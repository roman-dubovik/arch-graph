/**
 * bench/self-build/run.ts
 *
 * Usage:
 *   pnpm tsx bench/self-build/run.ts --model <alias> --out <results-path>
 *
 * Builds the arch-graph graph + semantic index for the chosen model alias,
 * runs all 12 queries from queries-self-build.json against the built index,
 * and writes a flat JSON result array to <results-path>.
 *
 * Result shape: BenchResultRow[] (see compare.ts for the type definition).
 *   Each row represents one (query, result) pair from the top-K results.
 *   Rows are tagged with `queryId` so compare.ts can group them per query.
 *
 * Idempotent: re-running overwrites the prior <results-path>.
 *
 * The graph build and semantic index build delegate to the existing production
 * pipeline (buildSemanticIndexFromArgs). Graph artifacts are written to a
 * dedicated temp directory so the bench does not pollute arch-graph-out/.
 *
 * End-to-end tests for this file may be marked .skip() when the chosen model
 * is not cached locally — the model download (~135 MB for minilm, ~500 MB for
 * bge-m3) would time out in CI. See src/bench/run.test.ts for the .skip()
 * condition and mock-based unit tests.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { loadConfig } from '../../src/core/config.js';
import { runBuild } from '../../src/pipeline/build.js';
import { writeGraphJson } from '../../src/output/graph-json.js';
import { makeEmbedder } from '../../src/semantic/embedder.js';
import { semanticSearch } from '../../src/semantic/search.js';
import { buildSemanticIndexFromArgs } from '../../src/cli/semantic-commands.js';
import type { SemanticModelAlias } from '../../src/semantic/types.js';
import { SEMANTIC_MODELS } from '../../src/semantic/types.js';
import type { BenchResultRow, QuerySpec } from './compare.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface RunArgs {
    model: SemanticModelAlias;
    out: string;
    config: string;
}

/** Type predicate: narrows a string to SemanticModelAlias without casts. */
function isSemanticModelAlias(s: string): s is SemanticModelAlias {
    return Object.hasOwn(SEMANTIC_MODELS, s);
}

/** Validate a --model alias against the SEMANTIC_MODELS registry. */
export function parseModelAlias(raw: string): SemanticModelAlias {
    if (!isSemanticModelAlias(raw)) {
        const validAliases = Object.keys(SEMANTIC_MODELS).join(', ');
        process.stderr.write(
            `run.ts: invalid --model alias '${raw}'. ` +
            `Valid aliases: ${validAliases}.\n`,
        );
        process.exit(1);
    }
    return raw;
}

function parseArgs(): RunArgs {
    const argv = process.argv.slice(2);
    let model: SemanticModelAlias = 'minilm';
    let out = '';
    let config = './arch-graph.config.ts';

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === '--model' && argv[i + 1]) {
            model = parseModelAlias(argv[++i]!);
        } else if (a.startsWith('--model=')) {
            model = parseModelAlias(a.slice('--model='.length));
        } else if (a === '--out' && argv[i + 1]) {
            out = argv[++i]!;
        } else if (a.startsWith('--out=')) {
            out = a.slice('--out='.length);
        } else if (a === '--config' && argv[i + 1]) {
            config = argv[++i]!;
        } else if (a.startsWith('--config=')) {
            config = a.slice('--config='.length);
        }
    }

    if (!out) {
        process.stderr.write('run.ts: --out <path> is required\n');
        process.exit(1);
    }

    return { model, out, config };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runBench(opts: {
    modelAlias: SemanticModelAlias;
    outResultPath: string;
    configPath: string;
    queries: QuerySpec[];
    topK?: number;
}): Promise<BenchResultRow[]> {
    const { modelAlias, outResultPath, configPath, queries, topK = 10 } = opts;

    // Build graph + semantic index in a temp directory so the bench run does
    // not overwrite arch-graph-out/. The temp dir is cleaned up on exit.
    const workDir = await mkdtemp(join(tmpdir(), 'ag-bench-'));
    process.stderr.write(`[bench] work dir: ${workDir}\n`);

    try {
        // Step 1: build structural graph (required before semantic index).
        const cfg = await loadConfig(configPath);
        const buildResult = await runBuild(cfg);
        await writeGraphJson(buildResult.graph, join(workDir, 'graph.json'));
        process.stderr.write(`[bench] graph: ${buildResult.graph.nodes.length} nodes\n`);

        // Step 2: build semantic index (reads graph.json written above).
        await buildSemanticIndexFromArgs({
            sub: 'build',
            config: configPath,
            out: workDir,
            format: 'json',
            model: modelAlias,
        });

        // Build a single-text embedder for search queries.
        // Query mode: the user query string must use the query prefix for e5-base.
        const queryEmbedderObj = makeEmbedder(modelAlias);
        const embedOneFn = async (text: string): Promise<number[]> =>
            queryEmbedderObj.embedOne(text, 'query');

        // Run all queries and collect results.
        const allRows: BenchResultRow[] = [];

        for (const spec of queries) {
            const response = await semanticSearch({
                query: spec.query,
                outDir: workDir,
                embedder: embedOneFn,
                modelAlias,
                topK,
            });

            // C2: check for infrastructure failures — silent empty rows misrepresent model quality.
            if (response.output.error) {
                throw new Error(
                    `bench: semanticSearch returned error for query "${spec.id}": ${response.output.error} — ${response.output.hint ?? ''}`,
                );
            }
            if (response.output.embedError) {
                throw new Error(
                    `bench: semanticSearch returned embedError for query "${spec.id}": ${response.output.embedError}`,
                );
            }

            for (const r of response.output.results) {
                allRows.push({
                    queryId: spec.id,
                    nodeId: r.nodeId,
                    kind: r.kind,
                    label: r.label,
                    score: r.score,
                    path: r.path,
                    snippet: r.snippet ?? '',
                });
            }
        }

        // Write results (overwrites any prior file at the same path).
        await writeFile(outResultPath, JSON.stringify(allRows, null, 2), 'utf8');
        process.stderr.write(`[bench] wrote ${allRows.length} rows to ${outResultPath}\n`);

        return allRows;
    } finally {
        await rm(workDir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const isMain = process.argv[1]?.endsWith('run.ts') ||
    process.argv[1]?.endsWith('run.js');

if (isMain) {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const queriesPath = join(__dirname, 'queries-self-build.json');

    const { model, out, config } = parseArgs();

    const queriesRaw = await readFile(queriesPath, 'utf8');
    const queries: QuerySpec[] = JSON.parse(queriesRaw);

    process.stderr.write(`[bench] model: ${model}\n`);
    process.stderr.write(`[bench] out:   ${out}\n`);

    runBench({
        modelAlias: model,
        outResultPath: out,
        configPath: config,
        queries,
    }).catch((err) => {
        process.stderr.write(`run.ts: fatal error: ${(err as Error).message}\n`);
        process.exit(1);
    });
}
