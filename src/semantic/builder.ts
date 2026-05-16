/**
 * Semantic index builder for arch-graph.
 *
 * Reads graph.json + ts-morph Project, extracts a text snippet per node,
 * embeds in batches of ≤ {@link EMBED_BATCH_SIZE}, and writes the sidecar:
 *   <outDir>/semantic/manifest.json
 *   <outDir>/semantic/embeddings.jsonl
 *
 * Also merges a `semantic` field into <outDir>/diagnostics.json without
 * clobbering any existing fields (nats, typeorm, bullmq, di, http, imports,
 * cycles). This is the anti-clobber contract: read → merge → write back.
 *
 * Injectable embedder: pass a fake in tests, the real `embed` in production.
 * This keeps the test suite free of network calls and model downloads.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from 'ts-morph';

import type { ArchGraph, GraphNode } from '../core/types.js';
import { fileSizeBytes, writeEmbeddingsJsonl, writeManifest } from './io.js';
import { extractSnippet } from './snippet.js';
import type { SemanticDiagnostics, SemanticManifest, SemanticRecord, SkippedNode } from './types.js';
import { SEMANTIC_DIM, SEMANTIC_MODEL } from './types.js';

/** Default batch size for the embedder. Safe for typical RAM budgets. */
export const EMBED_BATCH_SIZE = 32 as const;

/** Maximum number of skipped nodes retained in diagnostics. */
export const SKIPPED_NODES_CAP = 50 as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injectable embedder function. Tests pass a fake; production passes the real one. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface BuildSemanticOpts {
    /** Assembled graph loaded from graph.json (already parsed). */
    graph: ArchGraph;
    /** ts-morph Project initialised with the same source files as arch-graph build. */
    project: Project;
    /** Embedder function — injectable for testability. */
    embedder: EmbedFn;
    /** Directory where arch-graph-out lives (where graph.json is). */
    outDir: string;
    /** Optional ISO timestamp override for deterministic tests. */
    now?: () => string;
}

export interface BuildSemanticResult {
    manifest: SemanticManifest;
    diagnostics: SemanticDiagnostics;
}

// ---------------------------------------------------------------------------
// Core builder
// ---------------------------------------------------------------------------

/**
 * Build the semantic sidecar index. Writes manifest + JSONL to
 * `<outDir>/semantic/` and merges diagnostics into `<outDir>/diagnostics.json`.
 *
 * Never throws on partial node failure — skipped nodes are recorded in
 * diagnostics with a structured reason.
 *
 * @returns manifest + diagnostics for the caller (CLI) to report.
 */
