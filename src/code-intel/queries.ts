import { CODE_INTEL_SCHEMA_VERSION, type CodeIntelBranch, type CodeIntelCall, type CodeIntelFlow, type CodeIntelImpact, type CodeIntelIndex, type CodeIntelSymbol } from './types.js';
import type { ArchGraph } from '../core/types.js';

/**
 * Envelope wrapper kept for forward-compatible JIT health/warning signal.
 * The manifest currently exposes no health field; this is a no-op pass-through
 * that preserves call-sites while we decide whether to wire health at build.
 */
function withHealthWarning<T>(_index: CodeIntelIndex, data: T): T {
    return data;
}

export function selfCheck(index: CodeIntelIndex): {
    status: 'ok' | 'degraded' | 'stale' | 'missing';
    message: string;
    schemaVersion: number;
    freshness: string;
    symbols: number;
    warnings?: {
        ambiguousFqns: string[];
        skippedFiles: Array<{ file: string; error: string }>;
    };
} {
    const symbols = index.manifest.counts?.symbols ?? index.symbols.length;
    const w = index.manifest.warnings;
    const amb = Array.isArray(w?.ambiguousFqns) ? w!.ambiguousFqns : [];
    const skp = Array.isArray(w?.skippedFiles) ? w!.skippedFiles : [];
    if (amb.length > 0 || skp.length > 0) {
        const parts: string[] = [];
        if (amb.length > 0) parts.push(`${amb.length} ambiguous FQNs`);
        if (skp.length > 0) parts.push(`${skp.length} skipped files`);
        return {
            status: 'degraded',
            message: `Code-intel index is degraded: ${parts.join(', ')}.`,
            schemaVersion: index.manifest.schemaVersion,
            freshness: index.manifest.builtAt,
            symbols,
            warnings: { ambiguousFqns: amb, skippedFiles: skp },
        };
    }
    return {
        status: 'ok',
        message: 'Code-intel index is operational.',
        schemaVersion: index.manifest.schemaVersion,
        freshness: index.manifest.builtAt,
        symbols,
    };
}

export function getOrientation(index: CodeIntelIndex): {
    projectSummary: string;
    freshness: string;
    symbols: number;
    topPolicies: string[];
    agentHint: string;
} {
    const symbols = index.symbols;
    const apps = new Set<string>();
    const libs = new Set<string>();
    for (const s of symbols) {
        const match = s.file.match(/^(apps|libs)\/([^/]+)\//);
        if (match) {
            if (match[1] === 'apps') apps.add(match[2]);
            else libs.add(match[2]);
        }
    }

    const topPolicies = index.policies
        ?.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
        .slice(0, 3)
        .map((p) => p.rule) ?? [];

    return withHealthWarning(index, {
        projectSummary: `NestJS monorepo with ${apps.size} apps and ${libs.size} libs.`,
        freshness: index.manifest.builtAt,
        symbols: index.manifest.counts?.symbols ?? symbols.length,
        topPolicies,
        agentHint: "Use 'get_project_policies' for the full list of architectural conventions.",
    });
}

export function resolveSymbol(index: CodeIntelIndex, query: string): {
    query: string;
    matches: CodeIntelSymbol[];
} {
    const matches = index.symbols
        .filter((s) => matchesTarget(s.fqn, query) || matchesTarget(s.name, query) || matchesFile(s.file, query))
        .sort((a, b) => symbolRank(a) - symbolRank(b) || a.fqn.length - query.length)
        .slice(0, 10);

    return withHealthWarning(index, { query, matches });
}

export function getFileOutline(index: CodeIntelIndex, args: { file: string }): {
    file: string;
    symbols: Array<{ kind: string; name: string; fqn: string; line: number; endLine?: number }>;
} {
    const symbols = index.symbols
        .filter((s) => matchesFile(s.file, args.file))
        .sort((a, b) => a.line - b.line)
        .map((s) => ({
            kind: s.kind,
            name: s.name,
            fqn: s.fqn,
            line: s.line,
            endLine: s.endLine,
        }));

    return withHealthWarning(index, { file: args.file, symbols });
}

export function getTypeDefinition(index: CodeIntelIndex, args: { symbol: string }): {
    found: boolean;
    symbol?: CodeIntelSymbol;
    members: Array<{ kind: string; name: string; type?: string; description?: string; decorators?: string[] }>;
} {
    const resolved = resolveSymbol(index, args.symbol).matches;
    const symbol = resolved.find((s) => s.kind === 'class' || s.kind === 'dto' || s.kind === 'type' || s.kind === 'db-entity') ?? resolved[0];
    if (!symbol) return withHealthWarning(index, { found: false, members: [] });

    const members = index.symbols
        .filter((s) => s.parentId === symbol.id)
        .sort((a, b) => a.line - b.line)
        .map((s) => ({
            kind: s.kind,
            name: s.name,
            type: s.type,
            description: s.description,
            decorators: s.decorators,
        }));

    return withHealthWarning(index, { found: true, symbol, members });
}

export function findReferences(index: CodeIntelIndex, args: { symbol: string; maxResults?: number }): {
    query: string;
    symbol?: CodeIntelSymbol;
    references: Array<{ kind: 'call' | 'impact' | 'flow'; file: string; line: number; context: string }>;
} {
    const resolved = resolveSymbol(index, args.symbol).matches[0];
    if (!resolved) return withHealthWarning(index, { query: args.symbol, references: [] });

    const references: Array<{ kind: 'call' | 'impact' | 'flow'; file: string; line: number; context: string }> = [];

    // 1. Calls (where a method is called)
    index.calls.filter((c) => c.calleeId === resolved.id).forEach((c) => {
        references.push({ kind: 'call', file: c.file, line: c.line, context: c.expression });
    });

    // 2. Impacts (type references, DTO usages)
    index.impacts.filter((i) => i.symbolId === resolved.id).forEach((i) => {
        references.push({ kind: 'impact', file: i.file, line: i.line, context: i.detail });
    });

    // 3. Flows (where a parameter flows to/from this symbol)
    index.flows.filter((f) => f.targetId === resolved.id).forEach((f) => {
        references.push({ kind: 'flow', file: f.file, line: f.line, context: `Flow via ${f.via}` });
    });

    return withHealthWarning(index, {
        query: args.symbol,
        symbol: resolved,
        references: references.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line).slice(0, args.maxResults ?? 50),
    });
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
    const resolved = resolveSymbol(index, args.target).matches.find((s) => s.kind === 'method' || s.kind === 'function');
    if (!resolved) return withHealthWarning(index, { found: false, target: args.target, param: args.param, flows: [] });

    const flows = index.flows
        .filter((f) => f.targetId === resolved.id && f.param === args.param)
        .sort((a, b) => (sinkRank(a.sinkKind) - sinkRank(b.sinkKind)) || a.line - b.line)
        .slice(0, args.maxResults ?? 10);

    return withHealthWarning(index, { found: flows.length > 0, target: resolved.fqn, param: args.param, flows });
}

