# Rubric Second Brain — Research Notes

Source: **Jay E / RoboNuggets** (youtube.com/@RoboNuggets). Captured 2026-09-16.

## Primary sources

| Video | ID | Length | What it covers |
|---|---|---|---|
| Build your Ultimate Second Brain with Claude Fable 5 | `VoKiKvgpk78` | 13:41 | The graph UI + the `brain.js` retrieval engine |
| The NEW Agentic OS standard for Claude 5 Models | `8NSyI-npJCU` | 21:39 | The **ARMS** framework, 3 maturity levels per layer |
| Build a Self-Improving Claude Knowledge Base with ONE Prompt | `K2BpNt3UBOQ` | 12:35 | Karpathy LLM-wiki pattern, 5 building blocks |

Product page: https://www.getrubric.app/ — "The command centre for AI agents". Free to RoboNuggets
(Skool) members, 0 npm dependencies, one copy-paste install prompt. **Not open source.**

Transcripts: `research/notes/transcript-*.txt`. Frames: `research/frames/`. Contact sheets: `research/screenshots/contact-*.jpg`.

---

## 1. The ARMS framework

"Give Claude arms — give it its own workspace." Four layers, learned **bottom-up**:

| Layer | What it is | Graph colour |
|---|---|---|
| **A**pplications | MCP connectors / CLIs / APIs the agent can reach | blue |
| **R**outines | scheduled tasks (cron, cloud agents) | yellow |
| **M**emory | the workspace of files + router files | purple |
| **S**kills | `SKILL.md` folders with rich references | orange |

Each layer has three maturity levels:

- **Skills** — L1 prebuilt Anthropic skills → L2 skills with rich reference files (SKILL.md acts as a *router* to
  `brand.html`, examples, etc.) → L3 headless invocation via `claude -p` so skills fire from dashboards/cron.
- **Memory** — L1 a pile of files → L2 **router files** (`CLAUDE.md` → per-department `CONTENT.md`, `BUSINESS.md` …)
  → L3 visual graph over the whole thing.
- **Routines** — L1 Claude Desktop routines (die when the laptop sleeps) → L2 always-on cloud agent (he uses
  Hermes + **Syncthing** to mirror skills/memory to the cloud box) → L3 Claude Code on a VPS, one agent, no sync.
- **Applications** — L1 click connectors in the desktop app → L2 a `search-connectors` skill that finds official/community
  MCP/CLI/API connectors and installs them → L3 build your own connectors and micro-apps.

His stated numbers: **60,601 files** indexed in the workspace; **35,466** in the memory folder alone.

## 2. The five building blocks (the actual knowledge base)

From the Karpathy LLM-wiki video — this is the part that is genuinely reproducible:

```
knowledge-base/
├── CLAUDE.md          # the operating manual — rules the whole brain runs on, agent-maintained
├── raw/               # BLOCK 01 dumping ground, messy by design
│   └── pages/         # content pages live here
├── wiki/              # BLOCK 02 index + log + processed ONLY (no content)
│   ├── index.md       # one line per page + short summary, grouped by category
│   ├── log.md         # datestamped ledger of what was added/removed
│   └── processed.md   # which raw files have already been folded into the wiki
└── outputs/           # BLOCK 03 PDFs, decks, apps it generates
```

