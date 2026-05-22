/**
 * MCP stdio server exposing arch-graph as queryable tools.
 *
 * The server reads `graph.json` from the configured `out` directory at startup
 * and reloads it on each tool call when the file's mtime changes — so callers
 * can rebuild the graph in another shell without restarting the server.
 *
 * All tool answers are token-minimal: only the relevant subset of nodes/edges
 * is returned, never the full graph.
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import type { ArchGraph, EdgeKind, NodeKind } from '../core/types.js';
import { NODE_KIND_VALUES } from '../core/types.js';
import {
    explain,
    findPath,
    findPublishers,
    findQueueConsumers,
    findQueueProducers,
    findSubscribers,
    graphStats,
    moduleImports,
    serviceDependencies,
    serviceDependents,
    tableUsers,
} from './graph-queries.js';
import { semanticSearch, MAX_TOP_K } from '../semantic/search.js';
import { makeEmbedder } from '../semantic/embedder.js';
import { readEmbeddingsJsonl } from '../semantic/io.js';
import type { SemanticModelAlias } from '../semantic/types.js';
import { defaultModelAlias, resolveMinScore } from '../semantic/types.js';
import { applySemanticDefaults, loadConfig } from '../core/config.js';
import { readCodeIntelIndex } from '../code-intel/io.js';
import {
    explainBranch,
    explainDataFlow,
    getFileOutline,
    impactContract,
    resolveSymbol,
    traceScenario,
} from '../code-intel/queries.js';

const SERVER_NAME = 'arch-graph';
const SERVER_VERSION = '0.1.0';

// Exhaustiveness gate: `Record<EdgeKind, null>` forces TS to error here when
// a new `EdgeKind` is added to `src/core/types.ts` but not listed below. Casts
// (`as [EdgeKind, ...EdgeKind[]]`) silently lose this guarantee — the Record
// form makes the contract structural.
const EDGE_KIND_CHECK: Record<EdgeKind, null> = {
    'nats-publish': null,
    'nats-request': null,
    'nats-subscribe': null,
    'nats-reply': null,
    'rmq-subscribe': null,
    'http-call': null,
    'http-external': null,
    'queue-produce': null,
    'queue-consume': null,
    'db-read': null,
    'db-write': null,
    'db-access': null,
    'db-relation': null,
    'di-import': null,
    'di-provides': null,
    'di-exports': null,
    'di-controller': null,
    'di-uses': null,
    'di-guard': null,
    'di-interceptor': null,
    'di-pipe': null,
    'ts-import': null,
    'lib-usage': null,
    'fe-imports': null,
    'fe-renders': null,
    'fe-routes-to': null,
    'endpoint-of': null,
    'endpoint-calls': null,
    'config-read-by': null,
    'entity-has-field': null,
    'scoped': null,
    'cron-triggers': null,
    'queue-fails-into': null,
    'queue-event-listener': null,
    'queue-repeat': null,
};
const EDGE_KIND_VALUES = Object.keys(EDGE_KIND_CHECK) as [EdgeKind, ...EdgeKind[]];

const edgeKindSchema = z.enum(EDGE_KIND_VALUES);

// NODE_KIND_VALUES is imported from src/core/types.ts — the authoritative home
// for NodeKind exhaustiveness. Centralised so CLI + MCP always share the same set.
const nodeKindSchema = z.enum(NODE_KIND_VALUES);

/**
 * Zod shape for the `semantic_search` tool input — exported so tests can build
 * `z.object(semanticSearchInputShape)` and validate against the exact same
 * constraints that the registered MCP tool enforces.  Avoids schema drift.
 */
