import type { ArchGraphConfig } from '../core/config.js';
import type {
    BullMqGroundTruthEntry,
    BullMqInjectionSite,
    BullMqProcessorSite,
    BullMqQueueRegistration,
    BullMqValidationReport,
} from '../core/types.js';
import { buildLineStarts, indexBy, matchByLineKey, offsetToLineCol } from './line-index.js';
import { iterateSourceFiles } from './scan.js';
import { stripComments } from './strip-comments.js';

/**
 * Ground-truth grep for BullMQ. Three signals:
 *   - `@InjectQueue(<token>)`                 → role: 'producer'
 *   - `@Processor(<token>[, options])`        → role: 'consumer'
 *   - `BullModule.registerQueue[Async](...)`  → role: 'registration'
 * Matched against extracted sites by file:line (same scheme as NATS / TypeORM validators).
 *
 * `s` flag lets us match across newlines for the formatted constructor variants
 * (`@InjectQueue(\n    QUEUE,\n)`).
 */

// Decorator-call regex variants. The alternation matches three argument shapes:
//   1. bare identifier         (`MY_QUEUE`)            — captured token in m[1]
//   2. quoted literal          (`'my-queue'`)          — captured (with quotes) in m[1]
//   3. options object with name (`{ name: 'my-queue' }`) — captured `name` value in m[2]
// Shape #3 is the `@nestjs/bullmq` v10+ overload; without it, the extractor and the
// ground-truth both miss `@Processor({ name: 'q', concurrency: 5 })` symmetrically,
// hiding the bug behind a green recall metric.
const INJECT_RE =
    /@InjectQueue\s*\(\s*(?:([A-Za-z_][\w.]*|['"`][^'"`]+['"`])|\{[^}]*?\bname\s*:\s*([A-Za-z_][\w.]*|['"`][^'"`]+['"`]))/gs;
const PROCESSOR_RE =
    /@Processor\s*\(\s*(?:([A-Za-z_][\w.]*|['"`][^'"`]+['"`])|\{[^}]*?\bname\s*:\s*([A-Za-z_][\w.]*|['"`][^'"`]+['"`]))/gs;
const REGISTER_RE = /BullModule\s*\.\s*registerQueue(?:Async)?\s*\(/g;

export async function enumerateBullMqGroundTruth(
    cfg: ArchGraphConfig,
): Promise<BullMqGroundTruthEntry[]> {
    const out: BullMqGroundTruthEntry[] = [];

    for await (const { file, content } of iterateSourceFiles(cfg, 'bullmq GT')) {
        if (
            !content.includes('@InjectQueue') &&
            !content.includes('@Processor') &&
            !content.includes('BullModule')
        ) continue;

        const stripped = stripComments(content);
        const lineStarts = buildLineStarts(stripped);

        const push = (
            role: 'producer' | 'consumer' | 'registration',
            m: RegExpMatchArray,
        ): void => {
            const offset = m.index ?? 0;
            const { line, column } = offsetToLineCol(offset, lineStarts);
            // m[1] = bare-arg form; m[2] = options-object `name:` form. One of the two is set per match.
            const raw = m[1] ?? m[2] ?? '';
            out.push({
                role,
                location: { file, line, column },
                matchedText: stripped.slice(offset, offset + 80).replace(/\n.*$/s, '').trim(),
                context: raw.replace(/^['"`]|['"`]$/g, ''),
            });
        };

        for (const m of stripped.matchAll(INJECT_RE)) push('producer', m);
        for (const m of stripped.matchAll(PROCESSOR_RE)) push('consumer', m);
        for (const m of stripped.matchAll(REGISTER_RE)) push('registration', m);
    }

    return out;
}

export function buildBullMqReport(
    producers: BullMqInjectionSite[],
    consumers: BullMqProcessorSite[],
    registrations: BullMqQueueRegistration[],
    groundTruth: BullMqGroundTruthEntry[],
): BullMqValidationReport {
    const prodKeyed = indexBy(producers, (s) => `${s.location.file}:${s.location.line}`);
    const consKeyed = indexBy(consumers, (s) => `${s.location.file}:${s.location.line}`);
    const regKeyed = indexBy(registrations, (s) => `${s.location.file}:${s.location.line}`);

    const gtProd = groundTruth.filter((g) => g.role === 'producer');
    const gtCons = groundTruth.filter((g) => g.role === 'consumer');
    const gtReg = groundTruth.filter((g) => g.role === 'registration');

    const { consumed: consumedProd, missed: missedProducers } = matchByLineKey(gtProd, prodKeyed);
    const { consumed: consumedCons, missed: missedConsumers } = matchByLineKey(gtCons, consKeyed);
    const { consumed: consumedReg, missed: missedRegistrations } = matchByLineKey(gtReg, regKeyed);

    const extraProducers = producers.filter((s) => !consumedProd.has(s));
    const extraConsumers = consumers.filter((s) => !consumedCons.has(s));
    const extraRegistrations = registrations.filter((s) => !consumedReg.has(s));

    const totalSites = producers.length + consumers.length + registrations.length;
    const resolvedSites =
        producers.filter((s) => s.queue.kind !== 'unresolved').length +
        consumers.filter((s) => s.queue.kind !== 'unresolved').length +
        registrations.filter((s) => s.queue.kind !== 'unresolved').length;

    return {
        summary: {
            recallProducers: gtProd.length > 0 ? (gtProd.length - missedProducers.length) / gtProd.length : 1,
            recallConsumers: gtCons.length > 0 ? (gtCons.length - missedConsumers.length) / gtCons.length : 1,
            recallRegistrations: gtReg.length > 0 ? (gtReg.length - missedRegistrations.length) / gtReg.length : 1,
            resolveRate: totalSites > 0 ? resolvedSites / totalSites : 0,
            totalProducers: producers.length,
            totalConsumers: consumers.length,
            totalRegistrations: registrations.length,
            groundTruthProducers: gtProd.length,
            groundTruthConsumers: gtCons.length,
            groundTruthRegistrations: gtReg.length,
        },
        producers,
        consumers,
        registrations,
        groundTruth,
        missedProducers,
        missedConsumers,
        missedRegistrations,
        extraProducers,
        extraConsumers,
        extraRegistrations,
    };
}



