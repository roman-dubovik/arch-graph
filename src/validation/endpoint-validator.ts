/**
 * Endpoint validator — Variant 2, Task B10.
 *
 * Ground-truth regex detection of `@(Get|Post|Patch|Delete|Put|All|Options|Head|Sse)`
 * decorators in source files.
 * Target recall: ≥ 95% (canonical NestJS patterns).
 */

import type { ArchGraphConfig } from '../core/config.js';
import { buildLineStarts, offsetToLineCol } from './line-index.js';
import { iterateSourceFiles } from './scan.js';
import { stripComments } from './strip-comments.js';

export interface EndpointGroundTruthEntry {
    file: string;
    line: number;
    matchedText: string;
    method: string;
}

export interface EndpointValidationResult {
    /** Ground-truth entries found by regex. */
    groundTruth: EndpointGroundTruthEntry[];
    /** Number of detected @(Get|Post|...) decorators via ground-truth regex. */
    groundTruthCount: number;
    /** Recall: groundTruth > 0 ? extracted / groundTruth : null. */
    recall: number | null;
    /** Recall floor 95%. True if recall >= 0.95 or no ground truth detected. */
    meetsFloor: boolean;
}

/**
 * Regex matching all NestJS HTTP method decorators.
 * Captures the method name in group 1.
 * Uses word boundary \b to avoid matching inside larger identifiers.
 */
const ENDPOINT_RE = /@(Get|Post|Put|Patch|Delete|All|Options|Head|Sse)\s*[(\s]/g;

/**
 * Enumerate ground-truth endpoint decorator occurrences by regex.
 */
export async function enumerateEndpointGroundTruth(
    cfg: ArchGraphConfig,
): Promise<EndpointGroundTruthEntry[]> {
    const out: EndpointGroundTruthEntry[] = [];

    for await (const { file, content } of iterateSourceFiles(cfg, 'endpoint GT')) {
        // Quick pre-check
        if (
            !content.includes('@Get') &&
            !content.includes('@Post') &&
            !content.includes('@Put') &&
            !content.includes('@Patch') &&
            !content.includes('@Delete') &&
            !content.includes('@All') &&
            !content.includes('@Options') &&
            !content.includes('@Head') &&
            !content.includes('@Sse')
        ) continue;

        const stripped = stripComments(content);
        const lineStarts = buildLineStarts(stripped);

        for (const m of stripped.matchAll(ENDPOINT_RE)) {
            const offset = m.index!;
            const { line } = offsetToLineCol(offset, lineStarts);
            out.push({
                file,
                line,
                matchedText: m[0].trim(),
                method: m[1]!.toUpperCase(),
            });
        }
    }

    return out;
}

/**
 * Validate endpoint extraction: compare extracted count to ground-truth count.
 * Recall floor is 95%.
 */
export async function validateEndpoints(
    cfg: ArchGraphConfig,
    extractedCount: number,
): Promise<EndpointValidationResult> {
    const groundTruth = await enumerateEndpointGroundTruth(cfg);
    const groundTruthCount = groundTruth.length;

    const recall =
        groundTruthCount > 0 ? Math.min(extractedCount / groundTruthCount, 1) : null;

    const meetsFloor = recall === null || recall >= 0.95;

    return {
        groundTruth,
        groundTruthCount,
        recall,
        meetsFloor,
    };
}
