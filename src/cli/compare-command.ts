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
 *
 * Question auto-generation: we pull representative nodes from the user's
 * arch-graph graph (NATS subjects, queues, DB tables, services, modules) with a
 * seeded RNG so re-runs are reproducible. Ground-truth labels for each
 * question come directly from arch-graph's own query helpers (the same code
 * powering `arch-graph who-publishes` etc.) — arch-graph scores 100% by
 * construction; the comparison is "does graphify's context even contain those
 * answers?". The markdown report calls this out explicitly so the result isn't
 * mistaken for a rigged benchmark.
 */

import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';

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
        else if (a === '-h' || a === '--help') {
            process.stdout.write(COMPARE_HELP);
            process.exit(0);
        }
        // unknown flags are silently ignored to match the rest of the CLI
    }

    return { out, graphify, questions, report, quiet };
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
                     [--report <path>] [--quiet]

Options:
  --out <dir>        Directory with arch-graph's graph.json (default: ./arch-graph-out)
  --graphify <path>  Path to a graphify-out directory or graph.json file.
                     Omit for a graph-size-only summary (no recall comparison).
  --questions <n>    How many questions to auto-generate (default 10, max 20).
  --report <path>    Markdown report path (default <out>/compare-report.md).
  --quiet            Suppress stdout table; still writes the report.
