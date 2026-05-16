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

import type { ArchGraph, EdgeKind } from '../core/types.js';
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
import { embedOne } from '../semantic/embedder.js';
import { readEmbeddingsJsonl } from '../semantic/io.js';
import { SEMANTIC_DIM, SEMANTIC_MODEL } from '../semantic/types.js';
import type { NodeKind } from '../core/types.js';

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
    'di-guard': null,
    'di-interceptor': null,
    'di-pipe': null,
    'ts-import': null,
    'lib-usage': null,
};
const EDGE_KIND_VALUES = Object.keys(EDGE_KIND_CHECK) as [EdgeKind, ...EdgeKind[]];

const edgeKindSchema = z.enum(EDGE_KIND_VALUES);

// Same exhaustiveness-gate pattern for NodeKind values.
const NODE_KIND_CHECK: Record<NodeKind, null> = {
    'service': null,
    'lib': null,
    'nats-subject': null,
    'db-table': null,
    'queue': null,
    'module': null,
    'provider': null,
    'file': null,
    'external': null,
};
const NODE_KIND_VALUES = Object.keys(NODE_KIND_CHECK) as [NodeKind, ...NodeKind[]];
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
    includeVectors: z
        .boolean()
        .optional()
        .default(false)
        .describe('If true, include the embedding vector for each result.'),
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

export async function startMcpServer(opts: { out: string }): Promise<void> {
    const graphPath = resolve(opts.out, 'graph.json');
    const loadGraphFn = makeGraphLoader(graphPath);
    // Eager load so startup errors surface immediately on stderr instead of on first tool call.
    await loadGraphFn();

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
                'Semantic kNN search over the sidecar index. Query is embedded and compared to indexed node embeddings using cosine similarity.',
            inputSchema: semanticSearchInputShape,
        },
        // Reuse the exported handler factory so the test-accessible path and the
        // production registration share exactly the same logic.
        makeSemanticSearchHandler({ outDir: opts.out }),
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
    /** Injectable embedder — defaults to `embedOne` in production. */
    embedder?: (text: string) => Promise<number[]>;
}

export interface SemanticSearchHandlerInput {
    query: string;
    topK?: number;
    kinds?: string[];
    includeVectors?: boolean;
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
    const { outDir, embedder: embedderFn = embedOne } = handlerOpts;

    return async (input: SemanticSearchHandlerInput) => {
        const { query, topK = 10, kinds, includeVectors = false } = input;

        const searchRes = await semanticSearch({
            query,
            outDir,
            embedder: embedderFn,
            topK,
            kinds,
        });

        const output = searchRes.output;

        if (includeVectors && output.results.length > 0 && !output.error) {
            const embeddingsPath = `${outDir}/semantic/embeddings.jsonl`;
            const resultNodeIds = new Set(output.results.map((r) => r.nodeId));

            try {
                for await (const record of readEmbeddingsJsonl(embeddingsPath)) {
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
