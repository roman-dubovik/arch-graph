/**
 * Endpoint mapper — Variant 2, Task B3.
 *
 * Maps endpoint sites to `endpoint` nodes and `endpoint-of` edges.
 * Node id: `endpoint:METHOD /pattern` (e.g. `endpoint:GET /users/:id`)
 * Edge: `endpoint-of` from endpoint node → controller owner node (service or lib).
 */

import type { GraphEdge, GraphNode } from '../core/types.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import type { EndpointSite } from '../extractors/endpoint/extractor.js';
import { ownerNodeFor, ownerNodeId } from './owner-node.js';
import { buildClassMemberAnchor } from './anchor.js';

export interface EndpointMapResult {
    nodes: GraphNode[];
    edges: GraphEdge[];
    diagnostics: Array<{ message: string }>;
}

/**
 * Map endpoint sites to graph nodes and edges.
 *
 * Each endpoint becomes: `endpoint:METHOD /pattern` node.
 * An `endpoint-of` edge links the endpoint node to the owning service/lib node.
 * Duplicate (method, pattern) pairs are deduplicated — first-seen wins.
 */
export function mapEndpointsToGraph(
    sites: EndpointSite[],
    ownership: OwnershipRegistry,
): EndpointMapResult {
    const endpointNodes = new Map<string, GraphNode>();
    const ownerNodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const diagnostics: Array<{ message: string }> = [];

    for (const site of sites) {
        const nodeId = `endpoint:${site.method} ${site.pattern}`;

        if (!endpointNodes.has(nodeId)) {
            const anchor = buildClassMemberAnchor(site.controllerClass, site.methodName, nodeId);
            endpointNodes.set(nodeId, {
                id: nodeId,
                kind: 'endpoint',
                label: `${site.method} ${site.pattern}`,
                path: site.location.file,
                anchor,
                meta: {
                    controllerClass: site.controllerClass,
                    methodName: site.methodName,
                    ...(site.meta ?? {}),
                },
            });
        }

        // Owner resolution — find the service/lib that owns this file
        const owner = ownership.findOwner(site.location.file);
        if (owner.kind === 'unknown') {
            diagnostics.push({
                message: `endpoint ${nodeId} in unowned file ${site.location.file}`,
            });
            // Still emit the node, skip the edge
            continue;
        }

        const ownerId = ownerNodeId(owner);
        if (!ownerNodes.has(ownerId)) {
            ownerNodes.set(ownerId, ownerNodeFor(owner));
        }

        // endpoint-of: endpoint → owning service/lib (first-seen wins per unique pair)
        const edgeId = `endpoint-of:${nodeId}->${ownerId}`;
        if (!edges.has(edgeId)) {
            edges.set(edgeId, {
                id: edgeId,
                from: nodeId,
                to: ownerId,
                kind: 'endpoint-of',
                file: site.location.file,
                line: site.location.line,
                meta: {
                    controllerClass: site.controllerClass,
                    methodName: site.methodName,
                },
            });
        }
    }

    return {
        nodes: [...endpointNodes.values(), ...ownerNodes.values()],
        edges: [...edges.values()],
        diagnostics,
    };
}
