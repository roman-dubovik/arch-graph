import { describe, it, expect, beforeAll } from 'vitest';
import { countTokens, _resetTokenizerForTesting } from './tokenizer.js';

describe('tokenizer', () => {
    beforeAll(() => {
        _resetTokenizerForTesting();
    });

    it('counts tokens deterministically for a fixed input', async () => {
        const a = await countTokens('hello world');
        const b = await countTokens('hello world');
        expect(a).toBe(b);
        expect(a).toBeGreaterThan(0);
    });

    it('returns more tokens for longer text', async () => {
        const short = await countTokens('hi');
        const long = await countTokens('hi '.repeat(100));
        expect(long).toBeGreaterThan(short);
    });

    it('handles empty string', async () => {
        const n = await countTokens('');
        expect(n).toBeGreaterThanOrEqual(0);
    });
});
