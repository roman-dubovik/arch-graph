/**
 * Tests for the cycle-detection error handling added in the 2nd-round fix.
 *
 * These tests exercise `safeDetectCycles` — the helper extracted from `build.ts`
 * in the 4th-round fix — so any future change to that function's error-handling
 * logic is automatically caught here. No inline copy; tests use the real code.
 */

import { describe, expect, it, vi } from 'vitest';

import type { CyclesDiagnostics } from '../core/types.js';
import { safeDetectCycles } from './build.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal ArchGraph stub — safeDetectCycles only passes it through to `detect`. */
const stubGraph = {
    version: '1' as const,
    buildAt: new Date().toISOString(),
    root: '/project',
    nodes: [],
    edges: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('safeDetectCycles — cycle detection error handling', () => {
    it('returns cycles normally when detect succeeds', () => {
        const expected: CyclesDiagnostics = {
            cycles: [],
            counts: { tsImport: 0, libUsage: 0, diImport: 0 },
        };
        const result = safeDetectCycles(stubGraph, () => expected);
        expect(result).toBe(expected);
        expect(result.error).toBeUndefined();
    });

    it('degrades gracefully on RangeError (stack overflow) and sets error sentinel', () => {
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            const result = safeDetectCycles(
                stubGraph,
                () => { throw new RangeError('Maximum call stack size exceeded'); },
            );
            // Does NOT throw — degrades gracefully
            expect(result.cycles).toHaveLength(0);
            expect(result.counts).toEqual({ tsImport: 0, libUsage: 0, diImport: 0 });
            // Sentinel field is set so consumers can detect degraded-mode runs
            expect(result.error).toBe('RangeError: Maximum call stack size exceeded');
            // User-visible message goes to stdout (not buried in stderr)
            const stdoutMessages = (stdoutSpy.mock.calls as unknown[][])
                .map((args) => String(args[0]));
            expect(stdoutMessages.some((m) => m.includes('stack overflow on large graph'))).toBe(true);
        } finally {
            stdoutSpy.mockRestore();
        }
    });

    it('re-throws unknown errors so the build fails loudly', () => {
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            const syntheticError = new TypeError('unexpected: null graph node');
            expect(() => {
                safeDetectCycles(
                    stubGraph,
                    () => { throw syntheticError; },
                );
            }).toThrow(syntheticError);
            // Failure message goes to stdout before re-throw
            const stdoutMessages = (stdoutSpy.mock.calls as unknown[][])
                .map((args) => String(args[0]));
            expect(stdoutMessages.some((m) => m.includes('cycles: detection failed'))).toBe(true);
        } finally {
            stdoutSpy.mockRestore();
        }
    });

    it('error sentinel is not set on a successful run (normal cycles present)', () => {
        const expected: CyclesDiagnostics = {
            cycles: [
                {
                    kind: 'ts-import',
                    nodes: ['file:a', 'file:b'],
                    edgeLocations: [
                        { from: 'file:a', to: 'file:b' },
                        { from: 'file:b', to: 'file:a' },
                    ],
                },
            ],
            counts: { tsImport: 1, libUsage: 0, diImport: 0 },
        };
        const result = safeDetectCycles(stubGraph, () => expected);
        expect(result.cycles).toHaveLength(1);
        expect(result.error).toBeUndefined();
    });

    it('uses custom write channel when provided', () => {
        const writes: string[] = [];
        safeDetectCycles(
            stubGraph,
            () => { throw new RangeError('overflow'); },
            (msg) => { writes.push(msg); },
        );
        expect(writes.some((m) => m.includes('stack overflow on large graph'))).toBe(true);
    });

    it('uses custom write channel for unknown-error failure message before re-throw', () => {
        const writes: string[] = [];
        expect(() => {
            safeDetectCycles(
                stubGraph,
                () => { throw new TypeError('boom'); },
                (msg) => { writes.push(msg); },
            );
        }).toThrow('boom');
        expect(writes.some((m) => m.includes('cycles: detection failed'))).toBe(true);
    });
});
