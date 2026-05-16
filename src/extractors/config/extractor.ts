/**
 * Config-field extractor — Variant 2, Task B6.
 *
 * Detects callsites:
 *   - configService.get<T>('KEY')
 *   - configService.getOrThrow<T>('KEY')
 *   - process.env.KEY (member access)
 *
 * Emits ConfigFieldSite records for each detected callsite.
 * One site per callsite (dedup by key happens in the mapper for node creation).
 */

import { Node, Project, SyntaxKind } from 'ts-morph';
import type { SourceLoc } from '../../core/types.js';
import { isExcludedSourceFile } from '../shared.js';

export interface ConfigFieldSite {
    /** Unique config key (e.g. 'DATABASE_URL' or 'PORT'). */
    key: string;
    /** Source: 'configService' | 'process.env'. */
    source: 'configService' | 'process.env';
    /** Consuming class name (if callsite is inside a class). */
    consumerClass: string | undefined;
    /** Method or property where the callsite appears. */
    consumerContext: string;
    location: SourceLoc;
}

export interface ConfigExtractResult {
    fields: ConfigFieldSite[];
    diagnostics: Array<{ file: string; line: number; message: string }>;
}

/**
 * Extract config-field callsites from a TypeScript project.
 */
export function extractConfig(project: Project): ConfigExtractResult {
    const fields: ConfigFieldSite[] = [];
    const diagnostics: Array<{ file: string; line: number; message: string }> = [];

    for (const sf of project.getSourceFiles()) {
        if (isExcludedSourceFile(sf)) continue;
        const text = sf.getFullText();
        if (!text.includes('configService') && !text.includes('process.env')) continue;

        const filePath = sf.getFilePath();

        for (const node of sf.getDescendants()) {
            // ---- configService.get('KEY') / configService.getOrThrow('KEY') ----
            if (node.getKind() === SyntaxKind.CallExpression) {
                const callExpr = node as import('ts-morph').CallExpression;
                const expr = callExpr.getExpression();

                if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
                    const pae = expr as import('ts-morph').PropertyAccessExpression;
                    const methodName = pae.getName();

                    if (methodName === 'get' || methodName === 'getOrThrow') {
                        const objExpr = pae.getExpression();
                        // Only detect calls whose object identifier contains 'config'
                        // (covers configService, this.configService, config_service, etc.)
                        const objText = objExpr.getText().toLowerCase();
                        if (!objText.includes('config')) continue;

                        const args = callExpr.getArguments();
                        if (args.length === 0) continue;

                        const firstArg = args[0]!;
                        if (
                            firstArg.getKind() !== SyntaxKind.StringLiteral &&
                            firstArg.getKind() !== SyntaxKind.NoSubstitutionTemplateLiteral
                        ) continue;

                        const key = (firstArg as unknown as { getLiteralText(): string }).getLiteralText();
                        if (!key) continue;

                        const { enclosingClass, context } = getEnclosingContext(node);
                        const startPos = node.getStart();
                        const loc = sf.getLineAndColumnAtPos(startPos);

                        fields.push({
                            key,
                            source: 'configService',
                            consumerClass: enclosingClass,
                            consumerContext: context,
                            location: { file: filePath, line: loc.line, column: loc.column },
                        });
                    }
                }
            }

            // ---- process.env.KEY (member access) ----
            if (node.getKind() === SyntaxKind.PropertyAccessExpression) {
                const pae = node as import('ts-morph').PropertyAccessExpression;
                const obj = pae.getExpression();

                // obj should be `process.env`
                if (obj.getKind() === SyntaxKind.PropertyAccessExpression) {
                    const outerPae = obj as import('ts-morph').PropertyAccessExpression;
                    if (
                        outerPae.getName() === 'env' &&
                        outerPae.getExpression().getText() === 'process'
                    ) {
                        // pae.getName() is the env var key
                        const key = pae.getName();
                        if (!key) continue;

                        const { enclosingClass, context } = getEnclosingContext(node);
                        const startPos = node.getStart();
                        const loc = sf.getLineAndColumnAtPos(startPos);

                        fields.push({
                            key,
                            source: 'process.env',
                            consumerClass: enclosingClass,
                            consumerContext: context,
                            location: { file: filePath, line: loc.line, column: loc.column },
                        });
                    }
                }
            }
        }
    }

    return { fields, diagnostics };
}

/**
 * Walk up the AST to find the enclosing class + nearest function/method name.
 */
function getEnclosingContext(node: Node): { enclosingClass: string | undefined; context: string } {
    let cur: Node | undefined = node.getParent();
    let context = '<top-level>';
    let enclosingClass: string | undefined;

    while (cur) {
        const kind = cur.getKind();

        if (
            kind === SyntaxKind.MethodDeclaration ||
            kind === SyntaxKind.FunctionDeclaration ||
            kind === SyntaxKind.ArrowFunction ||
            kind === SyntaxKind.FunctionExpression ||
            kind === SyntaxKind.Constructor ||
            kind === SyntaxKind.GetAccessor ||
            kind === SyntaxKind.SetAccessor
        ) {
            if (kind === SyntaxKind.Constructor) {
                context = 'constructor';
            } else if (kind === SyntaxKind.FunctionDeclaration) {
                const fd = cur as import('ts-morph').FunctionDeclaration;
                // Function declarations always have names in valid TypeScript
                context = fd.getName()!;
            } else if (kind === SyntaxKind.MethodDeclaration) {
                const md = cur as import('ts-morph').MethodDeclaration;
                context = md.getName()!;
            } else if (kind === SyntaxKind.GetAccessor || kind === SyntaxKind.SetAccessor) {
                const acc = cur as import('ts-morph').GetAccessorDeclaration | import('ts-morph').SetAccessorDeclaration;
                context = acc.getName();
            }
            // Don't break — keep looking for class
        }

        if (kind === SyntaxKind.ClassDeclaration) {
            const cls = cur as import('ts-morph').ClassDeclaration;
            enclosingClass = cls.getName();
            break;
        }

        cur = cur.getParent();
    }

    return { enclosingClass, context };
}
