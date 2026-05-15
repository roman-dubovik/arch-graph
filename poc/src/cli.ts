import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Project } from 'ts-morph';

import { extractNats } from './extractors/nats.extractor.js';
import { enumerateHandlers } from './ground-truth/handlers.js';
import { enumerateSenders } from './ground-truth/senders.js';
import { writeJsonReport, writeMarkdownReport } from './reporter.js';
import { discoverServices } from './service-registry.js';
import type { ProjectConfig } from './types.js';
import { buildReport } from './validator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POC_ROOT = resolve(__dirname, '..');

async function loadConfig(name: string): Promise<ProjectConfig> {
    const path = join(POC_ROOT, 'config', `${name}.json`);
    const txt = await readFile(path, 'utf8');
    return JSON.parse(txt) as ProjectConfig;
}

async function runProject(name: string): Promise<void> {
    const cfg = await loadConfig(name);
    process.stdout.write(`\n=== ${cfg.id} ===\n`);
    process.stdout.write(`root: ${cfg.root}\n`);

    const services = await discoverServices(cfg);
    process.stdout.write(`services: ${services.length}\n`);

    // Build one ts-morph project covering all service tsconfigs + libs.
    // For POC simplicity we add files by glob (don't rely on tsconfig path resolution).
    const project = new Project({
        useInMemoryFileSystem: false,
        skipAddingFilesFromTsConfig: true,
        compilerOptions: {
            allowJs: false,
            // permissive — we want AST, not type-checking strictness
            strict: false,
            noEmit: true,
        },
    });

    const globs = [
        join(cfg.root, cfg.appsGlob, '**/*.ts'),
        ...(cfg.libsGlob ? [join(cfg.root, cfg.libsGlob, '**/*.ts')] : []),
    ];
    for (const g of globs) {
        project.addSourceFilesAtPaths([
            g,
            '!' + join(cfg.root, '**/node_modules/**'),
            '!' + join(cfg.root, '**/dist/**'),
            '!' + join(cfg.root, '**/.claude/**'),
            '!' + join(cfg.root, '**/.worktrees/**'),
            '!**/*.spec.ts',
            '!**/*.test.ts',
            '!**/*.d.ts',
        ]);
    }
    process.stdout.write(`source files: ${project.getSourceFiles().length}\n`);

    process.stdout.write(`running NATS extractor...\n`);
    const t0 = Date.now();
    const extracted = await extractNats(cfg, project);
    process.stdout.write(`extracted ${extracted.length} call sites in ${Date.now() - t0}ms\n`);

    process.stdout.write(`enumerating ground truth (handlers)...\n`);
    const handlers = await enumerateHandlers(cfg);
    process.stdout.write(`  handlers: ${handlers.length}\n`);

    process.stdout.write(`enumerating ground truth (senders)...\n`);
    const senders = await enumerateSenders(cfg);
    process.stdout.write(`  senders: ${senders.length}\n`);

    const gt = [...handlers, ...senders];
    const report = buildReport(cfg.id, extracted, gt);

    const outMd = join(POC_ROOT, 'reports', `${cfg.id}.md`);
    const outJson = join(POC_ROOT, 'reports', `${cfg.id}.json`);
    await writeMarkdownReport(report, cfg, outMd);
    await writeJsonReport(report, outJson);

    const s = report.summary;
    process.stdout.write(
        `\nResults: recallH=${(s.recallHandlers * 100).toFixed(1)}% recallS=${(s.recallSenders * 100).toFixed(1)}% classify=${(s.classificationAccuracy * 100).toFixed(1)}% resolve=${(s.resolveRate * 100).toFixed(1)}%\n`,
    );
    process.stdout.write(`reports: ${outMd}\n`);
}

async function main(): Promise<void> {
    const [, , cmd, ...rest] = process.argv;
    if (cmd === 'project') {
        const name = rest[0];
        if (!name) {
            process.stderr.write('usage: cli project <name>\n');
            process.exit(1);
        }
        await runProject(name);
        return;
    }
    if (cmd === 'all') {
        const names = ['platform', 'insyra', 'beribuy2', 'unpacks', 'screenia'];
        for (const n of names) {
            try {
                await runProject(n);
            } catch (err) {
                process.stderr.write(`FAILED ${n}: ${(err as Error).message}\n`);
            }
        }
        return;
    }
    process.stderr.write('usage:\n  cli project <name>\n  cli all\n');
    process.exit(1);
}

main().catch((err) => {
    process.stderr.write(`fatal: ${err}\n${err?.stack ?? ''}\n`);
    process.exit(1);
});
