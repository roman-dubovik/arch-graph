import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadConfig } from '../core/config.js';
import { writeDiagnostics, writeGraphJson, writeValidationReport } from '../output/graph-json.js';
import {
    parseSliceMode,
    writeGraphMermaid,
    type MermaidSliceMode,
} from '../output/graph-mermaid.js';
import { runBuild } from '../pipeline/build.js';

interface ParsedArgs {
    cmd: string;
    config: string;
    out: string;
    only?: string;
    /** Optional extra slice; `graph.mermaid` (full) is always written. */
    mermaidSlice?: MermaidSliceMode;
}

function parseArgs(argv: string[]): ParsedArgs {
    const [cmd, ...rest] = argv;
    let config = './arch-graph.config.ts';
    let out = './arch-graph-out';
    let only: string | undefined;
    let mermaidSlice: MermaidSliceMode | undefined;

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
        }
    }
    return { cmd: cmd ?? '', config, out, only, mermaidSlice };
}

const HELP = `
arch-graph — static architecture graph extractor

Usage:
  arch-graph build      [--config <path>] [--out <dir>] [--only=<extractor>] [--mermaid-slice=<mode>]
  arch-graph diagnose   [--config <path>] [--out <dir>]
  arch-graph init       [--out <path>]

Defaults:
  --config  ./arch-graph.config.ts
  --out     ./arch-graph-out

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

    // Regression gate: hard fail if any *enabled* domain produced zero ground-truth
    // (misconfig) or dropped below 95% recall. Disable via `domains.<x> = false`.
    const n = result.validation.nats.summary;
    const t = result.validation.typeorm.summary;
    const b = result.validation.bullmq.summary;
    const d = result.validation.di.summary;
    const h = result.validation.http.summary;
    const i = result.validation.imports.summary;
    const natsEnabled = cfg.domains?.nats !== false;
    const typeormEnabled = cfg.domains?.typeorm !== false;
    const bullmqEnabled = cfg.domains?.bullmq !== false;
    const diEnabled = cfg.domains?.di !== false;
    const httpEnabled = cfg.domains?.http !== false;
    const importsEnabled = cfg.domains?.imports !== false;
    const fails: string[] = [];

    // Per-role zero-GT: handlers misconfig and senders misconfig fail independently
    // (otherwise a zero on one side hides behind a non-zero on the other).
    if (natsEnabled) {
        if (n.groundTruthHandlers === 0) fails.push(`nats: zero handler ground-truth — check subscribe decorators / wrapperSubscribeApis`);
        if (n.groundTruthSenders === 0) fails.push(`nats: zero sender ground-truth — check wrapperPublishApis (typo'd class name?)`);
        gateRecall(natsEnabled, 'nats', 'handlers', n.groundTruthHandlers, n.recallHandlers, fails);
        gateRecall(natsEnabled, 'nats', 'senders', n.groundTruthSenders, n.recallSenders, fails);
    }
    if (typeormEnabled) {
        if (t.groundTruthInjections === 0) fails.push(`typeorm: zero injection ground-truth — check appsGlob / @InjectRepository usage`);
        if (t.groundTruthEntities === 0) fails.push(`typeorm: zero entity ground-truth — check @Entity declarations in libs/`);
        gateRecall(typeormEnabled, 'typeorm', 'injections', t.groundTruthInjections, t.recallInjections, fails);
        gateRecall(typeormEnabled, 'typeorm', 'entities', t.groundTruthEntities, t.recallEntities, fails);
        // Low resolveRate = many @InjectRepository(X) didn't match a known @Entity —
        // usually a real extractor gap (alias re-exports, namespaced imports) worth gating.
        gateResolve(typeormEnabled, 'typeorm', t.totalInjections, t.resolveRate, fails);
    }
    if (httpEnabled) {
        // HTTP is opt-in via gate: a project with no HTTP at all should set `domains.http=false`.
        // We only gate on recall (the resolve metric reflects how *interpretable* the URLs are —
        // a project with 80% external `fetch(literal)` legitimately has low "resolve" by the spec).
        if (h.groundTruthCalls === 0) {
            fails.push(`http: zero ground-truth — set domains.http=false if this project has no HTTP usage`);
        }
        gateRecall(httpEnabled, 'http', 'recall', h.groundTruthCalls, h.recallCalls, fails);
    }
    if (bullmqEnabled) {
        // Per-role zero-GT — each role gates independently. A project with @InjectQueue but
        // no @Processor is legitimate; both being zero usually means BullMQ isn't in the project
        // and the operator should set `domains.bullmq = false`.
        const anyGt = b.groundTruthProducers + b.groundTruthConsumers + b.groundTruthRegistrations;
        if (anyGt === 0) fails.push(`bullmq: zero ground-truth across producers/consumers/registrations — set domains.bullmq=false if this project has no BullMQ`);
        gateRecall(bullmqEnabled, 'bullmq', 'producers', b.groundTruthProducers, b.recallProducers, fails);
        gateRecall(bullmqEnabled, 'bullmq', 'consumers', b.groundTruthConsumers, b.recallConsumers, fails);
        gateRecall(bullmqEnabled, 'bullmq', 'registrations', b.groundTruthRegistrations, b.recallRegistrations, fails);
        const totalSites = b.totalProducers + b.totalConsumers + b.totalRegistrations;
        gateResolve(bullmqEnabled, 'bullmq', totalSites, b.resolveRate, fails);
    }
    if (diEnabled) {
        // `module` recall is the primary contract — every `@Module(` in source must be
        // extracted. Field-presence recall (imports/providers/exports/controllers) catches
        // regressions in the field-decoder logic. `resolveRate` catches ref-decoder regressions.
        if (d.groundTruthModules === 0) {
            fails.push(`di: zero @Module ground-truth — set domains.di=false if this project is not NestJS`);
        }
        gateRecall(diEnabled, 'di', 'modules', d.groundTruthModules, d.recallModules, fails);
        gateRecall(diEnabled, 'di', 'imports-fields', d.groundTruthImportsFields, d.recallImportsFields, fails);
        gateRecall(diEnabled, 'di', 'providers-fields', d.groundTruthProvidersFields, d.recallProvidersFields, fails);
        gateRecall(diEnabled, 'di', 'exports-fields', d.groundTruthExportsFields, d.recallExportsFields, fails);
        gateRecall(diEnabled, 'di', 'controllers-fields', d.groundTruthControllersFields, d.recallControllersFields, fails);
        const totalRefs = d.totalImports + d.totalProviders + d.totalExports + d.totalControllers;
        gateResolve(diEnabled, 'di', totalRefs, d.resolveRate, fails);
    }

    if (importsEnabled) {
        // Imports gate: GT must be non-zero (every project has imports), and
        // aggregate recall must be reasonable. We aim for 80% — ts-morph's
        // alias resolution is imperfect without a per-app Project, so we
        // accept a lower bar than NATS/TypeORM/BullMQ. See OPEN-QUESTIONS.
        if (i.groundTruthStatic === 0) {
            fails.push(`imports: zero ground-truth — appsGlob/libsGlob almost certainly broken`);
        } else if (i.recallStatic < 0.8) {
            fails.push(`imports recall ${pct(i.recallStatic)} (< 80%)`);
        }
    }

    if (fails.length > 0) {
        process.stderr.write(`\n⚠  regression gate failed:\n  ${fails.join('\n  ')}\nSee validation.json.\n`);
        process.exit(3);
    }
}

