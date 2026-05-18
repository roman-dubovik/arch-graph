# Design: doc-section — Markdown sections as a new graph kind

Date: 2026-05-17
Status: READY TO EXECUTE
Target branch: `develop` (off `develop` HEAD `aa96710` — post `closing-tails-v1`)

## Goal

Add `doc-section` as a new `NodeKind` so Markdown sections (README, CHANGELOG,
ADRs, `docs/**/*.md`) become first-class graph nodes with embeddings, making
them retrievable via the existing `semanticSearch` MCP tool.

**Why:** the dominant user (a coding agent such as Claude Code) currently has no way
to recall project documentation while working on the code. Hand-grepping docs
burns tokens; full README dumps blow context budgets. A graph node per
adaptively-sized section, embedded with the same model as code snippets, lets
the agent retrieve only the relevant doc fragment — the same 10×-token-saving
mechanism that arch-graph already provides for code.

## Non-goals (v1)

- **No edges from doc-section** to code entities. `doc-mentions` (link to a
  referenced class/module/endpoint) is deferred to v2 once we measure RAG
  quality without it.
- **No drift detection.** Comparing docs against current code state is a
  separate problem.
- **No MDX/AsciiDoc/RST.** Only CommonMark `.md`.
- **No image/asset extraction.** Image refs stay as raw markdown in snippet
  text.
- **No multi-language cross-linking.** `README.ru.md` is treated as a separate
  file, not linked to `README.md`.
- **No custom-extension parsing** (Docusaurus admonitions, Notion callouts) —
  rendered as plain text.
- **No inline-link parsing** `[text](path)` — reserved for v2 (doc-mentions).

## File-touch matrix

| Task | Files (absolute paths) | Touches |
|------|------------------------|---------|
| T1 — NodeKind | `<arch-graph-root>/src/core/types.ts` | add `'doc-section'` to `NodeKind` union, `NODE_KIND_CHECK`, `DocsDiagnostics` interface, `DocsValidationReport` interface, extend `DiagnosticsReport.docs?` and `BuildValidation.docs?` |
| T2 — anchor constructor | `<arch-graph-root>/src/mapper/anchor.ts`, `<arch-graph-root>/src/mapper/anchor.test.ts` | add `buildDocAnchor(slug)` (or extend `buildAnchor` to accept doc-style input) — no `as Anchor` casts in doc code |
| T3 — slugify helper | `<arch-graph-root>/src/extractors/docs/slugify.ts`, `.test.ts` (new) | GitHub-compatible slug + per-file collision counter |
| T4 — markdown splitter | `<arch-graph-root>/src/extractors/docs/markdown-split.ts`, `.test.ts` (new) | pure function `splitMarkdown(text, { chunkTokens, countTokens }) => DocSite[]` — no I/O, fully testable |
| T5 — tokenizer wrapper | `<arch-graph-root>/src/semantic/tokenizer.ts`, `.test.ts` (new) | lazy `AutoTokenizer.from_pretrained(SEMANTIC_MODEL)` singleton, exposes `countTokens(text): Promise<number>` |
| T6 — file walker / extractor | `<arch-graph-root>/src/extractors/docs/extract-docs.ts`, `.test.ts` (new) | resolve include/exclude → file list (gitignore-aware), read + normalize + parse frontmatter + call `splitMarkdown` → `DocSite[]` + diagnostics |
| T7 — mapper | `<arch-graph-root>/src/mapper/docs-to-graph.ts`, `.test.ts` (new) | `DocSite[] × projectRoot → GraphNode[]` — produces ids, relative paths, doc-anchors |
| T8 — snippet renderer | `<arch-graph-root>/src/semantic/snippet.ts`, `snippet.test.ts` and/or `snippet-kinds.test.ts` | new `case 'doc-section':` — re-read file by `[startLine, endLine]`, prepend heading-chain prefix `# A > B > C\n\n`, return for embedding |
| T9 — pipeline wiring | `<arch-graph-root>/src/pipeline/build.ts`, `build.test.ts` | call `extractDocs` → `mapDocsToGraph` → merge nodes; pass `DocsDiagnostics` into `DiagnosticsReport.docs` |
| T10 — validator | `<arch-graph-root>/src/validation/docs-validator.ts`, `.test.ts` (new) | file-coverage gate (every resolved-included file is processed or in `filesSkipped`) |
| T11 — snippet-recall integration | `<arch-graph-root>/src/validation/snippet-recall-validator.ts`, existing tests | `doc-section` is NOT added to `KINDS_WITHOUT_SOURCE`. Existing 85% floor applies; trivially met by construction |
| T12 — config schema | `<arch-graph-root>/src/cli/project-registry.ts` (or co-located config zod) | add `docs?: DocsConfig` with `include`, `exclude`, `respectGitignore`, `chunkTokens` |
| T13 — interactive init | `<arch-graph-root>/src/cli/init.ts`, existing tests | extend `arch-graph init` with docs-discovery TUI: `respectGitignore?` → propose found-outside-defaults `.md` files → write `docs.include` |
| T14 — semantic build integration | `<arch-graph-root>/src/semantic/builder.ts`, tests | confirm `kind === 'doc-section'` flows through `buildSnippet` and produces a non-empty embedding entry; add to existing snippet-kinds test suite |
| T15 — MCP exposure | `<arch-graph-root>/src/mcp/server.ts`, schemas | `NODE_KIND_VALUES` already drives the `kinds` filter zod-enum; once T1 lands, MCP picks up `'doc-section'` automatically. Verify with one new test |
| T16 — js-yaml prod-dep | `<arch-graph-root>/package.json` | move `js-yaml` from `devDependencies` to `dependencies` (used at runtime for frontmatter) |

