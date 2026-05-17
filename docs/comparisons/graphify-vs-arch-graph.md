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

These tools are **complementary, not competitive** — the README already frames them as "sister projects" at different ends of the precision/breadth axis. The bench numbers (14.3× token efficiency, 100% vs 39% recall) hold only for arch-graph's home turf; a bench on cross-cutting semantic or multi-media questions would tilt the other way.

**arch-graph users** should know graphify for orientation queries, heterogeneous corpora, and anything outside TypeScript. **graphify users on NestJS monorepos** should try arch-graph for any question that resolves to a specific edge type (pub/sub, queue, table, module DI) — the token savings and file:line citations are material in daily agent workflows.
