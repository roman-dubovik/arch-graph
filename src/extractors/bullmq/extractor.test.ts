import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import { extractBullMq } from './extractor.js';
import { mapBullMqToGraph } from '../../mapper/bullmq-to-graph.js';
import { OwnershipRegistry } from '../../core/service-registry.js';
import type { ArchGraphConfig } from '../../core/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(root = '/app'): ArchGraphConfig {
    return {
        id: 'test',
        root,
        appsGlob: 'apps/**',
    } as unknown as ArchGraphConfig;
}

function makeProject(source: string, filePath = '/app/apps/test-svc/src/test.ts'): Project {
    const p = new Project({
        useInMemoryFileSystem: true,
        compilerOptions: { target: 99, module: 99, moduleResolution: 100, strict: false },
    });
    p.createSourceFile(filePath, source);
    return p;
}

/**
 * Registry with two services:
 *   - test-svc: /app/apps/test-svc
 *   - other-svc: /app/apps/other-svc
 */
function makeRegistry(root = '/app'): OwnershipRegistry {
    return new OwnershipRegistry(root, [
        { id: 'test-svc', rootDir: '/app/apps/test-svc', tsconfigPath: null, entryFile: null },
        { id: 'other-svc', rootDir: '/app/apps/other-svc', tsconfigPath: null, entryFile: null },
    ], []);
}

// ---------------------------------------------------------------------------
// AC3b.1 — Queue node meta extras
// ---------------------------------------------------------------------------

