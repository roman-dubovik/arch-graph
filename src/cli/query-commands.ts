/**
 * CLI query subcommand handlers.
 *
 * Every handler reads graph.json from --out/<dir>/graph.json, delegates to the
 * backend-agnostic helpers in src/mcp/graph-queries.ts (no reimplementation),
 * and writes structured JSON or a pretty table to stdout.
 *
 * Exit codes:
 *   0  — query found the input node and returned results (found: true)
 *   4  — node not found in graph (found: false envelope still written to stdout)
 *   1  — bad args / fatal I/O error
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ArchGraph } from '../core/types.js';
import {
    findPublishers,
    findSubscribers,
    findQueueProducers,
    findQueueConsumers,
    tableUsers,
    serviceDependencies,
    serviceDependents,
    moduleImports,
    findPath,
    graphStats,
    stripPrefix,
    withPrefix,
    type EdgeAnswer,
    type EdgeAnswerList,
    type GroupedDeps,
    type PathResult,
    type GraphStats,
} from '../mcp/graph-queries.js';

// ---------------------------------------------------------------------------
// Parsed query args
// ---------------------------------------------------------------------------

export interface QueryArgs {
    /** Subcommand name, e.g. "who-publishes". */
    cmd: string;
    /** Positional arguments after the subcommand name. */
    positionals: string[];
    /** Directory that contains graph.json. Defaults to ./arch-graph-out. */
    out: string;
    /** Format flag: "json" (default) or "table". */
    format: 'json' | 'table';
}

/** All recognised query subcommands. */
export const QUERY_CMDS = new Set([
    'who-publishes',
    'who-subscribes',
    'queue-producers',
    'queue-consumers',
    'table-users',
    'deps-of',
    'dependents-of',
    'module-imports',
    'path',
    'stats',
]);

/**
 * Parse raw argv (starting after the binary) when the first token is a known
 * query subcommand. Returns a `QueryArgs` ready for `runQueryCommand`.
 */
export function parseQueryArgs(argv: string[]): QueryArgs {
    const [cmd, ...rest] = argv as [string, ...string[]];
    let out = './arch-graph-out';
    let format: 'json' | 'table' = 'json';
    const positionals: string[] = [];

    for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (a === '--out' || a === '-o') {
            if (rest[i + 1] === undefined) {
                process.stderr.write(`error: ${a} requires a value\n`);
                process.exit(1);
            }
            out = rest[++i]!;
        } else if (a.startsWith('--out=')) {
            out = a.slice('--out='.length);
        } else if (a === '--json') {
            format = 'json';
        } else if (a === '--table') {
            format = 'table';
        } else if (!a.startsWith('-')) {
            positionals.push(a);
        }
        // unknown flags are silently ignored
    }

    return { cmd: cmd ?? '', positionals, out, format };
}

// ---------------------------------------------------------------------------
// Graph loader
// ---------------------------------------------------------------------------

async function loadGraph(outDir: string): Promise<ArchGraph> {
    const path = resolve(outDir, 'graph.json');
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        fatal(
            `cannot read graph.json from '${path}': ${e.message}\n` +
            `  Run 'arch-graph build' first.`,
        );
    }
    try {
        return JSON.parse(raw!) as ArchGraph;
    } catch (err) {
        fatal(`graph.json at '${path}' is not valid JSON: ${(err as Error).message}`);
    }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

/** Structured success envelope shared by most query commands. */
interface QueryEnvelope {
    query: string;
    input: string | string[];
    found: boolean;
    results?: unknown[];
    hint?: string;
    // stats uses a different top-level shape; see runStats
    [key: string]: unknown;
}

