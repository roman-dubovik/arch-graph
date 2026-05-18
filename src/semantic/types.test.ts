/**
 * Unit tests for per-model `recommendedMinScore` registry and the
 * `resolveMinScore` helper introduced in Task 3.
 *
 * Covers Task 3 AC:
 *   - Each alias resolves to its `recommendedMinScore` when user provides no override.
 *   - User override always wins.
 *   - Missing/unknown alias in manifest → falls back to DEFAULT_MIN_SCORE_FALLBACK (0.30).
 *   - Edge case: invalid/empty string alias at runtime.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_MIN_SCORE_FALLBACK,
    SEMANTIC_MODELS,
    resolveMinScore,
} from './types.js';

// ---------------------------------------------------------------------------
// Registry — field presence
// ---------------------------------------------------------------------------

describe('SEMANTIC_MODELS registry — recommendedMinScore field', () => {
    it('minilm has recommendedMinScore: 0.30', () => {
        expect(SEMANTIC_MODELS.minilm.recommendedMinScore).toBe(0.30);
    });

    it('e5-base has recommendedMinScore: 0.55', () => {
        expect(SEMANTIC_MODELS['e5-base'].recommendedMinScore).toBe(0.55);
    });

    it('all aliases have recommendedMinScore in [0, 1]', () => {
        for (const [alias, entry] of Object.entries(SEMANTIC_MODELS)) {
            expect(entry.recommendedMinScore, `alias: ${alias}`).toBeGreaterThanOrEqual(0);
            expect(entry.recommendedMinScore, `alias: ${alias}`).toBeLessThanOrEqual(1);
        }
    });
});

// ---------------------------------------------------------------------------
// DEFAULT_MIN_SCORE_FALLBACK
// ---------------------------------------------------------------------------

describe('DEFAULT_MIN_SCORE_FALLBACK', () => {
    it('is 0.30', () => {
        expect(DEFAULT_MIN_SCORE_FALLBACK).toBe(0.30);
    });
});

// ---------------------------------------------------------------------------
// resolveMinScore — step 1: user value always wins
// ---------------------------------------------------------------------------

describe('resolveMinScore — user override wins (step 1)', () => {
    it('returns user value when provided for minilm', () => {
        expect(resolveMinScore('minilm', 0.50)).toBe(0.50);
    });

    it('returns user value when provided for e5-base', () => {
        expect(resolveMinScore('e5-base', 0.70)).toBe(0.70);
    });

    it('returns user value 0.0 (falsy) for e5-base — falsy user value wins', () => {
        // Ensures we check `userValue !== undefined`, not `!userValue`.
        expect(resolveMinScore('e5-base', 0.0)).toBe(0.0);
    });

    it('returns user value -1 for minilm — negative user value wins', () => {
        expect(resolveMinScore('minilm', -1)).toBe(-1);
    });

    it('returns user value for unknown alias when override is provided', () => {
        expect(resolveMinScore('bogus-model', 0.45)).toBe(0.45);
    });
});

// ---------------------------------------------------------------------------
// resolveMinScore — step 2: per-model recommendedMinScore
// ---------------------------------------------------------------------------

describe('resolveMinScore — per-model recommendedMinScore (step 2)', () => {
    it('returns 0.30 for minilm when no user override', () => {
        expect(resolveMinScore('minilm')).toBe(0.30);
    });

    it('returns 0.30 for minilm when userValue is undefined', () => {
        expect(resolveMinScore('minilm', undefined)).toBe(0.30);
    });

    it('returns 0.55 for e5-base when no user override', () => {
        expect(resolveMinScore('e5-base')).toBe(0.55);
    });
});

// ---------------------------------------------------------------------------
// resolveMinScore — step 3: unknown / missing alias → fallback 0.30 + warning
// ---------------------------------------------------------------------------

describe('resolveMinScore — fallback for unknown alias (step 3)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('falls back to DEFAULT_MIN_SCORE_FALLBACK (0.30) for unknown alias string', () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        expect(resolveMinScore('completely-unknown')).toBe(DEFAULT_MIN_SCORE_FALLBACK);
    });

    it('falls back to 0.30 for empty string alias', () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        expect(resolveMinScore('')).toBe(DEFAULT_MIN_SCORE_FALLBACK);
    });

    it('falls back to 0.30 for alias matching no registry key', () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        expect(resolveMinScore('not-in-registry')).toBe(DEFAULT_MIN_SCORE_FALLBACK);
    });

    it('emits a stderr warning when alias is unknown', () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        resolveMinScore('ghost-model');
        const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(output).toContain('ghost-model');
        expect(output).toContain('not in the registry');
        expect(output).toContain(`minScore=${DEFAULT_MIN_SCORE_FALLBACK}`);
        expect(output).toContain('arch-graph semantic build');
    });

    it('does NOT emit a warning when alias is in the registry (no false positives)', () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        resolveMinScore('e5-base');
        expect(stderrSpy).not.toHaveBeenCalled();
    });

    it('does NOT emit a warning when user value is provided (step 1 short-circuits)', () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        resolveMinScore('ghost-model', 0.5);
        expect(stderrSpy).not.toHaveBeenCalled();
    });
});
