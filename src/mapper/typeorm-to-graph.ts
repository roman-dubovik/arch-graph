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
 * Also maps `@ManyToOne / @ManyToMany / @OneToOne` relations to
 * `db-table → db-table` edges with kind `db-relation`.
 *   - Resolved target      -> `db-relation` edge emitted
 *   - Unresolved target    -> diagnostics.unresolvedRelations
 *
 * Policy A: only `@ManyToOne` (the FK-owner side), `@ManyToMany`, and `@OneToOne`
 * produce `db-relation` edges. `@OneToMany` is the inverse/mirror of a `@ManyToOne`
 * on the other side of the same FK — emitting both would produce duplicate edges in
 * opposite directions for the same logical foreign key. Since the FK lives on the
 * `@ManyToOne` side, that is the single source of truth; `@OneToMany` is skipped.
 *
 * `entityIndex` is required when `relations` is non-empty: it is used to look up
 * the owner entity's table name for each relation. Pass `undefined` or omit only
 * when no relations are extracted (e.g. unit tests exercising db-access logic only).
 */
export function mapTypeOrmToGraph(
    sites: TypeOrmInjectionSite[],
    ownership: OwnershipRegistry,
    entityWarnings: TypeOrmEntityDecoratorWarning[] = [],
    relations: TypeOrmRelation[] = [],
    entityIndex: EntityIndex | undefined = undefined,
    baseClassCycles = 0,
): MapTypeOrmResult {
    if (relations.length > 0 && !entityIndex) {
        throw new Error('entityIndex is required when relations are provided');
    }

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

    // ---- db-relation edges from @ManyToOne / @ManyToMany / @OneToOne ----
    // Policy A: skip @OneToMany — the FK is owned by @ManyToOne on the other entity.
    // Emitting both would produce two edges in opposite directions for the same FK.
    // Note: @OneToMany relations that are also unresolved are NOT counted in
    // unresolvedReasons — Policy A filters them before unresolved bucketing.
    const unresolvedRelations: TypeOrmRelation[] = [];
    let relationsEmitted = 0;
    let relationsResolved = 0;
    let oneToManySkipped = 0;
    const unresolvedReasons = { unparseable: 0, notIndexed: 0, ownerNotIndexed: 0 };

    for (const rel of relations) {
        // Count resolved relations BEFORE Policy A filtering (matches JSDoc on the field).
        if (rel.resolvedTarget) relationsResolved++;

        // Policy A: @OneToMany is the inverse mirror of @ManyToOne — skip it entirely.
        if (rel.decorator === 'OneToMany') {
            oneToManySkipped++;
            continue;
        }

        if (!rel.resolvedTarget) {
            unresolvedRelations.push(rel);
            if (rel.reason === 'unparseable') unresolvedReasons.unparseable++;
            else if (rel.reason === 'not-indexed') unresolvedReasons.notIndexed++;
            continue;
        }

        // Owner entity lookup for table name (entityIndex is guaranteed non-null here)
        const ownerEntity = entityIndex!.get(rel.ownerClass) ?? null;
        if (!ownerEntity) {
            // Owner not in index — treat as unresolved (defensive; extractor already filters).
            // Increment ownerNotIndexed to maintain:
            //   unparseable + notIndexed + ownerNotIndexed === unresolvedRelations.length
            unresolvedRelations.push(rel);
            unresolvedReasons.ownerNotIndexed++;
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
                    ...(rel.sourceDecorator ? { sourceDecorator: rel.sourceDecorator } : {}),
                    propertyName: rel.propertyName,
                    ownerClass: rel.ownerClass,
                    targetClass: rel.targetClass,
                },
            });
            relationsEmitted++;
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
                relationsEmitted,
                relationsResolved,
                unresolvedRelations: unresolvedRelations.length,
                oneToManySkipped,
                unresolvedReasons,
                baseClassCycles,
            },
        },
    };
}
