/**
 * Unit tests for src/cli/index.ts — strict mode gating and validation table building.
 *
 * Tests computeStrictFails directly (exported) with full FeValidationReport shape.
 */
import { describe, expect, it } from 'vitest';
import { computeStrictFails } from './strict-gate.js';
import { tipsForFe } from './build-tips.js';
import type { BuildValidation } from '../core/types.js';
import type { FeValidationReport } from '../validation/fe-validator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidation(overrides: {
    feRecallComponents?: number;
    feRecallRoutes?: number;
    feRecallHooks?: number;
    feGtComponents?: number;
    feGtRoutes?: number;
    feGtHooks?: number;
}): BuildValidation {
    const {
        feRecallComponents = 1,
        feRecallRoutes = 1,
        feRecallHooks = 1,
        feGtComponents = 100,
        feGtRoutes = 10,
        feGtHooks = 20,
    } = overrides;

    return {
        projectId: 'test',
        timestamp: '2026-05-16T00:00:00Z',
        nats: {
            summary: {
                groundTruthHandlers: 0,
                groundTruthSenders: 0,
                recallHandlers: 1,
                recallSenders: 1,
                resolveRate: 1,
                classificationAccuracy: 1,
                totalExtracted: 0,
                totalGroundTruth: 0,
                bySubjectKind: {},
            },
            extracted: [],
            groundTruth: [],
            missed: [],
            extra: [],
            unresolvedSamples: [],
        },
        typeorm: {
            summary: {
                groundTruthInjections: 0,
                groundTruthEntities: 0,
                recallInjections: 1,
                recallEntities: 1,
                totalInjections: 0,
                totalEntities: 0,
                resolveRate: 1,
            },
            injections: [],
            entities: [],
            groundTruth: [],
            missedInjections: [],
            missedEntities: [],
            extraInjections: [],
        },
        bullmq: {
            summary: {
                groundTruthProducers: 0,
                groundTruthConsumers: 0,
                groundTruthRegistrations: 0,
                recallProducers: 1,
                recallConsumers: 1,
                recallRegistrations: 1,
                totalProducers: 0,
                totalConsumers: 0,
                totalRegistrations: 0,
                resolveRate: 1,
            },
            producers: [],
            consumers: [],
            registrations: [],
            groundTruth: [],
            missedProducers: [],
            missedConsumers: [],
            missedRegistrations: [],
        },
        di: {
            summary: {
                groundTruthModules: 0,
                groundTruthImportsFields: 0,
                groundTruthProvidersFields: 0,
                groundTruthExportsFields: 0,
                groundTruthControllersFields: 0,
                recallModules: 1,
                recallImportsFields: 1,
                recallProvidersFields: 1,
                recallExportsFields: 1,
                recallControllersFields: 1,
                totalImports: 0,
                totalProviders: 0,
                totalExports: 0,
                totalControllers: 0,
                resolveRate: 1,
            },
            modules: [],
            groundTruth: [],
            missed: [],
            unresolvedRefs: [],
        },
        http: {
            summary: {
                groundTruthCalls: 0,
                recallCalls: 1,
                resolveRate: 1,
                totalCalls: 0,
            },
            calls: [],
            groundTruth: [],
            missed: [],
            extra: [],
        },
        imports: {
            summary: {
                groundTruthStatic: 0,
                recallStatic: 1,
                minPerFileRecall: 1,
                totalExtracted: 0,
                totalGroundTruth: 0,
            },
            details: [],
            groundTruth: [],
            missed: [],
        },
        fe: {
            summary: {
                recallComponents: feRecallComponents,
                recallRoutes: feRecallRoutes,
                recallHooks: feRecallHooks,
                totalComponents: 0,
                totalRoutes: 0,
                totalHooks: 0,
                groundTruthComponents: feGtComponents,
                groundTruthRoutes: feGtRoutes,
                groundTruthHooks: feGtHooks,
            },
            groundTruth: [],
            missedComponents: [],
            missedRoutes: [],
            missedHooks: [],
        },
    };
}

const ENABLED_FE_ONLY = {
    nats: false,
    typeorm: false,
    bullmq: false,
    di: false,
    http: false,
    imports: false,
    fe: true,
};

const ALL_DISABLED = { ...ENABLED_FE_ONLY, fe: false };

