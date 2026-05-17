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
});
