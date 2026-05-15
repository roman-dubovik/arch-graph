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
