# Great Squash — Pre-merge Audit

Date: 2026-05-19
Branch: `chore/great-squash` (off main `d51d3aa`)
Source plan: `~/.claude/projects/-Users-romandubovik-Documents-Projects-dotforge/memory/plan_great_squash_develop_to_main.md`

## State snapshot

- arch-graph local main HEAD: `d51d3aa` ("docs: scrub remaining client-name leaks").
- arch-graph local develop HEAD: `120e5e3` ("docs: anonymize ident_* schema prefix").
- merge-base: `635b405`.
- 168 commits develop-only, 174 main-only since divergence.
- origin/main = local main (0/0 sync).
- Origin tags (7, pushed): `bench-2026-05-19`, `bullmq-extras-v1`, `bullmq-realworld-v1`, `bullmq-realworld-v2`, `bullmq-realworld-v3`, `bullmq-types-v1`, `cron-v1`.
- Local-only develop tags (9, **per AC4.1 choice (c) NOT pushed**): `closing-tails-v1`, `code-vs-docs-v1`, `doc-section-v1`, `fe-i18n-multi-enum-v1`, `init-strategy-v1`, `openapi-enrich-v1`, `pre-anonymization-scrub-2026-05-17`, `snippet-fix-all-kinds-v1`, `ui-uplift-v1`.

## Dry-run squash result

```
git checkout -b _tmp_dryrun_merge main
git merge --squash develop
→ 47 conflict files (UU/AA), 49 total modified files
git reset --hard HEAD && git checkout main && git branch -D _tmp_dryrun_merge
```

Working tree returned clean (only `?? .claude/` untracked persists).

## Conflict files (47)

```
README.md
ROADMAP.md
docs/BENCHMARKS.md
docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md
docs/index.html
docs/plans/2026-05-17-en-normalized-rerun.md
docs/plans/v_2026-05-16-semantic-sidecar-design.md
docs/plans/v_2026-05-17-closing-tails-design.md
docs/plans/v_2026-05-17-doc-section-extractor-design.md
docs/plans/v_2026-05-17-doc-section-extractor-implementation.md
docs/plans/v_2026-05-17-openapi-enrich-design.md
scripts/eval/queries-en.json
scripts/eval/queries.json
scripts/eval/results-2026-05-16.md
scripts/eval/results-2026-05-17-both-buckets-en.md
scripts/eval/results-2026-05-17-both-buckets.md
scripts/eval/results-2026-05-17-fallback.md
scripts/eval/results-2026-05-17-per-category.md
scripts/eval/results-2026-05-17.md
scripts/eval/results-after-filter-fix.md
scripts/integration-test.sh
scripts/run-baseline-eval.sh
src/cli/init.test.ts
src/cli/init.ts
src/cli/semantic-commands.test.ts
src/cli/semantic-commands.ts
src/core/config.docs.test.ts
src/core/config.ts
src/core/types.ts                       # EXHAUSTIVENESS GATE 1
src/mcp/semantic-search.test.ts
src/mcp/server.ts                       # EXHAUSTIVENESS GATE 2
src/output/graph-mermaid.ts             # EXHAUSTIVENESS GATE 3
src/pipeline/build.ts
src/semantic/builder.test.ts
src/semantic/builder.ts
src/semantic/embedder.test.ts
src/semantic/embedder.ts
src/semantic/io.test.ts
src/semantic/io.ts
src/semantic/search.test.ts
src/semantic/search.ts
src/semantic/tokenizer.test.ts
src/semantic/tokenizer.ts
src/semantic/types.ts
```

## TSC baselines (non-fixture)

- **main HEAD**: 5 errors (`npx tsc --noEmit 2>&1 | grep -v __fixtures__ | grep -cE 'error TS'`).
- **develop HEAD**: 1 error (same filter).
- **Post-merge target**: ≤ **max(5, 1) = 5**. Hard threshold: if > 6, investigate before commit.

Total tsc errors with fixtures included: main = 49 (44 fixture-only), develop ~ same shape — fixture files are intentionally non-compiling test inputs.

## Exhaustiveness gate triple — UNION analysis

**KEY FINDING: `main` is a SUPERSET of `develop` on all 3 gate files.**

Develop's last touch on these files predates `cron-v1` + `bullmq-extras-v1` + `bullmq-types-v1` work. So develop lacks:

- **NodeKind**: develop missing `'cron-schedule'` (added by cron-v1). NodeKind UNION = main's 19 members.
- **EdgeKind**: develop missing `'cron-triggers'`, `'queue-fails-into'`, `'queue-event-listener'`, `'queue-repeat'`. EdgeKind UNION = main's 33 members.
- **EDGE_KIND_CHECK** (`src/mcp/server.ts`): UNION = main's 33 keys.
- **EDGE_SYNTAX** (`src/output/graph-mermaid.ts`): UNION = main's 33 keys.

### Resolution rule for gate triple

**Take main unconditionally** for:
- `src/core/types.ts`
- `src/mcp/server.ts`
- `src/output/graph-mermaid.ts`

Develop's version is a strict subset; nothing to preserve from develop on these 3 files. After taking main, verify via `npx tsc --noEmit` — should reproduce 5-error baseline.

## Conflict resolution priority (Phase B sequencing)

