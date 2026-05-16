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

import { archGraphAdapter } from '../src/compare/adapters/arch-graph.js';
import { graphifyAdapter } from '../src/compare/adapters/graphify.js';
import type { BenchAdapter } from '../src/compare/adapters/compact.js';
import { countTokens, disposeTokens } from '../src/compare/tokens.js';

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

/**
 * graphify-only result data, bundled into one struct so the fields are jointly
 * present-or-null. Previously we had five parallel `graphify*: T | null` columns
 * — easy for them to drift apart (e.g. tokens set but recall null after a
 * partial-skip code path). The nested DU makes that structurally impossible.
 */
interface GraphifyQuestionResult {
    tokens: number;
    precision: number;
    recall: number;
    matched: string[];
    missed: string[];
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
    /** `null` when the graphify graph wasn't available for this project. */
    graphify: GraphifyQuestionResult | null;
}

interface GraphifyProjectInfo {
    sizeBytes: number | null;
    nodes: number;
    edges: number;
}

interface ProjectSummary {
    project: string;
    archGraphBuildTimeMs: number;
    archGraphSizeBytes: number;
    archNodes: number;
    archEdges: number;
    /** `null` when graphify wasn't run on this project. Bundles all graphify metadata. */
    graphify: GraphifyProjectInfo | null;
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
    //
    // NB: empty `gtLabels` would otherwise force `recall = 1.0` (vacuous truth),
    // which is misleading. `loadQuestions` rejects empty arrays upstream, so we
    // never hit that branch in practice — but the divide-by-zero guard stays.
    const recall = gtLabels.length === 0 ? 1.0 : matched.length / gtLabels.length;
    const precision = matched.length === 0 ? 0.0 : 1.0;
    return { precision, recall, matched, missed };
}

/**
 * Parse + validate `questions.yaml`. Each entry needs `id`, `project`, and a
 * non-empty `ground_truth_labels` array — an empty array silently coerces
 * `recall` to the vacuous-truth `1.0`, which would hide real regressions.
 *
 * Validation is structural (no zod) because the bench is internal and we
 * prefer one fewer dependency surface. Failures throw with the offending
 * entry index so the author can find it.
 */
async function loadQuestions(path: string): Promise<Question[]> {
    const raw = await readFile(path, 'utf8');
    const parsed = yaml.load(raw);
    if (!Array.isArray(parsed)) throw new Error('questions.yaml must be a list');
    const out: Question[] = [];
    for (let i = 0; i < parsed.length; i++) {
        const q = parsed[i] as Partial<Question> | null;
        if (!q || typeof q !== 'object') {
            throw new Error(`questions.yaml[${i}]: not an object`);
        }
        if (typeof q.id !== 'string' || q.id.length === 0) {
            throw new Error(`questions.yaml[${i}]: missing or empty 'id'`);
        }
        if (typeof q.project !== 'string' || q.project.length === 0) {
            throw new Error(`questions.yaml[${i}] (${q.id}): missing or empty 'project'`);
        }
        if (!Array.isArray(q.ground_truth_labels)) {
            throw new Error(`questions.yaml[${i}] (${q.id}): 'ground_truth_labels' must be an array`);
        }
        if (q.ground_truth_labels.length === 0) {
            // Soft-warn: an empty array would silently force `recall = 1.0`,
            // which masks real failures. Keep going (the per-question try/catch
            // in `main` handles downstream surprises) but make it visible.
            process.stderr.write(
                `bench: WARNING questions.yaml[${i}] (${q.id}): empty 'ground_truth_labels' — recall will be vacuously 1.0\n`,
            );
        }
        // `category` / `difficulty` / `question` are required `string`s on the
        // Question interface. Without these checks a missing field would land in
        // `r.category` as `undefined`, render as the string "undefined" in the
        // markdown report row, and silently corrupt the per-category aggregate.
        if (typeof q.category !== 'string' || q.category.length === 0) {
            throw new Error(`questions.yaml[${i}] (${q.id}): missing or empty 'category'`);
        }
        if (typeof q.difficulty !== 'string' || q.difficulty.length === 0) {
            throw new Error(`questions.yaml[${i}] (${q.id}): missing or empty 'difficulty'`);
        }
        if (typeof q.question !== 'string' || q.question.length === 0) {
            throw new Error(`questions.yaml[${i}] (${q.id}): missing or empty 'question'`);
        }
        out.push(q as Question);
    }
    return out;
}

// ─── project resolution ──────────────────────────────────────────────────

async function getProjectInfo(projectId: string, repoRoot: string): Promise<ProjectInfo | null> {
    // The config file pins the project's source root. We read it as text and
    // grep out the `root:` value — cheaper than importing the TS config here
    // (which would require ts-node bootstrap).
    //
    // The public repo ships only `configs/example.config.ts`; bench users
    // bring their own `configs/<id>.config.ts` per project they want to
    // benchmark. A missing config is a documented case — return null so the
    // caller can skip the project with an informative message rather than
    // crash the whole run.
    const cfgPath = resolve(repoRoot, `configs/${projectId}.config.ts`);
    let txt: string;
    try {
        txt = await readFile(cfgPath, 'utf8');
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
    }
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
    /** `null` when the graphify graph wasn't available — jointly with graphify*Nodes. */
    graphify: { context: string; nodes: number; edges: number } | null;
}

