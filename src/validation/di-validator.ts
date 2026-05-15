import type { ArchGraphConfig } from '../core/config.js';
import type {
    DiGroundTruthEntry,
    DiModuleSite,
    DiValidationReport,
} from '../core/types.js';
import { buildLineStarts, indexBy, matchByLineKey, offsetToLineCol } from './line-index.js';
import { iterateSourceFiles } from './scan.js';
import { stripComments } from './strip-comments.js';

/**
 * Ground-truth grep for NestJS DI. Two signal levels:
 *
 *   1. `@Module\s*\(`                           role: 'module'
 *      Recall gate: extracted module sites must cover at least 95 percent of these.
 *
 *   2. Field-presence inside any `@Module({...})`:
 *      lines like `imports:`, `providers:`, `exports:`, `controllers:`.
 *      Counts populated fields per module, not array entries — robust against
 *      multiline arrays, nested calls, spreads, comments. The deeper question
 *      "did every entry resolve" is `resolveRate`'s job, not the recall gate.
 *
 * Match key: `file:line` (extractor reports module-decorator line for `module`
 * GT entries, property-name-token line for field GT entries; both are stable
 * across formatter passes).
 *
 * `g` flag collects all `@Module(` occurrences in a file; the brace-balanced
 * scanner in `findModuleSpans` handles multi-line bodies without needing `.`
 * to span newlines.
 */

