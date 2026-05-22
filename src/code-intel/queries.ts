import type {
    CodeIntelBranch,
    CodeIntelCall,
    CodeIntelFlow,
    CodeIntelImpact,
    CodeIntelIndex,
    CodeIntelSymbol,
} from './types.js';

export function resolveSymbol(index: CodeIntelIndex, query: string): {
    found: boolean;
    query: string;
    matches: CodeIntelSymbol[];
} {
    const q = query.toLowerCase();
    const exact = index.symbols
        .filter((symbol) => symbol.fqn.toLowerCase() === q || symbol.name.toLowerCase() === q)
        .sort((a, b) => symbolRank(a) - symbolRank(b));
    const fuzzy = index.symbols.filter((symbol) =>
            symbol.fqn.toLowerCase().includes(q) &&
            symbol.fqn.toLowerCase() !== q &&
            symbol.name.toLowerCase() !== q,
        )
        .sort((a, b) => symbolRank(a) - symbolRank(b));
    const matches = exact
        .concat(fuzzy)
        .slice(0, 20);
    return { found: matches.length > 0, query, matches };
}

export function explainDataFlow(index: CodeIntelIndex, args: {
    target: string;
    param: string;
    maxResults?: number;
}): {
    found: boolean;
    target: string;
    param: string;
    flows: CodeIntelFlow[];
} {
    const max = args.maxResults ?? 20;
    const flows = expandDataFlows(index, args.target, args.param, max);
    return { found: flows.length > 0, target: args.target, param: args.param, flows };
}

function expandDataFlows(index: CodeIntelIndex, target: string, param: string, max: number): CodeIntelFlow[] {
    const out: CodeIntelFlow[] = [];
    const seenKeys = new Set<string>();
    const queue: Array<{ target: string; param: string }> = [{ target, param }];
    const seenQueries = new Set<string>();

    while (queue.length > 0 && out.length < max * 2) { // Collect a bit more for ranking
        const current = queue.shift();
        if (!current) break;
        const queryKey = `${current.target}:${current.param}`;
        if (seenQueries.has(queryKey)) continue;
        seenQueries.add(queryKey);

        const direct = index.flows
            .filter((flow) => matchesTarget(flow.target, current.target) && flow.param === current.param);
        for (const flow of direct) {
            if (!seenKeys.has(flow.id)) {
                out.push(flow);
                seenKeys.add(flow.id);
            }
            if (flow.to && flow.toParam && flow.to !== flow.target) {
                queue.push({ target: flow.to, param: flow.toParam });
            }
        }
    }
    return out.sort((a, b) => flowRank(a) - flowRank(b)).slice(0, max);
}

function flowRank(flow: CodeIntelFlow): number {
    if (flow.sinkKind) {
        switch (flow.sinkKind) {
            case 'db': return 0;
            case 'http': return 1;
            case 'msg': return 2;
            case 'job': return 3;
            case 'error': return 4;
            case 'log': return 5;
        }
    }
    switch (flow.sourceKind) {
        case 'http': return 10;
        case 'msg': return 11;
        case 'db': return 12;
        case 'env': return 13;
        case 'config': return 14;
        case 'decorator': return 15;
        case 'param': return 16;
        case 'local': return 20;
        case 'return': return 30;
        case 'call-arg': return 40;
        default: return 100;
    }
}

export function explainBranch(index: CodeIntelIndex, args: { file: string; line: number }): {
    found: boolean;
    file: string;
    line: number;
    branches: CodeIntelBranch[];
} {
    let branches = index.branches.filter((branch) =>
        matchesFile(branch.file, args.file) && branch.line <= args.line && args.line <= branch.line + 2,
    );
    if (branches.length === 0) {
        branches = index.branches
            .filter((branch) => matchesFile(branch.file, args.file))
            .sort((a, b) => Math.abs(a.line - args.line) - Math.abs(b.line - args.line))
            .slice(0, 1)
            .filter((branch) => Math.abs(branch.line - args.line) <= 5);
    }
    return { found: branches.length > 0, file: args.file, line: args.line, branches };
}

