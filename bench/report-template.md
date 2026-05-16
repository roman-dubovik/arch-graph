# arch-graph vs graphify — head-to-head benchmark

_Generated: {{GENERATED_AT}}_

## What this measures

For each NestJS monorepo configured under `configs/`, we built **two**
knowledge graphs:

- **arch-graph** — a NestJS-specific static graph (typed nodes + edges:
  NATS subjects, BullMQ queues, TypeORM tables, DI modules/providers, HTTP
  endpoints, `lib-usage`, `ts-import`). Build is deterministic (`ts-morph`),
  no LLM calls.
- **graphify** — a generic semantic knowledge graph builder. Combines AST
  extraction (deterministic) with LLM-driven semantic subagents that surface
  cross-cutting concepts and ambiguous edges.

We then ran architecture-grade questions (defined in `bench/questions.yaml`)
through a benchmark adapter that:

1. Loads each tool's graph, **compresses it identically** (drop redundant
   `meta`, drop absolute paths, keep only `id` + `kind/file_type` + `label`
   + `source` + `target` + `relation`).
2. Serializes to compact JSON — the same format an LLM would consume as
   in-context retrieval payload.
3. Counts tokens via OpenAI's `cl100k_base` (the encoding shared by gpt-4,
   gpt-4-turbo, gpt-4o, gpt-3.5-turbo). _Token counts are the same encoding,
   the same compression aggressiveness — so the comparison is apples-to-apples._
4. Scores **precision / recall** by checking whether each question's
   `ground_truth_labels` appear as substrings of the serialized context.

### The substring-presence heuristic

We approximate "would an LLM answer correctly given this context?" by checking
whether each ground-truth label appears (case-insensitive substring) in the
serialized context. This is **deliberately permissive** — it answers "did the
tool's output even *contain* the answer". A real LLM might still get the wrong
answer from a graph that contains the right nodes, but it definitely *cannot*
answer correctly from a graph that doesn't contain them. So this is a useful
**necessary-condition** check, not a sufficient one.

- **Recall** = |GT labels found in context| / |GT labels|
- **Precision** stays at 100 % under this scheme by construction (we only
  look for the GT labels — every match is "correct"). Reported for transparency.

The interesting axis is **recall × tokens** — how much of the architectural
truth each tool delivers per token of LLM context.

## Per-project summary

{{SUMMARY_TABLE}}

## Per-question breakdown

{{PER_QUESTION_TABLE}}

## Aggregate

{{AGGREGATE}}

## When arch-graph wins

The benchmark questions are deliberately **architecture-focused**:
"who publishes / subscribes / produces / consumes / accesses / imports".
arch-graph wins on every one of these by design — it's a NestJS-specific
extractor with typed edges for exactly these relations:

- `nats-publish` / `nats-subscribe` / `nats-request` / `nats-reply`
- `queue-produce` / `queue-consume` (BullMQ)
- `db-access` (TypeORM `@InjectRepository` → `@Entity`)
- `di-import` / `di-provides` / `di-exports` / `di-controller`
- `http-call` / `http-external`
- `lib-usage`, `ts-import` (optional)

Each edge carries the **source location** (file:line) — so an LLM can cite
the answer to a specific line, which graphify's semantic edges generally
cannot, because they're inferred at the symbol level.

## When graphify wins

Graphify wins on **semantic / cross-cutting questions** the current bench
does **not** cover, e.g.:

- "Explain the auth flow" — graphify infers `conceptually_related_to` and
  `semantically_similar_to` edges across files; arch-graph has nothing to
  say there.
- "Which patterns implement resilience?" — graphify's `hyperedges` capture
  multi-node patterns (resilience = retry + circuit-breaker + redis-lock,
  observability, etc.); arch-graph has no notion of patterns.
- "What do these documents have in common?" — arch-graph is code-only;
  graphify ingests docs, papers, images.

## Build cost

- **arch-graph** — deterministic, single-process, ts-morph only. No network
  calls, no LLM. Cost: **wall time + CPU**.
- **graphify** — runs AST extraction in parallel with LLM subagents for
  semantic extraction. Cost: **wall time + LLM tokens** (sometimes thousands
  of subagent calls for a medium monorepo).

Numbers above (`arch build` column) come from `bench/.build-times.json`,
populated by `bench/run.sh`. We don't time graphify here because it must be
launched as a Claude skill, not from a script — see `bench/README.md`.

## Honesty disclaimer

This benchmark is **biased toward arch-graph** in two ways:

1. **Question selection.** We picked architecture-grade questions, which is
   arch-graph's home turf. A bench picked from `graphify-out/GRAPH_REPORT.md`'s
   "Suggested Questions" section would tilt the other way.
2. **Ground-truth derivation.** Ground truth comes from arch-graph's
   `graph.json`. If arch-graph misses something (e.g. a NATS subject defined
   via an unknown wrapper class), the bench can't know to check for it.

Still useful because: real teams using NestJS need to answer **exactly these
kinds of questions** ("who publishes X?", "who consumes Y?", "what imports Z?")
when fixing bugs, doing rollouts, or scoping changes. The bench shows what a
domain-specific tool buys you over a generic one for that workload.

## Skipped legs

{{SKIPPED_LEGS}}

To populate the graphify leg for a project, run graphify as a Claude Code
skill against the project root. The output should land at
`<project_root>/graphify-out/graph.json`. Re-run `bash bench/run.sh` afterwards.
