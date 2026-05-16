/**
 * CLI handler for `arch-graph semantic build`.
 *
 * Follows the two-word subcommand dispatch pattern used by `claude` and `hook`
 * in src/cli/index.ts. The handler is dispatched before `parseArgs()` so that
 * positionals are never mis-interpreted as config paths.
 *
 * Shape:
 *   arch-graph semantic build [--out <dir>] [--config <path>] [--repo <id>]
 *
 * Exit codes:
 *   0 — success (non-zero skipped count is NOT a hard failure; it is diagnostic)
 *   1 — hard failure (config missing, model load failure, etc.)
 */
import { join, resolve } from 'node:path';
import { Project } from 'ts-morph';

import { loadConfig } from '../core/config.js';
import { buildSemanticIndex } from '../semantic/builder.js';
import { embed } from '../semantic/embedder.js';
import { readFile as readFileGraph } from 'node:fs/promises';
import type { ArchGraph } from '../core/types.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface SemanticArgs {
    sub: string;
    config: string;
    out: string;
    repo?: string;
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
        }
    }

    return { sub: sub ?? '', config, out, repo };
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
