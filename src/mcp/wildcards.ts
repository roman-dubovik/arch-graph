/**
 * NATS subject pattern matcher.
 *
 * Symmetric: if either side contains wildcards, the literal side is matched
 * against the pattern. If both are literals, plain string equality is used.
 * If both are patterns, an entry matches when the regexes are *compatible*
 * (one accepts the other's wildcard-substituted form).
 *
 * NATS wildcard rules:
 *   - `*`  matches exactly ONE token (one segment between dots).
 *   - `>`  matches ONE OR MORE trailing tokens (only at the end).
 */

const TOKEN_PLACEHOLDER = '__ARCHGRAPH_TOKEN__';
const REST_PLACEHOLDER = '__ARCHGRAPH_REST__';

export function hasWildcard(subject: string): boolean {
    return /(^|\.)\*(\.|$)/.test(subject) || /(^|\.)>$/.test(subject);
}

/** Compile a (possibly-wildcarded) subject into a regex matching literal subjects. */
function compileToRegex(pattern: string): RegExp {
    // Replace wildcards with placeholders first, escape rest, then swap placeholders for regex.
    let p = pattern
        .replace(/(^|\.)\*(?=\.|$)/g, (_m, pre: string) => `${pre}${TOKEN_PLACEHOLDER}`)
        .replace(/(^|\.)>$/g, (_m, pre: string) => `${pre}${REST_PLACEHOLDER}`);
    p = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    p = p.split(TOKEN_PLACEHOLDER).join('[^.]+');
    p = p.split(REST_PLACEHOLDER).join('.+');
    return new RegExp(`^${p}$`);
}

/**
 * Match `a` against `b` symmetrically.
 * - Both literal: string equality.
 * - One has wildcards: literal matched against pattern.
 * - Both have wildcards: either pattern's wildcard expansion accepts the other
 *   (loose intersection, sufficient for graph-query use cases).
 */
export function subjectMatches(a: string, b: string): boolean {
    if (a === b) return true;
    const aw = hasWildcard(a);
    const bw = hasWildcard(b);
    if (!aw && !bw) return false;
    if (aw && !bw) return compileToRegex(a).test(b);
    if (!aw && bw) return compileToRegex(b).test(a);
    // Both patterns — try both directions. Substitute the other side's wildcards
    // with a concrete placeholder token before testing.
    const aConcrete = a.replace(/(^|\.)\*(?=\.|$)/g, '$1_x_').replace(/(^|\.)>$/g, '$1_x_');
    const bConcrete = b.replace(/(^|\.)\*(?=\.|$)/g, '$1_x_').replace(/(^|\.)>$/g, '$1_x_');
    return compileToRegex(a).test(bConcrete) || compileToRegex(b).test(aConcrete);
}
