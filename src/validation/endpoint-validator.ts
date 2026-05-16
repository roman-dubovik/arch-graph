/**
 * Endpoint validator — placeholder for Variant 2, Task B10.
 *
 * Ground-truth regex detection of `@(Get|Post|...)` decorators.
 * Target recall: ≥ 95% (canonical NestJS).
 *
 * Implementation: B10 (real validator with regex detection).
 */

export interface EndpointValidationResult {
    /** Number of detected @(Get|Post|...) decorators via ground-truth regex. */
    groundTruthCount: number;
    /** Recall: groundTruth > 0 ? extracted / groundTruth : null. */
    recall: number | null;
}

/**
 * Validate endpoint extraction via ground-truth regex detection.
 *
 * This is a placeholder stub returning zero results. The full implementation
 * will be added in B10.
 */
export function validateEndpoints(
    _sourceFiles: string[],
    _extractedCount: number,
): EndpointValidationResult {
    return {
        groundTruthCount: 0,
        recall: null,
    };
}
