# Reproducing the arch-graph benchmarks

This guide explains how to run the published benchmarks yourself on any TypeScript / NestJS monorepo. The numbers in [`docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md`](../docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md) were produced this way against three private monorepos; the methodology is identical on any project.

> Two benchmarks live in this repo. **This guide covers the 103-query post-semantic bench.** The older 40-question structural-only bench is in [`bench/README.md`](README.md) and is preserved as a historical reference (see also [`bench/report.md`](report.md)).

## What this benchmark measures

For each query, did the tool's output contain enough information for an LLM to answer correctly?

- **arch-graph HIT** = top-K results contain a node satisfying `score ≥ minScore` AND `kind ∈ expectedKindIn` AND `label substring-matches expectedLabelHas`.
- **graphify HIT (lenient)** = `expectedLabelHas` substring appears anywhere in the free-text response.
- **graphify HIT (strict)** = same kind+label criterion as arch-graph, applied to the first 10 NODE lines of graphify's output (graphify does not emit per-node scores, so the `score ≥ minScore` floor is dropped — small advantage to graphify).

The lenient/strict split exists because graphify's response is a 600-1000-token BFS community expansion, not a ranked top-K list. The lenient criterion measures "is the answer somewhere in the dump?". The strict criterion measures "would an LLM looking at the top of the dump find the right node?". Strict is the honest apples-to-apples number against arch-graph's top-K.

## Prerequisites

