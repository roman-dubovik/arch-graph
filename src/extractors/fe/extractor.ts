import type { Project } from 'ts-morph';
import type { ArchGraphConfig } from '../../core/config.js';

/**
 * Frontend (React) AST extractor.
 *
 * Implemented in A2: detects React components, hooks, pages, and imports
 * from .tsx/.jsx sources using ts-morph and JSX/TSX AST analysis.
 *
 * For A1, returns empty results as placeholder to satisfy pipeline integration.
 */
export async function extractFe(cfg: ArchGraphConfig, project: Project): Promise<any> {
    // TODO (A2): Analyze .tsx/.jsx files for:
    //   - React component definitions (@function, @class decorated with JSX)
    //   - Hook calls (useEffect, useState, etc.)
    //   - Route registration (React Router, Next.js etc.)
    //   - Import edges between components
    // For now, return shape compatible with mapper/validator.
    return {
        components: [],
        hooks: [],
        routes: [],
        imports: [],
    };
}
