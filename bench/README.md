# bench — arch-graph vs graphify

Head-to-head benchmark: for the same NestJS monorepo + the same architecture
questions, **how many LLM tokens does each tool need to deliver the answer?**

## Layout

```
bench/
├── questions.yaml          — 15 architecture-grade questions + ground truth
├── adapters/
│   ├── arch-graph.ts       — load + compact arch-graph's graph.json
│   └── graphify.ts         — load + compact graphify's graph.json
├── tokens.ts               — tiktoken (cl100k_base) wrapper
├── bench.ts                — main runner
├── run.sh                  — orchestrator (rebuild arch-graph + run bench)
├── report-template.md      — Mustache-ish template, filled by bench.ts
├── report.md               — generated output (git-ignored; see below)
└── README.md               — this file
```

`.build-times.json` is written by `run.sh` and consumed by `bench.ts` so
that arch-graph build time appears in the report.

## Quick start

```bash
# from the worktree root
bash bench/run.sh
open bench/report.md   # macOS only; on Linux: xdg-open
```

`run.sh`:

1. Verifies `tsx` and the tiktoken/yaml dev-deps are installed (`npm install`
   if not).
2. Rebuilds each project's `arch-graph build` to `/tmp/sg-<project>/`,
   timing the wall clock per project (skip if `--skip-arch` is passed and
   the output already exists). Times are written to `bench/.build-times.json`.
3. Checks whether each project has a `graphify-out/graph.json`. If missing,
   it's logged and the graphify leg is skipped for that project — the
   arch-graph leg still runs.
4. Runs `npx tsx bench/bench.ts`. This loads questions, builds the LLM
   context per project, counts tokens, scores precision/recall, and writes
   `bench/report.md`.

## Populating the graphify leg

`graphify` is a Claude Code skill, **not** a one-shot CLI — building a graph
requires dispatching general-purpose subagents from a Claude session
(see `~/.claude/skills/graphify/SKILL.md`). For that reason `run.sh` cannot
invoke it. To produce a graphify graph for a project, run graphify as a
Claude Code skill against the project root.

The graph lands at `<project_root>/graphify-out/graph.json`. The bench
adapter (`adapters/graphify.ts`) picks it up automatically from either
`<project_root>/graphify-out/` or `bench/cache/<project>/graphify-out/`.

## How tokens are counted

We use OpenAI's `cl100k_base` encoding (gpt-4 / gpt-4-turbo / gpt-4o /
gpt-3.5-turbo all share it). We `encode_ordinary()` — no special tokens, no
chat template overhead — and report the raw count.

**Both adapters apply identical compression** before serializing:

- node = `{id, k=kind, label?}` (label dropped when redundant with id)
- edge = `{f=source, t=target, k=relation, at?=basename:line}`
- nothing else

Then serialized as one block: `"# <name> context\n<schema>\n\n<JSON>"`.

If you change one adapter's compression aggressiveness, change the other's
to match — otherwise the comparison is meaningless.

## How quality is scored

For each question we check whether each `ground_truth_labels` entry appears
(case-insensitive substring) in the serialized context. This is a necessary
condition, not a sufficient one — see the `report.md` `Heuristic` section.

Two consequences:

- A tool that contains *just the label string but no useful structure* would
  appear to "win" on this metric. We rule this out by also reporting context
  size in tokens: a tool that achieves recall by bloat is visible in the
  tokens column.
- A tool's IDs don't matter — `service:my-api` (arch-graph) and
  `apps_my_api` (graphify) both pass the label check for the label
  `my-api`. This is why questions store `ground_truth_labels`
  separately from `ground_truth_ids`.

## Adding a new question

```yaml
- id: q16
  project: my-project           # must match an `id` in configs/<id>.config.ts
  category: nats
  difficulty: easy
  question: "Which service publishes 'foo.bar'?"
  ground_truth_ids:
    - service:my-api
  ground_truth_labels:
    - my-api
    - foo.bar
```

Verify ground truth by inspecting the arch-graph graph:

```bash
python3 -c "
import json
g = json.load(open('/tmp/sg-my-project/graph.json'))
print([(e['from'], e['kind'], e['to']) for e in g['edges']
       if e['kind'] in ('nats-publish','nats-request')
       and e['to'] == 'nats:foo.bar'])
"
```

## Known limitations

- Build-time for graphify is not measured by this bench (it's a Claude skill,
  not a CLI — wall time isn't directly comparable to ts-morph anyway).
- The bench currently feeds **the whole compact graph** as context. A future
  iteration could implement a per-question retrieval strategy (subgraph
  pruning) for each tool and re-measure.
- The recall heuristic is permissive. It does not catch cases where the
  label appears for the *wrong* reason (e.g. the same string is mentioned
  somewhere unrelated). A small N (15 questions) makes this acceptable for
  reporting trends, but not for production scoring.
