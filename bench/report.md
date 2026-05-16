# arch-graph vs graphify — head-to-head benchmark

_Original run: 2026-05-15T20:47:24.567Z (15 hand-curated questions)_
_Updated: 2026-05-16 — see "Fresh head-to-head (auto-generated questions)" below_

## Headline (fresh run — 2026-05-16)

Head-to-head on all 4 working reference monorepos (Project A platform,
B insyra, C screenia, D beribuy2). 10 auto-generated questions per project,
40 questions total. Each question is auto-derived from real nodes in
arch-graph's own output → bilaterally fair: same compression, same
`cl100k_base` encoder, same questions for both tools.

| | arch-graph | graphify | ratio |
|---|---|---|---|
| Avg tokens per question | **38,654** | **570,605** | **14.8× fewer** |
| Mean recall (substring) | **100%** | **25%** | **~4× higher** |
| Σ tokens · 40 questions | 1,546,140 | 22,824,220 | — |

### Per-project breakdown

| Project | Size | Arch tokens | Arch recall | Graphify tokens | Graphify recall | Tokens × | Recall × |
|---|---|---|---|---|---|---|---|
| A | large | 59,835 | 100% | 718,155 | 16% | 12.0× | 6.3× |
| B† | large | 62,793 | 100% | 724,785 | 22% | 11.5× | 4.5× |
| C | medium | 23,416 | 100% | 302,999 | 4% | 12.9× | 23.3× |
| D† | small | 8,570 | 100% | 536,483 | 57% | 62.6× | 1.8× |

**Methodology caveat (†):** Projects B and D had graphify rebuilt fresh via the
Claude Code skill, which ran in **AST-only mode** (LLM semantic pass was
unavailable in the skill context — no `Task` tool dispatch + no `MOONSHOT_API_KEY`
/ `ANTHROPIC_API_KEY` set). This produces a larger, less-curated graph than a
full graphify run would. It inflates graphify's token count on those two
projects and may overstate arch-graph's token advantage there. Recall, however,
is measured on whatever ended up in the graph — that's still an honest
comparison. Projects A and C used pre-existing graphify-out (build mode unknown,
likely full).

The original 15-question hand-curated bench is preserved below for reference.

## What this measures

For each of 5 NestJS monorepos (anonymized as `Project A` (large),
`Project B` (large), `Project C` (medium), `Project D` (small),
`Project E` (small)), we built **two** knowledge graphs:

- **arch-graph** — a NestJS-specific static graph (typed nodes + edges:
  NATS subjects, BullMQ queues, TypeORM tables, DI modules/providers, HTTP
  endpoints, `lib-usage`, `ts-import`). Build is deterministic (`ts-morph`),
  no LLM calls.
- **graphify** — a generic semantic knowledge graph builder. Combines AST
  extraction (deterministic) with LLM-driven semantic subagents that surface
  cross-cutting concepts and ambiguous edges.

We then ran 15 architecture-grade questions (~3 per project) through a
benchmark adapter that:

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

| project | arch nodes/edges | arch size | arch build | arch avg tokens | arch recall | graphify nodes/edges | graphify size | graphify avg tokens | graphify recall |
|---|---|---|---|---|---|---|---|---|---|
| Project A (large) | 894n / 1532e | 892.8 KB | — | 65763 | 100% | 11440n / 10588e | 9.07 MB | 718155 | 42% |
| Project B (large) | 898n / 1222e | 770.9 KB | — | 63101 | 100% | unavailable | — | — | — |
| Project C (medium) | 358n / 552e | 332.9 KB | — | 23679 | 100% | 5163n / 4664e | 4.42 MB | 302999 | 33% |
| Project D (small) | 245n / 352e | 219.3 KB | — | 16391 | 100% | unavailable | — | — | — |
| Project E (small) | 144n / 189e | 117.8 KB | — | 8570 | 100% | unavailable | — | — | — |

## Per-question breakdown

