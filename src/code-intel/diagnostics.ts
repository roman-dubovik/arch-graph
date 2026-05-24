import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
    CodeIntelCall,
    CodeIntelDiagnostics,
    CodeIntelDiagnosticsExample,
    CodeIntelImpact,
    CodeIntelIndex,
} from './types.js';
import { CODE_INTEL_SCHEMA_VERSION } from './types.js';

const SIDECAR_FILES = [
    'manifest.json',
    'symbols.jsonl',
    'calls.jsonl',
    'flows.jsonl',
    'branches.jsonl',
    'impacts.jsonl',
    'diagnostics.json',
];

export async function createCodeIntelDiagnostics(
    index: CodeIntelIndex,
    opts: { sidecarDir?: string; topN?: number } = {},
): Promise<CodeIntelDiagnostics> {
    const sidecarFiles = opts.sidecarDir ? await collectSidecarFileSizes(opts.sidecarDir) : undefined;
    return analyzeCodeIntelDiagnostics(index, { ...opts, sidecarFiles });
}

export function analyzeCodeIntelDiagnostics(
    index: CodeIntelIndex,
    opts: { topN?: number; sidecarFiles?: Array<{ file: string; bytes: number }> } = {},
): CodeIntelDiagnostics {
    const topN = opts.topN ?? 10;
    const resolvedCalls = index.calls.filter((call) => Boolean(call.calleeId)).length;
    const unresolvedCalls = index.calls.length - resolvedCalls;
    const internalCalls = index.calls.filter((call) => call.kind === 'internal' || Boolean(call.calleeId)).length;
    const externalCalls = index.calls.filter((call) => call.kind === 'external' || call.kind === 'framework').length;
    const lowValueCalls = index.calls.filter((call) =>
        call.kind === 'built-in' ||
        call.kind === 'common-object-method' ||
        call.kind === 'process-env'
    ).length;
    const unknownCalls = index.calls.filter((call) => !call.calleeId && (!call.kind || call.kind === 'unknown')).length;
    const projectRelevantCalls = internalCalls + unknownCalls;
    const unknownCallRecords = index.calls.filter((call) => !call.calleeId && (!call.kind || call.kind === 'unknown'));
    const unresolvedCallCategories = topEntries(
        groupBy(index.calls.filter((call) => !call.calleeId), classifyUnresolvedCall),
        topN,
    ).map(([category, calls]) => ({
        category,
        count: calls.length,
        examples: calls.slice(0, 5).map(callExample),
    }));

    const impactByKind = topEntries(groupBy(index.impacts, (impact) => impact.kind), topN)
        .map(([kind, impacts]) => ({ kind: kind as CodeIntelImpact['kind'], count: impacts.length }));
    const topSymbols = topEntries(groupBy(index.impacts, (impact) => impact.symbol), topN)
        .map(([symbol, impacts]) => ({
            symbol,
            count: impacts.length,
            fieldReferences: impacts.filter((impact) => impact.kind === 'field-reference').length,
            risk: maxRisk(impacts),
        }));
    const topFields = topEntries(
        groupBy(index.impacts.filter((impact) => impact.field), (impact) => `${impact.symbol}.${impact.field}`),
        topN,
    ).map(([key, impacts]) => ({
        symbol: impacts[0]?.symbol ?? key,
        field: impacts[0]?.field ?? key.split('.').at(-1) ?? key,
        count: impacts.length,
    }));

    return {
        schemaVersion: CODE_INTEL_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        root: index.manifest.root,
        counts: {
            ...index.manifest.counts,
            resolvedCalls,
            unresolvedCalls,
            resolvedCallRatio: index.calls.length === 0 ? 1 : Number((resolvedCalls / index.calls.length).toFixed(4)),
            internalCalls,
            externalCalls,
            lowValueCalls,
            unknownCalls,
            projectRelevantCalls,
            projectResolvedCallRatio: projectRelevantCalls === 0 ? 1 : Number((internalCalls / projectRelevantCalls).toFixed(4)),
        },
        unresolvedCallCategories,
        impact: {
            byKind: impactByKind,
            topSymbols,
            topFields,
        },
        projectUnknownCalls: {
            topReceivers: topEntries(
                groupBy(unknownCallRecords.filter((call) => call.receiver), (call) => call.receiver ?? '<none>'),
                topN,
            ).map(([receiver, calls]) => ({ receiver, count: calls.length })),
            topCallers: topEntries(groupBy(unknownCallRecords, (call) => call.caller), topN)
                .map(([caller, calls]) => ({ caller, count: calls.length })),
            examples: unknownCallRecords.slice(0, topN).map(callExample),
        },
        proofPackets: {
            largestFlowTargets: topEntries(groupBy(index.flows, (flow) => `${flow.target}:${flow.param}`), topN)
                .map(([key, flows]) => ({
                    target: flows[0]?.target ?? key,
                    param: flows[0]?.param ?? key.split(':').at(-1) ?? key,
                    count: flows.length,
                })),
            largestImpactContracts: topSymbols.map(({ symbol, count }) => ({ symbol, count })),
            largestCallers: topEntries(groupBy(index.calls, (call) => call.caller), topN)
                .map(([caller, calls]) => ({ caller, count: calls.length })),
            largestBranches: index.branches
                .slice()
                .sort((a, b) => b.calls.length - a.calls.length || b.thenText.length - a.thenText.length)
                .slice(0, topN)
                .map((branch) => ({
                    functionName: branch.functionName,
                    condition: branch.condition,
                    calls: branch.calls.length,
                    thenTextLength: branch.thenText.length,
                    file: branch.file,
                    line: branch.line,
                    column: branch.column,
                })),
        },
        ...(opts.sidecarFiles ? { sidecarFiles: opts.sidecarFiles } : {}),
    };
}

