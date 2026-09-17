# laika-1brain — build plan

A deterministic, zero-token retrieval engine over a markdown knowledge base, plus a three.js
graph over the whole workspace. Local-first, with the storage layer kept swappable so it can
move to a Laika-wide server later.

Research this is based on: [`research/notes/findings.md`](research/notes/findings.md).

## Decisions taken

| | |
|---|---|
| **Scope** | Local first. Index/storage behind an interface so a hosted backend drops in without a rewrite. |
| **Retrieval** | Port the `brain.js` approach — keyword → score → slice → one-hop. No LLM in the recall path. |
| **Graph** | Full three.js build, GPU-instanced, target 60k+ nodes at 60fps. |

## Three things we do differently

1. **MCP tool, not clipboard.** Theirs ends by copying a prompt to the Windows clipboard. Ours exposes
   `recall` / `get` / `status` over MCP so Claude Code calls it directly mid-conversation. This is the
   difference between a demo and something you actually use.
2. **Word-boundary matching from day one.** They shipped a bug where `"one"` matched inside `"Done"`.
   Tokenise on `\b`, not substring.
3. **Honest confidence.** Their top-k=1 + 1-hop cap silently returns partial answers. Ours returns a
   score margin, and when the top two candidates are within a threshold it returns both and says so.

---

## Architecture

```
laika-1brain/
├── packages/
│   ├── core/          # indexer + recall engine. Zero runtime deps. The actual IP.
│   ├── cli/           # 1brain index | recall | ask | lint | serve
│   ├── mcp/           # MCP server wrapping core — what Claude Code talks to
│   └── graph/         # three.js viewer (Vite + TS)
├── brain/             # the knowledge base itself
│   ├── CLAUDE.md      # operating manual
│   ├── routers/       # BUSINESS.md, CLIENTS.md, ENG.md, ... the scoreable index
│   ├── raw/           # dumping ground
│   ├── wiki/          # index.md, log.md, processed.md
│   └── outputs/
└── research/          # already captured
```

`core` exposes a `Store` interface (`listDocs`, `readDoc`, `readIndex`) with a `LocalFsStore`
implementation now. A `RemoteStore` later is the only thing that changes.

---

## Phase 1 — Knowledge base skeleton + router convention

The engine is only as good as the router files, so this comes first.

- `brain/` scaffold per the 5-block pattern (`CLAUDE.md`, `raw/`, `wiki/{index,log,processed}.md`, `outputs/`).
- **Router file spec.** Typed pointer lines, one per row, machine-parseable:
  ```
  - Skills:    script-writing — full script generation
  - Files:     shared/projects/C-*/script.md — in-progress scripts
  - Reference: reference_kallaway.md — Kallaway methodology
  - Rules:     feedback_au_english.md — AU spelling always
  - Thinking:  core-content-notes.md — hook patterns + canonical principles
  ```
  Grouped under numbered stages. Write the parser and the spec together — the format must be strict
  enough to score against and loose enough to hand-edit.
- A `topics.yml` topic map (`voice → TOOLS.md`) — this is the third scoring list and it's hand-curated.

**Done when:** a parser turns every router file into a flat list of `{type, path, description, stage}` records.

## Phase 2 — `core`: the index

- Walk the workspace, respect `.gitignore` + an ignore list, hash contents.
- Build three scoreable lists: **catalogue lines** (from router files), **filenames**, **topic map**.
- Persist to a single `brain-index.json` (swap for SQLite if it gets slow — measure first).
- Incremental: re-index only changed hashes.

**Target:** full index of 60k files in under 30s; incremental under 500ms.

## Phase 3 — `core`: recall (the port)

Seven steps, mirroring theirs, each a pure function with its own tests:

1. `tokenise(q)` — lowercase, strip punctuation, drop stop list, **word-boundary matched**.
2. `score(tokens)` — points across the three lists. Returns ranked candidates **with margin**.
3. `select()` — top-1 normally; top-2 when margin is below threshold.
4. `read()` — open only the winner(s).
5. `sliceOf()` — `##` heading whose tokens match → that section (cap ~26 lines).
   Fallback: window around densest line, −10/+16.
6. `hop()` — regex a `.md` path out of the slice, skip index files, jump to best `##`, serve ~45 lines.
   **Hard cap 1 hop.**
7. `buildAsk()` — question + evidence + "quote the line, name the file". 9KB evidence cap.

**Targets:** zero LLM calls, zero tokens, p95 under 10ms, evidence ≤ 9KB.
Golden-file tests: a fixture brain + ~30 question/expected-file pairs, asserted on every commit.

## Phase 4 — MCP server

Wrap `core` as MCP tools: `recall(question)`, `get(path)`, `status()`. Register with Claude Code.
This is where the token saving actually lands — Claude stops using `grep`/`glob` and calls `recall`.

**Benchmark here**, the same way he did: same question against a plain session and a 1brain session,
compare `/context`. We should reproduce something near the 50k → 30k result. If we don't, the router
files are the problem, not the engine.

## Phase 5 — three.js graph

State-of-the-art means the rendering approach has to be right from the start:

