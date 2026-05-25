import { Node, Project, SyntaxKind, type CallExpression, type ClassDeclaration, type FunctionDeclaration, type MethodDeclaration, type Node as MorphNode, type ParameterDeclaration, type PropertyAccessExpression, type SourceFile, type TypeAliasDeclaration } from 'ts-morph';

import type {
    CodeIntelBranch,
    CodeIntelCall,
    CodeIntelFlow,
    CodeIntelImpact,
    CodeIntelIndex,
    CodeIntelManifest,
    CodeIntelPolicy,
    CodeIntelSymbol,
    CodeIntelSymbolKind,
} from './types.js';
import { CODE_INTEL_SCHEMA_VERSION } from './types.js';

export interface CodeIntelExtractOptions {
    root: string;
}

interface FunctionLikeCtx {
    id: string;
    fqn: string;
    node: MethodDeclaration | FunctionDeclaration;
    className?: string;
    propertyTypes: Map<string, string>;
    propertyDecorators: Map<string, string[]>;
    imports: Map<string, ImportBinding>;
    callOrder: number;
}

interface ImportBinding {
    module: string;
    imported: string;
    isExternal: boolean;
}

interface FunctionLocalFacts {
    variableTypes: Map<string, string>;
    receiverKinds: Map<string, NonNullable<CodeIntelCall['kind']>>;
    externalTypeBindings: Map<string, ImportBinding>;
}

export function extractCodeIntel(project: Project, opts: CodeIntelExtractOptions): CodeIntelIndex {
    const symbols: CodeIntelSymbol[] = [];
    const calls: CodeIntelCall[] = [];
    const flows: CodeIntelFlow[] = [];
    const branches: CodeIntelBranch[] = [];
    const symbolsByFqn = new Map<string, CodeIntelSymbol[]>();
    const symbolsById = new Map<string, CodeIntelSymbol>();
    const functionContexts: FunctionLikeCtx[] = [];
    const ambiguousFqns = new Set<string>();
    const skippedFiles: Array<{ file: string; error: string }> = [];

    const addSymbol = (symbol: CodeIntelSymbol): void => {
        if (symbolsById.has(symbol.id)) return;
        symbols.push(symbol);
        symbolsById.set(symbol.id, symbol);
        const bucket = symbolsByFqn.get(symbol.fqn) ?? [];
        bucket.push(symbol);
        symbolsByFqn.set(symbol.fqn, bucket);
        // P1.2 diagnostic: track FQN collisions so consumers can warn agents
        // that resolve_symbol / find_references / impact_contract may return
        // an ambiguous result. The first symbol still wins downstream ranking,
        // but the conflict is no longer silent.
        if (bucket.length > 1) ambiguousFqns.add(symbol.fqn);
    };

    for (const sf of project.getSourceFiles()) {
        if (sf.isDeclarationFile()) continue;
        try {
        const imports = importsForSourceFile(sf);
        for (const cls of sf.getClasses()) {
            const name = cls.getName();
            if (!name) continue;
            const decorators = decoratorsOf(cls);
            let classKind: CodeIntelSymbolKind = 'class';
            if (isDtoName(name)) classKind = 'dto';
            else if (isEntityName(name) || decorators.some((d) => d.includes('@Entity'))) classKind = 'db-entity';

            const classSymbol = symbolForNode(cls, classKind, name, name, opts.root, {
                description: descriptionOf(cls),
                decorators,
            });
            addSymbol(classSymbol);

            const propertyTypes = new Map<string, string>();
            const propertyDecorators = new Map<string, string[]>();
            for (const prop of cls.getProperties()) {
                const propName = prop.getName();
                propertyTypes.set(propName, prop.getTypeNode()?.getText() ?? prop.getType().getText(prop));
                propertyDecorators.set(propName, decoratorsOf(prop));
                const fieldFqn = `${name}.${propName}`;
                addSymbol(symbolForNode(prop, 'field', propName, fieldFqn, opts.root, {
                    parentId: classSymbol.id,
                    ownerName: name,
                    type: prop.getTypeNode()?.getText() ?? prop.getType().getText(prop),
                    description: descriptionOf(prop),
                    decorators: decoratorsOf(prop),
                }));
            }
            for (const ctor of cls.getConstructors()) {
                for (const param of ctor.getParameters()) {
                    if (!param.isParameterProperty()) continue;
                    const paramName = param.getName();
                    propertyTypes.set(paramName, param.getTypeNode()?.getText() ?? param.getType().getText(param));
                    propertyDecorators.set(paramName, decoratorsOf(param));
                }
            }

            for (const method of cls.getMethods()) {
                const methodName = method.getName();
                const methodFqn = `${name}.${methodName}`;
                const methodSymbol = symbolForNode(method, 'method', methodName, methodFqn, opts.root, {
                    parentId: classSymbol.id,
                    ownerName: name,
                    signature: signatureOf(method),
                    returnType: method.getReturnTypeNode()?.getText() ?? method.getReturnType().getText(method),
                    visibility: method.getScope() ?? 'public',
                    isAsync: method.isAsync(),
                    description: descriptionOf(method),
                    decorators: decoratorsOf(method),
                });
                addSymbol(methodSymbol);
                addParams(method, methodSymbol, opts.root, addSymbol);
                functionContexts.push({
                    id: methodSymbol.id,
                    fqn: methodFqn,
                    node: method,
                    className: name,
                    propertyTypes,
                    propertyDecorators,
                    imports,
                    callOrder: 0,
                });
            }
        }

        for (const fn of sf.getFunctions()) {
            const name = fn.getName();
            if (!name) continue;
            const fnSymbol = symbolForNode(fn, 'function', name, name, opts.root, {
                signature: signatureOf(fn),
                returnType: fn.getReturnTypeNode()?.getText() ?? fn.getReturnType().getText(fn),
                isAsync: fn.isAsync(),
                description: descriptionOf(fn),
            });
            addSymbol(fnSymbol);
            addParams(fn, fnSymbol, opts.root, addSymbol);
            functionContexts.push({
                id: fnSymbol.id,
                fqn: name,
                node: fn,
                propertyTypes: new Map(),
                propertyDecorators: new Map(),
                imports,
                callOrder: 0,
            });
        }

        for (const intf of sf.getInterfaces()) {
            const name = intf.getName();
            const typeSymbol = symbolForNode(intf, isDtoName(name) ? 'dto' : 'type', name, name, opts.root, { description: descriptionOf(intf) });
            addSymbol(typeSymbol);
            for (const prop of intf.getProperties()) {
                const propName = prop.getName();
                addSymbol(symbolForNode(prop, 'field', propName, `${name}.${propName}`, opts.root, {
                    parentId: typeSymbol.id,
                    ownerName: name,
                    type: prop.getTypeNode()?.getText() ?? prop.getType().getText(prop),
                    description: descriptionOf(prop),
                }));
            }
        }

        for (const alias of sf.getTypeAliases()) {
            addTypeAliasDto(alias, opts.root, addSymbol);
        }
        } catch (sfErr) {
            // ts-morph getType()/getText() can throw on cyclic types, unresolved
            // .d.ts references, or virtual files; isolate the failure to one file
            // so the rest of the index still builds. Reported via diagnostics.
            const msg = sfErr instanceof Error ? sfErr.message : String(sfErr);
            skippedFiles.push({ file: sf.getFilePath(), error: msg });
            process.stderr.write(`[code-intel] skipping ${sf.getFilePath()}: ${msg}\n`);
        }
    }

    // Heritage pass: resolve extends chains, classify overrides, emit super-call edges (A1–A7).
    const pathAliases = collectPathAliases(project, opts.root);
    for (const sf of project.getSourceFiles()) {
        if (sf.isDeclarationFile()) continue;
        const imports = importsForSourceFile(sf);
        for (const cls of sf.getClasses()) {
            const name = cls.getName();
            if (!name) continue;
            try {
                extractHeritageForClass(cls, name, sf, imports, project, opts.root, pathAliases, symbolsByFqn, symbolsById, calls);
            } catch (heritageErr) {
                const msg = heritageErr instanceof Error ? heritageErr.message : String(heritageErr);
                skippedFiles.push({ file: `${sf.getFilePath()} (heritage:${name})`, error: msg });
            }
        }
    }

    for (const ctx of functionContexts) {
        try {
            collectFunctionFacts(ctx, symbolsByFqn, symbolsById, calls, flows, branches, opts.root);
        } catch (ctxErr) {
            const msg = ctxErr instanceof Error ? ctxErr.message : String(ctxErr);
            skippedFiles.push({ file: `${ctx.fqn} (function facts)`, error: msg });
            process.stderr.write(`[code-intel] skipping ${ctx.fqn} facts: ${msg}\n`);
        }
    }

    const impacts = collectImpacts(project, symbols, opts.root);
    const policies = inferPolicies(symbols);

    const index = buildIndex(opts.root, symbols, calls, flows, branches, impacts, policies);
    // P1.2 / P0-E diagnostics: attach as a manifest extension so MCP /
    // self_check can surface them without changing schemaVersion.
    (index.manifest as CodeIntelManifest & { warnings?: Record<string, unknown> }).warnings = {
        ambiguousFqns: Array.from(ambiguousFqns).sort(),
        skippedFiles,
    };
    return index;
}

