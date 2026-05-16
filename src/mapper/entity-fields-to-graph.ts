/**
 * db-entity-field mapper — Variant 2, Task B5.
 *
 * Maps EntityFieldSite records to `db-entity-field` nodes and `entity-has-field` edges.
 *
 * Node id: `db-entity-field:<table>/<field>`
 * Edge: `entity-has-field` from db-table node → db-entity-field node
 */

import type { GraphEdge, GraphNode } from '../core/types.js';
import type { EntityFieldSite } from '../extractors/typeorm/fields.js';

export interface EntityFieldsMapResult {
    nodes: GraphNode[];
    edges: GraphEdge[];
    diagnostics: Array<{ message: string }>;
}

/**
 * Map db-entity-field sites to graph nodes and edges.
 *
 * The db-table nodes are assumed to already exist in the main graph (emitted by
 * mapTypeOrmToGraph); this function only emits the db-entity-field nodes and
 * entity-has-field edges. Duplicate (table, field) pairs are deduplicated.
 */
export function mapEntityFieldsToGraph(
    fields: EntityFieldSite[],
): EntityFieldsMapResult {
    const fieldNodes = new Map<string, GraphNode>();
    const tableNodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const diagnostics: Array<{ message: string }> = [];

    for (const field of fields) {
        const tableId = `db-table:${field.tableName}`;
        const fieldNodeId = `db-entity-field:${field.tableName}/${field.fieldName}`;

        // Ensure parent db-table node exists (may already be in the graph from typeorm mapper)
        if (!tableNodes.has(tableId)) {
            tableNodes.set(tableId, {
                id: tableId,
                kind: 'db-table',
                label: field.tableName,
                meta: {
                    entityClass: field.entityClass,
                },
            });
        }

        // db-entity-field node (one per table/field combo)
        if (!fieldNodes.has(fieldNodeId)) {
            fieldNodes.set(fieldNodeId, {
                id: fieldNodeId,
                kind: 'db-entity-field',
                label: `${field.tableName}/${field.fieldName}`,
                meta: {
                    entityClass: field.entityClass,
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
                file: field.file,
                line: field.line,
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
        nodes: [...tableNodes.values(), ...fieldNodes.values()],
        edges: [...edges.values()],
        diagnostics,
    };
}
