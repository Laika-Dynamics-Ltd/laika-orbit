#!/usr/bin/env bash
# Install the live-progress skill for every Claude Code chat on this Mac:
# ~/.claude/skills/live-progress/{SKILL.md, runs.mjs, progress.mjs}.
# A copy, not a symlink, so the skill keeps working whichever branch or worktree is checked out.
# progress.mjs is the same file under its old name: a chat that started reporting before runs
# landed keeps working, because the old verbs still do what they did.
# Re-run after changing packages/app/runs.mjs or this skill.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="$HOME/.claude/skills/live-progress"
mkdir -p "$DEST"
cp "$REPO/tools/live-progress/SKILL.md" "$DEST/SKILL.md"
cp "$REPO/packages/app/runs.mjs" "$DEST/runs.mjs"
cp "$REPO/packages/app/runs.mjs" "$DEST/progress.mjs"
chmod +x "$DEST/runs.mjs" "$DEST/progress.mjs"
echo "installed live-progress skill -> $DEST"
# `runs` as a real command, so the examples in SKILL.md can be typed as written
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
ln -sf "$DEST/runs.mjs" "$BIN/runs"
echo "linked $BIN/runs -> $DEST/runs.mjs"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "note: $BIN is not on PATH here; add it, or call $DEST/runs.mjs" ;; esac
"$DEST/runs.mjs" url