describe('AC3b.1 — queue node meta', () => {
    it('concurrency parsed from @Processor({ concurrency: 5 }) decorator', async () => {
        const source = `
            import { Processor } from '@nestjs/bullmq';
            import { BullModule } from '@nestjs/bullmq';
            @Processor({ name: 'payments', concurrency: 5 })
            class PaymentsProcessor {}
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project);
        const consumer = result.consumers.find((c) => c.className === 'PaymentsProcessor');
        expect(consumer).toBeDefined();
        expect(consumer?.concurrency).toBe(5);
        // Verify mapper propagates @Processor concurrency to queue node meta
        const registry = makeRegistry();
        const mapped = mapBullMqToGraph(
            result.producers,
            result.consumers,
            result.registrations,
            registry,
        );
        const queueNode = mapped.nodes.find((n) => n.id === 'queue:payments');
        expect(queueNode?.meta?.['concurrency']).toBe(5);
    });

    it('concurrency parsed from @Processor(name, { concurrency: 3 }) — second arg options', async () => {
        const source = `
            import { Processor } from '@nestjs/bullmq';
            @Processor('orders', { concurrency: 3 })
            class OrdersProcessor {}
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project);
        const consumer = result.consumers.find((c) => c.className === 'OrdersProcessor');
        expect(consumer).toBeDefined();
        expect(consumer?.concurrency).toBe(3);
    });

    it('defaultDelay, defaultAttempts, defaultBackoff parsed from defaultJobOptions', async () => {
        const source = `
            import { BullModule } from '@nestjs/bullmq';
            BullModule.registerQueue({
                name: 'email',
                defaultJobOptions: {
                    delay: 1000,
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 500 },
                },
            });
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project);
        const reg = result.registrations.find(
            (r) => r.queue.kind !== 'unresolved' && r.queue.name === 'email',
        );
        expect(reg).toBeDefined();
        expect(reg?.defaultDelay).toBe(1000);
        expect(reg?.defaultAttempts).toBe(3);
        expect(reg?.defaultBackoff).toBeDefined();
    });

    it('hasRepeat: true when queue.add() has repeat option', async () => {
        const source = `
            import { InjectQueue } from '@nestjs/bullmq';
            import { BullModule } from '@nestjs/bullmq';

            BullModule.registerQueue({ name: 'reports' });

            class ReportService {
                constructor(@InjectQueue('reports') private reportsQueue: any) {}

                async schedule() {
                    await this.reportsQueue.add('daily', {}, { repeat: { every: 86400000 } });
                }
            }
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project);
        const repeatSites = result.repeatAddSites.filter((s) => s.queueName === 'reports');
        expect(repeatSites.length).toBeGreaterThan(0);
        // Verify mapper sets hasRepeat on queue node
        const registry = makeRegistry();
        const mapped = mapBullMqToGraph(
            result.producers,
            result.consumers,
            result.registrations,
            registry,
            result.repeatAddSites,
        );
        const queueNode = mapped.nodes.find((n) => n.id === 'queue:reports');
        expect(queueNode?.meta?.['hasRepeat']).toBe(true);
    });

    it('hasRepeat: true from defaultJobOptions.repeat in registerQueue', async () => {
        const source = `
            import { BullModule } from '@nestjs/bullmq';
            BullModule.registerQueue({
                name: 'scheduled',
                defaultJobOptions: {
                    repeat: { cron: '0 * * * *' },
                },
            });
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project);
        const reg = result.registrations.find(
            (r) => r.queue.kind !== 'unresolved' && r.queue.name === 'scheduled',
        );
        expect(reg?.hasDefaultRepeat).toBe(true);
        // Verify mapper sets hasRepeat on queue node
        const registry = makeRegistry();
        const mapped = mapBullMqToGraph(
            result.producers,
            result.consumers,
            result.registrations,
            registry,
        );
        const queueNode = mapped.nodes.find((n) => n.id === 'queue:scheduled');
        expect(queueNode?.meta?.['hasRepeat']).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// FIX 1 — failOver const resolution + unresolvedFailOver population
// ---------------------------------------------------------------------------

describe('FIX 1 — failOver resolution and unresolvedFailOver', () => {
    it('failOver as identifier resolves via QueueNameIndex', async () => {
        // QueueNameIndex indexes exported simple const declarations (e.g. export const DLQ_QUEUE = 'payments-dlq')
        const p = new Project({
            useInMemoryFileSystem: true,
            compilerOptions: { target: 99, module: 99, moduleResolution: 100, strict: false },
        });
        // The const must be exported for QueueNameIndex to pick it up
        p.createSourceFile('/app/apps/test-svc/src/constants.ts', `export const DLQ_QUEUE = 'payments-dlq';`);
        p.createSourceFile('/app/apps/test-svc/src/module.ts', `
            import { BullModule } from '@nestjs/bullmq';
            import { DLQ_QUEUE } from './constants';
            BullModule.registerQueue({
                name: 'payments',
                defaultJobOptions: {
                    attempts: 5,
                    failOver: DLQ_QUEUE,
                },
            });
            BullModule.registerQueue({ name: 'payments-dlq' });
        `);
        const result = await extractBullMq(makeConfig(), p);
        const reg = result.registrations.find(
            (r) => r.queue.kind !== 'unresolved' && r.queue.name === 'payments',
        );
        expect(reg?.failOverTarget).toBe('payments-dlq');

        const registry = makeRegistry();
        const mapped = mapBullMqToGraph(
            result.producers,
            result.consumers,
            result.registrations,
            registry,
            result.repeatAddSites,
            result.eventListenerSites,
            result.catchBlockAddSites,
            result.unresolvedFailOver,
        );
        const failsIntoEdge = mapped.edges.find((e) => e.kind === 'queue-fails-into');
        expect(failsIntoEdge).toBeDefined();
        expect(failsIntoEdge?.to).toBe('queue:payments-dlq');
    });

    it('failOver as non-literal (property access not in index) populates unresolvedFailOver', async () => {
        const source = `
            import { BullModule } from '@nestjs/bullmq';
            BullModule.registerQueue({
                name: 'payments',
                defaultJobOptions: {
                    attempts: 5,
                    failOver: someExternalRef.dlqQueue,
                },
            });
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project);
        // unresolvedFailOver should be populated
        expect(result.unresolvedFailOver.length).toBeGreaterThan(0);
        // No queue-fails-into edge should be emitted
        const registry = makeRegistry();
        const mapped = mapBullMqToGraph(
            result.producers,
            result.consumers,
            result.registrations,
            registry,
            result.repeatAddSites,
            result.eventListenerSites,
            result.catchBlockAddSites,
            result.unresolvedFailOver,
        );
        const failsIntoEdge = mapped.edges.find((e) => e.kind === 'queue-fails-into');
        expect(failsIntoEdge).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// AC3b.2 — queue-fails-into edge (MUST case)
// ---------------------------------------------------------------------------

describe('AC3b.2 — queue-fails-into edge', () => {
    it('MUST case: queue-fails-into edge from registerQueue.failOver', async () => {
        const source = `
            import { BullModule } from '@nestjs/bullmq';
            BullModule.registerQueue({
                name: 'payments',
                defaultJobOptions: {
                    attempts: 5,
                    failOver: 'payments-dlq',
                },
            });
            BullModule.registerQueue({ name: 'payments-dlq' });
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project);
        const reg = result.registrations.find(
            (r) => r.queue.kind !== 'unresolved' && r.queue.name === 'payments',
        );
        expect(reg?.failOverTarget).toBe('payments-dlq');

        const registry = makeRegistry();
        const mapped = mapBullMqToGraph(
            result.producers,
            result.consumers,
            result.registrations,
            registry,
        );
        const failsIntoEdge = mapped.edges.find((e) => e.kind === 'queue-fails-into');
        expect(failsIntoEdge).toBeDefined();
        expect(failsIntoEdge?.from).toBe('queue:payments');
        expect(failsIntoEdge?.to).toBe('queue:payments-dlq');
        expect(failsIntoEdge?.meta?.['source']).toBe('registerQueue.failOver');
    });

    it('MAY case: queue-fails-into from catch-block .add() inside @Process method', async () => {
        const source = `
            import { Processor, Process } from '@nestjs/bullmq';
            import { InjectQueue } from '@nestjs/bullmq';
            import { BullModule } from '@nestjs/bullmq';

            BullModule.registerQueue({ name: 'main-queue' });
            BullModule.registerQueue({ name: 'dead-letters' });

            @Processor('main-queue')
            class MainProcessor {
                constructor(@InjectQueue('dead-letters') private dlqQueue: any) {}

                @Process()
                async handle(job: any) {
                    try {
                        await doWork(job);
                    } catch (err) {
                        await this.dlqQueue.add('failed-job', job.data);
                    }
                }
            }
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project);

        // catch-block site should be detected
        expect(result.catchBlockAddSites.length).toBeGreaterThan(0);
        const catchSite = result.catchBlockAddSites[0]!;
        expect(catchSite.processorQueueName).toBe('main-queue');

        const registry = makeRegistry();
        const mapped = mapBullMqToGraph(
            result.producers,
            result.consumers,
            result.registrations,
            registry,
            result.repeatAddSites,
            result.eventListenerSites,
            result.catchBlockAddSites,
        );
        const failsIntoEdge = mapped.edges.find(
            (e) => e.kind === 'queue-fails-into' && e.meta?.['heuristic'] === true,
        );
        expect(failsIntoEdge).toBeDefined();
        expect(failsIntoEdge?.from).toBe('queue:main-queue');
        expect(failsIntoEdge?.to).toBe('queue:dead-letters');
        expect(failsIntoEdge?.meta?.['source']).toBe('catch-block-add');
    });

    it('catch-block .add() with unresolved receiver populates unresolvedCatchBlockSites (no phantom queue node)', async () => {
        const source = `
            import { Processor, Process } from '@nestjs/bullmq';
            import { BullModule } from '@nestjs/bullmq';

            BullModule.registerQueue({ name: 'main-queue' });

            @Processor('main-queue')
            class MainProcessor {
                @Process()
                async handle(job: any) {
                    try {
                        await doWork(job);
                    } catch (err) {
                        await unknownExternalQueue.add('failed-job', job.data);
                    }
                }
            }
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project);

        // No catch-block site should be emitted (receiver unresolved)
        expect(result.catchBlockAddSites).toHaveLength(0);
        // unresolvedCatchBlockSites should be populated
        expect(result.unresolvedCatchBlockSites.length).toBeGreaterThan(0);
        expect(result.unresolvedCatchBlockSites[0]!.processorQueueName).toBe('main-queue');
        expect(result.unresolvedCatchBlockSites[0]!.receiverText).toBe('unknownExternalQueue');

        const registry = makeRegistry();
        const mapped = mapBullMqToGraph(
            result.producers,
            result.consumers,
            result.registrations,
            registry,
            result.repeatAddSites,
            result.eventListenerSites,
            result.catchBlockAddSites,
            result.unresolvedFailOver,
            result.unresolvedEventListeners,
            result.unresolvedCatchBlockSites,
        );
        // No phantom queue node for the unresolved receiver
        const failsIntoEdge = mapped.edges.find((e) => e.kind === 'queue-fails-into');
        expect(failsIntoEdge).toBeUndefined();
        // unresolvedCatchBlockSites should be surfaced in diagnostics
        expect(mapped.diagnostics.unresolvedCatchBlockSites?.length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// FIX 7 — Unresolved diagnostic paths
// ---------------------------------------------------------------------------

describe('FIX 7 — unresolved diagnostic paths', () => {
    it('registerQueue with non-object-arg produces unresolved diagnostic', async () => {
        const source = `
            import { BullModule } from '@nestjs/bullmq';
            BullModule.registerQueue(someVariable);
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project);
        const unresolved = result.registrations.filter((r) => r.queue.kind === 'unresolved');
        expect(unresolved.length).toBeGreaterThan(0);
        const reg = unresolved[0]!;
        expect(reg.queue.kind).toBe('unresolved');
        if (reg.queue.kind === 'unresolved') {
            expect(reg.queue.reason).toBe('non-object-arg');
        }

        const registry = makeRegistry();
        const mapped = mapBullMqToGraph(
            result.producers,
            result.consumers,
            result.registrations,
            registry,
        );
        // Unresolved registration should appear in diagnostics, not as a queue node
        expect(mapped.diagnostics.unresolved.length).toBeGreaterThan(0);
        const queueNode = mapped.nodes.find((n) => n.kind === 'queue');
        expect(queueNode).toBeUndefined();
    });

    it('registerQueue without name property produces unresolved diagnostic', async () => {
        const source = `
            import { BullModule } from '@nestjs/bullmq';
            BullModule.registerQueue({ concurrency: 3 });
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project);
        const unresolved = result.registrations.filter((r) => r.queue.kind === 'unresolved');
        expect(unresolved.length).toBeGreaterThan(0);
        const reg = unresolved[0]!;
        expect(reg.queue.kind).toBe('unresolved');
        if (reg.queue.kind === 'unresolved') {
            expect(reg.queue.reason).toBe('no-name-property');
        }

        const registry = makeRegistry();
        const mapped = mapBullMqToGraph(
            result.producers,
            result.consumers,
            result.registrations,
            registry,
        );
        expect(mapped.diagnostics.unresolved.length).toBeGreaterThan(0);
        const queueNode = mapped.nodes.find((n) => n.kind === 'queue');
        expect(queueNode).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// AC3b.3 — queue-event-listener edge
// ---------------------------------------------------------------------------

describe('AC3b.3 — queue-event-listener edge', () => {
    it('cross-owner .on("failed") emits queue-event-listener edge', async () => {
        // Registration owner: other-svc; listener owner: test-svc → cross-link
        const regSource = `
            import { BullModule } from '@nestjs/bullmq';
            BullModule.registerQueue({ name: 'notifications' });
        `;
        const listenerSource = `
            import { InjectQueue } from '@nestjs/bullmq';

            class NotificationMonitor {
                constructor(@InjectQueue('notifications') private notifQueue: any) {}

                init() {
                    this.notifQueue.on('failed', (job: any, err: Error) => {
                        console.error(err);
                    });
                }
            }
        `;
        const p = new Project({
            useInMemoryFileSystem: true,
            compilerOptions: { target: 99, module: 99, moduleResolution: 100, strict: false },
        });
        p.createSourceFile('/app/apps/other-svc/src/module.ts', regSource);
        p.createSourceFile('/app/apps/test-svc/src/monitor.ts', listenerSource);

        const result = await extractBullMq(makeConfig(), p);
        expect(result.eventListenerSites.length).toBeGreaterThan(0);
        const site = result.eventListenerSites.find((s) => s.event === 'failed' && s.queueName === 'notifications');
        expect(site).toBeDefined();

        const registry = makeRegistry();
        const mapped = mapBullMqToGraph(
            result.producers,
            result.consumers,
            result.registrations,
            registry,
            result.repeatAddSites,
            result.eventListenerSites,
        );
        const listenerEdge = mapped.edges.find((e) => e.kind === 'queue-event-listener');
        expect(listenerEdge).toBeDefined();
        expect(listenerEdge?.to).toBe('queue:notifications');
        expect(listenerEdge?.meta?.['event']).toBe('failed');
    });

    it('unresolvedEventListeners populated when queue.on receiver is unresolvable', async () => {
        const source = `
            import { BullModule } from '@nestjs/bullmq';
            BullModule.registerQueue({ name: 'notifications' });

            class SomeService {
                init() {
                    someUnknownRef.on('failed', (job: any, err: Error) => {
                        console.error(err);
                    });
                }
            }
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project);
        // No resolved event-listener site
        expect(result.eventListenerSites).toHaveLength(0);
        // unresolvedEventListeners should be populated
        expect(result.unresolvedEventListeners.length).toBeGreaterThan(0);
        expect(result.unresolvedEventListeners[0]!.event).toBe('failed');
        expect(result.unresolvedEventListeners[0]!.receiverText).toBe('someUnknownRef');
    });

    it('self-loop .on() is silently dropped (no edge emitted)', async () => {
        // Same file registers the queue AND subscribes to its events
        const source = `
            import { BullModule } from '@nestjs/bullmq';
            import { InjectQueue } from '@nestjs/bullmq';

            BullModule.registerQueue({ name: 'self-loop-queue' });

            class SameOwnerService {
                constructor(@InjectQueue('self-loop-queue') private q: any) {}

                init() {
                    this.q.on('completed', (job: any) => {
                        console.log('done');
                    });
                }
            }
        `;
        const project = makeProject(source, '/app/apps/test-svc/src/service.ts');
        const result = await extractBullMq(makeConfig(), project);

        const registry = makeRegistry();
        const mapped = mapBullMqToGraph(
            result.producers,
            result.consumers,
            result.registrations,
            registry,
            result.repeatAddSites,
            result.eventListenerSites,
        );
        const listenerEdges = mapped.edges.filter((e) => e.kind === 'queue-event-listener');
        // Self-loop should be dropped
        expect(listenerEdges).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Round 2 P1 — registerQueueAsync, variadic, mergeQueueMeta, unownedEventListeners
// ---------------------------------------------------------------------------

describe('Round 2 P1 — registerQueueAsync, variadic, mergeQueueMeta, unownedEventListeners', () => {
    it('registerQueueAsync emits registration with api=\'registerQueueAsync\'', async () => {
        const source = `
            import { BullModule } from '@nestjs/bullmq';
            BullModule.registerQueueAsync({ name: 'email' });
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project);
        expect(result.registrations.length).toBe(1);
        expect(result.registrations[0]!.api).toBe('registerQueueAsync');

        // thread through mapper and assert api propagated to queue node meta
        const registry = makeRegistry();
        const mapped = mapBullMqToGraph(
            result.producers,
            result.consumers,
            result.registrations,
            registry,
        );
        const queueNode = mapped.nodes.find((n) => n.id === 'queue:email');
        expect(queueNode?.meta?.['api']).toBe('registerQueueAsync');
    });

    it('variadic registerQueue(a, b) registers both queues', async () => {
        const source = `
            import { BullModule } from '@nestjs/bullmq';
            BullModule.registerQueue({ name: 'q1' }, { name: 'q2' });
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project);
        expect(result.registrations.length).toBe(2);
        const names = result.registrations
            .map((r) => (r.queue.kind !== 'unresolved' ? r.queue.name : null))
            .filter(Boolean);
        expect(names).toContain('q1');
        expect(names).toContain('q2');
    });

    it('mergeQueueMeta: first-seen wins for numerics, OR for hasRepeat', async () => {
        // Two registerQueue calls for the same queue name in the same project.
        // First call: attempts=3, no repeat.
        // Second call: attempts=7, with repeat — hasRepeat should OR to true.
        const p = new Project({
            useInMemoryFileSystem: true,
            compilerOptions: { target: 99, module: 99, moduleResolution: 100, strict: false },
        });
        p.createSourceFile('/app/apps/test-svc/src/module-a.ts', `
            import { BullModule } from '@nestjs/bullmq';
            BullModule.registerQueue({
                name: 'shared',
                defaultJobOptions: { attempts: 3 },
            });
        `);
        p.createSourceFile('/app/apps/test-svc/src/module-b.ts', `
            import { BullModule } from '@nestjs/bullmq';
            BullModule.registerQueue({
                name: 'shared',
                defaultJobOptions: { attempts: 7, repeat: { cron: '0 * * * *' } },
            });
        `);
        const result = await extractBullMq(makeConfig(), p);
        const registry = makeRegistry();
        const mapped = mapBullMqToGraph(
            result.producers,
            result.consumers,
            result.registrations,
            registry,
        );
        const queueNode = mapped.nodes.find((n) => n.id === 'queue:shared');
        expect(queueNode).toBeDefined();
        // first-seen wins for numeric
        expect(queueNode?.meta?.['defaultAttempts']).toBe(3);
        // OR rule for boolean
        expect(queueNode?.meta?.['hasRepeat']).toBe(true);
    });

    it('unownedEventListeners populated when listener file has no resolved owner', async () => {
        // Queue is registered inside a known app root; listener lives at /elsewhere/monitor.ts
        // which is outside all known roots → ownership.findOwner returns { kind: 'unknown' }.
        const p = new Project({
            useInMemoryFileSystem: true,
            compilerOptions: { target: 99, module: 99, moduleResolution: 100, strict: false },
        });
        p.createSourceFile('/app/apps/test-svc/src/module.ts', `
            import { BullModule } from '@nestjs/bullmq';
            BullModule.registerQueue({ name: 'alerts' });
        `);
        p.createSourceFile('/elsewhere/monitor.ts', `
            import { InjectQueue } from '@nestjs/bullmq';

            class AlertMonitor {
                constructor(@InjectQueue('alerts') private alertsQueue: any) {}

                init() {
                    this.alertsQueue.on('failed', (job: any, err: Error) => {
                        console.error(err);
                    });
                }
            }
        `);
        const result = await extractBullMq(makeConfig(), p);
        // The listener site should be resolved (queue name known via @InjectQueue)
        expect(result.eventListenerSites.length).toBeGreaterThan(0);

        const registry = makeRegistry(); // only knows /app/apps/test-svc and /app/apps/other-svc
        const mapped = mapBullMqToGraph(
            result.producers,
            result.consumers,
            result.registrations,
            registry,
            result.repeatAddSites,
            result.eventListenerSites,
        );
        // No queue-event-listener edge should be emitted for the unowned listener
        const listenerEdges = mapped.edges.filter((e) => e.kind === 'queue-event-listener');
        expect(listenerEdges).toHaveLength(0);
        // unownedEventListeners diagnostic should be populated
        expect(mapped.diagnostics.unownedEventListeners?.length).toBe(1);
        expect(mapped.diagnostics.unownedEventListeners?.[0]?.queueName).toBe('alerts');
        expect(mapped.diagnostics.unownedEventListeners?.[0]?.event).toBe('failed');
    });
});

// ---------------------------------------------------------------------------
// AC3c — Task 3c specs
// ---------------------------------------------------------------------------

describe('AC3c.1 — @Process method with Job<MyData> resolves typeName + fields when withTypes=true', () => {
    it('resolves typeName and depth-1 fields for named Job<T> parameter', async () => {
        const source = `
            import { Processor, Process } from '@nestjs/bullmq';

            interface PaymentData {
                userId: string;
                amount: number;
                currency: string;
            }

            // Minimal Job stub so ts-morph can resolve the type arg
            interface Job<T = any> { data: T; }

            @Processor('payments')
            class PaymentsProcessor {
                @Process()
                async handle(job: Job<PaymentData>) {}
            }
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project, { withTypes: true });
        expect(result.jobDataTypes.length).toBeGreaterThan(0);
        const jd = result.jobDataTypes[0]!;
        expect(jd.queueName).toBe('payments');
        expect(jd.processorClass).toBe('PaymentsProcessor');
        expect(jd.typeName).toBe('PaymentData');
        // Fields from the PaymentData interface
        expect(jd.fields).toContain('userId');
        expect(jd.fields).toContain('amount');
        expect(jd.fields).toContain('currency');
    });

    it('resolves typeName=<inline> and fields for inline Job<{...}> parameter', async () => {
        const source = `
            import { Processor, Process } from '@nestjs/bullmq';
            interface Job<T = any> { data: T; }

            @Processor('notifications')
            class NotifProcessor {
                @Process()
                async handle(job: Job<{ recipientId: string; message: string }>) {}
            }
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project, { withTypes: true });
        expect(result.jobDataTypes.length).toBeGreaterThan(0);
        const jd = result.jobDataTypes[0]!;
        expect(jd.typeName).toBe('<inline>');
        expect(jd.fields).toContain('recipientId');
        expect(jd.fields).toContain('message');
    });
});