export const semanticSearchInputShape = {
    query: z.string().min(1).describe('Query text to search for.'),
    topK: z
        .number()
        .int()
        .min(1)
        .max(MAX_TOP_K)
        .optional()
        .default(10)
        .describe(`Number of results to return (1-${MAX_TOP_K}, default 10).`),
    kinds: z
        .array(nodeKindSchema)
        .optional()
        .describe('Optional filter: only return nodes of these NodeKind values.'),
    excludeKinds: z
        .array(nodeKindSchema)
        .optional()
        .describe(
            'Optional blacklist: drop nodes of these NodeKind values from results. ' +
                'Applied after `kinds` (exclude wins over include).',
        ),
    includeVectors: z
        .boolean()
        .optional()
        .default(false)
        .describe('If true, include the embedding vector for each result.'),
    minScore: z
        .number()
        .min(-1)
        .max(1)
        .optional()
        .describe(
            'Minimum cosine similarity threshold. Results below this value are dropped. ' +
            'When omitted, the per-model recommended threshold is used (e.g. 0.30 for minilm, 0.55 for e5-base).',
        ),
    kindQuotas: z
        .partialRecord(nodeKindSchema, z.number().int().min(0).max(MAX_TOP_K))
        .optional()
        .describe('Optional per-kind result caps, e.g. {"service": 3, "doc-section": 2}.'),
    kindBoosts: z
        .partialRecord(nodeKindSchema, z.number().min(0).max(10))
        .optional()
        .describe('Optional per-kind ranking multipliers, e.g. {"db-table": 1.5}.'),
} as const;

const bucketSearchInputShape = {
    query: semanticSearchInputShape.query,
    topK: semanticSearchInputShape.topK,
    includeVectors: semanticSearchInputShape.includeVectors,
    minScore: semanticSearchInputShape.minScore,
    kindQuotas: semanticSearchInputShape.kindQuotas,
    kindBoosts: semanticSearchInputShape.kindBoosts,
} as const;

/**
 * `code_search` exposes the same shape as `semantic_search` minus `kinds` /
 * `excludeKinds` — those are wired internally to exclude doc-section. Keeping
 * the other ranking controls makes the agent-facing contract identical and
 * eliminates a class of "I forgot to add the kind filter" mistakes.
 */
export const codeSearchInputShape = bucketSearchInputShape;

/**
 * `docs_search` — same shape as `code_search`, internally restricted to
 * `doc-section` results.  Symmetric with `code_search` so an agent picks one
 * or the other without learning two different schemas.
 */
export const docsSearchInputShape = codeSearchInputShape;

export const resolveSymbolInputShape = {
    query: z.string().min(1).describe('Symbol name, partial path, or FQN.'),
} as const;

export const getFileOutlineInputShape = {
    file: z.string().min(1).describe('Source file path (relative to root).'),
} as const;

export const explainDataFlowInputShape = {
    target: z.string().min(1).describe('Function or method FQN, e.g. ItemsController.create.'),
    param: z.string().min(1).describe('Parameter name inside the target function.'),
    maxResults: z.number().int().min(1).max(100).optional().default(20),
} as const;

export const explainBranchInputShape = {
    file: z.string().min(1).describe('Absolute or graph-recorded source file path.'),
    line: z.number().int().positive().describe('Line inside or near the branch condition.'),
} as const;

export const traceScenarioInputShape = {
    entry: z.string().min(1).describe('Entrypoint symbol/decorator text, e.g. Controller.method or POST /path.'),
    maxDepth: z.number().int().min(1).max(20).optional().default(5),
} as const;

export const impactContractInputShape = {
    symbol: z.string().min(1).describe('DTO/type symbol name, e.g. CreateItemDto.'),
    field: z.string().min(1).optional().describe('Optional field name to narrow impact.'),
    maxResults: z.number().int().min(1).max(200).optional().default(50),
} as const;

interface GraphHandle {
    path: string;
    mtimeMs: number;
    graph: ArchGraph;
}

async function loadGraph(path: string, mtimeMs: number): Promise<GraphHandle> {
    const buf = await readFile(path, 'utf8');
    const graph = JSON.parse(buf) as ArchGraph;
    return { path, mtimeMs, graph };
}

