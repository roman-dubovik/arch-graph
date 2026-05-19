import {
    Decorator,
    Node,
    ObjectLiteralExpression,
    Project,
    SyntaxKind,
    StringLiteral,
    PropertyAssignment,
} from 'ts-morph';

import type { ArchGraphConfig } from '../../core/config.js';
import type { CronScheduleSite } from '../../core/types.js';
import { isExcludedSourceFile } from '../shared.js';
import { CRON_EXPRESSION_MAP } from './constants.js';
import {
    buildSchedulerRegistryIndex,
    dynamicSiteToCronScheduleSite,
    type FilteredByReceiverSite,
} from './scheduler-registry-index.js';

export type { FilteredByReceiverSite };

/** A site whose expression argument could not be statically resolved. */
export interface UnresolvedCronSite {
    owner: string;
    file: string;
    line: number;
    /** Raw text of the unresolvable argument (truncated to 80 chars). */
    raw: string;
    /** Decorator/context name for distinguishing cases (e.g. '@Interval (v1 name-only)'). */
    decoratorName?: string;
}

/** A site whose options argument is a non-literal (variable/spread) — data-loss warning. */
export interface UnresolvedOptionsSite {
    owner: string;
    file: string;
    line: number;
    optionsText: string;
}

export interface ExtractCronScheduleResult {
    sites: CronScheduleSite[];
    diagnostics: {
        /** Sites dropped because the cron expression argument could not be resolved. */
        unresolved: UnresolvedCronSite[];
        /** Sites where the options arg is non-literal (name not extractable, but site emitted). */
        unresolvedOptions: UnresolvedOptionsSite[];
        /** Dynamic call sites filtered out because receiver name did not match scheduler pattern. */
        filteredByReceiver: FilteredByReceiverSite[];
    };
}

/**
 * Cron-schedule extractor.
 *
 * Pass 1 (decorator pass): Walk all classes, find methods bearing
 *   `@Cron(expression, options?)`, `@Interval(ms, name?)`, `@Timeout(ms, name?)`
 *   from `@nestjs/schedule`. Resolve the first argument:
 *     - string literal → raw + resolved = same
 *     - CronExpression.X → look up CRON_EXPRESSION_MAP
 *     - number literal  → stored as string (for Interval/Timeout)
 *
 * Pass 2 (dynamic pass): Find `SchedulerRegistry.add{CronJob,Interval,Timeout}()`
 *   call sites. Owner = file-based resolution (no class-method coupling needed).
 *
 * Not in scope (Task 3c): BullMQ.repeat cross-enrichment.
 */
export async function extractCronSchedule(
    _cfg: ArchGraphConfig,
    project: Project,
): Promise<ExtractCronScheduleResult> {
    const sites: CronScheduleSite[] = [];
    const unresolved: UnresolvedCronSite[] = [];
    const unresolvedOptions: UnresolvedOptionsSite[] = [];

    // Pass 1 — decorator-based registrations
    for (const sf of project.getSourceFiles()) {
        if (isExcludedSourceFile(sf)) continue;
        const text = sf.getFullText();
        const hasCron = text.includes('@Cron');
        const hasInterval = text.includes('@Interval');
        const hasTimeout = text.includes('@Timeout');
        if (!hasCron && !hasInterval && !hasTimeout) continue;

        for (const cls of sf.getClasses()) {
            const className = cls.getName() ?? '<anonymous>';

            for (const method of cls.getMethods()) {
                const methodName = method.getName();
                const owner = `${className}.${methodName}`;

                for (const dec of method.getDecorators()) {
                    const decName = dec.getName();
                    if (decName === 'Cron') {
                        const site = buildCronSite(owner, dec, sf.getFilePath(), unresolved, unresolvedOptions);
                        if (site) sites.push(site);
                    } else if (decName === 'Interval') {
                        const site = buildIntervalTimeoutSite(owner, dec, sf.getFilePath(), 'interval', unresolved);
                        if (site) sites.push(site);
                    } else if (decName === 'Timeout') {
                        const site = buildIntervalTimeoutSite(owner, dec, sf.getFilePath(), 'timeout', unresolved);
                        if (site) sites.push(site);
                    }
                }
            }
        }
    }

    // Pass 2 — dynamic SchedulerRegistry sites
    const { sites: dynamicSites, filteredByReceiver } = buildSchedulerRegistryIndex(project);
    for (const ds of dynamicSites) {
        const site = dynamicSiteToCronScheduleSite(ds, `dynamic:${ds.name ?? 'unnamed'}`);
        if (site !== null) {
            sites.push(site);
        } else {
            unresolved.push({
                owner: `dynamic:${ds.name ?? 'unnamed'}`,
                file: ds.location.file,
                line: ds.location.line,
                raw: ds.rawExpression,
            });
        }
    }

    return { sites, diagnostics: { unresolved, unresolvedOptions, filteredByReceiver } };
}

