/**
 * Snippet-recall validator — A11.
 *
 * Reads a built semantic sidecar (embeddings.jsonl) and asserts minimum
 * non-empty snippet coverage per node kind:
 *   - ≥ 85% across ALL kinds that are expected to have snippets
 *   - ≥ 95% for the "high-fidelity" kinds:
 *       provider, endpoint, db-entity-field, config-field
 *
 * Node kinds that legitimately have no source file (nats-subject, db-table,
 * queue, external, service-only nodes) are excluded from the denominator
 * — an empty snippet for them is correct, not a failure.
 *
 * Usage (CLI or test harness):
 *   const result = await validateSnippetRecall('/path/to/arch-graph-out/semantic');
 *   if (result.kind === 'corrupt' || result.kind === 'empty') throw new Error(...);
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { NodeKind } from '../core/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Floor for all source-backed kinds (85%). */
export const RECALL_FLOOR_DEFAULT = 0.85;

/** Floor for high-fidelity kinds that have a single unambiguous declaration (95%). */
export const RECALL_FLOOR_HIGH_FIDELITY = 0.95;

/** Node kinds for which the validator applies the high-fidelity floor. */
export const HIGH_FIDELITY_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
    'provider',
    'endpoint',
    'db-entity-field',
    'config-field',
]);

/**
 * Node kinds that legitimately have no source file and are EXCLUDED from
 * the recall denominator. An empty snippet for these is correct behaviour.
 */
