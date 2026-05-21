import { describe, expect, it, vi } from 'vitest';
import type { ClassDeclaration } from 'ts-morph';

import { inMemoryProject } from '../../__fixtures__/in-memory-project.js';
import type { TypeOrmConfig } from '../../core/config.js';
import { buildEntityIndex } from './entity-index.js';
import { extractRelations, getAllProperties } from './relations.js';

// ---------------------------------------------------------------------------
// Helper: build an entity index + extract relations from the same project
// ---------------------------------------------------------------------------
function setup(files: Record<string, string>, typeorm?: TypeOrmConfig) {
    const project = inMemoryProject(files);
    const entityIndex = buildEntityIndex(project);
    const { relations, baseClassCycles } = extractRelations(project, entityIndex, typeorm);
    return { entityIndex, relations, baseClassCycles };
}

// ---------------------------------------------------------------------------
// Single-decorator happy paths
// ---------------------------------------------------------------------------

describe('extractRelations — @ManyToOne', () => {
    it('extracts a @ManyToOne(() => User) relation', () => {
        const { relations } = setup({
            '/apps/svc/order.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Order {
                    @ManyToOne(() => User, user => user.orders)
                    user: User;
                }
            `,
            '/apps/svc/user.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class User {}
            `,
        });

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.decorator).toBe('ManyToOne');
        expect(rel.ownerClass).toBe('Order');
        expect(rel.propertyName).toBe('user');
        expect(rel.targetClass).toBe('User');
        expect(rel.resolvedTarget).not.toBeNull();
        expect(rel.resolvedTarget?.className).toBe('User');
        expect(rel.location.file).toContain('order.entity.ts');
        expect(rel.location.line).toBeGreaterThan(0);
    });

    it('extracts @ManyToOne with options object as second arg', () => {
        const { relations } = setup({
            '/apps/svc/order.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Order {
                    @ManyToOne(() => User, { onDelete: 'CASCADE', onUpdate: 'RESTRICT', nullable: false })
                    user: User;
                }
            `,
            '/apps/svc/user.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class User {}
            `,
        });

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.targetClass).toBe('User');
        expect(rel.resolvedTarget).not.toBeNull();
        expect(rel.onDelete).toBe('CASCADE');
        expect(rel.onUpdate).toBe('RESTRICT');
        expect(rel.nullable).toBe(false);
    });

    it('detects @JoinColumn on the relation property', () => {
        const { relations } = setup({
            '/apps/svc/order.entity.ts': `
                import { Entity, JoinColumn, ManyToOne } from 'typeorm';
                @Entity()
                export class Order {
                    @ManyToOne(() => User, user => user.orders)
                    @JoinColumn({ name: 'user_id' })
                    user: User;
                }
            `,
            '/apps/svc/user.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class User {}
            `,
        });

        expect(relations).toHaveLength(1);
        expect(relations[0]?.joinColumn).toBe(true);
    });
});

describe('extractRelations — configured relation decorators', () => {
    it('maps a custom decorator to a normalized relation type and keeps the source decorator', () => {
        const { relations } = setup(
            {
                '/apps/svc/order.entity.ts': `
                    import { Entity } from 'typeorm';
                    import { ManyToOneWithIndex } from '../decorators/many-to-one-with-index.decorator';
                    @Entity()
                    export class Order {
                        @ManyToOneWithIndex(() => User, user => user.orders)
                        user: User;
                    }
                `,
                '/apps/svc/user.entity.ts': `
                    import { Entity } from 'typeorm';
                    @Entity()
                    export class User {}
                `,
            },
            {
                relationDecorators: [
                    { name: 'ManyToOneWithIndex', mapsTo: 'ManyToOne' },
                ],
            },
        );

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.decorator).toBe('ManyToOne');
        expect(rel.sourceDecorator).toBe('ManyToOneWithIndex');
        expect(rel.ownerClass).toBe('Order');
        expect(rel.propertyName).toBe('user');
        expect(rel.targetClass).toBe('User');
        expect(rel.resolvedTarget?.className).toBe('User');
    });
});

describe('extractRelations — @OneToMany', () => {
    it('extracts a @OneToMany(() => Order) relation', () => {
        const { relations } = setup({
            '/apps/svc/user.entity.ts': `
                import { Entity, OneToMany } from 'typeorm';
                @Entity()
                export class User {
                    @OneToMany(() => Order, order => order.user)
                    orders: Order[];
                }
            `,
            '/apps/svc/order.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class Order {}
            `,
        });

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.decorator).toBe('OneToMany');
        expect(rel.ownerClass).toBe('User');
        expect(rel.targetClass).toBe('Order');
        expect(rel.resolvedTarget?.className).toBe('Order');
        expect(rel.inverseProperty).toBe('user');
    });
});