function buildIndex(
    root: string,
    symbols: CodeIntelSymbol[],
    calls: CodeIntelCall[],
    flows: CodeIntelFlow[],
    branches: CodeIntelBranch[],
    impacts: CodeIntelImpact[],
    policies: CodeIntelPolicy[],
): CodeIntelIndex {
    return {
        manifest: {
            schemaVersion: CODE_INTEL_SCHEMA_VERSION,
            builtAt: new Date().toISOString(),
            root,
            counts: {
                symbols: symbols.length,
                calls: calls.length,
                flows: flows.length,
                branches: branches.length,
                impacts: impacts.length,
            },
        },
        symbols,
        calls,
        flows,
        branches,
        impacts,
        policies,
    };
}

function inferPolicies(symbols: CodeIntelSymbol[]): CodeIntelPolicy[] {
    const policies: CodeIntelPolicy[] = [];
    const kinds: Array<CodeIntelSymbol['kind']> = ['dto', 'class', 'method', 'field'];

    for (const kind of kinds) {
        const kindSymbols = symbols.filter((s) => s.kind === kind);
        if (kindSymbols.length < 5) continue;

        // 1. Placement Patterns
        const placements = new Map<string, number>();
        for (const s of kindSymbols) {
            const dir = s.file.split('/').slice(0, -1).join('/');
            if (!dir) continue;
            const generalized = dir
                .replace(/^apps\/[^/]+\//, '**/')
                .replace(/^libs\/[^/]+\//, '**/')
                .replace(/\/src\/modules\/[^/]+/, '/src/modules/*')
                .replace(/\/src\/[^/]+$/, '/src/*');
            placements.set(generalized, (placements.get(generalized) ?? 0) + 1);
        }
        for (const [pattern, count] of placements) {
            const confidence = count / kindSymbols.length;
            if (confidence > 0.3) {
                policies.push({
                    id: `policy:placement:${kind}:${pattern}`,
                    kind: 'placement',
                    rule: `${kind.toUpperCase()} location: ${pattern}/*.ts`,
                    description: `${Math.round(confidence * 100)}% of ${kind} symbols follow this directory pattern.`,
                    confidence,
                    count,
                    total: kindSymbols.length,
                });
            }
        }

        // 2. Decorator Pairings
        if (kind === 'class' || kind === 'field' || kind === 'method' || kind === 'db-entity') {
            const decoratorCounts = new Map<string, number>();
            const pairings = new Map<string, Map<string, number>>();
            for (const s of kindSymbols) {
                if (!s.decorators || s.decorators.length === 0) continue;
                const uniqueDecoNames = Array.from(new Set(s.decorators.map((d) => d.split('(')[0].trim())));
                for (const dName of uniqueDecoNames) {
                    decoratorCounts.set(dName, (decoratorCounts.get(dName) ?? 0) + 1);
                    for (const d2Name of uniqueDecoNames) {
                        if (dName === d2Name) continue;
                        const bucket = pairings.get(dName) ?? new Map<string, number>();
                        bucket.set(d2Name, (bucket.get(d2Name) ?? 0) + 1);
                        pairings.set(dName, bucket);
                    }
                }
            }

            for (const [d1, d1Count] of decoratorCounts) {
                if (d1Count < 3) continue;
                const d1Pairings = pairings.get(d1);
                if (!d1Pairings) continue;
                for (const [d2, pairCount] of d1Pairings) {
                    const confidence = pairCount / d1Count;
                    if (confidence > 0.5) {
                        policies.push({
                            id: `policy:pairing:${kind}:${d1}:${d2}`,
                            kind: 'decorator-pairing',
                            rule: `When using ${d1}, also use ${d2}`,
                            description: `In this project, ${d1} is paired with ${d2} in ${Math.round(confidence * 100)}% of cases for ${kind}s.`,
                            confidence,
                            count: pairCount,
                            total: d1Count,
                        });
                    }
                }
            }
        }

        // 3. Naming Conventions
        if (kind === 'dto') {
            const suffixes = ['Dto', 'DTO', 'Request', 'Response', 'Payload', 'Command', 'Event'];
            const suffixCounts = new Map<string, number>();
            for (const s of kindSymbols) {
                for (const suffix of suffixes) {
                    if (s.name.endsWith(suffix)) {
                        suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
                    }
                }
            }
            for (const [suffix, count] of suffixCounts) {
                const confidence = count / kindSymbols.length;
                if (confidence > 0.7) {
                    policies.push({
                        id: `policy:naming:${kind}:${suffix}`,
                        kind: 'naming',
                        rule: `${kind.toUpperCase()} naming: *${suffix}`,
                        description: `Most ${kind} symbols in this project end with '${suffix}'.`,
                        confidence,
                        count,
                        total: kindSymbols.length,
                    });
                }
            }
        }
    }
    return policies;
}

function addTypeAliasDto(alias: TypeAliasDeclaration, root: string, addSymbol: (symbol: CodeIntelSymbol) => void): void {
    const name = alias.getName();
    const typeSymbol = symbolForNode(alias, isDtoName(name) ? 'dto' : 'type', name, name, root, { description: descriptionOf(alias) });
    addSymbol(typeSymbol);
    const typeNode = alias.getTypeNode();
    if (!typeNode || !Node.isTypeLiteral(typeNode)) return;
    for (const member of typeNode.getMembers()) {
        if (!Node.isPropertySignature(member)) continue;
        const propName = member.getName();
        addSymbol(symbolForNode(member, 'field', propName, `${name}.${propName}`, root, {
            parentId: typeSymbol.id,
            ownerName: name,
            type: member.getTypeNode()?.getText() ?? member.getType().getText(member),
            description: descriptionOf(member),
        }));
    }
}

function addParams(
    fn: MethodDeclaration | FunctionDeclaration,
    parent: CodeIntelSymbol,
    root: string,
    addSymbol: (symbol: CodeIntelSymbol) => void,
): void {
    for (const param of fn.getParameters()) {
        addSymbol(symbolForNode(param, 'param', param.getName(), `${parent.fqn}.${param.getName()}`, root, {
            parentId: parent.id,
            ownerName: parent.fqn,
            type: param.getTypeNode()?.getText() ?? param.getType().getText(param),
            decorators: decoratorsOf(param),
        }));
    }
}

function collectFunctionFacts(
    ctx: FunctionLikeCtx,
    symbolsByFqn: Map<string, CodeIntelSymbol[]>,
    symbolsById: Map<string, CodeIntelSymbol>,
    calls: CodeIntelCall[],
    flows: CodeIntelFlow[],
    branches: CodeIntelBranch[],
    root: string,
): void {
    const params = ctx.node.getParameters();
    const callByNode = new Map<CallExpression, CodeIntelCall>();
    const localFacts = collectLocalFacts(ctx, symbolsByFqn, symbolsById);
    ctx.node.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        if (node.getFirstAncestorByKind(SyntaxKind.Decorator)) return;
        const resolved = resolveCall(node, ctx, symbolsByFqn, symbolsById, localFacts);
        const loc = locOf(node, root);
        const conditions = collectNestedConditions(node);
        const call: CodeIntelCall = {
            id: `call:${ctx.fqn}:${ctx.callOrder}:${loc.line}:${loc.column}`,
            callerId: ctx.id,
            caller: ctx.fqn,
            callee: resolved.callee,
            ...(resolved.calleeId ? { calleeId: resolved.calleeId } : {}),
            kind: resolved.kind,
            ...(resolved.module ? { module: resolved.module } : {}),
            ...(resolved.importName ? { importName: resolved.importName } : {}),
            order: ctx.callOrder++,
            file: loc.file,
            line: loc.line,
            column: loc.column,
            expression: node.getExpression().getText(),
            ...(resolved.receiver ? { receiver: resolved.receiver } : {}),
            args: node.getArguments().map((arg) => arg.getText()),
            ...(conditions.length > 0 ? { conditions } : {}),
        };
        callByNode.set(node, call);
        calls.push(call);
    });

    for (const param of params) {
        collectParamFlows(ctx, param, calls.filter((call) => call.callerId === ctx.id), flows, symbolsById, root);
    }

    collectFunctionLocalFlows(ctx, flows, root);

    ctx.node.forEachDescendant((node) => {
        if (Node.isIfStatement(node)) {
            const loc = locOf(node.getExpression(), root);
            const nestedIn = collectNestedConditions(node);
            const dominatedCalls = Array.from(callByNode.entries())
                .filter(([callNode]) => node.getThenStatement().containsRange(callNode.getPos(), callNode.getEnd()))
                .map(([, call]) => call.callee);
            branches.push({
                id: `branch:${ctx.fqn}:${loc.line}:${loc.column}`,
                functionId: ctx.id,
                functionName: ctx.fqn,
                condition: node.getExpression().getText(),
                thenText: compactNodeText(node.getThenStatement().getText()),
                file: loc.file,
                line: loc.line,
                column: loc.column,
                nestedIn,
                calls: Array.from(new Set(dominatedCalls)),
            });

            const elseStatement = node.getElseStatement();
            if (elseStatement && !Node.isIfStatement(elseStatement)) {
                const elseLoc = locOf(elseStatement, root);
                const elseNestedIn = collectNestedConditions(elseStatement);
                const elseCalls = Array.from(callByNode.entries())
                    .filter(([callNode]) => elseStatement.containsRange(callNode.getPos(), callNode.getEnd()))
                    .map(([, call]) => call.callee);
                branches.push({
                    id: `branch:${ctx.fqn}:else:${elseLoc.line}:${elseLoc.column}`,
                    functionId: ctx.id,
                    functionName: ctx.fqn,
                    condition: 'else',
                    thenText: compactNodeText(elseStatement.getText()),
                    file: elseLoc.file,
                    line: elseLoc.line,
                    column: elseLoc.column,
                    nestedIn: elseNestedIn,
                    calls: Array.from(new Set(elseCalls)),
                });
            }
        } else if (Node.isConditionalExpression(node)) {
            const loc = locOf(node.getCondition(), root);
            const nestedIn = collectNestedConditions(node);
            const dominatedCalls = Array.from(callByNode.entries())
                .filter(([callNode]) => node.getWhenTrue().containsRange(callNode.getPos(), callNode.getEnd()) ||
                                      node.getWhenFalse().containsRange(callNode.getPos(), callNode.getEnd()))
                .map(([, call]) => call.callee);
            branches.push({
                id: `branch:${ctx.fqn}:${loc.line}:${loc.column}`,
                functionId: ctx.id,
                functionName: ctx.fqn,
                condition: node.getCondition().getText(),
                thenText: compactNodeText(`${node.getWhenTrue().getText()} : ${node.getWhenFalse().getText()}`),
                file: loc.file,
                line: loc.line,
                column: loc.column,
                nestedIn,
                calls: Array.from(new Set(dominatedCalls)),
            });
        } else if (Node.isSwitchStatement(node)) {
            const switchExpr = node.getExpression().getText();
            const nestedIn = collectNestedConditions(node);
            for (const clause of node.getClauses()) {
                const loc = locOf(clause, root);
                const isDefault = Node.isDefaultClause(clause);
                const condition = isDefault ? `${switchExpr} default` : `${switchExpr} === ${clause.getExpression().getText()}`;
                const dominatedCalls = Array.from(callByNode.entries())
                    .filter(([callNode]) => clause.containsRange(callNode.getPos(), callNode.getEnd()))
                    .map(([, call]) => call.callee);
                branches.push({
                    id: `branch:${ctx.fqn}:${loc.line}:${loc.column}`,
                    functionId: ctx.id,
                    functionName: ctx.fqn,
                    condition,
                    thenText: compactNodeText(clause.getText()),
                    file: loc.file,
                    line: loc.line,
                    column: loc.column,
                    nestedIn,
                    calls: Array.from(new Set(dominatedCalls)),
                });
            }
        } else if (Node.isThrowStatement(node)) {
            const loc = locOf(node, root);
            const nestedIn = collectNestedConditions(node);
            branches.push({
                id: `branch:${ctx.fqn}:throw:${loc.line}:${loc.column}`,
                functionId: ctx.id,
                functionName: ctx.fqn,
                condition: `throw ${node.getExpression()?.getText() ?? ''}`.trim(),
                thenText: 'throw',
                file: loc.file,
                line: loc.line,
                column: loc.column,
                nestedIn,
                calls: [],
            });
        } else if (Node.isTryStatement(node)) {
            const catchClause = node.getCatchClause();
            if (catchClause) {
                const loc = locOf(catchClause, root);
                const nestedIn = collectNestedConditions(catchClause);
                const dominatedCalls = Array.from(callByNode.entries())
                    .filter(([callNode]) => catchClause.getBlock().containsRange(callNode.getPos(), callNode.getEnd()))
                    .map(([, call]) => call.callee);
                branches.push({
                    id: `branch:${ctx.fqn}:catch:${loc.line}:${loc.column}`,
                    functionId: ctx.id,
                    functionName: ctx.fqn,
                    condition: `catch (${catchClause.getVariableDeclaration()?.getName() ?? ''})`,
                    thenText: compactNodeText(catchClause.getBlock().getText()),
                    file: loc.file,
                    line: loc.line,
                    column: loc.column,
                    nestedIn,
                    calls: Array.from(new Set(dominatedCalls)),
                });
            }
        } else if (Node.isReturnStatement(node)) {
            const expr = node.getExpression();
            if (expr) {
                const loc = locOf(node, root);
                const nestedIn = collectNestedConditions(node);
                branches.push({
                    id: `branch:${ctx.fqn}:return:${loc.line}:${loc.column}`,
                    functionId: ctx.id,
                    functionName: ctx.fqn,
                    condition: `return ${expr.getText()}`,
                    thenText: 'return',
                    file: loc.file,
                    line: loc.line,
                    column: loc.column,
                    nestedIn,
                    calls: [],
                });
            }
        }
    });
}

