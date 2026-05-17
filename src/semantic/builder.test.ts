/**
 * Unit tests for builder.ts.
 *
 * The embedder is injected as a fake — no network calls, no model downloads.
 * File I/O uses a real tmpdir so JSONL + manifest round-trips are exercised.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArchGraph, GraphNode } from '../core/types.js';
import { inMemoryProject } from '../__fixtures__/in-memory-project.js';
import { buildSemanticIndex } from './builder.js';
import { semanticSearch } from './search.js';
import type { SemanticDiagnostics } from './types.js';
import { SEMANTIC_DIM, SEMANTIC_MODEL, SEMANTIC_SCHEMA_VERSION, SKIPPED_NODES_CAP } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
    testDir = join(
        tmpdir(),
        `arch-graph-builder-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

/** Deterministic 384-dim fake vector seeded by index. */
function fakeVector(seed: number): number[] {
    return Array.from({ length: SEMANTIC_DIM }, (_, i) => (seed + i) / SEMANTIC_DIM);
}

/** Fake embedder: returns one deterministic vector per text. */
const fakeEmbedder = vi.fn(async (texts: string[]) =>
    texts.map((_, i) => fakeVector(i)),
);

/** Minimal valid ArchGraph for testing. */
function makeGraph(overrides: Partial<ArchGraph> = {}): ArchGraph {
    return {
        version: '1',
        buildAt: '2026-05-16T00:00:00.000Z',
        root: '/project',
        nodes: [],
        edges: [],
        ...overrides,
    };
}

/** Write a graph.json to testDir (required for hash computation). */
async function writeGraphJson(graph: ArchGraph): Promise<void> {
    await writeFile(join(testDir, 'graph.json'), JSON.stringify(graph, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Happy path: 3-node graph
// ---------------------------------------------------------------------------

describe('buildSemanticIndex — happy path (3 nodes)', () => {
    it('writes manifest.json with correct fields', async () => {
        const graph = makeGraph({
            nodes: [
                { id: 'service:api', kind: 'service', label: 'api', path: '/project/apps/api/src/app.module.ts' },
                { id: 'service:worker', kind: 'service', label: 'worker' },
                { id: 'nats-subject:user.created', kind: 'nats-subject', label: 'user.created' },
            ],
        });
        await writeGraphJson(graph);

        const project = inMemoryProject({
            '/project/apps/api/src/app.module.ts': `
                import { Module } from '@nestjs/common';
                @Module({})
                export class AppModule {}
            `,
        });

        const result = await buildSemanticIndex({
            graph,
            project,
            embedder: fakeEmbedder,
            outDir: testDir,
            now: () => '2026-05-16T12:00:00.000Z',
        });

        expect(result.manifest.model).toBe(SEMANTIC_MODEL);
        expect(result.manifest.dim).toBe(SEMANTIC_DIM);
        expect(result.manifest.builtAt).toBe('2026-05-16T12:00:00.000Z');
        expect(result.manifest.graphHash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
        expect(result.manifest.nodeCount).toBe(3);

        const onDisk = JSON.parse(
            await readFile(join(testDir, 'semantic', 'manifest.json'), 'utf8'),
        );
        expect(onDisk).toEqual(result.manifest);
    });

    it('writes embeddings.jsonl with one line per node', async () => {
        const graph = makeGraph({
            nodes: [
                { id: 'service:api', kind: 'service', label: 'api' },
                { id: 'service:worker', kind: 'service', label: 'worker' },
                { id: 'nats-subject:user.created', kind: 'nats-subject', label: 'user.created' },
            ],
        });
        await writeGraphJson(graph);

        await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: fakeEmbedder,
            outDir: testDir,
            now: () => '2026-05-16T12:00:00.000Z',
        });

        const raw = await readFile(join(testDir, 'semantic', 'embeddings.jsonl'), 'utf8');
        const lines = raw.trim().split('\n');
        expect(lines).toHaveLength(3);
        for (const line of lines) {
            const rec = JSON.parse(line) as { nodeId: string; vector: number[] };
            expect(rec.nodeId).toBeTruthy();
            expect(rec.vector).toHaveLength(SEMANTIC_DIM);
        }
    });

    it('returns diagnostics with correct indexed count', async () => {
        const graph = makeGraph({
            nodes: [
                { id: 'service:a', kind: 'service', label: 'a' },
                { id: 'service:b', kind: 'service', label: 'b' },
                { id: 'service:c', kind: 'service', label: 'c' },
            ],
        });
        await writeGraphJson(graph);

        const { diagnostics } = await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: fakeEmbedder,
            outDir: testDir,
        });

        expect(diagnostics.counts.indexed).toBe(3);
        expect(diagnostics.counts.skipped).toBe(0);
        expect(diagnostics.counts.transformerErrors).toBe(0);
        expect(diagnostics.model).toBe(SEMANTIC_MODEL);
        expect(diagnostics.dim).toBe(SEMANTIC_DIM);
        expect(diagnostics.indexSizeBytes).toBeGreaterThan(0);
    });

    it('JSONL lines are sorted by node id (idempotency)', async () => {
        const graph = makeGraph({
            nodes: [
                { id: 'service:zzz', kind: 'service', label: 'zzz' },
                { id: 'service:aaa', kind: 'service', label: 'aaa' },
                { id: 'service:mmm', kind: 'service', label: 'mmm' },
            ],
        });
        await writeGraphJson(graph);

        await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: fakeEmbedder,
            outDir: testDir,
        });

        const raw = await readFile(join(testDir, 'semantic', 'embeddings.jsonl'), 'utf8');
        const ids = raw.trim().split('\n').map((l) => (JSON.parse(l) as { nodeId: string }).nodeId);
        expect(ids).toEqual([...ids].sort());
    });

    it('graphHash is SHA-256 of graph.json content', async () => {
        const graph = makeGraph({ nodes: [{ id: 'service:x', kind: 'service', label: 'x' }] });
        await writeGraphJson(graph);

        const { manifest } = await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: fakeEmbedder,
            outDir: testDir,
        });

        // Manually compute expected hash
        const { createHash } = await import('node:crypto');
        const graphContent = await readFile(join(testDir, 'graph.json'), 'utf8');
        const expected = createHash('sha256').update(graphContent).digest('hex');

        expect(manifest.graphHash).toBe(expected);
    });
});