`;

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — reproducible question selection across runs.
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

/**
 * Stable seed from a string (FNV-1a 32-bit). We feed `graph.buildAt` so the
 * same graph always picks the same questions, but different graphs vary.
 */
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
    /** How many we'd ideally generate. Quota is filled-best-effort + redistributed if short. */
    target: number;
    /** Pretty label for output. */
    sourceLabel: string;
}

interface GeneratedQuestion {
    qid: string;
    category: QuestionCategory;
    sourceLabel: string;
    question: string;
    /** The node id (with prefix, e.g. `nats:user.created`) used to drive the query. */
    nodeId: string;
    /** Bare name used for label substring matching (lowercased counterparts). */
    bareName: string;
    /** Substring labels that an LLM context must contain to "have the answer". */
    groundTruthLabels: string[];
}

/**
 * Default mix — tuned to the spec. We aim for "2-3 NATS + 2 BullMQ + 2 TypeORM
 * + 2 DI (deps-of) + 1 cross-domain (module-imports)" at the default count of 10.
 */
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

/**
 * Pick up to `n` questions from the graph with category-quota best-effort:
 *   - Iterate the mix in order, draw `target` nodes from each domain.
 *   - If a domain is empty (e.g. no queues), redistribute the deficit by
 *     looping again over the non-empty ones and topping them up until we
 *     reach `n` or all wells are dry.
 *
 * Each question only counts as "generatable" if the chosen node actually has
 * at least one answer in arch-graph (otherwise the bilateral comparison is
 * vacuous — both sides return zero hits and recall is trivially 0/0).
 */
function generateQuestions(
    graph: ArchGraph,
    targetCount: number,
    rng: () => number,
): GeneratedQuestion[] {
    // Bucket the candidate nodes by kind. We shuffle once and consume via a cursor
    // so repeated draws don't re-pick the same head element.
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

    // Pass 1: try to satisfy each category's `target` exactly.
    for (const spec of mix) {
        for (let i = 0; i < spec.target && generated.length < targetCount; i++) {
            tryDraw(spec);
        }
    }

    // Pass 2: redistribute slack — keep cycling through the mix until we fill
    // up to `targetCount` or every category runs dry. Bounded by total
    // candidate count, so it always terminates.
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

interface BucketCursors {
    natsPublishers: { nodes: GraphNode[]; cursor: number };
    natsSubscribers: { nodes: GraphNode[]; cursor: number };
    queueProducers: { nodes: GraphNode[]; cursor: number };
    queueConsumers: { nodes: GraphNode[]; cursor: number };
    tables: { nodes: GraphNode[]; cursor: number };
    services: { nodes: GraphNode[]; cursor: number };
    modules: { nodes: GraphNode[]; cursor: number };
}

/**
 * Pre-shuffle the candidate node pool per category, separately filtered to
 * "has at least one matching edge". Empty pools yield empty buckets — callers
 * handle the deficit by category-redistribution.
 *
 * NATS publishers/subscribers and queue producers/consumers use different
 * filters (subjects with at least one publish edge vs. at least one subscribe
 * edge), so each gets its own bucket.
 */
function bucketCursors(graph: ArchGraph, rng: () => number): BucketCursors {
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

type Cursor = { nodes: GraphNode[]; cursor: number };

function nextNode(c: Cursor): GraphNode | null {
    if (c.cursor >= c.nodes.length) return null;
    return c.nodes[c.cursor++]!;
}

/**
 * Draw the next question for a category. Returns null if the bucket is empty
 * OR every remaining candidate yields zero ground-truth labels (no
 * publishers / subscribers / accessors / dependencies in the graph). We keep
 * pulling from the same cursor until we find one with ≥1 label or run out.
 */
function drawQuestion(
    kind: QuestionCategory,
    sourceLabel: string,
    graph: ArchGraph,
    cursors: BucketCursors,
): GeneratedQuestion | null {
    const pickCursor = (): Cursor => {
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

    // Keep advancing until we find a node with non-empty labels.
    while (true) {
        const node = nextNode(c);
        if (node === null) return null;
        const labels = labelsForQuestion(kind, node, graph);
        if (labels.length === 0) continue;
        const bare = stripPrefix(node.id);
        return {
            qid: '',
            category: kind,
            sourceLabel,
            question: phraseFor(kind, bare),
            nodeId: node.id,
            bareName: bare,
            groundTruthLabels: labels,
        };
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

/**
 * Run the arch-graph query for `kind` against `node` and return the substring
 * labels we expect any LLM-friendly context to contain.
 *
 * For edge-listing queries (NATS/queue/table) the labels are the deduped
 * `owner` bare names (services that publish/subscribe/produce/consume/access).
 * For `deps-of` the labels are dep counterparts (services and libs).
 * For `module-imports` the labels are the first-level imported module names.
 */
function labelsForQuestion(
    kind: QuestionCategory,
    node: GraphNode,
    graph: ArchGraph,
): string[] {
    const bare = stripPrefix(node.id);
    const dedupe = (xs: string[]): string[] => Array.from(new Set(xs.filter((x) => x.length > 0)));

    switch (kind) {
        case 'nats-publishers': {
            const r = findPublishers(graph, bare);
            return r.found ? dedupe(r.sites.map((s) => stripPrefix(s.owner))) : [];
        }
        case 'nats-subscribers': {
            const r = findSubscribers(graph, bare);
            return r.found ? dedupe(r.sites.map((s) => stripPrefix(s.owner))) : [];
        }
        case 'queue-producers': {
            const r = findQueueProducers(graph, bare);
            return r.found ? dedupe(r.sites.map((s) => stripPrefix(s.owner))) : [];
        }
        case 'queue-consumers': {
            const r = findQueueConsumers(graph, bare);
            return r.found ? dedupe(r.sites.map((s) => stripPrefix(s.owner))) : [];
        }
        case 'table-users': {
            const r = tableUsers(graph, bare);
            return r.found ? dedupe(r.sites.map((s) => stripPrefix(s.owner))) : [];
        }
        case 'deps-of': {
            const r = serviceDependencies(graph, bare);
            return r.found ? dedupe(flattenDeps(r).map(stripPrefix)) : [];
        }
        case 'module-imports': {
            const r = moduleImports(graph, bare);
            return r.found ? dedupe(r.imports) : [];
        }
    }
}

function flattenDeps(r: Extract<GroupedDeps, { found: true }>): string[] {
    const out: string[] = [];
    for (const entries of Object.values(r.byKind)) {
        for (const e of entries) out.push(e.counterpart);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Substring-presence scoring (matches bench/bench.ts:scorePR exactly).
// ---------------------------------------------------------------------------

interface Score {
    recall: number;
    matched: string[];
    missed: string[];
}

function scoreSubstring(haystack: string, labels: string[]): Score {
    const lower = haystack.toLowerCase();
    const matched: string[] = [];
    const missed: string[] = [];
    for (const l of labels) {
        if (lower.includes(l.toLowerCase())) matched.push(l);
        else missed.push(l);
    }
    const recall = labels.length === 0 ? 1.0 : matched.length / labels.length;
    return { recall, matched, missed };
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface PerQuestionResult {
    qid: string;
    category: QuestionCategory;
    sourceLabel: string;
    question: string;
    bareName: string;
    groundTruthLabels: string[];
    archTokens: number;
    archRecall: number;
    graphifyTokens: number | null;
    graphifyRecall: number | null;
}

interface CompareReport {
    repoRoot: string;
    archBuildAt: string;
    archNodes: number;
    archEdges: number;
    archSizeBytes: number;
    archGraphPath: string;
    graphifyPath: string | null;
    graphifyNodes: number | null;
    graphifyEdges: number | null;
    graphifySizeBytes: number | null;
    questions: GeneratedQuestion[];
    results: PerQuestionResult[];
}

// ---------------------------------------------------------------------------
// Graphify path resolution (the CLI form differs from the bench adapter's
// auto-discovery — here the user hands us a path; we resolve it.)
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied `--graphify` argument to a concrete graph.json file
 * path. We accept three forms:
 *   - a directory containing `graph.json`
 *   - a path to a `.json` file (used as-is)
 *   - a path to a directory that *is* `graphify-out/` itself
 *
 * Returns the absolute path, or throws an Error with a user-friendly message.
 */
function resolveGraphifyPath(input: string): string {
    const abs = resolve(input);
    if (!existsSync(abs)) {
        throw new Error(
            `--graphify path not found: ${abs}\n  ` +
            `Pass either the graphify-out directory or graph.json directly.`,
        );
    }
    const st = statSync(abs);
    if (st.isFile()) return abs;
    if (st.isDirectory()) {
        const candidate = resolve(abs, 'graph.json');
        if (existsSync(candidate)) return candidate;
        // Maybe they pointed at the parent — try /graphify-out/graph.json one level in.
        const nested = resolve(abs, 'graphify-out', 'graph.json');
        if (existsSync(nested)) return nested;
        throw new Error(
            `--graphify directory does not contain graph.json: ${abs}\n  ` +
            `Looked in: ${candidate} and ${nested}`,
        );
    }
    throw new Error(`--graphify path is neither a file nor a directory: ${abs}`);
}

// ---------------------------------------------------------------------------
// Stdout formatting
// ---------------------------------------------------------------------------

function fmtNumber(n: number): string {
    return n.toLocaleString('en-US');
}

function fmtPct(n: number | null): string {
    if (n === null || Number.isNaN(n)) return '—';
    return `${Math.round(n * 100)}%`;
}

function fmtBytes(n: number | null): string {
    if (n === null) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtRatio(arch: number, graphify: number, suffix: string): string {
    if (arch === 0 || graphify === 0) return '—';
    const ratio = graphify / arch;
    if (Number.isNaN(ratio)) return '—';
    return `${ratio.toFixed(1)}× ${suffix}`;
}

function categoryCounts(results: PerQuestionResult[]): string {
    const counts = new Map<string, number>();
    for (const r of results) counts.set(r.sourceLabel, (counts.get(r.sourceLabel) ?? 0) + 1);
    return Array.from(counts.entries()).map(([k, v]) => `${v} ${k}`).join(' · ');
}

function meanNumber(xs: number[]): number {
    if (xs.length === 0) return 0;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runCompareCommand(args: CompareArgs): Promise<void> {
    const outDir = resolve(args.out);
    const archPath = resolve(outDir, 'graph.json');

    if (!existsSync(archPath)) {
        process.stderr.write(
            `error: cannot read arch-graph output at ${archPath}\n  ` +
            `Run 'arch-graph build' first.\n`,
        );
        process.exit(1);
    }

    // Load arch-graph
    const archLoaded = await archGraphAdapter.load(archPath);
    const archGraph = archLoaded.raw as ArchGraph;
    const archCompact = archGraphAdapter.compact(archGraph);
    const archContext = archGraphAdapter.serialize(archCompact);
    const archSize = (await stat(archPath)).size;

    // Generate questions
    const seedSeed = archGraph.buildAt ?? '';
    const seed = fnv1a(seedSeed || 'arch-graph-compare');
    const rng = mulberry32(seed);
    const questions = generateQuestions(archGraph, args.questions, rng);

    if (questions.length === 0) {
        process.stderr.write(
            `error: could not generate any questions from ${archPath}\n  ` +
            `The graph appears empty (no NATS subjects, queues, tables, services, or modules).\n`,
        );
        process.exit(1);
    }
    if (questions.length < Math.min(5, args.questions)) {
        process.stderr.write(
            `warning: only generated ${questions.length} question(s) (requested ${args.questions}). ` +
            `Graph is too small for a representative comparison.\n`,
        );
    } else if (questions.length < args.questions) {
        process.stderr.write(
            `note: generated ${questions.length}/${args.questions} questions ` +
            `(some domains exhausted before reaching the target).\n`,
        );
    }

    // Resolve graphify if requested
    let graphifyPath: string | null = null;
    let graphifyContext: string | null = null;
    let graphifyNodes: number | null = null;
    let graphifyEdges: number | null = null;
    let graphifySize: number | null = null;
    if (args.graphify !== undefined) {
        try {
            graphifyPath = resolveGraphifyPath(args.graphify);
        } catch (err) {
            process.stderr.write(`error: ${(err as Error).message}\n`);
            process.exit(1);
        }
        const gLoaded = await graphifyAdapter.load(graphifyPath);
        const gCompact = graphifyAdapter.compact(gLoaded.raw);
        graphifyContext = graphifyAdapter.serialize(gCompact);
        graphifyNodes = gLoaded.nodeCount;
        graphifyEdges = gLoaded.edgeCount;
        graphifySize = (await stat(graphifyPath)).size;
    }

    // Token-count the contexts (one count each, reused across questions)
    const archTokens = countTokens(archContext);
    const graphifyTokens = graphifyContext === null ? null : countTokens(graphifyContext);

    // Score per question
    const results: PerQuestionResult[] = questions.map((q) => {
        const archS = scoreSubstring(archContext, q.groundTruthLabels);
        let gTokens: number | null = null;
        let gRecall: number | null = null;
        if (graphifyContext !== null) {
            gTokens = graphifyTokens;
            gRecall = scoreSubstring(graphifyContext, q.groundTruthLabels).recall;
        }
        return {
            qid: q.qid,
            category: q.category,
            sourceLabel: q.sourceLabel,
            question: q.question,
            bareName: q.bareName,
            groundTruthLabels: q.groundTruthLabels,
            archTokens,
            archRecall: archS.recall,
            graphifyTokens: gTokens,
            graphifyRecall: gRecall,
        };
    });

    const report: CompareReport = {
        repoRoot: archGraph.root,
        archBuildAt: archGraph.buildAt,
        archNodes: archLoaded.nodeCount,
        archEdges: archLoaded.edgeCount,
        archSizeBytes: archSize,
        archGraphPath: archPath,
        graphifyPath,
        graphifyNodes,
        graphifyEdges,
        graphifySizeBytes: graphifySize,
        questions,
        results,
    };

    // stdout (unless quiet)
    if (!args.quiet) {
        printStdout(report);
    }

    // markdown report
    const reportPath = args.report ? resolve(args.report) : resolve(outDir, 'compare-report.md');
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, renderMarkdown(report), 'utf8');
    if (!args.quiet) {
        process.stdout.write(`\nDetailed report → ${reportPath}\n`);
    }

    disposeTokens();
}

// ---------------------------------------------------------------------------
// stdout rendering
// ---------------------------------------------------------------------------

function printStdout(rep: CompareReport): void {
    if (rep.graphifyPath === null) {
        // Size-only mode
        const totalTok = rep.results.length > 0 ? rep.results[0]!.archTokens : 0;
        process.stdout.write(`\narch-graph compare — graph size analysis (no graphify comparison)\n\n`);
        process.stdout.write(`Your arch-graph graph:\n`);
        process.stdout.write(`  ${rep.archNodes} nodes · ${rep.archEdges} edges · ${fmtBytes(rep.archSizeBytes)}\n`);
        process.stdout.write(`  Estimated context tokens (compact graph): ${fmtNumber(totalTok)}\n`);
        process.stdout.write(`  Generated ${rep.results.length} question(s): ${categoryCounts(rep.results)}\n`);
        process.stdout.write(`\nTo compare against graphify:\n`);
        process.stdout.write(`  1. Generate graphify output for this repo:  /graphify ${rep.repoRoot}\n`);
        process.stdout.write(`  2. Re-run:  arch-graph compare --graphify <path/to/graphify-out>\n`);
        return;
    }

    // Head-to-head mode
    const archAvg = meanNumber(rep.results.map((r) => r.archTokens));
    const gAvg = meanNumber(rep.results.map((r) => r.graphifyTokens ?? 0));
    const archRecall = meanNumber(rep.results.map((r) => r.archRecall));
    const gRecall = meanNumber(rep.results.map((r) => r.graphifyRecall ?? 0));
    const archTotal = rep.results.reduce((a, r) => a + r.archTokens, 0);
    const gTotal = rep.results.reduce((a, r) => a + (r.graphifyTokens ?? 0), 0);

    process.stdout.write(`\narch-graph compare — your repo vs your graphify\n\n`);
    process.stdout.write(
        `Generated ${rep.results.length} question(s) auto-derived from ${rep.archGraphPath}:\n` +
        `  ${categoryCounts(rep.results)}\n\n`,
    );

    // Plain-text table
    const COL_LABEL = 32;
    const COL_NUM = 14;
    const COL_NUM2 = 14;
    const COL_RATIO = 12;
    const header =
        ''.padEnd(COL_LABEL) +
        'arch-graph'.padStart(COL_NUM) +
        'graphify'.padStart(COL_NUM2) +
        'ratio'.padStart(COL_RATIO);
    const sep = '─'.repeat(COL_LABEL + COL_NUM + COL_NUM2 + COL_RATIO);
    process.stdout.write(`${header}\n${sep}\n`);

    const row = (label: string, a: string, g: string, r: string): void => {
        process.stdout.write(
            label.padEnd(COL_LABEL) +
            a.padStart(COL_NUM) +
            g.padStart(COL_NUM2) +
            r.padStart(COL_RATIO) +
            '\n',
        );
    };

    row(
        'Avg tokens per question',
        fmtNumber(Math.round(archAvg)),
        fmtNumber(Math.round(gAvg)),
        archAvg > 0 && gAvg > 0 ? fmtRatio(archAvg, gAvg, 'more') : '—',
    );
    row(
        'Mean recall (substring)',
        fmtPct(archRecall),
        fmtPct(gRecall),
        archRecall > 0 && gRecall > 0 ? `${(archRecall / gRecall).toFixed(1)}× higher` : '—',
    );
    row(
        `Σ per-Q tokens · ${rep.results.length} q`,
        fmtNumber(archTotal),
        fmtNumber(gTotal),
        '—',
    );
    process.stdout.write(`  (context loaded once per session; sum shows cumulative if reloaded per Q)\n`);
    row('Build cost', 'deterministic', 'LLM-driven', '—');
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderMarkdown(rep: CompareReport): string {
    const repoName = rep.repoRoot ? basename(rep.repoRoot) : 'your repo';
    const date = new Date().toISOString().slice(0, 10);

    const head: string[] = [
        `# arch-graph compare — ${repoName} vs graphify`,
        ``,
        `_Generated: ${date}_`,
        ``,
        `## Setup`,
        `- Repo: \`${rep.repoRoot}\``,
        `- arch-graph: built at ${rep.archBuildAt}, ${rep.archNodes} nodes / ${rep.archEdges} edges (${fmtBytes(rep.archSizeBytes)})`,
        rep.graphifyPath
            ? `- graphify:   \`${rep.graphifyPath}\` — ${rep.graphifyNodes} nodes / ${rep.graphifyEdges} edges (${fmtBytes(rep.graphifySizeBytes)})`
            : `- graphify:   _not provided — run \`/graphify ${rep.repoRoot}\` and rerun \`arch-graph compare --graphify ...\` for a head-to-head._`,
        ``,
        `## How we score`,
        ``,
        `Questions are auto-derived from real nodes in your arch-graph (NATS subjects, queues, DB tables, services, modules), with answers computed by the same in-process query helpers that power \`arch-graph who-publishes\`, etc. Each question carries a list of **ground-truth labels** — the bare names of services/libs/modules that arch-graph's query returns.`,
        ``,
        `We then ask: **does each tool's compact-graph context (when handed to an LLM) contain those labels as substrings?** Recall = fraction of labels present. This is a permissive measure — it captures "could an LLM even find this answer in the context" rather than "did the LLM correctly extract it".`,
        ``,
        `Because the labels come from arch-graph's own answer, arch-graph scores **100% by construction**. The interesting axis is graphify's recall on the same labels: even with vastly more tokens, did it surface the same architecture facts? Token counts use OpenAI's \`cl100k_base\` encoding (the gpt-4 / gpt-3.5-turbo / gpt-4-turbo encoding) via \`@dqbd/tiktoken\`.`,
        ``,
    ];

    // Per-question table
    const perQHeader = rep.graphifyPath
        ? '| qid | category | source | arch tokens | arch recall | graphify tokens | graphify recall |'
        : '| qid | category | source | arch tokens | arch recall |';
    const perQSep = rep.graphifyPath
        ? '|---|---|---|---:|---:|---:|---:|'
        : '|---|---|---|---:|---:|';
    const perQRows = rep.results.map((r) => {
        if (rep.graphifyPath) {
            return `| ${r.qid} | ${r.category} | ${r.sourceLabel} | ${fmtNumber(r.archTokens)} | ${fmtPct(r.archRecall)} | ${fmtNumber(r.graphifyTokens ?? 0)} | ${fmtPct(r.graphifyRecall)} |`;
        }
        return `| ${r.qid} | ${r.category} | ${r.sourceLabel} | ${fmtNumber(r.archTokens)} | ${fmtPct(r.archRecall)} |`;
    });

    const perQ = [
        `## Per-question results`,
        ``,
        `_Token counts are constant across rows because the compact-graph context is built once per repo and reused across all questions (the LLM loads it once per session). Recall varies because each question scores against its own ground-truth labels._`,
        ``,
        perQHeader,
        perQSep,
        ...perQRows,
        ``,
    ];

    // Aggregate
    const archAvg = meanNumber(rep.results.map((r) => r.archTokens));
    const archRecall = meanNumber(rep.results.map((r) => r.archRecall));
    const archTotal = rep.results.reduce((a, r) => a + r.archTokens, 0);
    const aggLines: string[] = [`## Aggregate`, ``];
    if (rep.graphifyPath) {
        const gAvg = meanNumber(rep.results.map((r) => r.graphifyTokens ?? 0));
        const gRecall = meanNumber(rep.results.map((r) => r.graphifyRecall ?? 0));
        const gTotal = rep.results.reduce((a, r) => a + (r.graphifyTokens ?? 0), 0);
        aggLines.push(
            `| metric | arch-graph | graphify | ratio |`,
            `|---|---:|---:|---:|`,
            `| Avg tokens per question | ${fmtNumber(Math.round(archAvg))} | ${fmtNumber(Math.round(gAvg))} | ${archAvg > 0 && gAvg > 0 ? fmtRatio(archAvg, gAvg, 'more') : '—'} |`,
            `| Mean recall (substring) | ${fmtPct(archRecall)} | ${fmtPct(gRecall)} | ${archRecall > 0 && gRecall > 0 ? `${(archRecall / gRecall).toFixed(1)}× higher` : '—'} |`,
            `| Σ per-Q tokens (${rep.results.length} questions, context reloaded per Q) | ${fmtNumber(archTotal)} | ${fmtNumber(gTotal)} | — |`,
            `| Build cost | deterministic | LLM-driven (subagents) | — |`,
            ``,
        );
    } else {
        aggLines.push(
            `| metric | arch-graph |`,
            `|---|---:|`,
            `| Compact-graph context tokens | ${fmtNumber(Math.round(archAvg))} |`,
            `| Mean recall on auto-generated questions | ${fmtPct(archRecall)} |`,
            `| Total questions generated | ${rep.results.length} |`,
            ``,
            `> graphify column is unavailable — pass \`--graphify <path>\` to get a head-to-head.`,
            ``,
        );
    }

    // Reproducing section
    const reproLines: string[] = [`## Reproducing`, ``, `The same seeded question set is regenerated whenever you re-run on the same graph.json (seeded on \`graph.buildAt\`). The questions used in this run were:`, ``];
    for (const q of rep.questions) {
        reproLines.push(`- **${q.qid}** (${q.category}): ${q.question}`);
        reproLines.push(`  - ground-truth labels: ${q.groundTruthLabels.map((l) => `\`${l}\``).join(', ') || '_(none)_'}`);
    }
    reproLines.push(``);

    return [...head, ...perQ, ...aggLines, ...reproLines].join('\n');
}

