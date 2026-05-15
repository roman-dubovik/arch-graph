import fg from 'fast-glob';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ArchGraphConfig } from '../core/config.js';
import type {
    BullMqGroundTruthEntry,
    BullMqInjectionSite,
    BullMqProcessorSite,
    BullMqQueueRegistration,
    BullMqValidationReport,
} from '../core/types.js';
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

const INJECT_RE = /@InjectQueue\s*\(\s*([A-Za-z_][\w.]*|['"`][^'"`]+['"`])/gs;
const PROCESSOR_RE = /@Processor\s*\(\s*([A-Za-z_][\w.]*|['"`][^'"`]+['"`])/gs;
const REGISTER_RE = /BullModule\s*\.\s*registerQueue(?:Async)?\s*\(/g;

export async function enumerateBullMqGroundTruth(
    cfg: ArchGraphConfig,
): Promise<BullMqGroundTruthEntry[]> {
    const root = resolve(cfg.root);
    const files = await fg(
        [`${cfg.appsGlob}/**/*.ts`, ...(cfg.libsGlob ? [`${cfg.libsGlob}/**/*.ts`] : [])],
        {
            cwd: root,
            absolute: true,
            ignore: [
                '**/node_modules/**',
                '**/dist/**',
                '**/.claude/**',
                '**/.worktrees/**',
                '**/*.spec.ts',
                '**/*.test.ts',
                '**/*.d.ts',
                ...(cfg.excludeGlobs?.map((g) => `**${g}**`) ?? []),
            ],
        },
    );

    const out: BullMqGroundTruthEntry[] = [];

    for (const file of files) {
        let content: string;
        try {
            content = await readFile(file, 'utf8');
        } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code === 'ENOENT') continue;
            throw new Error(`ground-truth read failed for ${file}: ${e.code ?? e.message}`, { cause: err });
        }
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
            out.push({
                role,
                location: { file, line, column },
                matchedText: stripped.slice(offset, offset + 80).replace(/\n.*$/s, '').trim(),
                context: (m[1] ?? '').replace(/^['"`]|['"`]$/g, ''),
            });
        };

        for (const m of stripped.matchAll(INJECT_RE)) push('producer', m);
        for (const m of stripped.matchAll(PROCESSOR_RE)) push('consumer', m);
        for (const m of stripped.matchAll(REGISTER_RE)) push('registration', m);
    }

    return out;
}

function buildLineStarts(s: string): number[] {
    const starts = [0];
    for (let i = 0; i < s.length; i++) if (s[i] === '\n') starts.push(i + 1);
    return starts;
}

function offsetToLineCol(offset: number, lineStarts: number[]): { line: number; column: number } {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid]! <= offset) lo = mid;
        else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo]! + 1 };
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

    const { consumed: consumedProd, missed: missedProducers } = matchGroundTruth(gtProd, prodKeyed);
    const { missed: missedConsumers } = matchGroundTruth(gtCons, consKeyed);
    const { missed: missedRegistrations } = matchGroundTruth(gtReg, regKeyed);

    const extraProducers = producers.filter((s) => !consumedProd.has(s));

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
    };
}

function matchGroundTruth<T>(
    gtEntries: BullMqGroundTruthEntry[],
    keyed: Map<string, T[]>,
): { consumed: Set<T>; missed: BullMqGroundTruthEntry[] } {
    const consumed = new Set<T>();
    const missed: BullMqGroundTruthEntry[] = [];
    for (const g of gtEntries) {
        const k = `${g.location.file}:${g.location.line}`;
        const match = (keyed.get(k) ?? []).find((c) => !consumed.has(c));
        if (match) consumed.add(match);
        else missed.push(g);
    }
    return { consumed, missed };
}

function indexBy<T>(arr: T[], keyFn: (t: T) => string): Map<string, T[]> {
    const m = new Map<string, T[]>();
    for (const item of arr) {
        const k = keyFn(item);
        const list = m.get(k);
        if (list) list.push(item);
        else m.set(k, [item]);
    }
    return m;
}
