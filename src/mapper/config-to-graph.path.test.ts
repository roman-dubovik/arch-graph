/**
 * Tests asserting that config-field nodes carry path + anchor fields (A3).
 */
import { describe, expect, it } from 'vitest';

import type { ConfigFieldSite } from '../extractors/config/extractor.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import { mapConfigToGraph } from './config-to-graph.js';

function makeOwnership(): OwnershipRegistry {
    return new OwnershipRegistry('/apps', [
        { id: 'auth-service', rootDir: '/apps/auth', tsconfigPath: null, entryFile: null },
    ], []);
}

function makeSite(overrides: Partial<ConfigFieldSite> = {}): ConfigFieldSite {
    return {
        key: 'JWT_SECRET',
        source: 'configService',
        consumerClass: 'AuthConfig',
        consumerContext: 'get jwtSecret',
        location: { file: '/apps/auth/src/auth.config.ts', line: 10, column: 1 },
        ...overrides,
    };
}

describe('mapConfigToGraph — path + anchor (A3)', () => {
    it('emits path = first-seen location.file on config-field node', () => {
        const { nodes } = mapConfigToGraph([makeSite()], makeOwnership());
        const configNode = nodes.find((n) => n.kind === 'config-field');
        expect(configNode).toBeDefined();
        expect(configNode!.path).toBe('/apps/auth/src/auth.config.ts');
    });

    it('emits anchor = config key string', () => {
        const { nodes } = mapConfigToGraph([makeSite()], makeOwnership());
        const configNode = nodes.find((n) => n.kind === 'config-field');
        expect(configNode!.anchor).toBe('JWT_SECRET');
    });

    it('deduplicates config nodes — path from first-seen site', () => {
        const site1 = makeSite({ location: { file: '/apps/auth/src/auth.config.ts', line: 10, column: 1 } });
        const site2 = makeSite({ location: { file: '/apps/auth/src/other.config.ts', line: 5, column: 1 } });
        const { nodes } = mapConfigToGraph([site1, site2], makeOwnership());
        const configNodes = nodes.filter((n) => n.kind === 'config-field');
        // Both sites share the same key → one config-field node
        expect(configNodes.length).toBe(1);
        // First-seen path wins
        expect(configNodes[0]!.path).toBe('/apps/auth/src/auth.config.ts');
    });

    it('emits different nodes for different keys', () => {
        const sites = [
            makeSite({ key: 'JWT_SECRET' }),
            makeSite({ key: 'DATABASE_URL', location: { file: '/apps/auth/src/db.config.ts', line: 3, column: 1 } }),
        ];
        const { nodes } = mapConfigToGraph(sites, makeOwnership());
        const configNodes = nodes.filter((n) => n.kind === 'config-field');
        expect(configNodes.length).toBe(2);
        const jwtNode = configNodes.find((n) => n.label === 'JWT_SECRET');
        const dbNode = configNodes.find((n) => n.label === 'DATABASE_URL');
        expect(jwtNode!.anchor).toBe('JWT_SECRET');
        expect(dbNode!.anchor).toBe('DATABASE_URL');
    });
});
