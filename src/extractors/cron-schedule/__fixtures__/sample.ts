/**
 * Fixture file for cron-schedule extractor tests.
 * Mirrors @nestjs/schedule usage patterns — NOT compiled/run, parsed by ts-morph.
 */

// Simulated CronExpression enum (mirrors @nestjs/schedule)
export enum CronExpression {
    EVERY_SECOND = '* * * * * *',
    EVERY_MINUTE = '*/1 * * * *',
    EVERY_5_MINUTES = '0 */5 * * * *',
    EVERY_HOUR = '0 * * * *',
    EVERY_DAY_AT_MIDNIGHT = '0 0 * * *',
    EVERY_WEEK = '0 0 * * 0',
}

// Simulated decorators — do not import @nestjs/schedule in fixture
declare function Cron(expression: string | CronExpression, options?: { name?: string; timeZone?: string }): MethodDecorator;
declare function Interval(ms: number): MethodDecorator;
declare function Interval(name: string, ms: number): MethodDecorator;
declare function Timeout(ms: number): MethodDecorator;
declare function Timeout(name: string, ms: number): MethodDecorator;

declare class SchedulerRegistry {
    addCronJob(name: string, job: unknown): void;
    addInterval(name: string, ms: number): void;
    addTimeout(name: string, timeout: unknown): void;
}

declare class CronJob {
    constructor(expression: string, callback: () => void);
}

// ── Test class A: @Cron with raw string ──────────────────────────────────────
export class TaskServiceA {
    @Cron('0 0 * * *')
    handleMidnightJob() {
        // runs at midnight
    }

    @Cron(CronExpression.EVERY_HOUR)
    handleHourlyJob() {
        // runs every hour
    }

    @Cron('* * * * *', { name: 'myJob' })
    handleNamedJob() {
        // named cron job
    }
}

// ── Test class B: @Interval and @Timeout ─────────────────────────────────────
export class TaskServiceB {
    @Interval(60000)
    handleInterval() {
        // every 60 seconds
    }

    @Timeout(5000)
    handleTimeout() {
        // fires once after 5 seconds
    }

    @Interval('namedInterval', 30000)
    handleNamedInterval() {
        // named interval
    }
}

// ── Test class C: SchedulerRegistry dynamic registrations ─────────────────
export class DynamicTaskService {
    constructor(private readonly schedulerRegistry: SchedulerRegistry) {}

    addDynamicJob() {
        this.schedulerRegistry.addCronJob('dynamicJob', new CronJob('0 0 * * *', () => {}));
    }

    addDynamicInterval() {
        this.schedulerRegistry.addInterval('dynamicInterval', 5000);
    }

    addDynamicTimeout() {
        this.schedulerRegistry.addTimeout('dynamicTimeout', {} as unknown);
    }
}

// ── Test class D: mixed — both @Cron and @Interval on different methods ──────
export class MixedTaskService {
    @Cron('0 */6 * * *')
    handleEvery6Hours() {}

    @Interval(120000)
    handleEvery2Minutes() {}
}

// ── Empty class — should produce no sites ────────────────────────────────────
export class EmptyService {}
