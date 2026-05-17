/**
 * Extracts a short source snippet for a GraphNode using ts-morph.
 *
 * Snippet length is capped at {@link SNIPPET_MAX_CHARS} (400 chars) for most
 * node kinds; `fe-component` and `fe-page` use a relaxed cap of
 * {@link FE_SNIPPET_MAX_CHARS} (800 chars) to include JSDoc + JSX text.
 *
 * Nodes without a `path` (e.g. `nats-subject`, `db-table`) return an empty
 * snippet without a `reason` — that is expected behaviour, not a failure.
 *
 * Contract: **never throws**. All failure modes are returned as values with
 * a structured `reason` string so callers can record them in diagnostics.
 *
 * A8: kind-aware resolution uses `node.anchor` to locate declarations that
 * cannot be found by `node.label` alone:
 *   - `endpoint`:              anchor = "ControllerClass.methodName"
 *   - `db-entity-field`:       anchor = "EntityClass.propertyName"
 *   - `config-field`:          anchor = key string (line-window scan)
 *   - `scoped-marker`:         anchor = "ClassName" (class decorator)
 *   - `provider`/`module`:     anchor = class name
 *   - `fe-component`/`fe-page`: try variable, function, class; include JSDoc + JSX text
 *   - `fe-hook`:               try function, variable
 *   - `fe-route`:              label = URL pattern; anchor is never set; falls back to
 *                              default export then first exported function in the page file
 */
import { readFileSync } from 'node:fs';

import { SyntaxKind } from 'ts-morph';
import type { Node as TsMorphNode } from 'ts-morph';
import type { Project, SourceFile } from 'ts-morph';

import type { GraphNode } from '../core/types.js';
import type { SkipReason } from './types.js';

/** Maximum characters returned in a snippet (most node kinds). */
export const SNIPPET_MAX_CHARS = 400;

/** Relaxed snippet cap for fe-component and fe-page (includes JSDoc + JSX text). */
export const FE_SNIPPET_MAX_CHARS = 800;

/** Relaxed snippet cap for doc-section (heading chain + adaptive-sized chunk). */
export const DOC_SECTION_SNIPPET_MAX_CHARS = 800;

export interface SnippetResult {
    snippet: string;
    /** Set only when extraction failed for a recoverable reason. */
    reason?: SkipReason;
}

/**
 * Extract a representative source snippet for `node` from the ts-morph
 * `project`. Returns an empty snippet (no `reason`) for nodes with no `path`
 * — embedding `label + kind` alone still has value for those anchors.
 *
 * Never throws: all errors become `{ snippet: '', reason: SkipReason }`.
 */
export function extractSnippet(project: Project, node: GraphNode): SnippetResult {
    // Nodes with no path have no source to extract; expected, not a failure.
    if (!node.path) {
        return { snippet: '' };
    }

    // doc-section nodes are Markdown files — ts-morph cannot parse them.
    // Guard here so we never call getSourceFile() on a .md path.
    if (node.kind === 'doc-section') {
        return extractDocSectionSnippet(node);
    }

    try {
        const sourceFile = project.getSourceFile(node.path);
        if (!sourceFile) {
            return { snippet: '', reason: { kind: 'file-not-found', path: node.path } };
        }

        return extractKindAwareSnippet(sourceFile, node);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { snippet: '', reason: { kind: 'ts-morph-error', message } };
    }
}

// ---------------------------------------------------------------------------
// Kind-aware dispatch
// ---------------------------------------------------------------------------

function extractKindAwareSnippet(sf: SourceFile, node: GraphNode): SnippetResult {
    switch (node.kind) {
        case 'provider':
        case 'module':
            return extractClassNode(sf, node, SNIPPET_MAX_CHARS);

        case 'service':
            // service nodes use label as class name (e.g. owner-node.ts)
            return extractClassOrFunctionByLabel(sf, node, SNIPPET_MAX_CHARS);

        case 'endpoint':
            return extractEndpointSnippet(sf, node);

        case 'db-entity-field':
        case 'scoped-marker':
            return extractClassPropertySnippet(sf, node);

        case 'config-field':
            return extractConfigFieldSnippet(sf, node);

        case 'fe-component':
        case 'fe-page':
            return extractFeComponentSnippet(sf, node);

        case 'fe-hook':
            return extractFeHookSnippet(sf, node);

        case 'fe-route':
            // fe-route has path set to the page file; try to extract by anchor (page name)
            return extractFeRouteSnippet(sf, node);

        default:
            // Generic fallback: try class → function → interface → type → variable by label
            return extractClassOrFunctionByLabel(sf, node, SNIPPET_MAX_CHARS);
    }
}

