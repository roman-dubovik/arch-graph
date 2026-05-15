/** Offset → line/column helpers shared by regex-driven ground-truth validators. */

export function buildLineStarts(s: string): number[] {
    const starts = [0];
    for (let i = 0; i < s.length; i++) if (s[i] === '\n') starts.push(i + 1);
    return starts;
}

export function offsetToLineCol(offset: number, lineStarts: number[]): { line: number; column: number } {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid]! <= offset) lo = mid;
        else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo]! + 1 };
}

export function indexBy<T>(arr: T[], keyFn: (t: T) => string): Map<string, T[]> {
    const m = new Map<string, T[]>();
    for (const item of arr) {
        const k = keyFn(item);
        const list = m.get(k);
        if (list) list.push(item);
        else m.set(k, [item]);
    }
    return m;
}

/**
 * Matches ground-truth entries to extracted candidates by `file:line` key,
 * consuming one candidate per GT entry to preserve cardinality.
 *
 * An optional `predicate` narrows which candidates are eligible for a given
 * GT entry (e.g. NATS uses it to require matching `role`).
 */
export function matchByLineKey<
    GT extends { location: { file: string; line: number } },
    T,
>(
    gt: GT[],
    keyed: Map<string, T[]>,
    predicate?: (candidate: T, entry: GT) => boolean,
): { consumed: Set<T>; missed: GT[] } {
    const consumed = new Set<T>();
    const missed: GT[] = [];
    for (const g of gt) {
        const k = `${g.location.file}:${g.location.line}`;
        const hit = (keyed.get(k) ?? []).find(
            (c) => !consumed.has(c) && (!predicate || predicate(c, g)),
        );
        if (hit) consumed.add(hit);
        else missed.push(g);
    }
    return { consumed, missed };
}
