/**
 * Maps FE extractor output to graph nodes and edges.
 *
 * Node kinds emitted:
 *   fe-page      — one per FePage (Next.js page/route segment)
 *   fe-component — one per FeComponent (file-qualified to avoid cross-file collisions)
 *   fe-route     — one per FeRoute (unique URL pattern)
 *   fe-hook      — one per FeHook (file-qualified)
 *
 * Edge kinds emitted:
 *   fe-imports   — page/component → component (via import declarations)
 *   fe-renders   — component → component (via JSX usage)
 *   fe-routes-to — route → page (url pattern → page node)
 */

import type { GraphEdge, GraphNode } from '../core/types.js';
import type { FeExtractResult } from '../extractors/fe/types.js';
import { OwnershipRegistry } from '../core/service-registry.js';

/** Kind literals for unresolved FE references. */
export type FeUnresolvedKind = 'fe-imports' | 'fe-renders';

/** Kind literals for unowned FE nodes. */
export type FeUnownedKind = 'fe-component' | 'fe-page' | 'fe-hook' | 'fe-route';

export interface FeDiagnostics {
    unresolved: Array<{ kind: FeUnresolvedKind; ref: string; reason: string }>;
    unowned: Array<{ kind: FeUnownedKind; file: string }>;
    counts: {
        unresolvedImports: number;
        unresolvedRenders: number;
        unowned: number;
    };
}

export interface MapFeResult {
    nodes: GraphNode[];
    edges: GraphEdge[];
    diagnostics: FeDiagnostics;
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
    const unresolved: FeDiagnostics['unresolved'] = [];
    const unowned: FeDiagnostics['unowned'] = [];

    // Carry over unresolved imports from extractor (P0-5)
    for (const u of extractorOutput.unresolvedImports) {
        unresolved.push({
            kind: 'fe-imports' as FeUnresolvedKind,
            ref: u.specifier,
            reason: u.error,
        });
    }

    // -----------------------------------------------------------------------
    // 1. Component nodes  →  fe-component (file-qualified IDs, P1-2)
    // -----------------------------------------------------------------------
    for (const comp of extractorOutput.components) {
        const nodeId = `fe-component:${comp.file}#${comp.name}`;
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
                    // AC-B5: propagate i18n strings to GraphNode.meta for embed-text
                    ...(comp.i18nStrings && comp.i18nStrings.length > 0
                        ? { i18nStrings: comp.i18nStrings }
                        : {}),
                },
            });
        }
    }

    // -----------------------------------------------------------------------
    // 2. Hook nodes  →  fe-hook (file-qualified IDs, P1-2)
    // -----------------------------------------------------------------------
    for (const hook of extractorOutput.hooks) {
        const nodeId = `fe-hook:${hook.file}#${hook.name}`;
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
                // A6: path points at the page file so snippet can extract the component
                path: route.pageFile,
                meta: { pageFile: route.pageFile },
            });
        }
    }

    // -----------------------------------------------------------------------
    // 4. Page nodes  →  fe-page (file-qualified to avoid App Router collisions)
    //    + fe-routes-to edge
    // -----------------------------------------------------------------------
    for (const page of extractorOutput.pages) {
        const pageNodeId = `fe-page:${page.file}#${page.name}`;
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
    //    Lookup is file-scoped: renders carry fromFile, look up toName within
    //    renders from the same fromFile first, then globally (P1-2).
    // -----------------------------------------------------------------------
    // Build (file, name) → nodeId lookup for renders
    const fileNameToNodeId = new Map<string, string>(); // key: `${file}#${name}`
    const nameToNodeIds = new Map<string, string[]>();  // fallback: name → [nodeIds]
    for (const comp of extractorOutput.components) {
        const nodeId = `fe-component:${comp.file}#${comp.name}`;
        fileNameToNodeId.set(`${comp.file}#${comp.name}`, nodeId);
        const existing = nameToNodeIds.get(comp.name) ?? [];
        existing.push(nodeId);
        nameToNodeIds.set(comp.name, existing);
    }

    for (const render of extractorOutput.renders) {
        const fromId = `fe-component:${render.fromFile}#${render.fromName}`;

        // Prefer file-local target first, then any file with that name
        const toId =
            fileNameToNodeId.get(`${render.fromFile}#${render.toName}`) ??
            (nameToNodeIds.get(render.toName)?.[0] ?? undefined);

        if (!toId) {
            // toName not found in extracted components — could be external/unresolved
            unresolved.push({
                kind: 'fe-renders' as FeUnresolvedKind,
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
    // Build a file→[nodeId] lookup
    const fileToNodes = new Map<string, string[]>();
    for (const comp of extractorOutput.components) {
        const nodeId = `fe-component:${comp.file}#${comp.name}`;
        const existing = fileToNodes.get(comp.file) ?? [];
        existing.push(nodeId);
        fileToNodes.set(comp.file, existing);
    }
    for (const page of extractorOutput.pages) {
        const key = page.file;
        if (!fileToNodes.has(key)) fileToNodes.set(key, []);
        const pageNodeId = `fe-page:${page.file}#${page.name}`;
        fileToNodes.get(key)!.push(pageNodeId);
    }

    const importedEdgesAdded = new Set<string>();
    for (const imp of extractorOutput.imports) {
        if (!imp.resolvedFile) {
            // Push to diagnostics when resolvedFile is null (P0-5)
            unresolved.push({
                kind: 'fe-imports' as FeUnresolvedKind,
                ref: imp.specifier,
                reason: 'unresolved-file',
            });
            continue;
        }

        // Find target components in the resolved file
        const targetNodes = fileToNodes.get(imp.resolvedFile);
        if (!targetNodes || targetNodes.length === 0) continue;

        // Find source nodes (page or component) in the source file
        const sourceNodes = fileToNodes.get(imp.sourceFile);
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
    // 7. Ownership check (unowned nodes) — components, pages, hooks, routes (P1-3)
    // -----------------------------------------------------------------------
    for (const comp of extractorOutput.components) {
        const owner = ownership.findOwner(comp.file);
        if (owner.kind === 'unknown') {
            unowned.push({ kind: 'fe-component' as FeUnownedKind, file: comp.file });
        }
    }
    for (const page of extractorOutput.pages) {
        const owner = ownership.findOwner(page.file);
        if (owner.kind === 'unknown') {
            unowned.push({ kind: 'fe-page' as FeUnownedKind, file: page.file });
        }
    }
    for (const hook of extractorOutput.hooks) {
        const owner = ownership.findOwner(hook.file);
        if (owner.kind === 'unknown') {
            unowned.push({ kind: 'fe-hook' as FeUnownedKind, file: hook.file });
        }
    }
    for (const route of extractorOutput.routes) {
        const owner = ownership.findOwner(route.pageFile);
        if (owner.kind === 'unknown') {
            unowned.push({ kind: 'fe-route' as FeUnownedKind, file: route.pageFile });
        }
    }

    const unresolvedImportsCount = unresolved.filter((u) => u.kind === 'fe-imports').length;
    const unresolvedRendersCount = unresolved.filter((u) => u.kind === 'fe-renders').length;

    return {
        nodes: [...nodeMap.values()],
        edges: [...edgeMap.values()],
        diagnostics: {
            unresolved,
            unowned,
            counts: {
                unresolvedImports: unresolvedImportsCount,
                unresolvedRenders: unresolvedRendersCount,
                unowned: unowned.length,
            },
        },
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
