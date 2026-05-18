/**
 * Unit tests for io.ts.
 *
 * Uses Node's os.tmpdir() for ephemeral file I/O — no test fixtures on disk.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SemanticManifest, SemanticRecord } from './types.js';
import {
    fileSizeBytes,
    readEmbeddingsJsonl,
    readManifest,
    writeEmbeddingsJsonl,
    writeManifest,
} from './io.js';
import { SEMANTIC_DIM, SEMANTIC_MODEL, SEMANTIC_SCHEMA_VERSION } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
    testDir = join(tmpdir(), `arch-graph-io-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
});

function makeManifest(overrides: Partial<SemanticManifest> = {}): SemanticManifest {
    return {
        schemaVersion: SEMANTIC_SCHEMA_VERSION,
        model: SEMANTIC_MODEL,
        dim: SEMANTIC_DIM,
        builtAt: '2026-05-16T00:00:00.000Z',
        graphHash: 'abc123def456',
        nodeCount: 3,
        ...overrides,
    };
}

function makeRecord(nodeId: string, overrides: Partial<SemanticRecord> = {}): SemanticRecord {
    return {
        nodeId,
        kind: 'service',
        label: `Label${nodeId}`,
        snippet: `snippet for ${nodeId}`,
        vector: Array.from({ length: 384 }, (_, i) => i / 384),
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// writeManifest / readManifest
// ---------------------------------------------------------------------------

describe('writeManifest + readManifest', () => {
    it('roundtrips a manifest object', async () => {
        const manifestPath = join(testDir, 'manifest.json');
        const manifest = makeManifest();
        await writeManifest(manifest, manifestPath);
        const parsed = await readManifest(manifestPath);
        expect(parsed).toEqual(manifest);
    });

    it('creates parent directories if needed', async () => {
        const manifestPath = join(testDir, 'deep', 'nested', 'manifest.json');
        const manifest = makeManifest();
        await expect(writeManifest(manifest, manifestPath)).resolves.not.toThrow();
        const parsed = await readManifest(manifestPath);
        expect(parsed.model).toBe(SEMANTIC_MODEL);
    });

    it('writes pretty-printed JSON (not minified)', async () => {
        const manifestPath = join(testDir, 'manifest.json');
        await writeManifest(makeManifest(), manifestPath);
        const raw = await readFile(manifestPath, 'utf8');
        expect(raw).toContain('\n');
    });

    it('readManifest throws on missing file', async () => {
        await expect(readManifest(join(testDir, 'nonexistent.json'))).rejects.toThrow();
    });

    it('readManifest throws on malformed JSON', async () => {
        const manifestPath = join(testDir, 'bad.json');
        await writeFile(manifestPath, '{ not valid json', 'utf8');
        await expect(readManifest(manifestPath)).rejects.toThrow();
    });

    it('readManifest throws on incompatible schemaVersion', async () => {
        const manifestPath = join(testDir, 'wrong-schema.json');
        const bad = { ...makeManifest(), schemaVersion: 99 };
        await writeFile(manifestPath, JSON.stringify(bad), 'utf8');
        await expect(readManifest(manifestPath)).rejects.toThrow(/schemaVersion/);
    });

    it('readManifest throws on incompatible model when expected is supplied', async () => {
        const manifestPath = join(testDir, 'wrong-model.json');
        const bad = { ...makeManifest(), model: 'some-other-model' };
        await writeFile(manifestPath, JSON.stringify(bad), 'utf8');
        await expect(
            readManifest(manifestPath, { model: SEMANTIC_MODEL, dim: SEMANTIC_DIM }),
        ).rejects.toThrow(/model/);
    });

    it('readManifest does NOT throw on model mismatch when expected is omitted', async () => {
        const manifestPath = join(testDir, 'other-model-no-expected.json');
        // some-other-model manifest — valid schemaVersion, different model (hub-id is an arbitrary string)
        const bge = { ...makeManifest(), model: 'OtherOrg/some-other-model', dim: 1024 };
        await writeFile(manifestPath, JSON.stringify(bge), 'utf8');
        await expect(readManifest(manifestPath)).resolves.not.toThrow();
    });

    it('readManifest throws on incompatible dim when expected is supplied', async () => {
        const manifestPath = join(testDir, 'wrong-dim.json');
        const bad = { ...makeManifest(), dim: 768 };
        await writeFile(manifestPath, JSON.stringify(bad), 'utf8');
        await expect(
            readManifest(manifestPath, { model: SEMANTIC_MODEL, dim: SEMANTIC_DIM }),
        ).rejects.toThrow(/dim/);
    });
});

// ---------------------------------------------------------------------------
// writeEmbeddingsJsonl / readEmbeddingsJsonl
// ---------------------------------------------------------------------------

describe('writeEmbeddingsJsonl + readEmbeddingsJsonl', () => {
    it('roundtrips a 3-node fixture', async () => {
        const records = [
            makeRecord('node-1'),
            makeRecord('node-2', { kind: 'module', path: '/project/src/app.module.ts' }),
            makeRecord('node-3', { kind: 'nats-subject', snippet: '', path: undefined }),
        ];
        const jsonlPath = join(testDir, 'embeddings.jsonl');
        await writeEmbeddingsJsonl(records, jsonlPath);

        const collected: SemanticRecord[] = [];
        for await (const rec of readEmbeddingsJsonl(jsonlPath, SEMANTIC_DIM)) {
            collected.push(rec);
        }
        expect(collected).toHaveLength(3);
        expect(collected[0].nodeId).toBe('node-1');
        expect(collected[1].kind).toBe('module');
        expect(collected[2].snippet).toBe('');
    });

    it('preserves 384-dim vectors exactly', async () => {
        const vec = Array.from({ length: 384 }, (_, i) => Math.sin(i));
        const records = [makeRecord('vec-node', { vector: vec })];
        const jsonlPath = join(testDir, 'embeddings.jsonl');
        await writeEmbeddingsJsonl(records, jsonlPath);

        const collected: SemanticRecord[] = [];
        for await (const rec of readEmbeddingsJsonl(jsonlPath, SEMANTIC_DIM)) {
            collected.push(rec);
        }
        // JSON serialization rounds floats but they should remain close.
        const roundtripped = collected[0].vector;
        expect(roundtripped).toHaveLength(SEMANTIC_DIM);
        for (let i = 0; i < 384; i++) {
            expect(roundtripped[i]).toBeCloseTo(vec[i], 10);
        }
    });

    it('writes one JSON object per line', async () => {
        const records = [makeRecord('a'), makeRecord('b')];
        const jsonlPath = join(testDir, 'embeddings.jsonl');
        await writeEmbeddingsJsonl(records, jsonlPath);
        const raw = await readFile(jsonlPath, 'utf8');
        const lines = raw.trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(() => JSON.parse(lines[0])).not.toThrow();
        expect(() => JSON.parse(lines[1])).not.toThrow();
    });

    it('yields nothing for an empty file', async () => {
        const jsonlPath = join(testDir, 'empty.jsonl');
        await writeFile(jsonlPath, '', 'utf8');
        const collected: SemanticRecord[] = [];
        for await (const rec of readEmbeddingsJsonl(jsonlPath, SEMANTIC_DIM)) {
            collected.push(rec);
        }
        expect(collected).toHaveLength(0);
    });

    it('throws on malformed JSONL line', async () => {
        const jsonlPath = join(testDir, 'bad.jsonl');
        await writeFile(jsonlPath, '{"nodeId":"ok","kind":"service","label":"L","snippet":"","vector":[]}\nnot json\n', 'utf8');

        const collected: SemanticRecord[] = [];
        await expect(async () => {
            for await (const rec of readEmbeddingsJsonl(jsonlPath, SEMANTIC_DIM)) {
                collected.push(rec);
            }
        }).rejects.toThrow();
    });

    it('skips blank lines inside JSONL without error', async () => {
        const jsonlPath = join(testDir, 'blanks.jsonl');
        // Write a JSONL file with a blank line between records (exercises the trim branch).
        const line = JSON.stringify(makeRecord('blank-test'));
        await writeFile(jsonlPath, `${line}\n\n${line}\n`, 'utf8');
        const collected: SemanticRecord[] = [];
        for await (const rec of readEmbeddingsJsonl(jsonlPath, SEMANTIC_DIM)) {
            collected.push(rec);
        }
        expect(collected).toHaveLength(2);
    });

    it('creates parent directories when writing', async () => {
        const jsonlPath = join(testDir, 'subdir', 'embeddings.jsonl');
        await expect(writeEmbeddingsJsonl([makeRecord('x')], jsonlPath)).resolves.not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// fileSizeBytes
// ---------------------------------------------------------------------------

describe('fileSizeBytes', () => {
    it('returns file size in bytes', async () => {
        const path = join(testDir, 'sample.txt');
        await writeFile(path, 'hello', 'utf8');
        const size = await fileSizeBytes(path);
        expect(size).toBe(5);
    });

    it('returns 0 for a missing file', async () => {
        const size = await fileSizeBytes(join(testDir, 'missing.txt'));
        expect(size).toBe(0);
    });

});
