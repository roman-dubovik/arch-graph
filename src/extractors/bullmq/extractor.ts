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
    BullMqJobDataType,
    BullMqProcessorSite,
    BullMqQueueRef,
    BullMqQueueRegistration,
    BullMqRepeatAddSite,
    SourceLoc,
} from '../../core/types.js';
import { isExcludedSourceFile } from '../shared.js';
import { buildNumericConstIndex, NumericConstIndex } from './numeric-const-index.js';
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
    /**
     * repeat-add sites whose `{ repeat: { cron: X } }` uses a non-literal expression.
     * No cron-schedule node is emitted; recorded here for diagnostics only.
     */
    unresolvedRepeatExpressions: Array<{ location: SourceLoc; queueName: string; rawExpression: string }>;
    /**
     * Job-data type information for each @Process method — populated only when
     * `options.withTypes === true`. Empty array otherwise.
     */
    jobDataTypes: BullMqJobDataType[];
    /**
     * @Process methods for which the type-checker pass failed to resolve the
     * `Job<DataType>` generic parameter. Populated only when `withTypes === true`.
     */
    unresolvedJobDataTypes: Array<{
        queueName: string;
        processorClass: string;
        methodName: string;
        reason: string;
    }>;
    queueNames: QueueNameIndex;
}

export interface ExtractBullMqOptions {
    /**
     * When true, activates the ts-morph type-checker pass that resolves
     * `Job<DataType>` generic type parameters for each `@Process` method.
     * Gated behind this flag because the type-checker pass is O(n) on the
     * number of source files — can be ×2 slower on large projects.
     * Default: false.
     */
    withTypes?: boolean;
}

