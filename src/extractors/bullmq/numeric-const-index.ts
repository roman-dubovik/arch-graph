import { Project, SourceFile, SyntaxKind, VariableDeclaration } from 'ts-morph';
import { resolveEnvFallbackNumeric } from './env-fallback-numeric.js';

/**
 * Pre-pass: indexes exported `const NAME = <number>` declarations so we can
 * resolve numeric option values like `@Processor(NAME, { concurrency: CONCURRENCY_CONST })`
 * and `registerQueue({ defaultJobOptions: { attempts: ATTEMPTS_CONST } })`.
 *
 * Handles both plain numeric literals AND the common env-var + fallback pattern:
 *   `export const X = parseInt(process.env.Y ?? '7', 10)`
 *   `export const X = Number(process.env.Y) ?? 10`
 *   `export const X = parseInt(process.env.Y, 10) || 15`
 * In all cases the numeric fallback literal is used as the index value, since
 * it is the documented compile-time default for the setting.
 */

export class NumericConstIndex {
    private byIdent = new Map<string, number>();

    get(identifier: string): number | undefined {
        return this.byIdent.get(identifier);
    }
    size(): number {
        return this.byIdent.size;
    }
    set(identifier: string, value: number): void {
        this.byIdent.set(identifier, value);
    }
}

export function buildNumericConstIndex(project: Project): NumericConstIndex {
    const idx = new NumericConstIndex();
    for (const sf of project.getSourceFiles()) {
        if (isExcludedForIndex(sf)) continue;
        for (const ve of sf.getVariableStatements()) {
            if (!ve.hasExportKeyword()) continue;
            for (const decl of ve.getDeclarations()) {
                indexDecl(decl, idx);
            }
        }
    }
    return idx;
}

function indexDecl(decl: VariableDeclaration, idx: NumericConstIndex): void {
    const name = decl.getName();
    const init = decl.getInitializer();
    if (!name || !init) return;
    const value = resolveInitValue(init, 0);
    if (value !== undefined) idx.set(name, value);
}

/**
 * Recursively resolve a numeric value from a const initializer expression.
 * Handles:
 *   - NumericLiteral: direct value
 *   - AsExpression / ParenthesizedExpression: recursively unwrap (up to `maxDepth`)
 *   - env-var fallback patterns via `resolveEnvFallbackNumeric`
 */
function resolveInitValue(node: import('ts-morph').Node, depth: number): number | undefined {
    if (depth > 4) return undefined; // safety guard against pathological nesting
    const kind = node.getKind();

    if (kind === SyntaxKind.NumericLiteral) {
        const v = Number(node.getText());
        return isNaN(v) ? undefined : v;
    }

    // Recursively unwrap `(expr)` or `expr as T`
    if (kind === SyntaxKind.AsExpression || kind === SyntaxKind.ParenthesizedExpression) {
        const inner = (node as unknown as { getExpression?: () => import('ts-morph').Node | undefined }).getExpression?.();
        if (!inner) return undefined;
        return resolveInitValue(inner, depth + 1);
    }

    // env-var fallback patterns: parseInt(process.env.X ?? '5', 10), Number(process.env.X) ?? 10, etc.
    return resolveEnvFallbackNumeric(node);
}

const EXCLUDED_INDEX_SUBSTRINGS = ['/node_modules/', '/dist/', '/.claude/', '/.worktrees/'];

function isExcludedForIndex(sf: SourceFile): boolean {
    const p = sf.getFilePath();
    if (EXCLUDED_INDEX_SUBSTRINGS.some((s) => p.includes(s))) return true;
    return p.endsWith('.d.ts') || p.endsWith('.spec.ts') || p.endsWith('.test.ts');
}
