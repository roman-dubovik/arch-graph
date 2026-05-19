import type { ArchGraphConfig } from '../core/config.js';
import type { CronScheduleSite } from '../core/types.js';
import { buildLineStarts, offsetToLineCol } from './line-index.js';
import { iterateSourceFiles } from './scan.js';
import { stripComments } from './strip-comments.js';

/**
 * Ground-truth grep for @nestjs/schedule cron-schedule extractor.
 *
 * Signals detected:
 *   - `@Cron(<token>)`                              → role: 'cron'
 *   - `@Interval(<token>)`                          → role: 'interval'
 *   - `@Timeout(<token>)`                           → role: 'timeout'
 *   - `SchedulerRegistry.add{CronJob,Interval,Timeout}(...)` → role: 'dynamic'
 *
 * Validator is informational — recall floor is vacuously 1.0 when no
 * @Cron/@Interval/@Timeout is present in the project (most projects on initial
 * ship). Gate stays GREEN; any future regression with known GT will be caught.
 */

export interface CronScheduleGroundTruthEntry {
    role: 'cron' | 'interval' | 'timeout' | 'dynamic';
    location: { file: string; line: number; column: number };
    matchedText: string;
    /** Raw first argument token. */
    context: string;
}

export interface CronScheduleValidationReport {
    summary: {
        recallCron: number;
        recallInterval: number;
        recallTimeout: number;
        recallDynamic: number;
        /** Overall recall across all categories. */
        recallOverall: number;
        /** True if recallOverall >= floor OR groundTruth is empty. */
        meetsFloor: boolean;
        totalSites: number;
        groundTruthTotal: number;
        groundTruthCron: number;
        groundTruthInterval: number;
        groundTruthTimeout: number;
        groundTruthDynamic: number;
    };
    sites: CronScheduleSite[];
    groundTruth: CronScheduleGroundTruthEntry[];
    missed: CronScheduleGroundTruthEntry[];
    extra: CronScheduleSite[];
}

/** Recall floor — informational only (not a hard gate in v1). */
export const CRON_RECALL_FLOOR = 0.9;

// ---------------------------------------------------------------------------
// Ground-truth regex patterns
// ---------------------------------------------------------------------------

// @Cron(string | CronExpression.X | identifier)
const CRON_RE =
    /@Cron\s*\(\s*(?:([A-Za-z_][\w.]*|['"`][^'"`]*['"`]))/gs;

// @Interval(ms) or @Interval(name, ms)
const INTERVAL_RE =
    /@Interval\s*\(\s*(?:([A-Za-z_][\w.]*|['"`][^'"`]*['"`]|\d+))/gs;

// @Timeout(ms) or @Timeout(name, ms)
const TIMEOUT_RE =
    /@Timeout\s*\(\s*(?:([A-Za-z_][\w.]*|['"`][^'"`]*['"`]|\d+))/gs;

// SchedulerRegistry.addCronJob / addInterval / addTimeout
const SCHEDULER_REGISTRY_RE =
    /SchedulerRegistry\s*[.)][^(]*\.\s*add(?:CronJob|Interval|Timeout)\s*\(/gs;

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

export async function enumerateCronScheduleGroundTruth(
    cfg: ArchGraphConfig,
): Promise<CronScheduleGroundTruthEntry[]> {
    const out: CronScheduleGroundTruthEntry[] = [];

    for await (const { file, content } of iterateSourceFiles(cfg, 'cron-schedule GT')) {
        if (
            !content.includes('@Cron') &&
            !content.includes('@Interval') &&
            !content.includes('@Timeout') &&
            !content.includes('SchedulerRegistry')
        ) continue;

        const stripped = stripComments(content);
        const lineStarts = buildLineStarts(stripped);

        const push = (
            role: CronScheduleGroundTruthEntry['role'],
            m: RegExpMatchArray,
        ): void => {
            const offset = m.index ?? 0;
            const { line, column } = offsetToLineCol(offset, lineStarts);
            const raw = m[1] ?? '';
            out.push({
                role,
                location: { file, line, column },
                matchedText: stripped.slice(offset, offset + 80).replace(/\n.*$/s, '').trim(),
                context: raw.replace(/^['"`]|['"`]$/g, ''),
            });
        };

        for (const m of stripped.matchAll(CRON_RE)) push('cron', m);
        for (const m of stripped.matchAll(INTERVAL_RE)) push('interval', m);
        for (const m of stripped.matchAll(TIMEOUT_RE)) push('timeout', m);
        for (const m of stripped.matchAll(SCHEDULER_REGISTRY_RE)) push('dynamic', m);
    }

    return out;
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

export function buildCronScheduleReport(
    sites: CronScheduleSite[],
    groundTruth: CronScheduleGroundTruthEntry[],
): CronScheduleValidationReport {
    // Index extracted sites by file:line for matching
    const siteByKey = new Map<string, CronScheduleSite>();
    for (const s of sites) {
        siteByKey.set(`${s.location.file}:${s.location.line}`, s);
    }

    const gtCron = groundTruth.filter((g) => g.role === 'cron');
    const gtInterval = groundTruth.filter((g) => g.role === 'interval');
    const gtTimeout = groundTruth.filter((g) => g.role === 'timeout');
    const gtDynamic = groundTruth.filter((g) => g.role === 'dynamic');

    const matched = new Set<CronScheduleSite>();
    const missed: CronScheduleGroundTruthEntry[] = [];

    const matchGt = (entries: CronScheduleGroundTruthEntry[]): number => {
        let hits = 0;
        for (const gt of entries) {
            const key = `${gt.location.file}:${gt.location.line}`;
            const site = siteByKey.get(key);
            if (site) {
                matched.add(site);
                hits++;
            } else {
                missed.push(gt);
            }
        }
        return hits;
    };

    const hitsCron = matchGt(gtCron);
    const hitsInterval = matchGt(gtInterval);
    const hitsTimeout = matchGt(gtTimeout);
    const hitsDynamic = matchGt(gtDynamic);

    const totalGT = groundTruth.length;
    const totalHits = hitsCron + hitsInterval + hitsTimeout + hitsDynamic;
    const extra = sites.filter((s) => !matched.has(s));

    const recallCron = gtCron.length > 0 ? hitsCron / gtCron.length : 1;
    const recallInterval = gtInterval.length > 0 ? hitsInterval / gtInterval.length : 1;
    const recallTimeout = gtTimeout.length > 0 ? hitsTimeout / gtTimeout.length : 1;
    const recallDynamic = gtDynamic.length > 0 ? hitsDynamic / gtDynamic.length : 1;
    const recallOverall = totalGT > 0 ? totalHits / totalGT : 1;

    return {
        summary: {
            recallCron,
            recallInterval,
            recallTimeout,
            recallDynamic,
            recallOverall,
            meetsFloor: recallOverall >= CRON_RECALL_FLOOR,
            totalSites: sites.length,
            groundTruthTotal: totalGT,
            groundTruthCron: gtCron.length,
            groundTruthInterval: gtInterval.length,
            groundTruthTimeout: gtTimeout.length,
            groundTruthDynamic: gtDynamic.length,
        },
        sites,
        groundTruth,
        missed,
        extra,
    };
}
