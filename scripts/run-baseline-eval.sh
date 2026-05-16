#!/usr/bin/env bash
# scripts/run-baseline-eval.sh
# Baseline evaluation script for arch-graph semantic search.
#
# Runs the 26-query suite against platform / insyra / beribuy2,
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
#   SKIP_BUILD=1  Same as --skip-build (env var form).
#   EVAL_K=5      Number of top results to inspect (default: 5).
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
QUERIES_FILE="$SCRIPT_DIR/eval/queries.json"
CLI="$WORKTREE_DIR/src/cli/index.ts"
K="${EVAL_K:-5}"
DATE="$(date +%Y-%m-%d)"
RESULTS_FILE="$SCRIPT_DIR/eval/results-${DATE}.md"
SKIP_BUILD="${SKIP_BUILD:-0}"

# Project paths
PLATFORM_DIR="/Users/romandubovik/Documents/Projects/platform"
INSYRA_DIR="/Users/romandubovik/Documents/Projects/insyra"
BERIBUY_DIR="/Users/romandubovik/Documents/Projects/beribuy/beribuy-2.0"

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
# Per-query search and evaluation
# ---------------------------------------------------------------------------
# Writes: $TMPDIR_RESULTS/<qid>.result  — "HIT" or "MISS"
#         $TMPDIR_RESULTS/<qid>.top5    — one-line top-5 summary
run_query() {
  local proj_name="$1"
  local project_dir="$2"
  local qid="$3"

  local query min_score kinds_csv labels_csv
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

  local json_output top5 verdict
  json_output=$(cd "$project_dir" && "$TSX_BIN" "$CLI" semantic search "$query" --k "$K" --json 2>/dev/null) || true

  # Build top-5 summary
  top5=$(echo "$json_output" | jq -r '
    if .error then
      "ERROR: \(.error)"
    elif ((.results // []) | length) == 0 then
      "no results"
    else
      [.results[] | "\(.score | . * 1000 | round / 1000) \(.kind):\(.label)"] | join(" | ")
    end
  ' 2>/dev/null || echo "parse error")

  # Evaluate: check if any top-K result satisfies score + kind + label
  verdict="MISS"
  local result_count
  result_count=$(echo "$json_output" | jq '(.results // []) | length' 2>/dev/null || echo 0)

  local i
  for (( i=0; i<result_count; i++ )); do
    local score kind label
    score=$(echo "$json_output" | jq -r ".results[$i].score" 2>/dev/null || echo 0)
    kind=$(echo "$json_output" | jq -r ".results[$i].kind" 2>/dev/null || echo "")
    label=$(echo "$json_output" | jq -r ".results[$i].label" 2>/dev/null || echo "")

    # Score check
    local score_ok
    score_ok=$(awk -v s="$score" -v m="$min_score" 'BEGIN { print (s+0 >= m+0) ? "1" : "0" }')
    [[ "$score_ok" != "1" ]] && continue

    # Kind filter
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

    # Label filter (case-insensitive substring)
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

  echo "$verdict" > "$TMPDIR_RESULTS/${qid}.result"
  echo "$top5" > "$TMPDIR_RESULTS/${qid}.top5"
  log "[$proj_name] $qid: $verdict"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
log "arch-graph baseline eval — $(date)"
log "Worktree: $WORKTREE_DIR"
log "k=$K  skip_build=$SKIP_BUILD"
log ""

PROJECTS="platform insyra beribuy2"
PLATFORM_FAILED=0
INSYRA_FAILED=0
BERIBUY_FAILED=0

for proj in $PROJECTS; do
  case "$proj" in
    platform) proj_dir="$PLATFORM_DIR" ;;
    insyra)   proj_dir="$INSYRA_DIR" ;;
    beribuy2) proj_dir="$BERIBUY_DIR" ;;
  esac

  if ! build_project "$proj" "$proj_dir"; then
    case "$proj" in
      platform) PLATFORM_FAILED=1 ;;
      insyra)   INSYRA_FAILED=1 ;;
      beribuy2) BERIBUY_FAILED=1 ;;
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
  local hits=0 total=0

  while IFS= read -r qid; do
    total=$((total + 1))
    local res_file="$TMPDIR_RESULTS/${qid}.result"
    if [[ -f "$res_file" ]] && [[ "$(cat "$res_file")" == "HIT" ]]; then
      hits=$((hits + 1))
    fi
  done < <(jq -r --arg p "$proj" --arg c "$cat" '.[] | select(.project == $p and .category == $c) | .id' "$QUERIES_FILE")

  echo "$hits $total"
}

# ---------------------------------------------------------------------------
# Expected thresholds
# ---------------------------------------------------------------------------
get_threshold() {
  local proj="$1" cat="$2"
  case "${proj}:${cat}" in
    platform:A_find)  echo 80 ;;
    platform:B_debug) echo 100 ;;
    platform:C_ui)    echo 65 ;;
    platform:E_arch)  echo 85 ;;
    platform:overall) echo 85 ;;
    insyra:A_find)    echo 85 ;;
    insyra:C_ui)      echo 50 ;;
    insyra:overall)   echo 85 ;;
    beribuy2:A_find)  echo 65 ;;
    beribuy2:overall) echo 65 ;;
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
      platform) failed=$PLATFORM_FAILED ;;
      insyra)   failed=$INSYRA_FAILED ;;
      beribuy2) failed=$BERIBUY_FAILED ;;
    esac

    if [[ "$failed" == "1" ]]; then
      echo "| $proj | — | BUILD FAILED | — | — | ❌ |"
      GLOBAL_EXIT=1
      continue
    fi

    proj_hits_all=0
    proj_total_all=0

    for cat in A_find B_debug C_ui E_arch; do
      read -r hits total <<< "$(aggregate_count "$proj" "$cat")"
      [[ "$total" == "0" ]] && continue

      proj_hits_all=$((proj_hits_all + hits))
      proj_total_all=$((proj_total_all + total))

      pct=$(awk "BEGIN { printf \"%d\", ($hits/$total)*100 }")
      expected=$(get_threshold "$proj" "$cat")
      status=$(status_icon "$pct" "$expected")
      [[ "$status" == "⚠" ]] && GLOBAL_EXIT=1

      expected_display="${expected:-?}%"
      echo "| $proj | $cat | ${hits}/${total} | ${pct}% | $expected_display | $status |"
    done

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
    echo "| id | category | status | top-$K summary |"
    echo "|----|----------|--------|----------------|"

    while IFS= read -r qid; do
      cat=$(jq -r --arg id "$qid" '.[] | select(.id == $id) | .category' "$QUERIES_FILE")
      res_file="$TMPDIR_RESULTS/${qid}.result"
      top5_file="$TMPDIR_RESULTS/${qid}.top5"
      status="SKIP"
      top5="—"
      if [[ -f "$res_file" ]]; then
        status="$(cat "$res_file")"
      fi
      if [[ -f "$top5_file" ]]; then
        top5="$(cat "$top5_file")"
      fi
      echo "| $qid | $cat | $status | $top5 |"
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
