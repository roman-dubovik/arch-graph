/**
 * Cycle detection across the three graph edge sub-layers:
 *   - `ts-import`  — file → file
 *   - `lib-usage`  — service/lib → service/lib
 *   - `di-import`  — module → module
 *
 * Uses Johnson's algorithm (1975) to enumerate ALL elementary cycles in a
 * directed graph. Johnson's is preferred over plain Tarjan SCC because Tarjan
 * returns one SCC for {A↔B, A↔C} while Johnson's correctly enumerates two
 * elementary cycles (A→B→A and A→C→A).
 *
 * Cycle normalisation: each cycle is rotated so the lexicographically smallest
 * node id is first. This makes output deterministic regardless of iteration
 * order, and prevents the same logical cycle from appearing under different
 * rotations.
 */

import type { ArchGraph, CyclesDiagnostics, GraphEdge, ImportCycle, SourceLoc } from '../core/types.js';

// ============================================================================
// Public entry point
// ============================================================================

/**
 * Detect all elementary cycles across the three edge sub-layers of `graph`.
 * Returns a populated `CyclesDiagnostics` object.
 */
export function detectCycles(graph: ArchGraph): CyclesDiagnostics {
    const tsImportCycles = detectForKind(graph, 'ts-import');
    const libUsageCycles = detectForKind(graph, 'lib-usage');
    const diImportCycles = detectForKind(graph, 'di-import');

    const cycles: ImportCycle[] = [...tsImportCycles, ...libUsageCycles, ...diImportCycles];

    return {
        cycles,
        counts: {
            tsImport: tsImportCycles.length,
            libUsage: libUsageCycles.length,
            diImport: diImportCycles.length,
        },
    };
}

// ============================================================================
// Per-kind detection
// ============================================================================

function detectForKind(
    graph: ArchGraph,
    kind: 'ts-import' | 'lib-usage' | 'di-import',
): ImportCycle[] {
    const relevantEdges = graph.edges.filter((e) => e.kind === kind);
    if (relevantEdges.length === 0) return [];

    // Collect all node ids that appear in these edges (not all graph nodes).
    const nodeIds = new Set<string>();
    for (const e of relevantEdges) {
        nodeIds.add(e.from);
        nodeIds.add(e.to);
    }

    // Build adjacency: node → list of (toId, edge)
    const adj = new Map<string, Array<{ to: string; edge: GraphEdge }>>();
    for (const id of nodeIds) {
        adj.set(id, []);
    }
    for (const e of relevantEdges) {
        adj.get(e.from)!.push({ to: e.to, edge: e });
    }

    // Sort node ids alphabetically so that Johnson's iteration is deterministic.
    const nodes = [...nodeIds].sort();

    const rawCycles = johnsons(nodes, adj);

    // Convert raw paths to ImportCycle objects, normalising and deduplicating.
    const seen = new Set<string>();
    const result: ImportCycle[] = [];

    for (const cyclePath of rawCycles) {
        const normalised = canonicalise(cyclePath);
        const key = normalised.join('\0');
        if (seen.has(key)) continue;
        seen.add(key);

        if (normalised.length === 0) {
            process.stderr.write(
                `[detectCycles] BUG: canonicalise returned empty path for cycle on ${kind}; skipping.\n`,
            );
            continue;
        }
        const edgeLocations = buildEdgeLocations(normalised, adj);
        result.push({ kind, nodes: normalised as [string, ...string[]], edgeLocations });
    }

    return result;
}

// ============================================================================
// Johnson's algorithm
// ============================================================================

/**
 * Johnson's algorithm — enumerate all elementary cycles in a directed graph.
 *
 * Reference: D.B. Johnson, "Finding All the Elementary Circuits of a Directed
 * Graph", SIAM J. Comput. 4(1), 1975.
 *
 * @param nodes   Sorted list of all node ids in the subgraph.
 * @param adj     Adjacency list (node → [{to, edge}]).
 * @returns       Array of cycle paths — each path is [v0, v1, …, vn-1] where
 *                vn-1 → v0 closes the cycle. The closing node is NOT repeated.
 */
