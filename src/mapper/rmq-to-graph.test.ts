import { describe, expect, it } from 'vitest';

import { OwnershipRegistry } from '../core/service-registry.js';
import type { RmqCallSite } from '../core/types.js';
import { buildRmqDiagnostics, mapRmqToGraph } from './rmq-to-graph.js';

describe('mapRmqToGraph', () => {
    it('emits rmq-pattern node and rmq-subscribe edge', () => {
        const sites: RmqCallSite[] = [{
            pattern: { kind: 'literal', value: 'order.created' },
            location: { file: '/repo/apps/api/src/orders.listener.ts', line: 4, column: 5 },
            via: '@RmqEventPattern',
            enclosingClass: 'OrdersListener',
            handlerName: 'handle',
            payloadParamName: 'payload',
            payloadType: 'OrderCreatedDto',
        }];
        const ownership = new OwnershipRegistry('/repo', [{ id: 'api', rootDir: '/repo/apps/api' }], []);

        const result = mapRmqToGraph(sites, ownership);
        const diagnostics = buildRmqDiagnostics(sites, result);

        expect(result.nodes.find((n) => n.id === 'rmq:order.created')?.kind).toBe('rmq-pattern');
        const edge = result.edges.find((e) => e.kind === 'rmq-subscribe');
        expect(edge?.from).toBe('rmq:order.created');
        expect(edge?.to).toBe('service:api');
        expect(edge?.meta?.transport).toBe('rmq');
        expect(edge?.meta?.payloadType).toBe('OrderCreatedDto');
        expect(edge?.meta?.handlerName).toBe('handle');
        expect(diagnostics.counts.literal).toBe(1);
    });
});
