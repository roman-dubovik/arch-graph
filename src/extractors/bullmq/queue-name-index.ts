import { Project, SourceFile, SyntaxKind, VariableDeclaration } from 'ts-morph';

/**
 * Pre-pass: indexes exported `const NAME = '<string>'` declarations so we can
 * resolve `@InjectQueue(QUEUE_NAME_CONST)` / `BullModule.registerQueue({ name: QUEUE_NAME_CONST })`
 * to a stable string. A trimmed-down version of NATS's `ConstantIndex` — BullMQ
 * queue names are flat strings (no `*` patterns, no template-fn synthesis), so
 * we only need the literal-const path.
 */

export class QueueNameIndex {
    private byIdent = new Map<string, string>();

    get(identifier: string): string | undefined {
        return this.byIdent.get(identifier);
    }
    size(): number {
        return this.byIdent.size;
    }
    set(identifier: string, value: string): void {
        this.byIdent.set(identifier, value);
    }
}

export function buildQueueNameIndex(project: Project): QueueNameIndex {
    const idx = new QueueNameIndex();
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

function indexDecl(decl: VariableDeclaration, idx: QueueNameIndex): void {
    const name = decl.getName();
    const init = decl.getInitializer();
    if (!name || !init) return;
    const kind = init.getKind();
    if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
        const value = (init as unknown as { getLiteralText: () => string }).getLiteralText();
        idx.set(name, value);
        return;
    }
    if (kind === SyntaxKind.AsExpression || kind === SyntaxKind.ParenthesizedExpression) {
        const inner = (init as unknown as { getExpression?: () => { getKind: () => SyntaxKind } | undefined }).getExpression?.();
        if (!inner) return;
        if (
            inner.getKind() === SyntaxKind.StringLiteral ||
            inner.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
        ) {
            const value = (inner as unknown as { getLiteralText: () => string }).getLiteralText();
            idx.set(name, value);
        }
    }
}

const EXCLUDED_INDEX_SUBSTRINGS = ['/node_modules/', '/dist/', '/.claude/', '/.worktrees/'];

function isExcludedForIndex(sf: SourceFile): boolean {
    const p = sf.getFilePath();
    if (EXCLUDED_INDEX_SUBSTRINGS.some((s) => p.includes(s))) return true;
    return p.endsWith('.d.ts') || p.endsWith('.spec.ts') || p.endsWith('.test.ts');
}
