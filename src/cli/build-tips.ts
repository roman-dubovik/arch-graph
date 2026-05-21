/**
 * Advisory tips for each domain when recall falls below floor.
 *
 * Each function returns a list of actionable hint strings to print below the
 * validation table when a domain's status is ⚠. Kept in a dedicated module so
 * the CLI layer stays thin and tips can be extended without touching the
 * gate/table logic.
 */

import type {
    BullMqDiagnostics,
    BullMqValidationReport,
    DiDiagnostics,
    DiValidationReport,
    HttpDiagnostics,
    HttpValidationReport,
    ImportsDiagnostics,
    ImportsValidationReport,
    NatsDiagnostics,
    NatsValidationReport,
    TypeOrmDiagnostics,
    TypeOrmValidationReport,
} from '../core/types.js';
import type { FeValidationReport } from '../validation/fe-validator.js';

// ---------------------------------------------------------------------------
// NATS
// ---------------------------------------------------------------------------

export function tipsForNats(
    validation: NatsValidationReport,
    diagnostics: NatsDiagnostics,
): string[] {
    const tips: string[] = [];
    const { recallHandlers, recallSenders, groundTruthHandlers, groundTruthSenders } =
        validation.summary;

    if (groundTruthHandlers > 0 && recallHandlers < 0.95) {
        tips.push(
            `${groundTruthHandlers - Math.round(recallHandlers * groundTruthHandlers)} handler(s) not found — verify @MessagePattern / @EventPattern decorators match ground-truth patterns`,
        );
        tips.push(`Wrapper subscribe APIs must be declared in arch-graph.config.ts: nats.wrapperSubscribeApis`);
    }

    if (groundTruthSenders > 0 && recallSenders < 0.95) {
        tips.push(
            `${groundTruthSenders - Math.round(recallSenders * groundTruthSenders)} sender(s) not found — check nats.wrapperPublishApis entries (class name typos are common)`,
        );
        tips.push(`Wrapper publish APIs must be declared in arch-graph.config.ts: nats.wrapperPublishApis`);
    }

    // Count dynamic-looking unresolved subjects (contain ${...} template syntax in raw)
    const dynamicUnresolved = diagnostics.unresolved.filter(
        (u) => u.subject.kind === 'unresolved' && u.subject.raw.includes('${'),
    );
    if (dynamicUnresolved.length > 0) {
        tips.push(
            `${dynamicUnresolved.length} unresolved subject(s) contain \`\${...}\` — these are dynamic subjects, expected. See diagnostics.json`,
        );
    }

    if (diagnostics.counts.unresolved > 0) {
        tips.push(`Run \`arch-graph diagnose --only=nats\` for site-by-site details on unresolved subjects`);
    }

    return tips;
}

// ---------------------------------------------------------------------------
// TypeORM
// ---------------------------------------------------------------------------

export function tipsForTypeorm(
    validation: TypeOrmValidationReport,
    _diagnostics: TypeOrmDiagnostics,
): string[] {
    const tips: string[] = [];
    const {
        recallInjections,
        recallEntities,
        resolveRate,
        groundTruthInjections,
        groundTruthEntities,
    } = validation.summary;

    if (groundTruthInjections > 0 && recallInjections < 0.95) {
        const missed = groundTruthInjections - Math.round(recallInjections * groundTruthInjections);
        tips.push(`${missed} @InjectRepository site(s) not extracted — check appsGlob covers all services`);
    }

    if (groundTruthEntities > 0 && recallEntities < 0.95) {
        const missed = groundTruthEntities - Math.round(recallEntities * groundTruthEntities);
        tips.push(`${missed} @Entity class(es) not extracted — check libsGlob covers entity libraries`);
    }

    if (resolveRate < 0.95) {
        tips.push(
            `Low resolve rate: some @InjectRepository(X) don't match a known @Entity — check alias re-exports or namespaced imports`,
        );
    }

    tips.push(`Run \`arch-graph diagnose --only=typeorm\` for unresolved entity details`);

    return tips;
}

// ---------------------------------------------------------------------------
// BullMQ
// ---------------------------------------------------------------------------

export function tipsForBullmq(
    validation: BullMqValidationReport,
    diagnostics: BullMqDiagnostics,
): string[] {
    const tips: string[] = [];
    const {
        recallProducers,
        recallConsumers,
        recallRegistrations,
        resolveRate,
        groundTruthProducers,
        groundTruthConsumers,
        groundTruthRegistrations,
    } = validation.summary;

    if (groundTruthProducers > 0 && recallProducers < 0.95) {
        tips.push(`@InjectQueue producer(s) missed — check queue name resolution in your BullModule.registerQueue calls`);
    }
    if (groundTruthConsumers > 0 && recallConsumers < 0.95) {
        tips.push(`@Processor consumer(s) missed — check @Processor decorator arguments`);
    }
    if (groundTruthRegistrations > 0 && recallRegistrations < 0.95) {
        tips.push(`BullModule.registerQueue registration(s) missed — check registerQueueAsync forms`);
    }

    // Count dynamic-looking unresolved (template literals in raw)
    const dynamicUnresolved = diagnostics.unresolved.filter(
        (u) => u.queue.kind === 'unresolved' && u.queue.raw.includes('${'),
    );
    if (dynamicUnresolved.length > 0) {
        tips.push(
            `${dynamicUnresolved.length} unresolved queue name(s) contain \`\${...}\` — dynamic queue names, expected. See diagnostics.json`,
        );
    }

    if (resolveRate < 0.95) {
        tips.push(`Low resolve rate — queue name constants may not be exported where the extractor can see them`);
    }

    tips.push(`Run \`arch-graph diagnose --only=bullmq\` for site-by-site details`);

    return tips;
}

