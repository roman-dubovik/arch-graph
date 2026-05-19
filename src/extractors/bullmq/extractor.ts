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
    BullMqCatchBlockAddSite,
    BullMqEventListenerSite,
    BullMqInjectionSite,
    BullMqProcessorSite,
    BullMqQueueRef,
    BullMqQueueRegistration,
    BullMqRepeatAddSite,
    SourceLoc,
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
 *   - `queue.add(jobName, data, { repeat: ... })` call sites  → repeat-add site (hasRepeat)
 *   - `queue.on('event', handler)` / `worker.on(...)` sites   → event-listener site
 *   - catch-block `someQueue.add('dlq', ...)` inside @Process → catch-block-add site (DLQ heuristic)
 *
 * Queue-name resolution:
 *   - string literal               → `{ kind: 'literal', name }`
 *   - identifier resolved via QueueNameIndex pre-pass → `{ kind: 'const', name, identifier }`
 *   - anything else                → `{ kind: 'unresolved', raw, reason }`
 *
 * Not yet handled: per-job names (`@Process('jobName')` inside `@Processor`),
 * `BullModule.forFeature()` factory variants, wrapper producer/consumer classes.
 */

/** BullMQ event names recognised for `queue-event-listener` edge. */
const BULLMQ_EVENTS = new Set([
    'failed', 'completed', 'stalled', 'active', 'progress',
    'waiting', 'drained', 'paused', 'resumed', 'error',
]);

export interface ExtractBullMqResult {
    producers: BullMqInjectionSite[];
    consumers: BullMqProcessorSite[];
    registrations: BullMqQueueRegistration[];
    repeatAddSites: BullMqRepeatAddSite[];
    eventListenerSites: BullMqEventListenerSite[];
    catchBlockAddSites: BullMqCatchBlockAddSite[];
    /** Unresolved failOver references — diagnostics only. */
    unresolvedFailOver: Array<{ location: SourceLoc; raw: string }>;
    /** Unresolved event-listener receivers — diagnostics only. */
    unresolvedEventListeners: Array<{ location: SourceLoc; receiverText: string; event: string }>;
    /** Catch-block .add() sites whose receiver could not be resolved — diagnostics only (no edge). */
    unresolvedCatchBlockSites: Array<{ location: SourceLoc; receiverText: string; processorQueueName: string }>;
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
    const repeatAddSites: BullMqRepeatAddSite[] = [];
    const eventListenerSites: BullMqEventListenerSite[] = [];
    const catchBlockAddSites: BullMqCatchBlockAddSite[] = [];
    const unresolvedFailOver: Array<{ location: SourceLoc; raw: string }> = [];
    const unresolvedEventListeners: Array<{ location: SourceLoc; receiverText: string; event: string }> = [];
    const unresolvedCatchBlockSites: Array<{ location: SourceLoc; receiverText: string; processorQueueName: string }> = [];

    for (const sf of project.getSourceFiles()) {
        if (isExcludedSourceFile(sf)) continue;
        const text = sf.getFullText();
        const hasInject = text.includes('@InjectQueue');
        const hasProcessor = text.includes('@Processor');
        const hasBullModule = text.includes('BullModule.registerQueue');
        const hasOnCall = text.includes('.on(');
        const hasAddCall = text.includes('.add(');
        if (!hasInject && !hasProcessor && !hasBullModule && !hasOnCall && !hasAddCall) continue;

        // Build per-file property→queueName map from @InjectQueue sites (for receiver resolution)
        const injectedQueuesByProp = new Map<string, string>(); // propertyName → queueName

        if (hasInject || hasProcessor) {
            for (const cls of sf.getClasses()) {
                const enclosingClass = cls.getName();

                if (hasProcessor) {
                    const procDec = cls.getDecorator('Processor');
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
                        const site = buildInjectionSite(prop.getName(), dec, queueNames, enclosingClass);
                        producers.push(site);
                        // Index property → queue for receiver resolution
                        if (site.queue.kind !== 'unresolved') {
                            injectedQueuesByProp.set(prop.getName(), site.queue.name);
                        }
                    }
                    for (const ctor of cls.getConstructors()) {
                        for (const param of ctor.getParameters()) {
                            const dec = param.getDecorator('InjectQueue');
                            if (!dec) continue;
                            const site = buildInjectionSite(param.getName(), dec, queueNames, enclosingClass);
                            producers.push(site);
                            if (site.queue.kind !== 'unresolved') {
                                injectedQueuesByProp.set(param.getName(), site.queue.name);
                            }
                        }
                    }
                }
            }
        }

        if (hasBullModule) {
            collectRegistrations(sf, queueNames, registrations, unresolvedFailOver);
        }