function collectNestedConditions(node: MorphNode): string[] {
    const conditions: string[] = [];
    let current: MorphNode | undefined = node.getParent();
    let previous: MorphNode | undefined = node;
    while (current) {
        if (Node.isIfStatement(current)) {
            const condition = current.getExpression().getText();
            if (current.getElseStatement() === previous) {
                conditions.push(`!(${condition})`);
            } else {
                conditions.push(condition);
            }
        } else if (Node.isCaseClause(current)) {
            const switchExpr = current.getFirstAncestorByKind(SyntaxKind.SwitchStatement)?.getExpression().getText() ?? 'switch';
            conditions.push(`${switchExpr} === ${current.getExpression().getText()}`);
        } else if (Node.isDefaultClause(current)) {
            const switchExpr = current.getFirstAncestorByKind(SyntaxKind.SwitchStatement)?.getExpression().getText() ?? 'switch';
            conditions.push(`${switchExpr} default`);
        } else if (Node.isConditionalExpression(current)) {
            const condition = current.getCondition().getText();
            if (current.getWhenFalse() === previous) {
                conditions.push(`!(${condition})`);
            } else {
                conditions.push(condition);
            }
        } else if (Node.isCatchClause(current)) {
            conditions.push(`catch (${current.getVariableDeclaration()?.getName() ?? ''})`);
        }
        previous = current;
        current = current.getParent();
    }
    return conditions.reverse();
}

function collectFunctionLocalFlows(ctx: FunctionLikeCtx, flows: CodeIntelFlow[], root: string): void {
    ctx.node.forEachDescendant((node) => {
        if (!Node.isVariableDeclaration(node)) return;
        const initializerText = node.getInitializer()?.getText() ?? '';
        const sourceKind = classifyValueSourceKind(initializerText);
        if (!sourceKind) return;
        const loc = locOf(node, root);
        const name = node.getName();
        flows.push({
            id: `flow:${ctx.fqn}:local-source:${loc.line}:${loc.column}`,
            targetId: ctx.id,
            target: ctx.fqn,
            param: name,
            sourceKind,
            source: initializerText,
            via: node.getText(),
            file: loc.file,
            line: loc.line,
            column: loc.column,
            path: [sourceKind, name],
        });
    });
}

