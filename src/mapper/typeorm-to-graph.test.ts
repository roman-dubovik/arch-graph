import { describe, expect, it } from 'vitest';

import { inMemoryProject } from '../__fixtures__/in-memory-project.js';
import { buildEntityIndex } from '../extractors/typeorm/entity-index.js';
import { extractRelations } from '../extractors/typeorm/relations.js';
import type { TypeOrmEntity, TypeOrmInjectionSite, TypeOrmRelation } from '../core/types.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import { mapTypeOrmToGraph } from './typeorm-to-graph.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntity(className: string, table: string, file = '/apps/svc/entity.ts'): TypeOrmEntity {
    return {
        className,
        tableSource: { kind: 'explicit', table },
        file,
        line: 1,
    };
}

function makeInjectionSite(
    entityClass: string,
    resolvedEntity: TypeOrmEntity | null,
    file = '/apps/svc/service.ts',
): TypeOrmInjectionSite {
    return {
        propertyName: `${entityClass.toLowerCase()}Repo`,
        entityClass,
        resolvedEntity,
        location: { file, line: 5, column: 1 },
        enclosingClass: 'SomeService',
    };
}

function makeRelation(
    decorator: TypeOrmRelation['decorator'],
    ownerClass: string,
    targetClass: string,
    resolvedTarget: TypeOrmEntity | null,
    propertyName = 'relProp',
    file = '/apps/svc/entity.ts',
): TypeOrmRelation {
    return {
        decorator,
        ownerClass,
        propertyName,
        targetClass,
        resolvedTarget,
        location: { file, line: 10, column: 5 },
    };
}

/** Minimal OwnershipRegistry that always returns 'service:test-svc' for /apps/ paths */
function makeOwnership(): OwnershipRegistry {
    return {
        findOwner(file: string) {
            if (file.includes('/apps/')) return { kind: 'service', id: 'test-svc' };
            return { kind: 'unknown', path: file };
        },
        services: [],
        libs: [],
    } as unknown as OwnershipRegistry;
}

// ---------------------------------------------------------------------------
// db-access edges (existing logic — bring to 95%)
// ---------------------------------------------------------------------------

