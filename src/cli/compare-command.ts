/**
 * `arch-graph compare` — side-by-side context-cost comparison between
 * arch-graph's graph.json and an (optional) graphify graph.json, run on the
 * **user's own repo**.
 *
 * The internal `bench/` directory provides the same comparison on our
 * reference corpus. This CLI command exposes the same machinery so a skeptical
 * user can reproduce the comparison locally:
 *
 *     arch-graph compare                                # size-only
 *     arch-graph compare --graphify ./graphify-out/     # head-to-head
 */

import { writeFile, stat, mkdir, readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { resolve, basename, dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { ArchGraph, GraphNode } from '../core/types.js';
import {
    findPublishers,
    findSubscribers,
    findQueueProducers,
    findQueueConsumers,
    tableUsers,
    serviceDependencies,
    moduleImports,
    stripPrefix,
    type GroupedDeps,
} from '../mcp/graph-queries.js';
import { archGraphAdapter } from '../compare/adapters/arch-graph.js';
import { graphifyAdapter } from '../compare/adapters/graphify.js';
import { countTokens, disposeTokens } from '../compare/tokens.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface CompareArgs {
    out: string;
    graphify?: string;
    questions: number;
    report?: string;
    quiet: boolean;
    share: boolean;
    /** Skip the interactive confirmation in --share mode (for tests/CI). */
    shareYes: boolean;
    /** Skip opening the browser in --share mode (for tests/CI). */
    shareNoOpen: boolean;
}

const DEFAULT_QUESTIONS = 10;
const MAX_QUESTIONS = 20;
const DEFAULT_OUT = './arch-graph-out';

export function parseCompareArgs(argv: string[]): CompareArgs {
    let out = DEFAULT_OUT;
    let graphify: string | undefined;
    let questions = DEFAULT_QUESTIONS;
    let report: string | undefined;
    let quiet = false;
    let share = false;
    let shareYes = false;
    let shareNoOpen = false;

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        const takeValue = (flag: string): string => {
            const next = argv[i + 1];
            if (next === undefined) {
                process.stderr.write(`error: ${flag} requires a value\n`);
                process.exit(1);
            }
            i++;
            return next;
        };
        if (a === '--out') out = takeValue('--out');
        else if (a.startsWith('--out=')) out = a.slice('--out='.length);
        else if (a === '--graphify') graphify = takeValue('--graphify');
        else if (a.startsWith('--graphify=')) graphify = a.slice('--graphify='.length);
        else if (a === '--questions') questions = parseQuestionCount(takeValue('--questions'));
        else if (a.startsWith('--questions=')) questions = parseQuestionCount(a.slice('--questions='.length));
        else if (a === '--report') report = takeValue('--report');
        else if (a.startsWith('--report=')) report = a.slice('--report='.length);
        else if (a === '--quiet' || a === '-q') quiet = true;
        else if (a === '--share') share = true;
        else if (a === '--share-yes') { share = true; shareYes = true; }
        else if (a === '--share-no-open') { share = true; shareNoOpen = true; }
        else if (a === '-h' || a === '--help') {
            process.stdout.write(COMPARE_HELP);
            process.exit(0);
        }
    }

    return { out, graphify, questions, report, quiet, share, shareYes, shareNoOpen };
}

function parseQuestionCount(raw: string): number {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) {
        process.stderr.write(`error: --questions must be a positive integer (got '${raw}')\n`);
        process.exit(1);
    }
    if (n > MAX_QUESTIONS) {
        process.stderr.write(`warning: --questions=${n} capped at ${MAX_QUESTIONS}\n`);
        return MAX_QUESTIONS;
    }
    return n;
}

const COMPARE_HELP = `
arch-graph compare — side-by-side context-cost comparison on your own repo.

Usage:
  arch-graph compare [--out <dir>] [--graphify <path>] [--questions <n>]
                     [--report <path>] [--quiet] [--share]

Options:
  --out <dir>        Directory with arch-graph's graph.json (default: ./arch-graph-out)
  --graphify <path>  Path to a graphify-out directory or graph.json file.
  --questions <n>    How many questions to auto-generate (default 10, max 20).
  --report <path>    Markdown report path (default <out>/compare-report.md).
  --quiet            Suppress stdout table; still writes the report.
  --share            Anonymized contribution snippet.
`;

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function fnv1a(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = arr[i]!;
        arr[i] = arr[j]!;
        arr[j] = tmp;
    }
    return arr;
}

