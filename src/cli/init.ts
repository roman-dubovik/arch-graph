// Interactive wizard for `arch-graph init`.
//
// Asks a series of questions with sensible defaults, writes arch-graph.config.ts,
// and optionally chains: claude install --skill, hook install, and first build.
//
// Non-interactive fallback: if stdin is not a TTY, writes INIT_TEMPLATE as-is
// (matches legacy behaviour) without asking any questions.

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';

import fastGlob from 'fast-glob';

import { DOCS_DEFAULT_INCLUDE } from '../core/config.js';
import { claudeInstall } from './claude.js';
import * as hooksModule from './hooks.js';
import { registerProject } from './project-registry.js';

// ─── types ───────────────────────────────────────────────────────────────────

/** Agent-side semantic search strategy stored in the project CLAUDE.md snippet. */
export type SemanticStrategy = 'both-buckets' | 'fallback';

/** Preferred AI Agent Environment. */
export type AiEnvironment = 'claude' | 'cursor' | 'gemini' | 'none';

/** Where to write the semantic strategy snippet. */
export type SnippetTarget = 'append' | 'separate';

interface WizardAnswers {
    projectId: string;
    repoRoot: string;
    appsGlob: string;
    libsGlob: string;
    domains: DomainKey[];
    natsWrapper: boolean;
    natsWrapperClass: string;
    natsWrapperPublishMethods: string[];
    natsWrapperSubscribeMethods: string[];
    aiEnvs: AiEnvironment[];
    hookMode: 'pre-commit' | 'post-commit' | 'none';
    /** Strict mode: when true, a comment is emitted and a future `strictMode` field can be toggled. */
    strictMode: boolean;
    runBuild: boolean;
    docs?: {
        respectGitignore: boolean;
        chunkTokens: number;
        userInclude: string[];
        userExclude: string[];
    };
    semanticStrategy: SemanticStrategy;
    snippetTarget: SnippetTarget;
}

type DomainKey = 'nats' | 'rmq' | 'typeorm' | 'bullmq' | 'di' | 'http' | 'ts-import';

interface DomainOption {
    key: DomainKey;
    label: string;
    description: string;
}

// ─── domain catalogue ─────────────────────────────────────────────────────────

const DOMAIN_OPTIONS: DomainOption[] = [
    { key: 'nats',      label: 'NATS',       description: 'pub/sub + request/reply' },
    { key: 'rmq',       label: 'RMQ',        description: 'RabbitMQ decorator subscriptions' },
    { key: 'typeorm',   label: 'TypeORM',    description: '@InjectRepository → @Entity' },
    { key: 'bullmq',    label: 'BullMQ',     description: '@InjectQueue / @Processor' },
    { key: 'di',        label: 'NestJS DI',  description: '@Module imports/providers/exports' },
    { key: 'http',      label: 'HTTP',       description: 'HttpService / axios / fetch' },
    { key: 'ts-import', label: 'TS imports', description: 'file→file / service→lib' },
];

const ALL_DOMAINS: DomainKey[] = DOMAIN_OPTIONS.map((d) => d.key);

// ─── string escaping ──────────────────────────────────────────────────────────

