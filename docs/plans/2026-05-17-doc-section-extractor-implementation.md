# doc-section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `doc-section` as a new `NodeKind` so Markdown sections (README, CHANGELOG, ADRs, `docs/**/*.md`) become first-class graph nodes with embeddings, retrievable via the existing `semanticSearch` MCP tool.

**Architecture:** A new extractor walks resolved `.md` files (gitignore-aware include/exclude from config + interactive init), normalizes content, parses frontmatter (`js-yaml`), and adaptively splits into chunks bounded by the embedder's tokenizer (BERT-tokens, default 100). A new mapper turns sites into graph nodes; the existing `snippet.ts` gets a `'doc-section'` case that reconstructs body from disk by line range + heading-chain prefix. No new MCP tools — filtering via existing `kinds: ['doc-section']`.

**Tech Stack:** TypeScript (ESM, NodeNext), `@xenova/transformers` (tokenizer reuse), `js-yaml` (frontmatter), `fast-glob` (file discovery), `vitest`, `ts-morph` (already in graph layer; doc-section does NOT use it).

**Reference design:** `docs/plans/2026-05-17-doc-section-extractor-design.md` (commit `5de88af` on develop).

**Branch policy:** All work in a single isolated worktree off `develop`. NEVER `git switch develop`/`main`. Commit per-task using selective `git add <file>` — no `git add -A`.

**Process security note:** All shell-out calls to `git` use `execFileSync` (NOT `execSync` or `exec`). This bypasses the shell entirely — no quoting concerns, no injection surface when `projectRoot` comes from user config.

---

## Task ordering and dependency graph

```
Task 1 (deps + NodeKind)  ─┬─► Task 2 (tokenizer)     ─┐
                           ├─► Task 3 (slugify)        ├─► Task 4 (markdown-split) ─┐
                           │                           │                            │
                           ├─► Task 6 (config schema)  │                            ├─► Task 5 (extractor)
                           │                           │                            │
                           └─► Task 7 (mapper) ◄───────┘                            │
                                   │                                                │
                                   └─► Task 8 (snippet renderer) ◄──────────────────┤
                                                                                    │
                                       Task 9  (snippet-recall guard test) ◄────────┤
                                       Task 10 (pipeline wiring)            ◄───────┘
                                       Task 11 (docs-validator)             ◄────── Task 10
                                       Task 12 (interactive init)
                                       Task 13 (semantic + MCP tests)
                                       Task 14 (end-to-end verification)
                                       Task 15 (QG + review + merge)
```

Parallel-eligible after Task 1: Tasks 2, 3, 6 (touch disjoint files). After Task 5 completes: Tasks 7, 8, 9 are independent. Task 10 depends on 5+7. Task 11 depends on 10. Task 12 depends on 6.

---

## Task 1: Add `doc-section` to NodeKind + diagnostics types + js-yaml prod-dep

**Files:**
- Modify: `src/core/types.ts:70-117` (NodeKind union, NODE_KIND_CHECK)
- Modify: `src/core/types.ts:404-429` (DiagnosticsReport — add `docs?`)
- Modify: `src/core/types.ts:556-572` (BuildValidation — add `docs?`)
- Modify: `package.json` (move `js-yaml` to dependencies)
- Test: `src/core/types.kind.test.ts` (new)

- [ ] **Step 1: Write failing test**

Create `src/core/types.kind.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { NODE_KIND_VALUES } from './types.js';

describe('NodeKind taxonomy', () => {
    it('includes doc-section', () => {
        expect(NODE_KIND_VALUES).toContain('doc-section');
    });
});
```

- [ ] **Step 2: Run and verify failure**

```bash
pnpm test src/core/types.kind.test.ts
```

Expected: FAIL — `expected [...] to contain 'doc-section'`.

- [ ] **Step 3: Add `'doc-section'` to NodeKind, NODE_KIND_CHECK, types**

In `src/core/types.ts`, in the `NodeKind` union and `NODE_KIND_CHECK` add the new variant (keep alphabetical-ish; one line at the end is acceptable):

```ts
export type NodeKind =
    | 'service'
    | 'lib'
    | 'nats-subject'
    | 'db-table'
    | 'queue'
    | 'module'
    | 'provider'
    | 'file'
    | 'external'
    | 'fe-page'
    | 'fe-component'
    | 'fe-route'
    | 'fe-hook'
    | 'endpoint'
    | 'config-field'
    | 'scoped-marker'
    | 'db-entity-field'
    | 'doc-section';

const NODE_KIND_CHECK: Record<NodeKind, null> = {
    'service': null,
    'lib': null,
    'nats-subject': null,
    'db-table': null,
    'queue': null,
    'module': null,
    'provider': null,
    'file': null,
    'external': null,
    'fe-page': null,
    'fe-component': null,
    'fe-route': null,
    'fe-hook': null,
    'endpoint': null,
    'config-field': null,
    'scoped-marker': null,
    'db-entity-field': null,
    'doc-section': null,
};
```

Append the docs domain types near other Diagnostics types (around line 400):

```ts
// ============================================================================
// Docs-domain types (v1 — nodes only, no edges)
// ============================================================================

/**
 * Why a markdown file did not produce any doc-section nodes.
 *
 *   `oversized`           — file exceeds `docs.maxFileBytes`.
 *   `non-utf8`            — `Buffer.isUtf8(content)` returned false.
 *   `empty`               — zero bytes after BOM/CRLF normalization.
 *   `gitignored`          — file matched by .gitignore (respectGitignore=true).
 *   `excluded-by-config`  — file matched `docs.exclude` glob.
 */
export type DocsSkipReason =
    | 'oversized'
    | 'non-utf8'
    | 'empty'
    | 'gitignored'
    | 'excluded-by-config';

export interface DocsDiagnostics {
    filesScanned: number;
    filesSkipped: Array<{ path: string; reason: DocsSkipReason }>;
    frontmatterErrors: Array<{ path: string; error: string }>;
    /** Chunks whose single paragraph alone exceeded the token threshold. */
    oversizedChunks: Array<{ docSectionId: string; tokenCount: number }>;
    counts: {
        /** Resolved-include set size (after user-exclude + gitignore filters). */
        filesIncluded: number;
        nodesEmitted: number;
        headingsTotal: number;
        sectionsSplit: number;
        filesWithFrontmatter: number;
    };
}

export interface DocsValidationReport {
    summary: {
        filesIncluded: number;
        filesProcessed: number;
        filesSkippedWithReason: number;
        /** filesProcessed / max(1, filesIncluded - excludedByConfig). */
        recall: number;
        /** Floor 1.0 — every included file must be processed or skipped-with-reason. */
        meetsFloor: boolean;
    };
}
```

Add the optional fields to existing interfaces:

```ts
// In DiagnosticsReport (~line 404)
docs?: DocsDiagnostics;

// In BuildValidation (~line 556)
docs?: DocsValidationReport;
```

