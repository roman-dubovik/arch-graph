/**
 * MCP stdio server exposing arch-graph as queryable tools.
 *
 * The server reads `graph.json` from the configured `out` directory at startup
 * and reloads it on each tool call when the file's mtime changes — so callers
 * can rebuild the graph in another shell without restarting the server. The
 * same lazy-mtime-reload model applies to the code-intel sidecar via
 * `makeCodeIntelLoader`.
 *
 * All tool answers are token-minimal: only the relevant subset of nodes/edges
 * is returned, never the full graph.
 */

import { stat } from 'node:fs/promises';
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
import { loadGraph } from '../core/io.js';
import { semanticSearch, MAX_TOP_K } from '../semantic/search.js';
import { makeEmbedder } from '../semantic/embedder.js';
import { readEmbeddingsJsonl } from '../semantic/io.js';
import type { SemanticModelAlias } from '../semantic/types.js';
import { defaultModelAlias, resolveMinScore } from '../semantic/types.js';
import { applySemanticDefaults, loadConfig } from '../core/config.js';
import { readCodeIntelIndex } from '../code-intel/io.js';
import type { CodeIntelIndex } from '../code-intel/types.js';
import {
    explainBranch,
    explainDataFlow,
    findReferences,
    getBlueprint,
    getFileOutline,
    getOrientation,
    getProjectPolicies,
    getTypeDefinition,
    impactContract,
    resolveSymbol,
    selfCheck,
    suggestPlacement,
    traceExceptions,
    traceMessageFlow,
    traceScenario,
    validateProposal,
} from '../code-intel/queries.js';

const SERVER_NAME = 'arch-graph';
const SERVER_VERSION = '0.1.0';

// Exhaustiveness gate: `Record<EdgeKind, null>` forces TS to error here when
// a new `EdgeKind` is added to `src/core/types.ts` but not listed below.
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
const nodeKindSchema = z.enum(NODE_KIND_VALUES);

/**
 * Zod shape for the `semantic_search` tool input — exported so tests can build
 * `z.object(semanticSearchInputShape)` and validate against the exact same
 * constraints that the registered MCP tool enforces. Avoids schema drift.
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
            'When omitted, the per-model recommended threshold is used (e.g. 0.55 for e5-base).',
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

export const codeSearchInputShape = bucketSearchInputShape;
export const docsSearchInputShape = codeSearchInputShape;

export const resolveSymbolInputShape = {
    query: z.string().min(1).describe('Symbol name, partial path, or FQN.'),
} as const;

export const getFileOutlineInputShape = {
    file: z.string().min(1).describe('Source file path (relative to root).'),
} as const;

export const getTypeDefinitionInputShape = {
    symbol: z.string().min(1).describe('Class, DTO, type, or db-entity name.'),
} as const;

export const findReferencesInputShape = {
    symbol: z.string().min(1).describe('Symbol name or FQN to find references to.'),
    maxResults: z.number().int().min(1).max(200).optional().default(50),
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

export const traceExceptionsInputShape = {
    entry: z.string().min(1).describe('Entrypoint method/function FQN to walk for throw statements.'),
} as const;

export const traceMessageFlowInputShape = {
    pattern: z.string().min(1).describe('NATS subject or RMQ queue name (with or without prefix).'),
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

async function loadGraphHandle(path: string, mtimeMs: number): Promise<GraphHandle> {
    return { path, mtimeMs, graph: await loadGraph(path) };
}

/**
 * Returns a cached graph, reloading lazily if `graph.json` changed on disk.
 *
 * Robustness: stat and load are split so a mid-write torn JSON (`JSON.parse`
 * throws on a partial file) does NOT silently keep serving the old cached
 * graph forever. We track the mtime that failed; subsequent ticks at the same
 * mtime suppress the retry log but still continue serving cached data.
 */
