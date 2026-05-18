# Design: Snippet-fix-all-kinds + Eval expansion
Date: 2026-05-17

## Goal
1. **Track A**: fix the 90%-empty-snippet bug across ALL node kinds.
   Currently 3753/4184 project-a nodes embed only `label + kind` because
   (a) provider/endpoint/db-entity-field/config-field nodes have no `path`,
   (b) `extractSnippet` cannot resolve composite labels (`users/email`,
       `POST /mssql-sync/agents/:id`),
   (c) `SKIPPED_NODES_CAP = 50` hides the real scale.
2. **Track B**: expand `scripts/eval/queries.json` from 26 → 60-80 queries
   for statistical significance, then re-run eval to measure Track A's
   uplift.

Both tracks merge into `feat/semantic`. **NEVER touch main.**

## File-touch matrix

| Track | Task | Files (absolute paths) | Touches |
|------|------|------------------------|---------|
| A1 | provider mapper emit path+anchor | `/.worktrees/feat-semantic/src/mapper/di-to-graph.ts` (and similar; locate by grep) | + path + anchor name on emitted node |
| A2 | endpoint mapper emit path+anchor | `/.worktrees/feat-semantic/src/mapper/endpoint-to-graph.ts` | + path + anchor (controller class + method name) |
| A3 | config-field mapper emit path+anchor | `/.worktrees/feat-semantic/src/mapper/config-to-graph.ts` | + path + anchor |
| A4 | db-entity-field mapper emit path+anchor | `/.worktrees/feat-semantic/src/mapper/entity-fields-to-graph.ts` | + path + anchor (entity class + field name) |
| A5 | scoped-marker mapper emit path+anchor | `/.worktrees/feat-semantic/src/mapper/scoped-to-graph.ts` (locate by grep) | + path + anchor |
| A6 | fe-to-graph: ensure path is set for fe-page/fe-route (fe-component already has it) | `/.worktrees/feat-semantic/src/mapper/fe-to-graph.ts` | path verification |
| A7 | core/types: `GraphNode.anchor?: string` field | `/.worktrees/feat-semantic/src/core/types.ts` | optional schema field |
| A8 | snippet extractor: handle composite labels via `anchor` | `/.worktrees/feat-semantic/src/semantic/snippet.ts` | kind-aware resolution + JSX-return + JSDoc inclusion for fe-component |
| A9 | builder: ensure `.tsx`/`.jsx` files loaded into project | `/.worktrees/feat-semantic/src/semantic/builder.ts` (and ts-morph project bootstrap if not there) | verify Project globs include tsx/jsx |
| A10 | SKIPPED_NODES_CAP → 10000 | `/.worktrees/feat-semantic/src/semantic/types.ts` | constant bump |
| A11 | snippet recall validator | `/.worktrees/feat-semantic/src/validation/snippet-recall-validator.ts` (new) | new validator, per-kind ≥ 85% non-empty snippet |
| A12 | per-extractor + builder tests | `*.test.ts` next to each modified file | add tests for: path emitted, anchor resolved, snippet non-empty per kind |
| B1 | queries expansion | `/.worktrees/feat-semantic/scripts/eval/queries.json` | from 26 → 60-80 queries (distribution: 24+ A_find, 12 B_debug, 12 C_ui, 12 E_arch, balanced across 3 projects) |
| B2 | re-run eval against fresh indexes | `/.worktrees/feat-semantic/scripts/eval/results-post-snippet-fix.md` (new) | bash script run, results table |

## Patterns to follow

### Mapper path+anchor emission

Currently mappers emit nodes like:
```ts
{ id: '...', kind: 'provider', label: 'MssqlSyncService', meta: { module: 'MssqlSyncModule' } }
```

After fix:
```ts
{
  id: '...', kind: 'provider', label: 'MssqlSyncService',
  path: '/abs/path/mssql-sync.service.ts',
  anchor: 'MssqlSyncService',  // declaration name (class for provider, method for endpoint)
  meta: { module: 'MssqlSyncModule' },
}
```

