import {
    ArrowFunction,
    FunctionDeclaration,
    ObjectLiteralExpression,
    Project,
    PropertyAssignment,
    SourceFile,
    SyntaxKind,
    TemplateExpression,
    VariableDeclaration,
    Node,
} from 'ts-morph';

import type { ResolvedSubject } from '../types.js';

/**
 * Pre-pass indexer: walks all `export const NAME = ...` declarations across the project
 * and builds a flat map keyed by qualified path:
 *
 *   export const NATS_PATTERNS = { FEED: { INVALIDATE: 'feed.invalidate' } };
 *   → { "NATS_PATTERNS.FEED.INVALIDATE": { kind: 'literal', value: 'feed.invalidate' } }
 *
 *   export const APP_NATS_SUBJECTS = {
 *     CALLBACKS: { HANDLE: (appId: string) => `app.${appId}.callback.handle` }
 *   };
 *   → { "APP_NATS_SUBJECTS.CALLBACKS.HANDLE": { kind: 'fn-template', headTpl, params } }
 *
 * This sidesteps cross-file TypeChecker symbol resolution and works regardless of
 * tsconfig path mappings.
 *
 * Enums (`export enum X { A = 'a' }`) are also indexed.
 */

export interface FnTemplateEntry {
    kind: 'fn-template';
    /** raw template head + spans, with parameter names */
    paramNames: string[];
    /** head + alternating literal/expr fragments; expressions stored as raw text */
    fragments: Array<{ type: 'str'; value: string } | { type: 'param'; name: string } | { type: 'expr'; raw: string }>;
}

export type IndexEntry = ResolvedSubject | FnTemplateEntry;

export class ConstantIndex {
    private map = new Map<string, IndexEntry>();

    has(key: string): boolean {
        return this.map.has(key);
    }
    get(key: string): IndexEntry | undefined {
        return this.map.get(key);
    }
    size(): number {
        return this.map.size;
    }
    keys(): IterableIterator<string> {
        return this.map.keys();
    }
}

export function buildConstantIndex(project: Project): ConstantIndex {
    const idx = new ConstantIndex();
    const map = (idx as any).map as Map<string, IndexEntry>;

    // Pass 1 — gather raw declarations into the map.
    for (const sf of project.getSourceFiles()) {
        if (isExcludedForIndex(sf)) continue;

        // top-level `export const X = ...`
        for (const ve of sf.getVariableStatements()) {
            if (!ve.hasExportKeyword()) continue;
            for (const decl of ve.getDeclarations()) {
                const name = decl.getName();
                const init = decl.getInitializer();
                if (!init || !name) continue;
                walkConstValue(name, init, map);
            }
        }

        // top-level `export enum X { ... }`
        for (const en of sf.getEnums()) {
            if (!en.hasExportKeyword()) continue;
            const name = en.getName();
            for (const member of en.getMembers()) {
                const mName = member.getName();
                const init = member.getInitializer();
                if (!init) continue;
                if (
                    init.getKind() === SyntaxKind.StringLiteral ||
                    init.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
                ) {
                    map.set(`${name}.${mName}`, {
                        kind: 'literal',
                        value: (init as any).getLiteralText() as string,
                    });
                }
            }
        }

        // top-level `export function NAME(...) { return ... }`
        for (const fn of sf.getFunctions()) {
            if (!fn.hasExportKeyword()) continue;
            const name = fn.getName();
            if (!name) continue;
            indexFunctionDecl(name, fn, map);
        }
    }

    // Pass 2 — resolve identifier references inside template-pattern entries.
    // E.g. `CRON_JOB_EXECUTION_COMPLETE: \`${CRON_JOB_EXECUTION_COMPLETE_SUFFIX}.>\``
    // is stored as fn-template-ish "pattern" entry with placeholders; we substitute now.
    resolveCrossReferences(map);

    return idx;
}

