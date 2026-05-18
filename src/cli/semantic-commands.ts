/**
 * CLI handlers for `arch-graph semantic build` and `arch-graph semantic search`.
 *
 * Follows the two-word subcommand dispatch pattern used by `claude` and `hook`
 * in src/cli/index.ts. The handler is dispatched before `parseArgs()` so that
 * positionals are never mis-interpreted as config paths.
 *
 * Shapes:
 *   arch-graph semantic build [--out <dir>] [--config <path>] [--repo <id>]
 *   arch-graph semantic search "<query>" [--out <dir>] [--repo <id>] [--k <n>]
 *                              [--json|--table]
 *                              [--kinds k1,k2,... | --exclude-kinds k1,k2,...
 *                               | --code-only | --docs-only]
 *
 * Exit codes:
 *   build:  0 success, 1 hard failure
 *   search: 0 found, 4 empty results, 1 hard failure (sidecar missing, etc.)
 */
import { join, resolve } from 'node:path';
import { Project, ts } from 'ts-morph';

import { applySemanticDefaults, loadConfig } from '../core/config.js';
import { buildSemanticIndex } from '../semantic/builder.js';
import { makeEmbedder } from '../semantic/embedder.js';
import { readFile as readFileGraph } from 'node:fs/promises';
import type { ArchGraph, NodeKind } from '../core/types.js';
import { NODE_KIND_VALUES } from '../core/types.js';
import { semanticSearch } from '../semantic/search.js';
import type { SearchResult } from '../semantic/search.js';
import { validateSnippetRecall } from '../validation/snippet-recall-validator.js';
import type { SemanticModelAlias } from '../semantic/types.js';
import { SEMANTIC_MODELS } from '../semantic/types.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface SemanticArgs {
    sub: string;
    config: string;
    out: string;
    repo?: string;
    /** search: the query string (first positional after "search") */
    query?: string;
    /** search: number of results to return */
    k?: number;
    /** search: output format (default: json) */
    format: 'json' | 'table';
    /** search: node kinds whitelist (validated against NODE_KIND_VALUES) */
    kinds?: NodeKind[];
    /** search: node kinds blacklist (validated against NODE_KIND_VALUES) */
    excludeKinds?: NodeKind[];
    /**
     * build + search: override the embedding model alias. CLI wins over config.
     * When undefined, the resolved config value (or default 'minilm') is used.
     */
    model?: SemanticModelAlias;
    /**
     * build: when true, exit 1 if recall is below floor for any kind, or if
     * the index is empty. Has no effect on corrupt indexes, which always exit 1
     * regardless of this flag.
     */
    strictRecall?: boolean;
}

/**
 * Parse `argv` (slice after "semantic") into structured args.
 * Returns `{ sub: '', ... }` for unknown/missing subcommand so the caller
 * can emit a helpful error.
 */
