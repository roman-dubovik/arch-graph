import type {
    GraphEdge,
    GraphNode,
    TypeOrmDiagnostics,
    TypeOrmEntityDecoratorWarning,
    TypeOrmInjectionSite,
    TypeOrmRelation,
} from '../core/types.js';
import { tableNameOf } from '../core/types.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import { ownerNodeFor, ownerNodeId } from './owner-node.js';
import type { EntityIndex } from '../extractors/typeorm/entity-index.js';

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
 *
 * Also maps `@ManyToOne / @OneToMany / @ManyToMany / @OneToOne` relations to
 * `db-table → db-table` edges with kind `db-relation`.
 *   - Resolved target      -> `db-relation` edge emitted
 *   - Unresolved target    -> diagnostics.unresolvedRelations
 */
export function mapTypeOrmToGraph(
    sites: TypeOrmInjectionSite[],
    ownership: OwnershipRegistry,
    entityWarnings: TypeOrmEntityDecoratorWarning[] = [],
    relations: TypeOrmRelation[] = [],
    entityIndex?: EntityIndex,
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

    // ---- db-relation edges from @ManyToOne / @OneToMany / @ManyToMany / @OneToOne ----
    const unresolvedRelations: TypeOrmRelation[] = [];
    let resolvedRelationsCount = 0;

    for (const rel of relations) {
        if (!rel.resolvedTarget) {
            unresolvedRelations.push(rel);
            continue;
        }

        // Owner entity lookup for table name
        const ownerEntity = entityIndex?.get(rel.ownerClass) ?? null;
        if (!ownerEntity) {
            // Owner not in index — treat as unresolved (defensive; extractor already filters)
            unresolvedRelations.push(rel);
            continue;
        }

        const ownerTable = tableNameOf(ownerEntity);
        const targetTable = tableNameOf(rel.resolvedTarget);

        const ownerTableId = `db-table:${ownerTable}`;
        const targetTableId = `db-table:${targetTable}`;

        // Ensure both table nodes exist
        if (!tableNodes.has(ownerTableId)) {
            tableNodes.set(ownerTableId, {
                id: ownerTableId,
                kind: 'db-table',
                label: ownerTable,
                meta: {
                    entityClass: ownerEntity.className,
                    declaredAt: `${ownerEntity.file}:${ownerEntity.line}`,
                    tableSource: ownerEntity.tableSource.kind,
                },
            });
        }
        if (!tableNodes.has(targetTableId)) {
            tableNodes.set(targetTableId, {
                id: targetTableId,
                kind: 'db-table',
                label: targetTable,
                meta: {
                    entityClass: rel.resolvedTarget.className,
                    declaredAt: `${rel.resolvedTarget.file}:${rel.resolvedTarget.line}`,
                    tableSource: rel.resolvedTarget.tableSource.kind,
                },
            });
        }

        // Edge id uses propertyName as discriminant so two FK columns on the same
        // owner→target pair produce distinct edges (idempotent per property)
        const edgeId = `db-relation:${ownerTableId}->${targetTableId}:${rel.propertyName}`;
        if (!edges.has(edgeId)) {
            edges.set(edgeId, {
                id: edgeId,
                from: ownerTableId,
                to: targetTableId,
                kind: 'db-relation',
                file: rel.location.file,
                line: rel.location.line,
                meta: {
                    decorator: rel.decorator,
                    propertyName: rel.propertyName,
                    ownerClass: rel.ownerClass,
                    targetClass: rel.targetClass,
                },
            });
            resolvedRelationsCount++;
        }
    }

    return {
        nodes: [...ownerNodes.values(), ...tableNodes.values()],
        edges: [...edges.values()],
        diagnostics: {
            unresolvedEntities,
            unowned,
            entityDecoratorWarnings: entityWarnings,
            unresolvedRelations,
            counts: {
                resolved: sites.length - unresolvedEntities.length - unowned.length,
                unresolvedEntity: unresolvedEntities.length,
                unowned: unowned.length,
                entityDecoratorWarnings: entityWarnings.length,
                relations: resolvedRelationsCount,
                unresolvedRelations: unresolvedRelations.length,
            },
        },
    };
}