| Group | Files | Rule | Notes |
|-------|-------|------|-------|
| 1. Gate triple | `src/core/types.ts`, `src/mcp/server.ts`, `src/output/graph-mermaid.ts` | **Take main** | Pre-verified superset above |
| 2. Extractors / pipeline | `src/pipeline/build.ts` | Manual merge: main's BullMQ + cron orchestration + develop's semantic-pipeline integration | High risk — verify via Phase C insyra smoke |
| 3. CLI | `src/cli/init.ts`, `src/cli/init.test.ts`, `src/cli/semantic-commands.ts`, `src/cli/semantic-commands.test.ts` | Take develop where main never touched (semantic), main where develop didn't | |
| 4. Core config | `src/core/config.ts`, `src/core/config.docs.test.ts` | Manual merge — add new config fields from BOTH sides | |
| 5. MCP semantic search | `src/mcp/semantic-search.test.ts` | Take develop (code-vs-docs-v1 work) | |
| 6. Semantic refactors | `src/semantic/*` (10 files) | Take develop mostly (refactor); ensure main's minor changes preserved | Run `pnpm test src/semantic` post-resolve |
| 7. Eval scripts | `scripts/eval/queries*.json`, `scripts/eval/results-*.md`, `scripts/integration-test.sh`, `scripts/run-baseline-eval.sh` | JSON: UNION via jq. Markdown results: take develop (more comprehensive). Shell scripts: manual merge | |
| 8. Docs | `README.md`, `ROADMAP.md`, `docs/BENCHMARKS.md`, `docs/comparisons/*`, `docs/index.html`, `docs/plans/*.md` | Take main's structure + APPEND develop's missing entries; AC5.1 union | |

## Commit-message leak scan on develop

```
git log main..develop --pretty='%H|%s' | grep -iE "insyra|beribuy|platformx|platform_|nightly-quality-check|weekly-retention-cleanup|insyra-like|platform-like|beribuy-?2|\bplatform\b"
→ 1 commit
```

The single hit: `cc149fe` "docs: anonymize remaining platform/i..." — itself an anonymization-documentation commit (like main's `80d5dc5`/`d51d3aa`). It documents the mapping; literal client-names appear by intent. **Squash commit message must consolidate this without literal mentions** (AC2.2). No additional develop-side commit-message rewriting needed for AC2.1+AC2.2 scope.

For **AC2.3** (full commit-message history rewrite via filter-repo), main side has ~30 commits flagged in the source plan; develop side adds ~0-1. Combined ~30. Tag→subject map below covers the 7 origin tags that would need re-anchoring post-rewrite.

## Tag → subject map (for AC2.3 force-push recovery)

After `git filter-repo --replace-message`, ALL commit SHAs change. The 7 origin tags need to be recreated pointing at the equivalent commits identified by subject:

```
bench-2026-05-19          | 91f1443 | Merge feat/bench-rerun-2026-05-19: graphify LLM rebuild + bench docs update
bullmq-extras-v1          | 47f82e5 | Merge feat/bullmq-extras: BullMQ Phase 1 extras (bullmq-extras-v1)
bullmq-realworld-v1       | 96afdfc | Merge feat/bullmq-realworld: real-world recall fixes + eval queries (bullmq-realworld-v1)
bullmq-realworld-v2       | 6fbfd3f | Merge feat/bullmq-heritage-recursive: 2-level inheritance jobData closure (bullmq-realworld-v2)
bullmq-realworld-v3       | ab47cd8 | Merge feat/bullmq-default-concurrency: 100% concurrency recall via BullMQ-default injection (bullmq-realworld-v3)
bullmq-types-v1           | f0e9204 | Merge feat/bullmq-types: BullMQ Phase 2 + cross-enrichment (bullmq-types-v1)
cron-v1                   | 4d3a045 | Merge feat/cron-extractor: @nestjs/schedule extractor + 'cron-schedule' NodeKind (cron-v1)
```

Recovery sequence post-filter-repo (per advisor #6, only if AC2.3 attempted):
1. Save above subject list pre-rewrite.
2. Run `git filter-repo --replace-message <expressions>`.
3. For each tag: `new_sha=$(git log --all --format='%H %s' | grep '<subject>' | head -1 | awk '{print $1}'); git tag -f <tag> $new_sha`.
4. `git push origin --tags --force` + `git push origin main --force`.

Local-only tags (9) — NOT recreated (per AC4.1 choice (c) — bundled into squash, granularity lost by design).

## Graphify hook state

Verified safe:
- `.husky/` empty in arch-graph.
- `.git/hooks/post-commit` not present.
- No `graphify`/`hook`/`post`/`pre` scripts in `package.json`.

→ No auto-commit race risk during Phase B. The `graphify-out/` directory at repo root will not be touched by hooks; Phase B agent must NOT `git add -A` it.

## Phase B input contract

Phase B agent will:
1. Start on `chore/great-squash` (this branch — first commit will be this audit doc).
2. Run `git -C /Users/romandubovik/Documents/Projects/arch-graph merge --squash develop`.
3. Resolve 47 conflicts per priority table above; gate triple = take main; semantic/* = take develop; rest = manual.
4. Anonymization scrub (AC2.1) over full working tree post-resolve.
5. Run `pnpm test` + `npx tsc --noEmit 2>&1 | grep -v __fixtures__ | grep -cE 'error TS'`. Expect tests ≥ 1432, tsc ≤ 5.
6. Stage only intended files via `git add <paths>`; never `git add -A`; exclude `graphify-out/*`, `.claude/`.
7. Commit a SINGLE squash commit with clean message (AC2.2, no literal client names).
8. STOP. Do NOT push. Do NOT touch develop. Do NOT merge into main.

## Out of scope

- Bench re-run after merge.
- Pushing local-only develop tags (per AC4.1 (c)).
- AC2.3 force-push — gated by user confirmation at Phase E.
