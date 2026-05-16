/**
 * Scoped-marker extractor — stub for Variant 2, Task B8.
 *
 * Placeholder for `@Scope(REQUEST)` and `@Inject(REQUEST)` detection.
 *
 * **Important**: This extractor remains a stub intentionally. Per the design doc
 * (§ "Real-corpus signal"), scoped-marker patterns are NOT found in platform,
 * insyra, or beribuy 2.0. The NodeKind is added to the enum for future-proofing,
 * but the extractor returns empty results in v1.
 *
 * Activate when corpus evidence indicates real usage.
 * Reference: docs/plans/2026-05-16-fe-l1-and-var2-design.md § "Real-corpus signal"
 */

import type { Project } from 'ts-morph';
import type { SourceLoc } from '../../core/types.js';

export interface ScopedMarkerSite {
    /** Scope type (REQUEST, TRANSIENT, etc.). */
    scope: string;
    /** Class bearing the @Scope or @Inject(REQUEST) decorator. */
    className: string;
    location: SourceLoc;
}

export interface ScopedExtractResult {
    markers: ScopedMarkerSite[];
    diagnostics: Array<{ file: string; line: number; message: string }>;
}

/**
 * Extract scoped-marker sites from a TypeScript project.
 *
 * Stub implementation: returns empty array. This is intentional per design
 * (no corpus signal for scoped markers in v1). See comment block above.
 */
export function extractScoped(_project: Project): ScopedExtractResult {
    return {
        markers: [],
        diagnostics: [
            {
                file: '<stub>',
                line: 0,
                message: 'stub-extractor, awaiting corpus signal — see design doc § "Real-corpus signal"',
            },
        ],
    };
}
