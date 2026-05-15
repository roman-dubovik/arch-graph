import type {
    BullMqDiagnostics,
    BullMqInjectionSite,
    BullMqProcessorSite,
    BullMqQueueRegistration,
    GraphEdge,
    GraphNode,
    GraphOwnerRef,
} from '../core/types.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import { ownerNodeFor, ownerNodeId } from './owner-node.js';

export interface MapBullMqResult {
    nodes: GraphNode[];
    edges: GraphEdge[];
    diagnostics: BullMqDiagnostics;
}

/**
 * Maps BullMQ sites to graph nodes/edges:
 *   - resolved producer  → `queue-produce` edge (owner → queue)
 *   - resolved consumer  → `queue-consume` edge (owner ← queue)
 *   - registration       → metadata on `queue:<name>` node (where the queue is declared)
 *   - unresolved/unowned → diagnostics only (no graph entry)
 *
 * One edge per (owner, queue, kind); first-seen site location wins.
 */
export function mapBullMqToGraph(
    producers: BullMqInjectionSite[],
    consumers: BullMqProcessorSite[],
    registrations: BullMqQueueRegistration[],
    ownership: OwnershipRegistry,
): MapBullMqResult {
    const ownerNodes = new Map<string, GraphNode>();
    const queueNodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const unresolved: BullMqDiagnostics['unresolved'] = [];
    const unowned: BullMqDiagnostics['unowned'] = [];

    for (const reg of registrations) {
        if (reg.queue.kind === 'unresolved') {
            unresolved.push(reg);
            continue;
        }
        const queueId = `queue:${reg.queue.name}`;
        const existing = queueNodes.get(queueId);
        const decl = `${reg.location.file}:${reg.location.line}`;
        if (!existing) {
            queueNodes.set(queueId, {
                id: queueId,
                kind: 'queue',
                label: reg.queue.name,
                meta: { declaredAt: [decl], api: reg.api },
            });
        } else {
            const decls = ((existing.meta?.declaredAt as string[] | undefined) ?? []).slice();
            decls.push(decl);
            existing.meta = { ...(existing.meta ?? {}), declaredAt: decls };
        }
    }

    for (const p of producers) {
        if (p.queue.kind === 'unresolved') {
            unresolved.push(p);
            continue;
        }
        const owner = ownership.findOwner(p.location.file);
        if (owner.kind === 'unknown') {
            unowned.push(p);
            continue;
        }
        const ownerId = ensureOwner(ownerNodes, owner);
        const queueId = ensureQueue(queueNodes, p.queue.name);
        const key = `queue-produce:${ownerId}->${queueId}`;
        if (!edges.has(key)) {
            edges.set(key, {
                id: key,
                from: ownerId,
                to: queueId,
                kind: 'queue-produce',
                file: p.location.file,
                line: p.location.line,
                meta: {
                    propertyName: p.propertyName,
                    queueRef: p.queue.kind,
                    ...(p.enclosingClass !== undefined ? { enclosingClass: p.enclosingClass } : {}),
                },
            });
        }
    }

    for (const c of consumers) {
        if (c.queue.kind === 'unresolved') {
            unresolved.push(c);
            continue;
        }
        const owner = ownership.findOwner(c.location.file);
        if (owner.kind === 'unknown') {
            unowned.push(c);
            continue;
        }
        const ownerId = ensureOwner(ownerNodes, owner);
        const queueId = ensureQueue(queueNodes, c.queue.name);
        const key = `queue-consume:${queueId}->${ownerId}`;
        if (!edges.has(key)) {
            edges.set(key, {
                id: key,
                from: queueId,
                to: ownerId,
                kind: 'queue-consume',
                file: c.location.file,
                line: c.location.line,
                meta: {
                    processorClass: c.className,
                    queueRef: c.queue.kind,
                },
            });
        }
    }

    return {
        nodes: [...ownerNodes.values(), ...queueNodes.values()],
        edges: [...edges.values()],
        diagnostics: {
            unresolved,
            unowned,
            counts: {
                producers: producers.length,
                consumers: consumers.length,
                registrations: registrations.length,
                unresolved: unresolved.length,
                unowned: unowned.length,
            },
        },
    };
}

function ensureOwner(nodes: Map<string, GraphNode>, owner: GraphOwnerRef): string {
    const id = ownerNodeId(owner);
    if (!nodes.has(id)) nodes.set(id, ownerNodeFor(owner));
    return id;
}

function ensureQueue(nodes: Map<string, GraphNode>, name: string): string {
    const id = `queue:${name}`;
    if (!nodes.has(id)) {
        nodes.set(id, { id, kind: 'queue', label: name });
    }
    return id;
}

