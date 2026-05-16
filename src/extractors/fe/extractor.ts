/**
 * Frontend (React/Next.js) AST extractor.
 *
 * Walks all .tsx/.jsx source files in the project and detects:
 *   - React components (arrow, function, class, memo, forwardRef)
 *   - Custom hooks (use[A-Z]* with another hook call in body)
 *   - Next.js pages (Pages Router + App Router)
 *   - Routes derived from file paths
 *   - JSX render references (fe-renders edges)
 *   - Import references between FE files (fe-imports edges)
 */
import { resolve } from 'node:path';

import type { Project, SourceFile } from 'ts-morph';

import type { ArchGraphConfig } from '../../core/config.js';
import { isExcludedSourceFile } from '../shared.js';
import { extractReactPatterns } from './react-patterns.js';
import { deriveRoute, extractPageFromFile } from './router-patterns.js';
import type {
    FeComponent,
    FeExtractResult,
    FeHook,
    FeImportRef,
    FePage,
    FeRender,
    FeRoute,
} from './types.js';

// Extension filter — only scan JSX/TSX files for FE patterns.
const FE_EXTENSIONS = new Set(['.tsx', '.jsx']);

function isFESourceFile(sf: SourceFile): boolean {
    const p = sf.getFilePath();
    // Exclude test/spec files even for .tsx/.jsx
    if (p.endsWith('.spec.tsx') || p.endsWith('.test.tsx')) return false;
    if (p.endsWith('.spec.jsx') || p.endsWith('.test.jsx')) return false;
    const ext = p.slice(p.lastIndexOf('.'));
    return FE_EXTENSIONS.has(ext) && !isExcludedSourceFile(sf);
}

/**
 * Extract FE components, hooks, pages, routes, renders, and imports
 * from all .tsx/.jsx files in the ts-morph project.
 */
export async function extractFe(cfg: ArchGraphConfig, project: Project): Promise<FeExtractResult> {
    const root = resolve(cfg.root);

    const allComponents: FeComponent[] = [];
    const allHooks: FeHook[] = [];
    const allPages: FePage[] = [];
    const allRenders: FeRender[] = [];
    const allImports: FeImportRef[] = [];
    const routeMap = new Map<string, FeRoute>(); // pattern → FeRoute (dedup)

    for (const sf of project.getSourceFiles()) {
        if (!isFESourceFile(sf)) continue;

        const file = sf.getFilePath();

        // --- React patterns (components, hooks, renders) ---
        const { components, hooks, renders } = extractReactPatterns(sf);
        allComponents.push(...components);
        allHooks.push(...hooks);
        allRenders.push(...renders);

        // --- Page / route detection ---
        const pageResult = extractPageFromFile(sf, root);
        if (pageResult) {
            allPages.push(pageResult);
            if (!routeMap.has(pageResult.route)) {
                routeMap.set(pageResult.route, {
                    pattern: pageResult.route,
                    pageFile: file,
                });
            }
        }

        // --- Import references (for fe-imports edges) ---
        for (const importDecl of sf.getImportDeclarations()) {
            const specifier = importDecl.getModuleSpecifierValue();
            // Only local / aliased imports (starts with . or @)
            if (!specifier.startsWith('.') && !specifier.startsWith('@')) continue;

            let resolvedFile: string | null = null;
            try {
                const resolved = importDecl.getModuleSpecifierSourceFile();
                resolvedFile = resolved?.getFilePath() ?? null;
            } catch {
                // resolution failure — leave as null
            }

            // Collect all named + default imports
            const namedImports = importDecl.getNamedImports().map((n) => n.getName());
            const defaultImport = importDecl.getDefaultImport()?.getText();
            const namespaceImport = importDecl.getNamespaceImport()?.getText();

            const names: string[] = [
                ...(defaultImport ? [defaultImport] : []),
                ...(namespaceImport ? [namespaceImport] : []),
                ...namedImports,
            ];

            const { line, column } = sf.getLineAndColumnAtPos(importDecl.getStart());

            for (const importedName of names) {
                allImports.push({
                    sourceFile: file,
                    resolvedFile,
                    importedName,
                    specifier,
                    location: { file, line, column },
                });
            }
        }
    }

    return {
        components: allComponents,
        hooks: allHooks,
        pages: allPages,
        routes: [...routeMap.values()],
        renders: allRenders,
        imports: allImports,
    };
}
