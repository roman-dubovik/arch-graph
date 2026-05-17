/**
 * i18n string resolver for fe-components.
 *
 * Detects the i18n library used in a source file (next-intl / react-i18next),
 * walks the file for t('key') call expressions, and resolves each key against
 * a pre-loaded messages object.
 *
 * Design decisions:
 *   - Library detection is per-file (import scan), not project-wide.
 *   - Key resolution prefers Russian locale (ru.json) over English — callers
 *     should pass ru.json contents first and fall back to en.json externally.
 *   - Missing keys are silently skipped with a stderr diagnostic (AC-B4).
 *   - Unrecognised libraries → empty array, no error (AC-B3).
 *   - useTranslations('namespace') is supported for next-intl namespace prefix.
 */

import { SyntaxKind, type SourceFile } from 'ts-morph';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Nested message object shape (e.g. { common: { apply: "Применить" } }). */
export type MessagesObject = Record<string, unknown>;

/** Recognised i18n library variants (v1 scope). */
type I18nLibrary = 'next-intl' | 'react-i18next' | null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a JSON string into a MessagesObject.
 * Returns {} on parse error — callers should treat an empty object as "no messages".
 */
export function loadMessagesFromJson(jsonStr: string): MessagesObject {
    try {
        const parsed = JSON.parse(jsonStr);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as MessagesObject;
        }
        return {};
    } catch {
        return {};
    }
}

/**
 * Extract resolved i18n strings from a source file.
 *
 * Steps:
 *   1. Detect library by scanning import declarations.
 *   2. If no recognised library → return [] (AC-B3).
 *   3. Walk for t('key') call expressions.
 *   4. For next-intl, detect useTranslations('ns') namespace prefix.
 *   5. Resolve each key against `messages`. Skip unresolvable keys (AC-B4).
 *   6. Deduplicate resolved strings.
 *
 * @param sf       ts-morph SourceFile to analyse.
 * @param messages Pre-loaded messages object (typically from ru.json).
 * @returns        Deduplicated array of resolved human-readable strings.
 */
export function extractI18nStringsForFile(
    sf: SourceFile,
    messages: MessagesObject,
): string[] {
    const library = detectLibrary(sf);
    if (!library) return [];

    // Collect namespace prefixes from useTranslations('ns') / useTranslation('ns') calls
    const namespaces = collectNamespaces(sf, library);

    // Walk all call expressions for `t(...)` calls
    const rawKeys = collectRawKeys(sf);

    const resolved: string[] = [];
    const seen = new Set<string>();

    for (const { key, callSiteNamespace } of rawKeys) {
        // Determine effective key to look up:
        // For next-intl useTranslations('ns'), the t() call uses a relative key.
        // We try: namespace.key, then key bare.
        const candidateKeys = buildCandidateKeys(key, callSiteNamespace, namespaces, library);

        let found = false;
        for (const candidate of candidateKeys) {
            const value = resolveKey(candidate, messages);
            if (value !== undefined) {
                if (!seen.has(value)) {
                    seen.add(value);
                    resolved.push(value);
                }
                found = true;
                break;
            }
        }

        if (!found) {
            process.stderr.write(
                `[arch-graph fe-i18n] key not found: "${key}" in ${sf.getFilePath()}\n`,
            );
        }
    }

    return resolved;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Detect which i18n library (if any) is imported in this source file. */
function detectLibrary(sf: SourceFile): I18nLibrary {
    for (const imp of sf.getImportDeclarations()) {
        const spec = imp.getModuleSpecifierValue();
        if (spec === 'next-intl') return 'next-intl';
        if (spec === 'react-i18next') return 'react-i18next';
    }
    return null;
}

/**
 * Collect namespace strings from useTranslations('ns') or useTranslation('ns') calls.
 * Returns a Set of namespace strings found in the file.
 * An empty-string entry means "no namespace / root level".
 */
function collectNamespaces(sf: SourceFile, library: I18nLibrary): Set<string> {
    const hookName = library === 'next-intl' ? 'useTranslations' : 'useTranslation';
    const namespaces = new Set<string>();

    const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of calls) {
        const expr = call.getExpression().getText();
        if (expr !== hookName) continue;

        const args = call.getArguments();
        if (args.length === 0) {
            namespaces.add('');
        } else {
            const first = args[0];
            if (first) {
                const text = first.getText().replace(/^['"`]|['"`]$/g, '');
                namespaces.add(text);
            }
        }
    }

    // If no hook calls found, treat as no namespace
    if (namespaces.size === 0) namespaces.add('');
    return namespaces;
}

interface RawKey {
    key: string;
    /** Namespace of the t() caller variable (for next-intl), or '' */
    callSiteNamespace: string;
}

/**
 * Walk the source file for `t('key')` call expressions.
 * Collects all string literal arguments of calls whose expression is a bare `t`.
 * Also handles `t('key')` where t is destructured from useTranslation().
 */
function collectRawKeys(sf: SourceFile): RawKey[] {
    const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
    const results: RawKey[] = [];

    for (const call of calls) {
        const expr = call.getExpression();
        const exprText = expr.getText();

        // Match bare `t(...)` calls
        if (exprText !== 't') continue;

        const args = call.getArguments();
        if (args.length === 0) continue;

        const first = args[0];
        if (!first) continue;

        // Must be a string literal
        const kind = first.getKind();
        if (
            kind !== SyntaxKind.StringLiteral &&
            kind !== SyntaxKind.NoSubstitutionTemplateLiteral
        ) continue;

        const key = first.getText().replace(/^['"`]|['"`]$/g, '');
        if (!key) continue;

        results.push({ key, callSiteNamespace: '' });
    }

    return results;
}

/**
 * Build the ordered list of dotted keys to try when resolving a raw key.
 *
 * For next-intl with namespace: [namespace + '.' + key, key]
 * Without namespace: [key]
 */
function buildCandidateKeys(
    key: string,
    _callSiteNamespace: string,
    namespaces: Set<string>,
    _library: I18nLibrary,
): string[] {
    const candidates: string[] = [];

    for (const ns of namespaces) {
        if (ns) {
            candidates.push(`${ns}.${key}`);
        }
    }
    // Always try the key as-is (covers no-namespace + react-i18next full dotted keys)
    candidates.push(key);

    return candidates;
}

/**
 * Resolve a dotted key path against the messages object.
 * e.g. "common.apply" → messages.common.apply → "Применить"
 */
function resolveKey(dottedKey: string, messages: MessagesObject): string | undefined {
    const parts = dottedKey.split('.');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let current: any = messages;
    for (const part of parts) {
        if (current === null || typeof current !== 'object') return undefined;
        current = current[part];
    }
    if (typeof current === 'string') return current;
    return undefined;
}