describe('AC3c.1 (negative) — --with-types off skips job-data resolution', () => {
    it('jobDataTypes is empty when withTypes is not set', async () => {
        const source = `
            import { Processor, Process } from '@nestjs/bullmq';
            interface Job<T = any> { data: T; }

            @Processor('payments')
            class PaymentsProcessor {
                @Process()
                async handle(job: Job<{ userId: string }>) {}
            }
        `;
        const project = makeProject(source);
        // default options — withTypes is false
        const result = await extractBullMq(makeConfig(), project);
        expect(result.jobDataTypes).toHaveLength(0);
    });
});

describe('AC3c.2 — worker factory env-fallback concurrency resolves to numeric default', () => {
    it('process.env.X ?? 7 resolves fallback=7 with the env-var name', async () => {
        const source = `
            const factory = new WorkerFactory();
            factory.createWorker('analytics', { concurrency: process.env.ANALYTICS_CONCURRENCY ?? 7 });
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project);
        const reg = result.registrations.find(
            (r) => r.queue.kind !== 'unresolved' && r.queue.name === 'analytics',
        );
        expect(reg).toBeDefined();
        const mutableReg = reg as unknown as Record<string, unknown>;
        expect(mutableReg['workerConcurrencyFallback']).toBe(7);
        expect(mutableReg['workerConcurrencyEnvVar']).toBe('ANALYTICS_CONCURRENCY');
    });

    it('Number(process.env.X) || 10 resolves fallback=10', async () => {
        const source = `
            const factory = new WorkerFactory();
            factory.createWorker('emails', { concurrency: Number(process.env.EMAIL_WORKERS) || 10 });
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project);
        const reg = result.registrations.find(
            (r) => r.queue.kind !== 'unresolved' && r.queue.name === 'emails',
        );
        expect(reg).toBeDefined();
        const mutableReg = reg as unknown as Record<string, unknown>;
        expect(mutableReg['workerConcurrencyFallback']).toBe(10);
        expect(mutableReg['workerConcurrencyEnvVar']).toBe('EMAIL_WORKERS');
    });
});

