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

const SERVER_NAME = 'arch-graph';
const SERVER_VERSION = '0.1.0';

const EDGE_KIND_VALUES: readonly EdgeKind[] = [
    'nats-publish',
    'nats-request',
    'nats-subscribe',
    'nats-reply',
    'http-call',
    'http-external',
    'queue-produce',
    'queue-consume',
    'db-read',
    'db-write',
    'db-access',
    'di-import',
    'di-provides',
    'di-exports',
    'di-controller',
    'ts-import',
    'lib-usage',
] as const;

const edgeKindSchema = z.enum(EDGE_KIND_VALUES as unknown as [EdgeKind, ...EdgeKind[]]);

interface GraphHandle {
    path: string;
    mtimeMs: number;
    graph: ArchGraph;
}

async function loadGraph(path: string): Promise<GraphHandle> {
    const buf = await readFile(path, 'utf8');
    const graph = JSON.parse(buf) as ArchGraph;
    const st = await stat(path);
    return { path, mtimeMs: st.mtimeMs, graph };
}

/** Returns a cached graph, reloading lazily if `graph.json` changed on disk. */
function makeGraphLoader(path: string): () => Promise<ArchGraph> {
    let handle: GraphHandle | null = null;
    return async () => {
        try {
            const st = await stat(path);
            if (!handle || st.mtimeMs !== handle.mtimeMs) {
                handle = await loadGraph(path);
            }
        } catch (err) {
            // If stat fails but we have a cached copy, keep serving it.
            if (!handle) throw err;
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
        async ({ moduleClass, maxDepth }) => {
            const result = moduleImports(await loadGraphFn(), moduleClass, maxDepth ?? 5);
            return jsonResult(result ?? { found: false });
        },
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
        async ({ nodeId }) => {
            const result = explain(await loadGraphFn(), nodeId);
            return jsonResult(result ?? { found: false });
        },
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
                        result: moduleImports(graph, action.moduleClass) ?? { found: false },
                    });
                case 'table_users':
                    return jsonResult({ via: action.tool, result: tableUsers(graph, action.table) });
                case 'stats':
                    return jsonResult({ via: action.tool, result: graphStats(graph) });
                case 'unknown':
                    return jsonResult({ via: 'unknown', hint: action.hint });
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
