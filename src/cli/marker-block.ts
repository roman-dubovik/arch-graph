// Utilities for managing delimited (marked) sections inside text files.
// Provides idempotent replace, strip, and append operations for marker-delimited blocks.

/**
 * Replace the content (and surrounding markers) of an existing marked block.
 * Returns the original body unchanged if no block is found.
 */
export function replaceMarkedSection(
    body: string,
    start: string,
    end: string,
    replacement: string,
): string {
    const s = body.indexOf(start);
    if (s < 0) return body;
    const e = body.indexOf(end, s);
    if (e < 0) return body;
    const tail = e + end.length;
    // Swallow one trailing newline if present so we don't accumulate blank lines.
    const eatNl = body[tail] === '\n' ? 1 : 0;
    return body.slice(0, s) + replacement + body.slice(tail + eatNl);
}

/** Strip a marked block entirely, including surrounding whitespace noise. */
export function stripMarkedSection(body: string, start: string, end: string): string {
    const replaced = replaceMarkedSection(body, start, end, '');
    // Collapse any 3+ consecutive newlines that the strip might leave behind.
    return replaced.replace(/\n{3,}/g, '\n\n');
}

/**
 * Append `block` to body, separating from existing content with a blank line.
 * Caller is responsible for any trailing newline within `block` itself.
 * If body is empty (or whitespace-only), writes `block` as-is.
 */
export function appendBlock(body: string, block: string): string {
    const trimmed = body.replace(/\s+$/, '');
    if (trimmed.length === 0) return block;
    return `${trimmed}\n\n${block}`;
}
