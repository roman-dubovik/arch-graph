import {
    AsExpression,
    ClassDeclaration,
    Decorator,
    Expression,
    MethodDeclaration,
    NewExpression,
    Node,
    ParenthesizedExpression,
    Project,
    PropertyAccessExpression,
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
 *   - bare identifier `AuthGuard`              → kind: 'class'
 *   - `new LoggingInterceptor()`               → kind: 'instance'
 *   - `Namespace.Guard` (PropertyAccess)       → kind: 'class', name = rightmost identifier
 *   - `new factory.create()` (non-identifier)  → kind: 'unresolved', reason: 'new-non-identifier-expression'
 *   - `(AuthGuard)` / `AuthGuard as any`       → unwrapped transparently before dispatch
 *   - anything else (spread, call, etc.)       → kind: 'unresolved'
 *
 * Anonymous / default-export classes (no `getName()`) are not silently dropped:
 * the source file path is collected in `skippedAnonymousFiles`.
 *
 * Files excluded by `isExcludedSourceFile` are skipped entirely.
 */
export function extractFilterChain(
    project: Project,
): { refs: DiFilterChainRef[]; skippedAnonymousFiles: string[] } {
    const refs: DiFilterChainRef[] = [];
    const skippedAnonymousFiles: string[] = [];

    for (const sf of project.getSourceFiles()) {
        if (isExcludedSourceFile(sf)) continue;
        extractFromSourceFile(sf, refs, skippedAnonymousFiles);
    }

    return { refs, skippedAnonymousFiles };
}

function extractFromSourceFile(
    sf: SourceFile,
    refs: DiFilterChainRef[],
    skippedAnonymousFiles: string[],
): void {
    let hasAnonymousClass = false;

    for (const cls of sf.getClasses()) {
        const className = cls.getName();
        if (!className) {
            // Anonymous / default-export class — record file for diagnostics instead of
            // silently dropping; do not emit refs since we have no enclosing class name.
            hasAnonymousClass = true;
            continue;
        }

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

    if (hasAnonymousClass) {
        skippedAnonymousFiles.push(sf.getFilePath());
    }
}

/**
 * Return the filter decorator name if it's one of the three we care about,
 * using explicit branches rather than a cast so narrowing is sound.
 */
function filterDecoratorName(dec: Decorator): DiFilterDecorator | null {
    const name = dec.getName();
    if (name === 'UseGuards') return 'UseGuards';
    if (name === 'UseInterceptors') return 'UseInterceptors';
    if (name === 'UsePipes') return 'UsePipes';
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

/**
 * Recursively strip `AsExpression` and `ParenthesizedExpression` wrappers so
 * that `(AuthGuard)` and `AuthGuard as any` are treated the same as a bare
 * `AuthGuard` identifier.
 */
function unwrap(expr: Expression): Expression {
    if (expr.getKind() === SyntaxKind.AsExpression) {
        return unwrap((expr as AsExpression).getExpression());
    }
    if (expr.getKind() === SyntaxKind.ParenthesizedExpression) {
        return unwrap((expr as ParenthesizedExpression).getExpression());
    }
    return expr;
}

function decodeArg(
    arg: Node,
    decorator: DiFilterDecorator,
    enclosingClass: string,
    attachedTo: DiFilterChainRef['attachedTo'],
    location: SourceLoc,
): DiFilterChainRef {
    // Unwrap parenthesized / as-expression wrappers before dispatch
    const expr = unwrap(arg as Expression);
    const kind = expr.getKind();

    // Bare identifier: @UseGuards(AuthGuard)
    if (kind === SyntaxKind.Identifier) {
        return {
            kind: 'class',
            name: expr.getText(),
            decorator,
            location,
            enclosingClass,
            attachedTo,
        };
    }

    // Namespace-qualified access: @UseGuards(Namespace.Guard)
    // Extract the rightmost identifier (the actual class name).
    if (kind === SyntaxKind.PropertyAccessExpression) {
        const propAccess = expr as PropertyAccessExpression;
        return {
            kind: 'class',
            name: propAccess.getName(),
            decorator,
            location,
            enclosingClass,
            attachedTo,
        };
    }

    // new expression: @UseInterceptors(new LoggingInterceptor())
    // Only emit 'instance' when the expression after `new` is a plain Identifier.
    // Non-identifier new targets (e.g. `new factory.create()`, `new (getGuard())()`)
    // are noisy and produce phantom nodes — route to unresolved instead.
    if (kind === SyntaxKind.NewExpression) {
        const newExpr = expr as NewExpression;
        const ctorExpr = newExpr.getExpression();
        if (ctorExpr.getKind() === SyntaxKind.Identifier) {
            return {
                kind: 'instance',
                name: ctorExpr.getText(),
                decorator,
                location,
                enclosingClass,
                attachedTo,
            };
        }
        // Non-identifier new target → unresolved with structured reason
        const raw = expr.getText().replace(/\s+/g, ' ').slice(0, 80);
        return {
            kind: 'unresolved',
            raw,
            reason: 'new-non-identifier-expression',
            decorator,
            location,
            enclosingClass,
            attachedTo,
        };
    }

    // Spread element, function call, ternary, template literal, etc. → unresolved
    const raw = expr.getText().replace(/\s+/g, ' ').slice(0, 80);
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