/** Escape a user-supplied string for safe embedding in a single-quoted TS literal. */
function q(s: string): string {
    return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/** Emit a TS array literal from user-supplied method names. */
function methodsArray(methods: string[]): string {
    return '[' + methods.map(q).join(', ') + ']';
}

// ─── docs discovery ───────────────────────────────────────────────────────────

async function discoverExtraMdFiles(repoRoot: string, respectGitignore: boolean): Promise<string[]> {
    let all: string[];
    if (respectGitignore) {
        try {
            const stdout = execFileSync('git', ['-C', repoRoot, 'ls-files', '--', '*.md'], {
                encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
            });
            all = stdout.split('\n').filter(s => s.length > 0);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(`Warning: git ls-files failed (${message}); falling back to unfiltered glob — .gitignore NOT respected.\n`);
            all = await fastGlob(['**/*.md'], {
                cwd: repoRoot, ignore: ['**/node_modules/**'], dot: false,
            });
        }
    } else {
        all = await fastGlob(['**/*.md'], {
            cwd: repoRoot, ignore: ['**/node_modules/**'], dot: false,
        });
    }
    const defaultMatches = new Set(await fastGlob([...DOCS_DEFAULT_INCLUDE], { cwd: repoRoot }));
    return all.filter(f => !defaultMatches.has(f)).sort();
}

// ─── template builder ─────────────────────────────────────────────────────────

export function buildConfigTemplate(a: WizardAnswers): string {
    const domainSet = new Set(a.domains);

    // Domains block — only emit disabled keys (domains enabled by default are omitted).
    const disabledDomains = ALL_DOMAINS.filter((k) => !domainSet.has(k));
    let domainsBlock = '';
    if (disabledDomains.length > 0) {
        const lines = disabledDomains.map((k) => {
            // Map domain key → config property name
            const prop = k === 'ts-import' ? 'imports' : k;
            return `        ${prop}: false,`;
        });
        domainsBlock = `    domains: {\n${lines.join('\n')}\n    },\n`;
    }

    // NATS wrapper block
    let natsBlock = '';
    if (domainSet.has('nats')) {
        if (a.natsWrapper && a.natsWrapperClass) {
            const publishMethods = a.natsWrapperPublishMethods.length > 0
                ? methodsArray(a.natsWrapperPublishMethods)
                : `['publish', 'request']`;
            const subscribeMethods = a.natsWrapperSubscribeMethods.length > 0
                ? methodsArray(a.natsWrapperSubscribeMethods)
                : `['subscribe']`;
            natsBlock = `    nats: {
        wrapperPublishApis: [
            { class: ${q(a.natsWrapperClass)}, methods: ${publishMethods} },
        ],
        wrapperSubscribeApis: [
            { class: ${q(a.natsWrapperClass)}, methods: ${subscribeMethods} },
        ],
        subscribeDecorators: [
            // 'NatsMessagePattern',
        ],
    },\n`;
        } else {
            natsBlock = `    nats: {
        wrapperPublishApis: [
            // { class: 'MyNatsService', methods: ['publish', 'request'] },
        ],
        wrapperSubscribeApis: [
            // { class: 'MyNatsService', methods: ['subscribe'] },
        ],
        subscribeDecorators: [
            // 'NatsMessagePattern',
        ],
    },\n`;
        }
    }

    let rmqBlock = '';
    if (domainSet.has('rmq')) {
        rmqBlock = `    rmq: {
        subscribeDecorators: [
            // 'RmqEventPattern',
        ],
    },\n`;
    }

    // imports block — fileLevel comment only if ts-import enabled
    let importsBlock = '';
    if (domainSet.has('ts-import')) {
        importsBlock = `    imports: {
        // Emit file-level \`ts-import\` edges (file → file). Off by default —
        // produces 10k+ edges in medium monorepos. Turn on for file-graph drill-downs.
        // fileLevel: false,
    },\n`;
    }

    // Strict mode: emitted as a comment for now (actual gating is unconditional today;
    // the `strictMode` config field is planned for a future release so the setting
    // is already surfaced and discoverable). Remove the comment line to disable.
    const strictComment = a.strictMode
        ? `    // strictMode: true,  // fail build if recall drops below domain floor (CI-safe)\n`
        : '';

    // Docs block
    let docsBlockStr = '';
    if (a.docs !== undefined) {
        const customInclude = a.docs.userInclude.length > 0
            ? `        include: [${[...DOCS_DEFAULT_INCLUDE, ...a.docs.userInclude].map(q).join(', ')}],\n`
            : '';
        const customExclude = a.docs.userExclude.length > 0
            ? `        exclude: [${a.docs.userExclude.map(q).join(', ')}],\n`
            : '';
        docsBlockStr = `    docs: {\n${customInclude}${customExclude}        respectGitignore: ${a.docs.respectGitignore},\n        chunkTokens: ${a.docs.chunkTokens},\n    },\n`;
    }

    return `// arch-graph.config.ts — no import needed, arch-graph loads this directly.
// For editor type-hints add arch-graph as a devDependency:
//   npm i -D arch-graph@file:~/.arch-graph
// then prefix the export: export default { ... } satisfies import('arch-graph').ArchGraphConfig;

export default {
    id: ${q(a.projectId)},
    root: ${q(a.repoRoot)},
    appsGlob: ${q(a.appsGlob)},
    libsGlob: ${q(a.libsGlob)},
${domainsBlock}${natsBlock}${rmqBlock}${importsBlock}${docsBlockStr}${strictComment}    semantic: { model: 'e5-base' },
};
`;
}

// ─── readline helpers ──────────────────────────────────────────────────────────

type Rl = Awaited<ReturnType<typeof createInterface>>;

async function askWithDefault(rl: Rl, prompt: string, defaultValue: string): Promise<string> {
    const answer = await rl.question(`${prompt} [${defaultValue}]: `);
    return answer.trim() || defaultValue;
}

async function askYesNo(rl: Rl, prompt: string, defaultYes = true): Promise<boolean> {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    const answer = await rl.question(`${prompt} [${hint}]: `);
    const trimmed = answer.trim().toLowerCase();
    if (!trimmed) return defaultYes;
    return trimmed === 'y' || trimmed === 'yes';
}

// ─── semantic-build prompt + execution (extracted for unit testing) ──────────

/**
 * Prompt the user whether to build the semantic index now. The body is the
 * multi-line explainer; the question line follows. Defaults to "Y" so the
 * curl-piped install ends with a fully usable stack out of the box.
 *
 * Exported so unit tests can drive it with a fake readline; not part of the
 * public CLI surface.
 */
export async function askBuildSemantic(
    rl: Rl,
    write: (s: string) => void,
): Promise<boolean> {
    write(
        '\n? Build semantic search index now?\n' +
        '    Downloads ~280 MB embedding model on first use (cached under\n' +
        '    ~/.cache/transformers/), then embeds every graph node. Typically\n' +
        '    5–41 min depending on repo size. Enables fuzzy /\n' +
        '    multilingual queries via `code_search`, `docs_search`,\n' +
        '    `semantic_search` (MCP) and `arch-graph semantic search` (CLI).\n',
    );
    return askYesNo(rl, '  build now?', true);
}


/** Injectable build runner — production passes the real `buildSemanticIndexFromArgs`. */
export type SemanticBuildRunner = (args: {
    sub: string;
    config: string;
    out: string;
    format: 'json' | 'table';
}) => Promise<unknown>;

/**
 * Run the semantic build with init-wizard-friendly error handling: a failure
 * here (e.g. model download interrupted) must NOT tear down the rest of the
 * wizard. Prints either a success line or a recovery hint pointing at the
 * manual command, then returns.
 *
 * Exported alongside `askBuildSemantic` so unit tests can verify the recovery
 * path without spinning up the real embedder.
 */
export async function runSemanticBuildStep(opts: {
    targetPath: string;
    outDir: string;
    runner: SemanticBuildRunner;
    write: (s: string) => void;
}): Promise<void> {
    opts.write('\n... building semantic index (first run downloads the model) ...\n');
    try {
        await opts.runner({
            sub: 'build',
            config: opts.targetPath,
            out: opts.outDir,
            // `format` is required by SemanticArgs but only read by the
            // `search` subcommand. Any value satisfies the type here.
            format: 'json',
        });
        opts.write('\n✓ semantic index ready\n');
    } catch (err) {
        opts.write(`\n⚠  semantic build failed: ${(err as Error).message}\n`);
        opts.write('   Run `arch-graph semantic build` manually to retry.\n');
    }
}

/** Body printed when the user declines the semantic-build prompt. */
export const SEMANTIC_SKIP_HINT =
    '\n  Skipped. To enable semantic search later:\n' +
    '    arch-graph semantic build\n';

// Multi-select: show numbered list, ask which to disable (blank = all enabled).
async function askMultiSelect(rl: Rl, options: DomainOption[]): Promise<DomainKey[]> {
    output.write('\n? Which domains to extract?\n');
    options.forEach((opt, i) => {
        output.write(`  ${i + 1}. [x] ${opt.label.padEnd(12)} ${opt.description}\n`);
    });
    output.write('\n');

    const answer = await rl.question(
        '  Disable any? Enter numbers separated by comma (blank = all enabled): ',
    );

    if (!answer.trim()) return options.map((o) => o.key);

    const disabled = new Set<number>();
    for (const part of answer.split(',')) {
        const n = parseInt(part.trim(), 10);
        if (!isNaN(n) && n >= 1 && n <= options.length) {
            disabled.add(n - 1);
        }
    }

    return options
        .filter((_, i) => !disabled.has(i))
        .map((o) => o.key);
}

// ─── hook mode selector ───────────────────────────────────────────────────────

async function askHookMode(rl: Rl): Promise<'pre-commit' | 'post-commit' | 'none'> {
    output.write('\n? Install git hook?\n');
    output.write('  1. pre-commit   (validate graph build; artifacts stay local) — recommended\n');
    output.write('  2. post-commit  (graph rebuilt after commit, not in commit)\n');
    output.write('  3. none\n');

    const answer = await rl.question('  Choice [1]: ');
    const trimmed = answer.trim();
    if (trimmed === '2') return 'post-commit';
    if (trimmed === '3') return 'none';
    return 'pre-commit'; // default
}

// ─── re-run detection ─────────────────────────────────────────────────────────

type RerunChoice = 'overwrite' | 'cancel';

async function askRerun(rl: Rl, target: string): Promise<RerunChoice> {
    output.write(`\n⚠  Config already exists: ${target}\n`);
    output.write('  1. Overwrite — run wizard from scratch and replace it\n');
    output.write('  2. Cancel (default)\n');

    const answer = await rl.question('  Choice [2]: ');
    const trimmed = answer.trim();
    if (trimmed === '1') return 'overwrite';
    return 'cancel';
}

// ─── NATS wrapper prompts ─────────────────────────────────────────────────────

async function askNatsWrapper(rl: Rl): Promise<{
    enabled: boolean;
    className: string;
    publishMethods: string[];
    subscribeMethods: string[];
}> {
    const enabled = await askYesNo(
        rl,
        '\n? Custom NATS wrapper API? (you wrap @nestjs/microservices in your own class)',
        false,
    );

    if (!enabled) {
        return { enabled: false, className: '', publishMethods: [], subscribeMethods: [] };
    }

    const className = await askWithDefault(rl, '  Wrapper class name', 'MyNatsService');
    const publishRaw = await askWithDefault(rl, '  Publish methods (comma-separated)', 'publish,request');
    const subscribeRaw = await askWithDefault(rl, '  Subscribe methods (comma-separated)', 'subscribe');

    return {
        enabled: true,
        className,
        publishMethods: publishRaw.split(',').map((s) => s.trim()).filter(Boolean),
        subscribeMethods: subscribeRaw.split(',').map((s) => s.trim()).filter(Boolean),
    };
}

// ─── docs prompts ─────────────────────────────────────────────────────────────

async function askDocs(
    rl: ReturnType<typeof createInterface>,
    repoRoot: string,
): Promise<WizardAnswers['docs']> {
    const ignoreAns = (await rl.question('Use .gitignore when scanning .md? [Y/n] '))
        .trim().toLowerCase();
    const respectGitignore = ignoreAns !== 'n' && ignoreAns !== 'no';

    const candidates = await discoverExtraMdFiles(repoRoot, respectGitignore);
    const userInclude: string[] = [];
    const userExclude: string[] = [];

    if (candidates.length > 0) {
        process.stdout.write(
            `\nFound .md files outside defaults — for each, press enter to include, type '!' to exclude, or 's' to skip:\n`,
        );
        for (const c of candidates) {
            const ans = (await rl.question(`  ${c} [include/!exclude/skip]: `))
                .trim().toLowerCase();
            if (ans === '!' || ans === 'exclude') userExclude.push(c);
            else if (ans === 's' || ans === 'skip') continue;
            else userInclude.push(c);
        }
    }

    const tokensAns = (await rl.question(
        'Chunk tokens per section (BERT tokens, embedder context 128)? [100] ',
    )).trim();
    const chunkTokens = tokensAns === '' ? 100 : Math.max(1, Number.parseInt(tokensAns, 10) || 100);

    return { respectGitignore, chunkTokens, userInclude, userExclude };
}

// ─── semantic strategy prompt ─────────────────────────────────────────────────

/**
 * Ask the user which agent-side semantic search strategy to use.
 *
 * Exported for unit testing (pass a fake rl with a stubbed `.question()`).
 */
export async function askSemanticStrategy(rl: Rl): Promise<SemanticStrategy> {
    output.write('\n? Semantic search strategy\n');
    output.write('  code_search   — searches the code graph (functions, classes, edges).\n');
    output.write('  docs_search   — searches the embedded docs/markdown chunks.\n');
    output.write('\n');
    output.write('  1. both-buckets  (default, recommended)\n');
    output.write('     Two parallel calls per retrieval — richer LLM context.\n');
    output.write('     Cost: ~$0.005 / query on Sonnet · ~$0.025 / query on Opus.\n');
    output.write('\n');
    output.write('  2. fallback\n');
    output.write('     code_search first; docs_search only on miss.\n');
    output.write('     Cost: ~$0.003 / query on Sonnet · ~$0.012 / query on Opus.\n');
    output.write('     Halves cost for cost-sensitive projects.\n');
    output.write('\n');
    output.write('  Recall is identical for both modes. Difference is answer quality + cost.\n');

    const answer = await rl.question('  Choice [1]: ');
    const trimmed = answer.trim();
    if (trimmed === '2') return 'fallback';
    return 'both-buckets'; // default
}

/**
 * When a pre-existing CLAUDE.md is detected, ask whether to append to it or
 * write a separate snippet file.
 *
 * Exported for unit testing.
 */
export async function askSnippetTarget(rl: Rl): Promise<SnippetTarget> {
    output.write('\n⚠  CLAUDE.md already exists in this directory.\n');
    output.write('  The arch-graph semantic strategy snippet can be:\n');
    output.write('  1. Appended to CLAUDE.md\n');
    output.write('  2. Written to a separate file: CLAUDE.md.arch-graph-snippet.md (default)\n');

    const answer = await rl.question('  Choice [2]: ');
    const trimmed = answer.trim();
    if (trimmed === '1') return 'append';
    return 'separate'; // default
}

/** Ask which AI environment(s) to scaffold for. */
async function askAiEnvironments(rl: Rl): Promise<AiEnvironment[]> {
    output.write('\n? Which AI agent(s) do you use for this project? (select all that apply)\n');
    output.write('  1. Claude Code (SessionStart hook & CLAUDE.md)\n');
    output.write('  2. Cursor / Windsurf (.cursorrules)\n');
    output.write('  3. Gemini CLI (CLAUDE.md pointer)\n');
    output.write('  4. Done / Skip\n');

    const selected = new Set<AiEnvironment>();
    while (true) {
        const currentStr = selected.size === 0 ? 'none' : Array.from(selected).join(', ');
        const answer = await rl.question(`  Select [1-4, currently: ${currentStr}]: `);
        const trimmed = answer.trim();
        if (trimmed === '1') selected.add('claude');
        else if (trimmed === '2') selected.add('cursor');
        else if (trimmed === '3') selected.add('gemini');
        else break;
    }
    return Array.from(selected);
}

// ─── .gitignore helpers ───────────────────────────────────────────────────────

async function atomicWrite(path: string, content: string): Promise<void> {
    const tmp = path + '.tmp';
    try {
        await writeFile(tmp, content, 'utf8');
        await rename(tmp, path);
    } catch (err) {
        try {
            await unlink(tmp);
        } catch (unlinkErr) {
            const orig = err as Error;
            const cleanup = unlinkErr as Error;
            throw new Error(
                `${orig.message} (additionally, cleanup of ${tmp} failed: ${cleanup.message}; you may need to delete it manually)`,
            );
        }
        throw err;
    }
}

async function shouldProceed(nonInteractive: boolean, rl: Rl | undefined, prompt: string): Promise<boolean> {
    if (nonInteractive) return true;
    if (!rl) return false;  // safety: nothing to prompt with
    return askYesNo(rl, prompt, true);
}

// ─── .gitignore helper ────────────────────────────────────────────────────────

/** The six patterns that count as "arch-graph-out is already ignored". */
const GITIGNORE_PATTERNS = new Set([
    'arch-graph-out',
    'arch-graph-out/',
    '/arch-graph-out',
    '/arch-graph-out/',
    '**/arch-graph-out',
    '**/arch-graph-out/',
]);

/** Return type for ensureArchGraphOutGitignored. */
export type GitignoreAction = 'added' | 'created' | 'already-present' | 'declined' | 'no-gitignore-declined';

/**
 * Offer to add `arch-graph-out/` to the project's `.gitignore`.
 * - Idempotent: returns `already-present` if any of the 6 canonical patterns is found.
 * - Interactive: prompts via `rl` when `nonInteractive` is falsy.
 * - Non-interactive (`nonInteractive=true`): writes automatically (--yes behaviour).
 * - Atomic write: tmp → rename, so a Ctrl-C mid-write never corrupts the file.
 *
 * Exported so unit tests can call it directly.
 */
export async function ensureArchGraphOutGitignored(opts: {
    repoRoot: string;
    rl?: Rl;
    nonInteractive?: boolean;
    write?: (s: string) => void;
}): Promise<{ action: GitignoreAction }> {
    const { repoRoot, rl, nonInteractive = false, write = () => {} } = opts;
    const gitignorePath = join(repoRoot, '.gitignore');

    if (existsSync(gitignorePath)) {
        // Check whether any recognised pattern is already present.
        let content: string;
        try {
            content = await readFile(gitignorePath, 'utf8');
        } catch (err) {
            process.stderr.write('\nWarning: could not read .gitignore — ' + (err as Error).message + '\n  Add arch-graph-out/ to .gitignore manually.\n');
            return { action: 'declined' };
        }
        const alreadyIgnored = content
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith('#'))
            .some((l) => GITIGNORE_PATTERNS.has(l));

        if (alreadyIgnored) {
            return { action: 'already-present' };
        }

        // Not yet ignored — offer to append.
        const doAdd = await shouldProceed(nonInteractive, rl, "Add 'arch-graph-out/' to .gitignore?");
        if (!doAdd) {
            return { action: 'declined' };
        }

        // Atomic append via tmp → rename.
        const newContent = content + (content.endsWith('\n') ? '' : '\n') + 'arch-graph-out/\n';
        await atomicWrite(gitignorePath, newContent);
        write('  ✓ added arch-graph-out/ to .gitignore\n');
        return { action: 'added' };
    } else {
        // .gitignore does not exist — offer to create it.
        const doCreate = await shouldProceed(nonInteractive, rl, "No .gitignore found. Create one with 'arch-graph-out/'?");
        if (!doCreate) {
            return { action: 'no-gitignore-declined' };
        }

        await atomicWrite(gitignorePath, 'arch-graph-out/\n');
        write('  ✓ created .gitignore with arch-graph-out/\n');
        return { action: 'created' };
    }
}

