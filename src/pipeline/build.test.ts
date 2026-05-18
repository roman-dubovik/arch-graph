/**
 * Tests for stage() error handling and stack preservation.
 */
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { stage, runBuild } from './build.js';
import type { ArchGraphConfig } from '../core/config.js';

describe('stage()', () => {
    it('preserves Error stack when inner function throws an Error', async () => {
        const innerThrowSite = () => {
            throw new Error('original error');
        };

        try {
            await stage('test-phase', innerThrowSite);
            throw new Error('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(Error);
            const e = err as Error;
            expect(e.message).toBe('test-phase failed: original error');
            // Stack should contain the original throw site (innerThrowSite).
            // The stack will show frames from the throw site, not rooted at stage().
            expect(e.stack).toBeDefined();
            expect(e.stack).toContain('innerThrowSite');
        }
    });

    it('wraps non-Error throws in an Error with original string in message', async () => {
        const innerThrow = () => {
            throw 'raw string error';
        };

        try {
            await stage('test-phase', innerThrow);
            throw new Error('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(Error);
            const e = err as Error;
            expect(e.message).toBe('test-phase failed: raw string error');
        }
    });

    it('prefixes error message with label', async () => {
        const innerError = new Error('inner failure');

        try {
            await stage('custom-stage-name', () => {
                throw innerError;
            });
            throw new Error('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(Error);
            const e = err as Error;
            expect(e.message).toMatch(/^custom-stage-name failed:/);
        }
    });
});

describe('build — docs pass', () => {
    it('emits doc-section nodes when docs.include matches files', async () => {
        const fixtureRoot = resolve(__dirname, '../__fixtures__/docs/sample');
        const cfg: ArchGraphConfig = {
            id: 'docs-test',
            root: fixtureRoot,
            appsGlob: 'apps/*',
            docs: {
                include: ['README.md', 'ADR.md'],
                exclude: [],
                respectGitignore: false,
                chunkTokens: 100,
                maxFileBytes: 10_000_000,
            },
        };

        const result = await runBuild(cfg);

        const docNodes = result.graph.nodes.filter(n => n.kind === 'doc-section');
        expect(docNodes.length).toBeGreaterThan(0);
        expect(result.diagnostics.docs).toBeDefined();
        expect(result.diagnostics.docs!.counts.nodesEmitted).toBe(docNodes.length);
    });
});