function indexFunctionDecl(qname: string, fn: FunctionDeclaration, out: Map<string, IndexEntry>): void {
    const body = fn.getBody();
    if (!body || !Node.isBlock(body)) return;
    const ret = body.getStatements().find((s) => s.getKind() === SyntaxKind.ReturnStatement);
    if (!ret) return;
    const retExpr = (ret as any).getExpression();
    if (!retExpr) return;
    const paramNames = fn.getParameters().map((p) => p.getName());

    if (
        retExpr.getKind() === SyntaxKind.StringLiteral ||
        retExpr.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
        out.set(qname, { kind: 'literal', value: (retExpr as any).getLiteralText() });
        return;
    }

    if (retExpr.getKind() === SyntaxKind.TemplateExpression) {
        const tmpl = retExpr as TemplateExpression;
        const fragments: FnTemplateEntry['fragments'] = [
            { type: 'str', value: tmpl.getHead().getLiteralText() },
        ];
        for (const span of tmpl.getTemplateSpans()) {
            const e = span.getExpression();
            if (e.getKind() === SyntaxKind.Identifier && paramNames.includes(e.getText())) {
                fragments.push({ type: 'param', name: e.getText() });
            } else {
                fragments.push({ type: 'expr', raw: e.getText() });
            }
            fragments.push({ type: 'str', value: span.getLiteral().getLiteralText() });
        }
        out.set(qname, { kind: 'fn-template', paramNames, fragments });
    }
}

/**
 * Some patterns reference other constants in their template strings, e.g.
 *   CRON_JOB_EXECUTION_COMPLETE: `${CRON_JOB_EXECUTION_COMPLETE_SUFFIX}.>`
 * These are stored initially as pattern with placeholder for the expr.
 * We post-process to substitute resolved constant lookups.
 *
 * Done iteratively up to 3 passes for chained references.
 */
function resolveCrossReferences(map: Map<string, IndexEntry>): void {
    for (let pass = 0; pass < 3; pass++) {
        let changed = false;
        for (const [key, entry] of map) {
            if (entry.kind !== 'pattern') continue;
            // try substituting each placeholder if it's a known qualified name
            let pattern = entry.pattern;
            let changedHere = false;
            const remaining: string[] = [];
            let consumed = 0;
            // pattern has '*' as placeholders, in same order as `placeholders` array
            for (const ph of entry.placeholders) {
                const sub = map.get(ph);
                const starIdx = pattern.indexOf('*', consumed);
                if (starIdx === -1) {
                    remaining.push(ph);
                    continue;
                }
                if (sub && sub.kind === 'literal') {
                    pattern = pattern.slice(0, starIdx) + sub.value + pattern.slice(starIdx + 1);
                    consumed = starIdx + sub.value.length;
                    changedHere = true;
                } else {
                    remaining.push(ph);
                    consumed = starIdx + 1;
                }
            }
            if (changedHere) {
                if (remaining.length === 0) {
                    map.set(key, { kind: 'literal', value: pattern });
                } else {
                    map.set(key, { kind: 'pattern', pattern, placeholders: remaining });
                }
                changed = true;
            }
        }
        if (!changed) break;
    }
}

function isExcludedForIndex(sf: SourceFile): boolean {
    const p = sf.getFilePath();
    if (p.includes('/node_modules/')) return true;
    if (p.includes('/dist/')) return true;
    if (p.includes('/.claude/')) return true;
    if (p.includes('/.worktrees/')) return true;
    if (p.endsWith('.d.ts')) return true;
    if (p.endsWith('.spec.ts') || p.endsWith('.test.ts')) return true;
    return false;
}

