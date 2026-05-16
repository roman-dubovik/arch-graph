/**
 * Semantic kNN search over the arch-graph sidecar index.
 *
 * Pure library — no process.exit, no console.log.  The CLI wrapper in
 * src/cli/semantic-commands.ts handles I/O and exit codes.
 *
 * Injectable embedder: pass a fake in tests, `embedOne` from embedder.ts in
 * production.  This matches the Task 2 builder pattern.
 *
 * Cosine similarity:
 *   sim(a, b) = dot(a, b) / (norm(a) * norm(b))
 *
 * Production vectors are already unit-normalised (embedder uses
 * `normalize: true`), so dot == cosine — but we compute the full formula
 * so the function is correct for arbitrary (non-normalised) vectors and
 * remains testable with hand-crafted fixtures.
 *
 * Filter order:
 *   1. Compute cosine score for every indexed record.
 *   2. Apply `kinds` filter (if any).
 *   3. Sort descending by score.
 *   4. Take top-K (default 10, capped at 50).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { NodeKind } from '../core/types.js';
import { readEmbeddingsJsonl, readManifest } from './io.js';
import type { SemanticManifest } from './types.js';
import { SEMANTIC_DIM, SEMANTIC_MODEL } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_TOP_K = 10 as const;
export const MAX_TOP_K = 50 as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injectable single-text embedder.  Matches `embedOne` from embedder.ts. */
export type EmbedOneFn = (text: string) => Promise<number[]>;

/** One search result.  Matches the MCP output contract (Task 4). */
export interface SearchResult {
    nodeId: string;
    kind: NodeKind;
    label: string;
    path?: string;
    /** Cosine similarity in [-1, 1]. */
    score: number;
    /** Up to 400 chars of source snippet; omitted if empty. */
    snippet?: string;
    /** Present only when caller requests includeVectors (MCP layer adds this). */
    vector?: number[];
}

/** Full output of a semantic search call.  Matches the MCP contract. */
export interface SearchOutput {
    query: string;
    results: SearchResult[];
    model: typeof SEMANTIC_MODEL;
    dim: typeof SEMANTIC_DIM;
    indexBuiltAt: string;
    graphHashMatches: boolean;
    /**
     * Structured error code when the sidecar is unavailable or incompatible.
     * - `'semantic-index-missing'`: manifest or embeddings not found (ENOENT).
     * - `'semantic-index-corrupt'`: files exist but content is invalid (bad JSON,
     *    dimension mismatch, incompatible schemaVersion/model/dim, parse error).
     *
     * **Invariant**: `error` and `hint` always travel together — if `error` is
     * set, `hint` MUST be set, and vice versa.  Every error-producing code path
     * in `semanticSearch` populates both fields.  Tests assert this constraint.
     */
    error?: 'semantic-index-missing' | 'semantic-index-corrupt';
    /**
     * Human-readable hint for the user when `error` is set.
     * Always present when `error` is present (see invariant above).
     */
    hint?: string;
    /**
     * Present when the query embedding failed. Callers can surface this to
     * users as a diagnostic hint. Does not prevent other output fields from
     * being populated.
     *
     * Optional forward-compatible field — not part of the base MCP contract
     * required by 2-brain Phase 3, but surfaced for observability.
     */
    embedError?: string;
    /**
     * Present when the vector-augmentation re-read failed (MCP `includeVectors`
     * path). Results are still returned; only vector attachment failed.
     *
     * Optional forward-compatible field — not part of the base MCP contract
     * required by 2-brain Phase 3, but surfaced for observability.
     */
    vectorsError?: string;
}

/** Structured exit-code recommendation returned alongside SearchOutput. */
export type SearchExitCode = 0 | 1 | 4;

/** Pair returned from `semanticSearch`. */
export interface SearchResponse {
    output: SearchOutput;
    exitCode: SearchExitCode;
    /** Non-empty when the caller should write something to stderr. */
    stderrWarning?: string;
}

// ---------------------------------------------------------------------------
// Search options
// ---------------------------------------------------------------------------

export interface SemanticSearchOpts {
    /** The user query string. */
    query: string;
    /** Directory where arch-graph-out lives (contains graph.json + semantic/). */
    outDir: string;
    /** Single-text embedder — injectable for testability. */
    embedder: EmbedOneFn;
    /** Number of results to return.  Defaults to {@link DEFAULT_TOP_K}.  Capped at {@link MAX_TOP_K}. */
    topK?: number;
    /** Optional NodeKind whitelist.  Filter applied after scoring, before top-K. */
    kinds?: NodeKind[];
}

// ---------------------------------------------------------------------------
// Cosine math
// ---------------------------------------------------------------------------

/**
 * Dot product of two equal-length vectors.
 */
function dot(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += (a[i] ?? 0) * (b[i] ?? 0);
    }
    return sum;
}

/**
 * L2 norm of a vector.
 */
function norm(v: number[]): number {
    return Math.sqrt(dot(v, v));
}

/**
 * Cosine similarity between two vectors.
 * Returns 0 for zero-norm inputs (guard branch — exercised by tests).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    const na = norm(a);
    const nb = norm(b);
    if (na === 0 || nb === 0) return 0;
    return dot(a, b) / (na * nb);
}

// ---------------------------------------------------------------------------
// Core search function
// ---------------------------------------------------------------------------

/**
 * Run a semantic kNN search over the sidecar index.
 *
 * Never throws — all failures become structured {@link SearchResponse} values.
 */