function emit(data: QueryEnvelope | object): void {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function notFound(
    query: string,
    input: string | string[],
    hint: string,
    format: 'json' | 'table' = 'json',
): never {
    const envelope: QueryEnvelope = { query, input, found: false, hint };
    if (format === 'table') {
        process.stdout.write(`(not found) ${hint}\n`);
    } else {
        emit(envelope);
    }
    process.exit(4);
}

function fatal(msg: string): never {
    process.stderr.write(`error: ${msg}\n`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Table renderer
// ---------------------------------------------------------------------------

function renderTable(rows: Record<string, unknown>[]): void {
    if (rows.length === 0) {
        process.stdout.write('(no results)\n');
        return;
    }
    const keys = Object.keys(rows[0]!);
    const widths = keys.map((k) =>
        Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length)),
    );
    const sep = widths.map((w) => '-'.repeat(w));
    const fmt = (row: Record<string, unknown>) =>
        keys.map((k, i) => String(row[k] ?? '').padEnd(widths[i]!)).join('  ');
    process.stdout.write(keys.map((k, i) => k.padEnd(widths[i]!)).join('  ') + '\n');
    process.stdout.write(sep.join('  ') + '\n');
    for (const row of rows) {
        process.stdout.write(fmt(row) + '\n');
    }
}

// ---------------------------------------------------------------------------
// Individual command implementations
// ---------------------------------------------------------------------------

/** Convert EdgeAnswer to a flat display row (JSON results use the raw object). */
function edgeAnswerToRow(e: EdgeAnswer): Record<string, unknown> {
    return {
        role: e.role,
        owner: stripPrefix(e.owner),
        counterpart: stripPrefix(e.counterpart),
        kind: e.kind,
        ...(e.file !== undefined ? { file: e.file } : {}),
        ...(e.line !== undefined ? { line: e.line } : {}),
        ...(e.subjectPattern !== undefined ? { subjectPattern: e.subjectPattern } : {}),
        ...(e.dynamic !== undefined ? { dynamic: e.dynamic } : {}),
    };
}

function handleEdgeList(
    args: QueryArgs,
    query: string,
    input: string,
    hint: string,
    result: EdgeAnswerList,
): void {
    if (!result.found) {
        notFound(query, input, hint);
    }
    const results = result.sites.map(edgeAnswerToRow);

    if (args.format === 'table') {
        if (results.length === 0) {
            process.stdout.write(`(no ${query} for '${input}')\n`);
        } else {
            renderTable(results);
        }
        return;
    }
    emit({ query, input, found: true, results });
}

async function runWhoPublishes(args: QueryArgs): Promise<void> {
    if (args.positionals.length === 0) fatal('usage: arch-graph who-publishes <subject>');
    const input = args.positionals[0]!;
    const graph = await loadGraph(args.out);
    const result = findPublishers(graph, input);
    const normalized = withPrefix('nats', stripPrefix(input));
    handleEdgeList(
        args,
        'who-publishes',
        input,
        `no NATS subject node '${normalized}' in graph`,
        result,
    );
}

async function runWhoSubscribes(args: QueryArgs): Promise<void> {
    if (args.positionals.length === 0) fatal('usage: arch-graph who-subscribes <subject>');
    const input = args.positionals[0]!;
    const graph = await loadGraph(args.out);
    const result = findSubscribers(graph, input);
    const normalized = withPrefix('nats', stripPrefix(input));
    handleEdgeList(
        args,
        'who-subscribes',
        input,
        `no NATS subject node '${normalized}' in graph`,
        result,
    );
}

async function runQueueProducers(args: QueryArgs): Promise<void> {
    if (args.positionals.length === 0) fatal('usage: arch-graph queue-producers <queue>');
    const input = args.positionals[0]!;
    const graph = await loadGraph(args.out);
    const result = findQueueProducers(graph, input);
    const normalized = withPrefix('queue', stripPrefix(input));
    handleEdgeList(
        args,
        'queue-producers',
        input,
        `no queue node '${normalized}' in graph`,
        result,
    );
}

async function runQueueConsumers(args: QueryArgs): Promise<void> {
    if (args.positionals.length === 0) fatal('usage: arch-graph queue-consumers <queue>');
    const input = args.positionals[0]!;
    const graph = await loadGraph(args.out);
    const result = findQueueConsumers(graph, input);
    const normalized = withPrefix('queue', stripPrefix(input));
    handleEdgeList(
        args,
        'queue-consumers',
        input,
        `no queue node '${normalized}' in graph`,
        result,
    );
}

async function runTableUsers(args: QueryArgs): Promise<void> {
    if (args.positionals.length === 0) fatal('usage: arch-graph table-users <table>');
    const input = args.positionals[0]!;
    const graph = await loadGraph(args.out);
    const result = tableUsers(graph, input);
    const normalized = withPrefix('db-table', stripPrefix(input));
    handleEdgeList(
        args,
        'table-users',
        input,
        `no db-table node '${normalized}' in graph`,
        result,
    );
}

function handleGroupedDeps(
    args: QueryArgs,
    query: string,
    input: string,
    hint: string,
    result: GroupedDeps,
): void {
    if (!result.found) {
        notFound(query, input, hint);
    }
    if (args.format === 'table') {
        const rows: Record<string, unknown>[] = [];
        for (const [kind, entries] of Object.entries(result.byKind)) {
            for (const e of entries) {
                rows.push({
                    kind,
                    counterpart: stripPrefix(e.counterpart),
                    ...(e.file !== undefined ? { file: e.file } : {}),
                    ...(e.line !== undefined ? { line: e.line } : {}),
                });
            }
        }
        if (rows.length === 0) {
            process.stdout.write(`(no ${query} for '${input}')\n`);
        } else {
            renderTable(rows);
        }
        return;
    }
    emit({ query, input, found: true, counts: result.counts, byKind: result.byKind });
}

async function runDepsOf(args: QueryArgs): Promise<void> {
    if (args.positionals.length === 0) fatal('usage: arch-graph deps-of <service-id>');
    const input = args.positionals[0]!;
    const graph = await loadGraph(args.out);
    const result = serviceDependencies(graph, input);
    const normalized = withPrefix('service', stripPrefix(input));
    handleGroupedDeps(
        args,
        'deps-of',
        input,
        `no service node '${normalized}' in graph`,
        result,
    );
}

async function runDependentsOf(args: QueryArgs): Promise<void> {
    if (args.positionals.length === 0) fatal('usage: arch-graph dependents-of <service-id>');
    const input = args.positionals[0]!;
    const graph = await loadGraph(args.out);
    const result = serviceDependents(graph, input);
    const normalized = withPrefix('service', stripPrefix(input));
    handleGroupedDeps(
        args,
        'dependents-of',
        input,
        `no service node '${normalized}' in graph`,
        result,
    );
}

async function runModuleImports(args: QueryArgs): Promise<void> {
    if (args.positionals.length === 0) fatal('usage: arch-graph module-imports <module-name>');
    const input = args.positionals[0]!;
    const graph = await loadGraph(args.out);
    const result = moduleImports(graph, input);
    if (!result.found) {
        const normalized = withPrefix('module', stripPrefix(input));
        notFound('module-imports', input, `no module node '${normalized}' in graph`);
    }
    if (args.format === 'table') {
        // Flatten the import tree into rows (first level only for readability).
        const rows: Record<string, unknown>[] = result.imports.map((imp) => ({
            module: result.module,
            imports: imp,
        }));
        if (rows.length === 0) {
            process.stdout.write(`(module '${input}' has no imports)\n`);
        } else {
            renderTable(rows);
        }
        return;
    }
    emit({
        query: 'module-imports',
        input,
        found: true,
        module: result.module,
        imports: result.imports,
        children: result.children,
    });
}

async function runPath(args: QueryArgs): Promise<void> {
    if (args.positionals.length < 2) fatal('usage: arch-graph path <from> <to>');
    const [fromId, toId] = args.positionals as [string, string];
    const graph = await loadGraph(args.out);
    const result: PathResult = findPath(graph, fromId, toId);

    if (!result.found) {
        notFound(
            'path',
            [fromId, toId],
            `no path from '${fromId}' to '${toId}' in graph (either node missing or no directed path)`,
            args.format,
        );
    }

    if (args.format === 'table') {
        const rows: Record<string, unknown>[] = result.edges.map((e) => ({
            from: e.from,
            to: e.to,
            kind: e.kind,
        }));
        if (rows.length === 0) {
            // from === to
            process.stdout.write(`(trivial path: '${fromId}' is '${toId}')\n`);
        } else {
            renderTable(rows);
        }
        return;
    }
    emit({
        query: 'path',
        input: [fromId, toId],
        found: true,
        nodes: result.nodes,
        edges: result.edges,
    });
}

async function runStats(args: QueryArgs): Promise<void> {
    const graph = await loadGraph(args.out);
    const stats: GraphStats = graphStats(graph);

    if (args.format === 'table') {
        process.stdout.write(`version:  ${stats.version}\n`);
        process.stdout.write(`root:     ${stats.root}\n`);
        process.stdout.write(`buildAt:  ${stats.buildAt}\n`);
        process.stdout.write(`\nNodes (${stats.totals.nodes} total):\n`);
        for (const [kind, count] of Object.entries(stats.nodes)) {
            process.stdout.write(`  ${kind.padEnd(20)} ${count}\n`);
        }
        process.stdout.write(`\nEdges (${stats.totals.edges} total):\n`);
        for (const [kind, count] of Object.entries(stats.edges)) {
            process.stdout.write(`  ${kind.padEnd(20)} ${count}\n`);
        }
        return;
    }
    emit({ query: 'stats', found: true, ...stats });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Main entry point — call from cli/index.ts main(). */
export async function runQueryCommand(args: QueryArgs): Promise<void> {
    switch (args.cmd) {
        case 'who-publishes':
            return runWhoPublishes(args);
        case 'who-subscribes':
            return runWhoSubscribes(args);
        case 'queue-producers':
            return runQueueProducers(args);
        case 'queue-consumers':
            return runQueueConsumers(args);
        case 'table-users':
            return runTableUsers(args);
        case 'deps-of':
            return runDepsOf(args);
        case 'dependents-of':
            return runDependentsOf(args);
        case 'module-imports':
            return runModuleImports(args);
        case 'path':
            return runPath(args);
        case 'stats':
            return runStats(args);
        default:
            fatal(`unknown query command: ${args.cmd}`);
    }
}
