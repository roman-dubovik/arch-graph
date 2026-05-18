import type { NodeKind } from '../core/types.js';

// ============================================================================
// Semantic sidecar — type contracts
//
// Model registry: models are keyed by a short alias.  Each entry records the
// Hugging Face hub ID, output dimensionality, pooling strategy, and whether
// vectors are L2-normalised before storage.
//
// Current supported aliases:
//   minilm   — Xenova/paraphrase-multilingual-MiniLM-L12-v2, 384-dim, mean pooling
//   bge-m3   — Xenova/bge-m3, 1024-dim, CLS pooling
//   e5-base  — Xenova/multilingual-e5-base, 768-dim, mean pooling, REQUIRES PREFIX
//   arctic-m — Snowflake/snowflake-arctic-embed-m-v2.0, 768-dim, CLS pooling,
//              query-prefix only ('query: '); loads fp32 (no quantized variant
//              with the standard model_quantized.onnx name in the upstream repo
//              as of transformers.js@2.17 expectations)
//
// The model name and dim are recorded in `manifest.json` so any external
// consumer can verify vector compatibility before mixing results.
// ============================================================================

/**
 * Dual-prefix spec for models that require a passage/query prefix (e.g. E5 family).
 * Both fields are the literal prefix string to prepend before the text.
 */
export interface EmbedPrefix {
    /** Prefix for document/node embeddings (build time). */
    passage: string;
    /** Prefix for user query embeddings (search time). */
    query: string;
}

/** Short alias for a supported embedding model. */
export type SemanticModelAlias = 'minilm' | 'bge-m3' | 'e5-base' | 'arctic-m';

/**
 * Fallback `minScore` threshold used when the index manifest's model alias is
 * absent from {@link SEMANTIC_MODELS} (i.e. unknown alias at runtime).
 *
 * This is the step-3 fallback in the three-step resolution:
 *   1. User-supplied value (CLI `--min-score` / MCP `minScore`) — always wins.
 *   2. `SEMANTIC_MODELS[alias].recommendedMinScore` — per-model calibration.
 *   3. `DEFAULT_MIN_SCORE_FALLBACK` — when alias is missing or unrecognised.
 */
export const DEFAULT_MIN_SCORE_FALLBACK = 0.30 as const;

/**
 * Resolve the effective `minScore` threshold for a search call using the
 * three-step priority chain:
 *
 *   1. `userValue` — if provided (not undefined), it always wins.
 *   2. `SEMANTIC_MODELS[alias].recommendedMinScore` — per-model calibration.
 *   3. {@link DEFAULT_MIN_SCORE_FALLBACK} (0.30) — unknown / missing alias.
 *
 * @param alias      The model alias resolved from config or manifest.
 * @param userValue  The caller-supplied override, or `undefined` when absent.
 */
export function resolveMinScore(alias: string, userValue?: number): number {
    if (userValue !== undefined) return userValue;
    const entry = (SEMANTIC_MODELS as Record<string, { recommendedMinScore?: number } | undefined>)[alias];
    return entry?.recommendedMinScore ?? DEFAULT_MIN_SCORE_FALLBACK;
}

/** Registry of all supported embedding models. */
export const SEMANTIC_MODELS = {
    minilm: {
        hubId: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
        dim: 384,
        pooling: 'mean' as const,
        normalize: true,
        prefix: undefined,
        quantized: undefined,
        /**
         * Cosine similarity floor for search results.
         * 0.30 matches the historical default — no behaviour change for MiniLM
         * deployments. MiniLM scores are typically 0.30–0.60 for relevant matches.
         */
        recommendedMinScore: 0.30,
    },
    'bge-m3': {
        hubId: 'Xenova/bge-m3',
        dim: 1024,
        pooling: 'cls' as const,
        normalize: true,
        prefix: undefined,
        quantized: undefined,
        /**
         * BGE-M3 scores are typically 0.65–0.80 for relevant matches;
         * a 0.55 floor removes noise while retaining useful results.
         */
        recommendedMinScore: 0.55,
    },
    'e5-base': {
        hubId: 'Xenova/multilingual-e5-base',
        dim: 768,
        pooling: 'mean' as const,
        normalize: true,
        prefix: { passage: 'passage: ', query: 'query: ' } satisfies EmbedPrefix,
        quantized: undefined,
        /**
         * E5-base prefix normalisation yields scores 0.78–0.86 for relevant
         * matches; a 0.55 floor removes low-quality results while preserving
         * relevant cross-lingual hits.
         */
        recommendedMinScore: 0.55,
    },
    // Arctic v2.0 has only model.onnx (no model_quantized.onnx) in the upstream
    // repo, so we force fp32 loading via { quantized: false }.  The 'gte' model
    // type is unknown to @xenova/transformers@2.17 — falls back to the
    // encoder-only base class.  Empirically loads and produces 768-dim output.
    'arctic-m': {
        hubId: 'Snowflake/snowflake-arctic-embed-m-v2.0',
        dim: 768,
        pooling: 'cls' as const,
        normalize: true,
        prefix: { passage: '', query: 'query: ' } satisfies EmbedPrefix,
        quantized: false as const,
        /**
         * Provisional value — arctic-m has not been validated on arch-graph
         * workloads as of 2026-05-18 (transformers.js v3 migration pending).
         * Value is intentionally conservative to avoid over-filtering.
         */
        recommendedMinScore: 0.40,
    },
} as const satisfies Record<SemanticModelAlias, { hubId: string; dim: number; pooling: string; normalize: boolean; prefix?: EmbedPrefix; quantized?: boolean; recommendedMinScore: number }>;

