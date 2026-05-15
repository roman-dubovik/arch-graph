/**
 * Pure graph-query helpers used by the MCP server tool handlers.
 *
 * All functions are total — they return empty arrays / `null` when nothing matches,
 * never throw. Input normalisation (bare name vs `prefix:name`) is the caller's
 * concern in `server.ts`, but the helpers also accept either form transparently
 * for subject/queue/table lookups by going through `subjectMatches` / equality.
 */

import type { ArchGraph, EdgeKind, GraphEdge, GraphNode } from '../core/types.js';
import { subjectMatches } from './wildcards.js';

// ---------------------------------------------------------------------------
// ID normalisation
// ---------------------------------------------------------------------------

/** Strip a known graph prefix (`service:`, `nats:`, `db-table:`, `queue:`, `module:`, `provider:`, `lib:`, `external:`). */
const PREFIX_RE = /^(service|nats|db-table|queue|module|provider|lib|external|file):/;

export function stripPrefix(id: string): string {
    return id.replace(PREFIX_RE, '');
}

export function withPrefix(prefix: string, idOrName: string): string {
    return idOrName.startsWith(`${prefix}:`) ? idOrName : `${prefix}:${idOrName}`;
}

// ---------------------------------------------------------------------------
// Subject queries
// ---------------------------------------------------------------------------

/** All `nats-subject` nodes whose bare name matches `subject` (wildcards on either side). */
export function findMatchingSubjectNodes(graph: ArchGraph, subject: string): GraphNode[] {
    const bare = stripPrefix(subject);
    return graph.nodes.filter(
        (n) => n.kind === 'nats-subject' && subjectMatches(bare, stripPrefix(n.id)),
    );
}

/** Owners (services + libs) of NATS sender edges into `subject`. */
export function findPublishers(graph: ArchGraph, subject: string): EdgeAnswer[] {
    const subjectIds = new Set(findMatchingSubjectNodes(graph, subject).map((n) => n.id));
    if (subjectIds.size === 0) return [];
    const out: EdgeAnswer[] = [];
    for (const e of graph.edges) {
        if (e.kind !== 'nats-publish' && e.kind !== 'nats-request') continue;
        if (!subjectIds.has(e.to)) continue;
        out.push(edgeAnswer(e, e.from, e.to));
    }
    return sortByOwnerAndLocation(out);
}

/** Owners of NATS receiver edges from `subject` (subscribe / reply). */
export function findSubscribers(graph: ArchGraph, subject: string): EdgeAnswer[] {
    const subjectIds = new Set(findMatchingSubjectNodes(graph, subject).map((n) => n.id));
    if (subjectIds.size === 0) return [];
    const out: EdgeAnswer[] = [];
    for (const e of graph.edges) {
        if (e.kind !== 'nats-subscribe' && e.kind !== 'nats-reply') continue;
        if (!subjectIds.has(e.from)) continue;
        out.push(edgeAnswer(e, e.to, e.from));
    }
    return sortByOwnerAndLocation(out);
}

// ---------------------------------------------------------------------------
// Queue queries
// ---------------------------------------------------------------------------

export function findQueueProducers(graph: ArchGraph, queue: string): EdgeAnswer[] {
    const id = withPrefix('queue', queue);
    return graph.edges
        .filter((e) => e.kind === 'queue-produce' && e.to === id)
        .map((e) => edgeAnswer(e, e.from, e.to));
}

export function findQueueConsumers(graph: ArchGraph, queue: string): EdgeAnswer[] {
    const id = withPrefix('queue', queue);
    return graph.edges
        .filter((e) => e.kind === 'queue-consume' && e.from === id)
        .map((e) => edgeAnswer(e, e.to, e.from));
}

// ---------------------------------------------------------------------------
// Service dependency queries
// ---------------------------------------------------------------------------

/** Outgoing edges from `service:<id>`, grouped by kind family. */
export function serviceDependencies(graph: ArchGraph, serviceId: string): GroupedDeps {
    const id = withPrefix('service', serviceId);
    if (!graph.nodes.some((n) => n.id === id)) return emptyGroupedDeps();
    return groupOutgoing(graph, id);
}

/** Incoming edges into `service:<id>`, grouped by kind. */
export function serviceDependents(graph: ArchGraph, serviceId: string): GroupedDeps {
    const id = withPrefix('service', serviceId);
    if (!graph.nodes.some((n) => n.id === id)) return emptyGroupedDeps();
    return groupIncoming(graph, id);
}

