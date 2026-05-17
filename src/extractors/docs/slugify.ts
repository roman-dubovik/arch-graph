/**
 * GitHub-style slug builder with per-file collision counter.
 *
 * Algorithm:
 *   1. Lowercase.
 *   2. Strip characters not matching Unicode letter/number/dash/space.
 *   3. Replace whitespace runs with `-`.
 *   4. Collapse repeated dashes; trim leading/trailing dashes.
 *   5. If empty → `'section'`.
 *   6. On collision in the same file: append `-1`, `-2`, ... (GitHub).
 *
 * Cyrillic preserved as-is — matches GitHub's behaviour for .md rendering.
 */

export interface Slugifier {
    /** Compute and register a slug for `heading`; returns collision-free slug. */
    next(heading: string): string;
}

const STRIP_RE = /[^\p{L}\p{N}\- ]+/gu;
const WS_RE = /\s+/g;
const COLLAPSE_DASHES_RE = /-+/g;
const TRIM_DASHES_RE = /^-+|-+$/g;

function baseSlug(input: string): string {
    let s = input.toLowerCase();
    s = s.replace(STRIP_RE, '');
    s = s.replace(WS_RE, '-');
    s = s.replace(COLLAPSE_DASHES_RE, '-');
    s = s.replace(TRIM_DASHES_RE, '');
    return s === '' ? 'section' : s;
}

export function makeSlugifier(): Slugifier {
    const seen = new Map<string, number>();
    return {
        next(heading: string): string {
            const base = baseSlug(heading);
            const count = seen.get(base) ?? 0;
            seen.set(base, count + 1);
            return count === 0 ? base : `${base}-${count}`;
        },
    };
}
