# e5-base default-switch migration — design

Date: 2026-05-18
Branch: `feat/e5-base-migration`
Worktree: `.worktrees/feat-e5-migration`
Owner: team-lead orchestrating subagents

## Goal

Flip arch-graph's default embedder from `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384-dim) to `Xenova/multilingual-e5-base` (768-dim, passage/query prefixes) on `main`. Bench evidence: +6pp aggregate recall, C_ui 36% → 82% on three NestJS monorepos. Cost: ×1.6 build time (25 min → 41 min on 30K nodes).

Before flipping the default, ship three blocking follow-ups so the migration is honest:

1. Public site-doc explaining the choice (why e5-base, what we measured, what we deferred).
2. Prefix unit-test review — verify `passage:` is used at build, `query:` at search, undefined for prefix-less models. Hand-audit + new tests where missing.
3. Per-model `recommendedMinScore` — current 0.30 default is calibrated for MiniLM; e5-base has tighter distribution (~0.83 ± 0.02) and needs a different floor.
4. Incremental semantic re-embed — currently every `semantic build` re-embeds the whole graph; with e5-base ×1.6 this becomes too slow to enable hook-driven auto-update. Incremental brings the typical commit cost to ~1-2 seconds.
5. Then flip the default and merge.

## File-touch matrix

| Task | Files (exact paths, relative to worktree root) | Touches |
|------|-----------------------------------------------|---------|
| 1 — Site doc | `docs/comparisons/2026-05-18-embedder-evaluation.md` (CREATE) | new file |
| 2 — Prefix unit-tests | `src/semantic/embedder.test.ts`, `src/cli/semantic-commands.test.ts`, `src/mcp/semantic-search.test.ts`, `src/semantic/builder.test.ts` | audit + add tests |
| 3 — minScore calibration | `src/semantic/types.ts`, `src/mcp/semantic-search.ts`, `src/cli/semantic-commands.ts`, `src/semantic/types.test.ts`, `src/mcp/semantic-search.test.ts` | new field + default-resolution path |
| 4 — Incremental re-embed (design) | `docs/plans/2026-05-18-incremental-semantic-design.md` (CREATE) | new file |
| 5 — Incremental re-embed (impl) | `src/semantic/types.ts` (bump schema, add `contentHash` to SemanticRecord), `src/semantic/builder.ts`, `src/cli/semantic-commands.ts` (`--full` flag), `src/cli/hooks.ts` (option to chain semantic build), `src/semantic/builder.test.ts`, new `src/semantic/incremental.test.ts` | schema bump + skip-list logic |
| 6 — Switch default + docs | `src/semantic/types.ts` (default alias), `arch-graph.config.ts` (if needed), `ROADMAP.md`, `README.md` | flip default + roadmap reorg |

**Parallel vs sequential (per file-touch overlap):**

- Task 1 (site doc) touches a brand-new file in `docs/comparisons/` — **parallel-safe** with anything.
- Task 2 (prefix tests) touches `src/.../*.test.ts` files. Task 3 also touches `src/mcp/semantic-search.test.ts` → **Task 2 must complete before Task 3.**
- Task 3 modifies `src/semantic/types.ts` — Tasks 5 and 6 also modify it → **sequential: 3 → 5 → 6.**
- Task 4 (design doc for incremental) is doc-only and feeds Task 5 → **Task 4 before Task 5.**
- Task 6 is the closer — flips default, updates ROADMAP/README, must run last.

Final order:
```
   ┌──────────────────────┐
   │ Task 1: Site doc     │ ─── runs in parallel from start
   └──────────────────────┘
   ┌──────────────────────┐
   │ Task 2: Prefix tests │ ─── runs sequentially in main lane
   └──────────────────────┘
              ↓
   ┌──────────────────────┐
   │ Task 3: minScore cal │
   └──────────────────────┘
              ↓
   ┌──────────────────────┐
   │ Task 4: Incremental  │
   │         design doc   │
   └──────────────────────┘
              ↓
   ┌──────────────────────┐
   │ Task 5: Incremental  │
   │         impl + tests │
   └──────────────────────┘
              ↓
   ┌──────────────────────┐
   │ Task 6: Flip default │
   └──────────────────────┘
```

