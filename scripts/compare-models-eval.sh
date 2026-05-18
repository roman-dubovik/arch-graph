#!/usr/bin/env bash
# scripts/compare-models-eval.sh
# Side-by-side comparison of MiniLM vs BGE-M3 on the 103-query bench.
#
# Runs run-baseline-eval.sh twice (once per model) on the same projects
# in the same EVAL_MODE, then emits a per-project / per-category delta
# summary to stdout.
#
# Usage:
#   PROJECT_A_DIR=/path/a \
#   PROJECT_B_DIR=/path/b \
#   PROJECT_C_DIR=/path/c \
#   bash scripts/compare-models-eval.sh [--skip-build] [--mode <mode>]
#
# Optional env:
#   EVAL_MODE       one of single|per-category|fallback|both-buckets (default: both-buckets)
#   QUERIES_FILE    custom queries.json
#   SKIP_BUILD      1 to skip rebuild (only useful if BOTH indexes are
#                   already at the expected model on disk — rare; usually leave 0)
#
# Output:
#   - $SCRIPT_DIR/eval/results-<DATE>-<MODE>.md         (MiniLM run)
#   - $SCRIPT_DIR/eval/results-<DATE>-<MODE>-bge-m3.md  (BGE-M3 run)
#   - $SCRIPT_DIR/eval/comparison-<DATE>-<MODE>.md      (this script's delta)
#
# Cost: ~2x a single eval run (one full rebuild per model). BGE-M3 first
# run downloads ~560 MB. Plan 30-60 min wall-clock on a real monorepo set.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVAL_MODE="${EVAL_MODE:-both-buckets}"
DATE="$(date +%Y-%m-%d)"
SKIP_FLAG=""

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_FLAG="--skip-build" ;;
    --mode) shift; EVAL_MODE="${2:-$EVAL_MODE}" ;;
    *) ;;
  esac
done

MINILM_OUT="$SCRIPT_DIR/eval/results-${DATE}-${EVAL_MODE}.md"
BGE_OUT="$SCRIPT_DIR/eval/results-${DATE}-${EVAL_MODE}-bge-m3.md"
COMPARE_OUT="$SCRIPT_DIR/eval/comparison-${DATE}-${EVAL_MODE}.md"

echo "[compare] === Run 1: MiniLM (cached, fast) ==="
MODEL=minilm EVAL_MODE="$EVAL_MODE" bash "$SCRIPT_DIR/run-baseline-eval.sh" $SKIP_FLAG || true

echo ""
echo "[compare] === Run 2: BGE-M3 (560 MB download on first use) ==="
MODEL=bge-m3 EVAL_MODE="$EVAL_MODE" bash "$SCRIPT_DIR/run-baseline-eval.sh" $SKIP_FLAG || true

echo ""
echo "[compare] === Building comparison markdown ==="

# Extract project hit-rates from each results markdown.
# The eval script emits per-project sections like:
#   ## project-a
#   ...
#   **Total**: 45/103 (43.7%)
extract_totals() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "MISSING:$file" >&2
    return 1
  fi
  awk '
    /^## project-[abc]/ { proj=$2 }
    /^\*\*Total\*\*:/ {
      # **Total**: 45/103 (43.7%)
      gsub(/[*:%()/]/, " ")
      print proj, $2, $3, $4
    }
  ' "$file"
}

extract_categories() {
  local file="$1"
  if [[ ! -f "$file" ]]; then return 1; fi
  awk '
    /^## project-[abc]/ { proj=$2 }
    /^\| [ABCDE]_/ {
      # | A_find | 12 / 18 | 66.7% | ... | 70% | ... |
      gsub(/^[| ]+|[| ]+$/, "")
      gsub(/\| +/, "|")
      gsub(/ +\|/, "|")
      split($0, f, "|")
      print proj, f[1], f[2], f[3]
    }
  ' "$file"
}

{
  echo "# BGE-M3 vs MiniLM — 103-query head-to-head"
  echo ""
  echo "**Date**: $DATE  "
  echo "**Mode**: \`$EVAL_MODE\`  "
  echo "**MiniLM results**: \`$MINILM_OUT\`  "
  echo "**BGE-M3 results**: \`$BGE_OUT\`"
  echo ""

  echo "## Per-project totals"
  echo ""
  echo "| Project | MiniLM hits | MiniLM % | BGE-M3 hits | BGE-M3 % | Δ pp |"
  echo "|---------|-------------|----------|-------------|----------|------|"

  paste \
    <(extract_totals "$MINILM_OUT" 2>/dev/null) \
    <(extract_totals "$BGE_OUT" 2>/dev/null) \
  | while IFS=$'\t' read -r ml bg; do
      ml_proj=$(echo "$ml" | awk '{print $1}')
      ml_hits=$(echo "$ml" | awk '{print $2}')
      ml_tot=$(echo "$ml" | awk '{print $3}')
      ml_pct=$(echo "$ml" | awk '{print $4}')
      bg_hits=$(echo "$bg" | awk '{print $2}')
      bg_pct=$(echo "$bg" | awk '{print $4}')
      if [[ -n "$ml_pct" && -n "$bg_pct" ]]; then
        delta=$(awk -v a="$ml_pct" -v b="$bg_pct" 'BEGIN{printf "%+.1f", b-a}')
      else
        delta="?"
      fi
      echo "| $ml_proj | $ml_hits/$ml_tot | ${ml_pct}% | $bg_hits/$ml_tot | ${bg_pct}% | $delta |"
    done

  echo ""
  echo "## Per-category"
  echo ""
  echo "| Project | Category | MiniLM | BGE-M3 | Δ pp |"
  echo "|---------|----------|--------|--------|------|"

  paste \
    <(extract_categories "$MINILM_OUT" 2>/dev/null) \
    <(extract_categories "$BGE_OUT" 2>/dev/null) \
  | while IFS=$'\t' read -r ml bg; do
      proj=$(echo "$ml" | awk '{print $1}')
      cat=$(echo "$ml" | awk '{print $2}')
      ml_score=$(echo "$ml" | awk '{print $3}')
      ml_pct=$(echo "$ml" | awk '{print $4}')
      bg_score=$(echo "$bg" | awk '{print $3}')
      bg_pct=$(echo "$bg" | awk '{print $4}')
      ml_num="${ml_pct//[^0-9.]/}"
      bg_num="${bg_pct//[^0-9.]/}"
      if [[ -n "$ml_num" && -n "$bg_num" ]]; then
        delta=$(awk -v a="$ml_num" -v b="$bg_num" 'BEGIN{printf "%+.1f", b-a}')
      else
        delta="?"
      fi
      echo "| $proj | $cat | $ml_score $ml_pct | $bg_score $bg_pct | $delta |"
    done

  echo ""
  echo "## Decision rule"
  echo ""
  echo "Per the BGE-M3 migration design doc and roadmap:"
  echo ""
  echo "- **≥ 5pp overall improvement OR ≥ 10pp on any single category** → recommend switching default to BGE-M3."
  echo "- **C_ui specifically:** if BGE-M3 lifts C_ui ≥ 50% (from MiniLM's 33-50% ceiling), the C_ui hypothesis is confirmed; skip the CSS-processing track in the roadmap."
  echo "- **Anything less than 5pp overall and < 10pp per category** → keep current opt-in stance (verdict ii from self-build report)."
  echo ""
  echo "Raw per-query verdicts: see \`$MINILM_OUT\` and \`$BGE_OUT\`."
} > "$COMPARE_OUT"

echo "[compare] === Done ==="
echo "[compare] Comparison written to: $COMPARE_OUT"
echo ""
cat "$COMPARE_OUT"
