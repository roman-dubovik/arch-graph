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
 * Throws if the file is missing or cannot be parsed.
 */
export async function readManifest(outPath: string): Promise<SemanticManifest> {
    const raw = await readFile(outPath, 'utf8');
    return JSON.parse(raw) as SemanticManifest;
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
 * Malformed lines throw so the caller can decide how to handle corruption.
 * The generator yields nothing for an empty file.
 */
export async function* readEmbeddingsJsonl(
    outPath: string,
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
        yield JSON.parse(line) as SemanticRecord;
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
    } catch {
        return 0;
    }
}
