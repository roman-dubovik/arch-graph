import { join } from 'node:path';
import { Project } from 'ts-morph';

import type { ArchGraphConfig } from '../core/config.js';
import { discoverOwnership } from '../core/service-registry.js';
import type { ArchGraph, BuildValidation, DiagnosticsReport } from '../core/types.js';
import { extractBullMq } from '../extractors/bullmq/extractor.js';
import { extractDi } from '../extractors/di/extractor.js';
import { extractHttp } from '../extractors/http/extractor.js';
import { extractImports } from '../extractors/imports/extractor.js';
import { extractNats } from '../extractors/nats/extractor.js';
import { extractTypeOrm } from '../extractors/typeorm/extractor.js';
import { mapBullMqToGraph } from '../mapper/bullmq-to-graph.js';
import { mapDiToGraph } from '../mapper/di-to-graph.js';
import { mapHttpToGraph } from '../mapper/http-to-graph.js';
import { mapImportsToGraph } from '../mapper/imports-to-graph.js';
import { assembleGraph, buildNatsDiagnostics, mapNatsToGraph } from '../mapper/nats-to-graph.js';
import { mapTypeOrmToGraph } from '../mapper/typeorm-to-graph.js';
import { enumerateBullMqGroundTruth, buildBullMqReport } from '../validation/bullmq-validator.js';
import { enumerateDiGroundTruth, buildDiReport } from '../validation/di-validator.js';
import { enumerateHandlers } from '../validation/handlers.js';
import { enumerateHttpGroundTruth, buildHttpReport } from '../validation/http-validator.js';
import { buildImportsReport, enumerateImportsGroundTruth } from '../validation/imports-validator.js';
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
    // cfg.excludeGlobs MUST be applied here too — otherwise extractor and validator
    // disagree on the file set, and excluded paths become phantom `extra` matches
    // that mask real regressions in the gate. Convention: `cfg.excludeGlobs` entries
    // are path substrings (e.g. `/dist-poc/`) — wrapped with `**` to behave as
    // anywhere-in-path matchers, consistent with the validators.
    const extraExcludes = (cfg.excludeGlobs ?? []).map((g) => `!**${g}**`);
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
            ...extraExcludes,
        ]);
    }
    process.stdout.write(`source files: ${project.getSourceFiles().length}\n`);

    // ---- NATS domain ----
    process.stdout.write(`extracting NATS...\n`);
    let t0 = Date.now();
    const callSites = await stage(`[${cfg.id}] nats.extract`, () => extractNats(cfg, project));
    process.stdout.write(`  ${callSites.length} call sites in ${Date.now() - t0}ms\n`);

    process.stdout.write(`validating NATS against ground truth...\n`);
    const [handlers, senders] = await Promise.all([
        stage(`[${cfg.id}] nats.handlersGT`, () => enumerateHandlers(cfg)),
        stage(`[${cfg.id}] nats.sendersGT`, () => enumerateSenders(cfg)),
    ]);
    const natsValidation = buildNatsReport(callSites, [...handlers, ...senders]);
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
    const typeorm = await stage(`[${cfg.id}] typeorm.extract`, () => extractTypeOrm(cfg, project));
    process.stdout.write(
        `  ${typeorm.sites.length} @InjectRepository sites, ${typeorm.entities.size()} @Entity classes in ${Date.now() - t0}ms\n`,
    );

    process.stdout.write(`validating TypeORM against ground truth...\n`);
    const typeormGT = await stage(`[${cfg.id}] typeorm.GT`, () => enumerateTypeOrmGroundTruth(cfg));
    const typeormValidation = buildTypeOrmReport(
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
    const typeormMapped = mapTypeOrmToGraph(typeorm.sites, ownership, typeorm.entities.warnings);
    process.stdout.write(
        `  nodes: ${typeormMapped.nodes.length}, edges: ${typeormMapped.edges.length}, unresolved: ${typeormMapped.diagnostics.unresolvedEntities.length}, unowned: ${typeormMapped.diagnostics.unowned.length}, entityWarnings: ${typeormMapped.diagnostics.entityDecoratorWarnings.length}\n`,
    );

    // ---- BullMQ domain ----
    process.stdout.write(`extracting BullMQ...\n`);
    t0 = Date.now();
    const bullmq = await stage(`[${cfg.id}] bullmq.extract`, () => extractBullMq(cfg, project));
    process.stdout.write(
        `  ${bullmq.producers.length} @InjectQueue, ${bullmq.consumers.length} @Processor, ${bullmq.registrations.length} registerQueue in ${Date.now() - t0}ms\n`,
    );

    process.stdout.write(`validating BullMQ against ground truth...\n`);
    const bullmqGT = await stage(`[${cfg.id}] bullmq.GT`, () => enumerateBullMqGroundTruth(cfg));
    const bullmqValidation = buildBullMqReport(
        bullmq.producers,
        bullmq.consumers,
        bullmq.registrations,
        bullmqGT,
    );
    {
        const v = bullmqValidation.summary;
        process.stdout.write(
            `  recallProd=${pct(v.recallProducers)} recallCons=${pct(v.recallConsumers)} recallReg=${pct(v.recallRegistrations)} resolve=${pct(v.resolveRate)}\n`,
        );
    }

    process.stdout.write(`mapping BullMQ to graph...\n`);
    const bullmqMapped = mapBullMqToGraph(bullmq.producers, bullmq.consumers, bullmq.registrations, ownership);
    process.stdout.write(
        `  nodes: ${bullmqMapped.nodes.length}, edges: ${bullmqMapped.edges.length}, unresolved: ${bullmqMapped.diagnostics.unresolved.length}, unowned: ${bullmqMapped.diagnostics.unowned.length}\n`,
    );

    // ---- DI domain ----
    process.stdout.write(`extracting DI...\n`);
    t0 = Date.now();
    const di = await stage(`[${cfg.id}] di.extract`, () => extractDi(cfg, project));
    process.stdout.write(
        `  ${di.modules.length} @Module classes, ${di.moduleIndex.size()} indexed in ${Date.now() - t0}ms\n`,
    );

    process.stdout.write(`validating DI against ground truth...\n`);
    const diGT = await stage(`[${cfg.id}] di.GT`, () => enumerateDiGroundTruth(cfg));
    const diValidation = buildDiReport(di.modules, diGT);
    {
        const v = diValidation.summary;
        process.stdout.write(
            `  recallMod=${pct(v.recallModules)} recallImp=${pct(v.recallImportsFields)} recallProv=${pct(v.recallProvidersFields)} recallExp=${pct(v.recallExportsFields)} resolve=${pct(v.resolveRate)}\n`,
        );
    }

    process.stdout.write(`mapping DI to graph...\n`);
    const diMapped = mapDiToGraph(di.modules, di.moduleIndex, ownership);
    process.stdout.write(
        `  nodes: ${diMapped.nodes.length}, edges: ${diMapped.edges.length}, unresolvedRefs: ${diMapped.diagnostics.unresolvedRefs.length}, unowned: ${diMapped.diagnostics.unowned.length}\n`,
    );

    // ---- HTTP domain ----
    process.stdout.write(`extracting HTTP...\n`);
    t0 = Date.now();
    const httpSites = await stage(`[${cfg.id}] http.extract`, () => extractHttp(cfg, project));
    process.stdout.write(`  ${httpSites.length} HTTP call sites in ${Date.now() - t0}ms\n`);

    process.stdout.write(`validating HTTP against ground truth...\n`);
    const httpGT = await stage(`[${cfg.id}] http.GT`, () => enumerateHttpGroundTruth(cfg));
    const httpValidation = buildHttpReport(httpSites, httpGT, cfg.http);
    {
        const v = httpValidation.summary;
        process.stdout.write(
            `  recallCalls=${pct(v.recallCalls)} resolve=${pct(v.resolveRate)} internal=${v.internal} external=${v.external}\n`,
        );
    }

    process.stdout.write(`mapping HTTP to graph...\n`);
    const httpMapped = mapHttpToGraph(httpSites, ownership, cfg.http);
    process.stdout.write(
        `  nodes: ${httpMapped.nodes.length}, edges: ${httpMapped.edges.length}, unresolved: ${httpMapped.diagnostics.unresolved.length}, unowned: ${httpMapped.diagnostics.unowned.length}, externalEdges: ${httpMapped.diagnostics.counts.external}\n`,
    );

    // ---- TS-imports domain ----
    process.stdout.write(`extracting imports...\n`);
    t0 = Date.now();
    const imports = await stage(`[${cfg.id}] imports.extract`, () => extractImports(cfg, project));
    process.stdout.write(
        `  ${imports.sites.length} import sites in ${Date.now() - t0}ms\n`,
    );

    process.stdout.write(`validating imports against ground truth...\n`);
    const importsGT = await stage(`[${cfg.id}] imports.GT`, () => enumerateImportsGroundTruth(cfg));
    const importsValidation = buildImportsReport(imports.sites, importsGT);
    {
        const v = importsValidation.summary;
        process.stdout.write(
            `  recall=${pct(v.recallStatic)} minPerFile=${pct(v.minPerFileRecall)} files=${v.filesWithImports} GT=${v.groundTruthStatic} extracted=${v.totalStatic}\n`,
        );
    }

    process.stdout.write(`mapping imports to graph...\n`);
    const importsMapped = mapImportsToGraph(imports.sites, ownership, {
        fileLevel: cfg.imports?.fileLevel === true,
    });
    process.stdout.write(
        `  nodes: ${importsMapped.nodes.length}, edges: ${importsMapped.edges.length}, unresolvedInternal: ${importsMapped.diagnostics.counts.unresolvedInternal}, externalOrUnresolved: ${importsMapped.diagnostics.counts.externalOrUnresolved}, dynamic: ${importsMapped.diagnostics.counts.totalDynamic}\n`,
    );

    // ---- Compose ----
    const graph = assembleGraph(cfg.root, [
        natsMapped,
        typeormMapped,
        bullmqMapped,
        diMapped,
        httpMapped,
        importsMapped,
    ]);
    const diagnostics: DiagnosticsReport = {
        projectId: cfg.id,
        timestamp: new Date().toISOString(),
        nats: natsDiagnostics,
        typeorm: typeormMapped.diagnostics,
        bullmq: bullmqMapped.diagnostics,
        di: diMapped.diagnostics,
        http: httpMapped.diagnostics,
        imports: importsMapped.diagnostics,
        cycles: { cycles: [], counts: { tsImport: 0, libUsage: 0, diImport: 0, total: 0 } },
    };
    const validation: BuildValidation = {
        projectId: cfg.id,
        timestamp: new Date().toISOString(),
        nats: natsValidation,
        typeorm: typeormValidation,
        bullmq: bullmqValidation,
        di: diValidation,
        http: httpValidation,
        imports: importsValidation,
    };

    return { graph, diagnostics, validation };
}

function pct(n: number): string {
    return `${(n * 100).toFixed(1)}%`;
}

/**
 * Wrap a stage so any thrown error carries the stage name in its message.
 * Otherwise a fatal NATS-grep failure surfaces as a bare `ENOENT: ...` with
 * no indication of which pipeline phase produced it.
 */
async function stage<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        const e = err as Error;
        throw new Error(`${label} failed: ${e.message}`, { cause: err });
    }
}
