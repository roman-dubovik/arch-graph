/**
 * Tests asserting that db-entity-field nodes carry path + anchor fields (A4).
 */
import { describe, expect, it } from 'vitest';

import type { EntityFieldSite } from '../extractors/typeorm/fields.js';
import { mapEntityFieldsToGraph } from './entity-fields-to-graph.js';

function makeSite(overrides: Partial<EntityFieldSite> = {}): EntityFieldSite {
    return {
        entityClass: 'User',
        tableName: 'users',
        decorator: 'Column',
        fieldName: 'email',
        fieldType: 'varchar',
        nullable: false,
        location: { file: '/apps/db/src/user.entity.ts', line: 10, column: 1 },
        ...overrides,
    };
}

describe('mapEntityFieldsToGraph — path + anchor (A4)', () => {
    it('emits path = location.file on db-entity-field node', () => {
        const { nodes } = mapEntityFieldsToGraph([makeSite()]);
        expect(nodes.length).toBe(1);
        expect(nodes[0]!.path).toBe('/apps/db/src/user.entity.ts');
    });

    it('emits anchor = "EntityClass.fieldName"', () => {
        const { nodes } = mapEntityFieldsToGraph([makeSite()]);
        expect(nodes[0]!.anchor).toBe('User.email');
    });

    it('handles multiple fields with correct anchors', () => {
        const fields = [
            makeSite({ fieldName: 'email', entityClass: 'User' }),
            makeSite({ fieldName: 'name', entityClass: 'User', location: { file: '/apps/db/src/user.entity.ts', line: 15, column: 1 } }),
        ];
        const { nodes } = mapEntityFieldsToGraph(fields);
        expect(nodes).toHaveLength(2);
        const emailNode = nodes.find((n) => n.label === 'users/email');
        const nameNode = nodes.find((n) => n.label === 'users/name');
        expect(emailNode!.anchor).toBe('User.email');
        expect(nameNode!.anchor).toBe('User.name');
    });

    it('emits the entity file path for inherited fields (entityClass is the concrete class)', () => {
        const site = makeSite({
            entityClass: 'AdminUser', // concrete class (inheritance resolved by extractor)
            fieldName: 'createdAt',
            decorator: 'CreateDateColumn',
            location: { file: '/apps/db/src/admin-user.entity.ts', line: 5, column: 1 },
        });
        const { nodes } = mapEntityFieldsToGraph([site]);
        expect(nodes[0]!.path).toBe('/apps/db/src/admin-user.entity.ts');
        expect(nodes[0]!.anchor).toBe('AdminUser.createdAt');
    });
});
