import type { GraphEdge, GraphNode, ResolvedSubject, RmqCallSite, RmqDiagnostics } from '../core/types.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import { ownerNodeFor, ownerNodeId } from './owner-node.js';

export interface MapRmqResult {
    nodes: GraphNode[];
    edges: GraphEdge[];
    diagnostics: Omit<RmqDiagnostics, 'counts'>;
}

export function mapRmqToGraph(callSites: RmqCallSite[], ownership: OwnershipRegistry): MapRmqResult {
    const ownerNodes = new Map<string, GraphNode>();
    const patternNodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const unresolved: RmqCallSite[] = [];
    const dynamic: RmqCallSite[] = [];
    const unowned: RmqCallSite[] = [];

    for (const s of ownership.services) {
        const id = `service:${s.id}`;
        ownerNodes.set(id, { id, kind: 'service', label: s.id, path: s.rootDir });
    }

    for (const cs of callSites) {
        if (cs.pattern.kind === 'unresolved') {
            unresolved.push(cs);
            continue;
        }
        if (cs.pattern.kind === 'dynamic') {
            dynamic.push(cs);
            continue;
        }

        const owner = ownership.findOwner(cs.location.file);
        if (owner.kind === 'unknown') {
            unowned.push(cs);
            continue;
        }

        const ownerId = ownerNodeId(owner);
        if (!ownerNodes.has(ownerId)) ownerNodes.set(ownerId, ownerNodeFor(owner));

        const patternNode = patternNodeFor(cs.pattern);
        if (!patternNodes.has(patternNode.id)) patternNodes.set(patternNode.id, patternNode);

        const id = `rmq-subscribe:${patternNode.id}->${ownerId}:${cs.location.file}:${cs.location.line}`;
        edges.push({
            id,
            from: patternNode.id,
            to: ownerId,
            kind: 'rmq-subscribe',
            file: cs.location.file,
            line: cs.location.line,
            meta: {
                via: cs.via,
                transport: 'rmq',
                ...(cs.enclosingClass !== undefined ? { enclosingClass: cs.enclosingClass } : {}),
            },
            ...(cs.pattern.kind === 'pattern' ? { dynamic: true, subjectPattern: cs.pattern.pattern } : {}),
        });
    }

    return {
        nodes: [...ownerNodes.values(), ...patternNodes.values()],
        edges,
        diagnostics: { unresolved, dynamic, unowned },
    };
}

function patternNodeFor(pattern: ResolvedSubject): GraphNode {
    if (pattern.kind === 'literal') {
        return { id: `rmq:${pattern.value}`, kind: 'rmq-pattern', label: pattern.value };
    }
    if (pattern.kind === 'pattern') {
        return {
            id: `rmq:${pattern.pattern}`,
            kind: 'rmq-pattern',
            label: pattern.pattern,
            meta: { dynamic: true, placeholders: pattern.placeholders },
        };
    }
    throw new Error(`patternNodeFor: unexpected kind ${pattern.kind}`);
}

export function buildRmqDiagnostics(callSites: RmqCallSite[], result: MapRmqResult): RmqDiagnostics {
    const counts = { literal: 0, pattern: 0, dynamic: 0, unresolved: 0 };
    for (const cs of callSites) counts[cs.pattern.kind] += 1;
    return {
        unresolved: result.diagnostics.unresolved,
        dynamic: result.diagnostics.dynamic,
        unowned: result.diagnostics.unowned,
        counts,
    };
}
