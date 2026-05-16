import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import type { ArchGraph, CyclesDiagnostics, GraphEdge, GraphNode } from '../core/types.js';
import { parseSliceMode, renderMermaid, writeGraphMermaid } from './graph-mermaid.js';

// ============================================================================
// Helpers
// ============================================================================

function makeNode(id: string, kind: GraphNode['kind'] = 'service'): GraphNode {
    return { id, kind, label: id };
}

function makeEdge(from: string, to: string, kind: GraphEdge['kind'] = 'http-call'): GraphEdge {
    return { id: `${from}->${to}`, from, to, kind };
}

function makeGraph(nodes: GraphNode[], edges: GraphEdge[]): ArchGraph {
    return {
        version: '1',
        buildAt: new Date().toISOString(),
        root: '/project',
        nodes,
        edges,
    };
}

function noCycles(): CyclesDiagnostics {
    return { cycles: [], counts: { tsImport: 0, libUsage: 0, diImport: 0 } };
}

// ============================================================================
// renderMermaid — baseline behaviour (no cycles)
// ============================================================================

describe('renderMermaid — baseline', () => {
    it('emits flowchart LR header', () => {
        const { body } = renderMermaid([], [], 200);
        expect(body).toContain('flowchart LR');
    });

    it('emits empty-placeholder when no nodes', () => {
        const { body } = renderMermaid([], [], 200);
        expect(body).toContain('(no nodes in this slice)');
    });

    it('emits large-graph comment when node count exceeds threshold', () => {
        const nodes = Array.from({ length: 5 }, (_, i) => makeNode(`svc:${i}`));
        const { body } = renderMermaid(nodes, [], 3);
        expect(body).toContain('%% graph has 5 nodes');
    });

    it('does not emit large-graph comment when below threshold', () => {
        const nodes = [makeNode('svc:a'), makeNode('svc:b')];
        const { body } = renderMermaid(nodes, [], 200);
        expect(body).not.toContain('%% graph has');
    });

    it('emits subgraph for services', () => {
        const nodes = [makeNode('svc:a', 'service')];
        const { body } = renderMermaid(nodes, [], 200);
        expect(body).toContain('subgraph services');
    });

    it('emits subgraph for libs', () => {
        const nodes = [makeNode('lib:shared', 'lib')];
        const { body } = renderMermaid(nodes, [], 200);
        expect(body).toContain('subgraph libs');
    });

    it('emits subgraph for modules', () => {
        const nodes = [makeNode('module:app', 'module')];
        const { body } = renderMermaid(nodes, [], 200);
        expect(body).toContain('subgraph modules');
    });

    it('emits subgraph for queues', () => {
        const nodes = [makeNode('queue:email', 'queue')];
        const { body } = renderMermaid(nodes, [], 200);
        expect(body).toContain('subgraph queues');
    });

    it('emits subgraph for nats-subjects', () => {
        const nodes = [makeNode('nats:user.created', 'nats-subject')];
        const { body } = renderMermaid(nodes, [], 200);
        expect(body).toContain('subgraph nats_subjects');
    });

    it('emits subgraph for db-tables', () => {
        const nodes = [makeNode('db:users', 'db-table')];
        const { body } = renderMermaid(nodes, [], 200);
        expect(body).toContain('subgraph db_tables');
    });

    it('emits subgraph for providers', () => {
        const nodes = [makeNode('provider:auth', 'provider')];
        const { body } = renderMermaid(nodes, [], 200);
        expect(body).toContain('subgraph providers');
    });

    it('emits subgraph for externals', () => {
        const nodes = [makeNode('external:stripe', 'external')];
        const { body } = renderMermaid(nodes, [], 200);
        expect(body).toContain('subgraph externals');
    });

    it('emits subgraph for files', () => {
        const nodes = [makeNode('file:a', 'file')];
        const { body } = renderMermaid(nodes, [], 200);
        expect(body).toContain('subgraph files');
    });

    it('emits edges with correct syntax for http-call', () => {
        const nodes = [makeNode('svc:a'), makeNode('svc:b')];
        const edges = [makeEdge('svc:a', 'svc:b', 'http-call')];
        const { body } = renderMermaid(nodes, edges, 200);
        expect(body).toMatch(/svc_a\s+==>.*svc_b/);
    });

    it('emits edges with di-import arrow', () => {
        const nodes = [makeNode('module:x', 'module'), makeNode('module:y', 'module')];
        const edges = [makeEdge('module:x', 'module:y', 'di-import')];
        const { body } = renderMermaid(nodes, edges, 200);
        expect(body).toContain('di');
    });

    it('emits classDef lines', () => {
        const nodes = [makeNode('svc:a')];
        const { body } = renderMermaid(nodes, [], 200);
        expect(body).toContain('classDef service');
    });

    it('emits class assignments', () => {
        const nodes = [makeNode('svc:a', 'service')];
        const { body } = renderMermaid(nodes, [], 200);
        expect(body).toMatch(/class .* service;/);
    });

    it('returns no collision groups for unique ids', () => {
        const nodes = [makeNode('svc:a'), makeNode('svc:b')];
        const { collisionGroups } = renderMermaid(nodes, [], 200);
        expect(collisionGroups).toHaveLength(0);
    });

    it('detects collision groups when two ids sanitize to the same string', () => {
        // 'svc:a-b' and 'svc:a.b' both sanitize to 'svc_a_b'
        const nodes = [makeNode('svc:a-b'), makeNode('svc:a.b')];
        const { collisionGroups } = renderMermaid(nodes, [], 200);
        expect(collisionGroups.length).toBeGreaterThan(0);
    });

    it('no cycles parameter → no CYCLES subgraph', () => {
        const nodes = [makeNode('svc:a'), makeNode('svc:b')];
        const { body } = renderMermaid(nodes, [], 200);
        expect(body).not.toContain('subgraph CYCLES');
    });

    it('cycles=undefined → identical to no-cycles output', () => {
        const nodes = [makeNode('svc:a')];
        const { body: withUndefined } = renderMermaid(nodes, [], 200, undefined);
        const { body: withoutParam } = renderMermaid(nodes, [], 200);
        expect(withUndefined).toBe(withoutParam);
    });

    it('cycles with 0 cycles → no CYCLES subgraph', () => {
        const nodes = [makeNode('svc:a')];
        const { body } = renderMermaid(nodes, [], 200, noCycles());
        expect(body).not.toContain('subgraph CYCLES');
    });
});

