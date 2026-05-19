import {
    CallExpression,
    Node,
    Project,
    SourceFile,
    SyntaxKind,
    StringLiteral,
} from 'ts-morph';

import type { CronScheduleSite } from '../../core/types.js';
import { CRON_EXPRESSION_MAP } from './constants.js';

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

export function buildSchedulerRegistryIndex(project: Project): DynamicSchedulerSite[] {
    const sites: DynamicSchedulerSite[] = [];

    for (const sf of project.getSourceFiles()) {
        if (isExcludedForIndex(sf)) continue;
        const text = sf.getFullText();
        if (
            !text.includes('addCronJob') &&
            !text.includes('addInterval') &&
            !text.includes('addTimeout')
        ) continue;
        collectDynamicSites(sf, sites);
    }

    return sites;
}

function collectDynamicSites(sf: SourceFile, out: DynamicSchedulerSite[]): void {
    sf.forEachDescendant((node) => {
        if (node.getKind() !== SyntaxKind.CallExpression) return;
        const call = node as CallExpression;
        const expr = call.getExpression();
        if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return;

        const methodName = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getName();
        if (
            methodName !== 'addCronJob' &&
            methodName !== 'addInterval' &&
            methodName !== 'addTimeout'
        ) return;

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

/** Convert a DynamicSchedulerSite to a partial CronScheduleSite (caller fills owner). */
export function dynamicSiteToCronScheduleSite(
    ds: DynamicSchedulerSite,
    owner: string,
): CronScheduleSite {
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
