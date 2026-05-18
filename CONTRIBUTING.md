# Contributing to arch-graph

Thanks for the interest. Three ways to contribute, in order of impact:

1. **[Bench numbers from your repo](#1-benchmark-numbers-from-your-repo)** — the highest-leverage contribution. Even one extra data point on a non-NestJS or non-Russian-speaking codebase moves the published recall headline.
2. **[Custom evaluator suites](#2-custom-evaluator-suites)** — bring your own queries + scoring criteria for a project shape we don't cover.
3. **[Code, bug fixes, new extractors](#3-code-contributions)** — usual PR flow.

---

## 1. Benchmark numbers from your repo

The fastest way: run `arch-graph compare --share` on your NestJS repo and click through the publish prompt.

```bash
cd /path/to/your/repo
arch-graph compare --share
```

It generates an anonymized markdown snippet — counts and ratios only, no code, no subject names, no service IDs. The preview shows you the exact payload before anything leaves your machine. Submissions land in a public GitHub Discussion.

Why: we currently publish numbers from three NestJS monorepos. Every additional data point narrows the confidence interval on the headline recall numbers (currently RU 67% / EN-strict 53.6% vs graphify on 103 queries).

---

## 2. Custom evaluator suites

If you want to verify the published numbers on your own codebase, or contribute a benchmark for a project shape we don't cover (non-NestJS TS, Node monolith, GraphQL backend, mixed-language codebase), you can run the eval harness with your own query set and submit results.

### Query schema

Each query in [`scripts/eval/queries.json`](scripts/eval/queries.json) follows this shape:

```json
{
  "id": "A_find_01",
  "project": "project-a",
  "category": "A_find",
  "query": "how do we send email to customers",
  "expectedKindIn": ["provider", "queue", "db-table"],
  "expectedLabelHas": ["EmailSender", "email_logs"],
  "minScore": 0.45
}
```

| Field | What |
|-------|------|
| `id` | Unique short identifier (`A_find_01`, `B_debug_03`, etc.). Categories: `A_find`, `B_debug`, `C_ui`, `D_docs`, `D_links`, `E_arch`. |
| `project` | Logical project name. Mapped to a directory via `PROJECT_<NAME>_DIR` env var. |
| `category` | One of the six categories above. Used for the per-category breakdown in results. |
| `query` | The natural-language query. RU, EN, or mixed — the multilingual embedder handles all of them. |
| `expectedKindIn` | At least one node with one of these `NodeKind`s must appear in the top-K to count as a HIT. Common kinds: `provider`, `endpoint`, `queue`, `db-table`, `db-entity-field`, `doc-section`, `fe-component`. |
| `expectedLabelHas` | At least one of these substrings must appear in the matched node's `label` (case-insensitive). |
| `minScore` | Cosine-similarity floor for the match to count. Typical range: `0.40`–`0.55`. |

A query counts as a **HIT** if **all three conditions hold** for at least one node in the top-K results: `score ≥ minScore` AND `kind ∈ expectedKindIn` AND `label substring-matches one of expectedLabelHas`.

### Running the eval

```bash
# Build arch-graph and your project's graph once
arch-graph build --project-root /path/to/your/repo
arch-graph semantic build --project-root /path/to/your/repo

# Run the eval against your own queries
PROJECT_A_DIR=/path/to/your/repo \
QUERIES_FILE=$(pwd)/scripts/eval/my-queries.json \
RESULTS_FILE=$(pwd)/scripts/eval/results-my-run.md \
EVAL_MODE=both-buckets \
bash scripts/run-baseline-eval.sh --skip-build
```

`EVAL_MODE` options: `per-category` (route by category), `both-buckets` (always call both `code_search` and `docs_search`, union verdicts — used in the published headline), `fallback` (try `code_search` first, retry `docs_search` on MISS), `single` (legacy baseline).

See [`bench/REPRODUCE.md`](bench/REPRODUCE.md) for the full guide, including how to score against graphify head-to-head and what lenient-vs-strict scoring asymmetries to be aware of.

### Submitting your results

Open a PR adding a new file under `bench/contributed/`:

```
bench/contributed/<your-project-or-handle>-YYYY-MM-DD.md
```

Include:

- **Project shape** — TS monorepo? Node monolith? Framework? Roughly how many files / NodeKinds?
- **Query set** — link to your `queries.json` (or paste it inline). Briefly describe how you picked queries (real team questions? auto-generated from node labels? curated from issues?).
- **Final hit-rate** — overall, plus per-category breakdown if you used the standard categories.
- **Anything surprising** — categories where arch-graph under-performed, embedder limitations you hit, project-shape mismatches.

We don't need anonymized source or full result dumps — just numbers and methodology.

### Tips for picking queries

- **Real team questions beat synthetic ones.** Curating queries from actual Slack threads or GitHub issues stresses the system on what users actually ask.
- **Mix categories.** Heavy bias toward one category (e.g. all `A_find`) inflates or deflates the headline. The published 103-query suite has roughly: 30% A_find, 20% B_debug, 15% C_ui, 15% D_docs, 10% D_links, 10% E_arch.
- **Mix languages if applicable.** If your team uses multiple languages, include both in the query set — multilingual handling is one of arch-graph's load-bearing features.
- **Be careful with `expectedLabelHas`.** Substring matching is generous. Use the most specific label fragment you can — `EmailSender` not `email`. Otherwise you measure substring-presence in noisy results rather than retrieval quality.

---

## 3. Code contributions

### Setup

```bash
git clone https://github.com/roman-dubovik/arch-graph
cd arch-graph
pnpm install
pnpm test         # vitest, ~1 min on a clean tree
pnpm typecheck    # strict TS
pnpm lint         # ESLint
```

### Workflow

- Branch off `main`. PRs target `main`.
- Add tests for behaviour changes — vitest, co-located `*.test.ts` next to source. Coverage gates are per-file (95% lines / 95% functions / 90% branches on touched files).
- Conventional Commits: `feat(scope): ...`, `fix(scope): ...`, `docs: ...`, `chore: ...`.
- Run the quality gate locally before pushing: `pnpm typecheck && pnpm test && pnpm lint`.

### Adding a new extractor

The repo is organized by extractor — each new edge kind or node kind is a self-contained module under `src/extractors/`. The cleanest examples to read for the shape:

- `src/extractors/docs/` — pure-logic + I/O split, mapper, validator, diagnostics. Read this first for any new extractor.
- `src/extractors/typeorm/` — decorator-driven, with `forwardRef`/base-class resolution.
- `src/extractors/di/filter-chain.ts` — class + method-level decorator collection.

For a new `NodeKind`, also:
- Extend `NodeKind` union and `NODE_KIND_CHECK` in `src/core/types.ts` — T1 of every extractor plan.
- Verify it picks up automatically in `src/mcp/server.ts` zod enums (driven by `NODE_KIND_VALUES`).
- Add the snippet renderer case in `src/semantic/snippet.ts` so the new kind embeds correctly.

### Adding a new framework target

arch-graph is TypeScript-only by charter, but it isn't NestJS-only — Express, Fastify, or pure-TS apps work today (just with fewer typed edges). New framework decorators (Apollo GraphQL `@Resolver`, ts.ED, etc.) are additive and welcome — file an issue first describing the decorator surface you want to extract, so we can sketch the kind/edge shape together before you spend implementation time.

### What we won't accept

- **Cross-language coverage.** TS-only is a charter decision; CPG-style polyglot tools (Joern, scip-ts) are a different abstraction level.
- **Mock-based tests for retrieval logic.** Semantic-side tests use real embeddings via test fixtures; structural-side tests use real ts-morph projects in `src/__fixtures__/`. Mocks at integration boundaries are fine; mocks of arch-graph's own internals are not.
- **Backward-compat shims for hypothetical consumers.** The `manifest.json` contract is the federation surface; if you have a real downstream tool that needs a stable contract, open an issue and we'll cut a numbered version.

### Filing issues

Useful failure-mode issues look like:

> I ran `arch-graph semantic search "<query>"` on `<repo shape>` and expected to find `<node>` in the top-10. Got `<actual top-3>`. Graph has `<N nodes, N edges>`. Embedder model: `<manifest.model>`.

Vague reports ("doesn't work on my codebase") are hard to act on. Reproduction context — exact query, expected vs actual top-K, project shape — moves things forward.

---

## License & code of conduct

MIT license. Be respectful — disagreements about technical direction are welcome; personal attacks are not.
