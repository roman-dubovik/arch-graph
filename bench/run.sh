#!/usr/bin/env bash
# bench/run.sh — orchestrate the head-to-head benchmark.
#
# Usage:
#   bash bench/run.sh                # rebuild + bench
#   bash bench/run.sh --skip-arch    # reuse /tmp/sg-* if present
#
# Side effects:
#   - writes /tmp/sg-<project>/* (arch-graph build outputs)
#   - writes bench/.build-times.json (per-project wall-time)
#   - writes bench/report.md

set -euo pipefail

# Resolve worktree root (the parent of bench/)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

SKIP_ARCH=0
for arg in "$@"; do
    case "$arg" in
        --skip-arch) SKIP_ARCH=1 ;;
        -h|--help)
            sed -n '2,12p' "$0"
            exit 0
            ;;
        *)
            echo "unknown flag: $arg" >&2
            exit 1
            ;;
    esac
done

# ── Step 1: ensure node deps are installed ────────────────────────────────
if [ ! -d "node_modules/@dqbd/tiktoken" ] || [ ! -d "node_modules/js-yaml" ]; then
    echo "[bench] installing dev deps..."
    npm install >/dev/null
fi

# ── Step 2: rebuild each project (or skip if cached + --skip-arch) ────────
#
# The project list is derived from `configs/*.config.ts`. The included
# `configs/example.config.ts` is the public template — to benchmark your
# own monorepos, drop additional `configs/<id>.config.ts` files in place
# and add matching questions to `bench/questions.yaml` (using `<id>` as
# the `project:` value).
PROJECTS=()
for cfg in configs/*.config.ts; do
    [ -e "$cfg" ] || continue
    base="$(basename "$cfg" .config.ts)"
    [ "$base" = "example" ] && continue
    PROJECTS+=("$base")
done

if [ "${#PROJECTS[@]}" -eq 0 ]; then
    echo "[bench] no project configs found under configs/ (only example.config.ts ships by default)."
    echo "[bench] add configs/<id>.config.ts files and question entries to bench/questions.yaml, then re-run."
    exit 0
fi

# Build-times accumulator (JSON; we rebuild it from scratch each run unless --skip-arch)
BUILD_TIMES_JSON='{}'
if [ -f bench/.build-times.json ] && [ "$SKIP_ARCH" -eq 1 ]; then
    BUILD_TIMES_JSON="$(cat bench/.build-times.json)"
fi

for proj in "${PROJECTS[@]}"; do
    out="/tmp/sg-${proj}"
    cfg="configs/${proj}.config.ts"
    if [ "$SKIP_ARCH" -eq 1 ] && [ -f "${out}/graph.json" ]; then
        echo "[bench] arch-graph ${proj}: cached (${out}/graph.json) — skipping"
        continue
    fi

    echo "[bench] arch-graph build ${proj} → ${out}"
    t0=$(python3 -c 'import time; print(time.time())')
    # --strict: CI hard-fail mode — exit 3 if any enabled domain falls below
    # its recall floor. Stderr is tee'd to a temp file so failures are visible.
    err_log="$(mktemp -t archbuild-${proj}-XXXX.err)"
    if ! npx tsx src/cli/index.ts build --strict --config "$cfg" --out "$out" >/dev/null 2>"$err_log" ; then
        echo "[bench] ERROR: arch-graph build ${proj} failed (--strict gate or fatal error)"
        echo "[bench] ---- stderr (${err_log}) ----"
        tail -n 40 "$err_log" >&2 || true
        echo "[bench] ---- end stderr ----"
    fi
    rm -f "$err_log"
    t1=$(python3 -c 'import time; print(time.time())')
    ms=$(python3 -c "print(int((${t1} - ${t0}) * 1000))")
    echo "[bench]   build ${proj}: ${ms} ms"
    BUILD_TIMES_JSON="$(python3 -c "
import json, sys
j = json.loads('''${BUILD_TIMES_JSON}''')
j['${proj}'] = {'archMs': int('${ms}')}
print(json.dumps(j))
")"
done

echo "$BUILD_TIMES_JSON" > bench/.build-times.json

# ── Step 3: check graphify availability per project ────────────────────────
echo "[bench] graphify availability:"
for proj in "${PROJECTS[@]}"; do
    # Pull the `root` value out of the config file
    root="$(python3 -c "
import re
t = open('configs/${proj}.config.ts').read()
m = re.search(r\"root:\\s*'([^']+)'\", t)
print(m.group(1) if m else '')
")"
    cand1="${root}/graphify-out/graph.json"
    cand2="bench/cache/${proj}/graphify-out/graph.json"
    if [ -f "$cand1" ]; then
        echo "[bench]   ${proj}: $cand1"
    elif [ -f "$cand2" ]; then
        echo "[bench]   ${proj}: $cand2"
    else
        echo "[bench]   ${proj}: NOT FOUND (graphify leg will be skipped)"
        echo "[bench]     to produce: run graphify as a Claude Code skill against ${root}"
    fi
done

# ── Step 4: run the bench ─────────────────────────────────────────────────
echo "[bench] running bench.ts..."
npx tsx bench/bench.ts

echo "[bench] done — see bench/report.md"
