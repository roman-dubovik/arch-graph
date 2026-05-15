import {
    CallExpression,
    Decorator,
    Node,
    ObjectLiteralExpression,
    Project,
    PropertyAssignment,
    SourceFile,
    SyntaxKind,
} from 'ts-morph';

import type { ArchGraphConfig } from '../../core/config.js';
import type {
    BullMqInjectionSite,
    BullMqProcessorSite,
    BullMqQueueRef,
    BullMqQueueRegistration,
} from '../../core/types.js';
import { buildQueueNameIndex, QueueNameIndex } from './queue-name-index.js';

/**
 * BullMQ extractor.
 *
 *   - `@InjectQueue(NAME)` (property + ctor-param)            → producer site
 *   - `@Processor(NAME, options?)` (class decorator)          → consumer site
 *   - `BullModule.registerQueue({ name })` / `registerQueueAsync({ name })` → registration
 *
 * Queue-name resolution:
 *   - string literal               → `{ kind: 'literal', name }`
 *   - identifier resolved via QueueNameIndex pre-pass → `{ kind: 'const', name, identifier }`
 *   - anything else                → `{ kind: 'unresolved', raw }`
 *
 * Skipped (Phase 1): per-job names (`@Process('jobName')` inside `@Processor`),
 * `BullModule.forFeature()` factory variants, wrapper producer/consumer classes.
 */

export interface ExtractBullMqResult {
    producers: BullMqInjectionSite[];
    consumers: BullMqProcessorSite[];
    registrations: BullMqQueueRegistration[];
    queueNames: QueueNameIndex;
}

export async function extractBullMq(
    _cfg: ArchGraphConfig,
    project: Project,
): Promise<ExtractBullMqResult> {
    const queueNames = buildQueueNameIndex(project);
    const producers: BullMqInjectionSite[] = [];
    const consumers: BullMqProcessorSite[] = [];
    const registrations: BullMqQueueRegistration[] = [];

    for (const sf of project.getSourceFiles()) {
        if (isExcludedSourceFile(sf)) continue;
        const text = sf.getFullText();
        const hasInject = text.includes('@InjectQueue');
        const hasProcessor = text.includes('@Processor');
        const hasBullModule = text.includes('BullModule.registerQueue');
        if (!hasInject && !hasProcessor && !hasBullModule) continue;

        if (hasInject || hasProcessor) {
            for (const cls of sf.getClasses()) {
                const enclosingClass = cls.getName();

                if (hasProcessor) {
                    const procDec = cls.getDecorator('Processor');
                    if (procDec && enclosingClass) {
                        consumers.push(buildProcessorSite(enclosingClass, procDec, queueNames));
                    }
                }

                if (hasInject) {
                    for (const prop of cls.getProperties()) {
                        const dec = prop.getDecorator('InjectQueue');
                        if (!dec) continue;
                        producers.push(buildInjectionSite(prop.getName(), dec, queueNames, enclosingClass));
                    }
                    for (const ctor of cls.getConstructors()) {
                        for (const param of ctor.getParameters()) {
                            const dec = param.getDecorator('InjectQueue');
                            if (!dec) continue;
                            producers.push(buildInjectionSite(param.getName(), dec, queueNames, enclosingClass));
                        }
                    }
                }
            }
        }

        if (hasBullModule) {
            collectRegistrations(sf, queueNames, registrations);
        }
    }

    return { producers, consumers, registrations, queueNames };
}

function buildInjectionSite(
    propertyName: string,
    dec: Decorator,
    queueNames: QueueNameIndex,
    enclosingClass: string | undefined,
): BullMqInjectionSite {
    const sf = dec.getSourceFile();
    const pos = sf.getLineAndColumnAtPos(dec.getStart());
    return {
        role: 'producer',
        propertyName,
        queue: resolveDecoratorArg(dec, queueNames),
        location: { file: sf.getFilePath(), line: pos.line, column: pos.column },
        enclosingClass,
    };
}

function buildProcessorSite(
    className: string,
    dec: Decorator,
    queueNames: QueueNameIndex,
): BullMqProcessorSite {
    const sf = dec.getSourceFile();
    const pos = sf.getLineAndColumnAtPos(dec.getStart());
    return {
        role: 'consumer',
        className,
        queue: resolveDecoratorArg(dec, queueNames),
        location: { file: sf.getFilePath(), line: pos.line, column: pos.column },
    };
}

