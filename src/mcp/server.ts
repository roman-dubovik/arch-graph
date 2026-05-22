import { resolve } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
    findQueueConsumers,
    findQueueProducers,
    findPublishers,
    findSubscribers,
    graphStats,
    moduleImports,
    serviceDependencies,
    serviceDependents,
    tableUsers,
} from '../mcp/graph-queries.js';
import { loadGraph } from '../core/io.js';
import { NODE_KIND_VALUES, type ArchGraph } from '../core/types.js';
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
import type { CodeIntelIndex } from '../code-intel/types.js';
import { readCodeIntelIndex } from '../code-intel/io.js';
import { semanticSearch } from '../semantic/search.js';
import { makeEmbedder } from '../semantic/embedder.js';
import { resolveMinScore } from '../semantic/types.js';

const MAX_TOP_K = 50;
const nodeKindSchema = z.enum(NODE_KIND_VALUES);

export const semanticSearchInputShape = {
    query: z.string().min(1).describe('Query text to search for.'),
    topK: z.number().int().min(1).max(MAX_TOP_K).optional().default(10),
    kinds: z.array(nodeKindSchema).optional(),
    excludeKinds: z.array(nodeKindSchema).optional(),
    includeVectors: z.boolean().optional().default(false),
    minScore: z.number().min(-1).max(1).optional(),
    kindQuotas: z.partialRecord(nodeKindSchema, z.number().int().min(0).max(MAX_TOP_K)).optional(),
};

export const resolveSymbolInputShape = {
    query: z.string().min(1).describe('Symbol name, FQN, or partial path to resolve.'),
};

export const getFileOutlineInputShape = {
    file: z.string().min(1).describe('Relative path to the file to outline.'),
};

export const explainDataFlowInputShape = {
    target: z.string().min(1).describe('Method/Function FQN to trace flow in.'),
    param: z.string().min(1).describe('Parameter name to trace.'),
    maxResults: z.number().int().min(1).max(50).optional().default(10),
};

export const traceScenarioInputShape = {
    entry: z.string().min(1).describe('Entry point FQN (e.g. Controller.method).'),
    maxDepth: z.number().int().min(1).max(10).optional().default(5),
};

export interface McpServerOptions {
    out: string;
    config: string;
}

