import type { NodeKind } from '../core/types.js';

// ============================================================================
// Semantic sidecar — type contracts
//
// Model contract (locked for 2-brain federation):
//   Xenova/paraphrase-multilingual-MiniLM-L12-v2 — 384-dim, multilingual ONNX.
//   This matches 2-brain's model so vectors are cross-comparable.
// ============================================================================

/** The fixed embedding model used by the semantic layer. */
export const SEMANTIC_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2' as const;

/** Embedding dimensionality produced by SEMANTIC_MODEL. */
export const SEMANTIC_DIM = 384 as const;

/**
 * Written to `arch-graph-out/<repo>/semantic/manifest.json`.
 * Contains enough metadata to detect index staleness and cross-check
 * model compatibility with 2-brain federation consumers.
 */
export interface SemanticManifest {
    /** Locked value: {@link SEMANTIC_MODEL}. Checked by consumers. */
    model: typeof SEMANTIC_MODEL;
    /** Locked value: {@link SEMANTIC_DIM}. */
    dim: typeof SEMANTIC_DIM;
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
    /** Dense embedding vector of length 384 (float32 cast to JSON numbers). */
    vector: number[];
}

/**
 * Describes one node that was skipped during `semantic build`.
 * Honesty rule: no silent drops — every skipped node must appear here.
 */
export interface SkippedNode {
    nodeId: string;
    kind: NodeKind;
    label: string;
    reason: string;
}

/**
 * The `semantic` field added to `DiagnosticsReport` by Task 2.
 * Field is optional so plain `arch-graph build` keeps emitting the same
 * diagnostics.json shape without breaking existing consumers.
 */
export interface SemanticDiagnostics {
    model: typeof SEMANTIC_MODEL;
    dim: typeof SEMANTIC_DIM;
    counts: {
        indexed: number;
        skipped: number;
        fileReadErrors: number;
        transformerErrors: number;
    };
    /** Capped at 50 entries to keep diagnostics.json small. */
    skippedNodes: SkippedNode[];
    /** Size in bytes of `embeddings.jsonl`. */
    indexSizeBytes: number;
}
