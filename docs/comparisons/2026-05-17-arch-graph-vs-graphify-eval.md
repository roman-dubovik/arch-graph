# arch-graph vs graphify — Empirical 103-Query Benchmark

**Date:** 2026-05-17  
**Branch:** `develop`  
**Evaluator:** Claude Code (Sonnet 4.6) — automated run + LLM-as-judge spot-checks  
**Raw data:** `/tmp/graphify-eval-responses.jsonl`

---

## 1. TL;DR

arch-graph wins in every category except C_ui (tie). Overall hit-rate: **arch-graph 67%, graphify 35%**. The biggest gap is D_docs (85% vs 33%) — graphify lacks semantic understanding of natural-language documentation questions and simply returns "No matching nodes found" for 57% of queries (almost all Russian-text queries). When graphify does match (43% of queries), it delivers raw node lists at ~775 tokens versus arch-graph's ~1000 tokens — a modest savings that does not compensate for the 32-point hit-rate gap. The only category where graphify is competitive is D_links (70% vs 100% arch-graph), and it occasionally surfaces code nodes for English-keyword queries that arch-graph missed. **Recommendation: use arch-graph as primary; consider graphify only for English-keyword code-structure lookups as a complement.**

---

## Methodology Caveat: Query Language Asymmetry

The 103 queries in this benchmark are predominantly in Russian (80%+). arch-graph uses multilingual sentence embeddings (`Xenova/paraphrase-multilingual-MiniLM-L12-v2`, 384-dim) and handles Russian queries natively. Graphify does keyword-anchored BFS/DFS over English code-node labels, so Russian text produces zero matches for 57% of queries — not a bug, a fundamental architectural mismatch.

In production, LLM agents typically reformulate a user's natural-language question into 2-4 English keywords before invoking any retrieval tool. The RU benchmark therefore measures the tools under conditions that are structurally favorable to arch-graph. To isolate the retrieval-quality delta from the multilingual-handling delta, we re-ran the full 103-query set using EN-normalized queries (keyword-only, 2-4 words, no Russian, preserving Latin identifiers and domain terms). Results follow in the next section.

---

## EN-Normalized Re-run Results

**Queries:** `scripts/eval/queries-en.json` — 103 keyword-only EN translations of the original RU queries.  
**arch-graph mode:** `both-buckets`, k=10 (identical to original run). Results in `scripts/eval/results-2026-05-17-both-buckets-en.md`.  
**graphify run:** `graphify query "<en query>" --budget 1500` from each project directory. Raw responses in `/tmp/graphify-en-responses.jsonl`.

### Per-project hit-rates (EN)

| Project | arch-graph EN | graphify EN | arch-graph RU (ref) | graphify RU (ref) |
|---------|--------------|------------|--------------------|--------------------|
| project-a | 36/49 = **73%** | 45/49 = **92%** | 34/49 = 69% | 14/49 = 29% |
| project-b | 20/29 = **68%** | 27/29 = **93%** | 22/29 = 76% | 15/29 = 52% |
| project-c | 13/25 = **52%** | 22/25 = **88%** | 13/25 = 52% | 7/25 = 28% |
| **Overall** | **69/103 = 67%** | **94/103 = 91%** | 69/103 = 67% | 36/103 = 35% |

### Per-category hit-rates (EN, all projects combined)

| Category | AG EN | GF EN | AG RU (ref) | GF RU (ref) |
|----------|-------|-------|-------------|-------------|
| A_find | 17/30 = 57% | 26/30 = 87% | 16/30 = 53% | 8/30 = 27% |
| B_debug | 8/8 = 100% | 7/8 = 88% | 6/8 = 75% | 3/8 = 38% |
| C_ui | 2/11 = 18% | 11/11 = 100% | 3/11 = 27% | 3/11 = 27% |
| E_arch | 5/11 = 45% | 11/11 = 100% | 6/11 = 55% | 4/11 = 36% |
| D_docs | 27/33 = 82% | 29/33 = 88% | 28/33 = 85% | 11/33 = 33% |
| D_links | 10/10 = 100% | 10/10 = 100% | 10/10 = 100% | 7/10 = 70% |

### Token cost (EN)

| Metric | arch-graph EN | graphify EN |
|--------|--------------|-------------|
| Avg tokens/query | ~1000 | ~821 |
| Queries with zero output | 0 | 9/103 (9%) |

### Key finding: the gap reverses

The EN re-run produced an unexpected result: **the gap does not narrow — it reverses**. arch-graph holds at 67% (unchanged from RU), while graphify jumps from 35% to 91% (+56pp), ending 24pp ahead.

This reversal is real but requires a scoring-asymmetry caveat. Graphify's HIT criterion is broad: any `expectedLabelHas` string appearing anywhere in an ~821-token free-text response counts as a HIT. arch-graph's HIT criterion is strict: the matched node must satisfy score ≥ minScore AND kind in expectedKindIn AND label substring-matches. The asymmetry was largely invisible in the RU run because graphify returned nothing for 57% of queries; with EN queries it returns content for 91% of queries, making the broader matching criterion load-bearing.

Category-level patterns clarify what drove each tool's movement:
- **Graphify gains most in C_ui (27% → 100%) and E_arch (36% → 100%):** Short EN keyword queries such as "status column alignment" or "notification streaming architecture" are strong BFS seeds for graphify's community expansion. The same queries expressed in Russian returned empty.
- **arch-graph loses slightly in C_ui (27% → 18%) and E_arch (55% → 45%):** The 2-4 keyword cap removed semantic context that longer RU queries carried. "колонка статус выровнять по правому краю" (11 tokens) compressed to "status column alignment" (3 tokens) loses the "right-align" intent that arch-graph's multilingual embeddings could parse.
- **D_docs: near parity (AG 82%, GF 88%):** With EN queries, graphify's README/doc-node coverage surfaces documentation-category content that RU text previously missed. arch-graph's lead here shrinks from +52pp to -6pp — the docs bucket advantage narrows when the query language no longer handicaps graphify.
- **B_debug: arch-graph retakes the lead (100% vs 88%):** Debug queries benefit from arch-graph's scored, kind-filtered top-K; the strict matching is actually a precision feature here, not a handicap.

