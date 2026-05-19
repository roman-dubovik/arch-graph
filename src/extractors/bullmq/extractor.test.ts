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
        const source = `
            import { BullModule } from '@nestjs/bullmq';
            const QUEUE_NAMES = { DLQ: 'payments-dlq' };
            BullModule.registerQueue({
                name: 'payments',
                defaultJobOptions: {
                    attempts: 5,
                    failOver: QUEUE_NAMES.DLQ,
                },
            });
            BullModule.registerQueue({ name: 'payments-dlq' });
        `;
        const p = new Project({
            useInMemoryFileSystem: true,
            compilerOptions: { target: 99, module: 99, moduleResolution: 100, strict: false },
        });
        // const declarations must be in a separate file for QueueNameIndex to pick them up
        p.createSourceFile('/app/apps/test-svc/src/constants.ts', `export const QUEUE_NAMES = { DLQ: 'payments-dlq' };`);
        p.createSourceFile('/app/apps/test-svc/src/module.ts', source);
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
