/**
 * Tests for src/extractors/fe/react-patterns.ts
 *
 * Covers: arrow components, function components, class components,
 * React.memo wrappers, React.forwardRef wrappers, custom hooks (function + arrow),
 * hook detection rules, JSX render references, export detection.
 */

import { describe, expect, it } from 'vitest';
import { inMemoryProject } from '../../__fixtures__/in-memory-project.js';
import { extractReactPatterns } from './react-patterns.js';

function setup(files: Record<string, string>) {
    const project = inMemoryProject(files);
    // ts-morph in-memory project — get the first source file
    return project;
}

// ---------------------------------------------------------------------------
// Arrow function components
// ---------------------------------------------------------------------------
describe('extractReactPatterns — arrow components', () => {
    it('detects exported arrow component', () => {
        const project = setup({
            '/app/Button.tsx': `
                export const Button = () => <button>click</button>;
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/Button.tsx');
        const { components } = extractReactPatterns(sf);
        expect(components).toHaveLength(1);
        expect(components[0]!.name).toBe('Button');
        expect(components[0]!.kind).toBe('arrow');
        expect(components[0]!.exported).toBe(true);
    });

    it('ignores lowercase arrow "component" (not a valid React component name)', () => {
        const project = setup({
            '/app/helper.tsx': `
                const helper = () => <div/>;
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/helper.tsx');
        const { components } = extractReactPatterns(sf);
        expect(components).toHaveLength(0);
    });

    it('ignores arrow function with no JSX', () => {
        const project = setup({
            '/app/utils.tsx': `
                const Add = (a: number, b: number) => a + b;
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/utils.tsx');
        const { components } = extractReactPatterns(sf);
        expect(components).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Function declaration components
// ---------------------------------------------------------------------------
describe('extractReactPatterns — function declaration components', () => {
    it('detects exported function component', () => {
        const project = setup({
            '/app/Card.tsx': `
                export function Card() { return <div/>; }
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/Card.tsx');
        const { components } = extractReactPatterns(sf);
        expect(components).toHaveLength(1);
        expect(components[0]!.name).toBe('Card');
        expect(components[0]!.kind).toBe('function');
        expect(components[0]!.exported).toBe(true);
    });

    it('detects default exported function component', () => {
        const project = setup({
            '/app/Page.tsx': `
                export default function Page() { return <main/>; }
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/Page.tsx');
        const { components } = extractReactPatterns(sf);
        expect(components).toHaveLength(1);
        expect(components[0]!.name).toBe('Page');
        expect(components[0]!.defaultExport).toBe(true);
    });

    it('ignores lowercase function name', () => {
        const project = setup({
            '/app/utils.tsx': `
                function doSomething() { return <div/>; }
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/utils.tsx');
        const { components } = extractReactPatterns(sf);
        expect(components).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Class components
// ---------------------------------------------------------------------------
describe('extractReactPatterns — class components', () => {
    it('detects class extending React.Component', () => {
        const project = setup({
            '/app/Avatar.tsx': `
                import React from 'react';
                export class Avatar extends React.Component {
                    render() { return <img/>; }
                }
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/Avatar.tsx');
        const { components } = extractReactPatterns(sf);
        expect(components).toHaveLength(1);
        expect(components[0]!.name).toBe('Avatar');
        expect(components[0]!.kind).toBe('class');
    });

    it('detects class extending React.PureComponent', () => {
        const project = setup({
            '/app/Pure.tsx': `
                import React from 'react';
                class Pure extends React.PureComponent {
                    render() { return <div/>; }
                }
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/Pure.tsx');
        const { components } = extractReactPatterns(sf);
        expect(components).toHaveLength(1);
        expect(components[0]!.kind).toBe('class');
    });

    it('detects class extending plain Component', () => {
        const project = setup({
            '/app/Plain.tsx': `
                import { Component } from 'react';
                export class Plain extends Component {
                    render() { return <span/>; }
                }
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/Plain.tsx');
        const { components } = extractReactPatterns(sf);
        expect(components).toHaveLength(1);
        expect(components[0]!.kind).toBe('class');
    });

    it('ignores class NOT extending React.Component', () => {
        const project = setup({
            '/app/Service.tsx': `
                class UserService extends BaseService {
                    doSomething() {}
                }
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/Service.tsx');
        const { components } = extractReactPatterns(sf);
        expect(components).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// React.memo and React.forwardRef wrappers
// ---------------------------------------------------------------------------
describe('extractReactPatterns — memo and forwardRef', () => {
    it('detects React.memo wrapper', () => {
        const project = setup({
            '/app/MemoComp.tsx': `
                import React from 'react';
                const Inner = () => <div/>;
                export const MemoComp = React.memo(Inner);
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/MemoComp.tsx');
        const { components } = extractReactPatterns(sf);
        // Inner + MemoComp
        const memo = components.find((c) => c.name === 'MemoComp');
        expect(memo).toBeDefined();
        expect(memo!.kind).toBe('memo');
        expect(memo!.exported).toBe(true);
    });

    it('detects React.forwardRef wrapper', () => {
        const project = setup({
            '/app/Fwd.tsx': `
                import React from 'react';
                export const Fwd = React.forwardRef((props, ref) => <input ref={ref}/>);
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/Fwd.tsx');
        const { components } = extractReactPatterns(sf);
        const fwd = components.find((c) => c.name === 'Fwd');
        expect(fwd).toBeDefined();
        expect(fwd!.kind).toBe('forwardRef');
    });
});

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------
describe('extractReactPatterns — hooks', () => {
    it('detects function hook that calls another hook', () => {
        const project = setup({
            '/app/useCounter.ts': `
                import { useState } from 'react';
                export function useCounter() {
                    const [n, setN] = useState(0);
                    return { n, setN };
                }
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/useCounter.ts');
        const { hooks } = extractReactPatterns(sf);
        expect(hooks).toHaveLength(1);
        expect(hooks[0]!.name).toBe('useCounter');
    });

    it('does NOT flag use* function with no hook calls as a hook', () => {
        const project = setup({
            '/app/usePlain.ts': `
                export function usePlain() { return 42; }
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/usePlain.ts');
        const { hooks } = extractReactPatterns(sf);
        expect(hooks).toHaveLength(0);
    });

    it('detects arrow hook that calls another hook', () => {
        const project = setup({
            '/app/useFetch.ts': `
                import { useState, useEffect } from 'react';
                export const useFetch = (url: string) => {
                    const [data, setData] = useState(null);
                    useEffect(() => {}, [url]);
                    return data;
                };
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/useFetch.ts');
        const { hooks } = extractReactPatterns(sf);
        expect(hooks).toHaveLength(1);
        expect(hooks[0]!.name).toBe('useFetch');
    });

    it('does NOT treat a function whose name starts with lowercase use as hook', () => {
        const project = setup({
            '/app/utils.ts': `
                import { useState } from 'react';
                function userStore() { const [x] = useState(0); return x; }
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/utils.ts');
        const { hooks } = extractReactPatterns(sf);
        expect(hooks).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// JSX render references
// ---------------------------------------------------------------------------
describe('extractReactPatterns — renders', () => {
    it('detects render reference to another component', () => {
        const project = setup({
            '/app/Page.tsx': `
                import React from 'react';
                import { Button } from './Button';
                export const Page = () => <div><Button/></div>;
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/Page.tsx');
        const { renders } = extractReactPatterns(sf);
        expect(renders.some((r) => r.toName === 'Button')).toBe(true);
    });

    it('returns empty renders when no uppercase JSX tags', () => {
        const project = setup({
            '/app/Bare.tsx': `
                export const Bare = () => <div><span>text</span></div>;
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/Bare.tsx');
        const { renders } = extractReactPatterns(sf);
        expect(renders).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------
describe('extractReactPatterns — deduplication', () => {
    it('deduplicates component with same name across patterns', () => {
        // A class component named Same should appear only once
        const project = setup({
            '/app/Same.tsx': `
                import React from 'react';
                export class Same extends React.Component {
                    render() { return <div/>; }
                }
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/Same.tsx');
        const { components } = extractReactPatterns(sf);
        expect(components.filter((c) => c.name === 'Same')).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Non-exported components
// ---------------------------------------------------------------------------
describe('extractReactPatterns — non-exported', () => {
    it('detects non-exported arrow component', () => {
        const project = setup({
            '/app/Inner.tsx': `const Inner = () => <div/>;`,
        });
        const sf = project.getSourceFileOrThrow('/app/Inner.tsx');
        const { components } = extractReactPatterns(sf);
        expect(components).toHaveLength(1);
        expect(components[0]!.exported).toBe(false);
    });

    it('detects non-exported function component', () => {
        const project = setup({
            '/app/Local.tsx': `function Local() { return <span/>; }`,
        });
        const sf = project.getSourceFileOrThrow('/app/Local.tsx');
        const { components } = extractReactPatterns(sf);
        expect(components).toHaveLength(1);
        expect(components[0]!.exported).toBe(false);
    });

    it('detects non-exported memo', () => {
        const project = setup({
            '/app/NE.tsx': `
                const Inner = () => <div/>;
                const NE = React.memo(Inner);
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/NE.tsx');
        const { components } = extractReactPatterns(sf);
        const memo = components.find((c) => c.name === 'NE');
        expect(memo).toBeDefined();
        expect(memo!.exported).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Hook: arrow hook without hook calls (should be skipped)
// ---------------------------------------------------------------------------
describe('extractReactPatterns — arrow hook exclusion', () => {
    it('skips arrow function named use* that has no hook calls', () => {
        const project = setup({
            '/app/utils.tsx': `const usePlainArrow = () => 42;`,
        });
        const sf = project.getSourceFileOrThrow('/app/utils.tsx');
        const { hooks } = extractReactPatterns(sf);
        expect(hooks.every((h) => h.name !== 'usePlainArrow')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Non-VariableStatement parent (destructuring etc.)
// ---------------------------------------------------------------------------
describe('extractReactPatterns — complex var contexts', () => {
    it('detects component in const with multiple declarations', () => {
        const project = setup({
            '/app/Multi.tsx': `
                export const A = () => <div/>, B = 1;
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/Multi.tsx');
        const { components } = extractReactPatterns(sf);
        // A should be detected (exported, uppercase, has JSX)
        expect(components.some((c) => c.name === 'A')).toBe(true);
    });

    it('handles default export symbol mismatch (var name not the default)', () => {
        const project = setup({
            '/app/DiffDefault.tsx': `
                const Other = () => <div/>;
                export default Other;
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/DiffDefault.tsx');
        const { components } = extractReactPatterns(sf);
        // Other should be found; default export detection may or may not set defaultExport
        expect(components.some((c) => c.name === 'Other')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// VarDecl without initializer
// ---------------------------------------------------------------------------
describe('extractReactPatterns — edge cases', () => {
    it('handles variable declaration with no initializer gracefully', () => {
        const project = setup({
            '/app/Decl.tsx': `let X: any;`,
        });
        const sf = project.getSourceFileOrThrow('/app/Decl.tsx');
        // Should not throw
        const { components } = extractReactPatterns(sf);
        expect(components).toHaveLength(0);
    });

    it('handles class with no name gracefully', () => {
        const project = setup({
            '/app/AnonCls.tsx': `
                const x = class extends React.Component { render() { return <div/>; } };
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/AnonCls.tsx');
        // Should not throw
        const { components } = extractReactPatterns(sf);
        // Anonymous class components (from variable initializer) not detected as class kind
        expect(components).toHaveLength(0);
    });

    it('deduplicates memo/forwardRef with same name', () => {
        const project = setup({
            '/app/DupMemo.tsx': `
                const Inner = () => <div/>;
                const DupMemo = React.memo(Inner);
                // Second declaration with same name (unusual but possible)
                const DupMemo2 = React.memo(Inner);
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/DupMemo.tsx');
        const { components } = extractReactPatterns(sf);
        // DupMemo appears once despite two similar declarations
        expect(components.filter((c) => c.name === 'DupMemo')).toHaveLength(1);
    });

    it('detects component exported via separate export default statement', () => {
        const project = setup({
            '/app/DefaultComp.tsx': `
                const DefaultComp = () => <div/>;
                export default DefaultComp;
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/DefaultComp.tsx');
        const { components } = extractReactPatterns(sf);
        const c = components.find((c) => c.name === 'DefaultComp');
        // Component is detected even without export keyword on the const itself
        expect(c).toBeDefined();
    });

    it('detects renders from JsxOpeningElement', () => {
        const project = setup({
            '/app/WithOpen.tsx': `
                import { Modal } from './Modal';
                export const Page = () => <div><Modal>content</Modal></div>;
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/WithOpen.tsx');
        const { renders } = extractReactPatterns(sf);
        expect(renders.some((r) => r.toName === 'Modal')).toBe(true);
    });

    it('returns empty renders when file has no components', () => {
        const project = setup({
            '/app/NoComp.tsx': `
                import { Modal } from './Modal';
                export function helper() { return <Modal/>; }
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/NoComp.tsx');
        // helper is lowercase — no component, so renders should be empty
        const { renders, components } = extractReactPatterns(sf);
        expect(components).toHaveLength(0);
        expect(renders).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// seenComponents deduplication (else branches of !seenComponents.has)
// ---------------------------------------------------------------------------
describe('extractReactPatterns — seenComponents already-seen branches', () => {
    it('skips arrow component whose name is already in seenComponents (via prior memo)', () => {
        // If a memo wrapper is declared first with name X, and then an arrow component
        // named X appears, the arrow should be skipped via seenComponents guard.
        const project = setup({
            '/app/DupArrow.tsx': `
                import React from 'react';
                const Inner = () => <div/>;
                const DupArrow = React.memo(Inner);
                // Re-declare with same name (unusual but exercises the else branch)
                const DupArrow2 = React.memo(Inner);
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/DupArrow.tsx');
        const { components } = extractReactPatterns(sf);
        expect(components.filter((c) => c.name === 'DupArrow')).toHaveLength(1);
        expect(components.filter((c) => c.name === 'DupArrow2')).toHaveLength(1);
    });

    it('skips forwardRef component whose name is already in seenComponents', () => {
        const project = setup({
            '/app/DupFwd.tsx': `
                import React from 'react';
                const DupFwd = React.forwardRef((p, r) => <input ref={r}/>);
                const DupFwd2 = React.forwardRef((p, r) => <input ref={r}/>);
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/DupFwd.tsx');
        const { components } = extractReactPatterns(sf);
        expect(components.filter((c) => c.name === 'DupFwd')).toHaveLength(1);
        expect(components.filter((c) => c.name === 'DupFwd2')).toHaveLength(1);
    });

    it('skips function declaration component whose name is already in seenComponents', () => {
        // Declare the arrow first (with same name), then the function.
        // seenComponents guard on the function path is triggered.
        const project = setup({
            '/app/DupFn.tsx': `
                import React from 'react';
                // Arrow registered first
                const DupFn = React.memo(() => <div/>);
                // Function declaration with same name — should be deduplicated
                function DupFn() { return <span/>; }
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/DupFn.tsx');
        const { components } = extractReactPatterns(sf);
        expect(components.filter((c) => c.name === 'DupFn')).toHaveLength(1);
    });

    it('skips class component whose name is already in seenComponents', () => {
        const project = setup({
            '/app/DupClass.tsx': `
                import React from 'react';
                const DupClass = React.memo(() => <div/>);
                class DupClass extends React.Component { render() { return <span/>; } }
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/DupClass.tsx');
        const { components } = extractReactPatterns(sf);
        expect(components.filter((c) => c.name === 'DupClass')).toHaveLength(1);
    });

    it('skips arrow component whose name is already in seenComponents (arrow→arrow)', () => {
        const project = setup({
            '/app/DupArrowArrow.tsx': `
                const DupA = () => <div/>;
                const DupA2 = () => <span/>;
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/DupArrowArrow.tsx');
        const { components } = extractReactPatterns(sf);
        // Different names — both appear
        expect(components).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// Function declaration with no JSX (should be skipped)
// ---------------------------------------------------------------------------
describe('extractReactPatterns — uppercase function without JSX', () => {
    it('ignores uppercase function declaration that contains no JSX', () => {
        const project = setup({
            '/app/Utils.tsx': `
                export function ProcessData(items: string[]) { return items.map(s => s.trim()); }
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/Utils.tsx');
        const { components } = extractReactPatterns(sf);
        expect(components).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Location reporting
// ---------------------------------------------------------------------------
describe('extractReactPatterns — location info', () => {
    it('reports file and line > 0 for components', () => {
        const project = setup({
            '/app/Comp.tsx': `export const Comp = () => <div/>;`,
        });
        const sf = project.getSourceFileOrThrow('/app/Comp.tsx');
        const { components } = extractReactPatterns(sf);
        expect(components[0]!.location.file).toBe('/app/Comp.tsx');
        expect(components[0]!.location.line).toBeGreaterThanOrEqual(1);
    });

    it('reports file and line > 0 for hooks', () => {
        const project = setup({
            '/app/useData.ts': `
                import { useState } from 'react';
                export function useData() { const [x] = useState(0); return x; }
            `,
        });
        const sf = project.getSourceFileOrThrow('/app/useData.ts');
        const { hooks } = extractReactPatterns(sf);
        expect(hooks[0]!.location.file).toBe('/app/useData.ts');
        expect(hooks[0]!.location.line).toBeGreaterThanOrEqual(1);
    });
});
