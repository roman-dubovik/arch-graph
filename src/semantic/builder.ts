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
import type { SemanticDiagnostics, SemanticManifest, SemanticRecord, SkipReason, SkippedNode } from './types.js';
import { SEMANTIC_DIM, SEMANTIC_MODEL, SEMANTIC_SCHEMA_VERSION, SKIPPED_NODES_CAP } from './types.js';

/** Default batch size for the embedder. Safe for typical RAM budgets. */
export const EMBED_BATCH_SIZE = 32 as const;

// Re-export for backward compat (tests imported from builder.ts).
export { SKIPPED_NODES_CAP };

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
    /**
     * TEST-ONLY: override the skipped-nodes cap to a smaller value for unit tests.
     * Do NOT set in production code — use SKIPPED_NODES_CAP.
     */
    _testOnlySkippedNodesCap?: number;
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
    const { graph, project, embedder, outDir, now = () => new Date().toISOString(), _testOnlySkippedNodesCap } = opts;
    const effectiveCap = _testOnlySkippedNodesCap ?? SKIPPED_NODES_CAP;

    // --- Compute graphHash (SHA-256 of graph.json on disk) ------------------
    const graphJsonPath = join(outDir, 'graph.json');
    const graphJsonContent = await readFile(graphJsonPath, 'utf8');
    const graphHash = createHash('sha256').update(graphJsonContent).digest('hex');

    // --- Sort nodes by id for stable JSONL order (idempotency AC) -----------
    const sortedNodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));

    // --- Extract snippets + build embedding input texts ---------------------
    const snippetMap = new Map<string, string>();
    const textMap = new Map<string, string>();
    // Use a Map keyed by nodeId so each node appears at most once.
    const skippedNodeMap = new Map<string, SkippedNode>();
    let fileReadErrors = 0;
    let labelErrors = 0;
    let skippedNodesTruncated = false;

    /** Push to skippedNodeMap if below cap; record truncation flag when cap is first hit. */
    function recordSkip(node: GraphNode, reason: SkipReason): void {
        if (skippedNodeMap.has(node.id)) return; // already recorded (snippet phase)
        if (skippedNodeMap.size >= effectiveCap) {
            if (!skippedNodesTruncated) {
                skippedNodesTruncated = true;
                process.stderr.write(
                    `[arch-graph semantic] WARNING: skippedNodes cap (${effectiveCap}) reached — further skips omitted from diagnostics.\n`,
                );
            }
            return;
        }
        skippedNodeMap.set(node.id, { nodeId: node.id, kind: node.kind, label: node.label, reason });
    }

    for (const node of sortedNodes) {
        const { snippet, reason } = extractSnippet(project, node);

        if (reason) {
            // Bucket into the appropriate diagnostic counter.
            switch (reason.kind) {
                case 'file-not-found':
                case 'ts-morph-error':
                    fileReadErrors++;
                    break;
                case 'label-not-located':
                    labelErrors++;
                    break;
                case 'transformer-error':
                    // 'transformer-error' is produced in the embed phase (batch catch below),
                    // not in the snippet phase.  Including this case makes the switch
                    // exhaustive — TypeScript will error here if a new SkipReason variant
                    // is added without updating this switch.  This branch is intentionally
                    // unreachable from extractSnippet, so it does not increment any counter.
                    break;
                /* v8 ignore next 5 -- unreachable: all SkipReason variants are covered above;
                   this default exists as a compile-time exhaustiveness guard so that adding
                   a new SkipReason variant without updating this switch is a TS error. */
                default: {
                    const _exhaustive: never = reason;
                    void _exhaustive;
                    break;
                }
            }
            recordSkip(node, reason);
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
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[arch-graph semantic] transformer error: ${message}\n`);
            transformerErrors += batch.length;
            for (const node of batch) {
                failedEmbed.push(node.id);
                recordSkip(node, { kind: 'transformer-error', message });
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

    // --- Compute skipped count --------------------------------------------------
    // "skipped" means NOT indexed (embed failed). Snippet-failed nodes are still
    // embedded (fallback to label+kind), so they count as indexed.
    // Invariant: indexed + skipped === total (sortedNodes.length).
    const skippedCount = failedEmbed.length;

    // --- Write sidecar files ------------------------------------------------
    const semanticDir = join(outDir, 'semantic');
    const manifestPath = join(semanticDir, 'manifest.json');
    const embeddingsPath = join(semanticDir, 'embeddings.jsonl');

    const builtAt = now();
    const manifest: SemanticManifest = {
        schemaVersion: SEMANTIC_SCHEMA_VERSION,
        model: SEMANTIC_MODEL,
        dim: SEMANTIC_DIM,
        builtAt,
        graphHash,
        nodeCount: records.length,
    };

    await writeManifest(manifest, manifestPath);
    await writeEmbeddingsJsonl(records, embeddingsPath);

    const indexSizeBytes = await fileSizeBytes(embeddingsPath);

    const skippedNodes = Array.from(skippedNodeMap.values());

    const semanticDiagnostics: SemanticDiagnostics = {
        model: SEMANTIC_MODEL,
        dim: SEMANTIC_DIM,
        schemaVersion: SEMANTIC_SCHEMA_VERSION,
        counts: {
            indexed: records.length,
            skipped: skippedCount,
            fileReadErrors,
            transformerErrors,
            labelErrors,
        },
        skippedNodes,
        skippedNodesTruncated,
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
 * Distinguishes two cases:
 *   - File absent (ENOENT): start fresh with an empty base object.
 *   - File present but corrupt (JSON.parse fails): throw so the caller sees a
 *     hard failure and existing analyzer data (nats/typeorm/etc.) is NOT silently
 *     overwritten.
 */
async function mergeDiagnostics(outDir: string, semanticDiag: SemanticDiagnostics): Promise<void> {
    const diagPath = join(outDir, 'diagnostics.json');

    let existing: Record<string, unknown> = {};
    try {
        const raw = await readFile(diagPath, 'utf8');
        // Parse separately so JSON.parse errors are NOT swallowed along with ENOENT.
        try {
            existing = JSON.parse(raw) as Record<string, unknown>;
        } catch (parseErr) {
            // diagnostics.json exists but is corrupt — propagate as a hard failure.
            process.stderr.write(
                `[arch-graph semantic] ERROR: diagnostics.json is corrupt and cannot be parsed. ` +
                `Delete it and re-run \`arch-graph build\` to regenerate. ` +
                `Details: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}\n`,
            );
            throw parseErr;
        }
    } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') {
            // File absent — start fresh; the merge still succeeds.
            existing = {};
        } else {
            throw readErr;
        }
    }

    // Inject (or overwrite) only the `semantic` key.
    const merged = { ...existing, semantic: semanticDiag };
    await writeFile(diagPath, JSON.stringify(merged, null, 2), 'utf8');
}
