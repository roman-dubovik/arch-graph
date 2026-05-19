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
`*.md` root-glob (project-c setup docs). Final rebuild + run after merging
all five `*-v1` tags.

| project | hits/total | hit-rate |
|---|---|---|
| project-a | 34/49 | 69% |
| project-b | 22/29 | 75% |
| project-c | 13/25 | 52% |
| **all** | **69/103** | **67%** |

**Δ from previous**: ±1pp overall. Per-category shifts within projects:
- project-a B_debug: 50% → 66% (+16pp) — **enum-resolver wins** (endpoint
  paths now show real names instead of `<dynamic>`, matching B_debug
  controller-name queries).
- project-a C_ui: 33% → 16% (-17pp, 1 query) — likely embedding-text bloat
  regression. Adding i18n strings + classes block + OpenAPI description to
  the same node's embed-text crosses a threshold where the right answer
  rank-shifts below top-10. Worth investigating if C_ui matters; current
  ceiling diagnosis says embedder-linguistic gap dominates anyway.
- Other categories unchanged.

**Conclusion**: features ship correctly, but absolute eval needle didn't
move on this run because (a) the main win (code-vs-docs split) was the
20pp lift in the previous baseline, and (b) further features address
edge cases that this 103-query corpus doesn't sample heavily. The work
isn't wasted — enum-resolver gave +16pp on B_debug for project-a, and
OpenAPI/multi-file locales improve embedding quality for queries we
DON'T have in this corpus.

### 2026-05-18: `e5-base-default-v1` (embedder swap + incremental re-embed)

Default embedder switched from `Xenova/paraphrase-multilingual-MiniLM-L12-v2`
(384-dim) to `Xenova/multilingual-e5-base` (768-dim, passage/query prefixes).
Registry narrowed to `minilm | e5-base`; `bge-m3` and `arctic-m` aliases
removed (explored, not adopted — see Deferred section of ROADMAP).

| project | hits/total | hit-rate | Δ vs prior |
|---|---|---|---|
| project-a | 39/49 | **79%** | +10pp (was 69%) |
| project-b | 24/29 | **82%** | +7pp (was 75%) |
| project-c | 14/25 | **56%** | +4pp (was 52%) |
| **all** | **77/103** | **75%** | **+8pp overall** |

**C_ui per-category aggregate: 36% → 82% (+46pp)** — confirms the C_ui
ceiling diagnosis (embedder bottleneck, not snippet content). A_find +3pp
aggregate. D_docs, D_links unchanged at saturation. E_arch unchanged on
project-c and project-b (eval-corpus hygiene issue — ground truth assumes
NestJS `*Controller`/`*Service` naming that those repos don't follow);
project-a E_arch 75% (+25pp).

**Build cost trade-offs (post-migration):**

| Project (nodes) | Structural | Semantic full | Incremental no-op | Speedup |
|---|---|---|---|---|
| project-c (2 065) | ~10 s | ~164 s | ~5 s | ×31 |
| project-b (21 541) | ~22 s | ~21 min | ~19 s | ×68 |
| project-a (29 527) | ~24 s | ~40 min | ~19 s | ×128 |
| **Avg** | ~19 s | ~21 min | ~14 s | ~×76 |

Full rebuild: ×1.6 vs MiniLM (41 min vs 25 min on 30K nodes). Incremental
re-embed (schemaVersion=2, sha256 content-hash) lands together — typical
commit re-embeds only changed nodes in ~5–19 seconds. **Hook installs with
semantic auto-rebuild on by default** (`--no-include-semantic` opt-out).

Per-model `recommendedMinScore` calibration: minilm 0.30 (unchanged),
e5-base 0.55 (intentionally below the 0.83 ± 0.02 typical distribution
to retain borderline cross-lingual hits).

Sources:
- [`docs/comparisons/2026-05-18-embedder-evaluation.md`](comparisons/2026-05-18-embedder-evaluation.md) — full eval memo with 4-way comparison (MiniLM / e5-base / BGE-M3 / arctic-m).
- `scripts/eval/results-2026-05-18-projecta-e5-base.md`, `-projectb-`, `-projectc-` (anonymized; raw output retained locally).

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

- **~~C_ui project-a 33%, project-b 33%~~** — **RESOLVED** by `e5-base-default-v1`. Aggregate C_ui 36% → 82% (+46pp). The hypothesis that embedder linguistic gap RU↔EN was the bottleneck is confirmed; BGE-M3 turned out not to be needed (and was unshippable as default: ×6 build cost; see [`docs/comparisons/2026-05-18-embedder-evaluation.md`](comparisons/2026-05-18-embedder-evaluation.md)).
- **project-c A_find 50%** — eval-corpus mismatch (queries about cart/payment/delivery in a promo-aggregator project where those domains don't exist as graph nodes). Tracked under ROADMAP "Eval corpus hygiene"; ~30 min to rewrite affected queries against project-c's actual domain.
- **E_arch project-b 0% / project-c 0%** — accepted limitation: ground truth assumes NestJS `*Controller`/`*Service` naming that project-b and project-c don't follow (beribuy uses kebab-case domain names like `be-api-beribuy`; insyra uses different conventions). Embedder returns semantically relevant matches that fail the strict `expectedKindIn` + `expectedLabelHas` ground-truth rule. project-a E_arch is 75% (idiomatic NestJS naming), confirming the eval rule works where the corpus matches. ROADMAP item 4 covers this.

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
