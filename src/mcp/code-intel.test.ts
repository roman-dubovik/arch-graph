import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
    explainBranchInputShape,
    explainDataFlowInputShape,
    impactContractInputShape,
    resolveSymbolInputShape,
    traceScenarioInputShape,
} from './server.js';

describe('code-intel MCP schemas', () => {
    it('accept compact inputs for code intelligence tools', () => {
        expect(z.object(resolveSymbolInputShape).parse({ query: 'CreateItemDto' })).toEqual({
            query: 'CreateItemDto',
        });
        expect(z.object(explainDataFlowInputShape).parse({ target: 'ItemsController.create', param: 'dto' })).toEqual({
            target: 'ItemsController.create',
            param: 'dto',
            maxResults: 20,
        });
        expect(z.object(explainBranchInputShape).parse({ file: '/repo/a.ts', line: 10 })).toEqual({
            file: '/repo/a.ts',
            line: 10,
        });
        expect(z.object(traceScenarioInputShape).parse({ entry: 'POST /items', maxDepth: 3 })).toEqual({
            entry: 'POST /items',
            maxDepth: 3,
        });
        expect(z.object(impactContractInputShape).parse({ symbol: 'CreateItemDto', field: 'name' })).toEqual({
            symbol: 'CreateItemDto',
            field: 'name',
            maxResults: 50,
        });
    });
});
