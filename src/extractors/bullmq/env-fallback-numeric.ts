import { Node, SyntaxKind } from 'ts-morph';

/**
 * Shared helper: extract the compile-time numeric fallback from common
 * env-var + fallback patterns.
 *
 * Handles two shape families:
 *
 * Shape A — outer binary with a numeric literal fallback:
 *   `process.env.X ?? 5`
 *   `Number(process.env.X) ?? 5`
 *   `parseInt(process.env.X, 10) ?? 5`
 *   `parseInt(process.env.X, 10) || 5`
 *   `Number(process.env.X) || 5`
 *
 * Shape B — inner binary inside parseInt/Number call with a string or
 * numeric literal fallback:
 *   `parseInt(process.env.X ?? '5', 10)`
 *   `parseInt(process.env.X || '5', 10)`
 *   `Number(process.env.X ?? '5')`
 *   `Number(process.env.X ?? 5)`
 *
 * Returns the numeric value of the fallback literal, or `undefined` if the
 * expression does not match any of the above patterns or the fallback is not
 * statically determinable.
 */
export function resolveEnvFallbackNumeric(node: Node): number | undefined {
    const kind = node.getKind();

    // Shape A: outer binary `LHS [??/||] <NumericLiteral>`
    if (kind === SyntaxKind.BinaryExpression) {
        const bin = node.asKindOrThrow(SyntaxKind.BinaryExpression);
        const op = bin.getOperatorToken().getText();
        if (op !== '??' && op !== '||') return undefined;

        // RHS must be a numeric literal
        const right = bin.getRight();
        if (right.getKind() === SyntaxKind.NumericLiteral) {
            const v = Number(right.getText());
            if (!isNaN(v)) return v;
        }
        return undefined;
    }

    // Shape B: `parseInt(<inner>, 10)` or `Number(<inner>)`
    if (kind === SyntaxKind.CallExpression) {
        const call = node.asKindOrThrow(SyntaxKind.CallExpression);
        const fnName = call.getExpression().getText();
        if (fnName !== 'parseInt' && fnName !== 'Number') return undefined;

        const args = call.getArguments();
        if (args.length === 0) return undefined;

        const firstArg = args[0]!;
        // firstArg should be a binary `process.env.X ?? 'N'` or `process.env.X || 'N'`
        if (firstArg.getKind() !== SyntaxKind.BinaryExpression) return undefined;

        const innerBin = firstArg.asKindOrThrow(SyntaxKind.BinaryExpression);
        const op = innerBin.getOperatorToken().getText();
        if (op !== '??' && op !== '||') return undefined;

        const right = innerBin.getRight();
        // RHS may be StringLiteral OR NumericLiteral — accept both
        const rightKind = right.getKind();
        if (
            rightKind === SyntaxKind.StringLiteral ||
            rightKind === SyntaxKind.NumericLiteral
        ) {
            // For StringLiteral, getLiteralText() gives the unquoted value
            const raw = rightKind === SyntaxKind.StringLiteral
                ? (right as unknown as { getLiteralText(): string }).getLiteralText()
                : right.getText();
            const v = Number(raw);
            if (!isNaN(v)) return v;
        }
        return undefined;
    }

    return undefined;
}
