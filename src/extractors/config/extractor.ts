/**
 * Config-field extractor — placeholder for Variant 2, Task B6.
 *
 * Detects `configService.get('KEY')`, `configService.getOrThrow('KEY')`,
 * and `process.env.KEY` callsites, emitting config-field nodes with consumer edges.
 *
 * Implementation: B6 (real extractor with callsite detection).
 */

import type { Project } from 'ts-morph';
import type { SourceLoc } from '../../core/types.js';

export interface ConfigFieldSite {
    /** Unique config key (e.g. 'DATABASE_URL'). */
    key: string;
    /** Consuming class name. */
    consumerClass: string;
    /** Method or property where the callsite appears. */
    consumerContext: string;
    location: SourceLoc;
}

export interface ConfigExtractResult {
    fields: ConfigFieldSite[];
    diagnostics: Array<{ file: string; line: number; message: string }>;
}

/**
 * Extract config-field callsites from a TypeScript project.
 *
 * This is a placeholder stub returning empty results. The full implementation
 * will be added in B6.
 */
export function extractConfig(_project: Project): ConfigExtractResult {
    return {
        fields: [],
        diagnostics: [],
    };
}
