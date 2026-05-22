import { join, resolve } from 'node:path';

import { Project, ts } from 'ts-morph';

import { loadConfig } from '../core/config.js';
import { createCodeIntelDiagnostics } from './diagnostics.js';
import { extractCodeIntel } from './extractor.js';
import { readCodeIntelDiagnostics, readCodeIntelIndex, writeCodeIntelDiagnostics, writeCodeIntelIndex } from './io.js';
import {
    explainBranch,
    explainDataFlow,
    getBlueprint,
    getFileOutline,
    impactContract,
    resolveSymbol,
    traceScenario,
} from './queries.js';

export type CodeIntelSubcommand =
    | 'build'
    | 'resolve-symbol'
    | 'explain-flow'
    | 'explain-branch'
    | 'trace-scenario'
    | 'impact-contract'
    | 'outline'
    | 'blueprint'
    | 'policies'
    | 'suggest-placement'
    | 'validate-proposal'
    | 'summary'
    | 'self-check'
    | 'diagnostics';

export interface CodeIntelArgs {
    sub: CodeIntelSubcommand | '';
    out: string;
    config: string;
    target?: string;
    param?: string;
    file?: string;
    line?: number;
    entry?: string;
    symbol?: string;
    field?: string;
    maxDepth?: number;
    maxResults?: number;
}

export function parseCodeIntelArgs(argv: string[]): CodeIntelArgs {
    const [sub = '', ...rest] = argv;
    const args: CodeIntelArgs = {
        sub: sub as CodeIntelSubcommand | '',
        out: './arch-graph-out',
        config: './arch-graph.config.ts',
    };
    const positionals: string[] = [];
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        const readValue = (): string => {
            const v = rest[++i];
            if (v === undefined) throw new Error(`${a} requires a value`);
            return v;
        };
        if (a === '--out') args.out = readValue();
        else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
        else if (a === '--config') args.config = readValue();
        else if (a.startsWith('--config=')) args.config = a.slice('--config='.length);
        else if (a === '--target') args.target = readValue();
        else if (a.startsWith('--target=')) args.target = a.slice('--target='.length);
        else if (a === '--param') args.param = readValue();
        else if (a.startsWith('--param=')) args.param = a.slice('--param='.length);
        else if (a === '--file') args.file = readValue();
        else if (a.startsWith('--file=')) args.file = a.slice('--file='.length);
        else if (a === '--line') args.line = Number(readValue());
        else if (a.startsWith('--line=')) args.line = Number(a.slice('--line='.length));
        else if (a === '--entry') args.entry = readValue();
        else if (a.startsWith('--entry=')) args.entry = a.slice('--entry='.length);
        else if (a === '--field') args.field = readValue();
        else if (a.startsWith('--field=')) args.field = a.slice('--field='.length);
        else if (a === '--max-depth') args.maxDepth = Number(readValue());
        else if (a.startsWith('--max-depth=')) args.maxDepth = Number(a.slice('--max-depth='.length));
        else if (a === '--max-results') args.maxResults = Number(readValue());
        else if (a.startsWith('--max-results=')) args.maxResults = Number(a.slice('--max-results='.length));
        else if (!a.startsWith('-')) positionals.push(a);
    }
    if (args.sub === 'resolve-symbol') args.symbol = positionals[0] ?? args.symbol;
    if (args.sub === 'impact-contract') args.symbol = positionals[0] ?? args.symbol;
    if (args.sub === 'outline') args.file = positionals[0] ?? args.file;
    if (args.sub === 'blueprint') args.symbol = positionals[0] ?? args.symbol;
    if (args.sub === 'suggest-placement') args.entry = positionals[0] ?? args.entry;
    if (args.sub === 'validate-proposal') args.file = positionals[0] ?? args.file;
    if (args.sub === 'trace-scenario') args.entry = positionals.join(' ') || args.entry;
    return args;
}

export async function runCodeIntelCommand(args: CodeIntelArgs): Promise<void> {
    switch (args.sub) {
        case 'build':
            return runCodeIntelBuild(args);
        case 'resolve-symbol':
            return emitQuery(args, (index) => resolveSymbol(index, requireString(args.symbol, 'symbol')));
        case 'outline':
            return emitQuery(args, (index) => getFileOutline(index, { file: requireString(args.file, '--file') }));
        case 'blueprint':
            return emitQuery(args, (index) => getBlueprint(index, { kind: requireString(args.symbol, 'kind'), maxResults: args.maxResults }));
        case 'policies':
            return emitQuery(args, (index) => getProjectPolicies(index));
        case 'suggest-placement':
            return emitQuery(args, (index) => suggestPlacement(index, {
                name: requireString(args.entry, 'name'),
                kind: requireString(args.symbol, '--symbol or positional'),
            }));
        case 'validate-proposal':
            return emitQuery(args, (index) => validateProposal(index, {
                sourceFile: requireString(args.file, 'sourceFile'),
                sourceKind: (args.symbol as any) ?? 'class',
                proposedImports: args.target ? args.target.split(',') : [],
                proposedCalls: [],
            }));
        case 'summary':
            return emitQuery(args, (index) => getOrientation(index));
        case 'self-check':
            return emitQuery(args, (index) => selfCheck(index));
        case 'explain-flow':
            return emitQuery(args, (index) => explainDataFlow(index, {
                target: requireString(args.target, '--target'),
                param: requireString(args.param, '--param'),
                maxResults: args.maxResults,
            }));
        case 'explain-branch':
            return emitQuery(args, (index) => explainBranch(index, {
                file: requireString(args.file, '--file'),
                line: requireNumber(args.line, '--line'),
            }));
        case 'trace-scenario':
            return emitQuery(args, (index) => traceScenario(index, {
                entry: requireString(args.entry, '--entry'),
                maxDepth: args.maxDepth,
            }));
        case 'impact-contract':
            return emitQuery(args, (index) => impactContract(index, {
                symbol: requireString(args.symbol, 'symbol'),
                field: args.field,
                maxResults: args.maxResults,
            }));
        case 'diagnostics':
            return emitDiagnostics(args);
        default:
            process.stderr.write(codeIntelUsage());
            process.exit(1);
    }
}

