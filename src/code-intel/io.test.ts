import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CodeIntelDiagnostics, CodeIntelIndex } from './types.js';
import { CODE_INTEL_SCHEMA_VERSION } from './types.js';
import { readCodeIntelDiagnostics, readCodeIntelIndex, writeCodeIntelDiagnostics, writeCodeIntelIndex } from './io.js';

let dir: string;

beforeEach(async () => {
    dir = join(tmpdir(), `arch-graph-code-intel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('code-intel io', () => {
    it('round-trips the JSONL sidecar and validates manifest schema version', async () => {
        const index: CodeIntelIndex = {
            manifest: {
                schemaVersion: CODE_INTEL_SCHEMA_VERSION,
                builtAt: '2026-05-22T00:00:00.000Z',
                root: '/repo',
                counts: { symbols: 1, calls: 1, flows: 1, branches: 1, impacts: 1 },
            },
            symbols: [{
                id: 'symbol:/repo/item.dto.ts#CreateItemDto:1:1',
                kind: 'dto',
                name: 'CreateItemDto',
                fqn: 'CreateItemDto',
                file: '/repo/item.dto.ts',
                line: 1,
                column: 1,
            }],
            calls: [{
                id: 'call:1',
                callerId: 'symbol:/repo/a.ts#A.a:1:1',
                caller: 'A.a',
                callee: 'B.b',
                order: 0,
                file: '/repo/a.ts',
                line: 2,
                column: 3,
                expression: 'this.b.b()',
                args: [],
            }],
            flows: [{
                id: 'flow:1',
                targetId: 'symbol:/repo/a.ts#A.a:1:1',
                target: 'A.a',
                param: 'dto',
                sourceKind: 'param',
                source: 'dto',
                via: 'dto',
                file: '/repo/a.ts',
                line: 2,
                column: 3,
                path: ['dto'],
            }],
            branches: [{
                id: 'branch:1',
                functionId: 'symbol:/repo/a.ts#A.a:1:1',
                functionName: 'A.a',
                condition: 'dto.enabled',
                thenText: 'this.b.b()',
                file: '/repo/a.ts',
                line: 2,
                column: 3,
                nestedIn: [],
                calls: [],
            }],
            impacts: [{
                id: 'impact:1',
                symbolId: 'symbol:/repo/item.dto.ts#CreateItemDto:1:1',
                symbol: 'CreateItemDto',
                kind: 'type-reference',
                file: '/repo/a.ts',
                line: 2,
                column: 3,
                detail: 'CreateItemDto',
                risk: 'medium',
            }],
            policies: [],
        };

        await writeCodeIntelIndex(index, join(dir, 'code-intel'));
        await expect(readCodeIntelIndex(join(dir, 'code-intel'))).resolves.toEqual(index);
    });

    it('round-trips diagnostics sidecar', async () => {
        const diagnostics: CodeIntelDiagnostics = {
            schemaVersion: CODE_INTEL_SCHEMA_VERSION,
            generatedAt: '2026-05-22T00:00:00.000Z',
            root: '/repo',
            counts: {
                symbols: 1,
                calls: 1,
                flows: 0,
                branches: 0,
                impacts: 0,
                resolvedCalls: 0,
                unresolvedCalls: 1,
                resolvedCallRatio: 0,
                internalCalls: 0,
                externalCalls: 0,
                lowValueCalls: 0,
                unknownCalls: 1,
                projectRelevantCalls: 1,
                projectResolvedCallRatio: 0,
            },
            unresolvedCallCategories: [{
                category: 'logger',
                count: 1,
                examples: [{
                    caller: 'A.a',
                    callee: 'this.logger.log',
                    file: '/repo/a.ts',
                    line: 1,
                    column: 1,
                }],
            }],
            impact: {
                byKind: [],
                topSymbols: [],
                topFields: [],
            },
            projectUnknownCalls: {
                topReceivers: [],
                topCallers: [],
                examples: [],
            },
            proofPackets: {
                largestFlowTargets: [],
                largestImpactContracts: [],
                largestCallers: [],
                largestBranches: [],
            },
        };

        await writeCodeIntelDiagnostics(diagnostics, join(dir, 'code-intel'));
        await expect(readCodeIntelDiagnostics(join(dir, 'code-intel'))).resolves.toEqual(diagnostics);
    });
});
