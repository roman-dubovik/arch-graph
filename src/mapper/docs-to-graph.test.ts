import { describe, it, expect } from 'vitest';
import { mapDocsToGraph } from './docs-to-graph.js';
import type { ExtractedDocSite } from '../extractors/docs/extract-docs.js';

const PROJECT_ROOT = '/Users/me/proj';

function makeSite(overrides: Partial<ExtractedDocSite>): ExtractedDocSite {
    return {
        filePath: '/Users/me/proj/README.md',
        headingChain: ['Installation'],
        headingLevel: 2,
        slug: 'installation',
        startLine: 5,
        endLine: 20,
        charCount: 100,
        tokenCount: 30,
        wasSplit: false,
        ...overrides,
    };
}

describe('mapDocsToGraph', () => {
    it('creates a node with id, kind, label, path, anchor, meta', () => {
        const nodes = mapDocsToGraph([makeSite({})], PROJECT_ROOT);
        expect(nodes).toHaveLength(1);
        const n = nodes[0];
        expect(n.kind).toBe('doc-section');
        expect(n.id).toBe('doc-section:README.md#installation');
        expect(n.label).toBe('Installation');
        expect(n.path).toBe('README.md');
        expect(n.anchor).toBe('installation');
        expect(n.meta).toMatchObject({
            headingChain: ['Installation'],
            headingLevel: 2,
            startLine: 5,
            endLine: 20,
            wasSplit: false,
        });
    });

    it('uses last heading as label, full chain in meta', () => {
        const nodes = mapDocsToGraph([makeSite({
            headingChain: ['README', 'Installation', 'macOS'], headingLevel: 3,
        })], PROJECT_ROOT);
        expect(nodes[0].label).toBe('macOS');
        expect(nodes[0].meta?.headingChain).toEqual(['README', 'Installation', 'macOS']);
    });

    it('uses __root__ id for files with no headings', () => {
        const nodes = mapDocsToGraph([makeSite({
            headingChain: [], headingLevel: 0, slug: '__root__',
        })], PROJECT_ROOT);
        expect(nodes[0].id).toBe('doc-section:README.md#__root__');
        expect(nodes[0].label).toMatch(/^README$/);
    });

    it('preserves wasSplit/chunkIndex/chunkOf in meta', () => {
        const nodes = mapDocsToGraph([makeSite({
            slug: 'installation--part-2', wasSplit: true, chunkIndex: 2, chunkOf: 3,
        })], PROJECT_ROOT);
        expect(nodes[0].id).toBe('doc-section:README.md#installation--part-2');
        expect(nodes[0].meta?.wasSplit).toBe(true);
        expect(nodes[0].meta?.chunkIndex).toBe(2);
        expect(nodes[0].meta?.chunkOf).toBe(3);
    });

    it('attaches frontmatter only when site has it', () => {
        const sites: ExtractedDocSite[] = [
            makeSite({ headingChain: ['A'], slug: 'a', frontmatter: { title: 'Doc' } }),
            makeSite({ headingChain: ['B'], slug: 'b' }),
        ];
        const nodes = mapDocsToGraph(sites, PROJECT_ROOT);
        expect(nodes[0].meta?.frontmatter).toEqual({ title: 'Doc' });
        expect(nodes[1].meta?.frontmatter).toBeUndefined();
    });

    it('uses path relative to projectRoot', () => {
        const nodes = mapDocsToGraph([makeSite({
            filePath: '/Users/me/proj/apps/api/README.md',
        })], PROJECT_ROOT);
        expect(nodes[0].path).toBe('apps/api/README.md');
    });
});