export function explainBranch(index: CodeIntelIndex, args: { file: string; line: number }): {
    found: boolean;
    branches: CodeIntelBranch[];
} {
    // Fuzzy ±2 line window so an agent pointing at the function declaration or
    // a line off-by-one from the actual predicate still gets useful results.
    const branches = index.branches
        .filter((b) => matchesFile(b.file, args.file) && Math.abs(b.line - args.line) <= 2)
        .sort((a, b) => Math.abs(a.line - args.line) - Math.abs(b.line - args.line));
    return withHealthWarning(index, { found: branches.length > 0, branches });
}

export function traceScenario(index: CodeIntelIndex, args: { entry: string; maxDepth?: number }): {
    found: boolean;
    reason?: 'entry-not-found' | 'entry-not-callable';
    entry: string;
    start?: CodeIntelSymbol;
    calls: CodeIntelCall[];
    exceptions: Array<{ condition: string; file: string; line: number; depth: number }>;
} {
    const resolved = resolveSymbol(index, args.entry).matches;
    // Prefer method/function; if none match by name, only then fall back to
    // signature/decorator text lookup. Never accept a param/field as `start`
    // since walkScenario would silently produce an empty trace with found:true.
    const callableMatch = resolved.find((symbol) => symbol.kind === 'method' || symbol.kind === 'function');
    const decoratorMatch = !callableMatch ? index.symbols.find((symbol) =>
        (symbol.kind === 'method' || symbol.kind === 'function') && (
            symbol.signature?.includes(args.entry) ||
            symbol.decorators?.some((decorator) => decorator.includes(args.entry))
        ),
    ) : undefined;
    const start = callableMatch ?? decoratorMatch;
    if (!start) {
        const reason = resolved.length === 0 ? ('entry-not-found' as const) : ('entry-not-callable' as const);
        return withHealthWarning(index, { found: false, reason, entry: args.entry, calls: [], exceptions: [] });
    }
    const maxDepth = args.maxDepth ?? 5;
    const calls: CodeIntelCall[] = [];
    const exceptions: Array<{ condition: string; file: string; line: number; depth: number }> = [];
    const seen = new Set<string>();
    walkScenario(index, start.id, maxDepth, 0, calls, exceptions, seen, 40);
    return withHealthWarning(index, { found: true, entry: args.entry, start, calls, exceptions });
}