// ============================================================================
// renderMermaid — cycle-aware output
// ============================================================================

describe('renderMermaid — cycle-aware grouping', () => {
    it('does NOT emit subgraph CYCLES block when cycles are detected (style-only approach)', () => {
        // subgraph CYCLES was dropped: Mermaid disallows a node in two subgraphs,
        // re-declaration would silently move it out of its domain subgraph.
        // Cycle nodes are highlighted via cross-subgraph `style` directives instead.
        const nodes = [makeNode('svc:a', 'service'), makeNode('svc:b', 'service')];
        const cycles: CyclesDiagnostics = {
            cycles: [
                {
                    kind: 'lib-usage',
                    nodes: ['svc:a', 'svc:b'],
                    edgeLocations: [
                        { from: 'svc:a', to: 'svc:b' },
                        { from: 'svc:b', to: 'svc:a' },
                    ],
                },
            ],
            counts: { tsImport: 0, libUsage: 1, diImport: 0 },
        };

        const { body } = renderMermaid(nodes, [], 200, cycles);
        expect(body).not.toContain('subgraph CYCLES');
        expect(body).not.toContain('Cycles detected');
        // But style directives ARE emitted
        expect(body).toContain('fill:#fdd,stroke:#c00');
    });

    it('emits style with red fill for each cycle node', () => {
        const nodes = [makeNode('svc:a', 'service'), makeNode('svc:b', 'service')];
        const cycles: CyclesDiagnostics = {
            cycles: [
                {
                    kind: 'lib-usage',
                    nodes: ['svc:a', 'svc:b'],
                    edgeLocations: [],
                },
            ],
            counts: { tsImport: 0, libUsage: 1, diImport: 0 },
        };

        const { body } = renderMermaid(nodes, [], 200, cycles);
        expect(body).toContain('fill:#fdd,stroke:#c00');
        // Both nodes should get style overrides
        const styleLines = body.split('\n').filter((l) => l.includes('fill:#fdd'));
        expect(styleLines).toHaveLength(2);
    });

    it('only styles cycle nodes, not all graph nodes', () => {
        const nodes = [
            makeNode('svc:a', 'service'),
            makeNode('svc:b', 'service'),
            makeNode('svc:c', 'service'), // not in any cycle
        ];
        const cycles: CyclesDiagnostics = {
            cycles: [
                {
                    kind: 'lib-usage',
                    nodes: ['svc:a', 'svc:b'],
                    edgeLocations: [],
                },
            ],
            counts: { tsImport: 0, libUsage: 1, diImport: 0 },
        };

        const { body } = renderMermaid(nodes, [], 200, cycles);
        const styleLines = body.split('\n').filter((l) => l.includes('fill:#fdd'));
        // Only svc:a and svc:b should get red style, not svc:c
        expect(styleLines).toHaveLength(2);
        expect(body).not.toMatch(/svc_c.*fill:#fdd/);
    });

    it('ignores cycle nodes that do not exist in the current render slice', () => {
        // Only svc:a is in the render, svc:b is absent (domain slice scenario)
        const nodes = [makeNode('svc:a', 'service')];
        const cycles: CyclesDiagnostics = {
            cycles: [
                {
                    kind: 'lib-usage',
                    nodes: ['svc:a', 'svc:b'],
                    edgeLocations: [],
                },
            ],
            counts: { tsImport: 0, libUsage: 1, diImport: 0 },
        };

        const { body } = renderMermaid(nodes, [], 200, cycles);
        expect(body).not.toContain('subgraph CYCLES');
        const styleLines = body.split('\n').filter((l) => l.includes('fill:#fdd'));
        // Only svc:a gets styled (svc:b not in this slice)
        expect(styleLines).toHaveLength(1);
    });

    it('no style directives when all cycle nodes absent from slice', () => {
        // Neither cycle node is in the render
        const nodes = [makeNode('svc:c', 'service')];
        const cycles: CyclesDiagnostics = {
            cycles: [
                {
                    kind: 'lib-usage',
                    nodes: ['svc:a', 'svc:b'],
                    edgeLocations: [],
                },
            ],
            counts: { tsImport: 0, libUsage: 1, diImport: 0 },
        };

        const { body } = renderMermaid(nodes, [], 200, cycles);
        expect(body).not.toContain('subgraph CYCLES');
        expect(body).not.toContain('fill:#fdd');
    });

    it('handles multiple cycles with shared nodes correctly', () => {
        const nodes = [
            makeNode('svc:a', 'service'),
            makeNode('svc:b', 'service'),
            makeNode('svc:c', 'service'),
        ];
        const cycles: CyclesDiagnostics = {
            cycles: [
                { kind: 'lib-usage', nodes: ['svc:a', 'svc:b'], edgeLocations: [] },
                { kind: 'lib-usage', nodes: ['svc:a', 'svc:c'], edgeLocations: [] },
            ],
            counts: { tsImport: 0, libUsage: 2, diImport: 0 },
        };

        const { body } = renderMermaid(nodes, [], 200, cycles);
        expect(body).not.toContain('subgraph CYCLES');
        // All three nodes should get red style overrides
        const styleLines = body.split('\n').filter((l) => l.includes('fill:#fdd'));
        expect(styleLines).toHaveLength(3);
    });

    it('omits style directives for empty graph (empty-graph guard takes precedence)', () => {
        // No nodes at all — renderMermaid returns early with placeholder
        const cycles: CyclesDiagnostics = {
            cycles: [{ kind: 'ts-import', nodes: ['file:a'], edgeLocations: [] }],
            counts: { tsImport: 1, libUsage: 0, diImport: 0 },
        };
        const { body } = renderMermaid([], [], 200, cycles);
        // empty-graph placeholder is emitted, no CYCLES block, no style
        expect(body).toContain('no nodes in this slice');
        expect(body).not.toContain('subgraph CYCLES');
        expect(body).not.toContain('fill:#fdd');
    });
});

// ============================================================================
// writeGraphMermaid — file I/O
// ============================================================================

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'arch-graph-test-'));
    try {
        await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe('writeGraphMermaid — full slice (default)', () => {
    it('writes graph.mermaid to outPath', async () => {
        const nodes = [makeNode('svc:a', 'service'), makeNode('svc:b', 'service')];
        const edges = [makeEdge('svc:a', 'svc:b', 'http-call')];
        const graph = makeGraph(nodes, edges);

        await withTempDir(async (dir) => {
            const outPath = join(dir, 'graph.mermaid');
            const written = await writeGraphMermaid(graph, outPath);
            expect(written).toEqual([outPath]);
            const content = await readFile(outPath, 'utf8');
            expect(content).toContain('flowchart LR');
        });
    });

    it('creates parent directory if it does not exist', async () => {
        const nodes = [makeNode('svc:a', 'service')];
        const graph = makeGraph(nodes, []);

        await withTempDir(async (dir) => {
            const outPath = join(dir, 'nested', 'graph.mermaid');
            await writeGraphMermaid(graph, outPath);
            const content = await readFile(outPath, 'utf8');
            expect(content).toContain('flowchart LR');
        });
    });

    it('writes collision file when collisions detected', async () => {
        // Two nodes that sanitize to the same id
        const nodes = [makeNode('svc:a-b', 'service'), makeNode('svc:a.b', 'service')];
        const graph = makeGraph(nodes, []);

        await withTempDir(async (dir) => {
            const outPath = join(dir, 'graph.mermaid');
            await writeGraphMermaid(graph, outPath);
            // Should have written mermaid-collisions.json
            const collisionsPath = join(dir, 'mermaid-collisions.json');
            const collisionsContent = await readFile(collisionsPath, 'utf8');
            const parsed = JSON.parse(collisionsContent);
            expect(parsed.collisions.length).toBeGreaterThan(0);
        });
    });

    it('removes stale collision file when no collisions', async () => {
        const nodes = [makeNode('svc:a', 'service'), makeNode('svc:b', 'service')];
        const graph = makeGraph(nodes, []);

        await withTempDir(async (dir) => {
            const outPath = join(dir, 'graph.mermaid');
            // Write a stale collision file manually
            const staleCollision = join(dir, 'mermaid-collisions.json');
            const { writeFile: wf } = await import('node:fs/promises');
            await wf(staleCollision, '{"stale":true}', 'utf8');
            await writeGraphMermaid(graph, outPath);
            // Should be removed now
            try {
                await readFile(staleCollision, 'utf8');
                expect.fail('stale collision file should have been removed');
            } catch (e: unknown) {
                expect((e as NodeJS.ErrnoException).code).toBe('ENOENT');
            }
        });
    });

    it('passes cycles to renderMermaid and emits red style for cycle nodes', async () => {
        const nodes = [makeNode('svc:a', 'service'), makeNode('svc:b', 'service')];
        const graph = makeGraph(nodes, [makeEdge('svc:a', 'svc:b', 'lib-usage')]);
        const cycles: CyclesDiagnostics = {
            cycles: [{ kind: 'lib-usage', nodes: ['svc:a', 'svc:b'], edgeLocations: [] }],
            counts: { tsImport: 0, libUsage: 1, diImport: 0 },
        };

        await withTempDir(async (dir) => {
            const outPath = join(dir, 'graph.mermaid');
            await writeGraphMermaid(graph, outPath, { cycles });
            const content = await readFile(outPath, 'utf8');
            // No subgraph CYCLES — cycle nodes are highlighted via style directives
            expect(content).not.toContain('subgraph CYCLES');
            expect(content).toContain('fill:#fdd,stroke:#c00');
        });
    });
});

describe('writeGraphMermaid — domain slice', () => {
    it('writes only domain-matching edges', async () => {
        const nodes = [makeNode('svc:a', 'service'), makeNode('svc:b', 'service')];
        const edges = [
            makeEdge('svc:a', 'svc:b', 'http-call'),
            makeEdge('svc:a', 'svc:b', 'nats-publish'),
        ];
        const graph = makeGraph(nodes, edges);

        await withTempDir(async (dir) => {
            const outPath = join(dir, 'http.mermaid');
            const written = await writeGraphMermaid(graph, outPath, {
                slice: { kind: 'domain', domain: 'http' },
            });
            expect(written).toEqual([outPath]);
            const content = await readFile(outPath, 'utf8');
            expect(content).toContain('flowchart LR');
        });
    });

    it('writes empty-placeholder for domain with no edges', async () => {
        const nodes = [makeNode('svc:a', 'service')];
        const graph = makeGraph(nodes, [makeEdge('svc:a', 'svc:a', 'http-call')]);

        await withTempDir(async (dir) => {
            const outPath = join(dir, 'nats.mermaid');
            await writeGraphMermaid(graph, outPath, {
                slice: { kind: 'domain', domain: 'nats' },
            });
            const content = await readFile(outPath, 'utf8');
            // No nats edges → empty placeholder
            expect(content).toContain('no nodes in this slice');
        });
    });
});

describe('writeGraphMermaid — per-service slice', () => {
    it('writes one file per service with touching edges', async () => {
        const nodes = [
            makeNode('svc:alpha', 'service'),
            makeNode('svc:beta', 'service'),
            makeNode('svc:gamma', 'service'), // no edges → skipped
        ];
        const edges = [makeEdge('svc:alpha', 'svc:beta', 'http-call')];
        const graph = makeGraph(nodes, edges);

        await withTempDir(async (dir) => {
            const sliceDir = join(dir, 'slices');
            const written = await writeGraphMermaid(graph, sliceDir, {
                slice: { kind: 'per-service' },
            });
            // gamma has no edges, so only alpha and beta files
            expect(written).toHaveLength(2);
            for (const f of written) {
                const content = await readFile(f, 'utf8');
                expect(content).toContain('flowchart LR');
            }
        });
    });

    it('returns empty array when no service has touching edges', async () => {
        const nodes = [makeNode('svc:lonely', 'service')];
        const graph = makeGraph(nodes, []);

        await withTempDir(async (dir) => {
            const sliceDir = join(dir, 'slices');
            const written = await writeGraphMermaid(graph, sliceDir, {
                slice: { kind: 'per-service' },
            });
            expect(written).toHaveLength(0);
        });
    });

    it('per-service slice: each service file gets style for cycle nodes it contains', async () => {
        // svc:a and svc:b have a lib-usage cycle between them.
        // svc:c has an http-call to svc:a.
        // Each per-service file should get `style` for any cycle node present in its slice.
        const nodes = [
            makeNode('svc:a', 'service'),
            makeNode('svc:b', 'service'),
            makeNode('svc:c', 'service'),
        ];
        const edges = [
            makeEdge('svc:a', 'svc:b', 'lib-usage'),
            makeEdge('svc:b', 'svc:a', 'lib-usage'),
            makeEdge('svc:c', 'svc:a', 'http-call'),
        ];
        const graph = makeGraph(nodes, edges);
        const cycles: CyclesDiagnostics = {
            cycles: [{ kind: 'lib-usage', nodes: ['svc:a', 'svc:b'], edgeLocations: [] }],
            counts: { tsImport: 0, libUsage: 1, diImport: 0 },
        };

        await withTempDir(async (dir) => {
            const sliceDir = join(dir, 'slices');
            const written = await writeGraphMermaid(graph, sliceDir, {
                slice: { kind: 'per-service' },
                cycles,
            });
            // All 3 services have at least one touching edge → 3 files
            expect(written).toHaveLength(3);

            for (const f of written) {
                const content = await readFile(f, 'utf8');
                // svc:c's file contains svc:a (which is a cycle node) → style should be present
                // svc:a's file contains both svc:a and svc:b (both cycle nodes)
                // svc:b's file contains both svc:a and svc:b (both cycle nodes)
                // At minimum: any file containing svc:a or svc:b should have a style directive
                if (content.includes('svc_a') || content.includes('svc_b')) {
                    expect(content).toContain('fill:#fdd,stroke:#c00');
                }
                expect(content).not.toContain('subgraph CYCLES');
            }
        });
    });
});

describe('writeGraphMermaid — domain slice with cycles', () => {
    it('domain slice: emits style for cycle nodes present in the domain slice', async () => {
        // lib-usage domain slice includes both svc:a and svc:b which are cycle nodes
        const nodes = [
            makeNode('svc:a', 'service'),
            makeNode('svc:b', 'service'),
            makeNode('svc:c', 'service'),
        ];
        const edges = [
            makeEdge('svc:a', 'svc:b', 'lib-usage'),
            makeEdge('svc:b', 'svc:a', 'lib-usage'),
            makeEdge('svc:a', 'svc:c', 'http-call'), // http edge — not in lib domain slice
        ];
        const graph = makeGraph(nodes, edges);
        const cycles: CyclesDiagnostics = {
            cycles: [{ kind: 'lib-usage', nodes: ['svc:a', 'svc:b'], edgeLocations: [] }],
            counts: { tsImport: 0, libUsage: 1, diImport: 0 },
        };

        await withTempDir(async (dir) => {
            const outPath = join(dir, 'lib.mermaid');
            await writeGraphMermaid(graph, outPath, {
                slice: { kind: 'domain', domain: 'lib' },
                cycles,
            });
            const content = await readFile(outPath, 'utf8');
            // Both svc:a and svc:b are in the lib-usage domain slice and in the cycle
            expect(content).toContain('fill:#fdd,stroke:#c00');
            expect(content).not.toContain('subgraph CYCLES');
            // svc:c is not in lib-usage slice → should NOT have red style
            expect(content).not.toMatch(/svc_c.*fill:#fdd/);
        });
    });

    it('domain slice: no cycle styles when cycle nodes fall outside the domain', async () => {
        // ts-import domain has a cycle but the lib-usage domain does not
        const nodes = [makeNode('svc:a', 'service'), makeNode('svc:b', 'service')];
        const edges = [
            makeEdge('svc:a', 'svc:b', 'lib-usage'),
        ];
        const graph = makeGraph(nodes, edges);
        const cycles: CyclesDiagnostics = {
            // ts-import cycle between svc:x and svc:y — nodes not in this graph
            cycles: [{ kind: 'ts-import', nodes: ['svc:x', 'svc:y'], edgeLocations: [] }],
            counts: { tsImport: 1, libUsage: 0, diImport: 0 },
        };

        await withTempDir(async (dir) => {
            const outPath = join(dir, 'lib.mermaid');
            await writeGraphMermaid(graph, outPath, {
                slice: { kind: 'domain', domain: 'lib' },
                cycles,
            });
            const content = await readFile(outPath, 'utf8');
            // svc:x and svc:y not in this graph → no style directives
            expect(content).not.toContain('fill:#fdd');
        });
    });
});

// ============================================================================
// renderMermaid — degraded cycle detection warning
// ============================================================================

describe('renderMermaid — cycles.error warning comment', () => {
    it('emits %% WARNING comment when cycles.error is set', () => {
        const nodes = [makeNode('svc:a', 'service')];
        const cycles: CyclesDiagnostics = {
            cycles: [],
            counts: { tsImport: 0, libUsage: 0, diImport: 0 },
            error: 'RangeError: Maximum call stack size exceeded',
        };
        const { body } = renderMermaid(nodes, [], 200, cycles);
        expect(body).toContain('%% WARNING: cycle detection was skipped');
        expect(body).toContain('RangeError: Maximum call stack size exceeded');
        expect(body).toContain('Cycle styling may be incomplete.');
    });

    it('does NOT emit %% WARNING comment when cycles.error is absent', () => {
        const nodes = [makeNode('svc:a', 'service')];
        const cycles: CyclesDiagnostics = {
            cycles: [],
            counts: { tsImport: 0, libUsage: 0, diImport: 0 },
        };
        const { body } = renderMermaid(nodes, [], 200, cycles);
        expect(body).not.toContain('%% WARNING: cycle detection was skipped');
    });

    it('does NOT emit %% WARNING comment when cycles is undefined', () => {
        const nodes = [makeNode('svc:a', 'service')];
        const { body } = renderMermaid(nodes, [], 200, undefined);
        expect(body).not.toContain('%% WARNING: cycle detection was skipped');
    });

    it('WARNING comment appears immediately after flowchart LR directive', () => {
        const nodes = [makeNode('svc:a', 'service')];
        const cycles: CyclesDiagnostics = {
            cycles: [],
            counts: { tsImport: 0, libUsage: 0, diImport: 0 },
            error: 'RangeError: overflow',
        };
        const { body } = renderMermaid(nodes, [], 200, cycles);
        const lines = body.split('\n');
        const directiveIdx = lines.findIndex((l) => l === 'flowchart LR');
        const warningIdx = lines.findIndex((l) => l.includes('%% WARNING'));
        expect(directiveIdx).toBeGreaterThanOrEqual(0);
        expect(warningIdx).toBe(directiveIdx + 1);
    });
});

describe('renderMermaid — escapeMermaidLabel coverage', () => {
    it('escapes special characters in node labels', () => {
        const nodes: GraphNode[] = [
            {
                id: 'svc:special',
                kind: 'service',
                label: 'a & b "quoted" <tag> >arrow',
            },
        ];
        const { body } = renderMermaid(nodes, [], 200);
        expect(body).toContain('&amp;');
        expect(body).toContain('&quot;');
        expect(body).toContain('&lt;');
        expect(body).toContain('&gt;');
    });
});

describe('renderMermaid — edge sort branches', () => {
    it('sorts edges with same kind and same from by to (hits all sort branches)', () => {
        // Three edges: two with same kind and from (differ only by to),
        // and one with different kind — exercises all 3 comparator branches.
        const nodes = [
            makeNode('svc:a', 'service'),
            makeNode('svc:b', 'service'),
            makeNode('svc:c', 'service'),
        ];
        const edges: GraphEdge[] = [
            // same kind, same from, different to — exercises line 324
            { id: 'e1', from: 'svc:a', to: 'svc:c', kind: 'http-call' },
            { id: 'e2', from: 'svc:a', to: 'svc:b', kind: 'http-call' },
            // different kind — exercises line 322
            { id: 'e3', from: 'svc:a', to: 'svc:b', kind: 'nats-publish' },
            // same kind, different from — exercises line 323
            { id: 'e4', from: 'svc:b', to: 'svc:c', kind: 'http-call' },
        ];
        const { body } = renderMermaid(nodes, edges, 200);
        expect(body).toContain('flowchart LR');
        // Just verify it runs without error and produces output
        expect(body.split('\n').filter((l) => l.includes('-->')).length +
               body.split('\n').filter((l) => l.includes('-.->')).length +
               body.split('\n').filter((l) => l.includes('==>')).length
        ).toBeGreaterThan(0);
    });
});

describe('buildIdMap — triple collision (loop inside collision handler)', () => {
    it('handles triple collision where expected suffix is already taken', () => {
        // svc:a-b → svc_a_b (first, wins)
        // svc_a_b_2 → svc_a_b_2 (natural, takes _2 slot)
        // svc:a.b → svc_a_b (second collision, tries _2, finds it taken, uses _3)
        const nodes: GraphNode[] = [
            { id: 'svc:a-b', kind: 'service', label: 'a-b' },   // → svc_a_b
            { id: 'svc_a_b_2', kind: 'service', label: 'a_b_2' }, // → svc_a_b_2 (natural)
            { id: 'svc:a.b', kind: 'service', label: 'a.b' },   // → svc_a_b collision → tries _2 (taken) → _3
        ];
        const { body, collisionGroups } = renderMermaid(nodes, [], 200);
        // Should render without error
        expect(body).toContain('flowchart LR');
        // Collision group for svc_a_b should exist
        expect(collisionGroups.some((g) => g.sanitizedId === 'svc_a_b')).toBe(true);
    });
});

// ============================================================================
// parseSliceMode
// ============================================================================

describe('parseSliceMode', () => {
    it('parses full', () => {
        expect(parseSliceMode('full')).toEqual({ kind: 'full' });
    });

    it('parses per-service', () => {
        expect(parseSliceMode('per-service')).toEqual({ kind: 'per-service' });
    });

    it('parses domain:nats', () => {
        expect(parseSliceMode('domain:nats')).toEqual({ kind: 'domain', domain: 'nats' });
    });

    it('parses domain:bullmq', () => {
        expect(parseSliceMode('domain:bullmq')).toEqual({ kind: 'domain', domain: 'bullmq' });
    });

    it('parses domain:typeorm', () => {
        expect(parseSliceMode('domain:typeorm')).toEqual({ kind: 'domain', domain: 'typeorm' });
    });

    it('parses domain:http', () => {
        expect(parseSliceMode('domain:http')).toEqual({ kind: 'domain', domain: 'http' });
    });

    it('parses domain:di', () => {
        expect(parseSliceMode('domain:di')).toEqual({ kind: 'domain', domain: 'di' });
    });

    it('parses domain:ts-import', () => {
        expect(parseSliceMode('domain:ts-import')).toEqual({ kind: 'domain', domain: 'ts-import' });
    });

    it('parses domain:lib', () => {
        expect(parseSliceMode('domain:lib')).toEqual({ kind: 'domain', domain: 'lib' });
    });

    it('throws on unknown mode', () => {
        expect(() => parseSliceMode('unknown')).toThrow();
    });

    it('throws on unknown domain', () => {
        expect(() => parseSliceMode('domain:bogus')).toThrow('unknown mermaid-slice domain');
    });
});
