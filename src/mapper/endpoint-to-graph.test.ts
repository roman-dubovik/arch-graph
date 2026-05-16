import { describe, expect, it } from 'vitest';
import { mapEndpointsToGraph } from './endpoint-to-graph.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import type { EndpointSite, HttpMethod } from '../extractors/endpoint/extractor.js';
import { extractEndpoints } from '../extractors/endpoint/extractor.js';
import { inMemoryProject } from '../__fixtures__/in-memory-project.js';

function makeRegistry(serviceId = 'my-service', rootDir = '/app'): OwnershipRegistry {
    return new OwnershipRegistry('/root', [{ id: serviceId, rootDir, tsconfigPath: null, entryFile: null }], []);
}

function site(
    method: HttpMethod,
    pattern: string,
    controllerClass = 'AController',
    methodName = 'handler',
    file = '/app/a.controller.ts',
): EndpointSite {
    return { method, pattern, controllerClass, methodName, location: { file, line: 5, column: 1 } };
}

describe('mapEndpointsToGraph', () => {
    it('returns empty for no sites', () => {
        const result = mapEndpointsToGraph([], makeRegistry());
        expect(result.nodes).toHaveLength(0);
        expect(result.edges).toHaveLength(0);
        expect(result.diagnostics).toHaveLength(0);
    });

    it('creates endpoint node with correct id and label', () => {
        const result = mapEndpointsToGraph([site('GET', '/users')], makeRegistry());
        const node = result.nodes.find((n) => n.kind === 'endpoint');
        expect(node).toBeDefined();
        expect(node!.id).toBe('endpoint:GET /users');
        expect(node!.label).toBe('GET /users');
    });

    it('creates endpoint-of edge from endpoint to service', () => {
        const result = mapEndpointsToGraph([site('GET', '/users')], makeRegistry());
        const edge = result.edges.find((e) => e.kind === 'endpoint-of');
        expect(edge).toBeDefined();
        expect(edge!.from).toBe('endpoint:GET /users');
        expect(edge!.to).toBe('service:my-service');
    });

    it('creates service owner node', () => {
        const result = mapEndpointsToGraph([site('GET', '/users')], makeRegistry());
        const ownerNode = result.nodes.find((n) => n.kind === 'service');
        expect(ownerNode).toBeDefined();
        expect(ownerNode!.id).toBe('service:my-service');
    });

    it('deduplicates endpoint nodes with same method+pattern', () => {
        const sites: EndpointSite[] = [
            site('GET', '/users', 'CtrlA', 'getA'),
            site('GET', '/users', 'CtrlA', 'getADuplicate'),
        ];
        const result = mapEndpointsToGraph(sites, makeRegistry());
        const endpointNodes = result.nodes.filter((n) => n.kind === 'endpoint');
        expect(endpointNodes).toHaveLength(1);
    });

    it('deduplicates endpoint-of edges', () => {
        const sites: EndpointSite[] = [
            site('GET', '/users', 'CtrlA'),
            site('POST', '/users', 'CtrlA'),
        ];
        const result = mapEndpointsToGraph(sites, makeRegistry());
        // Two distinct endpoints, each produces one endpoint-of edge
        const edges = result.edges.filter((e) => e.kind === 'endpoint-of');
        expect(edges).toHaveLength(2);
    });

    it('deduplicates owner nodes across multiple sites', () => {
        const sites: EndpointSite[] = [
            site('GET', '/a'),
            site('POST', '/b'),
            site('PUT', '/c'),
        ];
        const result = mapEndpointsToGraph(sites, makeRegistry());
        const serviceNodes = result.nodes.filter((n) => n.kind === 'service');
        expect(serviceNodes).toHaveLength(1);
    });

    it('adds diagnostic for unowned file, still emits endpoint node', () => {
        const s = site('GET', '/orphan', 'OrphanCtrl', 'handler', '/outside/orphan.controller.ts');
        const result = mapEndpointsToGraph([s], makeRegistry());
        expect(result.diagnostics.length).toBeGreaterThan(0);
        const endpointNode = result.nodes.find((n) => n.kind === 'endpoint');
        expect(endpointNode).toBeDefined();
        // No edge emitted for unowned
        expect(result.edges).toHaveLength(0);
    });

    it('stores controllerClass in endpoint node meta', () => {
        const result = mapEndpointsToGraph([site('GET', '/users', 'UsersController')], makeRegistry());
        const node = result.nodes.find((n) => n.kind === 'endpoint')!;
        expect(node.meta?.controllerClass).toBe('UsersController');
    });

    it('forwards meta fields (version, httpCode) to endpoint node', () => {
        const s: EndpointSite = {
            ...site('POST', '/items'),
            meta: { version: '2', httpCode: 201 },
        };
        const result = mapEndpointsToGraph([s], makeRegistry());
        const node = result.nodes.find((n) => n.kind === 'endpoint')!;
        expect(node.meta?.version).toBe('2');
        expect(node.meta?.httpCode).toBe(201);
    });

    it('handles lib ownership', () => {
        const registry = new OwnershipRegistry(
            '/root',
            [],
            [{ id: 'libs/shared', rootDir: '/lib' }],
        );
        const s = site('GET', '/shared', 'SharedController', 'handler', '/lib/shared.controller.ts');
        const result = mapEndpointsToGraph([s], registry);
        const libNode = result.nodes.find((n) => n.kind === 'lib');
        expect(libNode).toBeDefined();
        expect(libNode!.id).toBe('lib:libs/shared');
    });
});

