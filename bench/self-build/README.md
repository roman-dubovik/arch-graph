# Public Self-Build Mini-Bench: arch-graph vs graphify

**TL;DR: arch-graph 83% (10/12), graphify 50% (6/12) on 12 queries about arch-graph's own internals.**

This is a fully reproducible benchmark. Anyone who clones the
[arch-graph repository](https://github.com/roman-dubovik/arch-graph) can re-run every step
and verify these numbers.

---

## Model comparison (MiniLM vs BGE-M3)

Two scripts let you benchmark a different embedding model and compare results:

### Run the bench for a given model

```bash
# Build graph + semantic index, run all 12 queries, write results JSON
pnpm tsx bench/self-build/run.ts --model minilm --out bench/self-build/results/minilm.json
pnpm tsx bench/self-build/run.ts --model bge-m3 --out bench/self-build/results/bge-m3.json
```

`--model` accepts any alias from the SEMANTIC_MODELS registry (`minilm`, `bge-m3`).
`--out` is the path for the flat JSON result array.
First run for BGE-M3 downloads ~500 MB; subsequent runs use the local cache.

### Compare two result files

```bash
# Emit markdown side-by-side comparison to stdout
pnpm tsx bench/self-build/compare.ts \
  bench/self-build/results/minilm.json \
  bench/self-build/results/bge-m3.json
```

The output has three sections:
- **Per-query**: score@1 delta, rank delta of expected node, hit/miss change
- **Per-category**: hit-rate change for A_find / B_debug / D_docs / E_arch
- **Overall summary**: total queries, total hits, hit-rate delta

### Full example invocation chain

```bash
# 1. Build both models
pnpm tsx bench/self-build/run.ts --model minilm --out /tmp/minilm.json
pnpm tsx bench/self-build/run.ts --model bge-m3 --out /tmp/bge-m3.json

# 2. Compare and save report
pnpm tsx bench/self-build/compare.ts /tmp/minilm.json /tmp/bge-m3.json \
  > docs/plans/bge-m3-migration-report.md
```

---

## Reproduction

All commands run from the repo root.

### 1. Build the arch-graph graph + semantic index

```bash
# Build the structural graph (writes arch-graph-out/graph.json)
pnpm tsx src/cli/index.ts build

# Build the semantic index (writes arch-graph-out/semantic/)
pnpm tsx src/cli/index.ts semantic build
```

### 2. Build the graphify graph

```bash
# Graphify AST extraction (writes graphify-out/graph.json)
graphify update .
```

### 3. Run arch-graph queries

For each query in `bench/self-build/queries-self-build.json`:

```bash
pnpm tsx src/cli/index.ts semantic search "<query>" --k 10 --json
```

### 4. Run graphify queries

For each query:

```bash
graphify query "<query>" --budget 1500
```

### 5. Score

- **arch-graph HIT**: top-10 contains a result with `score >= minScore` AND `kind ∈ expectedKindIn` AND `label` substring-matches any entry in `expectedLabelHas`.
- **graphify HIT (strict)**: top-10 NODE lines contain a result whose `label` or `source_file` substring-matches any entry in `expectedLabelHas`. No score floor (graphify doesn't emit scores).

---

## Results

### Overall

| Tool | Hits | Total | Hit Rate |
|------|------|-------|----------|
| arch-graph (semantic search) | 10 | 12 | **83%** |
| graphify (BFS query) | 6 | 12 | **50%** |

### By Category

| Category | arch-graph | graphify | Queries |
|----------|-----------|---------|---------|
| A_find (locate code element) | 3/3 (100%) | 1/3 (33%) | SB1–SB3 |
| B_debug (debugging-style) | 3/3 (100%) | 1/3 (33%) | SB4–SB6 |
| D_docs (documentation) | 1/3 (33%) | 1/3 (33%) | SB7–SB9 |
| E_arch (architecture) | 3/3 (100%) | 3/3 (100%) | SB10–SB12 |

### Per-Query Results

| ID | Category | Query | arch-graph | graphify |
|----|----------|-------|-----------|---------|
| SB1 | A_find | where is the semantic builder | HIT | MISS |
| SB2 | A_find | where is the doc-section extractor source file | HIT | HIT |
| SB3 | A_find | where is the OpenAPI enricher | HIT | MISS |
| SB4 | B_debug | why might semantic search return zero results | HIT | MISS |
| SB5 | B_debug | what handles empty markdown files during doc extraction | HIT | HIT |
| SB6 | B_debug | where is the score floor applied in semantic search | HIT | MISS |
| SB7 | D_docs | what does --strict mode do | MISS | MISS |
| SB8 | D_docs | how does code_search differ from docs_search | HIT | HIT |
| SB9 | D_docs | what is in the semantic manifest file | MISS | MISS |
| SB10 | E_arch | how is the build pipeline structured | HIT | HIT |
| SB11 | E_arch | what is the MCP server architecture | HIT | HIT |
| SB12 | E_arch | what extractors are wired together in the build | HIT | HIT |

### Top-3 Results per Query

**SB1 — where is the semantic builder**

arch-graph (HIT):
1. [doc-section] `Semantic search (optional)` — README.md (score=0.497)
2. [doc-section] `Task 13: Semantic build + MCP filter — integration tests` — impl plan (score=0.496)
3. [doc-section] `Goal` — semantic sidecar design doc (score=0.495)

graphify (MISS):
1. `types.ts` (src/core/types.ts)
2. `build.ts` (src/pipeline/build.ts)
3. `config.ts` (src/core/config.ts)

---

**SB2 — where is the doc-section extractor source file**

arch-graph (HIT):
1. [doc-section] `doc-section Implementation Plan` — implementation plan (score=0.573)
2. [doc-section] `Task 5: Extractor — file walker + reader + frontmatter` — impl plan (score=0.562)
3. [doc-section] `Task 5: Extractor — file walker + reader + frontmatter` — impl plan (score=0.552)

graphify (HIT):
1. `extractor.ts` (src/extractors/nats/extractor.ts)
2. `extractor.ts` (src/extractors/di/extractor.ts)
3. `extractor.ts` (src/extractors/fe/extractor.ts)

Note: graphify HIT via "extractor" substring match in filename. It does not distinguish between extractor types.

---

**SB3 — where is the OpenAPI enricher**

arch-graph (HIT):
1. [doc-section] `Architecture overview` — openapi design doc (score=0.397)
2. [doc-section] `Goal` — openapi design doc (score=0.378)
3. [doc-section] `Design: OpenAPI YAML Enrichment for Endpoint Nodes` (score=0.367)

graphify (MISS):
1. `types.ts` (src/core/types.ts)
2. `build.ts` (src/pipeline/build.ts)
3. `config.ts` (src/core/config.ts)

---

**SB4 — why might semantic search return zero results**

arch-graph (HIT):
1. [doc-section] `Semantic search (optional)` — README.md (score=0.563)
2. [doc-section] `Semantic search strategy` — README.md (score=0.548)
3. [doc-section] `Goal` — semantic sidecar design (score=0.548)

graphify (MISS):
1. `types.ts` (src/core/types.ts)
2. `build.ts` (src/pipeline/build.ts)
3. `config.ts` (src/core/config.ts)

---

**SB5 — what handles empty markdown files during doc extraction**

arch-graph (HIT):
1. [doc-section] `Task 5: Extractor — file walker + reader + frontmatter` (score=0.561)
2. [doc-section] `Task 5: Extractor — file walker + reader + frontmatter` (score=0.556)
3. [doc-section] `Task 5: Extractor — file walker + reader + frontmatter` (score=0.555)

graphify (HIT):
1. `extract-docs.ts` (src/extractors/docs/extract-docs.ts)
2. `splitMarkdown()` (src/extractors/docs/markdown-split.ts)
3. `markdown-split.ts` (src/extractors/docs/markdown-split.ts)

---

**SB6 — where is the score floor applied in semantic search**

arch-graph (HIT):
1. [doc-section] `Semantic search (optional)` — README.md (score=0.582)
2. [doc-section] `Semantic search strategy` — README.md (score=0.546)
3. [doc-section] `Goal` — semantic sidecar design (score=0.532)

Note: The "Semantic search" section discusses score semantics including floor behavior. Graphify returned no relevant code for "score floor."

graphify (MISS):
1. `types.ts` (src/core/types.ts)
2. `build.ts` (src/pipeline/build.ts)
3. `config.ts` (src/core/config.ts)

---

**SB7 — what does --strict mode do**

arch-graph (MISS): Top result was `CWD discipline` (score=0.348), below threshold. The `--strict` flag is documented inline in README but the semantic query did not surface it.

graphify (MISS): Returned general files (types.ts, config.ts), no strict-mode specific results.

---

**SB8 — how does code_search differ from docs_search**

arch-graph (HIT):
1. [doc-section] `Semantic search (optional)` — README.md (score=0.639)
2. [doc-section] `Semantic search strategy` — README.md (score=0.622)
3. [doc-section] `MCP server` — README.md (score=0.605)

graphify (HIT):
1. `graph-queries.ts` (src/mcp/graph-queries.ts)
2. `makeSemanticSearchHandler()` (src/mcp/server.ts)
3. `server.ts` (src/mcp/server.ts)

---

**SB9 — what is in the semantic manifest file**

arch-graph (MISS): Top results were about `Tokenizer` (score=0.502), not the manifest. No doc-section about `manifest.json` contents is indexed.

graphify (MISS): Returned general core files, no manifest-specific results.

---

**SB10 — how is the build pipeline structured**

arch-graph (HIT):
1. [doc-section] `Task 10: Pipeline wiring — call docs extractor + mapper in pipeline/build.ts` (score=0.555)
2. [doc-section] `Task 10: Pipeline wiring…` (score=0.549)
3. [doc-section] `Build output` — README.md (score=0.531)

graphify (HIT):
1. `build.ts` (src/pipeline/build.ts)
2. `runBuild()` (src/pipeline/build.ts)
3. `safeDetectCycles()` (src/pipeline/build.ts)

---

**SB11 — what is the MCP server architecture**

arch-graph (HIT):
1. [doc-section] `MCP server` — README.md (score=0.685)
2. [doc-section] `MCP server` — README.md (score=0.654)
3. [doc-section] `MCP contract (Task 4) — locked for federation` — docs/plans/v_2026-05-16-semantic-sidecar-design.md (score=0.638)

graphify (HIT):
1. `graph-queries.ts` (src/mcp/graph-queries.ts)
2. `server.ts` (src/mcp/server.ts)
3. `startMcpServer()` (src/mcp/server.ts)

---

**SB12 — what extractors are wired together in the build**

arch-graph (HIT):
1. [doc-section] `Task 10: Pipeline wiring — call docs extractor + mapper in pipeline/build.ts` (score=0.507)
2. [doc-section] `Task 10: Pipeline wiring…` (score=0.505)
3. [doc-section] `Task 10: Pipeline wiring…` (score=0.504)

graphify (HIT):
1. `build.ts` (src/pipeline/build.ts)
2. `runBuild()` (src/pipeline/build.ts)
3. `extractor.ts` (src/extractors/nats/extractor.ts)

---

## Methodology

### Query design

Twelve queries targeting real arch-graph internals across four categories:

- **A_find (3)**: "where is X?" — locate a specific code element by name
- **B_debug (3)**: debugging-style questions about runtime behavior
- **D_docs (3)**: documentation lookup questions
- **E_arch (3)**: architecture overview questions

### Scoring — arch-graph

A result is a HIT if **all three** of these hold for any result in top-10:
1. `score >= minScore` (per-query threshold, ranging 0.35–0.45)
2. `kind ∈ expectedKindIn` (e.g., `doc-section`, `config-field`)
3. `label` substring-matches any string in `expectedLabelHas` (case-insensitive)

### Scoring — graphify (strict apples-to-apples)

A result is a HIT if any of top-10 NODE lines' `label` or `source_file` substring-matches any string in `expectedLabelHas` (case-insensitive). No score floor — graphify does not emit confidence scores.

This methodology mirrors the Strict Apples-to-Apples section in
[docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md](../../docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md).

### Important limitation

This bench targets arch-graph's own codebase — which is primarily a TypeScript CLI tool, not a
NestJS monorepo. As a result, arch-graph's NestJS-specific extractors (NATS, TypeORM, BullMQ, DI,
HTTP, FE) are disabled. The self-build graph is dominated by **doc-section** nodes (1003 of 1008
nodes). All 12 queries are thus documentation/concept questions, not code-structure queries. This
explains arch-graph's strength in D_docs and the pattern difference vs the main 103-query bench.

---

## Why this bench matters

The main bench (`docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md`) runs against three
private NestJS monorepos — the numbers are honest but not independently reproducible by third parties.

This self-build bench uses arch-graph's own public repository as the target corpus. **Anyone with a
clone can re-run and verify the numbers**. No private code is involved.

---

## Raw data

- `queries-self-build.json` — 12 queries with scoring criteria
- `arch-graph-results.md` — full top-10 results for each query (arch-graph)
- `graphify-responses.jsonl` — raw graphify stdout per query (one JSON object per line)
