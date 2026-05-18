/**
 * Tests for the snippet recall validator (A11).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    RECALL_FLOOR_DEFAULT,
    RECALL_FLOOR_HIGH_FIDELITY,
    HIGH_FIDELITY_KINDS,
    KINDS_WITHOUT_SOURCE,
    makeSnippetStats,
    validateSnippetRecall,
    formatRecallResult,
    isExpectedToHaveSnippet,
} from './snippet-recall-validator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'snippet-recall-test-'));
    mkdirSync(join(dir, 'semantic'), { recursive: true });
    return dir;
}

type RecordLike = { kind: string; snippet: string; nodeId?: string; label?: string; path?: string };

function writeEmbeddingsJsonl(tmpDir: string, records: RecordLike[]): void {
    const lines = records.map((r) => JSON.stringify(r)).join('\n');
    writeFileSync(join(tmpDir, 'semantic', 'embeddings.jsonl'), lines, 'utf8');
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('snippet-recall-validator constants', () => {
    it('has RECALL_FLOOR_DEFAULT = 0.85', () => {
        expect(RECALL_FLOOR_DEFAULT).toBe(0.85);
    });

    it('has RECALL_FLOOR_HIGH_FIDELITY = 0.95', () => {
        expect(RECALL_FLOOR_HIGH_FIDELITY).toBe(0.95);
    });

    it('HIGH_FIDELITY_KINDS includes provider, endpoint, db-entity-field, config-field', () => {
        expect(HIGH_FIDELITY_KINDS.has('provider')).toBe(true);
        expect(HIGH_FIDELITY_KINDS.has('endpoint')).toBe(true);
        expect(HIGH_FIDELITY_KINDS.has('db-entity-field')).toBe(true);
        expect(HIGH_FIDELITY_KINDS.has('config-field')).toBe(true);
    });

    it('KINDS_WITHOUT_SOURCE includes nats-subject, db-table, queue, external, lib, service', () => {
        expect(KINDS_WITHOUT_SOURCE.has('nats-subject')).toBe(true);
        expect(KINDS_WITHOUT_SOURCE.has('db-table')).toBe(true);
        expect(KINDS_WITHOUT_SOURCE.has('queue')).toBe(true);
        expect(KINDS_WITHOUT_SOURCE.has('external')).toBe(true);
        // CT-AC1: lib and service are virtual — excluded from recall denominator
        expect(KINDS_WITHOUT_SOURCE.has('lib')).toBe(true);
        expect(KINDS_WITHOUT_SOURCE.has('service')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// makeSnippetStats — unit tests for the factory directly
// ---------------------------------------------------------------------------

describe('makeSnippetStats', () => {
    it('aggregateFillRate is 0 (not NaN) when totalNodes is 0', () => {
        const stats = makeSnippetStats(0, 0, []);
        expect(stats.aggregateFillRate).toBe(0);
        expect(Number.isNaN(stats.aggregateFillRate)).toBe(false);
    });

    it('computes aggregateFillRate correctly for non-zero totalNodes', () => {
        const stats = makeSnippetStats(10, 8, []);
        expect(stats.aggregateFillRate).toBeCloseTo(0.8);
    });

    it('returns provided byKind array unchanged', () => {
        const kindStats = [
            { kind: 'provider' as const, total: 10, filled: 10, fillRate: 1, floor: 0.95, passed: true },
        ];
        const stats = makeSnippetStats(10, 10, kindStats);
        expect(stats.byKind).toBe(kindStats);
    });
});

// ---------------------------------------------------------------------------
// Happy path — all pass → kind: 'ok'
// ---------------------------------------------------------------------------

describe('validateSnippetRecall — happy paths', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

    it('returns kind=ok when all source-backed kinds meet their floor', async () => {
        // 20 providers all with snippets → 100% (≥ 95%)
        const records: RecordLike[] = [
            ...Array.from({ length: 20 }, (_, i) => ({ kind: 'provider', snippet: `class Svc${i} {}`, nodeId: `provider:svc${i}`, label: `Svc${i}` })),
            ...Array.from({ length: 10 }, (_, i) => ({ kind: 'endpoint', snippet: `method${i}() {}`, nodeId: `endpoint:e${i}`, label: `GET /path${i}` })),
            ...Array.from({ length: 5 }, (_, i) => ({ kind: 'nats-subject', snippet: '', nodeId: `nats:s${i}`, label: `agent.${i}` })),
        ];
        writeEmbeddingsJsonl(tmpDir, records);
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') return;
        expect(result.stats.byKind.length).toBeGreaterThan(0);
    });

    it('excludes KINDS_WITHOUT_SOURCE from denominator; empty index → kind=empty', async () => {
        // Only nats-subject and db-table nodes with empty snippets — totalNodes=0.
        // Per P1-5: empty index (totalNodes === 0) must be kind=empty (not a pass).
        const records: RecordLike[] = [
            ...Array.from({ length: 10 }, (_, i) => ({ kind: 'nats-subject', snippet: '', nodeId: `n${i}`, label: `subj${i}` })),
            ...Array.from({ length: 5 }, (_, i) => ({ kind: 'db-table', snippet: '', nodeId: `t${i}`, label: `tbl${i}` })),
        ];
        writeEmbeddingsJsonl(tmpDir, records);
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.kind).toBe('empty');
    });

    it('computes correct fill rates per kind → kind=below-floor when provider < 95%', async () => {
        // 90 providers filled, 10 empty → 90% (≥ 95% fails)
        const records: RecordLike[] = [
            ...Array.from({ length: 90 }, (_, i) => ({ kind: 'provider', snippet: `class P${i} {}`, nodeId: `p${i}`, label: `P${i}` })),
            ...Array.from({ length: 10 }, (_, i) => ({ kind: 'provider', snippet: '', nodeId: `pe${i}`, label: `PE${i}` })),
        ];
        writeEmbeddingsJsonl(tmpDir, records);
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.kind).toBe('below-floor');
        if (result.kind !== 'below-floor') return;
        const providerStats = result.stats.byKind.find((k) => k.kind === 'provider');
        expect(providerStats).toBeDefined();
        expect(providerStats!.fillRate).toBeCloseTo(0.9);
        expect(providerStats!.passed).toBe(false); // 90% < 95%
        expect(result.failures.map((f) => f.kind)).toContain('provider');
    });
});

// ---------------------------------------------------------------------------
// Failure cases — kind: 'below-floor'
// ---------------------------------------------------------------------------

describe('validateSnippetRecall — failure detection', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

    it('returns kind=below-floor when provider fill rate < 95%', async () => {
        // 80 out of 100 providers have snippets → 80%
        const records: RecordLike[] = [
            ...Array.from({ length: 80 }, (_, i) => ({ kind: 'provider', snippet: `class P${i} {}`, nodeId: `p${i}`, label: `P${i}` })),
            ...Array.from({ length: 20 }, (_, i) => ({ kind: 'provider', snippet: '', nodeId: `pe${i}`, label: `PE${i}` })),
        ];
        writeEmbeddingsJsonl(tmpDir, records);
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.kind).toBe('below-floor');
        if (result.kind !== 'below-floor') return;
        expect(result.failures.map((f) => f.kind)).toContain('provider');
    });

    it('returns kind=below-floor when fe-component fill rate < 85%', async () => {
        // 80 out of 100 fe-components → 80% (< 85% default floor)
        const records: RecordLike[] = [
            ...Array.from({ length: 80 }, (_, i) => ({ kind: 'fe-component', snippet: `const C${i} = () => null;`, nodeId: `c${i}`, label: `C${i}` })),
            ...Array.from({ length: 20 }, (_, i) => ({ kind: 'fe-component', snippet: '', nodeId: `ce${i}`, label: `CE${i}` })),
        ];
        writeEmbeddingsJsonl(tmpDir, records);
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.kind).toBe('below-floor');
        if (result.kind !== 'below-floor') return;
        expect(result.failures.map((f) => f.kind)).toContain('fe-component');
    });

    it('reports all failing kinds in failures array', async () => {
        // Both provider (< 95%) and endpoint (< 95%) fail
        const records: RecordLike[] = [
            ...Array.from({ length: 80 }, (_, i) => ({ kind: 'provider', snippet: `class P${i} {}`, nodeId: `p${i}`, label: `P${i}` })),
            ...Array.from({ length: 20 }, (_, i) => ({ kind: 'provider', snippet: '', nodeId: `pe${i}`, label: `PE${i}` })),
            ...Array.from({ length: 70 }, (_, i) => ({ kind: 'endpoint', snippet: `method${i}() {}`, nodeId: `e${i}`, label: `GET /p${i}` })),
            ...Array.from({ length: 30 }, (_, i) => ({ kind: 'endpoint', snippet: '', nodeId: `ee${i}`, label: `POST /pe${i}` })),
        ];
        writeEmbeddingsJsonl(tmpDir, records);
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.kind).toBe('below-floor');
        if (result.kind !== 'below-floor') return;
        const failedKinds = result.failures.map((f) => f.kind);
        expect(failedKinds).toContain('provider');
        expect(failedKinds).toContain('endpoint');
    });
});

// ---------------------------------------------------------------------------
// P1-5: malformedLines tracking, empty-file false-pass, corruption threshold
// ---------------------------------------------------------------------------

describe('validateSnippetRecall — P1-5 malformed lines + edge cases', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

    it('returns kind=ok with no corruption for a clean index', async () => {
        const records: RecordLike[] = [
            ...Array.from({ length: 10 }, (_, i) => ({ kind: 'provider', snippet: `class P${i} {}` })),
        ];
        writeEmbeddingsJsonl(tmpDir, records);
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.kind).toBe('ok');
    });

    it('counts malformedLines for non-JSON lines but stays below corrupt threshold', async () => {
        const goodLine = JSON.stringify({ kind: 'provider', snippet: 'class P {}' });
        const badLine = 'this is not json {{{';
        writeFileSync(
            join(tmpDir, 'semantic', 'embeddings.jsonl'),
            [goodLine, badLine, goodLine].join('\n'),
            'utf8',
        );
        // 1 bad of 3 total = 33% → corrupt
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.kind).toBe('corrupt');
        if (result.kind !== 'corrupt') return;
        expect(result.malformedLines).toBe(1);
    });

    it('empty index file → kind=empty', async () => {
        // Write an empty file — no lines at all.
        writeFileSync(join(tmpDir, 'semantic', 'embeddings.jsonl'), '', 'utf8');
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.kind).toBe('empty');
    });

    it('all-kinds-without-source file → kind=empty', async () => {
        // All records are excluded (KINDS_WITHOUT_SOURCE) — totalNodes stays 0.
        const records: RecordLike[] = [
            ...Array.from({ length: 5 }, (_, i) => ({ kind: 'nats-subject', snippet: '' })),
        ];
        writeEmbeddingsJsonl(tmpDir, records);
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.kind).toBe('empty');
    });

    it('fully-corrupt index (100% malformed) → kind=corrupt', async () => {
        const lines = Array.from({ length: 10 }, () => 'CORRUPT LINE NOT JSON').join('\n');
        writeFileSync(join(tmpDir, 'semantic', 'embeddings.jsonl'), lines, 'utf8');
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.kind).toBe('corrupt');
        if (result.kind !== 'corrupt') return;
        expect(result.malformedLines).toBe(10);
        expect(result.totalLines).toBe(10);
    });

    it('90%-corrupt index exceeds 5% threshold → kind=corrupt', async () => {
        // 1 good line (provider with snippet) + 9 bad lines → 90% malformed, exceeds 5% threshold
        const goodLine = JSON.stringify({ kind: 'provider', snippet: 'class P {}' });
        const badLines = Array.from({ length: 9 }, () => 'BAD');
        writeFileSync(
            join(tmpDir, 'semantic', 'embeddings.jsonl'),
            [goodLine, ...badLines].join('\n'),
            'utf8',
        );
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.kind).toBe('corrupt');
        if (result.kind !== 'corrupt') return;
        expect(result.malformedLines).toBe(9);
        expect(result.totalLines).toBe(10);
    });

    it('4%-malformed index (below threshold) → kind=ok (corruption < 5%)', async () => {
        // 96 good lines + 4 bad lines = 4% malformed, below 5% threshold
        // All 96 providers have snippets → would pass if not corrupt
        const goodLine = JSON.stringify({ kind: 'provider', snippet: 'class P {}' });
        const badLines = Array.from({ length: 4 }, () => 'BAD');
        writeFileSync(
            join(tmpDir, 'semantic', 'embeddings.jsonl'),
            [...Array.from({ length: 96 }, () => goodLine), ...badLines].join('\n'),
            'utf8',
        );
        // 4 bad of 100 total = 4% — below threshold; 96 providers with snippets = 100% fill → ok
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.kind).toBe('ok');
    });
});

// ---------------------------------------------------------------------------
// P1-B: DU variant accessors
// ---------------------------------------------------------------------------

describe('validateSnippetRecall — discriminated union structure', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

    it('ok variant has stats with totalNodes, totalFilled, aggregateFillRate, byKind', async () => {
        const records: RecordLike[] = Array.from({ length: 10 }, (_, i) => ({
            kind: 'provider', snippet: `class P${i} {}`,
        }));
        writeEmbeddingsJsonl(tmpDir, records);
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') return;
        expect(result.stats.totalNodes).toBe(10);
        expect(result.stats.totalFilled).toBe(10);
        expect(result.stats.aggregateFillRate).toBeCloseTo(1.0);
        expect(result.stats.byKind).toHaveLength(1);
    });

    it('below-floor variant has failures array + stats', async () => {
        const records: RecordLike[] = [
            ...Array.from({ length: 80 }, (_, i) => ({ kind: 'provider', snippet: `class P${i} {}` })),
            ...Array.from({ length: 20 }, (_, i) => ({ kind: 'provider', snippet: '' })),
        ];
        writeEmbeddingsJsonl(tmpDir, records);
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.kind).toBe('below-floor');
        if (result.kind !== 'below-floor') return;
        expect(result.failures).toHaveLength(1);
        expect(result.stats.totalNodes).toBe(100);
        expect(result.stats.aggregateFillRate).toBeCloseTo(0.8);
    });

    it('corrupt variant exposes malformedLines and totalLines', async () => {
        const lines = Array.from({ length: 20 }, () => 'NOT JSON').join('\n');
        writeFileSync(join(tmpDir, 'semantic', 'embeddings.jsonl'), lines, 'utf8');
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.kind).toBe('corrupt');
        if (result.kind !== 'corrupt') return;
        expect(result.malformedLines).toBe(20);
        expect(result.totalLines).toBe(20);
    });
});

// ---------------------------------------------------------------------------
// formatRecallResult
// ---------------------------------------------------------------------------

describe('formatRecallResult', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

    it('produces readable output with PASS markers for ok result', async () => {
        const records: RecordLike[] = [
            ...Array.from({ length: 95 }, (_, i) => ({ kind: 'provider', snippet: `class P${i} {}`, nodeId: `p${i}`, label: `P${i}` })),
            ...Array.from({ length: 5 }, (_, i) => ({ kind: 'provider', snippet: '', nodeId: `pe${i}`, label: `PE${i}` })),
        ];
        writeEmbeddingsJsonl(tmpDir, records);
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        const formatted = formatRecallResult(result);
        expect(formatted).toContain('PASS'); // 95% meets 95% floor
        expect(formatted).toContain('provider');
    });

    it('includes FAILED kinds list when some fail (below-floor result)', async () => {
        const records: RecordLike[] = [
            ...Array.from({ length: 80 }, (_, i) => ({ kind: 'provider', snippet: `class P${i} {}`, nodeId: `p${i}`, label: `P${i}` })),
            ...Array.from({ length: 20 }, (_, i) => ({ kind: 'provider', snippet: '', nodeId: `pe${i}`, label: `PE${i}` })),
        ];
        writeEmbeddingsJsonl(tmpDir, records);
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        const formatted = formatRecallResult(result);
        expect(formatted).toContain('FAILED kinds');
        expect(formatted).toContain('provider');
    });

    it('formats corrupt result with malformed/total line counts', async () => {
        const lines = Array.from({ length: 10 }, () => 'GARBAGE').join('\n');
        writeFileSync(join(tmpDir, 'semantic', 'embeddings.jsonl'), lines, 'utf8');
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.kind).toBe('corrupt');
        const formatted = formatRecallResult(result);
        expect(formatted).toContain('corrupt');
        expect(formatted).toContain('10 of 10');
    });

    it('formats empty result', () => {
        const formatted = formatRecallResult({ kind: 'empty' });
        expect(formatted).toContain('empty');
    });
});

// ---------------------------------------------------------------------------
// CT-AC1/2/4: lib/service exclusion + module path-based classification
// ---------------------------------------------------------------------------

describe('isExpectedToHaveSnippet — virtual-kind and module classification', () => {
    // CT-AC1: lib and service are excluded (virtual, no source file)
    it('(a) lib node is excluded from denominator', () => {
        expect(isExpectedToHaveSnippet({ kind: 'lib' })).toBe(false);
        expect(isExpectedToHaveSnippet({ kind: 'lib', path: '/some/path' })).toBe(false);
    });

    it('(a) service node is excluded from denominator', () => {
        expect(isExpectedToHaveSnippet({ kind: 'service' })).toBe(false);
        expect(isExpectedToHaveSnippet({ kind: 'service', path: '/some/path' })).toBe(false);
    });

    // CT-AC2: module with path = internal → counted; module without path = external → excluded
    it('(b) module WITH path is counted (internal module)', () => {
        expect(isExpectedToHaveSnippet({ kind: 'module', path: '/workspace/apps/project-a/src/app.module.ts' })).toBe(true);
    });

    it('(c) module WITHOUT path is excluded (external module)', () => {
        expect(isExpectedToHaveSnippet({ kind: 'module' })).toBe(false);
        expect(isExpectedToHaveSnippet({ kind: 'module', path: undefined })).toBe(false);
    });

    it('module with empty-string path is treated as virtual (excluded)', () => {
        expect(isExpectedToHaveSnippet({ kind: 'module', path: '' })).toBe(false);
    });
});

describe('validateSnippetRecall — CT-AC2/4: mixed module set computes internal-only rate', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

    // (d) mixed module set: internal modules have path, external do not;
    //     recall rate should be computed only across internal modules.
    it('(d) computes recall rate from internal modules only, excludes external modules', async () => {
        const records: RecordLike[] = [
            // 10 internal modules (path present) — 9 with snippet, 1 without
            ...Array.from({ length: 9 }, (_, i) => ({
                kind: 'module',
                snippet: `@Module({}) export class AppModule${i} {}`,
                path: `/workspace/apps/svc/src/module${i}.ts`,
            })),
            { kind: 'module', snippet: '', path: '/workspace/apps/svc/src/broken.ts' },
            // 5 external modules (no path) — all without snippet (should not affect rate)
            ...Array.from({ length: 5 }, (_, i) => ({
                kind: 'module',
                snippet: '',
                // no path field
            })),
            // Unrelated lib and service nodes (should also be excluded)
            { kind: 'lib', snippet: '' },
            { kind: 'service', snippet: '' },
        ];
        writeEmbeddingsJsonl(tmpDir, records);

        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        // 9/10 internal modules = 90%, which is ≥ 85% floor → ok
        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') return;

        const moduleStats = result.stats.byKind.find((k) => k.kind === 'module');
        expect(moduleStats).toBeDefined();
        // Only 10 internal modules counted, not 15 (5 external excluded)
        expect(moduleStats!.total).toBe(10);
        expect(moduleStats!.filled).toBe(9);
        expect(moduleStats!.fillRate).toBeCloseTo(0.9);

        // Virtual nodes diagnostic reports the excluded counts (CT-AC7)
        expect(result.stats.virtualNodes.moduleExternal).toBe(5);
        expect(result.stats.virtualNodes.lib).toBe(1);
        expect(result.stats.virtualNodes.service).toBe(1);
    });

    it('lib-and-service-only index yields kind=empty (excluded from denominator)', async () => {
        const records: RecordLike[] = [
            ...Array.from({ length: 4 }, (_, i) => ({ kind: 'lib', snippet: '' })),
            ...Array.from({ length: 3 }, (_, i) => ({ kind: 'service', snippet: '' })),
        ];
        writeEmbeddingsJsonl(tmpDir, records);
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.kind).toBe('empty');
    });

    it('internal modules below 85% correctly fail (regression regression guard)', async () => {
        // Future PR might drop path from internal modules → recall collapses.
        // 7/10 internal modules with snippets = 70% → below 85% floor.
        const records: RecordLike[] = [
            ...Array.from({ length: 7 }, (_, i) => ({
                kind: 'module',
                snippet: `@Module({}) export class M${i} {}`,
                path: `/workspace/apps/svc/src/m${i}.ts`,
            })),
            ...Array.from({ length: 3 }, (_, i) => ({
                kind: 'module',
                snippet: '',
                path: `/workspace/apps/svc/src/missing${i}.ts`,
            })),
        ];
        writeEmbeddingsJsonl(tmpDir, records);
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.kind).toBe('below-floor');
        if (result.kind !== 'below-floor') return;
        expect(result.failures.map((f) => f.kind)).toContain('module');
    });
});

describe('formatRecallResult — CT-AC7: virtual nodes diagnostic section', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

    it('reports lib, service, and external module counts in formatted output', async () => {
        const records: RecordLike[] = [
            // Internal module — counts toward recall
            { kind: 'module', snippet: '@Module({}) export class App {}', path: '/ws/app.ts' },
            // Excluded virtual nodes
            { kind: 'lib', snippet: '' },
            { kind: 'service', snippet: '' },
            { kind: 'module', snippet: '' }, // external (no path)
        ];
        writeEmbeddingsJsonl(tmpDir, records);
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.kind).toBe('ok');
        const formatted = formatRecallResult(result);
        expect(formatted).toContain('Virtual nodes');
        expect(formatted).toContain('lib: 1');
        expect(formatted).toContain('service: 1');
        expect(formatted).toContain('module (external): 1');
    });
});

describe('doc-section recall contract', () => {
    it('is NOT in KINDS_WITHOUT_SOURCE (must contribute to recall denominator)', () => {
        expect(KINDS_WITHOUT_SOURCE.has('doc-section' as const)).toBe(false);
    });
});
