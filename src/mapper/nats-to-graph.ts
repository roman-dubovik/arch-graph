import type {
    ArchGraph,
    GraphEdge,
    GraphNode,
    NatsCallSite,
    NatsDiagnostics,
    ResolvedSubject,
} from '../core/types.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import { ownerNodeFor, ownerNodeId } from './owner-node.js';

/** Shape produced by any extractor's mapper — assembleGraph composes these. */
export interface GraphParts {
    nodes: GraphNode[];
    edges: GraphEdge[];
}

export interface MapNatsResult {
    nodes: GraphNode[];
    edges: GraphEdge[];
    diagnostics: Omit<NatsDiagnostics, 'counts'>;
}

/**
 * Maps validated NatsCallSite[] to graph nodes/edges + diagnostics.
 *  - literal/pattern subjects → `nats-subject` node + edge
 *  - dynamic/unresolved subjects → diagnostics only (no node)
 *  - owner apps/ libs/ → `service:` / `lib:`; unknown → diagnostics.unowned
 */
export function mapNatsToGraph(
    callSites: NatsCallSite[],
    ownership: OwnershipRegistry,
): MapNatsResult {
    const ownerNodes = new Map<string, GraphNode>();
    const subjectNodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const unresolved: NatsCallSite[] = [];
    const dynamic: NatsCallSite[] = [];
    const unowned: NatsCallSite[] = [];

    // Seed all services as nodes — even those without NATS edges should appear in the graph.
    for (const s of ownership.services) {
        const id = `service:${s.id}`;
        ownerNodes.set(id, { id, kind: 'service', label: s.id, path: s.rootDir });
    }

    for (const cs of callSites) {
        // Subject kind gates graph emission.
        if (cs.subject.kind === 'unresolved') {
            unresolved.push(cs);
            continue;
        }
        if (cs.subject.kind === 'dynamic') {
            dynamic.push(cs);
            continue;
        }

        const owner = ownership.findOwner(cs.location.file);
        if (owner.kind === 'unknown') {
            unowned.push(cs);
            continue;
        }

        const ownerId = ownerNodeId(owner);
        if (!ownerNodes.has(ownerId)) {
            ownerNodes.set(ownerId, ownerNodeFor(owner));
        }

        const subjectNode = subjectNodeFor(cs.subject);
        if (!subjectNodes.has(subjectNode.id)) {
            subjectNodes.set(subjectNode.id, subjectNode);
        }

        const edge = buildEdge(cs, ownerId, subjectNode.id);
        edges.push(edge);
    }

    const nodes: GraphNode[] = [
        ...ownerNodes.values(),
        ...subjectNodes.values(),
    ];

    return {
        nodes,
        edges,
        diagnostics: { unresolved, dynamic, unowned },
    };
}


function subjectNodeFor(subject: ResolvedSubject): GraphNode {
    if (subject.kind === 'literal') {
        return {
            id: `nats:${subject.value}`,
            kind: 'nats-subject',
            label: subject.value,
        };
    }
    if (subject.kind === 'pattern') {
        return {
            id: `nats:${subject.pattern}`,
            kind: 'nats-subject',
            label: subject.pattern,
            meta: { dynamic: true, placeholders: subject.placeholders },
        };
    }
    // unreachable — caller guards on kind, but keep type-complete
    throw new Error(`subjectNodeFor: unexpected kind ${subject.kind}`);
}

function buildEdge(cs: NatsCallSite, ownerId: string, subjectId: string): GraphEdge {
    const isSender = cs.role === 'sender';
    const from = isSender ? ownerId : subjectId;
    const to = isSender ? subjectId : ownerId;
    const id = `${cs.edgeKind}:${from}->${to}:${cs.location.file}:${cs.location.line}`;

    const edge: GraphEdge = {
        id,
        from,
        to,
        kind: cs.edgeKind,
        file: cs.location.file,
        line: cs.location.line,
        meta: { via: cs.via, ...(cs.enclosingClass !== undefined ? { enclosingClass: cs.enclosingClass } : {}) },
    };
    if (cs.subject.kind === 'pattern') {
        edge.dynamic = true;
        edge.subjectPattern = cs.subject.pattern;
    }
    return edge;
}

// ============================================================================
// Diagnostics builder
// ============================================================================

export function buildNatsDiagnostics(
    callSites: NatsCallSite[],
    result: MapNatsResult,
): NatsDiagnostics {
    const counts = { literal: 0, pattern: 0, dynamic: 0, unresolved: 0 };
    for (const cs of callSites) {
        counts[cs.subject.kind] += 1;
    }
    return {
        unresolved: result.diagnostics.unresolved,
        dynamic: result.diagnostics.dynamic,
        unowned: result.diagnostics.unowned,
        counts,
    };
}

// ============================================================================
// Final assembly
// ============================================================================

export function assembleGraph(root: string, parts: GraphParts[]): ArchGraph {
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();

    for (const part of parts) {
        for (const n of part.nodes) {
            const existing = nodes.get(n.id);
            if (!existing) nodes.set(n.id, n);
            else nodes.set(n.id, mergeNodes(existing, n));
        }
        for (const e of part.edges) {
            edges.set(e.id, e);
        }
    }

    return {
        version: '1.0',
        buildAt: new Date().toISOString(),
        root,
        nodes: [...nodes.values()],
        edges: [...edges.values()],
    };
}

function mergeNodes(a: GraphNode, b: GraphNode): GraphNode {
    return {
        ...a,
        ...b,
        meta: { ...(a.meta ?? {}), ...(b.meta ?? {}) },
    };
}
