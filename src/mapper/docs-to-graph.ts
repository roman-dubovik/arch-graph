/**
 * Convert ExtractedDocSite[] into GraphNode[] of kind 'doc-section'.
 *
 * Node ID:  doc-section:<relpath>#<slug>
 *           slug already includes per-file collision counter and --part-N
 *           suffix (assigned by markdown-split + slugify), so id is unique
 *           across the graph by construction.
 *
 * Label:    last heading in chain (or basename without `.md` for __root__).
 * Anchor:   slug, built through buildAnchor() so the Anchor brand is honest.
 */

import { basename, relative } from 'node:path';

import type { GraphNode } from '../core/types.js';
import type { ExtractedDocSite } from '../extractors/docs/extract-docs.js';
import { buildAnchor } from './anchor.js';

export function mapDocsToGraph(sites: ExtractedDocSite[], projectRoot: string): GraphNode[] {
    return sites.map((site): GraphNode => {
        const relPath = relative(projectRoot, site.filePath);
        const id = `doc-section:${relPath}#${site.slug}`;
        const label = site.headingChain.length > 0
            ? site.headingChain[site.headingChain.length - 1]
            : basename(site.filePath).replace(/\.md$/i, '');

        const meta: Record<string, unknown> = {
            headingChain: site.headingChain,
            headingLevel: site.headingLevel,
            startLine: site.startLine,
            endLine: site.endLine,
            charCount: site.charCount,
            tokenCount: site.tokenCount,
            wasSplit: site.wasSplit,
        };
        if (site.wasSplit) {
            meta.chunkIndex = site.chunkIndex;
            meta.chunkOf = site.chunkOf;
        }
        if (site.frontmatter !== undefined) {
            meta.frontmatter = site.frontmatter;
        }

        return {
            id,
            kind: 'doc-section',
            label,
            path: relPath,
            anchor: buildAnchor(site.slug, id),
            meta,
        };
    });
}