function resolveDecoratorArg(dec: Decorator, queueNames: QueueNameIndex): BullMqQueueRef {
    const args = dec.getArguments();
    if (args.length === 0) return { kind: 'unresolved', raw: '<no-arg>' };
    return resolveQueueArg(args[0]!, queueNames);
}

function resolveQueueArg(node: Node, queueNames: QueueNameIndex): BullMqQueueRef {
    const kind = node.getKind();
    if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
        const value = (node as unknown as { getLiteralText: () => string }).getLiteralText();
        return { kind: 'literal', name: value };
    }
    if (kind === SyntaxKind.Identifier) {
        const identifier = node.getText();
        const value = queueNames.get(identifier);
        if (value !== undefined) return { kind: 'const', name: value, identifier };
        return { kind: 'unresolved', raw: identifier };
    }
    if (kind === SyntaxKind.PropertyAccessExpression) {
        const text = node.getText();
        const tail = text.split('.').pop()!;
        const value = queueNames.get(tail);
        if (value !== undefined) return { kind: 'const', name: value, identifier: text };
        return { kind: 'unresolved', raw: text };
    }
    return { kind: 'unresolved', raw: node.getText().slice(0, 80) };
}

/**
 * Find `BullModule.registerQueue(...)` / `registerQueueAsync(...)` and read the
 * `name` field of each object-literal argument. The call can take multiple args
 * (each its own queue), and `forRoot()` is intentionally skipped — it configures
 * the connection, not a queue.
 */
function collectRegistrations(
    sf: SourceFile,
    queueNames: QueueNameIndex,
    out: BullMqQueueRegistration[],
): void {
    sf.forEachDescendant((node) => {
        if (node.getKind() !== SyntaxKind.CallExpression) return;
        const call = node as CallExpression;
        const expr = call.getExpression();
        if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return;
        const exprText = expr.getText();
        if (!exprText.endsWith('.registerQueue') && !exprText.endsWith('.registerQueueAsync')) return;
        const api: 'registerQueue' | 'registerQueueAsync' = exprText.endsWith('.registerQueueAsync')
            ? 'registerQueueAsync'
            : 'registerQueue';
        const pos = sf.getLineAndColumnAtPos(call.getStart());

        for (const arg of call.getArguments()) {
            if (arg.getKind() !== SyntaxKind.ObjectLiteralExpression) {
                out.push({
                    api,
                    queue: { kind: 'unresolved', raw: arg.getText().slice(0, 80) },
                    location: { file: sf.getFilePath(), line: pos.line, column: pos.column },
                });
                continue;
            }
            const obj = arg as ObjectLiteralExpression;
            const nameProp = findProp(obj, 'name');
            if (!nameProp) {
                out.push({
                    api,
                    queue: { kind: 'unresolved', raw: '<no-name>' },
                    location: { file: sf.getFilePath(), line: pos.line, column: pos.column },
                });
                continue;
            }
            const init = nameProp.getInitializer();
            if (!init) {
                out.push({
                    api,
                    queue: { kind: 'unresolved', raw: '<shorthand>' },
                    location: { file: sf.getFilePath(), line: pos.line, column: pos.column },
                });
                continue;
            }
            out.push({
                api,
                queue: resolveQueueArg(init, queueNames),
                location: { file: sf.getFilePath(), line: pos.line, column: pos.column },
            });
        }
    });
}

function findProp(obj: ObjectLiteralExpression, name: string): PropertyAssignment | null {
    for (const prop of obj.getProperties()) {
        if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
        const pa = prop as PropertyAssignment;
        if (pa.getName() === name) return pa;
    }
    return null;
}

export function isExcludedSourceFile(sf: SourceFile): boolean {
    const p = sf.getFilePath();
    if (p.includes('/node_modules/')) return true;
    if (p.includes('/dist/')) return true;
    if (p.includes('/.claude/')) return true;
    if (p.includes('/.worktrees/')) return true;
    if (p.endsWith('.d.ts')) return true;
    if (p.endsWith('.spec.ts') || p.endsWith('.test.ts')) return true;
    return false;
}
