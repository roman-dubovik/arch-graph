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
 *   - i18n strings (next-intl / react-i18next) — .tsx/.jsx only
 */
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import type { Project, SourceFile } from 'ts-morph';

import type { ArchGraphConfig } from '../../core/config.js';
import { isExcludedSourceFile } from '../shared.js';
import { extractReactPatterns } from './react-patterns.js';
import { extractI18nStringsForFile, loadMessagesFromJson, type MessagesObject } from './i18n-resolver.js';
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

// ---------------------------------------------------------------------------
// Multi-file locales constants
// ---------------------------------------------------------------------------

/** Directories to skip when globbing for locale files. */
const LOCALE_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'arch-graph-out']);

/** Max locale files to load per language before emitting a warning and stopping. */
export const MAX_LOCALE_FILES_PER_LANG = 100;

// ---------------------------------------------------------------------------
// i18n diagnostics
// ---------------------------------------------------------------------------

export interface I18nDiagnostics {
    i18nMode: 'single-file' | 'multi-file' | 'absent';
    i18nFilesLoaded: number;
    i18nLanguagesFound: string[];
}

// ---------------------------------------------------------------------------
// Multi-file locale discovery helpers
// ---------------------------------------------------------------------------

/**
 * Recursively scan `dir` for files matching `*.json` at depth 0 (immediate children).
 * Does NOT recurse into subdirectories.  Used to enumerate namespace files under
 * `locales/<lang>/` and `apps/<app>/locales/<lang>/`.
 */
async function listJsonFilesInDir(dir: string): Promise<string[]> {
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries
            .filter((e) => e.isFile() && e.name.endsWith('.json'))
            .map((e) => join(dir, e.name));
    } catch {
        return [];
    }
}

/**
 * Discover all multi-file locale JSON paths under `root`.
 *
 * Covers two patterns:
 *   1. `<root>/locales/<lang>/<feature>.json`
 *   2. `<root>/apps/<app>/locales/<lang>/<feature>.json`  (one apps-level only)
 *
 * Returns a map from language code → list of absolute JSON file paths.
 */
async function discoverMultiFileLocales(root: string): Promise<Map<string, string[]>> {
    const byLang = new Map<string, string[]>();

    const addFiles = (lang: string, files: string[]): void => {
        const existing = byLang.get(lang) ?? [];
        existing.push(...files);
        byLang.set(lang, existing);
    };

    // Pattern 1: <root>/locales/<lang>/
    const rootLocalesDir = join(root, 'locales');
    try {
        const langEntries = await readdir(rootLocalesDir, { withFileTypes: true });
        for (const langEntry of langEntries) {
            if (!langEntry.isDirectory()) continue;
            const lang = langEntry.name;
            const langDir = join(rootLocalesDir, lang);
            const files = await listJsonFilesInDir(langDir);
            if (files.length > 0) addFiles(lang, files);
        }
    } catch {
        // locales/ dir doesn't exist — not an error
    }

    // Pattern 2: <root>/apps/<app>/locales/<lang>/
    const appsDir = join(root, 'apps');
    try {
        const appEntries = await readdir(appsDir, { withFileTypes: true });
        for (const appEntry of appEntries) {
            if (!appEntry.isDirectory() || LOCALE_SKIP_DIRS.has(appEntry.name)) continue;
            const appLocalesDir = join(appsDir, appEntry.name, 'locales');
            try {
                const langEntries = await readdir(appLocalesDir, { withFileTypes: true });
                for (const langEntry of langEntries) {
                    if (!langEntry.isDirectory()) continue;
                    const lang = langEntry.name;
                    const langDir = join(appLocalesDir, lang);
                    const files = await listJsonFilesInDir(langDir);
                    if (files.length > 0) addFiles(lang, files);
                }
            } catch {
                // app doesn't have locales/ — skip
            }
        }
    } catch {
        // apps/ dir doesn't exist — skip
    }

    return byLang;
}

/**
 * Load multi-file locales for the preferred language (ru first, then en).
 * Each file's basename (sans .json) becomes a namespace key in the merged object.
 * e.g. `locales/ru/blogs.json` with `{"title":"Заголовок"}` →
 *   merged["blogs"]["title"] = "Заголовок"
 *
 * @param byLang   Map from language → list of JSON file paths
 * @param capOverride  Optional override for the per-language file cap (for testing)
 * @returns merged messages object + diagnostics fields
 */
async function loadMultiFileMessages(
    byLang: Map<string, string[]>,
    capOverride?: number,
): Promise<{ messages: MessagesObject; filesLoaded: number; langUsed: string | null }> {
    const cap = capOverride ?? MAX_LOCALE_FILES_PER_LANG;
    // Preferred order: ru, then en, then first available
    const preferredLangs = ['ru', 'en'];
    const allLangs = [...byLang.keys()];
    const orderedLangs = [
        ...preferredLangs.filter((l) => allLangs.includes(l)),
        ...allLangs.filter((l) => !preferredLangs.includes(l)),
    ];

    for (const lang of orderedLangs) {
        let files = byLang.get(lang) ?? [];
        if (files.length === 0) continue;

        if (files.length > cap) {
            process.stderr.write(
                `[arch-graph fe-i18n] WARNING: found ${files.length} locale files for lang "${lang}", capping at ${cap}\n`,
            );
            files = files.slice(0, cap);
        }

        const merged: MessagesObject = {};
        let loaded = 0;
        for (const filePath of files) {
            let raw: string;
            try {
                raw = await readFile(filePath, 'utf8');
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(
                    `[arch-graph fe-i18n] WARNING: could not read ${filePath}: ${msg}\n`,
                );
                continue;
            }
            const result = loadMessagesFromJson(raw);
            if (!result.ok) {
                process.stderr.write(
                    `[arch-graph fe-i18n] WARNING: failed to parse ${filePath}: ${result.error}\n`,
                );
                continue;
            }
            // Namespace key = basename without .json
            const ns = basename(filePath, '.json');
            merged[ns] = result.messages;
            loaded++;
        }

        if (loaded > 0) {
            return { messages: merged, filesLoaded: loaded, langUsed: lang };
        }
    }

    return { messages: {}, filesLoaded: 0, langUsed: null };
}

