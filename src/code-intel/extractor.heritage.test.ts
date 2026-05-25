import { describe, expect, it } from 'vitest';

import { inMemoryProject } from '../__fixtures__/in-memory-project.js';
import { extractCodeIntel } from './extractor.js';

const ROOT = '/root';

describe('extractCodeIntel — heritage v1 (RED)', () => {
    describe('A1: extendsClass + extendsTypeArgs on class symbols', () => {
        it('captures extendsClass id for a subclass extending a base in the same file', () => {
            const project = inMemoryProject({
                '/root/src/x.ts': `
                    export abstract class FooBase {
                        async run(): Promise<void> {}
                    }
                    export class FooImpl extends FooBase {}
                `,
            });

            const index = extractCodeIntel(project, { root: ROOT });

            const fooBase = index.symbols.find((s) => s.fqn === 'FooBase');
            const fooImpl = index.symbols.find((s) => s.fqn === 'FooImpl');

            expect(fooBase).toBeDefined();
            expect(fooImpl).toBeDefined();
            expect(fooImpl?.extendsClass).toBe(fooBase!.id);
        });

        it('leaves extendsClass undefined on a class without extends', () => {
            const project = inMemoryProject({
                '/root/src/x.ts': `
                    export class Loner {}
                `,
            });

            const index = extractCodeIntel(project, { root: ROOT });

            const loner = index.symbols.find((s) => s.fqn === 'Loner');
            expect(loner).toBeDefined();
            expect(loner?.extendsClass).toBeUndefined();
            expect(loner?.extendsTypeArgs).toBeUndefined();
        });

        it('captures extendsTypeArgs verbatim from the extends clause', () => {
            const project = inMemoryProject({
                '/root/src/x.ts': `
                    export class FooEntity {}
                    export class FooCreateDto {}
                    export abstract class GenericBase<TEntity, TCreateDto> {
                        async create(dto: TCreateDto): Promise<TEntity> {
                            return null as unknown as TEntity;
                        }
                    }
                    export class FooService extends GenericBase<FooEntity, FooCreateDto> {}
                `,
            });

            const index = extractCodeIntel(project, { root: ROOT });

            const fooService = index.symbols.find((s) => s.fqn === 'FooService');
            expect(fooService?.extendsTypeArgs).toEqual(['FooEntity', 'FooCreateDto']);
        });
    });

    describe('A2: inheritsFrom + overrideKind on methods', () => {
        it('classifies pure-delegation override (return super.X(args), no transform)', () => {
            const project = inMemoryProject({
                '/root/src/x.ts': `
                    export class FooBase {
                        async run(dto: { id: string }): Promise<void> {}
                    }
                    export class FooImpl extends FooBase {
                        async run(dto: { id: string }): Promise<void> {
                            return super.run(dto);
                        }
                    }
                `,
            });

            const index = extractCodeIntel(project, { root: ROOT });

            const baseRun = index.symbols.find((s) => s.fqn === 'FooBase.run');
            const implRun = index.symbols.find((s) => s.fqn === 'FooImpl.run');

            expect(baseRun).toBeDefined();
            expect(implRun?.inheritsFrom).toBe(baseRun!.id);
            expect(implRun?.overrideKind).toBe('delegation');
        });

        it('classifies augmented override (super + extra statements)', () => {
            const project = inMemoryProject({
                '/root/src/x.ts': `
                    export class FooBase {
                        async run(dto: { id: string }): Promise<void> {}
                    }
                    export class FooImpl extends FooBase {
                        async run(dto: { id: string }): Promise<void> {
                            this.audit(dto);
                            return super.run(dto);
                        }
                        audit(_dto: { id: string }): void {}
                    }
                `,
            });

            const index = extractCodeIntel(project, { root: ROOT });

            const implRun = index.symbols.find((s) => s.fqn === 'FooImpl.run');
            expect(implRun?.overrideKind).toBe('augmented');
            const baseRun = index.symbols.find((s) => s.fqn === 'FooBase.run');
            expect(implRun?.inheritsFrom).toBe(baseRun!.id);
        });

        it('classifies replaced override (no super reference at all)', () => {
            const project = inMemoryProject({
                '/root/src/x.ts': `
                    export class FooBase {
                        async run(dto: { id: string }): Promise<void> {}
                    }
                    export class FooImpl extends FooBase {
                        async run(_dto: { id: string }): Promise<void> {
                            await Promise.resolve();
                        }
                    }
                `,
            });

            const index = extractCodeIntel(project, { root: ROOT });

            const implRun = index.symbols.find((s) => s.fqn === 'FooImpl.run');
            expect(implRun?.overrideKind).toBe('replaced');
            const baseRun = index.symbols.find((s) => s.fqn === 'FooBase.run');
            expect(implRun?.inheritsFrom).toBe(baseRun!.id);
        });

        it('treats super with transformed args as augmented, not delegation', () => {
            const project = inMemoryProject({
                '/root/src/x.ts': `
                    export class FooBase {
                        async run(dto: { id: string; touched?: boolean }): Promise<void> {}
                    }
                    export class FooImpl extends FooBase {
                        async run(dto: { id: string; touched?: boolean }): Promise<void> {
                            return super.run({ ...dto, touched: true });
                        }
                    }
                `,
            });

            const index = extractCodeIntel(project, { root: ROOT });

            const implRun = index.symbols.find((s) => s.fqn === 'FooImpl.run');
            expect(implRun?.overrideKind).toBe('augmented');
        });

        it('does not set inheritsFrom on a method that only exists in the subclass', () => {
            const project = inMemoryProject({
                '/root/src/x.ts': `
                    export class FooBase {
                        async run(): Promise<void> {}
                    }
                    export class FooImpl extends FooBase {
                        async ownMethod(): Promise<void> {}
                    }
                `,
            });

            const index = extractCodeIntel(project, { root: ROOT });

            const own = index.symbols.find((s) => s.fqn === 'FooImpl.ownMethod');
            expect(own).toBeDefined();
            expect(own?.inheritsFrom).toBeUndefined();
            expect(own?.overrideKind).toBeUndefined();
        });
    });

    describe('A3: super-call edges in calls', () => {
        it('emits a super-call edge from subclass method to base method', () => {
            const project = inMemoryProject({
                '/root/src/x.ts': `
                    export class FooBase {
                        async run(dto: { id: string }): Promise<void> {}
                    }
                    export class FooImpl extends FooBase {
                        async run(dto: { id: string }): Promise<void> {
                            return super.run(dto);
                        }
                    }
                `,
            });

            const index = extractCodeIntel(project, { root: ROOT });

            const implRun = index.symbols.find((s) => s.fqn === 'FooImpl.run')!;
            const baseRun = index.symbols.find((s) => s.fqn === 'FooBase.run')!;

            const superCall = index.calls.find(
                (c) => c.callerId === implRun.id && c.kind === 'super-call',
            );

            expect(superCall).toBeDefined();
            expect(superCall?.calleeId).toBe(baseRun.id);
            expect(superCall?.expression).toMatch(/super\.run\(/);
        });

        it('does not emit a super-call edge when there is no super reference', () => {
            const project = inMemoryProject({
                '/root/src/x.ts': `
                    export class FooBase {
                        async run(): Promise<void> {}
                    }
                    export class FooImpl extends FooBase {
                        async run(): Promise<void> {
                            await Promise.resolve();
                        }
                    }
                `,
            });

            const index = extractCodeIntel(project, { root: ROOT });

            const superCalls = index.calls.filter((c) => c.kind === 'super-call');
            expect(superCalls).toHaveLength(0);
        });
    });

    describe('A4: cross-file base class resolution', () => {
        it('resolves base via relative same-package import', () => {
            const project = inMemoryProject({
                '/root/src/base/base.controller.ts': `
                    export class FooBase {
                        async run(_id: string): Promise<void> {}
                    }
                `,
                '/root/src/feature/foo.controller.ts': `
                    import { FooBase } from '../base/base.controller';
                    export class FooImpl extends FooBase {
                        async run(id: string): Promise<void> {
                            return super.run(id);
                        }
                    }
                `,
            });

            const index = extractCodeIntel(project, { root: ROOT });

            const fooBase = index.symbols.find((s) => s.fqn === 'FooBase');
            const fooImpl = index.symbols.find((s) => s.fqn === 'FooImpl');

            expect(fooBase).toBeDefined();
            expect(fooImpl?.extendsClass).toBe(fooBase!.id);

            const implRun = index.symbols.find((s) => s.fqn === 'FooImpl.run')!;
            const baseRun = index.symbols.find((s) => s.fqn === 'FooBase.run')!;
            expect(implRun.inheritsFrom).toBe(baseRun.id);
            expect(implRun.overrideKind).toBe('delegation');
        });

        it('resolves base via tsconfig path alias re-exported from a barrel', () => {
            const project = inMemoryProject({
                '/root/libs/shared/src/index.ts': `
                    export { FooBase } from './base.controller';
                `,
                '/root/libs/shared/src/base.controller.ts': `
                    export class FooBase {
                        async run(): Promise<void> {}
                    }
                `,
                '/root/packages/feature/src/foo.controller.ts': `
                    import { FooBase } from '@workspace/shared';
                    export class FooImpl extends FooBase {
                        async run(): Promise<void> {
                            return super.run();
                        }
                    }
                `,
                '/root/tsconfig.base.json': JSON.stringify({
                    compilerOptions: {
                        paths: {
                            '@workspace/shared': ['libs/shared/src/index.ts'],
                        },
                    },
                }),
            });

            const index = extractCodeIntel(project, { root: ROOT });

            const fooBase = index.symbols.find((s) => s.fqn === 'FooBase');
            const fooImpl = index.symbols.find((s) => s.fqn === 'FooImpl');

            expect(fooBase).toBeDefined();
            expect(fooImpl?.extendsClass).toBe(fooBase!.id);
        });
    });

    describe('A5: generic type-arg propagation', () => {
        it('captures extendsTypeArgs for multi-arg generics across files', () => {
            const project = inMemoryProject({
                '/root/src/base.ts': `
                    export abstract class GenericBase<TEntity, TCreateDto, TUpdateDto> {
                        async create(dto: TCreateDto): Promise<TEntity> {
                            return null as unknown as TEntity;
                        }
                        async update(dto: TUpdateDto): Promise<TEntity> {
                            return null as unknown as TEntity;
                        }
                    }
                `,
                '/root/src/feature.ts': `
                    import { GenericBase } from './base';
                    export class FooEntity {}
                    export class FooCreateDto {}
                    export class FooUpdateDto {}
                    export class FooService extends GenericBase<FooEntity, FooCreateDto, FooUpdateDto> {}
                `,
            });

            const index = extractCodeIntel(project, { root: ROOT });

            const fooService = index.symbols.find((s) => s.fqn === 'FooService');
            expect(fooService?.extendsTypeArgs).toEqual([
                'FooEntity',
                'FooCreateDto',
                'FooUpdateDto',
            ]);
        });
    });

    describe('A6: multi-level inheritance chain', () => {
        it('each subclass points to its direct parent in a 4-level chain', () => {
            const project = inMemoryProject({
                '/root/src/x.ts': `
                    export abstract class LevelA {
                        async run(): Promise<void> {}
                    }
                    export abstract class LevelB extends LevelA {}
                    export abstract class LevelC extends LevelB {}
                    export class LevelD extends LevelC {
                        async run(): Promise<void> {
                            return super.run();
                        }
                    }
                `,
            });

            const index = extractCodeIntel(project, { root: ROOT });

            const a = index.symbols.find((s) => s.fqn === 'LevelA')!;
            const b = index.symbols.find((s) => s.fqn === 'LevelB')!;
            const c = index.symbols.find((s) => s.fqn === 'LevelC')!;
            const d = index.symbols.find((s) => s.fqn === 'LevelD')!;

            expect(a.extendsClass).toBeUndefined();
            expect(b.extendsClass).toBe(a.id);
            expect(c.extendsClass).toBe(b.id);
            expect(d.extendsClass).toBe(c.id);

            // LevelD.run inherits from LevelA.run (the only concrete declaration
            // along the chain) — climbing through intermediate empty levels.
            const dRun = index.symbols.find((s) => s.fqn === 'LevelD.run');
            const aRun = index.symbols.find((s) => s.fqn === 'LevelA.run');
            expect(dRun?.inheritsFrom).toBe(aRun!.id);
        });
    });

    describe('A7: per-class isolation', () => {
        it('a class with an unresolvable base does not break extraction of clean classes', () => {
            const project = inMemoryProject({
                '/root/src/clean.ts': `
                    export class CleanBase {}
                    export class CleanSub extends CleanBase {}
                `,
                // Imports a name that doesn't exist anywhere — heritage
                // resolution must fail per-class and not abort the file.
                '/root/src/broken.ts': `
                    // @ts-expect-error — intentional: unresolved base used to
                    // exercise heritage-pass isolation.
                    import { NonExistentBase } from './does-not-exist';
                    export class BrokenSub extends NonExistentBase {}
                `,
            });

            const index = extractCodeIntel(project, { root: ROOT });

            const cleanBase = index.symbols.find((s) => s.fqn === 'CleanBase');
            const cleanSub = index.symbols.find((s) => s.fqn === 'CleanSub');
            const brokenSub = index.symbols.find((s) => s.fqn === 'BrokenSub');

            expect(cleanSub?.extendsClass).toBe(cleanBase!.id);
            // BrokenSub still exists as a symbol; its heritage is simply
            // unresolved (no extendsClass). Other classes unaffected.
            expect(brokenSub).toBeDefined();
            expect(brokenSub?.extendsClass).toBeUndefined();
        });
    });
});
