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
        // unknown flags are silently ignored to match the rest of the CLI
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
                     If omitted, we auto-detect ./graphify-out/ in the current dir.
                     Without graphify, you get a graph-size-only summary.
  --questions <n>    How many questions to auto-generate (default 10, max 20).
  --report <path>    Markdown report path (default <out>/compare-report.md).
  --quiet            Suppress stdout table; still writes the report.
  --share            After comparing, generate an anonymized markdown snippet
                     (counts only — no project/subject/queue names) and open a
                     GitHub Discussion draft to contribute it to the public
                     multi-repo benchmark.
  --share-yes        With --share: skip the confirmation prompt.
  --share-no-open    With --share: print the URL instead of opening a browser.
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
// Substring-presence scoring (matches the recall arm of `bench/bench.ts:scorePR`).
// We don't need precision/matched/missed for the CLI report — recall is the
// only axis surfaced — so this is the trimmed version.
// ---------------------------------------------------------------------------

function recallSubstring(haystack: string, labels: string[]): number {
    if (labels.length === 0) return 1.0;
    const lower = haystack.toLowerCase();
    let matched = 0;
    for (const l of labels) {
        if (lower.includes(l.toLowerCase())) matched++;
    }
    return matched / labels.length;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * Per-question scoring result. Graphify fields are jointly present-or-null —
 * bundled into a nested struct so they can't drift apart structurally (the
 * same DU refactor `bench/bench.ts:GraphifyQuestionResult` got, for the same
 * reason).
 */
interface PerQuestionResult {
    qid: string;
    category: QuestionCategory;
    sourceLabel: string;
    question: string;
    groundTruthLabels: string[];
    archTokens: number;
    archRecall: number;
    /** `null` when --graphify wasn't passed. */
    graphify: { tokens: number; recall: number } | null;
}

/** Bundled graphify metadata. `null` when --graphify wasn't passed. */
interface GraphifyInfo {
    path: string;
    nodes: number;
    edges: number;
    sizeBytes: number;
}

interface CompareReport {
    repoRoot: string;
    archBuildAt: string;
    archNodes: number;
    archEdges: number;
    archSizeBytes: number;
    archGraphPath: string;
    /** Jointly present-or-null with all graphify fields below. */
    graphify: GraphifyInfo | null;
    /** True if we discovered graphify-out/ without `--graphify` being passed. */
    graphifyAutoDetected: boolean;
    /** Set when graphify is null, to drive the post-run hint. */
    detect: GraphifyAutoDetect | null;
    questions: GeneratedQuestion[];
    results: PerQuestionResult[];
    /** Loaded once for the --share contributor snippet. */
    archGraph: ArchGraph;
}

// ---------------------------------------------------------------------------
// Graphify auto-detection
//
// We try three increasingly indirect signals to make the "no --graphify"
// path friendlier:
//   1. `<cwd>/graphify-out/graph.json` exists → autoload it and continue
//      with a full head-to-head (printing a tiny note that we did so).
//   2. Either `~/.claude/skills/graphify/SKILL.md` exists or `which graphify`
//      resolves → graphify is *installed* but produced no output here. Tell
//      the user to run `/graphify .` and re-run.
//   3. Neither → friendly install hint (skill name + repo URL).
//
// The detection result is one discriminated union so callers can branch
// on the kind once, without re-checking the filesystem.
// ---------------------------------------------------------------------------

interface GraphifyAutoDetect {
    /**
     * `autoloaded`: we found an output and will use it.
     * `installed-no-output`: graphify is available but produced nothing here.
     * `not-installed`: no signal of graphify anywhere on this machine.
     */
    kind: 'autoloaded' | 'installed-no-output' | 'not-installed';
    /** Set only when kind === 'autoloaded'. Always absolute. */
    autoloadedPath?: string;
}

function detectGraphify(cwd: string): GraphifyAutoDetect {
    // Signal 1: graphify-out next to where the user ran the command.
    const out1 = resolve(cwd, 'graphify-out', 'graph.json');
    if (existsSync(out1)) {
        return { kind: 'autoloaded', autoloadedPath: out1 };
    }

    // Signal 2a: Claude Code skill installed globally.
    const skillPath = join(homedir(), '.claude', 'skills', 'graphify', 'SKILL.md');
    const skillInstalled = existsSync(skillPath);

    // Signal 2b: standalone CLI on PATH. `which` doesn't exist on Windows; we
    // spawn-pipe so a missing binary is a clean failure (status !== 0), not a
    // shell-escape risk. We don't *use* the path — only the boolean.
    let cliInstalled = false;
    if (platform() !== 'win32') {
        try {
            const r = spawnSync('which', ['graphify'], { stdio: 'pipe' });
            cliInstalled = r.status === 0;
        } catch {
            cliInstalled = false;
        }
    }

    if (skillInstalled || cliInstalled) {
        return { kind: 'installed-no-output' };
    }
    return { kind: 'not-installed' };
}