- A clone of arch-graph: `git clone https://github.com/roman-dubovik/arch-graph.git && cd arch-graph && pnpm install`
- Node.js 20+, pnpm
- `graphify` CLI installed (for the head-to-head leg). See [`graphify`](https://github.com/Anthropic/graphify) for setup.
- A TypeScript / NestJS monorepo to point arch-graph at (your project, or three of them for parity with the published bench).
- A `<project>/graphify-out/graph.json` built per project, if you want the graphify leg.
- ~5 minutes of CPU for arch-graph build per project (small repo) to 2 minutes (large repo).

## Files involved

```
scripts/eval/
├── queries.json                                — 103 hand-curated Russian queries (real-world example)
├── queries-en.json                             — same 103 in EN keyword form (LLM-pre-translated equivalent)
├── results-2026-05-17-both-buckets.md          — published arch-graph RU results (reference)
├── results-2026-05-17-both-buckets-en.md       — published arch-graph EN results (reference)
└── ...
scripts/
└── run-baseline-eval.sh                        — eval harness
```

## Configuring project paths

The eval script supports per-project env overrides:

```bash
export PROJECT_A_DIR=/path/to/your/project-a
export PROJECT_B_DIR=/path/to/your/project-b
export PROJECT_C_DIR=/path/to/your/project-c
```

If you only have one project, set `PROJECT_A_DIR` only — the script gracefully skips missing projects.

Each project directory should be the **root** of a NestJS / TypeScript codebase that arch-graph can build (typically containing `package.json`, `tsconfig.json`, `nest-cli.json`, etc.).

## Step 1 — Build arch-graph graphs

The eval script rebuilds the arch-graph graph for each project before scoring, unless you pass `--skip-build`. First time:

```bash
PROJECT_A_DIR=/path/to/project-a \
PROJECT_B_DIR=/path/to/project-b \
PROJECT_C_DIR=/path/to/project-c \
bash scripts/run-baseline-eval.sh
```

This produces `<project>/arch-graph-out/{graph.json,validation.json,...}` per project. Subsequent runs can use `--skip-build` to reuse them.

## Step 2 — Build graphify graphs (optional, for head-to-head)

graphify is invoked from a Claude Code session, not the shell directly. From inside Claude Code:

```
/graphify build
```

Run this once per project, with the project root as the current working directory. The output lands at `<project>/graphify-out/graph.json`.

## Step 3 — Run the arch-graph eval

Default mode (`per-category`):

```bash
PROJECT_A_DIR=/path/to/project-a \
PROJECT_B_DIR=/path/to/project-b \
PROJECT_C_DIR=/path/to/project-c \
bash scripts/run-baseline-eval.sh --skip-build
```

To use the alternate query set or routing mode:

```bash
QUERIES_FILE="$(pwd)/scripts/eval/queries-en.json" \
RESULTS_FILE="$(pwd)/scripts/eval/results-my-en-run.md" \
EVAL_MODE=both-buckets \
PROJECT_A_DIR=... PROJECT_B_DIR=... PROJECT_C_DIR=... \
bash scripts/run-baseline-eval.sh --skip-build
```

### EVAL_MODE options

| Mode | Description |
|---|---|
| `per-category` (default) | Routes by category: A_find/B_debug/C_ui → `--code-only`; D_docs/E_arch → `--docs-only`; D_links → mixed |
| `both-buckets` | Always issues both `--code-only` AND `--docs-only` calls and unions the verdicts. Doubles retrieval cost but removes intent-routing risk. Used in the published headline run. |
| `fallback` | Naive two-call: tries `--code-only` first; on MISS retries `--docs-only`. Models an LLM with no intent knowledge. |
| `single` | One search call, no kind-bucket filter. Legacy baseline; doc-section dilutes code queries. |

Output: a Markdown file at `RESULTS_FILE` (default `scripts/eval/results-<date>-<mode>.md`) with per-project, per-category, and per-query verdicts (HIT/MISS) plus the top-10 results for each query.

## Step 4 — Run the graphify eval (head-to-head)

graphify does not have a parallel eval harness in this repo. For each query in `queries.json`:

```bash
cd /path/to/project-X
graphify query "<query text>" --budget 1500 > /tmp/gf-out.txt
```

To bulk-process, a minimal harness — pseudocode:

```bash
for id_query in $(jq -r '.[] | "\(.id)|\(.project)|\(.query)"' scripts/eval/queries.json); do
  id="$(echo $id_query | cut -d'|' -f1)"
  proj="$(echo $id_query | cut -d'|' -f2)"
  query="$(echo $id_query | cut -d'|' -f3-)"
  case "$proj" in
    project-a) dir=$PROJECT_A_DIR ;;
    project-b) dir=$PROJECT_B_DIR ;;
    project-c) dir=$PROJECT_C_DIR ;;
  esac
  (cd "$dir" && graphify query "$query" --budget 1500) > "/tmp/gf/$id.txt"
done
```

Then score with a Node/Python script that loads `queries.json`, reads each `/tmp/gf/<id>.txt`, applies the HIT criterion, and aggregates. See [`docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md`](../docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md) "Methodology" sections for exact scoring details.

For the **strict apples-to-apples** scoring, parse each graphify stdout into NODE-lines (regex `^NODE (.+?) \[src=(.+?) loc=(.+?) community=`), take the first 10, infer kind from `src` path heuristics (`.controller.ts` → `provider`/`endpoint`, `entities/` → `db-entity-field`/`db-table`, `.md` → `doc-section`, etc.), and apply the same kind+label check.

## What numbers should you expect?

If your project is also a NestJS monorepo with mixed RU/EN content, expect numbers in this rough ballpark (published bench, 3 monorepos × 103 queries):

| Setup | arch-graph | graphify |
|---|---|---|
| RU queries (real-world team usage) | 67% | 35% |
| EN-keyword queries (LLM-agent pipeline) | 67% | 91% lenient / 56.5% strict |

The 32-point gap on RU queries comes from arch-graph's multilingual embeddings; graphify does keyword-BFS on English code-node labels, which produces empty results for most Russian text. Under EN-keyword strict scoring, the two tools are within 3pp of each other.

## Self-build mini-bench (no external project needed)

If you don't have a target project to point this at but want to verify arch-graph works end-to-end, see [`bench/self-build/README.md`](self-build/README.md) — a 12-query benchmark that runs against arch-graph's own codebase. Anyone with a clone can reproduce it in one shell command.

## Common issues

- **`PROJECT_X_DIR` placeholder not replaced** → the eval script emits an error like `ERROR: PROJECT_A_DIR appears to be a placeholder`. Set the env var to a real path.
- **arch-graph build OOM on large repos** → pass `--max-old-space-size=8192` via NODE_OPTIONS, or use `--skip-build` after a successful rebuild.
- **graphify returns "No matching nodes found" on Russian queries** → expected behavior; graphify is keyword-BFS over English identifiers, not multilingual. This is the asymmetry documented in the comparison memo.
- **Hit-rates lower than published on your project** → likely a project-shape difference (e.g. no NATS, no TypeORM, doc-section coverage). Look at per-category numbers in the output to identify which extractor underperforms on your codebase.

## What changes between runs

- The query set and ground truth are fixed in `queries.json` — the same queries can be re-scored against newer arch-graph builds to track regression / progress.
- arch-graph's semantic embeddings are deterministic given the same model + input; expect bit-identical scores on the same graph.
- graphify's BFS traversal is also deterministic given the same graph.
- The only source of non-determinism is when the underlying source repo changes — re-running after editing project code will surface new nodes and may shift verdicts.

## Citation

If you use these benchmarks in research or comparisons, please link to the published memo at [`docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md`](../docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md) — it contains the full methodology, scoring criteria, and limitations.
