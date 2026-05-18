import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @xenova/transformers before any module under test is imported.
// The fake tokenizer returns text.split(/\s+/).length tokens so that
// relative comparisons (longer text → more tokens, '' → 0) still hold,
// while the spy lets us assert which hub ID was requested.
vi.mock('@xenova/transformers', () => {
    const fakeTokenizer = (hubId: string) => ({
        encode: (text: string) => {
            const tokens = text.length === 0 ? [] : text.split(/\s+/);
            return { input_ids: tokens, _hubId: hubId };
        },
    });
    return {
        AutoTokenizer: {
            from_pretrained: vi.fn().mockImplementation(async (hubId: string) => fakeTokenizer(hubId)),
        },
    };
});

import { AutoTokenizer } from '@xenova/transformers';
import { countTokens, _resetTokenizerForTesting } from './tokenizer.js';
import { SEMANTIC_MODELS } from './types.js';

beforeEach(() => {
    _resetTokenizerForTesting();
    vi.mocked(AutoTokenizer.from_pretrained).mockClear();
});

afterEach(() => {
    _resetTokenizerForTesting();
    vi.clearAllMocks();
});

describe('tokenizer', () => {
    it('counts tokens deterministically for a fixed input', async () => {
        const a = await countTokens('hello world', 'minilm');
        const b = await countTokens('hello world', 'minilm');
        expect(a).toBe(b);
        expect(a).toBeGreaterThan(0);
    });

    it('returns more tokens for longer text', async () => {
        const short = await countTokens('hi', 'minilm');
        const long = await countTokens('hi '.repeat(100), 'minilm');
        expect(long).toBeGreaterThan(short);
    });

    it('handles empty string', async () => {
        const n = await countTokens('', 'minilm');
        expect(n).toBeGreaterThanOrEqual(0);
    });
});

// ---------------------------------------------------------------------------
// P1-J: per-alias dispatch + cache
// ---------------------------------------------------------------------------

describe('tokenizer — per-alias dispatch and cache (P1-J)', () => {
    it('calls from_pretrained with the correct hub ID for each alias', async () => {
        await countTokens('hi', 'minilm');
        await countTokens('hi', 'e5-base');

        expect(AutoTokenizer.from_pretrained).toHaveBeenCalledTimes(2);

        const calls = vi.mocked(AutoTokenizer.from_pretrained).mock.calls;
        const calledIds = calls.map((c) => c[0] as string);
        expect(calledIds).toContain(SEMANTIC_MODELS.minilm.hubId);
        expect(calledIds).toContain(SEMANTIC_MODELS['e5-base'].hubId);
        // The two hub IDs must be different
        expect(SEMANTIC_MODELS.minilm.hubId).not.toBe(SEMANTIC_MODELS['e5-base'].hubId);
    });

    it('uses the per-alias cache: third call to same alias does not call from_pretrained again', async () => {
        await countTokens('hi', 'minilm');
        await countTokens('hi', 'e5-base');
        // Cache hit — from_pretrained must NOT be called a third time
        await countTokens('hi', 'minilm');

        expect(AutoTokenizer.from_pretrained).toHaveBeenCalledTimes(2);
    });
});
