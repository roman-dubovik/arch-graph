import type { NodeKind } from '../core/types.js';

// ============================================================================
// Semantic sidecar — type contracts
//
// Model contract (locked for cross-tool federation):
//   Xenova/paraphrase-multilingual-MiniLM-L12-v2 — 384-dim, multilingual ONNX.
//   The model name is recorded in `manifest.json` so any external consumer
//   can verify vector compatibility before mixing results.
// ============================================================================

/** The fixed embedding model used by the semantic layer. */
export const SEMANTIC_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2' as const;

/** Embedding dimensionality produced by SEMANTIC_MODEL. */
export const SEMANTIC_DIM = 384 as const;

/** Schema version for the manifest. Bump when the sidecar format changes. */
export const SEMANTIC_SCHEMA_VERSION = 1 as const;

/**
 * Written to `arch-graph-out/<repo>/semantic/manifest.json`.
 * Contains enough metadata to detect index staleness and cross-check
 * model compatibility with federation consumers.
 */
export interface SemanticManifest {
    /** Schema version — must equal {@link SEMANTIC_SCHEMA_VERSION}. */
    schemaVersion: typeof SEMANTIC_SCHEMA_VERSION;
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
    model: typeof SEMANTIC_MODEL;
    dim: typeof SEMANTIC_DIM;
    schemaVersion: typeof SEMANTIC_SCHEMA_VERSION;
    counts: {
        indexed: number;
        skipped: number;
        fileReadErrors: number;
        transformerErrors: number;
        /** Nodes whose label could not be located in the source file. */
        labelErrors: number;
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