**T1 must land first** (everything else depends on the `NodeKind` literal).
T3, T4, T5 are pure-logic and can run in parallel after T1. T6 depends on T3+T4+T5.
T7 depends on T6. T8 depends on T7 (needs the `doc-section` node form). T9
depends on T6+T7. T10, T11, T14, T15 can run after T9. T12+T13 can run in
parallel with the extractor track.

No two tasks touch the same file → no merge conflicts within the task plan.

## Architecture

```
arch-graph build
   │
   ├── (existing) ts-morph passes → code-side nodes/edges
   │
   └── (new) docs pass
        │
        ├── resolveDocFiles(config, projectRoot)
        │     ├── fast-glob expansion of `include`
        │     ├── exclude filter
        │     ├── gitignore filter (git ls-files '*.md' ∩ include if respectGitignore)
        │     └── interactive-init may have written a curated list
        │
        ├── for each file:
        │     ├── read → BOM-strip → CRLF-normalize → UTF-8 check
        │     ├── frontmatter parse (js-yaml, soft-fail)
        │     └── splitMarkdown(body, { chunkTokens, countTokens }) → DocSite[]
        │
        ├── mapDocsToGraph(allSites, projectRoot) → GraphNode[] (kind: 'doc-section')
        │
        └── pipeline.build merges into graph.nodes; semantic builder embeds via snippet.ts
```

Snippet for embedding is reconstructed on demand from `path` + `meta.startLine` /
`meta.endLine` plus the heading-chain prefix — same pattern as every other kind
that lives in source. `graph.json` stores only line ranges, not bodies.

## Data model

### NodeKind extension

```ts
export type NodeKind =
    // ... existing 17 ...
    | 'doc-section';

const NODE_KIND_CHECK: Record<NodeKind, null> = {
    // ... existing entries ...
    'doc-section': null,
};
```

`NODE_KIND_VALUES` (derived) and all zod-enum / CLI-flag consumers update
automatically.

### GraphNode shape for doc-section

```ts
{
    id: 'doc-section:apps/web/README.md#installation--macos',
    kind: 'doc-section',
    label: 'macOS',                                          // last heading in chain
    path: 'apps/web/README.md',                              // relative to project root
    anchor: 'installation--macos' as Anchor,                 // built via buildDocAnchor
    meta: {
        headingChain: ['Installation', 'macOS'],             // root-to-leaf
        headingLevel: 3,                                     // 0 if file has no headings
        startLine: 42,                                       // 1-based, inclusive
        endLine: 78,                                         // 1-based, inclusive
        charCount: 1247,                                     // raw bytes of section body
        tokenCount: 312,                                     // BERT-tokenizer count, integer
        wasSplit: false,                                     // true if adaptive split fired
        chunkIndex?: 1,                                      // present iff wasSplit; 1..N
        chunkOf?: 3,                                         // present iff wasSplit
        frontmatter?: { ... },                               // present only on first node of file with valid YAML frontmatter
    }
}
```