async function emitDiagnostics(args: CodeIntelArgs): Promise<void> {
    const dir = join(resolve(args.out), 'code-intel');
    if (args.maxResults !== undefined) {
        const index = await readCodeIntelIndex(dir);
        process.stdout.write(JSON.stringify(await createCodeIntelDiagnostics(index, { sidecarDir: dir, topN: args.maxResults }), null, 2) + '\n');
        return;
    }
    try {
        process.stdout.write(JSON.stringify(await readCodeIntelDiagnostics(dir), null, 2) + '\n');
    } catch {
        const index = await readCodeIntelIndex(dir);
        process.stdout.write(JSON.stringify(await createCodeIntelDiagnostics(index, { sidecarDir: dir, topN: args.maxResults }), null, 2) + '\n');
    }
}

async function emitQuery(
    args: CodeIntelArgs,
    run: (index: Awaited<ReturnType<typeof readCodeIntelIndex>>) => unknown,
): Promise<void> {
    const index = await readCodeIntelIndex(join(resolve(args.out), 'code-intel'));
    process.stdout.write(JSON.stringify(run(index), null, 2) + '\n');
}

async function runCodeIntelBuild(args: CodeIntelArgs): Promise<void> {
    const cfg = await loadConfig(resolve(args.config));
    const project = new Project({
        useInMemoryFileSystem: false,
        skipAddingFilesFromTsConfig: true,
        compilerOptions: {
            allowJs: false,
            strict: false,
            noEmit: true,
            jsx: ts.JsxEmit.React,
        },
    });
    const sourceExts = ['**/*.ts', '**/*.tsx'];
    const globs = [
        ...sourceExts.map((ext) => join(cfg.root, cfg.appsGlob, ext)),
        ...(cfg.libsGlob ? sourceExts.map((ext) => join(cfg.root, cfg.libsGlob!, ext)) : []),
    ];
    const extraExcludes = (cfg.excludeGlobs ?? []).map((g) => `!**${g}**`);
    for (const g of globs) {
        project.addSourceFilesAtPaths([
            g,
            '!' + join(cfg.root, '**/node_modules/**'),
            '!' + join(cfg.root, '**/dist/**'),
            '!' + join(cfg.root, '**/.claude/**'),
            '!' + join(cfg.root, '**/.worktrees/**'),
            '!**/*.d.ts',
            ...extraExcludes,
        ]);
    }
    const index = extractCodeIntel(project, { root: cfg.root });
    const dir = join(resolve(args.out), 'code-intel');
    await writeCodeIntelIndex(index, dir);
    await writeCodeIntelDiagnostics(await createCodeIntelDiagnostics(index, { sidecarDir: dir }), dir);
    process.stdout.write(`✓ code-intel sidecar: ${dir} (${index.symbols.length} symbols, ${index.calls.length} calls)\n`);
}

function requireString(value: string | undefined, name: string): string {
    if (!value) {
        process.stderr.write(`error: ${name} is required\n`);
        process.exit(1);
    }
    return value;
}

function requireNumber(value: number | undefined, name: string): number {
    if (value === undefined || Number.isNaN(value)) {
        process.stderr.write(`error: ${name} must be a number\n`);
        process.exit(1);
    }
    return value;
}

function codeIntelUsage(): string {
    return `unknown code-intel subcommand\n` +
        `  arch-graph code-intel build [--config <path>] [--out <dir>]\n` +
        `  arch-graph code-intel resolve-symbol <name> [--out <dir>]\n` +
        arch-graph code-intel outline <file> [--out <dir>]
        arch-graph code-intel blueprint <kind> [--out <dir>]
        arch-graph code-intel policies [--out <dir>]
        arch-graph code-intel suggest-placement <name> --symbol <kind> [--out <dir>]
        arch-graph code-intel validate-proposal <file> --symbol <kind> --target <imports> [--out <dir>]
        arch-graph code-intel summary [--out <dir>]
        arch-graph code-intel self-check [--out <dir>]
        arch-graph code-intel explain-flow --target Class.method --param x [--out <dir>]        `  arch-graph code-intel explain-branch --file path --line N [--out <dir>]\n` +
        `  arch-graph code-intel trace-scenario --entry "Class.method" [--out <dir>]\n` +
        `  arch-graph code-intel impact-contract DtoName [--field name] [--out <dir>]\n` +
        `  arch-graph code-intel diagnostics [--max-results N] [--out <dir>]\n`;
}
