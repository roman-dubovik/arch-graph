/**
 * Top-level docs extractor.
 *
 * Resolves the file list via fast-glob, applies gitignore filtering via
 * `git ls-files` (invoked through execFileSync to avoid shell injection),
 * reads each file, normalizes content, parses YAML frontmatter, and
 * dispatches to splitMarkdown. Returns the flat list of extracted sites
 * plus a diagnostics record describing skipped/erroring files.
 */

import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { relative, resolve as resolvePath } from 'node:path';
import fastGlob from 'fast-glob';
import yaml from 'js-yaml';

import type { DocsDiagnostics } from '../../core/types.js';
import type { DocSite } from './markdown-split.js';
import { splitMarkdown } from './markdown-split.js';

export interface ExtractedDocSite extends DocSite {
    filePath: string;
    frontmatter?: Record<string, unknown>;
}

export interface ExtractDocsOptions {
    projectRoot: string;
    include: string[];
    exclude: string[];
    respectGitignore: boolean;
    chunkTokens: number;
    maxFileBytes: number;
    countTokens: (text: string) => Promise<number>;
}

export interface ExtractDocsResult {
    sites: ExtractedDocSite[];
    diagnostics: DocsDiagnostics;
}

const FRONTMATTER_START = '---\n';
const FRONTMATTER_END_RE = /\n---\s*\n/;

interface ParsedContent {
    body: string;
    bodyStartLine: number;
    frontmatter?: Record<string, unknown>;
    frontmatterError?: string;
}

function parseFrontmatter(raw: string): ParsedContent {
    if (!raw.startsWith(FRONTMATTER_START)) {
        return { body: raw, bodyStartLine: 1 };
    }
    const afterStart = raw.slice(FRONTMATTER_START.length);
    const endMatch = afterStart.match(FRONTMATTER_END_RE);
    if (endMatch === null || endMatch.index === undefined) {
        return { body: raw, bodyStartLine: 1 };
    }

    const yamlText = afterStart.slice(0, endMatch.index);
    const bodyOffset = FRONTMATTER_START.length + endMatch.index + endMatch[0].length;
    const body = raw.slice(bodyOffset);
    const bodyStartLine = raw.slice(0, bodyOffset).split('\n').length;

    try {
        const parsed = yaml.load(yamlText, { schema: yaml.CORE_SCHEMA });
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { body, bodyStartLine, frontmatter: parsed as Record<string, unknown> };
        }
        return { body, bodyStartLine };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { body, bodyStartLine, frontmatterError: message };
    }
}

function normalize(buf: Buffer): { text: string; valid: boolean } {
    let text: string;
    try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        text = decoder.decode(buf);
    } catch {
        return { text: '', valid: false };
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    text = text.replace(/\r\n/g, '\n');
    return { text, valid: true };
}

/**
 * Return the set of absolute paths to .md files tracked by git in `projectRoot`,
 * or null if the directory is not a git repo.
 *
 * Uses execFileSync (no shell) to keep injection surface zero, even though
 * projectRoot comes from user config.
 */
function gitTrackedMdFiles(projectRoot: string): Set<string> | null {
    try {
        const stdout = execFileSync('git', ['-C', projectRoot, 'ls-files', '--', '*.md'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const rel = stdout.split('\n').filter(s => s.length > 0);
        return new Set(rel.map(r => resolvePath(projectRoot, r)));
    } catch {
        return null;
    }
}

export async function extractDocs(opts: ExtractDocsOptions): Promise<ExtractDocsResult> {
    const {
        projectRoot, include, exclude, respectGitignore,
        chunkTokens, maxFileBytes, countTokens,
    } = opts;

    const diagnostics: DocsDiagnostics = {
        filesScanned: 0,
        filesSkipped: [],
        frontmatterErrors: [],
        oversizedChunks: [],
        counts: {
            filesIncluded: 0,
            nodesEmitted: 0,
            headingsTotal: 0,
            sectionsSplit: 0,
            filesWithFrontmatter: 0,
        },
    };

    const matched = await fastGlob(include, {
        cwd: projectRoot,
        absolute: true,
        ignore: exclude,
        dot: false,
        onlyFiles: true,
    });

    let resolvedSet: Set<string>;
    if (respectGitignore) {
        const tracked = gitTrackedMdFiles(projectRoot);
        if (tracked !== null) {
            resolvedSet = new Set(matched.filter(f => tracked.has(f)));
            for (const abs of matched) {
                if (!tracked.has(abs)) {
                    diagnostics.filesSkipped.push({
                        path: relative(projectRoot, abs),
                        reason: 'gitignored',
                    });
                }
            }
        } else {
            resolvedSet = new Set(matched);
        }
    } else {
        resolvedSet = new Set(matched);
    }

    diagnostics.counts.filesIncluded = resolvedSet.size;
    const sites: ExtractedDocSite[] = [];

    for (const filePath of resolvedSet) {
        diagnostics.filesScanned += 1;
        const relPath = relative(projectRoot, filePath);

        const st = await stat(filePath);
        if (st.size > maxFileBytes) {
            diagnostics.filesSkipped.push({ path: relPath, reason: 'oversized' });
            continue;
        }

        const buf = await readFile(filePath);
        const { text, valid } = normalize(buf);
        if (!valid) {
            diagnostics.filesSkipped.push({ path: relPath, reason: 'non-utf8' });
            continue;
        }
        if (text.trim() === '') {
            diagnostics.filesSkipped.push({ path: relPath, reason: 'empty' });
            continue;
        }

        const parsed = parseFrontmatter(text);
        if (parsed.frontmatterError !== undefined) {
            diagnostics.frontmatterErrors.push({ path: relPath, error: parsed.frontmatterError });
        }
        const hasFrontmatter = parsed.frontmatter !== undefined;
        if (hasFrontmatter) diagnostics.counts.filesWithFrontmatter += 1;

        const docs = await splitMarkdown(parsed.body, { chunkTokens, countTokens });
        const offset = parsed.bodyStartLine - 1;

        docs.forEach((d, idx) => {
            const site: ExtractedDocSite = {
                ...d,
                startLine: d.startLine + offset,
                endLine: d.endLine + offset,
                filePath,
                ...(idx === 0 && hasFrontmatter ? { frontmatter: parsed.frontmatter } : {}),
            };
            sites.push(site);
            diagnostics.counts.nodesEmitted += 1;
            if (d.headingChain.length > 0) diagnostics.counts.headingsTotal += 1;
            if (d.wasSplit) diagnostics.counts.sectionsSplit += 1;
        });
    }

    return { sites, diagnostics };
}