/**
 * Returns a cached graph, reloading lazily if `graph.json` changed on disk.
 *
 * Robustness: stat and load are split so a mid-write torn JSON (`JSON.parse`
 * throws on a partial file) does NOT silently keep serving the old cached
 * graph forever. We track the mtime that failed; subsequent ticks at the same
 * mtime suppress the retry log but still continue serving cached data. On the
 * next *successful* write the mtime advances, we retry, and `failedMtime`
 * clears.
 */
function makeGraphLoader(path: string): () => Promise<ArchGraph> {
    let handle: GraphHandle | null = null;
    let failedMtime: number | null = null;
    return async () => {
        try {
            const st = await stat(path);
            if (!handle || st.mtimeMs !== handle.mtimeMs) {
                if (st.mtimeMs === failedMtime) {
                    // Same broken mtime as last attempt. If we have a previous
                    // good handle, keep serving it silently (we already logged
                    // once). If not, surface a useful error — the defensive
                    // assertion below would otherwise hide the real cause.
                    if (!handle) {
                        throw new Error(
                            `arch-graph mcp: graph file is unreadable at ${path} (last reload error already logged to stderr)`,
                        );
                    }
                } else {
                    try {
                        handle = await loadGraph(path, st.mtimeMs);
                        failedMtime = null;
                    } catch (loadErr) {
                        failedMtime = st.mtimeMs;
                        process.stderr.write(
                            `arch-graph mcp: reload error (corrupt write?): ${(loadErr as Error).message}\n`,
                        );
                        if (!handle) throw loadErr;
                    }
                }
            }
        } catch (err) {
            // If stat fails but we have a cached copy, keep serving it.
            if (!handle) throw err;
        }
        if (!handle) {
            // Reachable on the second+ call against a consistently corrupt
            // file: stat succeeds, mtime equals failedMtime, the silent retry
            // suppression keeps handle null, and the outer catch does NOT
            // fire (stat didn't throw). This guard converts that into a clear
            // error rather than a downstream `undefined.graph` access.
            throw new Error('arch-graph mcp: graph loader returned no handle');
        }
        return handle.graph;
    };
}

function makeCodeIntelLoader(outDir: string) {
    let cached: Awaited<ReturnType<typeof readCodeIntelIndex>> | null = null;
    return async () => {
        if (!cached) cached = await readCodeIntelIndex(resolve(outDir, 'code-intel'));
        return cached;
    };
}

/** Wrap a JSON-able result in the MCP `content` envelope. */
function jsonResult(data: unknown): {
    content: Array<{ type: 'text'; text: string }>;
    structuredContent?: Record<string, unknown>;
} {
    const text = JSON.stringify(data);
    const out: {
        content: Array<{ type: 'text'; text: string }>;
        structuredContent?: Record<string, unknown>;
    } = {
        content: [{ type: 'text', text }],
    };
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        out.structuredContent = data as Record<string, unknown>;
    } else {
        out.structuredContent = { result: data };
    }
    return out;
}

// ---------------------------------------------------------------------------
// Keyword router for the natural-language `query` fallback.
// ---------------------------------------------------------------------------

type RoutedAction =
    | { tool: 'subject_publishers'; subject: string }
    | { tool: 'subject_subscribers'; subject: string }
    | { tool: 'queue_producers'; queue: string }
    | { tool: 'queue_consumers'; queue: string }
    | { tool: 'service_dependencies'; serviceId: string }
    | { tool: 'service_dependents'; serviceId: string }
    | { tool: 'module_imports'; moduleClass: string }
    | { tool: 'table_users'; table: string }
    | { tool: 'stats' }
    | { tool: 'unknown'; hint: string };

