import { join } from 'node:path';
import { Project } from 'ts-morph';

import type { ArchGraphConfig } from '../core/config.js';
import { discoverOwnership } from '../core/service-registry.js';
import type { ArchGraph, DiagnosticsReport, ValidationReport } from '../core/types.js';
import { extractNats } from '../extractors/nats/extractor.js';
import { assembleGraph, buildDiagnostics, mapNatsToGraph } from '../mapper/nats-to-graph.js';
import { enumerateHandlers } from '../validation/handlers.js';
import { enumerateSenders } from '../validation/senders.js';
import { buildReport } from '../validation/validator.js';

export interface BuildResult {
    graph: ArchGraph;
    diagnostics: DiagnosticsReport;
    validation: ValidationReport;
}

/**
 * Single-pass build:
 *   1. Discover services + libs (ownership)
 *   2. Load all .ts sources into one ts-morph Project
 *   3. Run NATS extractor → NatsCallSite[]
 *   4. Validation against ground-truth (regression gate)
 *   5. Map to graph nodes/edges + diagnostics
 *   6. Assemble final ArchGraph
 */
export async function runBuild(cfg: ArchGraphConfig): Promise<BuildResult> {
    process.stdout.write(`\n=== ${cfg.id} ===\n`);
    process.stdout.write(`root: ${cfg.root}\n`);

    const ownership = await discoverOwnership(cfg);
    process.stdout.write(`services: ${ownership.services.length}, libs: ${ownership.libs.length}\n`);

    const project = new Project({
        useInMemoryFileSystem: false,
        skipAddingFilesFromTsConfig: true,
        compilerOptions: { allowJs: false, strict: false, noEmit: true },
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

    process.stdout.write(`extracting NATS...\n`);
    const t0 = Date.now();
    const callSites = await extractNats(cfg, project);
    process.stdout.write(`  ${callSites.length} call sites in ${Date.now() - t0}ms\n`);

    // Validation against grep ground-truth — regression gate.
    process.stdout.write(`validating against ground truth...\n`);
    const [handlers, senders] = await Promise.all([
        enumerateHandlers(cfg),
        enumerateSenders(cfg),
    ]);
    const validation = buildReport(cfg.id, callSites, [...handlers, ...senders]);
    const v = validation.summary;
    process.stdout.write(
        `  recallH=${pct(v.recallHandlers)} recallS=${pct(v.recallSenders)} classify=${pct(v.classificationAccuracy)} resolve=${pct(v.resolveRate)}\n`,
    );

    process.stdout.write(`mapping to graph...\n`);
    const mapped = mapNatsToGraph(callSites, ownership);
    process.stdout.write(
        `  nodes: ${mapped.nodes.length}, edges: ${mapped.edges.length}, unresolved: ${mapped.diagnostics.unresolved.length}, dynamic: ${mapped.diagnostics.dynamic.length}, unowned: ${mapped.diagnostics.unowned.length}\n`,
    );

    const diagnostics = buildDiagnostics(cfg.id, callSites, mapped);
    const graph = assembleGraph(cfg.root, [mapped]);

    return { graph, diagnostics, validation };
}

function pct(n: number): string {
    return `${(n * 100).toFixed(1)}%`;
}
