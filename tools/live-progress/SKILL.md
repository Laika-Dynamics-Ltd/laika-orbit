---
name: live-progress
description: Report a chat's live progress — lanes, jobs, artefacts, ETA — as a run on the one standard Laika Orbit runs page at /runs (formerly /progress), which flags stalls and keeps finished runs as history. Use by default, without being asked, whenever work will run longer than about five minutes or runs in parallel. That covers fanning out subagents, workflows, gauntlet loops, builds, renders, bakes, captures, benchmarks, offloads to other machines, batch jobs and multi-step migrations. Also use when the user asks for a progress tracker, dashboard, status page, ETA, a side-by-side comparison of what a run produced, or "let me watch it". Never build a separate tracker page or server for this.
---

# Runs — the live progress skill

Every chat reports to **one** page: Laika Orbit's `/runs` (http://localhost:5300/runs on the stable
app, :5200 on dev). `/progress` goes there too. Joe keeps that one URL open to watch every chat at
once, grouped by project. It flags any run that goes quiet.

**Do not build your own progress page, dashboard server or monitor.** Chats used to (localhost:7340,
a gauntlet monitor on :5300 that collided with the app itself, one-off comparison sheets), and those
trackers stalled, clashed or died with the chat. Reports here are plain files written with an atomic
rename, so they survive app restarts and still work when the app is down. If Joe asks for a live
view of anything, report here and give him the URL.

## One concept: a run

A **run** is work with parts, minutes to hours, worth watching, producing artefacts.

| | |
|---|---|
| **lanes** | parallel tracks — builders and a critic, test shards, this Mac vs box1 |
| **jobs** | items inside a lane, each with a state, a start and a duration |
| **artefacts** | images, pages and logs the run produced, comparable side by side |
| **verdicts** | gauntlet only: candidate vs reference, who won, in which slot order, why |
| **waves** | gauntlet rounds; a plain run never sets one and never shows them |

Plain progress uses lanes, jobs and artefacts. A gauntlet adds waves, candidates and verdicts to
the *same* run — there is no second thing to build or watch.

## The command

`runs`, a zero-dependency command that runs from any directory. `install.sh` links it into
`~/.local/bin`, so the examples below work as written. If a shell can't find it, call the file
itself: `~/.claude/skills/live-progress/runs.mjs`. Don't hold that path in a shell variable: variables
do not carry over between Bash calls, and `$R` with arguments does not split in zsh.

| When | Run |
|---|---|
| Work starts | `runs start <run> --title "What this run does" [--lanes build,check] [--eta 40m] [--kind site-rebuild] [--stall 10]` |
| A lane starts or moves | `runs lane <run> <lane> --name "Readable name" --status running --pct 40 [--eta 12m] [--note "what it's on now"]` |
| Counted work | `runs lane <run> <lane> --done 41 --total 120` |
| Work on another machine | `runs lane <run> <lane> --where box1` |
| Items inside a lane | `runs job <run> <lane> <job> --status done` (the lane's % follows its jobs) |
| Something the run produced | `runs artifact <run> <path> [--label "..."] [--compare hero-shot] [--wave 2] [--source "what made it"]` |
| Waiting on Joe | `runs lane <run> <lane> --status blocked --note "Needs your OK on X"` |
| Still alive, nothing new | `runs beat <run>` |
| Finished | `runs finish <run> [--status failed\|cancelled] --note "result in one line"` |
| Check what the page shows | `runs show <run>` · `runs url` · `runs history <kind>` |

- **run**: one per piece of work, short and unique, e.g. `site-rebuild-0918`. **lane**: one per
  parallel track, subagent or phase. **job**: one per item (a page, a shot, a test file).
- Status: `queued | running | blocked | done | failed | skipped`.
- `--eta` takes `15m`, `1h30m`, `90s` or a time. Give one when you can honestly estimate it.
- `--kind` groups runs that are the same sort of work. Once two of a kind have finished cleanly, a
  new run with no other estimate takes its ETA from their median, and the page says so. An ETA is
  always given, measured or projected — never guessed.
- The chat's session id and process are recorded automatically. The page shows which chat a run
  belongs to, and a run whose chat exits without finishing is **ended**, not left running for ever.

## Artefacts

An artefact is evidence, so it has to come from **the thing being built** — the built site, the
game, the rendered file — and never a screenshot of Laika Orbit itself. Say what made it with
`--source`; a source that looks like Orbit (`localhost:5200`, `:5300`) is marked on the page rather
than passing as the work.

`--compare <group>` puts artefacts side by side in the run's compare view: ours and the bar, before
and after, two candidates. Same group name, one frame each, same size.

## Stalls

A **running** lane with no report for the stall limit (default **10 minutes**, `--stall N` on the
run or lane) is flagged **stalled**, and the page names the lane that went quiet. So is a run that
goes quiet that long between lanes. `blocked` is never flagged, because it means waiting on a
person. So:

1. **Report at every real step, and at least every few minutes on long steps.** A quiet running
   lane reads to Joe as a broken run.
2. Before a single long wait (a render, a bake, a `sleep`/Monitor), set `--eta` or raise that lane's
   `--stall` to cover it, or `beat` while you wait.
3. When a subagent or workflow owns a lane, tell it the exact `lane`/`job` commands to run. One
   writer per lane is best, but concurrent writes are safe.
4. Always `finish` (done, failed or cancelled), including after errors and when the user stops the
   run. Finishing is also what files the run in history, which is what sharpens the next ETA.

## Rules

- Notes are one short line about what is happening *now*, not a log.
- Never put secrets, tokens or personal data in titles, notes or artefact labels.
- In a Workflow script, report from the orchestrator between phases, or have each agent's prompt run
  its own `lane` command.
- Clean up test runs: `runs rm <run>`. Old finished ones: `runs prune --days 7`.
- The source is `packages/app/runs.mjs` in the Laika Orbit repo. This skill carries a copy, installed by
  `tools/live-progress/install.sh`, which also installs it under the old name `progress.mjs` with
  the old verbs, so a chat mid-run does not break. The HTTP API (`POST /api/runs/<run>/lanes/<lane>`,
  JSON body) is there for code that cannot shell out.