function walkConstValue(qname: string, node: Node, out: Map<string, IndexEntry>): void {
    const kind = node.getKind();

    if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
        out.set(qname, { kind: 'literal', value: (node as any).getLiteralText() });
        return;
    }

    if (kind === SyntaxKind.AsExpression || kind === SyntaxKind.ParenthesizedExpression) {
        const inner = (node as any).getExpression?.();
        if (inner) walkConstValue(qname, inner, out);
        return;
    }

    if (kind === SyntaxKind.ObjectLiteralExpression) {
        const obj = node as ObjectLiteralExpression;
        for (const prop of obj.getProperties()) {
            if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
            const pa = prop as PropertyAssignment;
            const propName = pa.getName();
            const init = pa.getInitializer();
            if (!init) continue;
            walkConstValue(`${qname}.${propName}`, init, out);
        }
        return;
    }

    if (kind === SyntaxKind.ArrowFunction) {
        const arrow = node as ArrowFunction;
        const body = arrow.getBody();
        const paramNames = arrow.getParameters().map((p) => p.getName());

        let target: Node | undefined = body;
        if (Node.isBlock(body)) {
            const ret = body.getStatements().find((s) => s.getKind() === SyntaxKind.ReturnStatement);
            target = ret ? (ret as any).getExpression() : undefined;
        }
        if (!target) return;

        if (
            target.getKind() === SyntaxKind.StringLiteral ||
            target.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
        ) {
            out.set(qname, { kind: 'literal', value: (target as any).getLiteralText() });
            return;
        }

        if (target.getKind() === SyntaxKind.TemplateExpression) {
            const tmpl = target as any;
            const fragments: FnTemplateEntry['fragments'] = [
                { type: 'str', value: tmpl.getHead().getLiteralText() },
            ];
            for (const span of tmpl.getTemplateSpans()) {
                const e = span.getExpression();
                if (e.getKind() === SyntaxKind.Identifier && paramNames.includes(e.getText())) {
                    fragments.push({ type: 'param', name: e.getText() });
                } else {
                    fragments.push({ type: 'expr', raw: e.getText() });
                }
                fragments.push({ type: 'str', value: span.getLiteral().getLiteralText() });
            }
            out.set(qname, { kind: 'fn-template', paramNames, fragments });
            return;
        }

        // unsupported arrow body
        return;
    }

    if (kind === SyntaxKind.PropertyAccessExpression || kind === SyntaxKind.Identifier) {
        // Alias to another const: NATS_PATTERNS.X = OTHER.Y — record as alias placeholder
        // The cross-reference pass can resolve this if target is later in the index.
        out.set(qname, {
            kind: 'pattern',
            pattern: '*',
            placeholders: [node.getText()],
        });
        return;
    }

    if (kind === SyntaxKind.TemplateExpression) {
        const tmpl = node as TemplateExpression;
        let pattern = tmpl.getHead().getLiteralText();
        const placeholders: string[] = [];
        let hasPlaceholder = false;
        for (const span of tmpl.getTemplateSpans()) {
            const e = span.getExpression();
            pattern += '*';
            placeholders.push(e.getText());
            hasPlaceholder = true;
            pattern += span.getLiteral().getLiteralText();
        }
        if (!hasPlaceholder) {
            out.set(qname, { kind: 'literal', value: pattern });
        } else {
            out.set(qname, { kind: 'pattern', pattern, placeholders });
        }
        return;
    }

    // anything else — skip
}

/**
 * Apply a fn-template entry to the call arguments (as raw text strings).
 * Returns a resolved subject (literal if all params are literals, pattern otherwise).
 */
export function applyFnTemplate(entry: FnTemplateEntry, args: string[]): ResolvedSubject {
    let out = '';
    const placeholders: string[] = [];
    let hasPlaceholder = false;

    for (const frag of entry.fragments) {
        if (frag.type === 'str') {
            out += frag.value;
        } else if (frag.type === 'param') {
            const idx = entry.paramNames.indexOf(frag.name);
            const arg = idx >= 0 ? args[idx] : undefined;
            const literalArg = tryExtractLiteral(arg ?? '');
            if (literalArg !== null) {
                out += literalArg;
            } else {
                out += '*';
                hasPlaceholder = true;
                placeholders.push(arg ?? frag.name);
            }
        } else {
            out += '*';
            hasPlaceholder = true;
            placeholders.push(frag.raw);
        }
    }

    if (!hasPlaceholder) return { kind: 'literal', value: out };
    return { kind: 'pattern', pattern: out, placeholders };
}

function tryExtractLiteral(s: string): string | null {
    const trimmed = s.trim();
    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
        return trimmed.slice(1, -1);
    }
    if (trimmed.startsWith('`') && trimmed.endsWith('`') && !trimmed.includes('${')) {
        return trimmed.slice(1, -1);
    }
    return null;
}
