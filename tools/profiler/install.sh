#!/usr/bin/env bash
# Install the profiler skill for every Claude Code chat on this Mac:
# ~/.claude/skills/profiler/. A copy, not a symlink, so the skill keeps working whichever
# branch or worktree is checked out. Re-run after changing anything in tools/profiler.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="$HOME/.claude/skills/profiler"
mkdir -p "$DEST"
for f in SKILL.md profiler.mjs server.mjs index.html ab.mjs; do
  cp "$REPO/tools/profiler/$f" "$DEST/$f"
done
chmod +x "$DEST/profiler.mjs"
echo "installed profiler skill -> $DEST"
"$DEST/profiler.mjs" status