export function parseSemanticArgs(argv: string[]): SemanticArgs {
    const [sub, ...rest] = argv;
    let config = './arch-graph.config.ts';
    let out = './arch-graph-out';
    let repo: string | undefined;
    let query: string | undefined;
    let k: number | undefined;
    let format: 'json' | 'table' = 'json';
    let kinds: NodeKind[] | undefined;
    let excludeKinds: NodeKind[] | undefined;
    let model: SemanticModelAlias | undefined;
    /** Track which preset / explicit filter flag was used so we can reject mixes. */
    let kindFilterSource: '--kinds' | '--exclude-kinds' | '--code-only' | '--docs-only' | null = null;

    /**
     * Validate a raw --k value string.  Returns the parsed integer on success.
     * Writes to stderr and exits on NaN or non-positive values.
     */
    function parseK(raw: string): number {
        const parsed = parseInt(raw, 10);
        if (isNaN(parsed)) {
            process.stderr.write(
                `arch-graph semantic search: invalid --k value '${raw}': must be a positive integer.\n`,
            );
            process.exit(1);
        }
        if (parsed <= 0) {
            process.stderr.write(
                `arch-graph semantic search: invalid --k value '${raw}': must be greater than 0.\n`,
            );
            process.exit(1);
        }
        return parsed;
    }

    /**
     * Validate and parse a comma-separated --kinds value.
     * Rejects any value not in NODE_KIND_VALUES and exits with an error.
     */
    function parseKinds(raw: string, flagLabel: string): NodeKind[] {
        const tokens = raw.split(',').map((s) => s.trim()).filter(Boolean);
        const invalid = tokens.filter((t) => !(NODE_KIND_VALUES as readonly string[]).includes(t));
        if (invalid.length > 0) {
            process.stderr.write(
                `arch-graph semantic search: unknown ${flagLabel} value(s): ${invalid.join(', ')}.\n` +
                `  Valid kinds: ${NODE_KIND_VALUES.join(', ')}\n`,
            );
            process.exit(1);
        }
        return tokens as NodeKind[];
    }

    /**
     * Mark a kind-filter flag as used. Reject mixing presets with each other
     * or with --kinds / --exclude-kinds — a single search call should use
     * exactly one bucket strategy.
     */
    function claimFilterSource(flag: typeof kindFilterSource): void {
        if (kindFilterSource && kindFilterSource !== flag) {
            process.stderr.write(
                `arch-graph semantic search: cannot combine ${kindFilterSource} with ${flag}. ` +
                `Use one of --kinds, --exclude-kinds, --code-only, --docs-only.\n`,
            );
            process.exit(1);
        }
        if (kindFilterSource === flag) {
            // Repeated same flag — last-write would silently win without an error.
            // Refuse so the user notices and merges values into a single list.
            process.stderr.write(
                `arch-graph semantic search: ${flag} specified more than once. ` +
                `Provide a single comma-separated list instead.\n`,
            );
            process.exit(1);
        }
        kindFilterSource = flag;
    }

    /**
     * Reject a flag that requires a value but was given none (e.g. trailing
     * `--exclude-kinds` with no following positional). Without this, the
     * `&& rest[i + 1]` guard in the parse loop silently drops the flag.
     */
    function requireValue(flag: string, value: string | undefined): string {
        if (!value) {
            process.stderr.write(
                `arch-graph semantic search: ${flag} requires a value.\n`,
            );
            process.exit(1);
        }
        return value;
    }

    /**
     * Validate a --model alias value against the SEMANTIC_MODELS registry.
     * Exits with 1 and writes to stderr on invalid alias.
     */
    function parseModelAlias(raw: string): SemanticModelAlias {
        const validAliases = Object.keys(SEMANTIC_MODELS) as SemanticModelAlias[];
        if (!validAliases.includes(raw as SemanticModelAlias)) {
            process.stderr.write(
                `arch-graph semantic: invalid --model alias '${raw}'. ` +
                `Valid aliases: ${validAliases.join(', ')}.\n`,
            );
            process.exit(1);
        }
        return raw as SemanticModelAlias;
    }

    // For 'search', the first non-flag argument after the subcommand is the query.
    // We collect it separately.
    const positionals: string[] = [];

    for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (a === '--config' && rest[i + 1]) {
            config = rest[++i]!;
        } else if (a.startsWith('--config=')) {
            config = a.slice('--config='.length);
        } else if (a === '--out' && rest[i + 1]) {
            out = rest[++i]!;
        } else if (a.startsWith('--out=')) {
            out = a.slice('--out='.length);
        } else if (a === '--repo' && rest[i + 1]) {
            repo = rest[++i];
        } else if (a.startsWith('--repo=')) {
            repo = a.slice('--repo='.length);
        } else if ((a === '--k' || a === '-k') && rest[i + 1]) {
            k = parseK(rest[++i]!);
        } else if (a.startsWith('--k=')) {
            k = parseK(a.slice('--k='.length));
        } else if (a === '--json') {
            format = 'json';
        } else if (a === '--table') {
            format = 'table';
        } else if (a === '--kinds') {
            claimFilterSource('--kinds');
            kinds = parseKinds(requireValue('--kinds', rest[++i]), '--kinds');
        } else if (a.startsWith('--kinds=')) {
            claimFilterSource('--kinds');
            kinds = parseKinds(a.slice('--kinds='.length), '--kinds');
        } else if (a === '--exclude-kinds') {
            claimFilterSource('--exclude-kinds');
            excludeKinds = parseKinds(requireValue('--exclude-kinds', rest[++i]), '--exclude-kinds');
        } else if (a.startsWith('--exclude-kinds=')) {
            claimFilterSource('--exclude-kinds');
            excludeKinds = parseKinds(a.slice('--exclude-kinds='.length), '--exclude-kinds');
        } else if (a === '--code-only') {
            claimFilterSource('--code-only');
            excludeKinds = ['doc-section'];
        } else if (a === '--docs-only') {
            claimFilterSource('--docs-only');
            kinds = ['doc-section'];
        } else if (a === '--model') {
            const raw = requireValue('--model', rest[++i]);
            model = parseModelAlias(raw);
        } else if (a.startsWith('--model=')) {
            model = parseModelAlias(a.slice('--model='.length));
        } else if (!a.startsWith('-')) {
            positionals.push(a);
        }
    }

    // First positional after the subcommand is the query for 'search'
    if ((sub === 'search') && positionals.length > 0) {
        query = positionals[0];
    }

    // Parse --strict-recall anywhere in the arg list
    const strictRecall = rest.includes('--strict-recall');

    return {
        sub: sub ?? '',
        config,
        out,
        repo,
        query,
        k,
        format,
        kinds,
        excludeKinds,
        model,
        strictRecall,
    };
}