// ---------------------------------------------------------------------------
// computeStrictFails — FE gate
// ---------------------------------------------------------------------------
describe('computeStrictFails — FE strict mode gating', () => {
    it('returns no fails when fe disabled', () => {
        const v = makeValidation({ feRecallComponents: 0.5 });
        const fails = computeStrictFails(v, ALL_DISABLED);
        expect(fails).toHaveLength(0);
    });

    it('returns no fails when all GT = 0 (zero-GT escape hatch)', () => {
        const v = makeValidation({ feGtComponents: 0, feGtRoutes: 0, feGtHooks: 0 });
        const fails = computeStrictFails(v, ENABLED_FE_ONLY);
        expect(fails).toHaveLength(0);
    });

    it('fails with descriptive message when component recall < 0.9', () => {
        const v = makeValidation({ feRecallComponents: 0.85, feGtComponents: 100 });
        const fails = computeStrictFails(v, ENABLED_FE_ONLY);
        expect(fails.length).toBeGreaterThan(0);
        expect(fails.some((f) => f.includes('fe') && f.includes('components') && f.includes('85.0%'))).toBe(true);
    });

    it('fails when route recall < 0.9', () => {
        const v = makeValidation({ feRecallRoutes: 0.7, feGtRoutes: 10 });
        const fails = computeStrictFails(v, ENABLED_FE_ONLY);
        expect(fails.some((f) => f.includes('routes'))).toBe(true);
    });

    it('fails when hook recall < 0.9', () => {
        const v = makeValidation({ feRecallHooks: 0.8, feGtHooks: 20 });
        const fails = computeStrictFails(v, ENABLED_FE_ONLY);
        expect(fails.some((f) => f.includes('hooks'))).toBe(true);
    });

    it('passes when all recalls are at or above 0.9', () => {
        const v = makeValidation({ feRecallComponents: 0.9, feRecallRoutes: 1.0, feRecallHooks: 0.95 });
        const fails = computeStrictFails(v, ENABLED_FE_ONLY);
        expect(fails).toHaveLength(0);
    });

    it('skips category when GT = 0 for that category only', () => {
        // Routes GT = 0 but recall is 0 — should NOT fail (zero-GT escape)
        const v = makeValidation({ feRecallRoutes: 0, feGtRoutes: 0, feGtComponents: 10, feGtHooks: 5 });
        const fails = computeStrictFails(v, ENABLED_FE_ONLY);
        // routes should not appear in fails
        expect(fails.some((f) => f.includes('routes'))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// tipsForFe
// ---------------------------------------------------------------------------
function makeFeReport(overrides: Partial<FeValidationReport['summary']>): FeValidationReport {
    return {
        summary: {
            recallComponents: 1,
            recallRoutes: 1,
            recallHooks: 1,
            totalComponents: 0,
            totalRoutes: 0,
            totalHooks: 0,
            groundTruthComponents: 100,
            groundTruthRoutes: 10,
            groundTruthHooks: 20,
            ...overrides,
        },
        groundTruth: [],
        missedComponents: [],
        missedRoutes: [],
        missedHooks: [],
    };
}

describe('tipsForFe', () => {
    it('returns tip when component recall is low', () => {
        const report = makeFeReport({ recallComponents: 0.8, groundTruthComponents: 100 });
        const tips = tipsForFe(report);
        expect(tips.some((t) => t.includes('component'))).toBe(true);
        expect(tips.some((t) => t.includes('appsGlob'))).toBe(true);
    });

    it('returns tip when route recall is low', () => {
        const report = makeFeReport({ recallRoutes: 0.6, groundTruthRoutes: 10 });
        const tips = tipsForFe(report);
        expect(tips.some((t) => t.includes('route'))).toBe(true);
    });

    it('returns tip when hook recall is low', () => {
        const report = makeFeReport({ recallHooks: 0.7, groundTruthHooks: 20 });
        const tips = tipsForFe(report);
        expect(tips.some((t) => t.includes('hook'))).toBe(true);
    });

    it('always includes the diagnose tip', () => {
        const report = makeFeReport({ recallComponents: 0.5, groundTruthComponents: 10 });
        const tips = tipsForFe(report);
        expect(tips.some((t) => t.includes('arch-graph diagnose'))).toBe(true);
    });

    it('skips component-specific tips when groundTruthComponents = 0', () => {
        const report = makeFeReport({ recallComponents: 0, groundTruthComponents: 0 });
        const tips = tipsForFe(report);
        // No tip about appsGlob (only fires when GT > 0 and recall < 0.9)
        expect(tips.some((t) => t.includes('appsGlob'))).toBe(false);
    });
});
