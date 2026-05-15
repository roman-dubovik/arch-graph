import { join } from 'node:path';
import { Project } from 'ts-morph';

import type { ArchGraphConfig } from '../core/config.js';
import { discoverOwnership } from '../core/service-registry.js';
import type { ArchGraph, BuildValidation, DiagnosticsReport } from '../core/types.js';
import { extractNats } from '../extractors/nats/extractor.js';
import { extractTypeOrm } from '../extractors/typeorm/extractor.js';
import { assembleGraph, buildNatsDiagnostics, mapNatsToGraph } from '../mapper/nats-to-graph.js';
import { mapTypeOrmToGraph } from '../mapper/typeorm-to-graph.js';
import { enumerateHandlers } from '../validation/handlers.js';
import { enumerateSenders } from '../validation/senders.js';
import { enumerateTypeOrmGroundTruth, buildTypeOrmReport } from '../validation/typeorm-validator.js';
import { buildReport as buildNatsReport } from '../validation/validator.js';

export interface BuildResult {
    graph: ArchGraph;
    diagnostics: DiagnosticsReport;
    validation: BuildValidation;
}

/**
 * Single-pass multi-domain build:
 *   1. Discover services + libs (ownership)
 *   2. Load all .ts sources into one ts-morph Project
 *   3. Per domain: extract → validate (regression gate) → map to graph parts
 *   4. Merge graph parts into final ArchGraph
 *   5. Compose top-level diagnostics + validation reports
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

    // ---- NATS domain ----
    process.stdout.write(`extracting NATS...\n`);
    let t0 = Date.now();
    const callSites = await extractNats(cfg, project);
    process.stdout.write(`  ${callSites.length} call sites in ${Date.now() - t0}ms\n`);

    process.stdout.write(`validating NATS against ground truth...\n`);
    const [handlers, senders] = await Promise.all([
        enumerateHandlers(cfg),
        enumerateSenders(cfg),
    ]);
    const natsValidation = buildNatsReport(cfg.id, callSites, [...handlers, ...senders]);
    {
        const v = natsValidation.summary;
        process.stdout.write(
            `  recallH=${pct(v.recallHandlers)} recallS=${pct(v.recallSenders)} classify=${pct(v.classificationAccuracy)} resolve=${pct(v.resolveRate)}\n`,
        );
    }

    process.stdout.write(`mapping NATS to graph...\n`);
    const natsMapped = mapNatsToGraph(callSites, ownership);
    process.stdout.write(
        `  nodes: ${natsMapped.nodes.length}, edges: ${natsMapped.edges.length}, unresolved: ${natsMapped.diagnostics.unresolved.length}, dynamic: ${natsMapped.diagnostics.dynamic.length}, unowned: ${natsMapped.diagnostics.unowned.length}\n`,
    );
    const natsDiagnostics = buildNatsDiagnostics(callSites, natsMapped);

    // ---- TypeORM domain ----
    process.stdout.write(`extracting TypeORM...\n`);
    t0 = Date.now();
    const typeorm = await extractTypeOrm(cfg, project);
    process.stdout.write(
        `  ${typeorm.sites.length} @InjectRepository sites, ${typeorm.entities.size()} @Entity classes in ${Date.now() - t0}ms\n`,
    );

    process.stdout.write(`validating TypeORM against ground truth...\n`);
    const typeormGT = await enumerateTypeOrmGroundTruth(cfg);
    const typeormValidation = buildTypeOrmReport(
        cfg.id,
        typeorm.sites,
        typeorm.entities.entries(),
        typeormGT,
    );
    {
        const v = typeormValidation.summary;
        process.stdout.write(
            `  recallInj=${pct(v.recallInjections)} recallEnt=${pct(v.recallEntities)} resolve=${pct(v.resolveRate)}\n`,
        );
    }

    process.stdout.write(`mapping TypeORM to graph...\n`);
    const typeormMapped = mapTypeOrmToGraph(typeorm.sites, ownership);
    process.stdout.write(
        `  nodes: ${typeormMapped.nodes.length}, edges: ${typeormMapped.edges.length}, unresolved: ${typeormMapped.diagnostics.unresolvedEntities.length}, unowned: ${typeormMapped.diagnostics.unowned.length}\n`,
    );

    // ---- Compose ----
    const graph = assembleGraph(cfg.root, [natsMapped, typeormMapped]);
    const diagnostics: DiagnosticsReport = {
        projectId: cfg.id,
        timestamp: new Date().toISOString(),
        nats: natsDiagnostics,
        typeorm: typeormMapped.diagnostics,
    };
    const validation: BuildValidation = {
        projectId: cfg.id,
        timestamp: new Date().toISOString(),
        nats: natsValidation,
        typeorm: typeormValidation,
    };

    return { graph, diagnostics, validation };
}

function pct(n: number): string {
    return `${(n * 100).toFixed(1)}%`;
}
