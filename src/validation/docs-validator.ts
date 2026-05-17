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

import type { DocsDiagnostics, DocsSkipReason, DocsValidationReport, GraphNode } from '../core/types.js';

/**
 * Exhaustive classification of every DocsSkipReason variant.
 * Adding a new DocsSkipReason to types.ts produces a compile error here,
 * forcing the author to decide how it contributes to recall.
 *
 * 'user-excluded' reasons (gitignored) do not count against recall since
 * those files are already absent from filesIncluded.
 */
const SKIP_CLASSIFICATION: Record<DocsSkipReason, 'real' | 'user-excluded'> = {
    'oversized':  'real',
    'non-utf8':   'real',
    'empty':      'real',
    'read-error': 'real',
    'gitignored': 'user-excluded',
};

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
        if (SKIP_CLASSIFICATION[s.reason] === 'real') realSkipped += 1;
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