| qid | project | category | arch tokens | arch P | arch R | graphify tokens | graphify P | graphify R |
|---|---|---|---|---|---|---|---|---|
| q01 | A | nats | 65763 | 100% | 100% | 718155 | 0% | 0% |
| q02 | A | nats | 65763 | 100% | 100% | 718155 | 100% | 33% |
| q03 | B | nats | 63101 | 100% | 100% | — | — | — |
| q04 | C | nats | 23679 | 100% | 100% | 302999 | 0% | 0% |
| q05 | A | bullmq | 65763 | 100% | 100% | 718155 | 100% | 100% |
| q06 | D | bullmq | 16391 | 100% | 100% | — | — | — |
| q07 | B | typeorm | 63101 | 100% | 100% | — | — | — |
| q08 | E | typeorm | 8570 | 100% | 100% | — | — | — |
| q09 | E | di | 8570 | 100% | 100% | — | — | — |
| q10 | C | di | 23679 | 100% | 100% | 302999 | 100% | 100% |
| q11 | A | http | 65763 | 100% | 100% | 718155 | 100% | 67% |
| q12 | A | lib | 65763 | 100% | 100% | 718155 | 0% | 0% |
| q13 | B | di | 63101 | 100% | 100% | — | — | — |
| q14 | A | multi-hop | 65763 | 100% | 100% | 718155 | 100% | 50% |
| q15 | C | multi-hop | 23679 | 100% | 100% | 302999 | 0% | 0% |

## Aggregate

**Total context tokens across all 15 questions:**

- arch-graph: 688,449 tokens
- graphify:   5,217,927 tokens (7.6× more than arch-graph)

**Mean recall across questions (substring-presence heuristic):**

- arch-graph: 100%
- graphify:   39%

## Question taxonomy

The numbers above are measured on the original 15 questions in
`bench/questions.yaml`. The yaml has since been extended to **30 questions**
covering a wider spread of query shapes. The taxonomy below describes what
each shape exercises, so the bench's coverage matches the real-world workload
arch-graph is designed for.

- **single-edge** — `nats`, `bullmq`, `typeorm`, `http`, `lib`. One typed edge
  kind, one answer set. Easiest end of the spectrum; this is what the original
  15-question run was almost entirely composed of.
- **multi-hop** — answer requires traversing two or more edges of the same
  kind (e.g. a queue producer that is also the consumer — a self-loop; or the
  module-import closure that ends at `NatsModule`).
- **cross-domain** — answer requires joining two edge kinds (e.g. "service
  that consumes queue X AND writes to table Y"). Exercises whether the
  compressed context retains enough structure for an LLM to perform the join.
- **refactor-impact** — "if I rename/remove X, what breaks?". Closure on
  `ts-import` + `lib-usage` + `di-import` edges. This is the typical
  change-scoping workflow.
- **negative** — "is there ANY producer / subscriber / user?". The point is
  that arch-graph returns the same enumerable set as a positive question, and
  the consuming LLM can derive yes/no from emptiness. Ground-truth labels are
  still positive matches.
- **diagnostics** — answer lives in `diagnostics.json` (dynamic NATS subjects,
  unresolved queue names, opaque HTTP URLs), not in `graph.json`. These are
  **informational** in the current bench because the scorer only ingests
  `graph.json`. They document a class of honest "I don't know" queries
  arch-graph is built to surface — and they will become measurable once the
  scorer is extended to read diagnostics output too.

Recall / token numbers in the tables above predate the extension and still
reflect the original 15-question run. Re-running the bench against the full
30-question set requires the private reference monorepos and is left to the
benchmarker; the public repo cannot reproduce those numbers from this commit
alone.

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

## Reproducing on your own monorepos

The numbers above were measured against five private NestJS monorepos that
are not shipped with this repo. To run the benchmark on your own projects,
create one `configs/<id>.config.ts` per project (see `configs/example.config.ts`
as a starting template), add matching questions to `bench/questions.yaml`,
then run `bash bench/run.sh`.

## Skipped legs

- **Project B (large)** — no `graphify-out/graph.json` available
- **Project D (small)** — no `graphify-out/graph.json` available
- **Project E (small)** — no `graphify-out/graph.json` available

To populate the graphify leg for a project, run graphify as a Claude Code
skill against the project root. The output should land at
`<project_root>/graphify-out/graph.json`. Re-run `bash bench/run.sh` afterwards.