## Patterns to follow

- **Test style:** vitest, see existing `src/semantic/embedder.test.ts` for `Awaited<ReturnType<typeof pipeline>>` mocking with `vi.mock('@xenova/transformers', ...)`. Tests use the 2-arg `toHaveBeenCalledWith('feature-extraction', hubId)` form for `minilm` and `e5-base` (the only remaining aliases after Task 6 cleanup).
- **Conventional Commits:** `feat(semantic): ...`, `test(semantic): ...`, `docs(comparisons): ...`, `fix(semantic): ...`. Keep scope=semantic for code/tests; scope=comparisons for site doc; scope=hook for hook changes.
- **Selective `git add`:** stage only files you touched. Do NOT `git add -A`. The worktree has untracked `arch-graph-out/` artifacts from past local builds — leave them alone.
- **Bench artifacts retained:** `/tmp/bge-m3-bench/results-*` and `/tmp/bge-m3-bench/run-*.log` are kept for future analysis. Do not delete.
- **No project-name leakage in public docs.** Use `project-a` / `project-b` / `project-c`. Memory entry "Eval re-runs re-leak anonymization" pins this — every PR touching `docs/comparisons/` is scrubbed before commit.

## External constraints

- **Test suite must stay green** at every commit boundary. Existing `run.test.ts` timeout (5s exceeded on CPU contention) is a known flake — acceptable if reproducible in isolation but no contention.
- **Schema version**: `SEMANTIC_SCHEMA_VERSION` is currently 1. Task 5 will bump to 2 (adds `contentHash` to SemanticRecord). Manifest schema-version mismatch handling already exists at search time; verify it routes to "force full rebuild" path.
- **Public anonymization**: aggregate numbers (`%`, `+Δpp`, build time in minutes) are public-safe. Per-query examples must not include private repository names; reuse the `arch-graph` self-build queries from `bench/self-build/queries.json` if examples are needed.
- **No upgrade of `@xenova/transformers`** in this branch. Arctic-m v3 migration is a separate concern tracked in ROADMAP.

## Acceptance Criteria

### Task 1 — Site doc

File `docs/comparisons/2026-05-18-embedder-evaluation.md` exists with the following sections:

1. **TL;DR** — one-paragraph summary: switching to e5-base for +6pp recall, C_ui 36→82%, accepting ×1.6 build cost.
2. **Setup** — 3 projects, 103 queries, mode=both-buckets, K=10, hardware (Darwin arm64, Node v22).
3. **4-way table** — aggregate per-project hit-rate for MiniLM / e5-base / BGE-M3 (where available) / arctic-m (where measured). Use project-a/b/c naming, no real repo names.
4. **Per-category breakdown** — A_find / B_debug / C_ui / E_arch / D_docs / D_links columns × MiniLM/e5-base rows on project-a (the most query-diverse).
5. **Build cost** — table: minutes per model per project; minilm vs e5-base ratio; bge-m3 abort note.
6. **Why not BGE-M3** — concise paragraph: ×6 build cost on 30K nodes, killed after 2h40m, unshippable as default.
7. **Why not arctic-m yet** — concise paragraph: gte fallback in transformers.js v2.17 produces broken vectors (20% sanity bench), requires v3 migration which is deferred.
8. **Trade-offs accepted** — bullet list of overheads (disk +155 MB, RAM +600 MB, build time ×1.6, query +30-50ms).
9. **Open follow-ups** — list of three follow-ups completed in this migration set with links to commits or design doc.
10. **Reproducibility** — pointer to `scripts/run-baseline-eval.sh` + env-vars used.

Tests: doc must lint clean (no broken markdown), no leakage of private repo names. Cross-reference check: ROADMAP.md "Recall trajectory" row for e5-base 75% matches.

