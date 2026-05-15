// Bench runner — head-to-head: arch-graph vs graphify.
//
// For each (project × question) pair we:
//   1. Load the compact graph for each tool.
//   2. Serialize it as plain JSON (the format an LLM would consume in-context).
//   3. Count tokens via cl100k_base (gpt-4 family).
//   4. Score precision/recall using a deterministic substring-presence heuristic
//      against the question's `ground_truth_labels`.
//
// Quality heuristic (documented in report.md): we say a "ground truth label is
// in context" iff the lowercased label appears as a substring of the lowercased
// context string. This is a permissive recall measure — it answers the
// question "did the tool's output even *contain* the answer". Precision is
// then 1.0 when all expected labels are present (the LLM has everything it
// needs), and the F1/recall difference between tools comes from how much of
// the ground truth they surface.

import { readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

import yaml from 'js-yaml';

import {
    loadArchGraph,
    compactArchGraph,
    serializeContext as serializeArch,
} from './adapters/arch-graph.js';
import {
    loadGraphifyGraph,
    compactGraphifyGraph,
    serializeContext as serializeGraphify,
    findGraphifyOutput,
} from './adapters/graphify.js';
import { countTokens, disposeTokens } from './tokens.js';

// ─── types ────────────────────────────────────────────────────────────────

interface Question {
    id: string;
    project: string;
    category: string;
    difficulty: string;
    question: string;
    ground_truth_ids?: string[];
    ground_truth_labels: string[];
}

interface ProjectInfo {
    id: string;
    root: string;
    archGraphPath: string; // /tmp/sg-<id>/graph.json
}

interface QuestionResult {
    qid: string;
    project: string;
    category: string;
    archTokens: number;
    archPrecision: number;
    archRecall: number;
    archMatched: string[];
    archMissed: string[];
    graphifyTokens: number | null;
    graphifyPrecision: number | null;
    graphifyRecall: number | null;
    graphifyMatched: string[] | null;
    graphifyMissed: string[] | null;
}

interface ProjectSummary {
    project: string;
    archGraphBuildTimeMs: number;
    archGraphSizeBytes: number;
    archNodes: number;
    archEdges: number;
    graphifyAvailable: boolean;
    graphifySizeBytes: number | null;
    graphifyNodes: number | null;
    graphifyEdges: number | null;
}

// ─── helpers ──────────────────────────────────────────────────────────────

function scorePR(contextText: string, gtLabels: string[]): {
    precision: number;
    recall: number;
    matched: string[];
    missed: string[];
} {
    const haystack = contextText.toLowerCase();
    const matched: string[] = [];
    const missed: string[] = [];
    for (const lbl of gtLabels) {
        if (haystack.includes(lbl.toLowerCase())) matched.push(lbl);
        else missed.push(lbl);
    }
    // Heuristic precision/recall:
    //   recall    = matched / |GT|
    //   precision = 1.0 if all matched are *expected* labels, which they
    //               are by construction (we only look for the GT labels).
    //   So the *interesting* axis here is recall. We surface precision
    //   anyway for completeness, but it stays 1.0 in this scheme — see
    //   report.md `Heuristic` section.
    const recall = gtLabels.length === 0 ? 1.0 : matched.length / gtLabels.length;
    const precision = matched.length === 0 ? 0.0 : 1.0;
    return { precision, recall, matched, missed };
}

async function loadQuestions(path: string): Promise<Question[]> {
    const raw = await readFile(path, 'utf8');
    const parsed = yaml.load(raw);
    if (!Array.isArray(parsed)) throw new Error('questions.yaml must be a list');
    return parsed as Question[];
}

// ─── project resolution ──────────────────────────────────────────────────

async function getProjectInfo(projectId: string, repoRoot: string): Promise<ProjectInfo> {
    // The config file pins the project's source root. We read it as text and
    // grep out the `root:` value — cheaper than importing the TS config here
    // (which would require ts-node bootstrap).
    const cfgPath = resolve(repoRoot, `configs/${projectId}.config.ts`);
    const txt = await readFile(cfgPath, 'utf8');
    const m = txt.match(/root:\s*'([^']+)'/);
    if (!m) throw new Error(`could not parse 'root' from ${cfgPath}`);
    return {
        id: projectId,
        root: m[1]!,
        archGraphPath: `/tmp/sg-${projectId}/graph.json`,
    };
}

