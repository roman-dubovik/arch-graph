import type { GroundTruthEntry, NatsCallSite, NatsValidationReport } from '../core/types.js';
import { indexBy, matchByLineKey } from './line-index.js';

/**
 * Matches ground-truth entries against extracted call sites.
 *
 * Key = `${file}:${line}` (extractor and grep disagree on column — extractor
 * points to `@` of decorator / start of CallExpression, grep points to the
 * regex match offset). Cardinality is preserved by consuming one extracted
 * candidate per GT entry of the same role — so two decorators on one line are
 * both required to be matched, not just one of them.
 */
export function buildReport(
    extracted: NatsCallSite[],
    groundTruth: GroundTruthEntry[],
): NatsValidationReport {
    const extractedKeyed = indexBy(extracted, locKey);

    const { consumed, missed } = matchByLineKey(
        groundTruth,
        extractedKeyed,
        (candidate, entry) => candidate.role === entry.role,
    );

    let handlersFound = 0;
    let sendersFound = 0;
    for (const c of consumed) {
        if (c.role === 'receiver') handlersFound++;
        else sendersFound++;
    }

    const extra = extracted.filter((e) => !consumed.has(e));

    const handlersGT = groundTruth.filter((g) => g.role === 'receiver').length;
    const sendersGT = groundTruth.filter((g) => g.role === 'sender').length;

    // resolveRate/classify exclude wrapper-internal sites (Pattern F): those are
    // inner `this.client.publish(<param>)` calls whose actual subject lives on the
    // outer Pass-2 site, not at the inner location. Counting them would punish a
    // codebase for being properly factored.
    const realSites = extracted.filter((e) => !e.wrapperInternal);
    const resolvedCount = realSites.filter(
        (e) => e.subject.kind === 'literal' || e.subject.kind === 'pattern',
    ).length;
    const classifiedCount = realSites.filter((e) => e.subject.kind !== 'unresolved').length;

    const bySubjectKind: Record<string, number> = {};
    for (const e of extracted) {
        bySubjectKind[e.subject.kind] = (bySubjectKind[e.subject.kind] ?? 0) + 1;
    }

    const unresolved = extracted.filter(
        (e) => e.subject.kind === 'unresolved' || e.subject.kind === 'dynamic',
    );

    return {
        summary: {
            recallHandlers: handlersGT > 0 ? handlersFound / handlersGT : 1,
            recallSenders: sendersGT > 0 ? sendersFound / sendersGT : 1,
            resolveRate: realSites.length > 0 ? resolvedCount / realSites.length : 0,
            classificationAccuracy: realSites.length > 0 ? classifiedCount / realSites.length : 0,
            totalExtracted: extracted.length,
            totalGroundTruth: groundTruth.length,
            groundTruthHandlers: handlersGT,
            groundTruthSenders: sendersGT,
            bySubjectKind,
        },
        extracted,
        groundTruth,
        missed,
        extra,
        unresolvedSamples: unresolved.slice(0, 30),
    };
}

function locKey(x: NatsCallSite | GroundTruthEntry): string {
    return `${x.location.file}:${x.location.line}`;
}