// ---------------------------------------------------------------------------
// Kind-specific extractors
// ---------------------------------------------------------------------------

/**
 * Provider/module: anchor = class name.
 */
function extractClassNode(sf: SourceFile, node: GraphNode, cap: number): SnippetResult {
    const name = node.anchor ?? node.label;
    const cls = sf.getClass(name);
    if (cls) {
        return { snippet: cls.getText().slice(0, cap) };
    }
    // Fallback: label-based search (handles token providers that may be interfaces/vars)
    return extractClassOrFunctionByLabel(sf, node, cap);
}

/**
 * Endpoint: anchor = "ControllerClass.methodName".
 */
function extractEndpointSnippet(sf: SourceFile, node: GraphNode): SnippetResult {
    const anchor = node.anchor;
    if (anchor) {
        const dotIdx = anchor.indexOf('.');
        if (dotIdx !== -1) {
            const className = anchor.slice(0, dotIdx);
            const methodName = anchor.slice(dotIdx + 1);
            if (className && methodName) {
                const cls = sf.getClass(className);
                const method = cls?.getMethod(methodName);
                if (method) {
                    return { snippet: method.getText().slice(0, SNIPPET_MAX_CHARS) };
                }
            }
        }
    }
    return { snippet: '', reason: { kind: 'label-not-located', label: node.anchor ?? node.label } };
}

/**
 * db-entity-field / scoped-marker: anchor = "ClassName.propertyName".
 * Returns the property declaration text including its decorators.
 */
function extractClassPropertySnippet(sf: SourceFile, node: GraphNode): SnippetResult {
    const anchor = node.anchor;
    if (anchor) {
        const dotIdx = anchor.indexOf('.');
        if (dotIdx !== -1) {
            const className = anchor.slice(0, dotIdx);
            const propName = anchor.slice(dotIdx + 1);

            // Primary lookup: class name as declared in anchor.
            // For inherited fields the anchor now uses declaringClass (the base class
            // that owns the @Column decorator), so this direct lookup is always correct.
            // The old scan-all-classes fallback has been removed (it was semantically
            // wrong — it would silently return the first class with a matching property
            // even if the anchor class didn't exist).
            const prop = sf.getClass(className)?.getProperty(propName);

            if (prop) {
                // Include decorator text before the property
                const decorators = prop.getDecorators();
                const decoratorText = decorators.map((d) => d.getText()).join('\n');
                const propText = prop.getText();
                const full = decoratorText ? `${decoratorText}\n${propText}` : propText;
                return { snippet: full.slice(0, SNIPPET_MAX_CHARS) };
            }
        }
    }
    return { snippet: '', reason: { kind: 'label-not-located', label: node.anchor ?? node.label } };
}

/**
 * config-field: anchor = key string (e.g. 'DATABASE_URL').
 * Extracts a ~200-char window around the first occurrence of `get('KEY')` or `process.env.KEY`.
 */
function extractConfigFieldSnippet(sf: SourceFile, node: GraphNode): SnippetResult {
    const key = node.anchor ?? node.label;
    const text = sf.getFullText();

    // Look for configService.get('KEY') / configService.getOrThrow('KEY') / process.env.KEY
    const patterns = [
        `'${key}'`,
        `"${key}"`,
        `process.env.${key}`,
    ];

    let matchIdx = -1;
    for (const pat of patterns) {
        const idx = text.indexOf(pat);
        if (idx !== -1) {
            matchIdx = idx;
            break;
        }
    }

    if (matchIdx === -1) {
        return { snippet: '', reason: { kind: 'label-not-located', label: key } };
    }

    // Extract a ~200-char window around the match
    const start = Math.max(0, matchIdx - 60);
    const end = Math.min(text.length, matchIdx + 140);
    const window = text.slice(start, end).trim();
    return { snippet: window.slice(0, SNIPPET_MAX_CHARS) };
}

/**
 * fe-component / fe-page: try variable, function, class by label.
 * Also includes JSDoc, JSX text literals, and a `classes:` prefix block
 * with deduped className string-literal values.
 * Capped at FE_SNIPPET_MAX_CHARS.
 */