Plus **Block 05: the Dream Sequence** — a scheduled lint/health check ("while you sleep, it audits itself —
flags contradictions, fills gaps, re-links and heals the whole brain"). Ingests new `raw/`, diffs against
`processed.md`, folds into `wiki/`, flags contradictions / stale claims / duplicates / orphans.

Verbatim header of his `wiki/index.md`:

> `# Index — Table of Contents`
> The catalog of everything in this wiki. One line per page with a short summary, organized by category.
> Updated on every ingest. **Read this first when answering a question, then drill into pages.**
> **Note:** content pages live in `raw/pages/`; this folder (`wiki/`) holds only index/log/processed.
> `[[wikilinks]]` resolve by name.

## 3. `brain.js` — the retrieval engine (the real IP)

A **zero-LLM, deterministic** recall path. `brain.js` contains no LLM calls at all, by rule. Seven steps:

1. **You ask a plain question.** `node brain.js recall "which tts voice do we use"`.
2. **`words()`** — lowercase, strip punctuation, drop a ~45-word stop list. `"which tts voice do we use"` → `tts, voice`.
   Fixed rule, not a model decision, so the same question always cleans the same way.
   *(Noted bug they hit: `"one"` was matching inside `"Done"` — needs word-boundary matching.)*
3. **Score every candidate without opening any file.** Three lists checked in parallel:
   every line of the memory catalogue, every memory *filename*, and a built-in **topic map**
   (`voice → TOOLS.md`). Each match adds points; highest score wins. Pure arithmetic on names and index lines.
4. **Open only the winner.** Top-k defaults to **1**; the file is read once, then sliced.
5. **`sliceOf()`** — find the `##` heading whose exact word tokens match the subject → keep a **26-line** section.
   Fallback: a window around the densest line, **−10/+16**.
6. **Follow one pointer, never more.** Regex the `.md` path out of the slice, skip index files, jump to the best
   `##` heading (titles banned), serve **45 lines**. **Hard cap: 1 hop.**
7. **`buildAsk()`** — pack question + evidence + one instruction ("quote the line, name the file"),
   cap evidence at **9KB**, copy to clipboard.

Reported bill for the whole prep phase: **~20KB read · ~5ms · 0 tokens · $0.00**.
Only step 7's output goes to the model. Measured end-to-end: **30k tokens vs 50k** for default Claude Code
(~40% saving) and visibly faster, because default CC burns model turns on `grep`/`glob` and reads whole files.

## 4. The graph UI

`RUBRIC SECOND BRAIN` — force-directed graph, served locally (the wiki writeup of a third-party install says
`localhost:5210`, systemd unit `rubric-brain.service`, module at `/opt/rubric-brain/brain.js`).

Controls observed: search-all-files box · **Layout**: Force / Circle / Hex / **Rings** · **View**: Departments / Folders ·
ring-spin slider · file-name toggle · link-springs + circle/hex size sliders · Expand all / Collapse all / **Bake settings**.

Node inspector panel: type badges (`Content`, `Claude only`), size + mtime, **View here / Open on device / Copy path /
Fly to / Remove**, and a **CONNECTIONS** list with link counts (`slink ×9`, `link ×4`, `spoke`).

`CLAUDE.md` sits at the centre; departments (BUSINESS, CONTENT, COMMUNITY, PERSONAL, PRODUCT) are rings around it.
He is explicit that **the graph is only ~20–30% of the value** — the other 70% is retrieval speed and token cost.

## 5. Router file anatomy — the highest-leverage detail

His `CONTENT.md` (35KB) is *not* a folder listing. It is a **task-ordered playbook** with numbered stages
and status dots, and under each stage, typed pointers with one-line descriptions:

```
2 — select idea  🟢
just go do something
  Skills:    master-content-selection (Eddo) — surfaces best from backlog
  Files:     shared/data/tasks.json — all C- prefixed tasks (epic: "Content")
  Files:     shared/projects/ — folders prefixed C-XXXX-* are active video projects
  Reference: project_eddo_production_queue.md — current production queue

PRODUCTION
3 — research and write flow  🟢
notepad, cc to research
  Skills:    master-lesson — script lessons, hook research, structure
  Skills:    notebooklm / graphify / read-tweet / youtube-summarize / watch — research inputs
  Files:     shared/projects/C-XXXX-*/script.md (or outline.md, hooks.md)
  Thinking:  core-content-notes.md — ccn trigger, hook patterns + canonical principles
  Reference: reference_kallaway.md — Kallaway methodology
  Rules:     feedback_au_english.md — AU spelling always
  Rules:     feedback_no_isnt_x_its_y.md — no "isn't X, it's Y"
```

Typed prefixes: **Skills / Files / Reference / Thinking / Rules**. This is what makes step 3 of `brain.js` work —
the router lines *are* the scoreable index.

## 6. Upstream sources he credits

- **qmd** (Tobi Lütke) — https://github.com/tobi/qmd — local hybrid search: BM25 (SQLite FTS5) + vector +
  Qwen3 reranker, all local via node-llama-cpp. ~900-token chunks, 15% overlap, AST-aware chunking for code,
  RRF fusion (k=60), position-aware blending. Ships an **MCP server** (`query`/`get`/`multi_get`/`status`).
- **gbrain** (Garry Tan, YC) — reference pattern to copy.
- **Graphify** (YC-funded) — builds connections between files/folders.
- **/last30days** (Matt Van Horn, Lyft) — skill that scrapes Reddit/X/YouTube/HN for current best practice.
- **Karpathy's LLM wiki** — the underlying spec: LLM incrementally builds and maintains a cross-linked
  markdown wiki instead of re-reading raw docs every time. *"Humans abandon wikis because the maintenance burden
  grows faster than the value. LLMs don't get bored, don't forget to update a cross-reference, and can touch
  15 files in one pass."*

## 7. Honest assessment

**What's genuinely good:** the deterministic pre-retrieval idea. Doing keyword scoring, section slicing and
one-hop pointer following in plain code — before the model is ever invoked — is a real architectural win, and
the measured 40% token saving is believable. The typed router-file convention is the thing that makes it work.

**What's oversold:** the graph. He says so himself (20–30%). It is a visualisation of a filesystem; it doesn't
make retrieval better.

**What's weak:** step 2/3 is bag-of-words with a stop list — no stemming, no synonyms, no embeddings. It works
because *his router files are meticulously hand-curated*. On a messier workspace, recall will fall off a cliff.
Top-k=1 with a 1-hop cap means a question spanning two documents gets a partial answer with no signal that it
did. And `brain.js` is Windows-coupled (`clip`) and clipboard-based rather than a tool the agent calls directly.