function collectParamFlows(
    ctx: FunctionLikeCtx,
    param: ParameterDeclaration,
    callerCalls: CodeIntelCall[],
    flows: CodeIntelFlow[],
    symbolsById: Map<string, CodeIntelSymbol>,
    root: string,
): void {
    const paramName = param.getName();
    const source = sourceForParam(param);
    const aliases = aliasesForParam(ctx, paramName);
    for (const call of callerCalls) {
        const usedAliasesByArg = call.args.map((arg) => Array.from(aliases).filter((alias) => expressionUsesName(arg, alias)));
        const usedAliases = usedAliasesByArg.flat();
        if (usedAliases.length === 0) continue;
        const calleeParams = paramsForCall(symbolsById, call);
        const firstUsedArgIndex = usedAliasesByArg.findIndex((argAliases) => argAliases.length > 0);
        const toParam = firstUsedArgIndex >= 0 ? calleeParams[firstUsedArgIndex]?.name : undefined;
        flows.push({
            id: `flow:${ctx.fqn}:${paramName}:call:${call.order}`,
            targetId: ctx.id,
            target: ctx.fqn,
            param: paramName,
            sourceKind: source.kind,
            source: source.label,
            via: `${call.expression}(${call.args.join(', ')})`,
            to: call.callee,
            ...(toParam ? { toParam } : {}),
            sinkKind: classifySinkKind(call.callee, call.receiver ?? '', call.expression),
            file: call.file,
            line: call.line,
            column: call.column,
            path: [source.label, ...Array.from(new Set(usedAliases)), `${call.callee}${toParam ? `.${toParam}` : ' arg'}`],
        });
    }
    ctx.node.forEachDescendant((node) => {
        if (Node.isVariableDeclaration(node) && expressionUsesName(node.getInitializer()?.getText() ?? '', paramName)) {
            const loc = locOf(node, root);
            const initializerText = node.getInitializer()?.getText() ?? '';
            const sourceKind = classifyValueSourceKind(initializerText);
            flows.push({
                id: `flow:${ctx.fqn}:${paramName}:local:${loc.line}:${loc.column}`,
                targetId: ctx.id,
                target: ctx.fqn,
                param: paramName,
                sourceKind: sourceKind ?? 'local',
                source: source.label,
                via: node.getText(),
                file: loc.file,
                line: loc.line,
                column: loc.column,
                path: [source.label, node.getName()],
            });
        }
        if (Node.isReturnStatement(node) && expressionUsesName(node.getExpression()?.getText() ?? '', paramName)) {
            const loc = locOf(node, root);
            flows.push({
                id: `flow:${ctx.fqn}:${paramName}:return:${loc.line}:${loc.column}`,
                targetId: ctx.id,
                target: ctx.fqn,
                param: paramName,
                sourceKind: 'return',
                source: source.label,
                via: node.getText(),
                file: loc.file,
                line: loc.line,
                column: loc.column,
                path: [source.label, 'return'],
            });
        }
    });
}

function classifySinkKind(callee: string, receiver: string, expression: string): CodeIntelFlow['sinkKind'] {
    const text = `${receiver} ${callee} ${expression}`.toLowerCase();
    if (/\b(save|insert|update|delete|remove|upsert|execute|query|persist|create)\b/.test(text) &&
        /\b(db|repo|repository|manager|entity|database)\b/.test(text)) return 'db';
    if (/\b(emit|send|publish|dispatch)\b/.test(text) &&
        /\b(client|nats|broker|bus|event|message|rmq)\b/.test(text)) return 'msg';
    if (/\b(get|post|put|patch|delete|request|axios|fetch|http)\b/.test(text) &&
        /\b(http|client|api|request)\b/.test(text)) return 'http';
    if (/\b(add|addjob|process|execute)\b/.test(text) &&
        /\b(queue|bull|job|worker)\b/.test(text)) return 'job';
    if (/\b(log|debug|info|warn|error|audit)\b/.test(text) &&
        /\b(logger|console)\b/.test(text)) return 'log';
    return undefined;
}

function classifyValueSourceKind(expression: string): CodeIntelFlow['sourceKind'] | undefined {
    if (/\bprocess\.env\b/.test(expression)) return 'env';
    if (/\bconfigService\.get\b/.test(expression)) return 'config';
    return undefined;
}

function paramsForCall(symbolsById: Map<string, CodeIntelSymbol>, call: CodeIntelCall): CodeIntelSymbol[] {
    if (!call.calleeId) return [];
    return Array.from(symbolsById.values())
        .filter((symbol) => symbol.kind === 'param' && symbol.parentId === call.calleeId);
}

function aliasesForParam(ctx: FunctionLikeCtx, paramName: string): Set<string> {
    const aliases = new Set([paramName]);
    ctx.node.forEachDescendant((node) => {
        if (!Node.isVariableDeclaration(node)) return;
        if (!expressionUsesName(node.getInitializer()?.getText() ?? '', paramName)) return;
        for (const alias of namesFromBindingName(node.getNameNode())) {
            aliases.add(alias);
        }
    });
    return aliases;
}

function namesFromBindingName(node: MorphNode): string[] {
    if (Node.isIdentifier(node)) return [node.getText()];
    if (Node.isObjectBindingPattern(node) || Node.isArrayBindingPattern(node)) {
        return node.getElements().flatMap((element) => {
            // ArrayBindingPattern can contain OmittedExpression (sparse array holes,
            // e.g. `const [, b] = x`); skip those rather than crashing on getNameNode.
            if (!Node.isBindingElement(element)) return [];
            return namesFromBindingName(element.getNameNode());
        });
    }
    return [];
}