// ---------------------------------------------------------------------------
// semantic build handler
// ---------------------------------------------------------------------------

/**
 * Build the semantic index without doing any `process.exit` calls.
 *
 * Throws on hard failure (bad config, missing graph.json, fatal embed error)
 * so callers can decide what to do. The CLI entry `runSemanticBuild` translates
 * throws to `process.exit(1)`; `arch-graph init` catches them and continues so
 * the wizard's "next steps" block still prints.
 *
 * Returns the `outDir` so callers know where artifacts landed (helpful for
 * downstream operations like recall validation).
 */
export async function buildSemanticIndexFromArgs(args: SemanticArgs): Promise<{ outDir: string }> {
    const configPath = resolve(args.config);
    const outDir = resolve(args.out);

    // --- Load config --------------------------------------------------------
    let cfg;
    try {
        cfg = await loadConfig(configPath);
    } catch (err) {
        throw new Error(
            `arch-graph semantic build: failed to load config '${configPath}': ${(err as Error).message}\n` +
            `  Run 'arch-graph init' to create a starter config.`,
        );
    }

    process.stdout.write(`[arch-graph semantic] building index for '${cfg.id}'...\n`);
    process.stdout.write(`  config: ${configPath}\n`);
    process.stdout.write(`  out:    ${outDir}\n`);

    // --- Load graph.json ----------------------------------------------------
    const graphJsonPath = join(outDir, 'graph.json');
    let graph: ArchGraph;
    try {
        const raw = await readFileGraph(graphJsonPath, 'utf8');
        graph = JSON.parse(raw) as ArchGraph;
    } catch (err) {
        throw new Error(
            `arch-graph semantic build: cannot read graph.json at '${graphJsonPath}': ${(err as Error).message}\n` +
            `  Run 'arch-graph build' first to generate the graph.`,
        );
    }

    process.stdout.write(`  graph:  ${graph.nodes.length} nodes\n`);

    // --- Build ts-morph Project (mirrors runBuild in pipeline/build.ts) --------
    // A9: include .tsx/.jsx so fe-component snippets can be extracted.
    const project = new Project({
        useInMemoryFileSystem: false,
        skipAddingFilesFromTsConfig: true,
        compilerOptions: {
            allowJs: false,
            strict: false,
            noEmit: true,
            // Enable JSX parsing so ts-morph accepts .tsx/.jsx syntax without errors.
            jsx: ts.JsxEmit.React,
        },
    });

    // Always include .tsx; mirror the pipeline/build.ts glob strategy.
    const sourceExts = ['**/*.ts', '**/*.tsx'];
    const globs = [
        ...sourceExts.map((ext) => join(cfg.root, cfg.appsGlob, ext)),
        ...(cfg.libsGlob ? sourceExts.map((ext) => join(cfg.root, cfg.libsGlob!, ext)) : []),
    ];
    const extraExcludes = (cfg.excludeGlobs ?? []).map((g) => `!**${g}**`);
    for (const g of globs) {
        project.addSourceFilesAtPaths([
            g,
            '!' + join(cfg.root, '**/node_modules/**'),
            '!' + join(cfg.root, '**/dist/**'),
            '!' + join(cfg.root, '**/.claude/**'),
            '!' + join(cfg.root, '**/.worktrees/**'),
            '!**/*.spec.ts',
            '!**/*.test.ts',
            '!**/*.spec.tsx',
            '!**/*.test.tsx',
            '!**/*.spec.jsx',
            '!**/*.test.jsx',
            '!**/*.d.ts',
            ...extraExcludes,
        ]);
    }

    process.stdout.write(`  source files: ${project.getSourceFiles().length}\n`);

    // --- Resolve model alias (CLI flag wins over config) --------------------
    const { model: configModelAlias } = applySemanticDefaults(cfg.semantic);
    const modelAlias = args.model ?? configModelAlias;
    const embedder = makeEmbedder(modelAlias);

    // --- Run builder --------------------------------------------------------
    let result;
    try {
        result = await buildSemanticIndex({
            graph,
            project,
            embedder,
            outDir,
            modelAlias,
        });
    } catch (err) {
        throw new Error(
            `arch-graph semantic build: fatal error: ${(err as Error).message}`,
        );
    }

    const { manifest, diagnostics } = result;
    const d = diagnostics.counts;

    process.stdout.write(`\n✓ semantic/manifest.json:    ${outDir}/semantic/manifest.json\n`);
    process.stdout.write(`✓ semantic/embeddings.jsonl: ${outDir}/semantic/embeddings.jsonl\n`);
    process.stdout.write(`\n`);
    process.stdout.write(`  model:      ${manifest.model}\n`);
    process.stdout.write(`  dim:        ${manifest.dim}\n`);
    process.stdout.write(`  builtAt:    ${manifest.builtAt}\n`);
    process.stdout.write(`  graphHash:  ${manifest.graphHash.slice(0, 16)}...\n`);
    process.stdout.write(`  indexed:    ${d.indexed}\n`);
    process.stdout.write(`  skipped:    ${d.skipped}\n`);
    process.stdout.write(`  indexSize:  ${(diagnostics.indexSizeBytes / 1024).toFixed(1)} KB\n`);

    if (d.skipped > 0) {
        process.stderr.write(
            `\n[arch-graph semantic] ${d.skipped} node(s) skipped ` +
            `(fileReadErrors=${d.fileReadErrors}, transformerErrors=${d.transformerErrors}, labelErrors=${d.labelErrors}). ` +
            `See diagnostics.json for details.\n`,
        );
    }

    // Warn when label errors occurred but the skipped cap was not reached
    // (meaning all label errors are attributable — no silent swallowing).
    if (d.labelErrors > 0 && d.skipped === 0) {
        process.stderr.write(
            `\nWARNING: ${d.labelErrors} node(s) indexed with empty snippet (label not located — check anchor/label alignment).\n`,
        );
    }

    return { outDir };
}