// ---------------------------------------------------------------------------
// Partial failure: 1 snippet fails → recorded in diagnostics
// ---------------------------------------------------------------------------

describe('buildSemanticIndex — partial failure', () => {
    it('records snippet failure in diagnostics without hard-failing the run', async () => {
        const graph = makeGraph({
            nodes: [
                // This node has a path that won't exist in the in-memory project → snippet failure
                { id: 'service:missing', kind: 'service', label: 'MissingService', path: '/no/such/file.ts' },
                { id: 'service:ok', kind: 'service', label: 'OkService' },
            ],
        });
        await writeGraphJson(graph);

        const { diagnostics } = await buildSemanticIndex({
            graph,
            project: inMemoryProject({}), // no files → 'file-not-found' for /no/such/file.ts
            embedder: fakeEmbedder,
            outDir: testDir,
        });

        // The run must not throw; both nodes are still embedded (snippet falls back to label+kind)
        expect(diagnostics.counts.indexed).toBe(2);
        // The snippet failure is recorded
        expect(diagnostics.counts.fileReadErrors).toBeGreaterThanOrEqual(1);
        expect(diagnostics.skippedNodes.length).toBeGreaterThanOrEqual(1);
        const skipped = diagnostics.skippedNodes.find((s) => s.nodeId === 'service:missing');
        expect(skipped).toBeDefined();
        expect(skipped!.reason.kind).toBe('file-not-found');
    });

    it('records transformer errors per-batch without hard-failing the run', async () => {
        const graph = makeGraph({
            nodes: [
                { id: 'service:a', kind: 'service', label: 'a' },
                { id: 'service:b', kind: 'service', label: 'b' },
            ],
        });
        await writeGraphJson(graph);

        const failingEmbedder = vi.fn(async (_texts: string[]) => {
            throw new Error('transformer unavailable');
        });

        const { diagnostics } = await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: failingEmbedder,
            outDir: testDir,
        });

        expect(diagnostics.counts.indexed).toBe(0);
        expect(diagnostics.counts.transformerErrors).toBe(2);
        expect(diagnostics.skippedNodes.length).toBe(2);
        expect(diagnostics.skippedNodes[0]!.reason.kind).toBe('transformer-error');

        // embeddings.jsonl is empty but written
        const raw = await readFile(join(testDir, 'semantic', 'embeddings.jsonl'), 'utf8');
        expect(raw.trim()).toBe('');
    });
});

// ---------------------------------------------------------------------------
// Diagnostics merge — anti-clobber proof
// ---------------------------------------------------------------------------

