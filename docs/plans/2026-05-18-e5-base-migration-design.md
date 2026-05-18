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

- **Test style:** vitest, see existing `src/semantic/embedder.test.ts` for `Awaited<ReturnType<typeof pipeline>>` mocking with `vi.mock('@xenova/transformers', ...)`. Tests must keep using the 2-arg `toHaveBeenCalledWith('feature-extraction', hubId)` form for minilm/bge-m3/e5-base (only arctic-m uses the 3-arg form).
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

For every model alias (`minilm`, `bge-m3`, `e5-base`, `arctic-m`), the following invariants must be covered by tests:

- `makeEmbedder(alias).embed(['x'])` (default mode) — prefix is applied iff `SEMANTIC_MODELS[alias].prefix?.passage` is defined and non-empty.
- `makeEmbedder(alias).embed(['x'], 'query')` — prefix is applied iff `SEMANTIC_MODELS[alias].prefix?.query` is defined and non-empty.
- `makeEmbedder(alias).embed(['x'], 'passage')` — same as default.
- For `minilm` and `bge-m3` (prefix undefined): input passes through unchanged in both modes.
- For `e5-base` and `arctic-m` (prefix defined): exact `passage: ` / `query: ` strings prepended (note: arctic-m has empty passage prefix — verify pass-through in passage mode).

Build path (semantic builder) must call embedder with `'passage'` (or no argument, which defaults to passage) — assert via spy.
Search path (CLI `semantic search`, MCP `semantic_search`) must call embedder with `'query'` — assert via spy.

Tests: `pnpm test src/semantic/embedder.test.ts src/cli/semantic-commands.test.ts src/mcp/semantic-search.test.ts src/semantic/builder.test.ts` passes. Existing 2-arg pipeline assertion (`toHaveBeenCalledWith('feature-extraction', hubId)`) for minilm/bge-m3/e5-base preserved.

**Tests:** the task IS the tests. Pass = AC met.

### Task 3 — Per-model `recommendedMinScore` calibration

`src/semantic/types.ts` SEMANTIC_MODELS gains a `recommendedMinScore: number` field per entry:

- `minilm`: 0.30 (matches current hardcoded default — no behavior change)
- `bge-m3`: 0.55 (compensates for tighter distribution; bench shows scores 0.65-0.80 typical)
- `e5-base`: 0.55 (prefix-induced normalization yields scores 0.78-0.86 typical)
- `arctic-m`: 0.40 (provisional; not exercised in production yet)

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

- **Hook auto-trigger of semantic build** — Task 5 design includes `--include-semantic` flag for the hook. Default off. Decide post-design whether to flip default on after migration (depends on whether incremental cost is genuinely <2s for typical commits, measured in Task 5).
- **Old indexes on user machines** — schema bump from 1 → 2 forces one full rebuild for existing users. Migration note in README.md or first-run warning?
- **`recommendedMinScore` for arctic-m** — value is provisional (model not validated on arch-graph workload). Documented as such in the field's JSDoc.