async function collectSidecarFileSizes(sidecarDir: string): Promise<Array<{ file: string; bytes: number }>> {
    const out: Array<{ file: string; bytes: number }> = [];
    for (const file of SIDECAR_FILES) {
        try {
            const stats = await stat(join(sidecarDir, file));
            out.push({ file, bytes: stats.size });
        } catch {
            // diagnostics.json does not exist on the first write; older sidecars may miss new files.
        }
    }
    return out;
}

function classifyUnresolvedCall(call: CodeIntelCall): string {
    if (call.kind && call.kind !== 'unknown') return call.kind;
    const callee = call.callee;
    const receiver = call.receiver ?? '';
    const expression = call.expression;
    const text = `${receiver} ${callee} ${expression}`;

    if (callee === 'super' || expression === 'super') return 'language-super';
    if (receiver.startsWith('process.') || receiver === 'process') return 'process-io-or-env';
    if (/\blogger\b/i.test(text)) return 'logger';
    if (receiver && isCommonObjectMethod(callee.split('.').at(-1) ?? callee)) return 'common-object-method';
    if (!receiver.startsWith('/') && /\b(queryBuilder|createQueryBuilder|queryRunner|repository|manager)\b/i.test(`${receiver} ${expression}`)) {
        return 'orm-query-fluent';
    }
    if (isBuiltIn(callee) || isBuiltIn(receiver.split('.').at(0) ?? receiver)) return 'built-in-or-global';
    if (!receiver && /^use[A-Z0-9]/.test(callee)) return 'react-hook-or-custom-hook';
    if (receiver.startsWith('this.')) return 'di-field-or-instance';
    if (receiver === 'this') return 'same-class-method-missing-symbol';
    if (receiver) return 'external-or-local-object';
    if (/^[A-Z]/.test(callee)) return 'constructor-or-static';
    return 'unresolved-direct';
}

function isCommonObjectMethod(method: string): boolean {
    return new Set([
        'add',
        'at',
        'catch',
        'concat',
        'delete',
        'entries',
        'every',
        'filter',
        'find',
        'findIndex',
        'flat',
        'flatMap',
        'forEach',
        'get',
        'has',
        'includes',
        'join',
        'keys',
        'map',
        'match',
        'pop',
        'push',
        'reduce',
        'replace',
        'set',
        'slice',
        'some',
        'sort',
        'split',
        'startsWith',
        'test',
        'toFixed',
        'trim',
        'trimEnd',
        'trimStart',
        'values',
    ]).has(method);
}

function isBuiltIn(name: string): boolean {
    return new Set([
        'Array',
        'Boolean',
        'Date',
        'Error',
        'JSON',
        'Map',
        'Math',
        'Number',
        'Object',
        'Promise',
        'Reflect',
        'RegExp',
        'Set',
        'String',
        'console',
        'parseInt',
        'parseFloat',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
    ]).has(name);
}

function callExample(call: CodeIntelCall): CodeIntelDiagnosticsExample {
    return {
        caller: call.caller,
        callee: call.callee,
        ...(call.receiver ? { receiver: call.receiver } : {}),
        expression: call.expression,
        file: call.file,
        line: call.line,
        column: call.column,
    };
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
    const grouped = new Map<string, T[]>();
    for (const item of items) {
        const key = keyOf(item);
        const bucket = grouped.get(key) ?? [];
        bucket.push(item);
        grouped.set(key, bucket);
    }
    return grouped;
}

function topEntries<T>(grouped: Map<string, T[]>, limit: number): Array<[string, T[]]> {
    return Array.from(grouped.entries())
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
        .slice(0, limit);
}

function maxRisk(impacts: CodeIntelImpact[]): CodeIntelImpact['risk'] {
    if (impacts.some((impact) => impact.risk === 'high')) return 'high';
    if (impacts.some((impact) => impact.risk === 'medium')) return 'medium';
    return 'low';
}
