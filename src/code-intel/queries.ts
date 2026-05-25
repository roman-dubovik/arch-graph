import { CODE_INTEL_SCHEMA_VERSION, type CodeIntelBranch, type CodeIntelCall, type CodeIntelFlow, type CodeIntelImpact, type CodeIntelIndex, type CodeIntelSymbol } from './types.js';
import type { ArchGraph } from '../core/types.js';

/**
 * Health verdict for the code-intel sidecar.
 *
 * Semantics (important for callers, including LLMs):
 *
 *   - `status: 'ok'` means the index is COMPLETE and downstream lookups
 *     (`find_references`, `explain_data_flow`, `impact_contract`) are
 *     unambiguous. A non-empty `info.nameCollisions` does NOT degrade
 *     this — it only counts top-level functions/types/params that share
 *     a short name across files (e.g. two modules both exporting
 *     `setup`). For those, the LLM picks the right one by passing a
 *     path suffix to `resolve_symbol` — composite, file-qualified `id`s
 *     do the rest. No silent wrong-answer risk.
 *
 *   - `status: 'degraded'` means the index has REAL problems:
 *       • `warnings.skippedFiles` — extractor could not parse some files,
 *         so the trace/reference graph has missing edges.
 *       • `warnings.dangerousCollisions` — two class members share the
 *         same `<Class>.<method>` / `<Class>.<field>` FQN. Downstream
 *         tools currently pick the first match by rank, which can return
 *         results from the wrong class WITHOUT WARNING. Rename one of
 *         the colliding classes, or use the symbol `id` (file-qualified)
 *         instead of `fqn` for those lookups.
 *       • Manifest envelope malformed — rebuild required.
 *     Run `arch-graph code-intel build` after fixing the underlying cause.
 *
 *   - `info` is purely informational and never gates behaviour; it lets
 *     callers see, for transparency, the volume of harmless omonymy.
 */
