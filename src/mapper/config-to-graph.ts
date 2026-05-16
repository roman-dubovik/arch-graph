/**
 * Config-field mapper — placeholder for Variant 2, Task B7.
 *
 * Maps config-field callsites to `config-field` nodes and `config-read-by` edges.
 *
 * Implementation: B7 (real mapper with node/edge emission).
 */

import type { GraphNode, GraphEdge, OwnershipRegistry } from '../core/types.js';
import type { ConfigFieldSite } from '../extractors/config/extractor.js';

export interface ConfigMapResult {
    nodes: GraphNode[];
    edges: GraphEdge[];
    diagnostics: Array<{ message: string }>;
}

/**
 * Map config-field callsites to graph nodes and edges.
 *
 * This is a placeholder stub returning empty results. The full implementation
 * will be added in B7.
 */
export function mapConfigToGraph(
    _sites: ConfigFieldSite[],
    _ownership: OwnershipRegistry,
): ConfigMapResult {
    return {
        nodes: [],
        edges: [],
        diagnostics: [],
    };
}