function johnsons(
    nodes: string[],
    adj: Map<string, Array<{ to: string; edge: GraphEdge }>>,
): string[][] {
    const result: string[][] = [];

    // Self-loops: A → A.
    for (const id of nodes) {
        // adj is populated for every node in `nodes` — non-null assertion is safe.
        for (const { to } of adj.get(id)!) {
            if (to === id) {
                result.push([id]);
            }
        }
    }

    // Index nodes for O(1) lookup.
    const nodeIndex = new Map<string, number>();
    for (let i = 0; i < nodes.length; i++) nodeIndex.set(nodes[i]!, i);

    // Johnson's main loop — iterate over starting nodes in order.
    const blocked = new Map<string, boolean>();
    const B = new Map<string, Set<string>>(); // B[w] = set of nodes blocked on w
    const stack: string[] = [];

    function unblock(u: string): void {
        blocked.set(u, false);
        // B[u] is always initialised by the reset loop — non-null assertion is safe.
        const bSet = B.get(u)!;
        for (const w of [...bSet]) {
            bSet.delete(w);
            if (blocked.get(w)) unblock(w);
        }
    }

    function circuit(v: string, startIdx: number): boolean {
        let found = false;
        stack.push(v);
        blocked.set(v, true);

        // adj is populated for every node in `nodes` — non-null assertion is safe.
        for (const { to: w } of adj.get(v)!) {
            // Only consider nodes in the current subgraph (index >= startIdx).
            const wIdx = nodeIndex.get(w);
            if (wIdx === undefined || wIdx < startIdx) continue;
            // Skip self-loops — handled separately above.
            let edgeFound = false;
            if (w === stack[0]) {
                // Found a cycle. Record it (omit closing back-node — Johnson's convention).
                result.push([...stack]);
                edgeFound = true;
            } else if (!blocked.get(w)) {
                edgeFound = circuit(w, startIdx);
            }
            if (edgeFound) {
                found = true;
            } else {
                // w was not part of a cycle reachable from v via this edge — add to B[w].
                // B[w] is guaranteed to exist: the reset loop at the top of each
                // outer iteration initialises every in-scope node. Non-null assertion
                // is safe by construction.
                // Per Johnson's 1975: B-entry registration is per-edge, not
                // loop-cumulative — each blocked neighbor must be recorded independently.
                B.get(w)!.add(v);
            }
        }

        if (found) {
            unblock(v);
        }

        stack.pop();
        return found;
    }

    for (let i = 0; i < nodes.length; i++) {
        const s = nodes[i]!;
        // Reset blocked/B for nodes in the current subgraph.
        for (let j = i; j < nodes.length; j++) {
            blocked.set(nodes[j]!, false);
            B.set(nodes[j]!, new Set<string>());
        }
        circuit(s, i);
        // Remove s from the subgraph by advancing start index (implicit — we
        // pass `i+1` as startIdx in subsequent iterations).
    }

    return result;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Rotate a cycle so the lexicographically smallest node id is first.
 * This makes A→B→C→A, B→C→A→B, and C→A→B→C all canonical as [A,B,C].
 */
function canonicalise(cycle: string[]): string[] {
    if (cycle.length <= 1) return cycle;
    let minIdx = 0;
    for (let i = 1; i < cycle.length; i++) {
        if (cycle[i]! < cycle[minIdx]!) minIdx = i;
    }
    return [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
}

/**
 * Build `edgeLocations` — one entry per step in the cycle including the closing
 * back-edge. For an n-node cycle [v0, v1, …, vn-1] the steps are:
 *   v0→v1, v1→v2, …, v(n-1)→v0
 */
function buildEdgeLocations(
    cycle: string[],
    adj: Map<string, Array<{ to: string; edge: GraphEdge }>>,
): ImportCycle['edgeLocations'] {
    const locations: ImportCycle['edgeLocations'] = [];
    const n = cycle.length;

    for (let i = 0; i < n; i++) {
        const from = cycle[i]!;
        const to = cycle[(i + 1) % n]!;
        // adj is populated for every node in the cycle — non-null assertion is safe.
        // Policy: when multiple parallel edges share the same (from, to) pair, .find()
        // returns the first match. First-match-wins is intentional: the adjacency list
        // is built in graph.edges insertion order. For determinism under parallel edges
        // callers should ensure a stable edge order (e.g. sorted by file:line).
        const neighbours = adj.get(from);
        const match = neighbours?.find((nb) => nb.to === to);
        if (!match) {
            process.stderr.write(
                `[detectCycles] BUG: missing adjacency for cycle edge ${from} → ${to}; ` +
                `this should be unreachable. Skipping location for this hop.\n`,
            );
        }
        let location: SourceLoc | undefined;
        if (match && match.edge.file != null && match.edge.line != null) {
            location = { file: match.edge.file, line: match.edge.line, column: 0 };
        }
        const entry: { from: string; to: string; location?: SourceLoc } = { from, to };
        if (location !== undefined) entry.location = location;
        locations.push(entry);
    }

    return locations;
}