export async function semanticSearch(opts: SemanticSearchOpts): Promise<SearchResponse> {
    const { query, outDir, embedder, kinds } = opts;
    const topK = Math.min(opts.topK ?? DEFAULT_TOP_K, MAX_TOP_K);

    const manifestPath = join(outDir, 'semantic', 'manifest.json');
    const embeddingsPath = join(outDir, 'semantic', 'embeddings.jsonl');

    // --- Load manifest -------------------------------------------------------
    let manifest: SemanticManifest;
    try {
        manifest = await readManifest(manifestPath);
    } catch (manifestErr) {
        const isEnoent = (manifestErr as NodeJS.ErrnoException).code === 'ENOENT';
        if (!isEnoent) {
            const msg = manifestErr instanceof Error ? manifestErr.message : String(manifestErr);
            process.stderr.write(`[arch-graph semantic] manifest read error: ${msg}\n`);
            const output: SearchOutput = {
                query,
                results: [],
                model: SEMANTIC_MODEL,
                dim: SEMANTIC_DIM,
                indexBuiltAt: '',
                graphHashMatches: false,
                error: 'semantic-index-corrupt',
                hint: `manifest invalid or incompatible — ${msg}. run: arch-graph semantic build`,
            };
            return { output, exitCode: 1 };
        }
        const output: SearchOutput = {
            query,
            results: [],
            model: SEMANTIC_MODEL,
            dim: SEMANTIC_DIM,
            indexBuiltAt: '',
            graphHashMatches: false,
            error: 'semantic-index-missing',
            hint: 'run: arch-graph semantic build',
        };
        return { output, exitCode: 1 };
    }

    // --- Hash drift check ----------------------------------------------------
    const graphJsonPath = join(outDir, 'graph.json');
    let graphHashMatches = true;
    let stderrWarning: string | undefined;
    try {
        const graphContent = await readFile(graphJsonPath, 'utf8');
        const currentHash = createHash('sha256').update(graphContent).digest('hex');
        if (currentHash !== manifest.graphHash) {
            graphHashMatches = false;
            stderrWarning =
                `[arch-graph semantic] WARNING: graph.json has changed since the index was built ` +
                `(hash mismatch). Results may be stale. Run 'arch-graph semantic build' to refresh.\n`;
        }
    } catch (graphReadErr) {
        // graph.json unreadable — treat as mismatch (conservative)
        const graphReadMsg = graphReadErr instanceof Error ? graphReadErr.message : String(graphReadErr);
        graphHashMatches = false;
        stderrWarning =
            `[arch-graph semantic] WARNING: could not read graph.json to verify index freshness: ${graphReadMsg}\n`;
    }

    // --- Embed the query -----------------------------------------------------
    let queryVector: number[];
    try {
        queryVector = await embedder(query);
    } catch (embedErr) {
        // Hard failure — cannot search without a query vector
        const embedErrorMsg = embedErr instanceof Error ? embedErr.message : String(embedErr);
        process.stderr.write(`[arch-graph semantic] embed failed: ${embedErrorMsg}\n`);
        const output: SearchOutput = {
            query,
            results: [],
            model: manifest.model,
            dim: manifest.dim,
            indexBuiltAt: manifest.builtAt,
            graphHashMatches,
            embedError: embedErrorMsg,
        };
        return { output, exitCode: 1, stderrWarning };
    }

    // --- Score all records ---------------------------------------------------
    const scored: Array<{ result: SearchResult; score: number }> = [];
    try {
        for await (const record of readEmbeddingsJsonl(embeddingsPath)) {
            const score = cosineSimilarity(queryVector, record.vector);
            const result: SearchResult = {
                nodeId: record.nodeId,
                kind: record.kind,
                label: record.label,
                score,
            };
            if (record.path !== undefined) result.path = record.path;
            if (record.snippet) result.snippet = record.snippet;
            scored.push({ result, score });
        }
    } catch (jsonlErr) {
        // embeddings.jsonl exists but content is corrupt (bad JSON, dim mismatch, etc.)
        const jsonlErrorMsg = jsonlErr instanceof Error ? jsonlErr.message : String(jsonlErr);
        process.stderr.write(`[arch-graph semantic] embeddings read error: ${jsonlErrorMsg}\n`);
        const output: SearchOutput = {
            query,
            results: [],
            model: manifest.model,
            dim: manifest.dim,
            indexBuiltAt: manifest.builtAt,
            graphHashMatches,
            error: 'semantic-index-corrupt',
            hint: 'run: arch-graph semantic build',
        };
        return { output, exitCode: 1, stderrWarning };
    }

    // --- Apply kinds filter (after scoring, before top-K) -------------------
    const filtered =
        kinds && kinds.length > 0
            ? scored.filter((s) => kinds.includes(s.result.kind))
            : scored;

    // --- Sort descending, take top-K ----------------------------------------
    filtered.sort((a, b) => b.score - a.score);
    const topResults = filtered.slice(0, topK).map((s) => s.result);

    const exitCode: SearchExitCode = topResults.length > 0 ? 0 : 4;

    const output: SearchOutput = {
        query,
        results: topResults,
        model: manifest.model,
        dim: manifest.dim,
        indexBuiltAt: manifest.builtAt,
        graphHashMatches,
    };

    return { output, exitCode, stderrWarning };
}
