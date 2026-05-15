/**
 * Replaces single-line // and multi-line block comments with whitespace,
 * preserving line numbers so reporting remains accurate.
 */
export function stripComments(src: string): string {
    let out = '';
    let i = 0;
    const n = src.length;
    let inString: '"' | "'" | '`' | null = null;
    while (i < n) {
        const c = src[i]!;
        const next = src[i + 1];
        if (inString) {
            out += c;
            if (c === '\\' && i + 1 < n) {
                out += src[i + 1]!;
                i += 2;
                continue;
            }
            if (c === inString) inString = null;
            i++;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            inString = c as '"' | "'" | '`';
            out += c;
            i++;
            continue;
        }
        if (c === '/' && next === '/') {
            while (i < n && src[i] !== '\n') {
                out += ' ';
                i++;
            }
            continue;
        }
        if (c === '/' && next === '*') {
            i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
                out += src[i] === '\n' ? '\n' : ' ';
                i++;
            }
            i += 2;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}
