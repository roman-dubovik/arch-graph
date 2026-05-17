import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

    it('populates oversizedChunks when a chunk exceeds chunkTokens', async () => {
        // Use a very tight chunkTokens (1 word) so README.md's single-paragraph
        // sections that cannot be split further show up in oversizedChunks.
        const result = await extractDocs({
            projectRoot: FIXTURES,
            include: ['README.md'],
            exclude: [],
            respectGitignore: false,
            chunkTokens: 1,
            maxFileBytes: 10_000_000,
            countTokens: stubCountTokens,
        });
        // With chunkTokens=1, multi-word single paragraphs that can't be split further
        // become oversized chunks.
        expect(result.diagnostics.oversizedChunks.length).toBeGreaterThan(0);
        const first = result.diagnostics.oversizedChunks[0];
        expect(first.docSectionId).toMatch(/^doc-section:/);
        expect(first.tokenCount).toBeGreaterThan(1);
    });

    it('parses frontmatter even when file ends without trailing newline', async () => {
        const result = await extractDocs({
            projectRoot: FIXTURES,
            include: ['NO_NEWLINE_END.md'],
            exclude: [],
            respectGitignore: false,
            chunkTokens: 100,
            maxFileBytes: 10_000_000,
            countTokens: stubCountTokens,
        });
        const sites = result.sites.filter(s => s.filePath.endsWith('NO_NEWLINE_END.md'));
        expect(sites.length).toBeGreaterThan(0);
        expect(sites[0].frontmatter).toMatchObject({ title: 'At-EOF Close' });
        expect(result.diagnostics.frontmatterErrors).toHaveLength(0);
    });

    it('respects gitignore when respectGitignore=true', async () => {
        const tmpRoot = mkdtempSync(join(tmpdir(), 'arch-graph-docs-test-'));
        execFileSync('git', ['-C', tmpRoot, 'init', '-q'], { stdio: 'ignore' });
        writeFileSync(join(tmpRoot, 'README.md'), '# Tracked\n\nbody\n');
        writeFileSync(join(tmpRoot, 'IGNORED.md'), '# Ignored\n\nbody\n');
        writeFileSync(join(tmpRoot, '.gitignore'), 'IGNORED.md\n');
        execFileSync('git', ['-C', tmpRoot, 'add', 'README.md', '.gitignore'], { stdio: 'ignore' });
        execFileSync('git', ['-C', tmpRoot, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { stdio: 'ignore' });

        const result = await extractDocs({
            projectRoot: tmpRoot,
            include: ['README.md', 'IGNORED.md'],
            exclude: [], respectGitignore: true,
            chunkTokens: 100, maxFileBytes: 10_000_000,
            countTokens: stubCountTokens,
        });

        expect(result.sites.some(s => s.filePath.endsWith('README.md'))).toBe(true);
        expect(result.sites.some(s => s.filePath.endsWith('IGNORED.md'))).toBe(false);
        expect(result.diagnostics.filesSkipped.some(
            s => s.path.endsWith('IGNORED.md') && s.reason === 'gitignored',
        )).toBe(true);
    });
});