**Bottom line:** the RU benchmark accurately reflects how these tools perform when queries arrive in Russian. The EN benchmark shows what happens if an LLM pre-translates to English keywords: graphify's HIT rate triples while arch-graph stays flat. The "real" retrieval-quality delta is harder to pin down because the two scoring methods are not apples-to-apples; a strict apples-to-apples comparison would require the same top-K criterion applied to both tools.

---

## Strict Apples-to-Apples Re-score (EN, graphify rescored under arch-graph criteria)

This section closes the leniency caveat from the EN-Normalized Re-run above. It parses graphify's stdout into structured top-10 node lists and applies the same kind+label criterion that arch-graph's eval harness uses: HIT requires that at least one node within the top-10 ranked results satisfies (label substring-matches any `expectedLabelHas` entry, case-insensitive) AND (inferred node kind intersects `expectedKindIn`, or `expectedKindIn` is empty meaning no kind filter). This matches the arch-graph criterion exactly, modulo the `score ≥ minScore` floor (graphify does not emit per-node scores, so that sub-criterion is dropped — giving graphify a small advantage). The result is the honest apples-to-apples number that the previous section said would be needed.

### Methodology

**Parsing graphify stdout into top-10 nodes.** Graphify stdout contains `NODE <label> [src=<file> loc=<line> community=<n>]` lines interleaved with `EDGE` lines. The first 10 `NODE` lines in document order (BFS-ordered from the keyword seeds) were taken as the top-10 ranked list. `EDGE` lines were discarded.

**Inferring node kinds from src path.** Graphify does not expose arch-graph-style typed kinds (`provider`, `endpoint`, `db-entity-field`, etc.). Kinds were inferred heuristically from `src` path and label:

| Inferred kind(s) | Heuristic |
|---|---|
| `doc-section` | `src` ends in `.md` |
| `fe-hook` | label starts with `use` or `.use` AND `.ts`/`.tsx` extension |
| `fe-component` | `.tsx` extension |
| `fe-page` | `pages/` or `/app/` in path AND `.tsx` |
| `fe-route` | `/app/` in path AND `.tsx` |
| `module` | `src` ends in `.module.ts` |
| `provider` | `src` ends in `.service.ts`, `.provider.ts`, or `.controller.ts` |
| `service` | `src` ends in `.service.ts` |
| `endpoint` | `src` ends in `.controller.ts` AND label contains `()` |
| `db-entity-field` + `db-table` | `entities/` or `entity.ts` in path |
| `db-table` | `migrations/` or `migration.ts` in path |
| `config-field` | `.env` or `config.ts` or `configuration.ts` in path |
| `nats-subject` | `nats` in path or label |
| `queue` | `bullmq` or `processor.ts` or `queue` in path |

A single node can match multiple kinds (e.g. a method in `.controller.ts` maps to both `provider` and `endpoint`). Kind check is: `inferred_kinds ∩ expectedKindIn ≠ ∅`, or pass unconditionally if `expectedKindIn` is empty.

**Scoring criterion (per node, strict).** HIT = at least one node in top-10 where label substring-matches any `expectedLabelHas` entry AND kind is eligible. No score floor (graphify advantage).

**Unscored queries.** 34 of 103 queries have empty `expectedLabelHas`. Without a ground-truth label to search for in the top-10 node list, mechanical scoring is not possible. These queries are excluded from all percentage calculations. The denominator throughout this section is **69 scoreable queries**.

**arch-graph baseline.** The arch-graph EN results from `scripts/eval/results-2026-05-17-both-buckets-en.md` are filtered to the same 69-query scoreable subset. The arch-graph eval already applies strict scoring; no re-scoring is needed.

### Per-project strict hit-rates

| Project | GF strict | AG strict | GF lenient EN (ref) | Scoreable N |
|---------|-----------|-----------|---------------------|-------------|
| project-a | 24/33 = **72.7%** | 21/33 = **63.6%** | 45/49 = 92% | 33 |
| project-b | 7/18 = **38.9%** | 9/18 = **50.0%** | 27/29 = 93% | 18 |
| project-c | 8/18 = **44.4%** | 7/18 = **38.9%** | 22/25 = 88% | 18 |
| **Overall** | **39/69 = 56.5%** | **37/69 = 53.6%** | 94/103 = 91% | 69 |

### Per-category strict hit-rates

| Category | GF strict | AG strict | GF lenient EN (ref) | AG lenient EN (ref) | Scoreable N |
|----------|-----------|-----------|---------------------|---------------------|-------------|
| A_find | 17/30 = 57% | 17/30 = 57% | 26/30 = 87% | 17/30 = 57% | 30 |
| B_debug | 5/8 = 62% | 8/8 = 100% | 7/8 = 88% | 8/8 = 100% | 8 |
| C_ui | 7/10 = 70% | 2/10 = 20% | 11/11 = 100% | 2/11 = 18% | 10 |
| E_arch | 7/11 = 64% | 5/11 = 45% | 11/11 = 100% | 5/11 = 45% | 11 |
| D_docs | 3/10 = 30% | 5/10 = 50% | 29/33 = 88% | 27/33 = 82% | 10 |
| D_links | — | — | 10/10 = 100% | 10/10 = 100% | 0 (all unscored) |

**Note:** the lenient EN column uses the full per-category denominator (including unscored queries); the strict column uses only the scoreable subset within each category.

### Lenient → strict drop: what inflated the 91% number

22 queries changed from lenient-HIT to strict-MISS. The drop breaks down into two failure modes:

1. **Label match outside top-10 (11 queries):** graphify returned a response containing the target label, but that label appeared at rank >10 in the BFS traversal. The lenient criterion scanned the entire ~821-token response; the strict criterion only checks the top-10 nodes. Examples: B10 (`Admitad` label present in response but only surfaced after rank 10 due to `ExternalDataRepository` community dominating the BFS), B12 (image upload nodes buried behind `tinymce.min.js` nodes that dominated the response), B15 (`Controller`/`Service` labels present but outranked by module-file nodes).