describe('mapTypeOrmToGraph — db-access edges', () => {
    it('emits a db-table node and db-access edge for a resolved injection site', () => {
        const userEntity = makeEntity('User', 'users');
        const sites = [makeInjectionSite('User', userEntity)];
        const result = mapTypeOrmToGraph(sites, makeOwnership());

        const tableNode = result.nodes.find((n) => n.id === 'db-table:users');
        expect(tableNode).toBeDefined();
        expect(tableNode?.kind).toBe('db-table');

        const edge = result.edges.find((e) => e.kind === 'db-access');
        expect(edge).toBeDefined();
        expect(edge?.from).toBe('service:test-svc');
        expect(edge?.to).toBe('db-table:users');
        expect(edge?.meta?.entityClass).toBe('User');
    });

    it('deduplicates db-access edges for same owner+table', () => {
        const userEntity = makeEntity('User', 'users');
        const sites = [
            makeInjectionSite('User', userEntity),
            makeInjectionSite('User', userEntity),
        ];
        const result = mapTypeOrmToGraph(sites, makeOwnership());

        const accessEdges = result.edges.filter((e) => e.kind === 'db-access');
        expect(accessEdges).toHaveLength(1);
    });

    it('pushes unresolved injection sites to diagnostics.unresolvedEntities', () => {
        const sites = [makeInjectionSite('UnknownEntity', null)];
        const result = mapTypeOrmToGraph(sites, makeOwnership());

        expect(result.diagnostics.unresolvedEntities).toHaveLength(1);
        expect(result.edges).toHaveLength(0);
    });

    it('pushes unowned injection sites to diagnostics.unowned', () => {
        const userEntity = makeEntity('User', 'users', '/external/file.ts');
        const sites = [makeInjectionSite('User', userEntity, '/external/file.ts')];
        const result = mapTypeOrmToGraph(sites, makeOwnership());

        expect(result.diagnostics.unowned).toHaveLength(1);
        expect(result.edges).toHaveLength(0);
    });

    it('includes entityDecoratorWarnings in diagnostics', () => {
        const warnings = [
            { className: 'Foo', file: '/apps/svc/foo.ts', line: 1, reason: 'object-literal-missing-name' as const },
        ];
        const result = mapTypeOrmToGraph([], makeOwnership(), warnings);

        expect(result.diagnostics.entityDecoratorWarnings).toHaveLength(1);
        expect(result.diagnostics.counts.entityDecoratorWarnings).toBe(1);
    });

    it('emits separate db-access edges for two different tables from the same owner', () => {
        const userEntity = makeEntity('User', 'users');
        const orderEntity = makeEntity('Order', 'orders');
        const sites = [
            makeInjectionSite('User', userEntity),
            makeInjectionSite('Order', orderEntity),
        ];
        const result = mapTypeOrmToGraph(sites, makeOwnership());

        const accessEdges = result.edges.filter((e) => e.kind === 'db-access');
        expect(accessEdges).toHaveLength(2);
    });

    it('sets counts correctly for mixed resolved/unresolved/unowned sites', () => {
        const userEntity = makeEntity('User', 'users');
        const sites = [
            makeInjectionSite('User', userEntity),         // resolved
            makeInjectionSite('Ghost', null),              // unresolved
            makeInjectionSite('User', userEntity, '/external/x.ts'), // unowned
        ];
        const result = mapTypeOrmToGraph(sites, makeOwnership());

        expect(result.diagnostics.counts.resolved).toBe(1);
        expect(result.diagnostics.counts.unresolvedEntity).toBe(1);
        expect(result.diagnostics.counts.unowned).toBe(1);
    });

    it('attaches enclosingClass to db-access edge meta when present', () => {
        const entity = makeEntity('User', 'users');
        const site: TypeOrmInjectionSite = {
            propertyName: 'userRepo',
            entityClass: 'User',
            resolvedEntity: entity,
            location: { file: '/apps/svc/service.ts', line: 5, column: 1 },
            enclosingClass: 'UserService',
        };
        const result = mapTypeOrmToGraph([site], makeOwnership());
        const edge = result.edges.find((e) => e.kind === 'db-access');
        expect(edge?.meta?.enclosingClass).toBe('UserService');
    });

    it('does not attach enclosingClass when absent', () => {
        const entity = makeEntity('User', 'users');
        const site: TypeOrmInjectionSite = {
            propertyName: 'userRepo',
            entityClass: 'User',
            resolvedEntity: entity,
            location: { file: '/apps/svc/service.ts', line: 5, column: 1 },
        };
        const result = mapTypeOrmToGraph([site], makeOwnership());
        const edge = result.edges.find((e) => e.kind === 'db-access');
        expect(edge?.meta).not.toHaveProperty('enclosingClass');
    });
});

// ---------------------------------------------------------------------------
// db-relation edges (new logic)
// ---------------------------------------------------------------------------

