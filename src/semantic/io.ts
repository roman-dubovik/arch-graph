/**
 * Read/write helpers for the semantic sidecar on disk.
 *
 * Layout:
 *   arch-graph-out/<repo>/semantic/
 *     manifest.json    — SemanticManifest (pretty-printed JSON)
 *     embeddings.jsonl — one SemanticRecord per newline-delimited line
 *
 * The JSONL file is written and read one record at a time so it stays
 * streamable for very large graphs (5k+ nodes).
 */
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname } from 'node:path';

import type { SemanticManifest, SemanticRecord } from './types.js';
import { SEMANTIC_SCHEMA_VERSION } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureDir(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * Write the sidecar manifest to `outPath` (pretty-printed for readability).
 */
export async function writeManifest(
    manifest: SemanticManifest,
    outPath: string,
): Promise<void> {
    await ensureDir(outPath);
    await writeFile(outPath, JSON.stringify(manifest, null, 2), 'utf8');
}

/**
 * Read and parse the sidecar manifest from `outPath`.
 *
 * @param outPath - Path to `manifest.json`.
 * @param expected - Optional model/dim values to validate against.  When
 *   supplied, throws if the manifest's model or dim does not match.  When
 *   omitted, only the schemaVersion is checked (backward-compat path for
 *   callers that don't know which model they're searching with yet).
 *
 * Throws if the file is missing, cannot be parsed, or fails any validation.
 * Callers should treat the error as "semantic-index-corrupt" or
 * "semantic-index-missing" depending on whether ENOENT is set.
 */
export async function readManifest(
    outPath: string,
    expected?: { model: string; dim: number },
): Promise<SemanticManifest> {
    const raw = await readFile(outPath, 'utf8');
    const parsed = JSON.parse(raw) as SemanticManifest;

    // Always validate schemaVersion.
    if (parsed.schemaVersion !== SEMANTIC_SCHEMA_VERSION) {
        throw new Error(
            `manifest from incompatible build: schemaVersion=${parsed.schemaVersion} (expected ${SEMANTIC_SCHEMA_VERSION}). ` +
            `run: arch-graph semantic build`,
        );
    }

    // Validate model and dim only when the caller supplies expected values.
    if (expected !== undefined) {
        if (parsed.model !== expected.model) {
            throw new Error(
                `manifest from incompatible build: model="${parsed.model}" (expected "${expected.model}"). ` +
                `run: arch-graph semantic build`,
            );
        }
        if (parsed.dim !== expected.dim) {
            throw new Error(
                `manifest from incompatible build: dim=${parsed.dim} (expected ${expected.dim}). ` +
                `run: arch-graph semantic build`,
            );
        }
    }

    return parsed;
}

// ---------------------------------------------------------------------------
// Embeddings JSONL
// ---------------------------------------------------------------------------

/**
 * Write an array of records to `outPath` in JSONL format
 * (one JSON object per line, no trailing newline).
 */
export async function writeEmbeddingsJsonl(
    records: SemanticRecord[],
    outPath: string,
): Promise<void> {
    await ensureDir(outPath);
    const lines = records.map((r) => JSON.stringify(r));
    await writeFile(outPath, lines.join('\n'), 'utf8');
}

/**
 * Stream-read `embeddings.jsonl`, yielding one {@link SemanticRecord} per line.
 *
 * @param outPath - Path to `embeddings.jsonl`.
 * @param expectedDim - Expected vector dimensionality.  Each record's vector
 *   length is compared against this value; a mismatch throws so the caller can
 *   surface a `semantic-index-corrupt` error rather than silently returning
 *   wrong-length vectors.
 *
 * Malformed lines throw so the caller can decide how to handle corruption.
 * The generator yields nothing for an empty file.
 */
export async function* readEmbeddingsJsonl(
    outPath: string,
    expectedDim: number,
): AsyncGenerator<SemanticRecord> {
    // Check if file exists and is non-empty before streaming.
    const stats = await stat(outPath);
    if (stats.size === 0) return;

    const rl = createInterface({
        input: createReadStream(outPath, 'utf8'),
        crlfDelay: Infinity,
    });

    for await (const line of rl) {
        if (line.trim() === '') continue;
        const record = JSON.parse(line) as SemanticRecord;
        // Contract enforcement: dim mismatch means the index was built with a
        // different model — fail fast rather than silently returning wrong vectors.
        if (record.vector.length !== expectedDim) {
            throw new Error(
                `embeddings.jsonl: nodeId="${record.nodeId}" has vector length ${record.vector.length} ` +
                `(expected ${expectedDim}). run: arch-graph semantic build`,
            );
        }
        yield record;
    }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Return the byte size of `filePath`, or `0` if the file does not exist.
 */
export async function fileSizeBytes(filePath: string): Promise<number> {
    try {
        const s = await stat(filePath);
        return s.size;
    } catch (err) {
        // Silently return 0 only when the file is absent (ENOENT).
        // Any other error (permissions, I/O, …) is re-thrown so it surfaces.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw err;
    }
}
