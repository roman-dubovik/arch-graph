/**
 * Pure-function Markdown splitter. Converts a body string (frontmatter already
 * stripped by the caller) into one or more DocSite records, adaptively
 * splitting sections whose embedder-token count exceeds `chunkTokens`.
 *
 * Splitting strategy:
 *   - Partition by H1/H2 headings.
 *   - If a section exceeds the budget, greedy-pack paragraphs (blank-line
 *     separated) up to the budget.
 *   - A single paragraph exceeding the budget (long code block, wide table)
 *     is emitted as one site — splitting inside a fence would corrupt it.
 */

import { makeSlugifier } from './slugify.js';

export interface DocSite {
    headingChain: string[];
    headingLevel: number;
    slug: string;
    startLine: number;
    endLine: number;
    charCount: number;
    tokenCount: number;
    wasSplit: boolean;
    chunkIndex?: number;
    chunkOf?: number;
}

export interface SplitOptions {
    chunkTokens: number;
    countTokens: (text: string) => Promise<number>;
}

interface RawSection {
    headingChain: string[];
    headingLevel: number;
    bodyLines: string[];
    startLine: number;
    endLine: number;
}

const ATX_HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

function isSetextUnderline(line: string): 1 | 2 | null {
    if (/^=+\s*$/.test(line)) return 1;
    if (/^-+\s*$/.test(line)) return 2;
    return null;
}

function partitionByHeadings(body: string): RawSection[] {
    const lines = body.split('\n');
    const sections: RawSection[] = [];

    const stack: Array<{ level: number; text: string }> = [];
    let currentBody: string[] = [];
    let currentStart = 1;
    let inFence = false;
    let fenceMarker: '`' | '~' | null = null;

    const flushCurrent = (endLine: number) => {
        if (stack.length === 0 && currentBody.every(l => l.trim() === '')) {
            return;
        }
        sections.push({
            headingChain: stack.map(s => s.text),
            headingLevel: stack.at(-1)?.level ?? 0,
            bodyLines: currentBody,
            startLine: currentStart,
            endLine,
        });
        currentBody = [];
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;

        const fenceMatch = line.match(/^\s*(```|~~~)/);
        if (fenceMatch !== null) {
            const marker = fenceMatch[1][0] as '`' | '~';
            if (!inFence) {
                inFence = true;
                fenceMarker = marker;
            } else if (fenceMarker === marker) {
                inFence = false;
                fenceMarker = null;
            }
            currentBody.push(line);
            continue;
        }
        if (inFence) {
            currentBody.push(line);
            continue;
        }

        const atxMatch = line.match(ATX_HEADING_RE);
        if (atxMatch !== null) {
            const level = atxMatch[1].length;
            const text = atxMatch[2].trim();
            flushCurrent(lineNum - 1);
            while (stack.length > 0 && stack.at(-1)!.level >= level) stack.pop();
            stack.push({ level, text });
            currentStart = lineNum + 1;
            continue;
        }

        const setextLevel = i + 1 < lines.length ? isSetextUnderline(lines[i + 1]) : null;
        if (setextLevel !== null && line.trim() !== '') {
            currentBody.pop();
            flushCurrent(lineNum - 1);
            while (stack.length > 0 && stack.at(-1)!.level >= setextLevel) stack.pop();
            stack.push({ level: setextLevel, text: line.trim() });
            currentStart = lineNum + 2;
            i += 1;
            continue;
        }

        currentBody.push(line);
    }

    flushCurrent(lines.length);

    if (sections.length === 0) {
        return [{
            headingChain: [],
            headingLevel: 0,
            bodyLines: lines,
            startLine: 1,
            endLine: lines.length,
        }];
    }
    return sections;
}

async function packIntoChunks(
    bodyLines: string[],
    bodyStartLine: number,
    chunkTokens: number,
    countTokens: (text: string) => Promise<number>,
): Promise<Array<{ lines: string[]; startLine: number; endLine: number; tokens: number }>> {
    const paragraphs: Array<{ lines: string[]; startLine: number; endLine: number }> = [];
    let cur: string[] = [];
    let curStart = bodyStartLine;
    for (let i = 0; i < bodyLines.length; i++) {
        const line = bodyLines[i];
        if (line.trim() === '' && cur.length > 0) {
            paragraphs.push({ lines: cur, startLine: curStart, endLine: bodyStartLine + i - 1 });
            cur = [];
            curStart = bodyStartLine + i + 1;
        } else if (line.trim() !== '') {
            cur.push(line);
        }
    }
    if (cur.length > 0) {
        paragraphs.push({ lines: cur, startLine: curStart, endLine: bodyStartLine + bodyLines.length - 1 });
    }

    if (paragraphs.length === 0) {
        return [{
            lines: bodyLines,
            startLine: bodyStartLine,
            endLine: bodyStartLine + bodyLines.length - 1,
            tokens: 0,
        }];
    }

    const chunks: Array<{ lines: string[]; startLine: number; endLine: number; tokens: number }> = [];
    let bucket: { lines: string[]; startLine: number; endLine: number; tokens: number } | null = null;

    for (const p of paragraphs) {
        const pTokens = await countTokens(p.lines.join('\n'));
        if (bucket === null) {
            bucket = { lines: p.lines.slice(), startLine: p.startLine, endLine: p.endLine, tokens: pTokens };
            continue;
        }
        if (bucket.tokens + pTokens <= chunkTokens) {
            bucket.lines.push('', ...p.lines);
            bucket.endLine = p.endLine;
            bucket.tokens += pTokens;
        } else {
            chunks.push(bucket);
            bucket = { lines: p.lines.slice(), startLine: p.startLine, endLine: p.endLine, tokens: pTokens };
        }
    }
    if (bucket !== null) chunks.push(bucket);
    return chunks;
}

export async function splitMarkdown(body: string, opts: SplitOptions): Promise<DocSite[]> {
    const { chunkTokens, countTokens } = opts;
    const rawSections = partitionByHeadings(body);

    const sites: DocSite[] = [];
    const slugger = makeSlugifier();

    for (const section of rawSections) {
        const headingText = section.headingChain.at(-1);
        const baseSlug = headingText === undefined ? '__root__' : slugger.next(headingText);
        const bodyText = section.bodyLines.join('\n');
        const totalTokens = await countTokens(bodyText);

        if (totalTokens <= chunkTokens || section.bodyLines.length === 0) {
            sites.push({
                headingChain: section.headingChain,
                headingLevel: section.headingLevel,
                slug: baseSlug,
                startLine: section.startLine,
                endLine: section.endLine,
                charCount: bodyText.length,
                tokenCount: totalTokens,
                wasSplit: false,
            });
            continue;
        }

        const chunks = await packIntoChunks(section.bodyLines, section.startLine, chunkTokens, countTokens);

        if (chunks.length === 1) {
            sites.push({
                headingChain: section.headingChain,
                headingLevel: section.headingLevel,
                slug: baseSlug,
                startLine: chunks[0].startLine,
                endLine: chunks[0].endLine,
                charCount: chunks[0].lines.join('\n').length,
                tokenCount: chunks[0].tokens,
                wasSplit: false,
            });
            continue;
        }

        const N = chunks.length;
        chunks.forEach((c, idx) => {
            sites.push({
                headingChain: section.headingChain,
                headingLevel: section.headingLevel,
                slug: `${baseSlug}--part-${idx + 1}`,
                startLine: c.startLine,
                endLine: c.endLine,
                charCount: c.lines.join('\n').length,
                tokenCount: c.tokens,
                wasSplit: true,
                chunkIndex: idx + 1,
                chunkOf: N,
            });
        });
    }

    return sites;
}
