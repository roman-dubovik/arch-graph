import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { extractDocs } from './extract-docs.js';

const FIXTURES = resolve(__dirname, '../../__fixtures__/docs/sample');

const stubCountTokens = async (text: string): Promise<number> =>
    text.trim().split(/\s+/).filter(Boolean).length;

describe('extractDocs', () => {
    it('extracts sites from README.md', async () => {
        const result = await extractDocs({
            projectRoot: FIXTURES,
            include: ['README.md'],
            exclude: [],
            respectGitignore: false,
            chunkTokens: 100,
            maxFileBytes: 10_000_000,
            countTokens: stubCountTokens,
        });

        const sites = result.sites.filter(s => s.filePath.endsWith('README.md'));
        const headings = sites.map(s => s.headingChain.at(-1));
        expect(headings).toContain('Sample Project');
        expect(headings).toContain('Installation');
        expect(headings).toContain('Usage');
    });

    it('parses valid frontmatter and attaches to first site of the file', async () => {
        const result = await extractDocs({
            projectRoot: FIXTURES,
            include: ['ADR.md'],
            exclude: [],
            respectGitignore: false,
            chunkTokens: 100,
            maxFileBytes: 10_000_000,
            countTokens: stubCountTokens,
        });

        const adrSites = result.sites.filter(s => s.filePath.endsWith('ADR.md'));
        expect(adrSites.length).toBeGreaterThan(0);
        expect(adrSites[0].frontmatter).toMatchObject({
            title: 'Use TypeORM',
            status: 'accepted',
        });
        expect(result.diagnostics.counts.filesWithFrontmatter).toBe(1);
    });

    it('records frontmatter parse error but continues extraction', async () => {
        const result = await extractDocs({
            projectRoot: FIXTURES,
            include: ['BAD_FRONTMATTER.md'],
            exclude: [],
            respectGitignore: false,
            chunkTokens: 100,
            maxFileBytes: 10_000_000,
            countTokens: stubCountTokens,
        });

        expect(result.diagnostics.frontmatterErrors).toHaveLength(1);
        expect(result.diagnostics.frontmatterErrors[0].path).toMatch(/BAD_FRONTMATTER\.md$/);

        const sites = result.sites.filter(s => s.filePath.endsWith('BAD_FRONTMATTER.md'));
        expect(sites.map(s => s.headingChain.at(-1))).toContain('Body');
    });

    it('reports empty file in filesSkipped with reason=empty', async () => {
        const result = await extractDocs({
            projectRoot: FIXTURES,
            include: ['EMPTY.md'],
            exclude: [],
            respectGitignore: false,
            chunkTokens: 100,
            maxFileBytes: 10_000_000,
            countTokens: stubCountTokens,
        });

        const skipped = result.diagnostics.filesSkipped.find(s => s.path.endsWith('EMPTY.md'));
        expect(skipped).toBeDefined();
        expect(skipped?.reason).toBe('empty');
    });

    it('reports oversized file in filesSkipped', async () => {
        const result = await extractDocs({
            projectRoot: FIXTURES,
            include: ['README.md'],
            exclude: [],
            respectGitignore: false,
            chunkTokens: 100,
            maxFileBytes: 1,
            countTokens: stubCountTokens,
        });

        const skipped = result.diagnostics.filesSkipped.find(s => s.path.endsWith('README.md'));
        expect(skipped?.reason).toBe('oversized');
    });
});