For endpoint:
```ts
{
  id: '...', kind: 'endpoint', label: 'POST /mssql-sync/agents/:id',
  path: '/abs/.../mssql-sync.controller.ts',
  anchor: 'MssqlSyncController.create',  // class.method
  meta: { method: 'POST', pattern: '/mssql-sync/agents/:id', ... }
}
```

For db-entity-field:
```ts
{
  id: '...', kind: 'db-entity-field', label: 'project-a-id_sync_agents/redirect_url',
  path: '/abs/.../project-a-id-sync-agent.entity.ts',
  anchor: 'ProjectAIdSyncAgent.redirectUrl',  // class.property
  meta: { table: 'project-a-id_sync_agents', column: 'redirect_url', ... }
}
```

The exact anchor format is flexible — but `extractSnippet` must be able to
resolve it back to a `ts-morph` declaration.

### snippet.ts kind-aware resolution

```ts
// Pseudocode
if (!node.path) return { snippet: '', reason: { kind: 'no-path-emitted', kind: node.kind } };
const sf = project.getSourceFile(node.path);
if (!sf) return { snippet: '', reason: 'file-not-found' };

switch (node.kind) {
  case 'provider': case 'service': case 'module':
    // anchor = class name → getClass(anchor)?.getText() truncated
  case 'endpoint':
    // anchor = "Controller.method" → getClass(class)?.getMethod(method)?.getText()
  case 'db-entity-field': case 'config-field': case 'scoped-marker':
    // anchor = "Class.prop" → getClass(class)?.getProperty(prop)?.getText()
  case 'fe-component': case 'fe-page':
    // try variable, function, class. For fe-component, ALSO prepend JSDoc + extract JSX text content
  case 'fe-route':
    // anchor = component name in page file
  case 'fe-hook':
    // already works; preserve
  default:
    // db-table, nats-subject, queue, etc. — no source file expected; empty is OK
}
```

### fe-component snippet — special handling

Beyond just declaration text, extract:
1. **JSDoc preceding the declaration** (`getJsDocs()`).
2. **First 400 chars of declaration text** (current behaviour).
3. **JSX text literals**: walk the function body for `JsxText` nodes and
   collect string content (limited to first ~200 chars).
4. Concatenate: `"<jsdoc>\n<declaration-head>\n<jsx-text-snippet>"`,
   capped at 800 chars total (relax SNIPPET_MAX_CHARS for fe-component
   specifically OR bump it globally to 800).

This is what unblocks queries like P9 «3 точки в чатах»
(the `truncate` CSS class + JSX text «Сообщений нет» live inside
`chat-list-item.tsx`).

## External constraints (apply to all tasks)

- **Strict tests as default AC**: each modified extractor/mapper/snippet
  function gets unit tests for happy path + ≥1 error/edge branch.
- **Recall floor**: `snippet-recall-validator` requires ≥ 85% non-empty
  snippet per kind across project-a/project-b/project-c fixtures, ≥ 95% for
  provider/endpoint/db-entity-field/config-field (those have single
  unambiguous declarations).
- **SKIPPED_NODES_CAP**: raise to `10_000` so diagnostics never silently
  truncate at the scale we now have.
- **No regression on existing semantic tests** — 856/856 must still pass.
- **Commit policy**: Conventional Commits, no Co-Authored-By, scope = arch-graph.
  All commits stay on the feature branch in their isolation worktree.
- **Branch hygiene**: each agent works in its OWN isolation worktree
  (auto-created by harness). Never `git switch develop/main`. Use
  `git -C <worktree>` for every git call. Confirm branch in report.

## Acceptance Criteria

### Track A (one acceptance bundle — all of A1–A12 must hold)

A-AC1. **Path emitted**: every provider/endpoint/db-entity-field/config-field/
       scoped-marker node has a non-undefined `path` field pointing at an
       existing `.ts` file.
