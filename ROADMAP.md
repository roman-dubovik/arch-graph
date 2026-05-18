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

### e5-base as default embedder (2026-05-18) — `e5-base-default-v1`

`Xenova/multilingual-e5-base` (768-dim, passage/query prefixes) replaces MiniLM-L12 (384-dim) as the default embedder. Aggregate recall 69% → 75% (+6pp); C_ui 36% → 82% (+46pp). Incremental re-embed lands in the same migration set — hook default-on. BGE-M3 and arctic-m aliases removed from the registry; users who need 1024-dim multilingual must fork.

| What | Detail |
|---|---|
| Recall | 69% → 75% aggregate (+6pp, 103 queries, 3 projects) |
| C_ui | 36% → 82% (+46pp) — embedder was the bottleneck |
| Build cost | ~41 min on 30K nodes (×1.6 vs MiniLM 25 min); incremental brings typical commit to ~1-2 s |
| Disk | ~280 MB model download (was ~135 MB) |

See [`docs/comparisons/2026-05-18-embedder-evaluation.md`](./docs/comparisons/2026-05-18-embedder-evaluation.md) for the full evaluation memo.

## Recall trajectory (103-query bench, 3 NestJS monorepos)

| Run | Mode | Model | Recall |
|-----|------|-------|--------|
| Session start | `single`, K=5 | MiniLM | 47% |
| After `code-vs-docs` split | `both-buckets`, K=10 | MiniLM | 67% |
| vs graphify on the same suite — RU queries | `both-buckets`, K=10 | MiniLM | **arch-graph 67% / graphify 35%** (+32pp) |
| vs graphify on the same suite — EN-keyword strict | top-10 NODE lines | MiniLM | **arch-graph 53.6% / graphify 56.5%** (near tie) |
| **Embedder swap (2026-05-18)** | `both-buckets`, K=10 | **e5-base** | **75%** (+6pp vs MiniLM 69%, **C_ui 36→82%**) |

The RU lead is multilingual handling (MiniLM is multilingual; graphify keyword-BFS is English-only). Under EN-keyword strict apples-to-apples scoring the two tools are within 3pp. The e5-base swap added another +6pp aggregate and confirmed the C_ui-ceiling-is-the-embedder hypothesis.

## Strategic options — what's next

### ~~1. e5-base as new default embedder~~ — SHIPPED (`e5-base-default-v1`, 2026-05-18)

See "Shipped" section above.

### ~~2. Incremental semantic re-embed~~ — SHIPPED (2026-05-18)

`arch-graph semantic build` is now incremental by default. Node vectors are keyed by `(nodeId, contentHash)` where `contentHash` is a SHA-256 of `kind|label|snippet|modelAlias`. A prior-compatible index is loaded on each run; unchanged nodes reuse their vectors. The git hook runs `semantic build --incremental` automatically. Typical commit cost: ~1-2 s.

### 🟡 3. Per-model `minScore` calibration

`queries.json` currently uses a uniform `minScore: 0.5` floor. On MiniLM, top-1 scores cluster around 0.56±0.08 — 0.5 is a meaningful filter. On e5-base, top-1 scores cluster at 0.83±0.02 — 0.5 is a no-op. For default-switch to e5-base, the user-facing `minScore` semantic ("how confident does the result have to be") needs to differ per model. Suggested e5-base floor ≈ 0.78 (mean − 3σ — matches MiniLM 0.50 in terms of "filter floor"). Schema change in `queries.json` + default in `arch-graph semantic search` opts. ~1 day.

### 🟡 4. Eval corpus hygiene

A handful of project-c eval queries reference domains that don't exist in that codebase (e.g. I15 expects `provider`/`service` with label `"Auth"` but those nodes don't exist in insyra's graph either — only `useAuth` fe-hook). Rewrite affected queries (~30 min) for cleaner per-project recall numbers — doesn't affect any other project.

### ⚪ 5. Additional NodeKinds on demand

- GraphQL endpoints
- Cron schedule semantics
- Extended BullMQ (currently captures `Processor`; could broaden)

By request — each extractor is 1–2 days.

### ⚪ 6. Broader eval corpus

Currently three NestJS monorepos. A Node monolith or GraphQL backend would broaden the bench shape.

### ⚪ 7. Semantic extension of `compare --share`

Today `compare --share` measures structural graph size (nodes, edges, tokens) and emits anonymous numbers for the public bench Discussion. Adding a semantic recall number would let each contributor publish two data points instead of one — and surface the multilingual handling feature in community-comparable numbers.

**Mode A — paraphrase recall (deterministic, no LLM)**: auto-generate 2–3 queries per sampled node from templates (`endpoint:UsersController.create` → "how do we create users" / "create user endpoint"); score by whether the source node is in top-K. Single recall percentage in the share payload. ~1–2 days.

