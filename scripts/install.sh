#!/bin/sh
# arch-graph installer — POSIX, no bash features.
#
# Clones (or git pull's) the repo into ~/.arch-graph, installs deps, and
# symlinks `bin/arch-graph` onto PATH. The clone URL is resolved from one
# of, in order:
#
#   1. $ARCH_GRAPH_GIT — user-supplied clone source (any URL or local path)
#   2. ~/.arch-graph already exists with a git remote — use its `origin`
#   3. The path stored in $0 of this script, if it lives inside a git work
#      tree (the case when the user runs `bash scripts/install.sh` from
#      their existing clone)
#   4. $ARCH_GRAPH_DEFAULT_GIT — built-in default (the public GitHub repo)

set -e

ARCH_GRAPH_DEFAULT_GIT="${ARCH_GRAPH_DEFAULT_GIT:-https://github.com/roman-dubovik/arch-graph.git}"
INSTALL_DIR="${ARCH_GRAPH_HOME:-$HOME/.arch-graph}"
BIN_DIR="${ARCH_GRAPH_BIN_DIR:-$HOME/.local/bin}"

err() { echo "arch-graph install: $*" >&2; }
ok()  { echo "arch-graph install: $*"; }

# ---- 1. node version check -------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
    err "node is not installed. Install Node ≥ 20 from https://nodejs.org/ and re-run."
    exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
    err "node $(node -v) is too old. arch-graph needs Node ≥ 20."
    exit 1
fi

# ---- 2. figure out where to clone from -------------------------------------

resolve_source() {
    if [ -n "$ARCH_GRAPH_GIT" ]; then
        echo "$ARCH_GRAPH_GIT"; return
    fi
    if [ -d "$INSTALL_DIR/.git" ]; then
        # Existing install — keep using whatever origin it has.
        echo ""
        return
    fi
    # If install.sh was launched from inside an existing arch-graph clone,
    # use that path as the clone source (covers "bash scripts/install.sh"
    # from a `git clone` the user just made).
    SELF_DIR=$(cd -P "$(dirname "$0")/.." 2>/dev/null && pwd || true)
    # Accept both a regular .git directory and a worktree .git file pointer.
    if [ -n "$SELF_DIR" ] && [ -e "$SELF_DIR/.git" ] && [ -f "$SELF_DIR/package.json" ]; then
        # Make sure it's actually arch-graph, not some other repo
        if grep -q '"name": *"arch-graph"' "$SELF_DIR/package.json" 2>/dev/null; then
            echo "$SELF_DIR"
            return
        fi
    fi
    if [ -n "$ARCH_GRAPH_DEFAULT_GIT" ]; then
        echo "$ARCH_GRAPH_DEFAULT_GIT"; return
    fi
    echo ""
}

SOURCE=$(resolve_source)

if [ -d "$INSTALL_DIR/.git" ]; then
    ok "updating existing install at $INSTALL_DIR"
    (cd "$INSTALL_DIR" && git pull --ff-only) || err "(continuing despite git pull error)"
elif [ -n "$SOURCE" ]; then
    ok "cloning $SOURCE → $INSTALL_DIR"
    git clone "$SOURCE" "$INSTALL_DIR"
else
    err "don't know where to clone arch-graph from."
    err "  Set ARCH_GRAPH_GIT to a clone URL or path, e.g.:"
    err "    ARCH_GRAPH_GIT=https://github.com/<owner>/arch-graph bash scripts/install.sh"
    err "  Or run this script from inside an existing clone."
    exit 1
fi

# ---- 3. install deps -------------------------------------------------------

cd "$INSTALL_DIR"
if command -v pnpm >/dev/null 2>&1 && [ -f pnpm-lock.yaml ]; then
    ok "installing deps with pnpm"
    pnpm install --frozen-lockfile
elif [ -f package-lock.json ]; then
    ok "installing deps with npm ci"
    npm ci
else
    ok "installing deps with npm install"
    npm install
fi

# ---- 4. symlink onto PATH --------------------------------------------------

WRAPPER="$INSTALL_DIR/bin/arch-graph"
if [ ! -x "$WRAPPER" ]; then
    err "$WRAPPER not found or not executable — install layout is broken."
    exit 1
fi

mkdir -p "$BIN_DIR"

# Detect whether $BIN_DIR is already on PATH (POSIX, no GNU extensions).
case ":$PATH:" in
    *":$BIN_DIR:"*) ON_PATH=1 ;;
    *)              ON_PATH=0 ;;
esac

LINK="$BIN_DIR/arch-graph"
if [ -e "$LINK" ] || [ -L "$LINK" ]; then
    rm -f "$LINK"
fi
ln -s "$WRAPPER" "$LINK"
ok "symlinked $LINK → $WRAPPER"

if [ "$ON_PATH" -eq 0 ]; then
    cat <<EOF >&2

  ⚠  $BIN_DIR is not on your PATH. Add this to your shell rc:
       export PATH="\$HOME/.local/bin:\$PATH"

EOF
fi

# ---- 5. next steps ---------------------------------------------------------

cat <<EOF

✓ arch-graph installed.

Next steps:
  1. cd into your NestJS monorepo
  2. arch-graph init                  # write arch-graph.config.ts
  3. \$EDITOR arch-graph.config.ts     # set id / root / appsGlob / libsGlob
  4. arch-graph build                 # writes arch-graph-out/

Optional integrations:
  arch-graph claude install --skill   # tell Claude Code to use the graph
  arch-graph hook install             # auto-rebuild on every commit

Uninstall: bash $INSTALL_DIR/scripts/uninstall.sh --yes
EOF
