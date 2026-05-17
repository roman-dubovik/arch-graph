#!/usr/bin/env bash
# scripts/run-baseline-eval.sh
# Baseline evaluation script for arch-graph semantic search.
#
# Runs the 26-query suite against project-a / project-b / project-c,
# compares per-category hit-rates to documented expectations, and
# prints a Markdown results table.
#
# Usage:
#   bash scripts/run-baseline-eval.sh [--skip-build]
#
# Flags:
#   --skip-build  Skip graph + semantic rebuild (re-use existing index).
#
# Environment overrides:
#   SKIP_BUILD=1            Same as --skip-build (env var form).
#   EVAL_K=10               Number of top results to inspect (default: 10).
#   EVAL_MODE=per-category  Search routing strategy. One of:
#     single        — single search call, no kind-bucket filter (legacy
#                     baseline; doc-section dilutes code queries).
#     per-category  — route by category:
#                       A_find/B_debug/C_ui → --code-only
#                       D_docs/E_arch       → --docs-only
#                       D_links             → no filter (mixed by design)
#                     Models an LLM that knows query intent and routes
#                     correctly. Default.
#     fallback      — naive two-call: always try --code-only first; if MISS,
#                     retry --docs-only. Models an LLM with no intent
#                     knowledge that just tries both buckets.
#     both-buckets  — ALWAYS issue both --code-only AND --docs-only calls
#                     and union the verdicts. Models an LLM that runs both
#                     searches unconditionally and inspects two separately
#                     labeled top-K lists. Doubles retrieval cost but
#                     removes any intent-routing risk.
#   QUERIES_FILE=...        Path to a queries JSON file (default:
#                           $SCRIPT_DIR/eval/queries.json). Useful for
#                           running alternate query suites — e.g. the
#                           EN-normalized re-run uses queries-en.json.
#   RESULTS_FILE=...        Path to write the Markdown results table
#                           (default: $SCRIPT_DIR/eval/results-${DATE}-${EVAL_MODE}.md).
#                           Override when running multiple variants on
#                           the same day to avoid clobbering output.
#   PROJECT_A_DIR=...       Override path to project-a checkout.
#   PROJECT_B_DIR=...       Override path to project-b checkout.
#   PROJECT_C_DIR=...       Override path to project-c checkout.
#
# Exit code:
#   0 — all projects meet their expected threshold
#   1 — one or more projects below threshold (or fatal setup error)

set -uo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
QUERIES_FILE="${QUERIES_FILE:-$SCRIPT_DIR/eval/queries.json}"
CLI="$WORKTREE_DIR/src/cli/index.ts"
K="${EVAL_K:-10}"
EVAL_MODE="${EVAL_MODE:-per-category}"
case "$EVAL_MODE" in
  single|per-category|fallback|both-buckets) ;;
  *) echo "ERROR: invalid EVAL_MODE='$EVAL_MODE'. Use single|per-category|fallback|both-buckets." >&2; exit 1 ;;
esac
DATE="$(date +%Y-%m-%d)"
RESULTS_FILE="${RESULTS_FILE:-$SCRIPT_DIR/eval/results-${DATE}-${EVAL_MODE}.md}"
SKIP_BUILD="${SKIP_BUILD:-0}"

# Project paths — replace these with your local checkout locations OR set them
# as env vars before running (recommended so you don't have to edit the script).
# Example: PROJECT_A_DIR=/home/you/projects/project-a bash scripts/run-baseline-eval.sh
PROJECT_A_DIR="${PROJECT_A_DIR:-/REPLACE-WITH/path/to/project-a}"
PROJECT_B_DIR="${PROJECT_B_DIR:-/REPLACE-WITH/path/to/project-b}"
PROJECT_C_DIR="${PROJECT_C_DIR:-/REPLACE-WITH/path/to/project-c}"