function extractFeComponentSnippet(sf: SourceFile, node: GraphNode): SnippetResult {
    const name = node.anchor ?? node.label;
    const cap = FE_SNIPPET_MAX_CHARS;

    // Try variable declaration (arrow function components: `const Foo = () => ...`)
    const varDecl = sf.getVariableDeclaration(name);
    if (varDecl) {
        // Get the full variable statement (includes `export const`).
        // JSDoc lives on the VariableStatement, not the VariableDeclaration.
        const stmt = varDecl.getVariableStatement();
        const declText = stmt ? stmt.getText() : varDecl.getText();
        const jsDocs = stmt?.getJsDocs() ?? [];
        const jsDocText = jsDocs.map((d: TsMorphNode) => d.getText()).join('\n');
        const jsxText = extractJsxTextFromNode(varDecl, 200);
        const classesBlock = buildClassesBlock(varDecl, cap);
        const full = [classesBlock, jsDocText, declText.slice(0, 400), jsxText].filter(Boolean).join('\n');
        return { snippet: full.slice(0, cap) };
    }

    // Try function declaration
    const fn = sf.getFunction(name);
    if (fn) {
        const jsDocs = fn.getJsDocs();
        const jsDocText = jsDocs.map((d: TsMorphNode) => d.getText()).join('\n');
        const fnText = fn.getText();
        const jsxText = extractJsxTextFromNode(fn, 200);
        const classesBlock = buildClassesBlock(fn, cap);
        const full = [classesBlock, jsDocText, fnText.slice(0, 400), jsxText].filter(Boolean).join('\n');
        return { snippet: full.slice(0, cap) };
    }

    // Try class (class components)
    const cls = sf.getClass(name);
    if (cls) {
        const jsDocs = cls.getJsDocs();
        const jsDocText = jsDocs.map((d: TsMorphNode) => d.getText()).join('\n');
        const classesBlock = buildClassesBlock(cls, cap);
        const full = [classesBlock, jsDocText, cls.getText().slice(0, 400)].filter(Boolean).join('\n');
        return { snippet: full.slice(0, cap) };
    }

    return { snippet: '', reason: { kind: 'label-not-located', label: name } };
}

/**
 * fe-hook: try function, then variable.
 */
function extractFeHookSnippet(sf: SourceFile, node: GraphNode): SnippetResult {
    const name = node.anchor ?? node.label;

    const fn = sf.getFunction(name);
    if (fn) {
        return { snippet: fn.getText().slice(0, SNIPPET_MAX_CHARS) };
    }

    const varDecl = sf.getVariableDeclaration(name);
    if (varDecl) {
        const stmt = varDecl.getVariableStatement();
        return { snippet: (stmt ? stmt.getText() : varDecl.getText()).slice(0, SNIPPET_MAX_CHARS) };
    }

    return { snippet: '', reason: { kind: 'label-not-located', label: name } };
}

/**
 * fe-route: try anchor as component name in the page file, then scan for
 * the first exported function/class/variable (page components are rarely
 * `export default` in App Router — they're named exports).
 */
function extractFeRouteSnippet(sf: SourceFile, node: GraphNode): SnippetResult {
    // If anchor is set use it as the component name
    if (node.anchor) {
        const result = extractFeComponentSnippet(sf, { ...node, label: node.anchor });
        if (result.snippet) return result;
    }

    // Try default export symbol (Pages Router / explicit default)
    const defaultExport = sf.getDefaultExportSymbol();
    if (defaultExport) {
        const decls = defaultExport.getDeclarations();
        if (decls.length > 0) {
            const text = decls[0]!.getText();
            if (text.trim()) return { snippet: text.slice(0, FE_SNIPPET_MAX_CHARS) };
        }
    }

    // Scan exported function/class/variable declarations (App Router page.tsx pattern)
    for (const fn of sf.getFunctions()) {
        if (fn.isExported()) {
            const result = extractFeComponentSnippet(sf, { ...node, label: fn.getName() ?? '' });
            if (result.snippet) return result;
        }
    }
    for (const cls of sf.getClasses()) {
        if (cls.isExported()) {
            return { snippet: cls.getText().slice(0, FE_SNIPPET_MAX_CHARS) };
        }
    }
    for (const varStmt of sf.getVariableStatements()) {
        if (varStmt.isExported()) {
            const text = varStmt.getText();
            if (text.trim()) return { snippet: text.slice(0, FE_SNIPPET_MAX_CHARS) };
        }
    }

    return { snippet: '', reason: { kind: 'label-not-located', label: node.label } };
}

/**
 * Generic fallback: class → function → interface → type alias → variable, by label.
 */
function extractClassOrFunctionByLabel(sf: SourceFile, node: GraphNode, cap: number): SnippetResult {
    const declaration =
        sf.getClass(node.label) ??
        sf.getFunction(node.label) ??
        sf.getInterface(node.label) ??
        sf.getTypeAlias(node.label) ??
        sf.getVariableDeclaration(node.label);

    if (declaration) {
        const text = declaration.getText();
        return { snippet: text.slice(0, cap) };
    }

    return { snippet: '', reason: { kind: 'label-not-located', label: node.label } };
}

// ---------------------------------------------------------------------------
// doc-section extractor
// ---------------------------------------------------------------------------

