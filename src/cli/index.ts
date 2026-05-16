import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadConfig } from '../core/config.js';
import { startMcpServer } from '../mcp/server.js';
import { writeDiagnostics, writeGraphJson, writeValidationReport } from '../output/graph-json.js';
import {
    parseSliceMode,
    writeGraphMermaid,
    type MermaidSliceMode,
} from '../output/graph-mermaid.js';
import { runBuild } from '../pipeline/build.js';
import {
    claudeInstall,
    claudeUninstall,
    parseClaudeArgs,
} from './claude.js';
import { hookInstall, hookStatus, hookUninstall, parseHookArgs } from './hooks.js';
import { installSkill } from './skill.js';
import { parseQueryArgs, QUERY_CMDS, runQueryCommand } from './query-commands.js';
import {
    tipsForBullmq,
    tipsForDi,
    tipsForHttp,
    tipsForImports,
    tipsForNats,
    tipsForTypeorm,
} from './build-tips.js';
import type { BuildValidation, DiagnosticsReport } from '../core/types.js';

interface ParsedArgs {
    cmd: string;
    config: string;
    out: string;
    only?: string;
    /** Optional extra slice; `graph.mermaid` (full) is always written. */
    mermaidSlice?: MermaidSliceMode;
    /** Suppress non-error stdout. Used by the post-commit hook. */
    quiet: boolean;
    /**
     * Hard-fail mode for CI: exit 3 when any enabled domain falls below recall/resolve
     * floor. By default (without --quiet) the per-domain table is printed so CI logs
     * contain the context. With --quiet, the table is suppressed but exit 3 still fires
     * on failures.
     */
    strict: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
    const [cmd, ...rest] = argv;
    let config = './arch-graph.config.ts';
    let out = './arch-graph-out';
    let only: string | undefined;
    let mermaidSlice: MermaidSliceMode | undefined;
    let quiet = false;
    let strict = false;

    for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (a === '--config' && rest[i + 1]) {
            config = rest[++i]!;
        } else if (a.startsWith('--config=')) {
            config = a.slice('--config='.length);
        } else if (a === '--out' && rest[i + 1]) {
            out = rest[++i]!;
        } else if (a.startsWith('--out=')) {
            out = a.slice('--out='.length);
        } else if (a.startsWith('--only=')) {
            only = a.slice('--only='.length);
        } else if (a.startsWith('--mermaid-slice=')) {
            mermaidSlice = parseSliceMode(a.slice('--mermaid-slice='.length));
        } else if (a === '--mermaid-slice' && rest[i + 1]) {
            mermaidSlice = parseSliceMode(rest[++i]!);
        } else if (a === '--quiet' || a === '-q') {
            quiet = true;
        } else if (a === '--strict') {
            strict = true;
        }
    }
    return { cmd: cmd ?? '', config, out, only, mermaidSlice, quiet, strict };
}

