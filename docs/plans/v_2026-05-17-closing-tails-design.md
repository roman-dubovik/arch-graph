# Design: closing-tails — module recall + virtual-kind exclusion
Date: 2026-05-17
Status: READY TO EXECUTE
Target branch: `develop` (off `develop` HEAD `329a01f`)

## Goal

Close two deferred items from snippet-fix-all-kinds-v1:

1. **Module snippet recall** on insyra (79.7%) and beribuy2 (57.1%) below 85% floor.
   Root cause hypothesis: external modules (TypeOrmModule, ConfigModule, etc.)
   live in `node_modules` and have no extractable source. Counting them in the
   denominator depresses the rate artificially. Platform's 92.3% is the
   already-correct ceiling for the proportion of internal modules.

2. **`lib` / `service` (and `external`-module) at 0% recall** — virtual nodes
   with no source file. Validator counts them as "below floor", which is wrong.
   They should be excluded from the recall denominator like `nats-subject`,
   `db-table`, `queue`, `external` already are.

**Both fixes are validator-side, not extractor-side.** Retrieval quality does
not change — only the recall-rate calculation becomes honest.

## File-touch matrix

| Task | Files (absolute paths) | Touches |
|------|------------------------|---------|
| A — virtual-kind exclusion (lib/service) | `/Users/romandubovik/Documents/Projects/arch-graph/src/validation/snippet-recall-validator.ts` | extend `KINDS_WITHOUT_SOURCE` set to include `lib` and `service` |
| B — internal/external module classification | `/Users/romandubovik/Documents/Projects/arch-graph/src/validation/snippet-recall-validator.ts` | per-node classification for `kind === 'module'`: if `node.path` is missing → treat as virtual (skip from denominator); else apply ≥85% floor |
| C — tests | `/Users/romandubovik/Documents/Projects/arch-graph/src/validation/snippet-recall-validator.test.ts` | add unit tests for: (a) lib/service excluded entirely, (b) module with path counted, (c) module without path excluded, (d) mixed module set computes only-internal rate |
| D — CLI smoke + recall verification | run `arch-graph semantic build` + check validator output | verify ≥85% on insyra and beribuy2 module recall after exclusion |

**No mapper changes. No snippet.ts changes. Validator-only scope.**

## Why validator-only is the right scope

The Haiku research agent observed:
- Platform: 130 module nodes, 120 with non-empty snippets = 92.3% → already at ceiling
- All platform modules in the embeddings output lack `anchor` field (snippet works via path + label fallback in `snippet.ts`)
- External modules (node_modules) have `path` unset by design (DiModuleIndex skips them)

This means **path-emission already correctly distinguishes internal from external** —
the validator just doesn't use that signal. We don't need to change extraction;
we just need the validator to ask "is there a path? if yes, expect a snippet."

## Patterns to follow

Current validator pattern (`snippet-recall-validator.ts:46–51`):

```ts
const KINDS_WITHOUT_SOURCE = new Set([
    'nats-subject',
    'db-table',
    'queue',
    'external',
]);
```

After the fix:

```ts
const KINDS_WITHOUT_SOURCE = new Set([
    'nats-subject',
    'db-table',
    'queue',
    'external',
    'lib',           // virtual: no source file
    'service',       // virtual: monorepo service marker
]);

// In the per-node loop, before counting:
function isExpectedToHaveSnippet(node: GraphNode): boolean {
    if (KINDS_WITHOUT_SOURCE.has(node.kind)) return false;
    // Module is special: internal modules have path; externals don't
    if (node.kind === 'module' && !node.path) return false;
    return true;
}
```

Apply this gate in the counting loop. Nodes where `isExpectedToHaveSnippet`
returns `false` are EXCLUDED from both numerator and denominator for their
kind's rate calculation. They still appear in diagnostics (count, sample) but
under a separate "virtual nodes (no source expected)" bucket — not the
floor-checked bucket.

## External constraints

- **No retrieval change.** Search results, scoring, embeddings unchanged.
- **Backward-compat diagnostics**: existing `--strict-recall` flag still
  exits 1 when any kind with a non-zero "expected-snippet" denominator falls
  below floor. The denominator is now smaller (more honest), but the rule
  is the same.