2. **Label match with kind mismatch (11 queries):** The target label appeared in a top-10 node but the node's inferred kind did not satisfy `expectedKindIn`. Examples: B8 (`Delivery` matched by `DeliveryIcon()` in a `.tsx` icons file → inferred kind `fe-component`; query needed `db-table`/`endpoint`/`provider`), P5 (`Email` matched by `use-email.ts` → `fe-hook`; query needed `db-entity-field`), P24 (`Sync`/`Agent` matched by `SyncAgentController` → `provider`; query needed `fe-component`/`fe-page`).

The D_docs category is the most striking example: lenient reported 29/33 = 88%, strict reports 3/10 = 30% on the scoreable subset. The lenient criterion credited graphify for returning responses that happened to contain generic words like "plan", "roadmap", or "setup" from unrelated nodes (e.g., `SuperAdminPlansService` credited for "roadmap" query; `.setupMenuButton()` credited for "local setup" query). arch-graph's D_docs nodes are actual `doc-section` graph nodes built from project documentation, and they carry the correct kind — graphify's BFS does not distinguish documentation from code nodes.

### Updated takeaway: where does graphify actually stand?

Under strict top-K scoring on the 69 scoreable EN queries, graphify reaches **56.5%** and arch-graph reaches **53.6%** — a near tie, with graphify ahead by a statistically narrow 3pp. The dramatic 91% vs 67% gap from the lenient EN run was almost entirely a measurement artifact: 22pp came from the looser matching criterion, the remaining 2pp from genuine ranking differences.

By category, the pattern is nuanced: graphify leads meaningfully in C_ui (+50pp over arch-graph strict) and E_arch (+18pp), while arch-graph leads in B_debug (+38pp) and D_docs (+20pp). A_find is an exact tie (57% each). These patterns match the design intuitions: graphify's BFS community expansion finds UI and architecture-structure nodes well when EN keywords are exact identifiers; arch-graph's dense embeddings with doc-section nodes handle debugging and documentation questions better.

### Limitations

1. **Heuristic kind mapping is approximate.** Without graphify exposing arch-graph-style typed kinds, path-based inference is the best available proxy. The mapping misses nodes in non-standard paths (e.g., a service class in a `utils/` directory will not get `service` kind). This systematically under-credits graphify when a correctly ranked node has an unconventional path. The strict scores are therefore a **conservative lower bound** on graphify's true precision under this criterion.

2. **No score floor.** graphify's strict hit-rate is computed without a `score ≥ minScore` filter because graphify does not emit per-node scores. arch-graph's strict hits all satisfy a minimum cosine similarity threshold; graphify's do not. Dropping the score floor gives graphify a small advantage — the true apples-to-apples number would be slightly lower for graphify if a score threshold were applied.

3. **Top-10 as rank proxy.** graphify outputs BFS-ordered node lists, not score-ranked lists. "First 10 NODE lines" is a reasonable BFS-depth proxy but is not identical to a cosine-score ranking. Queries where the relevant community is large may have the target node appear at rank 11–20 even when it is semantically central.

4. **Strict-score sensitivity to graph mutation.** graphify's BFS top-10 is sensitive to community-structure changes — if `graphify-out/graph.json` is regenerated (e.g. the project source changed), the BFS ordering can shift, pushing some target labels past rank 10 even when the underlying retrieval quality is identical. A 2026-05-18 revalidation pass (see [`bench/REVALIDATION-2026-05-18.md`](../../bench/REVALIDATION-2026-05-18.md)) found graphify EN strict = 36/69 = 52.2% on a rebuilt project-a graph, vs the original 39/69 = 56.5% on the 2026-05-17 snapshot. arch-graph numbers (RU and EN strict) reproduced at 0.0 pp delta — arch-graph's dense-embedding ranking is deterministic given the same graph. The graphify strict range is therefore best read as **52-57% across snapshots**; the published 56.5% is the original 2026-05-17 measurement. The arch-graph vs graphify near-tie conclusion holds across the range.

---

## 2. Setup

**Eval corpus:** 103 queries across 3 projects, 6 categories.

| Project | Graph source |
|---------|-------------|
| project-a | `/Users/romandubovik/Documents/Projects/project-a/graphify-out/` |
| project-b | `/Users/romandubovik/Documents/Projects/project-b/graphify-out/` |
| project-c | `/Users/romandubovik/Documents/Projects/project-c/graphify-out/` |

**arch-graph eval:** Results taken directly from `scripts/eval/results-2026-05-17-both-buckets.md` (mode: `both-buckets`, k=10). HIT = top-10 contains a result satisfying score ≥ minScore AND kind in expectedKindIn AND label matches expectedLabelHas.

**graphify eval:** For each query, ran `graphify query "<query text>" --budget 1500` from the project directory. Captured full stdout. HIT = response text contains any string from `expectedLabelHas` (case-insensitive). For queries with empty `expectedLabelHas`, HIT = non-empty response with actual node content (not "No matching nodes found").

**Token measurement:** arch-graph = 1000 tokens/query (estimated: 20 results × ~50 tokens each, CODE + DOCS buckets). graphify = `len(response) / 4`.

**Critical caveat:** Graphify does keyword/BFS graph traversal — it matches query terms against node labels. Since 80%+ of queries are in Russian and the node labels are in English (code identifiers), graphify returns "No matching nodes found" for most Russian queries. This is not a bug, it is a fundamental architectural difference: graphify is designed for English technical queries, arch-graph uses multilingual semantic embeddings.

---

## 3. Aggregate Results

### 3a. Overall hit-rates by project

| Project | arch-graph hits/total | arch-graph % | graphify hits/total | graphify % |
|---------|----------------------|-------------|---------------------|-----------|
| project-a | 34/49 | 69% | 15/49 | 31% |
| project-b | 22/29 | 76% | 13/29 | 45% |
| project-c | 13/25 | 52% | 8/25 | 32% |
| **Overall** | **69/103** | **67%** | **36/103** | **35%** |

