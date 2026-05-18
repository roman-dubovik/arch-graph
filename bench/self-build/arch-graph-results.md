# arch-graph Results — Self-Build Bench

Top-10 results from `arch-graph semantic search` for each query.

Scoring: HIT = top-10 contains result with `score >= minScore` AND `kind ∈ expectedKindIn` AND `label` substring-matches `expectedLabelHas`.


## SB1 — where is the semantic builder

**Category:** A_find  
**Verdict:** HIT  
**minScore:** 0.4  
**expectedKindIn:** doc-section, config-field  
**expectedLabelHas:** Semantic search, semantic, builder

| Rank | Score | Kind | Label |
|------|-------|------|-------|
| 1 | 0.497 | doc-section | Semantic search (optional) **HIT** |
| 2 | 0.496 | doc-section | Task 13: Semantic build + MCP filter — integration tests |
| 3 | 0.495 | doc-section | Goal |
| 4 | 0.474 | doc-section | 🟡 3. Hybrid BM25 + semantic (отложено) |
| 5 | 0.464 | doc-section | Task 13: Semantic build + MCP filter — integration tests |
| 6 | 0.462 | doc-section | Design: Semantic sidecar for arch-graph (Variant 3) |
| 7 | 0.462 | doc-section | Task 13: Semantic build + MCP filter — integration tests |
| 8 | 0.461 | doc-section | Semantic search (optional) |
| 9 | 0.458 | doc-section | Task 13: Semantic build + MCP filter — integration tests |
| 10 | 0.455 | doc-section | Task 13: Semantic build + MCP filter — integration tests |

## SB2 — where is the doc-section extractor source file

**Category:** A_find  
**Verdict:** HIT  
**minScore:** 0.45  
**expectedKindIn:** doc-section  
**expectedLabelHas:** extract-docs, Extractor, doc-section