function formatHeadingChain(chain: readonly string[], fileLabel: string): string {
    if (chain.length === 0) return `# ${fileLabel}\n\n`;
    return `# ${chain.join(' > ')}\n\n`;
}

function extractDocSectionSnippet(node: GraphNode): SnippetResult {
    if (!node.path) {
        return { snippet: '' };
    }
    const meta = node.meta as
        | { headingChain?: string[]; startLine?: number; endLine?: number }
        | undefined;
    if (meta === undefined || meta.startLine === undefined || meta.endLine === undefined) {
        return { snippet: '', reason: { kind: 'label-not-located', label: node.label } };
    }

    let raw: string;
    try {
        raw = readFileSync(node.path, 'utf8');
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return {
            snippet: '',
            reason: code === 'ENOENT'
                ? { kind: 'file-not-found', path: node.path }
                : { kind: 'ts-morph-error', message: (err as Error).message },
        };
    }

    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const start = Math.max(0, meta.startLine - 1);
    const end = Math.min(lines.length, meta.endLine);
    const bodySlice = lines.slice(start, end).join('\n');

    const prefix = formatHeadingChain(meta.headingChain ?? [], node.label);
    let snippet = prefix + bodySlice;
    if (snippet.length > DOC_SECTION_SNIPPET_MAX_CHARS) {
        snippet = snippet.slice(0, DOC_SECTION_SNIPPET_MAX_CHARS);
    }
    return { snippet };
}

// ---------------------------------------------------------------------------
// JSX text extraction helper
// ---------------------------------------------------------------------------

/**
 * Walk a node's descendants and collect the first `maxChars` characters of
 * JsxText content. Returns empty string if none found.
 *
 * Used to enrich fe-component snippets with rendered text.
 */
function extractJsxTextFromNode(node: TsMorphNode, maxChars: number): string {
    const texts: string[] = [];
    let total = 0;

    function walk(n: TsMorphNode): void {
        if (total >= maxChars) return;
        if (n.getKind() === SyntaxKind.JsxText) {
            const t = n.getText().trim();
            if (t) {
                texts.push(t);
                total += t.length;
            }
        }
        for (const child of n.getChildren()) {
            if (total >= maxChars) break;
            walk(child);
        }
    }

    walk(node);
    return texts.join(' ').slice(0, maxChars);
}

/**
 * Walk a node's descendants and collect all `className="..."` string-literal
 * values (skips template-literal and expression-based className attributes).
 * Returns a deduped array of individual class tokens.
 */
function collectClassNameTokens(node: TsMorphNode): string[] {
    const seen = new Set<string>();
    const tokens: string[] = [];

    function walk(n: TsMorphNode): void {
        // Look for JsxAttribute nodes whose name is "className"
        if (n.getKind() === SyntaxKind.JsxAttribute) {
            const attrName = n.getChildren()[0];
            if (attrName?.getText() === 'className') {
                // The initializer is the part after `=`
                // Structure: JsxAttribute → [ Identifier("className"), EqualsToken, JsxExpression | StringLiteral ]
                const children = n.getChildren();
                // Find the initializer — either StringLiteral or JsxExpression wrapping a StringLiteral
                for (const child of children) {
                    if (child.getKind() === SyntaxKind.StringLiteral) {
                        // Narrow Node<Node> to StringLiteral so .getLiteralText() is available.
                        const raw = child.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText();
                        for (const tok of raw.split(/\s+/).filter(Boolean)) {
                            if (!seen.has(tok)) {
                                seen.add(tok);
                                tokens.push(tok);
                            }
                        }
                    }
                }
            }
        }
        for (const child of n.getChildren()) {
            walk(child);
        }
    }

    walk(node);
    return tokens;
}

/**
 * Build the `classes: <tokens>` prefix line for a fe-component snippet.
 *
 * The line is truncated at a whole-token boundary so it never bisects a class
 * name. If there are no class tokens, returns an empty string (no prefix line).
 *
 * Budget: reserves up to `Math.floor(cap / 4)` characters for the classes block
 * to keep headroom for the declaration body + JSDoc + JSX text.
 */
function buildClassesBlock(node: TsMorphNode, cap: number): string {
    const tokens = collectClassNameTokens(node);
    if (tokens.length === 0) return '';

    const PREFIX = 'classes: ';
    const budget = Math.floor(cap / 4); // up to 200 chars for fe-component (cap=800)
    let line = PREFIX;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        const separator = i === 0 ? '' : ' ';
        const candidate = line + separator + token;
        if (candidate.length > budget) break;
        line = candidate;
    }

    // If nothing was added beyond the prefix (all tokens exceeded budget), return empty
    if (line === PREFIX) return '';
    return line;
}
