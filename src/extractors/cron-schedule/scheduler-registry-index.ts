import {
    CallExpression,
    Node,
    Project,
    SourceFile,
    SyntaxKind,
    StringLiteral,
} from 'ts-morph';

import type { CronScheduleSite } from '../../core/types.js';
import { CRON_EXPRESSION_MAP, LIKELY_SCHEDULER_RECEIVER_RE } from './constants.js';

/**
 * Pre-pass: find dynamic `SchedulerRegistry` registrations:
 *   - `this.schedulerRegistry.addCronJob(name, new CronJob('expression', cb))`
 *   - `schedulerRegistry.addInterval(name, ms)`
 *   - `schedulerRegistry.addTimeout(name, ms)`
 *   - `registry.addCronJob(name, job)` (any variable name ending in registry or matching pattern)
 *
 * Resolution strategy:
 *   - Name arg (first): string literal → stored; else → 'dynamic'
 *   - Expression arg (second): for addCronJob, looks for `new CronJob('<expr>', ...)`;
 *     for addInterval/addTimeout, looks for numeric literal.
 *
 * Owner resolution is performed in the main extractor via file path.
 */

export interface DynamicSchedulerSite {
    method: 'addCronJob' | 'addInterval' | 'addTimeout';
    /** Resolved job/interval/timeout name (first arg), or null if dynamic. */
    name: string | null;
    /** Resolved cron expression / interval ms as string, or null if not parseable. */
    expression: string | null;
    resolvedExpression: string | null;
    humanReadable: string | undefined;
    location: { file: string; line: number; column: number };
    /** Raw expression text for diagnostics when not resolvable. */
    rawExpression: string;
}

/** A call site filtered out because the receiver variable name did not match
 * LIKELY_SCHEDULER_RECEIVER_RE — surfaced as diagnostic for operator debugging. */
export interface FilteredByReceiverSite {
    file: string;
    line: number;
    receiverText: string;
    method: string;
}

export interface SchedulerRegistryIndexResult {
    sites: DynamicSchedulerSite[];
    filteredByReceiver: FilteredByReceiverSite[];
}

export function buildSchedulerRegistryIndex(project: Project): SchedulerRegistryIndexResult {
    const sites: DynamicSchedulerSite[] = [];
    const filteredByReceiver: FilteredByReceiverSite[] = [];

    for (const sf of project.getSourceFiles()) {
        if (isExcludedForIndex(sf)) continue;
        const text = sf.getFullText();
        if (
            !text.includes('addCronJob') &&
            !text.includes('addInterval') &&
            !text.includes('addTimeout')
        ) continue;
        collectDynamicSites(sf, sites, filteredByReceiver);
    }

    return { sites, filteredByReceiver };
}

function collectDynamicSites(
    sf: SourceFile,
    out: DynamicSchedulerSite[],
    filteredByReceiverOut: FilteredByReceiverSite[],
): void {
    sf.forEachDescendant((node) => {
        if (node.getKind() !== SyntaxKind.CallExpression) return;
        const call = node as CallExpression;
        const expr = call.getExpression();
        if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return;

        const propAccess = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
        const methodName = propAccess.getName();
        if (
            methodName !== 'addCronJob' &&
            methodName !== 'addInterval' &&
            methodName !== 'addTimeout'
        ) return;

        // Receiver-name guard: only emit if the receiver name suggests a scheduler/registry.
        // This prevents phantom nodes for unrelated methods named addInterval/addTimeout
        // (e.g. EventEmitter.addInterval or custom builders).
        // Uses the shared LIKELY_SCHEDULER_RECEIVER_RE for symmetric coverage with the validator.
        const receiverText = propAccess.getExpression().getText();
        if (!LIKELY_SCHEDULER_RECEIVER_RE.test(receiverText)) {
            // Record filtered site for diagnostics
            const pos = sf.getLineAndColumnAtPos(call.getStart());
            filteredByReceiverOut.push({
                file: sf.getFilePath(),
                line: pos.line,
                receiverText,
                method: methodName,
            });
            return;
        }

        const args = call.getArguments();
        if (args.length < 1) return;

        const pos = sf.getLineAndColumnAtPos(call.getStart());
        const location = { file: sf.getFilePath(), line: pos.line, column: pos.column };

        // Resolve name (first arg — string literal preferred)
        const nameArg = args[0]!;
        const name = resolveStringArg(nameArg);

        let expression: string | null = null;
        let resolvedExpression: string | null = null;
        let humanReadable: string | undefined;
        let rawExpression = args[1]?.getText().slice(0, 80) ?? '';

        if (methodName === 'addCronJob') {
            // Second arg: new CronJob('<expression>', callback) — extract first arg of CronJob
            const cronJobExpression = extractCronJobExpression(args[1]);
            if (cronJobExpression !== null) {
                expression = cronJobExpression;
                resolvedExpression = cronJobExpression;
            }
        } else {
            // addInterval / addTimeout: second arg is ms (numeric literal)
            const msArg = args[1];
            if (msArg && msArg.getKind() === SyntaxKind.NumericLiteral) {
                expression = msArg.getText();
                resolvedExpression = msArg.getText();
                rawExpression = msArg.getText();
            }
        }

        out.push({
            method: methodName as 'addCronJob' | 'addInterval' | 'addTimeout',
            name,
            expression,
            resolvedExpression,
            humanReadable,
            location,
            rawExpression,
        });
    });
}

