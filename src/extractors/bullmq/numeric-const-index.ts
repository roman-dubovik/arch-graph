import { Project, SourceFile, SyntaxKind, VariableDeclaration } from 'ts-morph';

/**
 * Pre-pass: indexes exported `const NAME = <number>` declarations so we can
 * resolve numeric option values like `@Processor(NAME, { concurrency: CONCURRENCY_CONST })`
 * and `registerQueue({ defaultJobOptions: { attempts: ATTEMPTS_CONST } })`.
 *
 * Sister index to `QueueNameIndex` — handles numeric literals only.
 * Runtime expressions (`parseInt(...)`, `Number(...)`, computed values) are
 * intentionally excluded — they cannot be statically resolved at index time.
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
    const kind = init.getKind();
    if (kind === SyntaxKind.NumericLiteral) {
        const value = Number(init.getText());
        if (!isNaN(value)) idx.set(name, value);
        return;
    }
    // Unwrap `(5)` or `5 as const`
    if (kind === SyntaxKind.AsExpression || kind === SyntaxKind.ParenthesizedExpression) {
        const inner = (init as unknown as { getExpression?: () => { getKind: () => SyntaxKind; getText: () => string } | undefined }).getExpression?.();
        if (!inner) return;
        if (inner.getKind() === SyntaxKind.NumericLiteral) {
            const value = Number(inner.getText());
            if (!isNaN(value)) idx.set(name, value);
        }
    }
}

const EXCLUDED_INDEX_SUBSTRINGS = ['/node_modules/', '/dist/', '/.claude/', '/.worktrees/'];

function isExcludedForIndex(sf: SourceFile): boolean {
    const p = sf.getFilePath();
    if (EXCLUDED_INDEX_SUBSTRINGS.some((s) => p.includes(s))) return true;
    return p.endsWith('.d.ts') || p.endsWith('.spec.ts') || p.endsWith('.test.ts');
}
