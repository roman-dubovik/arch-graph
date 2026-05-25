#!/bin/sh
# verify-heritage-on-monorepo.sh — local smoke test for code-intel-heritage-v1.
#
# Builds the code-intel sidecar against any TypeScript / NestJS monorepo and
# verifies the heritage-aware behavior introduced in commit-range:
#   c98573a..HEAD (feat/code-intel-heritage-v1)
#
# Expected outcomes documented inline below. Run with:
#
#   ARCH_GRAPH_BIN=/path/to/arch-graph \
#   TARGET_REPO=/path/to/your/monorepo \
#   scripts/verify-heritage-on-monorepo.sh
#
# Defaults: ARCH_GRAPH_BIN = ./bin/arch-graph  (relative to the arch-graph repo)
#           TARGET_REPO    = ${ARCH_GRAPH_TARGET_REPO:-}
#
# This script does NOT modify the target repo. It writes its sidecar output to
# the standard `arch-graph-out/code-intel/` directory inside TARGET_REPO and
# reads it back.
#
# The script does not assert exact numbers (they depend on monorepo size). It
# reports the BEFORE → AFTER deltas that this feature is expected to produce:
#
#   1. self_check.warnings.dangerousCollisions count drops sharply on NestJS
#      monorepos with BaseController-style delegation wrappers (large monorepos
#      may go from thousands of false-positives to under 100; the exact number
#      depends on what fraction of your collisions are pure-delegation).
#   2. resolve_symbol on a known base method returns the base implementation as
#      the primary match; delegation wrappers carry note: 'decorator wrapper...'.
#   3. trace_scenario on a known delegation-wrapper method shows a `super-call`
#      edge pointing to the base implementation.
#   4. get_type_definition on a subclass returns inheritedMembers (non-empty for
#      subclasses with non-overridden inherited methods).

set -eu

err() { echo "verify-heritage: $*" >&2; }

ARCH_GRAPH_BIN="${ARCH_GRAPH_BIN:-./bin/arch-graph}"
TARGET_REPO="${TARGET_REPO:-${ARCH_GRAPH_TARGET_REPO:-}}"

if [ -z "${TARGET_REPO}" ]; then
    err "TARGET_REPO not set (pass a TypeScript monorepo path)"
    err "  usage: TARGET_REPO=/path/to/your/monorepo $0"
    exit 2
fi

if [ ! -x "${ARCH_GRAPH_BIN}" ] && [ ! -f "${ARCH_GRAPH_BIN}" ]; then
    err "ARCH_GRAPH_BIN '${ARCH_GRAPH_BIN}' is not executable / not a file"
    exit 2
fi

if [ ! -d "${TARGET_REPO}" ]; then
    err "TARGET_REPO '${TARGET_REPO}' is not a directory"
    exit 2
fi

# Resolve to absolutes so subsequent `cd` doesn't break the bin path.
case "${ARCH_GRAPH_BIN}" in
    /*) ABS_BIN="${ARCH_GRAPH_BIN}" ;;
    *)  ABS_BIN="$(cd "$(dirname "${ARCH_GRAPH_BIN}")" && pwd)/$(basename "${ARCH_GRAPH_BIN}")" ;;
esac

cd "${TARGET_REPO}"

echo "==> Building code-intel sidecar against ${TARGET_REPO}"
"${ABS_BIN}" code-intel build --with-types

echo "==> 1. self_check"
"${ABS_BIN}" code-intel self-check || true
echo "(expected: status 'ok' OR 'degraded' with only LEGITIMATE collisions —"
echo " not the pre-fix flood of bogus delegation-wrapper collisions.)"
echo

echo "==> 2. resolve_symbol probe (pass via TARGET_BASE_FQN / TARGET_SUB_FQN)"
if [ -n "${TARGET_BASE_FQN:-}" ]; then
    echo "Probing: ${TARGET_BASE_FQN}"
    "${ABS_BIN}" code-intel resolve-symbol "${TARGET_BASE_FQN}" || true
    echo
fi
if [ -n "${TARGET_SUB_FQN:-}" ]; then
    echo "Probing: ${TARGET_SUB_FQN}"
    "${ABS_BIN}" code-intel resolve-symbol "${TARGET_SUB_FQN}" || true
    echo "(expected: delegation wrappers carry note: 'decorator wrapper, delegates to <id>')"
    echo
fi

echo "==> 3. trace_scenario probe (TARGET_SUB_FQN)"
if [ -n "${TARGET_SUB_FQN:-}" ]; then
    "${ABS_BIN}" code-intel trace-scenario "${TARGET_SUB_FQN}" --max-depth 5 || true
    echo "(expected: at least one call with kind: 'super-call' pointing at the base impl)"
    echo
fi

echo "==> 4. get_type_definition probe (TARGET_SUB_CLASS)"
if [ -n "${TARGET_SUB_CLASS:-}" ]; then
    "${ABS_BIN}" code-intel get-type-definition "${TARGET_SUB_CLASS}" || true
    echo "(expected: response includes inheritedMembers with inheritedFrom labels for"
    echo " every base-class method the subclass does NOT override.)"
    echo
fi

echo "==> done. Compare counts vs. main-branch run for a true BEFORE/AFTER."
