import type { GroundTruthEntry, NatsCallSite, NatsValidationReport } from '../core/types.js';

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
    const gtKeyed = indexBy(groundTruth, locKey);

    const missed: GroundTruthEntry[] = [];
    const consumed = new Set<NatsCallSite>();
    let handlersFound = 0;
    let sendersFound = 0;

    for (const [k, gtList] of gtKeyed) {
        const candidates = extractedKeyed.get(k) ?? [];
        for (const gt of gtList) {
            const match = candidates.find((c) => c.role === gt.role && !consumed.has(c));
            if (match) {
                consumed.add(match);
                if (gt.role === 'receiver') handlersFound++;
                else sendersFound++;
            } else {
                missed.push(gt);
            }
        }
    }

    const extra = extracted.filter((e) => !consumed.has(e));

    const handlersGT = groundTruth.filter((g) => g.role === 'receiver').length;
    const sendersGT = groundTruth.filter((g) => g.role === 'sender').length;

    const resolvedCount = extracted.filter(
        (e) => e.subject.kind === 'literal' || e.subject.kind === 'pattern',
    ).length;
    const classifiedCount = extracted.filter((e) => e.subject.kind !== 'unresolved').length;

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
            resolveRate: extracted.length > 0 ? resolvedCount / extracted.length : 0,
            classificationAccuracy: extracted.length > 0 ? classifiedCount / extracted.length : 0,
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

function indexBy<T>(arr: T[], keyFn: (t: T) => string): Map<string, T[]> {
    const m = new Map<string, T[]>();
    for (const item of arr) {
        const k = keyFn(item);
        const list = m.get(k);
        if (list) list.push(item);
        else m.set(k, [item]);
    }
    return m;
}
