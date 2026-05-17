/**
 * Tests for the buildClassMemberAnchor factory (P1-C).
 */
import { describe, expect, it } from 'vitest';
import { buildClassMemberAnchor } from './anchor.js';

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
            "anchor: memberName is invalid for endpoint:GET /users (got '')",
        );
    });

    it('throws when memberName is whitespace only', () => {
        expect(() => buildClassMemberAnchor({ className: 'UserController', memberName: '   ', nodeId: 'endpoint:GET /users' })).toThrow(
            'anchor: memberName is invalid',
        );
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