const MODULE_RE = /@Module\s*\(/gs;
// Field-presence is detected via a brace-balanced scan over the metadata object — see
// `scanTopLevelKeys`. A plain regex like `(?<=[\{,\s])imports\s*:` over the whole
// `@Module(...)` argument would falsely match nested-config keys inside dynamic-module
// factory calls (e.g. `BullModule.registerQueueAsync({ imports: [ConfigModule], … })`).

export async function enumerateDiGroundTruth(
    cfg: ArchGraphConfig,
): Promise<DiGroundTruthEntry[]> {
    const out: DiGroundTruthEntry[] = [];

    for await (const { file, content } of iterateSourceFiles(cfg, 'di GT')) {
        // File-level pre-filter: only scrub and match files that contain `@Module(`. Field-presence
        // regex relies on being inside a module declaration; we don't trust raw `imports:`,
        // `providers:` matches outside that context.
        if (!content.includes('@Module')) continue;

        const stripped = stripComments(content);
        const lineStarts = buildLineStarts(stripped);

        const push = (role: DiGroundTruthEntry['role'], offset: number, text: string): void => {
            const { line, column } = offsetToLineCol(offset, lineStarts);
            out.push({
                role,
                location: { file, line, column },
                matchedText: text.slice(0, 60).replace(/\n.*$/s, '').trim(),
            });
        };

        // `module` GT — one entry per `@Module(`.
        for (const m of stripped.matchAll(MODULE_RE)) {
            const offset = m.index ?? 0;
            push('module', offset, stripped.slice(offset, offset + 60));
        }

        // Field GT — count populated *top-level* fields of `@Module({...})`. We avoid the
        // pitfall of false-matching `imports:` / `providers:` keys inside nested factory
        // configs (e.g. `BullModule.registerQueueAsync({ imports: [...] })` is NOT a
        // module's imports field) by scanning only depth-1 keys of the metadata object.
        const moduleSpans = findModuleSpans(stripped);
        for (const { topLevelKeys } of moduleSpans) {
            for (const keyOffset of topLevelKeys) {
                const role = classifyTopLevelKey(stripped, keyOffset);
                if (!role) continue;
                push(role, keyOffset, stripped.slice(keyOffset, keyOffset + 30));
            }
        }
    }

    return out;
}

/**
 * Returns the field role for a top-level key at `offset`, or `null` if the identifier
 * is one we don't track (e.g. `global`, the now-removed `component`-style fields).
 */
function classifyTopLevelKey(src: string, offset: number): DiGroundTruthEntry['role'] | null {
    if (src.startsWith('imports', offset) && !isIdentPart(src[offset + 7] ?? '')) return 'imports-field';
    if (src.startsWith('providers', offset) && !isIdentPart(src[offset + 9] ?? '')) return 'providers-field';
    if (src.startsWith('exports', offset) && !isIdentPart(src[offset + 7] ?? '')) return 'exports-field';
    if (src.startsWith('controllers', offset) && !isIdentPart(src[offset + 11] ?? '')) return 'controllers-field';
    return null;
}

/**
 * Returns ranges spanning each `@Module({...})` call's *top-level* metadata
 * object — i.e. just inside the outermost `{` … `}`, NOT including any nested
 * object literals (which can carry their own `imports:` / `providers:` keys
 * for unrelated dynamic-module factories like `BullModule.registerQueueAsync`).
 *
 * Each returned span pairs with a list of top-level key offsets so the caller
 * scans only depth-1 keys, not the entire substring.
 */
function findModuleSpans(src: string): Array<{ start: number; end: number; topLevelKeys: number[] }> {
    const out: Array<{ start: number; end: number; topLevelKeys: number[] }> = [];
    const re = /@Module\s*\(/gs;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
        const openParen = re.lastIndex - 1;
        const openBrace = findFirstChar(src, openParen + 1, '{');
        if (openBrace < 0) continue;
        const result = scanTopLevelKeys(src, openBrace);
        if (result.end > openBrace) {
            out.push({ start: openBrace + 1, end: result.end, topLevelKeys: result.keys });
        }
    }
    return out;
}

/** Find first occurrence of `ch` outside any whitespace/string starting from `from`. */
function findFirstChar(src: string, from: number, ch: string): number {
    for (let i = from; i < src.length; i++) {
        const c = src[i];
        if (c === ' ' || c === '\n' || c === '\t' || c === '\r') continue;
        if (c === ch) return i;
        // Anything other than whitespace before the brace is unexpected — bail.
        return -1;
    }
    return -1;
}

/**
 * Starting at `openBrace` (a `{`), scan to its matching `}`. Track depth, string state,
 * and record offsets of *depth-1* identifier tokens (the top-level keys: `imports`,
 * `providers`, `exports`, `controllers`, plus any others — we filter by name later).
 *
 * Returns the end offset (position of the matching `}`) plus the key offsets.
 */
function scanTopLevelKeys(src: string, openBrace: number): { end: number; keys: number[] } {
    let depth = 0;
    let i = openBrace;
    let inString: '"' | "'" | '`' | null = null;
    const keys: number[] = [];
    let atKeyPosition = false;

    while (i < src.length) {
        const c = src[i];

        if (inString) {
            if (c === '\\' && i + 1 < src.length) {
                i += 2;
                continue;
            }
            if (c === inString) inString = null;
            i++;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            inString = c as '"' | "'" | '`';
            i++;
            continue;
        }

        if (c === '{') {
            depth++;
            if (depth === 1) atKeyPosition = true;
            i++;
            continue;
        }
        if (c === '}') {
            depth--;
            if (depth === 0) return { end: i, keys };
            i++;
            continue;
        }
        if (c === ',' && depth === 1) {
            atKeyPosition = true;
            i++;
            continue;
        }
        if (c === ':' && depth === 1) {
            atKeyPosition = false;
            i++;
            continue;
        }

        // Identifier at a key position (depth 1, just after `{` or `,`).
        if (atKeyPosition && depth === 1 && isIdentStart(c)) {
            keys.push(i);
            // Advance past the identifier.
            while (i < src.length && isIdentPart(src[i]!)) i++;
            atKeyPosition = false;
            continue;
        }

        // Skip whitespace — atKeyPosition flag stays.
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
            i++;
            continue;
        }

        // Any other token at a key position invalidates "we're at a key" (e.g. computed key `[X]`,
        // shorthand `...spread`). Field-recall sees these as "no field match".
        atKeyPosition = false;
        i++;
    }
    return { end: openBrace, keys }; // unbalanced — caller treats as "no span"
}

