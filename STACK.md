# Laika Orbit — tech stack & setup definition of done

Companion to [`PLAN.md`](PLAN.md). Every version below was resolved from the npm registry on
2026-09-16 and every runtime claim was verified on this machine, not assumed.

---

## Verified baseline (this machine, today)

| Tool | Version | Note |
|---|---|---|
| Node | **26.0.0** | native TS execution confirmed — `node file.ts` runs with no build step |
| pnpm | 10.33.0 | |
| Bun | 1.3.11 | present, not used — see *Runtime* below |
| git / gh | 2.50.1 / 2.89.0 | |
| ffmpeg | 9.0.1 | already needed for the Hyperframes track |
| python3 | 3.14.7 | only for `faster-whisper` in the Hyperframes track |

Two things confirmed by running them, both of which shaped the decisions below:

- **`node:sqlite` is built in and stable** — no experimental warning on Node 26.
- **FTS5 is compiled into it.** We don't need it for v1, but it means a full-text escape hatch
  exists with zero added dependencies if deterministic scoring proves insufficient.

---

## The feasibility benchmark (run before choosing anything)

I built a synthetic 60k-file workspace with 40k catalogue lines and scored real queries against it:

```
index build (60k files + 40k catalogue lines):  78ms
postings tokens:                                50,992
recall  p50=0.525ms  p95=0.662ms  p99=0.710ms  max=1.279ms
heap:                                           111MB
```

**This changes the design.** Three consequences:

1. **The p95 target in PLAN.md (10ms) was ~15× too conservative.** Revised target: **p95 < 2ms**.
2. **Use an inverted index, not list scanning.** Their `brain.js` walks the catalogue, filenames and
   topic map per query — O(corpus). A token → postings map built at index time makes recall
   O(query tokens). Same determinism, same zero tokens, strictly better scaling.
3. **We can afford to drop `top-k = 1`.** At 0.66ms there is no cost argument for returning one
   candidate and hoping. Score everything, return top-5 with a margin. This directly closes the
   "silently returns a partial answer" weakness flagged in the research.

The benchmark lives at `bench/scoring.bench.ts` and runs in CI as a regression gate.

---

## Stack decisions

### Runtime — Node 26, not Bun

Bun is installed and its startup is faster, which matters for a CLI invoked repeatedly. I'm still
choosing Node because:

- The recall path runs inside a **long-lived MCP server**, so process startup is paid once, not per query.
- "Team later" means a server, and Node is the lower-risk target there.
- `node:sqlite` is a Node built-in; leaning on it keeps `core` at **zero runtime dependencies**.

`core` is written to plain Web/Node-standard APIs, so it runs under Bun unchanged. If CLI startup
becomes annoying, `bun build --compile` is available without a rewrite. This is a reversible decision.

### Language & build

| | Choice | Version | Why |
|---|---|---|---|
| Language | TypeScript | **7.0.2** | native (Go) compiler — order-of-magnitude faster typecheck |
| Dev execution | Node native TS stripping | built in | no build step in the inner loop |
| Library build | **tsdown** | 0.23.0 | Rolldown-based, the successor to tsup. *Fallback: tsup 8.5.1 if it bites.* |
| Monorepo | **pnpm workspaces** | 10.33.0 | four packages doesn't justify Turborepo yet |
| Test | **Vitest** | 5.0.1 | |
| Lint + format | **Biome** | 2.5.13 | one tool replacing ESLint + Prettier |
| Hooks | **lefthook** | 2.1.14 | |
| CLI parsing | **citty** | 0.2.2 | tiny; `commander` 15 is the heavier alternative |
| Schema | **zod** | 4.6.5 | MCP tool schemas only — kept out of `core` |

TypeScript is `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`
(the last forces syntax compatible with native stripping — no enums, no parameter properties).

### Storage — `node:sqlite`, behind an interface

Zero dependencies, built in, and it gives us a real query layer the moment the index outgrows memory.
The whole point of the `Store` interface is that this is swappable:

```ts
interface Store {
  listDocs(): AsyncIterable<DocMeta>
  readDoc(id: DocId): Promise<string>
  readPostings(token: string): Int32Array | undefined
  stat(): Promise<IndexStats>
}
```

`LocalFsStore` (v1) → `RemoteStore` (team phase). Nothing above the interface changes.

### Graph package

| | Choice | Version |
|---|---|---|
| Renderer | **three.js** | 0.186.0 |
| Bundler | **Vite** | 8.3.0 |
| Labels | **troika-three-text** | 0.52.5 |
| Layout | **ngraph.forcelayout** | 3.3.1 |
| Camera | **camera-controls** | 3.1.2 |
| Post FX | **postprocessing** | 6.39.5 |
| DOM chrome | **React** | 19.3.0 |
| UI state | **zustand** | 5.0.15 |

**React drives the DOM chrome only — the inspector panel, search, filter controls. The three.js scene
is imperative and lives outside React.** Explicitly *not* react-three-fiber: at 60k instances the
reconciler is overhead on the exact path that has to stay at 60fps, and we want direct control of the
instance buffers. R3F is the right tool for scene-graph-shaped apps; this is a single instanced draw call.

Non-negotiables for hitting 60fps at 60k nodes:
- One `InstancedMesh` for nodes, one batched line geometry for edges.
- Layout computed in a **Web Worker** and **baked** to a persisted `Float32Array` — the viewer reads
  positions and paints immediately. (Their "Bake settings" button is exactly this.)
- **GPU colour-ID picking**, not raycasting.
- SDF labels via troika, gated on distance *and* screen-space size. Never DOM nodes.

---

## Repo layout

