import { describe, expect, it } from 'vitest';

import { inMemoryProject } from '../../__fixtures__/in-memory-project.js';
import { extractRmq } from './extractor.js';

describe('extractRmq', () => {
    it('extracts configured RMQ decorator patterns without classifying them as NATS', async () => {
        const project = inMemoryProject({
            '/apps/api/src/orders.listener.ts': `
                enum RmqPattern {
                    OrderCreated = 'order.created',
                }
                class OrdersListener {
                    @RmqEventPattern(RmqPattern.OrderCreated)
                    handle(payload: OrderCreatedDto): void {}
                }
            `,
        });

        const sites = await extractRmq({
            id: 'test',
            root: '/',
            appsGlob: 'apps/*',
            rmq: { subscribeDecorators: ['RmqEventPattern'] },
        }, project);

        expect(sites).toHaveLength(1);
        expect(sites[0]?.pattern).toEqual({ kind: 'literal', value: 'order.created' });
        expect(sites[0]?.via).toBe('@RmqEventPattern');
        expect(sites[0]?.enclosingClass).toBe('OrdersListener');
        expect(sites[0]?.handlerName).toBe('handle');
        expect(sites[0]?.payloadParamName).toBe('payload');
        expect(sites[0]?.payloadType).toBe('OrderCreatedDto');
    });
});
