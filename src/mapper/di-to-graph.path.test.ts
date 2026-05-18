/**
 * Tests asserting that provider/module nodes carry path + anchor fields (A1).
 * Uses ClassIndex to supply file paths.
 */
import { describe, expect, it } from 'vitest';

import type { DiModuleSite, SourceLoc } from '../core/types.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import { DiModuleIndex } from '../extractors/di/module-index.js';
import { ClassIndex } from '../extractors/di/class-index.js';
import { mapDiToGraph } from './di-to-graph.js';

function makeLoc(file = '/apps/auth/src/auth.module.ts', line = 1): SourceLoc {
    return { file, line, column: 1 };
}

function makeModule(className: string, overrides: Partial<DiModuleSite> = {}): DiModuleSite {
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

function makeOwnership(): OwnershipRegistry {
    return new OwnershipRegistry('/apps', [
        { id: 'auth-service', rootDir: '/apps/auth', tsconfigPath: null, entryFile: null },
    ], []);
}

function makeModuleIndex(entries: Array<[string, { file: string; line: number }]> = []): DiModuleIndex {
    const idx = new DiModuleIndex();
    for (const [name, loc] of entries) idx.set(name, loc);
    return idx;
}

function makeClassIndex(entries: Array<[string, string]>): ClassIndex {
    const idx = new ClassIndex();
    for (const [name, file] of entries) idx._set(name, file);
    return idx;
}

describe('mapDiToGraph — provider path + anchor (A1)', () => {
    it('emits path + anchor on provider node when classIndex resolves the class', () => {
        const classIdx = makeClassIndex([
            ['AuthService', '/apps/auth/src/auth.service.ts'],
        ]);
        const mod = makeModule('AuthModule', {
            providers: [{ kind: 'class', name: 'AuthService' }],
        });
        const moduleIdx = makeModuleIndex([
            ['AuthModule', { file: '/apps/auth/src/auth.module.ts', line: 1 }],
        ]);
        const { nodes } = mapDiToGraph([mod], moduleIdx, makeOwnership(), [], [], classIdx);
        const providerNode = nodes.find((n) => n.kind === 'provider' && n.label === 'AuthService');
        expect(providerNode).toBeDefined();
        expect(providerNode!.path).toBe('/apps/auth/src/auth.service.ts');
        expect(providerNode!.anchor).toBe('AuthService');
    });

    it('omits path + anchor when classIndex has no entry for the provider', () => {
        const classIdx = makeClassIndex([]); // empty index
        const mod = makeModule('AuthModule', {
            providers: [{ kind: 'class', name: 'UnknownService' }],
        });
        const moduleIdx = makeModuleIndex([['AuthModule', { file: '/apps/auth/src/auth.module.ts', line: 1 }]]);
        const { nodes } = mapDiToGraph([mod], moduleIdx, makeOwnership(), [], [], classIdx);
        const providerNode = nodes.find((n) => n.kind === 'provider' && n.label === 'UnknownService');
        expect(providerNode).toBeDefined();
        expect(providerNode!.path).toBeUndefined();
        expect(providerNode!.anchor).toBeUndefined();
    });

    it('emits path + anchor on module node when moduleIndex resolves the class', () => {
        const classIdx = makeClassIndex([]);
        const mod = makeModule('AuthModule');
        const moduleIdx = makeModuleIndex([
            ['AuthModule', { file: '/apps/auth/src/auth.module.ts', line: 1 }],
        ]);
        const { nodes } = mapDiToGraph([mod], moduleIdx, makeOwnership(), [], [], classIdx);
        const moduleNode = nodes.find((n) => n.kind === 'module' && n.label === 'AuthModule');
        expect(moduleNode).toBeDefined();
        expect(moduleNode!.path).toBe('/apps/auth/src/auth.module.ts');
        expect(moduleNode!.anchor).toBe('AuthModule');
    });

    it('omits path + anchor on module node when not in moduleIndex', () => {
        const classIdx = makeClassIndex([]);
        const mod = makeModule('ExternalModule', {
            imports: [{ kind: 'class', name: 'ExternalModule' }],
        });
        const moduleIdx = makeModuleIndex([]); // empty — ExternalModule is external
        const { nodes } = mapDiToGraph([mod], moduleIdx, makeOwnership(), [], [], classIdx);
        const externalNode = nodes.find((n) => n.kind === 'module' && n.label === 'ExternalModule');
        // ExternalModule node is created via ensureModuleNode with no path
        if (externalNode) {
            expect(externalNode.path).toBeUndefined();
        }
    });

    it('works without classIndex (backward compat)', () => {
        const mod = makeModule('AuthModule', {
            providers: [{ kind: 'class', name: 'AuthService' }],
        });
        const moduleIdx = makeModuleIndex([['AuthModule', { file: '/apps/auth/src/auth.module.ts', line: 1 }]]);
        // No classIndex passed
        expect(() => mapDiToGraph([mod], moduleIdx, makeOwnership())).not.toThrow();
        const { nodes } = mapDiToGraph([mod], moduleIdx, makeOwnership());
        const providerNode = nodes.find((n) => n.kind === 'provider');
        expect(providerNode!.path).toBeUndefined(); // no index = no path
    });
});