export function traceScenario(index: CodeIntelIndex, args: { entry: string; maxDepth?: number }): {
    found: boolean;
    entry: string;
    start?: CodeIntelSymbol;
    calls: CodeIntelCall[];
} {
    const resolved = resolveSymbol(index, args.entry).matches;
    const start = resolved.find((symbol) => symbol.kind === 'method' || symbol.kind === 'function') ?? resolved[0] ??
        index.symbols.find((symbol) =>
            symbol.signature?.includes(args.entry) ||
            symbol.decorators?.some((decorator) => decorator.includes(args.entry)),
        );
    if (!start) return { found: false, entry: args.entry, calls: [] };
    const maxDepth = args.maxDepth ?? 5;
    const calls: CodeIntelCall[] = [];
    const seen = new Set<string>();
    walkCalls(index, start.id, maxDepth, calls, seen, 20);
    return { found: true, entry: args.entry, start, calls };
}

export function impactContract(index: CodeIntelIndex, args: {
    symbol: string;
    field?: string;
    maxResults?: number;
}): {
    found: boolean;
    symbol: string;
    field?: string;
    subject?: CodeIntelSymbol;
    impacts: CodeIntelImpact[];
} {
    const symbol = resolveSymbol(index, args.symbol).matches.find((match) => match.kind === 'dto') ??
        resolveSymbol(index, args.symbol).matches[0];
    if (!symbol) return { found: false, symbol: args.symbol, ...(args.field ? { field: args.field } : {}), impacts: [] };
    const impacts = index.impacts
        .filter((impact) => impact.symbolId === symbol.id && (!args.field || impact.field === args.field || impact.detail.includes(args.field)))
        .sort((a, b) => impactRank(a, Boolean(args.field)) - impactRank(b, Boolean(args.field)) || a.file.localeCompare(b.file) || a.line - b.line)
        .slice(0, args.maxResults ?? 50);
    return {
        found: impacts.length > 0,
        symbol: symbol.fqn,
        subject: symbol,
        ...(args.field ? { field: args.field } : {}),
        impacts,
    };
}

function walkCalls(
    index: CodeIntelIndex,
    callerId: string,
    depthLeft: number,
    out: CodeIntelCall[],
    seen: Set<string>,
    maxCalls: number,
): void {
    if (depthLeft <= 0 || seen.has(callerId) || out.length >= maxCalls) return;
    seen.add(callerId);
    const direct = index.calls
        .filter((call) => call.callerId === callerId && call.calleeId && isTraceRelevantCall(call))
        .sort((a, b) => a.order - b.order);
    for (const call of direct) {
        if (out.length >= maxCalls) return;
        out.push(call);
        if (call.calleeId) walkCalls(index, call.calleeId, depthLeft - 1, out, seen, maxCalls);
    }
}

function isTraceRelevantCall(call: CodeIntelCall): boolean {
    return call.kind === undefined || call.kind === 'internal';
}

function matchesTarget(value: string, target: string): boolean {
    return value === target || value.endsWith(`.${target}`) || value.includes(target);
}

function matchesFile(actual: string, query: string): boolean {
    return actual === query || actual.endsWith(`/${query.replace(/^\.?\//, '')}`);
}

function symbolRank(symbol: CodeIntelSymbol): number {
    switch (symbol.kind) {
        case 'method':
        case 'function':
            return 0;
        case 'class':
        case 'dto':
        case 'type':
            return 1;
        case 'field':
            return 2;
        case 'param':
            return 3;
    }
}

function impactRank(impact: CodeIntelImpact, fieldQuery: boolean): number {
    if (fieldQuery && impact.kind === 'field-reference') return 0;
    switch (impact.kind) {
        case 'endpoint':
        case 'message':
            return 0;
        case 'type-reference':
            return 1;
        case 'mapper':
            return 2;
        case 'test':
            return 3;
        case 'field-reference':
            return 4;
    }
}