describe('extractRelations — @ManyToMany', () => {
    it('extracts a @ManyToMany(() => Tag) relation', () => {
        const { relations } = setup({
            '/apps/svc/post.entity.ts': `
                import { Entity, ManyToMany } from 'typeorm';
                @Entity()
                export class Post {
                    @ManyToMany(() => Tag)
                    tags: Tag[];
                }
            `,
            '/apps/svc/tag.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class Tag {}
            `,
        });

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.decorator).toBe('ManyToMany');
        expect(rel.ownerClass).toBe('Post');
        expect(rel.targetClass).toBe('Tag');
        expect(rel.resolvedTarget?.className).toBe('Tag');
    });

    it('detects @JoinTable and explicit join table name on the relation property', () => {
        const { relations } = setup({
            '/apps/svc/post.entity.ts': `
                import { Entity, JoinTable, ManyToMany } from 'typeorm';
                @Entity()
                export class Post {
                    @ManyToMany(() => Tag)
                    @JoinTable({ name: 'post_tags' })
                    tags: Tag[];
                }
            `,
            '/apps/svc/tag.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class Tag {}
            `,
        });

        expect(relations).toHaveLength(1);
        expect(relations[0]?.joinTable).toBe(true);
        expect(relations[0]?.joinTableName).toBe('post_tags');
    });
});

describe('extractRelations — @OneToOne', () => {
    it('extracts a @OneToOne(() => Profile) relation', () => {
        const { relations } = setup({
            '/apps/svc/user.entity.ts': `
                import { Entity, OneToOne } from 'typeorm';
                @Entity()
                export class User {
                    @OneToOne(() => Profile)
                    profile: Profile;
                }
            `,
            '/apps/svc/profile.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class Profile {}
            `,
        });

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.decorator).toBe('OneToOne');
        expect(rel.ownerClass).toBe('User');
        expect(rel.targetClass).toBe('Profile');
        expect(rel.resolvedTarget?.className).toBe('Profile');
    });
});

// ---------------------------------------------------------------------------
// Bare-identifier form: @ManyToOne(Foo) — older TypeORM idiom (CRITICAL fix #1)
// ---------------------------------------------------------------------------

describe('extractRelations — bare-identifier target', () => {
    it('resolves @ManyToOne(User) bare identifier to the entity index', () => {
        const { relations } = setup({
            '/apps/svc/order.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Order {
                    @ManyToOne(User)
                    user: User;
                }
            `,
            '/apps/svc/user.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class User {}
            `,
        });

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.targetClass).toBe('User');
        expect(rel.resolvedTarget).not.toBeNull();
        expect(rel.resolvedTarget?.className).toBe('User');
        expect(rel.reason).toBeUndefined();
    });

    it('returns not-indexed when bare identifier is not a known @Entity', () => {
        const { relations } = setup({
            '/apps/svc/order.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Order {
                    @ManyToOne(SomeExternalClass)
                    ext: any;
                }
            `,
        });

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.targetClass).toBe('SomeExternalClass');
        expect(rel.resolvedTarget).toBeNull();
        expect(rel.reason).toBe('not-indexed');
    });
});

// ---------------------------------------------------------------------------
// String-token form: @ManyToOne('CategoryReference') — forward-ref idiom (CRITICAL fix #2)
// ---------------------------------------------------------------------------

