#!/usr/bin/env bash
#
# Create an isolated git worktree for a parallel agent session.
#
# WHY THIS EXISTS: a shared checkout has one working tree and one index, so two
# sessions editing at once write over each other by construction — one `git add`
# sweeps the other's half-finished files into the wrong commit, and neither can
# see what the other has staged. The note at the top of
# packages/app/test/e2e/harness.mjs is the same problem from the test side: a
# file save in one session live-reloads the pages another session is asserting
# against.
#
# A worktree gives each session its own directory, its own index and its own
# branch. Both still push to the same remote.
#
# Usage:
#   tools/session-worktree.sh <name> [base-branch]
#
# Example:
#   tools/session-worktree.sh spanview
#   -> ../laika-orbit-spanview on branch session/spanview
#
# Remove when finished:
#   git worktree remove ../laika-orbit-spanview

set -euo pipefail

NAME="${1:-}"
if [ -z "$NAME" ]; then
  echo "usage: tools/session-worktree.sh <name> [base-branch]" >&2
  exit 1
fi
BASE="${2:-main}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$(dirname "$REPO_ROOT")/$(basename "$REPO_ROOT")-$NAME"
BRANCH="session/$NAME"

if [ -e "$DEST" ]; then
  echo "error: $DEST already exists" >&2
  exit 1
fi

echo "==> Creating worktree for '$NAME'"
git -C "$REPO_ROOT" fetch --quiet origin "$BASE" 2>/dev/null || true
git -C "$REPO_ROOT" worktree add -b "$BRANCH" "$DEST" "origin/$BASE" 2>/dev/null \
  || git -C "$REPO_ROOT" worktree add -b "$BRANCH" "$DEST" "$BASE"

# Gitignored, so a fresh worktree has none. Symlinked rather than copied: rotate
# a key once and every worktree picks it up, instead of leaving stale secrets
# scattered across directories.
echo "==> Linking environment files"
for f in .env.local; do
  if [ -f "$REPO_ROOT/$f" ]; then
    mkdir -p "$DEST/$(dirname "$f")"
    ln -s "$REPO_ROOT/$f" "$DEST/$f"
    echo "    $f"
  fi
done

# brain/*.local.json and .orbit/ are deliberately NOT linked. They are runtime
# state the app rewrites as you click — sharing them would put the sessions back
# to fighting over one file, which is the thing this script exists to stop.

cat <<EOF

Worktree ready.

  path    $DEST
  branch  $BRANCH (from $BASE)

Dependencies are not shared between worktrees, so run once:

  cd "$DEST" && pnpm install

Give the session its own port so the suites and the HMR reloads stay apart:

  cd "$DEST/packages/app" && PORT=5201 node server.mjs

When the work is merged or abandoned:

  git worktree remove "$DEST"
  git branch -d $BRANCH
EOF
