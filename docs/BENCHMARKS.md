# arch-graph benchmarks

Durable record of semantic-search recall measurements on the eval corpus.
Re-runs after every shipped feature so changes can be measured.

## Eval corpus

- **103 queries** across 3 NestJS-style projects (project-a, project-b, project-c)
- **6 categories**:
  - `A_find` — "where is X implemented" (looking for code)
  - `B_debug` — "why is X failing / how does X log"
  - `C_ui` — UI / frontend visual behavior queries
  - `E_arch` — architecture / "how does X work" questions
  - `D_docs` — single-shot doc-RAG (target is doc-section nodes)
  - `D_links` — multi-hop queries needing both code + docs context
- **HIT definition**: top-K contains a node satisfying score ≥ minScore AND
  kind ∈ expectedKindIn AND label substring ∈ expectedLabelHas.

Corpus file: `scripts/eval/queries.json`.

## How to re-run

```sh
# Pre-condition: indexes already built per project (or set SKIP_BUILD=0 to rebuild)
SKIP_BUILD=1 EVAL_MODE=both-buckets bash scripts/run-baseline-eval.sh
# Output → scripts/eval/results-<DATE>-both-buckets.md
```

Modes (set via `EVAL_MODE` env):
- `single` — single search call, no kind-bucket filter (legacy baseline)
- `per-category` — route by query category (A→code, D→docs, etc.)
- `fallback` — try `code_search` first; on miss retry `docs_search`
- `both-buckets` — always issue both calls; HIT if either bucket satisfied

For apples-to-apples comparison with future embedder swaps, use
`EVAL_MODE=both-buckets` and `EVAL_K=10` (script defaults).

## Result archive

All result tables are committed to git for historical comparison.
Filename pattern: `scripts/eval/results-<DATE>-<MODE>.md`.

## Baselines (chronological)

### Pre-2026-05-17: original baseline (before semantic features)

Single-call mode, K=5, only 4 categories (60 queries, no docs/links):

| project | hits/total | hit-rate |
|---|---|---|
| project-a | 17/30 | 56% |
| project-b | 9/15 | 60% |
| project-c | 6/15 | 40% |
| **all** | **32/60** | **53%** |

Source: `scripts/eval/results-2026-05-17.md`.

### 2026-05-17: post-doc-section (dilution regression visible)

After doc-section was added to the index, single-call mode now diluted by
~25k doc-section nodes for code queries.

| project | hits/total | hit-rate |
|---|---|---|
| project-a | 21/49 | 42% |
| project-b | 15/29 | 51% |
| project-c | 12/25 | 48% |
| **all** | **48/103** | **47%** |

Source: in-flight eval log on develop tip pre-`code-vs-docs-v1`.

### 2026-05-17: `code-vs-docs-v1` (split tools)

`code_search` + `docs_search` MCP tools. Both `fallback` and `both-buckets`
modes give identical hit-rate (mathematically equivalent for our HIT metric;
difference is only LLM context richness).

| project | hits/total | hit-rate |
|---|---|---|
| project-a | 34/49 | 69% |
| project-b | 23/29 | 79% |
| project-c | 13/25 | 52% |
| **all** | **70/103** | **68%** |

Source: `scripts/eval/results-2026-05-17-both-buckets.md`.

**Δ from previous**: +21pp overall. Specifically A_find project-a 30→70%
(+40pp), project-b A_find 20→70% (+50pp), E_arch 25→62% / 0→50%.

### 2026-05-17: `ui-uplift-v1` rebuild

Tasks A (classes block) + B (i18n) on real projects. Numbers virtually
unchanged from previous — confirmed UI bottleneck is embedder, not snippet:

| project | hits/total | hit-rate |
|---|---|---|
| project-a | 34/49 | 69% |
| project-b | 22/29 | 75% |
| project-c | 13/25 | 52% |
| **all** | **69/103** | **67%** |

**Δ**: -1pp (noise/rebuild variance). UI uplift had no measurable effect
because (a) projects didn't have i18n message files in canonical paths
(fixed in `fe-i18n-multi-enum-v1`), and (b) RU→EN Tailwind lexical bridge
is missing (BGE-M3 candidate).

### 2026-05-17: cumulative — `fe-i18n-multi-enum-v1` + `openapi-enrich-v1` + `*.md`-glob

Combined effect of: multi-file locales (project-b benefits), enum-resolver
(project-c path resolution), OpenAPI YAML (project-c description text),
`*.md` root-glob (project-c setup docs).

**Numbers TBD** — eval `b0ebgp50l` running at time of writing. Results will
land in `scripts/eval/results-2026-05-17-both-buckets.md` (overwrite).

## Per-feature attribution (rule of thumb)

Approximate impact each feature contributes when isolated. Sum is NOT
additive — overlaps and ceiling effects matter.

| Feature | Tag | Mainly helps | Expected uplift |
|---|---|---|---|
| Semantic sidecar baseline | (pre-`doc-section-v1`) | Everything | foundation |
| doc-section indexing | `doc-section-v1` | D_docs, D_links | +20-30pp on doc queries |
| Code/Docs bucket split | `code-vs-docs-v1` | A_find, B_debug, C_ui (dilution fix) | +20pp overall |
| UI snippet/i18n extension | `ui-uplift-v1` | C_ui in projects with i18n | +0-5pp (depends on stack) |
| OpenAPI YAML enrichment | `openapi-enrich-v1` | A_find on projects with rich YAML | +3-10pp on project-c |
| Multi-file locales | `fe-i18n-multi-enum-v1` (part 1) | C_ui on project-b-style stacks | +2-5pp |
| Enum-resolver | `fe-i18n-multi-enum-v1` (part 2) | A_find on enum-prefixed NestJS | +10pp on project-c |
| Root `*.md` glob | (config) | D_docs on projects with non-standard docs | +1-2pp |

## Open targets

Where the recall budget is still tight, with planned interventions:

- **C_ui project-a 33%, project-b 33%** — embedder linguistic gap RU↔EN. BGE-M3 is the next bet (~+5-10pp expected). See `docs/research/2026-05-17-css-processing-feasibility.md`.
- **project-c A_find 30%** — should rise after enum-resolver (in flight). Remaining MISSes are likely eval-corpus issues (queries about cart/payment/delivery in a promo-aggregator project). See project-c diagnostic in chat archive.
- **E_arch project-b 50% / project-c 0%** — needs more sample queries plus possibly architectural-overview indexing (e.g. extract module-graph summaries).

## Comparison axes for future model swaps

When swapping embedder (e.g. MiniLM → BGE-M3), measure:

1. **Per-category recall delta** at K=10, both-buckets — apples-to-apples comparison with table above.
2. **Per-query MISS list** — diff before/after to identify which queries newly hit (good signal) vs newly miss (regression).
3. **Index size** (`du -sh arch-graph-out/<repo>/semantic/`) — bge-m3 is ~4× MiniLM dim.
4. **Build time** — embedding throughput matters for incremental updates.
5. **Per-call retrieval latency** — cosine over more vectors is linear; check it's still <100ms.

## When to update this file

After any change that could move recall:
- New extractor or NodeKind shipped (`*-v1` tag).
- Embedder model swap.
- Snippet content extension for an existing kind.
- Eval corpus changes (new queries / categories — note prominently).

Append a new section, do NOT overwrite previous baselines — historical
trail is the whole point.