function makeGraphLoader(path: string): () => Promise<ArchGraph> {
    let handle: GraphHandle | null = null;
    let failedMtime: number | null = null;
    return async () => {
        try {
            const st = await stat(path);
            if (!handle || st.mtimeMs !== handle.mtimeMs) {
                if (st.mtimeMs === failedMtime) {
                    if (!handle) {
                        throw new Error(
                            `arch-graph mcp: graph file is unreadable at ${path} (last reload error already logged to stderr)`,
                        );
                    }
                } else {
                    try {
                        handle = await loadGraphHandle(path, st.mtimeMs);
                        failedMtime = null;
                    } catch (loadErr) {
                        failedMtime = st.mtimeMs;
                        process.stderr.write(
                            `arch-graph mcp: graph reload error (corrupt write?): ${(loadErr as Error).message}\n`,
                        );
                        if (!handle) throw loadErr;
                    }
                }
            }
        } catch (err) {
            if (!handle) throw err;
        }
        if (!handle) {
            throw new Error('arch-graph mcp: graph loader returned no handle');
        }
        return handle.graph;
    };
}

interface CodeIntelHandle {
    mtimeMs: number;
    index: CodeIntelIndex;
}

/**
 * Code-intel sidecar loader with mtime-based reload and torn-write tolerance
 * (P1.3 acceptance: keep serving the last good index if a mid-write rebuild
 * leaves manifest temporarily unreadable).
 */