```
laika-orbit/
├── packages/
│   ├── core/      zero runtime deps. indexer + recall. the IP.
│   ├── cli/       laikaorbit index | recall | ask | lint | serve
│   ├── mcp/       MCP server over core (stdio transport)
│   └── graph/     Vite + three.js + React chrome
├── bench/         scoring.bench.ts — CI perf gate
├── brain/         the knowledge base itself
├── research/      done
├── STACK.md  PLAN.md
```

---

# Definition of done

Each gate is a command that exits 0. "It works on my machine" is not a gate.

## Gate 0 — Toolchain

- [ ] `mise` installed; `.mise.toml` pins node 26 + pnpm 10
- [ ] `node --version` → v26.x, `pnpm --version` → 10.x
- [ ] `node -e "require('node:sqlite')"` exits 0 with no warning

**Done when:** a fresh `git clone && mise install && pnpm install` produces a working tree on a second machine.

## Gate 1 — Repo scaffold

- [ ] pnpm workspace with the four packages; `core` has **zero** entries under `dependencies`
- [ ] `tsconfig.base.json` with the strict flags above; each package extends it
- [ ] `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm build` all exist and exit 0 on an empty repo
- [ ] lefthook runs `biome check --staged` + `typecheck` pre-commit
- [ ] GitHub Actions runs all four on push
- [ ] MIT `LICENSE` + `README.md` explaining what this is

**Done when:** CI is green on an empty scaffold, and `pnpm why -r <anything>` shows `core` importing nothing.

## Gate 2 — Router-file spec & parser

- [ ] `brain/` scaffolded: `CLAUDE.md`, `routers/`, `raw/`, `wiki/{index,log,processed}.md`, `outputs/`
- [ ] Router spec written down in `brain/CLAUDE.md` — typed lines: `Skills: | Files: | Reference: | Thinking: | Rules:`
- [ ] `parseRouter()` → `{type, path, description, stage}[]`
- [ ] Round-trip test: parse → serialise → byte-identical
- [ ] Malformed lines produce a **diagnostic with line number**, never a silent skip
- [ ] ≥ 3 real Laika router files written by hand

**Done when:** `laikaorbit lint` reports zero unparseable lines across `brain/routers/`.

## Gate 3 — Index

- [ ] Walks the workspace honouring `.gitignore` + `.orbitignore`
- [ ] Builds the inverted index (filenames w=3, catalogue w=2, topic map w=8)
- [ ] Persists via `Store`; incremental re-index on content hash
- [ ] `laikaorbit status` prints file count, token count, index age, staleness

**Targets — asserted in CI, not eyeballed:** cold index of 60k files **< 30s** · incremental **< 500ms** · index size **< 200MB**.

## Gate 4 — Recall

Each of the seven steps is a pure, separately-tested function.

- [ ] `tokenise()` — **word-boundary matched**. Regression test: `"one"` must NOT match `"Done"`.
- [ ] `score()` — returns ranked candidates **with a margin**
- [ ] `select()` — top-5, flagged low-confidence when margin < threshold
- [ ] `sliceOf()` — heading match → section; fallback densest-line window
- [ ] `hop()` — **hard cap 1**, enforced by test
- [ ] `buildAsk()` — 9KB evidence cap, enforced by test
- [ ] **Golden-file suite: ≥ 30 question → expected-file pairs over a fixture brain**
- [ ] **Zero LLM calls on the recall path — asserted by a test that fails if `fetch` is called**

**Targets:** p95 **< 2ms** · 0 tokens · recall@5 **≥ 90%** on the golden set.

## Gate 5 — MCP server

- [ ] Exposes `recall(question)`, `get(path)`, `status()` over stdio
- [ ] Registered in `.mcp.json`; Claude Code lists the tools
- [ ] **Benchmark reproduced**: same question, plain session vs a session with Laika Orbit recall, `/context` compared,
      result recorded in `bench/RESULTS.md`

**Done when:** a real question is answered end-to-end in Claude Code *and* the token delta is written down.
If we don't see a meaningful reduction, the router files are the problem, not the engine — say so in the results.

## Gate 6 — `calibrate` skill

- [ ] `.claude/skills/calibrate/SKILL.md`
- [ ] Session end → proposes bullet-point edits to router/skill files
- [ ] **Proposes a diff; never writes unattended**

**Done when:** it has been run on one real session and produced at least one edit worth keeping.

## Gate 7 — Graph

- [ ] Instanced nodes, batched edges, worker layout, baked positions
- [ ] Layouts: Force / Rings / Hex · views: Departments / Folders
- [ ] GPU-ID picking; inspector with type, size, mtime, connections, Open on device, Copy path, Fly to
- [ ] Search filters the instance buffer without a scene rebuild

**Targets:** **60fps at 60k nodes** on this M-series Mac · first paint **< 2s** · reload **< 10s**.
Measured with a scripted camera path, recorded in `bench/RESULTS.md`.

## Gate 8 — Dream sequence

- [ ] Ingests `raw/`, diffs `processed.md`, folds into `wiki/`, appends `log.md`
- [ ] Flags contradictions, stale claims, duplicates, orphans
- [ ] **Emits a review HTML — current vs proposed, numbered change table — and waits for approval**
- [ ] Scheduled nightly, never on the query path

---

## Open questions

Not blocking — I've assumed an answer for each and will proceed unless you say otherwise:

1. **Public or internal?** Assuming internal-first but packaged cleanly (MIT, no private paths hardcoded)
   so open-sourcing later is a decision, not a refactor.
2. **What does the team phase host on?** Assuming that's undecided; `RemoteStore` keeps it open.
3. **What does `brain/` actually index first?** I need a real corpus to write honest router files against.
   Point me at a folder and Gate 2 gets real instead of synthetic.
