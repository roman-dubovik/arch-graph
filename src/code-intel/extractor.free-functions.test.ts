import { describe, expect, it } from 'vitest';

import { inMemoryProject } from '../__fixtures__/in-memory-project.js';
import { extractCodeIntel } from './extractor.js';
import { findReferences, resolveSymbol } from './queries.js';

const ROOT = '/root';

/**
 * Feature: `feat/free-functions-v1` — extract arrow-const / function-expression
 * exports as `kind: 'function'` symbols.
 *
 * Pre-feature gap: `sf.getFunctions()` covers only `function foo() {}`-shape
 * declarations. Arrow-const exports (`export const foo = () => {}`) — the most
 * common shape in modern TS — are silently dropped from the index, so:
 *   - `resolveSymbol('foo')` returns nothing.
 *   - `findReferences('foo')` returns nothing.
 *   - `traceScenario('foo')` returns `entry-not-found`.
 *
 * Class methods do not have this problem (covered by `cls.getMethods()`).
 *
 * RED-state contract: every test below asserts symbols / references / call
 * edges produced for arrow-const exports. They currently fail; the extractor
 * patch makes them GREEN without touching the queries layer.
 */
describe('extractCodeIntel — free arrow-const / function-expression exports (RED)', () => {
    it('extracts a top-level arrow-const export as a function symbol', () => {
        const project = inMemoryProject({
            '/root/src/util.ts': `
                /** Trim then lowercase. */
                export const normalize = (s: string): string => s.trim().toLowerCase();
            `,
        });

        const index = extractCodeIntel(project, { root: ROOT });

        const fn = index.symbols.find((s) => s.fqn === 'normalize');
        expect(fn).toBeDefined();
        expect(fn?.kind).toBe('function');
        expect(fn?.file).toMatch(/src\/util\.ts$/);
        expect(fn?.returnType).toMatch(/string/);
        expect(fn?.description).toMatch(/Trim then lowercase/);
    });

    it('extracts an arrow-const without `export` keyword too', () => {
        const project = inMemoryProject({
            '/root/src/util.ts': `
                const internal = (n: number) => n + 1;
                export const callsInternal = () => internal(0);
            `,
        });

        const index = extractCodeIntel(project, { root: ROOT });

        const internal = index.symbols.find((s) => s.fqn === 'internal');
        const callsInternal = index.symbols.find((s) => s.fqn === 'callsInternal');
        expect(internal).toBeDefined();
        expect(internal?.kind).toBe('function');
        expect(callsInternal).toBeDefined();
        expect(callsInternal?.kind).toBe('function');
    });

    it('detects async on arrow-const', () => {
        const project = inMemoryProject({
            '/root/src/util.ts': `
                export const fetchData = async (id: string): Promise<string> => {
                    return id;
                };
            `,
        });

        const index = extractCodeIntel(project, { root: ROOT });

        const fn = index.symbols.find((s) => s.fqn === 'fetchData');
        expect(fn).toBeDefined();
        expect(fn?.isAsync).toBe(true);
    });

    it('extracts a function-expression export (named-function form)', () => {
        const project = inMemoryProject({
            '/root/src/util.ts': `
                export const handler = function namedFn(x: number) {
                    return x * 2;
                };
            `,
        });

        const index = extractCodeIntel(project, { root: ROOT });

        // Symbol fqn comes from the VARIABLE name (handler), not the inner
        // function-expression name (namedFn).
        const fn = index.symbols.find((s) => s.fqn === 'handler');
        expect(fn).toBeDefined();
        expect(fn?.kind).toBe('function');
    });

    it('captures parameters as separate `param` symbols (same as for `function` declarations)', () => {
        const project = inMemoryProject({
            '/root/src/util.ts': `
                export const add = (a: number, b: number): number => a + b;
            `,
        });

        const index = extractCodeIntel(project, { root: ROOT });

        const aParam = index.symbols.find((s) => s.fqn === 'add.a');
        const bParam = index.symbols.find((s) => s.fqn === 'add.b');
        expect(aParam).toBeDefined();
        expect(aParam?.kind).toBe('param');
        expect(aParam?.type).toMatch(/number/);
        expect(bParam).toBeDefined();
    });

    it('does NOT register a function symbol for non-function variable initializers', () => {
        // Plain const exports — strings, numbers, object literals — must NOT
        // get a 'function' symbol. We don't index those at all in this layer.
        const project = inMemoryProject({
            '/root/src/util.ts': `
                export const PI = 3.14;
                export const greeting = 'hello';
                export const config = { enabled: true };
            `,
        });

        const index = extractCodeIntel(project, { root: ROOT });

        expect(index.symbols.find((s) => s.fqn === 'PI')).toBeUndefined();
        expect(index.symbols.find((s) => s.fqn === 'greeting')).toBeUndefined();
        expect(index.symbols.find((s) => s.fqn === 'config')).toBeUndefined();
    });

    it('emits a call edge when an arrow-const calls another arrow-const', () => {
        const project = inMemoryProject({
            '/root/src/util.ts': `
                export const helper = (x: string) => x.trim();
                export const consumer = (input: string) => {
                    return helper(input);
                };
            `,
        });

        const index = extractCodeIntel(project, { root: ROOT });

        const helper = index.symbols.find((s) => s.fqn === 'helper')!;
        const consumer = index.symbols.find((s) => s.fqn === 'consumer')!;
        expect(helper).toBeDefined();
        expect(consumer).toBeDefined();

        const call = index.calls.find(
            (c) => c.callerId === consumer.id && c.calleeId === helper.id,
        );
        expect(call).toBeDefined();
    });

    it('resolveSymbol returns the arrow-const function', () => {
        const project = inMemoryProject({
            '/root/src/util.ts': `
                export const lookupByName = (name: string) => name.toUpperCase();
            `,
        });

        const index = extractCodeIntel(project, { root: ROOT });

        const result = resolveSymbol(index, 'lookupByName');
        const match = result.matches.find((s) => s.fqn === 'lookupByName');
        expect(match).toBeDefined();
        expect(match?.kind).toBe('function');
    });

    it('findReferences returns call sites of an arrow-const exported function', () => {
        const project = inMemoryProject({
            '/root/src/util.ts': `
                export const target = (x: string) => x;
                export const callerOne = (s: string) => target(s);
                export const callerTwo = (s: string) => target(s + '!');
            `,
        });

        const index = extractCodeIntel(project, { root: ROOT });

        const refs = findReferences(index, { symbol: 'target' });
        const callRefs = refs.references.filter((r) => r.kind === 'call');
        expect(callRefs.length).toBeGreaterThanOrEqual(2);
    });

    it('captures destructuring patterns and rest params correctly (no crash)', () => {
        // Edge case: per-class-isolation-style — funky params must not crash
        // the whole extractor.
        const project = inMemoryProject({
            '/root/src/util.ts': `
                export const destructured = ({ id, name }: { id: string; name: string }) => id + name;
                export const rest = (...args: number[]) => args.length;
            `,
        });

        const index = extractCodeIntel(project, { root: ROOT });

        // Both functions must be present even though one has a destructured
        // param and another has a rest param.
        expect(index.symbols.find((s) => s.fqn === 'destructured')).toBeDefined();
        expect(index.symbols.find((s) => s.fqn === 'rest')).toBeDefined();
    });
});