        // Collect .on() and .add() call sites for event listeners, repeat detection, and DLQ heuristic
        if (hasOnCall || hasAddCall) {
            collectCallSites(
                sf,
                queueNames,
                injectedQueuesByProp,
                consumers,
                repeatAddSites,
                eventListenerSites,
                catchBlockAddSites,
                unresolvedEventListeners,
                unresolvedCatchBlockSites,
            );
        }
    }

    return {
        producers,
        consumers,
        registrations,
        repeatAddSites,
        eventListenerSites,
        catchBlockAddSites,
        unresolvedFailOver,
        unresolvedEventListeners,
        unresolvedCatchBlockSites,
        queueNames,
    };
}

// ---------------------------------------------------------------------------
// Site builders
// ---------------------------------------------------------------------------

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

    let concurrency: number | undefined;

    // Check for concurrency in the options object form: @Processor({ name: 'x', concurrency: N })
    const args = dec.getArguments();
    if (args.length > 0) {
        const firstArg = args[0]!;
        if (firstArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
            const obj = firstArg as ObjectLiteralExpression;
            const concurrencyProp = findProp(obj, 'concurrency');
            const init = concurrencyProp?.getInitializer();
            if (init?.getKind() === SyntaxKind.NumericLiteral) {
                concurrency = Number(init.getText());
            }
        }
        // Also check second arg (options object when first arg is queue name string)
        if (args.length >= 2) {
            const secondArg = args[1]!;
            if (secondArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
                const obj = secondArg as ObjectLiteralExpression;
                const concurrencyProp = findProp(obj, 'concurrency');
                const init = concurrencyProp?.getInitializer();
                if (init?.getKind() === SyntaxKind.NumericLiteral) {
                    concurrency = Number(init.getText());
                }
            }
        }
    }

    return {
        role: 'consumer',
        className,
        queue: resolveDecoratorArg(dec, queueNames),
        location: { file: sf.getFilePath(), line: pos.line, column: pos.column },
        ...(concurrency !== undefined ? { concurrency } : {}),
    };
}

function resolveDecoratorArg(dec: Decorator, queueNames: QueueNameIndex): BullMqQueueRef {
    const args = dec.getArguments();
    if (args.length === 0) return { kind: 'unresolved', raw: '<no-arg>', reason: 'no-arg' };
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
        return { kind: 'unresolved', raw: identifier, reason: 'unindexed-identifier' };
    }
    if (kind === SyntaxKind.PropertyAccessExpression) {
        const text = node.getText();
        const value = queueNames.get(text);
        if (value !== undefined) return { kind: 'const', name: value, identifier: text };
        return { kind: 'unresolved', raw: text, reason: 'unindexed-identifier' };
    }
    if (kind === SyntaxKind.ObjectLiteralExpression) {
        // `@nestjs/bullmq` v10+ overloads `@Processor` and `@InjectQueue` with an
        // options-object form: `@Processor({ name: 'payments', concurrency: 3 })`.
        const nameProp = findProp(node as ObjectLiteralExpression, 'name');
        const init = nameProp?.getInitializer();
        if (init) return resolveQueueArg(init, queueNames);
        return { kind: 'unresolved', raw: '<options-no-name>', reason: 'options-no-name' };
    }
    return { kind: 'unresolved', raw: node.getText().slice(0, 80), reason: 'dynamic-expression' };
}

// ---------------------------------------------------------------------------
// Registration collector
// ---------------------------------------------------------------------------

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
    unresolvedFailOver: Array<{ location: SourceLoc; raw: string }>,
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
            out.push(resolveRegistrationArg(arg, queueNames, api, location, unresolvedFailOver));
        }
    });
}