describe('buildSemanticIndex — diagnostics merge', () => {
    it('extends existing diagnostics.json without clobbering other fields', async () => {
        const graph = makeGraph({ nodes: [{ id: 'service:x', kind: 'service', label: 'x' }] });
        await writeGraphJson(graph);

        // Seed diagnostics.json with fake nats/cycles fields
        const existingDiag = {
            projectId: 'test',
            timestamp: '2026-05-16T00:00:00.000Z',
            nats: { unresolved: [], dynamic: [], unowned: [], counts: { literal: 5, pattern: 0, dynamic: 0, unresolved: 0 } },
            cycles: { cycles: [], counts: { tsImport: 0, libUsage: 0, diImport: 0 } },
        };
        await writeFile(
            join(testDir, 'diagnostics.json'),
            JSON.stringify(existingDiag, null, 2),
            'utf8',
        );

        await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: fakeEmbedder,
            outDir: testDir,
        });

        const merged = JSON.parse(
            await readFile(join(testDir, 'diagnostics.json'), 'utf8'),
        ) as Record<string, unknown>;

        // Existing fields must be intact
        expect(merged.projectId).toBe('test');
        expect(merged.nats).toEqual(existingDiag.nats);
        expect(merged.cycles).toEqual(existingDiag.cycles);

        // semantic field must be populated
        const sem = merged.semantic as SemanticDiagnostics;
        expect(sem).toBeDefined();
        expect(sem.model).toBe(SEMANTIC_MODEL);
        expect(sem.counts.indexed).toBe(1);
    });

    it('creates diagnostics.json from scratch when absent', async () => {
        const graph = makeGraph({ nodes: [{ id: 'service:y', kind: 'service', label: 'y' }] });
        await writeGraphJson(graph);

        // diagnostics.json does not exist — builder must create it
        await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: fakeEmbedder,
            outDir: testDir,
        });

        const written = JSON.parse(
            await readFile(join(testDir, 'diagnostics.json'), 'utf8'),
        ) as Record<string, unknown>;
        expect(written.semantic).toBeDefined();
    });

    it('SF-P0-2: throws (not silently clobbers) when diagnostics.json is corrupt JSON', async () => {
        const graph = makeGraph({ nodes: [{ id: 'service:z', kind: 'service', label: 'z' }] });
        await writeGraphJson(graph);

        // Write corrupt JSON — NOT ENOENT, but a parse error
        await writeFile(join(testDir, 'diagnostics.json'), '{ broken json', 'utf8');

        // buildSemanticIndex must throw because of the corrupt diagnostics.json
        // (anti-clobber: must NOT silently overwrite nats/typeorm/etc.)
        await expect(
            buildSemanticIndex({
                graph,
                project: inMemoryProject({}),
                embedder: fakeEmbedder,
                outDir: testDir,
            }),
        ).rejects.toThrow();

        // Verify diagnostics.json was NOT overwritten with new data (stays corrupt)
        const stillBad = await readFile(join(testDir, 'diagnostics.json'), 'utf8');
        expect(stillBad).toBe('{ broken json');
    });
});

// ---------------------------------------------------------------------------
// Edge case: empty graph
// ---------------------------------------------------------------------------

describe('buildSemanticIndex — empty graph', () => {
    it('handles empty graph gracefully: exit 0, manifest.nodeCount=0, JSONL empty', async () => {
        const graph = makeGraph({ nodes: [] });
        await writeGraphJson(graph);

        const { manifest, diagnostics } = await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: fakeEmbedder,
            outDir: testDir,
        });

        expect(manifest.nodeCount).toBe(0);
        expect(diagnostics.counts.indexed).toBe(0);
        expect(diagnostics.counts.skipped).toBe(0);

        const raw = await readFile(join(testDir, 'semantic', 'embeddings.jsonl'), 'utf8');
        expect(raw.trim()).toBe('');
    });
});

// ---------------------------------------------------------------------------
// Snippet with actual content → embed text includes snippet
// ---------------------------------------------------------------------------