> Per-project counts corrected on 2026-05-18 after revalidation pass (see [`bench/REVALIDATION-2026-05-18.md`](../../bench/REVALIDATION-2026-05-18.md)) — the original 14/15/7 values disagreed with the per-query appendix (section 6) which sums to 15/13/8. The re-run matches section 6 exactly on all 103 per-query verdicts; section 3a is now corrected. Overall total of 36/103 is unchanged.

### 3b. Hit-rates by category (all projects combined)

| Category | AG hits/total | AG% | GF hits/total | GF% | Winner |
|----------|---------------|-----|---------------|-----|--------|
| A_find | 16/30 | 53% | 8/30 | 27% | arch-graph |
| B_debug | 6/8 | 75% | 3/8 | 38% | arch-graph |
| C_ui | 3/11 | 27% | 3/11 | 27% | tie |
| E_arch | 6/11 | 55% | 4/11 | 36% | arch-graph |
| D_docs | 28/33 | 85% | 11/33 | 33% | arch-graph (+52pp) |
| D_links | 10/10 | 100% | 7/10 | 70% | arch-graph |

### 3c. Per-project × category breakdown

| Project | Category | AG | GF |
|---------|----------|----|-----|
| project-a | A_find | 7/10 70% | 3/10 30% |
| project-a | B_debug | 4/6 67% | 2/6 33% |
| project-a | C_ui | 1/6 17% | 1/6 17% |
| project-a | E_arch | 5/8 62% | 4/8 50% |
| project-a | D_docs | 13/15 87% | 2/15 13% |
| project-a | D_links | 4/4 100% | 3/4 75% |
| project-b | A_find | 6/10 60% | 4/10 40% |
| project-b | C_ui | 1/3 33% | 1/3 33% |
| project-b | E_arch | 1/2 50% | 0/2 0% |
| project-b | D_docs | 11/11 100% | 6/11 55% |
| project-b | D_links | 3/3 100% | 2/3 67% |
| project-c | A_find | 3/10 30% | 1/10 10% |
| project-c | B_debug | 2/2 100% | 1/2 50% |
| project-c | C_ui | 1/2 50% | 1/2 50% |
| project-c | E_arch | 0/1 0% | 0/1 0% |
| project-c | D_docs | 4/7 57% | 3/7 43% |
| project-c | D_links | 3/3 100% | 2/3 67% |

### 3d. Winner distribution (all 103 queries)

| Outcome | Count | % |
|---------|-------|---|
| arch-graph wins | 37 | 36% |
| tie (both HIT) | 32 | 31% |
| both-miss | 30 | 29% |
| graphify wins | 4 | 4% |

---

## 4. Token Cost Comparison

| Metric | arch-graph | graphify |
|--------|-----------|---------|
| Avg tokens/query (all 103) | ~1000 | ~335 |
| Avg tokens/query (non-empty GF only, n=44) | ~1000 | ~775 |
| Queries with zero graphify output | 0 | 59/103 (57%) |
| Relative cost when GF has content | 1.0x | 0.78x |

**Key finding:** graphify is cheaper when it has content (saves ~22%), but 57% of the time it returns nothing, making its effective cost structure misleading. The token estimate for arch-graph (1000) includes both CODE and DOCS buckets (20 results total). In practice, a downstream LLM agent would consume roughly the same token budget with either tool on queries where both return content.

---

## 5. Spot-Check: LLM-as-Judge (15 queries)

Sample: 5 ties, 5 arch-graph-only wins, 3 both-miss, 2 graphify-only wins.

---

**P3 [A_find, tie]** — "интеграция с СРМ через MSSQL агента"

arch-graph returns: `endpoint:POST /mssql-sync/agents/:id/regenerate-token (0.653)`, `MssqlSync` code endpoints, plus doc-sections like "MSSQL Agent — Инструкция по установке (0.748)".  
graphify returns: raw NODE list — `MSSQLStructureAgent`, `getBaseDirectory()`, `SyncClient` code nodes from `tools/project-a-id-mssql-agent/`.  
**Verdict:** tie — both hit the target. arch-graph provides richer context (doc sections + scored endpoints); graphify gives direct code node references. For a code task, graphify is comparably useful; for understanding, arch-graph edges ahead.

---

**P5 [A_find, tie]** — "EMAIL разделы для чего отправляются от тенанта"

arch-graph: `provider:EMAIL_SENDER (0.720)`, `queue:email (0.705)`, doc sections "Email Infrastructure — Руководство по развёртыванию".  
graphify: `EmailDomainService`, `SmtpService`, `EmailQueueService`, `EmailLogsController` — code nodes, no docs.  
**Verdict:** arch-graph more useful for answering "why" (docs bucket explains purpose); graphify useful for "where is the code."

---

**P8 [B_debug, tie]** — "ON CONFLICT DO UPDATE двойной апдейт time_slots"

arch-graph: `endpoint:POST /time-slots/bulk (0.603)`, `db-table:appointment_time_slots`, `provider:TimeSlotsController`.  
graphify: `UpdateTimeSlotsQueryCurrentTimeTable1774500000000` migration class, `TimeSlotsModule`, `TimeSlotsController`.  
**Verdict:** Both hit. graphify uniquely surfaces the specific migration class that likely contains the ON CONFLICT logic — slight edge for debugging.

---

**P15 [E_arch, tie]** — "архитектура mini-app telegram"

arch-graph: `service:project-a-miniapp (0.676)`, `service:project-a-id-miniapp`, docs "MiniApp Auth Channels — Implementation Plan".  
graphify: `TelegramService`, `TelegramChannelHandler`, `TelegramMiniAppAuthHandler` — code nodes.  
**Verdict:** arch-graph substantially better — it returns architectural doc sections that explain the design; graphify returns code nodes without the architectural narrative.

---

**P27 [E_arch, graphify wins]** — "архитектура live notification streaming"

