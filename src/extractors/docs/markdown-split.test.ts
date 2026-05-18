import { describe, it, expect } from 'vitest';
import { splitMarkdown } from './markdown-split.js';

/** Stub tokenizer: 1 token per whitespace-separated word. Deterministic. */
const stubCount = async (text: string): Promise<number> =>
    text.trim().split(/\s+/).filter(Boolean).length;

describe('splitMarkdown', () => {
    it('returns one __root__ site for a file with no headings', async () => {
        const out = await splitMarkdown('just some plain text', {
            chunkTokens: 100, countTokens: stubCount,
        });
        expect(out).toHaveLength(1);
        expect(out[0].headingChain).toEqual([]);
        expect(out[0].headingLevel).toBe(0);
        expect(out[0].slug).toBe('__root__');
    });

    it('splits on ATX H2 headings', async () => {
        const md = [
            '# Title', '', 'intro', '',
            '## Setup', 'how to set up', '',
            '## Usage', 'how to use',
        ].join('\n');

        const out = await splitMarkdown(md, { chunkTokens: 100, countTokens: stubCount });
        expect(out.map(s => s.headingChain.at(-1))).toEqual(['Title', 'Setup', 'Usage']);
    });

    it('treats # foo inside code fences as content, not a heading', async () => {
        const md = [
            '## Real heading',
            '```bash',
            '# this is a shell comment',
            '# not a heading',
            '```',
            'tail',
        ].join('\n');

        const out = await splitMarkdown(md, { chunkTokens: 100, countTokens: stubCount });
        expect(out).toHaveLength(1);
        expect(out[0].headingChain).toEqual(['Real heading']);
    });

    it('handles setext H1 (=== underline)', async () => {
        const md = ['My Title', '========', '', 'body'].join('\n');
        const out = await splitMarkdown(md, { chunkTokens: 100, countTokens: stubCount });
        expect(out).toHaveLength(1);
        expect(out[0].headingChain).toEqual(['My Title']);
        expect(out[0].headingLevel).toBe(1);
    });

    it('marks oversized section wasSplit=true with chunkIndex/chunkOf', async () => {
        const paragraphs = Array.from({ length: 5 }, (_, i) =>
            `Paragraph ${i + 1} contains five words.`,
        ).join('\n\n');
        const md = `## Big section\n${paragraphs}`;

        const out = await splitMarkdown(md, { chunkTokens: 10, countTokens: stubCount });
        const chunks = out.filter(s => s.headingChain.at(-1) === 'Big section');
        expect(chunks.length).toBeGreaterThanOrEqual(2);
        for (const c of chunks) {
            expect(c.wasSplit).toBe(true);
            expect(c.chunkOf).toBe(chunks.length);
            expect(c.slug.startsWith('big-section--part-')).toBe(true);
        }
    });

    it('keeps non-oversized sections wasSplit=false', async () => {
        const md = '## Small\nshort body';
        const out = await splitMarkdown(md, { chunkTokens: 100, countTokens: stubCount });
        expect(out[0].wasSplit).toBe(false);
        expect(out[0].chunkIndex).toBeUndefined();
        expect(out[0].chunkOf).toBeUndefined();
    });

    it('handles setext H2 (--- underline)', async () => {
        const md = ['Section', '-------', '', 'body'].join('\n');
        const out = await splitMarkdown(md, { chunkTokens: 100, countTokens: stubCount });
        expect(out).toHaveLength(1);
        expect(out[0].headingChain).toEqual(['Section']);
        expect(out[0].headingLevel).toBe(2);
    });

    it('emits oversized single-paragraph section as one wasSplit=false site', async () => {
        // One paragraph with many words; chunkTokens=5 → packIntoChunks returns 1 chunk
        // (single paragraph cannot be split further). Site should have wasSplit=false but
        // tokenCount > chunkTokens.
        const md = '## Big\nthis paragraph has many many many many many many many many many words here';
        const out = await splitMarkdown(md, { chunkTokens: 5, countTokens: stubCount });
        const big = out.find(s => s.headingChain.at(-1) === 'Big');
        expect(big).toBeDefined();
        expect(big!.wasSplit).toBe(false);
        expect(big!.tokenCount).toBeGreaterThan(5);
    });

    it('does not drop content lines preceding a setext heading', async () => {
        // Input line 1: 'intro line', line 2: 'My Title', line 3: '========', line 4: '', line 5: 'body'
        // The setext branch must NOT pop 'intro line' from currentBody.
        // After the fix: a root section (covering line 1) is emitted before 'My Title' section.
        const md = ['intro line', 'My Title', '========', '', 'body'].join('\n');
        const out = await splitMarkdown(md, { chunkTokens: 100, countTokens: stubCount });
        const title = out.find(s => s.headingChain[0] === 'My Title');
        expect(title).toBeDefined();
        // A root section covering the intro line must exist.
        const root = out.find(s => s.headingChain.length === 0);
        expect(root).toBeDefined();
        // The root section should cover at least line 1 (the intro line).
        // If pop() bug were present, root would be suppressed (all-blank guard fires).
        expect(root!.charCount).toBeGreaterThan(0);
    });
});