export function traceExceptions(index: CodeIntelIndex, args: { entry: string }): {
    found: boolean;
    entry: string;
    throws: Array<{ type: string; file: string; line: number; path: string[] }>;
} {
    const scenario = traceScenario(index, { entry: args.entry, maxDepth: 10 });
    if (!scenario.found) return withHealthWarning(index, { found: false, entry: args.entry, throws: [] });

    const throws = scenario.exceptions.map((ex) => ({
        type: ex.condition.replace(/^throw\s+/, ''),
        file: ex.file,
        line: ex.line,
        path: [args.entry, `...depth:${ex.depth}`, ex.condition],
    }));

    return withHealthWarning(index, { found: true, entry: args.entry, throws });
}

export function traceMessageFlow(index: CodeIntelIndex, graph: ArchGraph, pattern: string): {
    pattern: string;
    publishers: Array<{ service: string; method: string; file: string; line: number }>;
    subscribers: Array<{ service: string; handler: string; file: string; line: number; trace: ReturnType<typeof traceScenario> }>;
} {
    const publishers: Array<{ service: string; method: string; file: string; line: number }> = [];
    const subscribers: Array<{ service: string; handler: string; file: string; line: number; trace: ReturnType<typeof traceScenario> }> = [];

    // Find publishers/producers and subscribers/consumers in the structural graph.
    // Edge kinds map: nats-publish/nats-request → publishers, nats-subscribe/nats-reply/rmq-subscribe → subscribers,
    // queue-produce → publishers, queue-consume → subscribers.
    const PUBLISH_KINDS = new Set(['nats-publish', 'nats-request', 'queue-produce']);
    const SUBSCRIBE_KINDS = new Set(['nats-subscribe', 'nats-reply', 'rmq-subscribe', 'queue-consume']);
    for (const edge of graph.edges) {
        if (PUBLISH_KINDS.has(edge.kind) && (edge.to.includes(pattern) || pattern.includes(edge.to.replace(/nats:|queue:/, '')))) {
            publishers.push({
                service: edge.from,
                method: (edge.meta as Record<string, unknown> | undefined)?.method as string ?? 'unknown',
                file: edge.file ?? '',
                line: edge.line ?? 0,
            });
        }
        if (SUBSCRIBE_KINDS.has(edge.kind) && (edge.from.includes(pattern) || pattern.includes(edge.from.replace(/nats:|queue:/, '')))) {
            const handlerFqn = (edge.meta as Record<string, unknown> | undefined)?.handler as string ?? edge.to;
            subscribers.push({
                service: edge.to,
                handler: handlerFqn,
                file: edge.file ?? '',
                line: edge.line ?? 0,
                trace: traceScenario(index, { entry: handlerFqn }),
            });
        }
    }

    return withHealthWarning(index, { pattern, publishers, subscribers });
}

export function impactContract(index: CodeIntelIndex, args: {
    symbol: string;
    field?: string;
    maxResults?: number;
}): {
    found: boolean;
    reason?: 'symbol-not-found' | 'no-impacts-for-field' | 'no-impacts';
    symbol: string;
    field?: string;
    subject?: CodeIntelSymbol;
    impacts: CodeIntelImpact[];
} {
    const resolved = resolveSymbol(index, args.symbol).matches;
    const symbol = resolved.find((match) => match.kind === 'dto' || match.kind === 'db-entity' || match.kind === 'type') ??
        resolved[0];
    if (!symbol) {
        return withHealthWarning(index, {
            found: false,
            reason: 'symbol-not-found' as const,
            symbol: args.symbol,
            ...(args.field ? { field: args.field } : {}),
            impacts: [],
        });
    }
    const impacts = index.impacts
        .filter((impact) => impact.symbolId === symbol.id && (!args.field || impact.field === args.field || impact.detail.includes(args.field)))
        .sort((a, b) => impactRank(a, Boolean(args.field)) - impactRank(b, Boolean(args.field)) || a.file.localeCompare(b.file) || a.line - b.line)
        .slice(0, args.maxResults ?? 50);
    const found = impacts.length > 0;
    // Always include `subject` so the caller can see what we resolved, even
    // when impacts is empty. `reason` disambiguates "no field with that
    // name on the DTO" from "this DTO has no impacts at all".
    return withHealthWarning(index, {
        found,
        ...(found ? {} : args.field ? { reason: 'no-impacts-for-field' as const } : { reason: 'no-impacts' as const }),
        symbol: symbol.fqn,
        subject: symbol,
        ...(args.field ? { field: args.field } : {}),
        impacts,
    });
}

