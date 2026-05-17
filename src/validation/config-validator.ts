/**
 * Config-field validator — Variant 2, Task B10.
 *
 * Ground-truth regex detection of:
 *   - configService.get(...)
 *   - configService.getOrThrow(...)
 *   - process.env.KEY
 *
 * Target recall: ≥ 90% (callsite detection has known false-negatives on dynamic key construction).
 */

import type { ArchGraphConfig } from '../core/config.js';
import { buildLineStarts, offsetToLineCol } from './line-index.js';
import { iterateSourceFiles } from './scan.js';
import { stripComments } from './strip-comments.js';

export interface ConfigGroundTruthEntry {
    file: string;
    line: number;
    matchedText: string;
    kind: 'configService' | 'process.env';
}

export interface ConfigValidationResult {
    /** Ground-truth entries found by regex. */
    groundTruth: ConfigGroundTruthEntry[];
    /** Number of detected callsites via ground-truth regex. */
    groundTruthCount: number;
    /** Recall: groundTruth > 0 ? extracted / groundTruth : null. */
    recall: number | null;
    /** Recall floor 90%. True if recall >= 0.90 or no ground truth detected. */
    meetsFloor: boolean;
}

/**
 * Regex for configService.get(...) and configService.getOrThrow(...).
 * Matches the method call with an opening paren/whitespace following.
 */
const CONFIG_SERVICE_RE = /\bconfigService\.(get|getOrThrow)\s*(?:<[^>]*>)?\s*\(/g;

/**
 * Regex for process.env.IDENTIFIER member accesses.
 * Captures the env var name in group 1.
 */
const PROCESS_ENV_RE = /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Enumerate ground-truth config callsites by regex.
 */
export async function enumerateConfigGroundTruth(
    cfg: ArchGraphConfig,
): Promise<ConfigGroundTruthEntry[]> {
    const out: ConfigGroundTruthEntry[] = [];

    for await (const { file, content } of iterateSourceFiles(cfg, 'config GT')) {
        if (!content.includes('configService') && !content.includes('process.env')) continue;

        const stripped = stripComments(content);
        const lineStarts = buildLineStarts(stripped);

        for (const m of stripped.matchAll(CONFIG_SERVICE_RE)) {
            const offset = m.index!;
            const { line } = offsetToLineCol(offset, lineStarts);
            out.push({
                file,
                line,
                matchedText: m[0].trim(),
                kind: 'configService',
            });
        }

        for (const m of stripped.matchAll(PROCESS_ENV_RE)) {
            const offset = m.index!;
            const { line } = offsetToLineCol(offset, lineStarts);
            out.push({
                file,
                line,
                matchedText: m[0].trim(),
                kind: 'process.env',
            });
        }
    }

    return out;
}

/**
 * Validate config extraction: compare extracted count to ground-truth count.
 * Recall floor is 90%.
 */
export async function validateConfig(
    cfg: ArchGraphConfig,
    extractedCount: number,
): Promise<ConfigValidationResult> {
    const groundTruth = await enumerateConfigGroundTruth(cfg);
    const groundTruthCount = groundTruth.length;

    const recall =
        groundTruthCount > 0 ? Math.min(extractedCount / groundTruthCount, 1) : null;

    const meetsFloor = recall === null || recall >= 0.90;

    return {
        groundTruth,
        groundTruthCount,
        recall,
        meetsFloor,
    };
}
