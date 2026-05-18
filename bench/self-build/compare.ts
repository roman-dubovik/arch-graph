/**
 * bench/self-build/compare.ts
 *
 * Usage:
 *   pnpm tsx bench/self-build/compare.ts <minilm-results.json> <bge-m3-results.json>
 *
 * Reads two result JSON files produced by bench/self-build/run.ts (each an
 * array of BenchResultRow), loads queries-self-build.json from the same
 * directory, and emits a markdown side-by-side comparison to stdout.
 *
 * Sections:
 *   1. Per-query: score@1, rank of expected node, hit/miss for each model
 *   2. Per-category hit-rate change
 *   3. Overall summary
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BenchResultRow {
    queryId: string;
    nodeId: string;
    kind: string;
    label: string;
    score: number;
    path?: string;
    snippet: string;
}

export interface QuerySpec {
    id: string;
    query: string;
    category: string;
    expectedKindIn: string[];
    expectedLabelHas: string[];
    minScore: number;
}

export interface QueryComparison {
    queryId: string;
    query: string;
    category: string;
    minilmHit: boolean;
    bgeHit: boolean;
    minilmScore1: number | null;
    bgeScore1: number | null;
    minilmRank: number | null;
    bgeRank: number | null;
}

// ---------------------------------------------------------------------------
// Hit-check (mirrors README scoring logic)
// ---------------------------------------------------------------------------

export function isHit(
    rows: BenchResultRow[],
    spec: QuerySpec,
): boolean {
    return rows.some(
        (r) =>
            r.score >= spec.minScore &&
            spec.expectedKindIn.includes(r.kind) &&
            spec.expectedLabelHas.some((needle) =>
                r.label.toLowerCase().includes(needle.toLowerCase()),
            ),
    );
}

export function rankOfFirstExpected(
    rows: BenchResultRow[],
    spec: QuerySpec,
): number | null {
    const sorted = [...rows].sort((a, b) => b.score - a.score);
    const idx = sorted.findIndex(
        (r) =>
            spec.expectedKindIn.includes(r.kind) &&
            spec.expectedLabelHas.some((needle) =>
                r.label.toLowerCase().includes(needle.toLowerCase()),
            ),
    );
    return idx === -1 ? null : idx + 1;
}

export function score1(rows: BenchResultRow[]): number | null {
    if (rows.length === 0) return null;
    const sorted = [...rows].sort((a, b) => b.score - a.score);
    return sorted[0]!.score;
}

// ---------------------------------------------------------------------------
// Core comparison logic (exported for tests)
// ---------------------------------------------------------------------------

export function buildComparison(
    minilmRows: BenchResultRow[],
    bgeRows: BenchResultRow[],
    specs: QuerySpec[],
): QueryComparison[] {
    const groupBy = (rows: BenchResultRow[]) => {
        const m = new Map<string, BenchResultRow[]>();
        for (const r of rows) {
            if (!m.has(r.queryId)) m.set(r.queryId, []);
            m.get(r.queryId)!.push(r);
        }
        return m;
    };

    const minilmByQuery = groupBy(minilmRows);
    const bgeByQuery = groupBy(bgeRows);

    return specs.map((spec) => {
        const ml = minilmByQuery.get(spec.id) ?? [];
        const bg = bgeByQuery.get(spec.id) ?? [];
        return {
            queryId: spec.id,
            query: spec.query,
            category: spec.category,
            minilmHit: isHit(ml, spec),
            bgeHit: isHit(bg, spec),
            minilmScore1: score1(ml),
            bgeScore1: score1(bg),
            minilmRank: rankOfFirstExpected(ml, spec),
            bgeRank: rankOfFirstExpected(bg, spec),
        };
    });
}

// ---------------------------------------------------------------------------
// Markdown renderer (exported for tests)
// ---------------------------------------------------------------------------

function fmt(n: number | null, decimals = 3): string {
    return n === null ? 'n/a' : n.toFixed(decimals);
}

function delta(a: number | null, b: number | null): string {
    if (a === null || b === null) return 'n/a';
    const d = b - a;
    return (d >= 0 ? '+' : '') + d.toFixed(3);
}

function rankDelta(a: number | null, b: number | null): string {
    if (a === null && b === null) return 'n/a';
    if (a === null) return `+${b}`;
    if (b === null) return `-${a}`;
    const d = b - a;
    return (d <= 0 ? '' : '+') + String(d);
}

function hitChange(ml: boolean, bge: boolean): string {
    if (ml === bge) return ml ? 'both HIT' : 'both MISS';
    return ml ? 'MISS<-HIT' : 'MISS->HIT';
}

export function renderMarkdown(comparisons: QueryComparison[], specs: QuerySpec[]): string {
    const lines: string[] = [];

    // ── Section 1: Per-query ─────────────────────────────────────────────────
    lines.push('## Per-query comparison');
    lines.push('');
    lines.push(
        '| ID | Category | Query | MiniLM hit | BGE-M3 hit | Change | ' +
        'Score@1 MiniLM | Score@1 BGE-M3 | Score delta | Rank MiniLM | Rank BGE-M3 | Rank delta |',
    );
    lines.push(
        '|----|----------|-------|-----------|-----------|--------|' +
        '---------------|---------------|-------------|------------|------------|------------|',
    );

    for (const c of comparisons) {
        const query = c.query.length > 40 ? c.query.slice(0, 37) + '...' : c.query;
        lines.push(
            `| ${c.queryId} | ${c.category} | ${query} | ` +
            `${c.minilmHit ? 'HIT' : 'MISS'} | ${c.bgeHit ? 'HIT' : 'MISS'} | ` +
            `${hitChange(c.minilmHit, c.bgeHit)} | ` +
            `${fmt(c.minilmScore1)} | ${fmt(c.bgeScore1)} | ${delta(c.minilmScore1, c.bgeScore1)} | ` +
            `${c.minilmRank ?? 'n/a'} | ${c.bgeRank ?? 'n/a'} | ${rankDelta(c.minilmRank, c.bgeRank)} |`,
        );
    }

    lines.push('');

    // ── Section 2: Per-category hit-rate ─────────────────────────────────────
    lines.push('## Per-category hit-rate');
    lines.push('');
    lines.push('| Category | MiniLM hits | BGE-M3 hits | Total | MiniLM % | BGE-M3 % | Delta |');
    lines.push('|----------|------------|------------|-------|----------|----------|-------|');

    const categories = [...new Set(comparisons.map((c) => c.category))].sort();
    for (const cat of categories) {
        const catComps = comparisons.filter((c) => c.category === cat);
        const total = catComps.length;
        const mlHits = catComps.filter((c) => c.minilmHit).length;
        const bgeHits = catComps.filter((c) => c.bgeHit).length;
        const mlPct = ((mlHits / total) * 100).toFixed(0);
        const bgePct = ((bgeHits / total) * 100).toFixed(0);
        const deltaPct = bgeHits / total * 100 - mlHits / total * 100;
        const deltaPctStr = (deltaPct >= 0 ? '+' : '') + deltaPct.toFixed(0) + 'pp';
        lines.push(
            `| ${cat} | ${mlHits}/${total} | ${bgeHits}/${total} | ${total} | ${mlPct}% | ${bgePct}% | ${deltaPctStr} |`,
        );
    }

    lines.push('');

    // ── Section 3: Overall summary ────────────────────────────────────────────
    lines.push('## Overall summary');
    lines.push('');

    const totalQueries = comparisons.length;
    const mlTotalHits = comparisons.filter((c) => c.minilmHit).length;
    const bgeTotalHits = comparisons.filter((c) => c.bgeHit).length;
    const mlRate = ((mlTotalHits / totalQueries) * 100).toFixed(0);
    const bgeRate = ((bgeTotalHits / totalQueries) * 100).toFixed(0);
    const overallDelta = bgeTotalHits / totalQueries * 100 - mlTotalHits / totalQueries * 100;
    const overallDeltaStr = (overallDelta >= 0 ? '+' : '') + overallDelta.toFixed(0) + 'pp';

    lines.push(`| Metric | MiniLM | BGE-M3 | Delta |`);
    lines.push(`|--------|--------|--------|-------|`);
    lines.push(`| Total queries | ${totalQueries} | ${totalQueries} | — |`);
    lines.push(`| Total hits | ${mlTotalHits} | ${bgeTotalHits} | ${bgeTotalHits - mlTotalHits >= 0 ? '+' : ''}${bgeTotalHits - mlTotalHits} |`);
    lines.push(`| Hit rate | ${mlRate}% | ${bgeRate}% | ${overallDeltaStr} |`);
    lines.push('');

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        process.stderr.write(
            'Usage: pnpm tsx bench/self-build/compare.ts <minilm-results.json> <bge-m3-results.json>\n',
        );
        process.exit(1);
    }

    const [minilmPath, bgePath] = args as [string, string];

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const queriesPath = join(__dirname, 'queries-self-build.json');

    const [minilmRaw, bgeRaw, queriesRaw] = await Promise.all([
        readFile(minilmPath, 'utf8'),
        readFile(bgePath, 'utf8'),
        readFile(queriesPath, 'utf8'),
    ]);

    const minilmRows: BenchResultRow[] = JSON.parse(minilmRaw);
    const bgeRows: BenchResultRow[] = JSON.parse(bgeRaw);
    const specs: QuerySpec[] = JSON.parse(queriesRaw);

    const comparisons = buildComparison(minilmRows, bgeRows, specs);
    const md = renderMarkdown(comparisons, specs);

    process.stdout.write(md);
}

// Guard so that importing this module in tests does not trigger the CLI.
const isMain = process.argv[1]?.endsWith('compare.ts') ||
    process.argv[1]?.endsWith('compare.js');
if (isMain) {
    main().catch((err) => {
        process.stderr.write(`compare: fatal error: ${(err as Error).message}\n`);
        process.exit(1);
    });
}
