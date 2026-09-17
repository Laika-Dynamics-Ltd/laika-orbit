## 1 — architecture

- Thinking: PLAN.md — six-phase build plan, why brain.js is ported not adopted
- Thinking: STACK.md — pinned stack, nine definition-of-done gates
- Reference: bench/RESULTS.md — every performance claim traces here
- Rules: packages/core/src/tokenise.ts — word-boundary matching, never substring

## 2 — retrieval engine

- Files: packages/core/src/recall.ts — the seven-step zero-LLM recall path
- Files: packages/core/src/score.ts — inverted-index scoring, returns a confidence margin
- Files: packages/core/src/slice.ts — section slicing and the one-hop pointer follow
- Skills: 1brain recall — query the knowledge base from the CLI
- Rules: MAX_HOPS — hard cap of one pointer hop, enforced by test

## 3 — the graph viewer

- Files: packages/graph/src/main.ts — three.js renderer, instanced points
- Files: packages/graph/scripts/capture.mjs — capture harness and integrity probe
- Rules: capture integrity — nodes=60000, links=65079, zero errors, fps p50 >= 60

## 4 — voice and tooling

- Reference: research/notes/findings.md — how the Rubric second brain actually works
- Reference: research/notes/findings-hyperframes.md — Hyperframes pipeline and lint gotchas
- Rules: brain/rules/feedback_au_english.md — AU spelling throughout