/**
 * Drive both adapters via the `BenchAdapter` contract. arch-graph is mandatory
 * (the runner is part of arch-graph's repo); graphify is optional.
 */
async function buildContexts(
    info: ProjectInfo,
    benchCacheRoot: string,
    adapters: { arch: BenchAdapter; graphify: BenchAdapter },
): Promise<ProjectContexts> {
    const archLoaded = await adapters.arch.load(info.archGraphPath);
    const archContext = adapters.arch.serialize(adapters.arch.compact(archLoaded.raw));

    let graphify: ProjectContexts['graphify'] = null;
    const gPath = adapters.graphify.findOutput(info.id, info.root, benchCacheRoot);
    if (gPath) {
        const gLoaded = await adapters.graphify.load(gPath);
        const gContext = adapters.graphify.serialize(adapters.graphify.compact(gLoaded.raw));
        graphify = { context: gContext, nodes: gLoaded.nodeCount, edges: gLoaded.edgeCount };
    }

    return {
        archContext,
        archNodes: archLoaded.nodeCount,
        archEdges: archLoaded.edgeCount,
        graphify,
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

    const adapters = { arch: archGraphAdapter, graphify: graphifyAdapter };

    // Build contexts (one per project, reused across all that project's questions)
    const ctxByProject = new Map<string, ProjectContexts>();
    const summaries: ProjectSummary[] = [];
    const skippedProjects: string[] = [];
    for (const pid of projectIds) {
        const info = await getProjectInfo(pid, repoRoot);
        if (info === null) {
            skippedProjects.push(pid);
            process.stdout.write(
                `bench: ${pid} — SKIP (no configs/${pid}.config.ts). ` +
                `Create the config to include this project. See bench/README.md.\n`,
            );
            continue;
        }
        const t0 = performance.now();
        const ctx = await buildContexts(info, benchCacheRoot, adapters);
        const t1 = performance.now();
        process.stdout.write(
            `bench: ${pid} — arch=${ctx.archNodes}n/${ctx.archEdges}e, graphify=${
                ctx.graphify ? `${ctx.graphify.nodes}n/${ctx.graphify.edges}e` : 'unavailable'
            } (compact in ${(t1 - t0).toFixed(0)}ms)\n`,
        );
        ctxByProject.set(pid, ctx);

        const archSize = await safeStatSize(info.archGraphPath);
        const gPath = adapters.graphify.findOutput(info.id, info.root, benchCacheRoot);
        const gSize = gPath ? await safeStatSize(gPath) : null;
        summaries.push({
            project: pid,
            archGraphBuildTimeMs: await timeArchBuild(repoRoot, pid),
            archGraphSizeBytes: archSize ?? 0,
            archNodes: ctx.archNodes,
            archEdges: ctx.archEdges,
            graphify: ctx.graphify
                ? { sizeBytes: gSize, nodes: ctx.graphify.nodes, edges: ctx.graphify.edges }
                : null,
        });
    }

    // Per-question scoring. Each question is independent — wrap in try/catch so
    // a single malformed entry doesn't poison the whole report.
    const results: QuestionResult[] = [];
    for (const q of questions) {
        try {
            const ctx = ctxByProject.get(q.project);
            if (!ctx) throw new Error(`no context for project ${q.project}`);

            const archTokens = countTokens(ctx.archContext);
            const archScore = scorePR(ctx.archContext, q.ground_truth_labels);

            let graphify: GraphifyQuestionResult | null = null;
            if (ctx.graphify) {
                const gTokens = countTokens(ctx.graphify.context);
                const gs = scorePR(ctx.graphify.context, q.ground_truth_labels);
                graphify = {
                    tokens: gTokens,
                    precision: gs.precision,
                    recall: gs.recall,
                    matched: gs.matched,
                    missed: gs.missed,
                };
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
                graphify,
            });
        } catch (err) {
            process.stderr.write(
                `bench: WARNING question '${q.id}' failed: ${(err as Error).message} — skipping\n`,
            );
        }
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
        const graphifyMean = s.graphify
            ? mean(perProj.map((r) => r.graphify?.tokens ?? 0))
            : null;
        const graphifyRecall = s.graphify
            ? mean(perProj.map((r) => r.graphify?.recall ?? 0))
            : null;
        return [
            s.project,
            `${s.archNodes}n / ${s.archEdges}e`,
            bytes(s.archGraphSizeBytes),
            ms(s.archGraphBuildTimeMs),
            fmt(archMean),
            pct(archRecall),
            s.graphify ? `${s.graphify.nodes}n / ${s.graphify.edges}e` : 'unavailable',
            s.graphify ? bytes(s.graphify.sizeBytes) : '—',
            s.graphify ? fmt(graphifyMean) : '—',
            s.graphify ? pct(graphifyRecall) : '—',
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
            fmt(r.graphify?.tokens ?? null),
            pct(r.graphify?.precision ?? null),
            pct(r.graphify?.recall ?? null),
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
    const graphifyTotalTok = results.every((r) => r.graphify === null)
        ? null
        : total(results.map((r) => r.graphify?.tokens ?? 0));
    const archMeanR = mean(results.map((r) => r.archRecall));
    const graphifyResults = results.filter((r) => r.graphify !== null);
    const graphifyMeanR =
        graphifyResults.length > 0
            ? mean(graphifyResults.map((r) => r.graphify?.recall ?? 0))
            : null;

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
        .filter((s) => s.graphify === null)
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
