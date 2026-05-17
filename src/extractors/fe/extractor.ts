/**
 * Frontend (React/Next.js) AST extractor.
 *
 * Walks all .tsx/.jsx/.ts source files in the project and detects:
 *   - React components (arrow, function, class, memo, forwardRef) — .tsx/.jsx only
 *   - Custom hooks (use[A-Z]* with another hook call in body) — .tsx/.jsx/.ts
 *   - Next.js pages (Pages Router + App Router) — .tsx/.jsx only
 *   - Routes derived from file paths — .tsx/.jsx only
 *   - JSX render references (fe-renders edges) — .tsx/.jsx only
 *   - Import references between FE files (fe-imports edges) — .tsx/.jsx only
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
    FeUnresolvedImport,
} from './types.js';

// Extension filter — JSX/TSX for full FE patterns; .ts for hooks only.
const FE_FULL_EXTENSIONS = new Set(['.tsx', '.jsx']);
const FE_HOOK_EXTENSIONS = new Set(['.ts']);

function isFESourceFile(sf: SourceFile): { include: boolean; hooksOnly: boolean } {
    const p = sf.getFilePath();
    // Exclude test/spec/declaration files
    if (
        p.endsWith('.spec.tsx') || p.endsWith('.test.tsx') ||
        p.endsWith('.spec.jsx') || p.endsWith('.test.jsx') ||
        p.endsWith('.spec.ts')  || p.endsWith('.test.ts')  ||
        p.endsWith('.d.ts')
    ) {
        return { include: false, hooksOnly: false };
    }
    /* v8 ignore next 1 */
    if (isExcludedSourceFile(sf)) return { include: false, hooksOnly: false };

    const ext = p.slice(p.lastIndexOf('.'));
    if (FE_FULL_EXTENSIONS.has(ext)) return { include: true, hooksOnly: false };
    if (FE_HOOK_EXTENSIONS.has(ext)) return { include: true, hooksOnly: true };
    /* v8 ignore next 1 */
    return { include: false, hooksOnly: false };
}

/**
 * Extract FE components, hooks, pages, routes, renders, and imports
 * from all .tsx/.jsx files (and hooks from .ts files) in the ts-morph project.
 */
export async function extractFe(cfg: ArchGraphConfig, project: Project): Promise<FeExtractResult> {
    const root = resolve(cfg.root);

    const allComponents: FeComponent[] = [];
    const allHooks: FeHook[] = [];
    const allPages: FePage[] = [];
    const allRenders: FeRender[] = [];
    const allImports: FeImportRef[] = [];
    const allUnresolvedImports: FeUnresolvedImport[] = [];
    const routeMap = new Map<string, FeRoute>(); // pattern → FeRoute (dedup)

    for (const sf of project.getSourceFiles()) {
        const { include, hooksOnly } = isFESourceFile(sf);
        if (!include) continue;

        const file = sf.getFilePath();

        if (hooksOnly) {
            // .ts files: extract hooks only (no components, renders, pages, imports)
            const { hooks } = extractReactPatterns(sf, { hooksOnly: true });
            // Apply fallback name for safety (hooks always have a name from regex, but guard anyway)
            for (const hook of hooks) {
                /* v8 ignore next 3 */
                if (!hook.name) {
                    hook.name = `hook@${hook.location.line}`;
                }
                allHooks.push(hook);
            }
            continue;
        }

        // --- Full FE patterns (components, hooks, renders) for .tsx/.jsx ---
        const { components, hooks, renders } = extractReactPatterns(sf, { hooksOnly: false });

        // Apply fallback name for anonymous components (P1-4)
        for (const comp of components) {
            /* v8 ignore next 3 */
            if (!comp.name) {
                comp.name = `${comp.kind}@${comp.location.line}`;
            }
            allComponents.push(comp);
        }
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
            } catch (err) /* v8 ignore next 7 */ {
                // resolution failure — record for diagnostics unless it looks like a
                // bare scoped npm package (@scope/pkg) that cannot be in the project tree.
                // Pattern: @scope/pkg with no further path segments and no file extension.
                const isScopedNpm = /^@[^/]+\/[^/.]+$/.test(specifier);
                if (!isScopedNpm) {
                    const msg = err instanceof Error ? err.message : String(err);
                    allUnresolvedImports.push({ file, specifier, error: msg });
                }
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
        unresolvedImports: allUnresolvedImports,
    };
}
