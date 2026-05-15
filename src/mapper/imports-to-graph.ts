import type {
    GraphEdge,
    GraphNode,
    GraphOwnerRef,
    ImportsDiagnostics,
    TsImportSite,
} from '../core/types.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import { ownerNodeFor, ownerNodeId } from './owner-node.js';

export interface MapImportsResult {
    nodes: GraphNode[];
    edges: GraphEdge[];
    diagnostics: ImportsDiagnostics;
}

export interface MapImportsOptions {
    /** Emit per-import `ts-import` edges (file → file). Default: false. */
    fileLevel: boolean;
}

/**
 * Maps `TsImportSite[]` to graph nodes/edges:
 *
 *   - aggregated `lib-usage` edges: one per (sourceOwner, targetOwner, kind)
 *     where source and target are different owners (service/lib). The
 *     primary deliverable — these are the architectural facts the user wants.
 *
 *   - optional per-import `ts-import` edges (file → file), behind `fileLevel`.
 *     One edge per import declaration; deduplicated per
 *     (sourceFile, resolvedFile) pair because re-imports inside the same file
 *     don't carry new information.
 *
 * Site classification (for an aggregated edge):
 *   sourceOwner / targetOwner:
 *     - both unknown / external          → diagnostics only
 *     - same owner                       → skipped (intra-service / intra-lib)
 *     - service → lib                    → `lib-usage` (canonical case)
 *     - lib → lib                        → `lib-usage` (transitive deps)
 *     - service → service                → `lib-usage` + meta.antipattern=true
 *     - lib → service                    → `lib-usage` + meta.antipattern=true
 *                                          (libs reaching back into apps; very rare)
 *
 * Why every cross-owner edge gets `lib-usage` regardless of target kind:
 *   "lib-usage" is shorthand for "structural module usage" — the consumer of
 *   the graph branches on `meta.antipattern` if they care about the direction;
 *   leaving cross-service imports without an edge would hide a real signal.
 */
export function mapImportsToGraph(
    sites: TsImportSite[],
    ownership: OwnershipRegistry,
    opts: MapImportsOptions,
): MapImportsResult {
    const ownerNodes = new Map<string, GraphNode>();
    const fileNodes = new Map<string, GraphNode>();
    const aggregatedEdges = new Map<string, GraphEdge>();
    const fileEdges = new Map<string, GraphEdge>();

    const unresolvedImports: TsImportSite[] = [];
    const dynamicImports: TsImportSite[] = [];

    let totalStatic = 0;
    let totalDynamic = 0;
    let resolvedToOwner = 0;
    let externalOrUnresolved = 0;
    let unresolvedInternal = 0;

    for (const site of sites) {
        if (site.kind === 'dynamic') {
            totalDynamic++;
            dynamicImports.push(site);
        } else {
            totalStatic++;
        }

        if (site.resolvedFilePath === null) {
            // Unresolved. Three buckets:
            //   - bare-external / builtin → node_modules / node:fs — expected, not a bug
            //   - relative / alias        → graph-relevant target we failed to find;
            //                                this IS the regression signal (typo'd
            //                                alias, broken `paths`, moved file)
            if (site.specifierShape === 'bare-external' || site.specifierShape === 'builtin') {
                externalOrUnresolved++;
            } else {
                unresolvedInternal++;
                if (site.kind === 'static') unresolvedImports.push(site);
            }
            continue;
        }

        const sourceOwner = ownership.findOwner(site.sourceFile);
        const targetOwner = ownership.findOwner(site.resolvedFilePath);

        // Both unknown — outside apps/ and libs/. Not graph-relevant.
        if (sourceOwner.kind === 'unknown' && targetOwner.kind === 'unknown') {
            externalOrUnresolved++;
            continue;
        }
        // Source must be owned (otherwise the edge has no `from` we care about).
        if (sourceOwner.kind === 'unknown') {
            externalOrUnresolved++;
            continue;
        }
        // Target outside apps/libs (e.g. an import that resolved to a file we don't
        // model as an owner). Drop quietly — it's not really an architectural fact.
        if (targetOwner.kind === 'unknown') {
            externalOrUnresolved++;
            continue;
        }

        resolvedToOwner++;

        // ---- File-level edges (opt-in) ----
        if (opts.fileLevel) {
            const fromFileId = `file:${site.sourceFile}`;
            const toFileId = `file:${site.resolvedFilePath}`;
            ensureFileNode(fileNodes, fromFileId, site.sourceFile);
            ensureFileNode(fileNodes, toFileId, site.resolvedFilePath);
            const fileKey = `${fromFileId}->${toFileId}`;
            if (!fileEdges.has(fileKey)) {
                fileEdges.set(fileKey, {
                    id: `ts-import:${fileKey}`,
                    from: fromFileId,
                    to: toFileId,
                    kind: 'ts-import',
                    file: site.sourceFile,
                    line: site.location.line,
                    ...(site.kind === 'dynamic' ? { meta: { dynamic: true } } : {}),
                });
            }
        }

        // ---- Aggregated lib-usage edges ----
        // Same owner — not interesting (intra-service module wiring).
        if (sameOwner(sourceOwner, targetOwner)) continue;

        const fromId = ownerNodeId(sourceOwner);
        const toId = ownerNodeId(targetOwner);
        ensureOwnerNode(ownerNodes, sourceOwner);
        ensureOwnerNode(ownerNodes, targetOwner);

        const edgeKey = `lib-usage:${fromId}->${toId}`;
        const existing = aggregatedEdges.get(edgeKey);
        const antipattern = isAntipattern(sourceOwner, targetOwner);

        if (!existing) {
            const meta: Record<string, unknown> = { importCount: 1 };
            if (antipattern) meta.antipattern = true;
            aggregatedEdges.set(edgeKey, {
                id: edgeKey,
                from: fromId,
                to: toId,
                kind: 'lib-usage',
                file: site.sourceFile,
                line: site.location.line,
                meta,
            });
        } else {
            const meta = (existing.meta ?? {}) as Record<string, unknown>;
            meta.importCount = ((meta.importCount as number | undefined) ?? 1) + 1;
            existing.meta = meta;
        }
    }

    return {
        nodes: [...ownerNodes.values(), ...fileNodes.values()],
        edges: [...aggregatedEdges.values(), ...fileEdges.values()],
        diagnostics: {
            unresolvedImports,
            dynamicImports,
            counts: {
                totalStatic,
                totalDynamic,
                resolvedToOwner,
                externalOrUnresolved,
                unresolvedInternal,
            },
        },
    };
}

function ensureOwnerNode(nodes: Map<string, GraphNode>, owner: GraphOwnerRef): void {
    const id = ownerNodeId(owner);
    if (!nodes.has(id)) nodes.set(id, ownerNodeFor(owner));
}

function ensureFileNode(nodes: Map<string, GraphNode>, id: string, path: string): void {
    if (!nodes.has(id)) {
        nodes.set(id, { id, kind: 'file', label: path, path });
    }
}

function sameOwner(a: GraphOwnerRef, b: GraphOwnerRef): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'unknown' || b.kind === 'unknown') return false;
    return a.id === (b as Extract<GraphOwnerRef, { kind: 'service' | 'lib' }>).id;
}

function isAntipattern(source: GraphOwnerRef, target: GraphOwnerRef): boolean {
    // service → service: app A imports from app B directly (should go through a lib).
    if (source.kind === 'service' && target.kind === 'service') return true;
    // lib → service: shared code reaching into an app (inversion of dependency direction).
    if (source.kind === 'lib' && target.kind === 'service') return true;
    return false;
}