- **Test coverage**: every branch of `isExpectedToHaveSnippet` covered by
  unit test. Including the regression vector: a future PR removes a path
  emit from internal modules → recall correctly drops <85% → exit code 1.
- **Commit policy**: Conventional Commits, no Co-Authored-By, scope = arch-graph.
- **Branch hygiene**: work in `.claude/worktrees/<auto-name>` (harness-created).
  Never `git switch develop` inside the worktree. Use absolute paths in
  prompts. Confirm branch + commit hash at top of report.
- **No regression on existing tests** — 970/970 must still pass + new tests.

## Acceptance Criteria (single bundle, all must hold)

CT-AC1. **`lib` and `service` excluded**: validator's `KINDS_WITHOUT_SOURCE`
        includes both. No `lib:*` or `service:*` node appears in any
        below-floor diagnostic.

CT-AC2. **Module classification**: validator computes recall for `kind: 'module'`
        only across nodes where `node.path` is set (= internal modules).
        Modules without `path` (= external, from node_modules) are reported
        under a separate "virtual nodes" diagnostic, not flagged as failures.

CT-AC3. **Recall floor met on all 3 projects**:
        - platform: module ≥ 85% (currently 92.3% on the *full* denominator;
          will be ≥95% on internal-only denominator)
        - insyra: module ≥ 85% (currently 79.7% on full → expect ≥95% on internal)
        - beribuy2: module ≥ 85% (currently 57.1% on full → expect ≥95% on internal)

        If insyra/beribuy2 STILL fail after internal-only filter, that's a
        real bug — escalate to user before merge (Phase 3.5 partial-AC
        discipline applies).

CT-AC4. **Unit tests**: 4 new test cases added (per file-touch matrix Task C),
        all passing. Existing tests still 100% pass.

CT-AC5. **CLI smoke**: run `arch-graph semantic build --strict-recall` on all
        3 projects (using existing indexes); all 3 exit 0.

CT-AC6. **No retrieval regression**: spot-check 3 queries from the 60-query
        suite that returned module nodes in top-5 — same nodes still appear
        with same scores. (Validator change must not affect embeddings.)

CT-AC7. **Diagnostics output is more honest, not less informative**:
        the new "virtual nodes (no source expected)" section reports counts
        per kind (`lib: N`, `service: N`, `module (external): N`).

## Open questions

OQ1. **Should "external module" be a separate kind in the graph, or just a
     module-without-path?** Recommend the latter for now (no schema change,
     classified by presence of `path`). If future eval needs to distinguish,
     add `meta.isExternal: boolean` later.

OQ2. **For the new "virtual nodes" diagnostic — JSON shape?** Recommend:
     ```ts
     virtualNodes: {
         lib: number;
         service: number;
         moduleExternal: number;
         natsSubject: number;
         dbTable: number;
         queue: number;
         external: number;
     }
     ```
     Numeric counts only. No need to list IDs.

## Task plan

| # | Task | Complexity | Model | Worktree |
|---|------|-----------|-------|----------|
| 1 | A + B + C (validator + tests, single feature branch) | Medium | Sonnet | isolation off develop |

Single agent, single commit (or 2-3 commits for clean history). Tasks A and B
touch the same file (`snippet-recall-validator.ts`) so they MUST be one task.

## Sequence to ship

1. Phase 1.1 — design doc (this file) committed to develop before dispatch.
2. Phase 3 — Sonnet agent in isolated worktree implements A+B+C.
3. Phase 3.1 — verify agent report (branch, commit, diff, QG paste).
4. Phase 3.5 — AC verification (independent Haiku agent reads diff + reads
   recall output on all 3 projects).
5. Phase 4 — quality gate (typecheck + test + lint).
6. Phase 5 — pr-review-toolkit (3 agents: code-reviewer, silent-failure-hunter,
   pr-test-analyzer). Type-design + comment-analyzer skipped this round
   (per Phase 5 asymptote rule — small validator change, low polish surface).
7. Phase 6 — iterate fix → re-review until 0 P0 + 0 P1.
8. Phase 7 — merge → develop with `--no-ff`, tag `closing-tails-v1`,
   v_-rename this design file.
9. Phase 8.5 — advisor call.
10. Phase 9 — summary.