const HELP = `
arch-graph — static architecture graph extractor for NestJS monorepos

Usage:
  arch-graph build      [--config <path>] [--out <dir>] [--only=<extractor>] [--mermaid-slice=<mode>] [--quiet] [--strict]
  arch-graph diagnose   [--config <path>] [--out <dir>]
  arch-graph init       [--out <path>]
  arch-graph mcp        [--out <dir>]
                        starts an MCP stdio server backed by <out>/graph.json

  arch-graph claude install   [--target <CLAUDE.md>] [--skill]
  arch-graph claude uninstall [--target <CLAUDE.md>]

  arch-graph hook install     [--repo <path>] [--mode=<pre-commit|post-commit>]
  arch-graph hook uninstall   [--repo <path>]
  arch-graph hook status      [--repo <path>]

  arch-graph install-skill    (writes ~/.claude/skills/arch-graph/SKILL.md)

Graph query subcommands (read arch-graph-out/graph.json):
  arch-graph who-publishes  <subject>      NATS publishers of subject (e.g. user.created)
  arch-graph who-subscribes <subject>      NATS subscribers of subject
  arch-graph queue-producers <queue>       BullMQ producers of queue
  arch-graph queue-consumers <queue>       BullMQ consumers of queue
  arch-graph table-users    <table>        TypeORM accessors of table
  arch-graph deps-of        <service-id>   service's outgoing dependencies
  arch-graph dependents-of  <service-id>   services that depend on this one
  arch-graph module-imports <module-name>  what does this NestJS module import
  arch-graph path           <from> <to>    shortest path between two graph nodes
  arch-graph stats                         overview: node/edge counts per kind

  Query options:
    --out <dir>   directory containing graph.json (default: ./arch-graph-out)
    --json        structured JSON output on stdout (default)
    --table       pretty table format for humans

  Exit codes for queries: 0=found, 4=not found

Flags:
  --quiet   Suppress non-error stdout (progress + validation table). Used by
            the post-commit hook so commits aren't noisy.
  --strict  CI hard-fail mode: exit 3 if any enabled domain recall falls below
            floor (≥95%, or ≥80% for imports). The per-domain table is printed
            in strict mode (good for CI logs) — unless --quiet is also passed,
            in which case the table is suppressed but exit 3 still fires.

Defaults:
  --config  ./arch-graph.config.ts
  --out     ./arch-graph-out
  --mode    pre-commit          (for \`hook install\`)

Mermaid slice modes (default writes graph.mermaid; flag adds an extra slice):
  full              full graph (already written as graph.mermaid)
  per-service       one service-<id>.mermaid per service under <out>/mermaid/
  domain:<key>      one <key>.mermaid filtered to edges of that domain.
                    Keys: nats, bullmq, typeorm, http, di, ts-import, lib
`;

const INIT_TEMPLATE = `import { defineConfig } from 'arch-graph';

export default defineConfig({
    id: 'my-project',
    root: '.',
    appsGlob: 'apps/*',
    libsGlob: 'libs/**',
    nats: {
        wrapperPublishApis: [
            // { class: 'MyNatsService', methods: ['publish', 'request'] },
        ],
        wrapperSubscribeApis: [
            // { class: 'MyNatsService', methods: ['subscribe'] },
        ],
    },
    imports: {
        // Emit file-level \`ts-import\` edges (file → file). Off by default —
        // produces 10k+ edges in medium monorepos. Turn on for file-graph drill-downs.
        // fileLevel: false,
    },
});
`;

async function cmdInit(out: string): Promise<void> {
    const target = resolve(out);
    await writeFile(target, INIT_TEMPLATE, 'utf8');
    process.stdout.write(`wrote ${target}\n`);
}

// ---------------------------------------------------------------------------
// Domain-level row computation
// ---------------------------------------------------------------------------

type DomainStatus = 'ok' | 'warn' | 'disabled' | 'no-gt';

interface DomainRow {
    name: string;
    /** Min recall across all per-role metrics (the gate-visible number). NaN when disabled or no-GT. */
    recall: number;
    /** Resolve rate for domains that track it; NaN otherwise. */
    resolve: number;
    /** The floor used for gating (0.95 for most, 0.80 for imports). */
    floor: number;
    status: DomainStatus;
    tips: string[];
}