| Rank | Score | Kind | Label |
|------|-------|------|-------|
| 1 | 0.566 | doc-section | Task 12: Interactive init — docs discovery prompts |
| 2 | 0.546 | doc-section | Task 11: Docs validator — file-coverage gate |
| 3 | 0.541 | doc-section | Task 12: Interactive init — docs discovery prompts |
| 4 | 0.540 | doc-section | Task 5: Extractor — file walker + reader + frontmatter (`ext **HIT** |
| 5 | 0.536 | doc-section | Task 12: Interactive init — docs discovery prompts |
| 6 | 0.524 | doc-section | Task 7: Mapper — `mapper/docs-to-graph.ts` |
| 7 | 0.521 | doc-section | Task 11: Docs validator — file-coverage gate |
| 8 | 0.517 | doc-section | Task 12: Interactive init — docs discovery prompts |
| 9 | 0.517 | doc-section | doc-section Implementation Plan |
| 10 | 0.514 | doc-section | Task 12: Interactive init — docs discovery prompts |

## SB3 — where is the OpenAPI enricher

**Category:** A_find  
**Verdict:** HIT  
**minScore:** 0.35  
**expectedKindIn:** doc-section, config-field  
**expectedLabelHas:** openapi, OpenAPI, enrich

| Rank | Score | Kind | Label |
|------|-------|------|-------|
| 1 | 0.397 | doc-section | Architecture overview |
| 2 | 0.378 | doc-section | Goal |
| 3 | 0.367 | doc-section | Design: OpenAPI YAML Enrichment for Endpoint Nodes **HIT** |
| 4 | 0.352 | doc-section | Execution order |
| 5 | 0.333 | doc-section | Quick start |
| 6 | 0.327 | doc-section | Constraints |
| 7 | 0.319 | doc-section | Key findings from analysis |
| 8 | 0.317 | doc-section | Runtime trace integration (OpenTelemetry service maps) |
| 9 | 0.317 | doc-section | 2026-05-17: cumulative — `fe-i18n-multi-enum-v1` + `openapi- |
| 10 | 0.315 | doc-section | Task 12: Interactive init — docs discovery prompts |

## SB4 — why might semantic search return zero results

**Category:** B_debug  
**Verdict:** HIT  
**minScore:** 0.35  
**expectedKindIn:** doc-section  
**expectedLabelHas:** semantic, Semantic, search

| Rank | Score | Kind | Label |
|------|-------|------|-------|
| 1 | 0.563 | doc-section | Semantic search (optional) **HIT** |
| 2 | 0.562 | doc-section | Semantic search (optional) |
| 3 | 0.545 | doc-section | Semantic search (optional) |
| 4 | 0.494 | doc-section | Semantic search strategy |
| 5 | 0.490 | doc-section | Semantic search strategy |
| 6 | 0.484 | doc-section | Semantic search (optional) |
| 7 | 0.454 | doc-section | Semantic search strategy |
| 8 | 0.423 | doc-section | Semantic search (optional) |
| 9 | 0.422 | doc-section | Semantic search (optional) |
| 10 | 0.419 | doc-section | Methodology — reading the substring heuristic |

## SB5 — what handles empty markdown files during doc extraction

**Category:** B_debug  
**Verdict:** HIT  
**minScore:** 0.35  
**expectedKindIn:** doc-section  
**expectedLabelHas:** empty, markdown, Extractor, docs

| Rank | Score | Kind | Label |
|------|-------|------|-------|
| 1 | 0.561 | doc-section | Task 5: Extractor — file walker + reader + frontmatter (`ext **HIT** |
| 2 | 0.550 | doc-section | Task 4: Markdown splitter (`extractors/docs/markdown-split.t |
| 3 | 0.546 | doc-section | 1. File-coverage gate (hard) |
| 4 | 0.540 | doc-section | Task 4: Markdown splitter (`extractors/docs/markdown-split.t |
| 5 | 0.540 | doc-section | Task 4: Markdown splitter (`extractors/docs/markdown-split.t |
| 6 | 0.539 | doc-section | Task 4: Markdown splitter (`extractors/docs/markdown-split.t |
| 7 | 0.539 | doc-section | Task 5: Extractor — file walker + reader + frontmatter (`ext |
| 8 | 0.537 | doc-section | Task 5: Extractor — file walker + reader + frontmatter (`ext |
| 9 | 0.536 | doc-section | Task 4: Markdown splitter (`extractors/docs/markdown-split.t |
| 10 | 0.533 | doc-section | Task 5: Extractor — file walker + reader + frontmatter (`ext |

## SB6 — where is the score floor applied in semantic search

**Category:** B_debug  
**Verdict:** HIT  
**minScore:** 0.35  
**expectedKindIn:** doc-section  
**expectedLabelHas:** strict, floor, Semantic, recall

| Rank | Score | Kind | Label |
|------|-------|------|-------|
| 1 | 0.582 | doc-section | Semantic search (optional) **HIT** |
| 2 | 0.577 | doc-section | Semantic search (optional) |
| 3 | 0.550 | doc-section | Semantic search (optional) |
| 4 | 0.546 | doc-section | Semantic search strategy |
| 5 | 0.546 | doc-section | Semantic search (optional) |
| 6 | 0.533 | doc-section | Semantic search (optional) |
| 7 | 0.531 | doc-section | Semantic search strategy |
| 8 | 0.513 | doc-section | Methodology — reading the substring heuristic |
| 9 | 0.512 | doc-section | Semantic search (optional) |
| 10 | 0.508 | doc-section | How quality is scored |

## SB7 — what does --strict mode do

**Category:** D_docs  
**Verdict:** MISS  
**minScore:** 0.4  
**expectedKindIn:** doc-section  
**expectedLabelHas:** strict, Strict

| Rank | Score | Kind | Label |
|------|-------|------|-------|
| 1 | 0.348 | doc-section | CWD discipline (mandatory for all agents) |
| 2 | 0.314 | doc-section | Real-corpus signal (from Phase 1 research) |
| 3 | 0.304 | doc-section | Limitations (honest) |
| 4 | 0.303 | doc-section | Extension A — FE Level 1 (React + Next pages/components/rout |
| 5 | 0.302 | doc-section | Hybrid mode: consume devtools snapshot (from @nestjs/devtool |
| 6 | 0.301 | doc-section | Conventions |
| 7 | 0.299 | doc-section | Why in-memory |
| 8 | 0.295 | doc-section | External constraints |
| 9 | 0.285 | doc-section | Markdown parser (production rules) |
| 10 | 0.284 | doc-section | External constraints |

## SB8 — how does code_search differ from docs_search

**Category:** D_docs  
**Verdict:** HIT  
**minScore:** 0.35  
**expectedKindIn:** doc-section  
**expectedLabelHas:** Semantic search, semantic, search, MCP

| Rank | Score | Kind | Label |
|------|-------|------|-------|
| 1 | 0.639 | doc-section | Semantic search (optional) **HIT** |
| 2 | 0.552 | doc-section | Task 12: Interactive init — docs discovery prompts |
| 3 | 0.551 | doc-section | Semantic search strategy |
| 4 | 0.538 | doc-section | Task 12: Interactive init — docs discovery prompts |
| 5 | 0.530 | doc-section | Semantic search (optional) |
| 6 | 0.529 | doc-section | Task 12: Interactive init — docs discovery prompts |
| 7 | 0.524 | doc-section | Task 12: Interactive init — docs discovery prompts |
| 8 | 0.513 | doc-section | Semantic search (optional) |
| 9 | 0.507 | doc-section | Task 12: Interactive init — docs discovery prompts |
| 10 | 0.499 | doc-section | Eval corpus |

## SB9 — what is in the semantic manifest file

**Category:** D_docs  
**Verdict:** MISS  
**minScore:** 0.35  
**expectedKindIn:** doc-section  
**expectedLabelHas:** manifest, Manifest

| Rank | Score | Kind | Label |
|------|-------|------|-------|
| 1 | 0.502 | doc-section | Tokenizer (`semantic/tokenizer.ts`) |
| 2 | 0.500 | doc-section | Tokenizer (`semantic/tokenizer.ts`) |
| 3 | 0.494 | doc-section | Tokenizer (`semantic/tokenizer.ts`) |
| 4 | 0.476 | config-field | ARCH_GRAPH_REGISTRY |
| 5 | 0.474 | doc-section | Task 2: Tokenizer wrapper (`semantic/tokenizer.ts`) |
| 6 | 0.466 | doc-section | Task 2: Tokenizer wrapper (`semantic/tokenizer.ts`) |
| 7 | 0.463 | doc-section | Task 2: Tokenizer wrapper (`semantic/tokenizer.ts`) |
| 8 | 0.457 | doc-section | Task 2: Tokenizer wrapper (`semantic/tokenizer.ts`) |
| 9 | 0.453 | doc-section | Tokenizer (`semantic/tokenizer.ts`) |
| 10 | 0.450 | doc-section | Task 13: Semantic build + MCP filter — integration tests |

## SB10 — how is the build pipeline structured

**Category:** E_arch  
**Verdict:** HIT  
**minScore:** 0.4  
**expectedKindIn:** doc-section  
**expectedLabelHas:** pipeline, build, Build

| Rank | Score | Kind | Label |
|------|-------|------|-------|
| 1 | 0.555 | doc-section | Task 10: Pipeline wiring — call docs extractor + mapper in ` **HIT** |
| 2 | 0.542 | doc-section | Task 10: Pipeline wiring — call docs extractor + mapper in ` |
| 3 | 0.527 | doc-section | Task 10: Pipeline wiring — call docs extractor + mapper in ` |
| 4 | 0.524 | doc-section | Task 10: Pipeline wiring — call docs extractor + mapper in ` |
| 5 | 0.522 | doc-section | Task 10: Pipeline wiring — call docs extractor + mapper in ` |
| 6 | 0.517 | doc-section | Task 10: Pipeline wiring — call docs extractor + mapper in ` |
| 7 | 0.512 | doc-section | Task 10: Pipeline wiring — call docs extractor + mapper in ` |
| 8 | 0.494 | doc-section | Task 10: Pipeline wiring — call docs extractor + mapper in ` |
| 9 | 0.488 | doc-section | Task 10: Pipeline wiring — call docs extractor + mapper in ` |
| 10 | 0.454 | doc-section | Task 10: Pipeline wiring — call docs extractor + mapper in ` |

## SB11 — what is the MCP server architecture

**Category:** E_arch  
**Verdict:** HIT  
**minScore:** 0.4  
**expectedKindIn:** doc-section  
**expectedLabelHas:** MCP server, MCP

| Rank | Score | Kind | Label |
|------|-------|------|-------|
| 1 | 0.685 | doc-section | MCP server **HIT** |
| 2 | 0.644 | doc-section | MCP server |
| 3 | 0.618 | doc-section | Fallback 1 — MCP server (if installed) |
| 4 | 0.615 | doc-section | MCP server |
| 5 | 0.606 | doc-section | MCP server |
| 6 | 0.531 | doc-section | MCP fallback (if installed) |
| 7 | 0.516 | doc-section | MCP contract — locked for federation |
| 8 | 0.478 | doc-section | MCP server |
| 9 | 0.449 | doc-section | MCP contract (Task 4) — locked for federation |
| 10 | 0.444 | doc-section | MCP contract (Task 4) — locked for federation |

## SB12 — what extractors are wired together in the build

**Category:** E_arch  
**Verdict:** HIT  
**minScore:** 0.35  
**expectedKindIn:** doc-section  
**expectedLabelHas:** pipeline, extractor, Extractor, build

| Rank | Score | Kind | Label |
|------|-------|------|-------|
| 1 | 0.507 | doc-section | Task 10: Pipeline wiring — call docs extractor + mapper in ` **HIT** |
| 2 | 0.501 | doc-section | Task 10: Pipeline wiring — call docs extractor + mapper in ` |
| 3 | 0.493 | doc-section | Task 5: Extractor — file walker + reader + frontmatter (`ext |
| 4 | 0.487 | doc-section | Task 5: Extractor — file walker + reader + frontmatter (`ext |
| 5 | 0.485 | doc-section | Task 5: Extractor — file walker + reader + frontmatter (`ext |
| 6 | 0.481 | doc-section | Test fixtures — pattern |
| 7 | 0.481 | doc-section | Task 10: Pipeline wiring — call docs extractor + mapper in ` |
| 8 | 0.477 | doc-section | Task 10: Pipeline wiring — call docs extractor + mapper in ` |
| 9 | 0.475 | doc-section | 🟡 4. project-c-specific extractor доводки |
| 10 | 0.472 | doc-section | Limitations & honesty |
