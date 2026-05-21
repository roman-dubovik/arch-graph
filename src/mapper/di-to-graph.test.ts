import { describe, expect, it } from 'vitest';

import type {
    DiControllerRef,
    DiDiagnostics,
    DiFilterChainRef,
    DiModuleRef,
    DiModuleSite,
    DiProviderRef,
    SourceLoc,
} from '../core/types.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import { DiModuleIndex } from '../extractors/di/module-index.js';
import { mapDiToGraph } from './di-to-graph.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLoc(file = '/apps/api/src/app.module.ts', line = 1): SourceLoc {
    return { file, line, column: 1 };
}

function makeModule(
    className: string,
    overrides: Partial<DiModuleSite> = {},
): DiModuleSite {
    return {
        className,
        location: makeLoc(),
        imports: [],
        providers: [],
        exports: [],
        controllers: [],
        fieldLocations: { imports: null, providers: null, exports: null, controllers: null },
        flags: {
            hasDynamicImports: false,
            hasDynamicProviders: false,
            hasDynamicExports: false,
            hasDynamicControllers: false,
        },
        ...overrides,
    };
}

/**
 * Build a module that registers a controller and a list of provider classes.
 * Used by filter-chain tests to ensure the required provider nodes exist in
 * providerNodes before filter refs are processed.
 */
function moduleWithProvidersAndControllers(
    controllerName: string,
    providerNames: string[],
): DiModuleSite {
    return makeModule('TestModule', {
        controllers: [{ kind: 'class', name: controllerName }],
        providers: providerNames.map((p) => ({ kind: 'class' as const, name: p })),
    });
}

type FilterRefInput = {
    kind: 'class' | 'instance' | 'unresolved';
    name?: string;
    decorator: DiFilterChainRef['decorator'];
    enclosingClass: string;
    attachedTo?: DiFilterChainRef['attachedTo'];
    location?: SourceLoc;
};

function makeFilterRef(overrides: FilterRefInput): DiFilterChainRef {
    const base = {
        location: makeLoc('/apps/api/src/cats.controller.ts', 5),
        attachedTo: { kind: 'class' as const },
    };
    if (overrides.kind === 'unresolved') {
        return {
            kind: 'unresolved',
            raw: '...guards',
            reason: 'unresolved-arg-kind-SpreadElement',
            decorator: overrides.decorator,
            enclosingClass: overrides.enclosingClass,
            attachedTo: overrides.attachedTo ?? base.attachedTo,
            location: overrides.location ?? base.location,
        };
    }
    if (overrides.kind === 'instance') {
        return {
            kind: 'instance',
            name: overrides.name ?? 'UnknownClass',
            decorator: overrides.decorator,
            enclosingClass: overrides.enclosingClass,
            attachedTo: overrides.attachedTo ?? base.attachedTo,
            location: overrides.location ?? base.location,
        };
    }
    return {
        kind: 'class',
        name: overrides.name ?? 'UnknownClass',
        decorator: overrides.decorator,
        enclosingClass: overrides.enclosingClass,
        attachedTo: overrides.attachedTo ?? base.attachedTo,
        location: overrides.location ?? base.location,
    };
}

const EMPTY_OWNERSHIP = new OwnershipRegistry('/root', [], []);

function emptyModuleIndex(): DiModuleIndex {
    // Build an in-memory DiModuleIndex by going through the project factory path.
    // DiModuleIndex is a thin Map wrapper — we can construct one via the factory
    // that accepts source files. For tests we just need an empty index.
    return {
        get: (_name: string) => undefined,
        size: () => 0,
    } as unknown as DiModuleIndex;
}

// Reuse across tests for convenience
const IDX = emptyModuleIndex();

// ---------------------------------------------------------------------------
// Basic module-to-graph mapping (existing logic)
// ---------------------------------------------------------------------------