/**
 * Try to extract the first string argument of `new CronJob('...', callback)`.
 * Returns null if the pattern doesn't match or isn't a string literal.
 */
function extractCronJobExpression(node: Node | undefined): string | null {
    if (!node) return null;
    // Walk through `new CronJob(...)` call
    if (node.getKind() === SyntaxKind.NewExpression) {
        const newExpr = node.asKindOrThrow(SyntaxKind.NewExpression);
        const args = newExpr.getArguments();
        if (args.length >= 1) {
            const firstArg = args[0]!;
            return resolveStringArg(firstArg);
        }
    }
    // Also handle PropertyAccessExpression.EVERY_HOUR enum references passed directly
    if (node.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propText = node.getText();
        const dotIdx = propText.lastIndexOf('.');
        if (dotIdx !== -1) {
            const memberName = propText.slice(dotIdx + 1);
            const mapped = CRON_EXPRESSION_MAP[memberName];
            if (mapped) return mapped.expression;
        }
    }
    return null;
}

function resolveStringArg(node: Node): string | null {
    const k = node.getKind();
    if (k === SyntaxKind.StringLiteral || k === SyntaxKind.NoSubstitutionTemplateLiteral) {
        return (node as StringLiteral).getLiteralText();
    }
    return null;
}

const EXCLUDED_SUBSTRINGS = ['/node_modules/', '/dist/', '/.claude/', '/.worktrees/'];

function isExcludedForIndex(sf: SourceFile): boolean {
    const p = sf.getFilePath();
    if (EXCLUDED_SUBSTRINGS.some((s) => p.includes(s))) return true;
    return p.endsWith('.d.ts') || p.endsWith('.spec.ts') || p.endsWith('.test.ts');
}

/**
 * Convert a DynamicSchedulerSite to a partial CronScheduleSite (caller fills owner).
 *
 * Returns null when the expression is not resolvable AND rawExpression is empty or
 * non-meaningful (e.g. pre-constructed `addCronJob(name, existingJob)` pattern where
 * `extractCronJobExpression` returned null and the arg is not `new CronJob`).
 * Callers should record null returns as unresolved diagnostics.
 */
export function dynamicSiteToCronScheduleSite(
    ds: DynamicSchedulerSite,
    owner: string,
): CronScheduleSite | null {
    // Skip: expression is null — argument was not statically resolvable.
    // For addCronJob: second arg was not `new CronJob(...)` (pre-constructed job variable).
    // For addInterval/addTimeout: second arg was not a numeric literal.
    // In all cases we cannot determine the expression — drop and let caller record as unresolved.
    if (ds.expression === null) {
        return null;
    }

    const category: CronScheduleSite['category'] =
        ds.method === 'addCronJob'
            ? 'dynamic'
            : ds.method === 'addInterval'
              ? 'interval'
              : 'timeout';

    return {
        owner,
        name: ds.name ?? undefined,
        expression: ds.expression ?? ds.rawExpression,
        resolvedExpression: ds.resolvedExpression ?? undefined,
        humanReadable: ds.humanReadable,
        category,
        location: ds.location,
    };
}
