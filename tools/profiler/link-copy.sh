#!/bin/sh
# Make a git worktree runnable as an isolated copy of Orbit: node_modules linked from the main
# checkout, no personal files. Usage: link-copy.sh <worktree> [<main checkout>]
set -e
W="$1"
M="${2:-$(cd "$(dirname "$0")/../.." && pwd)}"
for p in . packages/laikaorbit packages/app packages/cli packages/graph packages/mcp packages/shell; do
  if [ -d "$M/$p/node_modules" ] && [ ! -e "$W/$p/node_modules" ]; then ln -s "$M/$p/node_modules" "$W/$p/node_modules"; fi
done
echo "linked $W"
