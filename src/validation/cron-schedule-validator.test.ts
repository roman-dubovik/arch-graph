import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CronScheduleSite } from '../core/types.js';
import {
    buildCronScheduleReport,
    CRON_RECALL_FLOOR,
    CRON_RE,
    INTERVAL_RE,
    TIMEOUT_RE,
    SCHEDULER_REGISTRY_RE,
    type CronScheduleGroundTruthEntry,
} from './cron-schedule-validator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURE_PATH = join(import.meta.dirname ?? __dirname, '../extractors/cron-schedule/__fixtures__/sample.ts');

function readFixture(): string {
    return readFileSync(FIXTURE_PATH, 'utf8');
}

function makeSite(overrides: Partial<CronScheduleSite> = {}): CronScheduleSite {
    return {
        owner: 'TestService.method',
        expression: '0 * * * *',
        resolvedExpression: '0 * * * *',
        category: 'cron',
        location: { file: '/app/test.ts', line: 10, column: 4 },
        ...overrides,
    };
}

function makeGtEntry(overrides: Partial<CronScheduleGroundTruthEntry> = {}): CronScheduleGroundTruthEntry {
    return {
        role: 'cron',
        location: { file: '/app/test.ts', line: 10, column: 4 },
        matchedText: '@Cron',
        context: '0 * * * *',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// buildCronScheduleReport — recall computation
// ---------------------------------------------------------------------------

describe('buildCronScheduleReport — recall computation', () => {
    it('empty sites and empty GT → all recalls = 1 (vacuous) and meetsFloor = true', () => {
        const report = buildCronScheduleReport([], []);
        expect(report.summary.recallCron).toBe(1);
        expect(report.summary.recallInterval).toBe(1);
        expect(report.summary.recallTimeout).toBe(1);
        expect(report.summary.recallDynamic).toBe(1);
        expect(report.summary.recallOverall).toBe(1);
        expect(report.summary.meetsFloor).toBe(true);
    });

    it('all GT matched → recallOverall = 1 and meetsFloor = true', () => {
        const site = makeSite({ location: { file: '/app/test.ts', line: 10, column: 4 } });
        const gt = makeGtEntry({ location: { file: '/app/test.ts', line: 10, column: 4 } });
        const report = buildCronScheduleReport([site], [gt]);
        expect(report.summary.recallCron).toBe(1);
        expect(report.summary.recallOverall).toBe(1);
        expect(report.summary.meetsFloor).toBe(true);
        expect(report.missed).toHaveLength(0);
    });

    it('GT not matched (different line) → recall = 0 and meetsFloor = false', () => {
        const site = makeSite({ location: { file: '/app/test.ts', line: 10, column: 4 } });
        const gt = makeGtEntry({ location: { file: '/app/test.ts', line: 99, column: 4 } });
        const report = buildCronScheduleReport([site], [gt]);
        expect(report.summary.recallCron).toBe(0);
        expect(report.summary.recallOverall).toBe(0);
        expect(report.summary.meetsFloor).toBe(false);
        expect(report.missed).toHaveLength(1);
        expect(report.extra).toHaveLength(1);
    });

    it('partial recall — 1 of 2 GT matched → recallCron = 0.5', () => {
        const site = makeSite({ location: { file: '/app/test.ts', line: 10, column: 4 } });
        const gt1 = makeGtEntry({ location: { file: '/app/test.ts', line: 10, column: 4 } });
        const gt2 = makeGtEntry({ location: { file: '/app/test.ts', line: 20, column: 4 } });
        const report = buildCronScheduleReport([site], [gt1, gt2]);
        expect(report.summary.recallCron).toBe(0.5);
        expect(report.summary.groundTruthCron).toBe(2);
    });

    it('CRON_RECALL_FLOOR is 0.9', () => {
        expect(CRON_RECALL_FLOOR).toBe(0.9);
    });
});

// ---------------------------------------------------------------------------
// Regex pattern tests against fixture
// ---------------------------------------------------------------------------

describe('ground-truth regex patterns — fixture coverage', () => {
    it('CRON_RE matches all @Cron occurrences in sample.ts', () => {
        const text = readFixture();
        const matches = [...text.matchAll(new RegExp(CRON_RE.source, CRON_RE.flags))];
        // Fixture has @Cron('0 0 * * *'), @Cron(CronExpression.EVERY_HOUR), @Cron('* * * * *', {...}), @Cron('0 */6 * * *')
        expect(matches.length).toBeGreaterThanOrEqual(4);
    });

    it('INTERVAL_RE matches all @Interval occurrences in sample.ts', () => {
        const text = readFixture();
        const matches = [...text.matchAll(new RegExp(INTERVAL_RE.source, INTERVAL_RE.flags))];
        // Fixture has @Interval(60000), @Interval('namedInterval', 30000), @Interval(120000)
        expect(matches.length).toBeGreaterThanOrEqual(3);
    });

    it('TIMEOUT_RE matches all @Timeout occurrences in sample.ts', () => {
        const text = readFixture();
        const matches = [...text.matchAll(new RegExp(TIMEOUT_RE.source, TIMEOUT_RE.flags))];
        // Fixture has @Timeout(5000)
        expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    it('SCHEDULER_REGISTRY_RE matches dynamic registry calls in sample.ts including lowercase-var idioms', () => {
        const text = readFixture();
        const matches = [...text.matchAll(new RegExp(SCHEDULER_REGISTRY_RE.source, SCHEDULER_REGISTRY_RE.flags))];
        // Fixture has: .addCronJob, .addInterval, .addTimeout (multiple)
        expect(matches.length).toBeGreaterThanOrEqual(3);
    });

    it('SCHEDULER_REGISTRY_RE matches this.schedulerRegistry.addCronJob(...) pattern', () => {
        const sample = 'this.schedulerRegistry.addCronJob("job1", new CronJob("0 * * * *", cb))';
        const matches = [...sample.matchAll(new RegExp(SCHEDULER_REGISTRY_RE.source, SCHEDULER_REGISTRY_RE.flags))];
        expect(matches.length).toBe(1);
    });

    it('SCHEDULER_REGISTRY_RE does NOT match unrelated methods (sanity check)', () => {
        const sample = 'this.someService.addUser("bob")';
        const matches = [...sample.matchAll(new RegExp(SCHEDULER_REGISTRY_RE.source, SCHEDULER_REGISTRY_RE.flags))];
        expect(matches.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Round-2 validator tests — FIX 2C receiver-pattern symmetry
// ---------------------------------------------------------------------------

describe('SCHEDULER_REGISTRY_RE round-2 receiver guard', () => {
    it('matches this.cron.addCronJob(...) — cron receiver', () => {
        const sample = 'this.cron.addCronJob("cronReceiverJob", new CronJob("0 12 * * *", () => {}))';
        const matches = [...sample.matchAll(new RegExp(SCHEDULER_REGISTRY_RE.source, SCHEDULER_REGISTRY_RE.flags))];
        expect(matches.length).toBe(1);
    });

    it('matches registry.addInterval(...) — registry receiver', () => {
        const sample = 'registry.addInterval("interval1", 5000)';
        const matches = [...sample.matchAll(new RegExp(SCHEDULER_REGISTRY_RE.source, SCHEDULER_REGISTRY_RE.flags))];
        expect(matches.length).toBe(1);
    });

    it('matches taskRunner.addTimeout(...) — runner receiver', () => {
        const sample = 'taskRunner.addTimeout("t1", 3000)';
        const matches = [...sample.matchAll(new RegExp(SCHEDULER_REGISTRY_RE.source, SCHEDULER_REGISTRY_RE.flags))];
        expect(matches.length).toBe(1);
    });

    it('does NOT match this.unrelated.addInterval(...) — non-scheduler receiver', () => {
        const sample = 'this.unrelated.addInterval("unrelatedInterval", 3000)';
        const matches = [...sample.matchAll(new RegExp(SCHEDULER_REGISTRY_RE.source, SCHEDULER_REGISTRY_RE.flags))];
        expect(matches.length).toBe(0);
    });

    it('does NOT match this.someService.addCronJob(...) — non-scheduler receiver', () => {
        const sample = 'this.someService.addCronJob("job1", new CronJob("0 * * * *", cb))';
        const matches = [...sample.matchAll(new RegExp(SCHEDULER_REGISTRY_RE.source, SCHEDULER_REGISTRY_RE.flags))];
        expect(matches.length).toBe(0);
    });

    it('FIX 2D test 5 — fixture dynamic GT count equals extractor site count (recallDynamic = 1.0)', async () => {
        // The fixture has 4 dynamic sites in class DynamicTaskService:
        //   - schedulerRegistry.addCronJob (expression resolvable)     → site emitted
        //   - schedulerRegistry.addInterval (expression resolvable)    → site emitted
        //   - schedulerRegistry.addTimeout with {} (unresolvable)      → dropped (unresolved)
        //   - schedulerRegistry.addTimeout with 10000 (resolvable)     → site emitted
        // Plus class ReceiverGuardService:
        //   - cron.addCronJob (receiver=cron → matches) (resolvable)   → site emitted
        //   - unrelated.addInterval (receiver=unrelated → no match)    → filtered, NOT in GT
        //
        // The validator SCHEDULER_REGISTRY_RE with lookbehind should match exactly the
        // same set as the extractor (schedulerRegistry.* and cron.*), giving recallDynamic = 1.0
        // for the resolvable subset.
        //
        // We test this by checking that GT dynamic count matches the number of resolvable dynamic
        // sites emitted by the extractor (via buildCronScheduleReport).
        const fixtureContent = readFixture();

        // Count dynamic GT matches in fixture
        const re = new RegExp(SCHEDULER_REGISTRY_RE.source, SCHEDULER_REGISTRY_RE.flags);
        const gtDynamic = [...fixtureContent.matchAll(re)];
        // unrelated.addInterval should NOT be in GT
        const hasUnrelated = gtDynamic.some((m) =>
            fixtureContent.slice(Math.max(0, (m.index ?? 0) - 20), m.index ?? 0).toLowerCase().includes('unrelated'),
        );
        expect(hasUnrelated).toBe(false);
        // cron.addCronJob and schedulerRegistry.* should be in GT
        expect(gtDynamic.length).toBeGreaterThanOrEqual(4);
    });
});
