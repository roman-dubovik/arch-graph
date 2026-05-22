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
    agentHint?: string;
} {
    const q = query.toLowerCase();
    const exact = index.symbols
        .filter((symbol) => symbol.fqn.toLowerCase() === q || symbol.name.toLowerCase() === q)
        .sort((a, b) => symbolRank(a) - symbolRank(b));

    const pathMatches = index.symbols
        .filter((symbol) => !exact.includes(symbol) && matchesFile(symbol.file, query))
        .sort((a, b) => symbolRank(a) - symbolRank(b));

    const fuzzy = index.symbols.filter((symbol) =>
            !exact.includes(symbol) &&
            !pathMatches.includes(symbol) &&
            symbol.fqn.toLowerCase().includes(q),
        )
        .sort((a, b) => symbolRank(a) - symbolRank(b));

    const matches = exact
        .concat(pathMatches)
        .concat(fuzzy)
        .slice(0, 20);
    return withHealthWarning(index, { 
        found: matches.length > 0, 
        query, 
        matches,
        agentHint: matches.length > 0 ? "Use 'get_file_outline' with the returned file path to find exact 'line' and 'endLine' ranges for surgical reading." : undefined
    });
}

export function getFileOutline(index: CodeIntelIndex, args: { file: string }): {
    found: boolean;
    file: string;
    symbols: CodeIntelSymbol[];
} {
    const symbols = index.symbols
        .filter((symbol) => matchesFile(symbol.file, args.file))
        .sort((a, b) => (a.line - b.line) || (a.column - b.column));
    return withHealthWarning(index, { found: symbols.length > 0, file: args.file, symbols });
}

export function getBlueprint(index: CodeIntelIndex, args: { kind: string; maxResults?: number }): {
    found: boolean;
    kind: string;
    blueprints: CodeIntelSymbol[];
    patterns: string[];
    compositeGuide?: string;
    agentHint?: string;
} {
    const blueprints = index.symbols
        .filter((symbol) => symbol.kind === args.kind)
        .sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0))
        .slice(0, args.maxResults ?? 3);
    
    // Collect patterns for the kind itself
    const ownPatterns = (index.policies ?? [])
        .filter(p => p.id.includes(`:${args.kind}:`));

    // For container kinds (dto, db-entity, class), also include patterns for their common members
    let memberPatterns: CodeIntelPolicy[] = [];
    if (args.kind === 'dto' || args.kind === 'db-entity' || args.kind === 'class') {
        memberPatterns = (index.policies ?? [])
            .filter(p => p.id.includes(`:field:`) || p.id.includes(`:method:`))
            .filter(p => p.confidence > 0.5);
    }

    const allPatterns = [...ownPatterns, ...memberPatterns];
    const patterns = Array.from(new Set(allPatterns.map(p => p.rule)));

    let compositeGuide: string | undefined;
    if (patterns.length > 0) {
        const topPatterns = allPatterns
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 8)
            .map(p => `- ${p.rule} (${Math.round(p.confidence * 100)}% compliance)`);

        compositeGuide = `### ${args.kind.toUpperCase()} Style Guide (Synthesized from ${index.manifest.counts.symbols} symbols)\n\n` +
            `Based on existing code patterns, an ideal ${args.kind} should follow these conventions:\n\n` +
            topPatterns.join('\n') + '\n\n' +
            `See the blueprints below for full structural reference.`;
    }

    return withHealthWarning(index, { 
        found: blueprints.length > 0 || patterns.length > 0, 
        kind: args.kind, 
        blueprints, 
        patterns,
        compositeGuide,
        agentHint: compositeGuide ? "Follow the 'compositeGuide' and provided blueprints to ensure architectural consistency." : "Follow the code style of the provided blueprints."
    });
}

export function getProjectPolicies(index: CodeIntelIndex): {
    found: boolean;
    policies: CodeIntelPolicy[];
} {
    const policies = index.policies ?? [];
    return withHealthWarning(index, { found: policies.length > 0, policies });
}

