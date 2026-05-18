/**
 * Tests for the buildAnchor and buildClassMemberAnchor factories.
 */
import { describe, expect, it } from 'vitest';
import { buildAnchor, buildClassMemberAnchor } from './anchor.js';

describe('buildAnchor', () => {
    it('returns value as Anchor for a valid non-empty string', () => {
        const result = buildAnchor('foo', 'node:1');
        expect(result).toBe('foo');
    });

    it('works with a class name like AuthService', () => {
        expect(buildAnchor('AuthService', 'provider:auth')).toBe('AuthService');
    });

    it('throws when value is empty string', () => {
        expect(() => buildAnchor('', 'node:1')).toThrow('anchor: value is empty for node:1');
    });

    it('throws when value is whitespace only', () => {
        expect(() => buildAnchor('   ', 'provider:x')).toThrow('anchor: value is empty for provider:x');
    });

    it('throws when value is <anonymous> sentinel', () => {
        expect(() => buildAnchor('<anonymous>', 'provider:x')).toThrow(
            "anchor: value is invalid for provider:x (got '<anonymous>')",
        );
    });

    it('nodeId appears in error message for empty value', () => {
        expect(() => buildAnchor('', 'endpoint:GET /some/path')).toThrow('endpoint:GET /some/path');
    });

    it('nodeId appears in error message for <anonymous> sentinel', () => {
        expect(() => buildAnchor('<anonymous>', 'config-field:JWT_SECRET')).toThrow('config-field:JWT_SECRET');
    });
});

// ---------------------------------------------------------------------------
// Anchor newtype compile-time assertions
// ---------------------------------------------------------------------------
// The @ts-expect-error brand check has been migrated to anchor.test-d.ts
// and is enforced by vitest's typecheck runner (vitest.config.ts: typecheck.enabled).
describe('Anchor branded type', () => {
    it('Anchor is still a string structurally (read direction)', () => {
        const anchor = buildAnchor('MyService', 'node:1');
        // Anchor must be readable as a plain string without casting.
        const s: string = anchor;
        expect(s).toBe('MyService');
    });
});

describe('buildClassMemberAnchor', () => {
    it('returns "ClassName.memberName" for valid inputs', () => {
        expect(buildClassMemberAnchor({ className: 'UserController', memberName: 'findOne', nodeId: 'endpoint:GET /users/:id' })).toBe(
            'UserController.findOne',
        );
    });

    it('works with compound class names', () => {
        expect(buildClassMemberAnchor({ className: 'UserService', memberName: 'createUser', nodeId: 'provider:user-svc' })).toBe(
            'UserService.createUser',
        );
    });

    it('throws when className is empty string', () => {
        expect(() => buildClassMemberAnchor({ className: '', memberName: 'findOne', nodeId: 'endpoint:GET /users' })).toThrow(
            'anchor: className is empty for endpoint:GET /users',
        );
    });

    it('throws when className is whitespace only', () => {
        expect(() => buildClassMemberAnchor({ className: '   ', memberName: 'findOne', nodeId: 'endpoint:GET /users' })).toThrow(
            'anchor: className is empty',
        );
    });

    it('throws when memberName is empty string', () => {
        expect(() => buildClassMemberAnchor({ className: 'UserController', memberName: '', nodeId: 'endpoint:GET /users' })).toThrow(
            'anchor: memberName is empty for endpoint:GET /users',
        );
    });

    it('throws when memberName is whitespace only', () => {
        expect(() => buildClassMemberAnchor({ className: 'UserController', memberName: '   ', nodeId: 'endpoint:GET /users' })).toThrow(
            'anchor: memberName is empty',
        );
    });

    it('throws when className is <anonymous>', () => {
        expect(() =>
            buildClassMemberAnchor({ className: '<anonymous>', memberName: 'findOne', nodeId: 'endpoint:GET /users' }),
        ).toThrow("anchor: className is invalid for endpoint:GET /users (got '<anonymous>')");
    });

    it('throws when memberName is <anonymous>', () => {
        expect(() =>
            buildClassMemberAnchor({ className: 'UserController', memberName: '<anonymous>', nodeId: 'endpoint:GET /users' }),
        ).toThrow("anchor: memberName is invalid for endpoint:GET /users (got '<anonymous>')");
    });

    it('throws for <anonymous> even with surrounding whitespace in the value', () => {
        // memberName must literally be '<anonymous>' (not trimmed) — whitespace trimming
        // is only for empty-string detection; '<anonymous>' is a sentinel exact match.
        expect(() =>
            buildClassMemberAnchor({ className: 'UserController', memberName: '<anonymous>', nodeId: 'node:x' }),
        ).toThrow("got '<anonymous>'");
    });

    it('nodeId appears in error messages for both className and memberName failures', () => {
        expect(() => buildClassMemberAnchor({ className: '', memberName: 'method', nodeId: 'db-entity-field:users/id' })).toThrow(
            'db-entity-field:users/id',
        );
        expect(() => buildClassMemberAnchor({ className: 'MyClass', memberName: '<anonymous>', nodeId: 'db-entity-field:users/id' })).toThrow(
            'db-entity-field:users/id',
        );
    });
});
