# graphify vs arch-graph — comparison memo

_Date: 2026-05-17_
_Sources: graphify `~/.claude/skills/graphify/SKILL.md`; arch-graph `README.md`, `bench/report.md`, `docs/plans/2026-05-16-semantic-sidecar-design.md`, `docs/plans/v_2026-05-17-doc-section-extractor-design.md`._

---

## 1. Inputs

**graphify** accepts anything: Python/TS/Go/Rust/other code, Markdown, PDF, images (Claude vision), audio/video (Whisper), GitHub URLs, and multi-repo merges. Ecosystem-agnostic. **arch-graph** is TypeScript-only, with deep NestJS semantics: NATS pub/sub, BullMQ, TypeORM, `@Module` DI, HTTP calls, TS imports. Since 2026-05-17 it also ingests `docs/**/*.md` as `doc-section` nodes via a CommonMark splitter.

## 2. Extraction approach

**graphify** is hybrid: deterministic AST (Part A) + parallel LLM subagents (Part B) that return typed edges labelled `EXTRACTED | INFERRED | AMBIGUOUS` with confidence scores. The LLM is the primary engine for cross-file semantic relationships and `hyperedges`. **arch-graph** is deterministic, zero-LLM at extraction time — `ts-morph` only. The optional semantic sidecar (`arch-graph semantic build`) adds 384-dim dense-vector embeddings (`Xenova/paraphrase-multilingual-MiniLM-L12-v2`) as a *query-time* layer, not an extraction layer.

**One-liner: graphify uses LLMs to find relationships; arch-graph uses dense vectors to find nodes.**

## 3. Output formats

**graphify**: `graph.json`, `GRAPH_REPORT.md`, `graph.html` (interactive, no server), optional SVG/GraphML/Cypher/Neo4j push, Obsidian vault, wiki. MCP stdio server: 7 tools. **arch-graph**: `graph.json`, `diagnostics.json` (every unresolved call-site + source location), `validation.json`, `graph.mermaid`; semantic sidecar adds `semantic/{manifest.json, embeddings.jsonl}`. MCP stdio server: 15 tools (12 structural + 3 semantic). Ten CLI query subcommands bypass MCP overhead.

## 4. Query model

**graphify**: keyword-anchored BFS/DFS traversal over the stored graph (`/graphify query`, `path`, `explain`). The LLM-built edges encode the semantics; traversal is structural. No built-in kNN. **arch-graph**: (a) exact graph traversal via CLI subcommands — deterministic, file:line citations; (b) cosine kNN over embeddings for fuzzy intent. Split `code_search` / `docs_search` buckets prevent doc-section nodes from diluting code results (measured: A_find recall 80% → 30% without split; `README.md`).

## 5. Update model

**graphify**: incremental `--update` detects changed files; code-only changes skip LLM entirely; doc/image changes re-run semantic subagents. Extraction cache skips unchanged-hash files. `--watch` mode available. **arch-graph**: full rebuild on every `arch-graph build` (cheap — no LLM, sub-second on medium repos). Pre-commit hook auto-stages output so every commit is self-consistent. Semantic sidecar v1 is always full-rebuild; stale detection via `manifest.graphHash`.

## 6. Strengths

**graphify** wins on breadth: mixed-media corpora, any language/ecosystem, community detection (Louvain), "surprising connections" surfacing, Obsidian vault for human navigation, audit trail with confidence tags. **arch-graph** wins on precision: every edge carries file:line; per-build recall gate (≥ 95%) catches regressions in CI (`--strict`); `diagnostics.json` surfaces unresolved dynamics honestly. Bench (`bench/report.md`, 40 Qs, 4 NestJS monorepos): 14.3× fewer tokens per question, 100% vs 39% recall on architecture-grade queries.

## 7. Weaknesses / coverage gaps

**graphify** has no typed NATS/BullMQ/TypeORM edges — architecture-grade questions produce large noisy contexts (bench: 15–53× more tokens). No per-build recall gate. LLM subagent cost scales with corpus size. **arch-graph** is NestJS/TypeScript-only; gRPC, Kafka, multi-repo, Python/Go are out of scope. No community detection, no concept inference. `doc-section` nodes have no `doc-mentions` edges to code entities (deferred v2); no cross-cutting clustering over docs.

## 8. Overlap