// ---------------------------------------------------------------------------
// @Cron site builder
// ---------------------------------------------------------------------------

function buildCronSite(
    owner: string,
    dec: Decorator,
    filePath: string,
    unresolvedOut: UnresolvedCronSite[],
    unresolvedOptionsOut: UnresolvedOptionsSite[],
): CronScheduleSite | null {
    const args = dec.getArguments();
    if (args.length === 0) return null;

    const firstArg = args[0]!;
    const sf = dec.getSourceFile();
    const pos = sf.getLineAndColumnAtPos(dec.getStart());
    const location = { file: filePath, line: pos.line, column: pos.column };

    const resolved = resolveCronArg(firstArg);

    // Drop the site if expression is unresolvable — push to diagnostics instead
    if (resolved === null) {
        unresolvedOut.push({
            owner,
            file: filePath,
            line: pos.line,
            raw: firstArg.getText().slice(0, 80),
            decoratorName: '@Cron',
        });
        return null;
    }

    // Options object (second arg) — extract `name` if present
    let name: string | undefined;
    if (args.length >= 2) {
        const optionsNode = args[1]!;
        if (optionsNode.getKind() === SyntaxKind.ObjectLiteralExpression) {
            const nameProp = findProp(optionsNode as ObjectLiteralExpression, 'name');
            const init = nameProp?.getInitializer();
            if (init) {
                const k = init.getKind();
                if (k === SyntaxKind.StringLiteral || k === SyntaxKind.NoSubstitutionTemplateLiteral) {
                    name = (init as StringLiteral).getLiteralText();
                }
            }
        } else {
            // Options arg is a variable/spread — emit diagnostic note, but still emit the site
            unresolvedOptionsOut.push({
                owner,
                file: filePath,
                line: pos.line,
                optionsText: optionsNode.getText().slice(0, 80),
            });
        }
    }

    return {
        owner,
        name,
        expression: resolved.raw,
        resolvedExpression: resolved.resolved,
        humanReadable: resolved.humanReadable,
        category: 'cron',
        location,
    };
}

// ---------------------------------------------------------------------------
// @Interval / @Timeout site builder
// ---------------------------------------------------------------------------