describe('extractRelations — string token target', () => {
    it('resolves @ManyToOne("CategoryReference") when the class is in the entity index', () => {
        const { relations } = setup({
            '/apps/svc/item.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Item {
                    @ManyToOne('Category', cat => cat.items)
                    category: any;
                }
            `,
            '/apps/svc/category.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class Category {}
            `,
        });

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.targetClass).toBe('Category');
        expect(rel.resolvedTarget).not.toBeNull();
        expect(rel.resolvedTarget?.className).toBe('Category');
    });

    it('returns not-indexed for string token when class is not in entity index', () => {
        const { relations } = setup({
            '/apps/svc/item.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Item {
                    @ManyToOne('CategoryReference', cat => cat.items)
                    category: any;
                }
            `,
        });

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        // String form now provides the class name — not-indexed rather than unparseable
        expect(rel.targetClass).toBe('CategoryReference');
        expect(rel.resolvedTarget).toBeNull();
        expect(rel.reason).toBe('not-indexed');
    });
});

// ---------------------------------------------------------------------------
// Arrow without parens: type => Foo (no-parens single-param arrow)
// ---------------------------------------------------------------------------

describe('extractRelations — arrow without parens', () => {
    it('resolves `type => Foo` single-param arrow (no parens)', () => {
        const { relations } = setup({
            '/apps/svc/order.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Order {
                    @ManyToOne(type => User)
                    user: User;
                }
            `,
            '/apps/svc/user.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class User {}
            `,
        });

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.targetClass).toBe('User');
        expect(rel.resolvedTarget).not.toBeNull();
        expect(rel.resolvedTarget?.className).toBe('User');
    });
});

// ---------------------------------------------------------------------------
// forwardRef(() => Foo) — NestJS circular-import helper (HIGH fix #3)
// ---------------------------------------------------------------------------

describe('extractRelations — forwardRef', () => {
    it('resolves forwardRef(() => Foo) when Foo is in entity index', () => {
        const { relations } = setup({
            '/apps/svc/order.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                import { forwardRef } from '@nestjs/common';
                @Entity()
                export class Order {
                    @ManyToOne(() => forwardRef(() => User))
                    user: User;
                }
            `,
            '/apps/svc/user.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class User {}
            `,
        });

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.targetClass).toBe('User');
        expect(rel.resolvedTarget).not.toBeNull();
        expect(rel.resolvedTarget?.className).toBe('User');
    });

    it('falls to unparseable for forwardRef(getTarget()) — non-arrow inner arg', () => {
        const { relations } = setup({
            '/apps/svc/order.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Order {
                    @ManyToOne(() => forwardRef(getTarget()))
                    user: any;
                }
            `,
        });

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.targetClass).toBeNull();
        expect(rel.resolvedTarget).toBeNull();
        expect(rel.reason).toBe('unparseable');
    });

    it('returns not-indexed when forwardRef target is not in entity index', () => {
        const { relations } = setup({
            '/apps/svc/order.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Order {
                    @ManyToOne(() => forwardRef(() => UnknownEntity))
                    user: any;
                }
            `,
        });

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.targetClass).toBe('UnknownEntity');
        expect(rel.resolvedTarget).toBeNull();
        expect(rel.reason).toBe('not-indexed');
    });
});

// ---------------------------------------------------------------------------
// Inheritance: relations on abstract base class (HIGH fix #6)
// ---------------------------------------------------------------------------

describe('extractRelations — inheritance from abstract base', () => {
    it('walks relations declared on an abstract base class', () => {
        const { relations } = setup({
            '/apps/svc/base.entity.ts': `
                import { ManyToOne } from 'typeorm';
                export abstract class BaseEntity {
                    @ManyToOne(() => User)
                    createdBy: User;
                }
            `,
            '/apps/svc/order.entity.ts': `
                import { Entity } from 'typeorm';
                import { BaseEntity } from './base.entity';
                @Entity()
                export class Order extends BaseEntity {}
            `,
            '/apps/svc/user.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class User {}
            `,
        });

        // Order inherits the relation from BaseEntity
        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        // ownerClass must be the concrete entity, not the abstract base
        expect(rel.ownerClass).toBe('Order');
        expect(rel.targetClass).toBe('User');
        expect(rel.resolvedTarget).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Unresolvable targets — now produce discriminated union variants
// ---------------------------------------------------------------------------

describe('extractRelations — dynamic/property-access body', () => {
    it('sets unparseable for arrow with property access body', () => {
        const { relations } = setup({
            '/apps/svc/item.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Item {
                    @ManyToOne(() => entities.Category)
                    category: any;
                }
            `,
        });

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.targetClass).toBeNull();
        expect(rel.resolvedTarget).toBeNull();
        expect(rel.reason).toBe('unparseable');
        expect(typeof rel.raw).toBe('string');
    });

    it('sets unparseable for arrow with call-expression body', () => {
        const { relations } = setup({
            '/apps/svc/item.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Item {
                    @ManyToOne(() => getCategory())
                    category: any;
                }
            `,
        });

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.targetClass).toBeNull();
        expect(rel.resolvedTarget).toBeNull();
        expect(rel.reason).toBe('unparseable');
    });

    it('sets unparseable for no-arg decorator', () => {
        const { relations } = setup({
            '/apps/svc/item.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Item {
                    @ManyToOne()
                    category: any;
                }
            `,
        });

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.targetClass).toBeNull();
        expect(rel.resolvedTarget).toBeNull();
        expect(rel.reason).toBe('unparseable');
    });
});

describe('extractRelations — non-standard first argument', () => {
    it('sets unparseable for a template-literal-with-expression first argument', () => {
        const { relations } = setup({
            '/apps/svc/item.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Item {
                    @ManyToOne(\`\${SomeClass}\`)
                    category: any;
                }
            `,
        });

        // Template literal with substitution is unparseable
        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.targetClass).toBeNull();
        expect(rel.resolvedTarget).toBeNull();
        expect(rel.reason).toBe('unparseable');
    });
});

