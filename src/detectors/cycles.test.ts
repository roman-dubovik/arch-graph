import { describe, expect, it } from 'vitest';

import type { ArchGraph, GraphEdge, GraphNode } from '../core/types.js';
import { detectCycles } from './cycles.js';

// ============================================================================
// Helpers — build synthetic ArchGraph objects
// ============================================================================

function makeNode(id: string, kind: GraphNode['kind'] = 'file'): GraphNode {
    return { id, kind, label: id };
}

function makeEdge(
    from: string,
    to: string,
    kind: GraphEdge['kind'] = 'ts-import',
    extra?: Partial<GraphEdge>,
): GraphEdge {
    return { id: `${from}->${to}:${kind}`, from, to, kind, ...extra };
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

// ============================================================================
// Tests
// ============================================================================

describe('detectCycles — empty graph', () => {
    it('returns 0 cycles for a completely empty graph', () => {
        const graph = makeGraph([], []);
        const result = detectCycles(graph);
        expect(result.cycles).toHaveLength(0);
        expect(result.counts.total).toBe(0);
        expect(result.counts.tsImport).toBe(0);
        expect(result.counts.libUsage).toBe(0);
        expect(result.counts.diImport).toBe(0);
    });

    it('returns 0 cycles for nodes with no edges', () => {
        const graph = makeGraph(
            [makeNode('file:a'), makeNode('file:b')],
            [],
        );
        const result = detectCycles(graph);
        expect(result.cycles).toHaveLength(0);
    });
});

describe('detectCycles — DAG (no cycles)', () => {
    it('returns 0 cycles for a simple DAG A→B→C', () => {
        const a = makeNode('file:a');
        const b = makeNode('file:b');
        const c = makeNode('file:c');
        const graph = makeGraph(
            [a, b, c],
            [
                makeEdge('file:a', 'file:b'),
                makeEdge('file:b', 'file:c'),
            ],
        );
        const result = detectCycles(graph);
        expect(result.cycles).toHaveLength(0);
        expect(result.counts.total).toBe(0);
    });

    it('returns 0 cycles for a fan-out DAG', () => {
        const graph = makeGraph(
            [makeNode('file:root'), makeNode('file:left'), makeNode('file:right')],
            [
                makeEdge('file:root', 'file:left'),
                makeEdge('file:root', 'file:right'),
            ],
        );
        const result = detectCycles(graph);
        expect(result.cycles).toHaveLength(0);
    });
});

describe('detectCycles — self-loop', () => {
    it('detects A → A as a cycle of length 1', () => {
        const graph = makeGraph(
            [makeNode('file:a')],
            [makeEdge('file:a', 'file:a')],
        );
        const result = detectCycles(graph);
        expect(result.cycles).toHaveLength(1);
        expect(result.cycles[0]!.nodes).toEqual(['file:a']);
        expect(result.cycles[0]!.kind).toBe('ts-import');
        expect(result.counts.tsImport).toBe(1);
        expect(result.counts.total).toBe(1);
    });
});

describe('detectCycles — 2-node cycle', () => {
    it('detects A → B → A as one cycle with nodes [A, B]', () => {
        const graph = makeGraph(
            [makeNode('file:a'), makeNode('file:b')],
            [
                makeEdge('file:a', 'file:b'),
                makeEdge('file:b', 'file:a'),
            ],
        );
        const result = detectCycles(graph);
        expect(result.cycles).toHaveLength(1);
        const cycle = result.cycles[0]!;
        expect(cycle.kind).toBe('ts-import');
        // canonical: smallest node first
        expect(cycle.nodes).toEqual(['file:a', 'file:b']);
    });
});

describe('detectCycles — 3-node cycle', () => {
    it('detects A → B → C → A as one cycle with nodes [A, B, C]', () => {
        const graph = makeGraph(
            [makeNode('file:a'), makeNode('file:b'), makeNode('file:c')],
            [
                makeEdge('file:a', 'file:b'),
                makeEdge('file:b', 'file:c'),
                makeEdge('file:c', 'file:a'),
            ],
        );
        const result = detectCycles(graph);
        expect(result.cycles).toHaveLength(1);
        const cycle = result.cycles[0]!;
        expect(cycle.nodes).toEqual(['file:a', 'file:b', 'file:c']);
    });
});

describe('detectCycles — shared node between two cycles', () => {
    it('reports both A↔B and A↔C as separate cycles', () => {
        // Edges: A→B, B→A, A→C, C→A
        const graph = makeGraph(
            [makeNode('file:a'), makeNode('file:b'), makeNode('file:c')],
            [
                makeEdge('file:a', 'file:b'),
                makeEdge('file:b', 'file:a'),
                makeEdge('file:a', 'file:c'),
                makeEdge('file:c', 'file:a'),
            ],
        );
        const result = detectCycles(graph);
        expect(result.cycles).toHaveLength(2);

        const cycleNodes = result.cycles.map((c) => c.nodes.sort().join(','));
        expect(cycleNodes).toContain('file:a,file:b');
        expect(cycleNodes).toContain('file:a,file:c');
    });
});

describe('detectCycles — two disjoint cycles in different edge kinds', () => {
    it('reports one ts-import cycle and one di-import cycle with correct kinds', () => {
        const graph = makeGraph(
            [
                makeNode('file:a', 'file'),
                makeNode('file:b', 'file'),
                makeNode('module:x', 'module'),
                makeNode('module:y', 'module'),
            ],
            [
                // ts-import cycle: a ↔ b
                makeEdge('file:a', 'file:b', 'ts-import'),
                makeEdge('file:b', 'file:a', 'ts-import'),
                // di-import cycle: x ↔ y
                makeEdge('module:x', 'module:y', 'di-import'),
                makeEdge('module:y', 'module:x', 'di-import'),
            ],
        );
        const result = detectCycles(graph);
        expect(result.cycles).toHaveLength(2);
        expect(result.counts.tsImport).toBe(1);
        expect(result.counts.diImport).toBe(1);
        expect(result.counts.libUsage).toBe(0);
        expect(result.counts.total).toBe(2);

        const tsImportCycle = result.cycles.find((c) => c.kind === 'ts-import');
        const diImportCycle = result.cycles.find((c) => c.kind === 'di-import');
        expect(tsImportCycle).toBeDefined();
        expect(diImportCycle).toBeDefined();
        expect(tsImportCycle!.nodes).toEqual(['file:a', 'file:b']);
        expect(diImportCycle!.nodes).toEqual(['module:x', 'module:y']);
    });
});

describe('detectCycles — lib-usage cycles', () => {
    it('detects lib-usage cycle between two services', () => {
        const graph = makeGraph(
            [makeNode('service:a', 'service'), makeNode('service:b', 'service')],
            [
                makeEdge('service:a', 'service:b', 'lib-usage'),
                makeEdge('service:b', 'service:a', 'lib-usage'),
            ],
        );
        const result = detectCycles(graph);
        expect(result.counts.libUsage).toBe(1);
        expect(result.cycles[0]!.kind).toBe('lib-usage');
    });
});

describe('detectCycles — edgeLocations', () => {
    it('populates edgeLocations for a 2-node cycle', () => {
        const graph = makeGraph(
            [makeNode('file:a'), makeNode('file:b')],
            [
                makeEdge('file:a', 'file:b', 'ts-import', {
                    file: '/project/a.ts',
                    line: 10,
                }),
                makeEdge('file:b', 'file:a', 'ts-import', {
                    file: '/project/b.ts',
                    line: 5,
                }),
            ],
        );
        const result = detectCycles(graph);
        expect(result.cycles).toHaveLength(1);
        const { edgeLocations } = result.cycles[0]!;
        // 2 steps: a→b and b→a
        expect(edgeLocations).toHaveLength(2);

        // canonical order: [a, b], so step 0 is a→b
        const stepAB = edgeLocations.find((e) => e.from === 'file:a' && e.to === 'file:b');
        const stepBA = edgeLocations.find((e) => e.from === 'file:b' && e.to === 'file:a');
        expect(stepAB).toBeDefined();
        expect(stepAB!.location).toEqual({ file: '/project/a.ts', line: 10, column: 0 });
        expect(stepBA).toBeDefined();
        expect(stepBA!.location).toEqual({ file: '/project/b.ts', line: 5, column: 0 });
    });

    it('omits location when edge has no file/line', () => {
        const graph = makeGraph(
            [makeNode('file:a'), makeNode('file:b')],
            [
                makeEdge('file:a', 'file:b', 'ts-import'),
                makeEdge('file:b', 'file:a', 'ts-import'),
            ],
        );
        const result = detectCycles(graph);
        const { edgeLocations } = result.cycles[0]!;
        for (const loc of edgeLocations) {
            expect(loc.location).toBeUndefined();
        }
    });

    it('omits location when only file is present (no line)', () => {
        const graph = makeGraph(
            [makeNode('file:a'), makeNode('file:b')],
            [
                makeEdge('file:a', 'file:b', 'ts-import', { file: '/project/a.ts' }),
                makeEdge('file:b', 'file:a', 'ts-import'),
            ],
        );
        const result = detectCycles(graph);
        const { edgeLocations } = result.cycles[0]!;
        const stepAB = edgeLocations.find((e) => e.from === 'file:a');
        expect(stepAB!.location).toBeUndefined();
    });

    it('has n edgeLocations for an n-node cycle (including closing back-edge)', () => {
        // 3-node cycle: a→b→c→a
        const graph = makeGraph(
            [makeNode('file:a'), makeNode('file:b'), makeNode('file:c')],
            [
                makeEdge('file:a', 'file:b', 'ts-import', { file: '/a.ts', line: 1 }),
                makeEdge('file:b', 'file:c', 'ts-import', { file: '/b.ts', line: 2 }),
                makeEdge('file:c', 'file:a', 'ts-import', { file: '/c.ts', line: 3 }),
            ],
        );
        const result = detectCycles(graph);
        expect(result.cycles).toHaveLength(1);
        expect(result.cycles[0]!.edgeLocations).toHaveLength(3);
    });
});

describe('detectCycles — canonical normalisation', () => {
    it('reports the same cycle regardless of which node was first explored', () => {
        // The cycle B→C→A→B should be normalised to [A,B,C] (A is smallest).
        const graph = makeGraph(
            [makeNode('file:b'), makeNode('file:c'), makeNode('file:a')],
            [
                makeEdge('file:b', 'file:c'),
                makeEdge('file:c', 'file:a'),
                makeEdge('file:a', 'file:b'),
            ],
        );
        const result = detectCycles(graph);
        expect(result.cycles).toHaveLength(1);
        expect(result.cycles[0]!.nodes[0]).toBe('file:a');
    });
});

describe('detectCycles — blocked node B-map (Johnson algorithm internal paths)', () => {
    it('exercises B-map unblocking via chain: blocked ancestor reachable from two paths', () => {
        // Graph that exercises lines 140-141 (B-map unblocking cascade):
        //   file:a → file:b
        //   file:b → file:c  (file:c tries to reach file:b which is blocked → B[file:b]={file:c})
        //   file:b → file:d  (file:d → file:a closes the 3-cycle a→b→d→a)
        //   file:c → file:b  (back-edge to blocked ancestor)
        //   file:d → file:a
        //
        // When s=file:a, circuit(file:b) explores file:c first.
        // circuit(file:c) finds file:b blocked → adds file:c to B[file:b].
        // Then circuit(file:b) explores file:d which finds the cycle file:a→file:b→file:d→file:a.
        // unblock(file:b) runs with B[file:b]={file:c} → lines 140-141 are hit.
        const graph = makeGraph(
            [
                makeNode('file:a'),
                makeNode('file:b'),
                makeNode('file:c'),
                makeNode('file:d'),
            ],
            [
                makeEdge('file:a', 'file:b'),
                makeEdge('file:b', 'file:c'), // file:c is processed first (alphabetical)
                makeEdge('file:b', 'file:d'),
                makeEdge('file:c', 'file:b'), // back-edge to blocked ancestor file:b
                makeEdge('file:d', 'file:a'), // closes the outer cycle
            ],
        );
        const result = detectCycles(graph);
        // Should detect: file:a→file:b→file:d→file:a (3-cycle) AND file:b↔file:c (2-cycle)
        expect(result.counts.total).toBeGreaterThanOrEqual(2);
        const cycleKeys = result.cycles.map((c) => [...c.nodes].sort().join(','));
        expect(cycleKeys).toContain('file:a,file:b,file:d');
        expect(cycleKeys).toContain('file:b,file:c');
    });

    it('finds all cycles in a graph with multiple interconnected components', () => {
        // Additional coverage for the B-map paths with more graph complexity
        const graph = makeGraph(
            [
                makeNode('file:a'), makeNode('file:b'), makeNode('file:c'),
                makeNode('file:d'), makeNode('file:e'),
            ],
            [
                makeEdge('file:a', 'file:b'),
                makeEdge('file:b', 'file:c'),
                makeEdge('file:c', 'file:b'), // b↔c cycle
                makeEdge('file:b', 'file:d'),
                makeEdge('file:d', 'file:a'), // a→b→d→a cycle
                makeEdge('file:a', 'file:e'),
                makeEdge('file:e', 'file:a'), // a↔e cycle
            ],
        );
        const result = detectCycles(graph);
        expect(result.counts.total).toBeGreaterThanOrEqual(3);
    });
});
