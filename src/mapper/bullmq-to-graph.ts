import type {
    BullMqCatchBlockAddSite,
    BullMqDiagnostics,
    BullMqEventListenerSite,
    BullMqInjectionSite,
    BullMqProcessorSite,
    BullMqQueueRegistration,
    BullMqRepeatAddSite,
    GraphEdge,
    GraphNode,
    GraphOwnerRef,
    SourceLoc,
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
 *   - resolved producer        → `queue-produce` edge (owner → queue)
 *   - resolved consumer        → `queue-consume` edge (owner ← queue)
 *   - registration             → metadata on `queue:<name>` node (where the queue is declared)
 *   - repeat-add sites         → sets `hasRepeat: true` on queue node meta
 *   - event-listener sites     → `queue-event-listener` edge (owner → queue), self-loops dropped
 *   - catch-block-add sites    → `queue-fails-into` edge (queue:A → queue:B), heuristic
 *   - registration.failOver    → `queue-fails-into` edge (MUST-detect case)
 *   - unresolved/unowned       → diagnostics only (no graph entry)
 *
 * One edge per (owner, queue, kind); first-seen site location wins.
 */
export function mapBullMqToGraph(
    producers: BullMqInjectionSite[],
    consumers: BullMqProcessorSite[],
    registrations: BullMqQueueRegistration[],
    ownership: OwnershipRegistry,
    repeatAddSites: BullMqRepeatAddSite[] = [],
    eventListenerSites: BullMqEventListenerSite[] = [],
    catchBlockAddSites: BullMqCatchBlockAddSite[] = [],
    unresolvedFailOver: Array<{ location: SourceLoc; raw: string }> = [],
    unresolvedEventListeners: Array<{ location: SourceLoc; receiverText: string; event: string }> = [],
): MapBullMqResult {
    const ownerNodes = new Map<string, GraphNode>();
    const queueNodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const unresolved: BullMqDiagnostics['unresolved'] = [];
    const unowned: BullMqDiagnostics['unowned'] = [];

    // Track which registration owner owns each queue (for self-loop detection)
    // queueName → set of ownerIds
    const queueRegistrationOwners = new Map<string, Set<string>>();

    for (const reg of registrations) {
        if (reg.queue.kind === 'unresolved') {
            unresolved.push(reg);
            continue;
        }
        const queueName = reg.queue.name;
        const queueId = `queue:${queueName}`;
        const existing = queueNodes.get(queueId);
        const decl = `${reg.location.file}:${reg.location.line}`;

        // Determine registration owner (for self-loop detection)
        const regOwner = ownership.findOwner(reg.location.file);
        const regOwnerId = regOwner.kind !== 'unknown' ? ownerNodeId(regOwner) : null;
        if (regOwnerId !== null) {
            const owners = queueRegistrationOwners.get(queueName) ?? new Set<string>();
            owners.add(regOwnerId);
            queueRegistrationOwners.set(queueName, owners);
        }

        if (!existing) {
            queueNodes.set(queueId, {
                id: queueId,
                kind: 'queue',
                label: queueName,
                meta: buildQueueMeta(reg, [decl]),
            });
        } else {
            const decls = ((existing.meta?.declaredAt as string[] | undefined) ?? []).slice();
            decls.push(decl);
            // Merge meta: keep first-seen values for numeric fields, OR them for booleans
            const merged = mergeQueueMeta(existing.meta ?? {}, reg, decls);
            existing.meta = merged;
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

    // -------------------------------------------------------------------------
    // Apply hasRepeat from repeat-add sites
    // -------------------------------------------------------------------------
    for (const r of repeatAddSites) {
        const queueId = `queue:${r.queueName}`;
        const node = queueNodes.get(queueId) ?? ensureQueueNode(queueNodes, r.queueName);
        node.meta = { ...(node.meta ?? {}), hasRepeat: true };
    }

    // -------------------------------------------------------------------------
    // queue-fails-into edges from registration.failOver (MUST case)
    // -------------------------------------------------------------------------
    for (const reg of registrations) {
        if (reg.queue.kind === 'unresolved') continue;
        if (!reg.failOverTarget) continue;
        const fromId = ensureQueue(queueNodes, reg.queue.name);
        const toId = ensureQueue(queueNodes, reg.failOverTarget);
        const key = `queue-fails-into:${fromId}->${toId}`;
        if (!edges.has(key)) {
            edges.set(key, {
                id: key,
                from: fromId,
                to: toId,
                kind: 'queue-fails-into',
                file: reg.location.file,
                line: reg.location.line,
                meta: { source: 'registerQueue.failOver' },
            });
        }
    }

    // -------------------------------------------------------------------------
    // queue-fails-into edges from catch-block .add() (MAY / heuristic case)
    // -------------------------------------------------------------------------
    for (const site of catchBlockAddSites) {
        const fromId = ensureQueue(queueNodes, site.processorQueueName);
        const toId = ensureQueue(queueNodes, site.dlqName);
        const key = `queue-fails-into:${fromId}->${toId}`;
        if (!edges.has(key)) {
            edges.set(key, {
                id: key,
                from: fromId,
                to: toId,
                kind: 'queue-fails-into',
                file: site.location.file,
                line: site.location.line,
                meta: { source: 'catch-block-add', heuristic: true },
            });
        }
    }

    // -------------------------------------------------------------------------
    // queue-event-listener edges, with self-loop skip
    // -------------------------------------------------------------------------
    for (const site of eventListenerSites) {
        const owner = ownership.findOwner(site.file);
        if (owner.kind === 'unknown') {
            // unowned — emit to diagnostics (already in unresolvedEventListeners if needed)
            continue;
        }
        const ownerId = ownerNodeId(owner);

        // Self-loop check: skip if the owner is the same as the registration owner of the queue
        const regOwners = queueRegistrationOwners.get(site.queueName);
        if (regOwners !== undefined && regOwners.has(ownerId)) {
            continue; // self-loop — drop silently
        }

        const ensuredOwnerId = ensureOwner(ownerNodes, owner);
        const queueId = ensureQueue(queueNodes, site.queueName);
        const key = `queue-event-listener:${ensuredOwnerId}->${queueId}:${site.event}`;
        if (!edges.has(key)) {
            edges.set(key, {
                id: key,
                from: ensuredOwnerId,
                to: queueId,
                kind: 'queue-event-listener',
                file: site.file,
                line: site.location.line,
                meta: {
                    event: site.event,
                    listenerSite: `${site.file}:${site.location.line}`,
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
            ...(unresolvedFailOver.length > 0 ? { unresolvedFailOver } : {}),
            ...(unresolvedEventListeners.length > 0 ? { unresolvedEventListeners } : {}),
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

// ---------------------------------------------------------------------------
// Queue meta helpers
// ---------------------------------------------------------------------------

function buildQueueMeta(reg: BullMqQueueRegistration, declaredAt: string[]): Record<string, unknown> {
    const meta: Record<string, unknown> = {
        declaredAt,
        api: reg.api,
    };
    if (reg.concurrency !== undefined) meta['concurrency'] = reg.concurrency;
    if (reg.defaultDelay !== undefined) meta['defaultDelay'] = reg.defaultDelay;
    if (reg.defaultAttempts !== undefined) meta['defaultAttempts'] = reg.defaultAttempts;
    if (reg.defaultBackoff !== undefined) meta['defaultBackoff'] = reg.defaultBackoff;
    if (reg.hasDefaultRepeat) meta['hasRepeat'] = true;
    return meta;
}

function mergeQueueMeta(
    existing: Record<string, unknown>,
    reg: BullMqQueueRegistration,
    declaredAt: string[],
): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...existing, declaredAt };
    // Boolean fields: OR (once set, stays true)
    if (reg.hasDefaultRepeat) merged['hasRepeat'] = true;
    // Numeric fields: keep first-seen (do not overwrite)
    if (merged['concurrency'] === undefined && reg.concurrency !== undefined) merged['concurrency'] = reg.concurrency;
    if (merged['defaultDelay'] === undefined && reg.defaultDelay !== undefined) merged['defaultDelay'] = reg.defaultDelay;
    if (merged['defaultAttempts'] === undefined && reg.defaultAttempts !== undefined) merged['defaultAttempts'] = reg.defaultAttempts;
    if (merged['defaultBackoff'] === undefined && reg.defaultBackoff !== undefined) merged['defaultBackoff'] = reg.defaultBackoff;
    return merged;
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

function ensureOwner(nodes: Map<string, GraphNode>, owner: GraphOwnerRef): string {
    const id = ownerNodeId(owner);
    if (!nodes.has(id)) nodes.set(id, ownerNodeFor(owner));
    return id;
}

function ensureQueue(nodes: Map<string, GraphNode>, name: string): string {
    const id = `queue:${name}`;
    ensureQueueNode(nodes, name);
    return id;
}

function ensureQueueNode(nodes: Map<string, GraphNode>, name: string): GraphNode {
    const id = `queue:${name}`;
    if (!nodes.has(id)) {
        nodes.set(id, { id, kind: 'queue', label: name });
    }
    return nodes.get(id)!;
}