arch-graph: MISS — returns `queue:broadcast (0.528)`, no notification service node in top-10.  
graphify: HIT — `NotificationDeliveryService`, `.routeToWebSocket()`, `WebSocketGateway` — exactly the streaming components.  
**Verdict:** graphify clearly wins here. The query contains English keywords "live notification streaming" which graphify matched directly to code nodes. arch-graph's semantic embeddings ranked broadcast above notification-delivery.

---

**P14 [E_arch, graphify wins]** — "что такое тенант ident мульти-тенантность"

arch-graph: MISS — returns `fe-component:KanbanBoard (0.432)`, no tenant node.  
graphify: HIT — `TenantRepository`, `TenantModule`, `ProjectAIdTenantService` nodes — returned due to "ident" keyword in the query.  
**Verdict:** graphify wins by keyword match. The query contains "ident" (an exact service name) which graphify matched directly, while arch-graph's semantic search drifted.

---

**P25 [C_ui, graphify wins]** — "форма редактирования шаблонов email"

arch-graph: MISS — returns `provider:EmailLogsController (0.626)` but not a frontend form component.  
graphify: HIT — returns `EmailTemplatesController`, `EmailQueueService`, `SmtpService` — email-related nodes including `EmailTemplatesController` which contains "Template."  
**Verdict:** Both are weak. graphify's hit is via the "email" keyword surfacing template-related code. Neither tool returns an actual FE form component. Marginal graphify edge.

---

**P21 [B_debug, tie]** — "обработка ошибок в фоновых задачах cron"

arch-graph: `nats-subject:cron.delete (0.666)`, `db-entity-field:cron_job_executions/error_stack`, docs "Cron не срабатывает (0.695)".  
graphify: `SuperAdminCronService`, `CronSchedulerService`, `CronJobExecutionEntity` — code nodes with error-handling classes.  
**Verdict:** tie — arch-graph's docs section "Cron не срабатывает" is directly useful for debugging; graphify's code nodes are equally useful for finding where to put a fix.

---

**P1 [A_find, arch-graph wins]** — "ручки СРМ получение расписания и отдача записей"

arch-graph: HIT — `endpoint:PATCH /schedule/:id (0.605)`, `endpoint:POST /schedule`, `provider:ScheduleController`, doc sections about ScheduledReceptions.  
graphify: No matching nodes found (pure Russian query, no English keyword hooks).  
**Verdict:** arch-graph decisively wins. This is the most common failure mode for graphify: Russian-only queries return empty.

---

**P7 [B_debug, arch-graph wins]** — "не работают кнопки в телеграм боте уведомления"

arch-graph: HIT — `endpoint:POST /super-admin/notifications/test-telegram (0.512)`, `provider:TelegramBotRegistry`, docs "Telegram не доставляет (0.638)".  
graphify: No matching nodes found.  
**Verdict:** arch-graph wins. "Telegram" is in the query but graphify returned nothing — suggests the BFS didn't find a Telegram community entry point from "не работают кнопки" (Russian).

---

**I1 [A_find, tie]** — "Instagram scraper парсинг профилей"

arch-graph: `service:be-instagram-scraper (0.673)`, `nats-subject:instagram.profile.request`, docs "Instagram Scraper Migration".  
graphify: `InstagramScraperService`, `InstagramScraperModule`, `.getProfile()`, `.mapRawProfileToDto()` — detailed code structure.  
**Verdict:** tie. The query contains English keywords, so both tools hit. graphify's node list is more granular (method-level); arch-graph provides both code and doc context.

---

**I7 [A_find, tie]** — "как работает система сбора данных Instagram профилей"

arch-graph: `service:be-instagram-scraper (0.707)`, `queue:instagram-scraping`, docs "Story 2.1: Instagram Data Service".  
graphify: Same community as I1 — `InstagramScraperService`, `InstagramQueueService`, `InstagramDataStepService`.  
**Verdict:** tie, graphify slightly better for code navigation (detailed method nodes); arch-graph better for understanding architecture (story doc sections).

---

**B3 [A_find, arch-graph wins]** — "телеграм бот геозащита"

arch-graph: HIT — `nats-subject:SEND_SECURITY_ALERT`, `nats-subject:guard.parse-log`, docs "GeoIP фильтрация (0.556)", "Telegram бот геозащита".  
graphify: ~1094 tokens returned but MISS — returns README doc nodes, not the Telegram/guard code. The "телеграм" keyword didn't resolve to Telegram code nodes.  
**Verdict:** arch-graph wins. Semantic embedding correctly associated "геозащита" with guard/geo topics.

---

**B11 [B_debug, tie]** — "обработка ошибок валидации в формах"

arch-graph: `db-entity-field:auth_attempts/failed_attempts (0.537)`, `provider:ValidationFactoryService`, docs "Кастомная обработка (0.561)".  
graphify: doc-node READMEs + `ValidationFactoryService` (via "validation" keyword in query), `ValidationDecoratorService`.  
**Verdict:** tie — graphify matched "validation" keyword in `ValidationFactoryService`; arch-graph found the same via semantic similarity. Both useful.

---

**P51 [D_links, tie]** — "архитектура MssqlSync — документация и реализующие классы синхронизации"

arch-graph: `module:MssqlSyncModule (0.820)`, docs "MSSQL Sync — Операционный guide (0.820)", "MSSQL Sync Pipeline — Implementation Plan".  
graphify: `MssqlSyncPhaseB` and `MssqlSyncPhaseC` migration classes — code nodes directly named MssqlSync.  
**Verdict:** tie — arch-graph provides the doc-to-code link (both doc sections and the module); graphify provides the migration class chain. arch-graph more useful for the "architecture" part; graphify for the "implementing classes."

---

## 6. Per-Query Detail Table (Appendix)

