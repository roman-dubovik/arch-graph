import type { GraphNode, GraphOwnerRef } from '../core/types.js';

/** Shared owner-node id/builder used by every per-domain mapper. */

export function ownerNodeId(o: GraphOwnerRef): string {
    if (o.kind === 'service') return `service:${o.id}`;
    if (o.kind === 'lib') return `lib:${o.id}`;
    return `unknown:${o.path}`;
}

export function ownerNodeFor(o: GraphOwnerRef): GraphNode {
    if (o.kind === 'service') return { id: `service:${o.id}`, kind: 'service', label: o.id };
    if (o.kind === 'lib') return { id: `lib:${o.id}`, kind: 'lib', label: o.id, path: o.path };
    return { id: `unknown:${o.path}`, kind: 'file', label: o.path, path: o.path };
}
