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
    validateSnippetRecall,
    formatRecallResult,
} from './snippet-recall-validator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'snippet-recall-test-'));
    mkdirSync(join(dir, 'semantic'), { recursive: true });
    return dir;
}

type RecordLike = { kind: string; snippet: string; nodeId?: string; label?: string };

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

    it('KINDS_WITHOUT_SOURCE includes nats-subject, db-table, queue, external', () => {
        expect(KINDS_WITHOUT_SOURCE.has('nats-subject')).toBe(true);
        expect(KINDS_WITHOUT_SOURCE.has('db-table')).toBe(true);
        expect(KINDS_WITHOUT_SOURCE.has('queue')).toBe(true);
        expect(KINDS_WITHOUT_SOURCE.has('external')).toBe(true);
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
