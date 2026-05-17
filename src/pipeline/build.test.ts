/**
 * Tests for stage() error handling and stack preservation.
 */
import { describe, expect, it } from 'vitest';
import { stage } from './build.js';

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
