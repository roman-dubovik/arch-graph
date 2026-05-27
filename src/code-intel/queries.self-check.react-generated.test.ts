import { describe, expect, it } from 'vitest';

import { selfCheck } from './queries.js';
import type { CodeIntelIndex, CodeIntelSymbol } from './types.js';

/**
 * Feature `feat/self-check-react-and-generated-filters-v1` —
 * two additional noise filters for `selfCheck`:
 *
 *   D) **React-local `IProps`-style interfaces**.
 *      Every `.tsx` component file declares a local `interface IProps { ... }`
 *      (also `IFormProps`, `IOwnProps`, `IRouteProps`, etc. — the
 *      Hungarian-`I[A-Z]` React convention). These are local-only types
 *      shared in name across the project but never imported across files.
 *      A collision in `IProps.isLoading` across 80 .tsx files is NOT a
 *      disambiguation risk — every component has its own IProps.
 *
 *      Filter rule: a field collision is noise when the field's parent is
 *      `kind: 'type'` (or 'dto') with a name matching `/^I[A-Z]/` AND ALL
 *      duplicate files end in `.tsx`. Pure backend `.ts` files are NOT
 *      filtered — those collisions still matter.
 *
 *   E) **Generated-file collisions**.
 *      Auto-generated API clients (`*-api.generated.ts`) declare duplicate
 *      DTO types (one per OpenAPI tag → one `UserDto` per generated file).
 *      Collisions where ALL duplicate copies live in `*.generated.*` files
 *      are noise — they're codegen output, not author-written code.
 */

const BASE_MANIFEST = {
    schemaVersion: 2,
    builtAt: new Date().toISOString(),
    root: '/root',
    counts: { symbols: 0, calls: 0, flows: 0, branches: 0, impacts: 0 },
};

function typeSym(id: string, name: string, file: string): CodeIntelSymbol {
    return { id, kind: 'type', name, fqn: name, file, line: 1, column: 1 };
}

function dtoSym(id: string, name: string, file: string): CodeIntelSymbol {
    return { id, kind: 'dto', name, fqn: name, file, line: 1, column: 1 };
}

function fieldSym(id: string, fqn: string, file: string, parentId: string): CodeIntelSymbol {
    return {
        id,
        kind: 'field',
        name: fqn.split('.').pop()!,
        fqn,
        file,
        line: 1,
        column: 1,
        parentId,
        ownerName: fqn.split('.')[0],
    };
}

