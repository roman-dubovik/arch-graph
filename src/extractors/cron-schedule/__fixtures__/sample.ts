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

    addDynamicTimeoutMs() {
        this.schedulerRegistry.addTimeout('dynamicTimeoutMs', 10000);
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

// ── Test class E: unresolvable decorator args (round-2 diagnostics) ──────────
declare const MS_CONST: number;
declare const optionsVar: { name: string; timeZone: string };

export class UnresolvableService {
    @Interval(MS_CONST)
    handleIntervalConst() {
        // MS_CONST is not a literal — should appear in diagnostics.unresolved
    }

    @Cron(CronExpression.EVERY_HOUR, optionsVar)
    handleCronWithVarOptions() {
        // optionsVar is not an object literal — site emitted, appears in diagnostics.unresolvedOptions
    }
}

// ── Test class F: receiver-name variants for guard symmetry ──────────────────
declare class UnrelatedService {
    addInterval(name: string, ms: number): void;
}

export class ReceiverGuardService {
    constructor(
        private readonly cron: SchedulerRegistry,
        private readonly unrelated: UnrelatedService,
    ) {}

    addViaCronReceiver() {
        // 'cron' matches LIKELY_SCHEDULER_RECEIVER_RE → should be emitted as a site
        this.cron.addCronJob('cronReceiverJob', new CronJob('0 12 * * *', () => {}));
    }

    addViaUnrelatedReceiver() {
        // 'unrelated' does NOT match LIKELY_SCHEDULER_RECEIVER_RE → filtered, recorded in filteredByReceiver
        this.unrelated.addInterval('unrelatedInterval', 3000);
    }
}