function makeCodeIntelLoader(outDir: string): () => Promise<CodeIntelIndex> {
    const dir = resolve(outDir, 'code-intel');
    const manifestPath = resolve(dir, 'manifest.json');
    let handle: CodeIntelHandle | null = null;
    let failedMtime: number | null = null;
    return async () => {
        try {
            const st = await stat(manifestPath);
            if (!handle || st.mtimeMs !== handle.mtimeMs) {
                if (st.mtimeMs === failedMtime) {
                    if (!handle) {
                        throw new Error(
                            `arch-graph mcp: code-intel sidecar at ${dir} is unreadable (last reload error already logged to stderr)`,
                        );
                    }
                } else {
                    try {
                        const index = await readCodeIntelIndex(dir);
                        handle = { mtimeMs: st.mtimeMs, index };
                        failedMtime = null;
                    } catch (loadErr) {
                        failedMtime = st.mtimeMs;
                        process.stderr.write(
                            `arch-graph mcp: code-intel reload error (corrupt write?): ${(loadErr as Error).message}\n`,
                        );
                        if (!handle) throw loadErr;
                    }
                }
            }
        } catch (err) {
            if (!handle) throw err;
        }
        if (!handle) {
            throw new Error('arch-graph mcp: code-intel loader returned no handle');
        }
        return handle.index;
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
    await loadGraphFn();

    let resolvedModelAlias: SemanticModelAlias = defaultModelAlias;
    if (opts.config) {
        try {
            const cfg = await loadConfig(resolve(opts.config));
            resolvedModelAlias = applySemanticDefaults(cfg.semantic).model;
        } catch (err) {
            const isConfigMissing =
                err instanceof Error && err.message.startsWith('config not found:');
            if (!isConfigMissing) throw err;
        }
    }

    const resolvedEmbedderObj = makeEmbedder(resolvedModelAlias);
    const embedOneFn = async (text: string): Promise<number[]> =>
        resolvedEmbedderObj.embedOne(text, 'query');

    const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { capabilities: { tools: {} } },
    );

    // ─────────────────────────────────────────── STRUCTURAL GRAPH TOOLS
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
            description: 'Outgoing edges from a service, grouped by kind (nats-publish, http-call, queue-produce, db-access, lib-usage, …).',
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
            description: 'Shortest directed path between two node ids; returns `{ found: false }` when none under the filter.',
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

    // ─────────────────────────────────────────── SEMANTIC SEARCH TOOLS
    server.registerTool(
        'semantic_search',
        {
            description:
                'Semantic kNN search over the sidecar index across ALL node kinds (code + docs mixed). ' +
                'Use `code_search` / `docs_search` instead when you want one bucket — those avoid doc-section dilution.',
            inputSchema: semanticSearchInputShape,
        },
        makeSemanticSearchHandler({ outDir: opts.out, embedder: embedOneFn, modelAlias: resolvedModelAlias }),
    );

    server.registerTool(
        'code_search',
        {
            description:
                'Semantic kNN search restricted to CODE nodes (everything except doc-section). ' +
                'RECOMMENDED USAGE: call code_search and docs_search in parallel for every retrieval.',
            inputSchema: codeSearchInputShape,
        },
        makeSemanticSearchHandler({ outDir: opts.out, embedder: embedOneFn, modelAlias: resolvedModelAlias, baseExcludeKinds: ['doc-section'] }),
    );

    server.registerTool(
        'docs_search',
        {
            description:
                'Semantic kNN search restricted to DOC nodes (Markdown `doc-section` only). ' +
                'Use for design rationale, plans, README/ADR content, natural-language explanations.',
            inputSchema: docsSearchInputShape,
        },
        makeSemanticSearchHandler({ outDir: opts.out, embedder: embedOneFn, modelAlias: resolvedModelAlias, lockedKinds: ['doc-section'] }),
    );

    server.registerTool(
        'query',
        {
            description: 'Natural-language fallback. Keyword-routes to a structured tool and returns its result; no LLM dependency.',
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
                    return jsonResult({ via: action.tool, result: moduleImports(graph, action.moduleClass) });
                case 'table_users':
                    return jsonResult({ via: action.tool, result: tableUsers(graph, action.table) });
                case 'stats':
                    return jsonResult({ via: action.tool, result: graphStats(graph) });
                case 'unknown':
                    return jsonResult({ via: 'unknown', hint: action.hint });
                default: {
                    const _: never = action;
                    return jsonResult({ via: 'unknown', hint: 'unrouted action' });
                }
            }
        },
    );

    // ─────────────────────────────────────────── CODE-INTEL TOOLS
    server.registerTool(
        'resolve_symbol',
        {
            description:
                'Code intelligence lookup for classes, DTOs, methods, functions, fields, and params. ' +
                'Accepts a short name (e.g. "UsersService"), a dotted name (e.g. "UsersService.findById"), ' +
                'or a path fragment (e.g. "apps/api/users/users.service.ts"). ' +
                'When a short name is shared across files (e.g. two modules both export "setup"), ALL matches are returned — ' +
                'pass a path suffix in the query to narrow to one file. Each match carries a composite, file-qualified `id` ' +
                'that downstream tools (find_references, get_type_definition, etc.) accept for unambiguous lookup.',
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
        'get_type_definition',
        {
            description: 'Returns class/DTO/db-entity member list (fields with types, decorators, JSDoc).',
            inputSchema: getTypeDefinitionInputShape,
        },
        async ({ symbol }) => jsonResult(getTypeDefinition(await loadCodeIntelFn(), { symbol })),
    );

    server.registerTool(
        'find_references',
        {
            description: 'All call/impact/flow references to a symbol across the project.',
            inputSchema: findReferencesInputShape,
        },
        async ({ symbol, maxResults }) =>
            jsonResult(findReferences(await loadCodeIntelFn(), { symbol, maxResults })),
    );

    server.registerTool(
        'get_blueprint',
        {
            description: 'Returns the highest quality existing code examples (blueprints) for a given kind. EXPERIMENTAL.',
            inputSchema: {
                kind: z.enum(['class', 'method', 'function', 'dto', 'type', 'field', 'param', 'db-entity']).describe('Symbol kind to find blueprints for.'),
                maxResults: z.number().int().min(1).max(10).optional().default(3),
            },
        },
        async ({ kind, maxResults }) => jsonResult(getBlueprint(await loadCodeIntelFn(), { kind, maxResults })),
    );

    server.registerTool(
        'get_project_policies',
        {
            description: 'Returns inferred and explicit architectural policies (placement rules, decorator pairings). EXPERIMENTAL.',
            inputSchema: {},
        },
        async () => jsonResult(getProjectPolicies(await loadCodeIntelFn())),
    );

    server.registerTool(
        'get_orientation',
        {
            description: 'High-level architectural summary of the project (apps, libs, top policies). CALL THIS FIRST.',
            inputSchema: {},
        },
        async () => jsonResult(getOrientation(await loadCodeIntelFn())),
    );

    server.registerTool(
        'self_check',
        {
            description:
                'Verifies the health and freshness of the code-intel index. Returns one of two statuses: ' +
                '`ok` — the index is COMPLETE and lookups are unambiguous; `degraded` — there is a real silent-' +
                'wrong-answer risk: `warnings.skippedFiles` (extractor could not parse some files; trace graph has gaps) ' +
                'or `warnings.dangerousCollisions` (two class members share the same `<Class>.<method>` FQN, so ' +
                'find_references / explain_data_flow may return results from the wrong class without warning — ' +
                'use the symbol `id` (file-qualified) instead of `fqn`, or rename one of the duplicate classes). ' +
                'The optional `info.nameCollisions` field counts top-level functions/types/params with the same ' +
                'short name across files (e.g. two modules both exporting `setup`); this is NORMAL omonymy and does ' +
                'NOT affect status — pass a path suffix in resolve_symbol queries to target a specific file. ' +
                'Use this if other tools return unexpected or empty results.',
            inputSchema: {},
        },
        async () => jsonResult(selfCheck(await loadCodeIntelFn())),
    );

    server.registerTool(
        'suggest_placement',
        {
            description: 'Suggests the correct directory path for a new file based on its name and kind. EXPERIMENTAL.',
            inputSchema: {
                name: z.string().min(1).describe('The name of the new symbol, e.g. "UsersService".'),
                kind: z.enum(['class', 'method', 'function', 'dto', 'type', 'field', 'param', 'db-entity']).describe('The kind of the new symbol.'),
            },
        },
        async ({ name, kind }) => jsonResult(suggestPlacement(await loadCodeIntelFn(), { name, kind })),
    );

    server.registerTool(
        'validate_proposal',
        {
            description: 'Validates an architectural proposal (proposed imports/calls) against project guardrails. EXPERIMENTAL.',
            inputSchema: {
                sourceFile: z.string().min(1).describe('The file where the change is proposed.'),
                sourceKind: z.enum(['class', 'method', 'function', 'dto', 'type', 'field', 'param', 'db-entity']).describe('The kind of the proposing symbol.'),
                proposedImports: z.array(z.string()).describe('List of symbol names or paths to be imported.'),
                proposedCalls: z.array(z.string()).describe('List of method/function FQNs to be called.'),
            },
        },
        async (proposal) => jsonResult(validateProposal(await loadCodeIntelFn(), proposal)),
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
            description: 'Branch predicates and dominated calls at a file/line location.',
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
        'trace_exceptions',
        {
            description: 'Walk an entrypoint and surface every throw statement that can bubble up.',
            inputSchema: traceExceptionsInputShape,
        },
        async ({ entry }) => jsonResult(traceExceptions(await loadCodeIntelFn(), { entry })),
    );

    server.registerTool(
        'trace_message_flow',
        {
            description: 'Bridges NATS/RMQ structural edges with code-intel traces for a subject/queue pattern.',
            inputSchema: traceMessageFlowInputShape,
        },
        async ({ pattern }) =>
            jsonResult(traceMessageFlow(await loadCodeIntelFn(), await loadGraphFn(), pattern)),
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
}

// Exported for test use.
export { routeQuestion };

// ---------------------------------------------------------------------------
// Exported handler factory — lets tests exercise the exact same logic as the
// registered MCP tool without wiring the SDK transport.
// ---------------------------------------------------------------------------

export interface SemanticSearchHandlerOpts {
    outDir: string;
    embedder?: (text: string) => Promise<number[]>;
    modelAlias?: SemanticModelAlias;
    lockedKinds?: NodeKind[];
    baseExcludeKinds?: NodeKind[];
}

export interface SemanticSearchHandlerInput {
    query: string;
    topK?: number;
    kinds?: NodeKind[];
    excludeKinds?: NodeKind[];
    includeVectors?: boolean;
    minScore?: number;
    kindQuotas?: Partial<Record<NodeKind, number>>;
    kindBoosts?: Partial<Record<NodeKind, number>>;
}

export function makeSemanticSearchHandler(handlerOpts: SemanticSearchHandlerOpts) {
    const {
        outDir,
        embedder: embedderFn,
        modelAlias = defaultModelAlias,
        lockedKinds,
        baseExcludeKinds,
    } = handlerOpts;

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

        if (lockedKinds && kinds && kinds.length > 0) {
            throw new Error(
                `arch-graph semantic_search: handler was constructed with lockedKinds=[${lockedKinds.join(
                    ',',
                )}]; caller-supplied 'kinds' is not permitted on locked handlers.`,
            );
        }

        const effectiveKinds = lockedKinds ?? kinds;
        const effectiveExclude =
            baseExcludeKinds && excludeKinds
                ? [...baseExcludeKinds, ...excludeKinds]
                : (baseExcludeKinds ?? excludeKinds);

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
