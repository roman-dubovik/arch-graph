import { describe, expect, it } from 'vitest';
import {
    getBlueprint,
    getFileOutline,
    getOrientation,
    resolveSymbol,
    selfCheck,
    suggestPlacement,
    validateProposal,
} from './queries.js';
import type { CodeIntelIndex, CodeIntelSymbol } from './types.js';

describe('code-intel queries', () => {
    const mockIndex: CodeIntelIndex = {
        manifest: {
            schemaVersion: 1,
            builtAt: '',
            root: '/root',
            counts: { symbols: 2, calls: 0, flows: 0, branches: 0, impacts: 0 },
        },
        symbols: [
            { id: 's1', kind: 'class', name: 'App', fqn: 'App', file: 'src/app.ts', line: 1, column: 1, endLine: 10 },
            {
                id: 's2',
                kind: 'method',
                name: 'run',
                fqn: 'App.run',
                file: 'src/app.ts',
                line: 5,
                column: 5,
                endLine: 8,
                parentId: 's1',
            },
            { id: 's3', kind: 'dto', name: 'UserDto', fqn: 'UserDto', file: 'libs/dto.ts', line: 10, column: 1, endLine: 15 },
        ],
        calls: [],
        flows: [],
        branches: [],
        impacts: [],
    };

    describe('resolveSymbol', () => {
        it('resolves by exact name', () => {
            const result = resolveSymbol(mockIndex, 'UserDto');
            expect(result.found).toBe(true);
            expect(result.matches[0].fqn).toBe('UserDto');
        });

        it('resolves by partial path', () => {
            const result = resolveSymbol(mockIndex, 'libs/dto.ts');
            expect(result.found).toBe(true);
            expect(result.matches[0].name).toBe('UserDto');
        });

        it('resolves by fuzzy fqn', () => {
            const result = resolveSymbol(mockIndex, 'App.ru');
            expect(result.found).toBe(true);
            expect(result.matches[0].fqn).toBe('App.run');
        });
    });

    describe('getFileOutline', () => {
        it('returns all symbols in a file sorted by location', () => {
            const result = getFileOutline(mockIndex, { file: 'src/app.ts' });
            expect(result.found).toBe(true);
            expect(result.symbols.length).toBe(2);
            expect(result.symbols[0]).toMatchObject({ name: 'App', line: 1, endLine: 10 });
            expect(result.symbols[1]).toMatchObject({ name: 'run', line: 5, endLine: 8 });
        });

        it('handles missing files', () => {
            const result = getFileOutline(mockIndex, { file: 'non-existent.ts' });
            expect(result.found).toBe(false);
        });
    });

    describe('getBlueprint', () => {
        it('returns highest quality symbols first', () => {
            const index: CodeIntelIndex = {
                ...mockIndex,
                symbols: [
                    {
                        id: 'b1',
                        kind: 'dto',
                        name: 'BadDto',
                        fqn: 'BadDto',
                        file: 'a.ts',
                        line: 1,
                        column: 1,
                        qualityScore: 0,
                    },
                    {
                        id: 'b2',
                        kind: 'dto',
                        name: 'GoldDto',
                        fqn: 'GoldDto',
                        file: 'b.ts',
                        line: 1,
                        column: 1,
                        qualityScore: 10,
                    },
                    {
                        id: 'b3',
                        kind: 'dto',
                        name: 'MidDto',
                        fqn: 'MidDto',
                        file: 'c.ts',
                        line: 1,
                        column: 1,
                        qualityScore: 5,
                    },
                ],
            };
            const result = getBlueprint(index, { kind: 'dto' });
            expect(result.found).toBe(true);
            expect(result.blueprints[0].name).toBe('GoldDto');
            expect(result.blueprints[1].name).toBe('MidDto');
        });
    });

    describe('suggestPlacement', () => {
        it('suggests path based on domain match in existing folders', () => {
            const index: CodeIntelIndex = {
                ...mockIndex,
                symbols: [
                    {
                        id: 'p1',
                        kind: 'class',
                        name: 'UsersService',
                        fqn: 'UsersService',
                        file: 'src/modules/users/users.service.ts',
                        line: 1,
                        column: 1,
                    },
                    {
                        id: 'p2',
                        kind: 'class',
                        name: 'OrdersService',
                        fqn: 'OrdersService',
                        file: 'src/modules/orders/orders.service.ts',
                        line: 1,
                        column: 1,
                    },
                ],
            };
            const result = suggestPlacement(index, { name: 'UsersController', kind: 'class' });
            expect(result.found).toBe(true);
            expect(result.suggestions[0].path).toBe('src/modules/users/UsersController.ts');
            expect(result.suggestions[0].reason).toContain("domain 'users'");
        });

        it('falls back to most common folder for the kind', () => {
            const index: CodeIntelIndex = {
                ...mockIndex,
                symbols: [
                    { id: 'p1', kind: 'dto', name: 'A', fqn: 'A', file: 'src/dto/a.ts', line: 1, column: 1 },
                    { id: 'p2', kind: 'dto', name: 'B', fqn: 'B', file: 'src/dto/b.ts', line: 1, column: 1 },
                ],
            };
            const result = suggestPlacement(index, { name: 'NewDto', kind: 'dto' });
            expect(result.found).toBe(true);
            expect(result.suggestions[0].path).toBe('src/dto/NewDto.ts');
        });
    });

    describe('getOrientation', () => {
        it('summarizes monorepo structure', () => {
            const index: CodeIntelIndex = {
                ...mockIndex,
                symbols: [
                    { id: 'a1', kind: 'class', name: 'A', fqn: 'A', file: 'apps/api/src/a.ts', line: 1, column: 1 },
                    { id: 'l1', kind: 'class', name: 'L', fqn: 'L', file: 'libs/common/src/l.ts', line: 1, column: 1 },
                ],
                policies: [
                    {
                        id: 'p1',
                        kind: 'naming',
                        rule: 'DTO naming: *Dto',
                        description: '',
                        confidence: 0.9,
                        count: 10,
                        total: 11,
                    },
                ],
            };
            const result = getOrientation(index);
            expect(result.apps).toContain('api');
            expect(result.libs).toContain('common');
            expect(result.topPolicies[0]).toBe('DTO naming: *Dto');
            expect(result.projectSummary).toContain('1 apps and 1 libs');
        });
    });

    describe('validateProposal', () => {
        const indexWithGuardrails: CodeIntelIndex = {
            ...mockIndex,
            symbols: [
                {
                    id: 'c1',
                    kind: 'class',
                    name: 'ItemsController',
                    fqn: 'ItemsController',
                    file: 'src/items.controller.ts',
                    line: 1,
                    column: 1,
                },
                {
                    id: 's1',
                    kind: 'class',
                    name: 'ItemsService',
                    fqn: 'ItemsService',
                    file: 'src/items.service.ts',
                    line: 1,
                    column: 1,
                },
                {
                    id: 'r1',
                    kind: 'class',
                    name: 'ItemsRepository',
                    fqn: 'ItemsRepository',
                    file: 'src/items.repository.ts',
                    line: 1,
                    column: 1,
                },
            ],
            policies: [
                {
                    id: 'g1',
                    kind: 'guardrail',
                    rule: 'Controller -> !Repository',
                    description: 'Controllers are not allowed to depend on Repositories directly.',
                    confidence: 1,
                    count: 0,
                    total: 0,
                },
            ],
        };

        it('PASS: allows valid layer dependency (Controller -> Service)', () => {
            const proposal = {
                sourceFile: 'src/items.controller.ts',
                sourceKind: 'class' as const,
                proposedImports: ['ItemsService'],
                proposedCalls: ['ItemsService.find'],
            };
            const result = validateProposal(indexWithGuardrails, proposal);
            expect(result.isValid).toBe(true);
            expect(result.violations).toHaveLength(0);
        });

        it('FAIL: blocks invalid layer dependency (Controller -> Repository)', () => {
            const proposal = {
                sourceFile: 'src/items.controller.ts',
                sourceKind: 'class' as const,
                proposedImports: ['ItemsRepository'],
                proposedCalls: ['ItemsRepository.save'],
            };
            const result = validateProposal(indexWithGuardrails, proposal);
            expect(result.isValid).toBe(false);
            expect(result.violations[0].message).toContain('Controllers are not allowed to depend on Repositories');
        });

        it('FAIL: blocks cross-app violation (app A importing from app B)', () => {
            const crossIndex: CodeIntelIndex = {
                ...indexWithGuardrails,
                symbols: [
                    ...indexWithGuardrails.symbols,
                    {
                        id: 's2',
                        kind: 'class',
                        name: 'BillingService',
                        fqn: 'BillingService',
                        file: 'apps/billing/src/billing.service.ts',
                        line: 1,
                        column: 1,
                    },
                ],
            };
            const proposal = {
                sourceFile: 'apps/api/src/items.service.ts',
                sourceKind: 'class' as const,
                proposedImports: ['BillingService'],
                proposedCalls: [],
            };
            const result = validateProposal(crossIndex, proposal);
            expect(result.isValid).toBe(false);
            expect(result.violations[0].message).toContain('Cross-app dependency');
        });

        it('PASS: allows app importing from lib', () => {
            const crossIndex: CodeIntelIndex = {
                ...indexWithGuardrails,
                symbols: [
                    ...indexWithGuardrails.symbols,
                    {
                        id: 'l1',
                        kind: 'class',
                        name: 'CommonLib',
                        fqn: 'CommonLib',
                        file: 'libs/common/src/index.ts',
                        line: 1,
                        column: 1,
                    },
                ],
            };
            const proposal = {
                sourceFile: 'apps/api/src/items.service.ts',
                sourceKind: 'class' as const,
                proposedImports: ['CommonLib'],
                proposedCalls: [],
            };
            const result = validateProposal(crossIndex, proposal);
            expect(result.isValid).toBe(true);
        });
    });

    describe('selfCheck', () => {
        it('Success: reports healthy status for complete index', () => {
            const index: CodeIntelIndex = {
                ...mockIndex,
                manifest: { ...mockIndex.manifest, builtAt: new Date().toISOString() },
                calls: [
                    {
                        id: 'c1',
                        callerId: 's2',
                        caller: 'App.run',
                        callee: 'Other.method',
                        order: 0,
                        file: 'src/app.ts',
                        line: 1,
                        column: 1,
                        args: [],
                    },
                ],
            };
            const result = selfCheck(index);
            expect(result.isHealthy).toBe(true);
            expect(result.issues).toHaveLength(0);
        });

        it('Warning: reports stale index if builtAt is old', () => {
            const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25 hours ago
            const index: CodeIntelIndex = {
                ...mockIndex,
                manifest: { ...mockIndex.manifest, builtAt: oldDate },
            };
            const result = selfCheck(index);
            expect(result.isFresh).toBe(false);
            expect(result.issues[0]).toContain('more than 24 hours ago');
        });

        it('Error: reports broken index if symbols exist but calls are missing', () => {
            const index: CodeIntelIndex = {
                ...mockIndex,
                manifest: { ...mockIndex.manifest, counts: { ...mockIndex.manifest.counts, symbols: 100, calls: 0 } },
                symbols: new Array(100).fill(mockIndex.symbols[0]),
                calls: [],
            };
            const result = selfCheck(index);
            expect(result.isHealthy).toBe(false);
            expect(result.issues).toContain('Index appears broken: 100 symbols found but 0 calls recorded.');
        });
    });
});
