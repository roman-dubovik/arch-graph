import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { Project } from 'ts-morph';
import { extractCronSchedule } from './extractor.js';
import { mapCronScheduleToGraph } from '../../mapper/cron-schedule-to-graph.js';
import { OwnershipRegistry } from '../../core/service-registry.js';
import type { ArchGraphConfig } from '../../core/config.js';

const FIXTURE_PATH = join(import.meta.dirname ?? __dirname, '__fixtures__/sample.ts');

function makeConfig(root = '/app'): ArchGraphConfig {
    return {
        id: 'test',
        root,
        appsGlob: 'apps/**',
    } as unknown as ArchGraphConfig;
}

function makeProject(): Project {
    const p = new Project({ useInMemoryFileSystem: false });
    p.addSourceFileAtPath(FIXTURE_PATH);
    return p;
}

function makeRegistry(root = '/'): OwnershipRegistry {
    const fixtureDir = join(import.meta.dirname ?? __dirname, '__fixtures__');
    return new OwnershipRegistry(root, [
        { id: 'test-svc', rootDir: fixtureDir, tsconfigPath: null, entryFile: null },
    ], []);
}

// ---------------------------------------------------------------------------
// Extractor tests
// ---------------------------------------------------------------------------

describe('extractCronSchedule', () => {
    it('@Cron with raw string literal → cron site with expression', async () => {
        const project = makeProject();
        const { sites } = await extractCronSchedule(makeConfig(), project);
        const midnight = sites.find(
            (s) => s.expression === '0 0 * * *' && s.category === 'cron',
        );
        expect(midnight).toBeDefined();
        expect(midnight?.owner).toBe('TaskServiceA.handleMidnightJob');
        expect(midnight?.resolvedExpression).toBe('0 0 * * *');
    });

    it('@Cron with CronExpression.EVERY_HOUR → resolved expression from map', async () => {
        const project = makeProject();
        const { sites } = await extractCronSchedule(makeConfig(), project);
        const hourly = sites.find(
            (s) => s.owner === 'TaskServiceA.handleHourlyJob' && s.category === 'cron',
        );
        expect(hourly).toBeDefined();
        // raw = 'CronExpression.EVERY_HOUR'; resolved = '0 * * * *'
        expect(hourly?.resolvedExpression).toBe('0 * * * *');
        expect(hourly?.humanReadable).toBe('every hour');
    });

    it('@Cron with name option → site captures name from options object', async () => {
        const project = makeProject();
        const { sites } = await extractCronSchedule(makeConfig(), project);
        const named = sites.find(
            (s) => s.owner === 'TaskServiceA.handleNamedJob' && s.name === 'myJob',
        );
        expect(named).toBeDefined();
        expect(named?.expression).toBe('* * * * *');
        expect(named?.category).toBe('cron');
    });

    it('@Interval(60000) → site with interval category', async () => {
        const project = makeProject();
        const { sites } = await extractCronSchedule(makeConfig(), project);
        const interval = sites.find(
            (s) => s.owner === 'TaskServiceB.handleInterval' && s.category === 'interval',
        );
        expect(interval).toBeDefined();
        expect(interval?.expression).toBe('60000');
    });

    it('@Timeout(5000) → site with timeout category', async () => {
        const project = makeProject();
        const { sites } = await extractCronSchedule(makeConfig(), project);
        const timeout = sites.find(
            (s) => s.owner === 'TaskServiceB.handleTimeout' && s.category === 'timeout',
        );
        expect(timeout).toBeDefined();
        expect(timeout?.expression).toBe('5000');
    });

    it('@Interval(name, ms) → site captures name and expression', async () => {
        const project = makeProject();
        const { sites } = await extractCronSchedule(makeConfig(), project);
        const named = sites.find(
            (s) => s.owner === 'TaskServiceB.handleNamedInterval',
        );
        expect(named).toBeDefined();
        expect(named?.name).toBe('namedInterval');
        expect(named?.expression).toBe('30000');
        expect(named?.category).toBe('interval');
    });

    it('SchedulerRegistry.addCronJob → dynamic site', async () => {
        const project = makeProject();
        const { sites } = await extractCronSchedule(makeConfig(), project);
        const dynamic = sites.find(
            (s) => s.category === 'dynamic' && s.expression === '0 0 * * *',
        );
        expect(dynamic).toBeDefined();
        expect(dynamic?.owner).toMatch(/^dynamic:/);
    });

    it('empty class → no sites emitted for that class', async () => {
        const project = makeProject();
        const { sites } = await extractCronSchedule(makeConfig(), project);
        const emptySites = sites.filter((s) => s.owner.startsWith('EmptyService.'));
        expect(emptySites).toHaveLength(0);
    });

    it('class with @Cron + @Interval on different methods → 2 sites', async () => {
        const project = makeProject();
        const { sites } = await extractCronSchedule(makeConfig(), project);
        const mixed = sites.filter(
            (s) =>
                s.owner === 'MixedTaskService.handleEvery6Hours' ||
                s.owner === 'MixedTaskService.handleEvery2Minutes',
        );
        expect(mixed).toHaveLength(2);
        const cronSite = mixed.find((s) => s.category === 'cron');
        const intervalSite = mixed.find((s) => s.category === 'interval');
        expect(cronSite).toBeDefined();
        expect(intervalSite).toBeDefined();
    });

    it('dynamic addInterval site has interval category', async () => {
        const project = makeProject();
        const { sites } = await extractCronSchedule(makeConfig(), project);
        // Dynamic addInterval is treated as 'interval' category
        const dynInterval = sites.find(
            (s) => s.category === 'interval' && s.owner.startsWith('dynamic:'),
        );
        expect(dynInterval).toBeDefined();
    });

    it('SchedulerRegistry.addTimeout(name, ms) → dynamic site with timeout category', async () => {
        const project = makeProject();
        const { sites } = await extractCronSchedule(makeConfig(), project);
        // addDynamicTimeoutMs uses a numeric literal — should produce a site
        const dynTimeout = sites.find(
            (s) =>
                s.category === 'timeout' &&
                s.owner.startsWith('dynamic:') &&
                s.expression === '10000',
        );
        expect(dynTimeout).toBeDefined();
        expect(dynTimeout?.name).toBe('dynamicTimeoutMs');
    });

    it('unresolvable addCronJob (pre-constructed job) is dropped and recorded in diagnostics', async () => {
        const project = makeProject();
        const { sites, diagnostics } = await extractCronSchedule(makeConfig(), project);
        // addDynamicTimeout passes `{} as unknown` (not new CronJob) — should be dropped
        const badSite = sites.find(
            (s) => s.owner === 'dynamic:dynamicTimeout',
        );
        expect(badSite).toBeUndefined();
        // Should appear in diagnostics.unresolved
        const dropped = diagnostics.unresolved.find((d) => d.owner === 'dynamic:dynamicTimeout');
        expect(dropped).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// Mapper tests
// ---------------------------------------------------------------------------

describe('mapCronScheduleToGraph', () => {
    it('sites produce cron-schedule nodes', async () => {
        const project = makeProject();
        const { sites } = await extractCronSchedule(makeConfig(), project);
        const registry = makeRegistry();
        const { nodes } = mapCronScheduleToGraph(sites, registry);
        const cronNodes = nodes.filter((n) => n.kind === 'cron-schedule');
        expect(cronNodes.length).toBeGreaterThan(0);
    });

    it('cron-schedule node has expression in meta', async () => {
        const project = makeProject();
        const { sites } = await extractCronSchedule(makeConfig(), project);
        const registry = makeRegistry();
        const { nodes } = mapCronScheduleToGraph(sites, registry);
        const cronNodes = nodes.filter((n) => n.kind === 'cron-schedule');
        for (const node of cronNodes) {
            expect(node.meta).toHaveProperty('expression');
            expect(node.meta).toHaveProperty('category');
        }
    });

    it('edge kind is cron-triggers', async () => {
        const project = makeProject();
        const { sites } = await extractCronSchedule(makeConfig(), project);
        const registry = makeRegistry();
        const { edges } = mapCronScheduleToGraph(sites, registry);
        expect(edges.length).toBeGreaterThan(0);
        for (const edge of edges) {
            expect(edge.kind).toBe('cron-triggers');
        }
    });

    it('empty sites → empty nodes and edges', () => {
        const registry = makeRegistry();
        const { nodes, edges, diagnostics } = mapCronScheduleToGraph([], registry);
        expect(nodes).toHaveLength(0);
        expect(edges).toHaveLength(0);
        expect(diagnostics.counts.totalSites).toBe(0);
    });

    it('CronExpression.EVERY_HOUR site has humanReadable in node meta', async () => {
        const project = makeProject();
        const { sites } = await extractCronSchedule(makeConfig(), project);
        const hourlySite = sites.find((s) => s.humanReadable === 'every hour');
        expect(hourlySite).toBeDefined();
        const registry = makeRegistry();
        const { nodes } = mapCronScheduleToGraph([hourlySite!], registry);
        const cronNode = nodes.find((n) => n.kind === 'cron-schedule');
        expect(cronNode?.meta?.['humanReadable']).toBe('every hour');
    });
});
