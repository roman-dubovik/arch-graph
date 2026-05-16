/**
 * Tests for the cycle-detection error handling added in the 2nd-round fix.
 *
 * These tests isolate the try/catch block in `runBuild` by mocking `detectCycles`
 * to throw controlled errors. The full pipeline is not exercised — only the
 * error-surfacing paths introduced in fix #2.
 *
 * We test the catch logic directly via a helper that mirrors the try/catch block
 * in build.ts, since mocking the full `runBuild` call chain would require
 * stubbing ts-morph, file system, and all extractors.
 */

import { describe, expect, it, vi } from 'vitest';

import type { CyclesDiagnostics } from '../core/types.js';

// ---------------------------------------------------------------------------
// Inline re-implementation of the try/catch block for isolated unit testing.
// This mirrors the logic in src/pipeline/build.ts exactly, so if that block
// is updated this test must be updated too.
// ---------------------------------------------------------------------------

type DetectCyclesFn = () => CyclesDiagnostics;

function runCycleDetection(detectCycles: DetectCyclesFn): CyclesDiagnostics {
    let cyclesDiagnostics: CyclesDiagnostics;
    try {
        cyclesDiagnostics = detectCycles();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof RangeError) {
            process.stdout.write(`  cycles: detection skipped (stack overflow on large graph)\n`);
            cyclesDiagnostics = {
                cycles: [],
                counts: { tsImport: 0, libUsage: 0, diImport: 0 },
                error: `RangeError: ${message}`,
            };
        } else {
            process.stdout.write(`  cycles: detection failed: ${message}\n`);
            throw err;
        }
    }
    return cyclesDiagnostics;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('build.ts — cycle detection error handling', () => {
    it('returns cycles normally when detectCycles succeeds', () => {
        const expected: CyclesDiagnostics = {
            cycles: [],
            counts: { tsImport: 0, libUsage: 0, diImport: 0 },
        };
        const result = runCycleDetection(() => expected);
        expect(result).toBe(expected);
        expect(result.error).toBeUndefined();
    });

    it('degrades gracefully on RangeError (stack overflow) and sets error sentinel', () => {
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            const result = runCycleDetection(() => {
                throw new RangeError('Maximum call stack size exceeded');
            });
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
                runCycleDetection(() => {
                    throw syntheticError;
                });
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
        const result = runCycleDetection(() => expected);
        expect(result.cycles).toHaveLength(1);
        expect(result.error).toBeUndefined();
    });
});
