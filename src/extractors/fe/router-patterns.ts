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

import type { SourceFile } from 'ts-morph';
import type { FePage } from './types.js';

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
export function deriveRoute(file: string, root: string): { route: string; router: 'pages' | 'app' } | null {
    // Normalise: make `rel` a POSIX-style path relative to root
    const rel = file
        .replace(root.endsWith('/') ? root : root + '/', '')
        .replace(/\\/g, '/');

    // ---- Pages Router ----
    const pagesSeg = pagesRouterSubpath(rel);
    if (pagesSeg) {
        let seg = pagesSeg;

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

function pagesRouterSubpath(rel: string): string | null {
    const patterns = [
        /^pages\/(.+)\.(?:tsx|jsx|ts|js)$/,
        /^src\/pages\/(.+)\.(?:tsx|jsx|ts|js)$/,
        /^apps\/[^/]+\/(?:src\/)?pages\/(.+)\.(?:tsx|jsx|ts|js)$/,
        /^packages\/[^/]+\/(?:src\/)?pages\/(.+)\.(?:tsx|jsx|ts|js)$/,
    ];
    for (const pattern of patterns) {
        const match = rel.match(pattern);
        if (match) return match[1]!;
    }
    return null;
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
export function extractPageFromFile(sf: SourceFile, root: string): FePage | null {
    const file = sf.getFilePath();
    const routeResult = deriveRoute(file, root);
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
