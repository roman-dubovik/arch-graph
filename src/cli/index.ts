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
    if (args.only && args.only !== 'nats') {
        process.stderr.write(`error: --only=${args.only} not yet supported; only 'nats' available in Phase 1\n`);
        process.exit(2);
    }
    const cfg = await loadConfig(args.config);
    const result = await runBuild(cfg);

    const outDir = resolve(args.out);
    await writeGraphJson(result.graph, `${outDir}/graph.json`);
    await writeDiagnostics(result.diagnostics, `${outDir}/diagnostics.json`);
    await writeValidationReport(result.validation, `${outDir}/validation.json`);

    process.stdout.write(`\n✓ graph.json:      ${outDir}/graph.json (${result.graph.nodes.length} nodes, ${result.graph.edges.length} edges)\n`);
    process.stdout.write(`✓ diagnostics.json: ${outDir}/diagnostics.json\n`);
    process.stdout.write(`✓ validation.json:  ${outDir}/validation.json\n`);

    // Regression gate: hard fail if recall drops below 95%.
    const v = result.validation.summary;
    if (v.recallHandlers < 0.95 || v.recallSenders < 0.95) {
        process.stderr.write(
            `\n⚠  regression: recall fell below 95% (handlers=${(v.recallHandlers * 100).toFixed(1)}%, senders=${(v.recallSenders * 100).toFixed(1)}%). See validation.json.\n`,
        );
        process.exit(3);
    }
}

async function cmdDiagnose(args: ParsedArgs): Promise<void> {
    const cfg = await loadConfig(args.config);
    const result = await runBuild(cfg);

    const counts = result.diagnostics.counts;
    process.stdout.write(`\n--- diagnostics for ${cfg.id} ---\n`);
    process.stdout.write(`literal:    ${counts.literal}\n`);
    process.stdout.write(`pattern:    ${counts.pattern}\n`);
    process.stdout.write(`dynamic:    ${counts.dynamic}\n`);
    process.stdout.write(`unresolved: ${counts.unresolved}\n`);

    if (result.diagnostics.unresolved.length > 0) {
        process.stdout.write(`\nTop 10 unresolved subjects:\n`);
        for (const u of result.diagnostics.unresolved.slice(0, 10)) {
            const raw = u.subject.kind === 'unresolved' ? u.subject.raw : '';
            process.stdout.write(`  ${u.location.file}:${u.location.line} via=${u.via}  ${raw}\n`);
        }
    }

    if (result.diagnostics.unowned.length > 0) {
        process.stdout.write(`\nUnowned call-sites (outside apps/ & libs/): ${result.diagnostics.unowned.length}\n`);
        for (const u of result.diagnostics.unowned.slice(0, 5)) {
            process.stdout.write(`  ${u.location.file}:${u.location.line}\n`);
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
