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
// Happy path — all pass
// ---------------------------------------------------------------------------

describe('validateSnippetRecall — happy paths', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

    it('returns passed=true when all source-backed kinds meet their floor', async () => {
        // 20 providers all with snippets → 100% (≥ 95%)
        const records: RecordLike[] = [
            ...Array.from({ length: 20 }, (_, i) => ({ kind: 'provider', snippet: `class Svc${i} {}`, nodeId: `provider:svc${i}`, label: `Svc${i}` })),
            ...Array.from({ length: 10 }, (_, i) => ({ kind: 'endpoint', snippet: `method${i}() {}`, nodeId: `endpoint:e${i}`, label: `GET /path${i}` })),
            ...Array.from({ length: 5 }, (_, i) => ({ kind: 'nats-subject', snippet: '', nodeId: `nats:s${i}`, label: `agent.${i}` })),
        ];
        writeEmbeddingsJsonl(tmpDir, records);
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.passed).toBe(true);
        expect(result.failures).toHaveLength(0);
    });

    it('excludes KINDS_WITHOUT_SOURCE from denominator', async () => {
        // Only nats-subject and db-table nodes with empty snippets — should pass vacuously
        const records: RecordLike[] = [
            ...Array.from({ length: 10 }, (_, i) => ({ kind: 'nats-subject', snippet: '', nodeId: `n${i}`, label: `subj${i}` })),
            ...Array.from({ length: 5 }, (_, i) => ({ kind: 'db-table', snippet: '', nodeId: `t${i}`, label: `tbl${i}` })),
        ];
        writeEmbeddingsJsonl(tmpDir, records);
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.passed).toBe(true);
        expect(result.totalNodes).toBe(0); // all excluded
    });

    it('computes correct fill rates per kind', async () => {
        // 90 providers filled, 10 empty → 90% (≥ 95% fails)
        const records: RecordLike[] = [
            ...Array.from({ length: 90 }, (_, i) => ({ kind: 'provider', snippet: `class P${i} {}`, nodeId: `p${i}`, label: `P${i}` })),
            ...Array.from({ length: 10 }, (_, i) => ({ kind: 'provider', snippet: '', nodeId: `pe${i}`, label: `PE${i}` })),
        ];
        writeEmbeddingsJsonl(tmpDir, records);
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        const providerStats = result.byKind.find((k) => k.kind === 'provider');
        expect(providerStats).toBeDefined();
        expect(providerStats!.fillRate).toBeCloseTo(0.9);
        expect(providerStats!.passed).toBe(false); // 90% < 95%
        expect(result.passed).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Failure cases
// ---------------------------------------------------------------------------

describe('validateSnippetRecall — failure detection', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

    it('fails when provider fill rate < 95%', async () => {
        // 80 out of 100 providers have snippets → 80%
        const records: RecordLike[] = [
            ...Array.from({ length: 80 }, (_, i) => ({ kind: 'provider', snippet: `class P${i} {}`, nodeId: `p${i}`, label: `P${i}` })),
            ...Array.from({ length: 20 }, (_, i) => ({ kind: 'provider', snippet: '', nodeId: `pe${i}`, label: `PE${i}` })),
        ];
        writeEmbeddingsJsonl(tmpDir, records);
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.passed).toBe(false);
        expect(result.failures.map((f) => f.kind)).toContain('provider');
    });

    it('fails when fe-component fill rate < 85%', async () => {
        // 80 out of 100 fe-components → 80% (< 85% default floor)
        const records: RecordLike[] = [
            ...Array.from({ length: 80 }, (_, i) => ({ kind: 'fe-component', snippet: `const C${i} = () => null;`, nodeId: `c${i}`, label: `C${i}` })),
            ...Array.from({ length: 20 }, (_, i) => ({ kind: 'fe-component', snippet: '', nodeId: `ce${i}`, label: `CE${i}` })),
        ];
        writeEmbeddingsJsonl(tmpDir, records);
        const result = await validateSnippetRecall(join(tmpDir, 'semantic'));
        expect(result.passed).toBe(false);
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
        expect(result.passed).toBe(false);
        const failedKinds = result.failures.map((f) => f.kind);
        expect(failedKinds).toContain('provider');
        expect(failedKinds).toContain('endpoint');
    });
});

// ---------------------------------------------------------------------------
// formatRecallResult
// ---------------------------------------------------------------------------

describe('formatRecallResult', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

    it('produces readable output with PASS/FAIL markers', async () => {
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

    it('includes FAILED kinds list when some fail', async () => {
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
});
