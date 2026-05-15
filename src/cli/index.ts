import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadConfig } from '../core/config.js';
import { writeDiagnostics, writeGraphJson, writeValidationReport } from '../output/graph-json.js';
import { runBuild } from '../pipeline/build.js';

interface ParsedArgs {
    cmd: string;
    config: string;
    out: string;
    only?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
    const [cmd, ...rest] = argv;
    let config = './arch-graph.config.ts';
    let out = './arch-graph-out';
    let only: string | undefined;

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
        }
    }
    return { cmd: cmd ?? '', config, out, only };
}

const HELP = `
arch-graph — static architecture graph extractor

Usage:
  arch-graph build      [--config <path>] [--out <dir>] [--only=<extractor>]
  arch-graph diagnose   [--config <path>] [--out <dir>]
  arch-graph init       [--out <path>]

Defaults:
  --config  ./arch-graph.config.ts
  --out     ./arch-graph-out
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
});
`;

async function cmdInit(out: string): Promise<void> {
    const target = resolve(out);
    await writeFile(target, INIT_TEMPLATE, 'utf8');
    process.stdout.write(`wrote ${target}\n`);
}

async function cmdBuild(args: ParsedArgs): Promise<void> {
    if (args.only && args.only !== 'nats' && args.only !== 'typeorm' && args.only !== 'bullmq' && args.only !== 'di') {
        process.stderr.write(`error: --only=${args.only} not yet supported; available: 'nats', 'typeorm', 'bullmq', 'di'\n`);
        process.exit(2);
    }
    const cfg = await loadConfigWithContext(args.config);
    const result = await runBuild(cfg);

    const outDir = resolve(args.out);
    await writeGraphJson(result.graph, `${outDir}/graph.json`);
    await writeDiagnostics(result.diagnostics, `${outDir}/diagnostics.json`);
    await writeValidationReport(result.validation, `${outDir}/validation.json`);

    process.stdout.write(`\n✓ graph.json:      ${outDir}/graph.json (${result.graph.nodes.length} nodes, ${result.graph.edges.length} edges)\n`);
    process.stdout.write(`✓ diagnostics.json: ${outDir}/diagnostics.json\n`);
    process.stdout.write(`✓ validation.json:  ${outDir}/validation.json\n`);

    // Regression gate: hard fail if any *enabled* domain produced zero ground-truth
    // (misconfig) or dropped below 95% recall. Disable via `domains.<x> = false`.
    const n = result.validation.nats.summary;
    const t = result.validation.typeorm.summary;
    const b = result.validation.bullmq.summary;
    const d = result.validation.di.summary;
    const natsEnabled = cfg.domains?.nats !== false;
    const typeormEnabled = cfg.domains?.typeorm !== false;
    const bullmqEnabled = cfg.domains?.bullmq !== false;
    const diEnabled = cfg.domains?.di !== false;
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

    if (fails.length > 0) {
        process.stderr.write(`\n⚠  regression gate failed:\n  ${fails.join('\n  ')}\nSee validation.json.\n`);
        process.exit(3);
    }
}

function pct(n: number): string {
    return `${(n * 100).toFixed(1)}%`;
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
    process.stdout.write(`\n--- diagnostics for ${cfg.id} ---\n`);
    process.stdout.write(`[nats]    literal=${n.counts.literal} pattern=${n.counts.pattern} dynamic=${n.counts.dynamic} unresolved=${n.counts.unresolved}\n`);
    process.stdout.write(`[typeorm] resolved=${t.counts.resolved} unresolvedEntity=${t.counts.unresolvedEntity} unowned=${t.counts.unowned} entityWarnings=${t.counts.entityDecoratorWarnings}\n`);
    process.stdout.write(`[bullmq]  producers=${b.counts.producers} consumers=${b.counts.consumers} registrations=${b.counts.registrations} unresolved=${b.counts.unresolved} unowned=${b.counts.unowned}\n`);
    process.stdout.write(`[di]      modules=${di.counts.modules} imports=${di.counts.imports} providers=${di.counts.providers} exports=${di.counts.exports} controllers=${di.counts.controllers} unresolvedRefs=${di.counts.unresolvedRefs} unowned=${di.counts.unowned}\n`);

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
