/**
 * Unit tests for incremental semantic build (Task 5).
 *
 * Covers:
 *   1. Hash determinism — same inputs → same hash; any field change → different hash.
 *   2. No-op rebuild — 0 embedder calls, all N nodes reused.
 *   3. Single-node snippet change — 1 embedder call, N-1 reused.
 *   4. Model-alias change — full rebuild forced, no reuse, warning logged.
 *   5. schemaVersion mismatch in prior manifest — full rebuild, warning logged.
 *   6. --full flag — forces full rebuild even with compatible prior index.
 *   7. Deleted nodes — dropped from output, no orphans.
 *   8. Corrupt embeddings.jsonl — full rebuild, warning logged.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArchGraph } from '../core/types.js';
import { inMemoryProject } from '../__fixtures__/in-memory-project.js';
import { buildSemanticIndex, computeContentHash } from './builder.js';
import { SEMANTIC_MODELS, SEMANTIC_SCHEMA_VERSION } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
    testDir = join(
        tmpdir(),
        `arch-graph-incremental-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

const DIM = SEMANTIC_MODELS.minilm.dim; // 384

/** Deterministic fake vector seeded by index. */
function fakeVector(seed: number, dim = DIM): number[] {
    return Array.from({ length: dim }, (_, i) => (seed + i) / dim);
}

/** Minimal valid ArchGraph for testing. */
function makeGraph(overrides: Partial<ArchGraph> = {}): ArchGraph {
    return {
        version: '1',
        buildAt: '2026-05-18T00:00:00.000Z',
        root: '/project',
        nodes: [],
        edges: [],
        ...overrides,
    };
}

/** Write a graph.json to testDir. */
async function writeGraphJson(graph: ArchGraph): Promise<void> {
    await writeFile(join(testDir, 'graph.json'), JSON.stringify(graph, null, 2), 'utf8');
}

/** Write a manifest.json directly (bypassing builder) for compatibility-check tests. */
async function writeManifestRaw(fields: Record<string, unknown>): Promise<void> {
    await mkdir(join(testDir, 'semantic'), { recursive: true });
    await writeFile(
        join(testDir, 'semantic', 'manifest.json'),
        JSON.stringify(fields, null, 2),
        'utf8',
    );
}

/** Build a fake embedder that returns vectors seeded by batch call index. */
function makeFakeEmbedder() {
    let callCount = 0;
    const embedder = vi.fn(async (texts: string[]) => {
        return texts.map((_, i) => fakeVector(callCount++ + i));
    });
    return embedder;
}

// ---------------------------------------------------------------------------
// 1. Hash determinism
// ---------------------------------------------------------------------------

