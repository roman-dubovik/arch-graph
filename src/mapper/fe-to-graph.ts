/**
 * Maps FE extractor output to graph nodes and edges.
 *
 * Node kinds emitted:
 *   fe-page      — one per FePage (Next.js page/route segment)
 *   fe-component — one per FeComponent
 *   fe-route     — one per FeRoute (unique URL pattern)
 *   fe-hook      — one per FeHook
 *
 * Edge kinds emitted:
 *   fe-imports   — page/component → component (via import declarations)
 *   fe-renders   — component → component (via JSX usage)
 *   fe-routes-to — route → page (url pattern → page node)
 */

import type { GraphEdge, GraphNode } from '../core/types.js';
import type { FeExtractResult } from '../extractors/fe/types.js';
import { OwnershipRegistry } from '../core/service-registry.js';

export interface MapFeResult {
    nodes: GraphNode[];
    edges: GraphEdge[];
    diagnostics: {
        unresolved: Array<{ kind: string; ref: string; reason: string }>;
        unowned: Array<{ kind: string; file: string }>;
    };
}

/**
 * Convert FE extractor output into graph nodes and edges.
 *
 * @param extractorOutput  Result of extractFe().
 * @param ownership        Registry used to find the service/lib owner of each file.
 */
export function mapFeToGraph(
    extractorOutput: FeExtractResult,
    ownership: OwnershipRegistry,
): MapFeResult {
    const nodeMap = new Map<string, GraphNode>();
    const edgeMap = new Map<string, GraphEdge>();
    const unresolved: MapFeResult['diagnostics']['unresolved'] = [];
    const unowned: MapFeResult['diagnostics']['unowned'] = [];

    // -----------------------------------------------------------------------
    // 1. Component nodes  →  fe-component
    // -----------------------------------------------------------------------
    for (const comp of extractorOutput.components) {
        const nodeId = `fe-component:${comp.name}`;
        if (!nodeMap.has(nodeId)) {
            nodeMap.set(nodeId, {
                id: nodeId,
                kind: 'fe-component',
                label: comp.name,
                path: comp.file,
                meta: {
                    componentKind: comp.kind,
                    exported: comp.exported,
                    defaultExport: comp.defaultExport,
                },
            });
        }
    }

    // -----------------------------------------------------------------------
    // 2. Hook nodes  →  fe-hook
    // -----------------------------------------------------------------------
    for (const hook of extractorOutput.hooks) {
        const nodeId = `fe-hook:${hook.name}`;
        if (!nodeMap.has(nodeId)) {
            nodeMap.set(nodeId, {
                id: nodeId,
                kind: 'fe-hook',
                label: hook.name,
                path: hook.file,
            });
        }
    }

    // -----------------------------------------------------------------------
    // 3. Route nodes  →  fe-route
    // -----------------------------------------------------------------------
    for (const route of extractorOutput.routes) {
        const nodeId = `fe-route:${route.pattern}`;
        if (!nodeMap.has(nodeId)) {
            nodeMap.set(nodeId, {
                id: nodeId,
                kind: 'fe-route',
                label: route.pattern,
                meta: { pageFile: route.pageFile },
            });
        }
    }

    // -----------------------------------------------------------------------
    // 4. Page nodes  →  fe-page + fe-routes-to edge
    // -----------------------------------------------------------------------
    for (const page of extractorOutput.pages) {
        const pageNodeId = `fe-page:${page.name}`;
        if (!nodeMap.has(pageNodeId)) {
            nodeMap.set(pageNodeId, {
                id: pageNodeId,
                kind: 'fe-page',
                label: page.name,
                path: page.file,
                meta: { route: page.route, router: page.router },
            });
        }

        // fe-routes-to: route → page
        const routeNodeId = `fe-route:${page.route}`;
        if (nodeMap.has(routeNodeId)) {
            addEdge(edgeMap, {
                id: `fe-routes-to:${routeNodeId}->${pageNodeId}`,
                from: routeNodeId,
                to: pageNodeId,
                kind: 'fe-routes-to',
                file: page.file,
                line: page.location.line,
            });
        }
    }

    // -----------------------------------------------------------------------
    // 5. fe-renders edges: component → component (via JSX)
    // -----------------------------------------------------------------------
    // Build a name→nodeId lookup for components
    const nameToNodeId = new Map<string, string>();
    for (const comp of extractorOutput.components) {
        nameToNodeId.set(comp.name, `fe-component:${comp.name}`);
    }

    for (const render of extractorOutput.renders) {
        const fromId = `fe-component:${render.fromName}`;
        const toId = nameToNodeId.get(render.toName);

        if (!toId) {
            // toName not found in extracted components — could be external/unresolved
            unresolved.push({
                kind: 'fe-renders',
                ref: render.toName,
                reason: 'component-not-found',
            });
            continue;
        }

        addEdge(edgeMap, {
            id: `fe-renders:${fromId}->${toId}`,
            from: fromId,
            to: toId,
            kind: 'fe-renders',
            file: render.fromFile,
            line: render.location.line,
        });
    }

    // -----------------------------------------------------------------------
    // 6. fe-imports edges: page/component → component (via imports)
    //    We only emit an edge when the imported file resolves to a known
    //    component node, and the source is a page or component.
    // -----------------------------------------------------------------------
    // Build a file→[componentNodeId] lookup
    const fileToComponents = new Map<string, string[]>();
    for (const comp of extractorOutput.components) {
        const existing = fileToComponents.get(comp.file) ?? [];
        existing.push(`fe-component:${comp.name}`);
        fileToComponents.set(comp.file, existing);
    }
    for (const page of extractorOutput.pages) {
        const key = page.file;
        if (!fileToComponents.has(key)) fileToComponents.set(key, []);
        const pageNodeId = `fe-page:${page.name}`;
        fileToComponents.get(key)!.push(pageNodeId);
    }

    const importedEdgesAdded = new Set<string>();
    for (const imp of extractorOutput.imports) {
        if (!imp.resolvedFile) continue;

        // Find target components in the resolved file
        const targetNodes = fileToComponents.get(imp.resolvedFile);
        if (!targetNodes || targetNodes.length === 0) continue;

        // Find source nodes (page or component) in the source file
        const sourceNodes = fileToComponents.get(imp.sourceFile);
        if (!sourceNodes || sourceNodes.length === 0) continue;

        for (const fromId of sourceNodes) {
            for (const toId of targetNodes) {
                if (fromId === toId) continue;
                const edgeId = `fe-imports:${fromId}->${toId}`;
                if (importedEdgesAdded.has(edgeId)) continue;
                importedEdgesAdded.add(edgeId);
                addEdge(edgeMap, {
                    id: edgeId,
                    from: fromId,
                    to: toId,
                    kind: 'fe-imports',
                    file: imp.sourceFile,
                    line: imp.location.line,
                });
            }
        }
    }

    // -----------------------------------------------------------------------
    // 7. Ownership check (unowned nodes)
    // -----------------------------------------------------------------------
    for (const comp of extractorOutput.components) {
        const owner = ownership.findOwner(comp.file);
        if (owner.kind === 'unknown') {
            unowned.push({ kind: 'fe-component', file: comp.file });
        }
    }
    for (const page of extractorOutput.pages) {
        const owner = ownership.findOwner(page.file);
        if (owner.kind === 'unknown') {
            unowned.push({ kind: 'fe-page', file: page.file });
        }
    }

    return {
        nodes: [...nodeMap.values()],
        edges: [...edgeMap.values()],
        diagnostics: { unresolved, unowned },
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addEdge(map: Map<string, GraphEdge>, edge: GraphEdge): void {
    if (!map.has(edge.id)) {
        map.set(edge.id, edge);
    }
}
