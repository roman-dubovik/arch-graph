/**
 * Deterministic unit tests for bench/self-build/compare.ts.
 *
 * All assertions use fixed synthetic fixtures so results are byte-exact
 * regardless of the environment. No model downloads required.
 */
import { describe, expect, it } from 'vitest';

import {
    isHit,
    rankOfFirstExpected,
    score1,
    buildComparison,
    renderMarkdown,
    type BenchResultRow,
    type QuerySpec,
} from '../../bench/self-build/compare.js';

// ── Shared fixtures ────────────────────────────────────────────────────────

const SPEC_A: QuerySpec = {
    id: 'Q1',
    query: 'where is the semantic builder',
    category: 'A_find',
    expectedKindIn: ['doc-section'],
    expectedLabelHas: ['Semantic search', 'builder'],
    minScore: 0.40,
};

const SPEC_B: QuerySpec = {
    id: 'Q2',
    query: 'what does strict mode do',
    category: 'D_docs',
    expectedKindIn: ['doc-section'],
    expectedLabelHas: ['strict', 'Strict'],
    minScore: 0.40,
};

const ROW_HIT: BenchResultRow = {
    queryId: 'Q1',
    nodeId: 'node-1',
    kind: 'doc-section',
    label: 'Semantic search overview',
    score: 0.55,
    path: 'docs/README.md',
    snippet: 'The semantic builder embeds nodes.',
};

const ROW_LOW_SCORE: BenchResultRow = {
    queryId: 'Q1',
    nodeId: 'node-2',
    kind: 'doc-section',
    label: 'Semantic search overview',
    score: 0.30, // below minScore 0.40
    path: 'docs/README.md',
    snippet: 'The semantic builder embeds nodes.',
};

const ROW_WRONG_KIND: BenchResultRow = {
    queryId: 'Q1',
    nodeId: 'node-3',
    kind: 'config-field', // not in expectedKindIn
    label: 'Semantic search overview',
    score: 0.55,
    path: 'src/config.ts',
    snippet: '',
};

const ROW_WRONG_LABEL: BenchResultRow = {
    queryId: 'Q1',
    nodeId: 'node-4',
    kind: 'doc-section',
    label: 'Build pipeline overview', // label doesn't match
    score: 0.55,
    path: 'docs/README.md',
    snippet: '',
};

// ── isHit ─────────────────────────────────────────────────────────────────

describe('isHit', () => {
    it('returns true when score, kind, and label all match', () => {
        expect(isHit([ROW_HIT], SPEC_A)).toBe(true);
    });

    it('returns false when score is below minScore', () => {
        expect(isHit([ROW_LOW_SCORE], SPEC_A)).toBe(false);
    });

    it('returns false when kind is not in expectedKindIn', () => {
        expect(isHit([ROW_WRONG_KIND], SPEC_A)).toBe(false);
    });

    it('returns false when label does not match any expectedLabelHas', () => {
        expect(isHit([ROW_WRONG_LABEL], SPEC_A)).toBe(false);
    });

    it('is case-insensitive for label matching', () => {
        const row: BenchResultRow = { ...ROW_HIT, label: 'SEMANTIC SEARCH top node' };
        expect(isHit([row], SPEC_A)).toBe(true);
    });

    it('returns true if any row in a multi-row list matches', () => {
        expect(isHit([ROW_LOW_SCORE, ROW_HIT], SPEC_A)).toBe(true);
    });

    it('returns false for empty list', () => {
        expect(isHit([], SPEC_A)).toBe(false);
    });
});

// ── score1 ────────────────────────────────────────────────────────────────

describe('score1', () => {
    it('returns the highest score from the list', () => {
        expect(score1([ROW_LOW_SCORE, ROW_HIT])).toBeCloseTo(0.55, 5);
    });

    it('returns null for empty list', () => {
        expect(score1([])).toBeNull();
    });
});

// ── rankOfFirstExpected ───────────────────────────────────────────────────

