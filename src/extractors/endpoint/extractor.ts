/**
 * Endpoint extractor — Variant 2, Task B2.
 *
 * Detects `@Controller(...) @Get/@Post/@Patch/@Delete/@Put/@All/@Options/@Head/@Sse`
 * decorators and emits endpoint site records.
 */

import type { ArrayLiteralExpression, Decorator, Node, PropertyAssignment } from 'ts-morph';
import { ObjectLiteralExpression, Project, SyntaxKind } from 'ts-morph';
import type { SourceLoc } from '../../core/types.js';
import { isExcludedSourceFile } from '../shared.js';

/** Canonical HTTP method names produced by the endpoint extractor. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL' | 'OPTIONS' | 'HEAD' | 'SSE';

export interface EndpointSite {
    /** HTTP method. */
    method: HttpMethod;
    /** Canonical endpoint pattern (e.g. `/users/:id`). */
    pattern: string;
    /** Controller class name containing the method. */
    controllerClass: string;
    /** Method name on the controller class. */
    methodName: string;
    location: SourceLoc;
    /** Optional meta info: @Version, @HttpCode, version from controller object-form. */
    meta?: Record<string, unknown>;
}

export interface EndpointExtractResult {
    endpoints: EndpointSite[];
    diagnostics: Array<{ file: string; line: number; message: string }>;
}

/**
 * HTTP method decorators from NestJS mapped to canonical method names.
 * @All maps to 'ALL', @Sse to 'SSE'.
 */
const HTTP_METHOD_DECORATORS: Record<string, HttpMethod> = {
    Get: 'GET',
    Post: 'POST',
    Put: 'PUT',
    Patch: 'PATCH',
    Delete: 'DELETE',
    All: 'ALL',
    Options: 'OPTIONS',
    Head: 'HEAD',
    Sse: 'SSE',
};

/** Get the literal text from a string-literal-shaped Node, or undefined. */
function getLiteral(node: Node): string | undefined {
    const k = node.getKind();
    if (k === SyntaxKind.StringLiteral || k === SyntaxKind.NoSubstitutionTemplateLiteral) {
        return (node as unknown as { getLiteralText(): string }).getLiteralText();
    }
    return undefined;
}

/**
 * Extract the controller prefix string from a @Controller decorator argument.
 * Returns `{ prefix: '', isDynamic: false }` when no prefix (no-arg usage).
 * Returns `{ prefix: '<dynamic>', isDynamic: true }` when the arg is a non-literal
 * (e.g. @Controller(API_PREFIX)) — pattern is still emitted with a placeholder so
 * consumers know the endpoint exists but the path is unresolvable at static time.
 */
export function resolveControllerPrefix(dec: Decorator): { prefix: string; version?: string; isDynamic?: boolean } {
    const args = dec.getArguments();
    if (args.length === 0) return { prefix: '' };

    const first = args[0]!;

    // @Controller('path') — string literal
    const lit = getLiteral(first);
    if (lit !== undefined) return { prefix: lit };

    // @Controller({ path: 'x', version: '1' }) — object literal
    if (first.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const obj = first as ObjectLiteralExpression;
        let prefix = '';
        let version: string | undefined;
        let hasDynamicPath = false;
        for (const prop of obj.getProperties()) {
            if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
            const pa = prop as PropertyAssignment;
            const init = pa.getInitializer();
            if (!init) continue;
            const propName = pa.getName();
            const initLit = getLiteral(init);
            if (propName === 'path') {
                if (initLit !== undefined) {
                    prefix = initLit;
                } else {
                    hasDynamicPath = true;
                    prefix = '<dynamic>';
                }
            } else if (propName === 'version' && initLit !== undefined) {
                version = initLit;
            }
        }
        return hasDynamicPath ? { prefix, version, isDynamic: true } : { prefix, version };
    }

    // Identifier or other non-literal (e.g. @Controller(API_PREFIX)) — dynamic placeholder
    return { prefix: '<dynamic>', isDynamic: true };
}

/**
 * Combine controller prefix and method-level path into a canonical pattern.
 * Normalizes multiple slashes, strips trailing slash (except root '/').
 */
export function combinePattern(prefix: string, methodPath: string): string {
    const raw = '/' + prefix + '/' + methodPath;
    const normalized = raw.replace(/\/+/g, '/').replace(/\/$/, '');
    return normalized === '' ? '/' : normalized;
}

/**
 * Extract the path argument from an HTTP method decorator.
 * Returns `{ path: '' }` when no arg (e.g. `@Get()`).
 * Returns `{ path: '<dynamic>', isDynamic: true }` when arg is non-literal
 * (e.g. @Get(SOME_VAR)) — endpoint is still emitted with a placeholder.
 * Handles:
 *   @Get()           → { path: '' }
 *   @Get('path')     → { path: 'path' }
 *   @Get([':id'])    → { path: ':id' } (array form — takes first element)
 *   @Get(PATH_VAR)   → { path: '<dynamic>', isDynamic: true }
 */