async function safeStatSize(path: string): Promise<number | null> {
    try {
        const s = await stat(path);
        return s.size;
    } catch {
        return null;
    }
}

// ─── per-project run ─────────────────────────────────────────────────────

interface ProjectContexts {
    archContext: string;
    archNodes: number;
    archEdges: number;
    graphifyContext: string | null;
    graphifyNodes: number | null;
    graphifyEdges: number | null;
}

async function buildContexts(info: ProjectInfo, benchCacheRoot: string): Promise<ProjectContexts> {
    const archG = await loadArchGraph(info.archGraphPath);
    const archC = compactArchGraph(archG);
    const archContext = serializeArch(archC);

    let graphifyContext: string | null = null;
    let graphifyNodes: number | null = null;
    let graphifyEdges: number | null = null;
    const gPath = findGraphifyOutput(info.id, info.root, benchCacheRoot);
    if (gPath) {
        const gG = await loadGraphifyGraph(gPath);
        const gC = compactGraphifyGraph(gG);
        graphifyContext = serializeGraphify(gC);
        graphifyNodes = gG.nodes.length;
        graphifyEdges = gG.links.length;
    }

    return {
        archContext,
        archNodes: archG.nodes.length,
        archEdges: archG.edges.length,
        graphifyContext,
        graphifyNodes,
        graphifyEdges,
    };
}

// ─── build-time measurement (best-effort: cached graphs reuse cache) ─────

async function timeArchBuild(repoRoot: string, projectId: string): Promise<number> {
    // We don't actually re-run arch-graph build here. The bench script timing
    // is recorded in `run.sh` (which writes to bench/.build-times.json). We
    // simply read it if present, otherwise return -1 (unknown).
    const p = resolve(repoRoot, 'bench/.build-times.json');
    if (!existsSync(p)) return -1;
    try {
        const j = JSON.parse(await readFile(p, 'utf8')) as Record<string, { archMs?: number }>;
        return j[projectId]?.archMs ?? -1;
    } catch {
        return -1;
    }
}

