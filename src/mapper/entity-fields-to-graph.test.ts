import { describe, expect, it } from 'vitest';
import { mapEntityFieldsToGraph } from './entity-fields-to-graph.js';
import type { ColumnDecorator, EntityFieldSite } from '../extractors/typeorm/fields.js';

function field(
    entityClass = 'UserEntity',
    tableName = 'users',
    fieldName = 'email',
    fieldType = 'varchar',
    nullable = false,
    decorator: ColumnDecorator = 'Column',
    declaringClass?: string,
): EntityFieldSite {
    return {
        entityClass,
        declaringClass: declaringClass ?? entityClass,
        tableName,
        fieldName,
        fieldType,
        nullable,
        decorator,
        location: { file: '/app/user.entity.ts', line: 10, column: 5 },
    };
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

    // P1-3: db-table nodes are NOT emitted by this mapper (they come from mapTypeOrmToGraph)
    it('does NOT emit db-table nodes (owned by typeorm mapper)', () => {
        const result = mapEntityFieldsToGraph([field()]);
        const tableNode = result.nodes.find((n) => n.kind === 'db-table');
        expect(tableNode).toBeUndefined();
    });

    it('creates entity-has-field edge from db-table to db-entity-field', () => {
        const result = mapEntityFieldsToGraph([field()]);
        const edge = result.edges.find((e) => e.kind === 'entity-has-field');
        expect(edge).toBeDefined();
        expect(edge!.from).toBe('db-table:users');
        expect(edge!.to).toBe('db-entity-field:users/email');
    });

    it('creates one db-entity-field node per field (no tableNode deduplicate needed)', () => {
        const fields: EntityFieldSite[] = [
            field('UserEntity', 'users', 'email'),
            field('UserEntity', 'users', 'name'),
            field('UserEntity', 'users', 'id'),
        ];
        const result = mapEntityFieldsToGraph(fields);
        const fieldNodes = result.nodes.filter((n) => n.kind === 'db-entity-field');
        expect(fieldNodes).toHaveLength(3);
        // No db-table node from this mapper
        expect(result.nodes.filter((n) => n.kind === 'db-table')).toHaveLength(0);
    });

    it('emits edges with correct from pointing to non-existent-yet db-table node', () => {
        // The db-table:posts node would come from mapTypeOrmToGraph in real usage
        const fields: EntityFieldSite[] = [
            field('PostEntity', 'posts', 'title'),
        ];
        const result = mapEntityFieldsToGraph(fields);
        const edge = result.edges[0]!;
        expect(edge.from).toBe('db-table:posts');
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

    it('anchor uses declaringClass for directly-declared field (entityClass === declaringClass)', () => {
        const f = field('UserEntity', 'users', 'email');
        const result = mapEntityFieldsToGraph([f]);
        const node = result.nodes.find((n) => n.kind === 'db-entity-field')!;
        expect(node.anchor).toBe('UserEntity.email');
    });

    it('anchor uses declaringClass (base class) for inherited field', () => {
        const f = field('Users', 'users', 'createdAt', 'timestamp', false, 'CreateDateColumn', 'BaseEntity');
        const result = mapEntityFieldsToGraph([f]);
        const node = result.nodes.find((n) => n.kind === 'db-entity-field')!;
        expect(node.anchor).toBe('BaseEntity.createdAt');
    });

    it('meta includes both entityClass and declaringClass', () => {
        const f = field('Users', 'users', 'createdAt', 'timestamp', false, 'CreateDateColumn', 'BaseEntity');
        const result = mapEntityFieldsToGraph([f]);
        const node = result.nodes.find((n) => n.kind === 'db-entity-field')!;
        expect(node.meta?.entityClass).toBe('Users');
        expect(node.meta?.declaringClass).toBe('BaseEntity');
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
        const decorators: ColumnDecorator[] = [
            'Column', 'PrimaryColumn', 'PrimaryGeneratedColumn',
            'CreateDateColumn', 'UpdateDateColumn', 'DeleteDateColumn',
        ];
        const fields: EntityFieldSite[] = decorators.map((d, i) =>
            field('Ent', 'table', `field${i}`, 'varchar', false, d),
        );
        const result = mapEntityFieldsToGraph(fields);
        expect(result.nodes.filter((n) => n.kind === 'db-entity-field')).toHaveLength(6);
        expect(result.edges).toHaveLength(6);
    });

    it('includes file and line from location in edge', () => {
        const result = mapEntityFieldsToGraph([field()]);
        const edge = result.edges[0]!;
        expect(edge.file).toContain('user.entity.ts');
        expect(edge.line).toBeGreaterThan(0);
    });
});