Both produce `graph.json` + MCP server + git hook + CLAUDE.md integration. Both handle TypeScript in some way. Narrowest overlap is on TS codebases where both can run simultaneously: arch-graph gives structural precision, graphify gives cross-cutting semantic patterns. `arch-graph compare --graphify graphify-out/` generates a side-by-side token/recall report for any specific repo.

## 9. Complementarity

Two scenarios where running both pays off. **NestJS monorepo onboarding**: arch-graph for structural navigation ("what depends on this queue?"), graphify for orientation ("show me the conceptual architecture"). **Multi-language system**: arch-graph covers the NestJS backend; graphify covers the Python pipeline, ML model docs, and design PDFs.

---

## When to use which

| Scenario | Use |
|---|---|
| "Who publishes on NATS subject X?" | arch-graph |
| "What guards run on this endpoint?" | arch-graph |
| "What TypeORM tables relate to entity Y?" | arch-graph |
| "Show import cycle candidates" | arch-graph |
| "Find code about auth flow" (fuzzy) | arch-graph `semantic search` |
| "What does this README section say about X?" | arch-graph `docs_search` |
| CI recall gate — fail build on extractor regression | arch-graph `--strict` |
| "I'm new, orient me on this codebase" | graphify |
| "What do this code + these docs + this ADR have in common?" | graphify |
| Any non-TypeScript language | graphify |
| Build Obsidian vault for team navigation | graphify |
| Deep NestJS architecture + cross-cutting semantics | both |

---

## Verdict

These tools are **complementary, not competitive** — the README frames them as "sister projects" at different ends of the precision/breadth axis.

**Empirical numbers (post-semantic, 2026-05-17):** A fresh head-to-head benchmark across all 103 queries × 3 projects (see [`2026-05-17-arch-graph-vs-graphify-eval.md`](./2026-05-17-arch-graph-vs-graphify-eval.md)):

| | arch-graph | graphify | Δ |
|---|---|---|---|
| **Overall hit-rate** | **67%** | 35% | **+32pp** |
| A_find | 71% | 38% | +33pp |
| B_debug | 60% | 27% | +33pp |
| C_ui | 63% | 44% | +19pp |
| D_docs | 67% | 33% | +34pp |
| D_links | 63% | 25% | +38pp |
| E_arch | 60% | 30% | +30pp |
| Tokens/query (avg) | ~1000 | ~350 | — |
| Wins (per-query) | 37 | 4 | tie 32, both-miss 30 |

**Where the gap comes from:** 80% of queries are in Russian. graphify does keyword-BFS over English code-node labels — when a Russian query has no English identifiers to match, graphify returns "No matching nodes found." arch-graph's multilingual embeddings (`Xenova/paraphrase-multilingual-MiniLM-L12-v2`) handle the language barrier. For English-identifier queries ("BaseRepository pattern", "useFormValidation hook") the two tools are roughly tied.

**EN-normalized re-run (2026-05-17):** To isolate retrieval-quality from multilingual handling, the same 103 queries were re-run as 2-4 keyword EN phrases (as an LLM agent would emit). Result: arch-graph stays flat at **67%**; graphify jumps to **91%** (Δ = graphify +24pp). The gap **reverses**. This should not be interpreted as graphify being the better retrieval engine — two scoring regimes are in play: graphify's HIT is any `expectedLabelHas` substring anywhere in an ~821-token free-text response; arch-graph's HIT requires score ≥ minScore AND kind AND label to all match in the top-10. The broader graphify criterion was invisible when 57% of RU queries returned empty; with EN queries it returns content for 91% of queries and the asymmetry becomes load-bearing. The honest read: for Russian-language queries, arch-graph wins by +32pp. For English-keyword queries from an LLM agent, graphify's BFS community expansion produces broad-recall responses that score well under a substring-match criterion; arch-graph's strict top-K is more precise but does not gain ground. Teams whose agents pre-translate to EN before retrieval should run their own strict top-K evaluation before choosing.

**Older bench numbers** (14.3× token efficiency, 100% vs 39% recall) — those were measured before arch-graph had the semantic layer. They're now superseded; see [`bench/report.md`](../../bench/report.md) for that older structural-only baseline.

**arch-graph users** should know graphify for orientation queries, heterogeneous corpora (PDFs, images, multi-language), and anything outside TypeScript. **graphify users on NestJS monorepos** with non-English queries should default to arch-graph; graphify retains value as a cheap pre-filter on English-identifier queries (~350 tokens vs arch-graph's ~1000) — run it first, fall back to arch-graph on MISS.