// ---------------------------------------------------------------------------
// DI module imports (recursive)
// ---------------------------------------------------------------------------

export interface ModuleImportChain {
    module: string;
    imports: string[];
    children: ModuleImportChain[];
}

const DEFAULT_MAX_DEPTH = 5;

/**
 * Walk `di-import` edges starting from `module:<moduleClass>`, depth-limited.
 * Re-visited modules appear with an empty `children` array to break cycles.
 */
export function moduleImports(
    graph: ArchGraph,
    moduleClass: string,
    maxDepth: number = DEFAULT_MAX_DEPTH,
): ModuleImportChain | null {
    const startId = withPrefix('module', moduleClass);
    if (!graph.nodes.some((n) => n.id === startId)) return null;
    const seen = new Set<string>();
    return walk(graph, startId, maxDepth, seen);
}

function walk(
    graph: ArchGraph,
    nodeId: string,
    depthLeft: number,
    seen: Set<string>,
): ModuleImportChain {
    const bare = stripPrefix(nodeId);
    if (depthLeft <= 0 || seen.has(nodeId)) {
        return { module: bare, imports: [], children: [] };
    }
    seen.add(nodeId);
    const importEdges = graph.edges.filter((e) => e.kind === 'di-import' && e.from === nodeId);
    const importIds = importEdges.map((e) => e.to);
    const children = importIds.map((id) => walk(graph, id, depthLeft - 1, seen));
    return { module: bare, imports: importIds.map(stripPrefix), children };
}

// ---------------------------------------------------------------------------
// Table users
// ---------------------------------------------------------------------------

export function tableUsers(graph: ArchGraph, table: string): EdgeAnswer[] {
    const id = withPrefix('db-table', table);
    return graph.edges
        .filter((e) => e.to === id && e.kind.startsWith('db-'))
        .map((e) => edgeAnswer(e, e.from, e.to));
}

// ---------------------------------------------------------------------------
// Path (BFS)
// ---------------------------------------------------------------------------

export type PathResult =
    | { found: false }
    | { found: true; nodes: string[]; edges: Array<{ from: string; to: string; kind: EdgeKind }> };

/**
 * Shortest directed path from `from` to `to`, optionally restricted to the
 * given edge kinds. Returns `{ found: false }` when either node is missing
 * or no path exists under the filter.
 */
export function findPath(
    graph: ArchGraph,
    from: string,
    to: string,
    kindFilter?: EdgeKind[],
): PathResult {
    if (!graph.nodes.some((n) => n.id === from) || !graph.nodes.some((n) => n.id === to)) {
        return { found: false };
    }
    if (from === to) {
        return { found: true, nodes: [from], edges: [] };
    }
    const allowed = kindFilter && kindFilter.length > 0 ? new Set(kindFilter) : null;
    const adj = new Map<string, GraphEdge[]>();
    for (const e of graph.edges) {
        if (allowed && !allowed.has(e.kind)) continue;
        let bucket = adj.get(e.from);
        if (!bucket) {
            bucket = [];
            adj.set(e.from, bucket);
        }
        bucket.push(e);
    }
    const parent = new Map<string, { prev: string; edge: GraphEdge }>();
    const queue: string[] = [from];
    const visited = new Set<string>([from]);
    while (queue.length > 0) {
        const cur = queue.shift()!;
        const outs = adj.get(cur);
        if (!outs) continue;
        for (const e of outs) {
            if (visited.has(e.to)) continue;
            visited.add(e.to);
            parent.set(e.to, { prev: cur, edge: e });
            if (e.to === to) {
                return reconstructPath(parent, from, to);
            }
            queue.push(e.to);
        }
    }
    return { found: false };
}

function reconstructPath(
    parent: Map<string, { prev: string; edge: GraphEdge }>,
    from: string,
    to: string,
): PathResult {
    const nodes: string[] = [to];
    const edges: Array<{ from: string; to: string; kind: EdgeKind }> = [];
    let cur = to;
    while (cur !== from) {
        const step = parent.get(cur);
        if (!step) return { found: false };
        nodes.push(step.prev);
        edges.push({ from: step.edge.from, to: step.edge.to, kind: step.edge.kind });
        cur = step.prev;
    }
    nodes.reverse();
    edges.reverse();
    return { found: true, nodes, edges };
}

