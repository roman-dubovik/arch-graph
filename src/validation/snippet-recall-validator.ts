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
 *   if (!result.passed) throw new Error(...);
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

export interface SnippetRecallResult {
    /** True iff every kind that has ≥ 1 node meets its floor. */
    passed: boolean;
    /** Per-kind breakdown. */
    byKind: KindStats[];
    /** Total nodes examined (excluding KINDS_WITHOUT_SOURCE). */
    totalNodes: number;
    /** Total nodes with non-empty snippets. */
    totalFilled: number;
    /** Aggregate fill rate across all examined nodes. */
    aggregateFillRate: number;
    /** Kinds that failed their floor (empty if passed === true). */
    failures: KindStats[];
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

    // Stream the JSONL file line by line to avoid loading the whole index into RAM.
    await new Promise<void>((resolve, reject) => {
        const rl = createInterface({
            input: createReadStream(embeddingsPath, { encoding: 'utf8' }),
            crlfDelay: Infinity,
        });

        rl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            try {
                const record = JSON.parse(trimmed) as { kind: NodeKind; snippet: string };
                const kind = record.kind;
                // Skip kinds that legitimately have no source.
                if (KINDS_WITHOUT_SOURCE.has(kind)) return;

                const entry = countsByKind.get(kind) ?? { total: 0, filled: 0 };
                entry.total++;
                if (record.snippet && record.snippet.length > 0) {
                    entry.filled++;
                }
                countsByKind.set(kind, entry);
            } catch {
                // Malformed line — skip silently; the CLI already validates JSONL shape.
            }
        });

        rl.on('close', resolve);
        rl.on('error', reject);
    });

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

    const failures = byKind.filter((k) => !k.passed);
    const passed = failures.length === 0;
    const aggregateFillRate = totalNodes > 0 ? totalFilled / totalNodes : 1;

    return { passed, byKind, totalNodes, totalFilled, aggregateFillRate, failures };
}

/**
 * Format a SnippetRecallResult as a human-readable string (for CLI / test output).
 */
export function formatRecallResult(result: SnippetRecallResult): string {
    const lines: string[] = [
        `Snippet recall: ${(result.aggregateFillRate * 100).toFixed(1)}% (${result.totalFilled}/${result.totalNodes} nodes)`,
        '',
        'Per-kind breakdown:',
        'KIND               TOTAL   FILLED   RATE    FLOOR   STATUS',
        '-'.repeat(65),
    ];
    for (const k of result.byKind) {
        const pct = (k.fillRate * 100).toFixed(1).padStart(5);
        const floor = (k.floor * 100).toFixed(0).padStart(3);
        const status = k.passed ? 'PASS' : 'FAIL';
        lines.push(
            `${k.kind.padEnd(20)} ${String(k.total).padStart(5)}   ${String(k.filled).padStart(6)}  ${pct}%  ≥${floor}%  ${status}`,
        );
    }
    if (!result.passed) {
        lines.push('');
        lines.push(`FAILED kinds: ${result.failures.map((f) => f.kind).join(', ')}`);
    }
    return lines.join('\n');
}