// ---------------------------------------------------------------------------
// Question auto-generation
// ---------------------------------------------------------------------------

export type QuestionCategory =
    | 'nats-publishers'
    | 'nats-subscribers'
    | 'queue-producers'
    | 'queue-consumers'
    | 'table-users'
    | 'deps-of'
    | 'module-imports';

interface CategorySpec {
    kind: QuestionCategory;
    target: number;
    sourceLabel: string;
}

interface GeneratedQuestion {
    qid: string;
    category: QuestionCategory;
    sourceLabel: string;
    question: string;
    groundTruthLabels: string[];
}

function defaultMix(): CategorySpec[] {
    return [
        { kind: 'nats-publishers', target: 2, sourceLabel: 'NATS' },
        { kind: 'nats-subscribers', target: 1, sourceLabel: 'NATS' },
        { kind: 'queue-producers', target: 1, sourceLabel: 'BullMQ' },
        { kind: 'queue-consumers', target: 1, sourceLabel: 'BullMQ' },
        { kind: 'table-users', target: 2, sourceLabel: 'TypeORM' },
        { kind: 'deps-of', target: 2, sourceLabel: 'DI' },
        { kind: 'module-imports', target: 1, sourceLabel: 'cross-domain' },
    ];
}

function generateQuestions(graph: ArchGraph, targetCount: number, rng: () => number): GeneratedQuestion[] {
    const cursors = bucketCursors(graph, rng);
    const generated: GeneratedQuestion[] = [];
    const mix = defaultMix();
    const tryDraw = (spec: CategorySpec): boolean => {
        const q = drawQuestion(spec.kind, spec.sourceLabel, graph, cursors);
        if (q === null) return false;
        q.qid = `q${(generated.length + 1).toString().padStart(2, '0')}`;
        generated.push(q);
        return true;
    };
    for (const spec of mix) {
        for (let i = 0; i < spec.target && generated.length < targetCount; i++) {
            tryDraw(spec);
        }
    }
    let progress = true;
    while (generated.length < targetCount && progress) {
        progress = false;
        for (const spec of mix) {
            if (generated.length >= targetCount) break;
            if (tryDraw(spec)) progress = true;
        }
    }
    return generated;
}

function bucketCursors(graph: ArchGraph, rng: () => number): any {
    const subjectsWithPub = new Set<string>();
    const subjectsWithSub = new Set<string>();
    const queuesWithProd = new Set<string>();
    const queuesWithCons = new Set<string>();
    for (const e of graph.edges) {
        if (e.kind === 'nats-publish' || e.kind === 'nats-request') subjectsWithPub.add(e.to);
        else if (e.kind === 'nats-subscribe' || e.kind === 'nats-reply') subjectsWithSub.add(e.from);
        else if (e.kind === 'queue-produce') queuesWithProd.add(e.to);
        else if (e.kind === 'queue-consume') queuesWithCons.add(e.from);
    }
    const bucket = (predicate: (n: GraphNode) => boolean): GraphNode[] =>
        shuffleInPlace(graph.nodes.filter(predicate), rng);
    return {
        natsPublishers: { nodes: bucket((n) => n.kind === 'nats-subject' && subjectsWithPub.has(n.id)), cursor: 0 },
        natsSubscribers: { nodes: bucket((n) => n.kind === 'nats-subject' && subjectsWithSub.has(n.id)), cursor: 0 },
        queueProducers: { nodes: bucket((n) => n.kind === 'queue' && queuesWithProd.has(n.id)), cursor: 0 },
        queueConsumers: { nodes: bucket((n) => n.kind === 'queue' && queuesWithCons.has(n.id)), cursor: 0 },
        tables: { nodes: bucket((n) => n.kind === 'db-table'), cursor: 0 },
        services: { nodes: bucket((n) => n.kind === 'service'), cursor: 0 },
        modules: { nodes: bucket((n) => n.kind === 'module'), cursor: 0 },
    };
}