describe('buildSemanticIndex — snippet content', () => {
    it('includes snippet in embed text for nodes with path and matching declaration', async () => {
        // Track what the embedder received
        const receivedTexts: string[] = [];
        const trackingEmbedder = vi.fn(async (texts: string[]) => {
            receivedTexts.push(...texts);
            return texts.map((_, i) => fakeVector(i));
        });

        const graph = makeGraph({
            nodes: [
                { id: 'service:api', kind: 'service', label: 'ApiService', path: '/project/api.ts' },
            ],
        });
        await writeGraphJson(graph);

        const project = inMemoryProject({
            '/project/api.ts': `class ApiService { method() {} }`,
        });

        await buildSemanticIndex({
            graph,
            project,
            embedder: trackingEmbedder,
            outDir: testDir,
        });

        // The embed text should include snippet (contains class declaration)
        expect(receivedTexts[0]).toContain('ApiService');
        expect(receivedTexts[0]).toContain('service');
    });

    it('records ts-morph-error in fileReadErrors when snippet throws', async () => {
        // Use a node with a path that ts-morph will find but fail on (label not in file)
        const graph = makeGraph({
            nodes: [
                { id: 'service:api', kind: 'service', label: 'NonExistentClass', path: '/project/api.ts' },
            ],
        });
        await writeGraphJson(graph);

        const project = inMemoryProject({
            '/project/api.ts': `class SomeOtherClass {}`,
        });

        const { diagnostics } = await buildSemanticIndex({
            graph,
            project,
            embedder: fakeEmbedder,
            outDir: testDir,
        });

        // label-not-located is recorded as a skip (not fileReadError)
        expect(diagnostics.counts.indexed).toBe(1); // still embedded (fallback to label+kind)
        expect(diagnostics.skippedNodes.length).toBeGreaterThanOrEqual(1);
        expect(diagnostics.skippedNodes[0]!.reason.kind).toBe('label-not-located');
    });
});

// ---------------------------------------------------------------------------
// SKIPPED_NODES_CAP enforcement
// ---------------------------------------------------------------------------

describe('buildSemanticIndex — skipped nodes cap', () => {
    it('caps skippedNodes at SKIPPED_NODES_CAP (10_000) entries from snippet failures', async () => {
        // Create 60 nodes, all with missing paths (snippet failures).
        // Cap is now 10_000, so 60 nodes all fit — skippedNodesTruncated should be false.
        const nodes = Array.from({ length: 60 }, (_, i) => ({
            id: `service:svc${i}`,
            kind: 'service' as const,
            label: `Svc${i}`,
            path: `/no/such/file${i}.ts`,
        }));
        const graph = makeGraph({ nodes });
        await writeGraphJson(graph);

        const { diagnostics } = await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: fakeEmbedder,
            outDir: testDir,
        });

        // All 60 fit within the 10_000 cap.
        expect(diagnostics.skippedNodes.length).toBe(60);
        expect(diagnostics.skippedNodesTruncated).toBe(false);
    });

    it('caps skippedNodes at SKIPPED_NODES_CAP (10_000) entries from transformer batch failures', async () => {
        // Create 60 nodes, all failing transformer — cap is 10_000 so all are recorded.
        const nodes = Array.from({ length: 60 }, (_, i) => ({
            id: `service:svc${i}`,
            kind: 'service' as const,
            label: `Svc${i}`,
        }));
        const graph = makeGraph({ nodes });
        await writeGraphJson(graph);

        const throwEmbedder = vi.fn(async (_texts: string[]) => {
            throw new Error('batch fail');
        });

        const { diagnostics } = await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: throwEmbedder,
            outDir: testDir,
        });

        expect(diagnostics.skippedNodes.length).toBe(60);
        expect(diagnostics.skippedNodesTruncated).toBe(false);
        expect(diagnostics.counts.transformerErrors).toBe(60);
    });
});

// ---------------------------------------------------------------------------
// TG2 — node failing BOTH snippet (file-not-found) AND embed (transformer-error)
// ---------------------------------------------------------------------------

describe('buildSemanticIndex — dual failure (TG2)', () => {
    it('records node exactly once in skippedNodes with first reason (file-not-found)', async () => {
        /**
         * Node has a path that does not exist in the in-memory project → snippet
         * phase records 'file-not-found'. Then the embedder throws → transformer
         * phase tries to record 'transformer-error', but recordSkip skips it
         * (node already recorded). Result:
         *   - skippedNodes has the node exactly ONCE with reason 'file-not-found'
         *   - counts.fileReadErrors === 1
         *   - counts.transformerErrors === 1   (counter is independent of the map)
         */
        const graph = makeGraph({
            nodes: [
                {
                    id: 'service:failing',
                    kind: 'service' as const,
                    label: 'failing',
                    path: '/no/such/file.ts',
                },
            ],
        });
        await writeGraphJson(graph);

        const throwEmbedder = vi.fn(async (_texts: string[]) => {
            throw new Error('transformer exploded');
        });

        const { diagnostics } = await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: throwEmbedder,
            outDir: testDir,
        });

        // (a) Node appears exactly once in skippedNodes
        const skipped = diagnostics.skippedNodes.filter((s) => s.nodeId === 'service:failing');
        expect(skipped).toHaveLength(1);
        // (b) First reason is file-not-found (snippet phase runs first)
        expect(skipped[0]!.reason.kind).toBe('file-not-found');
        // (c) fileReadErrors counter incremented
        expect(diagnostics.counts.fileReadErrors).toBe(1);
        // (d) transformerErrors counter incremented (independent of map dedup)
        expect(diagnostics.counts.transformerErrors).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// transformer error with non-Error thrown value
// ---------------------------------------------------------------------------

describe('buildSemanticIndex — transformer error types', () => {
    it('handles non-Error thrown values in transformer catch block', async () => {
        const graph = makeGraph({
            nodes: [{ id: 'service:x', kind: 'service', label: 'x' }],
        });
        await writeGraphJson(graph);

        // Throw a non-Error value (string)
        const throwStringEmbedder = vi.fn(async (_texts: string[]) => {
            // eslint-disable-next-line @typescript-eslint/no-throw-literal
            throw 'plain string error';
        });

        const { diagnostics } = await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: throwStringEmbedder,
            outDir: testDir,
        });

        expect(diagnostics.counts.transformerErrors).toBe(1);
        expect(diagnostics.skippedNodes[0]!.reason.kind).toBe('transformer-error');
        expect((diagnostics.skippedNodes[0]!.reason as { kind: 'transformer-error'; message: string }).message).toContain('plain string error');
    });
});

