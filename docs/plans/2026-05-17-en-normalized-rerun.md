# EN-Normalized Re-run — Methodology Refinement

**Date:** 2026-05-17
**Context:** The 103-query head-to-head benchmark (`docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md`) compared arch-graph and graphify on raw Russian queries. In production, LLM agents typically reformulate user questions into English keywords before invoking retrieval — making the direct RU comparison potentially unfair to graphify (which does keyword-BFS over English code-node labels).

## Goal

Re-run **both** tools on EN-normalized (keyword-only) versions of the same 103 queries. Measure whether arch-graph's lead persists when the language asymmetry is removed. Expected outcome: arch-graph's lead shrinks but does not vanish; the residual gap is the "real" retrieval-quality delta independent of multilingual handling.

## Approach

1. **Translation**: Convert each `query` field in `scripts/eval/queries.json` to keyword-only EN form. 2-4 keywords max, no articles/verbs, preserve technical terms (NATS, BullMQ, TypeORM, NestJS guards). Output: `scripts/eval/queries-en.json`. Same schema as the RU version — only `query` changes; `id`, `project`, `category`, `expectedKindIn`, `expectedLabelHas`, `minScore` unchanged.
2. **arch-graph re-run**: Run the same `scripts/eval/run-baseline-eval.sh` style harness against `queries-en.json`. Mode: `both-buckets`, k=10. Output: `scripts/eval/results-2026-05-17-en.md`.
3. **graphify re-run**: For each EN query, run `graphify query "<en query>" --budget 1500` from the corresponding project root. Capture stdout. HIT = response text contains any string from `expectedLabelHas` (case-insensitive). For empty `expectedLabelHas`, HIT = non-empty response with node content. Output: `/tmp/graphify-en-responses.jsonl` + summary.
4. **Memo update**: Add two sections to `docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md`:
   - **Methodology Caveat: Query Language** — explain the asymmetry, why we re-ran.
   - **Section X: EN-Normalized Re-run** — table comparing RU vs EN numbers side by side, per project and per category. Identify queries where graphify gained ground.
5. **Verdict update**: Adjust `docs/comparisons/graphify-vs-arch-graph.md` verdict with one paragraph framing the EN result.

## Translation rules (locked)

- **Strip RU entirely.** No transliteration, no mixed RU/EN.
- **Keyword-only.** "ручки СРМ получение расписания" → "CRM endpoint schedule". Not "find CRM endpoint that returns schedule".
- **Preserve project-specific identifiers** when they appear in the RU query as Latin text (e.g. "MSSQL", "mini-app", "redirect_url" stay as-is).
- **Domain terms**: use the natural English equivalent that would appear in code: "запись" → "appointment" (since `Appointment` is in expected labels), "филиал" → "branch", "тенант" → "tenant", "карта" → "map" or "card" depending on context (use `expectedLabelHas` as a hint, but do not leak ground truth into the query: never include a `expectedLabelHas` string verbatim).
- **Disambiguation hints**: if the RU query is ambiguous out of context, include 1 disambiguating noun. "карты в напоминаниях" → "map reminder" (not just "map").
- **Cap**: 2-4 keywords. If the RU query is one phrase, use 2-3 words. If it's a compound question, use up to 4.

## Scoring methodology (unchanged from prior run)

- HIT = top-K contains a result satisfying `score ≥ minScore` AND `kind in expectedKindIn` AND any string in `expectedLabelHas` substring-matches the result label.
- For graphify: HIT = response stdout contains any `expectedLabelHas` string (case-insensitive); empty `expectedLabelHas` → HIT = non-empty meaningful response.
- Token measurement: arch-graph = 1000 tokens/query (fixed estimate from prior run); graphify = `len(stdout) / 4`.

## Acceptance criteria

- `scripts/eval/queries-en.json` exists, 103 entries, schema-identical to `queries.json` except `query` field.
- `scripts/eval/results-2026-05-17-en.md` exists with per-project + per-category + overall hit-rates for arch-graph.
- `/tmp/graphify-en-responses.jsonl` exists, 103 lines, one per query, each line: `{"id", "project", "query", "response", "hit", "tokens"}`.
- `docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md` updated with Methodology Caveat + EN-Normalized Re-run sections.
- `docs/comparisons/graphify-vs-arch-graph.md` verdict updated.
- Existing RU bench results stay untouched (no rewrites).

## Out of scope

- Re-running arch-graph in `fallback` mode (we only test `both-buckets` to keep parity with the existing bench).
- Translating expected labels — they are already English.
- Running on additional projects beyond the existing 3.
- Re-running fix/embedder improvements based on findings — this is measurement-only.

## Project paths

- project-a: `<project-a-root>`
- project-b: `<project-b-root>`
- project-c: `<project-c-root>`

(These are the real local paths; in the public docs the projects are anonymized.)

## Prior artifacts to reference (NOT modify)

- `scripts/eval/queries.json` — source of RU queries.
- `scripts/eval/results-2026-05-17-both-buckets-final.md` — RU bench, arch-graph side.
- `docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md` — RU bench, head-to-head.
- `/tmp/graphify-eval-responses.jsonl` — RU bench, graphify raw responses.
