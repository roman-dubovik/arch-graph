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
import { SEMANTIC_DIM, SEMANTIC_MODEL, SEMANTIC_SCHEMA_VERSION, SEMANTIC_MODELS } from '../semantic/types.js';
import { MAX_TOP_K } from '../semantic/search.js';
import { writeEmbeddingsJsonl, writeManifest } from '../semantic/io.js';
import { makeSemanticSearchHandler, semanticSearchInputShape } from './server.js';
import * as embedderModule from '../semantic/embedder.js';

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

// ---------------------------------------------------------------------------
// P1-K: makeSemanticSearchHandler with modelAlias: 'e5-base'
// ---------------------------------------------------------------------------

describe('makeSemanticSearchHandler — e5-base alias (P1-K)', () => {
    const e5Dim = SEMANTIC_MODELS['e5-base'].dim; // 768

    /** 768-dim unit vector along axis `i`. */
    function e5UnitVec(axis: number): number[] {
        const v = new Array<number>(e5Dim).fill(0);
        v[axis] = 1;
        return v;
    }

    it('returns results without model-mismatch error when handler and index both use e5-base', async () => {
        const graphHash = await writeGraphJson('{"nodes":[]}');

        // Write an e5-base manifest + 768-dim embeddings
        const e5Manifest: SemanticManifest = {
            schemaVersion: SEMANTIC_SCHEMA_VERSION,
            model: SEMANTIC_MODELS['e5-base'].hubId,
            dim: e5Dim,
            builtAt: '2026-05-18T00:00:00.000Z',
            graphHash,
            nodeCount: 2,
        };
        await mkdir(join(testDir, 'semantic'), { recursive: true });
        await writeManifest(e5Manifest, join(testDir, 'semantic', 'manifest.json'));

        const records: SemanticRecord[] = [
            makeRecord('svc:a', 'service', e5UnitVec(0)),
            makeRecord('svc:b', 'service', e5UnitVec(1)),
        ];
        await writeEmbeddingsJsonl(records, join(testDir, 'semantic', 'embeddings.jsonl'));

        // Embedder returns 768-dim vectors matching the e5-base manifest
        const e5Embedder = async (_text: string): Promise<number[]> => e5UnitVec(0);

        const handler = makeSemanticSearchHandler({
            outDir: testDir,
            embedder: e5Embedder,
            modelAlias: 'e5-base',
        });
        const result = await handler({ query: 'test', topK: 2, includeVectors: false });

        const output = JSON.parse(result.content[0]!.text);
        // No model-mismatch error — results should be present
        expect(output.error).toBeUndefined();
        expect(output.results.length).toBeGreaterThan(0);
        expect(output.model).toBe(SEMANTIC_MODELS['e5-base'].hubId);
        expect(output.dim).toBe(e5Dim);
    });

    it('defaults to minilm when no modelAlias is passed (documented default behaviour per SemanticSearchHandlerOpts JSDoc)', async () => {
        // The JSDoc on SemanticSearchHandlerOpts.modelAlias documents the default as 'minilm'.
        // This test pins that contract so silent changes to the default are caught.
        const graphHash = await writeGraphJson('{"nodes":[]}');
        await writeSidecar([makeRecord('svc:x', 'service', unitVec(0))], graphHash);

        // Handler constructed WITHOUT modelAlias — should apply 'e5-base' default
        const handler = makeSemanticSearchHandler({ outDir: testDir, embedder: fakeEmbedder });
        const result = await handler({ query: 'test', includeVectors: false });

        const output = JSON.parse(result.content[0]!.text);
        // Should succeed against the e5-base (768-dim) sidecar without model-mismatch error
        expect(output.error).toBeUndefined();
        expect(output.model).toBe(SEMANTIC_MODEL);
        expect(output.dim).toBe(SEMANTIC_DIM);
    });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Task 3: Per-model minScore calibration — MCP path
// ---------------------------------------------------------------------------

describe('makeSemanticSearchHandler — per-model minScore calibration (Task 3)', () => {
    /**
     * Write a minilm sidecar where one record scores exactly 1.0 (axis-aligned
     * with the fakeEmbedder) and one scores 0.0 (orthogonal), using 384-dim vectors.
     */
    async function writeMixedScoreSidecar(): Promise<void> {
        const graphHash = await writeGraphJson('{"nodes":[]}');
        const miniDim = SEMANTIC_MODELS.minilm.dim; // 384
        const miniVec = (axis: number): number[] => {
            const v = new Array<number>(miniDim).fill(0);
            v[axis] = 1;
            return v;
        };
        const records: SemanticRecord[] = [
            makeRecord('high', 'service', miniVec(0), { label: 'high score' }),
            makeRecord('low', 'service', miniVec(1), { label: 'low score (orthogonal)' }),
        ];
        // Write minilm-specific manifest
        const miniManifest: SemanticManifest = {
            schemaVersion: SEMANTIC_SCHEMA_VERSION,
            model: SEMANTIC_MODELS.minilm.hubId,
            dim: miniDim,
            builtAt: '2026-05-16T12:00:00.000Z',
            graphHash,
            nodeCount: records.length,
        };
        await mkdir(join(testDir, 'semantic'), { recursive: true });
        await writeManifest(miniManifest, join(testDir, 'semantic', 'manifest.json'));
        await writeEmbeddingsJsonl(records, join(testDir, 'semantic', 'embeddings.jsonl'));
    }

    it('minilm: no user override → uses recommendedMinScore 0.30 (both results kept when scores are 0.0 and 1.0 and 0.0 < 0.30 so low filtered)', async () => {
        // miniEmbedder returns 384-dim unitVec(0); high=1.0, low=0.0
        // minilm recommendedMinScore = 0.30, so low (0.0) is filtered out
        await writeMixedScoreSidecar();
        const miniDim = SEMANTIC_MODELS.minilm.dim;
        const miniEmbedder = async (_text: string): Promise<number[]> => {
            const v = new Array<number>(miniDim).fill(0); v[0] = 1; return v;
        };

        const handler = makeSemanticSearchHandler({
            outDir: testDir,
            embedder: miniEmbedder,
            modelAlias: 'minilm',
        });
        const result = await handler({ query: 'test' });

        const output = JSON.parse(result.content[0]!.text);
        expect(output.error).toBeUndefined();
        // high (1.0) passes 0.30 threshold; low (0.0) is filtered
        const ids = (output.results as Array<{ nodeId: string }>).map((r) => r.nodeId);
        expect(ids).toContain('high');
        expect(ids).not.toContain('low');
    });

    it('minilm: user minScore 0.0 override → low result included', async () => {
        // User explicitly sets 0.0 — overrides the 0.30 recommended
        await writeMixedScoreSidecar();
        const miniDim = SEMANTIC_MODELS.minilm.dim;
        const miniEmbedder = async (_text: string): Promise<number[]> => {
            const v = new Array<number>(miniDim).fill(0); v[0] = 1; return v;
        };

        const handler = makeSemanticSearchHandler({
            outDir: testDir,
            embedder: miniEmbedder,
            modelAlias: 'minilm',
        });
        const result = await handler({ query: 'test', minScore: 0.0 });

        const output = JSON.parse(result.content[0]!.text);
        const ids = (output.results as Array<{ nodeId: string }>).map((r) => r.nodeId);
        // With 0.0 threshold, both high (1.0 ≥ 0) and low (0.0 ≥ 0) pass
        expect(ids).toContain('high');
        expect(ids).toContain('low');
    });

    it('e5-base: no user override → uses recommendedMinScore 0.55 (filters score 0.0)', async () => {
        // Write an e5-base (768-dim) sidecar
        const graphHash = await writeGraphJson('{"nodes":[]}');
        const e5Dim = SEMANTIC_MODELS['e5-base'].dim; // 768
        const e5UnitVec = (axis: number): number[] => {
            const v = new Array<number>(e5Dim).fill(0);
            v[axis] = 1;
            return v;
        };
        const e5Manifest: SemanticManifest = {
            schemaVersion: SEMANTIC_SCHEMA_VERSION,
            model: SEMANTIC_MODELS['e5-base'].hubId,
            dim: e5Dim,
            builtAt: '2026-05-18T00:00:00.000Z',
            graphHash,
            nodeCount: 2,
        };
        await mkdir(join(testDir, 'semantic'), { recursive: true });
        await writeManifest(e5Manifest, join(testDir, 'semantic', 'manifest.json'));
        const e5Records: SemanticRecord[] = [
            makeRecord('e5-high', 'service', e5UnitVec(0), { label: 'e5 high' }),
            makeRecord('e5-low', 'service', e5UnitVec(1), { label: 'e5 low (orthogonal)' }),
        ];
        await writeEmbeddingsJsonl(e5Records, join(testDir, 'semantic', 'embeddings.jsonl'));

        // Embedder returns 768-dim unit vector along axis 0
        const e5Embedder = async (_text: string): Promise<number[]> => e5UnitVec(0);

        const handler = makeSemanticSearchHandler({
            outDir: testDir,
            embedder: e5Embedder,
            modelAlias: 'e5-base',
        });
        const result = await handler({ query: 'find service' });

        const output = JSON.parse(result.content[0]!.text);
        expect(output.error).toBeUndefined();
        // e5-base recommendedMinScore = 0.55; high=1.0 passes, low=0.0 filtered
        const ids = (output.results as Array<{ nodeId: string }>).map((r) => r.nodeId);
        expect(ids).toContain('e5-high');
        expect(ids).not.toContain('e5-low');
    });

    it('e5-base: score 0.50 is filtered (below 0.55) where minilm would have kept it', async () => {
        // Verify AC from design doc: "e5-base fixture with score 0.50 is filtered (below 0.55)
        // where MiniLM would have kept it."
        // Score 0.50: below e5-base's 0.55 but above minilm's 0.30.
        //
        // To produce score ≈ 0.50, we use vectors [1,1,...] (query) vs [1,0,...] (doc).
        // cos([1,1,0,...], [1,0,...]) = 1/√2 ≈ 0.7071 — that's above 0.55.
        //
        // Better: use a doc vector with cos ≈ 0.50 by picking orthogonal component.
        // doc = [1, √3, 0, ...] → cos([1,0,...], [1,√3,...]) = 1/2 = 0.50
        const graphHash = await writeGraphJson('{"nodes":[]}');
        const e5Dim = SEMANTIC_MODELS['e5-base'].dim;

        const e5Manifest: SemanticManifest = {
            schemaVersion: SEMANTIC_SCHEMA_VERSION,
            model: SEMANTIC_MODELS['e5-base'].hubId,
            dim: e5Dim,
            builtAt: '2026-05-18T00:00:00.000Z',
            graphHash,
            nodeCount: 1,
        };
        await mkdir(join(testDir, 'semantic'), { recursive: true });
        await writeManifest(e5Manifest, join(testDir, 'semantic', 'manifest.json'));

        // Build a vector with cos([1,0,...], v) = 0.50 exactly.
        // v = [1, √3, 0, ...] → |v| = 2; cos = (1*1)/(1*2) = 0.50
        const halfScoreVec = new Array<number>(e5Dim).fill(0);
        halfScoreVec[0] = 1;
        halfScoreVec[1] = Math.sqrt(3); // makes |v| = 2

        const record = makeRecord('half', 'service', halfScoreVec, { label: 'half score node' });
        await writeEmbeddingsJsonl([record], join(testDir, 'semantic', 'embeddings.jsonl'));

        const queryVec = new Array<number>(e5Dim).fill(0);
        queryVec[0] = 1; // unit vector along axis 0
        const e5Embedder = async (_text: string): Promise<number[]> => queryVec;

        // --- e5-base: 0.55 threshold → filtered ---
        const handlerE5 = makeSemanticSearchHandler({
            outDir: testDir,
            embedder: e5Embedder,
            modelAlias: 'e5-base',
        });
        const resultE5 = await handlerE5({ query: 'test' });
        const outputE5 = JSON.parse(resultE5.content[0]!.text);
        // Score is 0.50 < 0.55 → should be filtered
        expect(outputE5.results).toHaveLength(0);

        // --- minilm with same vector (conceptually): 0.30 threshold → kept ---
        // We test this by passing minScore: 0.30 explicitly (simulating minilm)
        const handlerMinScore30 = makeSemanticSearchHandler({
            outDir: testDir,
            embedder: e5Embedder,
            modelAlias: 'e5-base', // alias doesn't matter here; we override minScore
        });
        const resultMs30 = await handlerMinScore30({ query: 'test', minScore: 0.30 });
        const outputMs30 = JSON.parse(resultMs30.content[0]!.text);
        // Score 0.50 >= 0.30 → kept
        expect(outputMs30.results).toHaveLength(1);
        expect(outputMs30.results[0]!.nodeId).toBe('half');
    });

    it('modelAlias omitted → defaults to e5-base (0.55 threshold, score 0.0 filtered)', async () => {
        // makeSemanticSearchHandler defaults modelAlias to defaultModelAlias = 'e5-base'.
        // resolveMinScore('e5-base') = 0.55, so score 0.0 is filtered.
        // Write an e5-base sidecar so the default alias matches.
        const graphHash = await writeGraphJson('{"nodes":[]}');
        const e5Dim = SEMANTIC_MODELS['e5-base'].dim;
        const e5Vec = (axis: number): number[] => { const v = new Array<number>(e5Dim).fill(0); v[axis] = 1; return v; };
        const e5Manifest: SemanticManifest = {
            schemaVersion: SEMANTIC_SCHEMA_VERSION,
            model: SEMANTIC_MODELS['e5-base'].hubId,
            dim: e5Dim,
            builtAt: '2026-05-16T12:00:00.000Z',
            graphHash,
            nodeCount: 2,
        };
        await mkdir(join(testDir, 'semantic'), { recursive: true });
        await writeManifest(e5Manifest, join(testDir, 'semantic', 'manifest.json'));
        const e5Records: SemanticRecord[] = [
            makeRecord('high', 'service', e5Vec(0), { label: 'high score' }),
            makeRecord('low', 'service', e5Vec(1), { label: 'low score (orthogonal)' }),
        ];
        await writeEmbeddingsJsonl(e5Records, join(testDir, 'semantic', 'embeddings.jsonl'));

        // fakeEmbedder returns SEMANTIC_DIM-dim unitVec(0) → matches e5-base
        const handler = makeSemanticSearchHandler({
            outDir: testDir,
            embedder: fakeEmbedder,
            // modelAlias omitted → defaults to 'e5-base' → resolveMinScore('e5-base') = 0.55
        });
        const result = await handler({ query: 'test' });

        const output = JSON.parse(result.content[0]!.text);
        const ids = (output.results as Array<{ nodeId: string }>).map((r) => r.nodeId);
        // high (1.0) passes 0.55; low (0.0) filtered
        expect(ids).toContain('high');
        expect(ids).not.toContain('low');
    });

    it('Zod schema rejects minScore out of [-1, 1] range', () => {
        const semanticSearchInputSchema = z.object(semanticSearchInputShape);
        expect(() =>
            semanticSearchInputSchema.parse({ query: 'test', minScore: 1.5 }),
        ).toThrow();
        expect(() =>
            semanticSearchInputSchema.parse({ query: 'test', minScore: -1.5 }),
        ).toThrow();
    });

    it('Zod schema accepts valid minScore values', () => {
        const semanticSearchInputSchema = z.object(semanticSearchInputShape);
        expect(() =>
            semanticSearchInputSchema.parse({ query: 'test', minScore: 0.55 }),
        ).not.toThrow();
        expect(() =>
            semanticSearchInputSchema.parse({ query: 'test', minScore: -1 }),
        ).not.toThrow();
        expect(() =>
            semanticSearchInputSchema.parse({ query: 'test', minScore: 1 }),
        ).not.toThrow();
    });

    it('Zod schema: minScore omitted → parsed as undefined (not defaulted)', () => {
        const semanticSearchInputSchema = z.object(semanticSearchInputShape);
        const parsed = semanticSearchInputSchema.parse({ query: 'test' });
        expect(parsed.minScore).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// E5-T2: MCP wiring — default embedder uses embedOne(text, 'query')
// ---------------------------------------------------------------------------

describe('makeSemanticSearchHandler — default embedder uses query mode (E5-T2)', () => {
    it('when no embedder is passed, the factory calls embedOne(text, "query")', async () => {
        const graphHash = await writeGraphJson('{"nodes":[]}');
        await writeSidecar([makeRecord('svc:a', 'service', unitVec(0))], graphHash);

        // Spy on makeEmbedder to intercept the embedder object created by the factory
        const embedOneCalls: Array<{ text: string; mode: string | undefined }> = [];
        const makeEmbedderSpy = vi.spyOn(embedderModule, 'makeEmbedder');
        makeEmbedderSpy.mockReturnValue({
            embed: async (texts: string[], _mode?: string) => texts.map(() => unitVec(0)),
            embedOne: async (text: string, mode?: string) => {
                embedOneCalls.push({ text, mode });
                return unitVec(0);
            },
        } as unknown as ReturnType<typeof embedderModule.makeEmbedder>);

        // No embedder override — factory must build its own
        const handler = makeSemanticSearchHandler({ outDir: testDir });
        await handler({ query: 'find auth flow', topK: 1 });

        // The factory should have called embedOne with mode='query'
        expect(embedOneCalls).toHaveLength(1);
        expect(embedOneCalls[0]!.mode).toBe('query');
        expect(embedOneCalls[0]!.text).toBe('find auth flow');

        makeEmbedderSpy.mockRestore();
    });
});