function isIdentStart(c: string | undefined): boolean {
    if (!c) return false;
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
}
function isIdentPart(c: string): boolean {
    return isIdentStart(c) || (c >= '0' && c <= '9');
}

const DI_FIELDS = ['imports', 'providers', 'exports', 'controllers'] as const;
type DiField = (typeof DI_FIELDS)[number];

const FIELD_ROLE: Record<DiField, DiGroundTruthEntry['role']> = {
    imports: 'imports-field',
    providers: 'providers-field',
    exports: 'exports-field',
    controllers: 'controllers-field',
};

export function buildDiReport(
    modules: DiModuleSite[],
    groundTruth: DiGroundTruthEntry[],
): DiValidationReport {
    // Module GT match — by decorator file:line.
    const gtModule = groundTruth.filter((g) => g.role === 'module');
    const modKeyed = indexBy(modules, (m) => `${m.location.file}:${m.location.line}`);
    const { consumed: consumedModules, missed: missedModules } = matchByLineKey(gtModule, modKeyed);

    // Field GT match — by per-field property-name file:line.
    const missedByField = {} as Record<DiField, DiGroundTruthEntry[]>;
    const gtByField = {} as Record<DiField, DiGroundTruthEntry[]>;
    for (const f of DI_FIELDS) {
        const fieldKeyed = indexBy(
            modules.filter((m) => m.fieldLocations[f]),
            (m) => `${m.fieldLocations[f]!.file}:${m.fieldLocations[f]!.line}`,
        );
        gtByField[f] = groundTruth.filter((g) => g.role === FIELD_ROLE[f]);
        missedByField[f] = matchByLineKey(gtByField[f], fieldKeyed).missed;
    }

    const extraModules = modules.filter((m) => !consumedModules.has(m));

    // resolveRate: fraction of decoded refs across all four fields that resolved (not unresolved).
    let totalRefs = 0;
    let resolvedRefs = 0;
    const totals = { imports: 0, providers: 0, exports: 0, controllers: 0 };
    for (const mod of modules) {
        for (const f of DI_FIELDS) {
            for (const r of mod[f]) {
                totalRefs++;
                totals[f]++;
                if (r.kind !== 'unresolved') resolvedRefs++;
            }
        }
    }

    return {
        summary: {
            recallModules: gtModule.length > 0 ? (gtModule.length - missedModules.length) / gtModule.length : 1,
            recallImportsFields:
                gtByField.imports.length > 0
                    ? (gtByField.imports.length - missedByField.imports.length) / gtByField.imports.length
                    : 1,
            recallProvidersFields:
                gtByField.providers.length > 0
                    ? (gtByField.providers.length - missedByField.providers.length) / gtByField.providers.length
                    : 1,
            recallExportsFields:
                gtByField.exports.length > 0
                    ? (gtByField.exports.length - missedByField.exports.length) / gtByField.exports.length
                    : 1,
            recallControllersFields:
                gtByField.controllers.length > 0
                    ? (gtByField.controllers.length - missedByField.controllers.length) / gtByField.controllers.length
                    : 1,
            resolveRate: totalRefs > 0 ? resolvedRefs / totalRefs : 1,
            totalModules: modules.length,
            totalImports: totals.imports,
            totalProviders: totals.providers,
            totalExports: totals.exports,
            totalControllers: totals.controllers,
            groundTruthModules: gtModule.length,
            groundTruthImportsFields: gtByField.imports.length,
            groundTruthProvidersFields: gtByField.providers.length,
            groundTruthExportsFields: gtByField.exports.length,
            groundTruthControllersFields: gtByField.controllers.length,
        },
        modules,
        groundTruth,
        missedModules,
        missedImportsFields: missedByField.imports,
        missedProvidersFields: missedByField.providers,
        missedExportsFields: missedByField.exports,
        missedControllersFields: missedByField.controllers,
        extraModules,
    };
}

