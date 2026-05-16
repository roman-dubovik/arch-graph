#!/bin/sh
# arch-graph uninstaller — POSIX, symmetric with install.sh.
#
# Removes:
#   - the ~/.arch-graph (or $ARCH_GRAPH_HOME) install directory
#   - the ~/.local/bin/arch-graph (or $ARCH_GRAPH_BIN_DIR/arch-graph) symlink
#   - the global ~/.claude/skills/arch-graph/ directory if present
#
# Does NOT remove per-project artefacts (arch-graph.config.ts,
# arch-graph-out/, CLAUDE.md sections, git hooks). Run these INSIDE each
# project, BEFORE this script, while the CLI is still on PATH:
#
#   arch-graph claude uninstall
#   arch-graph hook uninstall
#   rm -rf arch-graph-out arch-graph.config.ts
#
# Requires --yes to actually delete anything. Without it, prints what
# would be removed and exits 0.

set -e

INSTALL_DIR="${ARCH_GRAPH_HOME:-$HOME/.arch-graph}"
BIN_DIR="${ARCH_GRAPH_BIN_DIR:-$HOME/.local/bin}"
LINK="$BIN_DIR/arch-graph"
SKILL_DIR="$HOME/.claude/skills/arch-graph"

err() { echo "arch-graph uninstall: $*" >&2; }
ok()  { echo "arch-graph uninstall: $*"; }

FORCE=0
for arg in "$@"; do
    case "$arg" in
        --yes|-y) FORCE=1 ;;
        --help|-h)
            cat <<EOF
arch-graph uninstall — remove the global install.

Usage: bash scripts/uninstall.sh [--yes]

Without --yes: dry-run, prints what would be removed.
With --yes:    actually removes files.

Env:
  ARCH_GRAPH_HOME      install dir (default: \$HOME/.arch-graph)
  ARCH_GRAPH_BIN_DIR   symlink dir (default: \$HOME/.local/bin)

Does NOT touch per-project artefacts. See script header for details.
EOF
            exit 0
            ;;
        *)
            err "unknown arg: $arg (try --help)"
            exit 1
            ;;
    esac
done

# ---- inventory -------------------------------------------------------------

INSTALL_PRESENT=0
LINK_PRESENT=0
SKILL_PRESENT=0
LINK_OURS=0

[ -d "$INSTALL_DIR" ] && INSTALL_PRESENT=1
if [ -L "$LINK" ] || [ -e "$LINK" ]; then
    LINK_PRESENT=1
    # Only auto-remove the symlink if it points into our install dir —
    # protects against a user-managed `arch-graph` binary that happens to
    # share the path.
    TARGET=$(readlink "$LINK" 2>/dev/null || true)
    case "$TARGET" in
        "$INSTALL_DIR"/*) LINK_OURS=1 ;;
        *)                LINK_OURS=0 ;;
    esac
fi
[ -d "$SKILL_DIR" ] && SKILL_PRESENT=1

# ---- report ----------------------------------------------------------------

if [ "$INSTALL_PRESENT" -eq 0 ] && [ "$LINK_PRESENT" -eq 0 ] && [ "$SKILL_PRESENT" -eq 0 ]; then
    ok "nothing to remove — arch-graph is not installed."
    exit 0
fi

echo "arch-graph uninstall: would remove"
if [ "$INSTALL_PRESENT" -eq 1 ]; then
    SIZE=$(du -sh "$INSTALL_DIR" 2>/dev/null | awk '{print $1}')
    echo "  - $INSTALL_DIR  ($SIZE)"
fi
if [ "$LINK_PRESENT" -eq 1 ]; then
    if [ "$LINK_OURS" -eq 1 ]; then
        echo "  - $LINK  → $TARGET"
    else
        echo "  - $LINK  → $TARGET  ⚠ does NOT point into $INSTALL_DIR — will be left alone"
    fi
fi
if [ "$SKILL_PRESENT" -eq 1 ]; then
    echo "  - $SKILL_DIR  (global Claude Code skill)"
fi

cat <<'EOF'

Per-project artefacts (arch-graph.config.ts, arch-graph-out/, CLAUDE.md
sections, git hooks) are NOT touched by this script. Run inside each
project, before uninstalling, while the CLI is still on PATH:

  arch-graph claude uninstall
  arch-graph hook uninstall
  rm -rf arch-graph-out arch-graph.config.ts

EOF

if [ "$FORCE" -eq 0 ]; then
    echo "Dry-run only. Re-run with --yes to actually remove."
    exit 0
fi

# ---- remove ----------------------------------------------------------------

if [ "$LINK_PRESENT" -eq 1 ] && [ "$LINK_OURS" -eq 1 ]; then
    rm -f "$LINK"
    ok "removed $LINK"
fi
if [ "$SKILL_PRESENT" -eq 1 ]; then
    rm -rf "$SKILL_DIR"
    ok "removed $SKILL_DIR"
fi
if [ "$INSTALL_PRESENT" -eq 1 ]; then
    rm -rf "$INSTALL_DIR"
    ok "removed $INSTALL_DIR"
fi

ok "done."
