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
 *   2. Apply `kinds` whitelist (if any).
 *   3. Apply `excludeKinds` blacklist (if any).  Exclude wins over include
 *      when a kind appears in both lists.
 *   4. Sort descending by score.
 *   5. Take top-K (default 10, capped at 50).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { NodeKind } from '../core/types.js';
import { readEmbeddingsJsonl, readManifest } from './io.js';
import type { SemanticManifest, SemanticModelAlias } from './types.js';
import { SEMANTIC_MODELS } from './types.js';
export { resolveMinScore, DEFAULT_MIN_SCORE_FALLBACK } from './types.js';

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
    /** Hub ID of the model that built this index. */
    model: string;
    /** Embedding dimensionality of the model that built this index. */
    dim: number;
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
     * Optional forward-compatible field — not part of the base MCP contract,
     * but surfaced for observability by federation consumers.
     */
    embedError?: string;
    /**
     * Present when the vector-augmentation re-read failed (MCP `includeVectors`
     * path). Results are still returned; only vector attachment failed.
     *
     * Optional forward-compatible field — not part of the base MCP contract,
     * but surfaced for observability by federation consumers.
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
    /**
     * Model alias used when building the index.  The search function uses this
     * to validate the manifest's model/dim against the expected values.
     *
     * Required: the alias controls which model the embedder must match, so
     * callers must pass it explicitly.  Production callers resolve it from
     * config (or use the `'minilm'` literal as a named default); omitting it
     * silently mismatches a bge-m3 index with minilm validation.
     */
    modelAlias: SemanticModelAlias;
    /** Number of results to return.  Defaults to {@link DEFAULT_TOP_K}.  Capped at {@link MAX_TOP_K}. */
    topK?: number;
    /** Optional NodeKind whitelist.  Filter applied after scoring, before top-K. */
    kinds?: NodeKind[];
    /**
     * Optional NodeKind blacklist.  Applied AFTER the `kinds` whitelist, so a
     * kind listed in both is excluded (exclude wins).  Empty / omitted = no
     * blacklist.  Use this for "give me everything except doc-section" style
     * queries, which is the canonical code-only search pattern.
     */
    excludeKinds?: NodeKind[];
    /**
     * Minimum cosine similarity threshold.  Results with a score strictly below
     * this value are dropped before top-K selection.
     *
     * When `undefined` (the default), no minimum-score filter is applied so
     * the function remains a pure library that callers can test with hand-crafted
     * vectors of any magnitude.  Production callers (CLI and MCP) resolve the
     * threshold via {@link resolveMinScore} and pass it explicitly.
     */
    minScore?: number;
    /** Per-kind maximum result counts after ranking. Omitted kinds are unlimited. */
    kindQuotas?: Partial<Record<NodeKind, number>>;
    /** Per-kind rank multiplier applied during hybrid ranking. Defaults to 1. */
    kindBoosts?: Partial<Record<NodeKind, number>>;
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
    const { query, outDir, embedder, kinds, excludeKinds } = opts;
    const topK = Math.min(opts.topK ?? DEFAULT_TOP_K, MAX_TOP_K);

    // Resolve model entry from the required alias.
    const alias = opts.modelAlias;
    const modelEntry = SEMANTIC_MODELS[alias];
    const expectedModel = { model: modelEntry.hubId, dim: modelEntry.dim };

    const manifestPath = join(outDir, 'semantic', 'manifest.json');
    const embeddingsPath = join(outDir, 'semantic', 'embeddings.jsonl');

    // --- Load manifest -------------------------------------------------------
    let manifest: SemanticManifest;
    try {
        manifest = await readManifest(manifestPath, expectedModel);
    } catch (manifestErr) {
        const isEnoent = (manifestErr as NodeJS.ErrnoException).code === 'ENOENT';
        if (!isEnoent) {
            const msg = manifestErr instanceof Error ? manifestErr.message : String(manifestErr);
            process.stderr.write(`[arch-graph semantic] manifest read error: ${msg}\n`);
            const output: SearchOutput = {
                query,
                results: [],
                model: modelEntry.hubId,
                dim: modelEntry.dim,
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
            model: modelEntry.hubId,
            dim: modelEntry.dim,
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
        for await (const record of readEmbeddingsJsonl(embeddingsPath, manifest.dim)) {
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
        // Distinguish ENOENT (missing file) from actual corruption
        const isEnoent = (jsonlErr as NodeJS.ErrnoException).code === 'ENOENT';
        if (!isEnoent) {
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
        const output: SearchOutput = {
            query,
            results: [],
            model: manifest.model,
            dim: manifest.dim,
            indexBuiltAt: manifest.builtAt,
            graphHashMatches,
            error: 'semantic-index-missing',
            hint: 'run: arch-graph semantic build',
        };
        return { output, exitCode: 1, stderrWarning };
    }

    // --- Apply kinds filters (after scoring, before top-K) -----------------
    // Whitelist first, blacklist second.  Exclude wins over include for kinds
    // that appear in both lists — matching the contract documented in the
    // file-level JSDoc.
    const excludeSet =
        excludeKinds && excludeKinds.length > 0 ? new Set(excludeKinds) : null;
    const { minScore } = opts;
    const filtered = scored.filter((s) => {
        if (kinds && kinds.length > 0 && !kinds.includes(s.result.kind)) return false;
        if (excludeSet && excludeSet.has(s.result.kind)) return false;
        if (minScore !== undefined && s.score < minScore) return false;
        return true;
    });

    // --- Hybrid rank dense + lexical using Reciprocal Rank Fusion ----------
    const ranked = rankHybrid(filtered, query, opts.kindBoosts);
    const topResults = applyKindQuotas(ranked, opts.kindQuotas, topK).map((s) => s.result);

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

function rankHybrid(
    scored: Array<{ result: SearchResult; score: number }>,
    query: string,
    kindBoosts?: Partial<Record<NodeKind, number>>,
): Array<{ result: SearchResult; score: number }> {
    const dense = [...scored].sort((a, b) => b.score - a.score);
    const denseRank = new Map<string, number>();
    dense.forEach((s, i) => denseRank.set(s.result.nodeId, i + 1));

    const queryTokens = tokenize(query);
    const bm25 = buildBm25Index(scored, queryTokens);
    const lexical = scored
        .map((s, i) => ({ ...s, lexicalScore: bm25.score(i) }))
        .filter((s) => s.lexicalScore > 0)
        .sort((a, b) => b.lexicalScore - a.lexicalScore || b.score - a.score);
    const lexicalRank = new Map<string, number>();
    lexical.forEach((s, i) => lexicalRank.set(s.result.nodeId, i + 1));

    const k = 60;
    return [...scored].sort((a, b) => {
        const ar = (
            1 / (k + (denseRank.get(a.result.nodeId) ?? scored.length + 1))
            + (lexicalRank.has(a.result.nodeId) ? 1 / (k + lexicalRank.get(a.result.nodeId)!) : 0)
        ) * (kindBoosts?.[a.result.kind] ?? 1);
        const br = (1 / (k + (denseRank.get(b.result.nodeId) ?? scored.length + 1))
            + (lexicalRank.has(b.result.nodeId) ? 1 / (k + lexicalRank.get(b.result.nodeId)!) : 0)
        ) * (kindBoosts?.[b.result.kind] ?? 1);
        return br - ar || b.score - a.score || a.result.nodeId.localeCompare(b.result.nodeId);
    });
}

function applyKindQuotas(
    ranked: Array<{ result: SearchResult; score: number }>,
    quotas: Partial<Record<NodeKind, number>> | undefined,
    topK: number,
): Array<{ result: SearchResult; score: number }> {
    if (!quotas) return ranked.slice(0, topK);
    const counts = new Map<NodeKind, number>();
    const out: Array<{ result: SearchResult; score: number }> = [];
    for (const item of ranked) {
        const quota = quotas[item.result.kind];
        const used = counts.get(item.result.kind) ?? 0;
        if (quota !== undefined && used >= quota) continue;
        counts.set(item.result.kind, used + 1);
        out.push(item);
        if (out.length >= topK) break;
    }
    return out;
}

function buildBm25Index(scored: Array<{ result: SearchResult; score: number }>, queryTokens: string[]): { score: (idx: number) => number } {
    const docs = scored.map((s) => tokenize([s.result.kind, s.result.label, s.result.path ?? '', s.result.snippet ?? ''].join(' ')));
    const avgLen = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
    const df = new Map<string, number>();
    for (const token of new Set(queryTokens)) {
        df.set(token, docs.filter((doc) => doc.includes(token)).length);
    }
    const n = docs.length;
    return {
        score(idx: number): number {
            const doc = docs[idx] ?? [];
            if (doc.length === 0 || queryTokens.length === 0) return 0;
            const counts = new Map<string, number>();
            for (const token of doc) counts.set(token, (counts.get(token) ?? 0) + 1);
            let total = 0;
            for (const token of queryTokens) {
                const tf = counts.get(token) ?? 0;
                if (tf === 0) continue;
                const idf = Math.log(1 + (n - (df.get(token) ?? 0) + 0.5) / ((df.get(token) ?? 0) + 0.5));
                const k1 = 1.2;
                const b = 0.75;
                total += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.length / avgLen))));
            }
            return total;
        },
    };
}

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^a-z0-9а-яё_]+/iu)
        .filter((token) => token.length >= 2);
}
