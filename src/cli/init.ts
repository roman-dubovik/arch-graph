// Interactive wizard for `arch-graph init`.
//
// Asks a series of questions with sensible defaults, writes arch-graph.config.ts,
// and optionally chains: claude install --skill, hook install, and first build.
//
// Non-interactive fallback: if stdin is not a TTY, writes INIT_TEMPLATE as-is
// (matches legacy behaviour) without asking any questions.

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { dirname, relative, resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';

import fastGlob from 'fast-glob';

import { DOCS_DEFAULT_INCLUDE } from '../core/config.js';
import { claudeInstall } from './claude.js';
import * as hooksModule from './hooks.js';
import { registerProject } from './project-registry.js';

// ─── types ───────────────────────────────────────────────────────────────────

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
    installClaude: boolean;
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
}

type DomainKey = 'nats' | 'typeorm' | 'bullmq' | 'di' | 'http' | 'ts-import';

interface DomainOption {
    key: DomainKey;
    label: string;
    description: string;
}

// ─── domain catalogue ─────────────────────────────────────────────────────────

const DOMAIN_OPTIONS: DomainOption[] = [
    { key: 'nats',      label: 'NATS',       description: 'pub/sub + request/reply' },
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
    },\n`;
        } else {
            natsBlock = `    nats: {
        wrapperPublishApis: [
            // { class: 'MyNatsService', methods: ['publish', 'request'] },
        ],
        wrapperSubscribeApis: [
            // { class: 'MyNatsService', methods: ['subscribe'] },
        ],
    },\n`;
        }
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
${domainsBlock}${natsBlock}${importsBlock}${docsBlockStr}${strictComment}};
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
    output.write('  1. pre-commit   (graph committed with code) — recommended\n');
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
        return;
    }

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
    const installClaude = await askYesNo(
        rl,
        '\n? Install Claude Code integration (./CLAUDE.md + skill)?',
        true,
    );

    const hookMode = await askHookMode(rl);

    const strictMode = await askYesNo(
        rl,
        '\n? Strict mode? (fail build if recall drops below domain floor — useful for CI)',
        false,
    );

    const shouldRunBuild = await askYesNo(rl, '\n? Run first build now?', true);

    const docs = await askDocs(rl, resolve(repoRoot));

    rl.close();

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
        installClaude,
        hookMode,
        strictMode,
        runBuild: shouldRunBuild,
        docs,
    };

    output.write('\n');

    const configContent = buildConfigTemplate(answers);
    await writeFile(targetPath, configContent, 'utf8');
    await registerProject(dirname(targetPath));
    output.write(`✓ wrote ${targetPath}\n`);

    // ── Claude integration ────────────────────────────────────────────────────
    if (installClaude) {
        await claudeInstall({ target: resolve('./CLAUDE.md'), installSkill: true });
    }

    // ── Git hook ──────────────────────────────────────────────────────────────
    if (hookMode !== 'none') {
        await hooksModule.hookInstall({ repo: resolve('.'), mode: hookMode });
    }

    // ── First build ───────────────────────────────────────────────────────────
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
        } catch (err) {
            output.write(`\n⚠  first build failed: ${(err as Error).message}\n`);
            output.write('   Run `arch-graph build` manually once your source is ready.\n\n');
        }
    }

    // ── Next steps ────────────────────────────────────────────────────────────
    output.write('\nNext steps:\n');
    const configRel = relative(process.cwd(), targetPath) || targetPath;
    const claudePart = installClaude ? ' CLAUDE.md' : '';
    output.write(`  • Commit the config: git add ${configRel}${claudePart} && git commit\n`);

    if (hookMode !== 'none') {
        output.write(
            `  • The graph rebuilds automatically ${hookMode === 'pre-commit' ? 'before each commit' : 'after each commit'} touching .ts files\n`,
        );
    }
    if (installClaude) {
        output.write('  • In Claude Code, the skill triggers on /arch-graph or architecture questions\n');
    }
    output.write('\n');
}