function routeQuestion(question: string): RoutedAction {
    const q = question.toLowerCase();
    // Try to extract a quoted or trailing token that looks like an identifier.
    const quoted = question.match(/['"`]([^'"`]+)['"`]/);
    const lastToken = question.split(/\s+/).pop() ?? '';

    const target = quoted?.[1] ?? lastToken;
    if (q.includes('stat')) return { tool: 'stats' };
    if (q.includes('subject') || q.includes('nats')) {
        if (q.includes('publish') || q.includes('producer') || q.includes('sender')) {
            return { tool: 'subject_publishers', subject: target };
        }
        if (q.includes('subscribe') || q.includes('consumer') || q.includes('handler') || q.includes('listener')) {
            return { tool: 'subject_subscribers', subject: target };
        }
    }
    if (q.includes('queue') || q.includes('bullmq')) {
        if (q.includes('produce') || q.includes('publisher') || q.includes('sender')) {
            return { tool: 'queue_producers', queue: target };
        }
        if (q.includes('consume') || q.includes('processor') || q.includes('worker')) {
            return { tool: 'queue_consumers', queue: target };
        }
    }
    if (q.includes('table') || q.includes('database') || q.includes('db ')) {
        return { tool: 'table_users', table: target };
    }
    if (q.includes('module') && (q.includes('import') || q.includes('depend'))) {
        return { tool: 'module_imports', moduleClass: target };
    }
    // Order matters: the "incoming" wording is more specific and must win over
    // the generic "depend" check (e.g. "depended on by", "used by").
    if (q.includes('depended') || q.includes('callers') || q.includes('used by') || q.includes('calls')) {
        return { tool: 'service_dependents', serviceId: target };
    }
    if (q.includes('depend on') || q.includes('depends on') || q.includes('uses') || q.includes('use')) {
        return { tool: 'service_dependencies', serviceId: target };
    }
    return {
        tool: 'unknown',
        hint: 'I could not route the question. Try a structured tool like subject_publishers, queue_consumers, service_dependencies, table_users, etc.',
    };
}

// ---------------------------------------------------------------------------
// Server construction.
// ---------------------------------------------------------------------------

export async function startMcpServer(opts: { out: string; config?: string }): Promise<void> {
    const graphPath = resolve(opts.out, 'graph.json');
    const loadGraphFn = makeGraphLoader(graphPath);
    const loadCodeIntelFn = makeCodeIntelLoader(opts.out);
    // Eager load so startup errors surface immediately on stderr instead of on first tool call.
    await loadGraphFn();

    // Resolve the embedding model alias from the config file (if supplied), falling back to
    // the defaultModelAlias ('e5-base') when no config is present.
    let resolvedModelAlias: SemanticModelAlias = defaultModelAlias;
    if (opts.config) {
        try {
            const cfg = await loadConfig(resolve(opts.config));
            resolvedModelAlias = applySemanticDefaults(cfg.semantic).model;
        } catch (err) {
            // Silently keep the defaultModelAlias ONLY when the config file is
            // absent.  Any other error (syntax error, invalid alias such as
            // 'bge-m4') must surface immediately so the operator knows their
            // config is broken rather than silently running on the wrong model.
            const isConfigMissing =
                err instanceof Error && err.message.startsWith('config not found:');
            if (!isConfigMissing) throw err;
        }
    }

    // Build a single-text embedder bound to the resolved alias.
    // Query mode: the user query string must use the query prefix for e5-base.
    const resolvedEmbedderObj = makeEmbedder(resolvedModelAlias);
    const embedOneFn = async (text: string): Promise<number[]> =>
        resolvedEmbedderObj.embedOne(text, 'query');

    const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { capabilities: { tools: {} } },
    );

    server.registerTool(
        'subject_publishers',
        {
            description: 'Services or libs that publish/request on a NATS subject (wildcards supported).',
            inputSchema: { subject: z.string().describe('Subject name or pattern; `nats:` prefix optional.') },
        },
        async ({ subject }) => jsonResult(findPublishers(await loadGraphFn(), subject)),
    );

    server.registerTool(
        'subject_subscribers',
        {
            description: 'Services or libs that subscribe / reply on a NATS subject (wildcards supported).',
            inputSchema: { subject: z.string() },
        },
        async ({ subject }) => jsonResult(findSubscribers(await loadGraphFn(), subject)),
    );

    server.registerTool(
        'queue_producers',
        {
            description: 'Services that inject the BullMQ queue (producers).',
            inputSchema: { queue: z.string().describe('Queue name; `queue:` prefix optional.') },
        },
        async ({ queue }) => jsonResult(findQueueProducers(await loadGraphFn(), queue)),
    );

    server.registerTool(
        'queue_consumers',
        {
            description: 'Services with an `@Processor` for the BullMQ queue (consumers).',
            inputSchema: { queue: z.string() },
        },
        async ({ queue }) => jsonResult(findQueueConsumers(await loadGraphFn(), queue)),
    );

    server.registerTool(
        'service_dependencies',
        {
            description:
                'Outgoing edges from a service, grouped by kind (nats-publish, http-call, queue-produce, db-access, lib-usage, …).',
            inputSchema: { serviceId: z.string().describe('Service id; `service:` prefix optional.') },
        },
        async ({ serviceId }) => jsonResult(serviceDependencies(await loadGraphFn(), serviceId)),
    );

    server.registerTool(
        'service_dependents',
        {
            description: 'Incoming edges into a service — who calls/uses this service.',
            inputSchema: { serviceId: z.string() },
        },
        async ({ serviceId }) => jsonResult(serviceDependents(await loadGraphFn(), serviceId)),
    );

    server.registerTool(
        'module_imports',
        {
            description: 'Recursive DI-import chain for a NestJS module class (depth-limited, cycle-safe).',
            inputSchema: {
                moduleClass: z.string().describe('Module class name; `module:` prefix optional.'),
                maxDepth: z.number().int().positive().max(20).optional(),
            },
        },
        async ({ moduleClass, maxDepth }) =>
            jsonResult(moduleImports(await loadGraphFn(), moduleClass, maxDepth ?? 5)),
    );

    server.registerTool(
        'table_users',
        {
            description: 'Services that read or write the DB table (any `db-*` edge).',
            inputSchema: { table: z.string().describe('Table name; `db-table:` prefix optional.') },
        },
        async ({ table }) => jsonResult(tableUsers(await loadGraphFn(), table)),
    );

    server.registerTool(
        'path',
        {
            description:
                'Shortest directed path between two node ids; returns `{ found: false }` when none under the filter.',
            inputSchema: {
                from: z.string().describe('Source node id (must include prefix, e.g. service:foo).'),
                to: z.string().describe('Target node id (must include prefix).'),
                kindFilter: z.array(edgeKindSchema).optional(),
            },
        },
        async ({ from, to, kindFilter }) => jsonResult(findPath(await loadGraphFn(), from, to, kindFilter)),
    );

    server.registerTool(
        'explain',
        {
            description: 'Node details + first-degree neighbours grouped by edge kind.',
            inputSchema: { nodeId: z.string().describe('Full node id including prefix.') },
        },
        async ({ nodeId }) => jsonResult(explain(await loadGraphFn(), nodeId)),
    );

    server.registerTool(
        'semantic_search',
        {
            description:
                'Semantic kNN search over the sidecar index across ALL node kinds (code + docs mixed). ' +
                'Use `code_search` / `docs_search` instead when you want one bucket — those avoid doc-section dilution of code results.',
            inputSchema: semanticSearchInputShape,
        },
        // Reuse the exported handler factory so the test-accessible path and the
        // production registration share exactly the same logic.
        makeSemanticSearchHandler({ outDir: opts.out, embedder: embedOneFn, modelAlias: resolvedModelAlias }),
    );

    server.registerTool(
        'code_search',
        {
            description:
                'Semantic kNN search restricted to CODE nodes (everything except doc-section). ' +
                'Use for "where is X implemented" — top-K is not diluted by Markdown sections. ' +
                'RECOMMENDED USAGE: call code_search and docs_search in parallel for every retrieval — ' +
                'the LLM then sees two labeled top-K lists and picks the more useful one (both-buckets pattern). ' +
                'Projects that want to halve retrieval cost can override to fallback-only in their CLAUDE.md ' +
                '("first code_search; only call docs_search if nothing relevant").',
            inputSchema: codeSearchInputShape,
        },
        makeSemanticSearchHandler({ outDir: opts.out, embedder: embedOneFn, modelAlias: resolvedModelAlias, baseExcludeKinds: ['doc-section'] }),
    );

    server.registerTool(
        'docs_search',
        {
            description:
                'Semantic kNN search restricted to DOC nodes (Markdown `doc-section` only). ' +
                'Use for design rationale, plans, README/ADR content, natural-language explanations. ' +
                'Docs may contain stale plans or speculative content — pair with code_search when the question is ' +
                '"what does the code actually do" (the code is authoritative). ' +
                'RECOMMENDED USAGE: call together with code_search in parallel — see code_search description.',
            inputSchema: docsSearchInputShape,
        },
        makeSemanticSearchHandler({ outDir: opts.out, embedder: embedOneFn, modelAlias: resolvedModelAlias, lockedKinds: ['doc-section'] }),
    );

    server.registerTool(
        'query',
        {
            description:
                'Natural-language fallback. Keyword-routes to a structured tool and returns its result; no LLM dependency.',
            inputSchema: { question: z.string() },
        },
        async ({ question }) => {
            const action = routeQuestion(question);
            const graph = await loadGraphFn();
            switch (action.tool) {
                case 'subject_publishers':
                    return jsonResult({ via: action.tool, result: findPublishers(graph, action.subject) });
                case 'subject_subscribers':
                    return jsonResult({ via: action.tool, result: findSubscribers(graph, action.subject) });
                case 'queue_producers':
                    return jsonResult({ via: action.tool, result: findQueueProducers(graph, action.queue) });
                case 'queue_consumers':
                    return jsonResult({ via: action.tool, result: findQueueConsumers(graph, action.queue) });
                case 'service_dependencies':
                    return jsonResult({ via: action.tool, result: serviceDependencies(graph, action.serviceId) });
                case 'service_dependents':
                    return jsonResult({ via: action.tool, result: serviceDependents(graph, action.serviceId) });
                case 'module_imports':
                    return jsonResult({
                        via: action.tool,
                        result: moduleImports(graph, action.moduleClass),
                    });
                case 'table_users':
                    return jsonResult({ via: action.tool, result: tableUsers(graph, action.table) });
                case 'stats':
                    return jsonResult({ via: action.tool, result: graphStats(graph) });
                case 'unknown':
                    return jsonResult({ via: 'unknown', hint: action.hint });
                // Exhaustiveness guard: if a new RoutedAction['tool'] variant is added without
                // a case here, the `const _: never = action` will fail compile. Not dead code —
                // reachable only when the union grows. The runtime fallback returns 'unknown'
                // for forward-compat with older clients.
                default: {
                    const _: never = action;
                    return jsonResult({ via: 'unknown', hint: 'unrouted action' });
                }
            }
        },
    );

    server.registerTool(
        'resolve_symbol',
        {
            description: 'Code intelligence lookup for classes, DTOs, methods, functions, fields, and params. Supports fuzzy path matching.',
            inputSchema: resolveSymbolInputShape,
        },
        async ({ query }) => jsonResult(resolveSymbol(await loadCodeIntelFn(), query)),
    );

    server.registerTool(
        'get_file_outline',
        {
            description: 'Structural summary of a file (classes, methods, fields) without implementation details.',
            inputSchema: getFileOutlineInputShape,
        },
        async ({ file }) => jsonResult(getFileOutline(await loadCodeIntelFn(), { file })),
    );

    server.registerTool(
        'explain_data_flow',
        {
            description: 'Compact proof packet for where a parameter flows inside a target function/method.',
            inputSchema: explainDataFlowInputShape,
        },
        async ({ target, param, maxResults }) =>
            jsonResult(explainDataFlow(await loadCodeIntelFn(), { target, param, maxResults })),
    );

    server.registerTool(
        'explain_branch',
        {
            description: 'Branch predicate and dominated calls for a file/line location.',
            inputSchema: explainBranchInputShape,
        },
        async ({ file, line }) => jsonResult(explainBranch(await loadCodeIntelFn(), { file, line })),
    );

    server.registerTool(
        'trace_scenario',
        {
            description: 'Ordered static call trace from a symbol/decorator entrypoint, depth-limited.',
            inputSchema: traceScenarioInputShape,
        },
        async ({ entry, maxDepth }) => jsonResult(traceScenario(await loadCodeIntelFn(), { entry, maxDepth })),
    );

    server.registerTool(
        'impact_contract',
        {
            description: 'DTO/type impact report grouped from endpoint/message/type/test/mapper references.',
            inputSchema: impactContractInputShape,
        },
        async ({ symbol, field, maxResults }) =>
            jsonResult(impactContract(await loadCodeIntelFn(), { symbol, field, maxResults })),
    );

    server.registerTool(
        'stats',
        {
            description: 'Overall node/edge counts by kind plus build timestamp.',
            inputSchema: {},
        },
        async () => jsonResult(graphStats(await loadGraphFn())),
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Note: keep the process alive until stdin closes — `connect()` wires that up.
}

// Exported for test use — the keyword router is also a pure function and
// worth exercising directly without round-tripping through the SDK.
export { routeQuestion };

// ---------------------------------------------------------------------------
// Exported handler factory — lets tests exercise the exact same logic as the
// registered MCP tool without wiring the SDK transport.
// ---------------------------------------------------------------------------

export interface SemanticSearchHandlerOpts {
    /** Directory where arch-graph-out lives (contains graph.json + semantic/). */
    outDir: string;
    /**
     * Injectable single-text embedder.  In production this is derived from
     * `makeEmbedder(modelAlias)`.  Tests supply a fake here to avoid real model
     * downloads.  When omitted, the factory builds a default embedder bound to
     * `modelAlias` (defaults to `defaultModelAlias`, currently `'e5-base'`).
     *
     * **Coupling invariant**: `embedder` must produce vectors whose dimensionality
     * matches the alias registered in `SEMANTIC_MODELS[modelAlias].dim`.  Passing
     * a mismatched embedder (wrong dim) with a different `modelAlias` will
     * cause every search to return `semantic-index-corrupt`.  Always set both
     * fields together or omit both (production wires them from the same config
     * lookup; tests use a matching fake).
     */
    embedder?: (text: string) => Promise<number[]>;
    /**
     * Model alias that was used to build the index.  Passed to `semanticSearch`
     * so it can validate the manifest's model/dim against the expected values.
     * Defaults to `defaultModelAlias` (`'e5-base'`) when omitted.
     *
     * **Must be set together with `embedder`** when overriding either (see
     * `embedder` coupling invariant above).  Production callers resolve this
     * from config via `applySemanticDefaults`.
     */
    modelAlias?: SemanticModelAlias;
    /**
     * Locks the handler to this kind-whitelist. Authoritative — overrides any
     * `kinds` passed in the caller input (and a runtime assert fires if the
     * caller tries — see implementation). Used by `docs_search` to pin the
     * tool to `doc-section`.
     *
     * The field name encodes the override semantics: this is a *lock*, not
     * an additive default.
     */
    lockedKinds?: NodeKind[];
    /**
     * Base `excludeKinds` blacklist always applied by this handler. Unlike
     * `lockedKinds`, this is *additive* — caller-supplied `excludeKinds` are
     * appended to this list, so callers can drop MORE kinds but never restore
     * any of these. Used by `code_search` to always exclude `doc-section`.
     */
    baseExcludeKinds?: NodeKind[];
}

export interface SemanticSearchHandlerInput {
    query: string;
    topK?: number;
    /**
     * Caller-supplied `kinds` whitelist. Ignored when the handler was
     * factory-constructed with `lockedKinds`; in that case the handler
     * throws to prevent silent override of the locked bucket.
     */
    kinds?: NodeKind[];
    /**
     * Caller-supplied `excludeKinds` blacklist. Merged additively with
     * `baseExcludeKinds` if the handler factory set one.
     */
    excludeKinds?: NodeKind[];
    includeVectors?: boolean;
    /**
     * Caller-supplied minimum cosine similarity threshold.
     * When provided, overrides the per-model `recommendedMinScore`.
     * When absent, the handler resolves via {@link resolveMinScore}
     * using the factory-bound `modelAlias`.
     */
    minScore?: number;
    kindQuotas?: Partial<Record<NodeKind, number>>;
    kindBoosts?: Partial<Record<NodeKind, number>>;
}

/**
 * Create the `semantic_search` MCP handler as a standalone async function.
 * This is the canonical handler logic — `startMcpServer` calls
 * `server.registerTool(…, handler)` using the same code path.
 *
 * Use this in tests to exercise the full handler (including vector augmentation
 * and error paths) without spinning up the MCP SDK transport.
 */
export function makeSemanticSearchHandler(handlerOpts: SemanticSearchHandlerOpts) {
    const {
        outDir,
        embedder: embedderFn,
        modelAlias = defaultModelAlias,
        lockedKinds,
        baseExcludeKinds,
    } = handlerOpts;

    // Default single-text embedder: bound to the resolved alias so production
    // and test paths share the same lazy-loading path.  Tests that supply their
    // own `embedder` override this entirely.
    // Query mode: the user query string must use the query prefix for e5-base.
    const effectiveEmbedder =
        embedderFn ??
        (() => {
            const e = makeEmbedder(modelAlias);
            return async (text: string): Promise<number[]> => e.embedOne(text, 'query');
        })();

    return async (input: SemanticSearchHandlerInput) => {
        const {
            query,
            topK = 10,
            kinds,
            excludeKinds,
            includeVectors = false,
            minScore: userMinScore,
            kindQuotas,
            kindBoosts,
        } = input;

        // Factory `lockedKinds` is authoritative. If the caller tries to pass
        // `kinds`, that would be a silent contract violation in production —
        // throw so it surfaces during development. (The MCP Zod boundary
        // strips this field for external callers, so in practice this guards
        // in-process consumers like tests and embedders.)
        if (lockedKinds && kinds && kinds.length > 0) {
            throw new Error(
                `arch-graph semantic_search: handler was constructed with lockedKinds=[${lockedKinds.join(
                    ',',
                )}]; caller-supplied 'kinds' is not permitted on locked handlers.`,
            );
        }

        // Factory `baseExcludeKinds` is additive — caller can extend, never reduce.
        const effectiveKinds = lockedKinds ?? kinds;
        const effectiveExclude =
            baseExcludeKinds && excludeKinds
                ? [...baseExcludeKinds, ...excludeKinds]
                : (baseExcludeKinds ?? excludeKinds);

        // Resolve minScore: user value wins; else per-model recommended; else 0.30 fallback.
        const effectiveMinScore = resolveMinScore(modelAlias, userMinScore);

        const searchRes = await semanticSearch({
            query,
            outDir,
            embedder: effectiveEmbedder,
            modelAlias,
            topK,
            kinds: effectiveKinds,
            excludeKinds: effectiveExclude,
            minScore: effectiveMinScore,
            kindQuotas,
            kindBoosts,
        });

        const output = searchRes.output;

        if (includeVectors && output.results.length > 0 && !output.error) {
            const embeddingsPath = `${outDir}/semantic/embeddings.jsonl`;
            const resultNodeIds = new Set(output.results.map((r) => r.nodeId));

            try {
                for await (const record of readEmbeddingsJsonl(embeddingsPath, output.dim)) {
                    const result = output.results.find((r) => r.nodeId === record.nodeId);
                    if (result && resultNodeIds.has(record.nodeId)) {
                        result.vector = record.vector;
                    }
                }
            } catch (vecErr) {
                const vecErrMsg = vecErr instanceof Error ? vecErr.message : String(vecErr);
                process.stderr.write(`[arch-graph semantic] vector augmentation read error: ${vecErrMsg}\n`);
                output.vectorsError = `read-error: ${vecErrMsg}`;
            }
        }

        return jsonResult(output);
    };
}
