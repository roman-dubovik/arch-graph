# graphify vs arch-graph — comparison memo

_Date: 2026-05-17_
_Sources: graphify `~/.claude/skills/graphify/SKILL.md` (60 KB); arch-graph `README.md`, `bench/report.md`, `docs/plans/2026-05-16-semantic-sidecar-design.md`, `docs/plans/v_2026-05-17-doc-section-extractor-design.md`._

---

## 1. Inputs

**graphify** accepts anything: Python, TypeScript, Go, Rust and other code formats; Markdown, plain text, PDF, images (PNG/JPG/WEBP via Claude vision), audio and video (via Whisper transcription). It can clone GitHub repos on-the-fly and merge multiple repos into one cross-repo graph. It is language- and ecosystem-agnostic by design — Andrej Karpathy's "drop everything into `/raw`" workflow is the stated mental model.

**arch-graph** accepts TypeScript exclusively (`ts-morph`-based static analysis). Within that narrow input space it understands deep NestJS ecosystem semantics: NATS pub/sub decorators, BullMQ `@InjectQueue`/`@Processor`, TypeORM `@InjectRepository`/`@Entity` + relation decorators, NestJS `@Module` DI fields, HTTP calls via `HttpService`/`axios`/`fetch`, and `static`/`dynamic`/`require` import sites. With the `doc-section` extractor shipped on 2026-05-17, root-level and `docs/**/*.md` files are also ingested as first-class nodes. Anything outside NestJS/TypeScript is out of scope.

---

## 2. Extraction approach

**graphify** uses a hybrid two-pass approach. Pass A is deterministic AST extraction for code files (`graphify.extract`, runs in parallel with pass B). Pass B dispatches parallel LLM subagents over doc/paper/image chunks; each subagent returns typed edges labelled `EXTRACTED | INFERRED | AMBIGUOUS` with confidence scores. The LLM is the primary engine for cross-file semantic relationships (`conceptually_related_to`, `semantically_similar_to`, `hyperedges`). A Kimi K2.6 backend is available as a cheaper alternative to Claude.