describe('extractRelations — target known but not in entity index', () => {
    it('sets reason=not-indexed when target class is not a known @Entity', () => {
        const { relations } = setup({
            '/apps/svc/order.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Order {
                    @ManyToOne(() => SomeExternalClass)
                    ext: any;
                }
            `,
            // SomeExternalClass is NOT decorated with @Entity
        });

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.targetClass).toBe('SomeExternalClass');
        expect(rel.resolvedTarget).toBeNull();
        expect(rel.reason).toBe('not-indexed');
    });
});

// ---------------------------------------------------------------------------
// Ownership / exclusion filters
// ---------------------------------------------------------------------------

describe('extractRelations — non-Entity class', () => {
    it('skips properties on classes that are NOT a known @Entity', () => {
        const { relations } = setup({
            '/apps/svc/service.ts': `
                import { ManyToOne } from 'typeorm';
                // No @Entity here
                export class SomeService {
                    @ManyToOne(() => User)
                    user: any;
                }
            `,
            '/apps/svc/user.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class User {}
            `,
        });

        expect(relations).toHaveLength(0);
    });
});

describe('extractRelations — excluded file', () => {
    it('skips files matching isExcludedSourceFile (node_modules)', () => {
        const { relations } = setup({
            '/node_modules/typeorm/entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class NodeModulesEntity {
                    @ManyToOne(() => Other)
                    other: any;
                }
            `,
            '/apps/svc/other.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class Other {}
            `,
        });

        expect(relations).toHaveLength(0);
    });

    it('skips .test.ts files', () => {
        const { relations } = setup({
            '/apps/svc/order.entity.test.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Order {
                    @ManyToOne(() => User)
                    user: any;
                }
            `,
            '/apps/svc/user.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class User {}
            `,
        });

        expect(relations).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Multiple relations
// ---------------------------------------------------------------------------

describe('extractRelations — two relations on same class', () => {
    it('returns two entries for two different relation properties', () => {
        const { relations } = setup({
            '/apps/svc/order.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Order {
                    @ManyToOne(() => User)
                    user: User;

                    @ManyToOne(() => Product)
                    product: Product;
                }
            `,
            '/apps/svc/user.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class User {}
            `,
            '/apps/svc/product.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class Product {}
            `,
        });

        expect(relations).toHaveLength(2);
        const decorators = relations.map((r) => r.propertyName).sort();
        expect(decorators).toEqual(['product', 'user']);
        const targets = relations.map((r) => r.targetClass).sort();
        expect(targets).toEqual(['Product', 'User']);
    });
});

describe('extractRelations — multiple decorator types on two entities', () => {
    it('captures all four relation decorator types', () => {
        const { relations } = setup({
            '/apps/svc/a.entity.ts': `
                import { Entity, ManyToOne, OneToMany, ManyToMany, OneToOne } from 'typeorm';
                @Entity()
                export class A {
                    @ManyToOne(() => B)
                    b1: B;

                    @OneToMany(() => B, b => b.a)
                    b2: B[];

                    @ManyToMany(() => B)
                    b3: B[];

                    @OneToOne(() => B)
                    b4: B;
                }
            `,
            '/apps/svc/b.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class B {}
            `,
        });

        expect(relations).toHaveLength(4);
        const decorators = relations.map((r) => r.decorator).sort();
        expect(decorators).toEqual(['ManyToMany', 'ManyToOne', 'OneToMany', 'OneToOne']);
    });
});

describe('extractRelations — self-referential relation', () => {
    it('resolves a self-join (tree parent) correctly', () => {
        const { relations } = setup({
            '/apps/svc/category.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Category {
                    @ManyToOne(() => Category)
                    parent: Category;
                }
            `,
        });

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.ownerClass).toBe('Category');
        expect(rel.targetClass).toBe('Category');
        expect(rel.resolvedTarget?.className).toBe('Category');
    });
});

describe('extractRelations — location accuracy', () => {
    it('records the correct file path in location', () => {
        const { relations } = setup({
            '/apps/svc/order.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Order {
                    @ManyToOne(() => User)
                    user: User;
                }
            `,
            '/apps/svc/user.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class User {}
            `,
        });

        expect(relations[0]!.location.file).toBe('/apps/svc/order.entity.ts');
        expect(typeof relations[0]!.location.line).toBe('number');
        expect(typeof relations[0]!.location.column).toBe('number');
    });
});

describe('extractRelations — table name propagation', () => {
    it('resolvedTarget has the correct table from the explicit @Entity name', () => {
        const { relations } = setup({
            '/apps/svc/order.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                @Entity()
                export class Order {
                    @ManyToOne(() => Customer)
                    customer: Customer;
                }
            `,
            '/apps/svc/customer.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity('customers')
                export class Customer {}
            `,
        });

        expect(relations).toHaveLength(1);
        expect(relations[0]!.resolvedTarget?.tableSource.table).toBe('customers');
    });
});

// ---------------------------------------------------------------------------
// Regression: getAllProperties cycle guard (CRITICAL fix)
// ---------------------------------------------------------------------------

describe('getAllProperties — cycle guard', () => {
    it('returns [] and does not infinite-loop when getBaseClass() creates a cycle', () => {
        // TypeScript forbids cyclic class extension, but ts-morph's getBaseClass()
        // can return unexpected results on partial / malformed ASTs. We simulate that
        // by hand-rolling a stub whose getBaseClass() returns itself.
        const stub = {
            getName: () => 'CyclicClass',
            getProperties: () => [],
            getBaseClass: function () { return this; },
        } as unknown as ClassDeclaration;

        // Must terminate (no stack overflow) and return empty props.
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const result = getAllProperties(stub);
        expect(result.props).toEqual([]);
        expect(result.cycles).toBe(1);
        // A diagnostic message must have been written to stderr.
        expect(stderrSpy).toHaveBeenCalledWith(
            expect.stringContaining('[typeorm/relations] BUG: circular base class chain'),
        );
        stderrSpy.mockRestore();
    });

    it('returns cycles=1 when a cyclic base-class chain is detected', () => {
        // Use a synthetic self-referential stub because TypeScript's type system
        // forbids cyclic class extension in real source. The cycle guard fires
        // on the second recursive call when `seen.has(cls)` returns true.
        const stub = {
            getName: () => 'CyclicClass',
            getProperties: () => [],
            getBaseClass: function () { return this; },
        } as unknown as ClassDeclaration;

        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const result = getAllProperties(stub);
        stderrSpy.mockRestore();

        expect(result.cycles).toBe(1);
        expect(result.props).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Regression: aliased forwardRef import (HIGH fix)
// ---------------------------------------------------------------------------

describe('extractRelations — aliased forwardRef', () => {
    it('resolves `import { forwardRef as fr }` usage to the entity index', () => {
        const { relations } = setup({
            '/apps/svc/order.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                import { forwardRef as fr } from '@nestjs/common';
                @Entity()
                export class Order {
                    @ManyToOne(() => fr(() => User))
                    user: User;
                }
            `,
            '/apps/svc/user.entity.ts': `
                import { Entity } from 'typeorm';
                @Entity()
                export class User {}
            `,
        });

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.targetClass).toBe('User');
        expect(rel.resolvedTarget).not.toBeNull();
        expect(rel.resolvedTarget?.className).toBe('User');
        expect(rel.reason).toBeUndefined();
    });

    it('falls to unparseable for aliased forwardRef with non-arrow inner arg', () => {
        const { relations } = setup({
            '/apps/svc/order.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                import { forwardRef as fr } from '@nestjs/common';
                @Entity()
                export class Order {
                    @ManyToOne(() => fr(getTarget()))
                    user: any;
                }
            `,
        });

        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.targetClass).toBeNull();
        expect(rel.resolvedTarget).toBeNull();
        expect(rel.reason).toBe('unparseable');
    });

    it('does NOT treat an unrelated alias as forwardRef', () => {
        // `fr` here is imported from a different module — should NOT be treated as forwardRef.
        const { relations } = setup({
            '/apps/svc/order.entity.ts': `
                import { Entity, ManyToOne } from 'typeorm';
                import { someHelper as fr } from './helpers';
                @Entity()
                export class Order {
                    @ManyToOne(() => fr(() => User))
                    user: User;
                }
            `,
        });

        // Arrow body is a CallExpression (fr(...)) but fr is not forwardRef — unparseable
        expect(relations).toHaveLength(1);
        const rel = relations[0]!;
        expect(rel.targetClass).toBeNull();
        expect(rel.resolvedTarget).toBeNull();
        expect(rel.reason).toBe('unparseable');
    });
});
