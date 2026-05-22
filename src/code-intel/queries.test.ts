import { describe, expect, it } from 'vitest';
import { getBlueprint, getFileOutline, getOrientation, resolveSymbol, suggestPlacement } from './queries.js';
import type { CodeIntelIndex, CodeIntelSymbol } from './types.js';

describe('code-intel queries', () => {
    const mockIndex: CodeIntelIndex = {
        manifest: { schemaVersion: 1, builtAt: '', root: '/root', counts: { symbols: 2, calls: 0, flows: 0, branches: 0, impacts: 0 } },
        symbols: [
            { id: 's1', kind: 'class', name: 'App', fqn: 'App', file: 'src/app.ts', line: 1, column: 1, endLine: 10 },
            { id: 's2', kind: 'method', name: 'run', fqn: 'App.run', file: 'src/app.ts', line: 5, column: 5, endLine: 8, parentId: 's1' },
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
                    { id: 'b1', kind: 'dto', name: 'BadDto', fqn: 'BadDto', file: 'a.ts', line: 1, column: 1, qualityScore: 0 },
                    { id: 'b2', kind: 'dto', name: 'GoldDto', fqn: 'GoldDto', file: 'b.ts', line: 1, column: 1, qualityScore: 10 },
                    { id: 'b3', kind: 'dto', name: 'MidDto', fqn: 'MidDto', file: 'c.ts', line: 1, column: 1, qualityScore: 5 },
                ]
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
                    { id: 'p1', kind: 'class', name: 'UsersService', fqn: 'UsersService', file: 'src/modules/users/users.service.ts', line: 1, column: 1 },
                    { id: 'p2', kind: 'class', name: 'OrdersService', fqn: 'OrdersService', file: 'src/modules/orders/orders.service.ts', line: 1, column: 1 },
                ]
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
                ]
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
                    { id: 'p1', kind: 'naming', rule: 'DTO naming: *Dto', description: '', confidence: 0.9, count: 10, total: 11 }
                ]
            };
            const result = getOrientation(index);
            expect(result.apps).toContain('api');
            expect(result.libs).toContain('common');
            expect(result.topPolicies[0]).toBe('DTO naming: *Dto');
            expect(result.projectSummary).toContain('1 apps and 1 libs');
        });
    });
});
