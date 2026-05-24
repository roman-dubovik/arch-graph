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

        // P1.2 acceptance: two files exporting the same short FQN must both
        // be returned, not silently deduped. The first symbol still wins
        // downstream ranking, but the ambiguity is visible to the caller.
        it('returns all matches when the short FQN is ambiguous across files', () => {
            const dupIndex: CodeIntelIndex = {
                ...mockIndex,
                symbols: [
                    {
                        id: 'symbol:apps/api/items/dto.ts#CreateItemDto:1:1',
                        kind: 'dto',
                        name: 'CreateItemDto',
                        fqn: 'CreateItemDto',
                        file: 'apps/api/items/dto.ts',
                        line: 1,
                        column: 1,
                    },
                    {
                        id: 'symbol:apps/admin/items/dto.ts#CreateItemDto:1:1',
                        kind: 'dto',
                        name: 'CreateItemDto',
                        fqn: 'CreateItemDto',
                        file: 'apps/admin/items/dto.ts',
                        line: 1,
                        column: 1,
                    },
                ],
            };
            const result = resolveSymbol(dupIndex, 'CreateItemDto');
            // Both file-qualified IDs survive the dedupe (which keys on `id`).
            expect(result.matches).toHaveLength(2);
            const files = result.matches.map((m) => m.file).sort();
            expect(files).toEqual(['apps/admin/items/dto.ts', 'apps/api/items/dto.ts']);
        });

        // P1.2 acceptance: a path-suffix query must disambiguate so callers
        // can target one of the duplicates explicitly.
        it('narrows ambiguous FQN matches with a path suffix in the query', () => {
            const dupIndex: CodeIntelIndex = {
                ...mockIndex,
                symbols: [
                    {
                        id: 'symbol:apps/api/items/dto.ts#CreateItemDto:1:1',
                        kind: 'dto',
                        name: 'CreateItemDto',
                        fqn: 'CreateItemDto',
                        file: 'apps/api/items/dto.ts',
                        line: 1,
                        column: 1,
                    },
                    {
                        id: 'symbol:apps/admin/items/dto.ts#CreateItemDto:1:1',
                        kind: 'dto',
                        name: 'CreateItemDto',
                        fqn: 'CreateItemDto',
                        file: 'apps/admin/items/dto.ts',
                        line: 1,
                        column: 1,
                    },
                ],
            };
            const adminOnly = resolveSymbol(dupIndex, 'admin/items/dto.ts');
            expect(adminOnly.matches).toHaveLength(1);
            expect(adminOnly.matches[0]!.file).toBe('apps/admin/items/dto.ts');
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

        // selfCheck contract (revised twice): only REAL silent-wrong-answer
        // risks degrade status.
        //   • Top-level omonymy (two `setup` functions in different files):
        //     normal, surfaces under `info`, status stays `ok`.
        //   • Class-member collisions (two `UsersService.findById` from two
        //     `UsersService` classes): DANGEROUS — downstream tools pick
        //     the first match silently. Goes under `warnings.dangerousCollisions`,
        //     status flips to `degraded`.
        //   • Skipped files: extractor gaps → degraded.
        //   • Malformed manifest: degraded + rebuild message.

        it('stays ok when only top-level (function/type) collisions exist; reports them under info', () => {
            const indexWithBareOmonymy: CodeIntelIndex = {
                ...mockIndex,
                symbols: [
                    // Two top-level functions both called `setup` in different files —
                    // classic harmless omonymy, NOT a silent-wrong-answer risk.
                    { id: 'symbol:apps/a/setup.ts#setup:1:1', kind: 'function', name: 'setup', fqn: 'setup', file: 'apps/a/setup.ts', line: 1, column: 1 },
                    { id: 'symbol:apps/b/setup.ts#setup:1:1', kind: 'function', name: 'setup', fqn: 'setup', file: 'apps/b/setup.ts', line: 1, column: 1 },
                    { id: 'symbol:apps/a/types.ts#DomainKey:1:1', kind: 'type', name: 'DomainKey', fqn: 'DomainKey', file: 'apps/a/types.ts', line: 1, column: 1 },
                    { id: 'symbol:apps/b/types.ts#DomainKey:1:1', kind: 'type', name: 'DomainKey', fqn: 'DomainKey', file: 'apps/b/types.ts', line: 1, column: 1 },
                ],
                manifest: {
                    ...mockIndex.manifest,
                    warnings: { ambiguousFqns: ['setup', 'DomainKey'], skippedFiles: [] },
                } as typeof mockIndex.manifest,
            };
            const result = selfCheck(indexWithBareOmonymy);
            expect(result.status).toBe('ok');
            expect(result.warnings).toBeUndefined();
            expect(result.info).toBeDefined();
            expect(result.info!.nameCollisions).toBe(2);
            expect(result.info!.nameCollisionsSample).toEqual(['setup', 'DomainKey']);
            expect(result.message).toMatch(/normal omonymy/i);
            expect(result.message).toMatch(/path suffix/);
        });

        // P0 fix (silent-failure-hunter round 3): class.method collisions are
        // a REAL silent-wrong-answer class; downstream find_references picks
        // the first by rank without warning. Must degrade, must list them.
        it('reports degraded when class members collide (UsersService.findById × 2)', () => {
            const indexWithClassCollision: CodeIntelIndex = {
                ...mockIndex,
                symbols: [
                    // Two distinct `UsersService` classes, each with `findById`.
                    // `UsersService.findById` now resolves to two real bodies and
                    // `find_references` would pick one silently.
                    { id: 'symbol:apps/api/users.service.ts#UsersService:1:1', kind: 'class', name: 'UsersService', fqn: 'UsersService', file: 'apps/api/users.service.ts', line: 1, column: 1 },
                    { id: 'symbol:apps/api/users.service.ts#findById:5:5', kind: 'method', name: 'findById', fqn: 'UsersService.findById', file: 'apps/api/users.service.ts', line: 5, column: 5, parentId: 'symbol:apps/api/users.service.ts#UsersService:1:1' },
                    { id: 'symbol:apps/admin/users.service.ts#UsersService:1:1', kind: 'class', name: 'UsersService', fqn: 'UsersService', file: 'apps/admin/users.service.ts', line: 1, column: 1 },
                    { id: 'symbol:apps/admin/users.service.ts#findById:5:5', kind: 'method', name: 'findById', fqn: 'UsersService.findById', file: 'apps/admin/users.service.ts', line: 5, column: 5, parentId: 'symbol:apps/admin/users.service.ts#UsersService:1:1' },
                ],
                manifest: {
                    ...mockIndex.manifest,
                    warnings: { ambiguousFqns: ['UsersService', 'UsersService.findById'], skippedFiles: [] },
                } as typeof mockIndex.manifest,
            };
            const result = selfCheck(indexWithClassCollision);
            expect(result.status).toBe('degraded');
            expect(result.warnings).toBeDefined();
            expect(result.warnings!.dangerousCollisions).toEqual(
                expect.arrayContaining(['UsersService', 'UsersService.findById']),
            );
            expect(result.message).toMatch(/class-member collision/i);
            expect(result.message).toMatch(/file-qualified|symbol.*id/i);
        });

        // Parameters of duplicated functions show up in ambiguousFqns as
        // `<funcName>.<paramName>` — these are NOT dangerous (no consumer
        // resolves params to bodies). Verify they don't trigger degraded.
        it('does NOT degrade for function-param collisions (atomicWrite.path × 2)', () => {
            const indexWithParamCollision: CodeIntelIndex = {
                ...mockIndex,
                symbols: [
                    { id: 'symbol:a.ts#atomicWrite:1:1', kind: 'function', name: 'atomicWrite', fqn: 'atomicWrite', file: 'a.ts', line: 1, column: 1 },
                    { id: 'symbol:a.ts#path:1:30', kind: 'param', name: 'path', fqn: 'atomicWrite.path', file: 'a.ts', line: 1, column: 30, parentId: 'symbol:a.ts#atomicWrite:1:1' },
                    { id: 'symbol:b.ts#atomicWrite:1:1', kind: 'function', name: 'atomicWrite', fqn: 'atomicWrite', file: 'b.ts', line: 1, column: 1 },
                    { id: 'symbol:b.ts#path:1:30', kind: 'param', name: 'path', fqn: 'atomicWrite.path', file: 'b.ts', line: 1, column: 30, parentId: 'symbol:b.ts#atomicWrite:1:1' },
                ],
                manifest: {
                    ...mockIndex.manifest,
                    warnings: { ambiguousFqns: ['atomicWrite', 'atomicWrite.path'], skippedFiles: [] },
                } as typeof mockIndex.manifest,
            };
            const result = selfCheck(indexWithParamCollision);
            expect(result.status).toBe('ok');
            expect(result.warnings).toBeUndefined();
            expect(result.info!.nameCollisions).toBe(2);
        });

        it('reports degraded when skippedFiles populated (real gap)', () => {
            const indexWithSkipped: CodeIntelIndex = {
                ...mockIndex,
                manifest: {
                    ...mockIndex.manifest,
                    warnings: { ambiguousFqns: [], skippedFiles: [{ file: 'src/broken.ts', error: 'cyclic type' }] },
                } as typeof mockIndex.manifest,
            };
            const result = selfCheck(indexWithSkipped);
            expect(result.status).toBe('degraded');
            expect(result.warnings).toBeDefined();
            expect(result.warnings!.skippedFiles).toHaveLength(1);
            expect(result.warnings!.dangerousCollisions).toBeUndefined();
            expect(result.message).toMatch(/could not be parsed/i);
            expect(result.message).toMatch(/arch-graph code-intel build/);
        });

        it('combines skipped + class-collision in one degraded verdict', () => {
            const indexWithBoth: CodeIntelIndex = {
                ...mockIndex,
                symbols: [
                    { id: 'symbol:a.ts#Svc:1:1', kind: 'class', name: 'Svc', fqn: 'Svc', file: 'a.ts', line: 1, column: 1 },
                    { id: 'symbol:a.ts#m:5:5', kind: 'method', name: 'm', fqn: 'Svc.m', file: 'a.ts', line: 5, column: 5, parentId: 'symbol:a.ts#Svc:1:1' },
                    { id: 'symbol:b.ts#Svc:1:1', kind: 'class', name: 'Svc', fqn: 'Svc', file: 'b.ts', line: 1, column: 1 },
                    { id: 'symbol:b.ts#m:5:5', kind: 'method', name: 'm', fqn: 'Svc.m', file: 'b.ts', line: 5, column: 5, parentId: 'symbol:b.ts#Svc:1:1' },
                ],
                manifest: {
                    ...mockIndex.manifest,
                    warnings: {
                        ambiguousFqns: ['Svc', 'Svc.m'],
                        skippedFiles: [{ file: 'src/broken.ts', error: 'cyclic' }],
                    },
                } as typeof mockIndex.manifest,
            };
            const result = selfCheck(indexWithBoth);
            expect(result.status).toBe('degraded');
            expect(result.warnings!.skippedFiles).toHaveLength(1);
            expect(result.warnings!.dangerousCollisions).toHaveLength(2);
        });

        it('reports ok when warnings exist but are empty', () => {
            const indexWithEmptyWarnings: CodeIntelIndex = {
                ...mockIndex,
                manifest: {
                    ...mockIndex.manifest,
                    warnings: { ambiguousFqns: [], skippedFiles: [] },
                } as typeof mockIndex.manifest,
            };
            const result = selfCheck(indexWithEmptyWarnings);
            expect(result.status).toBe('ok');
            expect(result.warnings).toBeUndefined();
            expect(result.info).toBeUndefined();
        });

        // Fix round 2: distinguish ABSENT (legacy index, OK) from PRESENT-BUT-MALFORMED
        // (corrupt manifest, must surface as degraded — not silently healthy).
        it('reports degraded when warnings is present but malformed (wrong-type fields)', () => {
            const indexWithMalformed: CodeIntelIndex = {
                ...mockIndex,
                manifest: {
                    ...mockIndex.manifest,
                    // Real-world corruption shape: user/external tool wrote a string
                    // instead of an array, or a number, or omitted the field entirely.
                    warnings: { ambiguousFqns: 'garbage' as unknown as string[], skippedFiles: 42 as unknown as Array<{ file: string; error: string }> },
                } as typeof mockIndex.manifest,
            };
            const result = selfCheck(indexWithMalformed);
            expect(result.status).toBe('degraded');
            expect(result.message).toMatch(/malformed.*rebuild/i);
        });

        it('reports ok when manifest.warnings is undefined (legacy index)', () => {
            // mockIndex has no warnings field — simulates a legacy index built before
            // warnings were tracked.
            const result = selfCheck(mockIndex);
            expect(result.status).toBe('ok');
            expect(result.warnings).toBeUndefined();
        });
    });
});