describe('AC3c.3 — queue.add with literal cron creates cron-schedule node + queue-repeat edge', () => {
    it('emits cron-schedule node and queue-repeat edge for literal cron expression', async () => {
        const source = `
            import { InjectQueue } from '@nestjs/bullmq';
            import { BullModule } from '@nestjs/bullmq';

            BullModule.registerQueue({ name: 'reports' });

            class ReportScheduler {
                constructor(@InjectQueue('reports') private reportsQueue: any) {}

                async schedule() {
                    await this.reportsQueue.add('daily', {}, { repeat: { cron: '0 0 * * *' } });
                }
            }
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project);
        const repeatSite = result.repeatAddSites.find((s) => s.queueName === 'reports');
        expect(repeatSite).toBeDefined();
        expect(repeatSite?.repeatExpression).toBe('0 0 * * *');
        expect(repeatSite?.jobName).toBe('daily');

        const registry = makeRegistry();
        const mapped = mapBullMqToGraph(
            result.producers,
            result.consumers,
            result.registrations,
            registry,
            result.repeatAddSites,
            result.eventListenerSites,
            result.catchBlockAddSites,
            result.unresolvedFailOver,
            result.unresolvedEventListeners,
            result.unresolvedCatchBlockSites,
            result.unresolvedRepeatExpressions,
        );

        // Cron-schedule node must exist
        const cronNode = mapped.nodes.find((n) => n.kind === 'cron-schedule');
        expect(cronNode).toBeDefined();
        expect(cronNode?.meta?.['expression']).toBe('0 0 * * *');
        expect(cronNode?.meta?.['category']).toBe('queue-repeat');

        // queue-repeat edge must exist
        const repeatEdge = mapped.edges.find((e) => e.kind === 'queue-repeat');
        expect(repeatEdge).toBeDefined();
        expect(repeatEdge?.from).toBe('queue:reports');
        expect(repeatEdge?.to).toBe(cronNode?.id);
        expect(repeatEdge?.meta?.['repeatExpression']).toBe('0 0 * * *');
    });
});

describe('extractInlineTypeFields — depth-1 only', () => {
    it('returns depth-1 fields only, excluding nested type properties', async () => {
        // Fixture: @Process() async handle(job: Job<{ outer: { inner: string }; top: number }>): Promise<void> {}
        // After FIX A, depth-1 scanner must return ['outer', 'top'], NOT ['outer', 'inner', 'top']
        const source = `
            import { Processor, Process } from '@nestjs/bullmq';
            @Processor('nested-type-queue')
            class NestedTypeProcessor {
                @Process()
                async handle(job: Job<{ outer: { inner: string }; top: number }>): Promise<void> {}
            }
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project, { withTypes: true });
        expect(result.jobDataTypes.length).toBeGreaterThanOrEqual(1);
        const jd = result.jobDataTypes.find((j) => j.queueName === 'nested-type-queue');
        expect(jd).toBeDefined();
        // Must NOT include 'inner' — depth-1 only
        expect(jd?.fields).toEqual(['outer', 'top']);
        expect(jd?.fields).not.toContain('inner');
    });
});