function printGraphifyHint(detect: GraphifyAutoDetect, cwd: string): void {
    if (detect.kind === 'installed-no-output') {
        process.stdout.write(
            `\ngraphify is installed but no output found here.\n` +
            `  Run \`/graphify .\` in Claude Code, then re-run \`arch-graph compare\`.\n`,
        );
        return;
    }
    // 'not-installed' — full install hint.
    process.stdout.write(
        `\ngraphify not detected. Without it, only graph-size analysis is available.\n\n` +
        `To install graphify (a Claude Code skill):\n` +
        `  1. In Claude Code, type: /skill install graphify\n` +
        `  2. Or: see https://github.com/safishamsi/graphify\n` +
        `Then run on your repo:\n` +
        `  /graphify ${cwd}\n` +
        `  arch-graph compare --graphify graphify-out/\n`,
    );
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

    // Resolve graphify: either explicit `--graphify <path>`, or auto-detect
    // `<cwd>/graphify-out/graph.json`. Auto-detection is silent on success
    // (we print a small notice in `printStdout`) and falls back to a
    // friendlier hint when nothing's available.
    let graphifyContext: string | null = null;
    let graphify: GraphifyInfo | null = null;
    let graphifyAutoDetected = false;
    let detect: GraphifyAutoDetect | null = null;

    let effectiveGraphifyPath: string | undefined = args.graphify;
    if (effectiveGraphifyPath === undefined) {
        detect = detectGraphify(process.cwd());
        if (detect.kind === 'autoloaded' && detect.autoloadedPath) {
            effectiveGraphifyPath = detect.autoloadedPath;
            graphifyAutoDetected = true;
        }
    }

    if (effectiveGraphifyPath !== undefined) {
        try {
            const resolvedPath = resolveGraphifyPath(effectiveGraphifyPath);
            const gLoaded = await graphifyAdapter.load(resolvedPath);
            const gCompact = graphifyAdapter.compact(gLoaded.raw);
            graphifyContext = graphifyAdapter.serialize(gCompact);
            const gStat = await stat(resolvedPath);
            graphify = {
                path: resolvedPath,
                nodes: gLoaded.nodeCount,
                edges: gLoaded.edgeCount,
                sizeBytes: gStat.size,
            };
        } catch (err) {
            process.stderr.write(`error: failed to load graphify graph: ${(err as Error).message}\n`);
            process.exit(1);
        }
    }

    // Token-count the contexts (one count each, reused across questions).
    // Wrap the tokenizer + report write in try/finally so the wasm-backed
    // encoder is released even if rendering throws downstream.
    try {
        const archTokens = countTokens(archContext);
        const graphifyTokens = graphifyContext === null ? null : countTokens(graphifyContext);

        // Score per question
        const results: PerQuestionResult[] = questions.map((q) => {
            const archRecall = recallSubstring(archContext, q.groundTruthLabels);
            const gResult =
                graphifyContext !== null && graphifyTokens !== null
                    ? {
                          tokens: graphifyTokens,
                          recall: recallSubstring(graphifyContext, q.groundTruthLabels),
                      }
                    : null;
            return {
                qid: q.qid,
                category: q.category,
                sourceLabel: q.sourceLabel,
                question: q.question,
                groundTruthLabels: q.groundTruthLabels,
                archTokens,
                archRecall,
                graphify: gResult,
            };
        });

        const report: CompareReport = {
            repoRoot: archGraph.root,
            archBuildAt: archGraph.buildAt,
            archNodes: archLoaded.nodeCount,
            archEdges: archLoaded.edgeCount,
            archSizeBytes: archSize,
            archGraphPath: archPath,
            graphify,
            graphifyAutoDetected,
            detect,
            questions,
            results,
            archGraph,
        };

        if (!args.quiet) {
            printStdout(report);
        }

        const reportPath = args.report ? resolve(args.report) : resolve(outDir, 'compare-report.md');
        await mkdir(dirname(reportPath), { recursive: true });
        await writeFile(reportPath, renderMarkdown(report), 'utf8');
        if (!args.quiet) {
            process.stdout.write(`\nDetailed report → ${reportPath}\n`);
        }

        if (args.share) {
            await runShareFlow(report, args);
        }
    } finally {
        disposeTokens();
    }
}

