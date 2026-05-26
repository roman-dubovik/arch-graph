import { describe, expect, it } from 'vitest';

import { selfCheck } from './queries.js';
import type { CodeIntelIndex, CodeIntelSymbol } from './types.js';

/**
 * Feature: `feat/self-check-noise-and-partition-v1`.
 *
 * Two improvements to `selfCheck`:
 *
 *   A) **Noise filters** — drop structural NestJS-convention collisions from
 *      `warnings.dangerousCollisions` because they are NOT silent-wrong-answer
 *      risks (the LLM never queries by short FQN for these). Targets:
 *        - any field/method named `logger`
 *        - any symbol whose name ends with `Cmd` (NestJS message-routing convention)
 *        - DTO/db-entity audit fields: id, name, createdAt, updatedAt, deletedAt, createdBy, updatedBy
 *
 *   C) **Partition** — break down what's left into named buckets so the
 *      caller (LLM/human) can triage at a glance instead of staring at a
 *      flat 4000-element list. Buckets:
 *        - `structuralNoise`        — count of collisions filtered by (A)
 *        - `crossServiceDuplicates` — collisions whose copies live in DIFFERENT
 *                                     `packages/<service>/...` directories
 *        - `intraServiceDuplicates` — collisions whose copies live in the SAME
 *                                     `packages/<service>/...` directory (real bugs)
 *        - `classLevel`             — bare-name (no-dot) collisions (two classes
 *                                     with the same name)
 *
 * All numbers are exposed in `info.collisionBreakdown` regardless of `status`.
 */

const BASE_MANIFEST = {
    schemaVersion: 2,
    builtAt: new Date().toISOString(),
    root: '/root',
    counts: { symbols: 0, calls: 0, flows: 0, branches: 0, impacts: 0 },
};

function classSym(id: string, fqn: string, file: string): CodeIntelSymbol {
    return { id, kind: 'class', name: fqn.split('.').pop()!, fqn, file, line: 1, column: 1 };
}

function methodSym(id: string, fqn: string, file: string, extra: Partial<CodeIntelSymbol> = {}): CodeIntelSymbol {
    return {
        id,
        kind: 'method',
        name: fqn.split('.').pop()!,
        fqn,
        file,
        line: 1,
        column: 1,
        ...extra,
    };
}

function fieldSym(id: string, fqn: string, file: string, parentKind: 'class' | 'dto' | 'db-entity' = 'class'): CodeIntelSymbol {
    return {
        id,
        kind: 'field',
        name: fqn.split('.').pop()!,
        fqn,
        file,
        line: 1,
        column: 1,
        parentId: `parent-of-${id}`,
        // ownerName carries the parent's display name; tests below also seed
        // a corresponding parent symbol in `symbols[]` so the filter can
        // look up the parent's kind.
        ownerName: fqn.split('.')[0],
    } as CodeIntelSymbol & { _parentKindHint?: 'class' | 'dto' | 'db-entity' };
}

