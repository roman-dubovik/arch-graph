import {
    ArrowFunction,
    CallExpression,
    Decorator,
    FunctionDeclaration,
    Identifier,
    Node,
    Project,
    PropertyAccessExpression,
    PropertyAssignment,
    PropertyDeclaration,
    PropertySignature,
    SourceFile,
    StringLiteral,
    SyntaxKind,
    TemplateExpression,
    Type,
    VariableDeclaration,
} from 'ts-morph';

import type { ArchGraphConfig } from '../../core/config.js';
import type { NatsCallSite, ResolvedSubject, SourceLoc, WrapperApi } from '../../core/types.js';
import { applyFnTemplate, buildConstantIndex, ConstantIndex } from './constant-index.js';

/**
 * NATS extractor — finds publishers, subscribers, and resolves subject strings.
 * Validated in POC on 5 projects (detection 100%, classification 99.3-100%).
 * See /poc/src/extractors/nats.extractor.ts for the original.
 */

const STANDARD_PUBLISH: WrapperApi[] = [
    { class: 'ClientProxy', methods: ['send', 'emit'] },
    { class: 'ClientNats', methods: ['send', 'emit'] },
];
const STANDARD_SUBSCRIBE_DECORATORS = new Set(['MessagePattern', 'EventPattern']);

const MAX_RESOLVE_DEPTH = 6;

interface ExtractorCtx {
    cfg: ArchGraphConfig;
    project: Project;
    publishApis: WrapperApi[];
    subscribeMethodApis: WrapperApi[];
    constIndex: ConstantIndex;
}

export async function extractNats(cfg: ArchGraphConfig, project: Project): Promise<NatsCallSite[]> {
    process.stdout.write(`  building constant index...\n`);
    const t0 = Date.now();
    const constIndex = buildConstantIndex(project);
    process.stdout.write(`    indexed ${constIndex.size()} entries in ${Date.now() - t0}ms\n`);

    const ctx: ExtractorCtx = {
        cfg,
        project,
        publishApis: [...STANDARD_PUBLISH, ...(cfg.nats?.wrapperPublishApis ?? [])],
        subscribeMethodApis: cfg.nats?.wrapperSubscribeApis ?? [],
        constIndex,
    };

    const out: NatsCallSite[] = [];
    for (const sf of project.getSourceFiles()) {
        if (isExcluded(sf, cfg)) continue;
        try {
            collectFromFile(sf, ctx, out);
        } catch (err) {
            process.stderr.write(
                `[nats.extractor] error in ${sf.getFilePath()}: ${(err as Error).message}\n`,
            );
        }
    }
    return out;
}

function isExcluded(sf: SourceFile, cfg: ArchGraphConfig): boolean {
    const path = sf.getFilePath();
    if (path.includes('/node_modules/')) return true;
    if (path.includes('/dist/')) return true;
    if (path.includes('/.claude/')) return true;
    if (path.includes('/.worktrees/')) return true;
    if (path.endsWith('.d.ts')) return true;
    if (path.endsWith('.spec.ts') || path.endsWith('.test.ts')) return true;
    if (cfg.excludeGlobs?.some((g) => path.includes(g))) return true;
    return false;
}