**Tests N/A** — this is doc-only.

### Task 2 — Prefix unit-test review

> **Note:** `bge-m3` and `arctic-m` were removed from the registry in Task 6.
> See the [## UPDATE](#update--2026-05-18-evening-scope-expanded-per-user-direction-auto-mode) section below.
> The alias list and prefix-rule explanations below reflect the final shipped state.

For every model alias (`minilm`, `e5-base`), the following invariants must be covered by tests:

- `makeEmbedder(alias).embed(['x'])` (default mode) — prefix is applied iff `SEMANTIC_MODELS[alias].prefix?.passage` is defined and non-empty.
- `makeEmbedder(alias).embed(['x'], 'query')` — prefix is applied iff `SEMANTIC_MODELS[alias].prefix?.query` is defined and non-empty.
- `makeEmbedder(alias).embed(['x'], 'passage')` — same as default.
- For `minilm` (prefix undefined): input passes through unchanged in both modes.
- For `e5-base` (prefix defined): exact `passage: ` / `query: ` strings prepended.

Build path (semantic builder) must call embedder with `'passage'` (or no argument, which defaults to passage) — assert via spy.
Search path (CLI `semantic search`, MCP `semantic_search`) must call embedder with `'query'` — assert via spy.

Tests: `pnpm test src/semantic/embedder.test.ts src/cli/semantic-commands.test.ts src/mcp/semantic-search.test.ts src/semantic/builder.test.ts` passes. Existing 2-arg pipeline assertion (`toHaveBeenCalledWith('feature-extraction', hubId)`) for minilm/e5-base preserved.

**Tests:** the task IS the tests. Pass = AC met.

### Task 3 — Per-model `recommendedMinScore` calibration

`src/semantic/types.ts` SEMANTIC_MODELS gains a `recommendedMinScore: number` field per entry.
(`bge-m3` and `arctic-m` were removed in Task 6 — see the UPDATE section.)

- `minilm`: 0.30 (matches current hardcoded default — no behavior change)
- `e5-base`: 0.55 (prefix-induced normalization yields scores 0.78-0.86 typical; 0.55 is intentionally below that range to preserve cross-lingual hits)

Resolution path in `src/mcp/semantic-search.ts` and CLI `semantic search`:

1. If user passes `--min-score` (CLI) or `minScore` (MCP) — use it.
2. Else, use `SEMANTIC_MODELS[manifest.model-alias].recommendedMinScore`.
3. Else (manifest lacks alias mapping), fall back to 0.30.

The legacy 0.30 hardcoded constant becomes the step-3 fallback and stays.

Tests (`src/mcp/semantic-search.test.ts`, new `src/semantic/types.test.ts`):
- Each alias resolves to its `recommendedMinScore` when user provides no override.
- User override always wins.
- MiniLM behavior on existing fixtures unchanged at 0.30.
- e5-base fixture with score 0.50 is filtered (below 0.55) where MiniLM would have kept it.

**Tests:** new unit tests for resolution path; happy path + at least one error/edge branch (missing manifest alias → fallback) in the same commit. Must run via project's `test` target and pass.

### Task 4 — Incremental re-embed design doc

File `docs/plans/2026-05-18-incremental-semantic-design.md` exists with:

1. Goal: skip re-embedding of unchanged nodes on `arch-graph semantic build`.
2. Schema change: bump `SEMANTIC_SCHEMA_VERSION` 1 → 2; add `contentHash: string` (sha256 of `kind|label|snippet|model-alias`) to `SemanticRecord`.
3. Algorithm:
   - Load existing `embeddings.jsonl` into `Map<nodeId, {contentHash, vector}>` if manifest.model matches current alias AND manifest.schemaVersion === 2.
   - For each node in graph: compute hash; if map has match for `nodeId` with same hash → reuse vector; else → enqueue for embedder.
   - Deleted nodes (in map but not in graph) → dropped from output.
4. CLI flag: `--full` forces full re-embed regardless of cache.
5. Backwards-compat: schemaVersion=1 indexes can't be reused (no contentHash) → automatic full rebuild with one-line warning.
6. Hook integration: post-structural-build invocation of `arch-graph semantic build --incremental` is opt-in via `arch-graph hook install --include-semantic` (new flag, default off). Design includes the flag-handling spec; impl can be either this branch or follow-up.
7. Performance model: full rebuild = N × per-node time; incremental rebuild = K × per-node time + N × hash time, where K = changed-node count, N = total nodes.
8. Edge cases enumerated: model alias change in config; corrupt embeddings.jsonl; dim mismatch; partial write failure recovery.
9. Test plan outlined (covers schema bump, model-change, --full, edge cases).

**Tests N/A** — design doc only.

### Task 5 — Incremental re-embed impl

Code matches the spec in Task 4 design doc. Specifically:

- `src/semantic/types.ts`: `SEMANTIC_SCHEMA_VERSION = 2 as const`, `SemanticRecord.contentHash: string` field added.
- `src/semantic/builder.ts`: `buildSemanticIndex` accepts new option `{ full?: boolean }`. When `full !== true` and prior manifest is compatible, loads prior vectors and reuses by `contentHash` match. Skipped count surfaces in returned diagnostics.
- `src/cli/semantic-commands.ts`: `--full` flag parsed in `cmdSemanticBuild`. Default behavior is incremental when prior index exists.
- `src/cli/hooks.ts`: new optional `--include-semantic` flag in `arch-graph hook install`. When set, the installed hook also calls `arch-graph semantic build --incremental --quiet || true` after the structural build.
- `SemanticDiagnostics.counts` gets `reused: number` and `recomputed: number` (sums to indexed).

Tests (new `src/semantic/incremental.test.ts` and additions to `builder.test.ts`):
- Hash determinism: same `(kind, label, snippet, model)` → same hash; any field change → different hash.
- No-op rebuild: zero changes → 0 embedder calls, all nodes reused.
- Single-node change: 1 embedder call, N-1 reused.
- Model-alias change: full rebuild forced, no reuse.
- Schema-version mismatch in prior manifest: full rebuild forced, warning printed.
- `--full` flag: forces full rebuild even with compatible prior index.
- Deleted nodes: not present in output, no orphans.

**Tests:** comprehensive unit suite covering all 7 cases above + at least one error path (corrupt embeddings.jsonl). Must run via project's `test` target and pass.

### Task 6 — Switch default + docs

- `src/semantic/types.ts`: `SEMANTIC_MODEL` and `SEMANTIC_DIM` deprecated-aliases pointed at e5-base. Document the new default everywhere they're referenced.
- New `defaultModelAlias: SemanticModelAlias = 'e5-base'` exported and used as the fallback when config doesn't specify.
- `arch-graph.config.ts` template (if shipped to users via `arch-graph init`) defaults to `semantic: { model: 'e5-base' }`.
- `ROADMAP.md`:
  - Promote e5-base into Shipped (new dated entry).
  - Remove "Open question 1" about when to flip the default.
  - Update "Recall trajectory" table to reflect e5-base as shipped baseline.
  - Update "Known limits" note about C_ui (already resolved).
- `README.md`: update model name in setup instructions, cache size note (135 MB → ~280 MB), build-time mention.

Tests:
- Existing test suite must pass with new default. Any test that hardcoded "minilm" as the default needs explicit alias.
- New test: `arch-graph init` produces a config with `semantic.model: 'e5-base'`.

**Tests:** the suite must remain green. Any test that hardcoded "Xenova/paraphrase-multilingual-MiniLM-L12-v2" or `dim: 384` as the default must either move to explicit minilm or update to e5-base values. Track each one in the commit.

## Open questions

- **Hook auto-trigger of semantic build** — **RESOLVED.** Task 6 UPDATE section flipped the default to on (`arch-graph hook install` includes semantic build by default; `--no-include-semantic` opts out). Incremental per-commit cost measured at ~1-2 s on typical commits — acceptable.
- **Old indexes on user machines** — schema bump from 1 → 2 forces one full rebuild for existing users. Migration note in README.md or first-run warning?
- **`recommendedMinScore` for arctic-m** — *Moot; arctic-m was removed from the registry in Task 6.* See UPDATE section.

---

## UPDATE — 2026-05-18 evening: scope expanded per user direction (auto-mode)

### Scope adjustments

1. **Cleanup is broader than originally planned.** User confirmed both `bge-m3` AND `arctic-m` aliases are to be removed from the registry. Final registry: `minilm` (legacy default) + `e5-base` (new default) only. ROADMAP's "BGE-M3 — superseded by e5-base" section is rewritten to "BGE-M3 — explored, not adopted" (won't ship status).
2. **Hook default flipped:** Task 5's `--include-semantic` flag on `arch-graph hook install` becomes **on by default**, with `--no-include-semantic` opt-out. Rationale: incremental re-embed makes per-commit cost ~1-2s for typical commits; user explicitly chose default-on.
3. **Post-merge bench:** after Tasks 2-7 land on main, run the full 103-query bench on project-a/b/c with e5-base as the new default, plus the 12-query arch-graph self-build mini-bench. Numbers attached to Phase 9 summary.
4. **No push to origin:** all work stays local. User pushes after morning review.

