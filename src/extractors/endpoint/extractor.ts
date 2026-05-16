/**
 * Endpoint extractor — placeholder for Variant 2, Task B2.
 *
 * Detects `@Controller(...) @Get/@Post/@Patch/@Delete/@Put/@All/@Options/@Head/@Sse`
 * decorators and emits endpoint site records.
 *
 * Implementation: B2 (real extractor with AST detection).
 */

import type { Project } from 'ts-morph';
import type { SourceLoc } from '../../core/types.js';

export interface EndpointSite {
    /** HTTP method (GET, POST, etc.). */
    method: string;
    /** Canonical endpoint pattern (e.g. `/users/:id`). */
    pattern: string;
    /** Controller class name containing the method. */
    controllerClass: string;
    /** Method name on the controller class. */
    methodName: string;
    location: SourceLoc;
    /** Optional meta info: @Version, @HttpCode decorators. */
    meta?: Record<string, unknown>;
}

export interface EndpointExtractResult {
    endpoints: EndpointSite[];
    diagnostics: Array<{ file: string; line: number; message: string }>;
}

/**
 * Extract endpoint sites from a TypeScript project.
 *
 * This is a placeholder stub returning empty results. The full implementation
 * will be added in B2.
 */
export function extractEndpoints(_project: Project): EndpointExtractResult {
    return {
        endpoints: [],
        diagnostics: [],
    };
}
