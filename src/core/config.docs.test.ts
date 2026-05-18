import { describe, it, expect } from 'vitest';
import { applyDocsDefaults, DOCS_DEFAULT_INCLUDE, DOCS_DEFAULT_EXCLUDE } from './config.js';

describe('applyDocsDefaults', () => {
    it('returns all defaults when docs is undefined', () => {
        const r = applyDocsDefaults(undefined);
        expect(r.respectGitignore).toBe(true);
        expect(r.chunkTokens).toBe(100);
        expect(r.maxFileBytes).toBe(10 * 1024 * 1024);
        expect(r.include).toEqual([...DOCS_DEFAULT_INCLUDE]);
        expect(r.exclude).toEqual([...DOCS_DEFAULT_EXCLUDE]);
    });

    it('returns all defaults when docs is empty object', () => {
        const r = applyDocsDefaults({});
        expect(r.chunkTokens).toBe(100);
        expect(r.include).toContain('README.md');
    });

    it('respects user overrides', () => {
        const r = applyDocsDefaults({
            chunkTokens: 200,
            respectGitignore: false,
        });
        expect(r.chunkTokens).toBe(200);
        expect(r.respectGitignore).toBe(false);
        // Defaults preserved for non-overridden fields.
        expect(r.include).toEqual([...DOCS_DEFAULT_INCLUDE]);
    });

    it('respects user-supplied include / exclude arrays (replaces defaults entirely)', () => {
        const r = applyDocsDefaults({
            include: ['ONLY_THIS.md'],
            exclude: ['NEVER_THIS.md'],
        });
        expect(r.include).toEqual(['ONLY_THIS.md']);
        expect(r.exclude).toEqual(['NEVER_THIS.md']);
    });

    it('throws on non-positive chunkTokens', () => {
        expect(() => applyDocsDefaults({ chunkTokens: 0 })).toThrow(/positive integer/);
        expect(() => applyDocsDefaults({ chunkTokens: -5 })).toThrow(/positive integer/);
    });

    it('throws on non-positive maxFileBytes', () => {
        expect(() => applyDocsDefaults({ maxFileBytes: 0 })).toThrow(/positive integer/);
    });
});