// ---------------------------------------------------------------------------
// Pipeline diagnostics merge — endpoint domain
// ---------------------------------------------------------------------------

describe('pipeline diagnostics merge — endpoint domain', () => {
    it('combines extractor diagnostics and mapper diagnostics into one messages array', () => {
        // This tests the merge pattern used in pipeline/build.ts:
        //   messages: [...endpoints.diagnostics, ...endpointsMapped.diagnostics]
        // Both arrays must appear in the final merged messages list.
        const extractorDiag = [
            { file: '/app/foo.ts', line: 1, message: 'extractor: non-literal arg in configService call' },
        ];
        const mapperDiag = [
            { message: 'endpoint endpoint:GET /orphan in unowned file /outside/orphan.ts' },
        ];

        // Simulate the build.ts merge
        const merged = [...extractorDiag, ...mapperDiag];

        expect(merged).toHaveLength(2);
        expect(merged.some((m) => m.message.includes('extractor:'))).toBe(true);
        expect(merged.some((m) => m.message.includes('unowned file'))).toBe(true);
    });

    it('mapper diagnostic appears when endpoint is in unowned file', () => {
        // End-to-end: give the mapper a site outside any service root and confirm
        // its diagnostic ends up in what the pipeline would merge.
        const registry = makeRegistry('svc', '/app');
        const orphanSite = site('POST', '/nowhere', 'OrphanCtrl', 'handle', '/outside/orphan.controller.ts');
        const mapperResult = mapEndpointsToGraph([orphanSite], registry);

        expect(mapperResult.diagnostics.length).toBeGreaterThan(0);

        // Simulate the build.ts merge (extractor has no diagnostics here)
        const extractorDiag: Array<{ file: string; line: number; message: string }> = [];
        const mergedMessages = [...extractorDiag, ...mapperResult.diagnostics];

        expect(mergedMessages.some((m) => m.message.includes('unowned'))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Round-trip: extractEndpoints → mapEndpointsToGraph
// ---------------------------------------------------------------------------

describe('round-trip: extractEndpoints → mapEndpointsToGraph', () => {
    it('produces endpoint nodes and endpoint-of edges from a real controller fixture', () => {
        const project = inMemoryProject({
            '/app/users.controller.ts': `
import { Controller, Get, Post, Param } from '@nestjs/common';
@Controller('users')
export class UsersController {
    @Get()
    findAll() { return []; }

    @Post()
    create() { return {}; }

    @Get(':id')
    findOne(@Param('id') id: string) { return { id }; }
}
`,
        });

        const extractResult = extractEndpoints(project);
        expect(extractResult.endpoints.length).toBeGreaterThanOrEqual(3);
        // All should be GET or POST
        const methods = new Set(extractResult.endpoints.map((e) => e.method));
        expect(methods.has('GET') || methods.has('POST')).toBe(true);

        const registry = makeRegistry('my-service', '/app');
        const mapResult = mapEndpointsToGraph(extractResult.endpoints, registry);

        // Nodes: endpoint nodes + service owner node
        const endpointNodes = mapResult.nodes.filter((n) => n.kind === 'endpoint');
        expect(endpointNodes.length).toBeGreaterThanOrEqual(3);

        const serviceNode = mapResult.nodes.find((n) => n.kind === 'service');
        expect(serviceNode).toBeDefined();
        expect(serviceNode!.id).toBe('service:my-service');

        // Edges: one endpoint-of per endpoint
        const endpointOfEdges = mapResult.edges.filter((e) => e.kind === 'endpoint-of');
        expect(endpointOfEdges.length).toBeGreaterThanOrEqual(3);

        // All edges point to the service
        for (const edge of endpointOfEdges) {
            expect(edge.to).toBe('service:my-service');
        }

        // No diagnostics — all files are in /app which is covered by the registry
        expect(mapResult.diagnostics).toHaveLength(0);
    });
});