**Decisions locked:**

- **`id` format** — `doc-section:` + relative path + `#` + anchor. Globally unique by construction (per-file slug collision-counter + per-file part-N suffix).
- **`anchor`** — GitHub-style slug. If `wasSplit` then suffix `--part-N` is ALWAYS appended (no implicit `part-1`); deterministic identity, no ambiguity between "split chunk" and "single section".
- **`label`** — last heading only, not the chain. Chain is in `meta.headingChain` for renderers that want context.
- **`path`** — relative to project root. Matches every other kind; portable `graph.json`.
- **No file body in `meta`.** Snippet reconstructed from disk via `path` + line range in `snippet.ts` (Blocker 2 fix — keeps `graph.json` lean).
- **Files without headings** → one node `id: doc-section:<path>#__root__`, `label = basename(path).replace(/\.md$/, '')`, `headingChain: []`, `headingLevel: 0`.

### DocSite (intermediate, in-memory only)

```ts
export interface DocSite {
    filePath: string;            // absolute — turned into relative in mapper
    headingChain: string[];      // [] for __root__ sites
    headingLevel: number;        // 1..6 for ATX/setext; 0 for __root__
    slug: string;                // full anchor including --part-N if wasSplit
    startLine: number;           // 1-based inclusive (heading line + 1, or first body line for __root__)
    endLine: number;             // 1-based inclusive (last body line)
    charCount: number;
    tokenCount: number;
    wasSplit: boolean;
    chunkIndex?: number;         // 1..N if wasSplit
    chunkOf?: number;
    frontmatter?: Record<string, unknown>;  // attached to the FIRST site of the file
}
```

No `text` field — body is not held in memory beyond split-time; `snippet.ts`
re-reads when embedding.

## Markdown parser (production rules)

Hand-rolled state machine in `markdown-split.ts`. Tested in isolation.

1. **Normalization** — CRLF → LF; strip BOM; run `Buffer.isUtf8(buf)`. Non-UTF-8
   files → emit `filesSkipped[].reason = 'non-utf8'`, no nodes produced.
2. **Oversize guard** — files > 10 MB (configurable as `docs.maxFileBytes`) →
   `filesSkipped[].reason = 'oversized'`. Defends against accidental large
   artefacts under `docs/`.
3. **Frontmatter** — only at line 1: if file starts with `---\n` and a closing
   `\n---\n` exists within the first 200 lines, parse the YAML between via
   `js-yaml.load(input, { schema: yaml.CORE_SCHEMA })`. Parse failure →
   `frontmatterErrors[]`, file continues without frontmatter. Body parsing
   starts after the closing `---`.
4. **Code-fence tracking** — toggles for both ` ``` ` and `~~~`. Inside a fence,
   `# foo` is content, NOT a heading. Closing fence must match opener (same
   char). This is the #1 bug in naive parsers.
5. **Headings**
   - ATX: `/^(#{1,6})\s+(.+?)\s*#*\s*$/` (trailing `#` allowed per CommonMark).
   - Setext: previous non-blank line followed by `^=+\s*$` (H1) or `^-+\s*$`
     (H2). Setext detection is suppressed inside fences and within frontmatter
     bounds.
6. **Slug**
   - lowercase, remove characters not matching `/[\wЀ-ӿ\- ]/u`, spaces
     → `-`, collapse repeated `-`.
   - Cyrillic kept as-is (Unicode `Ѐ-ӿ` allowed) — matches GitHub.
   - Empty slug after stripping (e.g. heading is just `🚀`) → fallback `section`.
   - Per-file collision: `seen.get(slug) ?? 0`; if seen → `slug-1`, `slug-2`, …
     (GitHub style).