function buildIntervalTimeoutSite(
    owner: string,
    dec: Decorator,
    filePath: string,
    category: 'interval' | 'timeout',
    unresolvedOut: UnresolvedCronSite[],
): CronScheduleSite | null {
    const args = dec.getArguments();
    if (args.length === 0) return null;

    const sf = dec.getSourceFile();
    const pos = sf.getLineAndColumnAtPos(dec.getStart());
    const location = { file: filePath, line: pos.line, column: pos.column };
    const decoratorName = category === 'interval' ? '@Interval' : '@Timeout';

    // First arg can be: number literal (ms) OR string (name for older nestjs/schedule API).
    // Per NestJS docs: @Interval(name?, milliseconds). In v3+ it's just (name, ms) or (ms).
    let expression: string | null = null;
    let name: string | undefined;

    if (args.length === 1) {
        const arg = args[0]!;
        const k = arg.getKind();
        if (k === SyntaxKind.NumericLiteral) {
            expression = arg.getText();
        } else if (k === SyntaxKind.StringLiteral || k === SyntaxKind.NoSubstitutionTemplateLiteral) {
            // Name-only call (v1 API) — drop, but record in diagnostics
            unresolvedOut.push({
                owner,
                file: filePath,
                line: pos.line,
                raw: arg.getText().slice(0, 80),
                decoratorName: `${decoratorName} (v1 name-only)`,
            });
            return null;
        } else {
            // Non-literal (variable, call expression, etc.) — push to diagnostics
            unresolvedOut.push({
                owner,
                file: filePath,
                line: pos.line,
                raw: arg.getText().slice(0, 80),
                decoratorName,
            });
        }
    } else if (args.length >= 2) {
        // @Interval(name, ms) or @Timeout(name, ms)
        const maybeNameArg = args[0]!;
        const maybeMs = args[1]!;
        if (
            (maybeNameArg.getKind() === SyntaxKind.StringLiteral ||
                maybeNameArg.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) &&
            maybeMs.getKind() === SyntaxKind.NumericLiteral
        ) {
            name = (maybeNameArg as StringLiteral).getLiteralText();
            expression = maybeMs.getText();
        } else if (maybeMs.getKind() === SyntaxKind.NumericLiteral) {
            expression = maybeMs.getText();
        } else {
            // Other non-literal patterns — push to diagnostics
            unresolvedOut.push({
                owner,
                file: filePath,
                line: pos.line,
                raw: args.map((a) => a.getText()).join(', ').slice(0, 80),
                decoratorName,
            });
        }
    }

    // Drop the site when expression is not resolvable
    if (expression === null) return null;

    return {
        owner,
        name,
        expression,
        resolvedExpression: expression,
        humanReadable: undefined,
        category,
        location,
    };
}

// ---------------------------------------------------------------------------
// Argument resolution
// ---------------------------------------------------------------------------

interface ResolvedCronArg {
    raw: string;
    resolved: string | undefined;
    humanReadable: string | undefined;
}

/**
 * Resolve the first argument of a `@Cron(...)` decorator.
 *
 * Returns `null` when the argument is a non-static node kind (CallExpression,
 * TemplateExpression, non-mapped Identifier, etc.) — callers should drop the
 * site and record it as unresolved diagnostics rather than emitting a node
 * with a raw/opaque expression.
 *
 * Returns a `ResolvedCronArg` for:
 *   - string literals ('0 0 * * *')
 *   - `CronExpression.X` PropertyAccessExpression (looked up in CRON_EXPRESSION_MAP)
 *   - bare Identifiers that match CRON_EXPRESSION_MAP keys
 */
function resolveCronArg(node: Node): ResolvedCronArg | null {
    const k = node.getKind();

    // String literal: '0 * * * *'
    if (k === SyntaxKind.StringLiteral || k === SyntaxKind.NoSubstitutionTemplateLiteral) {
        const value = (node as StringLiteral).getLiteralText();
        return { raw: value, resolved: value, humanReadable: undefined };
    }

    // PropertyAccessExpression: CronExpression.EVERY_HOUR
    if (k === SyntaxKind.PropertyAccessExpression) {
        const text = node.getText();
        const dotIdx = text.lastIndexOf('.');
        if (dotIdx !== -1) {
            const memberName = text.slice(dotIdx + 1);
            const mapped = CRON_EXPRESSION_MAP[memberName];
            if (mapped) {
                return {
                    raw: text,
                    resolved: mapped.expression,
                    humanReadable: mapped.humanReadable,
                };
            }
        }
        // PropertyAccessExpression not in map (e.g. some other enum reference) — unresolvable
        return null;
    }

    // Identifier (bare name without enum prefix): rare but possible
    if (k === SyntaxKind.Identifier) {
        const text = node.getText();
        const mapped = CRON_EXPRESSION_MAP[text];
        if (mapped) {
            return {
                raw: text,
                resolved: mapped.expression,
                humanReadable: mapped.humanReadable,
            };
        }
        // Unmapped identifier — unresolvable
        return null;
    }

    // CallExpression, TemplateExpression, BinaryExpression, etc. — all unresolvable
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
