import { describe, expect, it } from 'vitest';
import { mapEntityFieldsToGraph } from './entity-fields-to-graph.js';
import type { EntityFieldSite } from '../extractors/typeorm/fields.js';

function field(
    entityClass = 'UserEntity',
    tableName = 'users',
    fieldName = 'email',
    fieldType = 'varchar',
    nullable = false,
    decorator = 'Column',
): EntityFieldSite {
    return { entityClass, tableName, fieldName, fieldType, nullable, decorator, file: '/app/user.entity.ts', line: 10 };
}

describe('mapEntityFieldsToGraph', () => {
    it('returns empty for no fields', () => {
        const result = mapEntityFieldsToGraph([]);
        expect(result.nodes).toHaveLength(0);
        expect(result.edges).toHaveLength(0);
        expect(result.diagnostics).toHaveLength(0);
    });

    it('creates db-entity-field node with correct id', () => {
        const result = mapEntityFieldsToGraph([field()]);
        const node = result.nodes.find((n) => n.kind === 'db-entity-field');
        expect(node).toBeDefined();
        expect(node!.id).toBe('db-entity-field:users/email');
        expect(node!.label).toBe('users/email');
    });

    it('creates db-table node', () => {
        const result = mapEntityFieldsToGraph([field()]);
        const tableNode = result.nodes.find((n) => n.kind === 'db-table');
        expect(tableNode).toBeDefined();
        expect(tableNode!.id).toBe('db-table:users');
    });

    it('creates entity-has-field edge from db-table to db-entity-field', () => {
        const result = mapEntityFieldsToGraph([field()]);
        const edge = result.edges.find((e) => e.kind === 'entity-has-field');
        expect(edge).toBeDefined();
        expect(edge!.from).toBe('db-table:users');
        expect(edge!.to).toBe('db-entity-field:users/email');
    });

    it('deduplicates db-table nodes across multiple fields from same entity', () => {
        const fields: EntityFieldSite[] = [
            field('UserEntity', 'users', 'email'),
            field('UserEntity', 'users', 'name'),
            field('UserEntity', 'users', 'id'),
        ];
        const result = mapEntityFieldsToGraph(fields);
        const tableNodes = result.nodes.filter((n) => n.kind === 'db-table');
        expect(tableNodes).toHaveLength(1);
    });

    it('creates separate db-table nodes for different entities', () => {
        const fields: EntityFieldSite[] = [
            field('UserEntity', 'users', 'id'),
            field('PostEntity', 'posts', 'id'),
        ];
        const result = mapEntityFieldsToGraph(fields);
        const tableNodes = result.nodes.filter((n) => n.kind === 'db-table');
        expect(tableNodes).toHaveLength(2);
    });

    it('creates one db-entity-field node per unique table/field', () => {
        const fields: EntityFieldSite[] = [
            field('UserEntity', 'users', 'email'),
            field('UserEntity', 'users', 'name'),
        ];
        const result = mapEntityFieldsToGraph(fields);
        const fieldNodes = result.nodes.filter((n) => n.kind === 'db-entity-field');
        expect(fieldNodes).toHaveLength(2);
    });

    it('deduplicates duplicate table/field combos', () => {
        const fields: EntityFieldSite[] = [
            field('UserEntity', 'users', 'email'),
            field('UserEntity', 'users', 'email'), // duplicate
        ];
        const result = mapEntityFieldsToGraph(fields);
        const fieldNodes = result.nodes.filter((n) => n.kind === 'db-entity-field');
        expect(fieldNodes).toHaveLength(1);
        // Should emit a diagnostic for the duplicate
        expect(result.diagnostics.length).toBeGreaterThan(0);
    });

    it('stores field metadata in node meta', () => {
        const f = field('UserEntity', 'users', 'email', 'varchar', false, 'Column');
        const result = mapEntityFieldsToGraph([f]);
        const node = result.nodes.find((n) => n.kind === 'db-entity-field')!;
        expect(node.meta?.fieldType).toBe('varchar');
        expect(node.meta?.nullable).toBe(false);
        expect(node.meta?.decorator).toBe('Column');
    });

    it('nullable field is reflected in meta', () => {
        const f = field('UserEntity', 'users', 'phone', 'varchar', true);
        const result = mapEntityFieldsToGraph([f]);
        const node = result.nodes.find((n) => n.kind === 'db-entity-field')!;
        expect(node.meta?.nullable).toBe(true);
    });

    it('handles all 6 decorator types', () => {
        const decorators = ['Column', 'PrimaryColumn', 'PrimaryGeneratedColumn',
            'CreateDateColumn', 'UpdateDateColumn', 'DeleteDateColumn'];
        const fields: EntityFieldSite[] = decorators.map((d, i) =>
            field('Ent', 'table', `field${i}`, 'varchar', false, d),
        );
        const result = mapEntityFieldsToGraph(fields);
        expect(result.nodes.filter((n) => n.kind === 'db-entity-field')).toHaveLength(6);
        expect(result.edges).toHaveLength(6);
    });

    it('includes file and line in edge', () => {
        const result = mapEntityFieldsToGraph([field()]);
        const edge = result.edges[0]!;
        expect(edge.file).toContain('user.entity.ts');
        expect(edge.line).toBeGreaterThan(0);
    });
});