// ---------------------------------------------------------------------------
// Explain
// ---------------------------------------------------------------------------

export interface ExplainResult {
    node: GraphNode;
    incoming: Record<string, Array<{ from: string; kind: EdgeKind }>>;
    outgoing: Record<string, Array<{ to: string; kind: EdgeKind }>>;
}

export function explain(graph: ArchGraph, nodeId: string): ExplainResult | null {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    const incoming: Record<string, Array<{ from: string; kind: EdgeKind }>> = {};
    const outgoing: Record<string, Array<{ to: string; kind: EdgeKind }>> = {};
    for (const e of graph.edges) {
        if (e.to === nodeId) {
            (incoming[e.kind] ??= []).push({ from: e.from, kind: e.kind });
        }
        if (e.from === nodeId) {
            (outgoing[e.kind] ??= []).push({ to: e.to, kind: e.kind });
        }
    }
    return { node, incoming, outgoing };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface GraphStats {
    version: string;
    root: string;
    buildAt: string;
    nodes: Record<string, number>;
    edges: Record<string, number>;
    totals: { nodes: number; edges: number };
}

export function graphStats(graph: ArchGraph): GraphStats {
    const nodes: Record<string, number> = {};
    for (const n of graph.nodes) nodes[n.kind] = (nodes[n.kind] ?? 0) + 1;
    const edges: Record<string, number> = {};
    for (const e of graph.edges) edges[e.kind] = (edges[e.kind] ?? 0) + 1;
    return {
        version: graph.version,
        root: graph.root,
        buildAt: graph.buildAt,
        nodes,
        edges,
        totals: { nodes: graph.nodes.length, edges: graph.edges.length },
    };
}

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

export interface EdgeAnswer {
    owner: string;
    counterpart: string;
    kind: EdgeKind;
    file?: string;
    line?: number;
    subjectPattern?: string;
    dynamic?: boolean;
}

export interface GroupedDeps {
    /** Existence flag: `true` when the node was found, `false` for unknown IDs. */
    found: boolean;
    counts: Record<string, number>;
    byKind: Record<string, Array<{ counterpart: string; kind: EdgeKind; file?: string; line?: number }>>;
}

function emptyGroupedDeps(): GroupedDeps {
    return { found: false, counts: {}, byKind: {} };
}

function groupOutgoing(graph: ArchGraph, nodeId: string): GroupedDeps {
    const byKind: GroupedDeps['byKind'] = {};
    const counts: Record<string, number> = {};
    for (const e of graph.edges) {
        if (e.from !== nodeId) continue;
        (byKind[e.kind] ??= []).push({ counterpart: e.to, kind: e.kind, file: e.file, line: e.line });
        counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    }
    return { found: true, counts, byKind };
}

function groupIncoming(graph: ArchGraph, nodeId: string): GroupedDeps {
    const byKind: GroupedDeps['byKind'] = {};
    const counts: Record<string, number> = {};
    for (const e of graph.edges) {
        if (e.to !== nodeId) continue;
        (byKind[e.kind] ??= []).push({ counterpart: e.from, kind: e.kind, file: e.file, line: e.line });
        counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    }
    return { found: true, counts, byKind };
}

function edgeAnswer(edge: GraphEdge, owner: string, counterpart: string): EdgeAnswer {
    const out: EdgeAnswer = { owner, counterpart, kind: edge.kind };
    if (edge.file !== undefined) out.file = edge.file;
    if (edge.line !== undefined) out.line = edge.line;
    if (edge.subjectPattern !== undefined) out.subjectPattern = edge.subjectPattern;
    if (edge.dynamic !== undefined) out.dynamic = edge.dynamic;
    return out;
}

function sortByOwnerAndLocation(answers: EdgeAnswer[]): EdgeAnswer[] {
    // Keep all rows — each call site is informative — but stable order: owner, then file:line.
    return answers.slice().sort((a, b) => {
        if (a.owner !== b.owner) return a.owner < b.owner ? -1 : 1;
        const af = `${a.file ?? ''}:${a.line ?? 0}`;
        const bf = `${b.file ?? ''}:${b.line ?? 0}`;
        return af < bf ? -1 : af > bf ? 1 : 0;
    });
}
