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

/** Discriminated union result from loadMessagesFromJson. */
export type LoadMessagesResult =
    | { ok: true; messages: MessagesObject }
    | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a JSON string into a MessagesObject.
 * Returns a discriminated union so callers can distinguish parse errors from
 * valid-but-empty results.
 */
export function loadMessagesFromJson(jsonStr: string): LoadMessagesResult {
    try {
        const parsed = JSON.parse(jsonStr);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { ok: true, messages: parsed as MessagesObject };
        }
        return { ok: false, error: 'parsed value is not a plain object' };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
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

    // Collect aliased t-binding names (e.g. const { t: translate } = useTranslation())
    const tBindings = collectTBindings(sf, library);

    // Walk all call expressions for `t(...)` calls
    const rawKeys = collectRawKeys(sf, tBindings);

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
 *
 * P0-2: If the namespace argument is not a string literal (e.g. a variable),
 * emit a WARNING and skip it — do NOT add the identifier text as a namespace
 * prefix (that would silently poison all key resolutions in the file).
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
                const kind = first.getKind();
                if (
                    kind === SyntaxKind.StringLiteral ||
                    kind === SyntaxKind.NoSubstitutionTemplateLiteral
                ) {
                    const text = first.getText().replace(/^['"`]|['"`]$/g, '');
                    namespaces.add(text);
                } else {
                    // P0-2: non-literal namespace argument — skip and warn
                    process.stderr.write(
                        `[arch-graph fe-i18n] WARNING: non-literal namespace argument to ${hookName}() in ${sf.getFilePath()} — skipping namespace prefix, falling back to bare keys\n`,
                    );
                    // Do not add anything; bare-key fallback is ensured below
                }
            }
        }
    }

    // If no hook calls found (or all namespaces were skipped), treat as no namespace
    if (namespaces.size === 0) namespaces.add('');
    return namespaces;
}

/**
 * Collect the local binding names that are assigned to the `t` export from
 * useTranslation() / useTranslations().
 *
 * P1-A: handles both:
 *   const t = useTranslations()         → adds 't'
 *   const { t } = useTranslation()      → adds 't'
 *   const { t: translate } = ...        → adds 'translate'
 *
 * When no aliased bindings are found, returns a Set containing just 't'
 * so the existing behaviour is unchanged.
 */
function collectTBindings(sf: SourceFile, library: I18nLibrary): Set<string> {
    const hookName = library === 'next-intl' ? 'useTranslations' : 'useTranslation';
    const bindings = new Set<string>();

    for (const varStmt of sf.getDescendantsOfKind(SyntaxKind.VariableStatement)) {
        for (const decl of varStmt.getDeclarationList().getDeclarations()) {
            const init = decl.getInitializer();
            if (!init) continue;

            // Accept both `useTranslation()` directly and `useTranslation('ns')`
            const isHookCall =
                init.getKind() === SyntaxKind.CallExpression &&
                init.getFirstChild()?.getText() === hookName;

            if (isHookCall) {
                // Pattern: const t = useTranslations()  →  identifier binding
                const nameNode = decl.getNameNode();
                if (nameNode.getKind() === SyntaxKind.Identifier) {
                    bindings.add(nameNode.getText());
                }
                // Pattern: const { t } = useTranslation()  OR  const { t: translate } = ...
                if (nameNode.getKind() === SyntaxKind.ObjectBindingPattern) {
                    for (const element of nameNode.getDescendantsOfKind(SyntaxKind.BindingElement)) {
                        const propNameNode = element.getPropertyNameNode();
                        if (propNameNode && propNameNode.getText() === 't') {
                            // const { t: alias } = ...  → alias is the local name
                            const localName = element.getNameNode().getText();
                            bindings.add(localName);
                        } else if (!propNameNode) {
                            // const { t } = ...  → no rename, local name IS 't'
                            const localName = element.getNameNode().getText();
                            if (localName === 't') bindings.add(localName);
                        }
                    }
                }
            }
        }
    }

    // If nothing collected, fall back to bare 't' (keeps existing tests green)
    if (bindings.size === 0) bindings.add('t');
    return bindings;
}

interface RawKey {
    key: string;
    /** Namespace of the t() caller variable (for next-intl), or '' */
    callSiteNamespace: string;
}

/**
 * Walk the source file for `t('key')` call expressions.
 * Collects all string literal arguments of calls whose expression matches a
 * known t-binding name (handles aliased t, e.g. `translate('key')`).
 *
 * P1-B: emits a single per-file WARNING when at least one dynamic key argument
 * is encountered and skipped.
 */
function collectRawKeys(sf: SourceFile, tBindings: Set<string>): RawKey[] {
    const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
    const results: RawKey[] = [];
    let dynamicKeySkipped = false;

    for (const call of calls) {
        const expr = call.getExpression();
        const exprText = expr.getText();

        // Match any t-binding name (default: 't', or aliased name)
        if (!tBindings.has(exprText)) continue;

        const args = call.getArguments();
        if (args.length === 0) continue;

        const first = args[0];
        if (!first) continue;

        // Must be a string literal
        const kind = first.getKind();
        if (
            kind !== SyntaxKind.StringLiteral &&
            kind !== SyntaxKind.NoSubstitutionTemplateLiteral
        ) {
            // P1-B: dynamic key — skip but flag for per-file warn
            dynamicKeySkipped = true;
            continue;
        }

        const key = first.getText().replace(/^['"`]|['"`]$/g, '');
        if (!key) continue;

        results.push({ key, callSiteNamespace: '' });
    }

    // P1-B: emit exactly one warning per file if any dynamic keys were skipped
    if (dynamicKeySkipped) {
        process.stderr.write(
            `[arch-graph fe-i18n] WARNING: dynamic key argument(s) to t() in ${sf.getFilePath()} — skipped (static analysis only)\n`,
        );
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