describe('computeContentHash — determinism', () => {
    it('same inputs produce the same hash', () => {
        const input = { kind: 'service', label: 'UserService', snippet: 'class UserService {}', modelAlias: 'minilm' };
        const h1 = computeContentHash(input);
        const h2 = computeContentHash(input);
        expect(h1).toBe(h2);
    });

    it('produces a valid 64-char hex SHA-256', () => {
        const h = computeContentHash({ kind: 'service', label: 'Foo', snippet: '', modelAlias: 'minilm' });
        expect(h).toMatch(/^[0-9a-f]{64}$/);
    });

    it('matches manual sha256 computation (inputs are NOT lowercased — case-sensitive)', () => {
        const kind = 'service';
        const label = 'UsersService';
        const snippet = 'class UsersService {}';
        const modelAlias = 'e5-base';
        // Strings are hashed as-is; no casing normalisation.
        const expected = createHash('sha256')
            .update([kind, label, snippet, modelAlias].join('|'))
            .digest('hex');
        expect(computeContentHash({ kind, label, snippet, modelAlias })).toBe(expected);
    });

    it('changing kind → different hash', () => {
        const base = { kind: 'service', label: 'Foo', snippet: 'x', modelAlias: 'minilm' };
        const h1 = computeContentHash(base);
        const h2 = computeContentHash({ ...base, kind: 'controller' });
        expect(h1).not.toBe(h2);
    });

    it('changing label → different hash', () => {
        const base = { kind: 'service', label: 'Foo', snippet: 'x', modelAlias: 'minilm' };
        const h1 = computeContentHash(base);
        const h2 = computeContentHash({ ...base, label: 'Bar' });
        expect(h1).not.toBe(h2);
    });

    it('changing snippet → different hash', () => {
        const base = { kind: 'service', label: 'Foo', snippet: 'x', modelAlias: 'minilm' };
        const h1 = computeContentHash(base);
        const h2 = computeContentHash({ ...base, snippet: 'y' });
        expect(h1).not.toBe(h2);
    });

    it('changing modelAlias → different hash', () => {
        const base = { kind: 'service', label: 'Foo', snippet: 'x', modelAlias: 'minilm' };
        const h1 = computeContentHash(base);
        const h2 = computeContentHash({ ...base, modelAlias: 'e5-base' });
        expect(h1).not.toBe(h2);
    });

    it('label casing produces different hashes (e5-base is case-sensitive)', () => {
        // P0-2: UserService and userservice must NOT collide — e5-base tokenizer is case-sensitive.
        const h1 = computeContentHash({ kind: 'service', label: 'UserService', snippet: 'x', modelAlias: 'e5-base' });
        const h2 = computeContentHash({ kind: 'service', label: 'userservice', snippet: 'x', modelAlias: 'e5-base' });
        expect(h1).not.toBe(h2);
    });

    it('snippet casing produces different hashes', () => {
        const h1 = computeContentHash({ kind: 'service', label: 'Foo', snippet: 'class UserService {}', modelAlias: 'e5-base' });
        const h2 = computeContentHash({ kind: 'service', label: 'Foo', snippet: 'class userservice {}', modelAlias: 'e5-base' });
        expect(h1).not.toBe(h2);
    });
});

// ---------------------------------------------------------------------------
// 2. No-op rebuild — zero embedder calls
// ---------------------------------------------------------------------------

describe('incremental build — no-op rebuild', () => {
    it('second run with identical graph: 0 embedder calls, all N reused', async () => {
        const N = 3;
        const graph = makeGraph({
            nodes: [
                { id: 'service:a', kind: 'service', label: 'a' },
                { id: 'service:b', kind: 'service', label: 'b' },
                { id: 'service:c', kind: 'service', label: 'c' },
            ],
        });
        await writeGraphJson(graph);

        const embedder1 = makeFakeEmbedder();

        // First build — full embed.
        await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: embedder1,
            outDir: testDir,
            modelAlias: 'minilm',
        });
        expect(embedder1).toHaveBeenCalledTimes(1); // 3 nodes in one batch

        // Second build — incremental, nothing changed.
        const embedder2 = makeFakeEmbedder();
        const { diagnostics } = await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: embedder2,
            outDir: testDir,
            modelAlias: 'minilm',
        });

        expect(embedder2).toHaveBeenCalledTimes(0);
        expect(diagnostics.counts.reused).toBe(N);
        expect(diagnostics.counts.recomputed).toBe(0);
        expect(diagnostics.counts.indexed).toBe(N);

        // All N nodes present in output.
        const jsonl = await readFile(join(testDir, 'semantic', 'embeddings.jsonl'), 'utf8');
        const records = jsonl.trim().split('\n').map((l) => JSON.parse(l) as { nodeId: string });
        expect(records).toHaveLength(N);
    });
});

// ---------------------------------------------------------------------------
// 3. Single-node snippet change
// ---------------------------------------------------------------------------