// ─── snippet writer ───────────────────────────────────────────────────────────

const STRATEGY_EXPLANATIONS: Record<SemanticStrategy, string> = {
    'both-buckets':
        'Both `code_search` and `docs_search` are called in parallel for every retrieval. ' +
        'This provides the richest context to the LLM (~$0.005/query on Sonnet, ~$0.025/query on Opus).',
    'fallback':
        '`code_search` is called first; `docs_search` is only called when code_search returns no results. ' +
        'This halves the cost for cost-sensitive projects (~$0.003/query on Sonnet, ~$0.012/query on Opus).',
};

/**
 * Build the markdown snippet string for the chosen strategy.
 *
 * Exported for unit testing.
 */
export function buildStrategySnippet(strategy: SemanticStrategy): string {
    return `\n## arch-graph semantic search strategy\n\nThis project uses **${strategy}** for arch-graph semantic retrieval.\n\n${STRATEGY_EXPLANATIONS[strategy]}\n\nTo change: edit this file or re-run \`arch-graph init\`.\n`;
}

const STRATEGY_SNIPPET_START = '<!-- arch-graph:semantic-strategy:start -->';
const STRATEGY_SNIPPET_END = '<!-- arch-graph:semantic-strategy:end -->';

function buildMarkedStrategySnippet(strategy: SemanticStrategy): string {
    return `${STRATEGY_SNIPPET_START}\n${buildStrategySnippet(strategy).trimStart()}\n${STRATEGY_SNIPPET_END}\n`;
}

