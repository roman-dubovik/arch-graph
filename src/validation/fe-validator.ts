/**
 * FE validator: regex-based ground-truth enumeration + recall report.
 *
 * Ground-truth signals:
 *   - Components: files ending in .tsx/.jsx that contain recognisable React
 *     component patterns (arrow/function/class with JSX, memo/forwardRef wrappers).
 *   - Hooks: functions named use[A-Z]* in .tsx/.jsx/.ts files.
 *   - Routes: Next.js page files (pages/ subtree or app/ subtree page.tsx).
 *
 * Recall floor: ≥ 90% per category (enforced by the caller / CLI gate).
 */

import fg from 'fast-glob';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ArchGraphConfig } from '../core/config.js';
import type { FeExtractResult } from '../extractors/fe/types.js';
import { deriveRoute } from '../extractors/fe/router-patterns.js';

// ---------------------------------------------------------------------------
// Ground-truth entry shapes
// ---------------------------------------------------------------------------

export interface FeGroundTruthEntry {
    role: 'component' | 'hook' | 'route';
    file: string;
    /** Name/pattern that was matched (e.g. component name or URL pattern). */
    matchedText: string;
}

export interface FeValidationReport {
    summary: {
        recallComponents: number;
        recallRoutes: number;
        recallHooks: number;
        totalComponents: number;
        totalRoutes: number;
        totalHooks: number;
        groundTruthComponents: number;
        groundTruthRoutes: number;
        groundTruthHooks: number;
    };
    groundTruth: FeGroundTruthEntry[];
    missedComponents: FeGroundTruthEntry[];
    missedRoutes: FeGroundTruthEntry[];
    missedHooks: FeGroundTruthEntry[];
}

// ---------------------------------------------------------------------------
// Regex patterns for ground-truth detection
// ---------------------------------------------------------------------------

/**
 * Matches any of:
 *   export const X = () =>     (arrow component — must start with uppercase after const)
 *   export function X(         (function component — uppercase)
 *   export default function X( (default function component)
 *   export class X extends     (class component)
 *   React.memo(                (memo wrapper)
 *   React.forwardRef(          (forwardRef wrapper)
 *   export const X = React.memo
 *   export const X = React.forwardRef
 */
