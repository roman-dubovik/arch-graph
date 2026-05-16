import {
    ClassDeclaration,
    Decorator,
    MethodDeclaration,
    NewExpression,
    Node,
    Project,
    SourceFile,
    SyntaxKind,
} from 'ts-morph';

import type { DiFilterChainRef, DiFilterDecorator, SourceLoc } from '../../core/types.js';
import { isExcludedSourceFile } from '../shared.js';

/**
 * Walk every source file in `project`, find `@UseGuards / @UseInterceptors /
 * @UsePipes` decorators on class declarations and their methods, and emit one
 * `DiFilterChainRef` per argument per decorator.
 *
 * Argument shapes:
 *   - bare identifier `AuthGuard`         → kind: 'class'
 *   - `new LoggingInterceptor()`          → kind: 'instance'
 *   - anything else (spread, call, etc.)  → kind: 'unresolved'
 *
 * Files excluded by `isExcludedSourceFile` are skipped entirely.
 */
export function extractFilterChain(project: Project): DiFilterChainRef[] {
    const refs: DiFilterChainRef[] = [];

    for (const sf of project.getSourceFiles()) {
        if (isExcludedSourceFile(sf)) continue;
        extractFromSourceFile(sf, refs);
    }

    return refs;
}

function extractFromSourceFile(sf: SourceFile, refs: DiFilterChainRef[]): void {
    for (const cls of sf.getClasses()) {
        const className = cls.getName();
        if (!className) continue;

        // Class-level decorators
        for (const dec of cls.getDecorators()) {
            const decName = filterDecoratorName(dec);
            if (!decName) continue;
            extractFromDecorator(dec, decName, className, { kind: 'class' }, sf, refs);
        }

        // Method-level decorators
        for (const method of cls.getMethods()) {
            const methodName = method.getName();
            for (const dec of method.getDecorators()) {
                const decName = filterDecoratorName(dec);
                if (!decName) continue;
                extractFromDecorator(
                    dec,
                    decName,
                    className,
                    { kind: 'method', methodName },
                    sf,
                    refs,
                );
            }
        }
    }
}

function filterDecoratorName(dec: Decorator): DiFilterDecorator | null {
    const name = dec.getName();
    if (name === 'UseGuards' || name === 'UseInterceptors' || name === 'UsePipes') {
        return name as DiFilterDecorator;
    }
    return null;
}

function extractFromDecorator(
    dec: Decorator,
    decorator: DiFilterDecorator,
    enclosingClass: string,
    attachedTo: DiFilterChainRef['attachedTo'],
    sf: SourceFile,
    refs: DiFilterChainRef[],
): void {
    const args = dec.getArguments();

    // Decorator called with no arguments — nothing to emit
    if (args.length === 0) return;

    for (const arg of args) {
        const location = locationOf(sf, arg.getStart());
        const ref = decodeArg(arg, decorator, enclosingClass, attachedTo, location);
        refs.push(ref);
    }
}

function decodeArg(
    arg: Node,
    decorator: DiFilterDecorator,
    enclosingClass: string,
    attachedTo: DiFilterChainRef['attachedTo'],
    location: SourceLoc,
): DiFilterChainRef {
    const kind = arg.getKind();

    // Bare identifier: @UseGuards(AuthGuard)
    if (kind === SyntaxKind.Identifier) {
        return {
            kind: 'class',
            name: arg.getText(),
            decorator,
            location,
            enclosingClass,
            attachedTo,
        };
    }

    // new expression: @UseInterceptors(new LoggingInterceptor())
    if (kind === SyntaxKind.NewExpression) {
        const newExpr = arg as NewExpression;
        const expr = newExpr.getExpression();
        const name = expr.getText().trim();
        return {
            kind: 'instance',
            name,
            decorator,
            location,
            enclosingClass,
            attachedTo,
        };
    }

    // Spread element, function call, ternary, template literal, etc. → unresolved
    const raw = arg.getText().replace(/\s+/g, ' ').slice(0, 80);
    const reason = `unresolved-arg-kind-${SyntaxKind[kind]}`;
    return {
        kind: 'unresolved',
        raw,
        reason,
        decorator,
        location,
        enclosingClass,
        attachedTo,
    };
}

function locationOf(sf: SourceFile, pos: number): SourceLoc {
    const lc = sf.getLineAndColumnAtPos(pos);
    return { file: sf.getFilePath(), line: lc.line, column: lc.column };
}