export const KINDS_WITHOUT_SOURCE: ReadonlySet<NodeKind> = new Set<NodeKind>([
    'nats-subject',
    'db-table',
    'queue',
    'external',
    'lib',      // virtual: no source file — monorepo lib marker
    'service',  // virtual: monorepo service marker
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KindStats {
    kind: NodeKind;
    total: number;
    filled: number;
    fillRate: number;
    floor: number;
    passed: boolean;
}

/**
 * Counts of virtual nodes (no source expected) per kind.
 * These are excluded from the recall denominator; reported separately
 * so the output is more honest, not less informative (CT-AC7).
 */
export interface VirtualNodeCounts {
    lib: number;
    service: number;
    moduleExternal: number;  // module nodes without a path field
    natsSubject: number;
    dbTable: number;
    queue: number;
    external: number;
}

/**
 * Aggregate fill-rate statistics for all source-backed node kinds.
 */
export interface SnippetStats {
    /** Total source-backed nodes examined (excluding KINDS_WITHOUT_SOURCE). */
    totalNodes: number;
    /** Total nodes with non-empty snippets. */
    totalFilled: number;
    /** Aggregate fill rate: totalFilled / totalNodes. */
    aggregateFillRate: number;
    /** Per-kind breakdown, sorted by fill rate ascending (worst first). */
    byKind: KindStats[];
    /**
     * Counts of virtual nodes that were excluded from the recall denominator.
     * Reported for transparency (CT-AC7); not used in pass/fail evaluation.
     */
    virtualNodes: VirtualNodeCounts;
}

/**
 * Discriminated-union result from `validateSnippetRecall`.
 *
 * Precedence is structurally enforced by the ordering in which the validator
 * returns each variant:
 *   1. `corrupt`     — malformed-line ratio > 5%; always fatal.
 *   2. `empty`       — no source-backed nodes found (index not yet built or
 *                      all records are KINDS_WITHOUT_SOURCE).
 *   3. `below-floor` — at least one kind is below its recall floor.
 *   4. `ok`          — all kinds meet their floor.
 *
 * Consumers should switch on `result.kind`; the precedence is intentional
 * and matches CI severity: corrupt > empty > below-floor > ok.
 */
export type SnippetRecallResult =
    | {
          kind: 'ok';
          stats: SnippetStats;
      }
    | {
          kind: 'below-floor';
          /** Kinds that failed their recall floor (at least one entry guaranteed). */
          failures: [KindStats, ...KindStats[]];
          stats: SnippetStats;
      }
    | {
          kind: 'corrupt';
          /**
           * Number of lines that could not be parsed as valid JSON records.
           * Use `malformedLines / totalLines` to recompute the ratio.
           */
          malformedLines: number;
          /** Total non-empty lines in the JSONL file (denominator). */
          totalLines: number;
      }
    | { kind: 'empty' };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Assert a non-empty array at runtime and narrow its type to a non-empty tuple.
 * The check is technically redundant at every call site (callers already guard
 * for a non-empty condition), but it makes the invariant structural and reusable.
 */
function toNonEmpty<T>(arr: T[]): [T, ...T[]] {
    if (arr.length === 0) throw new Error('invariant: array must be non-empty');
    return arr as [T, ...T[]];
}

/**
 * Return true when a node is expected to have a non-empty snippet and should
 * therefore be counted in the recall denominator.
 *
 * - Any kind in KINDS_WITHOUT_SOURCE → false (virtual, no source file).
 * - `module` nodes without a `path` field → false (external module from
 *   node_modules; DiModuleIndex skips path emission for them by design).
 * - All other nodes → true.
 */
export function isExpectedToHaveSnippet(node: { kind: NodeKind; path?: string }): boolean {
    if (KINDS_WITHOUT_SOURCE.has(node.kind)) return false;
    // External modules have no path; internal modules do.
    // Empty string is treated as no-path (virtual), same as undefined.
    if (node.kind === 'module' && (node.path === undefined || node.path === '')) return false;
    return true;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Zero-value for VirtualNodeCounts — convenience for callers. */
export function makeEmptyVirtualNodeCounts(): VirtualNodeCounts {
    return {
        lib: 0,
        service: 0,
        moduleExternal: 0,
        natsSubject: 0,
        dbTable: 0,
        queue: 0,
        external: 0,
    };
}

/**
 * Build a SnippetStats object, computing aggregateFillRate from totals.
 * Centralises the zero-guard for aggregateFillRate — inline construction
 * would compute 0/0 = NaN when totalNodes is 0.
 */
export function makeSnippetStats(
    totalNodes: number,
    totalFilled: number,
    byKind: KindStats[],
    virtualNodes?: VirtualNodeCounts,
): SnippetStats {
    return {
        totalNodes,
        totalFilled,
        aggregateFillRate: totalNodes > 0 ? totalFilled / totalNodes : 0,
        byKind,
        virtualNodes: virtualNodes ?? makeEmptyVirtualNodeCounts(),
    };
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validate snippet recall from a built semantic index directory.
 *
 * @param semanticDir  Absolute path to the `semantic/` directory containing
 *                     `embeddings.jsonl`.
 */
export async function validateSnippetRecall(semanticDir: string): Promise<SnippetRecallResult> {
    const embeddingsPath = join(semanticDir, 'embeddings.jsonl');

    const countsByKind = new Map<NodeKind, { total: number; filled: number }>();
    const virtualCounts = makeEmptyVirtualNodeCounts();
    let malformedLines = 0;
    let totalLines = 0;

    // Stream the JSONL file line by line to avoid loading the whole index into RAM.
    await new Promise<void>((resolve, reject) => {
        const rl = createInterface({
            input: createReadStream(embeddingsPath, { encoding: 'utf8' }),
            crlfDelay: Infinity,
        });

        rl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            totalLines++;
            try {
                const record = JSON.parse(trimmed) as {
                    kind: NodeKind;
                    snippet: string;
                    path?: string;
                };

                // Non-string path (e.g. path: 42 or path: null) is malformed — skip.
                // Empty string is valid (treated as virtual by isExpectedToHaveSnippet).
                if (record.path !== undefined && typeof record.path !== 'string') {
                    malformedLines++;
                    return;
                }

                const kind = record.kind;

                // Check whether the node is expected to have a snippet.
                if (!isExpectedToHaveSnippet(record)) {
                    // Count into the virtual-nodes diagnostic bucket (CT-AC7).
                    if (kind === 'lib') virtualCounts.lib++;
                    else if (kind === 'service') virtualCounts.service++;
                    else if (kind === 'module') virtualCounts.moduleExternal++;
                    else if (kind === 'nats-subject') virtualCounts.natsSubject++;
                    else if (kind === 'db-table') virtualCounts.dbTable++;
                    else if (kind === 'queue') virtualCounts.queue++;
                    else if (kind === 'external') virtualCounts.external++;
                    else {
                        // Exhaustiveness check: if a new kind is added to KINDS_WITHOUT_SOURCE
                        // (or to the module-without-path branch) without updating this dispatch,
                        // it would silently drop from diagnostics. Surface immediately.
                        throw new Error(
                            `snippet-recall-validator: unrecognized virtual node kind '${kind}' — ` +
                            `update the dispatch table in isExpectedToHaveSnippet caller.`,
                        );
                    }
                    return;
                }

                const entry = countsByKind.get(kind) ?? { total: 0, filled: 0 };
                entry.total++;
                if (record.snippet && record.snippet.length > 0) {
                    entry.filled++;
                }
                countsByKind.set(kind, entry);
            } catch (e) {
                if (e instanceof SyntaxError) {
                    // Malformed line — track count for corruption detection.
                    malformedLines++;
                } else {
                    throw e;
                }
            }
        });

        rl.on('close', resolve);
        rl.on('error', reject);
    });

    // Corruption check: if more than 5% of lines are malformed, the index is suspect.
    // Evaluated BEFORE the empty-index check so a fully-corrupt index (totalNodes=0
    // because all lines failed to parse) is correctly flagged as corrupt rather than
    // just "empty".
    const corruptRatio = totalLines > 0 ? malformedLines / totalLines : 0;
    if (corruptRatio > 0.05) {
        return { kind: 'corrupt', malformedLines, totalLines };
    }

    const byKind: KindStats[] = [];
    let totalNodes = 0;
    let totalFilled = 0;

    for (const [kind, { total, filled }] of countsByKind) {
        if (total === 0) continue;
        const fillRate = filled / total;
        const floor = HIGH_FIDELITY_KINDS.has(kind)
            ? RECALL_FLOOR_HIGH_FIDELITY
            : RECALL_FLOOR_DEFAULT;
        const passed = fillRate >= floor;

        byKind.push({ kind, total, filled, fillRate, floor, passed });
        totalNodes += total;
        totalFilled += filled;
    }

    // Sort by fill rate ascending (worst first) for readable output.
    byKind.sort((a, b) => a.fillRate - b.fillRate);

    // Empty index (no source-backed nodes at all) is a failure, not a vacuous pass.
    if (totalNodes === 0) {
        return { kind: 'empty' };
    }

    const stats = makeSnippetStats(totalNodes, totalFilled, byKind, virtualCounts);

    const failures = byKind.filter((k) => !k.passed);
    if (failures.length > 0) {
        return { kind: 'below-floor', failures: toNonEmpty(failures), stats };
    }

    return { kind: 'ok', stats };
}

/**
 * Format a SnippetRecallResult as a human-readable string (for CLI / test output).
 */
export function formatRecallResult(result: SnippetRecallResult): string {
    if (result.kind === 'corrupt') {
        return (
            `Snippet recall: index appears corrupt — ` +
            `${result.malformedLines} of ${result.totalLines} lines malformed ` +
            `(${((result.malformedLines / result.totalLines) * 100).toFixed(1)}% > 5% threshold)`
        );
    }
    if (result.kind === 'empty') {
        return 'Snippet recall: index is empty (no source-backed nodes found)';
    }

    const { stats } = result;
    const lines: string[] = [
        `Snippet recall: ${(stats.aggregateFillRate * 100).toFixed(1)}% (${stats.totalFilled}/${stats.totalNodes} nodes)`,
        '',
        'Per-kind breakdown:',
        'KIND               TOTAL   FILLED   RATE    FLOOR   STATUS',
        '-'.repeat(65),
    ];
    for (const k of stats.byKind) {
        const pct = (k.fillRate * 100).toFixed(1).padStart(5);
        const floor = (k.floor * 100).toFixed(0).padStart(3);
        const status = k.passed ? 'PASS' : 'FAIL';
        lines.push(
            `${k.kind.padEnd(20)} ${String(k.total).padStart(5)}   ${String(k.filled).padStart(6)}  ${pct}%  ≥${floor}%  ${status}`,
        );
    }
    if (result.kind === 'below-floor') {
        lines.push('');
        lines.push(`FAILED kinds: ${result.failures.map((f) => f.kind).join(', ')}`);
    }

    // CT-AC7: virtual nodes diagnostic — counts of nodes excluded from denominator.
    const vn = stats.virtualNodes;
    const virtualEntries: string[] = [];
    if (vn.lib > 0) virtualEntries.push(`lib: ${vn.lib}`);
    if (vn.service > 0) virtualEntries.push(`service: ${vn.service}`);
    if (vn.moduleExternal > 0) virtualEntries.push(`module (external): ${vn.moduleExternal}`);
    if (vn.natsSubject > 0) virtualEntries.push(`nats-subject: ${vn.natsSubject}`);
    if (vn.dbTable > 0) virtualEntries.push(`db-table: ${vn.dbTable}`);
    if (vn.queue > 0) virtualEntries.push(`queue: ${vn.queue}`);
    if (vn.external > 0) virtualEntries.push(`external: ${vn.external}`);
    if (virtualEntries.length > 0) {
        lines.push('');
        lines.push(`Virtual nodes (no source expected, excluded from denominator): ${virtualEntries.join(', ')}`);
    }

    return lines.join('\n');
}