A-AC2. **Anchor resolves**: for ≥ 95% of provider/endpoint/db-entity-field/
       config-field nodes, `extractSnippet` returns a non-empty snippet.
A-AC3. **fe-component coverage**: ≥ 85% of fe-component nodes return a
       non-empty snippet on project-a fixture (727 nodes).
A-AC4. **fe-component content**: spot-check 5 fe-component snippets must
       include JSDoc (if present in source) AND at least the function
       signature. Spot-check 3 components with JSX `<Typography>...</Typography>`
       text must include that text.
A-AC5. **Diagnostics fidelity**: `skippedNodesTruncated` must be `false`
       on project-a run (cap raised, all skips recorded).
A-AC6. **Existing tests**: 856/856 still pass.
A-AC7. **New tests**: unit tests for each touched mapper (path emitted) +
       snippet.ts (per-kind resolution) + recall validator.
A-AC8. **CLI smoke**: `arch-graph build && arch-graph semantic build` on
       all 3 projects completes; semantic stats report shows ≥ 85%
       non-empty snippet rate.
A-AC9. **Eval shows uplift**: after rebuilding semantic index on project-a,
       project-b, project-c, hand-grade hit rate ≥ baseline + 5% on project-a
       AND ≥ baseline + 5% on at least one other project. (Lower bar
       than baseline-doc's +25-30% — this is just the snippet fix, not
       a model change.)

### Track B

B-AC1. `queries.json` has 60–80 entries, with this distribution:
       - project-a: 30 (8 A, 6 B, 8 C, 8 E)
       - project-b: 15 (8 A, 4 C, 3 E)
       - project-c: 15 (10 A, 3 B, 2 C)
B-AC2. Each query has: `id`, `query`, `project`, `category`,
       `expectedKindIn` (union of plausible kinds), `expectedLabelHas`
       (optional), `minScore` ∈ [0.40, 0.60].
B-AC3. `scripts/eval/results-post-snippet-fix.md` contains:
       - aggregate hit rate per project / per category
       - per-query top-5 listing
       - delta vs `results-after-filter-fix.md` (the post-merge baseline)
B-AC4. No duplicate `id`. No regression in existing 26 queries' grading
       (they remain in the file with the same IDs).
B-AC5. The bash eval script (`scripts/run-baseline-eval.sh`) runs to
       completion against all three projects' fresh indexes
       (after Track A merge).

## Open questions

OQ1. Should we emit `anchor` as a structured object (`{ class, member }`)
     or as a flat string ("Class.member")? The design above uses a flat
     string for simplicity — agents should use a flat string unless they
     hit a parsing ambiguity, in which case raise it back to the user
     before changing the schema.
OQ2. For fe-route nodes (one per URL pattern), `path` should point at the
     page file. If two pages collide on the same URL pattern, take the
     first one (deterministic by path string sort).

## Task plan

| # | Track | Complexity | Model | Worktree |
|---|------|-----------|-------|----------|
| 1 | A (all of A1–A12 as one bundle) | Medium-Complex | Sonnet | isolation off feat/semantic |
| 2 | B (queries expansion + re-run eval) | Simple-Medium | Haiku then Haiku for eval-run | isolation off feat/semantic |

Track B can land in parallel with Track A's *implementation*, but Track B's
final eval re-run must happen AFTER Track A is merged into feat/semantic
(needs the fixed snippets to measure uplift).

So the actual sequence:
1. Dispatch Track A (Sonnet) and Track B-part-1 (Haiku, just expand queries.json + commit)
   in parallel.
2. When Track A returns: pr-review-toolkit on Track A, iterate, merge into
   feat/semantic.
3. When Track B-part-1 returns: merge into feat/semantic.
4. Re-run eval after both are in feat/semantic (Track B-part-2 — Haiku).
5. pr-review-toolkit final pass + Phase 8.5 advisor + Phase 9 summary.
