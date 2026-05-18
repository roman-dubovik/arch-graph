# arch-graph roadmap

_Last updated: 2026-05-18_

No ETAs. Order within a section is rough priority, not a commitment.

## Where we are

A deterministic TypeScript architecture-graph builder for NestJS monorepos with an optional local multilingual semantic sidecar. Pipeline: ts-morph extractors → `graph.json` + (optional) `embeddings.jsonl` + `manifest.json`. **Zero LLM tokens at build and query.**

## Shipped

### Foundation (2026-05-16)

- **Cycle detection** — Johnson's algorithm across `ts-import` / `lib-usage` / `di-import` subgraphs; surfaced in `diagnostics.cycles`; cycle-aware Mermaid output.
- **Semantic sidecar** — `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384-dim) via `transformers.js`. CLI: `arch-graph semantic build` / `arch-graph semantic search`. MCP tool: `semantic_search`. Persisted at `arch-graph-out/<repo>/semantic/{manifest.json, embeddings.jsonl}`. In-process, no API key, no GPU, no network.
- **Guards / Interceptors / Pipes** — `@UseGuards`, `@UseInterceptors`, `@UsePipes` captured as typed edges (`di-guard`, `di-interceptor`, `di-pipe`) with `attachedTo: class | method:<name>`.
- **TypeORM entity-relation edges** — `@ManyToOne`, `@OneToMany`, `@ManyToMany`, `@OneToOne` → `db-table → db-table` edges with kind `db-relation`.
- **Multi-module-system imports** — `require(...)` captured alongside static `import` and dynamic `import()`.

### Post-semantic expansion (2026-05-17)

| Tag | What |
|-----|------|
| `doc-section-v1` | Markdown sections as `doc-section` graph nodes, indexed alongside code (README, CHANGELOG, ADRs, `docs/`). |
| `code-vs-docs-v1` | MCP tools `code_search` + `docs_search` split — fixes bucket dilution where doc-sections crowded out code in mixed-result lists. A_find recall: 80% → 30% (mixed) → 70% (split). |
| `ui-uplift-v1` | `fe-component` snippet enriched with JSX/className tokens + i18n strings folded into embed text. |
| `openapi-enrich-v1` | OpenAPI YAML descriptions attached to endpoint nodes via `operationId` or `method+path`. |
| `fe-i18n-multi-enum-v1` | Multi-file locales (`locales/<lang>/<feature>.json`) + TS-enum resolver in `@Controller` / `@Get` route decorators. |
| `snippet-fix-all-kinds-v1` | Snippet-extractor correctness pass across all NodeKinds. |
| `closing-tails-v1` | Module recall on three reference monorepos: 92.3% / 79.7% / 57.1% → 100% across the board. |

### Bench + public release (2026-05-18)

- `init-strategy-v1` — `arch-graph init` strategy refinement.
- **103-query post-semantic head-to-head bench** published — see [`docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md`](./docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md).
- **Self-build mini-bench** — 12 queries against arch-graph's own codebase, no external project required — see [`bench/self-build/README.md`](./bench/self-build/README.md).
- **Independent revalidation** — 5/6 numbers reproduce at 0.0pp; one re-rank delta documented as a strict-mode sensitivity limitation.
- **Public release** on `main` with anonymized history (single squash commit, no PII / proprietary names leaked).

## Recall trajectory (103-query bench, 3 NestJS monorepos)

| Run | Mode | Recall |
|-----|------|--------|
| Session start | `single`, K=5 | 47% |
| After `code-vs-docs` split | `both-buckets`, K=10 | 67% |
| vs graphify on the same suite — RU queries | both-buckets, K=10 | **arch-graph 67% / graphify 35%** (+32pp) |
| vs graphify on the same suite — EN-keyword strict | top-10 NODE lines | **arch-graph 53.6% / graphify 56.5%** (near tie) |

The RU lead is multilingual handling (MiniLM is multilingual; graphify keyword-BFS is English-only). Under EN-keyword strict apples-to-apples scoring the two tools are within 3pp.

## Strategic options — what's next

### 🟢 1. BGE-M3 migration (priority 1)

Replace MiniLM-L12 (384-dim) with `bge-m3` (1024-dim). Forecast: +5–10pp overall, especially **C_ui** category (which is stuck at 33–50%) and RU-only queries.

- Effort: 1–2 days.
- Cost: one-time index re-build per repo; 4× memory per vector.
- Compat: `manifest.json` already carries `model` — backward-compat path exists.

### 🟡 2. CSS / UI semantics (gated on BGE-M3)

Under research: Tailwind utility expansion (`text-right` → "text-align right"), per-class RU synonym dictionary, real CSS file parsing.

**Hypothesis**: C_ui caps at 33–50% because the **embedder** weakly maps RU intent to EN technical vocabulary, not because the snippets lack tokens. Concrete case from the eval: query «обрезать сообщение в 3 точки» misses a `<p className="truncate text-ellipsis">` node — the snippet contains both `truncate` and `text-ellipsis`, but MiniLM-L12 doesn't bridge them to the Russian phrasing. If the bottleneck is the embedder's cross-lingual mapping, BGE-M3 (1024-dim, larger multilingual + technical corpus) should fix it without any snippet changes.

**Decision rule**: ship BGE-M3 first, re-measure C_ui. If ≥ 50% — skip this work entirely (the hypothesis held; the embedder was the limit). If still < 50% — pick one of the three CSS approaches by error analysis on the surviving misses.

### 🟡 3. Hybrid BM25 + semantic

Lexical signal alongside cosine for exact-term matches ("truncate", "refresh"). 3–5 days, architectural work. Likely unnecessary after BGE-M3; revisit by the numbers.

### 🟡 4. Eval corpus hygiene

A handful of project-c eval queries reference domains that don't exist in that codebase. Rewrite affected queries (~30 min) for cleaner per-project recall numbers — doesn't affect any other project.

### 🟡 5. Incremental semantic re-embed

Today every `arch-graph semantic build` is a **full re-embed of the entire graph** — there is no node-level cache. On a 30k-node monorepo that's ~20 min with MiniLM and **1–3 hours with BGE-M3**. The cost is one-time per rebuild, but the rebuild becomes painful on any codebase change loop that wants a fresh semantic index.

The git hook installed by `arch-graph hook install` only re-runs the **structural** build (`arch-graph build`, seconds). Semantic re-embed is opt-in / manual. Stale indexes degrade gracefully via `graphHashMatches: false` + a warning, but the warning nudges the user toward a full rebuild — and on a large repo with BGE-M3 enabled, that nudge stops being friendly.

**Approach.** Key each node's embedding by `(nodeId, content_hash)` where `content_hash` is the SHA of the text fed to the embedder (snippet + label + relevant metadata). At build time:
1. Read prior `embeddings.jsonl` if present and compatible (same `model` + `dim`).
2. For each node in the new graph, compute `content_hash`. If `(nodeId, content_hash)` exists in the prior file → reuse vector. Else → enqueue for re-embed.
3. Write the merged set as the new `embeddings.jsonl`. Drop entries whose `nodeId` no longer exists in the new graph (cleanup).
4. Manifest stores `model`, `dim`, new `graphHash` as today.

**Expected impact.** Typical PR touches < 5% of nodes. On a 30k-node BGE-M3 index that drops 2h rebuild to ≤ 6 min. Makes BGE-M3-as-default conversation plausible on large repos.

**Effort.** 2–3 days. Real test: rebuild self-build twice (no code change between runs) and verify zero embedder calls on the second build via a counter.

**Hard prerequisite for default-switching to BGE-M3.** Even if the 103-query bench shows ≥ 5pp lift, the 2h-3h cold rebuild on a 30k-node repo is a UX regression that this item must close first.

### ⚪ 6. Additional NodeKinds on demand

- GraphQL endpoints
- Cron schedule semantics
- Extended BullMQ (currently captures `Processor`; could broaden)

By request — each extractor is 1–2 days.

### ⚪ 7. Broader eval corpus

Currently three NestJS monorepos. A Node monolith or GraphQL backend would broaden the bench shape.

### ⚪ 8. Semantic extension of `compare --share`

Today `compare --share` measures structural graph size (nodes, edges, tokens) and emits anonymous numbers for the public bench Discussion. Adding a semantic recall number would let each contributor publish two data points instead of one — and surface the multilingual handling feature in community-comparable numbers.

**Mode A — paraphrase recall (deterministic, no LLM)**: auto-generate 2–3 queries per sampled node from templates (`endpoint:UsersController.create` → "how do we create users" / "create user endpoint"); score by whether the source node is in top-K. Single recall percentage in the share payload. ~1–2 days.

**Mode B — multilingual delta** (extension of A): generate the same templates in two languages (EN + user-picked once via `arch-graph init`); emit two percentages. The gap exposes the multilingual embedder feature in one number. Translation tables (~20 templates per language) are deterministic, no LLM. +0.5 days.

**Mode C — LLM-generated queries** (NOT for `--share`): a separate `arch-graph semantic eval --llm` command — non-deterministic, non-comparable, useful for local self-eval, but not appropriate for the community contribution stream. 2–3 days if it ships at all.

**Deferred** because contribution volume is currently low. Revisit when external `bench/contributed/` submissions accumulate and the marginal value of a second number per submission becomes meaningful.

## Deferred / explicit non-goals

### `v2 doc-mentions` edges — won't ship

After `doc-section` reached D_docs = 100%, single-shot retrieval over doc nodes is sufficient. Edges would add explainability, not recall.

### Hybrid mode: consume `@nestjs/devtools-integration` snapshot

Optional `--devtools-snapshot <graph.json>` to merge runtime DI authority with static cross-cutting edges. Still on the table — revisit if a real failure mode appears (currently static decorator parse covers ≥ 95% of structural questions on the reference set).

### Better cycle-aware Mermaid grouping

Visual layering by architectural tier (apps → libs → external). Polish, optional.

### Cross-language coverage (Joern, scip-ts polyglot)

arch-graph is TS-only by charter. CPG abstraction is wrong level (statements/data-flow, not architectural edges).

### Runtime trace integration (OpenTelemetry)

Complementary, not competing. Possible future `--otel-snapshot` mode if user demand emerges.

## Known limits (honest)

- **Static extraction** — cannot see runtime config, container env, dynamically-built identifiers. Recorded in `diagnostics.json`.
- **C_ui recall ceiling 33–50%** — bounded by current embedder. UI uplift + i18n shipped, but the numbers didn't move; the bottleneck is multilingual mapping of UI vocabulary, not snippet content.
- **i18n format coverage** — supports `messages/*.json` and `locales/<lang>/<feature>.json`. Doesn't yet cover `react-intl` ICU bundles or server-side `.po` files.
- **Eval set is three NestJS monorepos** — broader shapes (Node monoliths, GraphQL backends) not yet represented in the published numbers.
- **No incremental semantic re-embed** — every `arch-graph semantic build` re-embeds the entire graph. ~20 min on a 30k-node repo with MiniLM, 1–3 hours with BGE-M3. The git hook only re-runs the structural build (seconds), so this doesn't bite per-commit, but a user who wants a fresh semantic index after a refactor pays the full cost each time. See Strategic option #5 — closing this is a hard prerequisite for any conversation about switching default to BGE-M3.

## Open questions

1. **BGE-M3 — when?** Highest-ROI item on the list; 1–2 days; needs one-time index re-build.
2. **Eval corpus hygiene** — rewrite project-c queries to match actual domain, or preserve historical comparability across runs?
3. **Expand eval corpus?** Add a non-NestJS shape (Node monolith, GraphQL).

## Related artifacts

- [`docs/BENCHMARKS.md`](./docs/BENCHMARKS.md) — durable single-page summary of benchmark numbers.
- [`docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md`](./docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md) — full 103-query memo.
- [`docs/comparison.html`](./docs/comparison.html) — capability matrix (who covers what).
- [`bench/REPRODUCE.md`](./bench/REPRODUCE.md) — reproduce the published bench on your own monorepo.
- [`bench/self-build/README.md`](./bench/self-build/README.md) — 12-query mini-bench against arch-graph's own codebase.

## How to contribute

Issues with a real failure mode + reproduction context (repo shape, query, expected vs actual) get re-evaluated against the deferred items above.
