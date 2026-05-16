/**
 * Unit tests for src/cli/index.ts — strict-gate logic.
 *
 * `computeStrictFails` is tested in isolation by constructing minimal
 * `BuildValidation` objects cast via `as unknown as BuildValidation`.
 * Only fields consumed by the branches under test are populated.
 */

import { describe, expect, it } from 'vitest';
import type { BuildValidation } from '../core/types.js';
import { computeStrictFails } from './index.js';

/**
 * Minimal stub for summary fields read by `computeStrictFails` when no
 * domain is enabled. All recalls = 1, all ground-truth counts = 1 so the
 * strict gate never fires on stubs.
 */
function stubBase() {
    return {
        projectId: 'test',
        timestamp: new Date().toISOString(),
        nats: {
            summary: {
                recallHandlers: 1, recallSenders: 1, resolveRate: 1,
                classificationAccuracy: 1, totalExtracted: 0, totalGroundTruth: 0,
                groundTruthHandlers: 1, groundTruthSenders: 1, bySubjectKind: {},
            },
        },
        typeorm: {
            summary: {
                recallInjections: 1, recallEntities: 1, resolveRate: 1,
                totalInjections: 0, totalEntities: 0,
                groundTruthInjections: 1, groundTruthEntities: 1,
            },
        },
        bullmq: {
            summary: {
                recallProducers: 1, recallConsumers: 1, recallRegistrations: 1,
                resolveRate: 1, totalProducers: 0, totalConsumers: 0, totalRegistrations: 0,
                groundTruthProducers: 1, groundTruthConsumers: 1, groundTruthRegistrations: 1,
            },
        },
        di: {
            summary: {
                recallModules: 1, recallImportsFields: 1, recallProvidersFields: 1,
                recallExportsFields: 1, recallControllersFields: 1, resolveRate: 1,
                totalModules: 0, totalImports: 0, totalProviders: 0, totalExports: 0, totalControllers: 0,
                groundTruthModules: 1, groundTruthImportsFields: 1, groundTruthProvidersFields: 1,
                groundTruthExportsFields: 1, groundTruthControllersFields: 1,
            },
        },
        http: {
            summary: {
                recallCalls: 1, resolveRate: 1, totalSites: 0, groundTruthCalls: 1,
                internal: 0, external: 0, unresolvedClassification: 0,
            },
        },
        imports: {
            summary: {
                recallStatic: 1, minPerFileRecall: 1, totalStatic: 0,
                groundTruthStatic: 1, filesWithImports: 0, filesUnderRecall: [],
            },
        },
    };
}

describe('computeStrictFails — endpoint strict gate', () => {
    it('returns empty fails when all domains disabled and no Var2 domains provided', () => {
        const validation = stubBase() as unknown as BuildValidation;
        const fails = computeStrictFails(validation, {});
        expect(fails).toHaveLength(0);
    });

    it('returns a fail entry when endpoint.meetsFloor is false', () => {
        const validation = {
            ...stubBase(),
            endpoint: {
                groundTruth: [],
                groundTruthCount: 10,
                recall: 0.5,
                meetsFloor: false,
            },
        } as unknown as BuildValidation;

        const fails = computeStrictFails(validation, { endpoint: true });
        expect(fails.length).toBeGreaterThan(0);
        const failMsg = fails.find((f) => f.includes('endpoint recall'));
        expect(failMsg).toBeDefined();
        // recall = 0.5 → "50.0%"
        expect(failMsg).toContain('50.0%');
    });

    it('returns no endpoint recall fail when meetsFloor is true', () => {
        const validation = {
            ...stubBase(),
            endpoint: {
                groundTruth: [],
                groundTruthCount: 10,
                recall: 0.97,
                meetsFloor: true,
            },
        } as unknown as BuildValidation;

        const fails = computeStrictFails(validation, { endpoint: true });
        const endpointFails = fails.filter((f) => f.includes('endpoint recall'));
        expect(endpointFails).toHaveLength(0);
    });

    it('reports zero ground-truth endpoint fail when groundTruthCount is 0', () => {
        const validation = {
            ...stubBase(),
            endpoint: {
                groundTruth: [],
                groundTruthCount: 0,
                recall: null,
                meetsFloor: true,
            },
        } as unknown as BuildValidation;

        const fails = computeStrictFails(validation, { endpoint: true });
        const zeroGtFail = fails.find((f) => f.includes('zero ground-truth'));
        expect(zeroGtFail).toBeDefined();
        expect(zeroGtFail).toContain('endpoint');
    });
});
