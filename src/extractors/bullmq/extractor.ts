import {
    CallExpression,
    Decorator,
    Node,
    ObjectLiteralExpression,
    Project,
    PropertyAssignment,
    SourceFile,
    StringLiteral,
    SyntaxKind,
} from 'ts-morph';

import type { ArchGraphConfig } from '../../core/config.js';
import type {
    BullMqInjectionSite,
    BullMqProcessorSite,
    BullMqQueueRef,
    BullMqQueueRegistration,
} from '../../core/types.js';
import { isExcludedSourceFile } from '../shared.js';
import { buildQueueNameIndex, QueueNameIndex } from './queue-name-index.js';

export { isExcludedSourceFile };

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
 * Not yet handled: per-job names (`@Process('jobName')` inside `@Processor`),
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
                    // Anonymous classes (`export default @Processor('foo') class { ... }`) have
                    // no `cls.getName()`. We still emit the site with a sentinel className so the
                    // GT key matches and the consumer edge is not silently dropped.
                    if (procDec) {
                        consumers.push(
                            buildProcessorSite(enclosingClass ?? '<anonymous>', procDec, queueNames),
                        );
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
        const value = (node as StringLiteral).getLiteralText();
        return { kind: 'literal', name: value };
    }
    if (kind === SyntaxKind.Identifier) {
        const identifier = node.getText();
        const value = queueNames.get(identifier);
        if (value !== undefined) return { kind: 'const', name: value, identifier };
        return { kind: 'unresolved', raw: identifier };
    }
    if (kind === SyntaxKind.PropertyAccessExpression) {
        // Only resolve when the full dotted name is in the index. Tail-only matches
        // (e.g. `QueueNames.PAYMENT_QUEUE` falling back to an unrelated bare const
        // `PAYMENT_QUEUE`) would produce wrong graph edges with no diagnostic signal.
        // Unresolved is honest — it lands in diagnostics and in the resolveRate metric.
        const text = node.getText();
        const value = queueNames.get(text);
        if (value !== undefined) return { kind: 'const', name: value, identifier: text };
        return { kind: 'unresolved', raw: text };
    }
    if (kind === SyntaxKind.ObjectLiteralExpression) {
        // `@nestjs/bullmq` v10+ overloads `@Processor` and `@InjectQueue` with an
        // options-object form: `@Processor({ name: 'payments', concurrency: 3 })`.
        // The queue name lives in the `name` property — recurse into it.
        const nameProp = findProp(node as ObjectLiteralExpression, 'name');
        const init = nameProp?.getInitializer();
        if (init) return resolveQueueArg(init, queueNames);
        return { kind: 'unresolved', raw: '<options-no-name>' };
    }
    return { kind: 'unresolved', raw: node.getText().slice(0, 80) };
}

/**
 * Find `BullModule.registerQueue(...)` / `registerQueueAsync(...)` and read the
 * `name` field of each argument.
 *
 * `registerQueue` / `registerQueueAsync` are variadic — a single call may register
 * multiple queues, so we iterate over all arguments rather than just `args[0]`.
 * `forRoot()` is intentionally skipped — it configures the connection, not a queue.
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
        const location = { file: sf.getFilePath(), line: pos.line, column: pos.column };

        for (const arg of call.getArguments()) {
            out.push({
                role: 'registration',
                api,
                queue: resolveRegistrationArg(arg, queueNames),
                location,
            });
        }
    });
}

function resolveRegistrationArg(arg: Node, queueNames: QueueNameIndex): BullMqQueueRef {
    if (arg.getKind() !== SyntaxKind.ObjectLiteralExpression) {
        return { kind: 'unresolved', raw: arg.getText().slice(0, 80) };
    }
    const obj = arg as ObjectLiteralExpression;
    const nameProp = findProp(obj, 'name');
    if (!nameProp) return { kind: 'unresolved', raw: '<no-name>' };
    const init = nameProp.getInitializer();
    if (!init) return { kind: 'unresolved', raw: '<shorthand>' };
    return resolveQueueArg(init, queueNames);
}

function findProp(obj: ObjectLiteralExpression, name: string): PropertyAssignment | null {
    for (const prop of obj.getProperties()) {
        if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
        const pa = prop as PropertyAssignment;
        if (pa.getName() === name) return pa;
    }
    return null;
}