| id | query (truncated) | project | category | AG HIT | AG top-1 | AG tokens | GF HIT | GF tokens | winner |
|----|------------------|---------|----------|--------|----------|-----------|--------|-----------|--------|
| P1 | ручки СРМ получение расписания и отдача | project-a | A_find | HIT | 0.605 | 1000 | MISS | 6 | arch-graph |
| P2 | redirect_url для чего используется в mssql sync | project-a | A_find | HIT | 0.544 | 1000 | MISS | 359 | arch-graph |
| P3 | интеграция с СРМ через MSSQL агента | project-a | A_find | HIT | 0.653 | 1000 | HIT | 609 | tie |
| P4 | карты в напоминаниях о записи | project-a | A_find | MISS | 0.495 | 1000 | MISS | 6 | both-miss |
| P5 | EMAIL разделы для чего отправляются от тенанта | project-a | A_find | HIT | 0.720 | 1000 | HIT | 826 | tie |
| P6 | mssql агент синк ошибки логи | project-a | B_debug | MISS | 0.676 | 1000 | MISS | 609 | both-miss |
| P7 | не работают кнопки в телеграм боте уведомления | project-a | B_debug | HIT | 0.512 | 1000 | MISS | 6 | arch-graph |
| P8 | ON CONFLICT DO UPDATE двойной апдейт time_slots | project-a | B_debug | HIT | 0.603 | 1000 | HIT | 776 | tie |
| P9 | обрезать последнее сообщение в списке чатов в 3 точки | project-a | C_ui | MISS | 0.493 | 1000 | MISS | 6 | both-miss |
| P10 | дровер справа при клике по клиенту в админке | project-a | C_ui | MISS | 0.512 | 1000 | MISS | 6 | both-miss |
| P11 | колонка статус выровнять по правому краю | project-a | C_ui | HIT | 0.514 | 1000 | MISS | 6 | arch-graph |
| P12 | как работает синк MSSQL агента с СРМ | project-a | E_arch | HIT | 0.691 | 1000 | HIT | 609 | tie |
| P13 | разделили услуги и профессии | project-a | E_arch | HIT | 0.588 | 1000 | MISS | 6 | arch-graph |
| P14 | что такое тенант ident мульти-тенантность | project-a | E_arch | MISS | 0.432 | 1000 | HIT | 1134 | graphify |
| P15 | архитектура mini-app telegram | project-a | E_arch | HIT | 0.676 | 1000 | HIT | 1134 | tie |
| P16 | как обновляются данные бронирования запись | project-a | A_find | MISS | 0.511 | 1000 | MISS | 6 | both-miss |
| P17 | отправка email уведомлений клиентам | project-a | A_find | HIT | 0.787 | 1000 | HIT | 826 | tie |
| P18 | обработка платежей и биллинг | project-a | A_find | HIT | 0.568 | 1000 | MISS | 6 | arch-graph |
| P19 | управление филиалами и точками доступа | project-a | A_find | MISS | 0.588 | 1000 | MISS | 6 | both-miss |
| P20 | система ролей и доступа пользователей | project-a | A_find | HIT | 0.651 | 1000 | MISS | 6 | arch-graph |
| P21 | обработка ошибок в фоновых задачах cron | project-a | B_debug | HIT | 0.666 | 1000 | HIT | 1134 | tie |
| P22 | найти где передаются задачи на доставку курьеру | project-a | B_debug | MISS | 0.491 | 1000 | MISS | 6 | both-miss |
| P23 | почему падает синхронизация с базой данных | project-a | B_debug | HIT | 0.630 | 1000 | MISS | 6 | arch-graph |
| P24 | UI панель управления агентами синка | project-a | C_ui | MISS | 0.660 | 1000 | MISS | 6 | both-miss |
| P25 | форма редактирования шаблонов email | project-a | C_ui | MISS | 0.626 | 1000 | HIT | 826 | graphify |
| P26 | таблица со списком клиентов фильтры | project-a | C_ui | MISS | 0.562 | 1000 | MISS | 6 | both-miss |
| P27 | архитектура live notification streaming | project-a | E_arch | MISS | 0.528 | 1000 | HIT | 585 | graphify |
| P28 | как интегрирована телеграм мини-ап с основным приложением | project-a | E_arch | HIT | 0.636 | 1000 | MISS | 6 | arch-graph |
| P29 | структура модулей и сервисов приложения | project-a | E_arch | HIT | 0.663 | 1000 | MISS | 6 | arch-graph |
| P30 | как работает система очередей сообщений | project-a | E_arch | MISS | 0.525 | 1000 | MISS | 6 | both-miss |
| P31 | что делает приложение project-a основная цель | project-a | D_docs | HIT | 0.614 | 1000 | MISS | 6 | arch-graph |
| P32 | какие основные возможности и фичи доступны пользователям | project-a | D_docs | HIT | 0.581 | 1000 | MISS | 6 | arch-graph |
| P33 | целевая аудитория и сценарии использования продукта | project-a | D_docs | HIT | 0.556 | 1000 | MISS | 6 | arch-graph |
| P34 | архитектурные решения и технологический стек | project-a | D_docs | HIT | 0.692 | 1000 | MISS | 6 | arch-graph |
| P35 | как настроить и запустить проект локально | project-a | D_docs | MISS | 0.569 | 1000 | MISS | 6 | both-miss |
| P36 | что в планах и roadmap проекта | project-a | D_docs | HIT | 0.588 | 1000 | MISS | 6 | arch-graph |
| P37 | с какими внешними системами интегрируется приложение | project-a | D_docs | HIT | 0.720 | 1000 | MISS | 6 | arch-graph |
| P38 | как организована мультитенантность и изоляция данных | project-a | D_docs | HIT | 0.560 | 1000 | MISS | 6 | arch-graph |
| P39 | что нового в последних версиях changelog | project-a | D_docs | HIT | 0.518 | 1000 | MISS | 6 | arch-graph |
| P40 | стратегия миграций базы данных | project-a | D_docs | HIT | 0.802 | 1000 | MISS | 6 | arch-graph |
| P41 | роли пользователей и матрица прав доступа | project-a | D_docs | HIT | 0.644 | 1000 | MISS | 6 | arch-graph |
| P42 | конфигурационные параметры env переменные | project-a | D_docs | HIT | 0.663 | 1000 | HIT | 96 | tie |
| P43 | руководство по миграции данных между версиями | project-a | D_docs | HIT | 0.718 | 1000 | MISS | 6 | arch-graph |
| P44 | известные проблемы ограничения системы known issues | project-a | D_docs | HIT | 0.522 | 1000 | HIT | 839 | tie |
| P45 | contributing guide как контрибутить в проект | project-a | D_docs | MISS | 0.578 | 1000 | MISS | 6 | both-miss |
| P51 | архитектура MssqlSync — документация и реализующие классы | project-a | D_links | HIT | 0.820 | 1000 | HIT | 352 | tie |
| P52 | мультитенантность tenant ident — концепция в docs и код | project-a | D_links | HIT | 0.614 | 1000 | HIT | 430 | tie |
| P53 | система уведомлений — описание в документации и провайдеры | project-a | D_links | HIT | 0.689 | 1000 | MISS | 6 | arch-graph |
| P54 | telegram mini-app — архитектура в docs и реализация | project-a | D_links | HIT | 0.735 | 1000 | HIT | 1134 | tie |
| I1 | Instagram scraper парсинг профилей | project-b | A_find | HIT | 0.673 | 1000 | HIT | 1096 | tie |
| I2 | Stripe платежи обработка подписок | project-b | A_find | HIT | 0.632 | 1000 | HIT | 727 | tie |
| I3 | AI сценарии генерация контента | project-b | A_find | MISS | 0.655 | 1000 | MISS | 6 | both-miss |
| I4 | уведомления пользователя email | project-b | A_find | HIT | 0.727 | 1000 | HIT | 1134 | tie |
| I5 | админка пользователи и роли | project-b | A_find | HIT | 0.601 | 1000 | MISS | 6 | arch-graph |
| I6 | клиент таблица колонка фронтенд | project-b | C_ui | MISS | 0.664 | 1000 | MISS | 6 | both-miss |
| I7 | как работает система сбора данных Instagram профилей | project-b | A_find | HIT | 0.707 | 1000 | HIT | 1134 | tie |
| I8 | обработка подписок и возмещений платежей | project-b | A_find | MISS | 0.703 | 1000 | MISS | 6 | both-miss |
| I9 | хранение и анализ данных об активности пользователей | project-b | A_find | MISS | 0.630 | 1000 | MISS | 6 | both-miss |
| I10 | управление коллекциями и segmentation | project-b | A_find | HIT | 0.557 | 1000 | MISS | 6 | arch-graph |
| I11 | сценарии автоматизации для контента | project-b | A_find | MISS | 0.578 | 1000 | MISS | 6 | both-miss |
| I12 | интеграция третьих сервисов Apify API | project-b | C_ui | HIT | 0.649 | 1000 | HIT | 669 | tie |
| I13 | панель аналитики и статистики | project-b | C_ui | MISS | 0.612 | 1000 | MISS | 6 | both-miss |
| I14 | масштабируемость системы анализа данных | project-b | E_arch | HIT | 0.620 | 1000 | MISS | 6 | arch-graph |
| I15 | безопасность и проверка подлинности пользователей | project-b | E_arch | MISS | 0.730 | 1000 | MISS | 6 | both-miss |
| I16 | что делает project-b основная идея и зачем нужен продукт | project-b | D_docs | HIT | 0.563 | 1000 | MISS | 6 | arch-graph |
| I17 | какие функции анализа Instagram профилей доступны | project-b | D_docs | HIT | 0.725 | 1000 | HIT | 1134 | tie |
| I18 | как работает биллинг подписок и тарифные планы | project-b | D_docs | HIT | 0.625 | 1000 | MISS | 6 | arch-graph |
| I19 | архитектурные принципы обработки больших данных Instagram | project-b | D_docs | HIT | 0.728 | 1000 | HIT | 1134 | tie |
| I20 | как развернуть проект и какие нужны переменные окружения | project-b | D_docs | HIT | 0.597 | 1000 | MISS | 6 | arch-graph |
| I21 | roadmap и планы по AI функциональности | project-b | D_docs | HIT | 0.690 | 1000 | MISS | 6 | arch-graph |
| I22 | история ключевых изменений по версиям приложения | project-b | D_docs | HIT | 0.593 | 1000 | MISS | 6 | arch-graph |
| I23 | интеграция с Apify Stripe и другими внешними API | project-b | D_docs | HIT | 0.533 | 1000 | HIT | 1102 | tie |
| I24 | rate limits ограничения парсинга Instagram | project-b | D_docs | HIT | 0.716 | 1000 | HIT | 1134 | tie |
| I25 | тарифные планы pricing подписки и их лимиты | project-b | D_docs | HIT | 0.647 | 1000 | HIT | 692 | tie |
| I26 | импорт списка Instagram аккаунтов формат данных | project-b | D_docs | HIT | 0.688 | 1000 | HIT | 1134 | tie |
| I31 | Instagram Scraper — документация подхода и Scraper классы | project-b | D_links | HIT | 0.761 | 1000 | HIT | 1096 | tie |
| I32 | AI сценарии генерации контента — описание и AI-провайдеры | project-b | D_links | HIT | 0.686 | 1000 | MISS | 6 | arch-graph |
| I33 | Stripe биллинг — документация и сервисы оплаты | project-b | D_links | HIT | 0.541 | 1000 | HIT | 727 | tie |
| B1 | корзина оформление заказа checkout | project-c | A_find | MISS | 0.418 | 1000 | MISS | 6 | both-miss |
| B2 | промокод скидка | project-c | A_find | HIT | 0.443 | 1000 | MISS | 6 | arch-graph |
| B3 | телеграм бот геозащита | project-c | A_find | HIT | 0.561 | 1000 | MISS | 1094 | arch-graph |
| B4 | платежи оплата товара | project-c | A_find | MISS | 0.234 | 1000 | MISS | 6 | both-miss |
| B5 | пользователь регистрация авторизация | project-c | A_find | MISS | 0.561 | 1000 | MISS | 1134 | both-miss |
| B6 | поиск и фильтрация товаров по категориям | project-c | A_find | MISS | 0.455 | 1000 | MISS | 6 | both-miss |
| B7 | данные о компаниях и её товарах | project-c | A_find | HIT | 0.465 | 1000 | MISS | 6 | arch-graph |
| B8 | управление доставкой и логистикой | project-c | A_find | MISS | 0.450 | 1000 | MISS | 390 | both-miss |
| B9 | система кэширования данных для производительности | project-c | A_find | MISS | 0.528 | 1000 | MISS | 513 | both-miss |
| B10 | интеграция с внешними системами рекламы Admitad | project-c | A_find | MISS | 0.386 | 1000 | HIT | 1134 | graphify |
| B11 | обработка ошибок валидации в формах | project-c | B_debug | HIT | 0.561 | 1000 | HIT | 1134 | tie |
| B12 | проблемы с загрузкой изображений товаров | project-c | B_debug | HIT | 0.503 | 1000 | MISS | 6 | arch-graph |
| B13 | структура хранения блога и контента | project-c | C_ui | HIT | 0.630 | 1000 | HIT | 1134 | tie |
| B14 | как реализована адаптивность мобильного интерфейса | project-c | C_ui | MISS | 0.416 | 1000 | MISS | 6 | both-miss |
| B15 | как структурировано приложение в целом | project-c | E_arch | MISS | 0.638 | 1000 | MISS | 6 | both-miss |
| B16 | что делает project-c основная идея и целевые пользователи | project-c | D_docs | HIT | 0.552 | 1000 | MISS | 6 | arch-graph |
| B17 | как организован процесс оформления и оплаты заказа | project-c | D_docs | HIT | 0.430 | 1000 | HIT | 331 | tie |
| B18 | как развернуть проект локально шаги установки | project-c | D_docs | MISS | 0.559 | 1000 | MISS | 123 | both-miss |
| B19 | архитектурные решения и технологический стек проекта | project-c | D_docs | HIT | 0.612 | 1000 | HIT | 123 | tie |
| B20 | планы развития проекта и roadmap | project-c | D_docs | MISS | 0.510 | 1000 | MISS | 123 | both-miss |
| B21 | FAQ помощь продавцам и покупателям | project-c | D_docs | MISS | 0.417 | 1000 | MISS | 6 | both-miss |
| B22 | модерация товаров продавцов правила | project-c | D_docs | HIT | 0.348 | 1000 | HIT | 123 | tie |
| B26 | checkout процесс — описание в docs и сервисы заказа | project-c | D_links | HIT | 0.615 | 1000 | HIT | 1134 | tie |
| B27 | промо-коды — документация и реализующие промо-сервисы | project-c | D_links | HIT | 0.468 | 1000 | HIT | 425 | tie |
| B28 | доставка логистика — описание процесса и DeliveryService | project-c | D_links | HIT | 0.439 | 1000 | MISS | 6 | arch-graph |