function replaceStrategySnippet(content: string, strategy: SemanticStrategy): string {
    const marked = buildMarkedStrategySnippet(strategy);
    const markedRe = new RegExp(
        `\\n*${escapeRegExp(STRATEGY_SNIPPET_START)}[\\s\\S]*?${escapeRegExp(STRATEGY_SNIPPET_END)}\\n*`,
        'g',
    );
    const legacyRe =
        /\n*## arch-graph semantic search strategy\n\nThis project uses \*\*(?:both-buckets|fallback)\*\* for arch-graph semantic retrieval\.\n\n[\s\S]*?To change: edit this file or re-run `arch-graph init`\.\n*/g;
    const cleaned = content.replace(markedRe, '\n').replace(legacyRe, '\n').trimEnd();
    return `${cleaned}${cleaned ? '\n\n' : ''}${marked}`;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Write the strategy snippet — either append to CLAUDE.md or create a
 * separate `CLAUDE.md.arch-graph-snippet.md` file.
 *
 * Exported for unit testing.
 */
export async function writeStrategySnippet(
    strategy: SemanticStrategy,
    target: SnippetTarget,
    dir: string,
): Promise<string> {
    if (target === 'append') {
        const claudeMdPath = join(dir, 'CLAUDE.md');
        let existing = '';
        try {
            existing = await readFile(claudeMdPath, 'utf8');
        } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code !== 'ENOENT') throw err;
        }
        await writeFile(claudeMdPath, replaceStrategySnippet(existing, strategy), 'utf8');
        return claudeMdPath;
    } else {
        const snippet = buildStrategySnippet(strategy);
        const snippetPath = join(dir, 'CLAUDE.md.arch-graph-snippet.md');
        await writeFile(snippetPath, snippet.trimStart(), 'utf8');
        return snippetPath;
    }
}

