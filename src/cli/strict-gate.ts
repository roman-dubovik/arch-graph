/**
 * Strict-mode gate helpers extracted to a standalone module so they can be
 * unit-tested without triggering the CLI's top-level main() call.
 */

import type { BuildValidation } from '../core/types.js';

// ---------------------------------------------------------------------------
// Strict-mode gate
// ---------------------------------------------------------------------------

export function computeStrictFails(
    validation: BuildValidation,
    enabled: Record<string, boolean>,
): string[] {
    const fails: string[] = [];
    const n = validation.nats.summary;
    const t = validation.typeorm.summary;
    const b = validation.bullmq.summary;
    const d = validation.di.summary;
    const h = validation.http.summary;
    const i = validation.imports.summary;
    const f = validation.fe.summary;

    // Per-role zero-GT: handlers misconfig and senders misconfig fail independently.
    if (enabled.nats) {
        if (n.groundTruthHandlers === 0) fails.push(`nats: zero handler ground-truth — check subscribe decorators / wrapperSubscribeApis`);
        if (n.groundTruthSenders === 0) fails.push(`nats: zero sender ground-truth — check wrapperPublishApis (typo'd class name?)`);
        strictGateRecall('nats', 'handlers', n.groundTruthHandlers, n.recallHandlers, fails);
        strictGateRecall('nats', 'senders', n.groundTruthSenders, n.recallSenders, fails);
    }
    if (enabled.typeorm) {
        if (t.groundTruthInjections === 0) fails.push(`typeorm: zero injection ground-truth — check appsGlob / @InjectRepository usage`);
        if (t.groundTruthEntities === 0) fails.push(`typeorm: zero entity ground-truth — check @Entity declarations in libs/`);
        strictGateRecall('typeorm', 'injections', t.groundTruthInjections, t.recallInjections, fails);
        strictGateRecall('typeorm', 'entities', t.groundTruthEntities, t.recallEntities, fails);
        strictGateResolve('typeorm', t.totalInjections, t.resolveRate, fails);
    }
    if (enabled.http) {
        if (h.groundTruthCalls === 0) {
            fails.push(`http: zero ground-truth — set domains.http=false if this project has no HTTP usage`);
        }
        strictGateRecall('http', 'recall', h.groundTruthCalls, h.recallCalls, fails);
    }
    if (enabled.bullmq) {
        const anyGt = b.groundTruthProducers + b.groundTruthConsumers + b.groundTruthRegistrations;
        if (anyGt === 0) fails.push(`bullmq: zero ground-truth across producers/consumers/registrations — set domains.bullmq=false if this project has no BullMQ`);
        strictGateRecall('bullmq', 'producers', b.groundTruthProducers, b.recallProducers, fails);
        strictGateRecall('bullmq', 'consumers', b.groundTruthConsumers, b.recallConsumers, fails);
        strictGateRecall('bullmq', 'registrations', b.groundTruthRegistrations, b.recallRegistrations, fails);
        const totalSites = b.totalProducers + b.totalConsumers + b.totalRegistrations;
        strictGateResolve('bullmq', totalSites, b.resolveRate, fails);
    }
    if (enabled.di) {
        if (d.groundTruthModules === 0) {
            fails.push(`di: zero @Module ground-truth — set domains.di=false if this project is not NestJS`);
        }
        strictGateRecall('di', 'modules', d.groundTruthModules, d.recallModules, fails);
        strictGateRecall('di', 'imports-fields', d.groundTruthImportsFields, d.recallImportsFields, fails);
        strictGateRecall('di', 'providers-fields', d.groundTruthProvidersFields, d.recallProvidersFields, fails);
        strictGateRecall('di', 'exports-fields', d.groundTruthExportsFields, d.recallExportsFields, fails);
        strictGateRecall('di', 'controllers-fields', d.groundTruthControllersFields, d.recallControllersFields, fails);
        const totalRefs = d.totalImports + d.totalProviders + d.totalExports + d.totalControllers;
        strictGateResolve('di', totalRefs, d.resolveRate, fails);
    }
    if (enabled.imports) {
        if (i.groundTruthStatic === 0) {
            fails.push(`imports: zero ground-truth — appsGlob/libsGlob almost certainly broken`);
        } else if (i.recallStatic < 0.8) {
            fails.push(`imports recall ${pct(i.recallStatic)} (< 80%)`);
        }
    }
    if (enabled.fe) {
        strictGateRecall('fe', 'components', f.groundTruthComponents, f.recallComponents, fails, 0.9);
        strictGateRecall('fe', 'routes', f.groundTruthRoutes, f.recallRoutes, fails, 0.9);
        strictGateRecall('fe', 'hooks', f.groundTruthHooks, f.recallHooks, fails, 0.9);
    }

    return fails;
}

export function strictGateRecall(
    domain: string,
    field: string,
    gt: number,
    recall: number,
    fails: string[],
    threshold = 0.95,
): void {
    if (gt === 0) return;
    if (recall < threshold) fails.push(`${domain} ${field} ${pct(recall)}`);
}

export function strictGateResolve(
    domain: string,
    total: number,
    rate: number,
    fails: string[],
    threshold = 0.95,
): void {
    if (total === 0) return;
    if (rate < threshold) fails.push(`${domain} resolve ${pct(rate)} (< ${pct(threshold)})`);
}

export function pct(n: number): string {
    return `${(n * 100).toFixed(1)}%`;
}