describe('mapTypeOrmToGraph — db-relation edges', () => {
    it('emits a db-relation edge for a resolved ManyToOne relation', () => {
        const userEntity = makeEntity('User', 'users', '/apps/svc/user.ts');
        const orderEntity = makeEntity('Order', 'orders', '/apps/svc/order.ts');

        const project = inMemoryProject({
            '/apps/svc/user.ts': `
                import { Entity } from 'typeorm';
                @Entity('users')
                export class User {}
            `,
            '/apps/svc/order.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity('orders')
                export class Order {
                    @ManyToOne(() => User)
                    user: User;
                }
            `,
        });
        const entityIndex = buildEntityIndex(project);
        const relations = extractRelations(project, entityIndex);

        const result = mapTypeOrmToGraph([], makeOwnership(), [], relations, entityIndex);

        const relEdge = result.edges.find((e) => e.kind === 'db-relation');
        expect(relEdge).toBeDefined();
        expect(relEdge?.from).toBe('db-table:orders');
        expect(relEdge?.to).toBe('db-table:users');
        expect(relEdge?.meta?.decorator).toBe('ManyToOne');
        expect(relEdge?.meta?.propertyName).toBe('user');
        expect(relEdge?.meta?.ownerClass).toBe('Order');
        expect(relEdge?.meta?.targetClass).toBe('User');
    });

    it('emits OneToMany db-relation edge', () => {
        const project = inMemoryProject({
            '/apps/svc/user.ts': `
                import { Entity, OneToMany } from 'typeorm';
                @Entity()
                export class User {
                    @OneToMany(() => Order, o => o.user)
                    orders: Order[];
                }
            `,
            '/apps/svc/order.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class Order {}
            `,
        });
        const entityIndex = buildEntityIndex(project);
        const relations = extractRelations(project, entityIndex);
        const result = mapTypeOrmToGraph([], makeOwnership(), [], relations, entityIndex);

        const relEdge = result.edges.find((e) => e.kind === 'db-relation');
        expect(relEdge).toBeDefined();
        expect(relEdge?.meta?.decorator).toBe('OneToMany');
    });

    it('emits ManyToMany db-relation edge', () => {
        const project = inMemoryProject({
            '/apps/svc/post.ts': `
                import { Entity, ManyToMany } from 'typeorm';
                @Entity()
                export class Post {
                    @ManyToMany(() => Tag)
                    tags: Tag[];
                }
            `,
            '/apps/svc/tag.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class Tag {}
            `,
        });
        const entityIndex = buildEntityIndex(project);
        const relations = extractRelations(project, entityIndex);
        const result = mapTypeOrmToGraph([], makeOwnership(), [], relations, entityIndex);

        const relEdge = result.edges.find((e) => e.kind === 'db-relation');
        expect(relEdge).toBeDefined();
        expect(relEdge?.meta?.decorator).toBe('ManyToMany');
    });

    it('emits OneToOne db-relation edge', () => {
        const project = inMemoryProject({
            '/apps/svc/user.ts': `
                import { Entity, OneToOne } from 'typeorm';
                @Entity()
                export class User {
                    @OneToOne(() => Profile)
                    profile: Profile;
                }
            `,
            '/apps/svc/profile.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class Profile {}
            `,
        });
        const entityIndex = buildEntityIndex(project);
        const relations = extractRelations(project, entityIndex);
        const result = mapTypeOrmToGraph([], makeOwnership(), [], relations, entityIndex);

        const relEdge = result.edges.find((e) => e.kind === 'db-relation');
        expect(relEdge).toBeDefined();
        expect(relEdge?.meta?.decorator).toBe('OneToOne');
    });

    it('updates diagnostics.counts.relations for emitted db-relation edges', () => {
        const project = inMemoryProject({
            '/apps/svc/a.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class A {
                    @ManyToOne(() => B)
                    b: B;
                }
            `,
            '/apps/svc/b.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class B {}
            `,
        });
        const entityIndex = buildEntityIndex(project);
        const relations = extractRelations(project, entityIndex);
        const result = mapTypeOrmToGraph([], makeOwnership(), [], relations, entityIndex);

        expect(result.diagnostics.counts.relations).toBe(1);
        expect(result.diagnostics.counts.unresolvedRelations).toBe(0);
    });

    it('pushes unresolved relation (string token) to diagnostics.unresolvedRelations, no edge', () => {
        const unresolvedRel = makeRelation('ManyToOne', 'Order', '', null, 'category');
        const orderEntity = makeEntity('Order', 'orders');

        const project = inMemoryProject({
            '/apps/svc/order.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity('orders')
                export class Order {
                    @ManyToOne('CategoryReference')
                    category: any;
                }
            `,
        });
        const entityIndex = buildEntityIndex(project);
        const relations = extractRelations(project, entityIndex);

        const result = mapTypeOrmToGraph([], makeOwnership(), [], relations, entityIndex);

        expect(result.diagnostics.unresolvedRelations).toHaveLength(1);
        expect(result.diagnostics.counts.unresolvedRelations).toBe(1);
        const relEdges = result.edges.filter((e) => e.kind === 'db-relation');
        expect(relEdges).toHaveLength(0);
    });

    it('emits two distinct db-relation edges for two FK columns on same owner→target', () => {
        const project = inMemoryProject({
            '/apps/svc/order.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Order {
                    @ManyToOne(() => User)
                    buyer: User;

                    @ManyToOne(() => User)
                    seller: User;
                }
            `,
            '/apps/svc/user.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class User {}
            `,
        });
        const entityIndex = buildEntityIndex(project);
        const relations = extractRelations(project, entityIndex);
        const result = mapTypeOrmToGraph([], makeOwnership(), [], relations, entityIndex);

        const relEdges = result.edges.filter((e) => e.kind === 'db-relation');
        expect(relEdges).toHaveLength(2);
        const edgeIds = relEdges.map((e) => e.id).sort();
        expect(edgeIds[0]).toContain('buyer');
        expect(edgeIds[1]).toContain('seller');
    });

    it('creates db-table nodes for entities referenced only in relations (no @InjectRepository)', () => {
        const project = inMemoryProject({
            '/apps/svc/order.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity('orders')
                export class Order {
                    @ManyToOne(() => User)
                    user: User;
                }
            `,
            '/apps/svc/user.ts': `
                import { Entity } from 'typeorm';
                @Entity('users')
                export class User {}
            `,
        });
        const entityIndex = buildEntityIndex(project);
        const relations = extractRelations(project, entityIndex);
        const result = mapTypeOrmToGraph([], makeOwnership(), [], relations, entityIndex);

        const tableIds = result.nodes.filter((n) => n.kind === 'db-table').map((n) => n.id);
        expect(tableIds).toContain('db-table:orders');
        expect(tableIds).toContain('db-table:users');
    });

    it('deduplicates db-table nodes created by both injection and relation for the same table', () => {
        const project = inMemoryProject({
            '/apps/svc/order.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity('orders')
                export class Order {
                    @ManyToOne(() => User)
                    user: User;
                }
            `,
            '/apps/svc/user.ts': `
                import { Entity } from 'typeorm';
                @Entity('users')
                export class User {}
            `,
        });
        const entityIndex = buildEntityIndex(project);
        const relations = extractRelations(project, entityIndex);

        const userEntity = entityIndex.get('User')!;
        const injectionSite = makeInjectionSite('User', userEntity);
        const result = mapTypeOrmToGraph([injectionSite], makeOwnership(), [], relations, entityIndex);

        const tableNodes = result.nodes.filter((n) => n.id === 'db-table:users');
        expect(tableNodes).toHaveLength(1);
    });

    it('sets correct file and line from relation location on db-relation edge', () => {
        const project = inMemoryProject({
            '/apps/svc/order.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Order {
                    @ManyToOne(() => User)
                    user: User;
                }
            `,
            '/apps/svc/user.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class User {}
            `,
        });
        const entityIndex = buildEntityIndex(project);
        const relations = extractRelations(project, entityIndex);
        const result = mapTypeOrmToGraph([], makeOwnership(), [], relations, entityIndex);

        const relEdge = result.edges.find((e) => e.kind === 'db-relation');
        expect(relEdge?.file).toContain('order.ts');
        expect(typeof relEdge?.line).toBe('number');
    });

    it('handles an empty relations array gracefully', () => {
        const result = mapTypeOrmToGraph([], makeOwnership(), [], [], undefined);

        expect(result.diagnostics.counts.relations).toBe(0);
        expect(result.diagnostics.counts.unresolvedRelations).toBe(0);
        expect(result.diagnostics.unresolvedRelations).toHaveLength(0);
    });

    it('handles an unresolved relation with no entityIndex gracefully (falls to unresolved)', () => {
        const orderEntity = makeEntity('Order', 'orders');
        const userEntity = makeEntity('User', 'users');
        // Pass a resolved relation but NO entityIndex — owner lookup returns null
        const rel = makeRelation('ManyToOne', 'Order', 'User', userEntity);

        const result = mapTypeOrmToGraph([], makeOwnership(), [], [rel], undefined);

        // Without entityIndex, ownerEntity lookup returns null → unresolved
        expect(result.diagnostics.unresolvedRelations).toHaveLength(1);
        expect(result.edges.filter((e) => e.kind === 'db-relation')).toHaveLength(0);
    });
});
