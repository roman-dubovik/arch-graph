/**
 * Type-level tests for the Anchor branded newtype.
 *
 * These tests are enforced by vitest's typecheck runner (see vitest.config.ts:
 * `typecheck.enabled`).  The `@ts-expect-error` assertions below are INERT
 * unless typecheck is active — do not remove the vitest config entry.
 */
import { describe, expectTypeOf, it } from 'vitest';
import { buildAnchor } from './anchor.js';
import type { Anchor } from './anchor.js';

describe('Anchor branded type (type-level)', () => {
    it('Anchor is assignable to string (read direction)', () => {
        const anchor = buildAnchor('MyService', 'node:1');
        expectTypeOf(anchor).toMatchTypeOf<string>();
    });

    it('bare string is not directly assignable to Anchor (write direction)', () => {
        // @ts-expect-error — Anchor is branded; raw strings are forbidden without buildAnchor
        const _bareStringIsNotAnchor: Anchor = 'foo';
        void _bareStringIsNotAnchor;
    });
});