function buildDomainRows(
    validation: BuildValidation,
    diagnostics: DiagnosticsReport,
    enabled: Record<string, boolean>,
): DomainRow[] {
    const rows: DomainRow[] = [];

    // ---- NATS ----
    {
        const v = validation.nats.summary;
        const d = diagnostics.nats;
        const en = enabled.nats!;
        let status: DomainStatus;
        let recall = NaN;
        let tips: string[] = [];
        if (!en) {
            status = 'disabled';
        } else if (v.groundTruthHandlers === 0 && v.groundTruthSenders === 0) {
            status = 'no-gt';
        } else {
            // Use min across enabled roles; roles with GT=0 are skipped per gate logic.
            const recallVals: number[] = [];
            if (v.groundTruthHandlers > 0) recallVals.push(v.recallHandlers);
            if (v.groundTruthSenders > 0) recallVals.push(v.recallSenders);
            recall = recallVals.length > 0 ? Math.min(...recallVals) : 1;
            status = recall >= 0.95 ? 'ok' : 'warn';
            if (status === 'warn') tips = tipsForNats(validation.nats, d);
        }
        rows.push({ name: 'nats', recall, resolve: NaN, floor: 0.95, status, tips });
    }

    // ---- TypeORM ----
    {
        const v = validation.typeorm.summary;
        const d = diagnostics.typeorm;
        const en = enabled.typeorm!;
        let status: DomainStatus;
        let recall = NaN;
        let resolve = NaN;
        let tips: string[] = [];
        if (!en) {
            status = 'disabled';
        } else if (v.groundTruthInjections === 0 && v.groundTruthEntities === 0) {
            status = 'no-gt';
        } else {
            const recallVals: number[] = [];
            if (v.groundTruthInjections > 0) recallVals.push(v.recallInjections);
            if (v.groundTruthEntities > 0) recallVals.push(v.recallEntities);
            recall = recallVals.length > 0 ? Math.min(...recallVals) : 1;
            resolve = v.resolveRate;
            const recallOk = recall >= 0.95;
            const resolveOk = v.totalInjections === 0 || v.resolveRate >= 0.95;
            status = recallOk && resolveOk ? 'ok' : 'warn';
            if (status === 'warn') tips = tipsForTypeorm(validation.typeorm, d);
        }
        rows.push({ name: 'typeorm', recall, resolve, floor: 0.95, status, tips });
    }

    // ---- BullMQ ----
    {
        const v = validation.bullmq.summary;
        const d = diagnostics.bullmq;
        const en = enabled.bullmq!;
        let status: DomainStatus;
        let recall = NaN;
        let resolve = NaN;
        let tips: string[] = [];
        if (!en) {
            status = 'disabled';
        } else if (
            v.groundTruthProducers === 0 &&
            v.groundTruthConsumers === 0 &&
            v.groundTruthRegistrations === 0
        ) {
            status = 'no-gt';
        } else {
            const recallVals: number[] = [];
            if (v.groundTruthProducers > 0) recallVals.push(v.recallProducers);
            if (v.groundTruthConsumers > 0) recallVals.push(v.recallConsumers);
            if (v.groundTruthRegistrations > 0) recallVals.push(v.recallRegistrations);
            recall = recallVals.length > 0 ? Math.min(...recallVals) : 1;
            const totalSites = v.totalProducers + v.totalConsumers + v.totalRegistrations;
            resolve = v.resolveRate;
            const recallOk = recall >= 0.95;
            const resolveOk = totalSites === 0 || v.resolveRate >= 0.95;
            status = recallOk && resolveOk ? 'ok' : 'warn';
            if (status === 'warn') tips = tipsForBullmq(validation.bullmq, d);
        }
        rows.push({ name: 'bullmq', recall, resolve, floor: 0.95, status, tips });
    }

    // ---- DI ----
    {
        const v = validation.di.summary;
        const d = diagnostics.di;
        const en = enabled.di!;
        let status: DomainStatus;
        let recall = NaN;
        let resolve = NaN;
        let tips: string[] = [];
        if (!en) {
            status = 'disabled';
        } else if (v.groundTruthModules === 0) {
            status = 'no-gt';
        } else {
            const recallVals: number[] = [v.recallModules];
            if (v.groundTruthImportsFields > 0) recallVals.push(v.recallImportsFields);
            if (v.groundTruthProvidersFields > 0) recallVals.push(v.recallProvidersFields);
            if (v.groundTruthExportsFields > 0) recallVals.push(v.recallExportsFields);
            if (v.groundTruthControllersFields > 0) recallVals.push(v.recallControllersFields);
            recall = Math.min(...recallVals);
            const totalRefs =
                v.totalImports + v.totalProviders + v.totalExports + v.totalControllers;
            resolve = v.resolveRate;
            const recallOk = recall >= 0.95;
            const resolveOk = totalRefs === 0 || v.resolveRate >= 0.95;
            status = recallOk && resolveOk ? 'ok' : 'warn';
            if (status === 'warn') tips = tipsForDi(validation.di, d);
        }
        rows.push({ name: 'di', recall, resolve, floor: 0.95, status, tips });
    }

    // ---- HTTP ----
    {
        const v = validation.http.summary;
        const d = diagnostics.http;
        const en = enabled.http!;
        let status: DomainStatus;
        let recall = NaN;
        let tips: string[] = [];
        if (!en) {
            status = 'disabled';
        } else if (v.groundTruthCalls === 0) {
            status = 'no-gt';
        } else {
            recall = v.recallCalls;
            status = recall >= 0.95 ? 'ok' : 'warn';
            if (status === 'warn') tips = tipsForHttp(validation.http, d);
        }
        // HTTP resolve is informational (not gated), so show n/a per spec sample
        rows.push({ name: 'http', recall, resolve: NaN, floor: 0.95, status, tips });
    }

    // ---- imports ----
    {
        const v = validation.imports.summary;
        const d = diagnostics.imports;
        const en = enabled.imports!;
        let status: DomainStatus;
        let recall = NaN;
        let tips: string[] = [];
        if (!en) {
            status = 'disabled';
        } else if (v.groundTruthStatic === 0) {
            status = 'no-gt';
        } else {
            recall = v.recallStatic;
            status = recall >= 0.8 ? 'ok' : 'warn';
            if (status === 'warn') tips = tipsForImports(validation.imports, d);
        }
        // imports has no resolve gate
        rows.push({ name: 'imports', recall, resolve: NaN, floor: 0.8, status, tips });
    }

    return rows;
}

