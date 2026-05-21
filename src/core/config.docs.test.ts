import { describe, it, expect } from 'vitest';
import {
    applyDocsDefaults,
    applySemanticDefaults,
    validateConfig,
    DOCS_DEFAULT_INCLUDE,
    DOCS_DEFAULT_EXCLUDE,
} from './config.js';

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

// ---------------------------------------------------------------------------
// D1: applySemanticDefaults
// ---------------------------------------------------------------------------

describe('applySemanticDefaults (D1)', () => {
    it('returns {model:"e5-base"} when semantic is undefined', () => {
        expect(applySemanticDefaults(undefined)).toEqual({ model: 'e5-base' });
    });

    it('passthrough when semantic.model is "e5-base"', () => {
        expect(applySemanticDefaults({ model: 'e5-base' })).toEqual({ model: 'e5-base' });
    });

    it('throws for unknown model alias', () => {
        expect(() => applySemanticDefaults({ model: 'unknown' as never })).toThrow(
            /not a recognised alias/,
        );
    });
});

// ---------------------------------------------------------------------------
// D1: validateConfig — semantic block validation
// ---------------------------------------------------------------------------

const BASE_CONFIG = { id: 'test', root: '.', appsGlob: 'apps/*' };

describe('validateConfig semantic block (D1)', () => {
    it('throws when semantic is a string (not an object)', () => {
        expect(() => validateConfig({ ...BASE_CONFIG, semantic: 'minilm' }, 'test')).toThrow(
            /semantic must be an object/,
        );
    });

    it('throws when semantic.model is an unrecognised alias', () => {
        expect(() =>
            validateConfig({ ...BASE_CONFIG, semantic: { model: 'bad-alias' } }, 'test'),
        ).toThrow(/not a recognised alias/);
    });

    it('does not throw when semantic.model is "e5-base"', () => {
        expect(() =>
            validateConfig({ ...BASE_CONFIG, semantic: { model: 'e5-base' } }, 'test'),
        ).not.toThrow();
    });

    it('throws when semantic.model is "bge-m3" (removed alias)', () => {
        expect(() =>
            validateConfig({ ...BASE_CONFIG, semantic: { model: 'bge-m3' } }, 'test'),
        ).toThrow(/not a recognised alias/);
    });
});

describe('validateConfig typeorm relation decorator aliases', () => {
    it('accepts configured TypeORM relation decorator aliases', () => {
        expect(() =>
            validateConfig(
                {
                    ...BASE_CONFIG,
                    typeorm: {
                        relationDecorators: [
                            { name: 'ManyToOneWithIndex', mapsTo: 'ManyToOne' },
                        ],
                    },
                },
                'test',
            ),
        ).not.toThrow();
    });

    it('rejects unknown TypeORM relation alias targets', () => {
        expect(() =>
            validateConfig(
                {
                    ...BASE_CONFIG,
                    typeorm: {
                        relationDecorators: [
                            { name: 'ManyToOneWithIndex', mapsTo: 'BelongsTo' },
                        ],
                    },
                },
                'test',
            ),
        ).toThrow(/relationDecorators\[0\]\.mapsTo/);
    });
});

describe('validateConfig nats subscribe decorators', () => {
    it('accepts configured NATS decorator subscribe aliases', () => {
        expect(() =>
            validateConfig(
                {
                    ...BASE_CONFIG,
                    nats: {
                        subscribeDecorators: ['NatsMessagePattern'],
                    },
                },
                'test',
            ),
        ).not.toThrow();
    });

    it('rejects invalid NATS decorator subscribe aliases', () => {
        expect(() =>
            validateConfig(
                {
                    ...BASE_CONFIG,
                    nats: {
                        subscribeDecorators: ['NatsMessagePattern', ''],
                    },
                },
                'test',
            ),
        ).toThrow(/nats\.subscribeDecorators\[1\]/);
    });
});