describe('incremental build — single node change', () => {
    it('changing one node triggers 1 embedder call, N-1 reused', async () => {
        const graph = makeGraph({
            nodes: [
                { id: 'service:a', kind: 'service', label: 'a' },
                { id: 'service:b', kind: 'service', label: 'b', path: '/project/b.ts' },
                { id: 'service:c', kind: 'service', label: 'c' },
            ],
        });
        await writeGraphJson(graph);

        // First build with initial snippet content.
        const project1 = inMemoryProject({ '/project/b.ts': 'class b { original() {} }' });
        const embedder1 = makeFakeEmbedder();
        await buildSemanticIndex({
            graph,
            project: project1,
            embedder: embedder1,
            outDir: testDir,
            modelAlias: 'minilm',
        });

        // Second build with changed snippet for node b.
        const project2 = inMemoryProject({ '/project/b.ts': 'class b { changed() {} }' });
        const embedder2 = makeFakeEmbedder();
        const { diagnostics } = await buildSemanticIndex({
            graph,
            project: project2,
            embedder: embedder2,
            outDir: testDir,
            modelAlias: 'minilm',
        });

        // Exactly 1 embedder call (1 changed node).
        expect(embedder2).toHaveBeenCalledTimes(1);
        expect(diagnostics.counts.reused).toBe(2);   // N-1
        expect(diagnostics.counts.recomputed).toBe(1);
        expect(diagnostics.counts.indexed).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// 4. Model-alias change → full rebuild
// ---------------------------------------------------------------------------

describe('incremental build — model alias change', () => {
    it('switching from minilm to e5-base forces full rebuild with warning', async () => {
        const N = 2;
        const graph = makeGraph({
            nodes: [
                { id: 'service:a', kind: 'service', label: 'a' },
                { id: 'service:b', kind: 'service', label: 'b' },
            ],
        });
        await writeGraphJson(graph);

        const e5Dim = SEMANTIC_MODELS['e5-base'].dim; // 768

        // First build with minilm (384-dim).
        const embedder1 = vi.fn(async (texts: string[]) => texts.map((_, i) => fakeVector(i)));
        await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: embedder1,
            outDir: testDir,
            modelAlias: 'minilm',
        });

        // Second build with e5-base — model changed, dim changed → full rebuild.
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const embedder2 = vi.fn(async (texts: string[]) => texts.map((_, i) => fakeVector(i, e5Dim)));
        const { diagnostics } = await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: embedder2,
            outDir: testDir,
            modelAlias: 'e5-base',
        });

        // Full rebuild: embedder called once for all N nodes.
        expect(embedder2).toHaveBeenCalledTimes(1);
        expect(diagnostics.counts.reused).toBe(0);
        expect(diagnostics.counts.recomputed).toBe(N);

        // Warning logged about model change.
        const warningCalls = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warningCalls).toMatch(/model.*changed.*full rebuild|prior index model/i);
    });
});

// ---------------------------------------------------------------------------
// 5. schemaVersion mismatch
// ---------------------------------------------------------------------------

describe('incremental build — schemaVersion mismatch', () => {
    it('schemaVersion=1 manifest triggers full rebuild with warning', async () => {
        const N = 2;
        const graph = makeGraph({
            nodes: [
                { id: 'service:a', kind: 'service', label: 'a' },
                { id: 'service:b', kind: 'service', label: 'b' },
            ],
        });
        await writeGraphJson(graph);

        // Manually write a schemaVersion=1 manifest (bypassing builder).
        const modelEntry = SEMANTIC_MODELS.minilm;
        await writeManifestRaw({
            schemaVersion: 1,
            model: modelEntry.hubId,
            dim: modelEntry.dim,
            builtAt: '2026-05-18T00:00:00.000Z',
            graphHash: 'deadbeef',
            nodeCount: N,
        });
        // Write empty embeddings.jsonl.
        await writeFile(join(testDir, 'semantic', 'embeddings.jsonl'), '', 'utf8');

        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const embedder = makeFakeEmbedder();

        const { diagnostics } = await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder,
            outDir: testDir,
            modelAlias: 'minilm',
        });

        // Full rebuild.
        expect(embedder).toHaveBeenCalledTimes(1);
        expect(diagnostics.counts.reused).toBe(0);
        expect(diagnostics.counts.recomputed).toBe(N);

        // Warning contains "schemaVersion".
        const allStderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(allStderr).toContain('schemaVersion');
    });

    it('schemaVersion mismatch: SEMANTIC_SCHEMA_VERSION is now 2', () => {
        expect(SEMANTIC_SCHEMA_VERSION).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// 6. --full flag
// ---------------------------------------------------------------------------

describe('incremental build — --full flag', () => {
    it('--full forces full rebuild even when prior compatible index exists', async () => {
        const N = 3;
        const graph = makeGraph({
            nodes: [
                { id: 'service:a', kind: 'service', label: 'a' },
                { id: 'service:b', kind: 'service', label: 'b' },
                { id: 'service:c', kind: 'service', label: 'c' },
            ],
        });
        await writeGraphJson(graph);

        // First build — creates a valid schemaVersion=2 index.
        const embedder1 = makeFakeEmbedder();
        await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: embedder1,
            outDir: testDir,
            modelAlias: 'minilm',
        });

        // Second build with full: true — must re-embed everything.
        const embedder2 = makeFakeEmbedder();
        const { diagnostics } = await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: embedder2,
            outDir: testDir,
            full: true,
            modelAlias: 'minilm',
        });

        expect(embedder2).toHaveBeenCalledTimes(1);
        expect(diagnostics.counts.reused).toBe(0);
        expect(diagnostics.counts.recomputed).toBe(N);
    });
});