export async function startMcpServer(opts: McpServerOptions) {
    const server = new McpServer({
        name: 'arch-graph',
        version: '0.1.0',
    });

    const loadGraphFn = makeGraphLoader(opts.out);
    const loadCodeIntelFn = makeCodeIntelLoader(opts.out);

    // ────────────────────────────────────────────────── STRUCTURAL TOOLS
    server.registerTool(
        'subject_publishers',
        { parameters: z.object({ subject: z.string() }) },
        async ({ subject }) => jsonResult(findPublishers(await loadGraphFn(), subject)),
    );

    server.registerTool(
        'subject_subscribers',
        { parameters: z.object({ subject: z.string() }) },
        async ({ subject }) => jsonResult(findSubscribers(await loadGraphFn(), subject)),
    );

    server.registerTool(
        'queue_producers',
        { parameters: z.object({ queue: z.string() }) },
        async ({ queue }) => jsonResult(findQueueProducers(await loadGraphFn(), queue)),
    );

    server.registerTool(
        'queue_consumers',
        { parameters: z.object({ queue: z.string() }) },
        async ({ queue }) => jsonResult(findQueueConsumers(await loadGraphFn(), queue)),
    );

    server.registerTool(
        'service_dependencies',
        { parameters: z.object({ serviceId: z.string() }) },
        async ({ serviceId }) => jsonResult(serviceDependencies(await loadGraphFn(), serviceId)),
    );

    server.registerTool(
        'service_dependents',
        { parameters: z.object({ serviceId: z.string() }) },
        async ({ serviceId }) => jsonResult(serviceDependents(await loadGraphFn(), serviceId)),
    );

    server.registerTool(
        'module_imports',
        { parameters: z.object({ moduleClass: z.string() }) },
        async ({ moduleClass }) => jsonResult(moduleImports(await loadGraphFn(), moduleClass)),
    );

    server.registerTool(
        'table_users',
        { parameters: z.object({ table: z.string() }) },
        async ({ table }) => jsonResult(tableUsers(await loadGraphFn(), table)),
    );

    server.registerTool(
        'stats',
        { parameters: z.object({}) },
        async () => jsonResult(graphStats(await loadGraphFn())),
    );

    // ────────────────────────────────────────────────── SEMANTIC TOOLS
    server.registerTool(
        'semantic_search',
        { parameters: z.object(semanticSearchInputShape) },
        async (args) => {
            const embedder = makeEmbedder('e5-base');
            return jsonResult(
                await semanticSearch({
                    ...args,
                    outDir: opts.out,
                    embedder: (t) => embedder.embedOne(t, 'query'),
                    modelAlias: 'e5-base',
                    minScore: resolveMinScore('e5-base', args.minScore),
                }),
            );
        },
    );

    server.registerTool(
        'code_search',
        { parameters: z.object(semanticSearchInputShape) },
        async (args) => {
            const embedder = makeEmbedder('e5-base');
            return jsonResult(
                await semanticSearch({
                    ...args,
                    excludeKinds: [...(args.excludeKinds ?? []), 'doc-section'],
                    outDir: opts.out,
                    embedder: (t) => embedder.embedOne(t, 'query'),
                    modelAlias: 'e5-base',
                    minScore: resolveMinScore('e5-base', args.minScore),
                }),
            );
        },
    );

    server.registerTool(
        'docs_search',
        { parameters: z.object(semanticSearchInputShape) },
        async (args) => {
            const embedder = makeEmbedder('e5-base');
            return jsonResult(
                await semanticSearch({
                    ...args,
                    kinds: ['doc-section'],
                    outDir: opts.out,
                    embedder: (t) => embedder.embedOne(t, 'query'),
                    modelAlias: 'e5-base',
                    minScore: resolveMinScore('e5-base', args.minScore),
                }),
            );
        },
    );

    server.registerTool(
        'query',
        { parameters: z.object({ question: z.string() }) },
        async ({ question }) => {
            const action = routeQuestion(question);
            const graph = await loadGraphFn();
            switch (action.tool) {
                case 'subject_publishers': return jsonResult(findPublishers(graph, action.subject!));
                case 'subject_subscribers': return jsonResult(findSubscribers(graph, action.subject!));
                case 'queue_producers': return jsonResult(findQueueProducers(graph, action.queue!));
                case 'queue_consumers': return jsonResult(findQueueConsumers(graph, action.queue!));
                case 'service_dependencies': return jsonResult(serviceDependencies(graph, action.serviceId!));
                case 'service_dependents': return jsonResult(serviceDependents(graph, action.serviceId!));
                case 'module_imports': return jsonResult(moduleImports(graph, action.moduleClass!));
                case 'table_users': return jsonResult(tableUsers(graph, action.table!));
                case 'stats': return jsonResult(graphStats(graph));
                default: return jsonResult({ via: 'unknown', hint: action.hint });
            }
        },
    );

    // ────────────────────────────────────────────────── CODE INTELLIGENCE TOOLS
    server.registerTool(
        'resolve_symbol',
        { parameters: z.object(resolveSymbolInputShape) },
        async ({ query }) => jsonResult(resolveSymbol(await loadCodeIntelFn(), query)),
    );

    server.registerTool(
        'get_file_outline',
        { parameters: z.object(getFileOutlineInputShape) },
        async ({ file }) => jsonResult(getFileOutline(await loadCodeIntelFn(), { file })),
    );

    server.registerTool(
        'get_type_definition',
        { parameters: z.object({ symbol: z.string() }) },
        async ({ symbol }) => jsonResult(getTypeDefinition(await loadCodeIntelFn(), { symbol })),
    );

    server.registerTool(
        'find_references',
        { parameters: z.object({ symbol: z.string(), maxResults: z.number().optional() }) },
        async ({ symbol, maxResults }) => jsonResult(findReferences(await loadCodeIntelFn(), { symbol, maxResults })),
    );

    server.registerTool(
        'get_blueprint',
        { parameters: z.object({ kind: z.enum(['class', 'method', 'function', 'dto', 'type', 'field', 'param', 'db-entity']), maxResults: z.number().optional() }) },
        async ({ kind, maxResults }) => jsonResult(getBlueprint(await loadCodeIntelFn(), { kind, maxResults })),
    );

    server.registerTool(
        'get_project_policies',
        { parameters: z.object({}) },
        async () => jsonResult(getProjectPolicies(await loadCodeIntelFn())),
    );

    server.registerTool(
        'get_orientation',
        { parameters: z.object({}) },
        async () => jsonResult(getOrientation(await loadCodeIntelFn())),
    );

    server.registerTool(
        'self_check',
        { parameters: z.object({}) },
        async () => jsonResult(selfCheck(await loadCodeIntelFn())),
    );

    server.registerTool(
        'suggest_placement',
        { parameters: z.object({ name: z.string(), kind: z.enum(['class', 'method', 'function', 'dto', 'type', 'field', 'param', 'db-entity']) }) },
        async ({ name, kind }) => jsonResult(suggestPlacement(await loadCodeIntelFn(), { name, kind })),
    );

    server.registerTool(
        'validate_proposal',
        { parameters: z.object({ sourceFile: z.string(), sourceKind: z.enum(['class', 'method', 'function', 'dto', 'type', 'field', 'param', 'db-entity']), proposedImports: z.array(z.string()), proposedCalls: z.array(z.string()) }) },
        async (proposal) => jsonResult(validateProposal(await loadCodeIntelFn(), proposal)),
    );

    server.registerTool(
        'explain_data_flow',
        { parameters: z.object(explainDataFlowInputShape) },
        async ({ target, param, maxResults }) => jsonResult(explainDataFlow(await loadCodeIntelFn(), { target, param, maxResults })),
    );

    server.registerTool(
        'explain_branch',
        { parameters: z.object({ file: z.string(), line: z.number() }) },
        async ({ file, line }) => jsonResult(explainBranch(await loadCodeIntelFn(), { file, line })),
    );

    server.registerTool(
        'trace_scenario',
        { parameters: z.object(traceScenarioInputShape) },
        async ({ entry, maxDepth }) => jsonResult(traceScenario(await loadCodeIntelFn(), { entry, maxDepth })),
    );

    server.registerTool(
        'trace_exceptions',
        { parameters: z.object({ entry: z.string() }) },
        async ({ entry }) => jsonResult(traceExceptions(await loadCodeIntelFn(), { entry })),
    );

    server.registerTool(
        'trace_message_flow',
        { parameters: z.object({ pattern: z.string() }) },
        async ({ pattern }) => {
            const index = await loadCodeIntelFn();
            const graphRaw = await readFile(resolve(opts.out, 'graph.json'), 'utf8');
            return jsonResult(traceMessageFlow(index, JSON.parse(graphRaw), pattern));
        },
    );

    server.registerTool(
        'impact_contract',
        { parameters: z.object({ symbol: z.string(), field: z.string().optional(), maxResults: z.number().optional() }) },
        async ({ symbol, field, maxResults }) => jsonResult(impactContract(await loadCodeIntelFn(), { symbol, field, maxResults })),
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

// ────────────────────────────────────────────────── INTERNAL HELPERS

type RoutedAction = {
    tool: string;
    subject?: string;
    queue?: string;
    table?: string;
    serviceId?: string;
    moduleClass?: string;
    hint: string;
};

function routeQuestion(question: string): RoutedAction {
    const q = question.toLowerCase();
    const quoted = question.match(/['"`]([^'"`]+)['"`]/);
    const lastToken = question.split(/\s+/).pop() ?? '';
    const target = quoted?.[1] ?? lastToken;

    if (q.includes('stat')) return { tool: 'stats', hint: '' };
    if (q.includes('subject') || q.includes('nats')) {
        if (q.includes('publish') || q.includes('producer') || q.includes('sender')) return { tool: 'subject_publishers', subject: target, hint: '' };
        return { tool: 'subject_subscribers', subject: target, hint: '' };
    }
    if (q.includes('queue') || q.includes('bullmq')) {
        if (q.includes('produce') || q.includes('publisher') || q.includes('sender')) return { tool: 'queue_producers', queue: target, hint: '' };
        return { tool: 'queue_consumers', queue: target, hint: '' };
    }
    if (q.includes('table') || q.includes('database') || q.includes('db ')) return { tool: 'table_users', table: target, hint: '' };
    if (q.includes('module') && (q.includes('import') || q.includes('depend'))) return { tool: 'module_imports', moduleClass: target, hint: '' };
    if (q.includes('depended') || q.includes('callers') || q.includes('used by')) return { tool: 'service_dependents', serviceId: target, hint: '' };
    if (q.includes('depend on') || q.includes('uses') || q.includes('use')) return { tool: 'service_dependencies', serviceId: target, hint: '' };

    return {
        tool: 'unknown',
        hint: 'Try subject_publishers, queue_consumers, service_dependencies, or table_users.',
    };
}

function makeGraphLoader(outDir: string) {
    let handle: { graph: ArchGraph; mtimeMs: number } | null = null;
    const path = resolve(outDir, 'graph.json');
    return async () => {
        const st = await stat(path);
        if (!handle || st.mtimeMs !== handle.mtimeMs) {
            handle = { graph: await loadGraph(path), mtimeMs: st.mtimeMs };
        }
        return handle.graph;
    };
}

function makeCodeIntelLoader(outDir: string) {
    let handle: { index: CodeIntelIndex; mtimeMs: number } | null = null;
    const path = resolve(outDir, 'code-intel', 'manifest.json');
    return async () => {
        const st = await stat(path);
        if (!handle || st.mtimeMs !== handle.mtimeMs) {
            handle = { index: await readCodeIntelIndex(resolve(outDir, 'code-intel')), mtimeMs: st.mtimeMs };
        }
        return handle.index;
    };
}

function jsonResult(data: unknown) {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