describe('rankOfFirstExpected', () => {
    it('returns 1 when the top result matches expected criteria', () => {
        expect(rankOfFirstExpected([ROW_HIT], SPEC_A)).toBe(1);
    });

    it('returns 2 when the second result matches', () => {
        const row1: BenchResultRow = { ...ROW_HIT, nodeId: 'n1', score: 0.90, label: 'Unrelated' };
        const row2: BenchResultRow = { ...ROW_HIT, nodeId: 'n2', score: 0.55 };
        expect(rankOfFirstExpected([row1, row2], SPEC_A)).toBe(2);
    });

    it('returns null when no row matches kind+label (score not checked for rank)', () => {
        expect(rankOfFirstExpected([ROW_WRONG_KIND, ROW_WRONG_LABEL], SPEC_A)).toBeNull();
    });

    it('returns null for empty list', () => {
        expect(rankOfFirstExpected([], SPEC_A)).toBeNull();
    });
});

// ── buildComparison ───────────────────────────────────────────────────────

describe('buildComparison', () => {
    const minilmRows: BenchResultRow[] = [
        ROW_HIT,
        { queryId: 'Q2', nodeId: 'n5', kind: 'doc-section', label: 'Unrelated doc', score: 0.30, snippet: '' },
    ];
    const bgeRows: BenchResultRow[] = [
        { queryId: 'Q1', nodeId: 'n6', kind: 'doc-section', label: 'Build pipeline', score: 0.60, snippet: '' },
        { queryId: 'Q2', nodeId: 'n7', kind: 'doc-section', label: 'Strict mode behavior', score: 0.50, snippet: '' },
    ];

    it('produces one comparison entry per query spec', () => {
        const result = buildComparison(minilmRows, bgeRows, [SPEC_A, SPEC_B]);
        expect(result).toHaveLength(2);
    });

    it('correctly detects hits and misses for each model', () => {
        const result = buildComparison(minilmRows, bgeRows, [SPEC_A, SPEC_B]);
        const q1 = result.find((c) => c.queryId === 'Q1')!;
        const q2 = result.find((c) => c.queryId === 'Q2')!;

        // Q1: MiniLM has ROW_HIT (score 0.55, doc-section, label matches) → HIT
        //     BGE has 'Build pipeline' label which does not match 'Semantic search'/'builder' → MISS
        expect(q1.minilmHit).toBe(true);
        expect(q1.bgeHit).toBe(false);

        // Q2: MiniLM has score 0.30 < 0.40 minScore → MISS
        //     BGE has 'Strict mode behavior' label matches 'strict' → HIT
        expect(q2.minilmHit).toBe(false);
        expect(q2.bgeHit).toBe(true);
    });

    it('handles missing queryId gracefully (empty rows → all misses)', () => {
        const result = buildComparison([], [], [SPEC_A]);
        expect(result[0]!.minilmHit).toBe(false);
        expect(result[0]!.bgeHit).toBe(false);
        expect(result[0]!.minilmScore1).toBeNull();
        expect(result[0]!.bgeScore1).toBeNull();
    });
});

// ── renderMarkdown (exact output) ─────────────────────────────────────────