function fileHasNatsImport(sf: SourceFile, ctx: ExtractorCtx): boolean {
    const text = sf.getFullText();
    if (/from\s+['"]@nestjs\/microservices['"]/.test(text)) return true;
    for (const api of ctx.publishApis) {
        if (new RegExp(`\\b${escapeReg(api.class)}\\b`).test(text)) return true;
    }
    for (const api of ctx.subscribeMethodApis) {
        if (new RegExp(`\\b${escapeReg(api.class)}\\b`).test(text)) return true;
    }
    return false;
}

function escapeReg(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectFromFile(sf: SourceFile, ctx: ExtractorCtx, out: NatsCallSite[]): void {
    const fileHasNats = fileHasNatsImport(sf, ctx);

    // Decorators are unambiguous NATS markers — always collect.
    sf.forEachDescendant((node) => {
        if (node.getKind() !== SyntaxKind.Decorator) return;
        const dec = node as Decorator;
        const name = decoratorName(dec);
        if (!STANDARD_SUBSCRIBE_DECORATORS.has(name)) return;

        const args = dec.getArguments();
        if (args.length === 0) return;

        const subjectExpr = args[0]!;
        if (subjectExpr.getKind() === SyntaxKind.ArrayLiteralExpression) {
            const arrayLit = subjectExpr.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
            for (const el of arrayLit.getElements()) {
                pushSubscribe(el, dec, name, ctx, out);
            }
        } else {
            pushSubscribe(subjectExpr, dec, name, ctx, out);
        }
    });

    // File-import pre-filter: drops 100s of false positives where method names collide
    // (e.g. EventEmitter.emit). Symmetric with ground-truth.
    if (!fileHasNats) return;

    sf.forEachDescendant((node) => {
        if (node.getKind() !== SyntaxKind.CallExpression) return;
        const call = node as CallExpression;
        const expr = call.getExpression();
        if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return;

        const pa = expr as PropertyAccessExpression;
        const methodName = pa.getName();
        const target = pa.getExpression();

        const publishMatch = matchApi(target, methodName, ctx.publishApis);
        if (publishMatch) {
            const args = call.getArguments();
            if (args.length === 0) return;
            const resolved = resolveSubject(args[0]!, 0, ctx.constIndex);
            const edgeKind = methodName === 'emit' || methodName === 'publish' ? 'nats-publish' : 'nats-request';
            out.push({
                role: 'sender',
                edgeKind,
                subject: resolved,
                location: locOf(call),
                via: `${publishMatch.class}.${methodName}`,
                enclosingClass: findEnclosingClassName(call) ?? undefined,
            });
            return;
        }

        const subscribeMatch = matchApi(target, methodName, ctx.subscribeMethodApis);
        if (subscribeMatch) {
            const args = call.getArguments();
            if (args.length === 0) return;
            const resolved = resolveSubject(args[0]!, 0, ctx.constIndex);
            out.push({
                role: 'receiver',
                edgeKind: 'nats-subscribe',
                subject: resolved,
                location: locOf(call),
                via: `${subscribeMatch.class}.${methodName}`,
                enclosingClass: findEnclosingClassName(call) ?? undefined,
            });
        }
    });
}

function pushSubscribe(
    subjectExpr: Node,
    dec: Decorator,
    decoratorNameStr: string,
    ctx: ExtractorCtx,
    out: NatsCallSite[],
): void {
    const resolved = resolveSubject(subjectExpr, 0, ctx.constIndex);
    out.push({
        role: 'receiver',
        edgeKind: decoratorNameStr === 'EventPattern' ? 'nats-subscribe' : 'nats-reply',
        subject: resolved,
        location: locOf(dec),
        via: `@${decoratorNameStr}`,
        enclosingClass: findEnclosingClassName(dec) ?? undefined,
    });
}

function decoratorName(dec: Decorator): string {
    const callExpr = dec.getExpression();
    if (callExpr.getKind() === SyntaxKind.CallExpression) {
        const ce = callExpr as CallExpression;
        const ident = ce.getExpression();
        return ident.getText();
    }
    return callExpr.getText();
}

function matchApi(target: Node, methodName: string, apis: WrapperApi[]): WrapperApi | null {
    let methodMatchesAny = false;
    for (const api of apis) {
        if (api.methods.includes(methodName)) {
            methodMatchesAny = true;
            break;
        }
    }
    if (!methodMatchesAny) return null;

    let typeName: string | undefined;
    try {
        const t = target.getType();
        typeName = simpleTypeName(t);
    } catch {
        typeName = undefined;
    }

    if (typeName) {
        for (const api of apis) {
            if (!api.methods.includes(methodName)) continue;
            if (typeName === api.class) return api;
            if (typeName.includes(api.class)) return api;
        }
    }

    // Text-based fallback: variable name often includes class name.
    const text = target.getText();
    const lower = text.toLowerCase();
    for (const api of apis) {
        if (!api.methods.includes(methodName)) continue;
        const className = api.class.toLowerCase();
        if (lower.includes(className)) return api;
        if (className === 'clientproxy' && /\bclient\b/.test(lower)) return api;
        if (className === 'clientnats' && /\bclient\b/.test(lower)) return api;
    }
    return null;
}

function simpleTypeName(t: Type): string {
    const txt = t.getText();
    const match = txt.match(/([A-Z][A-Za-z0-9_]+)(?:<|$|\s|\|)/);
    return match ? match[1]! : txt;
}

function locOf(node: Node): SourceLoc {
    const sf = node.getSourceFile();
    const { line, column } = sf.getLineAndColumnAtPos(node.getStart());
    return { file: sf.getFilePath(), line, column };
}

function findEnclosingClassName(node: Node): string | null {
    let cur: Node | undefined = node;
    while (cur) {
        if (Node.isClassDeclaration(cur)) return cur.getName() ?? null;
        cur = cur.getParent();
    }
    return null;
}

// ============================================================================
// Subject resolver
// ============================================================================

export function resolveSubject(node: Node, depth: number, idx?: ConstantIndex): ResolvedSubject {
    if (depth > MAX_RESOLVE_DEPTH) {
        return { kind: 'unresolved', raw: node.getText(), reason: 'max depth' };
    }

    switch (node.getKind()) {
        case SyntaxKind.StringLiteral:
        case SyntaxKind.NoSubstitutionTemplateLiteral: {
            return { kind: 'literal', value: (node as StringLiteral).getLiteralText() };
        }

        case SyntaxKind.TemplateExpression: {
            return resolveTemplate(node as TemplateExpression, depth, idx);
        }

        case SyntaxKind.PropertyAccessExpression: {
            const r = resolvePropertyAccess(node as PropertyAccessExpression, depth, idx);
            if ((r.kind === 'literal' || r.kind === 'pattern') && idx) return r;
            if (idx) {
                const ix = idx.get(node.getText());
                if (ix && (ix.kind === 'literal' || ix.kind === 'pattern')) return ix;
            }
            return r;
        }

        case SyntaxKind.ElementAccessExpression: {
            return { kind: 'dynamic', hint: node.getText() };
        }

        case SyntaxKind.Identifier: {
            return resolveIdentifier(node as Identifier, depth, idx);
        }

        case SyntaxKind.CallExpression: {
            return resolveCall(node as CallExpression, depth, idx);
        }

        case SyntaxKind.AsExpression:
        case SyntaxKind.ParenthesizedExpression:
        case SyntaxKind.TypeAssertionExpression: {
            const inner = (node as unknown as { getExpression?: () => Node | undefined }).getExpression?.();
            if (inner) return resolveSubject(inner, depth + 1, idx);
            return { kind: 'unresolved', raw: node.getText(), reason: 'no inner expression' };
        }

        case SyntaxKind.ConditionalExpression: {
            return { kind: 'dynamic', hint: node.getText() };
        }
    }

    return { kind: 'unresolved', raw: node.getText(), reason: `unsupported kind: ${node.getKindName()}` };
}

function resolveTemplate(node: TemplateExpression, depth: number, idx?: ConstantIndex): ResolvedSubject {
    const head = node.getHead().getLiteralText();
    const spans = node.getTemplateSpans();

    let pattern = head;
    const placeholders: string[] = [];

    for (const span of spans) {
        const expr = span.getExpression();
        const resolved = resolveSubject(expr, depth + 1, idx);

        if (resolved.kind === 'literal') {
            pattern += resolved.value;
        } else {
            pattern += '*';
            placeholders.push(expr.getText());
        }

        const literal = span.getLiteral();
        pattern += literal.getLiteralText();
    }

    if (placeholders.length === 0) {
        return { kind: 'literal', value: pattern };
    }
    return { kind: 'pattern', pattern, placeholders };
}

function resolvePropertyAccess(
    node: PropertyAccessExpression,
    depth: number,
    idx?: ConstantIndex,
): ResolvedSubject {
    const sym = node.getNameNode().getSymbol();
    if (!sym) {
        return { kind: 'unresolved', raw: node.getText(), reason: 'no symbol' };
    }

    const decls = sym.getDeclarations();
    if (decls.length === 0) {
        return { kind: 'unresolved', raw: node.getText(), reason: 'no declarations' };
    }

    for (const decl of decls) {
        const initOrValue = getInitializerOrValue(decl);
        if (initOrValue) {
            const resolved = resolveSubject(initOrValue, depth + 1, idx);
            if (resolved.kind !== 'unresolved') return resolved;
        }
    }

    return { kind: 'unresolved', raw: node.getText(), reason: 'cannot resolve declaration' };
}

function resolveIdentifier(node: Identifier, depth: number, idx?: ConstantIndex): ResolvedSubject {
    const sym = node.getSymbol();
    if (!sym) return { kind: 'unresolved', raw: node.getText(), reason: 'no symbol' };

    const decls = sym.getDeclarations();
    for (const decl of decls) {
        const k = decl.getKind();
        if (k === SyntaxKind.Parameter || k === SyntaxKind.BindingElement) {
            return { kind: 'dynamic', hint: `param:${node.getText()}` };
        }
        const initOrValue = getInitializerOrValue(decl);
        if (initOrValue) {
            const r = resolveSubject(initOrValue, depth + 1, idx);
            if (r.kind !== 'unresolved') return r;
        }
    }
    return { kind: 'unresolved', raw: node.getText(), reason: 'identifier not resolvable' };
}

function resolveCall(node: CallExpression, depth: number, idx?: ConstantIndex): ResolvedSubject {
    if (idx) {
        const calleeText = node.getExpression().getText();
        const idxEntry = idx.get(calleeText);
        if (idxEntry && idxEntry.kind === 'fn-template') {
            const args = node.getArguments().map((a) => a.getText());
            return applyFnTemplate(idxEntry, args);
        }
    }

    const callee = node.getExpression();
    let fnDecl: ArrowFunction | FunctionDeclaration | null = null;

    if (callee.getKind() === SyntaxKind.PropertyAccessExpression || callee.getKind() === SyntaxKind.Identifier) {
        const sym =
            (callee as unknown as { getNameNode?: () => { getSymbol: () => unknown } }).getNameNode?.()?.getSymbol() ??
            (callee as Identifier).getSymbol?.();
        if (sym) {
            const decls = (sym as { getDeclarations?: () => Node[] }).getDeclarations?.() ?? [];
            for (const decl of decls) {
                const init = getInitializerOrValue(decl);
                if (init && init.getKind() === SyntaxKind.ArrowFunction) {
                    fnDecl = init as ArrowFunction;
                    break;
                }
                if (decl.getKind() === SyntaxKind.FunctionDeclaration) {
                    fnDecl = decl as FunctionDeclaration;
                    break;
                }
                if (decl.getKind() === SyntaxKind.PropertyAssignment) {
                    const pa = decl as PropertyAssignment;
                    const i = pa.getInitializer();
                    if (i && i.getKind() === SyntaxKind.ArrowFunction) {
                        fnDecl = i as ArrowFunction;
                        break;
                    }
                }
            }
        }
    }

    if (!fnDecl) {
        return { kind: 'unresolved', raw: node.getText(), reason: 'callee not resolvable to function' };
    }

    let body: Node | undefined;
    if (Node.isArrowFunction(fnDecl)) {
        body = fnDecl.getBody();
    } else if (Node.isFunctionDeclaration(fnDecl)) {
        const blk = fnDecl.getBody();
        if (!blk || !Node.isBlock(blk)) {
            return { kind: 'unresolved', raw: node.getText(), reason: 'function has no body' };
        }
        const stmts = blk.getStatements();
        const ret = stmts.find((s) => s.getKind() === SyntaxKind.ReturnStatement);
        if (!ret) return { kind: 'unresolved', raw: node.getText(), reason: 'no return statement' };
        body = (ret as unknown as { getExpression: () => Node | undefined }).getExpression();
    }

    if (!body) {
        return { kind: 'unresolved', raw: node.getText(), reason: 'no function body' };
    }

    if (Node.isBlock(body)) {
        const stmts = body.getStatements();
        const ret = stmts.find((s) => s.getKind() === SyntaxKind.ReturnStatement);
        if (!ret) return { kind: 'unresolved', raw: node.getText(), reason: 'block has no return' };
        const retExpr = (ret as unknown as { getExpression: () => Node | undefined }).getExpression();
        if (!retExpr) return { kind: 'unresolved', raw: node.getText(), reason: 'return has no expression' };
        return resolveFnReturn(retExpr, fnDecl, node, depth, idx);
    }

    return resolveFnReturn(body, fnDecl, node, depth, idx);
}

function resolveFnReturn(
    bodyExpr: Node,
    fnDecl: ArrowFunction | FunctionDeclaration,
    call: CallExpression,
    depth: number,
    idx?: ConstantIndex,
): ResolvedSubject {
    const params = (fnDecl as unknown as { getParameters?: () => Array<{ getName?: () => string }> }).getParameters?.() ?? [];
    const args = call.getArguments();

    if (bodyExpr.getKind() === SyntaxKind.TemplateExpression) {
        const tmpl = bodyExpr as TemplateExpression;
        const paramMap = new Map<string, ResolvedSubject>();
        params.forEach((p, i) => {
            const pName = p.getName?.();
            if (!pName) return;
            const arg = args[i];
            if (!arg) return;
            paramMap.set(pName, resolveSubject(arg, depth + 1, idx));
        });

        let pattern = tmpl.getHead().getLiteralText();
        const placeholders: string[] = [];

        for (const span of tmpl.getTemplateSpans()) {
            const e = span.getExpression();
            let chunk = '*';
            if (e.getKind() === SyntaxKind.Identifier) {
                const r = paramMap.get(e.getText());
                if (r && r.kind === 'literal') {
                    chunk = r.value;
                } else if (r && r.kind === 'pattern') {
                    chunk = r.pattern;
                } else {
                    chunk = '*';
                    placeholders.push(e.getText());
                }
            } else {
                const r = resolveSubject(e, depth + 1, idx);
                if (r.kind === 'literal') chunk = r.value;
                else if (r.kind === 'pattern') chunk = r.pattern;
                else placeholders.push(e.getText());
            }
            pattern += chunk;
            pattern += span.getLiteral().getLiteralText();
        }

        if (placeholders.length === 0) return { kind: 'literal', value: pattern };
        return { kind: 'pattern', pattern, placeholders };
    }

    if (
        bodyExpr.getKind() === SyntaxKind.StringLiteral ||
        bodyExpr.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
        return { kind: 'literal', value: (bodyExpr as StringLiteral).getLiteralText() };
    }

    return resolveSubject(bodyExpr, depth + 1, idx);
}

function getInitializerOrValue(decl: Node): Node | undefined {
    if (Node.isVariableDeclaration(decl)) {
        return (decl as VariableDeclaration).getInitializer();
    }
    if (Node.isPropertyAssignment(decl)) {
        return (decl as PropertyAssignment).getInitializer();
    }
    if (Node.isPropertyDeclaration(decl)) {
        return (decl as PropertyDeclaration).getInitializer();
    }
    if (Node.isShorthandPropertyAssignment(decl)) {
        return (decl as unknown as { getNameNode?: () => Node }).getNameNode?.();
    }
    if (Node.isPropertySignature(decl)) {
        return (decl as PropertySignature).getInitializer?.();
    }
    if (Node.isEnumMember(decl)) {
        return (decl as unknown as { getInitializer?: () => Node | undefined }).getInitializer?.();
    }
    return undefined;
}