function resolveCall(
    call: CallExpression,
    ctx: FunctionLikeCtx,
    symbolsByFqn: Map<string, CodeIntelSymbol[]>,
    symbolsById: Map<string, CodeIntelSymbol>,
    localFacts: FunctionLocalFacts = emptyLocalFacts(),
): { callee: string; calleeId?: string; receiver?: string; kind: NonNullable<CodeIntelCall['kind']>; module?: string; importName?: string } {
    const expr = call.getExpression();
    if (Node.isPropertyAccessExpression(expr)) {
        const receiver = expr.getExpression();
        const method = expr.getName();
        let callee = `${receiver.getText()}.${method}`;
        let calleeId: string | undefined;

        if (Node.isThisExpression(receiver) && ctx.className) {
            callee = `${ctx.className}.${method}`;
        } else if (Node.isPropertyAccessExpression(receiver) && Node.isThisExpression(receiver.getExpression())) {
            const propName = receiver.getName();
            const typeName = ctx.propertyTypes.get(propName);
            const decorators = ctx.propertyDecorators.get(propName);
            const injectToken = decorators?.find((d) => d.includes('@Inject'))?.match(/@Inject\((['"])(.+)\1\)/)?.[2];

            if (typeName) callee = `${cleanTypeName(typeName)}.${method}`;
            if (injectToken && (!typeName || typeName === 'any' || typeName === 'unknown')) {
                callee = `${injectToken}.${method}`;
            }
        } else if (Node.isIdentifier(receiver)) {
            const typeName = localFacts.variableTypes.get(receiver.getText());
            if (typeName) callee = `${cleanTypeName(typeName)}.${method}`;
        }

        const candidates = symbolsByFqn.get(callee) ?? [];
        // Ranking: same file > close quality
        const best = candidates
            .sort((a, b) => {
                const aSameFile = a.file === ctx.node.getSourceFile().getFilePath() ? 0 : 1;
                const bSameFile = b.file === ctx.node.getSourceFile().getFilePath() ? 0 : 1;
                return aSameFile - bSameFile || (b.qualityScore ?? 0) - (a.qualityScore ?? 0);
            })[0];

        calleeId = best?.id;
        const receiverText = receiver.getText();
        const receiverImport = Node.isIdentifier(receiver) ? ctx.imports.get(receiverText) : undefined;
        if (receiverImport?.isExternal) {
            return {
                callee: `${receiverImport.module}.${receiverImport.imported}.${method}`,
                receiver: receiverText,
                kind: 'external',
                module: receiverImport.module,
                importName: `${receiverImport.imported}.${method}`,
            };
        }
        const receiverTypeImport = Node.isIdentifier(receiver) ? localFacts.externalTypeBindings.get(receiverText) : undefined;
        if (receiverTypeImport?.isExternal) {
            return {
                callee: `${receiverTypeImport.module}.${receiverTypeImport.imported}.${method}`,
                receiver: receiverText,
                kind: 'external',
                module: receiverTypeImport.module,
                importName: `${receiverTypeImport.imported}.${method}`,
            };
        }
        const receiverKind = Node.isIdentifier(receiver) ? localFacts.receiverKinds.get(receiverText) : undefined;
        return {
            callee,
            ...(calleeId ? { calleeId } : {}),
            receiver: receiverText,
            kind: calleeId ? 'internal' : receiverKind ?? classifyCallKind(callee, receiverText, expr.getText()),
        };
    }
    if (Node.isIdentifier(expr)) {
        const localName = expr.getText();
        const imported = ctx.imports.get(localName);
        if (imported) {
            const callee = imported.isExternal ? `${imported.module}.${imported.imported}` : imported.imported;
            const candidates = symbolsByFqn.get(callee) ?? [];
            const calleeId = candidates[0]?.id;
            return {
                callee,
                ...(calleeId ? { calleeId } : {}),
                kind: calleeId ? 'internal' : 'external',
                module: imported.module,
                importName: imported.imported,
            };
        }
        const callee = localName;
        const candidates = symbolsByFqn.get(callee) ?? [];
        const calleeId = candidates[0]?.id;
        return { callee, ...(calleeId ? { calleeId } : {}), kind: calleeId ? 'internal' : classifyCallKind(callee, '', expr.getText()) };
    }
    return { callee: expr.getText(), kind: classifyCallKind(expr.getText(), '', expr.getText()) };
}

function collectLocalFacts(
    ctx: FunctionLikeCtx,
    symbolsByFqn: Map<string, CodeIntelSymbol[]>,
    symbolsById: Map<string, CodeIntelSymbol>,
): FunctionLocalFacts {
    const facts = emptyLocalFacts();
    for (const param of ctx.node.getParameters()) {
        addTypedReceiverFact(facts, ctx, param.getName(), param.getTypeNode()?.getText() ?? param.getType().getText(param));
    }
    ctx.node.forEachDescendant((node) => {
        if (!Node.isVariableDeclaration(node)) return;
        if (!Node.isIdentifier(node.getNameNode())) return;
        const name = node.getName();
        const declaredType = node.getTypeNode()?.getText();
        if (declaredType) addTypedReceiverFact(facts, ctx, name, declaredType);
        const initializer = unwrapInitializer(node.getInitializer());
        if (!initializer) return;

        if (Node.isNewExpression(initializer)) {
            facts.variableTypes.set(name, cleanTypeName(initializer.getExpression().getText()));
            return;
        }

        if (!Node.isCallExpression(initializer)) return;
        const resolved = resolveCall(initializer, ctx, symbolsByFqn, symbolsById, facts);
        if (resolved.kind === 'external' || resolved.kind === 'framework' || resolved.kind === 'built-in') {
            facts.receiverKinds.set(name, resolved.kind);
        }
        if (!resolved.calleeId) return;
        const callee = symbolsById.get(resolved.calleeId);
        const returnType = callee?.returnType ? cleanTypeName(callee.returnType) : undefined;
        if (returnType && returnType !== 'void' && returnType !== 'Promise') {
            facts.variableTypes.set(name, unwrapPromiseType(returnType));
        }
    });
    return facts;
}

function addTypedReceiverFact(
    facts: FunctionLocalFacts,
    ctx: FunctionLikeCtx,
    name: string,
    typeText: string,
): void {
    const typeName = cleanTypeName(unwrapPromiseType(typeText));
    if (!typeName || typeName === 'unknown' || typeName === 'any') return;
    facts.variableTypes.set(name, typeName);
    const imported = ctx.imports.get(typeName);
    if (!imported?.isExternal) return;
    facts.receiverKinds.set(name, 'external');
    facts.externalTypeBindings.set(name, imported);
}

function unwrapInitializer(node: MorphNode | undefined): MorphNode | undefined {
    let current = node;
    while (current && (Node.isAwaitExpression(current) || Node.isParenthesizedExpression(current))) {
        current = current.getExpression();
    }
    return current;
}

function unwrapPromiseType(typeName: string): string {
    const match = typeName.match(/^Promise<(.+)>$/);
    return match?.[1]?.trim() ?? typeName;
}

function emptyLocalFacts(): FunctionLocalFacts {
    return { variableTypes: new Map(), receiverKinds: new Map(), externalTypeBindings: new Map() };
}

function importsForSourceFile(sf: SourceFile): Map<string, ImportBinding> {
    const imports = new Map<string, ImportBinding>();
    for (const decl of sf.getImportDeclarations()) {
        const module = decl.getModuleSpecifierValue();
        const isExternal = !module.startsWith('.');
        const defaultImport = decl.getDefaultImport();
        if (defaultImport) {
            imports.set(defaultImport.getText(), { module, imported: 'default', isExternal });
        }
        const namespaceImport = decl.getNamespaceImport();
        if (namespaceImport) {
            imports.set(namespaceImport.getText(), { module, imported: '*', isExternal });
        }
        for (const named of decl.getNamedImports()) {
            const imported = named.getName();
            const alias = named.getAliasNode()?.getText() ?? imported;
            imports.set(alias, { module, imported, isExternal });
        }
    }
    return imports;
}

function collectImpacts(project: Project, symbols: CodeIntelSymbol[], root: string): CodeIntelImpact[] {
    const rawImpacts: CodeIntelImpact[] = [];
    const dtoSymbols = symbols.filter((symbol) => symbol.kind === 'dto' || symbol.kind === 'type');
    const dtoByName = new Map(dtoSymbols.map((dto) => [dto.name, dto]));
    const fieldsByName = new Map<string, Array<{ dto: CodeIntelSymbol; field: CodeIntelSymbol }>>();
    for (const field of symbols.filter((symbol) => symbol.kind === 'field' && symbol.parentId)) {
        const dto = dtoSymbols.find((candidate) => candidate.id === field.parentId);
        if (!dto) continue;
        const bucket = fieldsByName.get(field.name) ?? [];
        bucket.push({ dto, field });
        fieldsByName.set(field.name, bucket);
    }

    for (const sf of project.getSourceFiles()) {
        if (sf.isDeclarationFile()) continue;
        sf.forEachDescendant((node) => {
            if (Node.isIdentifier(node)) {
                const dto = dtoByName.get(node.getText());
                if (!dto) return;
                const loc = locOf(node, root);
                const kind = classifyImpact(node, sf);
                rawImpacts.push({
                    id: `impact:${dto.fqn}:${kind}:${loc.file}:${loc.line}:${loc.column}`,
                    symbolId: dto.id,
                    symbol: dto.fqn,
                    kind,
                    file: loc.file,
                    line: loc.line,
                    column: loc.column,
                    detail: node.getParent()?.getText().slice(0, 240) ?? dto.name,
                    risk: kind === 'endpoint' || kind === 'message' ? 'high' : kind === 'test' ? 'low' : 'medium',
                });
                return;
            }

            if (!Node.isPropertyAccessExpression(node)) return;
            const candidates = fieldsByName.get(node.getName());
            if (!candidates) return;
            const receiverFacts = receiverFactsFor(node);
            for (const { dto, field } of candidates) {
                if (!propertyAccessMatchesFieldOwner(dto, receiverFacts)) continue;
                const loc = locOf(node, root);
                rawImpacts.push({
                    id: `impact:${dto.fqn}.${field.name}:field:${loc.file}:${loc.line}:${loc.column}`,
                    symbolId: dto.id,
                    symbol: dto.fqn,
                    field: field.name,
                    kind: 'field-reference',
                    file: loc.file,
                    line: loc.line,
                    column: loc.column,
                    detail: node.getText(),
                    risk: 'medium',
                });
            }
        });
    }
    return rankAndDedupeImpacts(rawImpacts);
}

function rankAndDedupeImpacts(impacts: CodeIntelImpact[]): CodeIntelImpact[] {
    const grouped = new Map<string, CodeIntelImpact[]>();
    for (const impact of impacts) {
        const key = `${impact.symbolId}:${impact.file}:${impact.line}`;
        const bucket = grouped.get(key) ?? [];
        bucket.push(impact);
        grouped.set(key, bucket);
    }

    const out: CodeIntelImpact[] = [];
    for (const bucket of grouped.values()) {
        bucket.sort((a, b) => impactWeight(a.kind) - impactWeight(b.kind));
        out.push(bucket[0]);
    }
    return out;
}

function impactWeight(kind: CodeIntelImpact['kind']): number {
    switch (kind) {
        case 'endpoint':
            return 0;
        case 'message':
            return 1;
        case 'field-reference':
            return 2;
        case 'type-reference':
            return 3;
        case 'mapper':
            return 4;
        case 'test':
            return 5;
    }
}

function classifyImpact(node: MorphNode, sf: SourceFile): CodeIntelImpact['kind'] {
    const file = sf.getFilePath();
    if (/\.(spec|test)\.tsx?$/.test(file)) return 'test';
    if (/mapper|adapter|transform/i.test(file)) return 'mapper';
    const method = node.getFirstAncestorByKind(SyntaxKind.MethodDeclaration);
    const decorators = method ? decoratorsOf(method).join(' ') : '';
    if (/@(?:Get|Post|Put|Patch|Delete|Controller|Body|Param|Query)\b/.test(decorators)) return 'endpoint';
    if (/@(?:MessagePattern|EventPattern|NatsMessagePattern|RmqEventPattern)\b/.test(decorators)) return 'message';
    if (/\.tsx$/.test(file) || /components|views|pages/i.test(file)) return 'type-reference';
    return 'type-reference';
}

interface ReceiverFacts {
    receiverName: string;
    typeText: string;
}

function receiverFactsFor(node: PropertyAccessExpression): ReceiverFacts {
    const receiver = node.getExpression();
    const receiverText = receiver.getText();
    return {
        receiverName: receiverText.split('.').at(-1) ?? receiverText,
        typeText: safeTypeText(receiver),
    };
}

function propertyAccessMatchesFieldOwner(dto: CodeIntelSymbol, facts: ReceiverFacts): boolean {
    const normalizedDto = normalizeName(dto.name);
    const normalizedReceiver = normalizeName(facts.receiverName);
    if (normalizedReceiver === normalizedDto) return true;
    if (normalizedReceiver === normalizedDto.replace(/(dto|request|response|payload|command|event)$/i, '')) return true;

    const typeText = facts.typeText;
    return typeText === dto.name ||
        typeText.includes(dto.name) ||
        typeText.includes(`import("${dto.file}")`) && typeText.includes(dto.name);
}

function safeTypeText(node: MorphNode): string {
    try {
        return node.getType().getText(node);
    } catch {
        return '';
    }
}

function normalizeName(name: string): string {
    return name.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function sourceForParam(param: ParameterDeclaration): { kind: CodeIntelFlow['sourceKind']; label: string } {
    const decorators = decoratorsOf(param);
    const transport = decorators.find((decorator) =>
        /@(Body|Param|Query|Payload|Headers|Req|Request|UploadedFile|UploadedFiles)\b/.test(decorator),
    );
    if (!transport) return { kind: 'param', label: param.getName() };
    const match = transport.match(/@([A-Za-z0-9_]+)/);
    const decoratorName = match?.[1] ?? transport;
    let kind: CodeIntelFlow['sourceKind'] = 'decorator';
    if (/@(?:Body|Param|Query|Headers|Req|Request|UploadedFile|UploadedFiles)\b/.test(transport)) {
        kind = 'http';
    } else if (/@(?:Payload|Ctx)\b/.test(transport)) {
        kind = 'msg';
    }
    return { kind, label: `${decoratorName.startsWith('@') ? decoratorName : `@${decoratorName}`} ${param.getName()}` };
}

function classifyCallKind(callee: string, receiver: string, expression: string): NonNullable<CodeIntelCall['kind']> {
    const text = `${receiver} ${callee} ${expression}`;
    if (receiver.startsWith('process.') || receiver === 'process') return 'process-env';
    if (/\blogger\b/i.test(text)) return 'framework';
    if (receiver && isCommonObjectMethod(callee.split('.').at(-1) ?? callee)) return 'common-object-method';
    if (!receiver.startsWith('/') && /\b(queryBuilder|createQueryBuilder|queryRunner|repository|manager)\b/i.test(`${receiver} ${expression}`)) {
        return 'framework';
    }
    if (isBuiltIn(callee) || isBuiltIn(receiver.split('.').at(0) ?? receiver)) return 'built-in';
    return 'unknown';
}

function isBuiltIn(name: string): boolean {
    return new Set([
        'Array',
        'Boolean',
        'Date',
        'Error',
        'JSON',
        'Map',
        'Math',
        'Number',
        'Object',
        'Promise',
        'Reflect',
        'RegExp',
        'Set',
        'String',
        'console',
        'parseInt',
        'parseFloat',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
    ]).has(name);
}

function isCommonObjectMethod(method: string): boolean {
    return new Set([
        'add',
        'at',
        'catch',
        'charCodeAt',
        'concat',
        'delete',
        'entries',
        'every',
        'filter',
        'find',
        'findIndex',
        'flat',
        'flatMap',
        'forEach',
        'get',
        'has',
        'includes',
        'join',
        'keys',
        'map',
        'match',
        'padStart',
        'padEnd',
        'pop',
        'push',
        'reduce',
        'replace',
        'set',
        'slice',
        'some',
        'sort',
        'split',
        'startsWith',
        'test',
        'toFixed',
        'toLowerCase',
        'toLocaleString',
        'toString',
        'trim',
        'trimEnd',
        'trimStart',
        'values',
    ]).has(method);
}

function expressionUsesName(text: string, name: string): boolean {
    return new RegExp(`\\b${escapeRegExp(name)}\\b`).test(text);
}

function symbolForNode(
    node: MorphNode,
    kind: CodeIntelSymbol['kind'],
    name: string,
    fqn: string,
    root: string,
    extra: Partial<CodeIntelSymbol> = {},
): CodeIntelSymbol {
    const loc = locOf(node, root);
    const score = computeQualityScore(node, extra);
    return {
        id: `symbol:${loc.file}#${fqn}:${loc.line}:${loc.column}`,
        kind,
        name,
        fqn,
        file: loc.file,
        line: loc.line,
        column: loc.column,
        endLine: endLineOf(node),
        qualityScore: score,
        ...withoutUndefined(extra),
    };
}

function computeQualityScore(node: MorphNode, extra: Partial<CodeIntelSymbol>): number {
    let score = 0;
    if (extra.name && /^(Base|Abstract|Internal)/.test(extra.name)) score -= 5;
    if (extra.description && extra.description.length > 20) score += 2;
    if (extra.decorators && extra.decorators.length > 0) {
        const uniqueDecos = new Set(extra.decorators.map((d) => d.split('(')[0])).size;
        score += uniqueDecos * 1.5;
    }
    if (Node.isClassDeclaration(node) || Node.isInterfaceDeclaration(node)) {
        const members = Node.isClassDeclaration(node) ? node.getProperties().length : (node as any).getMembers?.().length ?? 0;
        if (members >= 3 && members <= 15) score += 3;
        if (members > 15) score += 1;
    }
    if (extra.visibility === 'public') score += 1;
    if (extra.isAsync) score += 0.5;
    return score;
}

function locOf(node: MorphNode, root: string): { file: string; line: number; column: number } {
    const sf = node.getSourceFile();
    const pos = sf.getLineAndColumnAtPos(node.getStart());
    const file = sf.getFilePath().replace(root, '').replace(/^\/+/, '');
    return { file, line: pos.line, column: pos.column };
}

function endLineOf(node: MorphNode): number {
    return node.getSourceFile().getLineAndColumnAtPos(node.getEnd()).line;
}

function signatureOf(fn: MethodDeclaration | FunctionDeclaration): string {
    const params = fn.getParameters()
        .map((param) => `${param.getName()}: ${param.getTypeNode()?.getText() ?? param.getType().getText(param)}`)
        .join(', ');
    const ret = fn.getReturnTypeNode()?.getText() ?? fn.getReturnType().getText(fn);
    return `(${params}) => ${ret}`;
}

function descriptionOf(node: MorphNode): string | undefined {
    const docs = (node as { getJsDocs?: () => Array<{ getCommentText?: () => string | undefined; getText: () => string }> }).getJsDocs?.();
    const text = docs?.[0]?.getCommentText?.() ?? docs?.[0]?.getText?.();
    if (!text) return undefined;
    return text
        .replace(/^\/\*\*|\*\/$/g, '')
        .split('\n')
        .map((line) => line.replace(/^\s*\*\s?/, '').trim())
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240) || undefined;
}

function decoratorsOf(node: MorphNode): string[] {
    return (node as { getDecorators?: () => Array<{ getText: () => string }> }).getDecorators?.()
        .map((decorator) => decorator.getText()) ?? [];
}

function isDtoName(name: string): boolean {
    return /(Dto|DTO|Request|Response|Payload|Command|Event)$/.test(name);
}

function isEntityName(name: string): boolean {
    return /(Entity)$/.test(name);
}

function cleanTypeName(typeName: string): string {
    return typeName.replace(/^readonly\s+/, '').replace(/\s*\|.*$/, '').replace(/<.*>$/, '').trim();
}

function compactNodeText(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function withoutUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
    return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Heritage pass helpers (A1–A7) ──────────────────────────────────────────

/**
 * Collect tsconfig path aliases from any tsconfig*.json / tsconfig.base.json
 * files present in the in-memory project. Returns a map of alias → resolved
 * absolute file path (the first entry in the `paths` array).
 *
 * Only the first path entry per alias is used (barrels always list one target).
 * Paths are relative to the tsconfig file's directory.
 */
function collectPathAliases(project: Project, root: string): Map<string, string> {
    const aliases = new Map<string, string>();
    for (const sf of project.getSourceFiles()) {
        const filePath = sf.getFilePath();
        if (!/tsconfig.*\.json$/.test(filePath)) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(sf.getFullText());
        } catch {
            continue;
        }
        if (!parsed || typeof parsed !== 'object') continue;
        const co = (parsed as Record<string, unknown>).compilerOptions;
        if (!co || typeof co !== 'object') continue;
        const pathsObj = (co as Record<string, unknown>).paths;
        if (!pathsObj || typeof pathsObj !== 'object') continue;
        const tsConfigDir = filePath.replace(/\/[^/]+$/, '');
        for (const [alias, targets] of Object.entries(pathsObj as Record<string, string[]>)) {
            if (!Array.isArray(targets) || targets.length === 0) continue;
            const firstTarget = targets[0];
            // Resolve relative to the tsconfig dir; normalise to absolute.
            const absTarget = firstTarget.startsWith('/')
                ? firstTarget
                : `${tsConfigDir}/${firstTarget}`;
            // Strip the `root` prefix so we can compare against symbol files.
            // Keep as absolute path for resolution later.
            aliases.set(alias, absTarget);
        }
    }
    return aliases;
}

/**
 * Resolve a module specifier to a source file in the project.
 * Handles: relative imports, tsconfig path aliases.
 * Returns undefined if the base cannot be located.
 */
function resolveImportToSourceFile(
    moduleSpecifier: string,
    importingFilePath: string,
    project: Project,
    pathAliases: Map<string, string>,
): SourceFile | undefined {
    if (moduleSpecifier.startsWith('.')) {
        // Relative import — resolve from the importing file's directory.
        const importingDir = importingFilePath.replace(/\/[^/]+$/, '');
        const candidates = [
            `${importingDir}/${moduleSpecifier}`,
            `${importingDir}/${moduleSpecifier}.ts`,
            `${importingDir}/${moduleSpecifier}/index.ts`,
        ];
        for (const candidate of candidates) {
            const sf = project.getSourceFile(candidate);
            if (sf) return sf;
        }
        return undefined;
    }

    // Path alias — try exact match first, then prefix match (e.g. `@org/pkg/*`).
    const exactTarget = pathAliases.get(moduleSpecifier);
    if (exactTarget) {
        // The target is a barrel; resolve it directly.
        const sf = project.getSourceFile(exactTarget);
        if (sf) return sf;
        // Also try without extension or with .ts
        for (const ext of ['', '.ts', '/index.ts']) {
            const sf2 = project.getSourceFile(exactTarget + ext);
            if (sf2) return sf2;
        }
    }

    // Prefix wildcard aliases, e.g. `@org/pkg/*` → `libs/pkg/src/*`
    for (const [alias, target] of pathAliases) {
        if (!alias.endsWith('/*')) continue;
        const prefix = alias.slice(0, -2); // strip `/*`
        if (!moduleSpecifier.startsWith(prefix + '/')) continue;
        const suffix = moduleSpecifier.slice(prefix.length + 1);
        const baseTarget = target.endsWith('/index.ts')
            ? target.replace('/index.ts', '')
            : target.endsWith('/*')
                ? target.slice(0, -2)
                : target;
        const candidates = [
            `${baseTarget}/${suffix}`,
            `${baseTarget}/${suffix}.ts`,
            `${baseTarget}/${suffix}/index.ts`,
        ];
        for (const candidate of candidates) {
            const sf = project.getSourceFile(candidate);
            if (sf) return sf;
        }
    }

    return undefined;
}

/**
 * Given a source file (possibly a barrel), resolve the exported name to the
 * source file that actually declares it. Follows one level of re-exports.
 */
function resolveExportedNameToSourceFile(
    barrelSf: SourceFile,
    exportedName: string,
    project: Project,
    pathAliases: Map<string, string>,
): SourceFile | undefined {
    // Check if the name is declared directly in this file.
    if (barrelSf.getClasses().some((c) => c.getName() === exportedName)) return barrelSf;

    // Look for re-export: `export { FooBase } from './base.controller'`
    for (const decl of barrelSf.getExportDeclarations()) {
        const namedExports = decl.getNamedExports();
        const found = namedExports.find((ne) => {
            // exported name could be aliased: `export { Foo as FooAlias }`
            return ne.getAliasNode()?.getText() === exportedName || ne.getName() === exportedName;
        });
        if (!found) continue;
        const moduleSpec = decl.getModuleSpecifierValue();
        if (!moduleSpec) continue;
        const nextSf = resolveImportToSourceFile(moduleSpec, barrelSf.getFilePath(), project, pathAliases);
        if (nextSf) return nextSf;
    }

    // Also handle `export * from './x'`
    for (const decl of barrelSf.getExportDeclarations()) {
        if (decl.getNamedExports().length > 0) continue; // already handled
        const moduleSpec = decl.getModuleSpecifierValue();
        if (!moduleSpec) continue;
        const nextSf = resolveImportToSourceFile(moduleSpec, barrelSf.getFilePath(), project, pathAliases);
        if (!nextSf) continue;
        if (nextSf.getClasses().some((c) => c.getName() === exportedName)) return nextSf;
    }

    return undefined;
}

/**
 * Resolve a base class name (as it appears in the extends clause) to the
 * CodeIntelSymbol for that class.
 *
 * Strategy:
 * 1. Look up the name in the current file's class declarations.
 * 2. Look up the name in the imports map → resolve the import to a source file
 *    (relative or path-alias) → find the class in that file.
 * 3. Fallback: search symbolsByFqn directly (handles cases where the class was
 *    already indexed from a cross-file source in the same project run).
 */
function resolveBaseClassSymbol(
    baseName: string,
    currentFilePath: string,
    imports: Map<string, ImportBinding>,
    project: Project,
    pathAliases: Map<string, string>,
    symbolsByFqn: Map<string, CodeIntelSymbol[]>,
): CodeIntelSymbol | undefined {
    // 1. Same-file — direct FQN lookup.
    const sameFileCandidates = (symbolsByFqn.get(baseName) ?? []).filter(
        (s) => s.kind === 'class' && s.file === currentFilePath.replace(/^\/+/, '').replace(/^.*?(?=src\/)/, ''),
    );
    // More precise: match by absolute path.
    const absoluteCurrentFile = currentFilePath;
    const byFilePath = (symbolsByFqn.get(baseName) ?? []).filter((s) => {
        // s.file is relative (root-stripped); reconstruct absolute path not feasible here.
        // Instead check imports map first.
        return s.kind === 'class';
    });

    // Try imports map first (handles same-file and cross-file).
    const importBinding = imports.get(baseName);
    if (importBinding) {
        if (!importBinding.isExternal) {
            // Relative import — resolve and find the class in that file.
            const targetSf = resolveImportToSourceFile(importBinding.module, absoluteCurrentFile, project, pathAliases);
            if (targetSf) {
                // First check if the class is directly in this file.
                let sourceSf = targetSf;
                if (!targetSf.getClasses().some((c) => c.getName() === baseName)) {
                    // It's a barrel — follow re-exports.
                    const deeper = resolveExportedNameToSourceFile(targetSf, baseName, project, pathAliases);
                    if (deeper) sourceSf = deeper;
                }
                const candidates = (symbolsByFqn.get(baseName) ?? []).filter(
                    (s) => s.kind === 'class' && sourceSf.getClasses().some((c) => c.getName() === baseName),
                );
                // Find the symbol whose file path matches the resolved source file.
                const sfPath = sourceSf.getFilePath();
                const match = (symbolsByFqn.get(baseName) ?? []).find(
                    (s) => s.kind === 'class' && sfPath.includes(s.file),
                );
                if (match) return match;
            }
        } else {
            // External path alias — look up via path alias map.
            const targetSf = resolveImportToSourceFile(importBinding.module, absoluteCurrentFile, project, pathAliases);
            if (targetSf) {
                let sourceSf = targetSf;
                if (!targetSf.getClasses().some((c) => c.getName() === baseName)) {
                    const deeper = resolveExportedNameToSourceFile(targetSf, baseName, project, pathAliases);
                    if (deeper) sourceSf = deeper;
                }
                const sfPath = sourceSf.getFilePath();
                const match = (symbolsByFqn.get(baseName) ?? []).find(
                    (s) => s.kind === 'class' && sfPath.includes(s.file),
                );
                if (match) return match;
            }
        }
    }

    // 2. Fallback: best match from symbolsByFqn (same-file preference).
    const allCandidates = (symbolsByFqn.get(baseName) ?? []).filter((s) => s.kind === 'class');
    if (allCandidates.length === 1) return allCandidates[0];
    // Prefer the one from the same file.
    const sameFile = allCandidates.find((s) => absoluteCurrentFile.endsWith(s.file) || absoluteCurrentFile.includes(s.file));
    return sameFile ?? allCandidates[0];
}

/**
 * Given a method node, classify how it interacts with its base implementation.
 *
 * delegation — body is exactly `return super.X(args)` or `return await super.X(args)`
 *              with identity-passthrough (all super call args are bare parameter names,
 *              same set as the method's own parameters, no transformation).
 * augmented  — calls super but the body has other statements or transforms args.
 * replaced   — does not reference super at all.
 */
function classifyOverrideKind(method: MethodDeclaration): 'delegation' | 'augmented' | 'replaced' {
    const body = method.getBody();
    if (!body) return 'replaced';

    // Collect all super property-access call expressions in the body.
    const superCalls: CallExpression[] = [];
    body.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        const expr = node.getExpression();
        if (!Node.isPropertyAccessExpression(expr)) return;
        const obj = expr.getExpression();
        if (Node.isSuperExpression(obj)) superCalls.push(node);
    });

    if (superCalls.length === 0) return 'replaced';

    // Check for delegation: body has exactly one statement, which is
    // `return super.X(...identityArgs)`.
    const statements = body.getStatements();
    if (statements.length !== 1) return 'augmented';

    const stmt = statements[0];
    if (!Node.isReturnStatement(stmt)) return 'augmented';

    const returnExpr = stmt.getExpression();
    // Unwrap optional `await`.
    const inner = returnExpr && Node.isAwaitExpression(returnExpr)
        ? returnExpr.getExpression()
        : returnExpr;

    if (!inner || !Node.isCallExpression(inner)) return 'augmented';
    const innerExpr = inner.getExpression();
    if (!Node.isPropertyAccessExpression(innerExpr)) return 'augmented';
    if (!Node.isSuperExpression(innerExpr.getExpression())) return 'augmented';

    // Verify identity-passthrough: super call args must be bare identifier names
    // that match the method's parameter names exactly (same names, no transforms).
    const methodParamNames = method.getParameters().map((p) => p.getName());
    const superArgs = inner.getArguments().map((a) => a.getText().trim());

    // All super args must be bare identifiers matching method params.
    const isIdentityPassthrough = superArgs.every((arg) => {
        // Must be a simple identifier (no transforms like `{ ...arg }`, `arg.x`, etc.)
        return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(arg) && methodParamNames.includes(arg);
    });

    return isIdentityPassthrough ? 'delegation' : 'augmented';
}

/**
 * Walk the extends chain (following extendsClass ids through symbolsById) to
 * find the nearest ancestor class that declares a method named `methodName`.
 * Returns the symbol for that base method, or undefined if none found.
 */
function findAncestorMethod(
    baseClassId: string | undefined,
    methodName: string,
    symbolsById: Map<string, CodeIntelSymbol>,
    symbolsByFqn: Map<string, CodeIntelSymbol[]>,
): CodeIntelSymbol | undefined {
    let currentId = baseClassId;
    const visited = new Set<string>();
    while (currentId) {
        if (visited.has(currentId)) break; // cycle guard
        visited.add(currentId);
        const cls = symbolsById.get(currentId);
        if (!cls) break;
        // Look for a method with this name under this class.
        const methodFqn = `${cls.name}.${methodName}`;
        const candidates = symbolsByFqn.get(methodFqn) ?? [];
        // Prefer the one belonging to this exact class (file match).
        const match = candidates.find((s) => (s.kind === 'method' || s.kind === 'field') && s.file === cls.file)
            ?? candidates.find((s) => s.kind === 'method' || s.kind === 'field');
        if (match) return match;
        // Climb to the grandparent.
        currentId = cls.extendsClass;
    }
    return undefined;
}

/**
 * Main heritage extraction for one class. Called per-class with its own
 * try/catch in the caller (A7 isolation).
 */
function extractHeritageForClass(
    cls: ClassDeclaration,
    name: string,
    sf: SourceFile,
    imports: Map<string, ImportBinding>,
    project: Project,
    root: string,
    pathAliases: Map<string, string>,
    symbolsByFqn: Map<string, CodeIntelSymbol[]>,
    symbolsById: Map<string, CodeIntelSymbol>,
    calls: CodeIntelCall[],
): void {
    // Find the class's own symbol.
    const filePath = sf.getFilePath();
    const classSymbol = (symbolsByFqn.get(name) ?? []).find(
        (s) => s.kind === 'class' && filePath.includes(s.file),
    );
    if (!classSymbol) return;

    // ── A1: extendsClass + extendsTypeArgs ──────────────────────────────────
    const heritageClause = cls.getHeritageClauseByKind(SyntaxKind.ExtendsKeyword);
    if (!heritageClause) return; // no extends → nothing to do

    const [heritageType] = heritageClause.getTypeNodes();
    if (!heritageType) return;

    const baseExpr = heritageType.getExpression();
    const baseName = baseExpr.getText();

    // Capture type args verbatim.
    const typeArgs = heritageType.getTypeArguments();
    if (typeArgs.length > 0) {
        classSymbol.extendsTypeArgs = typeArgs.map((ta) => ta.getText());
    }

    // Resolve the base class symbol.
    const baseClassSymbol = resolveBaseClassSymbol(
        baseName,
        filePath,
        imports,
        project,
        pathAliases,
        symbolsByFqn,
    );
    if (baseClassSymbol) {
        classSymbol.extendsClass = baseClassSymbol.id;
    }

    // ── A2+A3: methods — inheritsFrom, overrideKind, super-call edges ───────
    if (!baseClassSymbol) return; // can't resolve — skip method pass (A7: class still in index)

    let superCallOrder = 0;
    for (const method of cls.getMethods()) {
        const methodName = method.getName();
        const methodFqn = `${name}.${methodName}`;
        const methodSymbol = (symbolsByFqn.get(methodFqn) ?? []).find(
            (s) => (s.kind === 'method') && filePath.includes(s.file),
        );
        if (!methodSymbol) continue;

        // A6: walk the chain to find the nearest ancestor declaring this method.
        const ancestorMethod = findAncestorMethod(
            baseClassSymbol.id,
            methodName,
            symbolsById,
            symbolsByFqn,
        );
        if (!ancestorMethod) continue; // method only exists in subclass, no inheritsFrom

        methodSymbol.inheritsFrom = ancestorMethod.id;
        methodSymbol.overrideKind = classifyOverrideKind(method);

        // A3: emit super-call edges for each `super.X(...)` site.
        const body = method.getBody();
        if (!body) continue;
        body.forEachDescendant((node) => {
            if (!Node.isCallExpression(node)) return;
            const expr = node.getExpression();
            if (!Node.isPropertyAccessExpression(expr)) return;
            const obj = expr.getExpression();
            if (!Node.isSuperExpression(obj)) return;
            const superMethodName = expr.getName();
            // Find the base method being called (may differ from the containing method name).
            const superMethodFqn = `${baseClassSymbol.name}.${superMethodName}`;
            // Walk the chain for the super call target too.
            let targetSymbol: CodeIntelSymbol | undefined = (symbolsByFqn.get(superMethodFqn) ?? []).find(
                (s) => s.kind === 'method',
            );
            if (!targetSymbol) {
                targetSymbol = findAncestorMethod(baseClassSymbol.id, superMethodName, symbolsById, symbolsByFqn);
            }
            if (!targetSymbol) return;

            const loc = locOf(node, root);
            const superCallId = `call:${methodFqn}:super:${superCallOrder}:${loc.line}:${loc.column}`;
            superCallOrder++;
            calls.push({
                id: superCallId,
                callerId: methodSymbol.id,
                caller: methodFqn,
                callee: targetSymbol.fqn,
                calleeId: targetSymbol.id,
                kind: 'super-call',
                order: superCallOrder,
                file: loc.file,
                line: loc.line,
                column: loc.column,
                expression: node.getText(),
                args: node.getArguments().map((a) => a.getText()),
            });
        });
    }
}
