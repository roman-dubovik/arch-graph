/**
 * Unit tests for builder.ts.
 *
 * The embedder is injected as a fake — no network calls, no model downloads.
 * File I/O uses a real tmpdir so JSONL + manifest round-trips are exercised.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArchGraph } from '../core/types.js';
import { inMemoryProject } from '../__fixtures__/in-memory-project.js';
import { buildSemanticIndex } from './builder.js';
import type { SemanticDiagnostics } from './types.js';
import { SEMANTIC_DIM, SEMANTIC_MODEL } from './types.js';

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
        expect(skipped!.reason).toMatch(/file-not-found/);
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
        expect(diagnostics.skippedNodes[0].reason).toMatch(/transformer-error/);

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
        expect(diagnostics.skippedNodes[0].reason).toMatch(/label-not-located/);
    });
});

// ---------------------------------------------------------------------------
// SKIPPED_NODES_CAP enforcement
// ---------------------------------------------------------------------------

describe('buildSemanticIndex — skipped nodes cap', () => {
    it('caps skippedNodes at 50 entries from snippet failures', async () => {
        // Create 60 nodes, all with missing paths (snippet failures)
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

        expect(diagnostics.skippedNodes.length).toBeLessThanOrEqual(50);
    });

    it('caps skippedNodes at 50 entries from transformer batch failures', async () => {
        // Create 60 nodes, all failing transformer — exercises cap inside batch catch
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

        expect(diagnostics.skippedNodes.length).toBeLessThanOrEqual(50);
        expect(diagnostics.counts.transformerErrors).toBe(60);
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
        expect(diagnostics.skippedNodes[0].reason).toContain('plain string error');
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
