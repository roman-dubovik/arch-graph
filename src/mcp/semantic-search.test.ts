/**
 * Tests for the `semantic_search` MCP tool.
 *
 * Uses the exported `makeSemanticSearchHandler` factory to call the exact same
 * handler logic that `startMcpServer` registers with the SDK — no transport
 * wiring required, no duplication of search.ts logic.
 *
 * Covers:
 *   PT-P0-1 / PT-P0-2 — real MCP handler path (via handler factory)
 *
 * Cases:
 *   1. Happy path with fixture index (top-K results returned)
 *   2. `query: ""` rejected by Zod min(1) — validated at schema layer
 *   3. `topK: 51` rejected by Zod max(MAX_TOP_K)
 *   4. `topK: 0` rejected by Zod min(1)
 *   5. `topK` omitted → default 10 returned
 *   6. `includeVectors: true` actually attaches vectors
 *   7. Missing sidecar → structured error, no throw
 *   8. Vector-augmentation read failure → `vectorsError` field (SF-P0-1)
 */
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { SemanticManifest, SemanticRecord } from '../semantic/types.js';
import { SEMANTIC_DIM, SEMANTIC_MODEL, SEMANTIC_SCHEMA_VERSION } from '../semantic/types.js';
import { MAX_TOP_K } from '../semantic/search.js';
import { writeEmbeddingsJsonl, writeManifest } from '../semantic/io.js';
import { makeSemanticSearchHandler, semanticSearchInputShape } from './server.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
    testDir = join(
        tmpdir(),
        `arch-graph-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
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
        graphHash: 'deadbeef'.repeat(8),
        nodeCount: 0,
        ...overrides,
    };
}

/** Write an empty graph.json and return its SHA-256. */
async function writeGraphJson(content: string = '{}'): Promise<string> {
    const p = join(testDir, 'graph.json');
    await writeFile(p, content, 'utf8');
    return createHash('sha256').update(content).digest('hex');
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

/** Build a 384-dim unit vector along dimension `axis`. */
function unitVec(axis: number): number[] {
    const v = new Array<number>(SEMANTIC_DIM).fill(0);
    v[axis] = 1;
    return v;
}

/** Fake embedder: always returns unitVec(0). */
const fakeEmbedder = async (_text: string): Promise<number[]> => unitVec(0);

/** Write a full sidecar fixture with N unit-vector records. */
async function writeSidecar(records: SemanticRecord[], graphHash: string): Promise<void> {
    const manifest = makeManifest({ graphHash, nodeCount: records.length });
    await mkdir(join(testDir, 'semantic'), { recursive: true });
    await writeManifest(manifest, join(testDir, 'semantic', 'manifest.json'));
    await writeEmbeddingsJsonl(records, join(testDir, 'semantic', 'embeddings.jsonl'));
}

// ---------------------------------------------------------------------------
// Zod schema for MCP input — built from the exported shape to avoid drift.
// Any change to server.ts's schema is automatically reflected here (PT-P0-1).
// ---------------------------------------------------------------------------

const semanticSearchInputSchema = z.object(semanticSearchInputShape);

// ---------------------------------------------------------------------------
// Case 1: Happy path
// ---------------------------------------------------------------------------

describe('semantic_search handler — happy path', () => {
    it('returns results from a fixture index via the handler', async () => {
        const graphHash = await writeGraphJson('{"nodes":[]}');
        const r1 = makeRecord('service:api', 'service', unitVec(0), { label: 'API Service' });
        const r2 = makeRecord('service:db', 'service', unitVec(1), { label: 'Database' });
        const r3 = makeRecord('nats-subject:orders', 'nats-subject', unitVec(2), {
            label: 'orders subject',
        });
        await writeSidecar([r1, r2, r3], graphHash);

        const handler = makeSemanticSearchHandler({ outDir: testDir, embedder: fakeEmbedder });
        const result = await handler({ query: 'API service', topK: 3, includeVectors: false });

        // Handler returns MCP-wrapped content
        const output = JSON.parse(result.content[0]!.text);
        expect(output.results).toBeDefined();
        expect(Array.isArray(output.results)).toBe(true);
        expect(output.model).toBe(SEMANTIC_MODEL);
        expect(output.dim).toBe(SEMANTIC_DIM);
        expect(typeof output.graphHashMatches).toBe('boolean');
        expect(typeof output.indexBuiltAt).toBe('string');
        expect(output.indexBuiltAt).toBe('2026-05-16T12:00:00.000Z');
        // r1 is closest to query (unitVec(0) === query vector)
        expect(output.results[0]!.nodeId).toBe('service:api');
    });
});

// ---------------------------------------------------------------------------
// Case 2: query: "" rejected by Zod
// ---------------------------------------------------------------------------

describe('semantic_search handler — Zod validation: query', () => {
    it('rejects empty query string via Zod schema', () => {
        expect(() =>
            semanticSearchInputSchema.parse({ query: '' }),
        ).toThrow();
    });

    it('accepts non-empty query string', () => {
        expect(() =>
            semanticSearchInputSchema.parse({ query: 'hello' }),
        ).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// Case 3 & 4: topK out-of-range rejected by Zod
// ---------------------------------------------------------------------------

describe('semantic_search handler — Zod validation: topK', () => {
    it('rejects topK: 51 (above MAX_TOP_K)', () => {
        expect(() =>
            semanticSearchInputSchema.parse({ query: 'q', topK: MAX_TOP_K + 1 }),
        ).toThrow();
    });

    it('rejects topK: 0 (below min 1)', () => {
        expect(() =>
            semanticSearchInputSchema.parse({ query: 'q', topK: 0 }),
        ).toThrow();
    });

    it('accepts topK: 1', () => {
        const parsed = semanticSearchInputSchema.parse({ query: 'q', topK: 1 });
        expect(parsed.topK).toBe(1);
    });

    it('accepts topK: MAX_TOP_K', () => {
        const parsed = semanticSearchInputSchema.parse({ query: 'q', topK: MAX_TOP_K });
        expect(parsed.topK).toBe(MAX_TOP_K);
    });
});

// ---------------------------------------------------------------------------
// Case 5: topK omitted → default 10 returned
// ---------------------------------------------------------------------------

describe('semantic_search handler — topK default', () => {
    it('returns at most 10 results when topK is omitted', async () => {
        const graphHash = await writeGraphJson('{}');
        const count = 15;
        const records = Array.from({ length: count }, (_, i) =>
            makeRecord(`svc:${i}`, 'service', unitVec(0)),
        );
        await writeSidecar(records, graphHash);

        const handler = makeSemanticSearchHandler({ outDir: testDir, embedder: fakeEmbedder });
        // Omit topK — handler defaults to 10
        const result = await handler({ query: 'test' });

        const output = JSON.parse(result.content[0]!.text);
        expect(output.results.length).toBeLessThanOrEqual(10);
    });
});

// ---------------------------------------------------------------------------
// Case 6: includeVectors: true — actually attaches vectors
// ---------------------------------------------------------------------------

describe('semantic_search handler — includeVectors', () => {
    it('attaches embedding vectors to results when includeVectors=true', async () => {
        const graphHash = await writeGraphJson('{}');
        const v1 = unitVec(0);
        const v2 = unitVec(1);
        const r1 = makeRecord('svc:a', 'service', v1);
        const r2 = makeRecord('svc:b', 'service', v2);
        await writeSidecar([r1, r2], graphHash);

        const handler = makeSemanticSearchHandler({ outDir: testDir, embedder: fakeEmbedder });
        const result = await handler({ query: 'test', includeVectors: true });

        const output = JSON.parse(result.content[0]!.text);
        expect(output.results.length).toBeGreaterThan(0);
        // Every result must have a vector of the correct length
        for (const res of output.results) {
            expect(res.vector).toBeDefined();
            expect(res.vector).toHaveLength(SEMANTIC_DIM);
        }
    });

    it('does NOT attach vectors when includeVectors=false (default)', async () => {
        const graphHash = await writeGraphJson('{}');
        await writeSidecar([makeRecord('svc:a', 'service', unitVec(0))], graphHash);

        const handler = makeSemanticSearchHandler({ outDir: testDir, embedder: fakeEmbedder });
        const result = await handler({ query: 'test', includeVectors: false });

        const output = JSON.parse(result.content[0]!.text);
        expect(output.results.length).toBeGreaterThan(0);
        for (const res of output.results) {
            expect(res.vector).toBeUndefined();
        }
    });
});

// ---------------------------------------------------------------------------
// Case 7: Missing sidecar — structured error, no throw
// ---------------------------------------------------------------------------

describe('semantic_search handler — missing sidecar', () => {
    it('returns structured error when sidecar is absent (no throw)', async () => {
        // Do NOT write any sidecar files.
        await writeGraphJson('{}');

        const handler = makeSemanticSearchHandler({ outDir: testDir, embedder: fakeEmbedder });
        // Must NOT throw
        const result = await handler({ query: 'test' });

        const output = JSON.parse(result.content[0]!.text);
        expect(output.error).toBe('semantic-index-missing');
        expect(output.hint).toContain('arch-graph semantic build');
        expect(output.results).toHaveLength(0);
        expect(output.model).toBe(SEMANTIC_MODEL);
        expect(output.dim).toBe(SEMANTIC_DIM);
    });
});

// ---------------------------------------------------------------------------
// Case 8: Vector-augmentation read failure → vectorsError field (SF-P0-1)
// ---------------------------------------------------------------------------

describe('semantic_search handler — vectorsError on augmentation failure', () => {
    it('sets vectorsError when embeddings JSONL is corrupt during vector augmentation', async () => {
        const graphHash = await writeGraphJson('{}');
        // Write a valid manifest
        const manifest = makeManifest({ graphHash, nodeCount: 1 });
        await mkdir(join(testDir, 'semantic'), { recursive: true });
        await writeManifest(manifest, join(testDir, 'semantic', 'manifest.json'));

        // Write a valid record for search to succeed…
        const validRecord = makeRecord('svc:a', 'service', unitVec(0));
        await writeEmbeddingsJsonl([validRecord], join(testDir, 'semantic', 'embeddings.jsonl'));

        // Now monkey-patch readEmbeddingsJsonl to throw on the second call
        // (first call is search.ts scoring, second is vector augmentation).
        const ioModule = await import('../semantic/io.js');
        let callCount = 0;
        const origReadEmbeddingsJsonl = ioModule.readEmbeddingsJsonl;
        vi.spyOn(ioModule, 'readEmbeddingsJsonl').mockImplementation(async function* (path: string, expectedDim: number) {
            callCount++;
            if (callCount === 1) {
                // First call (search scoring): yield normally
                yield* origReadEmbeddingsJsonl(path, expectedDim);
            } else {
                // Second call (vector augmentation): fail
                throw new Error('disk read failure');
            }
        });

        const handler = makeSemanticSearchHandler({ outDir: testDir, embedder: fakeEmbedder });
        const result = await handler({ query: 'test', includeVectors: true });

        const output = JSON.parse(result.content[0]!.text);
        // Results still present (search succeeded)
        expect(output.results.length).toBeGreaterThan(0);
        // vectorsError field set with message
        expect(output.vectorsError).toBeDefined();
        expect(output.vectorsError).toContain('disk read failure');
    });
});

// ---------------------------------------------------------------------------
// Case 9: kinds filter — only doc-section nodes returned
// ---------------------------------------------------------------------------

describe('semantic_search handler — kinds filter: doc-section', () => {
    it('returns only doc-section nodes when kinds: ["doc-section"] is passed', async () => {
        const graphHash = await writeGraphJson('{"nodes":[]}');

        // Mixed-kind sidecar: 2 doc-section + 2 other kinds
        const records = [
            makeRecord('doc-section:readme#install', 'doc-section', unitVec(0), {
                label: 'Installation',
            }),
            makeRecord('doc-section:readme#usage', 'doc-section', unitVec(1), {
                label: 'Usage',
            }),
            makeRecord('service:api', 'service', unitVec(2), { label: 'API Service' }),
            makeRecord('nats-subject:orders', 'nats-subject', unitVec(3), {
                label: 'orders',
            }),
        ];
        await writeSidecar(records, graphHash);

        const handler = makeSemanticSearchHandler({ outDir: testDir, embedder: fakeEmbedder });
        const result = await handler({
            query: 'installation docs',
            topK: 10,
            kinds: ['doc-section'],
            includeVectors: false,
        });

        const output = JSON.parse(result.content[0]!.text);
        expect(output.results).toBeDefined();
        expect(Array.isArray(output.results)).toBe(true);

        // Only doc-section results must be returned
        expect(output.results.length).toBeGreaterThan(0);
        for (const res of output.results as Array<{ nodeId: string; kind: string }>) {
            expect(res.kind).toBe('doc-section');
        }

        // The non-doc-section records must not appear
        const returnedIds = (output.results as Array<{ nodeId: string }>).map((r) => r.nodeId);
        expect(returnedIds).not.toContain('service:api');
        expect(returnedIds).not.toContain('nats-subject:orders');
    });
});

// ---------------------------------------------------------------------------
// Case 10: excludeKinds in handler input — code-vs-docs split
// ---------------------------------------------------------------------------

describe('semantic_search handler — excludeKinds filter', () => {
    it('drops doc-section results when excludeKinds: ["doc-section"] is passed', async () => {
        const graphHash = await writeGraphJson('{"nodes":[]}');
        const records = [
            makeRecord('doc-section:readme#install', 'doc-section', unitVec(0)),
            makeRecord('service:api', 'service', unitVec(0)),
            makeRecord('nats-subject:orders', 'nats-subject', unitVec(0)),
        ];
        await writeSidecar(records, graphHash);

        const handler = makeSemanticSearchHandler({ outDir: testDir, embedder: fakeEmbedder });
        const result = await handler({
            query: 'q',
            topK: 10,
            excludeKinds: ['doc-section'],
            includeVectors: false,
        });

        const output = JSON.parse(result.content[0]!.text);
        for (const res of output.results as Array<{ kind: string }>) {
            expect(res.kind).not.toBe('doc-section');
        }
        expect(output.results).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// Case 11: Factory presets — code_search / docs_search wiring
// ---------------------------------------------------------------------------

describe('makeSemanticSearchHandler — factory presets', () => {
    async function setupMixedSidecar(): Promise<void> {
        const graphHash = await writeGraphJson('{"nodes":[]}');
        await writeSidecar(
            [
                makeRecord('doc-section:readme#install', 'doc-section', unitVec(0)),
                makeRecord('doc-section:readme#usage', 'doc-section', unitVec(0)),
                makeRecord('service:api', 'service', unitVec(0)),
                makeRecord('nats-subject:orders', 'nats-subject', unitVec(0)),
            ],
            graphHash,
        );
    }

    it('preset excludeKinds (code_search style) strips doc-section even when caller omits it', async () => {
        await setupMixedSidecar();

        const handler = makeSemanticSearchHandler({
            outDir: testDir,
            embedder: fakeEmbedder,
            baseExcludeKinds: ['doc-section'],
        });
        const result = await handler({ query: 'q', topK: 10, includeVectors: false });

        const output = JSON.parse(result.content[0]!.text);
        expect(output.results.length).toBe(2);
        for (const res of output.results as Array<{ kind: string }>) {
            expect(res.kind).not.toBe('doc-section');
        }
    });

    it('lockedKinds restricts to its bucket when caller omits kinds', async () => {
        // Schema-level MCP callers cannot pass `kinds` to docs_search (the Zod
        // shape strips it), so this is the production code-path: caller omits
        // kinds, handler returns lockedKinds bucket only.
        await setupMixedSidecar();

        const handler = makeSemanticSearchHandler({
            outDir: testDir,
            embedder: fakeEmbedder,
            lockedKinds: ['doc-section'],
        });
        const result = await handler({ query: 'q', topK: 10, includeVectors: false });

        const output = JSON.parse(result.content[0]!.text);
        expect(output.results.length).toBe(2);
        for (const res of output.results as Array<{ kind: string }>) {
            expect(res.kind).toBe('doc-section');
        }
    });

    it('lockedKinds + caller kinds throws (silent-override guard)', async () => {
        await setupMixedSidecar();

        const handler = makeSemanticSearchHandler({
            outDir: testDir,
            embedder: fakeEmbedder,
            lockedKinds: ['doc-section'],
        });
        // In-process caller attempts to widen — must throw rather than silently
        // discard the caller's input (Zod blocks this path for MCP wire callers).
        await expect(
            handler({
                query: 'q',
                topK: 10,
                kinds: ['service', 'nats-subject'],
                includeVectors: false,
            }),
        ).rejects.toThrow(/lockedKinds/);
    });

    it('baseExcludeKinds merges with caller excludeKinds (additive)', async () => {
        await setupMixedSidecar();

        const handler = makeSemanticSearchHandler({
            outDir: testDir,
            embedder: fakeEmbedder,
            baseExcludeKinds: ['doc-section'],
        });
        const result = await handler({
            query: 'q',
            topK: 10,
            excludeKinds: ['nats-subject'],
            includeVectors: false,
        });

        const output = JSON.parse(result.content[0]!.text);
        const kinds = (output.results as Array<{ kind: string }>).map((r) => r.kind);
        expect(kinds).toEqual(['service']);
    });

    it('lockedKinds preset-poisoning: caller excludeKinds covering lockedKinds yields empty results', async () => {
        // Caller can subtract from the locked bucket via excludeKinds because
        // baseExcludeKinds is additive. The expected behaviour is well-defined:
        // result set = (kinds ∩ ¬excludeKinds), so passing
        // excludeKinds=['doc-section'] to a lockedKinds=['doc-section'] handler
        // yields the empty set — not a runtime error. Document this in a test
        // so it cannot regress silently.
        await setupMixedSidecar();

        const handler = makeSemanticSearchHandler({
            outDir: testDir,
            embedder: fakeEmbedder,
            lockedKinds: ['doc-section'],
        });
        const result = await handler({
            query: 'q',
            topK: 10,
            excludeKinds: ['doc-section'],
            includeVectors: false,
        });

        const output = JSON.parse(result.content[0]!.text);
        expect(output.results).toHaveLength(0);
    });
});
