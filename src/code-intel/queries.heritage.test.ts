import { describe, expect, it } from 'vitest';

import {
    explainDataFlow,
    findReferences,
    getTypeDefinition,
    impactContract,
    resolveSymbol,
    selfCheck,
    traceScenario,
} from './queries.js';
import type { CodeIntelCall, CodeIntelImpact, CodeIntelIndex, CodeIntelSymbol } from './types.js';

/**
 * Hand-rolled mock index modelling the canonical heritage shape:
 *
 *   FooBase (class)
 *     ├ run(dto)  ← real implementation
 *     └ doMore(dto)  ← inherited only, not overridden
 *
 *   FooImpl extends FooBase (class)
 *     └ run(dto)  ← delegation wrapper (`return super.run(dto)`)
 *
 *   Routes:
 *     - HTTP GET /foo → FooImpl.run (decorator-wrapped, delegates)
 *     - Internal caller: SomeService.invoke → FooImpl.run
 *
 *   And a separate AugmentedImpl extends FooBase whose `run` is augmented
 *   (used to verify B8 keeps collisions dangerous when ANY duplicate
 *   is augmented/replaced).
 */
function buildHeritageMockIndex(): CodeIntelIndex {
    const symbols: CodeIntelSymbol[] = [
        // Base class + members.
        { id: 'sym:FooBase', kind: 'class', name: 'FooBase', fqn: 'FooBase', file: 'src/base.ts', line: 1, column: 1, endLine: 20 },
        {
            id: 'sym:FooBase.run',
            kind: 'method',
            name: 'run',
            fqn: 'FooBase.run',
            file: 'src/base.ts',
            line: 4,
            column: 5,
            parentId: 'sym:FooBase',
            ownerName: 'FooBase',
        },
        {
            id: 'sym:FooBase.doMore',
            kind: 'method',
            name: 'doMore',
            fqn: 'FooBase.doMore',
            file: 'src/base.ts',
            line: 10,
            column: 5,
            parentId: 'sym:FooBase',
            ownerName: 'FooBase',
        },
        // Delegation subclass.
        {
            id: 'sym:FooImpl',
            kind: 'class',
            name: 'FooImpl',
            fqn: 'FooImpl',
            file: 'src/foo.controller.ts',
            line: 1,
            column: 1,
            endLine: 12,
            extendsClass: 'sym:FooBase',
        },
        {
            id: 'sym:FooImpl.run',
            kind: 'method',
            name: 'run',
            fqn: 'FooImpl.run',
            file: 'src/foo.controller.ts',
            line: 4,
            column: 5,
            parentId: 'sym:FooImpl',
            ownerName: 'FooImpl',
            inheritsFrom: 'sym:FooBase.run',
            overrideKind: 'delegation',
            decorators: ['@Get(\'/foo\')'],
        },
        // Augmented subclass — used for B8 collision-still-dangerous test.
        {
            id: 'sym:AugmentedImpl',
            kind: 'class',
            name: 'AugmentedImpl',
            fqn: 'AugmentedImpl',
            file: 'src/augmented.controller.ts',
            line: 1,
            column: 1,
            endLine: 12,
            extendsClass: 'sym:FooBase',
        },
        {
            id: 'sym:AugmentedImpl.run',
            kind: 'method',
            name: 'run',
            fqn: 'AugmentedImpl.run',
            file: 'src/augmented.controller.ts',
            line: 4,
            column: 5,
            parentId: 'sym:AugmentedImpl',
            ownerName: 'AugmentedImpl',
            inheritsFrom: 'sym:FooBase.run',
            overrideKind: 'augmented',
        },
        // A caller in a separate service.
        {
            id: 'sym:SomeService',
            kind: 'class',
            name: 'SomeService',
            fqn: 'SomeService',
            file: 'src/service.ts',
            line: 1,
            column: 1,
            endLine: 10,
        },
        {
            id: 'sym:SomeService.invoke',
            kind: 'method',
            name: 'invoke',
            fqn: 'SomeService.invoke',
            file: 'src/service.ts',
            line: 3,
            column: 5,
            parentId: 'sym:SomeService',
            ownerName: 'SomeService',
        },
    ];

    const calls: CodeIntelCall[] = [
        // Super-call edge from FooImpl.run → FooBase.run.
        {
            id: 'call:FooImpl.run:super:1:5:9',
            callerId: 'sym:FooImpl.run',
            caller: 'FooImpl.run',
            callee: 'FooBase.run',
            calleeId: 'sym:FooBase.run',
            kind: 'super-call',
            order: 1,
            file: 'src/foo.controller.ts',
            line: 5,
            column: 9,
            expression: 'super.run(dto)',
            args: ['dto'],
        },
        // Super-call edge from AugmentedImpl.run → FooBase.run.
        {
            id: 'call:AugmentedImpl.run:super:1:5:9',
            callerId: 'sym:AugmentedImpl.run',
            caller: 'AugmentedImpl.run',
            callee: 'FooBase.run',
            calleeId: 'sym:FooBase.run',
            kind: 'super-call',
            order: 1,
            file: 'src/augmented.controller.ts',
            line: 5,
            column: 9,
            expression: 'super.run(dto)',
            args: ['dto'],
        },
        // SomeService.invoke calls FooImpl.run (the delegation wrapper).
        {
            id: 'call:SomeService.invoke:1:4:9',
            callerId: 'sym:SomeService.invoke',
            caller: 'SomeService.invoke',
            callee: 'FooImpl.run',
            calleeId: 'sym:FooImpl.run',
            kind: 'internal',
            order: 1,
            file: 'src/service.ts',
            line: 4,
            column: 9,
            expression: 'this.foo.run(dto)',
            args: ['dto'],
        },
    ];

    return {
        manifest: {
            schemaVersion: 2,
            builtAt: new Date().toISOString(),
            root: '/root',
            counts: { symbols: symbols.length, calls: calls.length, flows: 0, branches: 0, impacts: 0 },
            warnings: {
                ambiguousFqns: ['FooImpl.run', 'AugmentedImpl.run', 'FooBase.run'],
                skippedFiles: [],
            },
        },
        symbols,
        calls,
        flows: [],
        branches: [],
        impacts: [],
    };
}