describe('selfCheck — React IProps (D) + generated-file (E) filters', () => {
    describe('D: React-local IProps interfaces in .tsx files', () => {
        it('filters IProps.isLoading collision across many .tsx files (all parents are local Hungarian-I types)', () => {
            const symbols: CodeIntelSymbol[] = [
                typeSym('s:t1', 'IProps', 'packages/svc1/fe-host-app/src/app/components/foo.tsx'),
                typeSym('s:t2', 'IProps', 'packages/svc1/fe-host-app/src/app/components/bar.tsx'),
                typeSym('s:t3', 'IProps', 'packages/svc1/fe-host-app/src/app/components/baz.tsx'),
                fieldSym('s:f1', 'IProps.isLoading', 'packages/svc1/fe-host-app/src/app/components/foo.tsx', 's:t1'),
                fieldSym('s:f2', 'IProps.isLoading', 'packages/svc1/fe-host-app/src/app/components/bar.tsx', 's:t2'),
                fieldSym('s:f3', 'IProps.isLoading', 'packages/svc1/fe-host-app/src/app/components/baz.tsx', 's:t3'),
            ];
            const index: CodeIntelIndex = {
                manifest: { ...BASE_MANIFEST, warnings: { ambiguousFqns: ['IProps', 'IProps.isLoading'], skippedFiles: [] } },
                symbols, calls: [], flows: [], branches: [], impacts: [],
            };

            const sc = selfCheck(index);

            // The field collision must be filtered as structural noise.
            expect(sc.warnings?.dangerousCollisions ?? []).not.toContain('IProps.isLoading');
            // The class-level IProps collision is filtered too — IProps in .tsx
            // is a React convention, not a real type-disambiguation risk.
            expect(sc.warnings?.dangerousCollisions ?? []).not.toContain('IProps');
        });

        it('also filters IFormProps / IOwnProps / IRouteProps (any `I[A-Z]...`)', () => {
            const symbols: CodeIntelSymbol[] = [
                typeSym('s:t1', 'IFormProps', 'packages/svc1/fe-host-app/src/app/components/form-a.tsx'),
                typeSym('s:t2', 'IFormProps', 'packages/svc1/fe-host-app/src/app/components/form-b.tsx'),
                fieldSym('s:f1', 'IFormProps.onSubmit', 'packages/svc1/fe-host-app/src/app/components/form-a.tsx', 's:t1'),
                fieldSym('s:f2', 'IFormProps.onSubmit', 'packages/svc1/fe-host-app/src/app/components/form-b.tsx', 's:t2'),
            ];
            const index: CodeIntelIndex = {
                manifest: { ...BASE_MANIFEST, warnings: { ambiguousFqns: ['IFormProps', 'IFormProps.onSubmit'], skippedFiles: [] } },
                symbols, calls: [], flows: [], branches: [], impacts: [],
            };

            const sc = selfCheck(index);

            expect(sc.warnings?.dangerousCollisions ?? []).not.toContain('IFormProps.onSubmit');
            expect(sc.warnings?.dangerousCollisions ?? []).not.toContain('IFormProps');
        });

        it('does NOT filter IProps when some duplicates live in .ts files (mixed backend/frontend type)', () => {
            // If one of the copies is a backend `.ts` file, the type might be
            // imported across the codebase — keep it dangerous to be safe.
            const symbols: CodeIntelSymbol[] = [
                typeSym('s:t1', 'IProps', 'packages/svc1/fe-host-app/src/app/components/foo.tsx'),
                typeSym('s:t2', 'IProps', 'packages/svc1/audit/src/internals/props.ts'),
                fieldSym('s:f1', 'IProps.id', 'packages/svc1/fe-host-app/src/app/components/foo.tsx', 's:t1'),
                fieldSym('s:f2', 'IProps.id', 'packages/svc1/audit/src/internals/props.ts', 's:t2'),
            ];
            const index: CodeIntelIndex = {
                manifest: { ...BASE_MANIFEST, warnings: { ambiguousFqns: ['IProps', 'IProps.id'], skippedFiles: [] } },
                symbols, calls: [], flows: [], branches: [], impacts: [],
            };

            const sc = selfCheck(index);

            expect(sc.warnings?.dangerousCollisions ?? []).toContain('IProps');
        });

        it('does NOT filter type names that do NOT match the `I[A-Z]` convention', () => {
            // `Props` (no `I` prefix) → could be a real shared type.
            const symbols: CodeIntelSymbol[] = [
                typeSym('s:t1', 'Props', 'packages/svc1/fe-host-app/src/app/components/foo.tsx'),
                typeSym('s:t2', 'Props', 'packages/svc1/fe-host-app/src/app/components/bar.tsx'),
                fieldSym('s:f1', 'Props.value', 'packages/svc1/fe-host-app/src/app/components/foo.tsx', 's:t1'),
                fieldSym('s:f2', 'Props.value', 'packages/svc1/fe-host-app/src/app/components/bar.tsx', 's:t2'),
            ];
            const index: CodeIntelIndex = {
                manifest: { ...BASE_MANIFEST, warnings: { ambiguousFqns: ['Props', 'Props.value'], skippedFiles: [] } },
                symbols, calls: [], flows: [], branches: [], impacts: [],
            };

            const sc = selfCheck(index);

            expect(sc.warnings?.dangerousCollisions ?? []).toContain('Props');
        });
    });

    describe('E: generated-file collisions', () => {
        it('filters UserDto.id duplicates when ALL copies live in `*.generated.ts` files', () => {
            const symbols: CodeIntelSymbol[] = [
                dtoSym('s:d1', 'UserDto', 'packages/svc1/fe-host-app/src/app/data/api/user-api.generated.ts'),
                dtoSym('s:d2', 'UserDto', 'packages/svc1/fe-host-app/src/app/data/api/orbita-api.generated.ts'),
                fieldSym('s:f1', 'UserDto.id', 'packages/svc1/fe-host-app/src/app/data/api/user-api.generated.ts', 's:d1'),
                fieldSym('s:f2', 'UserDto.id', 'packages/svc1/fe-host-app/src/app/data/api/orbita-api.generated.ts', 's:d2'),
            ];
            const index: CodeIntelIndex = {
                manifest: { ...BASE_MANIFEST, warnings: { ambiguousFqns: ['UserDto', 'UserDto.id'], skippedFiles: [] } },
                symbols, calls: [], flows: [], branches: [], impacts: [],
            };

            const sc = selfCheck(index);

            // Both the type-level and field-level collisions are filtered when
            // every copy is in a *.generated.* file.
            expect(sc.warnings?.dangerousCollisions ?? []).not.toContain('UserDto');
            expect(sc.warnings?.dangerousCollisions ?? []).not.toContain('UserDto.id');
        });

        it('does NOT filter when at least one copy is in a hand-written file (mixed gen/manual)', () => {
            const symbols: CodeIntelSymbol[] = [
                dtoSym('s:d1', 'UserDto', 'packages/svc1/fe-host-app/src/app/data/api/user-api.generated.ts'),
                dtoSym('s:d2', 'UserDto', 'packages/svc1/user-service/src/dto/user.dto.ts'),
                fieldSym('s:f1', 'UserDto.id', 'packages/svc1/fe-host-app/src/app/data/api/user-api.generated.ts', 's:d1'),
                fieldSym('s:f2', 'UserDto.id', 'packages/svc1/user-service/src/dto/user.dto.ts', 's:d2'),
            ];
            const index: CodeIntelIndex = {
                manifest: { ...BASE_MANIFEST, warnings: { ambiguousFqns: ['UserDto', 'UserDto.id'], skippedFiles: [] } },
                symbols, calls: [], flows: [], branches: [], impacts: [],
            };

            const sc = selfCheck(index);

            expect(sc.warnings?.dangerousCollisions ?? []).toContain('UserDto');
        });
    });

    describe('breakdown integration', () => {
        it('counts React + generated noise inside `structuralNoise`', () => {
            const symbols: CodeIntelSymbol[] = [
                // Real intra-service bug (stays)
                typeSym('s:real1', 'BugType', 'packages/svc1/audit/src/x/bug.ts'),
                typeSym('s:real2', 'BugType', 'packages/svc1/audit/src/y/bug.ts'),
                // React noise (filtered)
                typeSym('s:r1', 'IProps', 'packages/svc1/fe-host-app/src/app/components/foo.tsx'),
                typeSym('s:r2', 'IProps', 'packages/svc1/fe-host-app/src/app/components/bar.tsx'),
                fieldSym('s:rf1', 'IProps.isLoading', 'packages/svc1/fe-host-app/src/app/components/foo.tsx', 's:r1'),
                fieldSym('s:rf2', 'IProps.isLoading', 'packages/svc1/fe-host-app/src/app/components/bar.tsx', 's:r2'),
                // Generated noise (filtered)
                dtoSym('s:g1', 'UserDto', 'packages/svc1/fe-host-app/src/app/data/api/a.generated.ts'),
                dtoSym('s:g2', 'UserDto', 'packages/svc1/fe-host-app/src/app/data/api/b.generated.ts'),
                fieldSym('s:gf1', 'UserDto.id', 'packages/svc1/fe-host-app/src/app/data/api/a.generated.ts', 's:g1'),
                fieldSym('s:gf2', 'UserDto.id', 'packages/svc1/fe-host-app/src/app/data/api/b.generated.ts', 's:g2'),
            ];
            const index: CodeIntelIndex = {
                manifest: {
                    ...BASE_MANIFEST,
                    warnings: {
                        ambiguousFqns: ['BugType', 'IProps', 'IProps.isLoading', 'UserDto', 'UserDto.id'],
                        skippedFiles: [],
                    },
                },
                symbols, calls: [], flows: [], branches: [], impacts: [],
            };

            const sc = selfCheck(index);
            const dangerous = sc.warnings?.dangerousCollisions ?? [];

            // Only the real bug stays dangerous.
            expect(dangerous).toContain('BugType');
            expect(dangerous).not.toContain('IProps');
            expect(dangerous).not.toContain('IProps.isLoading');
            expect(dangerous).not.toContain('UserDto');
            expect(dangerous).not.toContain('UserDto.id');

            const breakdown = (sc.info as unknown as {
                collisionBreakdown?: {
                    structuralNoise: number;
                    crossServiceDuplicates: number;
                    intraServiceDuplicates: number;
                    classLevel: number;
                };
            } | undefined)?.collisionBreakdown;
            expect(breakdown?.structuralNoise).toBe(4); // IProps + IProps.isLoading + UserDto + UserDto.id
            expect(breakdown?.classLevel).toBe(1);      // BugType
        });
    });
});
