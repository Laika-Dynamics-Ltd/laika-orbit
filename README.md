# Laika Orbit

**Your whole working day in one window: a live map of everything you know, Claude Code chats
side by side, a real browser, and your inbox and calendar, all running on your own machine.**

Laika Orbit is powered by **1brain**, a retrieval engine that answers questions about your
files without calling a model. Ask a question and you get back the exact section that answers
it and the file it came from, in about a millisecond, with 97.8% fewer tokens than an agent
grepping and reading whole files ([`bench/RESULTS.md`](bench/RESULTS.md)).

> **Status: macOS preview.** Built and used daily on macOS. The engine, CLI and MCP server run
> anywhere Node runs; the desktop app is macOS first, Linux best effort, Windows untested.

## What's in it

| | |
|---|---|
| **The map** | Every indexed file, repo, chat and routine as a 3D ring you can fly through. `/` searches, `i` opens the index settings, `?` lists every key. |
| **Claude panel** | Claude Code chats in VS Code-style groups: split, drag, or four in a grid. Chats for a single repo or a whole project folder, a task track beside each chat, sub-agent cards, several Claude accounts at once, and chats that come back by themselves after a crash or restart. |
| **Browser** | `b` opens real Chromium tabs, one storage profile per account, so work and client logins sit side by side. Chrome-style tabs, and Chrome extensions from the Web Store (desktop app only). |
| **Widgets** | Inbox (Gmail), calendar (any iCal feed), agents, routines and skills on the side rails. Each is a JSON file in `brain/widgets/` you can edit or add to. |
| **1brain** | The engine underneath: an inverted index over your folders, seven pure steps, no model call. Also a CLI and an MCP server, so Claude Code calls `recall` instead of grepping. |

## Requirements

- **Node 22.18 or newer** (runs TypeScript directly) and **pnpm 10**. `mise install` sets up both.
- **macOS** for the desktop app. `pdftotext` for PDF indexing: `brew install poppler`.
- **Your own Claude account** for chats. Sign in from the Claude panel; it runs Claude Code's own
  login, and Laika Orbit never sees or stores your credentials. Until then, a demo agent runs
  offline so you can try the panel.

## Quick start

```bash
git clone https://github.com/Laika-Dynamics-Ltd/laika-orbit.git && cd laika-orbit
mise install && pnpm install

cd packages/app && node server.mjs    # the app at http://localhost:5200
pnpm shell                            # (from the root) the same app in its own window, with real browser tabs
```

The first run indexes this folder only. Add your own folders (notes, projects, documents) from
the index settings (`i`); nothing outside the repo is read until you add it.

### The engine on its own

```bash
node packages/cli/src/index.ts index                          # build the index
node packages/cli/src/index.ts recall "which TTS voice do we use"
node packages/cli/src/index.ts lint                           # router-file diagnostics
```

Claude Code picks up the MCP server from [`.mcp.json`](.mcp.json) when you open this folder.
`BRAIN_ROOT` points any of it at another corpus:

```bash
cd packages/app && BRAIN_ROOT="$HOME/Documents" PORT=5201 node server.mjs
```

## Configuration

Everything is optional. Copy [`.env.example`](.env.example) to `.env.local` for the feeds:

| | |
|---|---|
| **Calendar** | `CALENDAR_ICS_URLS`: your calendar's secret iCal address. Several: comma-separated. |
| **Inbox** | `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from your own Google Cloud OAuth client, then connect from the widget. The refresh token goes in the macOS Keychain. |
| **Claude accounts** | Added from the Claude panel, listed in `brain/agents.local.json`. |
| **Connectors** | The Claude connectors your accounts have, for the settings panel and the map: `brain/connectors.local.json`, as `[{ "id", "name", "via", "live" }]`. |

Files ending `.local.json`, `.env.local`, and the settings the app writes as you use it are
gitignored, so pulling updates never conflicts with your setup.

## Privacy and security

- **Local only.** The server listens on `127.0.0.1` and refuses requests with any other `Host`,
  and cross-site requests that would change something are refused. There is no login, so don't
  expose the port.
- **What leaves your machine:** chats go to Anthropic through Claude Code under your account; the
  inbox and calendar widgets fetch from Google with the credentials you configure. After each
  chat turn a short summary is written by a small model on the same account; `LAIKA_BRIEFS=0`
  turns that off.
- **Chats ask before acting.** New chats start in Claude Code's default permission mode; you
  choose when to allow more.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## How recall works

Seven steps, each a pure function with its own tests, none of them a model call:

1. **`tokenise`**: lowercase, strip punctuation, drop a stop list, matched on word boundaries so
   `everyone` and `milestone` survive.
2. **`score`**: sum weights across the inverted index. No file is opened yet.
3. **`select`**: top 5 with a confidence margin; two sources come back when the result is
   ambiguous, and say so.
4. **`read`**: open only the winner.
5. **`sliceOf`**: keep the `##` section whose heading matches, or a window around the densest line.
6. **`hop`**: follow at most **one** pointer out of that slice. Hard cap, enforced by test.
7. **`buildAsk`**: question, evidence, one instruction. 9KB cap.

Recall quality is bounded by your router files, not the engine. `brain/routers/` holds typed
pointer files that act as a curated index:

```
- Skills:    script-writing — full script generation
- Files:     shared/projects/C-*/script.md — in-progress scripts
- Rules:     brain/rules/feedback_au_english.md — AU spelling always
```

Write descriptions the way a question is phrased. Pointed at a folder with no routers, 1brain is
a very fast filename and content search; with them, it answers.

## Packages

| | |
|---|---|
| **`core`** | The engine: indexer and the seven-step recall path. **Zero runtime dependencies.** |
| **`cli`** | `1brain index · status · lint · recall · ask` |
| **`mcp`** | Three tools over stdio for Claude Code. |
| **`app`** | The Laika Orbit app: one Node server with Vite, the core API, the Claude chat host and the feeds. |
| **`shell`** | The Electron desktop app, with native browser tabs. `pnpm shell`; `pnpm shell:app` builds a macOS app into `/Applications` and adds it to the Dock. |
| **`graph`** | The renderer's scratch package. Not shipped. |

## Development

```bash
pnpm typecheck && pnpm test && pnpm lint      # the gates CI runs
pnpm test:e2e                                 # browser suite (npx playwright install chromium first)
node bench/scoring.bench.mjs                  # scoring throughput
node bench/token-delta.mjs                    # the token-saving claim
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Plan and gates: [`PLAN.md`](PLAN.md), [`STACK.md`](STACK.md);
still open: [`BACKLOG.md`](BACKLOG.md).

## Licence

MIT © Laika Dynamics Limited. See [LICENSE](LICENSE) and
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md): the Chrome extension support uses a GPL-3.0
library, and chats run Anthropic's Claude Agent SDK under Anthropic's terms.

Laika Orbit runs Claude Code. It is not made by, affiliated with, or endorsed by Anthropic.