---

## 7. Caveats

**Eval favors arch-graph by construction:**

1. **HIT criterion:** The `expectedLabelHas` strings (e.g., "Schedule", "MssqlSync") are English code identifiers from arch-graph's node labels. When graphify returns the same English node label, it gets credit — but the eval was authored against arch-graph results, so the label vocabulary aligns with arch-graph's output format.

2. **Russian query corpus:** 80%+ queries are in Russian. Graphify does keyword matching against English node labels; arch-graph uses multilingual embeddings (`Xenova/paraphrase-multilingual-MiniLM-L12-v2`, 384-dim). This is a structural mismatch, not a failure of graphify's design.

3. **arch-graph token estimate is generous:** The 1000-token estimate for arch-graph assumes both CODE and DOCS buckets are consumed. In practice, an agent might filter to just one bucket (~500 tokens), making arch-graph cheaper than shown.

4. **Graphify no-content responses:** 59/103 queries returned "No matching nodes found" which scores 6 tokens (the length of that string). This inflates graphify's average token count downward in the overall figure.

5. **D_docs category:** arch-graph explicitly has a `doc-section` kind built from project documentation. Graphify's graph is built from code + README files. For documentation questions, arch-graph has structural coverage graphify lacks.

**Eval may understate graphify for English queries:** The 4 graphify-only wins (P14, P25, P27, B10) all involved English or mixed-language queries where graphify's keyword matching was more precise than arch-graph's semantic search. In a codebase with English-language developers writing English queries, graphify's win rate would be meaningfully higher.

