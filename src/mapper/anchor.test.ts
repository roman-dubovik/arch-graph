/**
 * Tests for the buildClassMemberAnchor factory (P1-C).
 */
import { describe, expect, it } from 'vitest';
import { buildClassMemberAnchor } from './anchor.js';

describe('buildClassMemberAnchor', () => {
    it('returns "ClassName.memberName" for valid inputs', () => {
        expect(buildClassMemberAnchor('UserController', 'findOne', 'endpoint:GET /users/:id')).toBe(
            'UserController.findOne',
        );
    });

    it('works with compound class names', () => {
        expect(buildClassMemberAnchor('UserService', 'createUser', 'provider:user-svc')).toBe(
            'UserService.createUser',
        );
    });

    it('throws when className is empty string', () => {
        expect(() => buildClassMemberAnchor('', 'findOne', 'endpoint:GET /users')).toThrow(
            'anchor: className is empty for endpoint:GET /users',
        );
    });

    it('throws when className is whitespace only', () => {
        expect(() => buildClassMemberAnchor('   ', 'findOne', 'endpoint:GET /users')).toThrow(
            'anchor: className is empty',
        );
    });

    it('throws when memberName is empty string', () => {
        expect(() => buildClassMemberAnchor('UserController', '', 'endpoint:GET /users')).toThrow(
            "anchor: memberName is invalid for endpoint:GET /users (got '')",
        );
    });

    it('throws when memberName is whitespace only', () => {
        expect(() => buildClassMemberAnchor('UserController', '   ', 'endpoint:GET /users')).toThrow(
            'anchor: memberName is invalid',
        );
    });

    it('throws when memberName is <anonymous>', () => {
        expect(() =>
            buildClassMemberAnchor('UserController', '<anonymous>', 'endpoint:GET /users'),
        ).toThrow("anchor: memberName is invalid for endpoint:GET /users (got '<anonymous>')");
    });

    it('throws for <anonymous> even with surrounding whitespace in the value', () => {
        // memberName must literally be '<anonymous>' (not trimmed) — whitespace trimming
        // is only for empty-string detection; '<anonymous>' is a sentinel exact match.
        expect(() =>
            buildClassMemberAnchor('UserController', '<anonymous>', 'node:x'),
        ).toThrow("got '<anonymous>'");
    });

    it('nodeId appears in error messages for both className and memberName failures', () => {
        expect(() => buildClassMemberAnchor('', 'method', 'db-entity-field:users/id')).toThrow(
            'db-entity-field:users/id',
        );
        expect(() => buildClassMemberAnchor('MyClass', '<anonymous>', 'db-entity-field:users/id')).toThrow(
            'db-entity-field:users/id',
        );
    });
});
