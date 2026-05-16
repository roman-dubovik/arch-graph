/**
 * Endpoint mapper — placeholder for Variant 2, Task B3.
 *
 * Maps endpoint sites to `endpoint` nodes and `endpoint-of` edges.
 *
 * Implementation: B3 (real mapper with node/edge emission).
 */

import type { GraphNode, GraphEdge, OwnershipRegistry } from '../core/types.js';
import type { EndpointSite } from '../extractors/endpoint/extractor.js';

export interface EndpointMapResult {
    nodes: GraphNode[];
    edges: GraphEdge[];
    diagnostics: Array<{ message: string }>;
}

/**
 * Map endpoint sites to graph nodes and edges.
 *
 * This is a placeholder stub returning empty results. The full implementation
 * will be added in B3.
 */
export function mapEndpointsToGraph(
    _sites: EndpointSite[],
    _ownership: OwnershipRegistry,
): EndpointMapResult {
    return {
        nodes: [],
        edges: [],
        diagnostics: [],
    };
}
