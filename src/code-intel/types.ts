import type { SourceLoc } from '../core/types.js';

export const CODE_INTEL_SCHEMA_VERSION = 1;

export type CodeIntelSymbolKind = 'class' | 'method' | 'function' | 'dto' | 'type' | 'field' | 'param';

export type CodeIntelCallKind =
    | 'internal'
    | 'external'
    | 'built-in'
    | 'common-object-method'
    | 'process-env'
    | 'framework'
    | 'unknown';

export interface CodeIntelManifest {
    schemaVersion: number;
    builtAt: string;
    root: string;
    counts: {
        symbols: number;
        calls: number;
        flows: number;
        branches: number;
        impacts: number;
    };
}

export interface CodeIntelSymbol extends SourceLoc {
    id: string;
    kind: CodeIntelSymbolKind;
    name: string;
    fqn: string;
    parentId?: string;
    ownerName?: string;
    signature?: string;
    type?: string;
    returnType?: string;
    visibility?: string;
    isAsync?: boolean;
    decorators?: string[];
    description?: string;
}

export interface CodeIntelCall extends SourceLoc {
    id: string;
    callerId: string;
    caller: string;
    callee: string;
    calleeId?: string;
    kind?: CodeIntelCallKind;
    module?: string;
    importName?: string;
    order: number;
    expression: string;
    receiver?: string;
    args: string[];
    conditions?: string[];
}

export interface CodeIntelFlow extends SourceLoc {
    id: string;
    targetId: string;
    target: string;
    param: string;
    sourceKind:
        | 'param'
        | 'decorator'
        | 'local'
        | 'call-arg'
        | 'return'
        | 'http'
        | 'msg'
        | 'db'
        | 'env'
        | 'config'
        | 'job';
    source: string;
    via: string;
    to?: string;
    toParam?: string;
    sinkKind?: 'db' | 'http' | 'msg' | 'job' | 'log' | 'error';
    path: string[];
}

export interface CodeIntelBranch extends SourceLoc {
    id: string;
    functionId: string;
    functionName: string;
    condition: string;
    thenText: string;
    nestedIn: string[];
    calls: string[];
}

export interface CodeIntelImpact extends SourceLoc {
    id: string;
    symbolId: string;
    symbol: string;
    field?: string;
    kind: 'endpoint' | 'message' | 'type-reference' | 'field-reference' | 'test' | 'mapper';
    detail: string;
    risk: 'low' | 'medium' | 'high';
}

export interface CodeIntelIndex {
    manifest: CodeIntelManifest;
    symbols: CodeIntelSymbol[];
    calls: CodeIntelCall[];
    flows: CodeIntelFlow[];
    branches: CodeIntelBranch[];
    impacts: CodeIntelImpact[];
}

export interface CodeIntelDiagnosticsExample extends SourceLoc {
    caller?: string;
    callee?: string;
    receiver?: string;
    expression?: string;
    detail?: string;
}

export interface CodeIntelDiagnostics {
    schemaVersion: number;
    generatedAt: string;
    root: string;
    counts: CodeIntelManifest['counts'] & {
        resolvedCalls: number;
        unresolvedCalls: number;
        resolvedCallRatio: number;
        internalCalls: number;
        externalCalls: number;
        lowValueCalls: number;
        unknownCalls: number;
        projectRelevantCalls: number;
        projectResolvedCallRatio: number;
    };
    unresolvedCallCategories: Array<{
        category: string;
        count: number;
        examples: CodeIntelDiagnosticsExample[];
    }>;
    impact: {
        byKind: Array<{ kind: CodeIntelImpact['kind']; count: number }>;
        topSymbols: Array<{ symbol: string; count: number; fieldReferences: number; risk: CodeIntelImpact['risk'] }>;
        topFields: Array<{ symbol: string; field: string; count: number }>;
    };
    projectUnknownCalls: {
        topReceivers: Array<{ receiver: string; count: number }>;
        topCallers: Array<{ caller: string; count: number }>;
        examples: CodeIntelDiagnosticsExample[];
    };
    proofPackets: {
        largestFlowTargets: Array<{ target: string; param: string; count: number }>;
        largestImpactContracts: Array<{ symbol: string; count: number }>;
        largestCallers: Array<{ caller: string; count: number }>;
        largestBranches: Array<{ functionName: string; condition: string; calls: number; thenTextLength: number; file: string; line: number; column: number }>;
    };
    sidecarFiles?: Array<{ file: string; bytes: number }>;
}
