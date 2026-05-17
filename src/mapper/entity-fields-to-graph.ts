/**
 * db-entity-field mapper — Variant 2, Task B5.
 *
 * Maps EntityFieldSite records to `db-entity-field` nodes and `entity-has-field` edges.
 *
 * Node id: `db-entity-field:<table>/<field>`
 * Edge: `entity-has-field` from db-table node → db-entity-field node
 *
 * P1-3: db-table nodes are NOT emitted here — they are already emitted by
 * mapTypeOrmToGraph. This mapper only emits db-entity-field nodes + edges.
 */

import type { GraphEdge, GraphNode } from '../core/types.js';
import type { EntityFieldSite } from '../extractors/typeorm/fields.js';
import { buildClassMemberAnchor } from './anchor.js';

export interface EntityFieldsMapResult {
    nodes: GraphNode[];
    edges: GraphEdge[];
    diagnostics: Array<{ message: string }>;
}

/**
 * Map db-entity-field sites to graph nodes and edges.
 *
 * Only `db-entity-field` nodes are emitted here. The `db-table` nodes are
 * emitted by `mapTypeOrmToGraph`; duplicating them here would collide when
 * both results are merged in `assembleGraph`.
 *
 * `entity-has-field` edges use `db-table:<tableName>` as their source (`from`)
 * which references the node already in the graph from the TypeORM mapper.
 * Duplicate (table, field) pairs are deduplicated.
 */
export function mapEntityFieldsToGraph(
    fields: EntityFieldSite[],
): EntityFieldsMapResult {
    const fieldNodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const diagnostics: Array<{ message: string }> = [];

    for (const field of fields) {
        const tableId = `db-table:${field.tableName}`;
        const fieldNodeId = `db-entity-field:${field.tableName}/${field.fieldName}`;

        // db-entity-field node (one per table/field combo)
        if (!fieldNodes.has(fieldNodeId)) {
            // Use declaringClass for the anchor so snippet extraction can use
            // a direct primary lookup (sf.getClass(declaringClass).getProperty(fieldName))
            // instead of a fallback scan of all classes in the file.
            const anchor = buildClassMemberAnchor(field.declaringClass, field.fieldName, fieldNodeId);
            fieldNodes.set(fieldNodeId, {
                id: fieldNodeId,
                kind: 'db-entity-field',
                label: `${field.tableName}/${field.fieldName}`,
                path: field.location.file,
                anchor,
                meta: {
                    entityClass: field.entityClass,
                    declaringClass: field.declaringClass,
                    tableName: field.tableName,
                    fieldName: field.fieldName,
                    fieldType: field.fieldType,
                    nullable: field.nullable,
                    decorator: field.decorator,
                },
            });
        }

        // entity-has-field edge: db-table → db-entity-field
        const edgeId = `entity-has-field:${tableId}->${fieldNodeId}`;
        if (!edges.has(edgeId)) {
            edges.set(edgeId, {
                id: edgeId,
                from: tableId,
                to: fieldNodeId,
                kind: 'entity-has-field',
                file: field.location.file,
                line: field.location.line,
                meta: {
                    decorator: field.decorator,
                    fieldType: field.fieldType,
                    nullable: field.nullable,
                },
            });
        } else {
            diagnostics.push({
                message: `Duplicate field ${field.fieldName} on table ${field.tableName} — skipped`,
            });
        }
    }

    return {
        nodes: [...fieldNodes.values()],
        edges: [...edges.values()],
        diagnostics,
    };
}