// ─── INIT_TEMPLATE (non-TTY fallback) ─────────────────────────────────────────

export const INIT_TEMPLATE = `// arch-graph.config.ts — no import needed, arch-graph loads this directly.
// For editor type-hints add arch-graph as a devDependency:
//   npm i -D arch-graph@file:~/.arch-graph
// then prefix the export: export default { ... } satisfies import('arch-graph').ArchGraphConfig;

export default {
    id: 'my-project',
    root: '.',
    appsGlob: 'apps/*',
    libsGlob: 'libs/**',
    nats: {
        wrapperPublishApis: [
            // { class: 'MyNatsService', methods: ['publish', 'request'] },
        ],
        wrapperSubscribeApis: [
            // { class: 'MyNatsService', methods: ['subscribe'] },
        ],
        subscribeDecorators: [
            // 'NatsMessagePattern',
        ],
    },
    rmq: {
        subscribeDecorators: [
            // 'RmqEventPattern',
        ],
    },
    typeorm: {
        relationDecorators: [
            // { name: 'ManyToOneWithIndex', mapsTo: 'ManyToOne' },
        ],
    },
    imports: {
        // Emit file-level \`ts-import\` edges (file → file). Off by default —
        // produces 10k+ edges in medium monorepos. Turn on for file-graph drill-downs.
        // fileLevel: false,
    },
};
`;

