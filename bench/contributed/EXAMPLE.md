# Example contributed evaluator result

This is the template for `bench/contributed/<your-handle>-YYYY-MM-DD.md` submissions. Copy it, fill it in, open a PR. The headings below are the minimum set we look for when reviewing; feel free to add sections.

---

## Project shape

- **Framework**: NestJS 10 monorepo (or: Node monolith, GraphQL backend, mixed, etc.)
- **Approximate size**: 4 apps, 12 libs, ~800 TypeScript files
- **NodeKinds populated** (from `arch-graph stats`):
  - 1247 provider, 312 endpoint, 89 db-table, 156 db-entity-field
  - 24 queue (NATS), 8 cron, 41 fe-component
  - 320 doc-section (README + ADRs + `docs/**/*.md`)
- **Language mix in queries**: 60% RU, 40% EN
- **arch-graph build**: `pnpm arch-graph build && pnpm arch-graph semantic build` — 2m 14s total on M2 Pro

## Query set

Picked 50 queries from a real team's Slack — questions actually asked during onboarding and incident triage over the last quarter. Distribution:

| Category | Count | Source |
|----------|-------|--------|
| A_find | 18 | "where is X" / "how do we Y" |
| B_debug | 9 | recent incident threads |
| C_ui | 6 | frontend team backlog |
| D_docs | 8 | "what's in the runbook for Z" |
| D_links | 5 | doc + code combo queries |
| E_arch | 4 | architecture review prep |

Query file (paste excerpt or attach):

```json
[
  {
    "id": "A_find_01",
    "project": "myrepo",
    "category": "A_find",
    "query": "where do we send payment confirmation emails",
    "expectedKindIn": ["provider", "queue"],
    "expectedLabelHas": ["PaymentNotifier", "payment.email"],
    "minScore": 0.45
  },
  ...
]
```

## Eval configuration

```bash
PROJECT_MYREPO_DIR=/path/to/myrepo \
QUERIES_FILE=$(pwd)/scripts/eval/my-queries.json \
RESULTS_FILE=$(pwd)/scripts/eval/results-myrepo-2026-05-18.md \
EVAL_MODE=both-buckets \
bash scripts/run-baseline-eval.sh --skip-build
```

- `K=10`
- `EVAL_MODE=both-buckets` (matches the published headline run)
- Embedder: `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (default, no override)

## Results

| Category | Hits | Total | Recall |
|----------|------|-------|--------|
| A_find   | 14   | 18    | 78%    |
| B_debug  | 6    | 9     | 67%    |
| C_ui     | 2    | 6     | 33%    |
| D_docs   | 7    | 8     | 88%    |
| D_links  | 4    | 5     | 80%    |
| E_arch   | 3    | 4     | 75%    |
| **Total** | **36** | **50** | **72%** |

## Observations

- **C_ui is the weak spot** — same ceiling we see in the published numbers. Three queries about Tailwind utility classes (`truncate`, `text-ellipsis`) didn't map onto our snippet vocabulary.
- **D_docs at 88%** is higher than the published baseline (67% overall). Possibly because our `docs/` folder has more structure than the reference projects.
- **B_debug surprised me** — two queries about NATS subjects hit because the subject string is in the snippet, even though the team usually refers to the subject by a domain term that's nowhere in the code.
- One query I expected to fail (`how does authentication work`) hit cleanly on a `doc-section` for `docs/architecture/auth.md` — the doc-section extractor is doing real work here.

## Anything else to flag?

- We don't use BullMQ — no `queue:bull-*` queries. graph schema covers it, just no corpus.
- TypeORM entities with abstract base classes had `db-entity-field` nodes missing in v0.X; verified fixed in current main.
- Suggestion: a category for `F_perf` (queries about performance bottlenecks / N+1 patterns) would be valuable — easy to write, hard to score.

---

**Submitted by**: `@your-github-handle`
**Date**: 2026-05-18
**arch-graph version**: `git rev-parse HEAD` of `main` you ran against
