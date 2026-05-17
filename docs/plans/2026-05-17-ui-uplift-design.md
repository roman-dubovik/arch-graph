# UI uplift design (C_ui recall)

## Goal

Lift C_ui hit-rate (currently 33% platform / 33% insyra / 50% beribuy2) by
making fe-component nodes more matchable for UI/visual queries like
«выровнять колонку по правому краю», «обрезать сообщение в 3 точки»,
«кнопка применить».

## Root causes (from earlier analysis)

1. **fe-component labels are class-name-only**, e.g. `KanbanColumnHeader` —
   embedder has nothing visual to match against.
2. **CSS / Tailwind classes are NOT indexed**. `text-right`, `truncate`,
   `justify-end` are exact lexical signals lost today.
3. **i18n user-facing strings are NOT indexed**. A query «кнопка применить»
   should match a component whose i18n value is "Применить" even when the
   class name is `SubmitChangesButton`.

## Two-task split

### Task A — Snippet extension

Extend `extractFeComponentSnippet()` in `src/semantic/snippet.ts` to
include:
- The full JSX body (text content + attribute strings) within the
  per-snippet char budget.
- All `className="..."` literal strings concatenated as a separate token
  block prefixed with `classes:`.

The snippet is used both for caller-visible preview AND for
`buildEmbedText` input. Richer snippet = richer embedding text, no extra
metadata plumbing needed.

### Task B — i18n extraction → embed-text

New extraction surface in fe-extractor:
1. Detect i18n library in use (next-intl / react-i18next / next-translate /
   custom — check imports).
2. Walk JSX for `t('key')` / `useTranslation().t('key')` etc.
3. Resolve each key against the project's message file (typically
   `messages/ru.json` or `locales/ru/translation.json`) — pick Russian
   locale first, fall back to English.
4. Attach resolved strings to `FeComponent.i18nStrings: string[]`.
5. Propagate to `GraphNode.meta.i18nStrings` via `fe-to-graph.ts`.
6. In `buildEmbedText`, append these strings to the embedding text
   (NOT to snippet — keep snippet as visual code preview).

i18n is project-aware: each project may use a different library/format.
The extractor should detect library by import, gracefully skip if no
recognised i18n library is imported (no-op).

## File-touch matrix

| Task | Files modified | Risk |
|------|---------------|------|
| **A** | `src/semantic/snippet.ts` (extractFeComponentSnippet) | Low. Pure extension; cap at FE_SNIPPET_MAX_CHARS=800. |
| **A** | `src/semantic/snippet.test.ts` (new tests) | None — additive. |
| **B** | `src/extractors/fe/types.ts` (FeComponent.i18nStrings field) | Low. |
| **B** | `src/extractors/fe/extractor.ts` (i18n call detection) | Medium — new code path. |
| **B** | `src/extractors/fe/i18n-resolver.ts` (new file) | Self-contained. |
| **B** | `src/mapper/fe-to-graph.ts` (propagate i18nStrings to GraphNode meta) | Low — pass-through. |
| **B** | `src/semantic/builder.ts` (extend buildEmbedText for fe-component) | Medium — touches embed-text composition. |
| **B** | `src/extractors/fe/i18n-resolver.test.ts` + extractor.test.ts | None — additive. |

**Zero file overlap** between A and B. Both can run in isolated worktrees
in parallel. Merge order: any, since changes are disjoint.

## Acceptance criteria

### Task A
- AC-A1: A fe-component containing `<th className="text-right">` produces
  a snippet containing the substring `text-right`.
- AC-A2: A fe-component containing `<span className="truncate">…</span>`
  produces a snippet containing `truncate`.
- AC-A3: Snippet total length ≤ FE_SNIPPET_MAX_CHARS (800).
- AC-A4: When JSX body exceeds remaining budget, truncate gracefully —
  no half-attribute or half-class-string output.
- AC-A5: Existing fe-component snippet tests still pass.
- AC-A6: Tests for the new behavior added in same commit; cover all 4
  above and at least one edge (JSX with no classNames, JSX with templated
  className expression).

### Task B
- AC-B1: Given a fe-component using `next-intl` with `useTranslations()` +
  `t('common.apply')`, the extractor resolves 'common.apply' against a
  fixture `messages/ru.json` and `FeComponent.i18nStrings` includes
  "Применить".
- AC-B2: Works also for `react-i18next` pattern (`useTranslation()`).
- AC-B3: When no i18n library detected — silently no-op (empty array,
  no error).
- AC-B4: When key cannot be resolved (missing in message file) — silently
  skip that key, log to diagnostics.
- AC-B5: `GraphNode.meta.i18nStrings` flows through `fe-to-graph.ts`.
- AC-B6: `buildEmbedText` for fe-component appends the resolved strings
  (joined by spaces) to the embedding text — visible in the embeddings.jsonl
  output text field.
- AC-B7: Tests cover at least 4 paths: next-intl resolved, react-i18next
  resolved, library absent (no-op), key missing (graceful skip).

## Test verification post-merge

Both tasks land → `pnpm exec vitest run` should be 1059 + new tests passing.
Then re-run `arch-graph semantic build` on platform (the biggest C_ui pain
point), re-run eval with `EVAL_MODE=both-buckets`. Expected:
- platform C_ui: 33% → ~50-55% (combined Task A + Task B uplift)
- insyra C_ui:   33% → ~50-55%
- Other categories unchanged (these are fe-component-only changes).

## Out of scope

- BGE-M3 migration (separate larger task).
- Hybrid BM25 retrieval (separate, follows BGE-M3).
- beribuy2-specific extractor (separate, awaiting agent diagnosis).
- Updating tool descriptions (not needed — the change is transparent to
  agent-side callers; only retrieval quality improves).