export function getProjectPolicies(index: CodeIntelIndex): {
    policies: CodeIntelIndex['policies'];
} {
    return withHealthWarning(index, { policies: index.policies ?? [] });
}

export function getBlueprint(index: CodeIntelIndex, args: { kind: string; maxResults?: number }): {
    kind: string;
    compositeGuide: string;
    patterns: string[];
    topExamples: CodeIntelSymbol[];
} {
    const kind = args.kind.toLowerCase() as any;
    const examples = index.symbols
        .filter((s) => s.kind === kind)
        .sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0))
        .slice(0, args.maxResults ?? 3);

    const patterns = index.policies
        ?.filter((p) => p.id.includes(`:${kind}:`))
        .map((p) => p.rule) ?? [];

    let compositeGuide = `Standard ${kind} implementation pattern.`;
    if (patterns.length > 0) {
        compositeGuide = `Follow these project-wide patterns: ${patterns.join(', ')}.`;
    }
    if (examples.length > 0) {
        compositeGuide += ` Reference highest-quality implementation: ${examples[0]!.file}:${examples[0]!.line}.`;
    }

    return withHealthWarning(index, { kind, compositeGuide, patterns, topExamples: examples });
}

export function suggestPlacement(index: CodeIntelIndex, args: { name: string; kind: string }): {
    name: string;
    kind: string;
    suggestions: Array<{ path: string; reason: string }>;
} {
    const kind = args.kind.toLowerCase() as any;
    const policies = index.policies?.filter((p) => p.kind === 'placement' && p.id.includes(`:${kind}:`)) ?? [];
    const suggestions = policies.map((p) => ({
        path: p.rule.split(': ')[1] ?? 'src/',
        reason: p.description ?? 'Existing pattern.',
    }));
    if (suggestions.length === 0) {
        suggestions.push({ path: 'src/', reason: 'No specific pattern found, using root src/.' });
    }
    return withHealthWarning(index, { name: args.name, kind, suggestions });
}

export function validateProposal(index: CodeIntelIndex, args: {
    sourceFile: string;
    sourceKind: string;
    proposedImports: string[];
    proposedCalls: string[];
}): {
    valid: boolean;
    violations: Array<{ rule: string; message: string; severity: 'error' | 'warning' }>;
} {
    const violations: Array<{ rule: string; message: string; severity: 'error' | 'warning' }> = [];
    const kind = args.sourceKind.toLowerCase();

    if (kind === 'controller') {
        for (const imp of args.proposedImports) {
            if (imp.toLowerCase().includes('repository')) {
                violations.push({
                    rule: 'Layer Violation',
                    message: `Controller should not import Repository: ${imp}. Route through a Service instead.`,
                    severity: 'error',
                });
            }
        }
    }

    return withHealthWarning(index, { valid: violations.length === 0, violations });
}

function walkScenario(
    index: CodeIntelIndex,
    callerId: string,
    depthLeft: number,
    currentDepth: number,
    outCalls: CodeIntelCall[],
    outExceptions: Array<{ condition: string; file: string; line: number; depth: number }>,
    seen: Set<string>,
    maxTotal: number,
    parentConditions: string[] = [],
): void {
    if (depthLeft <= 0 || seen.has(callerId) || outCalls.length >= maxTotal) return;
    seen.add(callerId);

    // 1. Collect calls
    const directCalls = index.calls
        .filter((call) => call.callerId === callerId && isTraceRelevantCall(call))
        .sort((a, b) => a.order - b.order);

    // 2. Collect abnormal exits (throws) from this function
    const localExits = index.branches
        .filter((b) => b.functionId === callerId && (b.condition.startsWith('throw') || b.condition.startsWith('return')))
        .map((b) => ({ condition: b.condition, file: b.file, line: b.line, depth: currentDepth }));
    outExceptions.push(...localExits);

    for (const call of directCalls) {
        if (outCalls.length >= maxTotal) return;
        const conditions = Array.from(new Set([...parentConditions, ...(call.conditions ?? [])]));
        const enrichedCall = { ...call, ...(conditions.length > 0 ? { conditions } : {}) };
        outCalls.push(enrichedCall);
        if (call.calleeId) {
            walkScenario(index, call.calleeId, depthLeft - 1, currentDepth + 1, outCalls, outExceptions, new Set(seen), maxTotal, conditions);
        }
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
        case 'db-entity':
        case 'type':
            return 1;
        case 'field':
            return 2;
        case 'param':
            return 3;
    }
}

function sinkRank(kind: CodeIntelFlow['sinkKind']): number {
    switch (kind) {
        case 'db': return 0;
        case 'msg': return 1;
        case 'http': return 2;
        case 'job': return 3;
        case 'log': return 4;
        default: return 5;
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
