/**
 * Constants for the @nestjs/schedule cron-schedule extractor.
 *
 * Decorator names and CronExpression enum → cron-string mapping.
 * Only well-known aliases are mapped inline — we do NOT add a cronstrue dep.
 * Custom expressions are stored as-is with no humanReadable text.
 */

/** Decorator names recognised from @nestjs/schedule. */
export const CRON_DECORATOR_NAMES = ['Cron', 'Interval', 'Timeout'] as const;
export type CronDecoratorName = (typeof CRON_DECORATOR_NAMES)[number];

/** SchedulerRegistry dynamic registration methods. */
export const SCHEDULER_REGISTRY_METHODS = ['addCronJob', 'addInterval', 'addTimeout'] as const;
export type SchedulerRegistryMethod = (typeof SCHEDULER_REGISTRY_METHODS)[number];

/**
 * Subset of CronExpression enum values from @nestjs/schedule.
 * Maps enum member name → cron string + optional human-readable label.
 */
export const CRON_EXPRESSION_MAP: Record<string, { expression: string; humanReadable: string }> = {
    EVERY_SECOND: { expression: '* * * * * *', humanReadable: 'every second' },
    EVERY_5_SECONDS: { expression: '*/5 * * * * *', humanReadable: 'every 5 seconds' },
    EVERY_10_SECONDS: { expression: '*/10 * * * * *', humanReadable: 'every 10 seconds' },
    EVERY_30_SECONDS: { expression: '*/30 * * * * *', humanReadable: 'every 30 seconds' },
    EVERY_MINUTE: { expression: '*/1 * * * *', humanReadable: 'every minute' },
    EVERY_5_MINUTES: { expression: '0 */5 * * * *', humanReadable: 'every 5 minutes' },
    EVERY_10_MINUTES: { expression: '0 */10 * * * *', humanReadable: 'every 10 minutes' },
    EVERY_30_MINUTES: { expression: '0 */30 * * * *', humanReadable: 'every 30 minutes' },
    EVERY_HOUR: { expression: '0 * * * *', humanReadable: 'every hour' },
    EVERY_2_HOURS: { expression: '0 */2 * * *', humanReadable: 'every 2 hours' },
    EVERY_3_HOURS: { expression: '0 */3 * * *', humanReadable: 'every 3 hours' },
    EVERY_4_HOURS: { expression: '0 */4 * * *', humanReadable: 'every 4 hours' },
    EVERY_5_HOURS: { expression: '0 */5 * * *', humanReadable: 'every 5 hours' },
    EVERY_6_HOURS: { expression: '0 */6 * * *', humanReadable: 'every 6 hours' },
    EVERY_7_HOURS: { expression: '0 */7 * * *', humanReadable: 'every 7 hours' },
    EVERY_8_HOURS: { expression: '0 */8 * * *', humanReadable: 'every 8 hours' },
    EVERY_9_HOURS: { expression: '0 */9 * * *', humanReadable: 'every 9 hours' },
    EVERY_10_HOURS: { expression: '0 */10 * * *', humanReadable: 'every 10 hours' },
    EVERY_11_HOURS: { expression: '0 */11 * * *', humanReadable: 'every 11 hours' },
    EVERY_12_HOURS: { expression: '0 */12 * * *', humanReadable: 'every 12 hours' },
    EVERY_DAY_AT_1AM: { expression: '0 01 * * *', humanReadable: 'every day at 1am' },
    EVERY_DAY_AT_2AM: { expression: '0 02 * * *', humanReadable: 'every day at 2am' },
    EVERY_DAY_AT_3AM: { expression: '0 03 * * *', humanReadable: 'every day at 3am' },
    EVERY_DAY_AT_4AM: { expression: '0 04 * * *', humanReadable: 'every day at 4am' },
    EVERY_DAY_AT_5AM: { expression: '0 05 * * *', humanReadable: 'every day at 5am' },
    EVERY_DAY_AT_6AM: { expression: '0 06 * * *', humanReadable: 'every day at 6am' },
    EVERY_DAY_AT_7AM: { expression: '0 07 * * *', humanReadable: 'every day at 7am' },
    EVERY_DAY_AT_8AM: { expression: '0 08 * * *', humanReadable: 'every day at 8am' },
    EVERY_DAY_AT_9AM: { expression: '0 09 * * *', humanReadable: 'every day at 9am' },
    EVERY_DAY_AT_10AM: { expression: '0 10 * * *', humanReadable: 'every day at 10am' },
    EVERY_DAY_AT_11AM: { expression: '0 11 * * *', humanReadable: 'every day at 11am' },
    EVERY_DAY_AT_NOON: { expression: '0 12 * * *', humanReadable: 'every day at noon' },
    EVERY_DAY_AT_1PM: { expression: '0 13 * * *', humanReadable: 'every day at 1pm' },
    EVERY_DAY_AT_2PM: { expression: '0 14 * * *', humanReadable: 'every day at 2pm' },
    EVERY_DAY_AT_3PM: { expression: '0 15 * * *', humanReadable: 'every day at 3pm' },
    EVERY_DAY_AT_4PM: { expression: '0 16 * * *', humanReadable: 'every day at 4pm' },
    EVERY_DAY_AT_5PM: { expression: '0 17 * * *', humanReadable: 'every day at 5pm' },
    EVERY_DAY_AT_6PM: { expression: '0 18 * * *', humanReadable: 'every day at 6pm' },
    EVERY_DAY_AT_7PM: { expression: '0 19 * * *', humanReadable: 'every day at 7pm' },
    EVERY_DAY_AT_8PM: { expression: '0 20 * * *', humanReadable: 'every day at 8pm' },
    EVERY_DAY_AT_9PM: { expression: '0 21 * * *', humanReadable: 'every day at 9pm' },
    EVERY_DAY_AT_10PM: { expression: '0 22 * * *', humanReadable: 'every day at 10pm' },
    EVERY_DAY_AT_11PM: { expression: '0 23 * * *', humanReadable: 'every day at 11pm' },
    EVERY_DAY_AT_MIDNIGHT: { expression: '0 0 * * *', humanReadable: 'every day at midnight' },
    EVERY_WEEK: { expression: '0 0 * * 0', humanReadable: 'every week on Sunday' },
    EVERY_WEEKDAY: { expression: '0 0 * * 1-5', humanReadable: 'every weekday' },
    EVERY_WEEKEND: { expression: '0 0 * * 6,0', humanReadable: 'every weekend' },
    EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT: {
        expression: '0 0 1 * *',
        humanReadable: 'every 1st day of month at midnight',
    },
    EVERY_1ST_DAY_OF_MONTH_AT_NOON: {
        expression: '0 12 1 * *',
        humanReadable: 'every 1st day of month at noon',
    },
    EVERY_2ND_HOUR: { expression: '0 */2 * * *', humanReadable: 'every 2nd hour' },
    EVERY_QUARTER: { expression: '0 0 1 */3 *', humanReadable: 'every quarter' },
    EVERY_6_MONTHS: { expression: '0 0 1 */6 *', humanReadable: 'every 6 months' },
    EVERY_YEAR: { expression: '0 0 1 1 *', humanReadable: 'every year' },
    EVERY_30_MINUTES_BETWEEN_9AM_AND_5PM: {
        expression: '0 */30 9-17 * * *',
        humanReadable: 'every 30 minutes between 9am and 5pm',
    },
    EVERY_HOUR_BETWEEN_9AM_AND_6PM: {
        expression: '0 9-18 * * *',
        humanReadable: 'every hour between 9am and 6pm',
    },
    EVERY_HOUR_BETWEEN_9AM_AND_5PM: {
        expression: '0 9-17 * * *',
        humanReadable: 'every hour between 9am and 5pm',
    },
};