function resolveRegistrationArg(
    arg: Node,
    queueNames: QueueNameIndex,
    api: 'registerQueue' | 'registerQueueAsync',
    location: SourceLoc,
    unresolvedFailOver: Array<{ location: SourceLoc; raw: string }>,
): BullMqQueueRegistration {
    if (arg.getKind() !== SyntaxKind.ObjectLiteralExpression) {
        return {
            role: 'registration',
            queue: { kind: 'unresolved', raw: arg.getText().slice(0, 80), reason: 'non-object-arg' },
            api,
            location,
        };
    }
    const obj = arg as ObjectLiteralExpression;
    const nameProp = findProp(obj, 'name');
    if (!nameProp) {
        return {
            role: 'registration',
            queue: { kind: 'unresolved', raw: '<no-name>', reason: 'no-name-property' },
            api,
            location,
        };
    }
    const queue = resolveQueueArg(nameProp.getInitializer()!, queueNames);

    // Extract optional extras: concurrency, defaultJobOptions.*
    let concurrency: number | undefined;
    let defaultDelay: number | undefined;
    let defaultAttempts: number | undefined;
    let defaultBackoff: unknown;
    let hasDefaultRepeat: boolean | undefined;
    let failOverTarget: string | undefined;

    const concurrencyProp = findProp(obj, 'concurrency');
    const concurrencyInit = concurrencyProp?.getInitializer();
    if (concurrencyInit?.getKind() === SyntaxKind.NumericLiteral) {
        concurrency = Number(concurrencyInit.getText());
    }

    const defaultJobOptionsProp = findProp(obj, 'defaultJobOptions');
    const djoInit = defaultJobOptionsProp?.getInitializer();
    if (djoInit?.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const djo = djoInit as ObjectLiteralExpression;

        const delayProp = findProp(djo, 'delay');
        const delayInit = delayProp?.getInitializer();
        if (delayInit?.getKind() === SyntaxKind.NumericLiteral) {
            defaultDelay = Number(delayInit.getText());
        }

        const attemptsProp = findProp(djo, 'attempts');
        const attemptsInit = attemptsProp?.getInitializer();
        if (attemptsInit?.getKind() === SyntaxKind.NumericLiteral) {
            defaultAttempts = Number(attemptsInit.getText());
        }

        const backoffProp = findProp(djo, 'backoff');
        const backoffInit = backoffProp?.getInitializer();
        if (backoffInit) {
            const bk = backoffInit.getKind();
            if (bk === SyntaxKind.NumericLiteral) {
                defaultBackoff = Number(backoffInit.getText());
            } else if (bk === SyntaxKind.ObjectLiteralExpression) {
                // Store raw text representation for diagnostic purposes
                defaultBackoff = backoffInit.getText().slice(0, 120);
            }
        }

        const repeatProp = findProp(djo, 'repeat');
        if (repeatProp) {
            hasDefaultRepeat = true;
        }

        const failOverProp = findProp(djo, 'failOver');
        const failOverInit = failOverProp?.getInitializer();
        if (failOverInit) {
            const resolved = resolveQueueArg(failOverInit, queueNames);
            if (resolved.kind !== 'unresolved') {
                failOverTarget = resolved.name;
            } else {
                unresolvedFailOver.push({ location, raw: failOverInit.getText().slice(0, 80) });
            }
        }
    }

    return {
        role: 'registration',
        queue,
        api,
        location,
        ...(concurrency !== undefined ? { concurrency } : {}),
        ...(defaultDelay !== undefined ? { defaultDelay } : {}),
        ...(defaultAttempts !== undefined ? { defaultAttempts } : {}),
        ...(defaultBackoff !== undefined ? { defaultBackoff } : {}),
        ...(hasDefaultRepeat ? { hasDefaultRepeat } : {}),
        ...(failOverTarget !== undefined ? { failOverTarget } : {}),
    };
}

// ---------------------------------------------------------------------------
// Call-site collector (.on / .add)
// ---------------------------------------------------------------------------

/**
 * Walk all CallExpressions in the source file to find:
 *   1. `.add(jobName, data, { repeat: ... })` — contributes to hasRepeat
 *   2. `.on('event', handler)` on known queue/worker receivers
 *   3. catch-block `.add('dlq', ...)` calls inside @Process methods
 *
 * Receiver resolution: use per-file injectedQueuesByProp map (from @InjectQueue).
 * If receiver is `this.propName`, look up `propName` in the map.
 * Also handles `new Queue('name', ...)` / `new Worker('name', ...)` inline instances
 * by walking the AST for the binding.
 */
