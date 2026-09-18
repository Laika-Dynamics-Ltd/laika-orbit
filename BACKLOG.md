# Laika Orbit — backlog

State as of 2026-09-16. Gates in `STACK.md`, gauntlet results in `.gauntlet/RESULTS.md`.
Effort is rough: **S** = under an hour · **M** = half a day · **L** = a day or more.

---

## 0 · Do first — nothing is backed up

| | Item | Why | Effort |
|---|---|---|---|
| 0.1 | **`git init` + first commit** | ~2,150 lines of source, a 104-minute gauntlet run and all the research exist only on this disk. One bad `rm` loses the lot. | **S** |
| 0.2 | `.gitignore` | `node_modules`, `dist`, `.orbit/cache`, `.gauntlet/work/*/out`, `.gauntlet/void-run-1`. Without it the first commit is ~600MB. | **S** |
| 0.3 | `README.md` | What this is, how to run it, what the four packages do. First thing anyone opening the repo needs. | **S** |
| 0.4 | `LICENSE` | Decide internal vs open. Cheap now, awkward later. | **S** |

**Gate 1 was reported as done and was not.** `.mise.toml` exists; git, CI, lefthook, LICENSE and
README do not. Everything below assumes 0.1–0.2 land first.

## 1 · Makes it genuinely usable

| | Item | Why | Effort |
|---|---|---|---|
| 1.1 | **Router files for one real domain** | The actual recall bottleneck. On `~/Documents` this is filename+content matching; curated descriptions are what make it retrieval. Pick one folder, I generate a first pass, you correct it. | **M** |
| 1.2 | **Incremental indexing by content hash** | Re-index is ~11s on 2,383 files because every file is re-read. This is what stands between the app and your `dev` tree (403k files). Specced in `STACK.md`, zero implementation. | **M** |
| 1.3 | Fix the tied-score display | Five candidates all reading `100%` is decoration, not ranking. Show raw score, or collapse to "5 files tie". | **S** |
| 1.4 | Search-as-you-type | Recall is ~1ms. There is no reason to make the user press a button. | **S** |
| 1.5 | **Colour debt back to 163 / 48** | Raised to 218 hex / 82 rgb-hsl on 19 Sep 2026 so the public release could ship. Pulse (`pulse*.css`), `node-preview.css`, `sessions.css` and `session-terminal.ts` added the literals; tokenise them and lower the baselines in `test/design-debt.test.ts`. | **S** |

## 2 · Finish the gauntlet port

| | Item | Why | Effort |
|---|---|---|---|
| 2.1 | **Port the GPU force layout** from `.gauntlet/work/scale-fps` | The half of the win still unused. Validated at **204fps / 60k nodes**; the app uses hand-written circle packing. Matters at 60k, not at 2,383 — so pair it with 1.2. | **M** |
| 2.2 | Ring band density at overview zoom | Structure currently reads from labels and link webs; the points themselves nearly vanish at ~1,800 units. Point-size falloff + bloom. | **S** |
| 2.3 | Port `feel`'s interaction work | It was **capped, not passed**, but won two of four rounds. Worth mining rather than adopting wholesale. | **M** |

## 3 · Complete the plan

| | Item | Why | Effort |
|---|---|---|---|
| 3.1 | **Gate 8 — dream sequence** | Last unbuilt gate. Folds `raw/` into `wiki/`, flags contradictions and stale claims, emits a reviewable diff. Only earns its keep once a real corpus flows through `raw/` — so it follows 1.1. | **M** |
| 3.2 | CI (GitHub Actions) | Run typecheck / test / lint / `laikaorbit lint` on push. Specced in Gate 1. | **S** |
| 3.3 | lefthook pre-commit | `biome check --staged` + typecheck. Specced in Gate 1. | **S** |

## 4 · Known-weak, revisit when it bites

| | Item | Trigger |
|---|---|---|
| 4.1 | Semantic fallback when deterministic scoring misses | If golden-set recall@5 drops below 90% on a real corpus. `node:sqlite` has **FTS5 compiled in** — the escape hatch costs no new dependency. |
| 4.2 | `RemoteStore` for the team phase | When a second person needs the same index. The `Store` interface already isolates this. |
| 4.3 | Re-run `atmosphere` with a fixed brief | Its comparison was partly compromised: the brief said "no UI chrome" but the reference is a webpage that necessarily has chrome, so critics penalised *the bar*. Milder than the run-1 veto failure, same family. |
| 4.4 | Native-GPU fps numbers | Every framerate recorded so far is headless Chromium — comparative, not absolute. A headed run on the target machine would make `bench/RESULTS.md` honest in absolute terms. |

---

## Suggested order

**0.1 → 0.2 → 0.3** today, because everything else is worth more once it's committed.
Then **1.1** (router files), because it converts a good demo into something used daily, and it's the
only item where the bottleneck is your knowledge rather than my code.
Then **1.2 + 2.1** together — incremental indexing and the GPU layout are the pair that unlock
pointing this at a folder that actually matters.