- [ ] **Step 4: Move `js-yaml` to runtime deps**

In `package.json`:

```diff
     "dependencies": {
         "@dqbd/tiktoken": "^1.0.22",
         "@modelcontextprotocol/sdk": "^1.29.0",
         "@xenova/transformers": "^2.17.2",
         "fast-glob": "^3.3.2",
+        "js-yaml": "^4.1.1",
         "jiti": "^2.4.2",
         "ts-morph": "^24.0.0",
         "zod": "^4.0.0"
     },
     "devDependencies": {
         "@types/js-yaml": "^4.0.9",
         "@types/node": "^20.0.0",
         "@vitest/coverage-v8": "^4.1.6",
-        "js-yaml": "^4.1.1",
         "tsx": "^4.7.0",
         "typescript": "^5.4.0",
         "vitest": "^4.1.6"
     },
```

Then `pnpm install` to refresh `pnpm-lock.yaml`.

- [ ] **Step 5: Run typecheck + tests**

```bash
pnpm exec tsc --noEmit
pnpm test src/core/
```

Expected: 0 type errors, `types.kind.test.ts` PASS. If TS surfaces missing-case errors in existing switches over `node.kind`, list them — the engineer must add `case 'doc-section':` handlers (typically `return null` / fall-through is fine where the switch was already exhaustive-by-default). The exhaustiveness check via `NODE_KIND_CHECK` is what catches all sites.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/types.kind.test.ts package.json pnpm-lock.yaml
git commit -m "feat(arch-graph): introduce doc-section NodeKind + docs diagnostics types"
```

---

## Task 2: Tokenizer wrapper (`semantic/tokenizer.ts`)

**Files:**
- Create: `src/semantic/tokenizer.ts`
- Test: `src/semantic/tokenizer.test.ts`

Loads the embedder's tokenizer (no model weights — only ~5 MB JSON) via `AutoTokenizer.from_pretrained(SEMANTIC_MODEL)`. Used by `markdown-split.ts` to size chunks against the embedder's native 128-token context.

- [ ] **Step 1: Write failing test**

Create `src/semantic/tokenizer.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { countTokens, _resetTokenizerForTesting } from './tokenizer.js';

describe('tokenizer', () => {
    beforeAll(() => {
        _resetTokenizerForTesting();
    });

    it('counts tokens deterministically for a fixed input', async () => {
        const a = await countTokens('hello world');
        const b = await countTokens('hello world');
        expect(a).toBe(b);
        expect(a).toBeGreaterThan(0);
    });

    it('returns more tokens for longer text', async () => {
        const short = await countTokens('hi');
        const long = await countTokens('hi '.repeat(100));
        expect(long).toBeGreaterThan(short);
    });

    it('handles empty string', async () => {
        const n = await countTokens('');
        expect(n).toBeGreaterThanOrEqual(0);
    });
});
```

- [ ] **Step 2: Run and verify failure**

```bash
pnpm test src/semantic/tokenizer.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement tokenizer**

Create `src/semantic/tokenizer.ts`:

```ts
/**
 * Lazy singleton tokenizer for the embedder model.
 *
 * Loads only the tokenizer (small JSON, ~5 MB), not the 384-dim model weights.
 * Used by docs chunking (`markdown-split.ts`) and any future code that needs to
 * size content against the embedder's BERT-style context (native 128 tokens
 * for paraphrase-multilingual-MiniLM-L12-v2).
 *
 * DO NOT use `@dqbd/tiktoken` for embedder chunking — that's cl100k_base
 * (Claude's tokenizer); the embedder uses XLM-RoBERTa SentencePiece, and the
 * counts disagree by 20-40% on Cyrillic/multilingual text.
 */
import { AutoTokenizer } from '@xenova/transformers';

import { SEMANTIC_MODEL } from './types.js';

type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
let cached: Tokenizer | null = null;

export function _resetTokenizerForTesting(): void {
    cached = null;
}

async function getTokenizer(): Promise<Tokenizer> {
    if (cached === null) {
        cached = await AutoTokenizer.from_pretrained(SEMANTIC_MODEL);
    }
    return cached;
}

export async function countTokens(text: string): Promise<number> {
    const tk = await getTokenizer();
    const enc = tk.encode(text);
    if (Array.isArray(enc)) return enc.length;
    return (enc as { input_ids: number[] }).input_ids.length;
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/semantic/tokenizer.test.ts
```

Expected: PASS (3/3). First run may take 1-3 seconds to load tokenizer.

- [ ] **Step 5: Commit**

```bash
git add src/semantic/tokenizer.ts src/semantic/tokenizer.test.ts
git commit -m "feat(arch-graph): semantic tokenizer wrapper for docs chunk sizing"
```

---

## Task 3: Slugify (`extractors/docs/slugify.ts`)

**Files:**
- Create: `src/extractors/docs/slugify.ts`
- Test: `src/extractors/docs/slugify.test.ts`

GitHub-compatible slug. Lowercase, strip non-alphanum (Unicode-aware), spaces → `-`, collapse repeats. Cyrillic preserved. Per-file collision counter.

- [ ] **Step 1: Write failing tests**

Create `src/extractors/docs/slugify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeSlugifier } from './slugify.js';

describe('slugify', () => {
    it('lowercases and replaces spaces with dashes', () => {
        const slug = makeSlugifier();
        expect(slug.next('Installation Steps')).toBe('installation-steps');
    });

    it('strips punctuation', () => {
        const slug = makeSlugifier();
        expect(slug.next('What is `arch-graph`?')).toBe('what-is-arch-graph');
    });

    it('preserves Cyrillic', () => {
        const slug = makeSlugifier();
        expect(slug.next('Установка на macOS')).toBe('установка-на-macos');
    });

    it('falls back to "section" when slug is empty after strip', () => {
        const slug = makeSlugifier();
        expect(slug.next('🚀🔥')).toBe('section');
    });

    it('appends -1, -2 on per-file collisions (GitHub style)', () => {
        const slug = makeSlugifier();
        expect(slug.next('Setup')).toBe('setup');
        expect(slug.next('Setup')).toBe('setup-1');
        expect(slug.next('Setup')).toBe('setup-2');
    });

    it('collapses repeated dashes', () => {
        const slug = makeSlugifier();
        expect(slug.next('foo --- bar')).toBe('foo-bar');
    });

    it('trims leading and trailing dashes', () => {
        const slug = makeSlugifier();
        expect(slug.next('--foo--')).toBe('foo');
    });
});
```

- [ ] **Step 2: Run and verify failure**

```bash
pnpm test src/extractors/docs/slugify.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/extractors/docs/slugify.ts`:

```ts
/**
 * GitHub-style slug builder with per-file collision counter.
 *
 * Algorithm:
 *   1. Lowercase.
 *   2. Strip characters not matching Unicode letter/number/dash/space.
 *   3. Replace whitespace runs with `-`.
 *   4. Collapse repeated dashes; trim leading/trailing dashes.
 *   5. If empty → `'section'`.
 *   6. On collision in the same file: append `-1`, `-2`, ... (GitHub).
 *
 * Cyrillic preserved as-is — matches GitHub's behaviour for .md rendering.
 */

export interface Slugifier {
    /** Compute and register a slug for `heading`; returns collision-free slug. */
    next(heading: string): string;
}

const STRIP_RE = /[^\p{L}\p{N}\- ]+/gu;
const WS_RE = /\s+/g;
const COLLAPSE_DASHES_RE = /-+/g;
const TRIM_DASHES_RE = /^-+|-+$/g;

function baseSlug(input: string): string {
    let s = input.toLowerCase();
    s = s.replace(STRIP_RE, '');
    s = s.replace(WS_RE, '-');
    s = s.replace(COLLAPSE_DASHES_RE, '-');
    s = s.replace(TRIM_DASHES_RE, '');
    return s === '' ? 'section' : s;
}

export function makeSlugifier(): Slugifier {
    const seen = new Map<string, number>();
    return {
        next(heading: string): string {
            const base = baseSlug(heading);
            const count = seen.get(base) ?? 0;
            seen.set(base, count + 1);
            return count === 0 ? base : `${base}-${count}`;
        },
    };
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/extractors/docs/slugify.test.ts
```

Expected: PASS (7/7).

- [ ] **Step 5: Commit**

```bash
git add src/extractors/docs/slugify.ts src/extractors/docs/slugify.test.ts
git commit -m "feat(arch-graph): GitHub-style slugifier for doc-section anchors"
```

---

## Task 4: Markdown splitter (`extractors/docs/markdown-split.ts`)

**Files:**
- Create: `src/extractors/docs/markdown-split.ts`
- Test: `src/extractors/docs/markdown-split.test.ts`

Pure async function `splitMarkdown(body, opts) => DocSite[]`. Handles ATX/setext headings, fence tracking, adaptive split by H2 + recursive H3+/paragraph. No I/O.

`countTokens` is injected — keeps tests fast (stub counter) and modules decoupled.

- [ ] **Step 1: Write failing tests**

Create `src/extractors/docs/markdown-split.test.ts`:

```ts
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
```

- [ ] **Step 2: Run and verify failure**