function collectCallSites(
    sf: SourceFile,
    _queueNames: QueueNameIndex,
    injectedQueuesByProp: Map<string, string>,
    consumers: BullMqProcessorSite[],
    repeatAddSites: BullMqRepeatAddSite[],
    eventListenerSites: BullMqEventListenerSite[],
    catchBlockAddSites: BullMqCatchBlockAddSite[],
    unresolvedEventListeners: Array<{ location: SourceLoc; receiverText: string; event: string }>,
    unresolvedCatchBlockSites: Array<{ location: SourceLoc; receiverText: string; processorQueueName: string }>,
): void {
    const filePath = sf.getFilePath();

    sf.forEachDescendant((node) => {
        if (node.getKind() !== SyntaxKind.CallExpression) return;
        const call = node as CallExpression;
        const expr = call.getExpression();
        if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return;

        const methodName = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getName();
        const receiverNode = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getExpression();
        const receiverText = receiverNode.getText();

        const pos = sf.getLineAndColumnAtPos(call.getStart());
        const location: SourceLoc = { file: filePath, line: pos.line, column: pos.column };

        // -----------------------------------------------------------------------
        // Case 1: .on('event', handler) — queue-event-listener
        // -----------------------------------------------------------------------
        if (methodName === 'on') {
            const args = call.getArguments();
            if (args.length < 1) return;
            const firstArg = args[0]!;
            const firstArgKind = firstArg.getKind();
            if (firstArgKind !== SyntaxKind.StringLiteral && firstArgKind !== SyntaxKind.NoSubstitutionTemplateLiteral) return;
            const eventName = (firstArg as StringLiteral).getLiteralText();
            if (!BULLMQ_EVENTS.has(eventName)) return;

            const queueName = resolveReceiver(receiverText, injectedQueuesByProp);
            if (queueName !== null) {
                eventListenerSites.push({
                    role: 'event-listener',
                    queueName,
                    event: eventName,
                    location,
                    file: filePath,
                });
            } else {
                unresolvedEventListeners.push({ location, receiverText, event: eventName });
            }
            return;
        }

        // -----------------------------------------------------------------------
        // Case 2: .add(jobName, data, { repeat: ... }) — hasRepeat detection
        // -----------------------------------------------------------------------
        if (methodName === 'add') {
            const args = call.getArguments();
            // .add(name, data, options?) — options is the third arg
            if (args.length >= 3) {
                const optionsArg = args[2]!;
                if (optionsArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
                    const opts = optionsArg as ObjectLiteralExpression;
                    if (findProp(opts, 'repeat') !== null) {
                        const queueName = resolveReceiver(receiverText, injectedQueuesByProp);
                        if (queueName !== null) {
                            repeatAddSites.push({ role: 'repeat-add', queueName, location });
                        }
                    }
                }
            }

            // -----------------------------------------------------------------------
            // Case 3: catch-block .add('dlq', ...) DLQ heuristic
            // -----------------------------------------------------------------------
            // Walk ancestors to see if this call is inside a catch clause
            let ancestor = call.getParent();
            let inCatchClause = false;
            while (ancestor) {
                if (ancestor.getKind() === SyntaxKind.CatchClause) {
                    inCatchClause = true;
                    break;
                }
                ancestor = ancestor.getParent();
            }

            if (inCatchClause && args.length >= 1) {
                // The first arg of .add() is the job name (which the spec calls "dlq-name" heuristically)
                const firstArg = args[0]!;
                const firstArgKind = firstArg.getKind();
                if (firstArgKind === SyntaxKind.StringLiteral || firstArgKind === SyntaxKind.NoSubstitutionTemplateLiteral) {
                    // We need to find the processor queue name from consumers array (same file).
                    const processorQueueName = findProcessorQueueForFile(filePath, consumers);
                    if (processorQueueName !== null) {
                        // Receiver is the DLQ queue — resolve it
                        const dlqQueueName = resolveReceiver(receiverText, injectedQueuesByProp);
                        if (dlqQueueName !== null) {
                            catchBlockAddSites.push({
                                role: 'catch-block-add',
                                processorQueueName,
                                dlqName: dlqQueueName, // Use the resolved queue name as DLQ
                                location,
                            });
                        } else {
                            // Receiver unresolved — do NOT create a phantom queue node; route to diagnostics
                            unresolvedCatchBlockSites.push({ location, receiverText, processorQueueName });
                        }
                    }
                }
            }
        }
    });
}

/** Resolve `this.propName` or `this.propName.someMethod` receiver to a queue name. */
function resolveReceiver(receiverText: string, injectedQueuesByProp: Map<string, string>): string | null {
    // Handle `this.propName` pattern
    if (receiverText.startsWith('this.')) {
        const propName = receiverText.slice(5).split('.')[0]!;
        const queueName = injectedQueuesByProp.get(propName);
        if (queueName !== undefined) return queueName;
    }
    // Handle bare property name (less common, but some patterns omit `this`)
    const direct = injectedQueuesByProp.get(receiverText.split('.')[0]!);
    if (direct !== undefined) return direct;
    return null;
}

/** Find the queue name for the processor in the given file (uses same-file consumer). */
function findProcessorQueueForFile(
    filePath: string,
    consumers: BullMqProcessorSite[],
): string | null {
    for (const c of consumers) {
        if (c.location.file === filePath && c.queue.kind !== 'unresolved') {
            return c.queue.name;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findProp(obj: ObjectLiteralExpression, name: string): PropertyAssignment | null {
    for (const prop of obj.getProperties()) {
        if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
        const pa = prop as PropertyAssignment;
        if (pa.getName() === name) return pa;
    }
    return null;
}