export function resolveMethodPath(dec: Decorator): { path: string; isDynamic?: boolean } {
    const args = dec.getArguments();
    if (args.length === 0) return { path: '' };
    const first = args[0]!;

    const lit = getLiteral(first);
    if (lit !== undefined) return { path: lit };

    // Array form @Get([':id', ':uuid']) — take first string
    if (first.getKind() === SyntaxKind.ArrayLiteralExpression) {
        const arr = first as ArrayLiteralExpression;
        const el = arr.getElements()[0];
        if (el) {
            const elLit = getLiteral(el);
            if (elLit !== undefined) return { path: elLit };
        }
        // Array with non-literal first element
        return { path: '<dynamic>', isDynamic: true };
    }

    // Identifier or other non-literal argument
    return { path: '<dynamic>', isDynamic: true };
}

/**
 * Extract a string value from a @Version or @HttpCode decorator.
 * Returns undefined if decorator has no recognizable arg.
 */
function resolveVersionArg(dec: Decorator): string | undefined {
    const args = dec.getArguments();
    if (args.length === 0) return undefined;
    const lit = getLiteral(args[0]!);
    return lit;
}

function resolveHttpCodeArg(dec: Decorator): number | undefined {
    const args = dec.getArguments();
    if (args.length === 0) return undefined;
    const a = args[0]!;
    if (a.getKind() === SyntaxKind.NumericLiteral) {
        return Number(a.getText());
    }
    return undefined;
}

/**
 * Extract endpoint sites from a TypeScript project.
 */
export function extractEndpoints(project: Project): EndpointExtractResult {
    const endpoints: EndpointSite[] = [];
    const diagnostics: Array<{ file: string; line: number; message: string }> = [];

    for (const sf of project.getSourceFiles()) {
        if (isExcludedSourceFile(sf)) continue;
        if (!sf.getFullText().includes('@Controller')) continue;

        const filePath = sf.getFilePath();

        for (const cls of sf.getClasses()) {
            const controllerDec = cls.getDecorator('Controller');
            if (!controllerDec) continue;

            const controllerName = cls.getName();
            if (!controllerName) continue;

            const { prefix, version: controllerVersion, isDynamic: controllerDynamic } = resolveControllerPrefix(controllerDec);

            if (controllerDynamic) {
                const decStart = controllerDec.getStart();
                const decLoc = sf.getLineAndColumnAtPos(decStart);
                diagnostics.push({
                    file: filePath,
                    line: decLoc.line,
                    message: `@Controller on ${controllerName} uses non-literal prefix — pattern uses '<dynamic>' placeholder`,
                });
            }

            // Collect class-level @Version decorator
            const classVersionStr = (() => {
                const vDec = cls.getDecorator('Version');
                return vDec ? resolveVersionArg(vDec) : undefined;
            })();

            for (const method of cls.getMethods()) {
                for (const dec of method.getDecorators()) {
                    const decName = dec.getName();
                    const httpMethod = HTTP_METHOD_DECORATORS[decName];
                    if (!httpMethod) continue;

                    const { path: methodPath, isDynamic: methodDynamic } = resolveMethodPath(dec);
                    if (methodDynamic) {
                        const decStart = dec.getStart();
                        const decLoc = sf.getLineAndColumnAtPos(decStart);
                        diagnostics.push({
                            file: filePath,
                            line: decLoc.line,
                            message: `@${decName} on ${controllerName}.${method.getName()} uses non-literal path — pattern uses '<dynamic>' placeholder`,
                        });
                    }
                    const pattern = combinePattern(prefix, methodPath);

                    // Method-level @Version (overrides class/controller version)
                    const methodVersionStr = (() => {
                        const vDec = method.getDecorator('Version');
                        return vDec ? resolveVersionArg(vDec) : undefined;
                    })();

                    const httpCodeNum = (() => {
                        const hcDec = method.getDecorator('HttpCode');
                        return hcDec ? resolveHttpCodeArg(hcDec) : undefined;
                    })();

                    const effectiveVersion =
                        methodVersionStr ?? classVersionStr ?? controllerVersion;

                    const meta: Record<string, unknown> = {};
                    if (effectiveVersion !== undefined) meta.version = effectiveVersion;
                    if (httpCodeNum !== undefined) meta.httpCode = httpCodeNum;

                    const startPos = dec.getStart();
                    const loc = sf.getLineAndColumnAtPos(startPos);

                    endpoints.push({
                        method: httpMethod,
                        pattern,
                        controllerClass: controllerName,
                        methodName: method.getName() || '<anonymous>',
                        location: {
                            file: filePath,
                            line: loc.line,
                            column: loc.column,
                        },
                        ...(Object.keys(meta).length > 0 ? { meta } : {}),
                    });
                }
            }
        }
    }

    return { endpoints, diagnostics };
}