### Acceptance Criteria — updates

#### Task 5 — hook default flipped to include-semantic

`arch-graph hook install` (no flag) now installs a hook that runs BOTH structural build AND `semantic build --incremental --quiet`. `--no-include-semantic` opt-out flag preserves the legacy structural-only behavior. Tests cover both modes.

#### Task 6 — cleanup: remove arctic-m AND bge-m3

- `SemanticModelAlias` union narrowed to `'minilm' | 'e5-base'`.
- `SEMANTIC_MODELS` registry has only these two entries.
- `embedder.ts`: conditional `quantized: false` branch is removed (only minilm and e5-base support quantized=true).
- `scripts/run-baseline-eval.sh`: MODEL case updated to `minilm|e5-base` only.
- Tests referencing `bge-m3` or `arctic-m` aliases removed or refactored.
- ROADMAP: BGE-M3 section moved from "Deferred" to "Explored — not adopted" (with `feat/bge-m3-migration` branch reference for historical record). Arctic-m section likewise.
- README mentions of bge-m3/arctic-m aliases removed.
- Tests for `bge-m3` and `arctic-m` cases in `*.test.ts` files removed cleanly (no orphan imports/refs).

Tests: full vitest suite passes; no compile errors from dangling references.

#### Task 8 (new) — Post-merge bench