// ---------------------------------------------------------------------------
// Idempotency: two runs with fixed `now` produce identical content
// ---------------------------------------------------------------------------

describe('buildSemanticIndex — idempotency', () => {
    it('produces identical manifest (modulo builtAt) and JSONL on second run', async () => {
        const graph = makeGraph({
            nodes: [
                { id: 'service:a', kind: 'service', label: 'a' },
                { id: 'service:b', kind: 'service', label: 'b' },
            ],
        });
        await writeGraphJson(graph);

        const opts = {
            graph,
            project: inMemoryProject({}),
            embedder: fakeEmbedder,
            outDir: testDir,
            now: () => '2026-05-16T00:00:00.000Z',
        };

        await buildSemanticIndex(opts);
        const jsonl1 = await readFile(join(testDir, 'semantic', 'embeddings.jsonl'), 'utf8');
        const manifest1 = await readFile(join(testDir, 'semantic', 'manifest.json'), 'utf8');

        await buildSemanticIndex(opts);
        const jsonl2 = await readFile(join(testDir, 'semantic', 'embeddings.jsonl'), 'utf8');
        const manifest2 = await readFile(join(testDir, 'semantic', 'manifest.json'), 'utf8');

        expect(jsonl1).toBe(jsonl2);
        expect(manifest1).toBe(manifest2);
    });
});

// ---------------------------------------------------------------------------
// PT-P1-4 — Full diagnostics shape assertion
// ---------------------------------------------------------------------------

describe('buildSemanticIndex — complete diagnostics shape (PT-P1-4)', () => {
    it('diagnostics has all required fields with correct types', async () => {
        const graph = makeGraph({
            nodes: [
                // Success: will be indexed
                { id: 'service:a', kind: 'service', label: 'a' },
                // Snippet failure: path exists in project with different label → label-not-located
                { id: 'service:b', kind: 'service', label: 'NonExistent', path: '/project/b.ts' },
                // File not found: path not in project
                { id: 'service:c', kind: 'service', label: 'c', path: '/no/such/file.ts' },
            ],
        });
        await writeGraphJson(graph);

        const project = inMemoryProject({
            '/project/b.ts': 'class SomeOtherClass {}',
        });

        const { diagnostics } = await buildSemanticIndex({
            graph,
            project,
            embedder: fakeEmbedder,
            outDir: testDir,
            now: () => '2026-05-16T12:00:00.000Z',
        });

        // Top-level fields
        expect(diagnostics.model).toBe(SEMANTIC_MODEL);
        expect(diagnostics.dim).toBe(SEMANTIC_DIM);
        expect(diagnostics.schemaVersion).toBe(SEMANTIC_SCHEMA_VERSION);
        expect(typeof diagnostics.indexSizeBytes).toBe('number');
        expect(diagnostics.indexSizeBytes).toBeGreaterThan(0);
        expect(typeof diagnostics.skippedNodesTruncated).toBe('boolean');
        expect(diagnostics.skippedNodesTruncated).toBe(false); // only 3 nodes, below cap

        // Counts shape
        const { counts } = diagnostics;
        expect(typeof counts.indexed).toBe('number');
        expect(typeof counts.skipped).toBe('number');
        expect(typeof counts.fileReadErrors).toBe('number');
        expect(typeof counts.transformerErrors).toBe('number');
        expect(typeof counts.labelErrors).toBe('number');

        // All 3 nodes are indexed (snippet failures fall back to label+kind; embed still runs)
        expect(counts.indexed).toBe(3);
        expect(counts.skipped).toBe(0);

        // One file-not-found, one label-not-located
        expect(counts.fileReadErrors).toBe(1);
        expect(counts.labelErrors).toBe(1);
        expect(counts.transformerErrors).toBe(0);

        // skippedNodes shape
        expect(Array.isArray(diagnostics.skippedNodes)).toBe(true);
        expect(diagnostics.skippedNodes.length).toBe(2); // b + c

        for (const skipped of diagnostics.skippedNodes) {
            expect(typeof skipped.nodeId).toBe('string');
            expect(typeof skipped.kind).toBe('string');
            expect(typeof skipped.label).toBe('string');
            expect(skipped.reason).toBeDefined();
            expect(typeof skipped.reason.kind).toBe('string');
        }

        const kinds = diagnostics.skippedNodes.map((s) => s.reason.kind);
        expect(kinds).toContain('label-not-located');
        expect(kinds).toContain('file-not-found');

        // TG3: indexed + skipped must equal total node count
        expect(diagnostics.counts.indexed + diagnostics.counts.skipped).toBe(graph.nodes.length);
    });
});