function drawQuestion(kind: QuestionCategory, sourceLabel: string, graph: ArchGraph, cursors: any): GeneratedQuestion | null {
    const pickCursor = () => {
        switch (kind) {
            case 'nats-publishers': return cursors.natsPublishers;
            case 'nats-subscribers': return cursors.natsSubscribers;
            case 'queue-producers': return cursors.queueProducers;
            case 'queue-consumers': return cursors.queueConsumers;
            case 'table-users': return cursors.tables;
            case 'deps-of': return cursors.services;
            case 'module-imports': return cursors.modules;
        }
    };
    const c = pickCursor();
    while (true) {
        if (c.cursor >= c.nodes.length) return null;
        const node = c.nodes[c.cursor++]!;
        const labels = labelsForQuestion(kind, node, graph);
        if (labels.length === 0) continue;
        const bare = stripPrefix(node.id);
        return { qid: '', category: kind, sourceLabel, question: phraseFor(kind, bare), groundTruthLabels: labels };
    }
}

function phraseFor(kind: QuestionCategory, bare: string): string {
    switch (kind) {
        case 'nats-publishers': return `Who publishes on \`${bare}\`?`;
        case 'nats-subscribers': return `Who subscribes to \`${bare}\`?`;
        case 'queue-producers': return `Who produces jobs onto \`${bare}\`?`;
        case 'queue-consumers': return `Who consumes \`${bare}\`?`;
        case 'table-users': return `Which services access \`${bare}\`?`;
        case 'deps-of': return `What does \`${bare}\` depend on?`;
        case 'module-imports': return `Which modules does \`${bare}\` import?`;
    }
}

function labelsForQuestion(kind: QuestionCategory, node: GraphNode, graph: ArchGraph): string[] {
    const bare = stripPrefix(node.id);
    const dedupe = (xs: string[]) => Array.from(new Set(xs.filter((x) => x.length > 0)));
    // EdgeAnswerList / ModuleImportResult are { found: false } | { sites/imports: ... }
    // discriminated unions; we narrow with `'sites' in r` rather than `if (r.found)`
    // because the function signature is `found?: never` on the populated branch.
    const sites = <T extends { found: false } | { sites: Array<{ owner: string }> }>(r: T): Array<{ owner: string }> =>
        'sites' in r ? r.sites : [];
    switch (kind) {
        case 'nats-publishers': return dedupe(sites(findPublishers(graph, bare)).map(s => stripPrefix(s.owner)));
        case 'nats-subscribers': return dedupe(sites(findSubscribers(graph, bare)).map(s => stripPrefix(s.owner)));
        case 'queue-producers': return dedupe(sites(findQueueProducers(graph, bare)).map(s => stripPrefix(s.owner)));
        case 'queue-consumers': return dedupe(sites(findQueueConsumers(graph, bare)).map(s => stripPrefix(s.owner)));
        case 'table-users': return dedupe(sites(tableUsers(graph, bare)).map(s => stripPrefix(s.owner)));
        case 'deps-of': {
            const r = serviceDependencies(graph, bare);
            if (!r.found) return [];
            const labels: string[] = [];
            for (const entries of Object.values(r.byKind)) for (const e of entries) labels.push(stripPrefix(e.counterpart));
            return dedupe(labels);
        }
        case 'module-imports': {
            const r = moduleImports(graph, bare);
            return 'imports' in r ? dedupe(r.imports) : [];
        }
    }
}

function recallSubstring(haystack: string, labels: string[]): number {
    if (labels.length === 0) return 1.0;
    const lower = haystack.toLowerCase();
    let matched = 0;
    for (const l of labels) if (lower.includes(l.toLowerCase())) matched++;
    return matched / labels.length;
}

interface PerQuestionResult {
    qid: string;
    category: QuestionCategory;
    sourceLabel: string;
    question: string;
    groundTruthLabels: string[];
    archTokens: number;
    archRecall: number;
    graphify: { tokens: number; recall: number } | null;
}

interface CompareReport {
    repoRoot: string;
    archBuildAt: string;
    archNodes: number;
    archEdges: number;
    archSizeBytes: number;
    archGraphPath: string;
    graphify: { path: string; nodes: number; edges: number; sizeBytes: number } | null;
    questions: GeneratedQuestion[];
    results: PerQuestionResult[];
    archGraph: ArchGraph;
}