7. **Adaptive split (BERT-tokens)**
   - Token threshold: `docs.chunkTokens` (default **100**), heading-chain prefix
     budget reserved separately (~28 tokens).
   - Base partition: split on H1 and H2 (every H1/H2 starts a new candidate
     section; H3+ stays inside its enclosing H2). Sections ≤ threshold → one
     site each.
   - Section > threshold:
     - If it contains H3+/H4+ → re-partition along those headings, recurse.
     - Else split on blank-line paragraph boundaries, packing paragraphs greedily
       up to threshold. Each resulting site gets `wasSplit: true`,
       `chunkIndex: i+1`, `chunkOf: N`, identical `headingChain`,
       differentiating `slug` via `--part-N` suffix.
     - A single paragraph that alone exceeds the threshold (long code block,
       wide table) → one oversized site, recorded in
       `oversizedChunks[]`. Splitting inside a code block would corrupt it and
       is worse than over-context.
8. **`__root__` site** — file with no headings: one site with
   `headingChain: []`, `headingLevel: 0`, `slug: '__root__'`, body = whole file
   (excluding frontmatter).
9. **HTML headings inside markdown** (`<h2>...</h2>`) — treated as content, not
   headings. We don't render HTML.

## Tokenizer (`semantic/tokenizer.ts`)

```ts
import { AutoTokenizer } from '@xenova/transformers';
import { SEMANTIC_MODEL } from './types.js';

let cached: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;

async function getTokenizer() {
    if (cached === null) {
        cached = await AutoTokenizer.from_pretrained(SEMANTIC_MODEL);
    }
    return cached;
}

export async function countTokens(text: string): Promise<number> {
    const tk = await getTokenizer();
    const enc = tk.encode(text);
    return enc.length;
}
```

Loads only the tokenizer (small ~5 MB JSON), not the model weights. Cached
across calls. Used by both `markdown-split.ts` (for chunk-sizing) and any
future code path that wants to measure embedding-token budget.

**Why not `@dqbd/tiktoken`** — that's `cl100k_base` (Claude's tokenizer); the
embedder is multilingual-MiniLM-L12-v2 which uses XLM-RoBERTa's SentencePiece.
A 500 cl100k chunk can be 600+ MiniLM tokens → silent truncation at embed
time. We MUST use the embedder's own tokenizer for chunk-sizing.

`@dqbd/tiktoken` stays available for reporting Claude-context budget
elsewhere if needed; it's not used in this feature.

## Snippet reconstruction (`semantic/snippet.ts`)

New branch in the existing `buildSnippet(node, ...)` dispatcher:

```ts
case 'doc-section': {
    const body = await readLineRange(node.path, node.meta.startLine, node.meta.endLine);
    const prefix = formatHeadingChain(node.meta.headingChain);
    return prefix + body;
}
```

`formatHeadingChain(['README', 'Installation', 'macOS'])` →
`"# README > Installation > macOS\n\n"`.

For `__root__` sites the prefix is `"# " + basename(path).replace(/\.md$/, '') + "\n\n"`.

`readLineRange` already exists in `snippet.ts` for code-snippet paths; we reuse
it. Body lines are concatenated as-is (markdown is preserved verbatim — code
blocks, lists, tables intact).

## Anchor format (`mapper/anchor.ts`)

```ts
/** doc-anchor builder — slug already collision-resolved and part-suffixed by extractor. */
export function buildDocAnchor(slug: string): Anchor {
    return slug as Anchor;
}
```

Minimal API: the slug is computed in `slugify.ts` (with collisions resolved
per-file and part-N suffix appended per `wasSplit`), so the constructor is a
thin branded wrapper. The point is to eliminate ad-hoc `as Anchor` casts in
`docs-to-graph.ts` — every Anchor in the codebase comes through a builder.

If `buildAnchor` already accepts bare strings, we add `buildDocAnchor` anyway
for grep-ability (`buildDocAnchor` is unambiguous in code review).

## Config schema

Added to the existing arch-graph config zod schema:

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

Missing `docs` field → behaves as if all defaults were applied. Backward-
compatible with existing arch-graph configs.

## Interactive `arch-graph init`

Adds a docs-discovery step to the existing init wizard (post-language-detect,
before final write):

