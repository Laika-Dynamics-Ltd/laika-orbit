# Merge train and work ledger: the contract

Many chats work in parallel, sometimes on the same files. Every finished slice flows into **local**
`main` on its own. Pushing stays with the user.

## Which worktree a chat owns

A chat's cwd is usually the repo's main checkout, but it works in a worktree of its own. The host
works out that worktree from the chat's own tool events: the paths it edits and writes, and the
folders it `cd`s into. It matches them against `git worktree list` for the chat's repo, and the
most recent match wins. When nothing matches, the chat's cwd is its worktree. Marking a slice ready
with an explicit worktree pins it.

## The ledger: one row per chat, taken from git

```
ledger: {
  repo, root,               // the repo's name and its main checkout
  worktree, branch,         // where the chat works; branch null when detached
  base: 'main',
  behind, ahead,            // commits relative to local main
  commits: [{ sha, title, at }],   // ahead of main, newest first (at most 20)
  dirty: { count, oldestAt },      // uncommitted files; oldestAt = mtime of the oldest changed file
  lastCommitAt,             // the branch tip's commit time
  state: 'merged' | 'ready' | 'checking' | 'failed' | 'conflict' | 'not-ready' | 'none',
  ready: { sha, at, via: 'trailer' | 'mark' } | null,
  overlaps: [{ file, chat, repo }],        // other chats with uncommitted or unmerged changes to the same file
  train: { status, at, output? } | null,   // the last thing the train did with this chat's slice
}
```

- `merged`: the branch has nothing ahead of main (and a clean tree).
- `ready`: marked ready at its tip commit and waiting for the train.
- `checking`: in a batch the train is checking now.
- `failed`: the train's check went red on this slice; `train.output` has the tail.
- `conflict`: the slice does not merge onto main; `train.output` has the files and hunks.
- `not-ready`: commits ahead, or dirty, and not marked ready.
- `none`: the chat's worktree is the main checkout, with nothing to merge.

The ledger rides on the cockpit stream's `row` frames (`GET /api/control/agent/fleet/events`),
and `fleet_list` returns it on every chat card. The model's own status line is never an input.

## The ready marker

A slice is ready when its chat says so, in either of two ways:

- a commit trailer on the branch tip: `Ready: yes`
- a mark on the current tip: the chat bar's **Mark ready** button, a conductor's `fleet_ready`, or
  `POST /api/control/agent/train/ready { chat, worktree? }` (worktree pins where the chat works).

Every chat is told this in its system prompt (merge-train.mjs `WORK_PROMPT`).

Ready means: **committed** (clean tree), **typechecked**, and **the affected tests pass**. The train
re-checks all of it on the merged result, so a wrong mark costs one red run, not a broken main.
A new commit on top of a ready tip without the trailer clears the mark.

## The train

Host code in the chat host, one per repo. It:

1. takes ready slices in the order they were marked;
2. merges a batch of them (up to 4, `--no-ff`, one merge commit per slice) onto local main in the
   repo's own integration worktree (`~/.laika/train/<repo>-<hash>`, detached, reset each time);
3. runs the repo's light check;
4. if green, fast-forwards local main (`git merge --ff-only` in the main checkout);
5. if red, bisects the batch to find the culprit, lands the rest, and sends the culprit's chat the
   failing output;
6. on a merge conflict, sends the chat whose slice came second the exact files and hunks.

The check comes from the repo's `.laika/train.json`: `{ "check": "<shell command>", "timeoutMin": 20 }`.
It runs in the integration worktree, with `TRAIN_BASE` (main before the batch) and `TRAIN_FILES` (the
changed files, newline-separated) set. Without that file:

- a repo with one `<name>-check.sh` warden script at its root: `./<name>-check.sh --fast`, compile and
  tests, with an hour's timeout (a Unity project's first check in a fresh integration worktree imports
  its whole Library);
- a repo with a package.json: `pnpm install --offline`, `pnpm typecheck` and `vitest related` on the
  changed files, whichever of those it has;
- anything else: merging cleanly is the check.

It never pushes, never touches a remote, and never rewrites a chat's branch.

## Events

- `event: train` on the cockpit stream: `{ at, repo, phase, batch: [{ chat, branch, sha }], … }`,
  phase `merge | check | bisect | landed | failed | conflict | blocked | waiting | idle`
  (`landed` adds `sha`; `failed` adds `output`; `conflict` adds `files` and `against`).
- Each batch is also a run on /runs (kind `merge-train`): a lane per slice, the check, the fast-forward.
- `event: rebuild` on the cockpit stream: `{ at, state: 'building' | 'ready' | 'failed', sha }`.
- Messages to chats start with `[from the merge train] `, with the file and the other chat's id for
  an overlap, or the check's output for a red slice.

## Spawns

At most 8 conductor-spawned chats at once. A spawn is held, and says why, when this Mac's load, or
box1's, is high, or the away budget is low.

## Rebuild

When local main moves, the stable app is rebuilt in the background (`make-stable.mjs`), held while
the Mac is busy. The chrome then shows a quiet "new version ready, restart" prompt. It never
restarts on its own.
