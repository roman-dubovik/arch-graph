/**
 * Next.js route detection and URL pattern derivation.
 *
 * Supports:
 *   - Pages Router: files matching pages/**\/*.{tsx,jsx,ts,js}
 *     - pages/index.tsx           → /
 *     - pages/about.tsx           → /about
 *     - pages/users/[id].tsx      → /users/:id
 *     - pages/[...slug].tsx       → /*
 *     - pages/_app.tsx            → skipped (internal)
 *     - pages/_document.tsx       → skipped (internal)
 *     - pages/api/**              → skipped (API routes, not FE pages)
 *
 *   - App Router: files matching app/**\/page.{tsx,jsx,ts,js}
 *     - app/page.tsx              → /
 *     - app/about/page.tsx        → /about
 *     - app/users/[id]/page.tsx   → /users/:id
 *     - app/(marketing)/about/page.tsx → /about  (route groups stripped)
 *     - app/[...slug]/page.tsx    → /*
 */

import fg from 'fast-glob';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Node, type JsxAttribute, type ObjectLiteralExpression, type SourceFile } from 'ts-morph';
import type { FeRoute, FePage } from './types.js';

// ---------------------------------------------------------------------------
// Route derivation
// ---------------------------------------------------------------------------

/**
 * Given an absolute file path and the project root, derive the URL pattern.
 * Returns `null` if the file is not a page file or should be skipped.
 *
 * @param file     Absolute path of the source file.
 * @param root     Absolute monorepo/project root.
 */
export interface RouteDerivationOptions {
    /**
     * Confirmed Pages Router roots, relative to `root`, e.g.
     * `apps/web/pages`, `apps/web/src/pages`, `pages`, `src/pages`.
     * When omitted, Pages Router detection is permissive for direct callers and
     * legacy unit tests. Extractor/validator pass this list to avoid treating
     * arbitrary React feature folders named `src/pages` as Next.js routes.
     */
    pagesRouterRoots?: ReadonlySet<string>;
}

export function deriveRoute(
    file: string,
    root: string,
    options: RouteDerivationOptions = {},
): { route: string; router: 'pages' | 'app' } | null {
    // Normalise: make `rel` a POSIX-style path relative to root
    const rel = file
        .replace(root.endsWith('/') ? root : root + '/', '')
        .replace(/\\/g, '/');

    // ---- Pages Router ----
    const pagesInfo = pagesRouterSubpath(rel);
    if (pagesInfo) {
        if (options.pagesRouterRoots && !options.pagesRouterRoots.has(pagesInfo.root)) {
            return null;
        }
        let seg = pagesInfo.segment;

        // Skip internal Next.js pages and API routes
        if (/(?:^|\/)_/.test(seg)) return null;
        if (/(?:^|\/)api(?:\/|$)/.test(seg)) return null;

        // `index` → `/`
        seg = seg.replace(/\/index$/, '').replace(/^index$/, '');

        // Convert dynamic segments: [[...slug]] → *, [...slug] → *, [id] → :id
        seg = seg
            .replace(/\[\[\.\.\.(\w+)\]\]/g, '*')
            .replace(/\[\.\.\.(\w+)\]/g, '*')
            .replace(/\[(\w+)\]/g, ':$1');

        const route = seg === '' ? '/' : `/${seg}`;
        return { route, router: 'pages' };
    }

    // ---- App Router ----
    const appMatch = rel.match(/^(?:.*\/)?app\/(.*\/)?page\.(?:tsx|jsx|ts|js)$/);
    if (appMatch) {
        let seg = (appMatch[1] ?? '').replace(/\/$/, '');

        // Parallel routes: any segment starting with @ (e.g. @modal) → skip
        if (/(?:^|\/)@/.test(seg)) return null;

        // Intercepting routes: (.)/  (..)/  (...)/  → skip
        if (/(?:^|\/)\.+\)\//.test(seg) || /(?:^|\/)\(\.+\)/.test(seg)) return null;

        // Strip route groups (plain groups like (group)/, but NOT intercepting routes above)
        seg = seg.replace(/\([^.)][^)]*\)\//g, '').replace(/\([^.)][^)]*\)$/, '');

        // Optional catch-all: [[...slug]] → /* (must come before single [...])
        seg = seg.replace(/\[\[\.\.\.(\w+)\]\]/g, '*');

        // Convert dynamic segments
        seg = seg
            .replace(/\[\.\.\.(\w+)\]/g, '*')
            .replace(/\[(\w+)\]/g, ':$1');

        const route = seg === '' ? '/' : `/${seg}`;
        return { route, router: 'app' };
    }

    return null;
}

