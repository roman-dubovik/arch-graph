import { describe, it, expect } from 'vitest';
import { makeSlugifier } from './slugify.js';

describe('slugify', () => {
    it('lowercases and replaces spaces with dashes', () => {
        const slug = makeSlugifier();
        expect(slug.next('Installation Steps')).toBe('installation-steps');
    });

    it('strips punctuation', () => {
        const slug = makeSlugifier();
        expect(slug.next('What is `arch-graph`?')).toBe('what-is-arch-graph');
    });

    it('preserves Cyrillic', () => {
        const slug = makeSlugifier();
        expect(slug.next('Установка на macOS')).toBe('установка-на-macos');
    });

    it('falls back to "section" when slug is empty after strip', () => {
        const slug = makeSlugifier();
        expect(slug.next('🚀🔥')).toBe('section');
    });

    it('appends -1, -2 on per-file collisions (GitHub style)', () => {
        const slug = makeSlugifier();
        expect(slug.next('Setup')).toBe('setup');
        expect(slug.next('Setup')).toBe('setup-1');
        expect(slug.next('Setup')).toBe('setup-2');
    });

    it('collapses repeated dashes', () => {
        const slug = makeSlugifier();
        expect(slug.next('foo --- bar')).toBe('foo-bar');
    });

    it('trims leading and trailing dashes', () => {
        const slug = makeSlugifier();
        expect(slug.next('--foo--')).toBe('foo');
    });
});
