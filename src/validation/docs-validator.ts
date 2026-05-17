/**
 * Docs-domain file-coverage validator.
 *
 * Invariant: every file in the resolved-include set (counts.filesIncluded)
 * must be EITHER processed (produced ≥1 doc-section node) OR present in
 * filesSkipped with a real reason. Gitignored files are already absent from
 * filesIncluded (extractDocs never adds them to resolvedSet), so the
 * denominator is simply filesIncluded — no user-excluded subtraction needed.
 *
 * recall = (processedFiles.size + realSkipped) / filesIncluded
 */

import type { DocsDiagnostics, DocsValidationReport, GraphNode } from '../core/types.js';

const REAL_SKIP_REASONS = new Set(['oversized', 'non-utf8', 'empty', 'read-error']);

export function validateDocs(
    diagnostics: DocsDiagnostics,
    allNodes: GraphNode[],
): DocsValidationReport {
    const filesIncluded = diagnostics.counts.filesIncluded;
    const docNodes = allNodes.filter(n => n.kind === 'doc-section');
    const processedFiles = new Set(
        docNodes.map(n => n.path).filter((p): p is string => p !== undefined),
    );

    let realSkipped = 0;
    let userExcluded = 0;
    for (const s of diagnostics.filesSkipped) {
        if (REAL_SKIP_REASONS.has(s.reason)) realSkipped += 1;
        else userExcluded += 1;
    }

    // gitignored files are already absent from filesIncluded — no subtraction needed.
    const denominator = filesIncluded;
    const numerator = processedFiles.size + realSkipped;
    const recall = denominator === 0 ? 1 : numerator / denominator;
    const meetsFloor = denominator === 0 || recall >= 1;

    return {
        summary: {
            filesIncluded,
            filesProcessed: processedFiles.size,
            filesSkippedWithReason: realSkipped,
            recall,
            meetsFloor,
        },
    };
}