function pagesRouterSubpath(rel: string): { root: string; segment: string } | null {
    const patterns = [
        /^(pages)\/(.+)\.(?:tsx|jsx|ts|js)$/,
        /^(src\/pages)\/(.+)\.(?:tsx|jsx|ts|js)$/,
        /^(apps\/[^/]+\/(?:src\/)?pages)\/(.+)\.(?:tsx|jsx|ts|js)$/,
        /^(packages\/[^/]+\/(?:src\/)?pages)\/(.+)\.(?:tsx|jsx|ts|js)$/,
    ];
    for (const pattern of patterns) {
        const match = rel.match(pattern);
        if (match) return { root: match[1]!, segment: match[2]! };
    }
    return null;
}

export async function discoverNextPagesRouterRoots(root: string): Promise<Set<string>> {
    const roots = new Set<string>();
    const markers = await fg(
        [
            'next.config.js',
            'next.config.mjs',
            'next.config.cjs',
            'next.config.ts',
            'apps/*/next.config.js',
            'apps/*/next.config.mjs',
            'apps/*/next.config.cjs',
            'apps/*/next.config.ts',
            'packages/*/next.config.js',
            'packages/*/next.config.mjs',
            'packages/*/next.config.cjs',
            'packages/*/next.config.ts',
            'apps/*/project.json',
            'packages/*/project.json',
            'package.json',
            'apps/*/package.json',
            'packages/*/package.json',
        ],
        {
            cwd: root,
            absolute: false,
            ignore: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.worktrees/**'],
        },
    );

    // Tiny fixtures and in-memory tests often have only `pages/` / `app/`
    // files and no package/project metadata. Keep those permissive while real
    // Nx/package roots below are framework-gated by their markers.
    if (markers.length === 0) {
        addPagesRoots(roots, '.');
        const pageFiles = await fg(
            [
                'apps/*/pages/**/*.{ts,tsx,js,jsx}',
                'apps/*/src/pages/**/*.{ts,tsx,js,jsx}',
                'packages/*/pages/**/*.{ts,tsx,js,jsx}',
                'packages/*/src/pages/**/*.{ts,tsx,js,jsx}',
            ],
            {
                cwd: root,
                absolute: false,
                ignore: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.worktrees/**'],
            },
        );
        for (const file of pageFiles) {
            const info = pagesRouterSubpath(file.replace(/\\/g, '/'));
            if (info) roots.add(info.root);
        }
        return roots;
    }

    for (const marker of markers) {
        const dir = dirname(marker).replace(/\\/g, '/');
        if (marker.endsWith('next.config.js')
            || marker.endsWith('next.config.mjs')
            || marker.endsWith('next.config.cjs')
            || marker.endsWith('next.config.ts')) {
            addPagesRoots(roots, dir);
            continue;
        }

        if (marker.endsWith('project.json')) {
            if (await fileContainsNextMarker(root, marker)) addPagesRoots(roots, dir);
            continue;
        }

        if (marker.endsWith('package.json') && await packageJsonHasNext(root, marker)) {
            addPagesRoots(roots, dir);
        }
    }

    return roots;
}

function addPagesRoots(roots: Set<string>, appRoot: string): void {
    const prefix = appRoot === '.' ? '' : `${appRoot}/`;
    roots.add(`${prefix}pages`);
    roots.add(`${prefix}src/pages`);
}

async function fileContainsNextMarker(root: string, rel: string): Promise<boolean> {
    try {
        const text = await readFile(`${root}/${rel}`, 'utf8');
        return /@nx\/next:|@nrwl\/next:|next:/.test(text);
    } catch {
        return false;
    }
}

async function packageJsonHasNext(root: string, rel: string): Promise<boolean> {
    try {
        const pkg = JSON.parse(await readFile(`${root}/${rel}`, 'utf8')) as {
            dependencies?: Record<string, unknown>;
            devDependencies?: Record<string, unknown>;
        };
        return Boolean(pkg.dependencies?.next ?? pkg.devDependencies?.next);
    } catch {
        return false;
    }
}

/**
 * Determine if a file path looks like a page file (Pages or App Router).
 * Used by the extractor to quickly pre-filter before full AST analysis.
 */
export function isPageFile(file: string): boolean {
    const f = file.replace(/\\/g, '/');
    // Pages Router
    if (looksLikePagesRouterFile(f)) {
        const seg = f.match(/\/pages\/(.+)\.(tsx|jsx|ts|js)$/)?.[1] ?? '';
        if (/(?:^|\/)_/.test(seg) || /(?:^|\/)api(?:\/|$)/.test(seg)) return false;
        return true;
    }
    // App Router
    if (/\/app\/.*\/page\.(tsx|jsx|ts|js)$/.test(f) || /\/app\/page\.(tsx|jsx|ts|js)$/.test(f)) {
        return true;
    }
    return false;
}

function looksLikePagesRouterFile(file: string): boolean {
    if (!/\.(tsx|jsx|ts|js)$/.test(file)) return false;
    return (
        /\/pages\/[^/]/.test(file) &&
        !/\/(?:app|components?|features?|modules?|widgets?)\/.*\/pages\/[^/]/.test(file)
    );
}

// ---------------------------------------------------------------------------
// Extract page info from a SourceFile
// ---------------------------------------------------------------------------

/**
 * Extract a `FePage` from a source file that is a Next.js page.
 * Returns `null` if the file is not a recognized page file.
 */
export function extractPageFromFile(
    sf: SourceFile,
    root: string,
    options: RouteDerivationOptions = {},
): FePage | null {
    const file = sf.getFilePath();
    const routeResult = deriveRoute(file, root, options);
    if (!routeResult) return null;

    // Try to find the default-exported component name
    const defaultSymbol = sf.getDefaultExportSymbol();
    let name: string = defaultSymbol?.getName() ?? '';

    // Fallback: first exported function/arrow/class with uppercase name
    if (!name || name === 'default') {
        for (const fn of sf.getFunctions()) {
            const n = fn.getName();
            if (n && /^[A-Z]/.test(n)) { name = n; break; }
        }
    }
    if (!name || name === 'default') {
        for (const varDecl of sf.getVariableDeclarations()) {
            const n = varDecl.getName();
            if (/^[A-Z]/.test(n)) { name = n; break; }
        }
    }
    // Last resort: derive from filename
    if (!name || name === 'default') {
        const base = file.split('/').pop()?.replace(/\.(tsx|jsx|ts|js)$/, '') ?? 'Page';
        name = base.charAt(0).toUpperCase() + base.slice(1);
    }

    const { line, column } = sf.getLineAndColumnAtPos(0);

    return {
        name,
        file,
        location: { file, line, column },
        route: routeResult.route,
        router: routeResult.router,
    };
}

export function extractReactRouterRoutesFromFile(sf: SourceFile): FeRoute[] {
    const routes: FeRoute[] = [];
    const file = sf.getFilePath();
    const hasReactRouterImport = sf.getImportDeclarations().some((decl) =>
        decl.getModuleSpecifierValue() === 'react-router-dom'
            && decl.getNamedImports().some((named) => named.getName() === 'Route'),
    );
    if (!hasReactRouterImport) return routes;

    sf.forEachDescendant((node) => {
        if (!Node.isJsxSelfClosingElement(node) && !Node.isJsxOpeningElement(node)) return;
        if (node.getTagNameNode().getText() !== 'Route') return;
        const pathAttr = node.getAttributes().find((attr) =>
            Node.isJsxAttribute(attr) && attr.getNameNode().getText() === 'path',
        );
        if (!pathAttr || !Node.isJsxAttribute(pathAttr)) return;
        const pattern = readJsxPathAttribute(pathAttr, sf);
        if (!pattern) return;
        routes.push({ pattern, pageFile: file });
    });

    return routes;
}

function readJsxPathAttribute(attr: JsxAttribute, sf: SourceFile): string | null {
    const init = attr.getInitializer();
    if (!init) return null;
    if (Node.isStringLiteral(init)) return normalizeReactRouterPath(init.getLiteralText());
    if (!Node.isJsxExpression(init)) return null;
    const expr = init.getExpression();
    if (!expr) return null;
    const unwrapped = unwrapExpression(expr);
    if (Node.isStringLiteral(unwrapped) || Node.isNoSubstitutionTemplateLiteral(unwrapped)) {
        return normalizeReactRouterPath(unwrapped.getLiteralText());
    }
    if (Node.isPropertyAccessExpression(unwrapped)) {
        return normalizeReactRouterPath(resolvePropertyAccessString(unwrapped.getText(), sf));
    }
    return null;
}

function unwrapExpression(expr: Node): Node {
    let cur = expr;
    while (
        Node.isAsExpression(cur)
        || Node.isTypeAssertion(cur)
        || Node.isParenthesizedExpression(cur)
        || Node.isNonNullExpression(cur)
    ) {
        cur = cur.getExpression();
    }
    return cur;
}

function normalizeReactRouterPath(path: string | null): string | null {
    if (!path) return null;
    if (path === '/') return '/';
    return path.startsWith('/') ? path : `/${path}`;
}

function resolvePropertyAccessString(accessText: string, sf: SourceFile): string | null {
    const segments = accessText.split('.');
    if (segments.length < 2) return null;
    const root = segments[0]!;
    const object = findObjectLiteral(root, sf);
    if (!object) return null;
    return readObjectPath(object, segments.slice(1));
}

function findObjectLiteral(name: string, sf: SourceFile): ObjectLiteralExpression | null {
    for (const decl of sf.getVariableDeclarations()) {
        if (decl.getName() === name) {
            const init = decl.getInitializer();
            const unwrapped = init ? unwrapExpression(init) : null;
            return unwrapped && Node.isObjectLiteralExpression(unwrapped) ? unwrapped : null;
        }
    }

    for (const imp of sf.getImportDeclarations()) {
        const named = imp.getNamedImports().find((n) => n.getName() === name);
        if (!named) continue;
        const imported = imp.getModuleSpecifierSourceFile();
        if (!imported) continue;
        const found = findObjectLiteral(name, imported);
        if (found) return found;
    }

    return null;
}

function readObjectPath(object: ObjectLiteralExpression, segments: string[]): string | null {
    let cur: Node = object;
    for (const segment of segments) {
        if (!Node.isObjectLiteralExpression(cur)) return null;
        const prop = cur.getProperties().find((p) =>
            Node.isPropertyAssignment(p) && propertyName(p.getNameNode()) === segment,
        );
        if (!prop || !Node.isPropertyAssignment(prop)) return null;
        cur = unwrapExpression(prop.getInitializerOrThrow());
    }
    if (Node.isStringLiteral(cur) || Node.isNoSubstitutionTemplateLiteral(cur)) {
        return cur.getLiteralText();
    }
    return null;
}

function propertyName(node: Node): string {
    if (Node.isIdentifier(node)) return node.getText();
    if (Node.isStringLiteral(node) || Node.isNumericLiteral(node)) {
        return node.getLiteralText();
    }
    return node.getText();
}