export async function buildSemanticIndex(opts: BuildSemanticOpts): Promise<BuildSemanticResult> {
    const { graph, project, embedder, outDir, now = () => new Date().toISOString() } = opts;

    // --- Compute graphHash (SHA-256 of graph.json on disk) ------------------
    const graphJsonPath = join(outDir, 'graph.json');
    const graphJsonContent = await readFile(graphJsonPath, 'utf8');
    const graphHash = createHash('sha256').update(graphJsonContent).digest('hex');

    // --- Sort nodes by id for stable JSONL order (idempotency AC) -----------
    const sortedNodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));

    // --- Extract snippets + build embedding input texts ---------------------
    const snippetMap = new Map<string, string>();
    const textMap = new Map<string, string>();
    const skippedNodes: SkippedNode[] = [];
    let fileReadErrors = 0;

    for (const node of sortedNodes) {
        const { snippet, reason } = extractSnippet(project, node);

        if (reason) {
            // Determine error type for diagnostic counts
            if (reason.startsWith('file-not-found:') || reason.startsWith('ts-morph-error:')) {
                fileReadErrors++;
            }
            if (skippedNodes.length < SKIPPED_NODES_CAP) {
                skippedNodes.push({ nodeId: node.id, kind: node.kind, label: node.label, reason });
            }
            // A failed snippet means embed just label + kind (still useful)
            snippetMap.set(node.id, '');
            textMap.set(node.id, buildEmbedText(node, ''));
        } else {
            snippetMap.set(node.id, snippet);
            textMap.set(node.id, buildEmbedText(node, snippet));
        }
    }

    // --- Embed in batches ---------------------------------------------------
    const records: SemanticRecord[] = [];
    let transformerErrors = 0;
    const indexed: string[] = [];
    const failedEmbed: string[] = [];

    for (let i = 0; i < sortedNodes.length; i += EMBED_BATCH_SIZE) {
        const batch = sortedNodes.slice(i, i + EMBED_BATCH_SIZE);
        const texts = batch.map((n) => textMap.get(n.id)!);

        let vectors: number[][];
        try {
            vectors = await embedder(texts);
        } catch (err) {
            // Transformer failure for an entire batch — record each node as skipped
            const reason = `transformer-error: ${err instanceof Error ? err.message : String(err)}`;
            transformerErrors += batch.length;
            for (const node of batch) {
                failedEmbed.push(node.id);
                if (skippedNodes.length < SKIPPED_NODES_CAP) {
                    skippedNodes.push({ nodeId: node.id, kind: node.kind, label: node.label, reason });
                }
            }
            continue;
        }

        for (let j = 0; j < batch.length; j++) {
            const node = batch[j]!;
            const vector = vectors[j]!;
            records.push({
                nodeId: node.id,
                kind: node.kind,
                label: node.label,
                path: node.path,
                // snippetMap is populated for every node in sortedNodes above;
                // the non-null assertion is safe.
                snippet: snippetMap.get(node.id)!,
                vector,
            });
            indexed.push(node.id);
        }
    }

    // --- Compute skipped count (snippet failures that weren't embed-failed) --
    const skippedCount = skippedNodes.filter((s) => !failedEmbed.includes(s.nodeId)).length +
        failedEmbed.length;

    // --- Write sidecar files ------------------------------------------------
    const semanticDir = join(outDir, 'semantic');
    const manifestPath = join(semanticDir, 'manifest.json');
    const embeddingsPath = join(semanticDir, 'embeddings.jsonl');

    const builtAt = now();
    const manifest: SemanticManifest = {
        model: SEMANTIC_MODEL,
        dim: SEMANTIC_DIM,
        builtAt,
        graphHash,
        nodeCount: records.length,
    };

    await writeManifest(manifest, manifestPath);
    await writeEmbeddingsJsonl(records, embeddingsPath);

    const indexSizeBytes = await fileSizeBytes(embeddingsPath);

    const semanticDiagnostics: SemanticDiagnostics = {
        model: SEMANTIC_MODEL,
        dim: SEMANTIC_DIM,
        counts: {
            indexed: records.length,
            skipped: skippedCount,
            fileReadErrors,
            transformerErrors,
        },
        skippedNodes: skippedNodes.slice(0, SKIPPED_NODES_CAP),
        indexSizeBytes,
    };

    // --- Merge into diagnostics.json (anti-clobber) -------------------------
    await mergeDiagnostics(outDir, semanticDiagnostics);

    return { manifest, diagnostics: semanticDiagnostics };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the text fed to the embedder for a single node.
 * Nodes without a path embed `label + kind` only — still valuable for
 * "find all queues about retries" style queries.
 */
function buildEmbedText(node: GraphNode, snippet: string): string {
    const base = `${node.label} ${node.kind}`;
    return snippet ? `${base}\n${snippet}` : base;
}

/**
 * Read diagnostics.json (if present), inject the `semantic` field, and write
 * back — without touching any other field. This is the anti-clobber merge.
 *
 * If diagnostics.json is absent (e.g. user ran `semantic build` before `build`),
 * we write a minimal object that satisfies the type contract enough for callers.
 */
async function mergeDiagnostics(outDir: string, semanticDiag: SemanticDiagnostics): Promise<void> {
    const diagPath = join(outDir, 'diagnostics.json');

    let existing: Record<string, unknown> = {};
    try {
        const raw = await readFile(diagPath, 'utf8');
        existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        // File absent or unreadable — start fresh; the merge still succeeds.
    }

    // Inject (or overwrite) only the `semantic` key.
    const merged = { ...existing, semantic: semanticDiag };
    await writeFile(diagPath, JSON.stringify(merged, null, 2), 'utf8');
}
