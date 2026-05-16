/**
 * Unit tests for search.ts.
 *
 * The embedder is injected as a fake — no network calls, no model downloads.
 * File I/O uses a real tmpdir for the sidecar fixtures.
 *
 * Required AC-6 cases (Task 3):
 *  1. kNN cosine correctness on a 5-vector hand-crafted fixture.
 *  2. --kinds filter on a mixed-kind fixture.
 *  3. Empty index → exit 4.
 *  4. Hash mismatch → stderrWarning emitted.
 *
 * Plus coverage-driving cases for cosineSimilarity, zero-norm, missing
 * manifest, embedder failure, and top-K capping.
 */
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SemanticManifest, SemanticRecord } from './types.js';
import { SEMANTIC_DIM, SEMANTIC_MODEL, SEMANTIC_SCHEMA_VERSION } from './types.js';
import { cosineSimilarity, DEFAULT_TOP_K, MAX_TOP_K, semanticSearch } from './search.js';
import { writeEmbeddingsJsonl, writeManifest } from './io.js';
import * as ioModule from './io.js';

// ---------------------------------------------------------------------------
// Test directory lifecycle
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
    testDir = join(
        tmpdir(),
        `arch-graph-search-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    await mkdir(join(testDir, 'semantic'), { recursive: true });
});

afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid SemanticManifest. */
function makeManifest(overrides: Partial<SemanticManifest> = {}): SemanticManifest {
    return {
        schemaVersion: SEMANTIC_SCHEMA_VERSION,
        model: SEMANTIC_MODEL,
        dim: SEMANTIC_DIM,
        builtAt: '2026-05-16T12:00:00.000Z',
        graphHash: 'deadbeef'.repeat(8), // 64-char hex placeholder
        nodeCount: 0,
        ...overrides,
    };
}

/** Write graph.json (empty ArchGraph-like) and return its SHA-256. */
async function writeGraphJson(content: string = '{}'): Promise<string> {
    const p = join(testDir, 'graph.json');
    await writeFile(p, content, 'utf8');
    return createHash('sha256').update(content).digest('hex');
}

/** Write a minimal sidecar with given records and a manifest. */
async function writeSidecar(records: SemanticRecord[], manifest: SemanticManifest): Promise<void> {
    await writeManifest(manifest, join(testDir, 'semantic', 'manifest.json'));
    await writeEmbeddingsJsonl(records, join(testDir, 'semantic', 'embeddings.jsonl'));
}

/** Fake embedder that always returns the provided vector. */
function fakeEmbedder(queryVec: number[]): (text: string) => Promise<number[]> {
    return async (_text: string) => queryVec;
}

/** Build a 384-dim unit vector along dimension `axis`. */
function unitVec(axis: number): number[] {
    const v = new Array<number>(SEMANTIC_DIM).fill(0);
    v[axis] = 1;
    return v;
}

/** Build a minimal SemanticRecord. */
function makeRecord(
    nodeId: string,
    kind: string,
    vector: number[],
    overrides: Partial<SemanticRecord> = {},
): SemanticRecord {
    return {
        nodeId,
        kind: kind as SemanticRecord['kind'],
        label: nodeId,
        snippet: '',
        vector,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Unit: cosineSimilarity
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
    it('returns 1 for identical non-zero vectors', () => {
        const v = [3, 4, 0];
        expect(cosineSimilarity(v, v)).toBeCloseTo(1, 10);
    });

    it('returns 0 for orthogonal vectors', () => {
        expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 10);
    });

    it('returns -1 for anti-parallel vectors', () => {
        expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
    });

    it('returns 0 when norm-a is zero (zero-norm guard branch)', () => {
        expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    });

    it('returns 0 when norm-b is zero (zero-norm guard branch)', () => {
        expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
    });

    it('computes a known value correctly', () => {
        // a=[3,4], b=[4,3]  → dot=24, |a|=5, |b|=5 → sim = 24/25 = 0.96
        expect(cosineSimilarity([3, 4], [4, 3])).toBeCloseTo(0.96, 5);
    });
});

// ---------------------------------------------------------------------------
// AC 6-1: kNN cosine correctness on 5-vector hand-crafted fixture
// ---------------------------------------------------------------------------

describe('semanticSearch — kNN cosine correctness (AC 6-1)', () => {
    /**
     * Fixture: 5 records with 3-dim (padded to 384) vectors.
     *
     * Query vector:  q = [1, 0, 0, ...] (unit along axis 0)
     *
     * Records and their cosine similarity to q:
     *   r1: [1, 0, 0, ...]   → sim = 1.0   (axis 0 only, identical direction)
     *   r2: [1, 1, 0, ...]   → sim = 1/√2 ≈ 0.7071  (45° in plane 0-1)
     *   r3: [0, 1, 0, ...]   → sim = 0.0   (orthogonal)
     *   r4: [-1, 0, 0, ...]  → sim = -1.0  (opposite)
     *   r5: [1, 0, 1, ...]   → sim = 1/√2 ≈ 0.7071  (45° in plane 0-2)
     *
     * Expected order desc: r1 (1.0) > r2 ≈ r5 (0.7071) > r3 (0.0) > r4 (-1.0)
     * r2 and r5 have the same score; their relative order is stable within
     * JavaScript's sort, but we test only that r1 is first and r4 is last.
     */
    it('returns results sorted by cosine score descending', async () => {
        const graphHash = await writeGraphJson('{"nodes":[]}');
        const manifest = makeManifest({ graphHash, nodeCount: 5 });

        const r1 = makeRecord('r1', 'service', unitVec(0));
        const r2 = makeRecord('r2', 'service', (() => { const v = unitVec(0); v[1] = 1; return v; })());
        const r3 = makeRecord('r3', 'service', unitVec(1));
        const r4 = makeRecord('r4', 'service', (() => { const v = unitVec(0); v[0] = -1; return v; })());
        const r5 = makeRecord('r5', 'service', (() => { const v = unitVec(0); v[2] = 1; return v; })());

        await writeSidecar([r1, r2, r3, r4, r5], manifest);

        const queryVec = unitVec(0); // [1, 0, 0, ...]
        const { output, exitCode } = await semanticSearch({
            query: 'test query',
            outDir: testDir,
            embedder: fakeEmbedder(queryVec),
            topK: 5,
        });

        expect(exitCode).toBe(0);
        expect(output.results).toHaveLength(5);

        const ids = output.results.map((r) => r.nodeId);
        // r1 must be first (score = 1.0)
        expect(ids[0]).toBe('r1');
        // r4 must be last (score = -1.0)
        expect(ids[ids.length - 1]).toBe('r4');
        // Scores must be descending
        const scores = output.results.map((r) => r.score);
        for (let i = 0; i < scores.length - 1; i++) {
            expect(scores[i]!).toBeGreaterThanOrEqual(scores[i + 1]!);
        }

        // Verify exact scores for r1 and r4
        expect(output.results[0]!.score).toBeCloseTo(1.0, 5);
        expect(output.results[output.results.length - 1]!.score).toBeCloseTo(-1.0, 5);
    });
});

// ---------------------------------------------------------------------------
// AC 6-2: --kinds filter
// ---------------------------------------------------------------------------

describe('semanticSearch — kinds filter (AC 6-2)', () => {
    it('filters results to requested kind only, then takes top-K of remaining', async () => {
        const graphHash = await writeGraphJson('{"nodes":[]}');
        const manifest = makeManifest({ graphHash, nodeCount: 5 });

        // 3 services, 2 nats-subjects — all vectors point along axis 0 (score = 1.0 for q=[1,0,...])
        const records: SemanticRecord[] = [
            makeRecord('svc1', 'service', unitVec(0)),
            makeRecord('svc2', 'service', unitVec(0)),
            makeRecord('svc3', 'service', unitVec(0)),
            makeRecord('nats1', 'nats-subject', unitVec(0)),
            makeRecord('nats2', 'nats-subject', unitVec(0)),
        ];
        await writeSidecar(records, manifest);

        const { output, exitCode } = await semanticSearch({
            query: 'service query',
            outDir: testDir,
            embedder: fakeEmbedder(unitVec(0)),
            kinds: ['service'],
            topK: 10,
        });

        expect(exitCode).toBe(0);
        expect(output.results).toHaveLength(3);
        for (const r of output.results) {
            expect(r.kind).toBe('service');
        }
        // nats-subjects must be absent
        const ids = output.results.map((r) => r.nodeId);
        expect(ids).not.toContain('nats1');
        expect(ids).not.toContain('nats2');
    });

    it('returns exit 4 when kinds filter removes all results', async () => {
        const graphHash = await writeGraphJson('{}');
        const manifest = makeManifest({ graphHash, nodeCount: 1 });
        await writeSidecar([makeRecord('svc1', 'service', unitVec(0))], manifest);

        const { output, exitCode } = await semanticSearch({
            query: 'q',
            outDir: testDir,
            embedder: fakeEmbedder(unitVec(0)),
            kinds: ['db-table'],
        });

        expect(exitCode).toBe(4);
        expect(output.results).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// AC 6-3: Empty index → exit 4
// ---------------------------------------------------------------------------

describe('semanticSearch — empty index (AC 6-3)', () => {
    it('returns exit 4 and empty results when embeddings.jsonl is empty', async () => {
        const graphHash = await writeGraphJson('{"nodes":[]}');
        const manifest = makeManifest({ graphHash, nodeCount: 0 });
        // writeSidecar with empty records → writes empty JSONL
        await writeSidecar([], manifest);

        const { output, exitCode } = await semanticSearch({
            query: 'anything',
            outDir: testDir,
            embedder: fakeEmbedder(unitVec(0)),
        });

        expect(exitCode).toBe(4);
        expect(output.results).toHaveLength(0);
        expect(output.query).toBe('anything');
        expect(output.model).toBe(SEMANTIC_MODEL);
        expect(output.dim).toBe(SEMANTIC_DIM);
    });
});

// ---------------------------------------------------------------------------
// AC 6-4: Hash mismatch → stderrWarning emitted
// ---------------------------------------------------------------------------

describe('semanticSearch — hash mismatch (AC 6-4)', () => {
    it('emits stderrWarning and sets graphHashMatches=false when hash differs', async () => {
        // Write graph.json with specific content
        await writeGraphJson('{"nodes":[], "version":"1"}');
        // Manifest intentionally has a different hash
        const manifest = makeManifest({ graphHash: 'a'.repeat(64), nodeCount: 1 });
        await writeSidecar([makeRecord('svc1', 'service', unitVec(0))], manifest);

        const { output, stderrWarning } = await semanticSearch({
            query: 'q',
            outDir: testDir,
            embedder: fakeEmbedder(unitVec(0)),
        });

        expect(output.graphHashMatches).toBe(false);
        expect(stderrWarning).toBeTruthy();
        expect(stderrWarning).toContain('hash mismatch');
    });

    it('sets graphHashMatches=true when hashes match', async () => {
        const graphHash = await writeGraphJson('{"nodes":[]}');
        const manifest = makeManifest({ graphHash, nodeCount: 1 });
        await writeSidecar([makeRecord('svc1', 'service', unitVec(0))], manifest);

        const { output, stderrWarning } = await semanticSearch({
            query: 'q',
            outDir: testDir,
            embedder: fakeEmbedder(unitVec(0)),
        });

        expect(output.graphHashMatches).toBe(true);
        expect(stderrWarning).toBeUndefined();
    });

    it('emits stderrWarning when graph.json is missing', async () => {
        // Do NOT write graph.json
        const manifest = makeManifest({ graphHash: 'b'.repeat(64), nodeCount: 1 });
        await writeSidecar([makeRecord('svc1', 'service', unitVec(0))], manifest);

        const { output, stderrWarning } = await semanticSearch({
            query: 'q',
            outDir: testDir,
            embedder: fakeEmbedder(unitVec(0)),
        });

        expect(output.graphHashMatches).toBe(false);
        expect(stderrWarning).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// Missing sidecar → exit 1
// ---------------------------------------------------------------------------

describe('semanticSearch — missing sidecar', () => {
    it('returns exit 1 and structured error when manifest is absent', async () => {
        // No sidecar files written at all

        const { output, exitCode } = await semanticSearch({
            query: 'q',
            outDir: testDir,
            embedder: fakeEmbedder(unitVec(0)),
        });

        expect(exitCode).toBe(1);
        expect(output.error).toBe('semantic-index-missing');
        expect(output.hint).toContain('arch-graph semantic build');
        expect(output.results).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Corrupt/unreadable embeddings.jsonl → exit 1
// ---------------------------------------------------------------------------

describe('semanticSearch — corrupt embeddings', () => {
    it('returns exit 1 and semantic-index-corrupt error when embeddings.jsonl has bad JSON', async () => {
        const graphHash = await writeGraphJson('{}');
        const manifest = makeManifest({ graphHash, nodeCount: 1 });
        // Write manifest but write garbage (not valid JSONL) to embeddings.jsonl
        await writeManifest(manifest, join(testDir, 'semantic', 'manifest.json'));
        await writeFile(join(testDir, 'semantic', 'embeddings.jsonl'), 'NOT_VALID_JSON\n', 'utf8');

        const { output, exitCode } = await semanticSearch({
            query: 'q',
            outDir: testDir,
            embedder: fakeEmbedder(unitVec(0)),
        });

        expect(exitCode).toBe(1);
        expect(output.error).toBe('semantic-index-corrupt');
    });

    it('returns semantic-index-corrupt when embeddings.jsonl has a wrong-dim vector', async () => {
        const graphHash = await writeGraphJson('{}');
        const manifest = makeManifest({ graphHash, nodeCount: 1 });
        await writeManifest(manifest, join(testDir, 'semantic', 'manifest.json'));
        // Write a record with a 3-dim vector instead of 384-dim
        const shortVector = [1, 2, 3];
        const badLine = JSON.stringify({ nodeId: 'svc:x', kind: 'service', label: 'x', snippet: '', vector: shortVector });
        await writeFile(join(testDir, 'semantic', 'embeddings.jsonl'), badLine + '\n', 'utf8');

        const { output, exitCode } = await semanticSearch({
            query: 'q',
            outDir: testDir,
            embedder: fakeEmbedder(unitVec(0)),
        });

        expect(exitCode).toBe(1);
        expect(output.error).toBe('semantic-index-corrupt');
    });
});

// ---------------------------------------------------------------------------
// Non-Error JSONL read failure (line 249 branch coverage)
// ---------------------------------------------------------------------------

describe('semanticSearch — non-Error JSONL read failure', () => {
    it('returns semantic-index-corrupt when readEmbeddingsJsonl throws a non-Error', async () => {
        const graphHash = await writeGraphJson('{}');
        const manifest = makeManifest({ graphHash, nodeCount: 1 });
        await writeSidecar([makeRecord('svc1', 'service', unitVec(0))], manifest);

        // Mock readEmbeddingsJsonl to throw a plain string (non-Error)
        vi.spyOn(ioModule, 'readEmbeddingsJsonl').mockImplementation(async function* () {
            // eslint-disable-next-line @typescript-eslint/no-throw-literal
            throw 'non-error string';
        });

        const { output, exitCode } = await semanticSearch({
            query: 'q',
            outDir: testDir,
            embedder: fakeEmbedder(unitVec(0)),
        });

        expect(exitCode).toBe(1);
        expect(output.error).toBe('semantic-index-corrupt');
    });
});

// ---------------------------------------------------------------------------
// Cosine math: dot() nullish-coalesce branch (line 135)
// ---------------------------------------------------------------------------

describe('cosineSimilarity — extra branch coverage', () => {
    it('handles mismatched-length vectors gracefully via ?? 0', () => {
        // a is shorter than b — the missing a[i] elements are treated as 0.
        // cos([1], [1, 1]) = dot([1, 0], [1, 1]) / (norm([1, 0]) * norm([1, 1]))
        //   = 1 / (1 * sqrt(2)) ≈ 0.707
        const result = cosineSimilarity([1], [1, 1]);
        expect(result).toBeCloseTo(1 / Math.sqrt(2), 5);
    });
});

// ---------------------------------------------------------------------------
// Embedder failure → exit 1
// ---------------------------------------------------------------------------

describe('semanticSearch — embedder failure', () => {
    it('returns exit 1 when the embedder throws an Error', async () => {
        const graphHash = await writeGraphJson('{}');
        const manifest = makeManifest({ graphHash, nodeCount: 1 });
        await writeSidecar([makeRecord('svc1', 'service', unitVec(0))], manifest);

        const throwingEmbedder = async (_text: string): Promise<number[]> => {
            throw new Error('model unavailable');
        };

        const { output, exitCode } = await semanticSearch({
            query: 'q',
            outDir: testDir,
            embedder: throwingEmbedder,
        });

        expect(exitCode).toBe(1);
        expect(output.results).toHaveLength(0);
        expect(output.embedError).toBe('model unavailable');
    });

    it('returns exit 1 and embedError when embedder throws a non-Error value', async () => {
        const graphHash = await writeGraphJson('{}');
        const manifest = makeManifest({ graphHash, nodeCount: 1 });
        await writeSidecar([makeRecord('svc1', 'service', unitVec(0))], manifest);

        const throwingEmbedder = async (_text: string): Promise<number[]> => {
            // eslint-disable-next-line @typescript-eslint/no-throw-literal
            throw 'plain string error';
        };

        const { output, exitCode } = await semanticSearch({
            query: 'q',
            outDir: testDir,
            embedder: throwingEmbedder,
        });

        expect(exitCode).toBe(1);
        expect(output.embedError).toBe('plain string error');
    });
});

// ---------------------------------------------------------------------------
// top-K capping and defaults
// ---------------------------------------------------------------------------

describe('semanticSearch — top-K behaviour', () => {
    it('respects the requested topK', async () => {
        const graphHash = await writeGraphJson('{}');
        const manifest = makeManifest({ graphHash, nodeCount: 5 });
        const records = Array.from({ length: 5 }, (_, i) =>
            makeRecord(`r${i}`, 'service', unitVec(i % 3)),
        );
        await writeSidecar(records, manifest);

        const { output } = await semanticSearch({
            query: 'q',
            outDir: testDir,
            embedder: fakeEmbedder(unitVec(0)),
            topK: 3,
        });

        expect(output.results.length).toBeLessThanOrEqual(3);
    });

    it(`caps topK at ${MAX_TOP_K} even if caller requests more`, async () => {
        const graphHash = await writeGraphJson('{}');
        const count = MAX_TOP_K + 10;
        const manifest = makeManifest({ graphHash, nodeCount: count });
        const records = Array.from({ length: count }, (_, i) =>
            makeRecord(`r${i}`, 'service', unitVec(0)),
        );
        await writeSidecar(records, manifest);

        const { output } = await semanticSearch({
            query: 'q',
            outDir: testDir,
            embedder: fakeEmbedder(unitVec(0)),
            topK: 999,
        });

        expect(output.results.length).toBeLessThanOrEqual(MAX_TOP_K);
    });

    it(`uses default topK of ${DEFAULT_TOP_K} when not specified`, async () => {
        const graphHash = await writeGraphJson('{}');
        const count = DEFAULT_TOP_K + 5;
        const manifest = makeManifest({ graphHash, nodeCount: count });
        const records = Array.from({ length: count }, (_, i) =>
            makeRecord(`r${i}`, 'service', unitVec(0)),
        );
        await writeSidecar(records, manifest);

        const { output } = await semanticSearch({
            query: 'q',
            outDir: testDir,
            embedder: fakeEmbedder(unitVec(0)),
        });

        expect(output.results.length).toBeLessThanOrEqual(DEFAULT_TOP_K);
    });
});

// ---------------------------------------------------------------------------
// Output shape: MCP contract fields
// ---------------------------------------------------------------------------

describe('semanticSearch — output shape', () => {
    it('emits all required MCP contract fields', async () => {
        const graphHash = await writeGraphJson('{}');
        const manifest = makeManifest({ graphHash, builtAt: '2026-05-16T12:00:00.000Z' });
        await writeSidecar([makeRecord('svc1', 'service', unitVec(0), { path: '/src/a.ts', snippet: 'class A {}' })], manifest);

        const { output } = await semanticSearch({
            query: 'hello',
            outDir: testDir,
            embedder: fakeEmbedder(unitVec(0)),
        });

        expect(output.query).toBe('hello');
        expect(output.model).toBe(SEMANTIC_MODEL);
        expect(output.dim).toBe(SEMANTIC_DIM);
        expect(output.indexBuiltAt).toBe('2026-05-16T12:00:00.000Z');
        expect(typeof output.graphHashMatches).toBe('boolean');
        expect(Array.isArray(output.results)).toBe(true);

        const r = output.results[0]!;
        expect(r.nodeId).toBeDefined();
        expect(r.kind).toBeDefined();
        expect(r.label).toBeDefined();
        expect(typeof r.score).toBe('number');
        // path and snippet are optional but present here
        expect(r.path).toBe('/src/a.ts');
        expect(r.snippet).toBe('class A {}');
        // vector must NOT be present (CLI layer; MCP layer adds it optionally)
        expect(r.vector).toBeUndefined();
    });

    it('omits path and snippet when they are empty', async () => {
        const graphHash = await writeGraphJson('{}');
        const manifest = makeManifest({ graphHash });
        // snippet='', no path
        await writeSidecar([makeRecord('svc1', 'service', unitVec(0))], manifest);

        const { output } = await semanticSearch({
            query: 'q',
            outDir: testDir,
            embedder: fakeEmbedder(unitVec(0)),
        });

        const r = output.results[0]!;
        expect(r.path).toBeUndefined();
        expect(r.snippet).toBeUndefined();
    });
});