function detectGraphify(cwd: string): { kind: string; autoloadedPath?: string } {
    const out1 = resolve(cwd, 'graphify-out', 'graph.json');
    if (existsSync(out1)) return { kind: 'autoloaded', autoloadedPath: out1 };
    const skillPath = join(homedir(), '.claude', 'skills', 'graphify', 'SKILL.md');
    if (existsSync(skillPath)) return { kind: 'installed-no-output' };
    if (platform() !== 'win32') {
        try {
            const r = spawnSync('which', ['graphify'], { stdio: 'pipe' });
            if (r.status === 0) return { kind: 'installed-no-output' };
        } catch {}
    }
    return { kind: 'not-installed' };
}

function openInBrowser(url: string): boolean {
    const plat = platform();
    let cmd: string;
    let argv: string[];
    if (plat === 'darwin') { cmd = 'open'; argv = [url]; }
    else if (plat === 'win32') { cmd = 'cmd'; argv = ['/c', 'start', '""', url]; }
    else { cmd = 'xdg-open'; argv = [url]; }
    try {
        const r = spawnSync(cmd, argv, { stdio: 'ignore' });
        return r.status === 0;
    } catch {
        return false;
    }
}

export async function runCompareCommand(args: CompareArgs): Promise<void> {
    const outDir = resolve(args.out);
    const archPath = resolve(outDir, 'graph.json');
    if (!existsSync(archPath)) {
        process.stderr.write(`error: cannot read arch-graph output at ${archPath}\n`);
        process.exit(1);
    }
    const archLoaded = await archGraphAdapter.load(archPath);
    const archGraph = archLoaded.raw as ArchGraph;
    const archCompact = archGraphAdapter.compact(archGraph);
    const archContext = archGraphAdapter.serialize(archCompact);
    const archSize = (await stat(archPath)).size;
    const rng = mulberry32(fnv1a(archGraph.buildAt ?? 'arch-graph-compare'));
    const questions = generateQuestions(archGraph, args.questions, rng);
    if (questions.length === 0) {
        process.stderr.write(`error: could not generate any questions\n`);
        process.exit(1);
    }

    let graphifyContext: string | null = null;
    let graphifyInfo: CompareReport['graphify'] = null;
    if (args.graphify || existsSync(resolve(process.cwd(), 'graphify-out/graph.json'))) {
        const gPath = args.graphify ? resolve(args.graphify) : resolve(process.cwd(), 'graphify-out/graph.json');
        try {
            const gLoaded = await graphifyAdapter.load(gPath);
            const gCompact = graphifyAdapter.compact(gLoaded.raw);
            graphifyContext = graphifyAdapter.serialize(gCompact);
            graphifyInfo = { path: gPath, nodes: gLoaded.nodeCount, edges: gLoaded.edgeCount, sizeBytes: (await stat(gPath)).size };
        } catch {}
    }

    try {
        const archTokens = countTokens(archContext);
        const graphifyTokens = graphifyContext ? countTokens(graphifyContext) : null;
        const results: PerQuestionResult[] = questions.map(q => ({
            qid: q.qid,
            category: q.category,
            sourceLabel: q.sourceLabel,
            question: q.question,
            groundTruthLabels: q.groundTruthLabels,
            archTokens,
            archRecall: recallSubstring(archContext, q.groundTruthLabels),
            graphify: graphifyContext && graphifyTokens ? { tokens: graphifyTokens, recall: recallSubstring(graphifyContext, q.groundTruthLabels) } : null,
        }));

        const report: CompareReport = {
            repoRoot: archGraph.root,
            archBuildAt: archGraph.buildAt ?? '',
            archNodes: archLoaded.nodeCount,
            archEdges: archLoaded.edgeCount,
            archSizeBytes: archSize,
            archGraphPath: archPath,
            graphify: graphifyInfo,
            questions,
            results,
            archGraph,
        };

        if (!args.quiet) {
            process.stdout.write(`\narch-graph compare — results:\n`);
            process.stdout.write(`  arch-graph: ${report.archNodes} nodes, ${report.archEdges} edges, ${Math.round(archTokens)} tokens avg\n`);
            if (report.graphify) process.stdout.write(`  graphify: ${report.graphify.nodes} nodes, ${report.graphify.edges} edges, ${Math.round(graphifyTokens ?? 0)} tokens avg\n`);
        }
    } finally {
        disposeTokens();
    }
}
