/**
 * DB entity field validator — Variant 2, Task B10 (Fix 3).
 *
 * Ground-truth regex detection of TypeORM column decorators:
 *   @Column, @PrimaryColumn, @PrimaryGeneratedColumn,
 *   @CreateDateColumn, @UpdateDateColumn, @DeleteDateColumn
 *
 * Target recall: ≥ 95%.
 */

import type { ArchGraphConfig } from '../core/config.js';
import type { DbEntityFieldGroundTruthEntry, DbEntityFieldsValidationResult } from '../core/types.js';
import { buildLineStarts, offsetToLineCol } from './line-index.js';
import { iterateSourceFiles } from './scan.js';
import { stripComments } from './strip-comments.js';

// Re-export the canonical type so existing importers of this module keep working.
export type { DbEntityFieldGroundTruthEntry } from '../core/types.js';

/**
 * Regex matching all supported TypeORM column decorators.
 * Captures the decorator name in group 1.
 * Uses word boundary \b to avoid matching inside larger identifiers.
 */
const COLUMN_RE =
    /@(Column|PrimaryColumn|PrimaryGeneratedColumn|CreateDateColumn|UpdateDateColumn|DeleteDateColumn)\s*[(\s]/g;

/** Quick pre-check strings to skip files that definitely have none. */
const QUICK_CHECK_STRINGS = [
    '@Column',
    '@PrimaryColumn',
    '@PrimaryGeneratedColumn',
    '@CreateDateColumn',
    '@UpdateDateColumn',
    '@DeleteDateColumn',
];

/**
 * Enumerate ground-truth db-entity-field decorator occurrences by regex.
 */
export async function enumerateDbEntityFieldsGroundTruth(
    cfg: ArchGraphConfig,
): Promise<DbEntityFieldGroundTruthEntry[]> {
    const out: DbEntityFieldGroundTruthEntry[] = [];

    for await (const { file, content } of iterateSourceFiles(cfg, 'db-entity-field GT')) {
        // Quick pre-check: skip files with none of the decorator strings
        if (!QUICK_CHECK_STRINGS.some((s) => content.includes(s))) continue;

        const stripped = stripComments(content);
        const lineStarts = buildLineStarts(stripped);

        for (const m of stripped.matchAll(COLUMN_RE)) {
            const offset = m.index!;
            const { line } = offsetToLineCol(offset, lineStarts);
            out.push({
                file,
                line,
                matchedText: m[0].trim(),
                decorator: m[1]!,
            });
        }
    }

    return out;
}

/**
 * Build a db-entity-field validation report comparing extracted count to ground-truth.
 * Recall floor is 95%.
 */
export function buildDbEntityFieldsReport(
    extractedCount: number,
    groundTruth: DbEntityFieldGroundTruthEntry[],
): DbEntityFieldsValidationResult {
    const groundTruthCount = groundTruth.length;

    const recall =
        groundTruthCount > 0 ? Math.min(extractedCount / groundTruthCount, 1) : null;

    const meetsFloor = recall === null || recall >= 0.95;

    return {
        groundTruth,
        groundTruthCount,
        recall,
        meetsFloor,
    };
}

/**
 * Convenience wrapper: enumerate ground truth then compute the report.
 * Used by the build pipeline.
 */
export async function validateDbEntityFields(
    cfg: ArchGraphConfig,
    extractedCount: number,
): Promise<DbEntityFieldsValidationResult> {
    const groundTruth = await enumerateDbEntityFieldsGroundTruth(cfg);
    return buildDbEntityFieldsReport(extractedCount, groundTruth);
}
