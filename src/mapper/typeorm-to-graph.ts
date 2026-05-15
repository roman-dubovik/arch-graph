import type {
    GraphEdge,
    GraphNode,
    TypeOrmDiagnostics,
    TypeOrmEntityDecoratorWarning,
    TypeOrmInjectionSite,
} from '../core/types.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import { ownerNodeFor, ownerNodeId } from './owner-node.js';

export interface MapTypeOrmResult {
    nodes: GraphNode[];
    edges: GraphEdge[];
    diagnostics: TypeOrmDiagnostics;
}

/**
 * Maps `@InjectRepository(EntityClass)` sites to graph nodes/edges.
 *   - Resolved entity      -> `db-table:<table>` node + `db-access` edge (owner -> table)
 *   - Unresolved entity    -> diagnostics.unresolvedEntities (not in graph)
 *   - Owner apps/ libs/    -> `service:<id>` / `lib:<id>`
 *   - Owner unknown        -> diagnostics.unowned
 * One edge per (owner, table); first-seen injection site location wins.
 */
export function mapTypeOrmToGraph(
    sites: TypeOrmInjectionSite[],
    ownership: OwnershipRegistry,
    entityWarnings: TypeOrmEntityDecoratorWarning[] = [],
): MapTypeOrmResult {
    const ownerNodes = new Map<string, GraphNode>();
    const tableNodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const unresolvedEntities: TypeOrmInjectionSite[] = [];
    const unowned: TypeOrmInjectionSite[] = [];

    for (const s of sites) {
        if (!s.resolvedEntity) {
            unresolvedEntities.push(s);
            continue;
        }
        const owner = ownership.findOwner(s.location.file);
        if (owner.kind === 'unknown') {
            unowned.push(s);
            continue;
        }

        const ownerId = ownerNodeId(owner);
        if (!ownerNodes.has(ownerId)) ownerNodes.set(ownerId, ownerNodeFor(owner));

        const table = s.resolvedEntity.tableSource.table;
        const tableId = `db-table:${table}`;
        if (!tableNodes.has(tableId)) {
            tableNodes.set(tableId, {
                id: tableId,
                kind: 'db-table',
                label: table,
                meta: {
                    entityClass: s.resolvedEntity.className,
                    declaredAt: `${s.resolvedEntity.file}:${s.resolvedEntity.line}`,
                    tableSource: s.resolvedEntity.tableSource.kind,
                },
            });
        }

        const edgeKey = `db-access:${ownerId}->${tableId}`;
        if (!edges.has(edgeKey)) {
            edges.set(edgeKey, {
                id: edgeKey,
                from: ownerId,
                to: tableId,
                kind: 'db-access',
                file: s.location.file,
                line: s.location.line,
                meta: {
                    entityClass: s.resolvedEntity.className,
                    propertyName: s.propertyName,
                    ...(s.enclosingClass !== undefined ? { enclosingClass: s.enclosingClass } : {}),
                },
            });
        }
    }

    return {
        nodes: [...ownerNodes.values(), ...tableNodes.values()],
        edges: [...edges.values()],
        diagnostics: {
            unresolvedEntities,
            unowned,
            entityDecoratorWarnings: entityWarnings,
            counts: {
                resolved: sites.length - unresolvedEntities.length - unowned.length,
                unresolvedEntity: unresolvedEntities.length,
                unowned: unowned.length,
                entityDecoratorWarnings: entityWarnings.length,
            },
        },
    };
}

