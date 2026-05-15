import type { GroundTruthEntry, NatsCallSite, ValidationReport } from '../core/types.js';

/**
 * Matches ground-truth entries against extracted call sites.
 *
 * Matching key = `${file}:${line}` (column varies between decorator vs call-site).
 * Coarse but sufficient — each decorator/call site sits on its own line in practice.
 */
export function buildReport(
    projectId: string,
    extracted: NatsCallSite[],
    groundTruth: GroundTruthEntry[],
): ValidationReport {
    const extractedKeyed = indexBy(extracted, locKey);
    const gtKeyed = indexBy(groundTruth, locKey);

    const missed: GroundTruthEntry[] = [];
    for (const [k, gtList] of gtKeyed) {
        const candidates = extractedKeyed.get(k);
        for (const gt of gtList) {
            const hasMatch = candidates?.some((c) => c.role === gt.role) ?? false;
            if (!hasMatch) missed.push(gt);
        }
    }

    const extra: NatsCallSite[] = [];
    for (const e of extracted) {
        const k = locKey(e);
        const gt = gtKeyed.get(k);
        if (!gt || !gt.some((g) => g.role === e.role)) {
            extra.push(e);
        }
    }

    const handlersGT = groundTruth.filter((g) => g.role === 'receiver').length;
    const handlersFound = groundTruth.filter((g) => {
        if (g.role !== 'receiver') return false;
        const k = locKey(g);
        return extractedKeyed.get(k)?.some((c) => c.role === 'receiver') ?? false;
    }).length;

    const sendersGT = groundTruth.filter((g) => g.role === 'sender').length;
    const sendersFound = groundTruth.filter((g) => {
        if (g.role !== 'sender') return false;
        const k = locKey(g);
        return extractedKeyed.get(k)?.some((c) => c.role === 'sender') ?? false;
    }).length;

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
        projectId,
        timestamp: new Date().toISOString(),
        summary: {
            recallHandlers: handlersGT > 0 ? handlersFound / handlersGT : 1,
            recallSenders: sendersGT > 0 ? sendersFound / sendersGT : 1,
            resolveRate: extracted.length > 0 ? resolvedCount / extracted.length : 0,
            classificationAccuracy: extracted.length > 0 ? classifiedCount / extracted.length : 0,
            totalExtracted: extracted.length,
            totalGroundTruth: groundTruth.length,
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
