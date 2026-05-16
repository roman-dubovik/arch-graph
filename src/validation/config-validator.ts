/**
 * Config-field validator — placeholder for Variant 2, Task B10.
 *
 * Ground-truth regex detection of `configService.get(...)` and `process.env.*` callsites.
 * Target recall: ≥ 90% (callsite detection has known false-negatives on dynamic key construction).
 *
 * Implementation: B10 (real validator with regex detection).
 */

export interface ConfigValidationResult {
    /** Number of detected configService.get/getOrThrow + process.env callsites via ground-truth regex. */
    groundTruthCount: number;
    /** Recall: groundTruth > 0 ? extracted / groundTruth : null. */
    recall: number | null;
}

/**
 * Validate config-field extraction via ground-truth regex detection.
 *
 * This is a placeholder stub returning zero results. The full implementation
 * will be added in B10.
 */
export function validateConfig(
    _sourceFiles: string[],
    _extractedCount: number,
): ConfigValidationResult {
    return {
        groundTruthCount: 0,
        recall: null,
    };
}