// ---------------------------------------------------------------------------
// stdout rendering
// ---------------------------------------------------------------------------

function printStdout(rep: CompareReport): void {
    if (rep.graphify === null) {
        // Size-only mode — pick a friendlier hint based on what's available.
        const totalTok = rep.results.length > 0 ? rep.results[0]!.archTokens : 0;
        process.stdout.write(`\narch-graph compare — graph size analysis (no graphify comparison)\n\n`);
        process.stdout.write(`Your arch-graph graph:\n`);
        process.stdout.write(`  ${rep.archNodes} nodes · ${rep.archEdges} edges · ${fmtBytes(rep.archSizeBytes)}\n`);
        process.stdout.write(`  Estimated context tokens (compact graph): ${fmtNumber(totalTok)}\n`);
        process.stdout.write(`  Generated ${rep.results.length} question(s): ${categoryCounts(rep.results)}\n`);
        if (rep.detect !== null) {
            printGraphifyHint(rep.detect, process.cwd());
        }
        return;
    }

    // Head-to-head mode — every result row carries a non-null `graphify` field
    // because we're here only when the report-level `graphify` is set, and the
    // two are produced together in one branch above.
    if (rep.graphifyAutoDetected) {
        process.stdout.write(
            `\n(auto-detected graphify-out/ — pass \`--graphify <path>\` to override)\n`,
        );
    }
    const archAvg = meanNumber(rep.results.map((r) => r.archTokens));
    const gAvg = meanNumber(rep.results.map((r) => r.graphify?.tokens ?? 0));
    const archRecall = meanNumber(rep.results.map((r) => r.archRecall));
    const gRecall = meanNumber(rep.results.map((r) => r.graphify?.recall ?? 0));
    const archTotal = rep.results.reduce((a, r) => a + r.archTokens, 0);
    const gTotal = rep.results.reduce((a, r) => a + (r.graphify?.tokens ?? 0), 0);

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
        rep.graphify !== null
            ? `- graphify:   \`${rep.graphify.path}\` — ${rep.graphify.nodes} nodes / ${rep.graphify.edges} edges (${fmtBytes(rep.graphify.sizeBytes)})`
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
    const hasGraphify = rep.graphify !== null;
    const perQHeader = hasGraphify
        ? '| qid | category | source | arch tokens | arch recall | graphify tokens | graphify recall |'
        : '| qid | category | source | arch tokens | arch recall |';
    const perQSep = hasGraphify
        ? '|---|---|---|---:|---:|---:|---:|'
        : '|---|---|---|---:|---:|';
    const perQRows = rep.results.map((r) => {
        if (hasGraphify) {
            return `| ${r.qid} | ${r.category} | ${r.sourceLabel} | ${fmtNumber(r.archTokens)} | ${fmtPct(r.archRecall)} | ${fmtNumber(r.graphify?.tokens ?? 0)} | ${fmtPct(r.graphify?.recall ?? null)} |`;
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
    if (rep.graphify !== null) {
        const gAvg = meanNumber(rep.results.map((r) => r.graphify?.tokens ?? 0));
        const gRecall = meanNumber(rep.results.map((r) => r.graphify?.recall ?? 0));
        const gTotal = rep.results.reduce((a, r) => a + (r.graphify?.tokens ?? 0), 0);
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

// ---------------------------------------------------------------------------
// --share flow
//
// Builds a **strictly allowlisted** anonymized markdown snippet (no project
// path, no node IDs, no question text, no ground-truth labels) and either
// opens a GitHub Discussion draft URL pre-filled with it, or prints the URL
// for manual paste.
//
// CRITICAL: this snippet is intended to be made public. Anything that isn't
// in the allowlist below must NOT leak into the output. We build it from
// scratch (not by stripping the existing markdown report) so additions to
// the report can't accidentally leak into share. `assertAnonymized()` at the
// end is a defense-in-depth check against future drift.
// ---------------------------------------------------------------------------

const SHARE_DISCUSSION_URL =
    'https://github.com/roman-dubovik/arch-graph/discussions/new?category=benchmark-contributions';

interface ShareSnippet {
    markdown: string;
    title: string;
}

async function buildShareSnippet(rep: CompareReport): Promise<ShareSnippet> {
    const date = new Date().toISOString().slice(0, 10);
    const version = await readArchGraphVersion();

    // Per-edge-kind counts. EdgeKind values are TYPE NAMES (`nats-publish`,
    // `queue-produce`, etc.), not user data — safe to include.
    const edgeKindCounts = new Map<string, number>();
    for (const e of rep.archGraph.edges) {
        edgeKindCounts.set(e.kind, (edgeKindCounts.get(e.kind) ?? 0) + 1);
    }
    // Per-node-kind counts. NodeKind values are TYPE NAMES (`nats-subject`,
    // `queue`, `db-table`, `service`, `module`, `lib`), not user data.
    const nodeKindCounts = new Map<string, number>();
    for (const n of rep.archGraph.nodes) {
        nodeKindCounts.set(n.kind, (nodeKindCounts.get(n.kind) ?? 0) + 1);
    }

    // Aggregate tokens / recall (totals + averages — never per-question text).
    const archAvg = Math.round(meanNumber(rep.results.map((r) => r.archTokens)));
    const archRecall = meanNumber(rep.results.map((r) => r.archRecall));
    const archTotal = rep.results.reduce((a, r) => a + r.archTokens, 0);
    const hasGraphify = rep.graphify !== null;
    const gAvg = hasGraphify
        ? Math.round(meanNumber(rep.results.map((r) => r.graphify?.tokens ?? 0)))
        : 0;
    const gRecall = hasGraphify
        ? meanNumber(rep.results.map((r) => r.graphify?.recall ?? 0))
        : 0;
    const gTotal = hasGraphify
        ? rep.results.reduce((a, r) => a + (r.graphify?.tokens ?? 0), 0)
        : 0;

    // Per-CATEGORY recall (e.g. NATS / BullMQ / TypeORM / DI / cross-domain).
    // Category labels are types, not user data.
    const byCategory = new Map<string, PerQuestionResult[]>();
    for (const r of rep.results) {
        const list = byCategory.get(r.sourceLabel) ?? [];
        list.push(r);
        byCategory.set(r.sourceLabel, list);
    }

    const lines: string[] = [];
    lines.push(`# arch-graph compare contribution`);
    lines.push(``);
    lines.push(`- Project: anonymized`);
    lines.push(`- Generated: ${date}`);
    lines.push(`- arch-graph version: ${version}`);
    lines.push(`- graphify available: ${hasGraphify ? 'yes' : 'no'}`);
    lines.push(`- questions: ${rep.results.length}`);
    lines.push(``);
    lines.push(`## Graph stats`);
    lines.push(``);
    if (hasGraphify) {
        lines.push(`| tool | nodes | edges | size (KB) | tokens (compact) |`);
        lines.push(`|---|---:|---:|---:|---:|`);
        lines.push(
            `| arch-graph | ${rep.archNodes} | ${rep.archEdges} | ${kb(rep.archSizeBytes)} | ${fmtNumber(archAvg)} |`,
        );
        lines.push(
            `| graphify | ${rep.graphify!.nodes} | ${rep.graphify!.edges} | ${kb(rep.graphify!.sizeBytes)} | ${fmtNumber(gAvg)} |`,
        );
    } else {
        lines.push(`| tool | nodes | edges | size (KB) | tokens (compact) |`);
        lines.push(`|---|---:|---:|---:|---:|`);
        lines.push(
            `| arch-graph | ${rep.archNodes} | ${rep.archEdges} | ${kb(rep.archSizeBytes)} | ${fmtNumber(archAvg)} |`,
        );
    }
    lines.push(``);

    lines.push(`## Edge breakdown (arch-graph)`);
    lines.push(``);
    lines.push(`| kind | count |`);
    lines.push(`|---|---:|`);
    for (const kind of Array.from(edgeKindCounts.keys()).sort()) {
        lines.push(`| ${kind} | ${edgeKindCounts.get(kind)} |`);
    }
    lines.push(``);

    lines.push(`## Node breakdown (arch-graph)`);
    lines.push(``);
    lines.push(`| kind | count |`);
    lines.push(`|---|---:|`);
    for (const kind of Array.from(nodeKindCounts.keys()).sort()) {
        lines.push(`| ${kind} | ${nodeKindCounts.get(kind)} |`);
    }
    lines.push(``);

    lines.push(`## Recall by category (${rep.results.length} auto-generated questions)`);
    lines.push(``);
    if (hasGraphify) {
        lines.push(`| category | arch recall | graphify recall |`);
        lines.push(`|---|---:|---:|`);
        for (const cat of Array.from(byCategory.keys()).sort()) {
            const rows = byCategory.get(cat)!;
            const aR = meanNumber(rows.map((r) => r.archRecall));
            const gR = meanNumber(rows.map((r) => r.graphify?.recall ?? 0));
            lines.push(`| ${cat} | ${fmtPct(aR)} | ${fmtPct(gR)} |`);
        }
    } else {
        lines.push(`| category | arch recall |`);
        lines.push(`|---|---:|`);
        for (const cat of Array.from(byCategory.keys()).sort()) {
            const rows = byCategory.get(cat)!;
            const aR = meanNumber(rows.map((r) => r.archRecall));
            lines.push(`| ${cat} | ${fmtPct(aR)} |`);
        }
    }
    lines.push(``);

    lines.push(`## Totals`);
    lines.push(``);
    if (hasGraphify) {
        lines.push(`| metric | arch-graph | graphify |`);
        lines.push(`|---|---:|---:|`);
        lines.push(`| mean recall | ${fmtPct(archRecall)} | ${fmtPct(gRecall)} |`);
        lines.push(`| Σ per-Q tokens | ${fmtNumber(archTotal)} | ${fmtNumber(gTotal)} |`);
    } else {
        lines.push(`| metric | arch-graph |`);
        lines.push(`|---|---:|`);
        lines.push(`| mean recall | ${fmtPct(archRecall)} |`);
        lines.push(`| Σ per-Q tokens | ${fmtNumber(archTotal)} |`);
    }
    lines.push(``);

    const markdown = lines.join('\n');
    const title = `arch-graph compare contribution (${date}, ${rep.archNodes}n/${rep.archEdges}e)`;

    // Defense-in-depth: guard against future code paths that accidentally
    // pipe identifying data through this function. Errors here surface as
    // user-visible failures rather than silently leaked snippets.
    assertAnonymized(markdown, rep);

    return { markdown, title };
}

function kb(bytes: number): string {
    if (bytes <= 0) return '0';
    return (bytes / 1024).toFixed(1);
}

/**
 * Read the version field from `package.json`. We compute the path relative
 * to this source file via `process.argv[1]` rather than `import.meta` so the
 * compiled output (under `dist/`) and the tsx-driven path both work. If we
 * can't determine it, return 'unknown' rather than throwing — version is a
 * decoration, not a correctness gate.
 */
async function readArchGraphVersion(): Promise<string> {
    const candidates = [
        // From compiled dist or tsx-run src: walk up to find package.json
        resolve(process.argv[1] ?? '', '..', '..', '..', 'package.json'),
        resolve(process.argv[1] ?? '', '..', '..', 'package.json'),
        resolve(process.cwd(), 'package.json'),
    ];
    for (const p of candidates) {
        if (!existsSync(p)) continue;
        try {
            const json = JSON.parse(await readFile(p, 'utf8')) as { name?: string; version?: string };
            if (json.name === 'arch-graph' && typeof json.version === 'string') {
                return json.version;
            }
        } catch {
            // Ignore — try next candidate.
        }
    }
    return 'unknown';
}

/**
 * Defense-in-depth: scan the generated snippet for high-signal identifying
 * values from the user's graph. If any appears, abort loudly — better to
 * crash than to silently leak.
 *
 * We deliberately DON'T check every node.id / node.label by substring,
 * because those routinely contain generic English words ("user", "queue",
 * "service") that legitimately appear in our snippet's prose and headers.
 * Instead we focus on the highest-signal sources:
 *   - the absolute repoRoot path and its basename
 *   - any absolute file paths (archGraphPath, graphify.path)
 *   - the literal question text (contains backticked subject/queue/table names)
 *   - ground-truth labels for each question (these ARE the real
 *     service/lib/module names that the user wants kept private)
 *
 * If this trips, the snippet was NOT written or sent. The user should file
 * a bug — drift in `buildShareSnippet` is the only way this should fire.
 */
function assertAnonymized(snippet: string, rep: CompareReport): void {
    const lower = snippet.toLowerCase();

    const forbid: string[] = [];
    if (rep.repoRoot) {
        forbid.push(rep.repoRoot);
        const base = basename(rep.repoRoot);
        // Skip obviously-generic basenames (e.g. `src`, `app`, `repo`).
        if (base && base.length >= 4) forbid.push(base);
    }
    if (rep.archGraphPath) forbid.push(rep.archGraphPath);
    if (rep.graphify?.path) forbid.push(rep.graphify.path);

    // Question text and ground-truth labels are the highest-risk identifying
    // values: by construction they contain real subject names, queue names,
    // table names, and service/lib basenames.
    for (const q of rep.questions) {
        if (q.question) forbid.push(q.question);
        for (const l of q.groundTruthLabels) {
            if (l && l.length >= 3) forbid.push(l);
        }
    }

    // Allowlist tokens that the snippet legitimately contains as type names.
    // These can collide with ground-truth labels if a user names a service
    // `nats` or `queue`, but we accept that false-negative trade — the value
    // would be uninformative as a leak anyway.
    const safeTokens = new Set<string>([
        'nats', 'bullmq', 'typeorm', 'di', 'http', 'cross-domain',
        'arch-graph', 'graphify',
        ...EDGE_KIND_TOKENS,
        ...NODE_KIND_TOKENS,
    ]);

    for (const raw of forbid) {
        const needle = raw.toLowerCase().trim();
        if (needle.length < 3) continue;
        if (safeTokens.has(needle)) continue;
        if (lower.includes(needle)) {
            throw new Error(
                `--share: refusing to emit snippet — anonymization guard ` +
                `matched a potentially identifying value. The snippet was NOT ` +
                `written or sent. Please report this as a bug.`,
            );
        }
    }
}

const EDGE_KIND_TOKENS: readonly string[] = [
    'nats-publish', 'nats-request', 'nats-subscribe', 'nats-reply',
    'http-call', 'http-external',
    'queue-produce', 'queue-consume',
    'db-read', 'db-write', 'db-access',
    'di-import', 'di-provides', 'di-exports', 'di-controller',
    'ts-import', 'lib-usage',
];
const NODE_KIND_TOKENS: readonly string[] = [
    'service', 'lib', 'module', 'nats-subject', 'queue', 'db-table',
    'provider', 'file', 'external',
];

async function runShareFlow(rep: CompareReport, args: CompareArgs): Promise<void> {
    let snippet: ShareSnippet;
    try {
        snippet = await buildShareSnippet(rep);
    } catch (err) {
        process.stderr.write(`error: --share: ${(err as Error).message}\n`);
        process.exit(1);
    }

    // Show preview so the user can SEE what we're about to send.
    process.stdout.write(`\n────────── --share preview (anonymized) ──────────\n`);
    process.stdout.write(snippet.markdown);
    process.stdout.write(`\n──────────────────────────────────────────────────\n`);
    process.stdout.write(
        `Counts only — no project, subject, queue, table, module, or file names.\n`,
    );

    if (!args.shareYes) {
        const yes = await promptYesNo(`Open GitHub to submit this contribution? [Y/n] `);
        if (!yes) {
            process.stdout.write(`Skipped. Snippet not sent.\n`);
            return;
        }
    }

    const url =
        SHARE_DISCUSSION_URL +
        `&title=${encodeURIComponent(snippet.title)}` +
        `&body=${encodeURIComponent(snippet.markdown)}`;

    if (args.shareNoOpen) {
        process.stdout.write(`\nPaste into your browser:\n  ${url}\n`);
        return;
    }

    const opened = openInBrowser(url);
    if (!opened) {
        process.stdout.write(
            `\nCould not open a browser automatically. Paste this URL:\n  ${url}\n`,
        );
    } else {
        process.stdout.write(`Opened your browser. The Discussion form is pre-filled.\n`);
    }
}

async function promptYesNo(prompt: string): Promise<boolean> {
    // Non-TTY (e.g. CI, piped stdin): default to NO. The user must explicitly
    // pass --share-yes to skip the prompt non-interactively.
    if (!process.stdin.isTTY) return false;

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await new Promise<string>((res) => rl.question(prompt, res));
        const t = answer.trim().toLowerCase();
        return t === '' || t === 'y' || t === 'yes';
    } finally {
        rl.close();
    }
}

function openInBrowser(url: string): boolean {
    // Pick the platform-native opener. We pipe stdio (not inherit) so the
    // command's own output doesn't garble our terminal, and we don't wait
    // for the browser to exit.
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