/**
 * Run `semantic build` against a single arch-graph project.
 *
 * The `outDir` layout is flat (mirrors `arch-graph build`):
 *   <outDir>/graph.json
 *   <outDir>/semantic/manifest.json
 *   <outDir>/semantic/embeddings.jsonl
 *   <outDir>/diagnostics.json   ← merged in-place
 *
 * Multi-repo configs: each project has its own config file; the `--repo` flag
 * is intended for use when multiple configs share an output directory. It is
 * accepted but not currently required — single-config runs work without it.
 *
 * For programmatic callers (e.g. `arch-graph init`), prefer
 * `buildSemanticIndexFromArgs` directly — it throws on failure instead of
 * calling `process.exit`, so the caller can recover gracefully.
 */
export async function runSemanticBuild(args: SemanticArgs): Promise<void> {
    let outDir: string;
    try {
        ({ outDir } = await buildSemanticIndexFromArgs(args));
    } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(1);
    }

    // --- Snippet recall validation ------------------------------------------
    // Exit codes:
    //   corrupt     → always exit 1 (corruption is never informational)
    //   empty       → exit 1 with --strict-recall
    //   below-floor → exit 1 with --strict-recall; informational otherwise
    //   ok          → no action
    //
    // Note: process.exit() calls are made OUTSIDE the try/catch so that a
    // test mock that throws from process.exit() is not swallowed by the catch.
    let recallExitCode: number | null = null;

    try {
        const recallResult = await validateSnippetRecall(join(outDir, 'semantic'));

        switch (recallResult.kind) {
            case 'ok': {
                const { stats } = recallResult;
                process.stdout.write('\nSnippet recall:\n');
                for (const k of stats.byKind) {
                    const pct = (k.fillRate * 100).toFixed(1);
                    const floor = (k.floor * 100).toFixed(0);
                    process.stdout.write(
                        `  recall: ${k.kind} ${k.filled}/${k.total} (${pct}%) [PASS floor=${floor}%]\n`,
                    );
                }
                const vn = stats.virtualNodes;
                const vnEntries: string[] = [];
                if (vn.lib > 0) vnEntries.push(`lib: ${vn.lib}`);
                if (vn.service > 0) vnEntries.push(`service: ${vn.service}`);
                if (vn.moduleExternal > 0) vnEntries.push(`module (external): ${vn.moduleExternal}`);
                if (vn.natsSubject > 0) vnEntries.push(`nats-subject: ${vn.natsSubject}`);
                if (vn.dbTable > 0) vnEntries.push(`db-table: ${vn.dbTable}`);
                if (vn.queue > 0) vnEntries.push(`queue: ${vn.queue}`);
                if (vn.external > 0) vnEntries.push(`external: ${vn.external}`);
                if (vnEntries.length > 0) {
                    process.stdout.write(
                        `  Virtual nodes (no source expected, excluded from denominator): ${vnEntries.join(', ')}\n`,
                    );
                }
                break;
            }
            case 'below-floor': {
                const { stats, failures } = recallResult;
                process.stdout.write('\nSnippet recall:\n');
                for (const k of stats.byKind) {
                    const pct = (k.fillRate * 100).toFixed(1);
                    const floor = (k.floor * 100).toFixed(0);
                    const status = k.passed ? 'PASS' : 'FAIL';
                    process.stdout.write(
                        `  recall: ${k.kind} ${k.filled}/${k.total} (${pct}%) [${status} floor=${floor}%]\n`,
                    );
                }
                const vn2 = stats.virtualNodes;
                const vnEntries2: string[] = [];
                if (vn2.lib > 0) vnEntries2.push(`lib: ${vn2.lib}`);
                if (vn2.service > 0) vnEntries2.push(`service: ${vn2.service}`);
                if (vn2.moduleExternal > 0) vnEntries2.push(`module (external): ${vn2.moduleExternal}`);
                if (vn2.natsSubject > 0) vnEntries2.push(`nats-subject: ${vn2.natsSubject}`);
                if (vn2.dbTable > 0) vnEntries2.push(`db-table: ${vn2.dbTable}`);
                if (vn2.queue > 0) vnEntries2.push(`queue: ${vn2.queue}`);
                if (vn2.external > 0) vnEntries2.push(`external: ${vn2.external}`);
                if (vnEntries2.length > 0) {
                    process.stdout.write(
                        `  Virtual nodes (no source expected, excluded from denominator): ${vnEntries2.join(', ')}\n`,
                    );
                }
                const failedKinds = failures.map((f) => f.kind).join(', ');
                const details = failures
                    .map((f) => `  ${f.kind}: ${(f.fillRate * 100).toFixed(1)}% (need ${(f.floor * 100).toFixed(0)}%)`)
                    .join('\n');
                process.stderr.write(
                    `\n[arch-graph semantic] WARNING: snippet recall below floor for: ${failedKinds}\n${details}\n`,
                );
                if (args.strictRecall) {
                    process.stderr.write(
                        `[arch-graph semantic] --strict-recall: exiting 1 due to below-floor recall.\n`,
                    );
                    recallExitCode = 1;
                }
                break;
            }
            case 'corrupt': {
                process.stderr.write(
                    `\n[arch-graph semantic] ERROR: index appears corrupt — ` +
                    `${recallResult.malformedLines} of ${recallResult.totalLines} ` +
                    `lines malformed (>${5}% threshold). Re-run \`arch-graph semantic build\` to rebuild.\n`,
                );
                // Corruption is never informational — always exit 1.
                recallExitCode = 1;
                break;
            }
            case 'empty': {
                process.stderr.write(
                    `\n[arch-graph semantic] WARNING: index is empty — no source-backed nodes were indexed.\n`,
                );
                if (args.strictRecall) {
                    process.stderr.write(
                        `[arch-graph semantic] --strict-recall: exiting 1 due to empty index.\n`,
                    );
                    recallExitCode = 1;
                }
                break;
            }
        }
    } catch (recallErr) {
        // Non-fatal: recall validation is informational only.
        process.stderr.write(
            `\n[arch-graph semantic] WARNING: could not run snippet recall validation: ${(recallErr as Error).message}\n`,
        );
    }

    // Exit outside the try/catch so process.exit mocks in tests are not swallowed.
    if (recallExitCode !== null) {
        process.exit(recallExitCode);
    }

    // Exit 0 — non-zero skipped count is diagnostic, not failure (per AC 6).
}

