/**
 * Config-field mapper — Variant 2, Task B7.
 *
 * Maps config-field callsites to `config-field` nodes and `config-read-by` edges.
 *
 * Node id: `config-field:<KEY>` (one node per unique key, deduped)
 * Edge: `config-read-by` from config-field node → consumer service/lib node
 * Edge id: `config-read-by:config-field:<KEY>-><serviceId>` (one edge per key×consumer)
 */

import type { GraphEdge, GraphNode } from '../core/types.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import type { ConfigFieldSite } from '../extractors/config/extractor.js';
import { ownerNodeFor, ownerNodeId } from './owner-node.js';

export interface ConfigMapResult {
    nodes: GraphNode[];
    edges: GraphEdge[];
    diagnostics: Array<{ message: string }>;
}

/**
 * Map config-field callsites to graph nodes and edges.
 */
export function mapConfigToGraph(
    sites: ConfigFieldSite[],
    ownership: OwnershipRegistry,
): ConfigMapResult {
    const configNodes = new Map<string, GraphNode>();
    const ownerNodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const diagnostics: Array<{ message: string }> = [];

    for (const site of sites) {
        const configNodeId = `config-field:${site.key}`;

        // Create or update config-field node (one per unique key).
        // path = first-seen callsite file; anchor = key (for snippet extraction).
        if (!configNodes.has(configNodeId)) {
            configNodes.set(configNodeId, {
                id: configNodeId,
                kind: 'config-field',
                label: site.key,
                path: site.location.file,
                anchor: site.key,
                meta: {
                    source: site.source,
                    firstLine: site.location.line,
                    ...(site.consumerClass ? { consumerClass: site.consumerClass } : {}),
                },
            });
        }

        // Owner resolution
        const owner = ownership.findOwner(site.location.file);
        if (owner.kind === 'unknown') {
            diagnostics.push({
                message: `config-field ${site.key} in unowned file ${site.location.file}`,
            });
            // Still emit the config node, skip the edge
            continue;
        }

        const ownerId = ownerNodeId(owner);
        if (!ownerNodes.has(ownerId)) {
            ownerNodes.set(ownerId, ownerNodeFor(owner));
        }

        // config-read-by: config-field → consumer (one edge per key×owner pair)
        const edgeId = `config-read-by:${configNodeId}->${ownerId}`;
        if (!edges.has(edgeId)) {
            edges.set(edgeId, {
                id: edgeId,
                from: configNodeId,
                to: ownerId,
                kind: 'config-read-by',
                file: site.location.file,
                line: site.location.line,
                meta: {
                    source: site.source,
                    ...(site.consumerClass ? { consumerClass: site.consumerClass } : {}),
                    consumerContext: site.consumerContext,
                },
            });
        }
    }

    return {
        nodes: [...configNodes.values(), ...ownerNodes.values()],
        edges: [...edges.values()],
        diagnostics,
    };
}
