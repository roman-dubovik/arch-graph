/**
 * Unit tests for snippet.ts.
 *
 * Uses in-memory ts-morph projects (no real files on disk).
 */
import { describe, expect, it } from 'vitest';

import { inMemoryProject } from '../__fixtures__/in-memory-project.js';
import type { GraphNode } from '../core/types.js';
import { SNIPPET_MAX_CHARS, extractSnippet } from './snippet.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<GraphNode> & Pick<GraphNode, 'id' | 'kind' | 'label'>): GraphNode {
    return { ...overrides };
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe('extractSnippet — nodes with no path', () => {
    it('returns empty snippet and no reason for nats-subject node', () => {
        const project = inMemoryProject({});
        const node = makeNode({ id: 'n1', kind: 'nats-subject', label: 'agent.events' });
        const result = extractSnippet(project, node);
        expect(result.snippet).toBe('');
        expect(result.reason).toBeUndefined();
    });

    it('returns empty snippet and no reason for db-table node', () => {
        const project = inMemoryProject({});
        const node = makeNode({ id: 'n2', kind: 'db-table', label: 'users' });
        const result = extractSnippet(project, node);
        expect(result.snippet).toBe('');
        expect(result.reason).toBeUndefined();
    });
});

describe('extractSnippet — class declaration found by label', () => {
    it('returns the class text when label matches a class in the file', () => {
        const project = inMemoryProject({
            '/project/src/user.service.ts': `
export class UserService {
    getAll() { return []; }
}
`,
        });
        const node = makeNode({
            id: 'service:UserService',
            kind: 'service',
            label: 'UserService',
            path: '/project/src/user.service.ts',
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toContain('UserService');
        expect(result.reason).toBeUndefined();
        expect(result.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    });

    it('returns the function text when label matches a function', () => {
        const project = inMemoryProject({
            '/project/src/utils.ts': `export function buildGraph() { return {}; }`,
        });
        const node = makeNode({
            id: 'fn:buildGraph',
            kind: 'file',
            label: 'buildGraph',
            path: '/project/src/utils.ts',
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toContain('buildGraph');
        expect(result.reason).toBeUndefined();
    });

    it('caps snippet at SNIPPET_MAX_CHARS (400)', () => {
        const longBody = 'x'.repeat(500);
        const project = inMemoryProject({
            '/project/src/big.ts': `export class BigClass { body = \`${longBody}\`; }`,
        });
        const node = makeNode({
            id: 'service:BigClass',
            kind: 'service',
            label: 'BigClass',
            path: '/project/src/big.ts',
        });
        const result = extractSnippet(project, node);
        expect(result.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    });
});

describe('extractSnippet — interface and type alias', () => {
    it('extracts interface text when label matches an interface', () => {
        const project = inMemoryProject({
            '/project/src/types.ts': `export interface MyInterface { name: string; }`,
        });
        const node = makeNode({
            id: 'type:MyInterface',
            kind: 'file',
            label: 'MyInterface',
            path: '/project/src/types.ts',
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toContain('MyInterface');
        expect(result.reason).toBeUndefined();
    });

    it('extracts type alias text when label matches', () => {
        const project = inMemoryProject({
            '/project/src/types.ts': `export type MyAlias = string | number;`,
        });
        const node = makeNode({
            id: 'type:MyAlias',
            kind: 'file',
            label: 'MyAlias',
            path: '/project/src/types.ts',
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toContain('MyAlias');
        expect(result.reason).toBeUndefined();
    });
});

describe('extractSnippet — variable declaration', () => {
    it('extracts variable declaration text', () => {
        const project = inMemoryProject({
            '/project/src/constants.ts': `export const MY_CONST = 42;`,
        });
        const node = makeNode({
            id: 'const:MY_CONST',
            kind: 'file',
            label: 'MY_CONST',
            path: '/project/src/constants.ts',
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toContain('MY_CONST');
        expect(result.reason).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Failure / edge cases
// ---------------------------------------------------------------------------

describe('extractSnippet — failures return values, never throw', () => {
    it('returns empty snippet with reason when file is not in project', () => {
        const project = inMemoryProject({});
        const node = makeNode({
            id: 'service:Missing',
            kind: 'service',
            label: 'Missing',
            path: '/project/src/missing.ts',
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toBe('');
        expect(result.reason).toBeDefined();
        expect(result.reason!.kind).toBe('file-not-found');
        expect((result.reason as { kind: 'file-not-found'; path: string }).path).toContain('missing.ts');
    });

    it('returns empty snippet with label-not-located reason when label is absent in file', () => {
        const project = inMemoryProject({
            '/project/src/service.ts': `export class OtherClass {}`,
        });
        const node = makeNode({
            id: 'service:NotHere',
            kind: 'service',
            label: 'NotHere',
            path: '/project/src/service.ts',
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toBe('');
        expect(result.reason).toBeDefined();
        expect(result.reason!.kind).toBe('label-not-located');
        expect((result.reason as { kind: 'label-not-located'; label: string }).label).toBe('NotHere');
    });

    it('does not throw for any input combination', () => {
        const project = inMemoryProject({});
        const weirdNode = makeNode({
            id: 'weird',
            kind: 'external',
            label: '',
            path: '/nonexistent/path/file.ts',
        });
        expect(() => extractSnippet(project, weirdNode)).not.toThrow();
    });

    it('catches ts-morph errors and returns them as values', () => {
        // Create a project and monkey-patch getSourceFile to throw, exercising the catch branch.
        const project = inMemoryProject({
            '/project/src/throws.ts': 'export class ThrowClass {}',
        });
        project.getSourceFile = (_path: string) => {
            throw new Error('synthetic-ts-morph-error');
        };
        const node = makeNode({
            id: 'service:ThrowClass',
            kind: 'service',
            label: 'ThrowClass',
            path: '/project/src/throws.ts',
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toBe('');
        expect(result.reason).toBeDefined();
        expect(result.reason!.kind).toBe('ts-morph-error');
        expect((result.reason as { kind: 'ts-morph-error'; message: string }).message).toContain('synthetic-ts-morph-error');
    });
});
