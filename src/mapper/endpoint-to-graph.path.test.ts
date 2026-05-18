/**
 * Tests asserting that endpoint nodes carry path + anchor fields (A2).
 */
import { describe, expect, it } from 'vitest';

import type { EndpointSite } from '../extractors/endpoint/extractor.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import { mapEndpointsToGraph } from './endpoint-to-graph.js';

function makeOwnership(): OwnershipRegistry {
    return new OwnershipRegistry('/apps', [
        { id: 'auth-service', rootDir: '/apps/auth', tsconfigPath: null, entryFile: null },
    ], []);
}

function makeSite(overrides: Partial<EndpointSite> = {}): EndpointSite {
    return {
        method: 'GET',
        pattern: '/users',
        controllerClass: 'UsersController',
        methodName: 'findAll',
        location: { file: '/apps/auth/src/users.controller.ts', line: 10, column: 1 },
        ...overrides,
    };
}

describe('mapEndpointsToGraph — path + anchor (A2)', () => {
    it('emits path = location.file on endpoint node', () => {
        const { nodes } = mapEndpointsToGraph([makeSite()], makeOwnership());
        const endpointNode = nodes.find((n) => n.kind === 'endpoint');
        expect(endpointNode).toBeDefined();
        expect(endpointNode!.path).toBe('/apps/auth/src/users.controller.ts');
    });

    it('emits anchor = "ControllerClass.methodName"', () => {
        const { nodes } = mapEndpointsToGraph([makeSite()], makeOwnership());
        const endpointNode = nodes.find((n) => n.kind === 'endpoint');
        expect(endpointNode!.anchor).toBe('UsersController.findAll');
    });

    it('deduplicates endpoint nodes — path+anchor from first-seen site', () => {
        const site1 = makeSite({ methodName: 'findAll' });
        const site2 = makeSite({ methodName: 'findAll' }); // same endpoint
        const { nodes } = mapEndpointsToGraph([site1, site2], makeOwnership());
        const endpointNodes = nodes.filter((n) => n.kind === 'endpoint');
        expect(endpointNodes.length).toBe(1);
        expect(endpointNodes[0]!.anchor).toBe('UsersController.findAll');
    });

    it('emits path + anchor for POST endpoints too', () => {
        const site = makeSite({
            method: 'POST',
            pattern: '/users',
            controllerClass: 'UsersController',
            methodName: 'create',
        });
        const { nodes } = mapEndpointsToGraph([site], makeOwnership());
        const endpointNode = nodes.find((n) => n.kind === 'endpoint');
        expect(endpointNode!.path).toBe('/apps/auth/src/users.controller.ts');
        expect(endpointNode!.anchor).toBe('UsersController.create');
    });
});