// ─── main entry point ─────────────────────────────────────────────────────────

export async function runInitWizard(target: string): Promise<void> {
    const targetPath = resolve(target);

    // ── Non-interactive fallback ──────────────────────────────────────────────
    if (!process.stdin.isTTY) {
        await writeFile(targetPath, INIT_TEMPLATE, 'utf8');
        await registerProject(dirname(targetPath));
        process.stdout.write(`wrote ${targetPath}\n`);
        // Non-interactive: default to both-buckets, separate snippet file.
        // Use CWD (resolve('.')) so the snippet lands in the project root,
        // consistent with the interactive path.
        const snippetPath = await writeStrategySnippet('both-buckets', 'separate', resolve('.'));
        process.stdout.write(`wrote ${snippetPath}\n`);
        try {
            await ensureArchGraphOutGitignored({ repoRoot: dirname(targetPath), nonInteractive: true, write: (s) => process.stdout.write(s) });
        } catch (err) {
            process.stderr.write('\nWarning: could not update .gitignore — ' + (err as Error).message + '\n  Add arch-graph-out/ to .gitignore manually.\n');
        }
        return;
    }

    // ── CLAUDE.md pre-existence check (must be before claudeInstall runs) ─────
    const claudeMdPath = resolve('./CLAUDE.md');
    const claudeMdPreExists = existsSync(claudeMdPath);

    // ── Re-run detection ──────────────────────────────────────────────────────
    const rl = createInterface({ input, output, terminal: true });

    if (existsSync(targetPath)) {
        const choice = await askRerun(rl, targetPath);
        if (choice === 'cancel') {
            output.write('\nCancelled. Existing config unchanged.\n');
            rl.close();
            return;
        }
        output.write('\nStarting wizard (will overwrite existing config)...\n\n');
    } else {
        output.write('\narch-graph init — interactive setup wizard\n\n');
    }

    // ── Core questions ────────────────────────────────────────────────────────
    const projectId = await askWithDefault(rl, '? Project id (used as service:<id> prefix)', 'my-project');
    const repoRoot = await askWithDefault(rl, '? Repo root', '.');
    const appsGlob = await askWithDefault(rl, '? Apps glob (where services live)', 'apps/*');
    const libsGlob = await askWithDefault(rl, '? Libs glob', 'libs/**');

    // ── Domain multi-select ───────────────────────────────────────────────────
    const domains = await askMultiSelect(rl, DOMAIN_OPTIONS);

    // ── NATS wrapper (only if NATS enabled) ───────────────────────────────────
    const natsEnabled = domains.includes('nats');
    let natsWrapper = false;
    let natsWrapperClass = '';
    let natsWrapperPublishMethods: string[] = [];
    let natsWrapperSubscribeMethods: string[] = [];

    if (natsEnabled) {
        const natsResult = await askNatsWrapper(rl);
        natsWrapper = natsResult.enabled;
        natsWrapperClass = natsResult.className;
        natsWrapperPublishMethods = natsResult.publishMethods;
        natsWrapperSubscribeMethods = natsResult.subscribeMethods;
    }

    // ── Tooling questions ─────────────────────────────────────────────────────
    const aiEnvs = await askAiEnvironments(rl);

    const hookMode = await askHookMode(rl);

    const strictMode = await askYesNo(
        rl,
        '\n? Strict mode? (fail build if recall drops below domain floor — useful for CI)',
        false,
    );

    const shouldRunBuild = await askYesNo(rl, '\n? Run first build now?', true);

    const docs = await askDocs(rl, resolve(repoRoot));

    // ── Semantic strategy ─────────────────────────────────────────────────────
    const semanticStrategy = await askSemanticStrategy(rl);

    // ── Snippet target (only ask when CLAUDE.md already exists) ──────────────
    const snippetTarget: SnippetTarget = claudeMdPreExists
        ? await askSnippetTarget(rl)
        : 'separate';

    // ── Assemble answers & write config ──────────────────────────────────────
    const answers: WizardAnswers = {
        projectId,
        repoRoot,
        appsGlob,
        libsGlob,
        domains,
        natsWrapper,
        natsWrapperClass,
        natsWrapperPublishMethods,
        natsWrapperSubscribeMethods,
        aiEnvs,
        hookMode,
        strictMode,
        runBuild: shouldRunBuild,
        docs,
        semanticStrategy,
        snippetTarget,
    };

    output.write('\n');

    const configContent = buildConfigTemplate(answers);
    await writeFile(targetPath, configContent, 'utf8');
    await registerProject(dirname(targetPath));
    output.write(`✓ wrote ${targetPath}\n`);

    // ── AI Environment integration ────────────────────────────────────────────
    let claudeInstalled = false;
    for (const env of aiEnvs) {
        if (env === 'claude' || env === 'gemini') {
            await claudeInstall({ target: resolve('./CLAUDE.md'), installSkill: true });
            claudeInstalled = true;
            await hooksModule.agentHookInstall({ repo: resolve('.'), agent: env === 'claude' ? 'claude' : 'gemini' as any });
        } else if (env === 'cursor') {
            await hooksModule.agentHookInstall({ repo: resolve('.'), agent: 'cursor' });
        }
    }

    // ── Semantic strategy snippet ─────────────────────────────────────────────
    // snippetTarget is 'append' only when CLAUDE.md pre-existed AND the user
    // explicitly chose option 1. Otherwise always 'separate' (preserves any
    // fresh arch-graph block that claudeInstall may have just written).
    const writtenSnippetPath = await writeStrategySnippet(
        answers.semanticStrategy,
        answers.snippetTarget,
        resolve('.'),
    );
    output.write(`✓ wrote ${writtenSnippetPath}\n`);

    // ── Git hook ──────────────────────────────────────────────────────────────
    if (hookMode !== 'none') {
        await hooksModule.hookInstall({ repo: resolve('.'), mode: hookMode });
    }

    // ── First build ───────────────────────────────────────────────────────────
    let structuralBuildOk = false;
    if (shouldRunBuild) {
        output.write('\n... running first build ...\n');

        try {
            const { runBuild } = await import('../pipeline/build.js');
            const { loadConfig } = await import('../core/config.js');
            const cfg = await loadConfig(targetPath);
            const result = await runBuild(cfg);
            output.write(`\n✓ build complete: ${result.graph.nodes.length} nodes, ${result.graph.edges.length} edges\n`);

            const { writeGraphJson, writeDiagnostics, writeValidationReport } = await import('../output/graph-json.js');
            const { writeGraphMermaid } = await import('../output/graph-mermaid.js');
            const outDir = resolve('./arch-graph-out');
            await writeGraphJson(result.graph, `${outDir}/graph.json`);
            await writeDiagnostics(result.diagnostics, `${outDir}/diagnostics.json`);
            await writeValidationReport(result.validation, `${outDir}/validation.json`);
            await writeGraphMermaid(result.graph, `${outDir}/graph.mermaid`);
            output.write(`✓ wrote arch-graph-out/\n`);
            structuralBuildOk = true;
        } catch (err) {
            output.write(`\n⚠  first build failed: ${(err as Error).message}\n`);
            output.write('   Run `arch-graph build` manually once your source is ready.\n\n');
        }
    }

    // ── Semantic index (offer only if structural build succeeded) ─────────────
    // The graph.json must exist for the semantic builder to read it. Skipping
    // the prompt on build failure prevents a follow-up error that would just
    // tell the user to run `arch-graph build` first — they already know.
    if (structuralBuildOk) {
        const buildSemantic = await askBuildSemantic(rl, (s) => output.write(s));
        if (buildSemantic) {
            const { buildSemanticIndexFromArgs } = await import('./semantic-commands.js');
            await runSemanticBuildStep({
                targetPath,
                outDir: resolve('./arch-graph-out'),
                runner: buildSemanticIndexFromArgs,
                write: (s) => output.write(s),
            });
        } else {
            output.write(SEMANTIC_SKIP_HINT);
        }
    }

    // ── .gitignore entry ──────────────────────────────────────────────────────
    try {
        await ensureArchGraphOutGitignored({
            repoRoot: dirname(targetPath),
            rl,
            nonInteractive: !process.stdin.isTTY,
            write: (s) => output.write(s),
        });
    } catch (err) {
        process.stderr.write('\nWarning: could not update .gitignore — ' + (err as Error).message + '\n  Add arch-graph-out/ to .gitignore manually.\n');
    }

    rl.close();

    // ── Next steps ────────────────────────────────────────────────────────────
    output.write('\nNext steps:\n');
    const configRel = relative(process.cwd(), targetPath) || targetPath;
    const claudePart = claudeInstalled ? ' CLAUDE.md' : '';
    const snippetRel = relative(process.cwd(), writtenSnippetPath) || writtenSnippetPath;
    const snippetPart = answers.snippetTarget === 'separate' ? ` ${snippetRel}` : '';
    output.write(`  • Commit the config: git add ${configRel}${claudePart}${snippetPart} && git commit\n`);

    if (hookMode !== 'none') {
        output.write(
            hookMode === 'pre-commit'
                ? '  • Commits touching .ts files validate that the graph can build; arch-graph-out/ stays local\n'
                : '  • The graph rebuilds automatically after each commit touching .ts files; arch-graph-out/ stays local\n',
        );
    }
    if (claudeInstalled) {
        output.write('  • In Claude Code, the skill triggers on /arch-graph or architecture questions\n');
    }
    output.write('\n');
}