```
[docs setup]
Use .gitignore when scanning .md files? [Y/n]

> Y → scan = (default include globs) ∪ (git ls-files '*.md' under project root)
> n → scan = (default include globs) ∪ (fast-glob '**/*.md' with default exclude)

Found .md files outside defaults (toggle to include in docs.include):

   [✓] CONTRIBUTING.md
   [✓] apps/api/docs/auth-flow.md
   [✓] docs/adr/0001-use-typeorm.md
   [ ] tools/scripts/HOWTO.md           (looks like internal tooling)

(space toggle, enter continue)

Chunk size (BERT tokens per section)? [100]

Writing docs.include to arch-graph.config.ts ...
```

**Behavior:**

- Files matching the **default include globs** are always included
  silently (no toggle needed).
- Files **outside** defaults are presented as a togglable list, default-checked
  when `respectGitignore: true`, default-unchecked when
  `respectGitignore: false`.
- User-deselected files are written to `docs.exclude` (so re-running init
  doesn't re-propose them).
- User-selected files are written to `docs.include` (appended after defaults).
- The chunk-tokens prompt is shown only on first init; subsequent inits reuse
  the existing value silently.

If the project is not a git repo and `respectGitignore: true` was answered,
we degrade to fast-glob with the default excludes and show a notice.

## Validator (`validation/docs-validator.ts`)

Two gates:

### 1. File-coverage gate (hard)

```ts
processedFiles  = files that produced ≥1 doc-section node
skippedFiles    = files in diagnostics.docs.filesSkipped (reason in
                  { 'oversized', 'non-utf8', 'empty' })
resolvedFiles   = files returned by resolveDocFiles() — already after
                  user-exclude filter; this is what we asked for, not what
                  the file system happens to contain

invariant: processedFiles ∪ skippedFiles === resolvedFiles
          (set equality, no orphans, no duplicates)
```

If the invariant breaks → validator returns `meetsFloor: false`, exit
code 1 under `--strict-recall`. Recall metric = `|processedFiles| / |resolvedFiles - excludedByConfig|`; floor 1.0.

**Excluded-by-config** does NOT count against recall — a file the user
explicitly deselected via interactive init or via `docs.exclude` is not a
miss.

### 2. Snippet-recall integration (soft, reuses existing)

`doc-section` is **not** added to `KINDS_WITHOUT_SOURCE` in
`snippet-recall-validator.ts`. The existing 85 % floor applies; by
construction every doc-section has a non-empty body (`startLine ≤ endLine`),
so recall is 100 %. The integration's value is as a regression guard against
"extractor returned empty body" bugs in future changes.

### Diagnostics surface

```ts
export interface DocsDiagnostics {
    filesScanned: number;
    filesSkipped: Array<{
        path: string;
        reason: 'oversized' | 'non-utf8' | 'empty' | 'gitignored' | 'excluded-by-config';
    }>;
    frontmatterErrors: Array<{ path: string; error: string }>;
    oversizedChunks: Array<{ docSectionId: string; tokenCount: number }>;
    counts: {
        filesIncluded: number;        // resolved set size
        nodesEmitted: number;
        headingsTotal: number;
        sectionsSplit: number;
        filesWithFrontmatter: number;
    };
}
```

Added to `DiagnosticsReport.docs?: DocsDiagnostics`.

## Semantic + MCP integration

- **`builder.ts`** already iterates `graph.nodes`. Once T1 (NodeKind) and
  T7 (mapper) land, doc-section nodes flow through naturally. The only
  required wiring is T8 (`snippet.ts` `case 'doc-section':`).
- **MCP `semanticSearch`** — `NODE_KIND_VALUES` is the source for the
  `kinds` zod-enum filter (`src/mcp/server.ts`). After T1, agents can
  filter `kinds: ['doc-section']` or include docs in mixed-kind search
  without code changes.
- Add one MCP test asserting `semanticSearch({ query: 'install macos',
  kinds: ['doc-section'] })` on a fixture project returns only
  doc-section nodes with the expected file in top-3.

## Acceptance Criteria (v1)

**DS-AC1** — `'doc-section'` is in `NodeKind`, `NODE_KIND_VALUES`,
`NODE_KIND_CHECK`. TypeScript exhaustiveness on `node.kind` switches across
the codebase still compiles (no missing branches).

**DS-AC2** — `arch-graph build` on three reference projects (project-a /
project-b / project-c) produces a non-empty doc-section bucket in `graph.json`.
Every emitted node passes a shape-validator (id format, kind, path is
relative, anchor is non-empty, meta required fields present).

**DS-AC3** — Interactive `arch-graph init` works for both
`respectGitignore` branches: writes `docs.include` / `docs.exclude` to
the config; re-running init does not re-propose user-deselected files.

**DS-AC4** — Adaptive split (behavioural): given a fixture H2-section whose
content tokenizes (via the embedder's tokenizer) above `chunkTokens` →
extractor produces > 1 site with `wasSplit: true`, `chunkOf > 1`, same
`headingChain`, distinct `slug` (`--part-N` suffix). A second fixture
with content below threshold → one site with `wasSplit: false`.

**DS-AC5** — Code-fence containment: fixture with five `# foo` heading-like
lines inside ` ``` ` blocks → 0 doc-section nodes derived from them.

**DS-AC6** — Slug collisions: fixture file with two H2 "Setup" → first slug
`setup`, second `setup-1`. Anchors are distinct, ids are distinct.

**DS-AC7** — Frontmatter: fixture with valid YAML frontmatter → first node
carries `meta.frontmatter`; fixture with malformed YAML → no
`meta.frontmatter`, `DocsDiagnostics.frontmatterErrors[]` contains a record,
extraction does NOT throw.

**DS-AC8** — `semanticSearch({ query, kinds: ['doc-section'] })` returns
only doc-section nodes. On a controlled fixture project where exactly one
section talks about "installation on macOS", the query "install macos"
returns that section in the top-3 results (relative score, not absolute).

**DS-AC9** — File-coverage validator: on each reference project, every
file in the resolved-include set is either processed (≥1 node) or appears in
`filesSkipped` with a non-null reason. Recall = 1.0.

**DS-AC10** — Snippet-recall validator: with `doc-section` outside
`KINDS_WITHOUT_SOURCE`, recall ≥ 85 % (in practice 100 %) on all three
reference projects.

**DS-AC11** — Token-economy sanity: on a reference project, the sum of
embedder-tokens across the top-5 `semanticSearch` results for a typical
doc query is < 3000 tokens. Establishes the baseline for the
10×-economy claim (vs grep-the-whole-`docs/` fallback).

**DS-AC12** — No regression: all existing 981 tests still pass.
`tsc --noEmit 2>&1 | grep -cE 'error TS'` returns 0 (excluding
`__fixtures__/`).

## Test plan

- **`markdown-split.test.ts`** — pure unit. ≥ 25 cases covering:
  ATX/setext headings, fence containment, frontmatter delimiters vs
  setext-H2 ambiguity, adaptive split (under/over threshold, recursive H3
  re-partition, paragraph greedy packing, oversized single paragraph),
  `__root__` site, CRLF/BOM normalization.
- **`slugify.test.ts`** — ≥ 10 cases: ASCII, Cyrillic, mixed, emoji-only,
  empty after strip → `section`, collision counter, repeated dashes.
- **`extract-docs.test.ts`** — integration against fixtures in
  `src/__fixtures__/docs/`: a small README, an ADR with frontmatter, a
  CHANGELOG with many H2s, a malformed file (frontmatter parse error),
  a non-UTF-8 file.
- **`docs-to-graph.test.ts`** — `DocSite[] → GraphNode[]`: relative path,
  id format, anchor through `buildDocAnchor`, no `as Anchor` casts.
- **`docs-validator.test.ts`** — file-coverage invariant: missing file
  causes `meetsFloor: false`; presence in `filesSkipped` satisfies.
- **`tokenizer.test.ts`** — lazy load, idempotent, counts deterministic
  for a sample input.
- **CLI smoke** — extend `scripts/integration-test.sh` so a build over a
  fixture project that contains `.md` produces a non-zero
  `doc-section` count in `graph.json` and exits 0 under
  `--strict-recall`.

## Risks

- **Embedder context (128 tokens default)**. If `chunkTokens: 100` proves
  too aggressive (excessive split count on real projects) and we later
  want to relax to 200, the embedder will silently truncate beyond its
  native window unless we explicitly pass
  `truncation: true, max_length: 256` to the pipeline. Out of scope
  for v1; defer the experiment to a measured benchmark.

- **Markdown variants we don't handle**. Setext H3+ (doesn't exist;
  setext is H1/H2 only — fine), indented code blocks (rare in modern
  docs — content treated as text, may surface fake headings if someone
  indents `# foo` four spaces; acceptable false-positive risk).

- **`buildAnchor` API drift**. If `buildAnchor` in current code already
  accepts arbitrary slugs and we don't need a separate
  `buildDocAnchor`, T2 collapses to a no-op + a clarifying test. Inspect
  during implementation.

- **`init` UX on non-TTY**. The interactive list is meaningful only in
  TTY mode. On CI / non-TTY, init falls back to writing defaults
  silently (skip the questionnaire). Existing init likely already has
  this guard; verify.

- **Large monorepos with 1000+ `.md` files** (e.g. `docs/**/*.md` in a
  Docusaurus subproject). Node count explosion. Mitigation: defaults
  exclude `**/node_modules/**` and `**/build/**`; user can narrow via
  `docs.exclude`. Document this in the README section we'll add later.

## Task plan

| # | Task | Complexity | Model | Worktree |
|---|------|-----------|-------|----------|
| 1 | T1 — NodeKind + diagnostics types | Simple | Haiku | shared |
| 2 | T2 — anchor constructor | Simple | Haiku | shared |
| 3 | T3 — slugify | Simple | Haiku | shared |
| 4 | T5 — tokenizer wrapper | Simple | Haiku | shared |
| 5 | T4 — markdown-split (pure logic) | Medium | Sonnet | shared |
| 6 | T6 — extractor (walker + reader + frontmatter) | Medium | Sonnet | shared |
| 7 | T7 — mapper | Simple | Haiku | shared |
| 8 | T8 — snippet renderer | Simple | Haiku | shared |
| 9 | T9 — pipeline wiring | Medium | Sonnet | shared |
| 10 | T10 — docs-validator | Simple | Haiku | shared |
| 11 | T11 — snippet-recall integration | Simple | Haiku | shared |
| 12 | T12 — config schema | Simple | Haiku | shared |
| 13 | T13 — interactive init | Medium | Sonnet | shared |
| 14 | T14 — semantic build integration test | Simple | Haiku | shared |
| 15 | T15 — MCP exposure test | Simple | Haiku | shared |
| 16 | T16 — js-yaml prod-dep | Simple | Haiku | shared |

Single shared worktree off `develop`. Ordering is the dependency graph
above (T1 first; T3/T4/T5 parallel after T1; T6 after T4+T5; T7 after T6;
T8 after T7; T9 after T6+T7; rest after T9 — but most are independent
file-add tasks and can run in parallel after T9). The implementation plan
in the writing-plans phase will refine parallelism.

## Sequence to ship

1. **Phase 1.1** — this design doc committed to develop before dispatch.
2. **Phase 2.5** — execution brief with model assignments, parallel
   structure, worktree count. User confirmation gate.
3. **Phase 3** — implementation in isolated worktree.
4. **Phase 3.1** — per-agent verification (branch + diff + QG paste).
5. **Phase 3.5** — AC verification (independent agent, AC1–AC12 one-by-one).
6. **Phase 4** — full quality gate: `pnpm test`, `tsc --noEmit`, lint.
7. **Phase 5** — pr-review-toolkit (code-reviewer, silent-failure-hunter,
   pr-test-analyzer; type-design-analyzer additionally because new types
   added).
8. **Phase 6** — iterate fix → re-review until 0 P0 + 0 P1.
9. **Phase 7** — merge to develop with `--no-ff`; tag `doc-section-v1`;
   v_-rename this design file.
10. **Phase 8.5** — advisor call.
11. **Phase 9** — summary + Required User Actions (graphify update, etc.).
