/**
 * Unit tests for src/cli/index.ts — strict mode gating and validation table building.
 *
 * FE gate tests use `computeStrictFails` from strict-gate.js with full BuildValidation objects.
 * Var2 gate tests use minimal stubs cast via `as unknown as BuildValidation`.
 */
import { describe, expect, it } from 'vitest';
import { computeStrictFails } from './strict-gate.js';
import { tipsForFe } from './build-tips.js';
import type { BuildValidation } from '../core/types.js';
import type { FeValidationReport } from '../validation/fe-validator.js';

// ---------------------------------------------------------------------------
// Helpers — FE side (full BuildValidation shape)
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
                totalSites: 0,
                internal: 0,
                external: 0,
                unresolvedClassification: 0,
            },
            informational: { externalCalls: [] },
            sites: [],
            groundTruth: [],
            missed: [],
            extra: [],
        },
        imports: {
            summary: {
                groundTruthStatic: 0,
                recallStatic: 1,
                minPerFileRecall: 1,
                totalStatic: 0,
                filesWithImports: 0,
                filesUnderRecall: [],
            },
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
    } as unknown as BuildValidation;
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

    it('fails with zero-GT guard when all GT counts are 0 and fe is enabled', () => {
        // P1: fe zero-GT guard — fails loudly so operators know to set domains.fe=false
        const v = makeValidation({ feGtComponents: 0, feGtRoutes: 0, feGtHooks: 0 });
        const fails = computeStrictFails(v, ENABLED_FE_ONLY);
        expect(fails.some((f) => f.includes('fe') && f.includes('zero ground-truth'))).toBe(true);
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

// ---------------------------------------------------------------------------
// Helpers — Var2 side (minimal stubs)
// ---------------------------------------------------------------------------

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
        fe: {
            summary: {
                recallComponents: 1, recallRoutes: 1, recallHooks: 1,
                totalComponents: 0, totalRoutes: 0, totalHooks: 0,
                groundTruthComponents: 1, groundTruthRoutes: 1, groundTruthHooks: 1,
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