describe('mapDiToGraph — module nodes', () => {
    it('creates a module node for each @Module class', () => {
        const modules = [makeModule('AppModule'), makeModule('UserModule')];
        const { nodes } = mapDiToGraph(modules, IDX, EMPTY_OWNERSHIP);
        const ids = nodes.map((n) => n.id);
        expect(ids).toContain('module:AppModule');
        expect(ids).toContain('module:UserModule');
    });

    it('sets meta.local = false for modules not in the index', () => {
        const modules = [makeModule('AppModule')];
        const { nodes } = mapDiToGraph(modules, IDX, EMPTY_OWNERSHIP);
        const mod = nodes.find((n) => n.id === 'module:AppModule')!;
        expect(mod.meta?.local).toBe(false);
    });

    it('accumulates declaredAt on the module node', () => {
        const mod = makeModule('AppModule');
        const { nodes } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        const node = nodes.find((n) => n.id === 'module:AppModule')!;
        expect(Array.isArray(node.meta?.declaredAt)).toBe(true);
        expect((node.meta?.declaredAt as string[]).length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// di-import edges
// ---------------------------------------------------------------------------

describe('mapDiToGraph — di-import edges', () => {
    it('emits a di-import edge for each resolved import ref', () => {
        const mod = makeModule('AppModule', {
            imports: [{ kind: 'class', name: 'UserModule' }],
        });
        const { edges } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        const e = edges.find((e) => e.kind === 'di-import');
        expect(e).toBeDefined();
        expect(e?.from).toBe('module:AppModule');
        expect(e?.to).toBe('module:UserModule');
    });

    it('emits a di-import edge for a dynamic module ref', () => {
        const mod = makeModule('AppModule', {
            imports: [{ kind: 'dynamic', name: 'TypeOrmModule', via: 'TypeOrmModule.forRoot()' }],
        });
        const { edges } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        const e = edges.find((e) => e.kind === 'di-import');
        expect(e?.to).toBe('module:TypeOrmModule');
        expect(e?.meta?.refKind).toBe('dynamic');
    });

    it('diverts unresolved import ref to diagnostics', () => {
        const ref: DiModuleRef = { kind: 'unresolved', raw: '...sharedImports', reason: 'spread' };
        const mod = makeModule('AppModule', { imports: [ref] });
        const { edges, diagnostics } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        expect(edges.filter((e) => e.kind === 'di-import')).toHaveLength(0);
        expect(diagnostics.unresolvedRefs).toHaveLength(1);
        expect(diagnostics.unresolvedRefs[0].field).toBe('imports');
    });

    it('deduplicates edges — same import from two modules produces one node', () => {
        const mod1 = makeModule('AppModule', {
            imports: [{ kind: 'class', name: 'CommonModule' }],
        });
        const mod2 = makeModule('CoreModule', {
            imports: [{ kind: 'class', name: 'CommonModule' }],
        });
        const { nodes } = mapDiToGraph([mod1, mod2], IDX, EMPTY_OWNERSHIP);
        const commonNodes = nodes.filter((n) => n.id === 'module:CommonModule');
        expect(commonNodes).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// di-provides edges
// ---------------------------------------------------------------------------

describe('mapDiToGraph — di-provides edges', () => {
    it('emits a di-provides edge for a class provider ref', () => {
        const mod = makeModule('AppModule', {
            providers: [{ kind: 'class', name: 'AuthService' }],
        });
        const { edges } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        const e = edges.find((e) => e.kind === 'di-provides');
        expect(e?.from).toBe('module:AppModule');
        expect(e?.to).toBe('provider:AuthService');
    });

    it('emits a di-provides edge for a token provider', () => {
        const ref: DiProviderRef = {
            kind: 'token',
            name: 'AuthServiceImpl',
            providerKind: 'class',
            provideToken: 'AUTH_SERVICE',
        };
        const mod = makeModule('AppModule', { providers: [ref] });
        const { edges } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        const e = edges.find((e) => e.kind === 'di-provides');
        expect(e?.to).toBe('provider:AuthServiceImpl');
        expect(e?.meta?.refKind).toBe('token');
        expect(e?.meta?.provideToken).toBe('AUTH_SERVICE');
    });

    it('emits a di-provides edge for a useFactory token (without provideToken)', () => {
        const ref: DiProviderRef = {
            kind: 'token',
            name: 'CONFIG_SERVICE',
            providerKind: 'factory',
        };
        const mod = makeModule('AppModule', { providers: [ref] });
        const { edges } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        const e = edges.find((e) => e.kind === 'di-provides');
        expect(e).toBeDefined();
        expect(e?.meta?.providerKind).toBe('factory');
    });

    it('emits a di-provides edge for a useExisting token', () => {
        const ref: DiProviderRef = {
            kind: 'token',
            name: 'AuthFacade',
            providerKind: 'existing',
        };
        const mod = makeModule('AppModule', { providers: [ref] });
        const { edges } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        const e = edges.find((e) => e.kind === 'di-provides');
        expect(e?.meta?.providerKind).toBe('existing');
    });

    it('emits a di-provides edge for a useValue token', () => {
        const ref: DiProviderRef = {
            kind: 'token',
            name: 'MY_CONFIG',
            providerKind: 'value',
        };
        const mod = makeModule('AppModule', { providers: [ref] });
        const { edges } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        const e = edges.find((e) => e.kind === 'di-provides');
        expect(e?.meta?.providerKind).toBe('value');
    });

    it('diverts unresolved provider ref to diagnostics', () => {
        const ref: DiProviderRef = { kind: 'unresolved', raw: '...providers', reason: 'spread' };
        const mod = makeModule('AppModule', { providers: [ref] });
        const { diagnostics } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        expect(diagnostics.unresolvedRefs[0].field).toBe('providers');
    });

    it('handles token-ref provider', () => {
        const ref: DiProviderRef = { kind: 'token-ref', name: 'MY_TOKEN' };
        const mod = makeModule('AppModule', { providers: [ref] });
        const { edges } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        const e = edges.find((e) => e.kind === 'di-provides');
        expect(e?.to).toBe('provider:MY_TOKEN');
        expect(e?.meta?.refKind).toBe('token-ref');
    });
});

describe('mapDiToGraph — di-uses edges', () => {
    it('emits provider-to-provider constructor dependency edges for registered providers only', () => {
        const mod = makeModule('AppModule', {
            providers: [
                { kind: 'class', name: 'OrdersService' },
                { kind: 'class', name: 'UsersService' },
            ],
        });

        const result = mapDiToGraph(
            [mod],
            IDX,
            EMPTY_OWNERSHIP,
            [],
            [],
            undefined,
            [{
                providerClass: 'OrdersService',
                dependencyClass: 'UsersService',
                location: makeLoc('/apps/api/src/orders.service.ts', 7),
                via: 'constructor',
            }],
        );

        const edge = result.edges.find((e) => e.kind === 'di-uses');
        expect(edge?.from).toBe('provider:OrdersService');
        expect(edge?.to).toBe('provider:UsersService');
        expect(edge?.meta?.via).toBe('constructor');
        expect(result.diagnostics.counts.providerUses).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// di-exports edges
// ---------------------------------------------------------------------------

describe('mapDiToGraph — di-exports edges', () => {
    it('emits a di-exports edge for a class export ref', () => {
        const mod = makeModule('AppModule', {
            exports: [{ kind: 'class', name: 'AuthService' }],
        });
        const { edges } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        const e = edges.find((e) => e.kind === 'di-exports');
        expect(e?.from).toBe('module:AppModule');
        expect(e?.to).toBe('provider:AuthService');
    });

    it('diverts unresolved export ref to diagnostics', () => {
        const ref: DiProviderRef = { kind: 'unresolved', raw: 'SomeModule', reason: 'conditional' };
        const mod = makeModule('AppModule', { exports: [ref] });
        const { diagnostics } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        expect(diagnostics.unresolvedRefs[0].field).toBe('exports');
    });
});

// ---------------------------------------------------------------------------
// di-controller edges
// ---------------------------------------------------------------------------

describe('mapDiToGraph — di-controller edges', () => {
    it('emits a di-controller edge for a class controller ref', () => {
        const mod = makeModule('AppModule', {
            controllers: [{ kind: 'class', name: 'CatsController' }],
        });
        const { edges, nodes } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        const e = edges.find((e) => e.kind === 'di-controller');
        expect(e?.from).toBe('module:AppModule');
        expect(e?.to).toBe('provider:CatsController');
        // isController flag should be set on node
        const node = nodes.find((n) => n.id === 'provider:CatsController')!;
        expect(node.meta?.isController).toBe(true);
    });

    it('diverts unresolved controller ref to diagnostics', () => {
        const ref: DiControllerRef = { kind: 'unresolved', raw: '...controllers', reason: 'spread' };
        const mod = makeModule('AppModule', { controllers: [ref] });
        const { diagnostics } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        expect(diagnostics.unresolvedRefs[0].field).toBe('controllers');
    });
});

// ---------------------------------------------------------------------------
// Token-ref enrichment (defensive enrichment branch)
// ---------------------------------------------------------------------------

describe('mapDiToGraph — token-ref enrichment', () => {
    it('enriches a token-ref provider node when the concrete provider appears later', () => {
        // token-ref appears in exports before the concrete provider in providers
        const tokenRef: DiProviderRef = { kind: 'token-ref', name: 'MY_TOKEN' };
        const concreteProvider: DiProviderRef = {
            kind: 'token',
            name: 'MY_TOKEN',
            providerKind: 'class',
        };
        // To test enrichment: process exports first (token-ref creates node),
        // then providers (token concrete enriches meta). We achieve ordering by putting
        // exports before providers in the module (but fillSiteFromMetadata processes
        // providers before exports). Let's just test the resulting node has providerKind.
        const mod = makeModule('AppModule', {
            providers: [concreteProvider],
            exports: [tokenRef],
        });
        const { nodes } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        const node = nodes.find((n) => n.id === 'provider:MY_TOKEN')!;
        expect(node.meta?.providerKind).toBe('class');
    });

    it('does NOT overwrite providerKind when the concrete token ref appears a second time', () => {
        // Two modules both declare { provide: MY_TOKEN, useClass: FooImpl }.
        // Second encounter hits the `else if (ref.kind === 'token')` branch with
        // providerKind already set — first-concrete-ref wins, nothing is overwritten.
        const provider1: DiProviderRef = {
            kind: 'token',
            name: 'MY_TOKEN',
            providerKind: 'class',
        };
        const provider2: DiProviderRef = {
            kind: 'token',
            name: 'MY_TOKEN',
            providerKind: 'factory', // different kind — should be ignored
        };
        const mod1 = makeModule('AppModule', { providers: [provider1] });
        const mod2 = makeModule('OtherModule', { providers: [provider2] });
        const { nodes } = mapDiToGraph([mod1, mod2], IDX, EMPTY_OWNERSHIP);
        const node = nodes.find((n) => n.id === 'provider:MY_TOKEN')!;
        // First-seen wins: mod1's 'class' should be preserved
        expect(node.meta?.providerKind).toBe('class');
    });

    it('enriches a token-ref node when token-ref appears before the concrete token in the same providers array', () => {
        // token-ref first in providers creates node with providerKind=undefined.
        // concrete token second enriches the node.
        const tokenRef: DiProviderRef = { kind: 'token-ref', name: 'SHARED_TOKEN' };
        const concrete: DiProviderRef = {
            kind: 'token',
            name: 'SHARED_TOKEN',
            providerKind: 'factory',
            provideToken: 'SHARED_TOKEN',
        };
        const mod = makeModule('AppModule', { providers: [tokenRef, concrete] });
        const { nodes } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        const node = nodes.find((n) => n.id === 'provider:SHARED_TOKEN')!;
        expect(node.meta?.providerKind).toBe('factory');
        expect(node.meta?.provideToken).toBe('SHARED_TOKEN');
    });
});

// ---------------------------------------------------------------------------
// Unowned modules
// ---------------------------------------------------------------------------

describe('mapDiToGraph — unowned modules', () => {
    it('adds unowned module to diagnostics.unowned', () => {
        // EMPTY_OWNERSHIP has no apps or libs, so all files are "unknown" (unowned)
        const mod = makeModule('AppModule');
        const { diagnostics } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        expect(diagnostics.unowned).toHaveLength(1);
    });

    it('records module as owned when file matches a service', () => {
        const ownership = new OwnershipRegistry('/root', [
            {
                id: 'api',
                rootDir: '/apps/api',
                tsconfigPath: null,
                entryFile: null,
            },
        ], []);
        const mod = makeModule('AppModule', {
            location: makeLoc('/apps/api/src/app.module.ts'),
        });
        const { diagnostics } = mapDiToGraph([mod], IDX, ownership);
        expect(diagnostics.unowned).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Counts in diagnostics
// ---------------------------------------------------------------------------

describe('mapDiToGraph — counts in diagnostics', () => {
    it('counts modules, imports, providers, exports, controllers correctly', () => {
        const mod = makeModule('AppModule', {
            imports: [{ kind: 'class', name: 'UserModule' }],
            providers: [{ kind: 'class', name: 'AuthService' }],
            exports: [{ kind: 'class', name: 'AuthService' }],
            controllers: [{ kind: 'class', name: 'CatsController' }],
        });
        const { diagnostics } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        const c = diagnostics.counts;
        expect(c.modules).toBe(1);
        expect(c.imports).toBe(1);
        expect(c.providers).toBe(1);
        expect(c.exports).toBe(1);
        expect(c.controllers).toBe(1);
    });

    it('counts unresolved refs', () => {
        const mod = makeModule('AppModule', {
            imports: [{ kind: 'unresolved', raw: '...x', reason: 'spread' }],
        });
        const { diagnostics } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        expect(diagnostics.counts.unresolvedRefs).toBe(1);
    });

    it('counts unowned', () => {
        const mod = makeModule('AppModule');
        const { diagnostics } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP);
        expect(diagnostics.counts.unowned).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Filter-chain: di-guard edges
//
// Policy: only emit edges when both enclosingClass and guard target are already
// registered in providerNodes from a real @Module declaration. Unregistered
// classes are routed to unresolvedFilterRefs with a structured reason.
// ---------------------------------------------------------------------------

describe('mapDiToGraph — di-guard edges', () => {
    it('emits a di-guard edge when both controller and guard are in providerNodes', () => {
        const mod = moduleWithProvidersAndControllers('CatsController', ['AuthGuard']);
        const ref = makeFilterRef({
            kind: 'class',
            name: 'AuthGuard',
            decorator: 'UseGuards',
            enclosingClass: 'CatsController',
        });
        const { edges } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP, [ref]);
        const e = edges.find((e) => e.kind === 'di-guard');
        expect(e).toBeDefined();
        expect(e?.from).toBe('provider:CatsController');
        expect(e?.to).toBe('provider:AuthGuard');
    });

    it('routes to unresolvedFilterRefs when guard target is NOT in providerNodes', () => {
        // Only controller registered, not the guard
        const mod = moduleWithProvidersAndControllers('CatsController', []);
        const ref = makeFilterRef({
            kind: 'class',
            name: 'AuthGuard',
            decorator: 'UseGuards',
            enclosingClass: 'CatsController',
        });
        const { edges, diagnostics } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP, [ref]);
        expect(edges.filter((e) => e.kind === 'di-guard')).toHaveLength(0);
        expect(diagnostics.unresolvedFilterRefs.length).toBeGreaterThan(0);
        const unresolved = diagnostics.unresolvedFilterRefs[0];
        expect(unresolved.kind).toBe('unresolved');
        expect((unresolved as { reason: string }).reason).toBe('target-not-in-di-graph');
    });

    it('routes to unresolvedFilterRefs when enclosingClass is NOT in providerNodes', () => {
        // Guard registered but controller is not
        const mod = makeModule('TestModule', {
            providers: [{ kind: 'class', name: 'AuthGuard' }],
        });
        const ref = makeFilterRef({
            kind: 'class',
            name: 'AuthGuard',
            decorator: 'UseGuards',
            enclosingClass: 'UnregisteredController',
        });
        const { edges, diagnostics } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP, [ref]);
        expect(edges.filter((e) => e.kind === 'di-guard')).toHaveLength(0);
        expect(diagnostics.unresolvedFilterRefs.length).toBeGreaterThan(0);
        const unresolved = diagnostics.unresolvedFilterRefs[0];
        expect((unresolved as { reason: string }).reason).toBe('source-not-in-di-graph');
    });

    it('sets meta.decorator and meta.attachedTo on the guard edge', () => {
        const mod = moduleWithProvidersAndControllers('CatsController', ['AuthGuard']);
        const ref = makeFilterRef({
            kind: 'class',
            name: 'AuthGuard',
            decorator: 'UseGuards',
            enclosingClass: 'CatsController',
            attachedTo: { kind: 'class' },
        });
        const { edges } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP, [ref]);
        const e = edges.find((e) => e.kind === 'di-guard')!;
        expect(e.meta?.decorator).toBe('UseGuards');
        expect(e.meta?.attachedTo).toBe('class');
    });

    it('sets meta.attachedTo to method:<name> for method-level guard', () => {
        const mod = moduleWithProvidersAndControllers('CatsController', ['RoleGuard']);
        const ref = makeFilterRef({
            kind: 'class',
            name: 'RoleGuard',
            decorator: 'UseGuards',
            enclosingClass: 'CatsController',
            attachedTo: { kind: 'method', methodName: 'findAll' },
        });
        const { edges } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP, [ref]);
        const e = edges.find((e) => e.kind === 'di-guard')!;
        expect(e.meta?.attachedTo).toBe('method:findAll');
    });

    it('increments guards count per emitted edge', () => {
        const mod = moduleWithProvidersAndControllers('CatsController', ['GuardA', 'GuardB']);
        const refs = [
            makeFilterRef({ kind: 'class', name: 'GuardA', decorator: 'UseGuards', enclosingClass: 'CatsController' }),
            makeFilterRef({ kind: 'class', name: 'GuardB', decorator: 'UseGuards', enclosingClass: 'CatsController' }),
        ];
        const { diagnostics } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP, refs);
        expect(diagnostics.counts.guards).toBe(2);
    });

    it('deduplicates guard edges when attachedTo is the same', () => {
        const mod = moduleWithProvidersAndControllers('CatsController', ['AuthGuard']);
        const ref1 = makeFilterRef({
            kind: 'class',
            name: 'AuthGuard',
            decorator: 'UseGuards',
            enclosingClass: 'CatsController',
        });
        const ref2 = makeFilterRef({
            kind: 'class',
            name: 'AuthGuard',
            decorator: 'UseGuards',
            enclosingClass: 'CatsController',
        });
        const { edges, diagnostics } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP, [ref1, ref2]);
        const guardEdges = edges.filter((e) => e.kind === 'di-guard');
        expect(guardEdges).toHaveLength(1);
        // Count increments only once (first insertion wins); second is dedupDropped
        expect(diagnostics.counts.guards).toBe(1);
        expect(diagnostics.counts.dedupDropped).toBe(1);
    });

    it('produces TWO distinct di-guard edges for @UseGuards(AuthGuard) on two different methods', () => {
        // This is the core fix for the dedup-key issue:
        // Same guard on different methods must NOT collapse into one edge.
        const mod = moduleWithProvidersAndControllers('CatsController', ['AuthGuard']);
        const refFindAll = makeFilterRef({
            kind: 'class',
            name: 'AuthGuard',
            decorator: 'UseGuards',
            enclosingClass: 'CatsController',
            attachedTo: { kind: 'method', methodName: 'findAll' },
        });
        const refFindOne = makeFilterRef({
            kind: 'class',
            name: 'AuthGuard',
            decorator: 'UseGuards',
            enclosingClass: 'CatsController',
            attachedTo: { kind: 'method', methodName: 'findOne' },
        });
        const { edges, diagnostics } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP, [refFindAll, refFindOne]);
        const guardEdges = edges.filter((e) => e.kind === 'di-guard');
        expect(guardEdges).toHaveLength(2);
        expect(diagnostics.counts.guards).toBe(2);
        expect(diagnostics.counts.dedupDropped).toBe(0);
        const methods = guardEdges.map((e) => e.meta?.attachedTo as string);
        expect(methods).toContain('method:findAll');
        expect(methods).toContain('method:findOne');
    });
});

// ---------------------------------------------------------------------------
// Filter-chain: di-interceptor edges
// ---------------------------------------------------------------------------

describe('mapDiToGraph — di-interceptor edges', () => {
    it('emits a di-interceptor edge when both controller and interceptor are in providerNodes', () => {
        const mod = moduleWithProvidersAndControllers('CatsController', ['LoggingInterceptor']);
        const ref = makeFilterRef({
            kind: 'class',
            name: 'LoggingInterceptor',
            decorator: 'UseInterceptors',
            enclosingClass: 'CatsController',
        });
        const { edges, diagnostics } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP, [ref]);
        const e = edges.find((e) => e.kind === 'di-interceptor');
        expect(e).toBeDefined();
        expect(e?.from).toBe('provider:CatsController');
        expect(e?.to).toBe('provider:LoggingInterceptor');
        expect(diagnostics.counts.interceptors).toBe(1);
    });

    it('emits instantiated=true for an instance UseInterceptors ref', () => {
        const mod = moduleWithProvidersAndControllers('CatsController', ['LoggingInterceptor']);
        const ref = makeFilterRef({
            kind: 'instance',
            name: 'LoggingInterceptor',
            decorator: 'UseInterceptors',
            enclosingClass: 'CatsController',
        });
        const { edges } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP, [ref]);
        const e = edges.find((e) => e.kind === 'di-interceptor')!;
        expect(e.meta?.instantiated).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Filter-chain: di-pipe edges
// ---------------------------------------------------------------------------

describe('mapDiToGraph — di-pipe edges', () => {
    it('emits a di-pipe edge when both controller and pipe are in providerNodes', () => {
        const mod = moduleWithProvidersAndControllers('CatsController', ['ValidationPipe']);
        const ref = makeFilterRef({
            kind: 'class',
            name: 'ValidationPipe',
            decorator: 'UsePipes',
            enclosingClass: 'CatsController',
        });
        const { edges, diagnostics } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP, [ref]);
        const e = edges.find((e) => e.kind === 'di-pipe');
        expect(e).toBeDefined();
        expect(diagnostics.counts.pipes).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Filter-chain: unresolved refs → diagnostics not edges
// ---------------------------------------------------------------------------

describe('mapDiToGraph — unresolved filter refs', () => {
    it('diverts unresolved filter ref to diagnostics.unresolvedFilterRefs', () => {
        const ref = makeFilterRef({
            kind: 'unresolved',
            name: '',
            decorator: 'UseGuards',
            enclosingClass: 'CatsController',
        });
        const { edges, diagnostics } = mapDiToGraph([], IDX, EMPTY_OWNERSHIP, [ref]);
        expect(edges.filter((e) => e.kind === 'di-guard')).toHaveLength(0);
        expect(diagnostics.unresolvedFilterRefs).toHaveLength(1);
        expect(diagnostics.counts.unresolvedFilterRefs).toBe(1);
        expect(diagnostics.counts.guards).toBe(0);
    });

    it('mixes resolved and unresolved filter refs correctly', () => {
        const mod = moduleWithProvidersAndControllers('CatsController', ['AuthGuard']);
        const resolved = makeFilterRef({
            kind: 'class',
            name: 'AuthGuard',
            decorator: 'UseGuards',
            enclosingClass: 'CatsController',
        });
        const unresolved = makeFilterRef({
            kind: 'unresolved',
            name: '',
            decorator: 'UseGuards',
            enclosingClass: 'CatsController',
        });
        const { edges, diagnostics } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP, [resolved, unresolved]);
        expect(edges.filter((e) => e.kind === 'di-guard')).toHaveLength(1);
        expect(diagnostics.unresolvedFilterRefs).toHaveLength(1);
        expect(diagnostics.counts.guards).toBe(1);
        expect(diagnostics.counts.unresolvedFilterRefs).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Filter-chain: file + line on edges
// ---------------------------------------------------------------------------

describe('mapDiToGraph — filter-chain edge location', () => {
    it('sets file and line on the guard edge from ref.location', () => {
        const mod = moduleWithProvidersAndControllers('CatsController', ['AuthGuard']);
        const ref = makeFilterRef({
            kind: 'class',
            name: 'AuthGuard',
            decorator: 'UseGuards',
            enclosingClass: 'CatsController',
            location: { file: '/apps/api/src/cats.controller.ts', line: 42, column: 3 },
        });
        const { edges } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP, [ref]);
        const e = edges.find((e) => e.kind === 'di-guard')!;
        expect(e.file).toBe('/apps/api/src/cats.controller.ts');
        expect(e.line).toBe(42);
    });
});

// ---------------------------------------------------------------------------
// Filter-chain: provider node creation (no phantom nodes policy)
// ---------------------------------------------------------------------------

describe('mapDiToGraph — provider nodes from filter chain', () => {
    it('does NOT create phantom provider nodes when guard/controller are unregistered', () => {
        // With no modules, neither CatsController nor AuthGuard are in providerNodes.
        // The old behavior was to fabricate them — now both go to unresolvedFilterRefs.
        const ref = makeFilterRef({
            kind: 'class',
            name: 'AuthGuard',
            decorator: 'UseGuards',
            enclosingClass: 'CatsController',
        });
        const { nodes, diagnostics } = mapDiToGraph([], IDX, EMPTY_OWNERSHIP, [ref]);
        const ids = nodes.map((n) => n.id);
        expect(ids).not.toContain('provider:CatsController');
        expect(ids).not.toContain('provider:AuthGuard');
        expect(diagnostics.unresolvedFilterRefs.length).toBeGreaterThan(0);
        expect((diagnostics.unresolvedFilterRefs[0] as { reason: string }).reason).toBe('source-not-in-di-graph');
    });

    it('does not duplicate a provider node when it already exists from @Module controllers', () => {
        const mod = makeModule('AppModule', {
            controllers: [{ kind: 'class', name: 'CatsController' }],
            providers: [{ kind: 'class', name: 'AuthGuard' }],
        });
        const ref = makeFilterRef({
            kind: 'class',
            name: 'AuthGuard',
            decorator: 'UseGuards',
            enclosingClass: 'CatsController',
        });
        const { nodes } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP, [ref]);
        const catNodes = nodes.filter((n) => n.id === 'provider:CatsController');
        expect(catNodes).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Filter-chain: diagnostics fields (new in this PR)
// ---------------------------------------------------------------------------

describe('mapDiToGraph — new diagnostics fields', () => {
    it('initialises unresolvedFilterRefsTruncated as false', () => {
        const { diagnostics } = mapDiToGraph([], IDX, EMPTY_OWNERSHIP, []);
        expect(diagnostics.unresolvedFilterRefsTruncated).toBe(false);
    });

    it('initialises skippedAnonymousFiles as empty array', () => {
        const { diagnostics } = mapDiToGraph([], IDX, EMPTY_OWNERSHIP, []);
        expect(Array.isArray(diagnostics.skippedAnonymousFiles)).toBe(true);
        expect(diagnostics.skippedAnonymousFiles).toHaveLength(0);
    });

    it('initialises dedupDropped as 0 with no refs', () => {
        const { diagnostics } = mapDiToGraph([], IDX, EMPTY_OWNERSHIP, []);
        expect(diagnostics.counts.dedupDropped).toBe(0);
    });

    it('truncates unresolvedFilterRefs at 200 and sets truncated flag', () => {
        // Build 201 unresolved refs (the kind that always goes to unresolved)
        const refs: DiFilterChainRef[] = Array.from({ length: 201 }, (_, i) =>
            makeFilterRef({
                kind: 'unresolved',
                decorator: 'UseGuards',
                enclosingClass: `Controller${i}`,
            }),
        );
        const { diagnostics } = mapDiToGraph([], IDX, EMPTY_OWNERSHIP, refs);
        expect(diagnostics.unresolvedFilterRefs).toHaveLength(200);
        expect(diagnostics.unresolvedFilterRefsTruncated).toBe(true);
        // Count still reflects the capped length
        expect(diagnostics.counts.unresolvedFilterRefs).toBe(200);
    });

    it('truncatedFilterRefs counter tracks overflow correctly at 205 refs', () => {
        // Build 205 unresolved refs — 200 retained, 5 truncated.
        const refs: DiFilterChainRef[] = Array.from({ length: 205 }, (_, i) =>
            makeFilterRef({
                kind: 'unresolved',
                decorator: 'UseGuards',
                enclosingClass: `Controller${i}`,
            }),
        );
        const { diagnostics } = mapDiToGraph([], IDX, EMPTY_OWNERSHIP, refs);
        // Retained cap
        expect(diagnostics.unresolvedFilterRefs).toHaveLength(200);
        expect(diagnostics.counts.unresolvedFilterRefs).toBe(200);
        // Overflow counter
        expect(diagnostics.counts.truncatedFilterRefs).toBe(5);
        // Truncated flag
        expect(diagnostics.unresolvedFilterRefsTruncated).toBe(true);
        // Numeric invariant: guards(0) + interceptors(0) + pipes(0) + retained(200) + dedup(0) + truncated(5) === 205
        const c = diagnostics.counts;
        const total = c.guards + c.interceptors + c.pipes + c.unresolvedFilterRefs + c.dedupDropped + c.truncatedFilterRefs;
        expect(total).toBe(205);
    });
});

// ---------------------------------------------------------------------------
// Empty inputs
// ---------------------------------------------------------------------------

describe('mapDiToGraph — empty inputs', () => {
    it('returns empty nodes/edges/diagnostics for no modules and no filter chain', () => {
        const { nodes, edges, diagnostics } = mapDiToGraph([], IDX, EMPTY_OWNERSHIP, []);
        expect(nodes).toHaveLength(0);
        expect(edges).toHaveLength(0);
        expect(diagnostics.counts.modules).toBe(0);
        expect(diagnostics.counts.guards).toBe(0);
        expect(diagnostics.unresolvedFilterRefs).toHaveLength(0);
    });

    it('defaults filterChain param to empty array when omitted', () => {
        const { diagnostics } = mapDiToGraph([], IDX, EMPTY_OWNERSHIP);
        expect(diagnostics.unresolvedFilterRefs).toHaveLength(0);
        expect(diagnostics.counts.guards).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// skippedAnonymousFiles passthrough
// ---------------------------------------------------------------------------

describe('mapDiToGraph — skippedAnonymousFiles passthrough', () => {
    it('passes through skippedAnonymousFiles from 5th param to diagnostics', () => {
        const files = ['/apps/api/src/anon.controller.ts', '/apps/api/src/anon2.controller.ts'];
        const { diagnostics } = mapDiToGraph([], IDX, EMPTY_OWNERSHIP, [], files);
        expect(diagnostics.skippedAnonymousFiles).toEqual(files);
        expect(diagnostics.skippedAnonymousFiles).toHaveLength(2);
    });

    it('defaults skippedAnonymousFiles to empty array when omitted', () => {
        const { diagnostics } = mapDiToGraph([], IDX, EMPTY_OWNERSHIP, []);
        expect(diagnostics.skippedAnonymousFiles).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Count invariant: guards + interceptors + pipes + unresolvedFilterRefs.length
//                  + dedupDropped === filterChain.length
// ---------------------------------------------------------------------------

describe('mapDiToGraph — count invariant', () => {
    it('guards + interceptors + pipes + unresolvedFilterRefs + dedupDropped === filterChain.length', () => {
        // Set up a module with one controller (CatsController) and three providers
        // (AuthGuard, LoggingInterceptor, ValidationPipe) so resolved edges can be emitted.
        const mod = moduleWithProvidersAndControllers('CatsController', [
            'AuthGuard',
            'LoggingInterceptor',
            'ValidationPipe',
        ]);

        // Resolved guard → contributes 1 guard edge
        const guardRef = makeFilterRef({
            kind: 'class',
            name: 'AuthGuard',
            decorator: 'UseGuards',
            enclosingClass: 'CatsController',
            attachedTo: { kind: 'class' },
        });

        // Resolved interceptor → contributes 1 interceptor edge
        const interceptorRef = makeFilterRef({
            kind: 'class',
            name: 'LoggingInterceptor',
            decorator: 'UseInterceptors',
            enclosingClass: 'CatsController',
            attachedTo: { kind: 'class' },
        });

        // Resolved pipe → contributes 1 pipe edge
        const pipeRef = makeFilterRef({
            kind: 'class',
            name: 'ValidationPipe',
            decorator: 'UsePipes',
            enclosingClass: 'CatsController',
            attachedTo: { kind: 'class' },
        });

        // Unresolved ref (spread) → contributes 1 unresolvedFilterRef
        const unresolvedRef = makeFilterRef({
            kind: 'unresolved',
            decorator: 'UseGuards',
            enclosingClass: 'CatsController',
        });

        // Duplicate of guardRef → contributes 1 dedupDropped
        const dupGuardRef = makeFilterRef({
            kind: 'class',
            name: 'AuthGuard',
            decorator: 'UseGuards',
            enclosingClass: 'CatsController',
            attachedTo: { kind: 'class' }, // same attachedTo → same dedup key
        });

        const filterChain = [guardRef, interceptorRef, pipeRef, unresolvedRef, dupGuardRef];
        const { diagnostics } = mapDiToGraph([mod], IDX, EMPTY_OWNERSHIP, filterChain);

        const c = diagnostics.counts;
        const lhs = c.guards + c.interceptors + c.pipes + c.unresolvedFilterRefs + c.dedupDropped + c.truncatedFilterRefs;
        expect(lhs).toBe(filterChain.length);
        // Spot-check the individual counts
        expect(c.guards).toBe(1);
        expect(c.interceptors).toBe(1);
        expect(c.pipes).toBe(1);
        expect(c.unresolvedFilterRefs).toBe(1);
        expect(c.dedupDropped).toBe(1);
    });
});