```bash
pnpm test src/extractors/docs/markdown-split.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement splitter**

Create `src/extractors/docs/markdown-split.ts`:

```ts
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
    startLine: number;  // 1-based, body only (heading line excluded)
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

        // Fence tracking.
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

        // ATX heading.
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

        // Setext: this line is heading text, next line is underline.
        const setextLevel = i + 1 < lines.length ? isSetextUnderline(lines[i + 1]) : null;
        if (setextLevel !== null && line.trim() !== '') {
            currentBody.pop(); // remove the heading-text line we just pushed
            flushCurrent(lineNum - 1);
            while (stack.length > 0 && stack.at(-1)!.level >= setextLevel) stack.pop();
            stack.push({ level: setextLevel, text: line.trim() });
            currentStart = lineNum + 2;
            i += 1;  // skip underline
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
    // Group into paragraphs (blank-line separated).
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
            // Single oversized paragraph — emit as one site.
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
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/extractors/docs/markdown-split.test.ts
```

Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/extractors/docs/markdown-split.ts src/extractors/docs/markdown-split.test.ts
git commit -m "feat(arch-graph): adaptive Markdown splitter for doc-section chunks"
```

---

## Task 5: Extractor — file walker + reader + frontmatter (`extractors/docs/extract-docs.ts`)

**Files:**
- Create: `src/extractors/docs/extract-docs.ts`
- Test: `src/extractors/docs/extract-docs.test.ts`
- Create: `src/__fixtures__/docs/sample/` (folder with .md fixtures)

Resolves file list (fast-glob + gitignore via `execFileSync('git', ['ls-files', ...])`), reads each file, normalizes (CRLF→LF, BOM-strip, UTF-8 check), parses frontmatter, calls `splitMarkdown`. Returns `{ sites, diagnostics }`.

- [ ] **Step 1: Create fixtures**

```bash
mkdir -p src/__fixtures__/docs/sample
```

`src/__fixtures__/docs/sample/README.md`:

```markdown
# Sample Project

Brief intro.

## Installation

How to install.

## Usage

How to use.
```

`src/__fixtures__/docs/sample/ADR.md`:

```markdown
---
title: Use TypeORM
status: accepted
---

# Decision

Use TypeORM for persistence.
```

`src/__fixtures__/docs/sample/EMPTY.md` (zero or whitespace-only):

```
```

`src/__fixtures__/docs/sample/BAD_FRONTMATTER.md`:

```markdown
---
title: [this is: not valid yaml because [unbalanced
---

# Body

Content after broken frontmatter.
```

- [ ] **Step 2: Write failing tests**

Create `src/extractors/docs/extract-docs.test.ts`:

```ts
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
```

- [ ] **Step 3: Run and verify failure**

```bash
pnpm test src/extractors/docs/extract-docs.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement extractor**

Create `src/extractors/docs/extract-docs.ts`:

```ts
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
    if (!Buffer.isUtf8(buf)) return { text: '', valid: false };
    let text = buf.toString('utf8');
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
```

- [ ] **Step 5: Run tests**

```bash
pnpm test src/extractors/docs/extract-docs.test.ts
```

Expected: PASS (5/5).

- [ ] **Step 6: Commit**

```bash
git add src/extractors/docs/extract-docs.ts src/extractors/docs/extract-docs.test.ts src/__fixtures__/docs/
git commit -m "feat(arch-graph): docs extractor — walker, frontmatter, gitignore filter via execFileSync"
```

---

## Task 6: Config schema — add `docs` to ArchGraphConfig

**Files:**
- Modify: `src/core/config.ts` (or wherever the zod schema lives — search for `ArchGraphConfig`)
- Test: `src/core/config.docs.test.ts` (new)

- [ ] **Step 1: Locate the config schema**

```bash
grep -rn "ArchGraphConfig\|export const configSchema\|z.object" src/core/ | head -10
```

Open the file. Find where the zod object is exported. The `docs` field gets added here.

- [ ] **Step 2: Write failing test**

Create `src/core/config.docs.test.ts` (adjust the import to the real schema path):

```ts
import { describe, it, expect } from 'vitest';
import { configSchema } from './config.js';

describe('config schema — docs section', () => {
    it('parses an empty docs object with all defaults', () => {
        const result = configSchema.parse({ projectId: 'x', repoRoot: '/tmp', docs: {} });
        expect(result.docs.respectGitignore).toBe(true);
        expect(result.docs.chunkTokens).toBe(100);
        expect(result.docs.maxFileBytes).toBe(10 * 1024 * 1024);
        expect(result.docs.include).toContain('README.md');
    });

    it('uses defaults when docs field is missing', () => {
        const result = configSchema.parse({ projectId: 'x', repoRoot: '/tmp' });
        expect(result.docs.chunkTokens).toBe(100);
    });

    it('accepts user overrides', () => {
        const result = configSchema.parse({
            projectId: 'x', repoRoot: '/tmp',
            docs: { chunkTokens: 200, respectGitignore: false },
        });
        expect(result.docs.chunkTokens).toBe(200);
        expect(result.docs.respectGitignore).toBe(false);
    });
});
```

- [ ] **Step 3: Run and verify failure**

```bash
pnpm test src/core/config.docs.test.ts
```

- [ ] **Step 4: Add the `docs` field to the schema**

Inside the existing `configSchema` (zod object), add:

```ts
docs: z.object({
    include: z.array(z.string()).default([
        'README.md',
        'docs/**/*.md',
        'apps/*/README.md',
        'libs/*/README.md',
        'packages/*/README.md',
        'CHANGELOG.md',
        'ROADMAP.md',
    ]),
    exclude: z.array(z.string()).default([
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/.next/**',
        '**/coverage/**',
        'LICENSE.md',
        '.github/**/*.md',
    ]),
    respectGitignore: z.boolean().default(true),
    chunkTokens: z.number().int().positive().default(100),
    maxFileBytes: z.number().int().positive().default(10 * 1024 * 1024),
}).default({}),
```

- [ ] **Step 5: Run tests + typecheck**

```bash
pnpm test src/core/config.docs.test.ts
pnpm exec tsc --noEmit
```

Expected: PASS (3/3), 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/config.ts src/core/config.docs.test.ts
git commit -m "feat(arch-graph): add docs.* config schema with production defaults"
```

---

## Task 7: Mapper — `mapper/docs-to-graph.ts`

**Files:**
- Create: `src/mapper/docs-to-graph.ts`
- Test: `src/mapper/docs-to-graph.test.ts`

Turns `ExtractedDocSite[]` into `GraphNode[]`. Uses `buildAnchor` from `mapper/anchor.ts` (existing) for the brand cast — no new constructor needed.

- [ ] **Step 1: Write failing test**

Create `src/mapper/docs-to-graph.test.ts`:

```ts
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
```

- [ ] **Step 2: Run and verify failure**

```bash
pnpm test src/mapper/docs-to-graph.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/mapper/docs-to-graph.ts`:

```ts
/**
 * Convert ExtractedDocSite[] into GraphNode[] of kind 'doc-section'.
 *
 * Node ID:  doc-section:<relpath>#<slug>
 *           slug already includes per-file collision counter and --part-N
 *           suffix, so id is unique by construction.
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
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/mapper/docs-to-graph.test.ts
```

Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/mapper/docs-to-graph.ts src/mapper/docs-to-graph.test.ts
git commit -m "feat(arch-graph): docs-to-graph mapper — GraphNode emission for doc-section"
```

---

## Task 8: Snippet renderer — `case 'doc-section':` in `semantic/snippet.ts`

**Files:**
- Modify: `src/semantic/snippet.ts`
- Test: `src/semantic/snippet-kinds.test.ts` (existing, add doc-section block)

Reads body from disk by `path` + `[startLine, endLine]`, prepends heading-chain prefix `# A > B > C\n\n`. Caps at 800 chars (relaxed cap mirroring fe-component).

The dispatch in `extractSnippet` calls `getSourceFile(node.path)` which returns null for `.md` files (ts-morph Project doesn't have them). Guard doc-section BEFORE that call so we never depend on ts-morph for docs.

- [ ] **Step 1: Write failing test**

In `src/semantic/snippet-kinds.test.ts` (append at end, inside the existing top-level describe or as a new describe):

```ts
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { Project } from 'ts-morph';
import { extractSnippet } from './snippet.js';
import type { GraphNode } from '../core/types.js';

const FIXTURE_PATH = resolve(__dirname, '../__fixtures__/docs/sample/README.md');

describe('extractSnippet — doc-section', () => {
    function makeNode(overrides: Partial<GraphNode>): GraphNode {
        return {
            id: 'doc-section:README.md#installation',
            kind: 'doc-section',
            label: 'Installation',
            path: FIXTURE_PATH,
            anchor: 'installation' as GraphNode['anchor'],
            meta: {
                headingChain: ['Sample Project', 'Installation'],
                headingLevel: 2,
                startLine: 6,   // line right after "## Installation"
                endLine: 7,
                charCount: 16,
                tokenCount: 4,
                wasSplit: false,
            },
            ...overrides,
        };
    }

    it('reads body from file and prepends heading-chain prefix', () => {
        const project = new Project({ useInMemoryFileSystem: false });
        const result = extractSnippet(project, makeNode({}));
        expect(result.reason).toBeUndefined();
        expect(result.snippet.startsWith('# Sample Project > Installation')).toBe(true);
        expect(result.snippet).toContain('How to install.');
    });

    it('returns reason=file-not-found when path is absent on disk', () => {
        const project = new Project({ useInMemoryFileSystem: false });
        const result = extractSnippet(project, makeNode({ path: '/no/such/file.md' }));
        expect(result.snippet).toBe('');
        expect(result.reason?.kind).toBe('file-not-found');
    });

    it('handles __root__ node (no headings) with file-label prefix', () => {
        const project = new Project({ useInMemoryFileSystem: false });
        const node = makeNode({
            id: 'doc-section:README.md#__root__',
            label: 'README',
            meta: {
                headingChain: [],
                headingLevel: 0,
                startLine: 1,
                endLine: 3,
                charCount: 0,
                tokenCount: 0,
                wasSplit: false,
            },
        });
        const result = extractSnippet(project, node);
        expect(result.snippet.startsWith('# README')).toBe(true);
    });
});
```

- [ ] **Step 2: Run and verify failure**

```bash
pnpm test src/semantic/snippet-kinds.test.ts -t "doc-section"
```

Expected: FAIL — likely empty snippet or wrong reason.

- [ ] **Step 3: Implement**

In `src/semantic/snippet.ts`:

(a) Near the top constants block, add:

```ts
/** Relaxed snippet cap for doc-section (header chain + adaptive-sized chunk). */
export const DOC_SECTION_SNIPPET_MAX_CHARS = 800;
```

(b) Add the `readFileSync` import:

```ts
import { readFileSync } from 'node:fs';
```

(c) In `extractSnippet(project, node)`, after the `if (!node.path) return { snippet: '' };` early return, insert:

```ts
if (node.kind === 'doc-section') {
    return extractDocSectionSnippet(node);
}
```

(d) At the bottom of the file (near other private `extract*Snippet` helpers), add:

```ts
function formatHeadingChain(chain: readonly string[], fileLabel: string): string {
    if (chain.length === 0) return `# ${fileLabel}\n\n`;
    return `# ${chain.join(' > ')}\n\n`;
}

function extractDocSectionSnippet(node: GraphNode): SnippetResult {
    if (!node.path) {
        return { snippet: '' };
    }
    const meta = node.meta as
        | { headingChain?: string[]; startLine?: number; endLine?: number }
        | undefined;
    if (meta === undefined || meta.startLine === undefined || meta.endLine === undefined) {
        return { snippet: '', reason: { kind: 'label-not-located', label: node.label } };
    }

    let raw: string;
    try {
        raw = readFileSync(node.path, 'utf8');
    } catch {
        return { snippet: '', reason: { kind: 'file-not-found', path: node.path } };
    }

    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const start = Math.max(0, meta.startLine - 1);
    const end = Math.min(lines.length, meta.endLine);
    const bodySlice = lines.slice(start, end).join('\n');

    const prefix = formatHeadingChain(meta.headingChain ?? [], node.label);
    let snippet = prefix + bodySlice;
    if (snippet.length > DOC_SECTION_SNIPPET_MAX_CHARS) {
        snippet = snippet.slice(0, DOC_SECTION_SNIPPET_MAX_CHARS);
    }
    return { snippet };
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/semantic/snippet-kinds.test.ts -t "doc-section"
pnpm test src/semantic/                                        # full file
pnpm exec tsc --noEmit
```

Expected: doc-section tests PASS, no regression in existing tests, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/semantic/snippet.ts src/semantic/snippet-kinds.test.ts
git commit -m "feat(arch-graph): snippet renderer for doc-section — line-range + heading-chain prefix"
```

---

## Task 9: Snippet-recall validator — guard test for doc-section inclusion

**Files:**
- Modify: `src/validation/snippet-recall-validator.test.ts`

`doc-section` is implicitly in the recall denominator because it's NOT in `KINDS_WITHOUT_SOURCE`. We lock that invariant with a test.

- [ ] **Step 1: Confirm doc-section is NOT in KINDS_WITHOUT_SOURCE**

```bash
grep -A 10 "KINDS_WITHOUT_SOURCE" src/validation/snippet-recall-validator.ts
```

Expected: set contains `nats-subject, db-table, queue, external, lib, service` — `doc-section` MUST NOT appear.

- [ ] **Step 2: Add a guard test**

At the bottom of `src/validation/snippet-recall-validator.test.ts`:

```ts
import { KINDS_WITHOUT_SOURCE } from './snippet-recall-validator.js';

describe('doc-section recall contract', () => {
    it('is NOT in KINDS_WITHOUT_SOURCE (must contribute to recall denominator)', () => {
        expect(KINDS_WITHOUT_SOURCE.has('doc-section' as const)).toBe(false);
    });
});
```

(`KINDS_WITHOUT_SOURCE` may already be imported at the top of that test file. If so, drop the duplicate import.)

- [ ] **Step 3: Run**

```bash
pnpm test src/validation/snippet-recall-validator.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/validation/snippet-recall-validator.test.ts
git commit -m "test(arch-graph): lock doc-section in snippet-recall denominator"
```

---

## Task 10: Pipeline wiring — call docs extractor + mapper in `pipeline/build.ts`

**Files:**
- Modify: `src/pipeline/build.ts`
- Modify or add: `src/pipeline/build.test.ts`

- [ ] **Step 1: Write failing test**

In `src/pipeline/build.test.ts`, add:

```ts
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { configSchema } from '../core/config.js';      // adjust to actual path
import { build } from './build.js';

describe('build — docs pass', () => {
    it('emits doc-section nodes when docs.include matches files', async () => {
        const fixtureRoot = resolve(__dirname, '../__fixtures__/docs/sample');
        const cfg = configSchema.parse({
            projectId: 'docs-test',
            repoRoot: fixtureRoot,
            appsGlob: 'apps/*',
            libsGlob: 'libs/*',
            docs: {
                include: ['README.md', 'ADR.md'],
                exclude: [],
                respectGitignore: false,
                chunkTokens: 100,
                maxFileBytes: 10_000_000,
            },
        });

        const result = await build(cfg);

        const docNodes = result.graph.nodes.filter(n => n.kind === 'doc-section');
        expect(docNodes.length).toBeGreaterThan(0);
        expect(result.diagnostics.docs).toBeDefined();
        expect(result.diagnostics.docs!.counts.nodesEmitted).toBe(docNodes.length);
    });
});
```

If `configSchema` requires additional non-default fields, fill them. The point is to give `build()` a valid `ArchGraphConfig` with the docs section populated.

- [ ] **Step 2: Run and verify failure**

```bash
pnpm test src/pipeline/build.test.ts -t "docs pass"
```

Expected: FAIL — `result.diagnostics.docs` undefined.

- [ ] **Step 3: Wire docs into the pipeline**

In `src/pipeline/build.ts`, add imports near the top:

```ts
import { extractDocs } from '../extractors/docs/extract-docs.js';
import { mapDocsToGraph } from '../mapper/docs-to-graph.js';
import { countTokens } from '../semantic/tokenizer.js';
```

Inside the `build(config: ArchGraphConfig): Promise<BuildResult>` function, AFTER `assembleGraph(...)` populates `graph` and the diagnostics/validation accumulators are initialised, add:

```ts
// ─── docs pass ────────────────────────────────────────────────────────────
const docs = await extractDocs({
    projectRoot: config.repoRoot,
    include: config.docs.include,
    exclude: config.docs.exclude,
    respectGitignore: config.docs.respectGitignore,
    chunkTokens: config.docs.chunkTokens,
    maxFileBytes: config.docs.maxFileBytes,
    countTokens,
});
const docNodes = mapDocsToGraph(docs.sites, config.repoRoot);
graph.nodes.push(...docNodes);
diagnostics.docs = docs.diagnostics;
```

Note: the existing test fixtures live under `src/__fixtures__/docs/sample/` — `extractDocs` will use them via the fixtureRoot passed in tests.

If config.docs may legally be undefined (because schema is `.default({})` and parse-time was bypassed), wrap with `if (config.docs !== undefined) { ... }` for defensive safety.

- [ ] **Step 4: Run pipeline tests + full suite**

```bash
pnpm test src/pipeline/build.test.ts
pnpm test
pnpm exec tsc --noEmit
```

Expected: docs-pass test PASS, all existing tests PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/build.ts src/pipeline/build.test.ts
git commit -m "feat(arch-graph): wire docs extractor + mapper into build pipeline"
```

---

## Task 11: Docs validator — file-coverage gate

**Files:**
- Create: `src/validation/docs-validator.ts`
- Test: `src/validation/docs-validator.test.ts`
- Modify: `src/pipeline/build.ts` (call validator, attach result)

- [ ] **Step 1: Write failing test**

Create `src/validation/docs-validator.test.ts`:

```ts
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

    it('does not count gitignored/excluded-by-config against recall', () => {
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
});
```

- [ ] **Step 2: Run and verify failure**

```bash
pnpm test src/validation/docs-validator.test.ts
```

- [ ] **Step 3: Implement**

Create `src/validation/docs-validator.ts`:

```ts
/**
 * Docs-domain file-coverage validator.
 *
 * Invariant: every file in the resolved-include set (counts.filesIncluded)
 * must be EITHER processed (produced ≥1 doc-section node) OR present in
 * filesSkipped with a real reason. User-excluded reasons (gitignored,
 * excluded-by-config) are NOT counted against recall.
 */

import type { DocsDiagnostics, DocsValidationReport, GraphNode } from '../core/types.js';

const REAL_SKIP_REASONS = new Set(['oversized', 'non-utf8', 'empty']);

export function validateDocs(
    diagnostics: DocsDiagnostics,
    allNodes: GraphNode[],
): DocsValidationReport {
    const filesIncluded = diagnostics.counts.filesIncluded;
    const docNodes = allNodes.filter(n => n.kind === 'doc-section');
    const processedFiles = new Set(
        docNodes.map(n => n.path).filter((p): p is string => p !== undefined),
    );

    let realSkipped = 0;
    let userExcluded = 0;
    for (const s of diagnostics.filesSkipped) {
        if (REAL_SKIP_REASONS.has(s.reason)) realSkipped += 1;
        else userExcluded += 1;
    }

    const denominator = Math.max(0, filesIncluded - userExcluded);
    const numerator = processedFiles.size + realSkipped;
    const recall = denominator === 0 ? 1 : numerator / denominator;
    const meetsFloor = denominator === 0 || recall >= 1;

    return {
        summary: {
            filesIncluded,
            filesProcessed: processedFiles.size,
            filesSkippedWithReason: realSkipped,
            recall,
            meetsFloor,
        },
    };
}
```

- [ ] **Step 4: Wire into pipeline**

In `src/pipeline/build.ts`, after the docs pass, add:

```ts
import { validateDocs } from '../validation/docs-validator.js';

// ... after `diagnostics.docs = docs.diagnostics;` ...
validation.docs = validateDocs(docs.diagnostics, graph.nodes);
```

(`validation` is the local `BuildValidation` accumulator — keep the actual local name as-is in the file.)

- [ ] **Step 5: Run tests + typecheck**

```bash
pnpm test src/validation/docs-validator.test.ts
pnpm exec tsc --noEmit
```

Expected: PASS (4/4), 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/validation/docs-validator.ts src/validation/docs-validator.test.ts src/pipeline/build.ts
git commit -m "feat(arch-graph): file-coverage validator for docs (recall floor 1.0)"
```

---

## Task 12: Interactive init — docs discovery prompts

**Files:**
- Modify: `src/cli/init.ts`
- Test: `src/cli/init.docs.test.ts` (new)

Add docs questions to the wizard after the existing domain block. TTY guard: don't prompt in non-TTY mode (defaults from zod apply).

- [ ] **Step 1: Read current init flow**

Read all of `src/cli/init.ts`. Identify:
- The `WizardAnswers` interface.
- The `runInit` (or similar) function with `createInterface`.
- The non-TTY fallback (probably checks `input.isTTY`).
- `buildConfigTemplate(answers)` and where blocks are interpolated.

- [ ] **Step 2: Write failing test**

Create `src/cli/init.docs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildConfigTemplate } from './init.js';

describe('init — docs block in config template', () => {
    it('emits docs.include with user-curated extras', () => {
        const answers = makeAnswers({
            docs: {
                respectGitignore: true,
                chunkTokens: 100,
                userInclude: ['docs/adr/0001-foo.md'],
                userExclude: ['tools/scripts/HOWTO.md'],
            },
        });
        const tpl = buildConfigTemplate(answers);
        expect(tpl).toContain('docs:');
        expect(tpl).toContain("'docs/adr/0001-foo.md'");
        expect(tpl).toContain("'tools/scripts/HOWTO.md'");
        expect(tpl).toContain('chunkTokens: 100');
        expect(tpl).toContain('respectGitignore: true');
    });

    it('omits docs block entirely when answers.docs is undefined', () => {
        const answers = makeAnswers({});
        const tpl = buildConfigTemplate(answers);
        // No `docs:` field — defaults flow from zod.
        expect(tpl.includes('docs:')).toBe(false);
    });
});

function makeAnswers(overrides: Partial<{
    docs: {
        respectGitignore: boolean;
        chunkTokens: number;
        userInclude: string[];
        userExclude: string[];
    };
}>) {
    return {
        projectId: 'demo',
        repoRoot: '/tmp',
        appsGlob: 'apps/*',
        libsGlob: 'libs/*',
        domains: [],
        natsWrapper: false,
        natsWrapperClass: '',
        natsWrapperPublishMethods: [],
        natsWrapperSubscribeMethods: [],
        installClaude: false,
        hookMode: 'none' as const,
        strictMode: false,
        runBuild: false,
        ...overrides,
    };
}
```

- [ ] **Step 3: Run and verify failure**

```bash
pnpm test src/cli/init.docs.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement**

In `src/cli/init.ts`:

(a) Extend `WizardAnswers`:

```ts
interface WizardAnswers {
    // ... existing fields ...
    docs?: {
        respectGitignore: boolean;
        chunkTokens: number;
        userInclude: string[];
        userExclude: string[];
    };
}
```

(b) Add discovery helper (top-of-file or near other helpers):

```ts
import { execFileSync } from 'node:child_process';
import { relative as relPath } from 'node:path';
import fastGlob from 'fast-glob';

const DEFAULT_DOC_INCLUDE = [
    'README.md',
    'docs/**/*.md',
    'apps/*/README.md',
    'libs/*/README.md',
    'packages/*/README.md',
    'CHANGELOG.md',
    'ROADMAP.md',
];

async function discoverExtraMdFiles(repoRoot: string, respectGitignore: boolean): Promise<string[]> {
    let all: string[];
    if (respectGitignore) {
        try {
            const stdout = execFileSync('git', ['-C', repoRoot, 'ls-files', '--', '*.md'], {
                encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
            });
            all = stdout.split('\n').filter(s => s.length > 0);
        } catch {
            all = await fastGlob(['**/*.md'], {
                cwd: repoRoot, ignore: ['**/node_modules/**'], dot: false,
            });
        }
    } else {
        all = await fastGlob(['**/*.md'], {
            cwd: repoRoot, ignore: ['**/node_modules/**'], dot: false,
        });
    }
    const defaultMatches = new Set(await fastGlob(DEFAULT_DOC_INCLUDE, { cwd: repoRoot }));
    return all.filter(f => !defaultMatches.has(f)).sort();
}
```

(c) Add the docs prompt block (somewhere between existing domain prompts and the final `runBuild?` question):

```ts
async function askDocs(
    rl: ReturnType<typeof createInterface>,
    repoRoot: string,
): Promise<WizardAnswers['docs']> {
    const ignoreAns = (await rl.question('Use .gitignore when scanning .md? [Y/n] '))
        .trim().toLowerCase();
    const respectGitignore = ignoreAns !== 'n' && ignoreAns !== 'no';

    const candidates = await discoverExtraMdFiles(repoRoot, respectGitignore);
    const userInclude: string[] = [];
    const userExclude: string[] = [];

    if (candidates.length > 0) {
        process.stdout.write(
            `\nFound .md files outside defaults — for each, press enter to include, type '!' to exclude, or 's' to skip:\n`,
        );
        for (const c of candidates) {
            const ans = (await rl.question(`  ${c} [include/!exclude/skip]: `))
                .trim().toLowerCase();
            if (ans === '!' || ans === 'exclude') userExclude.push(c);
            else if (ans === 's' || ans === 'skip') continue;
            else userInclude.push(c);
        }
    }

    const tokensAns = (await rl.question(
        'Chunk tokens per section (BERT tokens, embedder context 128)? [100] ',
    )).trim();
    const chunkTokens = tokensAns === '' ? 100 : Math.max(1, Number.parseInt(tokensAns, 10) || 100);

    return { respectGitignore, chunkTokens, userInclude, userExclude };
}
```

(d) Call from `runInit` after existing prompts:

```ts
if (input.isTTY) {
    answers.docs = await askDocs(rl, answers.repoRoot);
}
```

(e) Update `buildConfigTemplate`. Add a block builder:

```ts
function docsBlock(a: WizardAnswers): string {
    if (a.docs === undefined) return '';
    const customInclude = a.docs.userInclude.length > 0
        ? `        include: [${[...DEFAULT_DOC_INCLUDE, ...a.docs.userInclude].map(q).join(', ')}],\n`
        : '';
    const customExclude = a.docs.userExclude.length > 0
        ? `        exclude: [${a.docs.userExclude.map(q).join(', ')}],\n`
        : '';
    return `    docs: {\n${customInclude}${customExclude}        respectGitignore: ${a.docs.respectGitignore},\n        chunkTokens: ${a.docs.chunkTokens},\n    },\n`;
}
```

Splice `docsBlock(a)` into the final template — find the existing pattern (e.g. where `natsBlock` is included) and add `${docsBlock(a)}` next to it.

- [ ] **Step 5: Run tests**

```bash
pnpm test src/cli/init.docs.test.ts
pnpm exec tsc --noEmit
```

Expected: PASS (2/2), 0 type errors.

- [ ] **Step 6: Manual smoke**

```bash
mkdir -p /tmp/init-smoke && cd /tmp/init-smoke && git init -q && echo "# foo" > README.md && echo "# extra" > NOTES.md
pnpm --dir /Users/romandubovik/Documents/Projects/arch-graph exec tsx /Users/romandubovik/Documents/Projects/arch-graph/src/cli/index.ts init
```

Walk through prompts; verify generated config has the `docs:` block with your selections.

- [ ] **Step 7: Commit**

```bash
git add src/cli/init.ts src/cli/init.docs.test.ts
git commit -m "feat(arch-graph): init wizard — docs discovery prompts (gitignore-aware)"
```

---

## Task 13: Semantic build + MCP filter — integration tests

**Files:**
- Modify: `src/semantic/builder.test.ts` (add doc-section block)
- Modify: `src/mcp/semantic-search.test.ts` (add doc-section block)

- [ ] **Step 1: Read existing builder + MCP test patterns**

```bash
wc -l src/semantic/builder.test.ts src/mcp/semantic-search.test.ts
```

Open both, find the public entry points the existing tests use (e.g. `buildSemanticIndex(graph, ...)`, `semanticSearch(opts, root)`).

- [ ] **Step 2: Add builder test for doc-section**

Add to `src/semantic/builder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import type { GraphNode } from '../core/types.js';
// Adjust this import to whatever the builder's public function is:
// import { buildSemanticIndex } from './builder.js';

describe('semantic builder — doc-section', () => {
    it('produces a SemanticRecord with non-empty snippet for a doc-section node', async () => {
        const node: GraphNode = {
            id: 'doc-section:src/__fixtures__/docs/sample/README.md#installation',
            kind: 'doc-section',
            label: 'Installation',
            path: resolve(__dirname, '../__fixtures__/docs/sample/README.md'),
            anchor: 'installation' as GraphNode['anchor'],
            meta: {
                headingChain: ['Sample Project', 'Installation'],
                headingLevel: 2,
                startLine: 6, endLine: 7,
                charCount: 16, tokenCount: 4, wasSplit: false,
            },
        };

        // EDIT BELOW: replace with the real builder entry point. The test asserts:
        //   1. exactly 1 record produced
        //   2. record.kind === 'doc-section'
        //   3. record.snippet.length > 0
        //   4. record.snippet starts with '# Sample Project > Installation'
        //   5. record.vector.length === 384
        //
        // Example pattern (adapt to real API):
        // const records = await buildSemanticIndex({ nodes: [node], edges: [] } as any);
        // expect(records).toHaveLength(1);
        // expect(records[0].kind).toBe('doc-section');
        // expect(records[0].snippet.startsWith('# Sample Project > Installation')).toBe(true);
        // expect(records[0].vector.length).toBe(384);
    });
});
```

If `buildSemanticIndex` is private and only the top-level `semantic build` CLI is testable, write a tmpdir-based integration test that runs `semantic build` against the fixture graph and reads back `embeddings.jsonl`.

- [ ] **Step 3: Add MCP filter test**

In `src/mcp/semantic-search.test.ts`:

```ts
describe('semanticSearch — doc-section filter', () => {
    it('returns only doc-section nodes when kinds: [doc-section]', async () => {
        // Build a small in-memory or tmpdir sidecar with mixed kinds (1+ doc-section).
        // Call semanticSearch({ query: 'install', kinds: ['doc-section'] }, ...).
        // Assert every result has kind === 'doc-section'.
    });
});
```

(Replicate the structure of existing tests in this file — they likely set up a tmpdir sidecar via the builder, then call the search function.)

- [ ] **Step 4: Run + iterate**

```bash
pnpm test src/semantic/builder.test.ts -t "doc-section"
pnpm test src/mcp/semantic-search.test.ts -t "doc-section"
```

Adapt imports until tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/semantic/builder.test.ts src/mcp/semantic-search.test.ts
git commit -m "test(arch-graph): semantic builder + MCP filter coverage for doc-section"
```

---

## Task 14: End-to-end verification on a reference project

**Files:** none committed (manual verification + AC checklist)

- [ ] **Step 1: Build arch-graph itself**

```bash
cd /Users/romandubovik/Documents/Projects/arch-graph
pnpm exec tsx src/cli/index.ts build
```

Then inspect graph.json:

```bash
jq '[.nodes[] | select(.kind == "doc-section")] | length' arch-graph-out/arch-graph/graph.json
jq '[.nodes[] | select(.kind == "doc-section")][0:3]' arch-graph-out/arch-graph/graph.json
```

Expected: ≥ 1 doc-section node with valid shape (id, label, path, anchor, meta).

- [ ] **Step 2: Build semantic index**

```bash
pnpm exec tsx src/cli/index.ts semantic build
```

Then:

```bash
grep -m 1 '"kind":"doc-section"' arch-graph-out/arch-graph/semantic/embeddings.jsonl | jq .
```

Expected: a record with non-empty `snippet`, 384-dim `vector`.

- [ ] **Step 3: MCP semanticSearch smoke**

```bash
pnpm exec tsx -e "
import { semanticSearch } from './src/mcp/semantic-search.js';
const r = await semanticSearch(
    { query: 'installation', kinds: ['doc-section'] },
    '/Users/romandubovik/Documents/Projects/arch-graph',
);
console.log(JSON.stringify(r.slice(0, 3), null, 2));
" || echo "Adjust the import path or call signature to match the real export."
```

Expected: top-3 doc-section results, all with `kind === 'doc-section'`.

- [ ] **Step 4: Token-economy sanity check (DS-AC11)**

Sum embedder-token counts across the top-5 results. Should be < 3000 tokens for a typical doc query. Use the existing tokenizer:

```bash
pnpm exec tsx -e "
import { countTokens } from './src/semantic/tokenizer.js';
import { semanticSearch } from './src/mcp/semantic-search.js';
const r = await semanticSearch({ query: 'install', kinds: ['doc-section'] }, process.cwd());
let total = 0;
for (const item of r.slice(0, 5)) total += await countTokens(item.snippet ?? '');
console.log('top-5 total embedder tokens:', total);
"
```

Expected: number < 3000.

- [ ] **Step 5: Walk through AC checklist**

For each of DS-AC1..DS-AC12 from the design doc, tick a box (next section). If any AC fails, fix before proceeding to Task 15.

---

## Task 15: Full QG + pr-review-toolkit + merge to develop

- [ ] **Step 1: Full quality gate**

```bash
pnpm exec tsc --noEmit
pnpm test
```

Optional if lint script is configured:

```bash
pnpm exec eslint src --max-warnings=0
```

Expected: 0 type errors, all tests PASS (≥ 981 existing + new tests).

- [ ] **Step 2: pr-review-toolkit (run in parallel)**

Dispatch the team-lead's standard parallel review (5 agents):
- `pr-review-toolkit:code-reviewer`
- `pr-review-toolkit:silent-failure-hunter`
- `pr-review-toolkit:pr-test-analyzer`
- `pr-review-toolkit:type-design-analyzer` (new types: DocsDiagnostics, DocsValidationReport, DocsSkipReason, DocSite)
- `pr-review-toolkit:comment-analyzer` (multiple new doc blocks)

Iterate fix → re-review until 0 P0 + 0 P1 (typically 2-3 rounds; see MEMORY.md `feedback_fix_introduces_regression.md`).

- [ ] **Step 3: Sync with develop + merge**

```bash
git -C <worktree> fetch origin
git -C <worktree> merge origin/develop
# resolve conflicts if any, re-run pnpm test
git -C <main-tree> checkout develop
git -C <main-tree> merge --no-ff <feature-branch>
git -C <main-tree> push origin develop
```

- [ ] **Step 4: Tag + v_-rename design files**

```bash
git -C <main-tree> tag doc-section-v1
git -C <main-tree> mv docs/plans/2026-05-17-doc-section-extractor-design.md docs/plans/v_2026-05-17-doc-section-extractor-design.md
git -C <main-tree> mv docs/plans/2026-05-17-doc-section-extractor-implementation.md docs/plans/v_2026-05-17-doc-section-extractor-implementation.md
git -C <main-tree> commit -m "docs(arch-graph): mark doc-section design+plan as shipped (v_-rename)"
git -C <main-tree> push origin develop --tags
```

- [ ] **Step 5: Regenerate graphify-out**

```bash
graphify update .
```

- [ ] **Step 6: Cleanup worktree**

```bash
git worktree remove .claude/worktrees/<branch>
git branch -d <feature-branch>
```

---

## Acceptance Criteria checklist (mirrors design doc)

After Task 14, verify each AC from `docs/plans/2026-05-17-doc-section-extractor-design.md`:

- [ ] **DS-AC1** — `'doc-section'` in NodeKind/NODE_KIND_VALUES/NODE_KIND_CHECK; no exhaustiveness errors anywhere
- [ ] **DS-AC2** — `arch-graph build` on reference project emits non-empty doc-section bucket; nodes pass shape validation
- [ ] **DS-AC3** — `arch-graph init` interactive flow writes correct docs config (both gitignore branches)
- [ ] **DS-AC4** — adaptive split: oversized section → wasSplit:true with chunkOf>1; small → wasSplit:false
- [ ] **DS-AC5** — code-fence containment: `# foo` inside ` ``` ` produces 0 nodes from those lines
- [ ] **DS-AC6** — slug collisions: two `## Setup` → `setup`, `setup-1`; ids distinct
- [ ] **DS-AC7** — frontmatter: valid YAML attaches; broken YAML → diagnostic, no crash
- [ ] **DS-AC8** — `semanticSearch({ kinds: ['doc-section'] })` returns only doc-section; relevant result in top-3
- [ ] **DS-AC9** — file-coverage validator: recall = 1.0 on reference project
- [ ] **DS-AC10** — snippet-recall: doc-section meets 85% floor (trivially 100%)
- [ ] **DS-AC11** — token-economy sanity: top-5 search < 3000 embedder-tokens
- [ ] **DS-AC12** — all existing tests still pass; `tsc --noEmit` returns 0 errors (excl. `__fixtures__/`)

---

## Notes for the implementing engineer

1. **CWD trap.** Every git command uses `git -C <abs-path>` form OR assumes you have `cd`-ed into the worktree at the top of your session. Don't `git switch develop` inside the worktree — pollutes main.
2. **Selective `git add`.** Stage only files relevant to the task at hand. Run `git status` between tasks; it should be empty (or only contain unrelated pnpm-lock changes if Task 1 hasn't run yet).
3. **`pnpm-lock.yaml`.** Task 1 modifies it (moving js-yaml). Commit it alongside `package.json` in Task 1. Other tasks should not touch it.
4. **Tests first.** Each task explicitly writes the failing test before code. Don't skip — the test catches subtle deviations from the spec.
5. **`@xenova/transformers` first-run cost.** Task 2 will cache the tokenizer on disk; subsequent test runs are fast. CI might need a warmup or a pre-cached HuggingFace dir.
6. **Shell-out safety.** All `git` invocations use `execFileSync` (no shell). Do NOT introduce `execSync(\`git ... ${variable}\`)` — even when escaping looks fine, the project convention is shell-free invocation.