// ---------------------------------------------------------------------------
// Table formatting
// ---------------------------------------------------------------------------

function formatPct(n: number): string {
    if (isNaN(n)) return 'n/a';
    return `${(n * 100).toFixed(1)}%`;
}

function formatFloor(floor: number, status: DomainStatus): string {
    if (status === 'disabled' || status === 'no-gt') return '—';
    return `≥${(floor * 100).toFixed(1)}%`;
}

function statusSymbol(status: DomainStatus): string {
    switch (status) {
        case 'ok': return '✓ ok';        // ✓ ok
        case 'warn': return '⚠ WARN';    // ⚠ WARN
        case 'disabled': return '• disabled'; // • disabled
        case 'no-gt': return '• no GT (domain not in use?)'; // • no GT
    }
}

function printValidationTable(rows: DomainRow[]): void {
    // Column widths
    const COL_DOMAIN  = 10;
    const COL_RECALL  = 9;
    const COL_RESOLVE = 9;
    const COL_FLOOR   = 8;
    const COL_STATUS  = 30;

    const header =
        'Domain'.padEnd(COL_DOMAIN) +
        'Recall'.padStart(COL_RECALL) +
        'Resolve'.padStart(COL_RESOLVE) +
        'Floor'.padStart(COL_FLOOR) +
        '   Status';

    const sep = '─'.repeat(COL_DOMAIN + COL_RECALL + COL_RESOLVE + COL_FLOOR + 3 + COL_STATUS);

    process.stdout.write(`\n${header}\n${sep}\n`);

    for (const row of rows) {
        const line =
            row.name.padEnd(COL_DOMAIN) +
            formatPct(row.recall).padStart(COL_RECALL) +
            formatPct(row.resolve).padStart(COL_RESOLVE) +
            formatFloor(row.floor, row.status).padStart(COL_FLOOR) +
            '   ' +
            statusSymbol(row.status);
        process.stdout.write(`${line}\n`);
    }

    // Tips section: collect all warn domains
    const warnRows = rows.filter((r) => r.status === 'warn' && r.tips.length > 0);
    if (warnRows.length > 0) {
        process.stdout.write(`\nTips:\n`);
        for (const row of warnRows) {
            process.stdout.write(`  [${row.name}]\n`);
            for (const tip of row.tips) {
                process.stdout.write(`    - ${tip}\n`);
            }
        }
    }

    process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// Strict-mode gate (same semantics as the old hard-fail, but collected here)
// ---------------------------------------------------------------------------

function computeStrictFails(
    validation: BuildValidation,
    enabled: Record<string, boolean>,
): string[] {
    const fails: string[] = [];
    const n = validation.nats.summary;
    const t = validation.typeorm.summary;
    const b = validation.bullmq.summary;
    const d = validation.di.summary;
    const h = validation.http.summary;
    const i = validation.imports.summary;

    // Per-role zero-GT: handlers misconfig and senders misconfig fail independently.
    if (enabled.nats) {
        if (n.groundTruthHandlers === 0) fails.push(`nats: zero handler ground-truth — check subscribe decorators / wrapperSubscribeApis`);
        if (n.groundTruthSenders === 0) fails.push(`nats: zero sender ground-truth — check wrapperPublishApis (typo'd class name?)`);
        strictGateRecall('nats', 'handlers', n.groundTruthHandlers, n.recallHandlers, fails);
        strictGateRecall('nats', 'senders', n.groundTruthSenders, n.recallSenders, fails);
    }
    if (enabled.typeorm) {
        if (t.groundTruthInjections === 0) fails.push(`typeorm: zero injection ground-truth — check appsGlob / @InjectRepository usage`);
        if (t.groundTruthEntities === 0) fails.push(`typeorm: zero entity ground-truth — check @Entity declarations in libs/`);
        strictGateRecall('typeorm', 'injections', t.groundTruthInjections, t.recallInjections, fails);
        strictGateRecall('typeorm', 'entities', t.groundTruthEntities, t.recallEntities, fails);
        strictGateResolve('typeorm', t.totalInjections, t.resolveRate, fails);
    }
    if (enabled.http) {
        if (h.groundTruthCalls === 0) {
            fails.push(`http: zero ground-truth — set domains.http=false if this project has no HTTP usage`);
        }
        strictGateRecall('http', 'recall', h.groundTruthCalls, h.recallCalls, fails);
    }
    if (enabled.bullmq) {
        const anyGt = b.groundTruthProducers + b.groundTruthConsumers + b.groundTruthRegistrations;
        if (anyGt === 0) fails.push(`bullmq: zero ground-truth across producers/consumers/registrations — set domains.bullmq=false if this project has no BullMQ`);
        strictGateRecall('bullmq', 'producers', b.groundTruthProducers, b.recallProducers, fails);
        strictGateRecall('bullmq', 'consumers', b.groundTruthConsumers, b.recallConsumers, fails);
        strictGateRecall('bullmq', 'registrations', b.groundTruthRegistrations, b.recallRegistrations, fails);
        const totalSites = b.totalProducers + b.totalConsumers + b.totalRegistrations;
        strictGateResolve('bullmq', totalSites, b.resolveRate, fails);
    }
    if (enabled.di) {
        if (d.groundTruthModules === 0) {
            fails.push(`di: zero @Module ground-truth — set domains.di=false if this project is not NestJS`);
        }
        strictGateRecall('di', 'modules', d.groundTruthModules, d.recallModules, fails);
        strictGateRecall('di', 'imports-fields', d.groundTruthImportsFields, d.recallImportsFields, fails);
        strictGateRecall('di', 'providers-fields', d.groundTruthProvidersFields, d.recallProvidersFields, fails);
        strictGateRecall('di', 'exports-fields', d.groundTruthExportsFields, d.recallExportsFields, fails);
        strictGateRecall('di', 'controllers-fields', d.groundTruthControllersFields, d.recallControllersFields, fails);
        const totalRefs = d.totalImports + d.totalProviders + d.totalExports + d.totalControllers;
        strictGateResolve('di', totalRefs, d.resolveRate, fails);
    }
    if (enabled.imports) {
        if (i.groundTruthStatic === 0) {
            fails.push(`imports: zero ground-truth — appsGlob/libsGlob almost certainly broken`);
        } else if (i.recallStatic < 0.8) {
            fails.push(`imports recall ${pct(i.recallStatic)} (< 80%)`);
        }
    }

    return fails;
}

function strictGateRecall(
    domain: string,
    field: string,
    gt: number,
    recall: number,
    fails: string[],
    threshold = 0.95,
): void {
    if (gt === 0) return;
    if (recall < threshold) fails.push(`${domain} ${field} ${pct(recall)}`);
}

function strictGateResolve(
    domain: string,
    total: number,
    rate: number,
    fails: string[],
    threshold = 0.95,
): void {
    if (total === 0) return;
    if (rate < threshold) fails.push(`${domain} resolve ${pct(rate)} (< ${pct(threshold)})`);
}

// ---------------------------------------------------------------------------
// Build command
// ---------------------------------------------------------------------------

async function cmdBuild(args: ParsedArgs): Promise<void> {
    const ALLOWED_ONLY = ['nats', 'typeorm', 'bullmq', 'di', 'http', 'imports'] as const;
    if (args.only && !ALLOWED_ONLY.includes(args.only as (typeof ALLOWED_ONLY)[number])) {
        process.stderr.write(
            `error: --only=${args.only} not yet supported; available: ${ALLOWED_ONLY.join(', ')}\n`,
        );
        process.exit(2);
    }
    const cfg = await loadConfigWithContext(args.config);
    const result = await runBuild(cfg);

    const outDir = resolve(args.out);
    await writeGraphJson(result.graph, `${outDir}/graph.json`);
    await writeDiagnostics(result.diagnostics, `${outDir}/diagnostics.json`);
    await writeValidationReport(result.validation, `${outDir}/validation.json`);

    // Always emit the full Mermaid flowchart alongside graph.json.
    const mermaidPath = `${outDir}/graph.mermaid`;
    await writeGraphMermaid(result.graph, mermaidPath);

    // Optional extra slicing per user request.
    let extraSliceFiles: string[] = [];
    if (args.mermaidSlice && args.mermaidSlice.kind !== 'full') {
        if (args.mermaidSlice.kind === 'per-service') {
            extraSliceFiles = await writeGraphMermaid(
                result.graph,
                `${outDir}/mermaid`,
                { slice: args.mermaidSlice },
            );
        } else {
            // domain:<key>
            const file = `${outDir}/${args.mermaidSlice.domain}.mermaid`;
            extraSliceFiles = await writeGraphMermaid(result.graph, file, {
                slice: args.mermaidSlice,
            });
        }
    }

    if (!args.quiet) {
        process.stdout.write(`\n✓ graph.json:      ${outDir}/graph.json (${result.graph.nodes.length} nodes, ${result.graph.edges.length} edges)\n`);
        process.stdout.write(`✓ diagnostics.json: ${outDir}/diagnostics.json\n`);
        process.stdout.write(`✓ validation.json:  ${outDir}/validation.json\n`);
        process.stdout.write(`✓ graph.mermaid:    ${mermaidPath}\n`);
        if (extraSliceFiles.length > 0) {
            process.stdout.write(
                `✓ mermaid slice (${describeSlice(args.mermaidSlice!)}): ${extraSliceFiles.length} file(s)\n`,
            );
            for (const f of extraSliceFiles) {
                process.stdout.write(`    ${f}\n`);
            }
        }
    }

    // Determine which domains are enabled
    const enabled: Record<string, boolean> = {
        nats: cfg.domains?.nats !== false,
        typeorm: cfg.domains?.typeorm !== false,
        bullmq: cfg.domains?.bullmq !== false,
        di: cfg.domains?.di !== false,
        http: cfg.domains?.http !== false,
        imports: cfg.domains?.imports !== false,
    };

    // Build per-domain rows for advisory table
    const rows = buildDomainRows(result.validation, result.diagnostics, enabled);

    // Print the validation table (advisory mode: always; strict mode: always; quiet: never)
    if (!args.quiet) {
        printValidationTable(rows);
    }

    // Strict mode: hard-fail exactly like the old behavior
    if (args.strict) {
        const fails = computeStrictFails(result.validation, enabled);
        if (fails.length > 0) {
            process.stderr.write(`\n⚠  regression gate failed (--strict):\n  ${fails.join('\n  ')}\nSee validation.json.\n`);
            process.exit(3);
        }
    }
    // Default (advisory) mode: always exit 0
}

function pct(n: number): string {
    return `${(n * 100).toFixed(1)}%`;
}

function describeSlice(slice: MermaidSliceMode): string {
    if (slice.kind === 'full') return 'full';
    if (slice.kind === 'per-service') return 'per-service';
    return `domain:${slice.domain}`;
}

async function loadConfigWithContext(path: string): Promise<Awaited<ReturnType<typeof loadConfig>>> {
    const absolute = resolve(path);
    try {
        return await loadConfig(absolute);
    } catch (err) {
        const e = err as Error;
        throw new Error(
            `failed to load config '${absolute}': ${e.message}\n  Run 'arch-graph init' to create a starter config.`,
            { cause: err },
        );
    }
}

async function cmdDiagnose(args: ParsedArgs): Promise<void> {
    const cfg = await loadConfigWithContext(args.config);
    const result = await runBuild(cfg);

    const n = result.diagnostics.nats;
    const t = result.diagnostics.typeorm;
    const b = result.diagnostics.bullmq;
    const di = result.diagnostics.di;
    const hd = result.diagnostics.http;
    const im = result.diagnostics.imports;
    process.stdout.write(`\n--- diagnostics for ${cfg.id} ---\n`);
    process.stdout.write(`[nats]    literal=${n.counts.literal} pattern=${n.counts.pattern} dynamic=${n.counts.dynamic} unresolved=${n.counts.unresolved}\n`);
    process.stdout.write(`[typeorm] resolved=${t.counts.resolved} unresolvedEntity=${t.counts.unresolvedEntity} unowned=${t.counts.unowned} entityWarnings=${t.counts.entityDecoratorWarnings}\n`);
    process.stdout.write(`[bullmq]  producers=${b.counts.producers} consumers=${b.counts.consumers} registrations=${b.counts.registrations} unresolved=${b.counts.unresolved} unowned=${b.counts.unowned}\n`);
    process.stdout.write(`[di]      modules=${di.counts.modules} imports=${di.counts.imports} providers=${di.counts.providers} exports=${di.counts.exports} controllers=${di.counts.controllers} unresolvedRefs=${di.counts.unresolvedRefs} unowned=${di.counts.unowned}\n`);
    process.stdout.write(`[http]    total=${hd.counts.totalSites} literal=${hd.counts.literal} envRef=${hd.counts.envRef} pattern=${hd.counts.pattern} unresolved=${hd.counts.unresolved} internal=${hd.counts.internal} external=${hd.counts.external} unowned=${hd.counts.unowned}\n`);
    process.stdout.write(`[imports] static=${im.counts.totalStatic} dynamic=${im.counts.totalDynamic} resolved=${im.counts.resolvedToOwner} external/unres=${im.counts.externalOrUnresolved} unresolvedInternal=${im.counts.unresolvedInternal}\n`);

    if (n.unresolved.length > 0) {
        process.stdout.write(`\nTop 10 unresolved NATS subjects:\n`);
        for (const u of n.unresolved.slice(0, 10)) {
            const raw = u.subject.kind === 'unresolved' ? u.subject.raw : '';
            process.stdout.write(`  ${u.location.file}:${u.location.line} via=${u.via}  ${raw}\n`);
        }
    }

    if (t.unresolvedEntities.length > 0) {
        process.stdout.write(`\nTop 10 unresolved TypeORM entities:\n`);
        for (const u of t.unresolvedEntities.slice(0, 10)) {
            process.stdout.write(`  ${u.location.file}:${u.location.line}  @InjectRepository(${u.entityClass})\n`);
        }
    }

    if (n.unowned.length + t.unowned.length > 0) {
        process.stdout.write(`\nUnowned call-sites (outside apps/ & libs/): nats=${n.unowned.length}, typeorm=${t.unowned.length}\n`);
    }

    if (im.unresolvedImports.length > 0) {
        process.stdout.write(`\nTop 10 unresolved internal imports (likely typo'd alias or broken path):\n`);
        for (const u of im.unresolvedImports.slice(0, 10)) {
            process.stdout.write(`  ${u.location.file}:${u.location.line}  '${u.specifier}'\n`);
        }
    }

    const outDir = resolve(args.out);
    await writeDiagnostics(result.diagnostics, `${outDir}/diagnostics.json`);
    process.stdout.write(`\n✓ wrote ${outDir}/diagnostics.json\n`);
}

async function cmdMcp(args: ParsedArgs): Promise<void> {
    const outDir = resolve(args.out);
    // Log to stderr so we don't pollute the stdio JSON-RPC channel on stdout.
    process.stderr.write(`arch-graph mcp: serving ${outDir}/graph.json over stdio\n`);
    await startMcpServer({ out: outDir });
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const cmd = argv[0];

    if (!cmd || cmd === '-h' || cmd === '--help') {
        process.stdout.write(HELP);
        process.exit(cmd ? 0 : 1);
    }

    // Two-token subcommand groups: dispatch BEFORE the flag parser so we don't
    // mis-interpret `install` / `uninstall` / `status` as positional config paths.
    if (cmd === 'claude') {
        const { sub, args } = parseClaudeArgs(argv.slice(1));
        if (sub === 'install') return claudeInstall(args);
        if (sub === 'uninstall') return claudeUninstall(args);
        process.stderr.write(`unknown subcommand: claude ${sub}\n${HELP}`);
        process.exit(1);
    }
    if (cmd === 'hook') {
        const { sub, args } = parseHookArgs(argv.slice(1));
        if (sub === 'install') return hookInstall(args);
        if (sub === 'uninstall') return hookUninstall(args);
        if (sub === 'status') return hookStatus(args);
        process.stderr.write(`unknown subcommand: hook ${sub}\n${HELP}`);
        process.exit(1);
    }
    if (cmd === 'install-skill') {
        return installSkill();
    }

    // Query subcommands: dispatch before flag-parser so positionals aren't
    // mis-interpreted as config paths. Exit codes: 0=found, 4=not found.
    if (QUERY_CMDS.has(cmd)) {
        const qargs = parseQueryArgs(argv);
        await runQueryCommand(qargs);
        return;
    }

    const args = parseArgs(argv);
    switch (args.cmd) {
        case 'init':
            await cmdInit(args.out === './arch-graph-out' ? './arch-graph.config.ts' : args.out);
            return;
        case 'build':
            await cmdBuild(args);
            return;
        case 'diagnose':
            await cmdDiagnose(args);
            return;
        case 'mcp':
            await cmdMcp(args);
            return;
        default:
            process.stderr.write(`unknown command: ${args.cmd}\n${HELP}`);
            process.exit(1);
    }
}

main().catch((err) => {
    process.stderr.write(`fatal: ${err}\n${(err as Error)?.stack ?? ''}\n`);
    process.exit(1);
});