// ---------------------------------------------------------------------------
// PT-P1-3 — Round-trip: build index then search, assert top-1 matches
// ---------------------------------------------------------------------------

describe('buildSemanticIndex + semanticSearch — round-trip (PT-P1-3)', () => {
    it('builds a 3-node index and searches it; top-1 matches the most-similar node', async () => {
        /**
         * 3 nodes — sorted alphabetically in the builder:
         *   nats-subject:gamma → batch index 0 → fakeVector(0)
         *   service:alpha      → batch index 1 → fakeVector(1)
         *   service:beta       → batch index 2 → fakeVector(2)
         *
         * Search query embedder returns fakeVector(1), so service:alpha
         * (same vector) is the closest and must be top-1 (cosine = 1.0).
         */
        const graph = makeGraph({
            nodes: [
                { id: 'service:alpha', kind: 'service', label: 'alpha' },
                { id: 'service:beta',  kind: 'service', label: 'beta' },
                { id: 'nats-subject:gamma', kind: 'nats-subject', label: 'gamma' },
            ],
        });
        await writeGraphJson(graph);

        // Build the index with the same fakeEmbedder used elsewhere in this suite.
        await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: fakeEmbedder,
            outDir: testDir,
        });

        // Search with a query whose vector equals fakeVector(1) — identical to service:alpha
        // (second in sorted order: nats-subject:gamma < service:alpha < service:beta).
        const queryEmbedder = async (_text: string) => fakeVector(1);
        const { output, exitCode } = await semanticSearch({
            query: 'alpha service',
            outDir: testDir,
            embedder: queryEmbedder,
            topK: 3,
        });

        expect(exitCode).toBe(0);
        expect(output.results).toHaveLength(3);
        // service:alpha must be top-1 with cosine = 1.0
        expect(output.results[0]!.nodeId).toBe('service:alpha');
        expect(output.results[0]!.score).toBeCloseTo(1.0, 5);
        // All MCP contract fields present
        expect(output.model).toBe(SEMANTIC_MODEL);
        expect(output.dim).toBe(SEMANTIC_DIM);
        expect(output.graphHashMatches).toBe(true);
    });

    it('TG3: indexed + skipped equals total graph node count', async () => {
        const graph = makeGraph({
            nodes: [
                { id: 'service:alpha', kind: 'service', label: 'alpha' },
                { id: 'service:beta', kind: 'service', label: 'beta', path: '/no/such/file.ts' },
                { id: 'nats-subject:gamma', kind: 'nats-subject', label: 'gamma' },
            ],
        });
        await writeGraphJson(graph);

        const { diagnostics } = await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: fakeEmbedder,
            outDir: testDir,
        });

        // Invariant: every node is either indexed or skipped, never lost
        expect(diagnostics.counts.indexed + diagnostics.counts.skipped).toBe(graph.nodes.length);
    });
});

// ---------------------------------------------------------------------------
// P1-6 — SKIPPED_NODES_CAP truncation branch
// ---------------------------------------------------------------------------