// ---------------------------------------------------------------------------
// semantic search handler
// ---------------------------------------------------------------------------

/**
 * Render search results as an aligned table.
 * Columns: score (6 chars), kind (16 chars), label (32 chars), path.
 */
function renderTable(results: SearchResult[]): string {
    const lines: string[] = [];
    const header = [
        'SCORE '.padEnd(8),
        'KIND'.padEnd(18),
        'LABEL'.padEnd(34),
        'PATH',
    ].join('  ');
    lines.push(header);
    lines.push('-'.repeat(header.length));
    for (const r of results) {
        const score = r.score.toFixed(4).padEnd(8);
        const kind = (r.kind as string).padEnd(18);
        const label = r.label.length > 32
            ? r.label.slice(0, 29) + '...'
            : r.label.padEnd(34);
        const path = r.path ?? '';
        lines.push([score, kind, label, path].join('  '));
    }
    return lines.join('\n');
}

/**
 * Run `semantic search` — embed query, kNN over sidecar, print results.
 */
export async function runSemanticSearch(args: SemanticArgs): Promise<void> {
    if (!args.query) {
        process.stderr.write(
            'arch-graph semantic search: missing query argument.\n' +
            '  Usage: arch-graph semantic search "<query>" [--out <dir>] [--repo <id>] [--k <n>] [--json|--table]\n' +
            '         [--kinds k1,k2,... | --exclude-kinds k1,k2,... | --code-only | --docs-only]\n',
        );
        process.exit(1);
    }

    const outDir = resolve(args.out);
    const isJson = args.format !== 'table';

    // Resolve model alias: CLI flag wins over config, config wins over default.
    let modelAlias: SemanticModelAlias = args.model ?? 'minilm';
    if (!args.model) {
        try {
            const cfg = await loadConfig(resolve(args.config));
            modelAlias = applySemanticDefaults(cfg.semantic).model;
        } catch {
            // Config load failure is non-fatal for search — model defaults to minilm.
        }
    }

    // Build a single-text embedder bound to the resolved alias.
    const embedderFn = makeEmbedder(modelAlias);
    const embedOneFn = async (text: string): Promise<number[]> => {
        const results = await embedderFn([text]);
        return results[0]!;
    };

    const { output, exitCode, stderrWarning } = await semanticSearch({
        query: args.query,
        outDir,
        embedder: embedOneFn,
        modelAlias,
        topK: args.k,
        kinds: args.kinds,
        excludeKinds: args.excludeKinds,
    });

    // Emit hash-drift or other warnings to stderr
    if (stderrWarning) {
        process.stderr.write(stderrWarning);
    }

    if (isJson) {
        process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    } else {
        if (output.error) {
            process.stderr.write(
                `arch-graph semantic search: ${output.hint ?? output.error}\n`,
            );
        } else if (output.embedError) {
            process.stderr.write(
                `arch-graph semantic search: embedding failed — ${output.embedError}\n`,
            );
        } else if (output.results.length === 0) {
            process.stdout.write('No results found.\n');
        } else {
            process.stdout.write(renderTable(output.results) + '\n');
        }
    }

    process.exit(exitCode);
}