// ---------------------------------------------------------------------------
// Backward-compat aliases — existing code referencing SEMANTIC_MODEL /
// SEMANTIC_DIM continues to compile and behave identically.
// ---------------------------------------------------------------------------

/** Embedding mode: passage (build) or query (search). */
export type EmbedMode = 'passage' | 'query';

/** @deprecated Use `SEMANTIC_MODELS.minilm.hubId` or resolve from config. */
export const SEMANTIC_MODEL = SEMANTIC_MODELS.minilm.hubId;

/** @deprecated Use `SEMANTIC_MODELS.minilm.dim` or resolve from config. */
export const SEMANTIC_DIM = SEMANTIC_MODELS.minilm.dim;

/** Schema version for the manifest. Bump when the sidecar format changes. */
export const SEMANTIC_SCHEMA_VERSION = 2 as const;

/**
 * Written to `arch-graph-out/<repo>/semantic/manifest.json`.
 * Contains enough metadata to detect index staleness and cross-check
 * model compatibility with federation consumers.
 */
export interface SemanticManifest {
    /** Schema version — must equal {@link SEMANTIC_SCHEMA_VERSION}. */
    schemaVersion: typeof SEMANTIC_SCHEMA_VERSION;
    /** Hub ID of the model used to build this index. */
    model: string;
    /** Embedding dimensionality of the model used to build this index. */
    dim: number;
    /** ISO 8601 timestamp of when `semantic build` ran. */
    builtAt: string;
    /** SHA-256 hex of `graph.json` at build time — used to detect staleness. */
    graphHash: string;
    /** Total number of nodes embedded (excluding skipped). */
    nodeCount: number;
}

/**
 * One line in `arch-graph-out/<repo>/semantic/embeddings.jsonl`.
 * Streamable: one JSON object per newline-delimited line.
 */
export interface SemanticRecord {
    nodeId: string;
    kind: NodeKind;
    label: string;
    /** Absolute path to the source file, if the node has one. */
    path?: string;
    /**
     * Up to 400 characters of source snippet. Empty string for nodes that
     * have no associated file (e.g. `nats-subject`, `db-table`). In those
     * cases `label + kind` alone forms the embedding input.
     */
    snippet: string;
    /**
     * SHA-256 hex digest of `kind|label|snippet|modelAlias` (all lowercased).
     * Used by incremental builds to detect which nodes changed since the last
     * index was written. Added in schemaVersion 2.
     */
    contentHash: string;
    /** Dense embedding vector (float32 cast to JSON numbers). Length matches the model's dim. */
    vector: number[];
}

/**
 * Discriminated union of reasons a node was skipped during `semantic build`.
 * Using a DU (rather than a plain string) lets callers switch on `kind`
 * without fragile string prefix checks.
 */
export type SkipReason =
    | { kind: 'file-not-found'; path: string }
    | { kind: 'ts-morph-error'; message: string }
    | { kind: 'label-not-located'; label: string }
    | { kind: 'transformer-error'; message: string };

/**
 * Describes one node that was skipped during `semantic build`.
 * Honesty rule: no silent drops — every skipped node must appear here.
 */
export interface SkippedNode {
    nodeId: string;
    kind: NodeKind;
    label: string;
    reason: SkipReason;
}

/**
 * The `semantic` field added to `DiagnosticsReport` by Task 2.
 * Field is optional so plain `arch-graph build` keeps emitting the same
 * diagnostics.json shape without breaking existing consumers.
 */
export interface SemanticDiagnostics {
    model: string;
    dim: number;
    schemaVersion: typeof SEMANTIC_SCHEMA_VERSION;
    counts: {
        indexed: number;
        skipped: number;
        fileReadErrors: number;
        transformerErrors: number;
        /** Nodes whose label could not be located in the source file. */
        labelErrors: number;
        /** Nodes whose vector was reused from the prior index (incremental build). */
        reused: number;
        /** Nodes that were re-embedded in this run (incremental or full build). */
        recomputed: number;
    };
    /** Capped at {@link SKIPPED_NODES_CAP} entries to keep diagnostics.json small. */
    skippedNodes: SkippedNode[];
    /**
     * True when the skippedNodes list was truncated due to the cap.
     * The total count is still accurate via `counts.skipped`.
     */
    skippedNodesTruncated: boolean;
    /** Size in bytes of `embeddings.jsonl`. */
    indexSizeBytes: number;
}

/** Maximum number of skipped nodes retained in diagnostics (exported for tests). */
export const SKIPPED_NODES_CAP = 10_000 as const;