export function suggestPlacement(index: CodeIntelIndex, args: { name: string; kind: string }): {
    found: boolean;
    suggestions: Array<{ path: string; confidence: number; reason: string }>;
} {
    const kindSymbols = index.symbols.filter((s) => s.kind === args.kind);
    if (kindSymbols.length === 0) return { found: false, suggestions: [] };

    const placements = new Map<string, number>();
    for (const s of kindSymbols) {
        const dir = s.file.split('/').slice(0, -1).join('/');
        if (dir) placements.set(dir, (placements.get(dir) ?? 0) + 1);
    }

    // Heuristic: try to match domain from name (e.g. UsersService -> users)
    const domainMatch = args.name.match(/^([A-Z][a-z0-9]+)/);
    const domain = domainMatch ? domainMatch[1].toLowerCase() : undefined;

    const suggestions: Array<{ path: string; confidence: number; reason: string }> = [];
    
    if (domain) {
        const domainDirs = Array.from(placements.keys()).filter(d => d.toLowerCase().includes(domain));
        for (const dir of domainDirs) {
            suggestions.push({
                path: `${dir}/${args.name}.ts`,
                confidence: 0.9,
                reason: `Existing ${args.kind} symbols for domain '${domain}' are found in this directory.`
            });
        }
    }

    // Fallback: most common directory for this kind
    const sortedPlacements = Array.from(placements.entries()).sort((a, b) => b[1] - a[1]);
    if (sortedPlacements.length > 0 && suggestions.length === 0) {
        const [dir, count] = sortedPlacements[0];
        suggestions.push({
            path: `${dir}/${args.name}.ts`,
            confidence: count / kindSymbols.length,
            reason: `Most ${args.kind} symbols (${count}) are located here.`
        });
    }

    return withHealthWarning(index, { found: suggestions.length > 0, suggestions });
}

export function getOrientation(index: CodeIntelIndex): {
    projectSummary: string;
    apps: string[];
    libs: string[];
    health: {
        freshness: string;
        coverage: {
            symbols: number;
            calls: number;
        };
    };
    topPolicies: string[];
    agentHint?: string;
} {
    const apps = Array.from(
        new Set(index.symbols.filter((s) => s.file.startsWith('apps/')).map((s) => s.file.split('/')[1])),
    ).sort();

    const libs = Array.from(
        new Set(index.symbols.filter((s) => s.file.startsWith('libs/')).map((s) => s.file.split('/')[1])),
    ).sort();

    const topPolicies = (index.policies ?? [])
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 5)
        .map((p) => p.rule);

    return withHealthWarning(index, {
        projectSummary: `NestJS Monorepo with ${apps.length} apps and ${libs.length} libs.`,
        apps,
        libs,
        health: {
            freshness: index.manifest.builtAt,
            coverage: {
                symbols: index.manifest.counts.symbols,
                calls: index.manifest.counts.calls,
            },
        },
        topPolicies,
        agentHint: "Use 'get_project_policies' for all rules. Use 'get_file_outline' to explore files surgically.",
    });
}

export function validateProposal(index: CodeIntelIndex, proposal: CodeIntelProposal): CodeIntelValidationResult {
    const violations: CodeIntelValidationResult['violations'] = [];

    // 1. Enforce Explicit Guardrails from Policies
    const guardrails = (index.policies ?? []).filter((p) => p.kind === 'guardrail');
    for (const guardrail of guardrails) {
        const parts = guardrail.rule.split('->').map((s) => s.trim());
        if (parts.length !== 2) continue;
        const [sourceMatch, targetMatch] = parts;
        const isForbidden = targetMatch.startsWith('!');
        const targetClean = targetMatch.replace('!', '');

        const sourceMatches =
            proposal.sourceFile.toLowerCase().includes(sourceMatch.toLowerCase()) ||
            proposal.sourceKind.toLowerCase().includes(sourceMatch.toLowerCase());

        if (sourceMatches) {
            for (const imp of proposal.proposedImports) {
                if (imp.toLowerCase().includes(targetClean.toLowerCase()) && isForbidden) {
                    violations.push({
                        rule: guardrail.rule,
                        message: guardrail.description,
                        severity: 'error',
                    });
                }
            }
        }
    }

    // 2. Default Monorepo Boundary Rules
    const isApp = proposal.sourceFile.startsWith('apps/');
    if (isApp) {
        const sourceApp = proposal.sourceFile.split('/')[1];
        for (const imp of proposal.proposedImports) {
            const symbol = index.symbols.find((s) => s.fqn === imp || s.name === imp);
            if (symbol?.file.startsWith('apps/')) {
                const targetApp = symbol.file.split('/')[1];
                if (targetApp !== sourceApp) {
                    violations.push({
                        rule: 'Monorepo Isolation',
                        message: `Cross-app dependency detected: '${sourceApp}' attempted to import from '${targetApp}'. Move shared logic to 'libs/'.`,
                        severity: 'error',
                    });
                }
            }
        }
    }

    return withHealthWarning(index, {
        isValid: violations.length === 0,
        violations,
    });
}

