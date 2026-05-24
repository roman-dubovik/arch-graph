import { describe, expect, it } from 'vitest';

import { analyzeCodeIntelDiagnostics } from './diagnostics.js';
import type { CodeIntelIndex } from './types.js';
import { CODE_INTEL_SCHEMA_VERSION } from './types.js';

describe('code-intel diagnostics', () => {
    it('classifies unresolved calls and reports top impact/proof packet groups', () => {
        const index: CodeIntelIndex = {
            manifest: {
                schemaVersion: CODE_INTEL_SCHEMA_VERSION,
                builtAt: '2026-05-22T00:00:00.000Z',
                root: '/repo',
                counts: { symbols: 0, calls: 5, flows: 2, branches: 1, impacts: 3 },
            },
            symbols: [],
            calls: [
                {
                    id: 'call:1',
                    callerId: 'symbol:A.a',
                    caller: 'A.a',
                    callee: 'B.b',
                    calleeId: 'symbol:B.b',
                    order: 0,
                    expression: 'this.b.b',
                    receiver: 'this.b',
                    args: [],
                    file: '/repo/a.ts',
                    line: 1,
                    column: 1,
                },
                {
                    id: 'call:2',
                    callerId: 'symbol:A.a',
                    caller: 'A.a',
                    callee: 'this.logger.log',
                    kind: 'framework',
                    order: 1,
                    expression: 'this.logger.log',
                    receiver: 'this.logger',
                    args: ['message'],
                    file: '/repo/a.ts',
                    line: 2,
                    column: 1,
                },
                {
                    id: 'call:3',
                    callerId: 'symbol:A.a',
                    caller: 'A.a',
                    callee: 'queryBuilder.where',
                    kind: 'framework',
                    order: 2,
                    expression: 'queryBuilder.where',
                    receiver: 'queryBuilder',
                    args: [],
                    file: '/repo/a.ts',
                    line: 3,
                    column: 1,
                },
                {
                    id: 'call:4',
                    callerId: 'symbol:C.c',
                    caller: 'C.c',
                    callee: 'Date.now',
                    kind: 'built-in',
                    order: 0,
                    expression: 'Date.now',
                    receiver: 'Date',
                    args: [],
                    file: '/repo/c.ts',
                    line: 4,
                    column: 1,
                },
                {
                    id: 'call:5',
                    callerId: 'symbol:C.c',
                    caller: 'C.c',
                    callee: 'adapter.load',
                    kind: 'unknown',
                    order: 1,
                    expression: 'adapter.load',
                    receiver: 'adapter',
                    args: [],
                    file: '/repo/c.ts',
                    line: 5,
                    column: 1,
                },
            ],
            flows: [
                {
                    id: 'flow:1',
                    targetId: 'symbol:A.a',
                    target: 'A.a',
                    param: 'dto',
                    sourceKind: 'decorator',
                    source: '@Body dto',
                    via: 'this.b.b(dto)',
                    to: 'B.b',
                    path: ['@Body dto', 'dto', 'B.b arg'],
                    file: '/repo/a.ts',
                    line: 1,
                    column: 1,
                },
                {
                    id: 'flow:2',
                    targetId: 'symbol:A.a',
                    target: 'A.a',
                    param: 'dto',
                    sourceKind: 'return',
                    source: '@Body dto',
                    via: 'return dto',
                    path: ['@Body dto', 'return'],
                    file: '/repo/a.ts',
                    line: 5,
                    column: 1,
                },
            ],
            branches: [{
                id: 'branch:1',
                functionId: 'symbol:A.a',
                functionName: 'A.a',
                condition: 'dto.enabled',
                thenText: 'this.b.b(dto); this.logger.log(dto);',
                nestedIn: [],
                calls: ['B.b', 'this.logger.log'],
                file: '/repo/a.ts',
                line: 6,
                column: 5,
            }],
            impacts: [
                {
                    id: 'impact:1',
                    symbolId: 'symbol:CreateDto',
                    symbol: 'CreateDto',
                    kind: 'endpoint',
                    detail: '@Body dto: CreateDto',
                    risk: 'high',
                    file: '/repo/a.ts',
                    line: 1,
                    column: 1,
                },
                {
                    id: 'impact:2',
                    symbolId: 'symbol:CreateDto',
                    symbol: 'CreateDto',
                    field: 'name',
                    kind: 'field-reference',
                    detail: 'dto.name',
                    risk: 'medium',
                    file: '/repo/a.ts',
                    line: 2,
                    column: 1,
                },
                {
                    id: 'impact:3',
                    symbolId: 'symbol:CreateDto',
                    symbol: 'CreateDto',
                    field: 'name',
                    kind: 'field-reference',
                    detail: 'dto.name',
                    risk: 'medium',
                    file: '/repo/b.ts',
                    line: 3,
                    column: 1,
                },
            ],
        };

        const diagnostics = analyzeCodeIntelDiagnostics(index);

        expect(diagnostics.counts).toMatchObject({
            resolvedCalls: 1,
            unresolvedCalls: 4,
            resolvedCallRatio: 0.2,
            internalCalls: 1,
            externalCalls: 2,
            lowValueCalls: 1,
            unknownCalls: 1,
            projectRelevantCalls: 2,
            projectResolvedCallRatio: 0.5,
        });
        expect(diagnostics.unresolvedCallCategories.map((item) => item.category)).toEqual(
            expect.arrayContaining(['framework', 'built-in']),
        );
        expect(diagnostics.impact.topSymbols[0]).toMatchObject({
            symbol: 'CreateDto',
            count: 3,
            fieldReferences: 2,
            risk: 'high',
        });
        expect(diagnostics.projectUnknownCalls.topReceivers[0]).toEqual({ receiver: 'adapter', count: 1 });
        expect(diagnostics.projectUnknownCalls.topCallers[0]).toEqual({ caller: 'C.c', count: 1 });
        expect(diagnostics.proofPackets.largestFlowTargets[0]).toMatchObject({
            target: 'A.a',
            param: 'dto',
            count: 2,
        });
        expect(diagnostics.proofPackets.largestBranches[0]).toMatchObject({
            functionName: 'A.a',
            calls: 2,
        });
    });
});
