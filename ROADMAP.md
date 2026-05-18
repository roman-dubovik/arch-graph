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

Under research: Tailwind utility expansion (`text-right` → "text-align right"), per-class RU synonym dictionary, real CSS file parsing. Wait for BGE-M3 numbers first — if C_ui ≥ 50% post-migration, this work likely isn't needed.

### 🟡 3. Hybrid BM25 + semantic

Lexical signal alongside cosine for exact-term matches ("truncate", "refresh"). 3–5 days, architectural work. Likely unnecessary after BGE-M3; revisit by the numbers.

### 🟡 4. Eval corpus hygiene

A handful of project-c eval queries reference domains that don't exist in that codebase. Rewrite affected queries (~30 min) for cleaner per-project recall numbers — doesn't affect any other project.

### ⚪ 5. Additional NodeKinds on demand

- GraphQL endpoints
- Cron schedule semantics
- Extended BullMQ (currently captures `Processor`; could broaden)

By request — each extractor is 1–2 days.

### ⚪ 6. Broader eval corpus

Currently three NestJS monorepos. A Node monolith or GraphQL backend would broaden the bench shape.

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
