import { CallExpression, Decorator, Node, Project, SyntaxKind } from 'ts-morph';

import type { ArchGraphConfig } from '../../core/config.js';
import type { RmqCallSite, SourceLoc } from '../../core/types.js';
import { isExcludedSourceFile } from '../shared.js';
import { buildConstantIndex } from '../nats/constant-index.js';
import { resolveSubject } from '../nats/extractor.js';

export async function extractRmq(cfg: ArchGraphConfig, project: Project): Promise<RmqCallSite[]> {
    const decorators = new Set(cfg.rmq?.subscribeDecorators ?? []);
    if (cfg.domains?.rmq === false || decorators.size === 0) return [];

    const constIndex = buildConstantIndex(project);
    const out: RmqCallSite[] = [];

    for (const sf of project.getSourceFiles()) {
        if (isExcludedSourceFile(sf)) continue;
        const text = sf.getFullText();
        if (![...decorators].some((name) => text.includes(name))) continue;

        for (const dec of sf.getDescendantsOfKind(SyntaxKind.Decorator)) {
            const name = decoratorName(dec);
            if (!decorators.has(name)) continue;

            const args = dec.getArguments();
            const first = args[0];
            if (!first) {
                out.push({
                    pattern: { kind: 'unresolved', raw: '', reason: 'missing decorator argument' },
                    location: locOf(dec),
                    via: `@${name}`,
                    enclosingClass: findEnclosingClassName(dec),
                });
                continue;
            }

            if (first.getKind() === SyntaxKind.ArrayLiteralExpression) {
                for (const el of (first as import('ts-morph').ArrayLiteralExpression).getElements()) {
                    out.push({
                        pattern: resolveSubject(el, 0, constIndex),
                        location: locOf(dec),
                        via: `@${name}`,
                        enclosingClass: findEnclosingClassName(dec),
                    });
                }
                continue;
            }

            out.push({
                pattern: resolveSubject(first, 0, constIndex),
                location: locOf(dec),
                via: `@${name}`,
                enclosingClass: findEnclosingClassName(dec),
            });
        }
    }

    return out;
}

function decoratorName(dec: Decorator): string {
    const callExpr = dec.getExpression();
    if (callExpr.getKind() === SyntaxKind.CallExpression) {
        return (callExpr as CallExpression).getExpression().getText();
    }
    return callExpr.getText();
}

function locOf(node: Node): SourceLoc {
    const sf = node.getSourceFile();
    const { line, column } = sf.getLineAndColumnAtPos(node.getStart());
    return { file: sf.getFilePath(), line, column };
}

function findEnclosingClassName(node: Node): string | undefined {
    let cur: Node | undefined = node;
    while (cur) {
        if (Node.isClassDeclaration(cur)) return cur.getName();
        cur = cur.getParent();
    }
    return undefined;
}