// ---------------------------------------------------------------------------
// DI
// ---------------------------------------------------------------------------

export function tipsForDi(
    validation: DiValidationReport,
    _diagnostics: DiDiagnostics,
): string[] {
    const tips: string[] = [];
    const {
        recallModules,
        recallImportsFields,
        recallProvidersFields,
        recallExportsFields,
        recallControllersFields,
        resolveRate,
        groundTruthModules,
    } = validation.summary;

    if (groundTruthModules > 0 && recallModules < 0.95) {
        tips.push(`@Module decorator(s) not extracted — check appsGlob/libsGlob covers all module files`);
    }
    if (recallImportsFields < 0.95) {
        tips.push(`Some @Module imports: fields missed — dynamic imports arrays may not be fully enumerable`);
    }
    if (recallProvidersFields < 0.95) {
        tips.push(`Some @Module providers: fields missed — spread operators or ternaries block enumeration`);
    }
    if (recallExportsFields < 0.95) {
        tips.push(`Some @Module exports: fields missed — ensure the exports: array is a static literal`);
    }
    if (recallControllersFields < 0.95) {
        tips.push(`Some @Module controllers: fields missed — check controller declarations`);
    }
    if (resolveRate < 0.95) {
        tips.push(`Low resolve rate: module/provider refs unresolved — likely unindexed or external providers`);
    }

    tips.push(`Run \`arch-graph diagnose --only=di\` for unresolvedRefs site-by-site details`);

    return tips;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export function tipsForHttp(
    validation: HttpValidationReport,
    diagnostics: HttpDiagnostics,
): string[] {
    const tips: string[] = [];
    const { recallCalls, groundTruthCalls } = validation.summary;

    if (groundTruthCalls > 0 && recallCalls < 0.95) {
        const missed = groundTruthCalls - Math.round(recallCalls * groundTruthCalls);
        tips.push(`${missed} HTTP call site(s) not extracted — check HttpService / axios / fetch usage patterns`);
    }

    if (diagnostics.counts.unresolved > 0) {
        tips.push(
            `${diagnostics.counts.unresolved} unresolved HTTP site(s) — URL could not be classified as internal or external`,
        );
        tips.push(`Configure internalServices in arch-graph.config.ts to classify env-ref URLs`);
    }

    tips.push(`Run \`arch-graph diagnose --only=http\` for unresolved URL details`);

    return tips;
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export function tipsForImports(
    validation: ImportsValidationReport,
    diagnostics: ImportsDiagnostics,
): string[] {
    const tips: string[] = [];
    const { recallStatic, minPerFileRecall, groundTruthStatic } = validation.summary;

    if (groundTruthStatic > 0 && recallStatic < 0.8) {
        tips.push(
            `Import recall ${(recallStatic * 100).toFixed(1)}% (< 80%) — appsGlob/libsGlob may exclude source files`,
        );
    }

    if (minPerFileRecall < 0.8) {
        tips.push(
            `Per-file recall floor ${(minPerFileRecall * 100).toFixed(1)}% — one or more files has very low extraction coverage`,
        );
    }

    if (diagnostics.counts.unresolvedInternal > 0) {
        tips.push(
            `${diagnostics.counts.unresolvedInternal} broken internal import path(s) — typo'd alias or missing tsconfig paths entry`,
        );
    }

    tips.push(`Run \`arch-graph diagnose --only=imports\` for broken-path details`);

    return tips;
}

// ---------------------------------------------------------------------------
// FE (React/Next.js)
// ---------------------------------------------------------------------------

export function tipsForFe(validation: FeValidationReport): string[] {
    const tips: string[] = [];
    const {
        recallComponents,
        recallRoutes,
        recallHooks,
        groundTruthComponents,
        groundTruthRoutes,
        groundTruthHooks,
    } = validation.summary;

    if (groundTruthComponents > 0 && recallComponents < 0.9) {
        const missed = groundTruthComponents - Math.round(recallComponents * groundTruthComponents);
        tips.push(
            `${missed} component(s) not extracted — check appsGlob includes frontend apps (e.g. apps/web/**)`,
        );
        tips.push(
            `Verify recall with: npx tsx ...build --json | jq .validation.fe.summary`,
        );
    }

    if (groundTruthRoutes > 0 && recallRoutes < 0.9) {
        const missed = groundTruthRoutes - Math.round(recallRoutes * groundTruthRoutes);
        tips.push(
            `${missed} route(s) not extracted — ensure pages/ or app/ directories are under appsGlob`,
        );
    }

    if (groundTruthHooks > 0 && recallHooks < 0.9) {
        const missed = groundTruthHooks - Math.round(recallHooks * groundTruthHooks);
        tips.push(
            `${missed} hook(s) not extracted — hooks in .ts files are scanned; check appsGlob/libsGlob coverage and diagnose missed files`,
        );
    }

    tips.push(`Run \`arch-graph diagnose --only=fe\` for missed component/route/hook details`);

    return tips;
}
