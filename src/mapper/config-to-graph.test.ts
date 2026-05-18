import { describe, expect, it } from 'vitest';
import { mapConfigToGraph } from './config-to-graph.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import type { ConfigFieldSite } from '../extractors/config/extractor.js';

function makeRegistry(serviceId = 'svc', rootDir = '/app'): OwnershipRegistry {
    return new OwnershipRegistry('/root', [{ id: serviceId, rootDir, tsconfigPath: null, entryFile: null }], []);
}

function site(
    key: string,
    source: 'configService' | 'process.env' = 'configService',
    file = '/app/a.service.ts',
    consumerClass?: string,
): ConfigFieldSite {
    return {
        key,
        source,
        consumerClass,
        consumerContext: 'someMethod',
        location: { file, line: 10, column: 1 },
    };
}

describe('mapConfigToGraph', () => {
    it('returns empty for no sites', () => {
        const result = mapConfigToGraph([], makeRegistry());
        expect(result.nodes).toHaveLength(0);
        expect(result.edges).toHaveLength(0);
        expect(result.diagnostics).toHaveLength(0);
    });

    it('creates config-field node with correct id', () => {
        const result = mapConfigToGraph([site('DATABASE_URL')], makeRegistry());
        const node = result.nodes.find((n) => n.kind === 'config-field');
        expect(node).toBeDefined();
        expect(node!.id).toBe('config-field:DATABASE_URL');
        expect(node!.label).toBe('DATABASE_URL');
    });

    it('creates config-read-by edge from config-field to service', () => {
        const result = mapConfigToGraph([site('JWT_SECRET')], makeRegistry());
        const edge = result.edges.find((e) => e.kind === 'config-read-by');
        expect(edge).toBeDefined();
        expect(edge!.from).toBe('config-field:JWT_SECRET');
        expect(edge!.to).toBe('service:svc');
    });

    it('deduplicates config-field nodes for same key', () => {
        const sites: ConfigFieldSite[] = [
            site('DB_URL'),
            site('DB_URL', 'configService', '/app/b.service.ts'),
        ];
        const result = mapConfigToGraph(sites, makeRegistry());
        const configNodes = result.nodes.filter((n) => n.kind === 'config-field');
        expect(configNodes).toHaveLength(1);
    });

    it('deduplicates edges for same key×owner pair', () => {
        // two calls to get('SAME_KEY') from same service → one edge
        const sites: ConfigFieldSite[] = [
            site('SAME_KEY'),
            site('SAME_KEY', 'process.env'),
        ];
        const result = mapConfigToGraph(sites, makeRegistry());
        const edges = result.edges.filter((e) => e.kind === 'config-read-by');
        expect(edges).toHaveLength(1);
    });

    it('emits separate edges for same key from different services', () => {
        const registry = new OwnershipRegistry(
            '/root',
            [
                { id: 'svc-a', rootDir: '/app/a', tsconfigPath: null, entryFile: null },
                { id: 'svc-b', rootDir: '/app/b', tsconfigPath: null, entryFile: null },
            ],
            [],
        );
        const sites: ConfigFieldSite[] = [
            site('SHARED_KEY', 'configService', '/app/a/service.ts'),
            site('SHARED_KEY', 'configService', '/app/b/service.ts'),
        ];
        const result = mapConfigToGraph(sites, registry);
        const edges = result.edges.filter((e) => e.kind === 'config-read-by');
        expect(edges).toHaveLength(2);
    });

    it('creates service owner node', () => {
        const result = mapConfigToGraph([site('KEY')], makeRegistry());
        const ownerNode = result.nodes.find((n) => n.kind === 'service');
        expect(ownerNode).toBeDefined();
        expect(ownerNode!.id).toBe('service:svc');
    });

    it('stores source in config-field node meta', () => {
        const result = mapConfigToGraph([site('PORT', 'process.env')], makeRegistry());
        const node = result.nodes.find((n) => n.kind === 'config-field')!;
        expect(node.meta?.source).toBe('process.env');
    });

    it('adds diagnostic for unowned file, still emits config node', () => {
        const s = site('ORPHAN_KEY', 'configService', '/outside/orphan.service.ts');
        const result = mapConfigToGraph([s], makeRegistry());
        expect(result.diagnostics.length).toBeGreaterThan(0);
        const configNode = result.nodes.find((n) => n.kind === 'config-field');
        expect(configNode).toBeDefined();
        expect(result.edges).toHaveLength(0);
    });

    it('stores consumerClass in edge meta when present', () => {
        const s = site('MY_KEY', 'configService', '/app/a.service.ts', 'MyService');
        const result = mapConfigToGraph([s], makeRegistry());
        const edge = result.edges.find((e) => e.kind === 'config-read-by')!;
        expect(edge.meta?.consumerClass).toBe('MyService');
    });

    it('handles multiple distinct keys', () => {
        const sites: ConfigFieldSite[] = [
            site('KEY_A'),
            site('KEY_B'),
            site('KEY_C', 'process.env'),
        ];
        const result = mapConfigToGraph(sites, makeRegistry());
        const configNodes = result.nodes.filter((n) => n.kind === 'config-field');
        expect(configNodes).toHaveLength(3);
        const edges = result.edges.filter((e) => e.kind === 'config-read-by');
        expect(edges).toHaveLength(3);
    });
});
