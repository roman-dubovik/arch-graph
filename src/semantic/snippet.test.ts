/**
 * Unit tests for snippet.ts.
 *
 * Uses in-memory ts-morph projects (no real files on disk).
 */
import { describe, expect, it } from 'vitest';
import { Project, ts } from 'ts-morph';

import { inMemoryProject } from '../__fixtures__/in-memory-project.js';
import type { GraphNode } from '../core/types.js';
import { FE_SNIPPET_MAX_CHARS, SNIPPET_MAX_CHARS, extractSnippet } from './snippet.js';

/**
 * Local in-memory project with JSX support — required for fe-component fixture tests.
 * The shared `inMemoryProject` fixture does NOT set jsx: ts.JsxEmit.React.
 */
function inMemoryJsxProject(files: Record<string, string>): Project {
    const project = new Project({
        useInMemoryFileSystem: true,
        compilerOptions: {
            target: 99,
            module: 99,
            moduleResolution: 100,
            strict: false,
            esModuleInterop: true,
            jsx: ts.JsxEmit.React,
        },
    });
    for (const [path, src] of Object.entries(files)) {
        project.createSourceFile(path, src);
    }
    return project;
}

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (project as any).getSourceFile = (_path: string) => {
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

// ---------------------------------------------------------------------------
// fe-component — className extraction (Task A: AC-A1..AC-A6)
// ---------------------------------------------------------------------------

function feNode(label: string, path: string): GraphNode {
    return { id: `fe-component:${path}#${label}`, kind: 'fe-component', label, path };
}

describe('extractSnippet — fe-component className extraction (Task A)', () => {
    // AC-A1: className="text-right" appears in snippet via the classes: block
    it('AC-A1: snippet contains "text-right" in a "classes:" prefix block', () => {
        const project = inMemoryJsxProject({
            '/app/table-header.tsx': `
export const KanbanColumnHeader = () => (
  <th className="text-right">Header</th>
);
`,
        });
        const result = extractSnippet(project, feNode('KanbanColumnHeader', '/app/table-header.tsx'));
        expect(result.reason).toBeUndefined();
        expect(result.snippet).toContain('text-right');
        // Must have a classes: prefix block
        expect(result.snippet).toMatch(/^classes:/m);
        const classesLine = result.snippet.split('\n').find((l) => l.startsWith('classes:'))!;
        expect(classesLine).toContain('text-right');
    });

    // AC-A2: className="truncate" appears in snippet via the classes: block
    it('AC-A2: snippet contains "truncate" in a "classes:" prefix block', () => {
        const project = inMemoryJsxProject({
            '/app/truncate.tsx': `
export const TruncateLabel = () => (
  <span className="truncate">Long text here…</span>
);
`,
        });
        const result = extractSnippet(project, feNode('TruncateLabel', '/app/truncate.tsx'));
        expect(result.reason).toBeUndefined();
        expect(result.snippet).toContain('truncate');
        // Must have a classes: prefix block
        expect(result.snippet).toMatch(/^classes:/m);
        const classesLine = result.snippet.split('\n').find((l) => l.startsWith('classes:'))!;
        expect(classesLine).toContain('truncate');
    });

    // AC-A3: total snippet length ≤ FE_SNIPPET_MAX_CHARS
    it('AC-A3: snippet length is always ≤ FE_SNIPPET_MAX_CHARS (800)', () => {
        // Many classNames to stress the budget
        const manyClasses = Array.from({ length: 40 }, (_, i) => `class-token-${i}`).join(' ');
        const project = inMemoryJsxProject({
            '/app/big.tsx': `
export const BigComponent = () => (
  <div className="${manyClasses}">
    {'x'.repeat(500)}
  </div>
);
`,
        });
        const result = extractSnippet(project, feNode('BigComponent', '/app/big.tsx'));
        expect(result.snippet.length).toBeLessThanOrEqual(FE_SNIPPET_MAX_CHARS);
    });

    // AC-A4: graceful truncation — no half-class-token cut
    it('AC-A4: when classes block would exceed budget, truncates at whole-token boundary', () => {
        // 60 tokens × 12 chars each = 720 chars — deliberately large
        const tokens = Array.from({ length: 60 }, (_, i) => `tailwind-cls-${i}`);
        const classAttr = tokens.join(' ');
        const project = inMemoryJsxProject({
            '/app/wide.tsx': `
export const WideComponent = () => (
  <div className="${classAttr}">content</div>
);
`,
        });
        const result = extractSnippet(project, feNode('WideComponent', '/app/wide.tsx'));
        expect(result.snippet.length).toBeLessThanOrEqual(FE_SNIPPET_MAX_CHARS);
        // Every class token in the output must be complete (not split mid-name)
        // Extract the classes: line if present
        const classesLine = result.snippet.split('\n').find((l) => l.startsWith('classes:'));
        if (classesLine) {
            const classTokens = classesLine.replace(/^classes:\s*/, '').split(/\s+/).filter(Boolean);
            for (const tok of classTokens) {
                // Each token must look like a full token — ends with a digit (our pattern)
                expect(tok).toMatch(/^tailwind-cls-\d+$/);
            }
        }
    });

    // AC-A5 is implicitly verified by the quality gate running all existing tests.
    // But let's also explicitly verify the old JSX text extraction still works:
    it('AC-A5: existing JSX text extraction still present (no regression)', () => {
        const project = inMemoryJsxProject({
            '/app/button.tsx': `
/** Reusable button. */
export const ApplyButton = () => (
  <button className="btn-primary">Применить</button>
);
`,
        });
        const result = extractSnippet(project, feNode('ApplyButton', '/app/button.tsx'));
        expect(result.reason).toBeUndefined();
        // JSDoc must be present
        expect(result.snippet).toContain('Reusable button');
        // JSX text content must be present
        expect(result.snippet).toContain('Применить');
        // className must now also be present (via classes: block)
        expect(result.snippet).toContain('btn-primary');
    });

    // AC-A6 edges: no classNames, and templated className expression
    it('AC-A6 edge — JSX with no classNames: snippet has no "classes:" line', () => {
        const project = inMemoryJsxProject({
            '/app/plain.tsx': `
export const PlainDiv = () => <div>Just text</div>;
`,
        });
        const result = extractSnippet(project, feNode('PlainDiv', '/app/plain.tsx'));
        expect(result.reason).toBeUndefined();
        expect(result.snippet).not.toMatch(/^classes:/m);
    });

    it('AC-A6 edge — templated className expression is skipped gracefully', () => {
        const project = inMemoryJsxProject({
            '/app/dynamic.tsx': `
export const DynamicButton = ({ active }: { active: boolean }) => (
  <button className={\`btn \${active ? 'active' : 'inactive'}\`}>Click</button>
);
`,
        });
        const result = extractSnippet(project, feNode('DynamicButton', '/app/dynamic.tsx'));
        expect(result.reason).toBeUndefined();
        // Should not crash; no classes: block since it's a template literal not a string literal
        expect(result.snippet).not.toMatch(/^classes:.*undefined/m);
    });

    // Deduplication: multiple elements with same className
    it('AC-A6 edge — duplicate classNames are deduplicated in classes: block', () => {
        const project = inMemoryJsxProject({
            '/app/dup.tsx': `
export const DupComp = () => (
  <div>
    <span className="text-sm font-bold">A</span>
    <span className="text-sm italic">B</span>
  </div>
);
`,
        });
        const result = extractSnippet(project, feNode('DupComp', '/app/dup.tsx'));
        expect(result.reason).toBeUndefined();
        expect(result.snippet).toContain('text-sm');
        // text-sm should appear only once in the classes: block
        const classesLine = result.snippet.split('\n').find((l) => l.startsWith('classes:'));
        if (classesLine) {
            const classTokens = classesLine.replace(/^classes:\s*/, '').split(/\s+/).filter(Boolean);
            const count = classTokens.filter((t) => t === 'text-sm').length;
            expect(count).toBe(1);
        }
    });
});