export async function extractBullMq(
    _cfg: ArchGraphConfig,
    project: Project,
    options: ExtractBullMqOptions = {},
): Promise<ExtractBullMqResult> {
    const queueNames = buildQueueNameIndex(project);
    const numericConsts = buildNumericConstIndex(project);
    const producers: BullMqInjectionSite[] = [];
    const consumers: BullMqProcessorSite[] = [];
    const registrations: BullMqQueueRegistration[] = [];
    const repeatAddSites: BullMqRepeatAddSite[] = [];
    const eventListenerSites: BullMqEventListenerSite[] = [];
    const catchBlockAddSites: BullMqCatchBlockAddSite[] = [];
    const unresolvedFailOver: Array<{ location: SourceLoc; raw: string }> = [];
    const unresolvedEventListeners: Array<{ location: SourceLoc; receiverText: string; event: string }> = [];
    const unresolvedCatchBlockSites: Array<{ location: SourceLoc; receiverText: string; processorQueueName: string }> = [];
    const unresolvedRepeatExpressions: Array<{ location: SourceLoc; queueName: string; rawExpression: string }> = [];

    for (const sf of project.getSourceFiles()) {
        if (isExcludedSourceFile(sf)) continue;
        const text = sf.getFullText();
        const hasInject = text.includes('@InjectQueue');
        const hasProcessor = text.includes('@Processor');
        const hasBullModule = text.includes('BullModule.registerQueue');
        const hasOnCall = text.includes('.on(');
        const hasAddCall = text.includes('.add(');
        const hasCreateWorker = text.includes('createWorker');
        if (!hasInject && !hasProcessor && !hasBullModule && !hasOnCall && !hasAddCall && !hasCreateWorker) continue;

        // Build per-file property→queueName map from @InjectQueue sites (for receiver resolution)
        const injectedQueuesByProp = new Map<string, string>(); // propertyName → queueName

        if (hasInject || hasProcessor) {
            for (const cls of sf.getClasses()) {
                const enclosingClass = cls.getName();

                if (hasProcessor) {
                    const procDec = cls.getDecorator('Processor');
                    if (procDec) {
                        consumers.push(
                            buildProcessorSite(enclosingClass ?? '<anonymous>', procDec, queueNames, numericConsts),
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
            collectRegistrations(sf, queueNames, numericConsts, registrations, unresolvedFailOver);
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
                unresolvedRepeatExpressions,
            );
        }

        // Worker factory env-fallback concurrency detection
        // Detects: factory.createWorker('queue-name', { concurrency: process.env.X ?? 5 })
        if (text.includes('createWorker')) {
            collectWorkerFactorySites(sf, queueNames, numericConsts, registrations);
        }
    }

    // Job-data type resolution — only when withTypes is explicitly enabled.
    // This pass invokes the ts-morph type-checker which is O(n) on source files.
    const jobDataTypes: BullMqJobDataType[] = [];
    const unresolvedJobDataTypes: Array<{
        queueName: string;
        processorClass: string;
        methodName: string;
        reason: string;
    }> = [];
    if (options.withTypes === true) {
        resolveJobDataTypes(project, consumers, jobDataTypes, unresolvedJobDataTypes);
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
        unresolvedRepeatExpressions,
        jobDataTypes,
        unresolvedJobDataTypes,
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
    numericConsts: NumericConstIndex,
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
            if (init !== undefined) concurrency = readNumeric(init, numericConsts);
        }
        // Also check second arg (options object when first arg is queue name string)
        if (args.length >= 2) {
            const secondArg = args[1]!;
            if (secondArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
                const obj = secondArg as ObjectLiteralExpression;
                const concurrencyProp = findProp(obj, 'concurrency');
                const init = concurrencyProp?.getInitializer();
                if (init !== undefined) concurrency = readNumeric(init, numericConsts);
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
    numericConsts: NumericConstIndex,
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
            out.push(resolveRegistrationArg(arg, queueNames, numericConsts, api, location, unresolvedFailOver));
        }
    });
}

function resolveRegistrationArg(
    arg: Node,
    queueNames: QueueNameIndex,
    numericConsts: NumericConstIndex,
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
    let hasDefaultRepeat: true | undefined;
    let failOverTarget: string | undefined;

    const concurrencyProp = findProp(obj, 'concurrency');
    const concurrencyInit = concurrencyProp?.getInitializer();
    if (concurrencyInit !== undefined) concurrency = readNumeric(concurrencyInit, numericConsts);

    const defaultJobOptionsProp = findProp(obj, 'defaultJobOptions');
    const djoInit = defaultJobOptionsProp?.getInitializer();
    if (djoInit?.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const djo = djoInit as ObjectLiteralExpression;

        const delayProp = findProp(djo, 'delay');
        const delayInit = delayProp?.getInitializer();
        if (delayInit !== undefined) defaultDelay = readNumeric(delayInit, numericConsts);

        const attemptsProp = findProp(djo, 'attempts');
        const attemptsInit = attemptsProp?.getInitializer();
        if (attemptsInit !== undefined) defaultAttempts = readNumeric(attemptsInit, numericConsts);

        const backoffProp = findProp(djo, 'backoff');
        const backoffInit = backoffProp?.getInitializer();
        if (backoffInit) {
            const bk = backoffInit.getKind();
            if (bk === SyntaxKind.NumericLiteral) {
                defaultBackoff = Number(backoffInit.getText());
            } else if (bk === SyntaxKind.Identifier) {
                const resolved = numericConsts.get(backoffInit.getText());
                if (resolved !== undefined) defaultBackoff = resolved;
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
 * Collects call sites for repeat-add, catch-block-add, and event-listener
 * patterns. Receiver resolution uses the per-file `injectedQueuesByProp` map
 * (built from `@InjectQueue` sites) and handles `this.propName` and bare
 * property-name patterns. Anything else (inline `new Queue(...)`, external
 * variables) is unresolved and either lands in `unresolvedEventListeners` /
 * `unresolvedCatchBlockSites` or is silently skipped for repeat-add sites
 * (no diagnostic emitted for that path — `hasRepeat` would just stay false).
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
    unresolvedRepeatExpressions: Array<{ location: SourceLoc; queueName: string; rawExpression: string }>,
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
        // Case 2: .add(jobName, data, { repeat: ... }) — hasRepeat detection + cron extraction
        // -----------------------------------------------------------------------
        if (methodName === 'add') {
            const args = call.getArguments();
            // .add(name, data, options?) — options is the third arg
            if (args.length >= 3) {
                const optionsArg = args[2]!;
                if (optionsArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
                    const opts = optionsArg as ObjectLiteralExpression;
                    const repeatProp = findProp(opts, 'repeat');
                    if (repeatProp !== null) {
                        const queueName = resolveReceiver(receiverText, injectedQueuesByProp);
                        if (queueName !== null) {
                            // Resolve job name (first arg) if it is a string literal
                            let jobName: string | undefined;
                            const firstArg = args[0]!;
                            if (firstArg.getKind() === SyntaxKind.StringLiteral
                                || firstArg.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
                                jobName = (firstArg as StringLiteral).getLiteralText();
                            }

                            // Try to extract literal cron expression
                            let repeatExpression: string | undefined;
                            const repeatInit = repeatProp.getInitializer();
                            if (repeatInit?.getKind() === SyntaxKind.ObjectLiteralExpression) {
                                const repeatObj = repeatInit as ObjectLiteralExpression;
                                const cronProp = findProp(repeatObj, 'cron');
                                if (cronProp !== null) {
                                    const cronInit = cronProp.getInitializer();
                                    const cronKind = cronInit?.getKind();
                                    if (cronKind === SyntaxKind.StringLiteral
                                        || cronKind === SyntaxKind.NoSubstitutionTemplateLiteral) {
                                        repeatExpression = (cronInit as StringLiteral).getLiteralText();
                                    } else if (cronInit !== undefined) {
                                        // Non-literal — record as unresolved diagnostic
                                        unresolvedRepeatExpressions.push({
                                            location,
                                            queueName,
                                            rawExpression: cronInit.getText().slice(0, 120),
                                        });
                                    }
                                }
                                // Non-literal `every` (variable, template, expression):
                                // no ms value stored, but push to unresolvedRepeatExpressions
                                // so operators can see it. Literal numeric `every` is silently
                                // accepted (hasRepeat is set on the queue node via the site).
                                const everyProp = findProp(repeatObj, 'every');
                                if (everyProp !== null) {
                                    const everyInit = everyProp.getInitializer();
                                    if (everyInit !== undefined && everyInit.getKind() !== SyntaxKind.NumericLiteral) {
                                        unresolvedRepeatExpressions.push({
                                            location,
                                            queueName,
                                            rawExpression: '<every: ' + everyInit.getText().slice(0, 60) + '>',
                                        });
                                    }
                                }
                            }

                            repeatAddSites.push({
                                role: 'repeat-add',
                                queueName,
                                location,
                                ...(jobName !== undefined ? { jobName } : {}),
                                ...(repeatExpression !== undefined ? { repeatExpression } : {}),
                            });
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
// Worker factory env-fallback concurrency
// ---------------------------------------------------------------------------

/**
 * Detects the factory-style worker creation pattern and resolves the numeric
 * env-var fallback for concurrency:
 *   factory.createWorker('queue-name', { concurrency: process.env.X ?? 5 })
 *   factory.createWorker('queue-name', { concurrency: Number(process.env.X) || 10 })
 *   factory.createWorker('queue-name', { concurrency: parseInt(process.env.X, 10) || 10 })
 *
 * The resolved values are stored as `workerConcurrencyFallback` and
 * `workerConcurrencyEnvVar` on the matching existing registration (first-seen
 * wins) or as a synthetic registration entry if none is found.
 */
function collectWorkerFactorySites(
    sf: SourceFile,
    queueNames: QueueNameIndex,
    numericConsts: NumericConstIndex,
    registrations: BullMqQueueRegistration[],
): void {
    sf.forEachDescendant((node) => {
        if (node.getKind() !== SyntaxKind.CallExpression) return;
        const call = node as CallExpression;
        const expr = call.getExpression();
        if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return;
        const methodName = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getName();
        if (methodName !== 'createWorker') return;

        const args = call.getArguments();
        if (args.length < 2) return;

        // First arg: queue name
        const queueNameRef = resolveQueueArg(args[0]!, queueNames);
        if (queueNameRef.kind === 'unresolved') return;
        const queueName = queueNameRef.name;

        // Second arg: options object
        const optsArg = args[1]!;
        if (optsArg.getKind() !== SyntaxKind.ObjectLiteralExpression) return;
        const opts = optsArg as ObjectLiteralExpression;
        const concProp = findProp(opts, 'concurrency');
        if (!concProp) return;

        const concInit = concProp.getInitializer();
        if (!concInit) return;

        const resolved = resolveEnvFallback(concInit, numericConsts);
        if (!resolved) return;

        // Store on existing registration (first-seen wins) or append synthetic entry
        const existing = registrations.find(
            (r) => r.queue.kind !== 'unresolved' && r.queue.name === queueName,
        );
        if (existing) {
            const mutableReg = existing as unknown as Record<string, unknown>;
            if (mutableReg['workerConcurrencyFallback'] === undefined) {
                mutableReg['workerConcurrencyFallback'] = resolved.fallback;
                mutableReg['workerConcurrencyEnvVar'] = resolved.envVar;
            }
        } else {
            const sfPath = sf.getFilePath();
            const pos = sf.getLineAndColumnAtPos(call.getStart());
            const syntheticReg: BullMqQueueRegistration & {
                workerConcurrencyFallback?: number;
                workerConcurrencyEnvVar?: string;
            } = {
                role: 'registration',
                queue: queueNameRef,
                api: 'registerQueue',
                location: { file: sfPath, line: pos.line, column: pos.column },
                workerConcurrencyFallback: resolved.fallback,
                workerConcurrencyEnvVar: resolved.envVar,
            };
            registrations.push(syntheticReg);
        }
    });
}

/**
 * Resolves the numeric fallback from a worker concurrency expression.
 *
 * Supported patterns:
 *   - `process.env.X ?? <literal>`
 *   - `Number(process.env.X) || <literal>`
 *   - `parseInt(process.env.X, 10) || <literal>`
 *
 * Returns `{ envVar, fallback }` or `null` if the pattern is not recognised.
 */
function resolveEnvFallback(node: Node, numericConsts: NumericConstIndex): { envVar: string; fallback: number } | null {
    const kind = node.getKind();

    // Binary expression: LHS ?? RHS  or  LHS || RHS
    if (kind === SyntaxKind.BinaryExpression) {
        const bin = node.asKindOrThrow(SyntaxKind.BinaryExpression);
        const op = bin.getOperatorToken().getText();
        if (op !== '??' && op !== '||') return null;

        const right = bin.getRight();
        const fallback = readNumeric(right, numericConsts);
        if (fallback === undefined) return null;

        const left = bin.getLeft();
        const envVar = extractEnvVar(left);
        if (envVar === null) return null;

        return { envVar, fallback };
    }

    return null;
}

/**
 * Extracts the env-var name string from a `process.env.X` or
 * `Number(process.env.X)` / `parseInt(process.env.X, 10)` expression.
 *
 * Also handles `Number(process.env.X ?? 'fallback')` — the inner `??` binary
 * expression is unwrapped by taking the LHS (the env var reference), ignoring
 * the inner string fallback. The OUTER numeric fallback (from `resolveEnvFallback`)
 * is what counts as the actual concurrency fallback value.
 */
function extractEnvVar(node: Node): string | null {
    const kind = node.getKind();

    // Direct: process.env.X
    if (kind === SyntaxKind.PropertyAccessExpression) {
        const text = node.getText();
        const match = text.match(/^process\.env\.([A-Z_a-z][A-Z_a-z0-9]*)$/);
        return match ? (match[1] ?? null) : null;
    }

    // Wrapped: Number(process.env.X) or parseInt(process.env.X, 10)
    // Also: Number(process.env.X ?? 'fallback') — unwrap the inner ?? binary
    if (kind === SyntaxKind.CallExpression) {
        const call = node as CallExpression;
        const fnExpr = call.getExpression().getText();
        if (fnExpr !== 'Number' && fnExpr !== 'parseInt') return null;
        const firstArg = call.getArguments()[0];
        if (!firstArg) return null;
        // Recurse — handles both direct process.env.X and inner binary expressions
        return extractEnvVar(firstArg);
    }

    // Inner binary: process.env.X ?? 'fallback' (or process.env.X ?? someDefault)
    // Take the LHS (the env var); ignore the inner fallback literal.
    if (kind === SyntaxKind.BinaryExpression) {
        const bin = node.asKindOrThrow(SyntaxKind.BinaryExpression);
        const op = bin.getOperatorToken().getText();
        if (op !== '??' && op !== '||') return null;
        return extractEnvVar(bin.getLeft());
    }

    return null;
}

// ---------------------------------------------------------------------------
// Job-data type resolution (--with-types pass)
// ---------------------------------------------------------------------------

/**
 * Resolves `Job<DataType>` generic parameter for each `@Process` method.
 *
 * For each consumer processor site, walks the methods decorated with `@Process`
 * and uses ts-morph's type-checker to resolve the first parameter's generic type.
 *
 * If the type argument is an object-literal type (anonymous), `typeName` is
 * set to `'<inline>'`. On any failure, the entry is silently skipped.
 *
 * Design choice: if multiple `@Process` methods on different classes target the
 * same queue, ALL entries are appended (not first-seen dedup). This preserves
 * per-method resolution for multi-process processor classes.
 */
function resolveJobDataTypes(
    project: Project,
    consumers: BullMqProcessorSite[],
    out: BullMqJobDataType[],
    unresolvedOut: Array<{ queueName: string; processorClass: string; methodName: string; reason: string }>,
): void {
    for (const consumer of consumers) {
        if (consumer.queue.kind === 'unresolved') continue;
        const queueName = consumer.queue.name;

        // Find source file containing the processor class
        const sf = project.getSourceFiles().find(
            (f) => f.getFilePath() === consumer.location.file,
        );
        if (!sf) continue;

        const cls = sf.getClasses().find((c) => c.getName() === consumer.className);
        if (!cls) continue;

        for (const method of cls.getMethods()) {
            const processDecorator = method.getDecorator('Process');
            if (!processDecorator) continue;

            const params = method.getParameters();
            if (params.length === 0) continue;

            const firstParam = params[0]!;
            try {
                const typeNode = firstParam.getTypeNode();
                if (!typeNode) continue;

                // Type text e.g. "Job<MyData>" or "Job<{ foo: string }>"
                const typeText = typeNode.getText();
                if (!typeText.startsWith('Job<') || !typeText.endsWith('>')) continue;

                // Extract the type argument text
                const innerText = typeText.slice(4, -1).trim();

                let typeName: string;
                let fields: string[] = [];

                if (innerText.startsWith('{')) {
                    // Inline object literal type
                    typeName = '<inline>';
                    // Extract depth-1 property names from inline type literal
                    fields = extractInlineTypeFields(innerText);
                } else {
                    // Named type — use ts-morph type-checker for field resolution
                    typeName = innerText;
                    const paramType = firstParam.getType();
                    // paramType is Job<X> — get type arguments
                    const typeArgs = paramType.getTypeArguments();
                    if (typeArgs.length > 0) {
                        const dataType = typeArgs[0]!;
                        fields = dataType
                            .getProperties()
                            .map((p) => p.getName())
                            .filter((n) => !n.startsWith('__'));
                    }
                }

                out.push({
                    queueName,
                    processorClass: consumer.className,
                    methodName: method.getName(),
                    typeName,
                    fields,
                });
            } catch (err) {
                // Type-checker pass is best-effort — record failure in diagnostics
                unresolvedOut.push({
                    queueName,
                    processorClass: consumer.className,
                    methodName: method.getName(),
                    reason: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }
}

/**
 * Extract depth-1 property names from an inline TypeScript object-literal type.
 * e.g. `{ foo: string; bar: number; baz?: boolean }` → `['foo', 'bar', 'baz']`
 * e.g. `{ outer: { inner: string }; top: number }` → `['outer', 'top']` (NOT 'inner')
 *
 * Uses a character-by-character brace-depth scanner to enforce "depth-1 only":
 * properties of nested types (depth > 1) are excluded.
 */
function extractInlineTypeFields(typeText: string): string[] {
    const fields: string[] = [];
    const seen = new Set<string>();
    const re = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\??:/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(typeText)) !== null) {
        const prefix = typeText.slice(0, match.index);
        let depth = 0;
        for (const ch of prefix) {
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
        }
        if (depth === 1) {
            const name = match[1]!;
            if (!seen.has(name)) {
                seen.add(name);
                fields.push(name);
            }
        }
        if (fields.length > 64) break;   // pathological-type guard
    }
    return fields;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a numeric value from a node: accepts `NumericLiteral` directly or
 * resolves an `Identifier` via `NumericConstIndex`. Returns `undefined` for
 * any other kind (dynamic expressions, runtime calls, etc.) — callers silently
 * treat `undefined` as "not resolved".
 */
function readNumeric(node: Node, idx: NumericConstIndex): number | undefined {
    const k = node.getKind();
    if (k === SyntaxKind.NumericLiteral) return Number(node.getText());
    if (k === SyntaxKind.Identifier) return idx.get(node.getText());
    return undefined;
}

function findProp(obj: ObjectLiteralExpression, name: string): PropertyAssignment | null {
    for (const prop of obj.getProperties()) {
        if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
        const pa = prop as PropertyAssignment;
        if (pa.getName() === name) return pa;
    }
    return null;
}