- **Instanced rendering.** One `InstancedMesh` for nodes, a single `LineSegments2` batch for edges.
  60k individual meshes will not work; 60k instances will.
- **Layout is baked, not live.** Run force layout (`ngraph.forcelayout` or d3-force-3d) in a Web Worker,
  write positions to a typed array, persist it. The viewer reads baked positions and renders immediately.
  "Bake settings" in their UI is exactly this — steal it.
- **Layouts:** Force / Rings / Hex, matching theirs. Rings = departments as concentric shells around `CLAUDE.md`.
- **LOD.** Labels only within a distance threshold and only above a screen-space size; SDF text atlas,
  never DOM nodes. Frustum cull aggressively.
- **Picking** via GPU colour-ID buffer, not raycasting against 60k objects.
- **Inspector panel:** type badges, size + mtime, connections list with link counts,
  Open on device / Copy path / Fly to. Camera `flyTo` with eased tweening.
- **Search** across all files, filtering the instance buffer rather than rebuilding the scene.

**Targets:** 60fps at 60k nodes on an M-series Mac, first paint under 2s, under 10s on reload.

## Phase 6 — Dream sequence

A scheduled lint pass: ingest new `raw/`, diff against `processed.md`, fold into `wiki/`,
flag contradictions / stale claims / duplicates / orphans, append to `log.md`.
This one *is* an LLM job — it's synthesis, not retrieval. Runs nightly, not in the query path.

---

## Sequencing

Phases 1–4 are the value and are largely independent of Phase 5. I'd ship the engine and MCP server
first, benchmark it, and only then build the graph — that way the graph renders a knowledge base that
already works rather than one we're still designing.

## Risks worth naming now

- **Bag-of-words recall is brittle.** No stemming, no synonyms. It works for him because his router files
  are meticulously curated by hand. If our router files are thin, recall degrades quietly. Mitigation: the
  golden-file test suite catches regressions, and the score margin surfaces low-confidence answers instead
  of hiding them. If it proves insufficient, a semantic fallback is an additive change, not a rewrite.
- **Router-file maintenance is real work.** The dream sequence helps but does not eliminate it.
- **60k nodes is a genuine graphics problem.** If the instanced/baked approach slips, this phase can
  consume the whole project. It's sequenced last for that reason.

---

# Addendum — Hyperframes

Added after the initial plan. Research: [`research/notes/findings-hyperframes.md`](research/notes/findings-hyperframes.md).
Working copy of their kit: `research/hyperframes-helper/`.

**This is a different problem from the second brain** — video production, not retrieval — but it belongs
in the same workspace as the **Skills** layer of ARMS, and it's the best worked example of the
"rich reference skill" pattern we're copying for router files.

Critically: **it's fully open source and needs no reverse-engineering.** HeyGen's Hyperframes is
Apache 2.0 and runs entirely locally; RoboNuggets' helper kit is public under CC BY 4.0. Unlike Rubric,
we can just use this today.

## Recommendation: adopt, don't rebuild

1. **Use the kit as-is first.** `npx hyperframes@latest init`, copy their skill into `.claude/skills/`,
   make one real Laika video. The 16 lint gotchas alone are worth hours — no reason to rediscover them.
2. **Then fork it into a Laika skill.** Same structure, our content:
   - `templates/recipes.md` → Laika brand recipes instead of RoboNuggets pixel-art icons
   - a Laika `composition-template.html` carrying our fonts, colours and lower-thirds
   - keep `silence-cut.sh` / `transcribe-whisper.py` / `cut-retakes.py` essentially unchanged
3. **Keep the two gates.** The `script-review.html` (approve cuts before re-encode) and the storyboard
   HTML (iterate on the plan, ~1 min, not the render, ~15 min). These are the whole reason the
   pipeline is affordable.

## Three ideas to steal into 1brain proper

These are domain-independent and belong in the main build, not just the video skill:

- **Storyboard-before-artefact.** Cheap, reviewable plan first; expensive artefact second. Applies
  directly to the **dream sequence** (Phase 6) — it should propose a diff for review before rewriting
  the wiki, not silently rewrite it.
- **The approve-gate HTML.** A side-by-side of current vs proposed with a numbered change table is a
  genuinely good review UI. Reuse it for dream-sequence output.
- **BIT + `calibrate`.** Build → Integrate → Tune, with a `calibrate` skill that at session end
  self-analyses and proposes bullet-point edits to the skill and memory files. **This is the highest-value
  transferable idea in any of the four videos** — it's the mechanism by which the second brain actually
  self-improves, and it's cheap to build. Worth adding as **Phase 4.5**, right after the MCP server,
  because it's what keeps our router files current, and stale router files are the number-one risk to
  recall quality named in the main plan.

## Revised sequencing

| Phase | |
|---|---|
| 1–3 | Knowledge base + index + recall engine |
| 4 | MCP server, then benchmark 50k → 30k |
| **4.5** | **`calibrate` skill** — keeps router files current, closing the main quality risk |
| 5 | three.js graph |
| 6 | Dream sequence, with a storyboard-style approve-gate |
| **Parallel, any time** | **Hyperframes**: adopt the kit, fork to Laika branding. Independent of everything above. |