**arch-graph** is deterministic, zero-LLM at extraction time. `ts-morph` walks AST nodes; per-domain extractors emit typed edges (`nats-publish`, `db-access`, `di-import`, etc.) with file:line source locations. The per-build recall gate enforces ≥ 95% recall (≥ 80% for TS imports) against ground truth automatically derived from the code. The optional semantic sidecar (`arch-graph semantic build`) adds dense-vector embeddings via `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384-dim) — but this is a *query-time* layer, not an extraction layer. No LLM is ever involved in building the graph.

One-liner: **graphify uses LLMs to find relationships; arch-graph uses dense vectors to find nodes.**

---

## 3. Output formats

**graphify** produces: `graphify-out/graph.json` (GraphRAG-ready node-link JSON), `GRAPH_REPORT.md` (community detection + audit trail), interactive `graph.html` (no server needed). Optional extras: `graph.svg`, `graph.graphml` (Gephi/yEd), `cypher.txt` or direct Neo4j push, Obsidian vault (one `.md` per node + `.canvas`), `wiki/index.md` (agent-crawlable wiki). MCP stdio server exposes 7 tools (`query_graph`, `get_node`, `get_neighbors`, `get_community`, `god_nodes`, `graph_stats`, `shortest_path`).

**arch-graph** produces: `arch-graph-out/graph.json`, `diagnostics.json` (every unresolved/dynamic call-site with source location), `validation.json` (per-domain recall + resolveRate), `graph.mermaid`. Semantic sidecar adds `arch-graph-out/<repo>/semantic/{manifest.json, embeddings.jsonl}`. MCP stdio server exposes 15 tools (12 structural + 3 semantic: `semantic_search`, `code_search`, `docs_search`). Ten CLI query subcommands (`who-publishes`, `table-users`, `deps-of`, `path`, `stats`, etc.) provide structured answers without MCP overhead.

---

## 4. Query model

**graphify** supports keyword-anchored BFS or DFS traversal over the stored graph (`/graphify query`, `/graphify path`, `/graphify explain`), with a configurable token budget. Matching is term-overlap on node labels — not semantic search. The graph itself, built with LLM-inferred edges, encodes the semantics; the traversal is structural. There is no dense-vector retrieval in the default pipeline (the `--mcp` flag exposes the graph to agents, but kNN search is not a built-in query mode).

**arch-graph** offers two complementary modes. **Structural**: exact graph traversal via CLI subcommands or MCP tools — "who publishes on `user.created`?" returns rows with file:line citations, no ambiguity. **Semantic**: cosine kNN over 384-dim embeddings for fuzzy intent ("find code about auth flow", "how does logging work?"). The two buckets (`code_search` / `docs_search`) are kept separate to prevent doc-section nodes from diluting code results — a dilution effect measured and documented in `README.md`. The recommended MCP agent pattern (`both-buckets`) calls both in parallel and lets the LLM pick.

---

## 5. Update model

**graphify** supports incremental re-extraction (`/graphify --update`): detects new/changed files, runs only AST for code-only changes (no LLM), runs semantic subagents for doc/image changes. A `--watch` mode rebuilds the graph automatically on file-system events (code changes: instant, no LLM; doc changes: sets a flag, requires manual `--update`). A git post-commit hook is available. An extraction cache (`graphify.cache`) skips files with unchanged hashes.

**arch-graph** rebuilds fully on every `arch-graph build`. This is cheap (sub-second on medium monorepos) because there is no LLM cost — `ts-morph` is fast. The git pre-commit hook rebuilds the graph and auto-stages output artifacts so every commit is self-consistent. The semantic sidecar is rebuilt explicitly via `arch-graph semantic build`; v1 is always full-rebuild (stale detection via `manifest.graphHash` warns if the graph drifted). Incremental semantic rebuild is noted as a v2 item.

---

## 6. Strengths

**graphify** wins on breadth: mixed media (PDF, video, images), any language/ecosystem, cross-repo graphs, community detection (Louvain clustering), "surprising connections" surfacing, Obsidian vault output for human navigation, and the GRAPH_REPORT.md audit trail with confidence tags. For a corpus that is fundamentally heterogeneous — docs + code + papers + screenshots — graphify is the only option.

**arch-graph** wins on precision and accountability in the NestJS domain. Every edge has a file:line source. The per-build recall gate (`--strict` in CI) makes regressions detectable automatically — graphify has no equivalent. The bench measured 14.3× fewer tokens per question and 100% vs 39% recall on architecture-grade queries across 4 NestJS monorepos (`bench/report.md`, 2026-05-16 post-Tier-1-2-3 run; caveat: question set was arch-graph-friendly, see bench honesty disclaimer). `diagnostics.json` surfaces unresolved dynamic identifiers honestly rather than inventing edges.

---

## 7. Weaknesses / coverage gaps

**graphify** degrades on precisely the questions arch-graph is built for: "who publishes on NATS subject X?" will produce a large, noisy context (measured at 15–53× more tokens for the same question) because it has no typed NATS-specific edge kind — the answer is buried in a flat semantic graph alongside hundreds of unrelated nodes. It has no per-build recall gate. Incremental update requires re-running LLM subagents for any non-code change. Build cost scales with corpus size due to LLM subagents. On Projects B and D in the bench, the LLM semantic pass was unavailable and only AST ran, which inflates token counts and reduces recall further.

**arch-graph** is NestJS/TypeScript-only. gRPC, Kafka, SQS, and multi-repo deployments are out of scope (limitations D2, D3 in README). It cannot reason across heterogeneous media. Community detection, cross-cutting concept inference, and "what is this codebase about?" orientation queries are outside its design. The `doc-section` feature ingests Markdown but produces retrieval-ready nodes only — there are no `doc-mentions` edges connecting docs to code entities (deferred to v2), and there is no community clustering over doc nodes.

---

## 8. Overlap

Both tools produce a `graph.json` and a MCP server. Both handle TypeScript code files in some way (graphify via LLM semantic extraction, arch-graph via AST). Both output a Mermaid-compatible artifact (graphify via graphml export, arch-graph natively). Both support CLAUDE.md integration and git hooks. The narrowest overlap is on TypeScript codebases where both can be run: arch-graph will have richer structural precision; graphify will surface cross-cutting semantic patterns. Choose arch-graph if the question is "what calls what"; choose graphify if the question is "what is this about".

---

## 9. Complementarity

Running both makes sense in at least two scenarios. First, **NestJS monorepo onboarding**: run arch-graph for structural navigation ("find what depends on this queue before refactoring") and graphify for semantic orientation ("I'm new, show me the conceptual architecture"). Second, **cross-language system**: arch-graph covers the NestJS backend; graphify covers the Python data pipeline, the ML model docs, and the design PDFs — merge them mentally by sharing arch-graph's MCP server alongside graphify's MCP server in Claude Desktop. A third scenario is the **arch-graph `compare` subcommand** itself: `arch-graph compare --graphify graphify-out/` generates a side-by-side token and recall report for your specific codebase, removing the need to take the bench numbers at face value.

---

## When to use which

| Scenario | Use |
|---|---|
| "Who publishes on NATS subject X?" | arch-graph |
| "What guards run on this endpoint?" | arch-graph |
| "What services depend on this BullMQ queue?" | arch-graph |
| "What TypeORM tables relate to entity Y?" | arch-graph |
| "Show import cycle candidates" | arch-graph |
| "Find code about authentication" (fuzzy) | arch-graph semantic search |
| "What does this Markdown doc section say about X?" | arch-graph docs_search (doc-section) |
| "I'm new to this NestJS monorepo, orient me" | graphify (community detection) |
| "Explain the codebase architecture in plain language" | graphify |
| "What do these three papers have in common?" | graphify |
| "Index this repo + its docs + a PDF ADR" | graphify |
| "Analyse a Python / Go / Rust / mixed codebase" | graphify |
| "Build a navigable Obsidian vault of this project" | graphify |
| "CI recall gate — fail build if a NATS extractor regresses" | arch-graph --strict |
| Deep NestJS + cross-cutting semantics simultaneously | both |

---

## Verdict

These tools are **complementary, not competitive**. They occupy different ends of a precision/breadth axis: arch-graph is a scalpel for NestJS wiring questions; graphify is a wide net for heterogeneous corpora. The README already frames them as sister projects, and the bench benchmarks them on arch-graph's home turf (architecture queries) — where the token efficiency gap is 14.3× and recall is 100% vs 39%. A bench on graphify's home turf (cross-cutting concept, media, orientation queries) would tilt sharply the other way.

**arch-graph users should know about graphify** when they need orientation-level understanding ("what is this about?"), when the corpus extends beyond TypeScript code, or when semantic similarity across unrelated files matters. **graphify users working on NestJS monorepos should try arch-graph** for any question that resolves to a specific edge type (pub/sub, queue, table access, module DI) — the token savings and file:line citations are material in daily agent workflows.

The only genuine competitive scenario is a TypeScript-only codebase where someone must pick one tool for a Claude Code session. For architecture navigation: arch-graph. For codebase exploration by a new team member: graphify first, arch-graph second.
