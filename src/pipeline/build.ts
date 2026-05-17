import { join } from 'node:path';
import { Project, ts } from 'ts-morph';

import type { ArchGraphConfig } from '../core/config.js';
import { discoverOwnership } from '../core/service-registry.js';
import type { ArchGraph, BuildValidation, CyclesDiagnostics, DiagnosticsReport } from '../core/types.js';
import { extractBullMq } from '../extractors/bullmq/extractor.js';
import { extractDi } from '../extractors/di/extractor.js';
import { extractFe } from '../extractors/fe/extractor.js';
import { extractHttp } from '../extractors/http/extractor.js';
import { extractImports } from '../extractors/imports/extractor.js';
import { extractNats } from '../extractors/nats/extractor.js';
import { extractTypeOrm } from '../extractors/typeorm/extractor.js';
import { extractEndpoints } from '../extractors/endpoint/extractor.js';
import { extractConfig } from '../extractors/config/extractor.js';
import { extractScoped } from '../extractors/scoped/extractor.js';
import { extractEntityFields } from '../extractors/typeorm/fields.js';
import { mapBullMqToGraph } from '../mapper/bullmq-to-graph.js';
import { mapDiToGraph } from '../mapper/di-to-graph.js';
import { mapFeToGraph } from '../mapper/fe-to-graph.js';
import { mapHttpToGraph } from '../mapper/http-to-graph.js';
import { mapImportsToGraph } from '../mapper/imports-to-graph.js';
import { assembleGraph, buildNatsDiagnostics, mapNatsToGraph } from '../mapper/nats-to-graph.js';
import { mapTypeOrmToGraph } from '../mapper/typeorm-to-graph.js';
import { mapEndpointsToGraph } from '../mapper/endpoint-to-graph.js';
import { mapConfigToGraph } from '../mapper/config-to-graph.js';
import { mapEntityFieldsToGraph } from '../mapper/entity-fields-to-graph.js';
import { buildClassIndex } from '../extractors/di/class-index.js';
import { enumerateBullMqGroundTruth, buildBullMqReport } from '../validation/bullmq-validator.js';
import { enumerateDiGroundTruth, buildDiReport } from '../validation/di-validator.js';
import { enumerateFeGroundTruth, buildFeReport } from '../validation/fe-validator.js';
import { enumerateHandlers } from '../validation/handlers.js';
import { enumerateHttpGroundTruth, buildHttpReport } from '../validation/http-validator.js';
import { buildImportsReport, enumerateImportsGroundTruth } from '../validation/imports-validator.js';
import { enumerateSenders } from '../validation/senders.js';
import { enumerateTypeOrmGroundTruth, buildTypeOrmReport } from '../validation/typeorm-validator.js';
import { validateEndpoints } from '../validation/endpoint-validator.js';
import { validateConfig } from '../validation/config-validator.js';
import { validateDbEntityFields } from '../validation/db-entity-fields-validator.js';
import { buildReport as buildNatsReport } from '../validation/validator.js';
import { detectCycles } from '../detectors/cycles.js';

export interface BuildResult {
    graph: ArchGraph;
    diagnostics: DiagnosticsReport;
    validation: BuildValidation;
}

/**
 * Wrapper around `detectCycles` that degrades gracefully on RangeError (stack
 * overflow on very large graphs) and re-throws any other unexpected error.
 *
 * Extracted so tests can import this function directly and exercise the same
 * error-handling paths that production uses — no inline copy required.
 *
 * @param graph  The assembled ArchGraph to analyse.
 * @param detect Injected detector — defaults to the real `detectCycles`. Pass a
 *               throwing stub in tests to exercise the catch branches without
 *               building a real graph.
 * @param write  Output channel for user-visible progress messages. Defaults to
 *               `process.stdout.write` (progress belongs on stdout, not stderr).
 */
