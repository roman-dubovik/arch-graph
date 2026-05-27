import { describe, expect, it } from 'vitest';

import { selfCheck } from './queries.js';
import type { CodeIntelIndex, CodeIntelSymbol } from './types.js';

/**
 * Feature `feat/self-check-actionable-status-v1` — semantic fix to status.
 *
 * Problem: `status: 'degraded'` previously fired whenever `dangerousCollisions
 * > 0`. On NestJS monorepos that's almost always thousands of cross-service
 * fanout duplicates — NORMAL, NOT a silent-wrong-answer risk (the LLM
 * disambiguates by file path). LLMs reading the MCP description saw
 * "degraded → real silent-wrong-answer risk" and refused to use the tools.
 *
 * Fix:
 *  1. `status: 'degraded'` ONLY when:
 *       - skippedFiles.length > 0 (extractor parse failures), OR
 *       - intraServiceDuplicates > 0 (two symbols same FQN in same package —
 *         likely real copy-paste bug)
 *  2. `warnings.dangerousCollisions` contains ONLY the intra-service list
 *     (actionable). Cross-service + class-level fanout → `info`.
 *  3. `info.collisionBreakdown` retained, gives breakdown counts.
 *  4. Status `ok` with cross-service / class-level fanout reports them
 *     via `info.expectedCollisions` (NOT warnings) so the LLM knows
 *     they exist but isn't scared.
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

function methodSym(id: string, fqn: string, file: string): CodeIntelSymbol {
    return { id, kind: 'method', name: fqn.split('.').pop()!, fqn, file, line: 1, column: 1 };
}

describe('selfCheck — actionable status (degraded ONLY on real bugs)', () => {
    it('status=ok when ONLY cross-service fanout exists (no intra-service bugs)', () => {
        // Classic NestJS pattern: AreaController defined per-microservice.
        // Each has its own bff/audit version. This is EXPECTED, not a bug.
        const symbols: CodeIntelSymbol[] = [
            classSym('s:c1', 'AreaController', 'packages/audit/src/area.controller.ts'),
            classSym('s:c2', 'AreaController', 'packages/bff/src/area.controller.ts'),
            methodSym('s:m1', 'AreaController.create', 'packages/audit/src/area.controller.ts'),
            methodSym('s:m2', 'AreaController.create', 'packages/bff/src/area.controller.ts'),
        ];
        const index: CodeIntelIndex = {
            manifest: { ...BASE_MANIFEST, warnings: { ambiguousFqns: ['AreaController', 'AreaController.create'], skippedFiles: [] } },
            symbols, calls: [], impacts: [], flows: [], branches: [],
        };

        const sc = selfCheck(index);

        // KEY FIX: status is `ok`, not `degraded`, despite the dup.
        expect(sc.status).toBe('ok');
        // dangerousCollisions empty or undefined — these fanout dups are not warnings.
        expect(sc.warnings?.dangerousCollisions ?? []).toEqual([]);
        // The LLM still knows about them via info.collisionBreakdown.
        const breakdown = (sc.info as unknown as {
            collisionBreakdown?: {
                crossServiceDuplicates: number;
                classLevel: number;
                intraServiceDuplicates: number;
            };
        } | undefined)?.collisionBreakdown;
        expect(breakdown).toBeDefined();
        expect((breakdown!.crossServiceDuplicates + breakdown!.classLevel)).toBeGreaterThan(0);
    });

    it('status=degraded when intra-service duplicate exists (real bug)', () => {
        // TWO files in ONE microservice declare AreaController. Copy-paste leftover.
        // LLM picking the "wrong" file is a real disambiguation problem.
        const symbols: CodeIntelSymbol[] = [
            classSym('s:c1', 'AreaController', 'packages/audit/src/x/area.controller.ts'),
            classSym('s:c2', 'AreaController', 'packages/audit/src/y/area.controller.ts'),
            methodSym('s:m1', 'AreaController.create', 'packages/audit/src/x/area.controller.ts'),
            methodSym('s:m2', 'AreaController.create', 'packages/audit/src/y/area.controller.ts'),
        ];
        const index: CodeIntelIndex = {
            manifest: { ...BASE_MANIFEST, warnings: { ambiguousFqns: ['AreaController', 'AreaController.create'], skippedFiles: [] } },
            symbols, calls: [], impacts: [], flows: [], branches: [],
        };

        const sc = selfCheck(index);

        expect(sc.status).toBe('degraded');
        // Real intra-service bugs surface in dangerousCollisions.
        expect((sc.warnings?.dangerousCollisions ?? []).length).toBeGreaterThan(0);
    });

    it('status=degraded when skippedFiles > 0 (extractor parse failure)', () => {
        const index: CodeIntelIndex = {
            manifest: {
                ...BASE_MANIFEST,
                warnings: {
                    ambiguousFqns: [],
                    skippedFiles: [{ file: 'foo.ts', error: 'parse error' }],
                },
            },
            symbols: [], calls: [], impacts: [], flows: [], branches: [],
        };

        const sc = selfCheck(index);
        expect(sc.status).toBe('degraded');
    });

    it('status=ok with both cross-service AND class-level (still expected fanout)', () => {
        const symbols: CodeIntelSymbol[] = [
            // class-level dup (FooDto in two services) — expected
            { id: 's:dto1', kind: 'dto', name: 'FooDto', fqn: 'FooDto', file: 'packages/a/src/foo.dto.ts', line: 1, column: 1 },
            { id: 's:dto2', kind: 'dto', name: 'FooDto', fqn: 'FooDto', file: 'packages/b/src/foo.dto.ts', line: 1, column: 1 },
            // cross-service method dup
            classSym('s:c1', 'BarController', 'packages/a/src/bar.controller.ts'),
            classSym('s:c2', 'BarController', 'packages/b/src/bar.controller.ts'),
            methodSym('s:m1', 'BarController.get', 'packages/a/src/bar.controller.ts'),
            methodSym('s:m2', 'BarController.get', 'packages/b/src/bar.controller.ts'),
        ];
        const index: CodeIntelIndex = {
            manifest: {
                ...BASE_MANIFEST,
                warnings: { ambiguousFqns: ['FooDto', 'BarController', 'BarController.get'], skippedFiles: [] },
            },
            symbols, calls: [], impacts: [], flows: [], branches: [],
        };

        const sc = selfCheck(index);

        expect(sc.status).toBe('ok');
        expect(sc.warnings?.dangerousCollisions ?? []).toEqual([]);
    });

    it('status=ok with NO collisions at all', () => {
        const index: CodeIntelIndex = {
            manifest: { ...BASE_MANIFEST, warnings: { ambiguousFqns: [], skippedFiles: [] } },
            symbols: [], calls: [], impacts: [], flows: [], branches: [],
        };
        expect(selfCheck(index).status).toBe('ok');
    });

    it('message clearly distinguishes "expected fanout" from "real bug"', () => {
        // Cross-service only → message says "fanout, normal", NOT "wrong file silently".
        const symbols: CodeIntelSymbol[] = [
            classSym('s:c1', 'Foo', 'packages/a/src/foo.ts'),
            classSym('s:c2', 'Foo', 'packages/b/src/foo.ts'),
        ];
        const index: CodeIntelIndex = {
            manifest: { ...BASE_MANIFEST, warnings: { ambiguousFqns: ['Foo'], skippedFiles: [] } },
            symbols, calls: [], impacts: [], flows: [], branches: [],
        };

        const sc = selfCheck(index);

        // Status must be `ok` so LLM agents don't refuse to use other tools.
        expect(sc.status).toBe('ok');
        // Message must mention "normal fanout"-style reassurance.
        expect(sc.message.toLowerCase()).toMatch(/(cross.service|fanout|normal|expected)/);
        // Must NOT use scary "degraded" / "dangerous" framing for this case.
        expect(sc.message.toLowerCase()).not.toContain('degraded');
        expect(sc.message.toLowerCase()).not.toContain('dangerous');
    });
});