describe('AC3c.5 (optional) — queue.add with non-literal cron populates unresolvedRepeatExpressions', () => {
    it('non-literal cron expression goes to unresolvedRepeatExpressions diagnostic', async () => {
        const source = `
            import { InjectQueue } from '@nestjs/bullmq';
            import { BullModule } from '@nestjs/bullmq';

            const DYNAMIC_CRON = process.env.CRON_EXPR;
            BullModule.registerQueue({ name: 'dynamic-jobs' });

            class DynamicScheduler {
                constructor(@InjectQueue('dynamic-jobs') private jobsQueue: any) {}

                async schedule() {
                    await this.jobsQueue.add('task', {}, { repeat: { cron: DYNAMIC_CRON } });
                }
            }
        `;
        const project = makeProject(source);
        const result = await extractBullMq(makeConfig(), project);

        // Should record as unresolved — not as repeatExpression
        const repeatSite = result.repeatAddSites.find((s) => s.queueName === 'dynamic-jobs');
        expect(repeatSite).toBeDefined();
        expect(repeatSite?.repeatExpression).toBeUndefined();

        // Unresolved diagnostic
        expect(result.unresolvedRepeatExpressions.length).toBeGreaterThan(0);
        expect(result.unresolvedRepeatExpressions[0]!.queueName).toBe('dynamic-jobs');
    });
});