**Mode B — multilingual delta** (extension of A): generate the same templates in two languages (EN + user-picked once via `arch-graph init`); emit two percentages. The gap exposes the multilingual embedder feature in one number. Translation tables (~20 templates per language) are deterministic, no LLM. +0.5 days.

**Mode C — LLM-generated queries** (NOT for `--share`): a separate `arch-graph semantic eval --llm` command — non-deterministic, non-comparable, useful for local self-eval, but not appropriate for the community contribution stream. 2–3 days if it ships at all.

**Deferred** because contribution volume is currently low. Revisit when external `bench/contributed/` submissions accumulate and the marginal value of a second number per submission becomes meaningful.

## Deferred / explicit non-goals

### BGE-M3 — explored, not adopted (2026-05-18)

Originally proposed as priority-1 C_ui fix. **Outcome**: aborted at 2h40m on a 30k-node monorepo without completing the build. e5-base delivers the same C_ui win at 6× faster build cost. **Registry alias removed as of `e5-base-default-v1`**; users who need 1024-dim multilingual must fork or add the alias locally. Historical exploration on branch `feat/bge-m3-migration`. Bench artefacts at `/tmp/bge-m3-bench/`.

### Arctic Embed M v2.0 — explored, not adopted (2026-05-18)

Spike result: sanity bench on project-c (beribuy-2.0, 2065 nodes, mode=both-buckets) returned **20% hit-rate vs 56-60% baselines** — broken.

Root cause: `Snowflake/snowflake-arctic-embed-m-v2.0` is built on Alibaba GTE base (`model_type: "gte"`). `@xenova/transformers@2.17.2` does not register the `gte` class and falls back to a generic BERT encoder-only construction, silently dropping RoPE positional encoding and other GTE-specific layers. Output vectors are numerically plausible but semantically wrong.

2-brain (sister project) is running the same model on `@huggingface/transformers` v3 and reports 96% recall@10 + 43% top-5 density (semantic-only). So the model itself is viable — the blocker is the package migration.

**Cost to unblock:** swap `@xenova/transformers` → `@huggingface/transformers` (different npm scope; `pipeline()` API surface, env config, ONNX backend, and cache layout all differ). ~150 LoC of mock-shape updates in the test suite. Estimated 1-2 days of focused work, separate worktree.

**Registry alias removed as of `e5-base-default-v1`**; e5-base alone closes the C_ui gap. Users who need GTE-family embedders must wait for the `@huggingface/transformers` v3 migration or maintain a fork. Bench artefacts at `/tmp/bge-m3-bench/results-projectc-arctic-m.md`.

### CSS / UI semantics — closed by e5-base (2026-05-18)

Original hypothesis: C_ui ceiling 33–50% because the embedder weakly maps RU intent to EN technical vocabulary. e5-base lifted C_ui to 82% with no snippet changes → hypothesis confirmed, **embedder was the bottleneck**. No further CSS-processing work needed unless a future model regression on C_ui appears.

### Hybrid BM25 + semantic — low value after e5-base

Lexical signal alongside cosine for exact-term matches ("truncate", "refresh"). 3–5 days, architectural work. e5-base's stronger multilingual handling closed most of the gap that BM25 would have helped. Revisit only if a concrete failure mode (specific category dropping below threshold) appears.

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
- **~~C_ui recall ceiling 33–50%~~ — RESOLVED (2026-05-18)**: lifted to 82% by switching to e5-base embedder. Hypothesis (embedder, not snippets) confirmed.
- **i18n format coverage** — supports `messages/*.json` and `locales/<lang>/<feature>.json`. Doesn't yet cover `react-intl` ICU bundles or server-side `.po` files.
- **Eval set is three NestJS monorepos** — broader shapes (Node monoliths, GraphQL backends) not yet represented in the published numbers.

## Open questions

1. **Eval corpus hygiene** — rewrite project-c queries to match actual domain, or preserve historical comparability across runs?
2. **Expand eval corpus?** Add a non-NestJS shape (Node monolith, GraphQL).

## Related artifacts

- [`docs/BENCHMARKS.md`](./docs/BENCHMARKS.md) — durable single-page summary of benchmark numbers.
- [`docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md`](./docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md) — full 103-query memo.
- [`docs/comparison.html`](./docs/comparison.html) — capability matrix (who covers what).
- [`bench/REPRODUCE.md`](./bench/REPRODUCE.md) — reproduce the published bench on your own monorepo.
- [`bench/self-build/README.md`](./bench/self-build/README.md) — 12-query mini-bench against arch-graph's own codebase.

## How to contribute

Issues with a real failure mode + reproduction context (repo shape, query, expected vs actual) get re-evaluated against the deferred items above.