// ---------------------------------------------------------------------------
// Extended loadProjectMessages with diagnostics
// ---------------------------------------------------------------------------

interface LoadProjectMessagesResult {
    messages: MessagesObject;
    diagnostics: I18nDiagnostics;
}

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
 * Load project i18n messages from well-known locations under `root`.
 *
 * AC-2 detection:
 *   - If any of the 4 single-file candidates exists → single-file mode (existing behaviour).
 *   - Else if multi-file locales are found → multi-file mode.
 *   - Else → absent.
 *
 * Single-file priority: messages/ru.json → messages/en.json →
 *   locales/ru/translation.json → locales/en/translation.json.
 *
 * Returns messages + i18n diagnostics (AC-6).
 *
 * @param root          Project root directory.
 * @param capOverride   Optional override for the per-lang file cap (testing only).
 */
async function loadProjectMessages(
    root: string,
    capOverride?: number,
): Promise<LoadProjectMessagesResult> {
    // -----------------------------------------------------------------------
    // Single-file candidates (existing behaviour, priority 1)
    // -----------------------------------------------------------------------
    const singleFileCandidates = [
        join(root, 'messages', 'ru.json'),
        join(root, 'messages', 'en.json'),
        join(root, 'locales', 'ru', 'translation.json'),
        join(root, 'locales', 'en', 'translation.json'),
    ];

    for (const candidate of singleFileCandidates) {
        let raw: string;
        try {
            raw = await readFile(candidate, 'utf8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                continue;
            }
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(
                `[arch-graph fe-i18n] WARNING: could not read ${candidate}: ${msg}\n`,
            );
            continue;
        }

        const result = loadMessagesFromJson(raw);
        if (!result.ok) {
            process.stderr.write(
                `[arch-graph fe-i18n] WARNING: failed to parse ${candidate}: ${result.error}\n`,
            );
            continue;
        }

        if (Object.keys(result.messages).length === 0) {
            process.stderr.write(
                `[arch-graph fe-i18n] WARNING: ${candidate} parsed to empty object — skipping (possible placeholder or corrupt file)\n`,
            );
            continue;
        }

        return {
            messages: result.messages,
            diagnostics: {
                i18nMode: 'single-file',
                i18nFilesLoaded: 1,
                i18nLanguagesFound: [candidate.includes('/ru/') || candidate.includes('ru.json') ? 'ru' : 'en'],
            },
        };
    }

    // -----------------------------------------------------------------------
    // Multi-file locales (AC-1/AC-2 priority 2)
    // -----------------------------------------------------------------------
    const byLang = await discoverMultiFileLocales(root);
    if (byLang.size > 0) {
        const { messages, filesLoaded, langUsed } = await loadMultiFileMessages(byLang, capOverride);
        if (filesLoaded > 0) {
            return {
                messages,
                diagnostics: {
                    i18nMode: 'multi-file',
                    i18nFilesLoaded: filesLoaded,
                    i18nLanguagesFound: langUsed ? [langUsed] : [...byLang.keys()],
                },
            };
        }
    }

    // -----------------------------------------------------------------------
    // Absent
    // -----------------------------------------------------------------------
    return {
        messages: {},
        diagnostics: {
            i18nMode: 'absent',
            i18nFilesLoaded: 0,
            i18nLanguagesFound: [],
        },
    };
}

/**
 * Extract FE components, hooks, pages, routes, renders, and imports
 * from all .tsx/.jsx files (and hooks from .ts files) in the ts-morph project.
 *
 * @param _capOverride  Internal: override the multi-file locale cap (for testing AC-7 cap).
 */
export async function extractFe(
    cfg: ArchGraphConfig,
    project: Project,
    _capOverride?: number,
): Promise<FeExtractResult & { i18nDiagnostics: I18nDiagnostics }> {
    const root = resolve(cfg.root);

    // Load i18n messages once per extractFe call (shared across all files).
    const { messages: projectMessages, diagnostics: i18nDiagnostics } =
        await loadProjectMessages(root, _capOverride);

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

        // Resolve i18n strings for this file once (shared by all components in the file,
        // since useTranslations/useTranslation is typically called at file scope).
        // AC-B1..B4: next-intl + react-i18next only; graceful no-op for others.
        const fileI18nStrings = extractI18nStringsForFile(sf, projectMessages);

        // Apply fallback name for anonymous components (P1-4)
        for (const comp of components) {
            /* v8 ignore next 3 */
            if (!comp.name) {
                comp.name = `${comp.kind}@${comp.location.line}`;
            }
            // Attach resolved i18n strings (may be empty array — that's fine)
            comp.i18nStrings = fileI18nStrings;
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
        i18nDiagnostics,
    };
}
