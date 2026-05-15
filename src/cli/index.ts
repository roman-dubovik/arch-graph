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
  arch-graph mcp        [--out <dir>]
                        starts an MCP stdio server backed by <out>/graph.json

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
        if (n.groundTruthHandlers > 0 && n.recallHandlers < 0.95) fails.push(`nats handlers ${pct(n.recallHandlers)}`);
        if (n.groundTruthSenders > 0 && n.recallSenders < 0.95) fails.push(`nats senders ${pct(n.recallSenders)}`);
    }
    if (typeormEnabled) {
        if (t.groundTruthInjections === 0) fails.push(`typeorm: zero injection ground-truth — check appsGlob / @InjectRepository usage`);
        if (t.groundTruthEntities === 0) fails.push(`typeorm: zero entity ground-truth — check @Entity declarations in libs/`);
        if (t.groundTruthInjections > 0 && t.recallInjections < 0.95) fails.push(`typeorm injections ${pct(t.recallInjections)}`);
        if (t.groundTruthEntities > 0 && t.recallEntities < 0.95) fails.push(`typeorm entities ${pct(t.recallEntities)}`);
        // Low resolveRate = many @InjectRepository(X) didn't match a known @Entity —
        // usually a real extractor gap (alias re-exports, namespaced imports) worth gating.
        if (t.totalInjections > 0 && t.resolveRate < 0.95) {
            fails.push(`typeorm resolve ${pct(t.resolveRate)} (< 95%)`);
        }
    }
    if (httpEnabled) {
        // HTTP is opt-in via gate: a project with no HTTP at all should set `domains.http=false`.
        // We only gate on recall (the resolve metric reflects how *interpretable* the URLs are —
        // a project with 80% external `fetch(literal)` legitimately has low "resolve" by the spec).
        if (h.groundTruthCalls === 0) {
            fails.push(`http: zero ground-truth — set domains.http=false if this project has no HTTP usage`);
        }
        if (h.groundTruthCalls > 0 && h.recallCalls < 0.95) {
            fails.push(`http recall ${pct(h.recallCalls)}`);
        }
    }
    if (bullmqEnabled) {
        // Per-role zero-GT — each role gates independently. A project with @InjectQueue but
        // no @Processor is legitimate; both being zero usually means BullMQ isn't in the project
        // and the operator should set `domains.bullmq = false`.
        const anyGt = b.groundTruthProducers + b.groundTruthConsumers + b.groundTruthRegistrations;
        if (anyGt === 0) fails.push(`bullmq: zero ground-truth across producers/consumers/registrations — set domains.bullmq=false if this project has no BullMQ`);
        if (b.groundTruthProducers > 0 && b.recallProducers < 0.95) fails.push(`bullmq producers ${pct(b.recallProducers)}`);
        if (b.groundTruthConsumers > 0 && b.recallConsumers < 0.95) fails.push(`bullmq consumers ${pct(b.recallConsumers)}`);
        if (b.groundTruthRegistrations > 0 && b.recallRegistrations < 0.95) fails.push(`bullmq registrations ${pct(b.recallRegistrations)}`);
        const totalSites = b.totalProducers + b.totalConsumers + b.totalRegistrations;
        if (totalSites > 0 && b.resolveRate < 0.95) {
            fails.push(`bullmq resolve ${pct(b.resolveRate)} (< 95%)`);
        }
    }
    if (diEnabled) {
        // `module` recall is the primary contract — every `@Module(` in source must be
        // extracted. Field-presence recall (imports/providers/exports/controllers) catches
        // regressions in the field-decoder logic. `resolveRate` catches ref-decoder regressions.
        if (d.groundTruthModules === 0) {
            fails.push(`di: zero @Module ground-truth — set domains.di=false if this project is not NestJS`);
        }
        if (d.groundTruthModules > 0 && d.recallModules < 0.95) fails.push(`di modules ${pct(d.recallModules)}`);
        if (d.groundTruthImportsFields > 0 && d.recallImportsFields < 0.95) fails.push(`di imports-fields ${pct(d.recallImportsFields)}`);
        if (d.groundTruthProvidersFields > 0 && d.recallProvidersFields < 0.95) fails.push(`di providers-fields ${pct(d.recallProvidersFields)}`);
        if (d.groundTruthExportsFields > 0 && d.recallExportsFields < 0.95) fails.push(`di exports-fields ${pct(d.recallExportsFields)}`);
        if (d.groundTruthControllersFields > 0 && d.recallControllersFields < 0.95) fails.push(`di controllers-fields ${pct(d.recallControllersFields)}`);
        const totalRefs = d.totalImports + d.totalProviders + d.totalExports + d.totalControllers;
        if (totalRefs > 0 && d.resolveRate < 0.95) {
            fails.push(`di resolve ${pct(d.resolveRate)} (< 95%)`);
        }
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
