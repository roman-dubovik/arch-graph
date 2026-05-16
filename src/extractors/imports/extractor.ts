import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
    CallExpression,
    ImportDeclaration,
    Node,
    Project,
    SourceFile,
    SyntaxKind,
} from 'ts-morph';

import type { ArchGraphConfig } from '../../core/config.js';
import type { TsDynamicResolution, TsImportSite, TsStaticResolution } from '../../core/types.js';
import { isExcludedSourceFile } from '../shared.js';

/**
 * TS-imports extractor.
 *
 * Goal: emit two layers of import-derived edges (mapper does the emission).
 *   - service-level `lib-usage`: dedup'd `service:X → lib:Y`. Primary deliverable.
 *   - file-level `ts-import`:    raw per-import edges. Behind `imports.fileLevel`
 *                                because a medium monorepo produces 10k+ edges.
 *
 * Resolution algorithm (per `ImportDeclaration`):
 *   1. ts-morph `getModuleSpecifierSourceFile()` — works for relative paths.
 *   2. Manual relative resolve fallback — covers cases where the SourceFile
 *      isn't in the Project (e.g. the Project glob didn't include the target).
 *   3. Tsconfig `paths` alias resolution — `getModuleSpecifierSourceFile()` does
 *      NOT honor path aliases when the Project was created without a tsconfig
 *      (which is how `runBuild` builds it — single shared Project, files added
 *      by glob). We load the monorepo's base tsconfig once and rewrite alias
 *      specifiers to absolute paths, then look the file up on disk.
 *
 * What we don't extract:
 *   - `require()` calls (CommonJS) — out of scope; documented in OPEN-QUESTIONS.
 *   - Side-effect-only imports (`import './x'`) — they DO resolve here; they just
 *     don't carry symbols. Still relevant for lib-usage.
 *
 * Why ts-morph instead of dependency-cruiser:
 *   - reuses the already-loaded Project (no second AST pass), keeps deps lean.
 *   - tradeoff: alias resolution is weaker — we patch it via the tsconfig walk.
 */

export interface ExtractImportsResult {
    sites: TsImportSite[];
}

export async function extractImports(
    cfg: ArchGraphConfig,
    project: Project,
): Promise<ExtractImportsResult> {
    const { resolve: aliasResolver, isAliasPrefix } = buildAliasResolver(cfg.root);
    const sites: TsImportSite[] = [];

    for (const sf of project.getSourceFiles()) {
        if (isExcludedSourceFile(sf)) continue;
        const text = sf.getFullText();
        // Cheap rejection: a TS file without "import" string can't contain
        // static or dynamic imports. Saves the AST traversal cost on the
        // ~10% of files that are pure data/constants.
        if (!text.includes('import')) continue;

        // ---- Static imports ----
        for (const imp of sf.getImportDeclarations()) {
            sites.push(buildStaticSite(imp, aliasResolver, isAliasPrefix));
        }

        // ---- Dynamic imports ----
        // `import(...)` is a CallExpression where the expression is the
        // `ImportKeyword`. We only walk the file when the cheap substring
        // check suggests it's present — `forEachDescendant` on every file
        // would dominate runtime.
        if (text.includes('import(')) {
            sf.forEachDescendant((node) => {
                if (node.getKind() !== SyntaxKind.CallExpression) return;
                const call = node as CallExpression;
                if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) return;
                const site = buildDynamicSite(sf, call, aliasResolver, isAliasPrefix);
                if (site) sites.push(site);
            });
        }
    }

    return { sites };
}

function buildStaticSite(
    imp: ImportDeclaration,
    aliasResolver: AliasResolver,
    isAliasPrefix: AliasPrefixCheck,
): TsImportSite {
    const sf = imp.getSourceFile();
    const sourceFile = sf.getFilePath();
    const specifier = imp.getModuleSpecifierValue();
    const pos = sf.getLineAndColumnAtPos(imp.getStart());
    const typeOnly = imp.isTypeOnly();

    const resolution = resolveSpecifier(sourceFile, specifier, imp.getModuleSpecifierSourceFile(), aliasResolver, isAliasPrefix);
    return {
        sourceFile,
        specifier,
        resolution,
        kind: 'static',
        typeOnly,
        specifierShape: classifySpecifier(specifier, isAliasPrefix),
        location: { file: sourceFile, line: pos.line, column: pos.column },
    };
}