After Task 7 commits land on main:

1. **Self-build mini-bench:** `pnpm tsx bench/self-build/run.ts` with new default (e5-base). Numbers stored at `bench/self-build/results/e5-base.json`. Compare against historical MiniLM numbers.
2. **Full 103-query bench on 3 projects (project-a, project-b, project-c):**
   - `MODEL=e5-base EVAL_MODE=both-buckets bash scripts/run-baseline-eval.sh`
   - Use existing project paths (PROJECT_A_DIR=/Users/romandubovik/Documents/Projects/platform, PROJECT_B_DIR=/Users/romandubovik/Documents/Projects/insyra, PROJECT_C_DIR=/Users/romandubovik/Documents/Projects/beribuy/beribuy-2.0)
   - Results files go to `/tmp/bge-m3-bench/` so they don't enter the repo (anonymization rule). Per-project aggregate hit-rates extracted to a single anonymized summary in Phase 9 report.
3. **Incremental perf measurement:**
   - On project-c: time `arch-graph semantic build --full` vs `arch-graph semantic build` (no-op, after first run).
   - On project-c: edit one node's snippet, then time `arch-graph semantic build` again.
   - Record: full time, no-op time, single-node-change time.

Tests N/A — this is empirical measurement. Numbers attached to Phase 9 summary.

