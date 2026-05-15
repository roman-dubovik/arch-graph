import {
    ArrowFunction,
    FunctionDeclaration,
    Node,
    ObjectLiteralExpression,
    Project,
    PropertyAssignment,
    SourceFile,
    SyntaxKind,
    TemplateExpression,
} from 'ts-morph';

import type { ResolvedSubject } from '../../core/types.js';

/** Pre-pass: indexes exported `const`/`enum`/`function` subjects by qualified name for resolveSubject. */

export interface FnTemplateEntry {
    kind: 'fn-template';
    paramNames: string[];
    fragments: Array<{ type: 'str'; value: string } | { type: 'param'; name: string } | { type: 'expr'; raw: string }>;
}

export type IndexEntry = ResolvedSubject | FnTemplateEntry;

export class ConstantIndex {
    readonly map = new Map<string, IndexEntry>();

    get(key: string): IndexEntry | undefined {
        return this.map.get(key);
    }
    size(): number {
        return this.map.size;
    }
}

export function buildConstantIndex(project: Project): ConstantIndex {
    const idx = new ConstantIndex();
    const map = idx.map;

    for (const sf of project.getSourceFiles()) {
        if (isExcludedForIndex(sf)) continue;

        for (const ve of sf.getVariableStatements()) {
            if (!ve.hasExportKeyword()) continue;
            for (const decl of ve.getDeclarations()) {
                const name = decl.getName();
                const init = decl.getInitializer();
                if (!init || !name) continue;
                walkConstValue(name, init, map);
            }
        }

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
                        value: (init as unknown as { getLiteralText: () => string }).getLiteralText(),
                    });
                }
            }
        }

        for (const fn of sf.getFunctions()) {
            if (!fn.hasExportKeyword()) continue;
            const name = fn.getName();
            if (!name) continue;
            indexFunctionDecl(name, fn, map);
        }
    }

    resolveCrossReferences(map);
    return idx;
}

function indexFunctionDecl(qname: string, fn: FunctionDeclaration, out: Map<string, IndexEntry>): void {
    const body = fn.getBody();
    if (!body || !Node.isBlock(body)) return;
    const ret = body.getStatements().find((s) => s.getKind() === SyntaxKind.ReturnStatement);
    if (!ret) return;
    const retExpr = (ret as unknown as { getExpression: () => Node | undefined }).getExpression();
    if (!retExpr) return;
    const paramNames = fn.getParameters().map((p) => p.getName());

    if (
        retExpr.getKind() === SyntaxKind.StringLiteral ||
        retExpr.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
        out.set(qname, {
            kind: 'literal',
            value: (retExpr as unknown as { getLiteralText: () => string }).getLiteralText(),
        });
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

// Cap is a safety bound, not a correctness limit — the loop terminates at the
// first pass with no changes. Cap exists only to guarantee progress on a malformed
// (cyclic) input. If a project ever hits the cap, the warning surfaces the chain
// instead of silently truncating a half-resolved pattern.
const CROSS_REF_PASSES_CAP = 16;

function resolveCrossReferences(map: Map<string, IndexEntry>): void {
    for (let pass = 0; pass < CROSS_REF_PASSES_CAP; pass++) {
        let changed = false;
        for (const [key, entry] of map) {
            if (entry.kind !== 'pattern') continue;
            let pattern = entry.pattern;
            let changedHere = false;
            const remaining: string[] = [];
            let consumed = 0;
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
        if (!changed) return;
    }
    process.stderr.write(
        `[nats.constant-index] WARNING: cross-reference loop hit pass cap (${CROSS_REF_PASSES_CAP}); ` +
            `some patterns may remain unresolved. Likely cause: cyclic const definitions.\n`,
    );
}

const EXCLUDED_INDEX_SUBSTRINGS = ['/node_modules/', '/dist/', '/.claude/', '/.worktrees/'];

function isExcludedForIndex(sf: SourceFile): boolean {
    const p = sf.getFilePath();
    if (EXCLUDED_INDEX_SUBSTRINGS.some((s) => p.includes(s))) return true;
    return p.endsWith('.d.ts') || p.endsWith('.spec.ts') || p.endsWith('.test.ts');
}

function walkConstValue(qname: string, node: Node, out: Map<string, IndexEntry>): void {
    const kind = node.getKind();

    if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
        out.set(qname, {
            kind: 'literal',
            value: (node as unknown as { getLiteralText: () => string }).getLiteralText(),
        });
        return;
    }

    if (kind === SyntaxKind.AsExpression || kind === SyntaxKind.ParenthesizedExpression) {
        const inner = (node as unknown as { getExpression?: () => Node | undefined }).getExpression?.();
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
            target = ret
                ? (ret as unknown as { getExpression: () => Node | undefined }).getExpression()
                : undefined;
        }
        if (!target) return;

        if (
            target.getKind() === SyntaxKind.StringLiteral ||
            target.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
        ) {
            out.set(qname, {
                kind: 'literal',
                value: (target as unknown as { getLiteralText: () => string }).getLiteralText(),
            });
            return;
        }

        if (target.getKind() === SyntaxKind.TemplateExpression) {
            const tmpl = target as TemplateExpression;
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

        return;
    }

    if (kind === SyntaxKind.PropertyAccessExpression || kind === SyntaxKind.Identifier) {
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
        for (const span of tmpl.getTemplateSpans()) {
            pattern += '*';
            placeholders.push(span.getExpression().getText());
            pattern += span.getLiteral().getLiteralText();
        }
        if (placeholders.length === 0) {
            out.set(qname, { kind: 'literal', value: pattern });
        } else {
            out.set(qname, { kind: 'pattern', pattern, placeholders });
        }
        return;
    }
}

export function applyFnTemplate(entry: FnTemplateEntry, args: string[]): ResolvedSubject {
    let out = '';
    const placeholders: string[] = [];

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
                placeholders.push(arg ?? frag.name);
            }
        } else {
            out += '*';
            placeholders.push(frag.raw);
        }
    }

    if (placeholders.length === 0) return { kind: 'literal', value: out };
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