export function safeDetectCycles(
    graph: ArchGraph,
    detect: (g: ArchGraph) => CyclesDiagnostics = detectCycles,
    write: (msg: string) => void = (m) => process.stdout.write(m),
): CyclesDiagnostics {
    try {
        return detect(graph);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof RangeError) {
            // Stack overflow on a very large graph — degrade gracefully and record
            // the failure structurally so consumers can detect degraded-mode runs.
            write(`  cycles: detection skipped (stack overflow on large graph)\n`);
            return {
                cycles: [],
                counts: { tsImport: 0, libUsage: 0, diImport: 0 },
                error: `RangeError: ${message}`,
            };
        }
        // Unknown errors are bugs — surface them loudly and fail the build.
        write(`  cycles: detection failed: ${message}\n`);
        throw err;
    }
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
        compilerOptions: {
            allowJs: false,
            strict: false,
            noEmit: true,
            // Enable JSX parsing so ts-morph accepts .tsx/.jsx syntax without errors.
            jsx: ts.JsxEmit.React,
        },
    });

    // Always include .tsx; include .jsx when the project opts in via cfg.fe?.allowJsx.
    // See: P0-NEW — .tsx/.jsx files not in ts-morph Project globs (CATASTROPHIC).
    const sourceExts = ['**/*.ts', '**/*.tsx'];
    const libsGlob = cfg.libsGlob;
    const globs = [
        ...sourceExts.map((ext) => join(cfg.root, cfg.appsGlob, ext)),
        ...(libsGlob ? sourceExts.map((ext) => join(cfg.root, libsGlob, ext)) : []),
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
            '!**/*.spec.tsx',
            '!**/*.test.tsx',
            '!**/*.spec.jsx',
            '!**/*.test.jsx',
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
        `  ${typeorm.sites.length} @InjectRepository sites, ${typeorm.entities.size()} @Entity classes, ${typeorm.relations.length} relations in ${Date.now() - t0}ms\n`,
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
    const typeormMapped = mapTypeOrmToGraph(
        typeorm.sites,
        ownership,
        typeorm.entities.warnings,
        typeorm.relations,
        typeorm.entities,
        typeorm.baseClassCycles,
    );
    {
        const c = typeormMapped.diagnostics.counts;
        const reasons = `unparseable: ${c.unresolvedReasons.unparseable}, notIndexed: ${c.unresolvedReasons.notIndexed}, ownerNotIndexed: ${c.unresolvedReasons.ownerNotIndexed}`;
        process.stdout.write(
            `  nodes: ${typeormMapped.nodes.length}, edges: ${typeormMapped.edges.length}, unresolved: ${typeormMapped.diagnostics.unresolvedEntities.length}, unowned: ${typeormMapped.diagnostics.unowned.length}, entityWarnings: ${typeormMapped.diagnostics.entityDecoratorWarnings.length}, relationsEmitted: ${c.relationsEmitted}, relationsResolved: ${c.relationsResolved}, oneToManySkipped: ${c.oneToManySkipped}, unresolvedRelations: ${c.unresolvedRelations} (${reasons}), baseClassCycles: ${c.baseClassCycles}\n`,
        );
    }

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
    // A1: build class index so provider/module nodes get path + anchor fields.
    const classIndex = buildClassIndex(project);
    const diMapped = await stage(`[${cfg.id}] di.map`, () =>
        mapDiToGraph(di.modules, di.moduleIndex, ownership, di.filterChain, di.skippedAnonymousFiles, classIndex),
    );
    process.stdout.write(
        `  nodes: ${diMapped.nodes.length}, edges: ${diMapped.edges.length}, unresolvedRefs: ${diMapped.diagnostics.unresolvedRefs.length}, unowned: ${diMapped.diagnostics.unowned.length}, guards: ${diMapped.diagnostics.counts.guards}, interceptors: ${diMapped.diagnostics.counts.interceptors}, pipes: ${diMapped.diagnostics.counts.pipes}, unresolvedFilterRefs: ${diMapped.diagnostics.counts.unresolvedFilterRefs}, truncatedFilterRefs: ${diMapped.diagnostics.counts.truncatedFilterRefs}, skippedAnonymousFiles: ${diMapped.diagnostics.skippedAnonymousFiles.length}\n`,
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
        `  nodes: ${importsMapped.nodes.length}, edges: ${importsMapped.edges.length}, unresolvedInternal: ${importsMapped.diagnostics.counts.unresolvedInternal}, externalOrUnresolved: ${importsMapped.diagnostics.counts.externalOrUnresolved}, dynamic: ${importsMapped.diagnostics.counts.totalDynamic}, cjsRequire: ${importsMapped.diagnostics.counts.totalCjsRequire}\n`,
    );

    // ---- FE domain ----
    process.stdout.write(`extracting FE...\n`);
    t0 = Date.now();
    const fe = await stage(`[${cfg.id}] fe.extract`, () => extractFe(cfg, project));
    process.stdout.write(`  components: ${fe.components.length}, routes: ${fe.routes.length}, hooks: ${fe.hooks.length}, imports: ${fe.imports.length} in ${Date.now() - t0}ms\n`);

    process.stdout.write(`validating FE against ground truth...\n`);
    const feGT = await stage(`[${cfg.id}] fe.GT`, () => enumerateFeGroundTruth(cfg));
    const feValidation = buildFeReport(fe, feGT);
    {
        const v = feValidation.summary;
        process.stdout.write(
            `  recallComp=${pct(v.recallComponents)} recallRoute=${pct(v.recallRoutes)} recallHook=${pct(v.recallHooks)}\n`,
        );
    }

    process.stdout.write(`mapping FE to graph...\n`);
    const feMapped = mapFeToGraph(fe, ownership);
    process.stdout.write(
        `  nodes: ${feMapped.nodes.length}, edges: ${feMapped.edges.length}, unresolved: ${feMapped.diagnostics.unresolved.length}, unowned: ${feMapped.diagnostics.unowned.length}\n`,
    );

    // ---- Endpoint domain (Var 2) ----
    process.stdout.write(`extracting endpoints...\n`);
    t0 = Date.now();
    const endpoints = await stage(`[${cfg.id}] endpoint.extract`, () => extractEndpoints(project));
    process.stdout.write(
        `  ${endpoints.endpoints.length} endpoint sites, ${endpoints.diagnostics.length} diagnostics in ${Date.now() - t0}ms\n`,
    );

    process.stdout.write(`validating endpoints against ground truth...\n`);
    const endpointValidation = await stage(`[${cfg.id}] endpoint.GT`, () =>
        validateEndpoints(cfg, endpoints.endpoints.length),
    );
    process.stdout.write(
        `  groundTruth: ${endpointValidation.groundTruthCount}, recall: ${endpointValidation.recall !== null ? pct(endpointValidation.recall) : 'N/A'}\n`,
    );

    process.stdout.write(`mapping endpoints to graph...\n`);
    const endpointsMapped = mapEndpointsToGraph(endpoints.endpoints, ownership);
    process.stdout.write(
        `  nodes: ${endpointsMapped.nodes.length}, edges: ${endpointsMapped.edges.length}\n`,
    );

    // ---- Config domain (Var 2) ----
    process.stdout.write(`extracting config callsites...\n`);
    t0 = Date.now();
    const config = await stage(`[${cfg.id}] config.extract`, () => extractConfig(project));
    process.stdout.write(
        `  ${config.fields.length} config callsites, ${config.diagnostics.length} diagnostics in ${Date.now() - t0}ms\n`,
    );

    process.stdout.write(`validating config against ground truth...\n`);
    const configValidation = await stage(`[${cfg.id}] config.GT`, () =>
        validateConfig(cfg, config.fields.length),
    );
    process.stdout.write(
        `  groundTruth: ${configValidation.groundTruthCount}, recall: ${configValidation.recall !== null ? pct(configValidation.recall) : 'N/A'}\n`,
    );

    process.stdout.write(`mapping config to graph...\n`);
    const configMapped = await stage(`[${cfg.id}] config.map`, () =>
        mapConfigToGraph(config.fields, ownership),
    );
    process.stdout.write(
        `  nodes: ${configMapped.nodes.length}, edges: ${configMapped.edges.length}\n`,
    );

    // ---- Scoped-marker domain (Var 2 stub) ----
    process.stdout.write(`extracting scoped markers (stub)...\n`);
    const scoped = await stage(`[${cfg.id}] scoped.extract`, () => extractScoped(project));
    process.stdout.write(
        `  ${scoped.markers.length} scoped sites (stub: awaiting corpus signal)\n`,
    );

    // ---- db-entity-field domain (Var 2) ----
    process.stdout.write(`extracting db entity fields...\n`);
    t0 = Date.now();
    const dbEntityFields = await stage(`[${cfg.id}] dbEntityFields.extract`, () =>
        extractEntityFields(Array.from(typeorm.entities.entries()), project),
    );
    process.stdout.write(
        `  ${dbEntityFields.fields.length} entity fields, ${dbEntityFields.diagnostics.length} diagnostics in ${Date.now() - t0}ms\n`,
    );

    process.stdout.write(`validating db entity fields against ground truth...\n`);
    const dbEntityFieldsValidation = await stage(`[${cfg.id}] dbEntityFields.GT`, () =>
        validateDbEntityFields(cfg, dbEntityFields.fields.length),
    );
    process.stdout.write(
        `  groundTruth: ${dbEntityFieldsValidation.groundTruthCount}, recall: ${dbEntityFieldsValidation.recall !== null ? pct(dbEntityFieldsValidation.recall) : 'N/A'}\n`,
    );

    process.stdout.write(`mapping db entity fields to graph...\n`);
    const entityFieldsMapped = mapEntityFieldsToGraph(dbEntityFields.fields);
    process.stdout.write(
        `  nodes: ${entityFieldsMapped.nodes.length}, edges: ${entityFieldsMapped.edges.length}\n`,
    );

    // ---- Compose ----
    const graph = assembleGraph(cfg.root, [
        natsMapped,
        typeormMapped,
        bullmqMapped,
        diMapped,
        httpMapped,
        importsMapped,
        feMapped,
        endpointsMapped,
        configMapped,
        entityFieldsMapped,
    ]);

    // ---- Cycle detection ----
    process.stdout.write(`detecting cycles...\n`);
    const cyclesDiagnostics = safeDetectCycles(graph);
    {
        const c = cyclesDiagnostics.counts;
        process.stdout.write(
            `  cycles: total: ${cyclesDiagnostics.cycles.length} (ts-import: ${c.tsImport}, lib-usage: ${c.libUsage}, di-import: ${c.diImport})\n`,
        );
    }

    const diagnostics: DiagnosticsReport = {
        projectId: cfg.id,
        timestamp: new Date().toISOString(),
        nats: natsDiagnostics,
        typeorm: typeormMapped.diagnostics,
        bullmq: bullmqMapped.diagnostics,
        di: diMapped.diagnostics,
        http: httpMapped.diagnostics,
        imports: importsMapped.diagnostics,
        fe: feMapped.diagnostics,
        cycles: cyclesDiagnostics,
        endpoint: {
            // Merge: extractor-level (non-literal arg) + mapper-level (unowned files)
            messages: [
                ...endpoints.diagnostics,
                ...endpointsMapped.diagnostics,
            ],
        },
        config: {
            // Merge: extractor-level (non-literal key) + mapper-level (unowned files)
            messages: [
                ...config.diagnostics,
                ...configMapped.diagnostics,
            ],
        },
        dbEntityFields: {
            // Merge: extractor-level (not-in-index) + mapper-level (duplicate fields)
            messages: [
                ...dbEntityFields.diagnostics,
                ...entityFieldsMapped.diagnostics,
            ],
            counts: {
                baseClassCycles: dbEntityFields.baseClassCycles,
            },
        },
        scoped: {
            markerCount: scoped.markers.length,
            messages: scoped.diagnostics,
        },
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
        fe: feValidation,
        endpoint: endpointValidation,
        config: configValidation,
        dbEntityFields: dbEntityFieldsValidation,
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
export async function stage<T>(label: string, fn: () => T | Promise<T>): Promise<Awaited<T>> {
    try {
        return await fn();
    } catch (err) {
        // Mutate message in-place instead of constructing a new Error so the
        // original throw-site stack frames are preserved.  A `new Error(...)`
        // would produce a fresh stack rooted here, burying the actual source.
        // Note: V8 freezes the first line of `.stack` at construction time, so
        // `.stack` will still open with the un-prefixed message — that is
        // expected and harmless.
        const e = err instanceof Error ? err : new Error(String(err));
        // Non-Error branch (new Error(...)) has no original stack; it will be rooted here.
        e.message = `${label} failed: ${e.message}`;
        throw e;
    }
}