describe('buildSemanticIndex — skippedNodes cap truncation (P1-6)', () => {
    it('sets skippedNodesTruncated=true and caps list at the cap when exceeded', async () => {
        // Use _testOnlySkippedNodesCap=3 so we can exceed the cap with a small node count
        const CAP = 3;
        // Create CAP+2 nodes all with missing paths → snippet fails → each would be skipped
        const nodes = Array.from({ length: CAP + 2 }, (_, i) => ({
            id: `service:svc${i}`,
            kind: 'service' as const,
            label: `Svc${i}`,
            path: `/no/such/file${i}.ts`,
        }));
        const graph = makeGraph({ nodes });
        await writeGraphJson(graph);

        const { diagnostics } = await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: fakeEmbedder,
            outDir: testDir,
            _testOnlySkippedNodesCap: CAP,
        });

        // The list is capped at CAP entries
        expect(diagnostics.skippedNodes.length).toBe(CAP);
        // The truncation flag is set
        expect(diagnostics.skippedNodesTruncated).toBe(true);
    });

    it('SKIPPED_NODES_CAP constant is 10_000', () => {
        // Ensure the production cap value is not accidentally changed.
        expect(SKIPPED_NODES_CAP).toBe(10_000);
    });
});

// ---------------------------------------------------------------------------
// Integration: doc-section node produces SemanticRecord with heading-chain
// snippet and 384-dim vector
// ---------------------------------------------------------------------------

describe('buildSemanticIndex — doc-section integration', () => {
    it('produces a SemanticRecord with heading-chain snippet and 384-dim vector', async () => {
        /**
         * doc-section extractor uses readFileSync(node.path) directly — bypasses
         * the ts-morph Project.  We point node.path at the real fixture file on
         * disk so extractDocSectionSnippet can read it.
         *
         * Fixture: src/__fixtures__/docs/sample/README.md
         *   Line 5:  ## Installation
         *   Line 6:  (blank)
         *   Line 7:  How to install.
         *
         * meta.headingChain = ['Sample Project', 'Installation']
         * meta.startLine = 6, meta.endLine = 7
         *
         * Expected snippet prefix: "# Sample Project > Installation"
         */
        const fixtureReadme = fileURLToPath(
            new URL('../__fixtures__/docs/sample/README.md', import.meta.url),
        );

        const graph = makeGraph({
            nodes: [
                {
                    id: 'doc-section:sample/README.md#installation',
                    kind: 'doc-section',
                    label: 'Installation',
                    path: fixtureReadme,
                    meta: {
                        headingChain: ['Sample Project', 'Installation'],
                        startLine: 6,
                        endLine: 7,
                    },
                },
            ],
        });
        await writeGraphJson(graph);

        const { diagnostics } = await buildSemanticIndex({
            graph,
            project: inMemoryProject({}), // unused for doc-section (readFileSync bypass)
            embedder: fakeEmbedder,
            outDir: testDir,
        });

        // Node must be successfully indexed (no snippet failure)
        expect(diagnostics.counts.indexed).toBe(1);
        expect(diagnostics.counts.skipped).toBe(0);
        expect(diagnostics.counts.fileReadErrors).toBe(0);
        expect(diagnostics.skippedNodes).toHaveLength(0);

        // Read back the JSONL to inspect the full SemanticRecord on disk
        const raw = await readFile(join(testDir, 'semantic', 'embeddings.jsonl'), 'utf8');
        const lines = raw.trim().split('\n');
        expect(lines).toHaveLength(1);

        const record = JSON.parse(lines[0]!) as {
            nodeId: string;
            kind: string;
            snippet: string;
            vector: number[];
        };

        // Kind is preserved
        expect(record.kind).toBe('doc-section');

        // Snippet starts with the heading-chain prefix
        expect(record.snippet.startsWith('# Sample Project > Installation')).toBe(true);
        expect(record.snippet.length).toBeGreaterThan(0);

        // Vector is 384-dimensional
        expect(record.vector).toHaveLength(SEMANTIC_DIM);
    });
});

// ---------------------------------------------------------------------------
// AC-7-F: buildEmbedText — OpenAPI info appended for endpoint nodes
// ---------------------------------------------------------------------------