# Fail loudly if the user forgot to override the placeholders — saves debugging
# a confusing "directory not found" or empty-results scenario.
for _p_var in PROJECT_A_DIR PROJECT_B_DIR PROJECT_C_DIR; do
  _p_val="${!_p_var}"
  if [[ "$_p_val" == /REPLACE-WITH/* ]]; then
    echo "ERROR: $_p_var is still the placeholder ($_p_val). " >&2
    echo "       Edit scripts/run-baseline-eval.sh OR set $_p_var=/your/local/path before running." >&2
    exit 1
  fi
  if [[ ! -d "$_p_val" ]]; then
    echo "ERROR: $_p_var points at $_p_val which doesn't exist." >&2
    exit 1
  fi
done
unset _p_var _p_val

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------
log() { echo "[eval] $*" >&2; }
warn() { echo "[eval] WARN: $*" >&2; }

# Require jq
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required but not found. Install with: brew install jq" >&2
  exit 1
fi

# Require tsx
TSX_BIN="$WORKTREE_DIR/node_modules/.bin/tsx"
if [[ ! -x "$TSX_BIN" ]]; then
  echo "ERROR: tsx not found at $TSX_BIN. Run 'npm install' in the worktree." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Build phase
# ---------------------------------------------------------------------------
build_project() {
  local proj_name="$1"
  local project_dir="$2"

  if [[ "$SKIP_BUILD" == "1" ]]; then
    log "[$proj_name] SKIP_BUILD=1 — skipping graph + semantic build"
    return 0
  fi

  log "[$proj_name] Building graph at $project_dir ..."
  if ! (cd "$project_dir" && "$TSX_BIN" "$CLI" build 2>&1); then
    warn "[$proj_name] graph build failed"
    return 1
  fi

  log "[$proj_name] Building semantic sidecar ..."
  if ! (cd "$project_dir" && "$TSX_BIN" "$CLI" semantic build 2>&1); then
    warn "[$proj_name] semantic build failed"
    return 1
  fi

  return 0
}

# ---------------------------------------------------------------------------
# Temporary directory for per-query results
# ---------------------------------------------------------------------------
TMPDIR_RESULTS="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_RESULTS"' EXIT

# ---------------------------------------------------------------------------
# Per-query helpers
# ---------------------------------------------------------------------------

# Map a query category to the kind-bucket CLI flag for per-category mode.
# Echoes "--code-only", "--docs-only", or "" (no filter).
#
# Fails loudly on unknown categories — otherwise adding a new category to
# queries.json would silently fall through to "no filter" and corrupt the
# per-category metric without any visible signal.
route_filter_flag() {
  local cat="$1"
  case "$cat" in
    A_find|B_debug|C_ui) echo "--code-only" ;;
    D_docs|E_arch)       echo "--docs-only" ;;
    D_links)             echo "" ;;
    "")
      echo "[eval] ERROR: route_filter_flag called with empty category" >&2
      exit 1
      ;;
    *)
      echo "[eval] ERROR: route_filter_flag: unknown category '$cat'. " \
           "Update queries.json or extend the case statement in run-baseline-eval.sh." >&2
      exit 1
      ;;
  esac
}

# Run one search call, evaluate the result, and echo the verdict ("HIT",
# "MISS", or "ERROR") to stdout. Stores raw CLI JSON in
# $TMPDIR_RESULTS/_last.json so build_top_summary can render it afterward.
#
# Distinguishes three CLI outcomes:
#   exit 0  — results returned; judge HIT/MISS by score+kind+label filters
#   exit 4  — index OK, but no results passed the filter — judge MISS
#   exit 1+ — hard failure (missing/corrupt index, embed error). Stderr is
#             surfaced via warn() and the verdict is "ERROR" so the operator
#             can distinguish infrastructure problems from genuine misses.
#
# Args: qid, project_dir, query, min_score, kinds_csv, labels_csv, filter_flag
search_and_judge() {
  local qid="$1" project_dir="$2" query="$3" min_score="$4" kinds_csv="$5" labels_csv="$6"
  local filter_flag="$7"

  local cli_stderr cli_exit json_output verdict result_count
  cli_stderr=$(mktemp)
  if [[ -n "$filter_flag" ]]; then
    json_output=$(cd "$project_dir" && "$TSX_BIN" "$CLI" semantic search "$query" --k "$K" "$filter_flag" --json 2>"$cli_stderr")
  else
    json_output=$(cd "$project_dir" && "$TSX_BIN" "$CLI" semantic search "$query" --k "$K" --json 2>"$cli_stderr")
  fi
  cli_exit=$?
  # Surface stderr unless every line matches a known-harmless banner.
  # Inverted (denylist) instead of error-keyword-allowlist: a keyword list
  # would silently drop real diagnostics that use different vocabulary
  # ("timed out", "ECONNREFUSED", "ENOENT", "stale index", etc).
  if [[ -s "$cli_stderr" ]]; then
    # If the CLI failed at the exit-code level, always surface stderr.
    # Otherwise check if ANY non-banner line is present.
    if [[ "$cli_exit" != "0" && "$cli_exit" != "4" ]]; then
      warn "[$qid] CLI stderr: $(tr '\n' ' ' < "$cli_stderr")"
    elif grep -qvE '^\[arch-graph semantic\] (Loading model|Downloading|Fetching|Using cached)' "$cli_stderr"; then
      warn "[$qid] CLI stderr: $(tr '\n' ' ' < "$cli_stderr")"
    fi
  fi
  rm -f "$cli_stderr"

  echo "$json_output" > "$TMPDIR_RESULTS/_last.json"

  # Hard CLI failure — do NOT count as a recall miss.
  if [[ "$cli_exit" != "0" && "$cli_exit" != "4" ]]; then
    warn "[$qid] CLI exit=$cli_exit (treating as ERROR, not MISS)"
    echo "ERROR"
    return
  fi

  # Validate the JSON envelope once, up front. If parse fails, that is also
  # an infrastructure problem (stale tsx cache, unexpected stdout banner),
  # not a recall miss.
  if ! jq empty "$TMPDIR_RESULTS/_last.json" 2>/dev/null; then
    warn "[$qid] CLI output is not valid JSON; treating as ERROR"
    echo "ERROR"
    return
  fi

  verdict="MISS"
  result_count=$(jq '(.results // []) | length' "$TMPDIR_RESULTS/_last.json")

  local i
  for (( i=0; i<result_count; i++ )); do
    local score kind label
    score=$(jq -r ".results[$i].score" "$TMPDIR_RESULTS/_last.json")
    kind=$(jq -r ".results[$i].kind" "$TMPDIR_RESULTS/_last.json")
    label=$(jq -r ".results[$i].label" "$TMPDIR_RESULTS/_last.json")

    local score_ok
    score_ok=$(awk -v s="$score" -v m="$min_score" 'BEGIN { print (s+0 >= m+0) ? "1" : "0" }')
    [[ "$score_ok" != "1" ]] && continue

    local kind_ok=1
    if [[ -n "$kinds_csv" ]]; then
      kind_ok=0
      local k
      IFS=',' read -ra kind_arr <<< "$kinds_csv"
      for k in "${kind_arr[@]}"; do
        [[ "$kind" == "$k" ]] && kind_ok=1 && break
      done
    fi
    [[ "$kind_ok" != "1" ]] && continue

    local label_ok=1
    if [[ -n "$labels_csv" ]]; then
      label_ok=0
      local label_lower tok t
      label_lower="$(echo "$label" | tr '[:upper:]' '[:lower:]')"
      IFS=',' read -ra label_arr <<< "$labels_csv"
      for tok in "${label_arr[@]}"; do
        t="$(echo "$tok" | tr '[:upper:]' '[:lower:]')"
        if [[ "$label_lower" == *"$t"* ]]; then
          label_ok=1
          break
        fi
      done
    fi
    [[ "$label_ok" != "1" ]] && continue

    verdict="HIT"
    break
  done

  echo "$verdict"
}

# Render the top-K summary line from $TMPDIR_RESULTS/_last.json.
build_top_summary() {
  jq -r '
    if .error then
      "ERROR: \(.error)"
    elif ((.results // []) | length) == 0 then
      "no results"
    else
      [.results[] | "\(.score | . * 1000 | round / 1000) \(.kind):\(.label)"] | join(" | ")
    end
  ' "$TMPDIR_RESULTS/_last.json" 2>/dev/null || echo "parse error"
}

# ---------------------------------------------------------------------------
# Per-query orchestrator — dispatches according to $EVAL_MODE.
# Writes: $TMPDIR_RESULTS/<qid>.result — "HIT" or "MISS"
#         $TMPDIR_RESULTS/<qid>.top5   — one-line top-K summary
#         $TMPDIR_RESULTS/<qid>.mode   — one of:
#           "code"|"docs"|"both"   (per-category)
#           "single"               (single)
#           "code"|"fallback-docs"|"fallback-miss"   (fallback)
#           "both-buckets"|"both-buckets(code-errored)"|
#             "both-buckets(docs-errored)"|"both-buckets(partial-errored)"   (both-buckets)
#         All error-indicating mode tags share the "errored" substring so a
#         single grep matches them all in aggregate_count.
# ---------------------------------------------------------------------------
run_query() {
  local proj_name="$1"
  local project_dir="$2"
  local qid="$3"

  local query min_score kinds_csv labels_csv cat
  query=$(jq -r --arg id "$qid" '.[] | select(.id == $id) | .query' "$QUERIES_FILE")
  min_score=$(jq -r --arg id "$qid" '.[] | select(.id == $id) | .minScore' "$QUERIES_FILE")
  kinds_csv=$(jq -r --arg id "$qid" '
    .[] | select(.id == $id) |
    ((.expectedTopKindIn // .expectedKindIn) // []) | join(",")
  ' "$QUERIES_FILE")
  labels_csv=$(jq -r --arg id "$qid" '
    .[] | select(.id == $id) |
    (.expectedLabelHas // []) | join(",")
  ' "$QUERIES_FILE")
  cat=$(jq -r --arg id "$qid" '.[] | select(.id == $id) | .category' "$QUERIES_FILE")

  local verdict mode_tag top5
  case "$EVAL_MODE" in
    single)
      verdict=$(search_and_judge "$qid" "$project_dir" "$query" "$min_score" "$kinds_csv" "$labels_csv" "")
      mode_tag="single"
      top5=$(build_top_summary)
      ;;
    per-category)
      local flag
      flag=$(route_filter_flag "$cat")
      verdict=$(search_and_judge "$qid" "$project_dir" "$query" "$min_score" "$kinds_csv" "$labels_csv" "$flag")
      case "$flag" in
        --code-only) mode_tag="code" ;;
        --docs-only) mode_tag="docs" ;;
        *)           mode_tag="both" ;;
      esac
      top5=$(build_top_summary)
      ;;
    fallback)
      verdict=$(search_and_judge "$qid" "$project_dir" "$query" "$min_score" "$kinds_csv" "$labels_csv" "--code-only")
      mode_tag="code"
      top5=$(build_top_summary)
      if [[ "$verdict" == "MISS" ]]; then
        # Retry on docs. Update mode_tag/top5 unconditionally to reflect the
        # last attempted bucket — distinguishes "code-only MISS" from
        # "tried both and missed".
        verdict=$(search_and_judge "$qid" "$project_dir" "$query" "$min_score" "$kinds_csv" "$labels_csv" "--docs-only")
        if [[ "$verdict" == "HIT" ]]; then
          mode_tag="fallback-docs"
        else
          mode_tag="fallback-miss"
        fi
        top5=$(build_top_summary)
      fi
      ;;
    both-buckets)
      # Always issue both calls; union verdicts. This models the production
      # pattern where the LLM agent receives two separately-labeled top-K
      # lists ("CODE:..." and "DOCS:...") and decides on the fly which one
      # is more useful. The HIT verdict here is "at least one bucket
      # satisfied the filters".
      local code_verdict code_top5 docs_verdict docs_top5
      code_verdict=$(search_and_judge "$qid" "$project_dir" "$query" "$min_score" "$kinds_csv" "$labels_csv" "--code-only")
      code_top5=$(build_top_summary)
      docs_verdict=$(search_and_judge "$qid" "$project_dir" "$query" "$min_score" "$kinds_csv" "$labels_csv" "--docs-only")
      docs_top5=$(build_top_summary)

      # Verdict union: ERROR must not override a confirmed HIT from the
      # healthy bucket — a real LLM agent would still use that bucket's
      # results. ERROR-only when BOTH buckets fail at the infrastructure
      # layer. When one errors and the other yields a HIT, annotate which
      # bucket errored so the operator can still see infrastructure signal.
      if [[ "$code_verdict" == "ERROR" && "$docs_verdict" == "ERROR" ]]; then
        verdict="ERROR"
        mode_tag="both-buckets"
      elif [[ "$code_verdict" == "HIT" || "$docs_verdict" == "HIT" ]]; then
        verdict="HIT"
        if [[ "$code_verdict" == "ERROR" ]]; then
          mode_tag="both-buckets(code-errored)"
        elif [[ "$docs_verdict" == "ERROR" ]]; then
          mode_tag="both-buckets(docs-errored)"
        else
          mode_tag="both-buckets"
        fi
      elif [[ "$code_verdict" == "ERROR" || "$docs_verdict" == "ERROR" ]]; then
        # One errored, other MISSed — infrastructure problem on one side,
        # genuine miss on the other. Surface as ERROR so the aggregator's
        # error counter fires; otherwise the broken bucket gets hidden.
        verdict="ERROR"
        mode_tag="both-buckets(partial-errored)"
      else
        verdict="MISS"
        mode_tag="both-buckets"
      fi
      top5="CODE: ${code_top5} ⏐ DOCS: ${docs_top5}"
      ;;
  esac

  echo "$verdict" > "$TMPDIR_RESULTS/${qid}.result"
  echo "$top5"    > "$TMPDIR_RESULTS/${qid}.top5"
  echo "$mode_tag" > "$TMPDIR_RESULTS/${qid}.mode"
  log "[$proj_name] $qid: $verdict ($mode_tag)"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
log "arch-graph baseline eval — $(date)"
log "Worktree: $WORKTREE_DIR"
log "k=$K  mode=$EVAL_MODE  skip_build=$SKIP_BUILD"
log ""

PROJECTS="project-a project-b project-c"
PROJECT_A_FAILED=0
PROJECT_B_FAILED=0
PROJECT_C_FAILED=0

for proj in $PROJECTS; do
  case "$proj" in
    project-a) proj_dir="$PROJECT_A_DIR" ;;
    project-b) proj_dir="$PROJECT_B_DIR" ;;
    project-c) proj_dir="$PROJECT_C_DIR" ;;
  esac

  if ! build_project "$proj" "$proj_dir"; then
    case "$proj" in
      project-a) PROJECT_A_FAILED=1 ;;
      project-b) PROJECT_B_FAILED=1 ;;
      project-c) PROJECT_C_FAILED=1 ;;
    esac
    continue
  fi

  # Get query IDs for this project
  mapfile_compat() {
    local _var="$1" _cmd="$2"
    # Works on bash 3 (no mapfile)
    while IFS= read -r line; do
      eval "${_var}+=(\"\$line\")"
    done < <(eval "$_cmd")
  }

  QIDS=()
  while IFS= read -r qid; do
    QIDS+=("$qid")
  done < <(jq -r --arg p "$proj" '.[] | select(.project == $p) | .id' "$QUERIES_FILE")

  for qid in "${QIDS[@]}"; do
    run_query "$proj" "$proj_dir" "$qid"
  done
done

# ---------------------------------------------------------------------------
# Aggregate results
# ---------------------------------------------------------------------------
# For each project:category — count hits and totals
# Stored as files: $TMPDIR_RESULTS/agg_<proj>_<cat>_hits  and _total

aggregate_count() {
  local proj="$1"
  local cat="$2"
  local hits=0 total=0 errors=0

  while IFS= read -r qid; do
    total=$((total + 1))
    local res_file="$TMPDIR_RESULTS/${qid}.result"
    local mode_file="$TMPDIR_RESULTS/${qid}.mode"
    if [[ -f "$res_file" ]]; then
      local v
      v=$(cat "$res_file")
      case "$v" in
        HIT)
          hits=$((hits + 1))
          # both-buckets mode can produce a HIT verdict while one bucket
          # errored at the infrastructure layer — preserve the HIT in the
          # recall metric but ALSO count the partial-error so the broken
          # bucket surfaces in proj_errors_all and triggers GLOBAL_EXIT=1.
          if [[ -f "$mode_file" ]] && grep -q 'errored' "$mode_file"; then
            errors=$((errors + 1))
          fi
          ;;
        ERROR) errors=$((errors + 1)) ;;
      esac
    fi
  done < <(jq -r --arg p "$proj" --arg c "$cat" '.[] | select(.project == $p and .category == $c) | .id' "$QUERIES_FILE")

  # ERROR queries count toward total (conservative — surfaces infrastructure
  # problems in the hit-rate rather than hiding them as zero-denominator).
  # The third value lets the caller emit a separate "N errored" warning.
  echo "$hits $total $errors"
}

# ---------------------------------------------------------------------------
# Expected thresholds
# ---------------------------------------------------------------------------
get_threshold() {
  local proj="$1" cat="$2"
  case "${proj}:${cat}" in
    project-a:A_find)  echo 80 ;;
    project-a:B_debug) echo 100 ;;
    project-a:C_ui)    echo 65 ;;
    project-a:E_arch)  echo 85 ;;
    project-a:overall) echo 85 ;;
    project-b:A_find)  echo 85 ;;
    project-b:C_ui)    echo 50 ;;
    project-b:overall) echo 85 ;;
    project-c:A_find)  echo 65 ;;
    project-c:overall) echo 65 ;;
    # D_docs: thresholds intentionally empty for the first measurement —
    # results display as "—" (informational, do not gate exit code). Tune
    # after observing actual hit-rates on real READMEs/ROADMAPs.
    *) echo "" ;;
  esac
}

status_icon() {
  local pct="$1" expected="$2"
  if [[ -z "$expected" ]]; then echo "—"; return; fi
  if [[ "$pct" -ge "$expected" ]]; then echo "✅"; else echo "⚠"; fi
}

# ---------------------------------------------------------------------------
# Build Markdown report
# ---------------------------------------------------------------------------
GLOBAL_EXIT=0

{
  echo "# arch-graph Baseline Eval — $DATE"
  echo ""
  echo "**Worktree**: \`$WORKTREE_DIR\`  "
  echo "**CLI**: \`$CLI\`  "
  echo "**k**: $K  "
  echo "**mode**: \`$EVAL_MODE\`  "
  echo "**skip_build**: $SKIP_BUILD  "
  echo "**Run at**: $(date)"
  echo ""
  echo "> **Context**: This run is against \`feat/semantic\` (Variant 3 baseline only)."
  echo "> FE-L1 and Var2 are in sibling worktrees and not merged yet."
  echo "> Expected thresholds are the *post-FE-L1+Var2 uplift targets*,"
  echo "> so ⚠ rows are expected at this stage."
  echo ""

  echo "## Results Table"
  echo ""
  echo "| project | category | hits/total | hit-rate | expected | status |"
  echo "|---------|----------|-----------|---------|---------|--------|"

  for proj in $PROJECTS; do
    case "$proj" in
      project-a) failed=$PROJECT_A_FAILED ;;
      project-b) failed=$PROJECT_B_FAILED ;;
      project-c) failed=$PROJECT_C_FAILED ;;
    esac

    if [[ "$failed" == "1" ]]; then
      echo "| $proj | — | BUILD FAILED | — | — | ❌ |"
      GLOBAL_EXIT=1
      continue
    fi

    proj_hits_all=0
    proj_total_all=0
    proj_errors_all=0

    for cat in A_find B_debug C_ui E_arch D_docs D_links; do
      read -r hits total errors <<< "$(aggregate_count "$proj" "$cat")"
      [[ "$total" == "0" ]] && continue

      proj_hits_all=$((proj_hits_all + hits))
      proj_total_all=$((proj_total_all + total))
      proj_errors_all=$((proj_errors_all + errors))

      pct=$(awk "BEGIN { printf \"%d\", ($hits/$total)*100 }")
      expected=$(get_threshold "$proj" "$cat")
      status=$(status_icon "$pct" "$expected")
      [[ "$status" == "⚠" ]] && GLOBAL_EXIT=1

      expected_display="${expected:-?}%"
      err_suffix=""
      [[ "$errors" -gt 0 ]] && err_suffix=" (${errors} ERROR)"
      echo "| $proj | $cat | ${hits}/${total}${err_suffix} | ${pct}% | $expected_display | $status |"
    done

    if [[ "$proj_errors_all" -gt 0 ]]; then
      warn "[$proj] ${proj_errors_all} queries errored (CLI exit ≠ 0/4 or invalid JSON). " \
           "Check the [eval] WARN lines above; these were counted as failures in the hit-rate."
      # Errored queries indicate infrastructure breakage. Unconditionally fail
      # the eval — without this, an unthresholded category can silently absorb
      # every ERROR and still let the script exit 0 (CI false-green).
      GLOBAL_EXIT=1
    fi

    # Overall
    if [[ "$proj_total_all" -gt 0 ]]; then
      op=$(awk "BEGIN { printf \"%d\", ($proj_hits_all/$proj_total_all)*100 }")
      oe=$(get_threshold "$proj" "overall")
      os=$(status_icon "$op" "$oe")
      [[ "$os" == "⚠" ]] && GLOBAL_EXIT=1
      oe_display="${oe:-?}%"
      echo "| **$proj** | **overall** | **${proj_hits_all}/${proj_total_all}** | **${op}%** | **$oe_display** | **$os** |"
    fi
  done

  echo ""
  echo "## Per-Query Detail"
  echo ""
  echo "> HIT = top-$K contains a result satisfying score + kind + label filters.  "
  echo "> MISS = no result in top-$K satisfies all filters."
  echo ""

  for proj in $PROJECTS; do
    echo "### $proj"
    echo ""
    echo "| id | category | status | mode | top-$K summary |"
    echo "|----|----------|--------|------|----------------|"

    while IFS= read -r qid; do
      cat=$(jq -r --arg id "$qid" '.[] | select(.id == $id) | .category' "$QUERIES_FILE")
      res_file="$TMPDIR_RESULTS/${qid}.result"
      top5_file="$TMPDIR_RESULTS/${qid}.top5"
      mode_file="$TMPDIR_RESULTS/${qid}.mode"
      status="SKIP"
      top5="—"
      mode_tag="—"
      if [[ -f "$res_file" ]]; then
        status="$(cat "$res_file")"
      fi
      if [[ -f "$top5_file" ]]; then
        top5="$(cat "$top5_file")"
      fi
      if [[ -f "$mode_file" ]]; then
        mode_tag="$(cat "$mode_file")"
      fi
      echo "| $qid | $cat | $status | $mode_tag | $top5 |"
    done < <(jq -r --arg p "$proj" '.[] | select(.project == $p) | .id' "$QUERIES_FILE")

    echo ""
  done

  echo "## Missed Queries (MISS detail)"
  echo ""
  echo "Queries that did NOT hit, with top-$K results:"
  echo ""

  while IFS= read -r qid; do
    res_file="$TMPDIR_RESULTS/${qid}.result"
    [[ ! -f "$res_file" ]] && continue
    [[ "$(cat "$res_file")" == "HIT" ]] && continue

    query=$(jq -r --arg id "$qid" '.[] | select(.id == $id) | .query' "$QUERIES_FILE")
    proj=$(jq -r --arg id "$qid" '.[] | select(.id == $id) | .project' "$QUERIES_FILE")
    cat=$(jq -r --arg id "$qid" '.[] | select(.id == $id) | .category' "$QUERIES_FILE")
    top5_file="$TMPDIR_RESULTS/${qid}.top5"
    top5="$(cat "$top5_file" 2>/dev/null || echo "—")"

    echo "- **$qid** [$proj/$cat] \"$query\""
    echo "  - top-$K: $top5"
  done < <(jq -r '.[].id' "$QUERIES_FILE")

  echo ""
  echo "## Notes"
  echo ""
  echo "- Expected thresholds reflect **post FE-L1+Var2 uplift targets**."
  echo "- Variant-3 baseline is ~60% / ~50% / ~40% overall — all ⚠ are intentional."
  echo "- Re-run after merging \`feat/fe-l1\` and \`feat/var2-extractors\` to measure uplift."
  echo ""

} 2>&1 | tee "$RESULTS_FILE"

log ""
log "Results saved to: $RESULTS_FILE"

if [[ "$GLOBAL_EXIT" == "0" ]]; then
  log "All thresholds met. Exit 0."
else
  log "Thresholds not yet met (expected at Variant-3 stage). Exit 1."
fi

exit "$GLOBAL_EXIT"