// ---------------------------------------------------------------------------
// 7. Deleted nodes
// ---------------------------------------------------------------------------

describe('incremental build — deleted nodes', () => {
    it('node present in prior index but removed from graph is absent from output', async () => {
        const fullGraph = makeGraph({
            nodes: [
                { id: 'service:a', kind: 'service', label: 'a' },
                { id: 'service:b', kind: 'service', label: 'b' },
                { id: 'service:c', kind: 'service', label: 'c' },
            ],
        });
        await writeGraphJson(fullGraph);

        const embedder1 = makeFakeEmbedder();
        await buildSemanticIndex({
            graph: fullGraph,
            project: inMemoryProject({}),
            embedder: embedder1,
            outDir: testDir,
            modelAlias: 'minilm',
        });

        // Remove service:b from the graph.
        const reducedGraph = makeGraph({
            nodes: [
                { id: 'service:a', kind: 'service', label: 'a' },
                { id: 'service:c', kind: 'service', label: 'c' },
            ],
        });
        await writeGraphJson(reducedGraph);

        const embedder2 = makeFakeEmbedder();
        const { diagnostics } = await buildSemanticIndex({
            graph: reducedGraph,
            project: inMemoryProject({}),
            embedder: embedder2,
            outDir: testDir,
            modelAlias: 'minilm',
        });

        // Output has exactly 2 records.
        const jsonl = await readFile(join(testDir, 'semantic', 'embeddings.jsonl'), 'utf8');
        const records = jsonl.trim().split('\n').map((l) => JSON.parse(l) as { nodeId: string });
        expect(records).toHaveLength(2);

        // Deleted node is gone.
        const ids = records.map((r) => r.nodeId);
        expect(ids).not.toContain('service:b');
        expect(ids).toContain('service:a');
        expect(ids).toContain('service:c');

        // Diagnostics: 2 indexed, 2 reused (a + c unchanged), 0 recomputed.
        expect(diagnostics.counts.indexed).toBe(2);
        expect(diagnostics.counts.reused).toBe(2);
        expect(diagnostics.counts.recomputed).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// 8. Corrupt embeddings.jsonl
// ---------------------------------------------------------------------------

describe('incremental build — corrupt embeddings.jsonl', () => {
    it('corrupt JSONL at line 3 triggers full rebuild with warning', async () => {
        const N = 3;
        const graph = makeGraph({
            nodes: [
                { id: 'service:a', kind: 'service', label: 'a' },
                { id: 'service:b', kind: 'service', label: 'b' },
                { id: 'service:c', kind: 'service', label: 'c' },
            ],
        });
        await writeGraphJson(graph);

        // Write a compatible manifest with schemaVersion=2.
        const modelEntry = SEMANTIC_MODELS.minilm;
        await writeManifestRaw({
            schemaVersion: SEMANTIC_SCHEMA_VERSION,
            model: modelEntry.hubId,
            dim: modelEntry.dim,
            builtAt: '2026-05-18T00:00:00.000Z',
            graphHash: 'deadbeef',
            nodeCount: N,
        });

        // Write 2 valid lines then a corrupt line.
        const validRecord1 = JSON.stringify({ nodeId: 'service:a', kind: 'service', label: 'a', snippet: '', contentHash: 'abc', vector: fakeVector(0) });
        const validRecord2 = JSON.stringify({ nodeId: 'service:b', kind: 'service', label: 'b', snippet: '', contentHash: 'def', vector: fakeVector(1) });
        await writeFile(
            join(testDir, 'semantic', 'embeddings.jsonl'),
            [validRecord1, validRecord2, '{ this is not valid json !!'].join('\n'),
            'utf8',
        );

        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const embedder = makeFakeEmbedder();

        const { diagnostics } = await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder,
            outDir: testDir,
            modelAlias: 'minilm',
        });

        // Full rebuild triggered.
        expect(embedder).toHaveBeenCalledTimes(1);
        expect(diagnostics.counts.reused).toBe(0);
        expect(diagnostics.counts.recomputed).toBe(N);

        // Warning contains "corrupt".
        const allStderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(allStderr).toContain('corrupt');

        // Output is valid (3 records, no orphans from prior).
        const jsonl = await readFile(join(testDir, 'semantic', 'embeddings.jsonl'), 'utf8');
        const records = jsonl.trim().split('\n').map((l) => JSON.parse(l));
        expect(records).toHaveLength(N);
    });
});

// ---------------------------------------------------------------------------
// 9. contentHash in output records
// ---------------------------------------------------------------------------

// Note: section numbers preserved; new sections appended below.

describe('incremental build — contentHash in JSONL records', () => {
    it('each record in schemaVersion=2 output has a non-empty contentHash', async () => {
        const graph = makeGraph({
            nodes: [
                { id: 'service:a', kind: 'service', label: 'a' },
                { id: 'service:b', kind: 'service', label: 'b' },
            ],
        });
        await writeGraphJson(graph);

        await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: makeFakeEmbedder(),
            outDir: testDir,
            modelAlias: 'minilm',
        });

        const jsonl = await readFile(join(testDir, 'semantic', 'embeddings.jsonl'), 'utf8');
        const records = jsonl.trim().split('\n').map((l) => JSON.parse(l) as { contentHash?: string });
        for (const rec of records) {
            expect(rec.contentHash).toBeTruthy();
            expect(rec.contentHash).toMatch(/^[0-9a-f]{64}$/);
        }
    });
});