describe('buildSemanticIndex — AC-7-F OpenAPI info in embed text', () => {
    it('appends description/summary/tags/paramSummary to embed text for endpoint node with openapiInfo', async () => {
        const receivedTexts: string[] = [];
        const trackingEmbedder = vi.fn(async (texts: string[]) => {
            receivedTexts.push(...texts);
            return texts.map((_, i) => fakeVector(i));
        });

        const endpointNode: GraphNode = {
            id: 'endpoint:GET /categories',
            kind: 'endpoint',
            label: 'GET /categories',
            meta: {
                methodName: 'getCategories',
                controllerClass: 'CategoriesController',
                openapiInfo: {
                    description: 'Получение списка категорий',
                    summary: 'List categories',
                    tags: ['Категории', 'Read'],
                    paramSummary: 'limit: Максимальное количество',
                },
            },
        };

        const graph = makeGraph({ nodes: [endpointNode] });
        await writeGraphJson(graph);

        const project = inMemoryProject({});

        await buildSemanticIndex({
            graph,
            project,
            embedder: trackingEmbedder,
            outDir: testDir,
        });

        expect(receivedTexts).toHaveLength(1);
        const embedText = receivedTexts[0]!;

        // Base label + kind present
        expect(embedText).toContain('GET /categories');
        expect(embedText).toContain('endpoint');

        // Russian description present
        expect(embedText).toContain('Получение списка категорий');

        // Summary present
        expect(embedText).toContain('List categories');

        // Tags joined with comma
        expect(embedText).toContain('Категории, Read');

        // Param summary present
        expect(embedText).toContain('limit: Максимальное количество');
    });

    it('endpoint node WITHOUT openapiInfo produces same embed text as before (label + kind + snippet)', async () => {
        const receivedTexts: string[] = [];
        const trackingEmbedder = vi.fn(async (texts: string[]) => {
            receivedTexts.push(...texts);
            return texts.map((_, i) => fakeVector(i));
        });

        const endpointNode: GraphNode = {
            id: 'endpoint:POST /users',
            kind: 'endpoint',
            label: 'POST /users',
            meta: {
                methodName: 'createUser',
                controllerClass: 'UsersController',
                // No openapiInfo
            },
        };

        const graph = makeGraph({ nodes: [endpointNode] });
        await writeGraphJson(graph);

        const project = inMemoryProject({});

        await buildSemanticIndex({
            graph,
            project,
            embedder: trackingEmbedder,
            outDir: testDir,
        });

        expect(receivedTexts).toHaveLength(1);
        const embedText = receivedTexts[0]!;

        // Base content present
        expect(embedText).toContain('POST /users');
        expect(embedText).toContain('endpoint');

        // No Russian text or extra content
        expect(embedText).not.toContain('Получение');
        expect(embedText).not.toContain('summary');

        // Exact shape: "POST /users endpoint" (no snippet since no path, no openapiInfo)
        expect(embedText).toBe('POST /users endpoint');
    });

    it('non-endpoint node is unaffected even if meta has openapiInfo-like fields', async () => {
        const receivedTexts: string[] = [];
        const trackingEmbedder = vi.fn(async (texts: string[]) => {
            receivedTexts.push(...texts);
            return texts.map((_, i) => fakeVector(i));
        });

        const serviceNode: GraphNode = {
            id: 'service:api',
            kind: 'service',
            label: 'api',
            meta: {
                // hypothetical meta field — should NOT be appended to embed text
                openapiInfo: {
                    description: 'This should not appear',
                },
            },
        };

        const graph = makeGraph({ nodes: [serviceNode] });
        await writeGraphJson(graph);

        const project = inMemoryProject({});

        await buildSemanticIndex({
            graph,
            project,
            embedder: trackingEmbedder,
            outDir: testDir,
        });

        expect(receivedTexts).toHaveLength(1);
        const embedText = receivedTexts[0]!;

        // Only label + kind, no openapiInfo appended
        expect(embedText).not.toContain('This should not appear');
        expect(embedText).toBe('api service');
    });

    it('appends only present openapiInfo fields (partial info)', async () => {
        const receivedTexts: string[] = [];
        const trackingEmbedder = vi.fn(async (texts: string[]) => {
            receivedTexts.push(...texts);
            return texts.map((_, i) => fakeVector(i));
        });

        const endpointNode: GraphNode = {
            id: 'endpoint:DELETE /items/:id',
            kind: 'endpoint',
            label: 'DELETE /items/:id',
            meta: {
                methodName: 'deleteItem',
                controllerClass: 'ItemsController',
                openapiInfo: {
                    description: 'Удаление элемента',
                    // summary, tags, paramSummary all absent
                },
            },
        };

        const graph = makeGraph({ nodes: [endpointNode] });
        await writeGraphJson(graph);
        const project = inMemoryProject({});

        await buildSemanticIndex({
            graph,
            project,
            embedder: trackingEmbedder,
            outDir: testDir,
        });

        const embedText = receivedTexts[0]!;
        expect(embedText).toContain('DELETE /items/:id');
        expect(embedText).toContain('Удаление элемента');
        // Only one extra line was appended
        const lines = embedText.split('\n');
        expect(lines).toHaveLength(2); // "DELETE /items/:id endpoint" + "Удаление элемента"
    });
});