export function selfCheck(index: CodeIntelIndex): {
    status: 'ok' | 'degraded' | 'stale' | 'missing';
    message: string;
    schemaVersion: number;
    freshness: string;
    symbols: number;
    warnings?: {
        skippedFiles?: Array<{ file: string; error: string }>;
        dangerousCollisions?: string[];
    };
    info?: {
        nameCollisions: number;
        nameCollisionsSample: string[];
    };
} {
    const symbols = index.manifest.counts?.symbols ?? index.symbols.length;
    const w = index.manifest.warnings;

    // Three states for `warnings`:
    //   (a) absent (legacy index, pre-warnings extractor)   → status='ok'
    //   (b) present and well-formed                         → see logic below
    //   (c) present but malformed (wrong-type fields, etc.) → 'degraded' with a "rebuild recommended" message
    // The distinction between (a) and (c) matters: a corrupt manifest must
    // not masquerade as a healthy legacy one — that was the exact regression
    // FIX-1 introduced, surfaced by silent-failure-hunter round 2.
    if (w !== undefined && (!Array.isArray(w.ambiguousFqns) || !Array.isArray(w.skippedFiles))) {
        return {
            status: 'degraded',
            message: 'Code-intel manifest.warnings is malformed; rebuild recommended (run: arch-graph code-intel build).',
            schemaVersion: index.manifest.schemaVersion,
            freshness: index.manifest.builtAt,
            symbols,
        };
    }

    const amb = w?.ambiguousFqns ?? [];
    const skp = w?.skippedFiles ?? [];

    // Partition collisions by symbol kind. A collision is DANGEROUS (real
    // silent-wrong-answer risk) when ≥2 symbols of a "structural" kind
    // (class member, class itself, DTO, db-entity, type alias / non-DTO
    // interface) share the same FQN. Downstream consumers — getTypeDefinition,
    // impactContract, find_references, explain_data_flow — resolve such
    // names and take the FIRST match by rank, so a duplicate `type Result`
    // or `UsersService.findById` returns data from the wrong file without
    // any warning. Bare-name omonymy of functions or function-params is
    // expected in modular codebases and the LLM is taught (via tool
    // description) to qualify with a path suffix when it matters.
    const DANGEROUS_KINDS = new Set<CodeIntelSymbol['kind']>(['method', 'field', 'class', 'dto', 'db-entity', 'type']);
    // Class-level (structural) kinds always remain dangerous when colliding.
    const CLASS_LEVEL_KINDS = new Set<CodeIntelSymbol['kind']>(['class', 'dto', 'db-entity', 'type']);
    const ambSet = new Set(amb);
    const buckets = new Map<string, CodeIntelSymbol[]>();
    if (amb.length > 0) {
        for (const s of index.symbols) {
            if (!ambSet.has(s.fqn)) continue;
            const b = buckets.get(s.fqn) ?? [];
            b.push(s);
            buckets.set(s.fqn, b);
        }
    }
    const dangerous = amb.filter((fqn) => {
        const bucket = buckets.get(fqn) ?? [];
        const structuralDups = bucket.filter((s) => DANGEROUS_KINDS.has(s.kind));
        if (structuralDups.length <= 1) return false;

        // B8: class-level kinds always stay dangerous
        const hasClassLevelDup = structuralDups.some((s) => CLASS_LEVEL_KINDS.has(s.kind));
        if (hasClassLevelDup) return true;

        // Check delegation-only condition
        const allAreDelegation = structuralDups.every(
            (s) => s.overrideKind === 'delegation' && s.inheritsFrom !== undefined,
        );
        if (!allAreDelegation) return true;

        // All point to the SAME base member?
        const baseIds = new Set(structuralDups.map((s) => s.inheritsFrom));
        if (baseIds.size !== 1) return true;

        return false;
    });

    // Degraded branch: any combination of skipped files + dangerous collisions.
    if (skp.length > 0 || dangerous.length > 0) {
        const parts: string[] = [];
        if (skp.length > 0) parts.push(`${skp.length} file${skp.length === 1 ? '' : 's'} could not be parsed`);
        if (dangerous.length > 0) {
            parts.push(
                `${dangerous.length} structural-name collision${dangerous.length === 1 ? '' : 's'} (two classes/types/DTOs share a name — downstream tools may pick the wrong one silently)`,
            );
        }
        const warnings: { skippedFiles?: typeof skp; dangerousCollisions?: string[] } = {};
        if (skp.length > 0) warnings.skippedFiles = skp;
        if (dangerous.length > 0) warnings.dangerousCollisions = dangerous;
        const info = amb.length > dangerous.length
            ? { nameCollisions: amb.length, nameCollisionsSample: amb.slice(0, 5) }
            : undefined;
        return {
            status: 'degraded',
            message:
                `Code-intel index is degraded: ${parts.join('; ')}. ` +
                (dangerous.length > 0
                    ? 'For structural-name collisions, use the symbol `id` (file-qualified) when looking up specific bodies, or rename one of the duplicates. '
                    : '') +
                'Run: arch-graph code-intel build after fixing.',
            schemaVersion: index.manifest.schemaVersion,
            freshness: index.manifest.builtAt,
            symbols,
            warnings,
            ...(info ? { info } : {}),
        };
    }

    if (amb.length > 0) {
        return {
            status: 'ok',
            message: `Code-intel index is operational. ${amb.length} short-name collision${amb.length === 1 ? '' : 's'} (top-level functions/types with the same name in different files) — normal omonymy; pass a path suffix to resolve_symbol if uncertain which file to target.`,
            schemaVersion: index.manifest.schemaVersion,
            freshness: index.manifest.builtAt,
            symbols,
            info: { nameCollisions: amb.length, nameCollisionsSample: amb.slice(0, 5) },
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

    return {
        projectSummary: `NestJS monorepo with ${apps.size} apps and ${libs.size} libs.`,
        freshness: index.manifest.builtAt,
        symbols: index.manifest.counts?.symbols ?? symbols.length,
        topPolicies,
        agentHint: "Use 'get_project_policies' for the full list of architectural conventions.",
    };
}

export function resolveSymbol(index: CodeIntelIndex, query: string): {
    query: string;
    matches: (CodeIntelSymbol & { note?: string })[];
} {
    const rawMatches = index.symbols
        .filter((s) => matchesTarget(s.fqn, query) || matchesTarget(s.name, query) || matchesFile(s.file, query))
        .sort((a, b) => {
            // B1: rank real impls before delegation wrappers
            const da = a.overrideKind === 'delegation' ? 1 : 0;
            const db = b.overrideKind === 'delegation' ? 1 : 0;
            if (da !== db) return da - db;
            return symbolRank(a) - symbolRank(b) || a.fqn.length - query.length;
        })
        .slice(0, 10);

    // B1: Attach delegation note (use a copy, never mutate original)
    const matches = rawMatches.map((s) => {
        if (s.overrideKind === 'delegation' && s.inheritsFrom) {
            return { ...s, note: `decorator wrapper, delegates to ${s.inheritsFrom}` };
        }
        return s;
    });

    return { query, matches };
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

    return { file: args.file, symbols };
}

export function getTypeDefinition(index: CodeIntelIndex, args: { symbol: string }): {
    found: boolean;
    symbol?: CodeIntelSymbol;
    members: Array<{ kind: string; name: string; type?: string; description?: string; decorators?: string[]; inheritedFrom?: string; overrideKind?: string }>;
    inheritedMembers?: Array<{ kind: string; name: string; type?: string; description?: string; decorators?: string[]; inheritedFrom: string }>;
    /** F12: true when the chain walk was cut short because a class id was not
     *  found in the index (as opposed to a chain that reached its natural end
     *  with extendsClass === undefined). */
    chainTruncated?: boolean;
} {
    const resolved = resolveSymbol(index, args.symbol).matches;
    const symbol = resolved.find((s) => s.kind === 'class' || s.kind === 'dto' || s.kind === 'type' || s.kind === 'db-entity') ?? resolved[0];
    if (!symbol) return { found: false, members: [] };

    // Own members (direct children)
    const ownMemberSymbols = index.symbols
        .filter((s) => s.parentId === symbol.id)
        .sort((a, b) => a.line - b.line);

    const members = ownMemberSymbols.map((s) => ({
        kind: s.kind,
        name: s.name,
        type: s.type,
        description: s.description,
        decorators: s.decorators,
        // B2: annotate overridden members with heritage info
        ...(s.inheritsFrom !== undefined ? { inheritedFrom: s.inheritsFrom } : {}),
        ...(s.overrideKind !== undefined ? { overrideKind: s.overrideKind } : {}),
    }));

    // B2: Collect inherited members by climbing the extendsClass chain
    const inheritedMembers: Array<{ kind: string; name: string; type?: string; description?: string; decorators?: string[]; inheritedFrom: string }> = [];
    const ownMemberNames = new Set(ownMemberSymbols.map((s) => s.name));

    const symbolsById = new Map<string, CodeIntelSymbol>();
    for (const s of index.symbols) {
        symbolsById.set(s.id, s);
    }

    let currentClassId: string | undefined = symbol.extendsClass;
    const visitedClassIds = new Set<string>();
    let chainTruncated = false;
    while (currentClassId && !visitedClassIds.has(currentClassId)) {
        visitedClassIds.add(currentClassId);
        const baseClass = symbolsById.get(currentClassId);
        if (!baseClass) {
            // F12: loop exited because the class id was not found — chain truncated.
            chainTruncated = true;
            break;
        }

        const baseMembers = index.symbols.filter((s) => s.parentId === baseClass.id);
        for (const bm of baseMembers) {
            if (!ownMemberNames.has(bm.name)) {
                inheritedMembers.push({
                    kind: bm.kind,
                    name: bm.name,
                    type: bm.type,
                    description: bm.description,
                    decorators: bm.decorators,
                    inheritedFrom: baseClass.id,
                });
                ownMemberNames.add(bm.name);
            }
        }

        currentClassId = baseClass.extendsClass;
    }

    // F12/G5: if the loop exited because of a visited cycle (not !baseClass), also mark truncated.
    if (!chainTruncated && currentClassId && visitedClassIds.has(currentClassId)) {
        chainTruncated = true;
    }

    return { found: true, symbol, members, inheritedMembers, ...(chainTruncated ? { chainTruncated } : {}) };
}

export function findReferences(index: CodeIntelIndex, args: { symbol: string; maxResults?: number }): {
    query: string;
    symbol?: CodeIntelSymbol;
    references: Array<{ kind: 'call' | 'impact' | 'flow'; file: string; line: number; context: string }>;
    viaDelegation?: boolean;
} {
    const resolved = resolveSymbol(index, args.symbol).matches[0];
    if (!resolved) return { query: args.symbol, references: [] };

    const references: Array<{ kind: 'call' | 'impact' | 'flow'; file: string; line: number; context: string }> = [];

    // 1. Calls (includes super-call edges — B3)
    index.calls.filter((c) => c.calleeId === resolved.id).forEach((c) => {
        references.push({ kind: 'call', file: c.file, line: c.line, context: c.expression });
    });

    // B3: Surface routing sites from delegation-wrapper subclasses
    const delegationWrappers = index.symbols.filter(
        (s) => s.inheritsFrom === resolved.id && s.overrideKind === 'delegation',
    );
    for (const wrapper of delegationWrappers) {
        const decorators = wrapper.decorators ?? [];
        if (decorators.length > 0) {
            references.push({ kind: 'call', file: wrapper.file, line: wrapper.line, context: `${wrapper.fqn} [${decorators.join(', ')}]` });
        } else {
            references.push({ kind: 'call', file: wrapper.file, line: wrapper.line, context: wrapper.fqn });
        }
    }

    // 2. Impacts (type references, DTO usages)
    index.impacts.filter((i) => i.symbolId === resolved.id).forEach((i) => {
        references.push({ kind: 'impact', file: i.file, line: i.line, context: i.detail });
    });

    // 3. Flows (where a parameter flows to/from this symbol)
    index.flows.filter((f) => f.targetId === resolved.id).forEach((f) => {
        references.push({ kind: 'flow', file: f.file, line: f.line, context: `Flow via ${f.via}` });
    });

    const result: ReturnType<typeof findReferences> = {
        query: args.symbol,
        symbol: resolved,
        references: references.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line).slice(0, args.maxResults ?? 50),
    };

    // B4: Flag delegation wrappers
    if (resolved.overrideKind === 'delegation') {
        result.viaDelegation = true;
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
    follows?: Array<{ from: string; to: string; via: string }>;
} {
    const resolved = resolveSymbol(index, args.target).matches.find((s) => s.kind === 'method' || s.kind === 'function');
    if (!resolved) return { found: false, target: args.target, param: args.param, flows: [] };

    const flows = index.flows
        .filter((f) => f.targetId === resolved.id && f.param === args.param)
        .sort((a, b) => (sinkRank(a.sinkKind) - sinkRank(b.sinkKind)) || a.line - b.line)
        .slice(0, args.maxResults ?? 10);

    const follows: Array<{ from: string; to: string; via: string }> = [];
    for (const flow of flows) {
        if (flow.to) {
            const superCallEdge = index.calls.find(
                (c) => c.callerId === resolved.id && c.kind === 'super-call' && (c.callee === flow.to || c.calleeId === flow.to),
            );
            if (superCallEdge) {
                follows.push({ from: resolved.fqn, to: flow.to, via: superCallEdge.expression });
            } else if (flow.via && flow.via.includes('super')) {
                follows.push({ from: resolved.fqn, to: flow.to, via: flow.via });
            }
        }
    }

    return {
        found: flows.length > 0,
        target: resolved.fqn,
        param: args.param,
        flows,
        ...(follows.length > 0 ? { follows } : {}),
    };
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
    return { found: branches.length > 0, branches };
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
        return { found: false, reason, entry: args.entry, calls: [], exceptions: [] };
    }
    const maxDepth = args.maxDepth ?? 5;
    const calls: CodeIntelCall[] = [];
    const exceptions: Array<{ condition: string; file: string; line: number; depth: number }> = [];
    const seen = new Set<string>();
    walkScenario(index, start.id, maxDepth, 0, calls, exceptions, seen, 40);
    return { found: true, entry: args.entry, start, calls, exceptions };
}

export function traceExceptions(index: CodeIntelIndex, args: { entry: string }): {
    found: boolean;
    entry: string;
    throws: Array<{ type: string; file: string; line: number; path: string[] }>;
} {
    const scenario = traceScenario(index, { entry: args.entry, maxDepth: 10 });
    if (!scenario.found) return { found: false, entry: args.entry, throws: [] };

    const throws = scenario.exceptions.map((ex) => ({
        type: ex.condition.replace(/^throw\s+/, ''),
        file: ex.file,
        line: ex.line,
        path: [args.entry, `...depth:${ex.depth}`, ex.condition],
    }));

    return { found: true, entry: args.entry, throws };
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

    return { pattern, publishers, subscribers };
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
        return {
            found: false,
            reason: 'symbol-not-found' as const,
            symbol: args.symbol,
            ...(args.field ? { field: args.field } : {}),
            impacts: [],
        };
    }
    const directImpacts = index.impacts
        .filter((impact) => impact.symbolId === symbol.id && (!args.field || impact.field === args.field || impact.detail.includes(args.field)))
        .sort((a, b) => impactRank(a, Boolean(args.field)) - impactRank(b, Boolean(args.field)) || a.file.localeCompare(b.file) || a.line - b.line);

    // B7: Synthetic impacts for delegation subclasses
    const syntheticImpacts: CodeIntelImpact[] = [];
    const symbolsById = new Map<string, CodeIntelSymbol>();
    for (const s of index.symbols) {
        symbolsById.set(s.id, s);
    }

    for (const directImpact of directImpacts) {
        const delegationWrappers = index.symbols.filter((s) => {
            if (s.overrideKind !== 'delegation' || !s.inheritsFrom) return false;
            const baseMethod = symbolsById.get(s.inheritsFrom);
            if (!baseMethod) return false;
            // F8: word-boundary match to avoid prefix collisions
            // (e.g. "FooBase.runner(dto)" must NOT match for fqn "FooBase.run").
            const fqn = baseMethod.fqn;
            const detail = directImpact.detail;
            return detail === fqn
                || detail.startsWith(fqn + '(')
                || detail.includes(' ' + fqn + '(')
                || detail.includes(' ' + fqn + ' ');
        });

        for (const wrapper of delegationWrappers) {
            const detail = `${wrapper.fqn}(dto: ${symbol.fqn}) [via delegation]`;
            syntheticImpacts.push({
                id: `synthetic:${directImpact.id}:${wrapper.id}`,
                symbolId: symbol.id,
                symbol: symbol.fqn,
                kind: directImpact.kind,
                detail,
                risk: directImpact.risk,
                file: wrapper.file,
                line: wrapper.line,
                column: wrapper.column ?? 1,
            });
        }
    }

    const impacts = [...directImpacts, ...syntheticImpacts]
        .slice(0, args.maxResults ?? 50);
    const found = impacts.length > 0;
    // Always include `subject` so the caller can see what we resolved, even
    // when impacts is empty. `reason` disambiguates "no field with that
    // name on the DTO" from "this DTO has no impacts at all".
    return {
        found,
        ...(found ? {} : args.field ? { reason: 'no-impacts-for-field' as const } : { reason: 'no-impacts' as const }),
        symbol: symbol.fqn,
        subject: symbol,
        ...(args.field ? { field: args.field } : {}),
        impacts,
    };
}

export function getProjectPolicies(index: CodeIntelIndex): {
    policies: CodeIntelIndex['policies'];
} {
    return { policies: index.policies ?? [] };
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

    return { kind, compositeGuide, patterns, topExamples: examples };
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
    return { name: args.name, kind, suggestions };
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

    return { valid: violations.length === 0, violations };
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
    // B5: allow super-call edges so traceScenario follows inheritance chains
    return call.kind === undefined || call.kind === 'internal' || call.kind === 'super-call';
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