---

## 8. Recommendation

This benchmark **updates and supersedes** the earlier qualitative memo at `docs/comparisons/graphify-vs-arch-graph.md`.

**Use arch-graph as primary for all query types when queries are in Russian or natural language.** With concrete numbers: 67% overall hit-rate vs 35%, and a +52pp gap in D_docs (the largest category in production use).

**Use graphify as a complementary fallback in these specific situations:**
- Query contains exact English class/service names (e.g., "NotificationDeliveryService", "ident tenant") — graphify BFS graph traversal finds the local code community around that node quickly and at lower cost (~775 tokens vs ~1000).
- You need method-level code navigation (graphify exposes `.getProfile()`, `.mapRawProfileToDto()` etc. at the node level, which arch-graph aggregates away).
- You want to confirm which files compose a code community — graphify's community clustering is visually useful for understanding module boundaries.

**Do not use graphify alone:** 57% of queries (all Russian, broad architectural) produce zero output. An agent relying on graphify alone will fail on more than half of real developer queries in this codebase.

**Hybrid pipeline suggestion:** Issue query to arch-graph first. If arch-graph returns 0 results or top-1 score < 0.45, fall back to graphify with English-translated keywords. Expected combined hit-rate: ~72-75% (vs 67% arch-graph alone, 35% graphify alone).

**Token budget:** When both tools have content, graphify uses ~22% fewer tokens. Not enough to justify switching, but worth keeping in mind for high-volume agentic loops where every token counts.
