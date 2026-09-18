---
name: profiler
description: Profile the Laika Orbit desktop app live from outside it — CPU and memory per process (window renderer, GPU, server, chats), server response time, with a page at :5491, 60 s benchmarks that compare against a baseline, and a findings panel. Use when the user asks to profile Orbit, asks why the app or the fan is loud, asks where its CPU or memory goes, wants a performance baseline, or wants to check whether a change made the app faster or slower. Also use for the before/after benchmark after any performance change to Orbit.
---

# Orbit profiler

One page, one sampler: `http://127.0.0.1:5491`. It watches the **running** Laika Orbit app from
outside — `ps` once a second, CPU from cumulative CPU-time deltas — so it touches no app state and
needs no debugger port. Don't build another dashboard; extend this one.

`profiler` below means `~/.claude/skills/profiler/profiler.mjs`. Write the full path in every
command; shell variables don't carry between Bash calls.

| When | Run |
|---|---|
| Start it and show Joe | `profiler open` (starts if needed, opens the tab) |
| Start without a tab | `profiler start` · stop: `profiler stop` · check: `profiler status` |
| Measure a state for 60 s | `profiler bench "map view · before fix" --secs 60` |
| Put conclusions on the page | `profiler findings --when "…" --item "<b>Headline.</b> detail" --item "…"` |

State lives in `~/.laika/profiler/`: `samples.ndjson` (every sample, survives restarts),
`runs.json` (benchmarks), `findings.json`, `ab.json`, `server.log`.
Env: `PROFILER_PORT` (5491), `PROFILER_APP_PORT` (5300, the app's own server, probed for response
time), `PROFILER_APP_MATCH` (regex for the app's main process), `PROFILER_DIR`.

## What the page shows

- **Tiles**: app CPU, app-window renderer, memory, server response, system load.
- **Charts**: CPU and memory stacked by component (renderers · GPU · Electron main · app server ·
  chats and their tools · utilities), with a crosshair tooltip. 1/5/10-minute windows.
- **Processes**: per process now/avg/peak CPU and memory. The largest renderer is the app window;
  anything under a Claude agent is labelled "Agent tool" and grouped with chats.
- **Benchmarks**: labelled 60 s runs with green/red deltas against the baseline (★ sets a
  different baseline). "App CPU" excludes chat agents, whose load depends on what the chats do.
- **3D map: before / after**: results from `ab.mjs`, if any.
- **What the profile shows**: the findings panel you write.

## Rules that keep the numbers honest

1. **60 s or longer.** With nothing changed, a 10 s run differed from the baseline by 25%.
2. **Same state both times** — same view, same chats open, same window size. Say so in the label.
3. **Check `System load`.** This Mac often runs Unity at 100%+; a run at load 15 is not comparable
   to one at load 7. Alternate before/after runs when load is drifting.
4. **Never screenshot or drive the real app** to "see" what it's doing: it shows Joe's inbox,
   calendar and chats. Profile it from outside, read the source, or use an isolated copy.
5. Report what you cannot see. From outside you get processes and threads, not which JavaScript
   function is hot — that needs a CPU profile from a debuggable copy.

## A/B on isolated copies (`ab.mjs`)

For "did this change help?", don't touch the live app. Two git worktrees (base commit vs the
change), each `NO_HMR=1 PORT=528x node packages/app/server.mjs`, then:

```
node ~/.claude/skills/profiler/ab.mjs "Baseline=5281" "Change=5282"
```

It drives headless Chromium on the real GPU at Joe's 3440×1440, waits past the map's idle
threshold, and measures a 60 s window per scenario: renderer + GPU process CPU (CDP
`SystemInfo.getProcessInfo`), frames drawn and WebGL draw calls per second. Results land in
`~/.laika/profiler/ab.json` and appear on the page. `SCENARIOS=inview,panel,unfocused` picks
scenarios; `WINDOW`/`SETTLE` change the timings.

Isolated-copy notes: symlink `node_modules` into each worktree, give each its own `PORT` (that
also gives it its own `~/.laika/agent-sessions-<port>.json`, so it can't touch Joe's real chats —
delete those files afterwards), and leave out personal `brain/widgets/*.json`.

## Shipping a change to the app Joe uses

`/Applications/Laika Orbit.app` runs `~/.laika/orbit-stable`. A merged change only reaches it
after `pnpm shell:stable`, then Joe quits and reopens Orbit. Benchmark the live app before and
after that, not just the isolated copies.