function pct(n: number): string {
    return `${(n * 100).toFixed(1)}%`;
}

/** Push a recall failure if `enabled`, GT is non-zero, and `recall` is below `threshold`. */
function gateRecall(
    enabled: boolean,
    domain: string,
    field: string,
    gt: number,
    recall: number,
    fails: string[],
    threshold = 0.95,
): void {
    if (!enabled || gt === 0) return;
    if (recall < threshold) fails.push(`${domain} ${field} ${pct(recall)}`);
}

/** Push a resolve failure if `enabled`, total is non-zero, and `rate` is below `threshold`. */
function gateResolve(
    enabled: boolean,
    domain: string,
    total: number,
    rate: number,
    fails: string[],
    threshold = 0.95,
): void {
    if (!enabled || total === 0) return;
    if (rate < threshold) fails.push(`${domain} resolve ${pct(rate)} (< ${pct(threshold)})`);
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

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (!args.cmd || args.cmd === '-h' || args.cmd === '--help') {
        process.stdout.write(HELP);
        process.exit(args.cmd ? 0 : 1);
    }

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
        default:
            process.stderr.write(`unknown command: ${args.cmd}\n${HELP}`);
            process.exit(1);
    }
}

main().catch((err) => {
    process.stderr.write(`fatal: ${err}\n${(err as Error)?.stack ?? ''}\n`);
    process.exit(1);
});