// ─── main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
    const questionsPath = resolve(repoRoot, 'bench/questions.yaml');
    const reportTplPath = resolve(repoRoot, 'bench/report-template.md');
    const reportOutPath = resolve(repoRoot, 'bench/report.md');
    const benchCacheRoot = resolve(repoRoot, 'bench/cache');

    process.stdout.write(`bench: loading questions from ${questionsPath}\n`);
    const questions = await loadQuestions(questionsPath);

    const projectIds = Array.from(new Set(questions.map((q) => q.project)));
    process.stdout.write(`bench: ${questions.length} questions across ${projectIds.length} projects\n`);

    // Build contexts (one per project, reused across all that project's questions)
    const ctxByProject = new Map<string, ProjectContexts>();
    const summaries: ProjectSummary[] = [];
    for (const pid of projectIds) {
        const info = await getProjectInfo(pid, repoRoot);
        const t0 = performance.now();
        const ctx = await buildContexts(info, benchCacheRoot);
        const t1 = performance.now();
        process.stdout.write(
            `bench: ${pid} — arch=${ctx.archNodes}n/${ctx.archEdges}e, graphify=${
                ctx.graphifyContext ? `${ctx.graphifyNodes}n/${ctx.graphifyEdges}e` : 'unavailable'
            } (compact in ${(t1 - t0).toFixed(0)}ms)\n`,
        );
        ctxByProject.set(pid, ctx);

        const archSize = await safeStatSize(info.archGraphPath);
        const gPath = findGraphifyOutput(info.id, info.root, benchCacheRoot);
        const gSize = gPath ? await safeStatSize(gPath) : null;
        summaries.push({
            project: pid,
            archGraphBuildTimeMs: await timeArchBuild(repoRoot, pid),
            archGraphSizeBytes: archSize ?? 0,
            archNodes: ctx.archNodes,
            archEdges: ctx.archEdges,
            graphifyAvailable: ctx.graphifyContext !== null,
            graphifySizeBytes: gSize,
            graphifyNodes: ctx.graphifyNodes,
            graphifyEdges: ctx.graphifyEdges,
        });
    }

    // Per-question scoring
    const results: QuestionResult[] = [];
    for (const q of questions) {
        const ctx = ctxByProject.get(q.project);
        if (!ctx) throw new Error(`no context for project ${q.project}`);

        const archTokens = countTokens(ctx.archContext);
        const archScore = scorePR(ctx.archContext, q.ground_truth_labels);

        let graphifyTokens: number | null = null;
        let graphifyP: number | null = null;
        let graphifyR: number | null = null;
        let graphifyMatched: string[] | null = null;
        let graphifyMissed: string[] | null = null;
        if (ctx.graphifyContext) {
            graphifyTokens = countTokens(ctx.graphifyContext);
            const gs = scorePR(ctx.graphifyContext, q.ground_truth_labels);
            graphifyP = gs.precision;
            graphifyR = gs.recall;
            graphifyMatched = gs.matched;
            graphifyMissed = gs.missed;
        }

        results.push({
            qid: q.id,
            project: q.project,
            category: q.category,
            archTokens,
            archPrecision: archScore.precision,
            archRecall: archScore.recall,
            archMatched: archScore.matched,
            archMissed: archScore.missed,
            graphifyTokens,
            graphifyPrecision: graphifyP,
            graphifyRecall: graphifyR,
            graphifyMatched,
            graphifyMissed,
        });
    }

    // Render the report
    const tpl = existsSync(reportTplPath)
        ? await readFile(reportTplPath, 'utf8')
        : '# Bench report\n\n{{SUMMARY_TABLE}}\n\n{{PER_QUESTION_TABLE}}\n\n{{NOTES}}\n';
    const md = renderReport(tpl, summaries, results);
    await writeFile(reportOutPath, md, 'utf8');
    process.stdout.write(`\nbench: wrote ${reportOutPath}\n`);

    disposeTokens();
}

// ─── report rendering ────────────────────────────────────────────────────

function fmt(n: number | null | undefined, suffix = ''): string {
    if (n === null || n === undefined || n < 0 || Number.isNaN(n)) return '—';
    return `${n}${suffix}`;
}

function pct(n: number | null | undefined): string {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    return `${(n * 100).toFixed(0)}%`;
}

function ms(n: number | null | undefined): string {
    if (n === null || n === undefined || n < 0) return '—';
    if (n < 1000) return `${n.toFixed(0)} ms`;
    return `${(n / 1000).toFixed(1)} s`;
}

