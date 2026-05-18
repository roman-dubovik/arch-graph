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
import { describe, expect, it } from 'vitest';

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

    it('bge-m3 has recommendedMinScore: 0.55', () => {
        expect(SEMANTIC_MODELS['bge-m3'].recommendedMinScore).toBe(0.55);
    });

    it('e5-base has recommendedMinScore: 0.55', () => {
        expect(SEMANTIC_MODELS['e5-base'].recommendedMinScore).toBe(0.55);
    });

    it('arctic-m has recommendedMinScore: 0.40 (provisional)', () => {
        expect(SEMANTIC_MODELS['arctic-m'].recommendedMinScore).toBe(0.40);
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

    it('returns user value 0.0 (falsy) for bge-m3 — falsy user value wins', () => {
        // Ensures we check `userValue !== undefined`, not `!userValue`.
        expect(resolveMinScore('bge-m3', 0.0)).toBe(0.0);
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

    it('returns 0.55 for bge-m3 when no user override', () => {
        expect(resolveMinScore('bge-m3')).toBe(0.55);
    });

    it('returns 0.55 for e5-base when no user override', () => {
        expect(resolveMinScore('e5-base')).toBe(0.55);
    });

    it('returns 0.40 for arctic-m when no user override', () => {
        expect(resolveMinScore('arctic-m')).toBe(0.40);
    });
});

// ---------------------------------------------------------------------------
// resolveMinScore — step 3: unknown / missing alias → fallback 0.30
// ---------------------------------------------------------------------------

describe('resolveMinScore — fallback for unknown alias (step 3)', () => {
    it('falls back to DEFAULT_MIN_SCORE_FALLBACK (0.30) for unknown alias string', () => {
        expect(resolveMinScore('completely-unknown')).toBe(DEFAULT_MIN_SCORE_FALLBACK);
    });

    it('falls back to 0.30 for empty string alias', () => {
        expect(resolveMinScore('')).toBe(DEFAULT_MIN_SCORE_FALLBACK);
    });

    it('falls back to 0.30 for alias matching no registry key', () => {
        expect(resolveMinScore('not-in-registry')).toBe(DEFAULT_MIN_SCORE_FALLBACK);
    });
});
