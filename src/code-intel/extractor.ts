import { Node, Project, SyntaxKind, type CallExpression, type FunctionDeclaration, type MethodDeclaration, type Node as MorphNode, type ParameterDeclaration, type PropertyAccessExpression, type SourceFile, type TypeAliasDeclaration } from 'ts-morph';

import type {
    CodeIntelBranch,
    CodeIntelCall,
    CodeIntelFlow,
    CodeIntelImpact,
    CodeIntelIndex,
    CodeIntelSymbol,
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
    const symbolByFqn = new Map<string, CodeIntelSymbol>();
    const functionContexts: FunctionLikeCtx[] = [];

    const addSymbol = (symbol: CodeIntelSymbol): void => {
        if (symbolByFqn.has(symbol.fqn)) return;
        symbols.push(symbol);
        symbolByFqn.set(symbol.fqn, symbol);
    };

    for (const sf of project.getSourceFiles()) {
        if (sf.isDeclarationFile()) continue;
        const imports = importsForSourceFile(sf);
        for (const cls of sf.getClasses()) {
            const name = cls.getName();
            if (!name) continue;
            const classKind = isDtoName(name) ? 'dto' : 'class';
            const classSymbol = symbolForNode(cls, classKind, name, name, opts.root, {
                description: descriptionOf(cls),
                decorators: decoratorsOf(cls),
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
    }

    for (const ctx of functionContexts) {
        collectFunctionFacts(ctx, symbolByFqn, calls, flows, branches, opts.root);
    }

    const impacts = collectImpacts(project, symbols, opts.root);
    return buildIndex(opts.root, symbols, calls, flows, branches, impacts);
}

function buildIndex(
    root: string,
    symbols: CodeIntelSymbol[],
    calls: CodeIntelCall[],
    flows: CodeIntelFlow[],
    branches: CodeIntelBranch[],
    impacts: CodeIntelImpact[],
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
    };
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
    symbolByFqn: Map<string, CodeIntelSymbol>,
    calls: CodeIntelCall[],
    flows: CodeIntelFlow[],
    branches: CodeIntelBranch[],
    root: string,
): void {
    const params = ctx.node.getParameters();
    const callByNode = new Map<CallExpression, CodeIntelCall>();
    const localFacts = collectLocalFacts(ctx, symbolByFqn);
    ctx.node.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        if (node.getFirstAncestorByKind(SyntaxKind.Decorator)) return;
        const resolved = resolveCall(node, ctx, symbolByFqn, localFacts);
        const loc = locOf(node);
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
        collectParamFlows(ctx, param, calls.filter((call) => call.callerId === ctx.id), flows, symbolByFqn);
    }

    collectFunctionLocalFlows(ctx, flows);

    ctx.node.forEachDescendant((node) => {
        if (Node.isIfStatement(node)) {
            const loc = locOf(node.getExpression());
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
                const elseLoc = locOf(elseStatement);
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
            const loc = locOf(node.getCondition());
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
                const loc = locOf(clause);
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
            const loc = locOf(node);
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
                const loc = locOf(catchClause);
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
                const loc = locOf(node);
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
        const loc = locOf(node);
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
    symbolByFqn: Map<string, CodeIntelSymbol>,
    root: string,
): void {
    const paramName = param.getName();
    const source = sourceForParam(param);
    const aliases = aliasesForParam(ctx, paramName);
    for (const call of callerCalls) {
        const usedAliasesByArg = call.args.map((arg) => Array.from(aliases).filter((alias) => expressionUsesName(arg, alias)));
        const usedAliases = usedAliasesByArg.flat();
        if (usedAliases.length === 0) continue;
        const calleeParams = paramsForCall(symbolByFqn, call);
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
            const loc = locOf(node);
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
            const loc = locOf(node);
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

function paramsForCall(symbolByFqn: Map<string, CodeIntelSymbol>, call: CodeIntelCall): CodeIntelSymbol[] {
    if (!call.calleeId) return [];
    return Array.from(symbolByFqn.values())
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
        return node.getElements().flatMap((element) => namesFromBindingName(element.getNameNode()));
    }
    return [];
}

function resolveCall(
    call: CallExpression,
    ctx: FunctionLikeCtx,
    symbolByFqn: Map<string, CodeIntelSymbol>,
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
        calleeId = symbolByFqn.get(callee)?.id;
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
            const calleeId = symbolByFqn.get(callee)?.id;
            return {
                callee,
                ...(calleeId ? { calleeId } : {}),
                kind: calleeId ? 'internal' : 'external',
                module: imported.module,
                importName: imported.imported,
            };
        }
        const callee = localName;
        const calleeId = symbolByFqn.get(callee)?.id;
        return { callee, ...(calleeId ? { calleeId } : {}), kind: calleeId ? 'internal' : classifyCallKind(callee, '', expr.getText()) };
    }
    return { callee: expr.getText(), kind: classifyCallKind(expr.getText(), '', expr.getText()) };
}

function collectLocalFacts(
    ctx: FunctionLikeCtx,
    symbolByFqn: Map<string, CodeIntelSymbol>,
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
        const resolved = resolveCall(initializer, ctx, symbolByFqn, facts);
        if (resolved.kind === 'external' || resolved.kind === 'framework' || resolved.kind === 'built-in') {
            facts.receiverKinds.set(name, resolved.kind);
        }
        if (!resolved.calleeId) return;
        const callee = symbolById(symbolByFqn, resolved.calleeId);
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

function symbolById(symbolByFqn: Map<string, CodeIntelSymbol>, id: string): CodeIntelSymbol | undefined {
    for (const symbol of symbolByFqn.values()) {
        if (symbol.id === id) return symbol;
    }
    return undefined;
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
        // Sort by weight: lower is better
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
    return {
        id: `symbol:${fqn}`,
        kind,
        name,
        fqn,
        file: loc.file,
        line: loc.line,
        column: loc.column,
        endLine: endLineOf(node),
        ...withoutUndefined(extra),
    };
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

function cleanTypeName(typeName: string): string {
    return typeName.replace(/^readonly\s+/, '').replace(/\s*\|.*$/, '').replace(/<.*>$/, '').trim();
}

function compactNodeText(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
    }
    return out;
}

function withoutUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
    return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