function bytes(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function renderReport(
    tpl: string,
    summaries: ProjectSummary[],
    results: QuestionResult[],
): string {
    // Summary table
    const sumRows = summaries.map((s) => {
        const perProj = results.filter((r) => r.project === s.project);
        const archMean = mean(perProj.map((r) => r.archTokens));
        const archRecall = mean(perProj.map((r) => r.archRecall));
        const graphifyMean = s.graphifyAvailable
            ? mean(perProj.map((r) => r.graphifyTokens ?? 0))
            : null;
        const graphifyRecall = s.graphifyAvailable
            ? mean(perProj.map((r) => r.graphifyRecall ?? 0))
            : null;
        return [
            s.project,
            `${s.archNodes}n / ${s.archEdges}e`,
            bytes(s.archGraphSizeBytes),
            ms(s.archGraphBuildTimeMs),
            fmt(archMean),
            pct(archRecall),
            s.graphifyAvailable
                ? `${s.graphifyNodes}n / ${s.graphifyEdges}e`
                : 'unavailable',
            s.graphifyAvailable ? bytes(s.graphifySizeBytes) : '—',
            s.graphifyAvailable ? fmt(graphifyMean) : '—',
            s.graphifyAvailable ? pct(graphifyRecall) : '—',
        ].join(' | ');
    });
    const summaryTable = [
        '| project | arch nodes/edges | arch size | arch build | arch avg tokens | arch recall | graphify nodes/edges | graphify size | graphify avg tokens | graphify recall |',
        '|---|---|---|---|---|---|---|---|---|---|',
        ...sumRows.map((r) => `| ${r} |`),
    ].join('\n');

    // Per-question table
    const qRows = results.map((r) =>
        [
            r.qid,
            r.project,
            r.category,
            fmt(r.archTokens),
            pct(r.archPrecision),
            pct(r.archRecall),
            fmt(r.graphifyTokens),
            pct(r.graphifyPrecision),
            pct(r.graphifyRecall),
        ].join(' | '),
    );
    const perQTable = [
        '| qid | project | category | arch tokens | arch P | arch R | graphify tokens | graphify P | graphify R |',
        '|---|---|---|---|---|---|---|---|---|',
        ...qRows.map((r) => `| ${r} |`),
    ].join('\n');

    // Aggregate one-liners
    const total = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
    const archTotalTok = total(results.map((r) => r.archTokens));
    const graphifyTotalTok = results.every((r) => r.graphifyTokens === null)
        ? null
        : total(results.map((r) => r.graphifyTokens ?? 0));
    const archMeanR = mean(results.map((r) => r.archRecall));
    const graphifyResults = results.filter((r) => r.graphifyRecall !== null);
    const graphifyMeanR =
        graphifyResults.length > 0 ? mean(graphifyResults.map((r) => r.graphifyRecall!)) : null;

    const aggregate = [
        `**Total context tokens across all ${results.length} questions:**`,
        ``,
        `- arch-graph: ${archTotalTok.toLocaleString()} tokens`,
        graphifyTotalTok !== null
            ? `- graphify:   ${graphifyTotalTok.toLocaleString()} tokens` +
              (archTotalTok > 0
                  ? ` (${(graphifyTotalTok / archTotalTok).toFixed(1)}× more than arch-graph)`
                  : '')
            : `- graphify:   not run on any project (see report \`Skipped legs\`)`,
        ``,
        `**Mean recall across questions (substring-presence heuristic):**`,
        ``,
        `- arch-graph: ${pct(archMeanR)}`,
        `- graphify:   ${pct(graphifyMeanR)}`,
    ].join('\n');

    const skipped = summaries
        .filter((s) => !s.graphifyAvailable)
        .map((s) => `- **${s.project}** — no \`graphify-out/graph.json\` found at \`${s.project}/graphify-out/\` or \`bench/cache/${s.project}/graphify-out/\``);
    const skippedSection =
        skipped.length === 0
            ? '_All projects have graphify outputs._'
            : skipped.join('\n');

    return tpl
        .replace('{{SUMMARY_TABLE}}', summaryTable)
        .replace('{{PER_QUESTION_TABLE}}', perQTable)
        .replace('{{AGGREGATE}}', aggregate)
        .replace('{{SKIPPED_LEGS}}', skippedSection)
        .replace('{{GENERATED_AT}}', new Date().toISOString());
}

function mean(xs: number[]): number {
    if (xs.length === 0) return 0;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
}

main().catch((err) => {
    process.stderr.write(`bench fatal: ${err}\n${(err as Error)?.stack ?? ''}\n`);
    process.exit(1);
});
