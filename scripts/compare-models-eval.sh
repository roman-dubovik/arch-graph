#!/usr/bin/env bash
# scripts/compare-models-eval.sh
# Side-by-side comparison of MiniLM vs e5-base on the 103-query bench.
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
#   - $SCRIPT_DIR/eval/results-<DATE>-<MODE>-minilm.md  (MiniLM run)
#   - $SCRIPT_DIR/eval/results-<DATE>-<MODE>.md         (e5-base run)
#   - $SCRIPT_DIR/eval/comparison-<DATE>-<MODE>.md      (this script's delta)
#
# Cost: ~2x a single eval run (one full rebuild per model). e5-base first
# run downloads ~280 MB. Plan 30-60 min wall-clock on a real monorepo set.

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

MINILM_OUT="$SCRIPT_DIR/eval/results-${DATE}-${EVAL_MODE}-minilm.md"
E5_OUT="$SCRIPT_DIR/eval/results-${DATE}-${EVAL_MODE}.md"
COMPARE_OUT="$SCRIPT_DIR/eval/comparison-${DATE}-${EVAL_MODE}.md"

echo "[compare] === Run 1: MiniLM legacy baseline (cached, fast) ==="
MODEL=minilm EVAL_MODE="$EVAL_MODE" RESULTS_FILE="$MINILM_OUT" bash "$SCRIPT_DIR/run-baseline-eval.sh" $SKIP_FLAG || true

echo ""
echo "[compare] === Run 2: e5-base default (280 MB download on first use) ==="
MODEL=e5-base EVAL_MODE="$EVAL_MODE" RESULTS_FILE="$E5_OUT" bash "$SCRIPT_DIR/run-baseline-eval.sh" $SKIP_FLAG || true

echo ""
echo "[compare] === Building comparison markdown ==="

# Extract project hit-rates from each results markdown.
# The eval script emits table rows like:
#   | **project-a** | **overall** | **39/49** | **79%** | ...
extract_totals() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "MISSING:$file" >&2
    return 1
  fi
  awk '
    /^\| \*\*project-[abc]\*\* \| \*\*overall\*\*/ {
      line=$0
      gsub(/\*\*/, "", line)
      split(line, f, "|")
      gsub(/^ +| +$/, "", f[2])
      gsub(/^ +| +$/, "", f[4])
      gsub(/^ +| +$/, "", f[5])
      split(f[4], ht, "/")
      gsub(/%/, "", f[5])
      print f[2], ht[1], ht[2], f[5]
    }
  ' "$file"
}

extract_categories() {
  local file="$1"
  if [[ ! -f "$file" ]]; then return 1; fi
  awk '
    /^\| project-[abc] \|/ {
      line=$0
      split(line, f, "|")
      gsub(/^ +| +$/, "", f[2])
      gsub(/^ +| +$/, "", f[3])
      gsub(/^ +| +$/, "", f[4])
      gsub(/^ +| +$/, "", f[5])
      if (f[3] != "overall" && f[3] != "—") {
        print f[2], f[3], f[4], f[5]
      }
    }
  ' "$file"
}

{
  echo "# e5-base vs MiniLM — 103-query head-to-head"
  echo ""
  echo "**Date**: $DATE  "
  echo "**Mode**: \`$EVAL_MODE\`  "
  echo "**MiniLM results**: \`$MINILM_OUT\`  "
  echo "**e5-base results**: \`$E5_OUT\`"
  echo ""

  echo "## Per-project totals"
  echo ""
  echo "| Project | MiniLM hits | MiniLM % | e5-base hits | e5-base % | Δ pp |"
  echo "|---------|-------------|----------|-------------|----------|------|"

  paste \
    <(extract_totals "$MINILM_OUT" 2>/dev/null) \
    <(extract_totals "$E5_OUT" 2>/dev/null) \
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
  echo "| Project | Category | MiniLM | e5-base | Δ pp |"
  echo "|---------|----------|--------|--------|------|"

  paste \
    <(extract_categories "$MINILM_OUT" 2>/dev/null) \
    <(extract_categories "$E5_OUT" 2>/dev/null) \
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
  echo "Decision rule:"
  echo ""
  echo "- **e5-base should remain the default** unless MiniLM is explicitly being measured as a legacy baseline."
  echo "- **≥ 5pp MiniLM regression on a category** → inspect that category before changing search routing or scoring thresholds."
  echo "- **Both models below threshold** → treat it as extractor/config coverage or query-suite quality, not an embedder decision."
  echo ""
  echo "Raw per-query verdicts: see \`$MINILM_OUT\` and \`$E5_OUT\`."
} > "$COMPARE_OUT"

echo "[compare] === Done ==="
echo "[compare] Comparison written to: $COMPARE_OUT"
echo ""
cat "$COMPARE_OUT"