function buildDynamicSite(
    sf: SourceFile,
    call: CallExpression,
    aliasResolver: AliasResolver,
    isAliasPrefix: AliasPrefixCheck,
): (TsImportSite & { kind: 'dynamic' }) | null {
    const args = call.getArguments();
    if (args.length === 0) return null;
    const arg = args[0]!;
    // Only resolve literal specifiers — `import(variable)` is genuinely dynamic
    // and tracking it would require taint analysis we don't do here.
    const kind = arg.getKind();
    if (kind !== SyntaxKind.StringLiteral && kind !== SyntaxKind.NoSubstitutionTemplateLiteral) {
        const pos = sf.getLineAndColumnAtPos(call.getStart());
        // Non-literal argument: resolution is structurally impossible.
        // `dynamic-non-literal` can only appear on a `kind: 'dynamic'` site — the
        // type system enforces this via the TsImportSite discriminated union.
        const resolution: TsDynamicResolution = { kind: 'dynamic-non-literal' };
        return {
            sourceFile: sf.getFilePath(),
            specifier: arg.getText().slice(0, 80),
            resolution,
            kind: 'dynamic',
            typeOnly: false,
            // Non-literal specifier — can't classify shape. Mark as bare-external
            // so it stays out of the unresolvedInternal diagnostics bucket.
            specifierShape: 'bare-external',
            location: { file: sf.getFilePath(), line: pos.line, column: pos.column },
        };
    }
    const specifier = (arg as Node).getText().replace(/^['"`]|['"`]$/g, '');
    const pos = sf.getLineAndColumnAtPos(call.getStart());
    const resolution = resolveSpecifier(sf.getFilePath(), specifier, undefined, aliasResolver, isAliasPrefix);
    return {
        sourceFile: sf.getFilePath(),
        specifier,
        resolution,
        kind: 'dynamic',
        typeOnly: false,
        specifierShape: classifySpecifier(specifier, isAliasPrefix),
        location: { file: sf.getFilePath(), line: pos.line, column: pos.column },
    };
}

/**
 * Classify the specifier's shape for downstream diagnostics and consumers of
 * `TsImportSite`. Captures the *form* of the specifier (relative, alias, etc.)
 * independently of the resolution outcome — e.g. a relative specifier that
 * fails to resolve still carries `specifierShape: 'relative'`.
 */
function classifySpecifier(
    specifier: string,
    isAliasPrefix: AliasPrefixCheck,
): TsImportSite['specifierShape'] {
    if (specifier.startsWith('.')) return 'relative';
    if (specifier.startsWith('node:')) return 'builtin';
    if (isAliasPrefix(specifier)) return 'alias';
    return 'bare-external';
}

/**
 * Extract the canonical npm package name from a module specifier.
 *
 * Examples:
 *   `@nestjs/common/decorators` → `@nestjs/common`
 *   `react/jsx-runtime`         → `react`
 *   `@scope/pkg`                → `@scope/pkg`
 *   `node:fs`                   → `node:fs`
 */
function packageNameOf(specifier: string): string {
    if (specifier.startsWith('@')) {
        // Scoped: keep first two segments (`@scope/pkg`)
        const parts = specifier.split('/');
        return parts.length >= 2 ? `${parts[0]!}/${parts[1]!}` : specifier;
    }
    // Unscoped: keep everything before the first `/`
    const slash = specifier.indexOf('/');
    return slash === -1 ? specifier : specifier.slice(0, slash);
}

/**
 * Five-stage resolver. Returns a `TsStaticResolution` describing the outcome.
 *
 *   1. If ts-morph already resolved the spec → `resolved`. (Fast path for
 *      relatives whose target is in the Project.)
 *   2. Relative spec (`./` or `../`) → resolve from sourceFile dir and probe
 *      `.ts`, `.tsx`, `/index.ts`, `/index.tsx`. Failure → `broken-relative`.
 *   3. Node.js builtin (`node:fs`) → `external`.
 *   4. Alias match (`isAliasPrefix` is true) → probe on disk via aliasResolver.
 *      Hit → `resolved`. Miss → `broken-alias` reason `alias-prefix-matched-file-not-found`.
 *   5. No alias match but not relative / builtin → `external` with canonical
 *      npm package name (`packageNameOf`). No further probing.
 *
 * Returns `TsStaticResolution` (not the wider `TsDynamicResolution`) — this
 * function is called from both static and literal-dynamic import paths. The
 * `dynamic-non-literal` variant is produced directly in `buildDynamicSite`
 * (before this function is called) and is intentionally absent here, which
 * enforces the structural invariant that only `kind: 'dynamic'` sites carry it.
 */
function resolveSpecifier(
    sourceFilePath: string,
    specifier: string,
    tsMorphResolved: SourceFile | undefined,
    aliasResolver: AliasResolver,
    isAliasPrefix: AliasPrefixCheck,
): TsStaticResolution {
    if (tsMorphResolved) return { kind: 'resolved', filePath: tsMorphResolved.getFilePath() };

    if (specifier.startsWith('.')) {
        const probed = probeRelative(sourceFilePath, specifier);
        return probed !== null
            ? { kind: 'resolved', filePath: probed }
            : { kind: 'broken-relative', reason: 'file-not-found' };
    }

    // Node.js builtin (`node:fs`, `node:path`) — external, expected.
    if (specifier.startsWith('node:')) {
        return { kind: 'external', packageName: specifier };
    }

    if (isAliasPrefix(specifier)) {
        // Matched a tsconfig `paths` entry — try the on-disk probe.
        const probed = aliasResolver(specifier);
        return probed !== null
            ? { kind: 'resolved', filePath: probed }
            : { kind: 'broken-alias', reason: 'alias-prefix-matched-file-not-found' };
    }

    // Not relative, not builtin, not an alias prefix — bare npm package specifier
    // (`react`, `@nestjs/common`, etc.). No further probing needed.
    return { kind: 'external', packageName: packageNameOf(specifier) };
}

function probeRelative(sourceFilePath: string, specifier: string): string | null {
    const baseDir = dirname(sourceFilePath);
    const target = resolve(baseDir, specifier);
    return probeWithExtensions(target);
}

const TS_EXTENSIONS = ['.ts', '.tsx', '.d.ts'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.d.ts'];

function probeWithExtensions(target: string): string | null {
    // Exact path (already has extension).
    if (existsSync(target)) {
        // Could be a directory — fall through to index probing if so.
        try {
            const stat = statSync(target);
            if (stat.isFile()) return target;
            if (stat.isDirectory()) {
                for (const idx of INDEX_FILES) {
                    const p = resolve(target, idx);
                    if (existsSync(p)) return p;
                }
                return null;
            }
        } catch {
            // race / permission — give up
            return null;
        }
    }
    for (const ext of TS_EXTENSIONS) {
        const p = target + ext;
        if (existsSync(p)) return p;
    }
    for (const idx of INDEX_FILES) {
        const p = resolve(target, idx);
        if (existsSync(p)) return p;
    }
    return null;
}

// ============================================================================
// Tsconfig `paths` alias resolver
// ============================================================================

type AliasResolver = (specifier: string) => string | null;
type AliasPrefixCheck = (specifier: string) => boolean;

interface AliasResolverBundle {
    resolve: AliasResolver;
    /**
     * `true` when `specifier` matches any tsconfig-`paths` key (exact or
     * `/*` prefix). Used by the extractor to tag the specifier's shape even
     * when resolution fails, so the mapper can route alias-but-unresolved
     * failures into `unresolvedInternal` (real bug signal) vs node_modules
     * (expected external).
     */
    isAliasPrefix: AliasPrefixCheck;
}

/**
 * Build an alias resolver from the monorepo's tsconfig `paths`. Tries common
 * locations in priority order:
 *   1. `<root>/tsconfig.base.json`  (Nx / Nest monorepo convention)
 *   2. `<root>/tsconfig.json`       (when extends-base isn't used)
 *
 * We don't walk the whole tsconfig-graph (extends/references). That handles
 * 95% of real monorepos; the remaining 5% will surface as "unresolved internal
 * imports" in diagnostics — operator action: add the alias file manually or
 * fix the broken `paths` entry.
 *
 * Returns a NO-OP resolver when no tsconfig is found — every alias-shaped
 * specifier falls through to `null` (treated as external).
 */
function buildAliasResolver(root: string): AliasResolverBundle {
    const loaded = loadTsConfigPaths(root);
    const paths = loaded.paths;
    if (paths.size === 0) {
        // Two cases are silent failures here:
        //   1. No tsconfig found at all          → loud warning (alias imports will not resolve).
        //   2. Tsconfig found but no `compilerOptions.paths` → normal for projects without
        //      aliases; no warning.
        if (!loaded.foundTsconfig) {
            process.stderr.write(
                `[imports.extractor] WARNING: no tsconfig with compilerOptions.paths found at ${root} ` +
                    `(tried tsconfig.base.json, tsconfig.json) — alias imports will not resolve\n`,
            );
        }
        return { resolve: () => null, isAliasPrefix: () => false };
    }

    // Pre-compute prefix list once — `isAliasPrefix` runs per import,
    // and the iteration here would otherwise repeat for every call.
    //
    // We track exact keys and prefix keys separately. For prefix keys
    // (`@scope/*`), we drop the `*` AND keep the trailing slash. Without
    // the slash, `@scope-other/foo` would falsely match `@scope/*`
    // via naive `startsWith('@scope')`. Trailing `/` is the only honest
    // boundary marker in TypeScript path aliases.
    const aliasPrefixesWithSlash: string[] = [];
    for (const key of paths.keys()) {
        if (key.endsWith('/*')) {
            aliasPrefixesWithSlash.push(key.slice(0, -1)); // keep trailing `/`
        }
        // Exact keys are handled by `paths.has(specifier)` in the closure below —
        // no false-prefix risk there.
    }

    const resolveFn: AliasResolver = (specifier: string): string | null => {
        // Exact-key match (no `/*`) — most aliases are leaf-only barrels:
        //   "@scope/messaging": ["libs/messaging/src/index.ts"]
        const exact = paths.get(specifier);
        if (exact) {
            for (const p of exact) {
                const abs = isAbsolute(p) ? p : resolve(root, p);
                const probed = probeWithExtensions(abs);
                if (probed) return probed;
            }
        }
        // Prefix match (`@scope/messaging/*` → `libs/messaging/src/*`).
        // We iterate from longest to shortest key so `@a/b/*` wins over `@a/*`.
        for (const [key, targets] of paths) {
            if (!key.endsWith('/*')) continue;
            const prefix = key.slice(0, -1); // drop the `*`
            if (!specifier.startsWith(prefix)) continue;
            const tail = specifier.slice(prefix.length);
            for (const t of targets) {
                if (!t.endsWith('/*')) continue;
                const tBase = t.slice(0, -1);
                const abs = isAbsolute(tBase) ? tBase + tail : resolve(root, tBase + tail);
                const probed = probeWithExtensions(abs);
                if (probed) return probed;
            }
        }
        return null;
    };

    const isAliasPrefix: AliasPrefixCheck = (specifier: string): boolean => {
        // Exact match (alias `"@scope/pkg"` without `/*`).
        if (paths.has(specifier)) return true;
        // Prefix match — `specifier` starts with `<prefix>/`. The trailing `/`
        // is critical: without it `@scope/` would falsely match `@scope-other`,
        // and `@a/` would falsely match `@ab/c`.
        for (const prefix of aliasPrefixesWithSlash) {
            if (specifier.startsWith(prefix)) return true;
        }
        return false;
    };

    return { resolve: resolveFn, isAliasPrefix };
}

/**
 * Load `compilerOptions.paths` from the first existing tsconfig variant.
 * Returns the paths Map (ordered by key length descending so longest-prefix wins)
 * plus a flag indicating whether any tsconfig was found at all — used to
 * distinguish "no aliases configured" from "no tsconfig at root" in diagnostics.
 *
 * Strips JSONC comments (// and /* ... *\/) — Nx-style tsconfigs frequently
 * contain inline notes that vanilla `JSON.parse` chokes on.
 */
function loadTsConfigPaths(root: string): { paths: Map<string, string[]>; foundTsconfig: boolean } {
    const candidates = [
        resolve(root, 'tsconfig.base.json'),
        resolve(root, 'tsconfig.json'),
    ];
    let foundTsconfig = false;
    for (const candidate of candidates) {
        if (!existsSync(candidate)) continue;
        foundTsconfig = true;
        let raw: string;
        try {
            raw = readFileSync(candidate, 'utf8');
        } catch (err) {
            // Permission / FS race — log and try the next candidate. Silent skip
            // would mask the case where the file IS there but can't be read.
            process.stderr.write(
                `[imports.extractor] failed to read ${candidate}: ${(err as Error).message}\n`,
            );
            continue;
        }
        // JSONC: strip comments AND trailing commas. Both are common in
        // hand-edited tsconfigs; vanilla `JSON.parse` rejects both.
        const stripped = stripTrailingCommas(stripJsonComments(raw));
        let parsed: { compilerOptions?: { paths?: Record<string, string[]> } };
        try {
            parsed = JSON.parse(stripped);
        } catch (err) {
            // Malformed JSON is a real operator problem — they'll see empty
            // lib-usage edges otherwise. Surface it loudly.
            process.stderr.write(
                `[imports.extractor] WARNING: ${candidate} has invalid JSON (alias resolution disabled): ${(err as Error).message}\n`,
            );
            continue;
        }
        const paths = parsed.compilerOptions?.paths;
        if (!paths) continue;
        // Sort longest-key first so prefix matches don't shadow more specific entries.
        const entries = Object.entries(paths).sort((a, b) => b[0].length - a[0].length);
        return { paths: new Map(entries), foundTsconfig };
    }
    return { paths: new Map(), foundTsconfig };
}

/**
 * Removes trailing commas inside arrays / objects that JSON.parse rejects.
 * Strings are protected by a tiny state machine so a literal `,]` inside
 * a quoted value isn't touched.
 */
function stripTrailingCommas(s: string): string {
    let out = '';
    let i = 0;
    const n = s.length;
    let inString = false;
    while (i < n) {
        const c = s[i]!;
        if (inString) {
            out += c;
            if (c === '\\' && i + 1 < n) {
                out += s[i + 1]!;
                i += 2;
                continue;
            }
            if (c === '"') inString = false;
            i++;
            continue;
        }
        if (c === '"') {
            inString = true;
            out += c;
            i++;
            continue;
        }
        if (c === ',') {
            // Look ahead past whitespace for `}` or `]`.
            let j = i + 1;
            while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j++;
            if (s[j] === '}' || s[j] === ']') {
                // Drop the comma — skip past it without emitting.
                i++;
                continue;
            }
        }
        out += c;
        i++;
    }
    return out;
}

function stripJsonComments(s: string): string {
    let out = '';
    let i = 0;
    const n = s.length;
    let inString = false;
    while (i < n) {
        const c = s[i]!;
        const next = s[i + 1];
        if (inString) {
            out += c;
            if (c === '\\' && i + 1 < n) {
                out += s[i + 1]!;
                i += 2;
                continue;
            }
            if (c === '"') inString = false;
            i++;
            continue;
        }
        if (c === '"') {
            inString = true;
            out += c;
            i++;
            continue;
        }
        if (c === '/' && next === '/') {
            while (i < n && s[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && next === '*') {
            i += 2;
            while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}