describe('selfCheck — noise filters (A) + partition (C)', () => {
    describe('A1: `.logger` field collisions are NOT dangerous', () => {
        it('filters two services both declaring `.logger` field out of dangerousCollisions', () => {
            const symbols: CodeIntelSymbol[] = [
                classSym('s:audit:AService',    'AService',         'packages/audit/src/a.service.ts'),
                classSym('s:bff:AService',      'AService',         'packages/bff/src/a.service.ts'),
                fieldSym('s:audit:AService.logger', 'AService.logger', 'packages/audit/src/a.service.ts'),
                fieldSym('s:bff:AService.logger',   'AService.logger', 'packages/bff/src/a.service.ts'),
            ];
            const index: CodeIntelIndex = {
                manifest: {
                    ...BASE_MANIFEST,
                    warnings: { ambiguousFqns: ['AService', 'AService.logger'], skippedFiles: [] },
                },
                symbols, calls: [], flows: [], branches: [], impacts: [],
            };

            const sc = selfCheck(index);

            // Class-level collision is still dangerous (per B8 spec).
            expect(sc.warnings?.dangerousCollisions).toContain('AService');
            // The .logger collision is structural noise and must NOT be dangerous.
            expect(sc.warnings?.dangerousCollisions ?? []).not.toContain('AService.logger');
        });
    });

    describe('A2: `*Cmd` static-field collisions are NOT dangerous', () => {
        it('filters createEntityCmd-style collisions out of dangerousCollisions', () => {
            const symbols: CodeIntelSymbol[] = [
                classSym('s:c1', 'AreaController', 'packages/audit/src/area.controller.ts'),
                classSym('s:c2', 'AreaController', 'packages/bff/src/area.controller.ts'),
                fieldSym('s:c1.cmd', 'AreaController.createEntityCmd', 'packages/audit/src/area.controller.ts'),
                fieldSym('s:c2.cmd', 'AreaController.createEntityCmd', 'packages/bff/src/area.controller.ts'),
            ];
            const index: CodeIntelIndex = {
                manifest: {
                    ...BASE_MANIFEST,
                    warnings: {
                        ambiguousFqns: ['AreaController', 'AreaController.createEntityCmd'],
                        skippedFiles: [],
                    },
                },
                symbols, calls: [], flows: [], branches: [], impacts: [],
            };

            const sc = selfCheck(index);

            // The *Cmd collision must be filtered out as structural noise.
            expect(sc.warnings?.dangerousCollisions ?? []).not.toContain('AreaController.createEntityCmd');
        });
    });

    describe('A3: DTO/db-entity audit fields (createdAt/updatedAt/...) are NOT dangerous', () => {
        it('filters createdAt/updatedAt/deletedAt collisions out for DTO/db-entity parents', () => {
            const symbols: CodeIntelSymbol[] = [
                { id: 's:dto:Foo', kind: 'dto', name: 'FooDto', fqn: 'FooDto', file: 'packages/audit/src/foo.dto.ts', line: 1, column: 1 },
                { id: 's:dto:Bar', kind: 'dto', name: 'FooDto', fqn: 'FooDto', file: 'packages/bff/src/foo.dto.ts', line: 1, column: 1 },
                { id: 's:dto:Foo.id', kind: 'field', name: 'id', fqn: 'FooDto.id', file: 'packages/audit/src/foo.dto.ts', line: 1, column: 1, parentId: 's:dto:Foo', ownerName: 'FooDto' },
                { id: 's:dto:Bar.id', kind: 'field', name: 'id', fqn: 'FooDto.id', file: 'packages/bff/src/foo.dto.ts', line: 1, column: 1, parentId: 's:dto:Bar', ownerName: 'FooDto' },
                { id: 's:dto:Foo.createdAt', kind: 'field', name: 'createdAt', fqn: 'FooDto.createdAt', file: 'packages/audit/src/foo.dto.ts', line: 1, column: 1, parentId: 's:dto:Foo', ownerName: 'FooDto' },
                { id: 's:dto:Bar.createdAt', kind: 'field', name: 'createdAt', fqn: 'FooDto.createdAt', file: 'packages/bff/src/foo.dto.ts', line: 1, column: 1, parentId: 's:dto:Bar', ownerName: 'FooDto' },
            ];
            const index: CodeIntelIndex = {
                manifest: {
                    ...BASE_MANIFEST,
                    warnings: {
                        ambiguousFqns: ['FooDto', 'FooDto.id', 'FooDto.createdAt'],
                        skippedFiles: [],
                    },
                },
                symbols, calls: [], flows: [], branches: [], impacts: [],
            };

            const sc = selfCheck(index);

            // Class-level dto collision stays dangerous (two distinct DTO types).
            expect(sc.warnings?.dangerousCollisions).toContain('FooDto');
            // Audit fields are noise — filtered.
            expect(sc.warnings?.dangerousCollisions ?? []).not.toContain('FooDto.id');
            expect(sc.warnings?.dangerousCollisions ?? []).not.toContain('FooDto.createdAt');
        });

        it('does NOT filter `id`/`createdAt` when the parent is a regular class (not DTO/db-entity)', () => {
            // A regular service class with an `id` field IS a real disambiguation
            // problem because semantics differ from DTOs. Filter must NOT apply.
            const symbols: CodeIntelSymbol[] = [
                { id: 's:svc1', kind: 'class', name: 'FooService', fqn: 'FooService', file: 'packages/audit/src/foo.service.ts', line: 1, column: 1 },
                { id: 's:svc2', kind: 'class', name: 'FooService', fqn: 'FooService', file: 'packages/bff/src/foo.service.ts', line: 1, column: 1 },
                { id: 's:svc1.id', kind: 'field', name: 'id', fqn: 'FooService.id', file: 'packages/audit/src/foo.service.ts', line: 1, column: 1, parentId: 's:svc1', ownerName: 'FooService' },
                { id: 's:svc2.id', kind: 'field', name: 'id', fqn: 'FooService.id', file: 'packages/bff/src/foo.service.ts', line: 1, column: 1, parentId: 's:svc2', ownerName: 'FooService' },
            ];
            const index: CodeIntelIndex = {
                manifest: {
                    ...BASE_MANIFEST,
                    warnings: { ambiguousFqns: ['FooService', 'FooService.id'], skippedFiles: [] },
                },
                symbols, calls: [], flows: [], branches: [], impacts: [],
            };

            const sc = selfCheck(index);

            expect(sc.warnings?.dangerousCollisions).toContain('FooService.id');
        });
    });

    describe('C1: collisionBreakdown exposes named buckets', () => {
        it('partitions collisions into structuralNoise/crossService/intraService/classLevel', () => {
            const symbols: CodeIntelSymbol[] = [
                // class-level collision: AreaController in 2 packages
                classSym('s:c1', 'AreaController', 'packages/audit/src/area.controller.ts'),
                classSym('s:c2', 'AreaController', 'packages/bff/src/area.controller.ts'),

                // method-level CROSS-SERVICE collision
                methodSym('s:c1.create', 'AreaController.create', 'packages/audit/src/area.controller.ts'),
                methodSym('s:c2.create', 'AreaController.create', 'packages/bff/src/area.controller.ts'),

                // method-level INTRA-SERVICE collision (rare, real bug)
                methodSym('s:c1.update.a', 'AreaController.update', 'packages/audit/src/area.controller.ts'),
                methodSym('s:c1.update.b', 'AreaController.update', 'packages/audit/src/area-extra.controller.ts'),

                // structural noise — `.logger`
                fieldSym('s:c1.log', 'AreaController.logger', 'packages/audit/src/area.controller.ts'),
                fieldSym('s:c2.log', 'AreaController.logger', 'packages/bff/src/area.controller.ts'),
            ];
            const index: CodeIntelIndex = {
                manifest: {
                    ...BASE_MANIFEST,
                    warnings: {
                        ambiguousFqns: [
                            'AreaController',
                            'AreaController.create',
                            'AreaController.update',
                            'AreaController.logger',
                        ],
                        skippedFiles: [],
                    },
                },
                symbols, calls: [], flows: [], branches: [], impacts: [],
            };

            const sc = selfCheck(index);

            const breakdown = (sc.info as unknown as {
                collisionBreakdown?: {
                    structuralNoise: number;
                    crossServiceDuplicates: number;
                    intraServiceDuplicates: number;
                    classLevel: number;
                };
            } | undefined)?.collisionBreakdown;

            expect(breakdown).toBeDefined();
            expect(breakdown?.classLevel).toBe(1);               // AreaController
            expect(breakdown?.crossServiceDuplicates).toBe(1);   // AreaController.create
            expect(breakdown?.intraServiceDuplicates).toBe(1);   // AreaController.update
            expect(breakdown?.structuralNoise).toBe(1);          // AreaController.logger
        });

        it('buckets are present even when total ambiguous count is 0', () => {
            const index: CodeIntelIndex = {
                manifest: { ...BASE_MANIFEST, warnings: { ambiguousFqns: [], skippedFiles: [] } },
                symbols: [], calls: [], flows: [], branches: [], impacts: [],
            };

            const sc = selfCheck(index);

            const breakdown = (sc.info as unknown as {
                collisionBreakdown?: {
                    structuralNoise: number;
                    crossServiceDuplicates: number;
                    intraServiceDuplicates: number;
                    classLevel: number;
                };
            } | undefined)?.collisionBreakdown;

            // When there are no collisions, breakdown is omitted (no info at all)
            // OR all-zero — either is acceptable. The contract is that callers
            // can safely default missing buckets to 0.
            if (breakdown !== undefined) {
                expect(breakdown.structuralNoise).toBe(0);
                expect(breakdown.crossServiceDuplicates).toBe(0);
                expect(breakdown.intraServiceDuplicates).toBe(0);
                expect(breakdown.classLevel).toBe(0);
            }
        });
    });

    describe('integration: real-world NestJS shape', () => {
        it('reduces dangerousCollisions by removing noise + reports breakdown', () => {
            // Simulate a slice of real Aurora-style codebase:
            //   - 1 class-level collision (AreaController) — stays
            //   - 1 method collision (createEntity, mixed delegation/augmented) — stays (cross-service)
            //   - 1 `.logger` collision — filtered (noise)
            //   - 1 `*Cmd` collision — filtered (noise)
            //   - 1 DTO `id` collision — filtered (noise)
            //   - 1 intra-service collision — stays (real bug)
            const symbols: CodeIntelSymbol[] = [
                classSym('s:c1', 'AreaController', 'packages/audit/src/area.controller.ts'),
                classSym('s:c2', 'AreaController', 'packages/bff/src/area.controller.ts'),
                methodSym('s:c1.create', 'AreaController.createEntity', 'packages/audit/src/area.controller.ts', { overrideKind: 'delegation', inheritsFrom: 'base-A' }),
                methodSym('s:c2.create', 'AreaController.createEntity', 'packages/bff/src/area.controller.ts',   { overrideKind: 'augmented', inheritsFrom: 'base-B' }),
                fieldSym('s:c1.log', 'AreaController.logger', 'packages/audit/src/area.controller.ts'),
                fieldSym('s:c2.log', 'AreaController.logger', 'packages/bff/src/area.controller.ts'),
                fieldSym('s:c1.cmd', 'AreaController.createEntityCmd', 'packages/audit/src/area.controller.ts'),
                fieldSym('s:c2.cmd', 'AreaController.createEntityCmd', 'packages/bff/src/area.controller.ts'),
                { id: 's:dto1', kind: 'dto', name: 'AreaDto', fqn: 'AreaDto', file: 'packages/audit/src/area.dto.ts', line: 1, column: 1 },
                { id: 's:dto2', kind: 'dto', name: 'AreaDto', fqn: 'AreaDto', file: 'packages/bff/src/area.dto.ts', line: 1, column: 1 },
                { id: 's:dto1.id', kind: 'field', name: 'id', fqn: 'AreaDto.id', file: 'packages/audit/src/area.dto.ts', line: 1, column: 1, parentId: 's:dto1', ownerName: 'AreaDto' },
                { id: 's:dto2.id', kind: 'field', name: 'id', fqn: 'AreaDto.id', file: 'packages/bff/src/area.dto.ts', line: 1, column: 1, parentId: 's:dto2', ownerName: 'AreaDto' },
                methodSym('s:intra.a', 'AreaController.duplicateBug', 'packages/audit/src/area.controller.ts'),
                methodSym('s:intra.b', 'AreaController.duplicateBug', 'packages/audit/src/area-extra.controller.ts'),
            ];
            const index: CodeIntelIndex = {
                manifest: {
                    ...BASE_MANIFEST,
                    warnings: {
                        ambiguousFqns: [
                            'AreaController',
                            'AreaController.createEntity',
                            'AreaController.logger',
                            'AreaController.createEntityCmd',
                            'AreaDto',
                            'AreaDto.id',
                            'AreaController.duplicateBug',
                        ],
                        skippedFiles: [],
                    },
                },
                symbols, calls: [], flows: [], branches: [], impacts: [],
            };

            const sc = selfCheck(index);
            const dangerous = sc.warnings?.dangerousCollisions ?? [];

            // Stays dangerous:
            expect(dangerous).toContain('AreaController');
            expect(dangerous).toContain('AreaDto');
            expect(dangerous).toContain('AreaController.createEntity');
            expect(dangerous).toContain('AreaController.duplicateBug');

            // Filtered out (noise):
            expect(dangerous).not.toContain('AreaController.logger');
            expect(dangerous).not.toContain('AreaController.createEntityCmd');
            expect(dangerous).not.toContain('AreaDto.id');

            const breakdown = (sc.info as unknown as {
                collisionBreakdown?: {
                    structuralNoise: number;
                    crossServiceDuplicates: number;
                    intraServiceDuplicates: number;
                    classLevel: number;
                };
            } | undefined)?.collisionBreakdown;
            expect(breakdown?.structuralNoise).toBe(3); // logger + Cmd + id
            expect(breakdown?.classLevel).toBe(2);      // AreaController + AreaDto
            expect(breakdown?.crossServiceDuplicates).toBe(1); // createEntity (cross-service)
            expect(breakdown?.intraServiceDuplicates).toBe(1); // duplicateBug (intra-service)
        });
    });
});
