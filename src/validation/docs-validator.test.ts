import { describe, it, expect } from 'vitest';
import { validateDocs } from './docs-validator.js';
import type { DocsDiagnostics, GraphNode } from '../core/types.js';

function makeDocNode(id: string, path: string): GraphNode {
    return {
        id, kind: 'doc-section', label: 'X', path,
        anchor: 'x' as GraphNode['anchor'],
        meta: {
            headingChain: [], headingLevel: 0,
            startLine: 1, endLine: 1, charCount: 0, tokenCount: 0, wasSplit: false,
        },
    };
}

describe('validateDocs', () => {
    it('passes when every file is processed', () => {
        const diagnostics: DocsDiagnostics = {
            filesScanned: 2, filesSkipped: [], frontmatterErrors: [], oversizedChunks: [],
            counts: {
                filesIncluded: 2, nodesEmitted: 2, headingsTotal: 2,
                sectionsSplit: 0, filesWithFrontmatter: 0,
            },
        };
        const nodes = [makeDocNode('a', 'A.md'), makeDocNode('b', 'B.md')];
        const result = validateDocs(diagnostics, nodes);
        expect(result.summary.meetsFloor).toBe(true);
        expect(result.summary.recall).toBe(1);
    });

    it('passes when missing files are accounted for in filesSkipped', () => {
        const diagnostics: DocsDiagnostics = {
            filesScanned: 2,
            filesSkipped: [{ path: 'B.md', reason: 'oversized' }],
            frontmatterErrors: [], oversizedChunks: [],
            counts: {
                filesIncluded: 2, nodesEmitted: 1, headingsTotal: 1,
                sectionsSplit: 0, filesWithFrontmatter: 0,
            },
        };
        const nodes = [makeDocNode('a', 'A.md')];
        const result = validateDocs(diagnostics, nodes);
        expect(result.summary.meetsFloor).toBe(true);
    });

    it('fails when filesIncluded does not match processed + skipped', () => {
        const diagnostics: DocsDiagnostics = {
            filesScanned: 1, filesSkipped: [], frontmatterErrors: [], oversizedChunks: [],
            counts: {
                filesIncluded: 2, nodesEmitted: 1, headingsTotal: 1,
                sectionsSplit: 0, filesWithFrontmatter: 0,
            },
        };
        const nodes = [makeDocNode('a', 'A.md')];
        const result = validateDocs(diagnostics, nodes);
        expect(result.summary.meetsFloor).toBe(false);
    });

    it('does not count gitignored against recall (gitignored files are absent from filesIncluded)', () => {
        const diagnostics: DocsDiagnostics = {
            filesScanned: 1,
            filesSkipped: [{ path: 'gone.md', reason: 'gitignored' }],
            frontmatterErrors: [], oversizedChunks: [],
            counts: {
                filesIncluded: 1, nodesEmitted: 1, headingsTotal: 1,
                sectionsSplit: 0, filesWithFrontmatter: 0,
            },
        };
        const nodes = [makeDocNode('a', 'A.md')];
        const result = validateDocs(diagnostics, nodes);
        expect(result.summary.meetsFloor).toBe(true);
        expect(result.summary.recall).toBe(1);
    });

    it('recall is 1.0 (not >1.0) when processed files equal filesIncluded and gitignored entries are present', () => {
        // filesIncluded=2, gitignored entry is informational only (not in resolvedSet)
        // Previous bug: denominator was filesIncluded - userExcluded = 2 - 1 = 1,
        // but numerator was processedFiles.size + realSkipped = 2 + 0 = 2 → recall > 1.
        const diagnostics: DocsDiagnostics = {
            filesScanned: 2, filesSkipped: [{ path: 'C.md', reason: 'gitignored' }],
            frontmatterErrors: [], oversizedChunks: [],
            counts: {
                filesIncluded: 2, nodesEmitted: 2, headingsTotal: 2,
                sectionsSplit: 0, filesWithFrontmatter: 0,
            },
        };
        const nodes = [makeDocNode('a', 'A.md'), makeDocNode('b', 'B.md')];
        const result = validateDocs(diagnostics, nodes);
        expect(result.summary.recall).toBe(1);
        expect(result.summary.meetsFloor).toBe(true);
    });
});
