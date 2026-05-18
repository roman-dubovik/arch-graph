#!/bin/sh
# arch-graph installer — POSIX, no bash features.
#
# Mirror policy: this file is also served at docs/install.sh for the
# `curl -fsSL .../install.sh | sh` UX. Whenever this file changes, copy it
# to docs/install.sh in the same commit:
#   cp scripts/install.sh docs/install.sh
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

# Capture the user's original working directory before any `cd` inside this
# script — used at the end to ask whether to initialise arch-graph here.
INITIAL_PWD="$(pwd)"

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

# ---- 5. offer to initialise here (interactive) -----------------------------

# Print the post-install hint shown when init is skipped or unavailable.
print_init_hint() {
    cat <<EOF

To initialise arch-graph in a project later:

  cd /path/to/your/nestjs-monorepo
  arch-graph init                     # interactive wizard

The wizard writes arch-graph.config.ts and (asks you about each):
  • install the Claude Code skill so agents pick up the graph
  • install a git pre-push hook that keeps the graph fresh
  • run the first build right away

If your project is tracked in a single repository and you don't want to
commit build output, add this line to its .gitignore:

  arch-graph-out/

Uninstall: bash $INSTALL_DIR/scripts/uninstall.sh --yes
EOF
}

# Decide whether to attempt an interactive init prompt. When the installer
# was launched via `curl | sh`, stdin is the curl pipe — not a TTY — so we
# try to re-open /dev/tty for prompts (same trick brew/rustup use). We test
# /dev/tty by actually trying to open it in a subshell, not by checking
# permission bits — on some minimal Linux images /dev/tty is mode crw--w----
# and `[ -w /dev/tty ]` returns false even when reads/writes would succeed.
PROMPT_FD=""
if [ -t 0 ]; then
    PROMPT_FD="0"
elif (exec </dev/tty) 2>/dev/null; then
    PROMPT_FD="tty"
fi

# Looks-like-a-project heuristic: package.json or tsconfig.json present.
INITIAL_LOOKS_LIKE_PROJECT=0
if [ -f "$INITIAL_PWD/package.json" ] || [ -f "$INITIAL_PWD/tsconfig.json" ]; then
    INITIAL_LOOKS_LIKE_PROJECT=1
fi

echo
echo "✓ arch-graph installed."

# Without a TTY there's no safe way to ask — skip the prompt entirely and
# fall through to the hint.
if [ -z "$PROMPT_FD" ]; then
    print_init_hint
    exit 0
fi

# Build the prompt text. If the current directory doesn't look like a TS
# project, default to N to avoid creating arch-graph.config.ts in $HOME.
if [ "$INITIAL_LOOKS_LIKE_PROJECT" -eq 1 ]; then
    DEFAULT_HINT="Y/n"
    DEFAULT_ANSWER="y"
else
    DEFAULT_HINT="y/N"
    DEFAULT_ANSWER="n"
    echo "  Note: $INITIAL_PWD has no package.json / tsconfig.json — looks like you may"
    echo "  want to cd into a NestJS project first."
fi

printf "\nInitialise arch-graph in %s? [%s] " "$INITIAL_PWD" "$DEFAULT_HINT"

# Read one line from the chosen prompt source. Distinguish a genuine read
# failure (EOF, closed stdin, broken pipe — happens on `docker run` without
# `-i`, ssh -T, etc.) from the user just pressing Enter: a failure must NOT
# silently fall through to the default "y", because that would launch the
# init wizard without the user actually consenting.
ANSWER=""
READ_OK=1
if [ "$PROMPT_FD" = "tty" ]; then
    IFS= read -r ANSWER </dev/tty || READ_OK=0
else
    IFS= read -r ANSWER || READ_OK=0
fi

if [ "$READ_OK" -eq 0 ]; then
    echo
    err "could not read a response (no usable input) — skipping init."
    print_init_hint
    exit 0
fi

[ -z "$ANSWER" ] && ANSWER="$DEFAULT_ANSWER"

case "$ANSWER" in
    y|Y|yes|YES|Yes)
        echo
        # An explicit cd-failure is fatal: silently exec-ing init from
        # $INSTALL_DIR (the previous cd in this script) would create
        # arch-graph.config.ts inside ~/.arch-graph, which the user
        # definitely did not ask for.
        if ! cd "$INITIAL_PWD"; then
            err "cannot cd into $INITIAL_PWD — aborting init."
            exit 1
        fi
        # Use the full path so we don't depend on $PATH being refreshed in
        # this shell. exec replaces this process — init owns stdio from here.
        exec "$WRAPPER" init
        ;;
    *)
        print_init_hint
        ;;
esac