export function selfCheck(index: CodeIntelIndex): CodeIntelHealth {
    const issues: string[] = [];
    const suggestions: string[] = [];
    const now = Date.now();
    // Default to a very old date if builtAt is missing or invalid so it triggers stale warning
    const builtAtTime = index.manifest.builtAt ? new Date(index.manifest.builtAt).getTime() : 0;
    const ageHours = builtAtTime > 0 ? (now - builtAtTime) / (1000 * 60 * 60) : 999;

    const isFresh = ageHours < 24;
    if (!isFresh) {
        issues.push(`Index is stale: built more than 24 hours ago (${Math.round(ageHours)}h).`);
        suggestions.push('Run `arch-graph code-intel build` to refresh the index.');
    }

    let isConsistent = true;
    if (index.symbols.length > 50 && index.calls.length === 0) {
        isConsistent = false;
        issues.push(`Index appears broken: ${index.symbols.length} symbols found but 0 calls recorded.`);
        suggestions.push('Run `arch-graph code-intel build` to attempt a clean rebuild.');
    }

    return {
        isHealthy: isConsistent,
        isFresh,
        issues,
        suggestions,
    };
}

function withHealthWarning<T>(index: CodeIntelIndex, result: T): T & { agentHint?: string } {
    const health = selfCheck(index);
    if (!health.isFresh || !health.isHealthy) {
        const warning = `⚠️ WARNING: ${health.issues.join(' ')} ${health.suggestions.join(' ')}`;
        return { ...result, agentHint: ((result as any).agentHint ? `${(result as any).agentHint} | ` : '') + warning };
    }
    return result;
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
    return withHealthWarning(index, { found: flows.length > 0, target: args.target, param: args.param, flows });
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
    return withHealthWarning(index, { found: branches.length > 0, file: args.file, line: args.line, branches });
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
    if (!start) return withHealthWarning(index, { found: false, entry: args.entry, calls: [] });
    const maxDepth = args.maxDepth ?? 5;
    const calls: CodeIntelCall[] = [];
    const seen = new Set<string>();
    walkCalls(index, start.id, maxDepth, calls, seen, 20);
    return withHealthWarning(index, { found: true, entry: args.entry, start, calls });
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
    if (!symbol) return withHealthWarning(index, { found: false, symbol: args.symbol, ...(args.field ? { field: args.field } : {}), impacts: [] });
    const impacts = index.impacts
        .filter((impact) => impact.symbolId === symbol.id && (!args.field || impact.field === args.field || impact.detail.includes(args.field)))
        .sort((a, b) => impactRank(a, Boolean(args.field)) - impactRank(b, Boolean(args.field)) || a.file.localeCompare(b.file) || a.line - b.line)
        .slice(0, args.maxResults ?? 50);
    return withHealthWarning(index, {
        found: impacts.length > 0,
        symbol: symbol.fqn,
        subject: symbol,
        ...(args.field ? { field: args.field } : {}),
        impacts,
    });
}

function walkCalls(
    index: CodeIntelIndex,
    callerId: string,
    depthLeft: number,
    out: CodeIntelCall[],
    seen: Set<string>,
    maxCalls: number,
    parentConditions: string[] = [],
): void {
    if (depthLeft <= 0 || seen.has(callerId) || out.length >= maxCalls) return;
    seen.add(callerId);
    const direct = index.calls
        .filter((call) => call.callerId === callerId && call.calleeId && isTraceRelevantCall(call))
        .sort((a, b) => a.order - b.order);
    for (const call of direct) {
        if (out.length >= maxCalls) return;
        const conditions = Array.from(new Set([...parentConditions, ...(call.conditions ?? [])]));
        const enrichedCall = { ...call, ...(conditions.length > 0 ? { conditions } : {}) };
        out.push(enrichedCall);
        if (call.calleeId) walkCalls(index, call.calleeId, depthLeft - 1, out, new Set(seen), maxCalls, conditions);
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