describe('queries — heritage v1 (RED)', () => {
    describe('B1: resolveSymbol — ranking + delegation note', () => {
        it('ranks a replaced/augmented impl higher than a delegation wrapper for the same fqn', () => {
            // Two symbols share fqn 'FooBase.run'-like; we model this by querying
            // `run` which matches both FooImpl.run (delegation) and AugmentedImpl.run
            // (augmented). The augmented one must rank higher.
            const index = buildHeritageMockIndex();
            const result = resolveSymbol(index, 'run');
            const runMatches = result.matches.filter((s) => s.kind === 'method' && s.name === 'run');
            expect(runMatches.length).toBeGreaterThanOrEqual(3);

            const augmentedIdx = runMatches.findIndex((s) => s.id === 'sym:AugmentedImpl.run');
            const delegationIdx = runMatches.findIndex((s) => s.id === 'sym:FooImpl.run');
            expect(augmentedIdx).toBeGreaterThan(-1);
            expect(delegationIdx).toBeGreaterThan(-1);
            expect(augmentedIdx).toBeLessThan(delegationIdx);
        });

        it('attaches a delegation note pointing to the base method id', () => {
            const index = buildHeritageMockIndex();
            const result = resolveSymbol(index, 'FooImpl.run');
            const wrapper = result.matches.find((s) => s.id === 'sym:FooImpl.run');
            expect(wrapper).toBeDefined();
            const noteField = (wrapper as unknown as { note?: string } | undefined)?.note;
            expect(noteField).toBeDefined();
            expect(noteField).toMatch(/sym:FooBase\.run/);
            expect(noteField).toMatch(/delegat/i);
        });
    });

    describe('B2: getTypeDefinition — inherited members', () => {
        it('returns inheritedMembers from base classes labelled with inheritedFrom', () => {
            const index = buildHeritageMockIndex();
            const def = getTypeDefinition(index, { symbol: 'FooImpl' });
            expect(def.found).toBe(true);

            const definitionWithInherited = def as unknown as {
                inheritedMembers: Array<{ kind: string; name: string; inheritedFrom: string }>;
            };
            expect(definitionWithInherited.inheritedMembers).toBeDefined();

            // FooImpl declares only `run`. doMore is inherited from FooBase
            // and NOT overridden, so it must appear in inheritedMembers.
            const inheritedNames = definitionWithInherited.inheritedMembers.map((m) => m.name);
            expect(inheritedNames).toContain('doMore');

            const doMore = definitionWithInherited.inheritedMembers.find((m) => m.name === 'doMore');
            expect(doMore?.inheritedFrom).toBe('sym:FooBase');
        });

        it('annotates overridden own members with inheritedFrom + overrideKind', () => {
            const index = buildHeritageMockIndex();
            const def = getTypeDefinition(index, { symbol: 'FooImpl' });
            expect(def.found).toBe(true);

            const runMember = def.members.find((m) => m.name === 'run');
            expect(runMember).toBeDefined();
            const annotated = runMember as unknown as { inheritedFrom?: string; overrideKind?: string };
            expect(annotated.inheritedFrom).toBe('sym:FooBase.run');
            expect(annotated.overrideKind).toBe('delegation');
        });
    });

    describe('B3: findReferences — base-class method', () => {
        it('includes super-call sites when querying a base method', () => {
            const index = buildHeritageMockIndex();
            const refs = findReferences(index, { symbol: 'FooBase.run' });
            expect(refs.symbol?.id).toBe('sym:FooBase.run');

            // FooBase.run is targeted by two super-call edges:
            // FooImpl.run → FooBase.run and AugmentedImpl.run → FooBase.run.
            const superCallRefs = refs.references.filter((r) => r.context.includes('super.run'));
            expect(superCallRefs.length).toBeGreaterThanOrEqual(2);

            const fromFooImpl = superCallRefs.find((r) => r.file === 'src/foo.controller.ts');
            const fromAugmented = superCallRefs.find((r) => r.file === 'src/augmented.controller.ts');
            expect(fromFooImpl).toBeDefined();
            expect(fromAugmented).toBeDefined();
        });

        it('includes HTTP/MCP routing sites that reach base via decorator-wrapper subclasses', () => {
            const index = buildHeritageMockIndex();
            const refs = findReferences(index, { symbol: 'FooBase.run' });

            // FooImpl.run is decorated with @Get('/foo') and is a delegation
            // wrapper for FooBase.run — so the route effectively targets the
            // base implementation. The references list must surface it.
            const routeRef = refs.references.find((r) =>
                r.context.includes('@Get') ||
                r.context.includes('/foo') ||
                r.context.includes('FooImpl.run'),
            );
            expect(routeRef).toBeDefined();
        });
    });

    describe('B4: findReferences — delegation subclass method', () => {
        it('flags the result with viaDelegation: true when the queried method is a delegation wrapper', () => {
            const index = buildHeritageMockIndex();
            const refs = findReferences(index, { symbol: 'FooImpl.run' });
            const flagged = refs as unknown as { viaDelegation?: boolean };
            expect(flagged.viaDelegation).toBe(true);
        });

        it('does NOT set viaDelegation when the queried method is augmented (real impl in subclass)', () => {
            const index = buildHeritageMockIndex();
            const refs = findReferences(index, { symbol: 'AugmentedImpl.run' });
            const flagged = refs as unknown as { viaDelegation?: boolean };
            expect(flagged.viaDelegation).toBeFalsy();
        });
    });

    describe('B5: traceScenario follows super-call edges', () => {
        it('walks from a subclass delegation method into the base body via super-call', () => {
            const index = buildHeritageMockIndex();
            const trace = traceScenario(index, { entry: 'FooImpl.run' });

            expect(trace.found).toBe(true);

            // The super-call edge from FooImpl.run → FooBase.run must be
            // present among the traced calls.
            const superHop = trace.calls.find(
                (c) => c.kind === 'super-call' && c.calleeId === 'sym:FooBase.run',
            );
            expect(superHop).toBeDefined();
        });
    });

    describe('B6: explainDataFlow follows dto through super', () => {
        it('returns a flow row showing dto crossing the super-call boundary into base', () => {
            // We add a Flow on FooImpl.run for param `dto` that is "consumed"
            // by the super call. queries.explainDataFlow then matches on
            // target=FooImpl.run + param=dto. The new behaviour: the flow's
            // continuation MUST include an entry for FooBase.run that captures
            // the same dto via the super-call edge.
            const index = buildHeritageMockIndex();
            index.flows.push({
                id: 'flow:FooImpl.run:dto:1',
                targetId: 'sym:FooImpl.run',
                target: 'FooImpl.run',
                param: 'dto',
                sourceKind: 'param',
                source: 'dto',
                via: 'super.run(dto)',
                to: 'FooBase.run',
                toParam: 'dto',
                file: 'src/foo.controller.ts',
                line: 5,
                column: 9,
                path: ['dto', 'super.run(dto)', 'FooBase.run.dto'],
            });

            const flow = explainDataFlow(index, { target: 'FooImpl.run', param: 'dto' });
            expect(flow.found).toBe(true);

            const followed = flow as unknown as {
                follows?: Array<{ from: string; to: string; via: string }>;
            };
            expect(followed.follows).toBeDefined();
            const superHop = followed.follows?.find((f) => f.via.includes('super'));
            expect(superHop).toBeDefined();
            expect(superHop?.to).toMatch(/FooBase\.run/);
        });
    });

    describe('B7: impactContract follows delegation chain and generic-typed base methods', () => {
        it('finds DTO impacts reached through delegation wrappers', () => {
            const index = buildHeritageMockIndex();
            // Add a DTO + impact rows reachable through the delegation chain.
            index.symbols.push({
                id: 'sym:FooCreateDto',
                kind: 'dto',
                name: 'FooCreateDto',
                fqn: 'FooCreateDto',
                file: 'src/dto.ts',
                line: 1,
                column: 1,
            });
            const directImpact: CodeIntelImpact = {
                id: 'imp:FooBase.run:1',
                symbolId: 'sym:FooCreateDto',
                symbol: 'FooCreateDto',
                kind: 'type-reference',
                detail: 'FooBase.run(dto: FooCreateDto)',
                risk: 'medium',
                file: 'src/base.ts',
                line: 4,
                column: 5,
            };
            index.impacts.push(directImpact);

            const result = impactContract(index, { symbol: 'FooCreateDto' });

            expect(result.found).toBe(true);
            // The DTO impacts must include at least the direct base usage,
            // AND a transitive one from the delegation wrapper (FooImpl.run).
            const symbols = result.impacts.map((i) => i.detail);
            const transitive = symbols.some((d) => d.includes('FooImpl.run') || d.includes('AugmentedImpl.run'));
            expect(transitive).toBe(true);
        });
    });

    describe('B8: selfCheck filters delegation-only collisions', () => {
        it('does NOT report a dangerous collision when ALL duplicates are delegation wrappers of the same base', () => {
            // Two FooImpl.run-like classes, BOTH pure delegation pointing at
            // the same base member — this collision is benign and should be
            // filtered out of dangerousCollisions.
            const symbols: CodeIntelSymbol[] = [
                { id: 'sym:FooBase', kind: 'class', name: 'FooBase', fqn: 'FooBase', file: 'libs/base.ts', line: 1, column: 1 },
                { id: 'sym:FooBase.run', kind: 'method', name: 'run', fqn: 'FooBase.run', file: 'libs/base.ts', line: 4, column: 5, parentId: 'sym:FooBase' },
                { id: 'sym:Wrap1', kind: 'class', name: 'WrapController', fqn: 'WrapController', file: 'apps/svc1/x/wrap.controller.ts', line: 1, column: 1, extendsClass: 'sym:FooBase' },
                {
                    id: 'sym:Wrap1.run',
                    kind: 'method',
                    name: 'run',
                    fqn: 'WrapController.run',
                    file: 'apps/svc1/x/wrap.controller.ts',
                    line: 4,
                    column: 5,
                    parentId: 'sym:Wrap1',
                    inheritsFrom: 'sym:FooBase.run',
                    overrideKind: 'delegation',
                },
                { id: 'sym:Wrap2', kind: 'class', name: 'WrapController', fqn: 'WrapController', file: 'apps/svc1/y/wrap.controller.ts', line: 1, column: 1, extendsClass: 'sym:FooBase' },
                {
                    id: 'sym:Wrap2.run',
                    kind: 'method',
                    name: 'run',
                    fqn: 'WrapController.run',
                    file: 'apps/svc1/y/wrap.controller.ts',
                    line: 4,
                    column: 5,
                    parentId: 'sym:Wrap2',
                    inheritsFrom: 'sym:FooBase.run',
                    overrideKind: 'delegation',
                },
            ];
            const index: CodeIntelIndex = {
                manifest: {
                    schemaVersion: 2,
                    builtAt: new Date().toISOString(),
                    root: '/root',
                    counts: { symbols: symbols.length, calls: 0, flows: 0, branches: 0, impacts: 0 },
                    warnings: {
                        // Method-name collision flagged by extractor at FQN level.
                        ambiguousFqns: ['WrapController.run', 'WrapController'],
                        skippedFiles: [],
                    },
                },
                symbols,
                calls: [],
                flows: [],
                branches: [],
                impacts: [],
            };

            const sc = selfCheck(index);
            const methodCollision = sc.warnings?.dangerousCollisions?.includes('WrapController.run') ?? false;
            expect(methodCollision).toBe(false);
            // But the CLASS-level collision (WrapController vs WrapController)
            // remains dangerous — two separate classes with the same name in
            // different microservices is a real disambiguation problem.
            const classCollision = sc.warnings?.dangerousCollisions?.includes('WrapController') ?? false;
            expect(classCollision).toBe(true);
        });

        it('STILL reports a dangerous collision when at least one duplicate is augmented/replaced', () => {
            const symbols: CodeIntelSymbol[] = [
                { id: 'sym:FooBase', kind: 'class', name: 'FooBase', fqn: 'FooBase', file: 'libs/base.ts', line: 1, column: 1 },
                { id: 'sym:FooBase.run', kind: 'method', name: 'run', fqn: 'FooBase.run', file: 'libs/base.ts', line: 4, column: 5, parentId: 'sym:FooBase' },
                { id: 'sym:Wrap1', kind: 'class', name: 'AController', fqn: 'AController', file: 'apps/svc1/x/a.controller.ts', line: 1, column: 1, extendsClass: 'sym:FooBase' },
                {
                    id: 'sym:Wrap1.run',
                    kind: 'method',
                    name: 'run',
                    fqn: 'AController.run',
                    file: 'apps/svc1/x/a.controller.ts',
                    line: 4,
                    column: 5,
                    parentId: 'sym:Wrap1',
                    inheritsFrom: 'sym:FooBase.run',
                    overrideKind: 'delegation',
                },
                { id: 'sym:Wrap2', kind: 'class', name: 'AController', fqn: 'AController', file: 'apps/svc1/y/a.controller.ts', line: 1, column: 1, extendsClass: 'sym:FooBase' },
                {
                    id: 'sym:Wrap2.run',
                    kind: 'method',
                    name: 'run',
                    fqn: 'AController.run',
                    file: 'apps/svc1/y/a.controller.ts',
                    line: 4,
                    column: 5,
                    parentId: 'sym:Wrap2',
                    inheritsFrom: 'sym:FooBase.run',
                    overrideKind: 'augmented', // ← THIS makes the collision still dangerous
                },
            ];
            const index: CodeIntelIndex = {
                manifest: {
                    schemaVersion: 2,
                    builtAt: new Date().toISOString(),
                    root: '/root',
                    counts: { symbols: symbols.length, calls: 0, flows: 0, branches: 0, impacts: 0 },
                    warnings: {
                        ambiguousFqns: ['AController.run', 'AController'],
                        skippedFiles: [],
                    },
                },
                symbols,
                calls: [],
                flows: [],
                branches: [],
                impacts: [],
            };

            const sc = selfCheck(index);
            const methodCollision = sc.warnings?.dangerousCollisions?.includes('AController.run') ?? false;
            expect(methodCollision).toBe(true);
        });
    });
});

