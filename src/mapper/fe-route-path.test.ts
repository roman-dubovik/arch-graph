/**
 * Tests asserting that fe-route nodes now carry a path field (A6).
 */
import { describe, expect, it } from 'vitest';

import type { FeExtractResult } from '../extractors/fe/types.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import { mapFeToGraph } from './fe-to-graph.js';

function makeOwnership(): OwnershipRegistry {
    return new OwnershipRegistry('/apps', [
        { id: 'web', rootDir: '/apps/web', tsconfigPath: null, entryFile: null },
    ], []);
}

function makeExtractResult(overrides: Partial<FeExtractResult> = {}): FeExtractResult {
    return {
        components: [],
        hooks: [],
        routes: [],
        pages: [],
        renders: [],
        imports: [],
        unresolvedImports: [],
        ...overrides,
    };
}

describe('mapFeToGraph — fe-route path (A6)', () => {
    it('emits path = pageFile on fe-route node', () => {
        const extractResult = makeExtractResult({
            routes: [
                { pattern: '/dashboard', pageFile: '/apps/web/src/app/dashboard/page.tsx' },
            ],
        });
        const { nodes } = mapFeToGraph(extractResult, makeOwnership());
        const routeNode = nodes.find((n) => n.kind === 'fe-route');
        expect(routeNode).toBeDefined();
        expect(routeNode!.path).toBe('/apps/web/src/app/dashboard/page.tsx');
        expect(routeNode!.label).toBe('/dashboard');
    });

    it('emits path for multiple routes', () => {
        const extractResult = makeExtractResult({
            routes: [
                { pattern: '/users', pageFile: '/apps/web/src/app/users/page.tsx' },
                { pattern: '/settings', pageFile: '/apps/web/src/app/settings/page.tsx' },
            ],
        });
        const { nodes } = mapFeToGraph(extractResult, makeOwnership());
        const routeNodes = nodes.filter((n) => n.kind === 'fe-route');
        expect(routeNodes).toHaveLength(2);
        const usersRoute = routeNodes.find((n) => n.label === '/users');
        const settingsRoute = routeNodes.find((n) => n.label === '/settings');
        expect(usersRoute!.path).toBe('/apps/web/src/app/users/page.tsx');
        expect(settingsRoute!.path).toBe('/apps/web/src/app/settings/page.tsx');
    });

    it('fe-component still has path (regression test)', () => {
        const extractResult = makeExtractResult({
            components: [
                {
                    name: 'Button',
                    file: '/apps/web/src/components/button.tsx',
                    kind: 'arrow',
                    exported: true,
                    defaultExport: false,
                    location: { file: '/apps/web/src/components/button.tsx', line: 1, column: 1 },
                },
            ],
        });
        const { nodes } = mapFeToGraph(extractResult, makeOwnership());
        const componentNode = nodes.find((n) => n.kind === 'fe-component');
        expect(componentNode).toBeDefined();
        expect(componentNode!.path).toBe('/apps/web/src/components/button.tsx');
    });
});
