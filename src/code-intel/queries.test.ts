import { describe, expect, it } from 'vitest';
import {
    getBlueprint,
    getFileOutline,
    getOrientation,
    getTypeDefinition,
    findReferences,
    resolveSymbol,
    selfCheck,
    suggestPlacement,
    traceExceptions,
    validateProposal,
} from './queries.js';
import type { CodeIntelIndex } from './types.js';

describe('code-intel queries', () => {
    const mockIndex: CodeIntelIndex = {
        manifest: {
            schemaVersion: 2,
            builtAt: new Date().toISOString(),
            root: '/root',
            counts: { symbols: 4, calls: 0, flows: 0, branches: 0, impacts: 0 },
            health: { freshness: 'Updated now', symbols: 4 },
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
            { id: 's4', kind: 'field', name: 'id', fqn: 'UserDto.id', file: 'libs/dto.ts', line: 11, column: 5, parentId: 's3' },
        ],
        calls: [],
        flows: [],
        branches: [],
        impacts: [],
    };

    describe('resolveSymbol', () => {
        it('resolves by exact name', () => {
            const result = resolveSymbol(mockIndex, 'UserDto');
            expect(result.matches.length).toBeGreaterThan(0);
            expect(result.matches[0].fqn).toBe('UserDto');
        });

        it('resolves by partial path', () => {
            const result = resolveSymbol(mockIndex, 'libs/dto.ts');
            expect(result.matches.length).toBeGreaterThan(0);
            expect(result.matches[0].name).toBe('UserDto');
        });
    });

    describe('getFileOutline', () => {
        it('returns all symbols in a file sorted by location', () => {
            const result = getFileOutline(mockIndex, { file: 'src/app.ts' });
            expect(result.symbols.length).toBe(2);
            expect(result.symbols[0]).toMatchObject({ name: 'App', line: 1, endLine: 10 });
        });
    });

    describe('getTypeDefinition', () => {
        it('returns members for a DTO', () => {
            const result = getTypeDefinition(mockIndex, { symbol: 'UserDto' });
            expect(result.found).toBe(true);
            expect(result.members.find(m => m.name === 'id')).toBeDefined();
        });
    });

    describe('findReferences', () => {
        it('finds references for a symbol', () => {
            const indexWithRefs: CodeIntelIndex = {
                ...mockIndex,
                calls: [{ id: 'c1', callerId: 's100', caller: 'Other.m', callee: 'App.run', calleeId: 's2', order: 0, file: 'f.ts', line: 1, column: 1, expression: 'app.run()', args: [] }],
            };
            const result = findReferences(indexWithRefs, { symbol: 'App.run' });
            expect(result.references.length).toBe(1);
            expect(result.references[0].kind).toBe('call');
        });
    });

    describe('traceExceptions', () => {
        it('finds bubbling exceptions from an entry point', () => {
            const indexWithThrows: CodeIntelIndex = {
                ...mockIndex,
                calls: [{ id: 'c1', callerId: 's2', caller: 'App.run', callee: 'Sub.m', calleeId: 's100', order: 0, file: 'f.ts', line: 1, column: 1, expression: 'sub.m()', args: [] }],
                branches: [{ id: 'b1', functionId: 's100', functionName: 'Sub.m', condition: 'throw new Error()', thenText: 'throw', file: 'sub.ts', line: 10, column: 1, nestedIn: [], calls: [] }],
            };
            const result = traceExceptions(indexWithThrows, { entry: 'App.run' });
            expect(result.found).toBe(true);
            expect(result.throws.length).toBe(1);
            expect(result.throws[0].type).toBe('new Error()');
        });
    });

    describe('getBlueprint', () => {
        it('returns highest quality symbols first', () => {
            const index: CodeIntelIndex = {
                ...mockIndex,
                symbols: [
                    { id: 'b1', kind: 'dto', name: 'Bad', fqn: 'Bad', file: 'a.ts', line: 1, column: 1, qualityScore: 0 },
                    { id: 'b2', kind: 'dto', name: 'Gold', fqn: 'Gold', file: 'b.ts', line: 1, column: 1, qualityScore: 10 },
                ],
            };
            const result = getBlueprint(index, { kind: 'dto' });
            expect(result.topExamples[0].name).toBe('Gold');
        });
    });

    describe('getOrientation', () => {
        it('summarizes monorepo structure from paths', () => {
            const indexWithPaths: CodeIntelIndex = {
                ...mockIndex,
                symbols: [
                    ...mockIndex.symbols,
                    { id: 'a1', kind: 'class', name: 'A', fqn: 'A', file: 'apps/api/src/a.ts', line: 1, column: 1 },
                    { id: 'l1', kind: 'class', name: 'L', fqn: 'L', file: 'libs/common/src/l.ts', line: 1, column: 1 },
                ]
            };
            const result = getOrientation(indexWithPaths);
            expect(result.projectSummary).toContain('1 apps and 1 libs');
        });
    });

    describe('selfCheck', () => {
        it('Success: reports status', () => {
            const result = selfCheck(mockIndex);
            expect(result.status).toBe('ok');
            expect(result.symbols).toBe(4);
        });
    });
});
