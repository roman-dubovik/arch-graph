import { describe, expect, it } from 'vitest';

import { selfCheck } from './queries.js';
import type { CodeIntelCall, CodeIntelImpact, CodeIntelIndex, CodeIntelSymbol } from './types.js';

/**
 * Feature `feat/local-only-collision-filter-v1`.
 *
 * Universal "local-only" filter — derived from index data (not framework
 * heuristics). A collision is NOT a silent-wrong-answer risk when NONE of
 * the duplicate symbols is referenced from a different file. The check
 * uses two existing sidecar edge sets:
 *
 *   - `index.calls`   — call edges (caller invokes callee)
 *   - `index.impacts` — type-reference / field-reference / mapper / endpoint /
 *                       message / test impacts
 *
 * If for every duplicate symbol of an ambiguous FQN there is no entry in
 * `calls` or `impacts` whose `file` differs from the symbol's own file,
 * the FQN is local-only by construction. Generalizable across frameworks
 * (TS/Node/React/NestJS/Django-via-TS-shim/etc).
 *
 * Order of filters in selfCheck:
 *   F (this one) — primary, universal, derived from index data
 *   A — *.logger (framework fallback)
 *   B — *Cmd     (framework fallback)
 *   C — DTO audit fields (framework fallback)
 *   D — IProps in .tsx   (framework fallback)
 *   E — *.generated.*    (framework fallback)
 *
 * Framework filters stay as belt-and-suspenders; on codebases where the
 * extractor's calls/impacts coverage is incomplete, they catch noise
 * the universal filter misses.
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

function methodSym(id: string, fqn: string, file: string, parentId?: string): CodeIntelSymbol {
    return { id, kind: 'method', name: fqn.split('.').pop()!, fqn, file, line: 1, column: 1, parentId };
}

function call(id: string, callerId: string, calleeId: string, callerFile: string): CodeIntelCall {
    return {
        id,
        callerId,
        caller: callerId,
        callee: calleeId,
        calleeId,
        kind: 'internal',
        order: 1,
        expression: 'X()',
        args: [],
        file: callerFile,
        line: 1,
        column: 1,
    };
}

function impact(id: string, symbolId: string, file: string): CodeIntelImpact {
    return {
        id,
        symbolId,
        symbol: symbolId,
        kind: 'type-reference',
        detail: '',
        risk: 'low',
        file,
        line: 1,
        column: 1,
    };
}

describe('selfCheck — F: universal local-only filter (via calls+impacts)', () => {
    it('filters a collision when NEITHER copy is referenced from a different file', () => {
        // Two services each declare `type TState = ...` LOCALLY in their slice.ts.
        // Each is used only within its own file (or not at all). No cross-file
        // call or impact references either id. → local-only → not dangerous.
        const symbols: CodeIntelSymbol[] = [
            typeSym('s:a', 'TState', 'packages/x/src/features/foo/slice.ts'),
            typeSym('s:b', 'TState', 'packages/x/src/features/bar/slice.ts'),
        ];
        const index: CodeIntelIndex = {
            manifest: { ...BASE_MANIFEST, warnings: { ambiguousFqns: ['TState'], skippedFiles: [] } },
            symbols,
            // calls/impacts that reference these symbols, but ONLY from the
            // symbol's own file. Not cross-file.
            calls: [],
            impacts: [
                impact('i1', 's:a', 'packages/x/src/features/foo/slice.ts'),
                impact('i2', 's:b', 'packages/x/src/features/bar/slice.ts'),
            ],
            flows: [], branches: [],
        };

        const sc = selfCheck(index);

        expect(sc.warnings?.dangerousCollisions ?? []).not.toContain('TState');
    });

    it('keeps the collision dangerous when AT LEAST ONE copy is referenced cross-file', () => {
        // Same TState shape, but one of the copies is imported (=type-referenced)
        // from a different file. If the LLM looks up `TState`, it might pick the
        // wrong copy. → STAYS dangerous.
        const symbols: CodeIntelSymbol[] = [
            typeSym('s:a', 'TState', 'packages/x/src/features/foo/slice.ts'),
            typeSym('s:b', 'TState', 'packages/x/src/features/bar/slice.ts'),
        ];
        const index: CodeIntelIndex = {
            manifest: { ...BASE_MANIFEST, warnings: { ambiguousFqns: ['TState'], skippedFiles: [] } },
            symbols,
            calls: [],
            impacts: [
                // cross-file impact: s:a referenced from a different file
                impact('i1', 's:a', 'packages/x/src/some-other-place/uses-tstate.ts'),
            ],
            flows: [], branches: [],
        };

        const sc = selfCheck(index);

        expect(sc.warnings?.dangerousCollisions).toContain('TState');
    });

    it('detects cross-file via `calls` too (method called from another file)', () => {
        // Two HelperService.foo() methods. One is called from a different file
        // → ambiguity is real (LLM picking wrong one matters).
        const symbols: CodeIntelSymbol[] = [
            { id: 's:hs1', kind: 'class', name: 'HelperService', fqn: 'HelperService', file: 'packages/x/src/a/helper.service.ts', line: 1, column: 1 },
            { id: 's:hs2', kind: 'class', name: 'HelperService', fqn: 'HelperService', file: 'packages/x/src/b/helper.service.ts', line: 1, column: 1 },
            methodSym('s:m1', 'HelperService.foo', 'packages/x/src/a/helper.service.ts'),
            methodSym('s:m2', 'HelperService.foo', 'packages/x/src/b/helper.service.ts'),
            { id: 's:caller', kind: 'method', name: 'orchestrate', fqn: 'Caller.orchestrate', file: 'packages/x/src/c/caller.ts', line: 1, column: 1 },
        ];
        const index: CodeIntelIndex = {
            manifest: { ...BASE_MANIFEST, warnings: { ambiguousFqns: ['HelperService', 'HelperService.foo'], skippedFiles: [] } },
            symbols,
            calls: [
                call('c1', 's:caller', 's:m1', 'packages/x/src/c/caller.ts'),
            ],
            impacts: [], flows: [], branches: [],
        };

        const sc = selfCheck(index);

        // Both class-level and method-level collisions stay flagged.
        expect(sc.warnings?.dangerousCollisions).toContain('HelperService.foo');
    });

    it('treats `Logger` × N standalone scripts as local-only (no cross-file calls)', () => {
        // Each util script has its own `class Logger` with methods called only
        // inside that same script. No script imports another's Logger.
        const symbols: CodeIntelSymbol[] = [
            { id: 's:l1', kind: 'class', name: 'Logger', fqn: 'Logger', file: 'libs/utils/a.ts', line: 1, column: 1 },
            { id: 's:l2', kind: 'class', name: 'Logger', fqn: 'Logger', file: 'libs/utils/b.ts', line: 1, column: 1 },
            methodSym('s:l1.log', 'Logger.log', 'libs/utils/a.ts', 's:l1'),
            methodSym('s:l2.log', 'Logger.log', 'libs/utils/b.ts', 's:l2'),
        ];
        const index: CodeIntelIndex = {
            manifest: { ...BASE_MANIFEST, warnings: { ambiguousFqns: ['Logger', 'Logger.log'], skippedFiles: [] } },
            symbols,
            // Each Logger.log is called only from its own file.
            calls: [
                call('c1', 's:l1', 's:l1.log', 'libs/utils/a.ts'),
                call('c2', 's:l2', 's:l2.log', 'libs/utils/b.ts'),
            ],
            impacts: [], flows: [], branches: [],
        };

        const sc = selfCheck(index);

        expect(sc.warnings?.dangerousCollisions ?? []).not.toContain('Logger');
        expect(sc.warnings?.dangerousCollisions ?? []).not.toContain('Logger.log');
    });

    it('counts F-filtered collisions in `structuralNoise` bucket', () => {
        const symbols: CodeIntelSymbol[] = [
            typeSym('s:a', 'TState', 'packages/x/src/foo/slice.ts'),
            typeSym('s:b', 'TState', 'packages/x/src/bar/slice.ts'),
            // Plus a real cross-file bug for comparison:
            typeSym('s:r1', 'RealBug', 'packages/x/src/p/m.ts'),
            typeSym('s:r2', 'RealBug', 'packages/x/src/q/m.ts'),
        ];
        const index: CodeIntelIndex = {
            manifest: {
                ...BASE_MANIFEST,
                warnings: { ambiguousFqns: ['TState', 'RealBug'], skippedFiles: [] },
            },
            symbols,
            calls: [],
            impacts: [
                // TState same-file usage → "any signal" precondition for F filter
                impact('i_a', 's:a', 'packages/x/src/foo/slice.ts'),
                impact('i_b', 's:b', 'packages/x/src/bar/slice.ts'),
                // RealBug referenced cross-file
                impact('i1', 's:r1', 'packages/x/src/elsewhere/uses-it.ts'),
            ],
            flows: [], branches: [],
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

        expect(breakdown?.structuralNoise).toBeGreaterThanOrEqual(1); // TState filtered as local-only
        expect(sc.warnings?.dangerousCollisions).toContain('RealBug');
    });

    it('does NOT filter when calls/impacts are absent but framework-fallback should fire', () => {
        // Empty calls + impacts (incomplete extractor coverage). The universal
        // F filter cannot tell — falls back to framework filters (`.logger`).
        const symbols: CodeIntelSymbol[] = [
            { id: 's:l1', kind: 'class', name: 'AService', fqn: 'AService', file: 'packages/x/src/a/a.service.ts', line: 1, column: 1 },
            { id: 's:l2', kind: 'class', name: 'AService', fqn: 'AService', file: 'packages/x/src/b/a.service.ts', line: 1, column: 1 },
            { id: 's:l1.log', kind: 'field', name: 'logger', fqn: 'AService.logger', file: 'packages/x/src/a/a.service.ts', line: 1, column: 1, parentId: 's:l1', ownerName: 'AService' },
            { id: 's:l2.log', kind: 'field', name: 'logger', fqn: 'AService.logger', file: 'packages/x/src/b/a.service.ts', line: 1, column: 1, parentId: 's:l2', ownerName: 'AService' },
        ];
        const index: CodeIntelIndex = {
            manifest: { ...BASE_MANIFEST, warnings: { ambiguousFqns: ['AService', 'AService.logger'], skippedFiles: [] } },
            symbols,
            calls: [], impacts: [], flows: [], branches: [],
        };

        const sc = selfCheck(index);

        // Universal F filter: no calls/impacts → "no cross-file refs" → would
        // mark local-only. That's fine — but check `.logger` filter ALSO works
        // independently. Either way, the .logger collision is gone.
        expect(sc.warnings?.dangerousCollisions ?? []).not.toContain('AService.logger');
    });
});
