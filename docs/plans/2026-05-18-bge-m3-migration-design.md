# BGE-M3 migration — design doc

Date: 2026-05-18
Status: implementation

## Goal

Add **opt-in** support for the BGE-M3 multilingual embedder (1024-dim) alongside the current MiniLM-L12 default (384-dim). Produce side-by-side bench numbers on the self-build 12-query suite and ship a migration recommendation. **MiniLM remains the default** to keep `install.sh` UX intact.

## Decision rules

- **Primary model**: `Xenova/bge-m3` (CLS pooling + L2 normalize, 1024-dim).
- **Fallback if BGE-M3 ONNX is broken** (transformers.js issue / load error): switch to `Xenova/multilingual-e5-large` (1024-dim, mean pooling + L2 normalize). Document the swap in the report and continue.
- **Final fallback** (both above fail): mark the task BLOCKED with a written failure analysis. Do NOT silently ship MiniLM-only changes.

## Non-goals

- Changing the default model (decision deferred to after bench numbers).
- Updating `install.sh` UX (BGE-M3 is opt-in via config).
- Touching the 103-query bench infra (separate run by maintainer locally).
- Sparse / multi-vector heads of BGE-M3 (transformers.js exposes dense only — acceptable).
- Federation / cross-model index compatibility (manifest mismatch stays strict; rebuild required).

## Architecture

A small **model registry** keyed by a short alias maps `'minilm' | 'bge-m3'` → `{ hubId, dim, pooling, normalize }`. `embedder.ts` accepts the registry entry; `builder.ts` persists `{model, dim}` in `manifest.json`; `io.ts` validates against the **resolved** current model, not a constant. CLI `--model <alias>` overrides `arch-graph.config.ts` `semantic.model`. Default = `'minilm'`.

## File-touch matrix

| # | File | Touch | Role |
|---|------|-------|------|
| 1 | `src/semantic/types.ts` | modify | Add `SEMANTIC_MODELS` registry + `SemanticModelAlias` type. Keep `SEMANTIC_MODEL`/`SEMANTIC_DIM` as `SEMANTIC_MODELS.minilm.*` aliases for backward compat in unchanged callers. |
| 2 | `src/semantic/embedder.ts` | modify | `getPipeline(alias)` takes alias, looks up registry, passes `{pooling, normalize}` to transformers.js. Module-private cache keyed by alias (multiple pipelines coexist if both used). |
| 3 | `src/semantic/builder.ts` | modify | Accept `modelAlias` in `BuildSemanticOpts`. Write resolved `hubId` + `dim` to manifest. |
| 4 | `src/semantic/io.ts` | modify | `readManifest()` accepts expected `{model, dim}` from caller (not module constant). Reject mismatches with actionable error. |
| 5 | `src/semantic/search.ts` | modify | Resolve model alias from config, pass to embedder + manifest validator. |
| 6 | `src/core/config.ts` | modify | Add `SemanticConfig: { model?: SemanticModelAlias }`, `applySemanticDefaults()` helper, integrate into `ArchGraphConfig`. |
| 7 | `src/cli/semantic-commands.ts` | modify | Parse `--model <alias>` flag, merge with config (CLI wins), pass to builder + search. |
| 8 | `src/semantic/*.test.ts` | modify | Replace hardcoded `384` with `registry.minilm.dim`; add BGE-M3 cases (mocked embedder returns 1024-dim). |
| 9 | `src/cli/init.ts` | modify (small) | If config has `semantic.model: 'bge-m3'`, print a one-liner warning about ~500 MB download. No prompt change. |
| 10 | `bench/self-build/run.ts` | **create** | TS runner: accepts `--model <alias> --out <path>`, builds index (delegates to existing builder), runs all 12 queries, writes JSON results. |
| 11 | `bench/self-build/compare.ts` | **create** | TS tool: takes two result JSONs, emits markdown side-by-side table with score/rank deltas and per-category hit-rate diff. |
| 12 | `bench/self-build/README.md` | modify | Document the new runner + comparison flow. |
| 13 | `docs/plans/2026-05-18-bge-m3-migration-report.md` | **create** | Final report with numbers, trade-offs, and migration verdict (recommendation). Lives on the feature branch only until the maintainer decides. |
| 14 | `arch-graph.config.ts` | leave | No change (default model = minilm). Mention `semantic: { model: 'bge-m3' }` only in `README` example. |

## External constraints

- `manifest.json` schema is **strict** — `model` and `dim` mismatches reject the index with an error pointing at `arch-graph semantic build`. Don't relax this; mixing vectors from different embedders is meaningless.
- No new runtime deps. `@huggingface/transformers` already supports BGE-M3 via the `pipeline('feature-extraction', ...)` API (v3.4+).
- All existing tests must stay green. New tests added for both code paths (minilm + bge-m3 via mock pipeline).
- Honor `CLAUDE.md` style rules — no comments unless WHY is non-obvious; no decorative emoji in source.

## Acceptance criteria

### Task 1 — Foundation refactor (types + config + embedder + builder + io + search)

> Touches files #1–8 from the matrix.