const COMPONENT_RE =
    /(?:export\s+(?:default\s+)?(?:function|class)\s+[A-Z]\w*|const\s+[A-Z]\w+\s*=\s*(?:\(|React\.(?:memo|forwardRef)))/g;

/**
 * Matches hook function definitions: function useXxx or const useXxx =
 * Also catches arrow hooks: const useXxx = (...) =>
 *
 * KNOWN DIVERGENCE from react-patterns.ts extractor:
 *   This regex counts any `use[A-Z]*` function by name alone, regardless of
 *   whether its body calls another hook. The AST extractor (react-patterns.ts)
 *   additionally requires `bodyCallsHook()` — i.e. the body must contain at
 *   least one `use[A-Z]*()` call. Bare utility functions named `useXxx` that
 *   contain no inner hook calls are counted by GT but skipped by the extractor.
 *   This is intentional: the extractor prioritises precision over recall.
 *   See: test "KNOWN DIVERGENCE — bare use* function" in react-patterns.test.ts.
 */
const HOOK_RE =
    /(?:function|const)\s+(use[A-Z]\w*)\s*[=(]/g;

/** Matches JSX — at least one <Tag or /> occurrence in the file. */
const JSX_RE = /<[A-Z][A-Za-z]*[\s/>]|\/>/;

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Enumerate ground-truth FE entries by scanning .tsx/.jsx (+ .ts for hooks)
 * files across the configured source tree.
 */
export async function enumerateFeGroundTruth(cfg: ArchGraphConfig): Promise<FeGroundTruthEntry[]> {
    const root = resolve(cfg.root);
    const out: FeGroundTruthEntry[] = [];

    const files = await fg(
        [
            `${cfg.appsGlob}/**/*.tsx`,
            `${cfg.appsGlob}/**/*.jsx`,
            `${cfg.appsGlob}/**/*.ts`,
            ...(cfg.libsGlob
                ? [
                      `${cfg.libsGlob}/**/*.tsx`,
                      `${cfg.libsGlob}/**/*.jsx`,
                      `${cfg.libsGlob}/**/*.ts`,
                  ]
                : []),
        ],
        {
            cwd: root,
            absolute: true,
            ignore: [
                '**/node_modules/**',
                '**/dist/**',
                '**/*.spec.ts',
                '**/*.spec.tsx',
                '**/*.test.ts',
                '**/*.test.tsx',
                '**/*.d.ts',
            ],
        },
    );

    for (const file of files) {
        let content: string;
        try {
            content = await readFile(file, 'utf8');
        } catch (err) /* v8 ignore next 4 */ {
            const e = err as NodeJS.ErrnoException;
            if (e.code === 'ENOENT') continue;
            throw new Error(`fe GT read failed for ${file}: ${e.code ?? e.message}`, { cause: err });
        }

        const isFE = file.endsWith('.tsx') || file.endsWith('.jsx');

        // ---- Component GT (FE files only) ----
        if (isFE && JSX_RE.test(content)) {
            for (const m of content.matchAll(COMPONENT_RE)) {
                out.push({ role: 'component', file, matchedText: m[0].trim().slice(0, 80) });
            }
        }

        // ---- Hook GT (any file) ----
        for (const m of content.matchAll(HOOK_RE)) {
            const hookName = m[1]!;
            out.push({ role: 'hook', file, matchedText: hookName });
        }

        // ---- Route GT (page files) ----
        const routeResult = deriveRoute(file, root);
        if (routeResult) {
            out.push({ role: 'route', file, matchedText: routeResult.route });
        }
    }

    return out;
}

/**
 * Compute recall metrics comparing extracted FE output against ground truth.
 * Recall = extracted ∩ ground-truth / ground-truth total (per category).
 */
export function buildFeReport(
    extracted: FeExtractResult,
    groundTruth: FeGroundTruthEntry[],
): FeValidationReport {
    const gtComponents = groundTruth.filter((g) => g.role === 'component');
    const gtHooks = groundTruth.filter((g) => g.role === 'hook');
    const gtRoutes = groundTruth.filter((g) => g.role === 'route');

    // Build lookup sets from extracted results — keyed as `${file}#${name}` to
    // avoid cross-file collisions (e.g. two `Button` components in different files).
    const extractedComponentKeys = new Set(extracted.components.map((c) => `${c.file}#${c.name}`));
    const extractedHookKeys = new Set(extracted.hooks.map((h) => `${h.file}#${h.name}`));
    const extractedRoutePatterns = new Set(extracted.routes.map((r) => r.pattern));

    // Recall: ground-truth entries that have a match in extracted
    const missedComponents: FeGroundTruthEntry[] = [];
    for (const gt of gtComponents) {
        // Match by file + component name (file-qualified key prevents same-name cross-file inflation)
        const nameMatch = gt.matchedText.match(/(?:function|class|const)\s+([A-Z]\w*)/);
        const name = nameMatch?.[1] ?? '';
        if (!extractedComponentKeys.has(`${gt.file}#${name}`)) {
            missedComponents.push(gt);
        }
    }

    const missedHooks: FeGroundTruthEntry[] = [];
    for (const gt of gtHooks) {
        // gt.matchedText for hooks is the hook name (e.g. "useCounter")
        if (!extractedHookKeys.has(`${gt.file}#${gt.matchedText}`)) {
            missedHooks.push(gt);
        }
    }

    const missedRoutes: FeGroundTruthEntry[] = [];
    for (const gt of gtRoutes) {
        if (!extractedRoutePatterns.has(gt.matchedText)) {
            missedRoutes.push(gt);
        }
    }

    const recallComponents =
        gtComponents.length > 0
            ? (gtComponents.length - missedComponents.length) / gtComponents.length
            : 1;
    const recallHooks =
        gtHooks.length > 0
            ? (gtHooks.length - missedHooks.length) / gtHooks.length
            : 1;
    const recallRoutes =
        gtRoutes.length > 0
            ? (gtRoutes.length - missedRoutes.length) / gtRoutes.length
            : 1;

    return {
        summary: {
            recallComponents,
            recallRoutes,
            recallHooks,
            totalComponents: extracted.components.length,
            totalRoutes: extracted.routes.length,
            totalHooks: extracted.hooks.length,
            groundTruthComponents: gtComponents.length,
            groundTruthRoutes: gtRoutes.length,
            groundTruthHooks: gtHooks.length,
        },
        groundTruth,
        missedComponents,
        missedRoutes,
        missedHooks,
    };
}