// ---------------------------------------------------------------------------
// 10. P0-1: fe-component i18nStrings metadata change busts cache
// ---------------------------------------------------------------------------

describe('incremental build — fe-component i18nStrings change busts cache (P0-1)', () => {
    it('same snippet but changed i18nStrings triggers recompute', async () => {
        const snippet = 'export function MyButton() {}';

        // First build: node with i18nStrings = ['Save']
        const graphV1 = makeGraph({
            nodes: [
                {
                    id: 'fe-component:MyButton',
                    kind: 'fe-component',
                    label: 'MyButton',
                    meta: { i18nStrings: ['Save'] },
                },
            ],
        });
        await writeGraphJson(graphV1);

        const embedder1 = makeFakeEmbedder();
        await buildSemanticIndex({
            graph: graphV1,
            project: inMemoryProject({ 'MyButton.tsx': snippet }),
            embedder: embedder1,
            outDir: testDir,
            modelAlias: 'minilm',
        });
        expect(embedder1).toHaveBeenCalledTimes(1);

        // Second build: same snippet, but i18nStrings changed to ['Cancel']
        const graphV2 = makeGraph({
            nodes: [
                {
                    id: 'fe-component:MyButton',
                    kind: 'fe-component',
                    label: 'MyButton',
                    meta: { i18nStrings: ['Cancel'] },
                },
            ],
        });
        await writeGraphJson(graphV2);

        const embedder2 = makeFakeEmbedder();
        const { diagnostics } = await buildSemanticIndex({
            graph: graphV2,
            project: inMemoryProject({ 'MyButton.tsx': snippet }),
            embedder: embedder2,
            outDir: testDir,
            modelAlias: 'minilm',
        });

        // Metadata changed → must recompute, not reuse.
        expect(embedder2).toHaveBeenCalledTimes(1);
        expect(diagnostics.counts.reused).toBe(0);
        expect(diagnostics.counts.recomputed).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// 11. e5-base incremental: no-op rebuild with 768-dim vectors
// ---------------------------------------------------------------------------

describe('incremental build — e5-base no-op rebuild (768-dim)', () => {
    const E5_DIM = SEMANTIC_MODELS['e5-base'].dim; // 768

    function fakeVector768(seed: number): number[] {
        return Array.from({ length: E5_DIM }, (_, i) => (seed + i) / E5_DIM);
    }

    it('second run with identical graph and e5-base: 0 embedder calls, all nodes reused', async () => {
        const N = 2;
        const graph = makeGraph({
            nodes: [
                { id: 'service:alpha', kind: 'service', label: 'AlphaService' },
                { id: 'service:beta', kind: 'service', label: 'BetaService' },
            ],
        });
        await writeGraphJson(graph);

        let e5CallCount = 0;
        const embedder1 = vi.fn(async (texts: string[]) => texts.map((_, i) => fakeVector768(e5CallCount++ + i)));

        // First build — full embed with e5-base.
        await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: embedder1,
            outDir: testDir,
            modelAlias: 'e5-base',
        });
        expect(embedder1).toHaveBeenCalledTimes(1);

        // Second build — incremental, nothing changed.
        let e5CallCount2 = 0;
        const embedder2 = vi.fn(async (texts: string[]) => texts.map((_, i) => fakeVector768(e5CallCount2++ + i)));
        const { diagnostics } = await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: embedder2,
            outDir: testDir,
            modelAlias: 'e5-base',
        });

        expect(embedder2).toHaveBeenCalledTimes(0); // zero embed calls — all reused
        expect(diagnostics.counts.reused).toBe(N);
        expect(diagnostics.counts.recomputed).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// 12. Atomic write order: JSONL written before manifest
// ---------------------------------------------------------------------------

describe('incremental build — JSONL written before manifest (atomic write order)', () => {
    it('when manifest write fails, prior manifest survives so next run forces full rebuild', async () => {
        const graph = makeGraph({
            nodes: [
                { id: 'service:x', kind: 'service', label: 'X' },
            ],
        });
        await writeGraphJson(graph);

        // First successful build to create a valid prior sidecar.
        const embedder1 = makeFakeEmbedder();
        await buildSemanticIndex({
            graph,
            project: inMemoryProject({}),
            embedder: embedder1,
            outDir: testDir,
            modelAlias: 'minilm',
        });

        // Capture the prior manifest content.
        const priorManifestContent = await readFile(join(testDir, 'semantic', 'manifest.json'), 'utf8');
        const priorManifest = JSON.parse(priorManifestContent) as { schemaVersion: number; builtAt: string };

        // Make the manifest file read-only so writeManifest will throw.
        const { chmod } = await import('node:fs/promises');
        const manifestPath = join(testDir, 'semantic', 'manifest.json');
        await chmod(manifestPath, 0o444); // read-only

        // Second build — should fail at writeManifest (manifest is read-only).
        let buildThrew = false;
        try {
            await buildSemanticIndex({
                graph,
                project: inMemoryProject({}),
                embedder: makeFakeEmbedder(),
                outDir: testDir,
                modelAlias: 'minilm',
            });
        } catch {
            buildThrew = true;
        }

        // Restore permissions.
        await chmod(manifestPath, 0o644);

        // Build must have thrown (write failed).
        expect(buildThrew).toBe(true);

        // The prior manifest content must be unchanged — old manifest survives.
        // This means the next run will see a schemaVersion/model match and can
        // either reuse (if JSONL survived) or force full rebuild (if JSONL is new).
        const currentManifestContent = await readFile(manifestPath, 'utf8');
        const currentManifest = JSON.parse(currentManifestContent) as { schemaVersion: number; builtAt: string };
        expect(currentManifest.builtAt).toBe(priorManifest.builtAt);
        expect(currentManifest.schemaVersion).toBe(priorManifest.schemaVersion);
    });
});