- AC1.1 Registry exists: `SEMANTIC_MODELS` exported from `src/semantic/types.ts` with entries `minilm` and `bge-m3`, each carrying `{ hubId, dim, pooling, normalize }`. `SemanticModelAlias` is the union of keys.
- AC1.2 `embedder.ts` takes an alias and dispatches to the right pipeline config; module-level cache is per-alias (Map keyed by alias), so running build with both aliases in the same process is supported.
- AC1.3 `arch-graph.config.ts` accepts optional `semantic.model: 'minilm' | 'bge-m3'`. Missing field → default `'minilm'`. Invalid value → typed validation error in `validateConfig()`.
- AC1.4 `manifest.json` persists `{model: hubId, dim}` from the resolved alias. `readManifest()` rejects with a clear message if expected model/dim differ.
- AC1.5 `search.ts` resolves alias from `effectiveConfig` once and passes it consistently to embedder + manifest validator. Mismatched index errors include the recovery command (`arch-graph semantic build`).
- AC1.6 Backward compat: existing `arch-graph.config.ts` files without `semantic` field continue to work with no changes; existing MiniLM indexes continue to validate.
- AC1.7 **Tests**: unit tests for the registry, embedder dispatch (mock pipeline asserting `{pooling, normalize}` per alias), `validateConfig` accepts/rejects the new field, `readManifest` reject path, and at least one search path test using a mocked 1024-dim BGE-M3 fixture. All previous tests green. Hardcoded `384` removed from tests in favor of registry lookup.
- AC1.8 `pnpm build` (tsc) and `pnpm test` exit 0.

### Task 2 — CLI flag + bench tooling

> Touches files #7, #9–12.

- AC2.1 `arch-graph semantic build --model bge-m3` works. CLI flag overrides config.
- AC2.2 `arch-graph semantic search --model bge-m3 "query"` also accepts `--model`.
- AC2.3 `init.ts` prints a single-line note when `semantic.model: 'bge-m3'` is configured (e.g. "Note: bge-m3 model is ~500 MB on first download.").
- AC2.4 New `bench/self-build/run.ts`: invocable via `pnpm tsx bench/self-build/run.ts --model <alias> --out <path>`. Builds graph + semantic index for the chosen model, runs all 12 queries, writes results as JSON (compatible shape with existing `.ag_results.json`). Idempotent (overwrites prior results at same `--out`).
- AC2.5 New `bench/self-build/compare.ts`: invocable via `pnpm tsx bench/self-build/compare.ts <minilm.json> <bge-m3.json>` and prints a markdown table to stdout with: per-query score delta, per-query rank delta, hit/miss change, per-category hit-rate change, and an overall summary row.
- AC2.6 **Tests**: unit tests for `compare.ts` (deterministic — given two synthetic result fixtures, assert exact markdown output). The `run.ts` end-to-end test is integration-style and may be marked `.skip()` on CI if the model isn't cached — document the skip condition.
- AC2.7 `bench/self-build/README.md` documents the new commands and shows an example invocation chain.
- AC2.8 `pnpm build` and `pnpm test` exit 0.

### Task 3 — Benchmark run + migration report

> Touches file #13. Executes inside the worktree only.

- AC3.1 Run `pnpm tsx bench/self-build/run.ts --model minilm --out bench/self-build/results/minilm.json` (cached MiniLM; ~30–60 s).
- AC3.2 Run `pnpm tsx bench/self-build/run.ts --model bge-m3 --out bench/self-build/results/bge-m3.json` (first run downloads ~500 MB; 2–5 min).
- AC3.3 Run `pnpm tsx bench/self-build/compare.ts ...` and save markdown output to `docs/plans/2026-05-18-bge-m3-migration-report.md` under a "Numbers" section.
- AC3.4 Report also includes:
  - **Trade-offs section**: model size on disk, peak RAM during build (approx via `/usr/bin/time -l` on macOS or comparable), wall-clock build time, first-run download time.
  - **Accuracy section**: total hit-rate delta, per-category delta (A_find / B_debug / D_docs / E_arch — note D_docs was 33% on MiniLM, this is the main candidate for improvement).
  - **Migration verdict**: one of (i) recommend default switch, (ii) recommend keep MiniLM default + advertise BGE-M3 as opt-in, (iii) recommend abandoning BGE-M3 — each with explicit reasoning tied to the numbers.
  - **Known caveats**: 12-query bench is narrow; broader 103-query bench needs to be run by the maintainer locally before any default switch.
- AC3.5 Commit the report on the feature branch with message `docs(plans): BGE-M3 migration bench results + verdict`. Don't merge to main from inside the agent.

### Cross-cutting AC (applies to every commit)

- Conventional Commits format. Scope: `semantic` for Task 1, `bench`/`cli`/`init` as appropriate for Task 2, `docs` for Task 3.
- No `--no-verify` on commits.
- Branch confirmation at the top of each agent report: `git -C <worktree> branch --show-current` + last commit hash.
- Each task is one or more commits (TDD: failing test, implementation, refactor, commit). No "kitchen-sink" mega-commits.

## Risk register

1. **BGE-M3 download blocked / model load fails.** Fallback chain documented in Decision rules. If primary fails, switch to `multilingual-e5-large` and update the registry entry. Document in the report.
2. **Disk pressure**: 500 MB extra on `~/.cache/huggingface/`. Detect existing cache via `transformers.js` defaults — no manual cache management.
3. **Test flakiness from network during model download**: mock the embedder in unit tests; only the `run.ts` end-to-end touches the real model.
4. **Hardcoded `384` in tests**: agent grep replace must be deliberate (some `384` values may be unrelated, e.g. line-counts, byte sizes). Use registry constant where it's the embedding dim, leave others.

## Open questions (resolve during implementation, document in report)

- Does BGE-M3 cosine score distribution match MiniLM's `minScore` thresholds in queries-self-build.json? If BGE-M3 scores are systematically higher/lower, the threshold semantics shift. Possible answers: (a) keep absolute thresholds — accept distribution drift, (b) normalize against per-model baseline. Default: keep thresholds, document drift.
- Should the registry expose a per-model `recommendedMinScore` so threshold drift is per-model? Defer — only add if data shows it's necessary.