describe('renderMarkdown', () => {
    const specs: QuerySpec[] = [SPEC_A, SPEC_B];
    const comparisons = [
        {
            queryId: 'Q1',
            query: 'where is the semantic builder',
            category: 'A_find',
            minilmHit: true,
            bgeHit: false,
            minilmScore1: 0.550,
            bgeScore1: 0.600,
            minilmRank: 1,
            bgeRank: null,
        },
        {
            queryId: 'Q2',
            query: 'what does strict mode do',
            category: 'D_docs',
            minilmHit: false,
            bgeHit: true,
            minilmScore1: 0.300,
            bgeScore1: 0.500,
            minilmRank: null,
            bgeRank: 1,
        },
    ];

    it('contains all three section headers', () => {
        const md = renderMarkdown(comparisons, specs);
        expect(md).toContain('## Per-query comparison');
        expect(md).toContain('## Per-category hit-rate');
        expect(md).toContain('## Overall summary');
    });

    it('emits correct hit/miss per query row', () => {
        const md = renderMarkdown(comparisons, specs);
        expect(md).toContain('| Q1 |');
        expect(md).toContain('HIT');
        expect(md).toContain('MISS');
    });

    it('emits MISS->HIT change for Q2', () => {
        const md = renderMarkdown(comparisons, specs);
        expect(md).toContain('MISS->HIT');
    });

    it('emits MISS<-HIT change for Q1', () => {
        const md = renderMarkdown(comparisons, specs);
        expect(md).toContain('MISS<-HIT');
    });

    it('shows correct per-category hit-rates', () => {
        const md = renderMarkdown(comparisons, specs);
        // A_find: MiniLM 1/1 (100%), BGE 0/1 (0%), delta -100pp
        expect(md).toContain('| A_find | 1/1 | 0/1 | 1 | 100% | 0% | -100pp |');
        // D_docs: MiniLM 0/1 (0%), BGE 1/1 (100%), delta +100pp
        expect(md).toContain('| D_docs | 0/1 | 1/1 | 1 | 0% | 100% | +100pp |');
    });

    it('shows correct overall summary (1/2 each, 50%/50%, +0pp)', () => {
        const md = renderMarkdown(comparisons, specs);
        expect(md).toContain('| Total queries | 2 | 2 | — |');
        expect(md).toContain('| Total hits | 1 | 1 | +0 |');
        expect(md).toContain('| Hit rate | 50% | 50% | +0pp |');
    });

    it('emits score delta correctly for Q1 (+0.050)', () => {
        const md = renderMarkdown(comparisons, specs);
        expect(md).toContain('+0.050');
    });

    it('shows n/a for null rank (BGE rank on Q1)', () => {
        const md = renderMarkdown(comparisons, specs);
        // Q1 BGE rank is null → n/a
        const q1Line = md.split('\n').find((l) => l.startsWith('| Q1 |'));
        expect(q1Line).toBeDefined();
        expect(q1Line).toContain('n/a');
    });

    it('exact sentinel: full markdown output matches byte-for-byte (AC2.6)', () => {
        const md = renderMarkdown(comparisons, specs);

        // Build the expected string from the same logic, but expressed as a
        // literal so any change to renderMarkdown fails this test.
        const expected =
            '## Per-query comparison\n' +
            '\n' +
            '| ID | Category | Query | MiniLM hit | BGE-M3 hit | Change | ' +
            'Score@1 MiniLM | Score@1 BGE-M3 | Score delta | Rank MiniLM | Rank BGE-M3 | Rank delta |\n' +
            '|----|----------|-------|-----------|-----------|--------|' +
            '---------------|---------------|-------------|------------|------------|------------|\n' +
            '| Q1 | A_find | where is the semantic builder | HIT | MISS | MISS<-HIT | 0.550 | 0.600 | +0.050 | 1 | n/a | -1 |\n' +
            '| Q2 | D_docs | what does strict mode do | MISS | HIT | MISS->HIT | 0.300 | 0.500 | +0.200 | n/a | 1 | +1 |\n' +
            '\n' +
            '## Per-category hit-rate\n' +
            '\n' +
            '| Category | MiniLM hits | BGE-M3 hits | Total | MiniLM % | BGE-M3 % | Delta |\n' +
            '|----------|------------|------------|-------|----------|----------|-------|\n' +
            '| A_find | 1/1 | 0/1 | 1 | 100% | 0% | -100pp |\n' +
            '| D_docs | 0/1 | 1/1 | 1 | 0% | 100% | +100pp |\n' +
            '\n' +
            '## Overall summary\n' +
            '\n' +
            '| Metric | MiniLM | BGE-M3 | Delta |\n' +
            '|--------|--------|--------|-------|\n' +
            '| Total queries | 2 | 2 | — |\n' +
            '| Total hits | 1 | 1 | +0 |\n' +
            '| Hit rate | 50% | 50% | +0pp |\n';

        expect(md).toBe(expected);
    });
});
