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
 *                              [--json|--table] [--kinds k1,k2,...]
 *
 * Exit codes:
 *   build:  0 success, 1 hard failure
 *   search: 0 found, 4 empty results, 1 hard failure (sidecar missing, etc.)
 */
import { join, resolve } from 'node:path';
import { Project } from 'ts-morph';

import { loadConfig } from '../core/config.js';
import { buildSemanticIndex } from '../semantic/builder.js';
import { embed, embedOne } from '../semantic/embedder.js';
import { readFile as readFileGraph } from 'node:fs/promises';
import type { ArchGraph, NodeKind } from '../core/types.js';
import { NODE_KIND_VALUES } from '../core/types.js';
import { semanticSearch } from '../semantic/search.js';
import type { SearchResult } from '../semantic/search.js';

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
    function parseKinds(raw: string): NodeKind[] {
        const tokens = raw.split(',').map((s) => s.trim()).filter(Boolean);
        const invalid = tokens.filter((t) => !(NODE_KIND_VALUES as readonly string[]).includes(t));
        if (invalid.length > 0) {
            process.stderr.write(
                `arch-graph semantic search: unknown --kinds value(s): ${invalid.join(', ')}.\n` +
                `  Valid kinds: ${NODE_KIND_VALUES.join(', ')}\n`,
            );
            process.exit(1);
        }
        return tokens as NodeKind[];
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
        } else if (a === '--kinds' && rest[i + 1]) {
            kinds = parseKinds(rest[++i]!);
        } else if (a.startsWith('--kinds=')) {
            kinds = parseKinds(a.slice('--kinds='.length));
        } else if (!a.startsWith('-')) {
            positionals.push(a);
        }
    }

    // First positional after the subcommand is the query for 'search'
    if ((sub === 'search') && positionals.length > 0) {
        query = positionals[0];
    }

    return { sub: sub ?? '', config, out, repo, query, k, format, kinds };
}

// ---------------------------------------------------------------------------
// semantic build handler
// ---------------------------------------------------------------------------

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
 */
export async function runSemanticBuild(args: SemanticArgs): Promise<void> {
    const configPath = resolve(args.config);
    const outDir = resolve(args.out);

    // --- Load config --------------------------------------------------------
    let cfg;
    try {
        cfg = await loadConfig(configPath);
    } catch (err) {
        process.stderr.write(
            `arch-graph semantic build: failed to load config '${configPath}': ${(err as Error).message}\n` +
            `  Run 'arch-graph init' to create a starter config.\n`,
        );
        process.exit(1);
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
        process.stderr.write(
            `arch-graph semantic build: cannot read graph.json at '${graphJsonPath}': ${(err as Error).message}\n` +
            `  Run 'arch-graph build' first to generate the graph.\n`,
        );
        process.exit(1);
    }

    process.stdout.write(`  graph:  ${graph.nodes.length} nodes\n`);

    // --- Build ts-morph Project (same approach as runBuild in pipeline/build.ts) ---
    const project = new Project({
        useInMemoryFileSystem: false,
        skipAddingFilesFromTsConfig: true,
        compilerOptions: { allowJs: false, strict: false, noEmit: true },
    });

    const globs = [
        join(cfg.root, cfg.appsGlob, '**/*.ts'),
        ...(cfg.libsGlob ? [join(cfg.root, cfg.libsGlob, '**/*.ts')] : []),
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
            '!**/*.d.ts',
            ...extraExcludes,
        ]);
    }

    process.stdout.write(`  source files: ${project.getSourceFiles().length}\n`);

    // --- Run builder --------------------------------------------------------
    let result;
    try {
        result = await buildSemanticIndex({
            graph,
            project,
            embedder: embed,
            outDir,
        });
    } catch (err) {
        process.stderr.write(
            `arch-graph semantic build: fatal error: ${(err as Error).message}\n`,
        );
        process.exit(1);
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
            `(fileReadErrors=${d.fileReadErrors}, transformerErrors=${d.transformerErrors}). ` +
            `See diagnostics.json for details.\n`,
        );
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
            '  Usage: arch-graph semantic search "<query>" [--out <dir>] [--repo <id>] [--k <n>] [--json|--table] [--kinds k1,k2,...]\n',
        );
        process.exit(1);
    }

    const outDir = resolve(args.out);
    const isJson = args.format !== 'table';

    const { output, exitCode, stderrWarning } = await semanticSearch({
        query: args.query,
        outDir,
        embedder: embedOne,
        topK: args.k,
        kinds: args.kinds,
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
