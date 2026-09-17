# Benchmark results

Append-only. Every performance claim in `STACK.md` must trace back to an entry here.

## 2026-09-16 · Scoring feasibility (pre-implementation)

Synthetic corpus, run on M-series Mac, Node 26.0.0. `node bench/scoring.bench.mjs`.

```
index build (60k files + 40k catalogue lines):  78ms
postings tokens:                                50,992
recall  p50=0.525ms  p95=0.662ms  p99=0.710ms  max=1.279ms
heap:                                           111MB
```

### Second run, same machine, same commit

```
index build:  103ms
recall  p50=0.493ms  p95=1.073ms  p99=1.743ms  max=10.774ms
```

**Run-to-run variance is real and must be accounted for.** p95 moved 0.66 → 1.07ms and max moved
1.28 → 10.77ms between two runs of identical code. The max is almost certainly a GC pause landing
inside a sample. Implications:

- Quote **p95, never p50 or max**, and require **3 runs** before recording a number here.
- The < 2ms p95 target still holds with ~2× headroom, but it is not the 15× headroom the first run
  suggested. Treat 0.66ms as the optimistic tail, not the expected value.
- The CI gate should assert on p95 with a tolerance, or it will flake.

### Third run

```
recall  p50=0.481ms  p95=0.670ms  p99=0.818ms  max=1.065ms
```

Three runs, p95: **0.662 / 1.073 / 0.670 ms**. Run 2 was the outlier, not the rule. Expected p95
is **~0.67ms** with occasional excursions to ~1.1ms. Set the CI gate at **p95 < 2ms** — roughly
3× headroom over the typical case and still comfortably above the worst observed.

**Conclusion:** an inverted-index approach to deterministic scoring is ~15× inside the original 10ms
budget at target scale. Revised the p95 target to < 2ms and dropped `top-k = 1` in favour of top-5
with a confidence margin.

**Caveat — this is synthetic.** Tokens are drawn from a 20-word vocabulary, so the postings
distribution is far more uniform than a real workspace, and heap figures reflect JS strings for
generated data rather than a real corpus. It de-risks the *algorithm*, not the *implementation*.
Re-run against a real `brain/` at Gate 3 before treating the numbers as settled.

## Pending

- [x] Gate 3 — cold/incremental index timing. **196x on a 2,383-doc corpus** (21.4s -> 109ms),
      postings verified identical. `node bench/incremental.bench.mjs`
- [ ] Gate 4 — recall@5 on the golden set
- [x] Gate 5 — token delta. **Median 97.8% reduction per question** (total also 97.8%, so no single
      outlier carries it). Run `node bench/token-delta.mjs`. Full entry below.
- [x] Gate 7 — fps at 60k nodes, gauntlet run 2: **p50 204, min 134, 1% low 128, 13 draw calls**
      with a GPU force simulation, 60,000 points / 65,079 links. Headless Chromium — comparative,
      not native. Full trail in `.gauntlet/RESULTS.md`.


## 2026-09-16 · Gate 5 — token delta

`node bench/token-delta.mjs` · 97-doc corpus (this repo) · 12 golden questions.

| | baseline | 1brain | saving |
|---|---|---|---|
| total tokens | 228,657 | 5,004 | **97.8%** |
| median per question | — | — | **97.8%** |

Per-question savings span 96–99%; median and total agree, so the figure is not
carried by one outlier. p50 recall latency **0.41ms**, **0 model calls**.

**What the baseline models.** A grep/glob agent searches for the query's terms, ranks
hits by how often they appear, and reads the top 5 files **whole** — because an agent
cannot read half a file. Per-file reads are capped at 100KB, since agents truncate
very large files rather than ingesting them.

**Two methodology errors found and fixed while building this**, both of which would
have produced a flattering-but-false number:

1. The first version ranked hits by size **ascending** and read the 5 smallest, which
   made the baseline absurdly cheap and reported savings of **−3300%**. Ranking must
   model what an agent would actually choose, not what is convenient.
2. Five 5.5MB synthetic `brain.json` fixtures inside `.gauntlet/work/` were being
   counted as corpus, inflating one question's baseline to 7.2M tokens and carrying
   the total to a fake 99.9%. Fixed properly at the source: `LocalFsStore` now
   ignores `.gauntlet`, which also removes the scratch copies that were 50% of the
   graph's nodes.

**Caveat.** Tokens are estimated at 4 bytes/token — an approximation, not a tokeniser.
The ratio is the finding; absolute figures are indicative. The comparison is also
against a *simulated* grep agent rather than a live plain session, so it measures the
retrieval strategy, not an end-to-end session.


## 2026-09-16 · Incremental indexing

`node bench/incremental.bench.mjs`

| corpus | cold | incremental | re-read | speedup |
|---|---|---|---|---|
| this repo, 104 docs | 658ms | 230ms (63ms on the third pass) | 0 / 104 | 2.9x |
| ~/Documents, 2,383 docs | 21,363ms | 109ms | 0 / 2,383 | **196x** |

A file is reused when **both** its size and mtime match the previous build. Hashing
every file would cost exactly the read being avoided, so size+mtime is the right
check — it is what makes the saving real rather than moved.

The benchmark asserts the incremental index is **byte-identical in its postings** to a
cold build, and exits non-zero if it diverges. A fast index that quietly disagrees
with the slow one would be worse than no optimisation at all.

Wired into the app and MCP servers, which are long-lived. The CLI builds fresh per
invocation, so it benefits only within a single process — persisting the index to
disk is the follow-up, and is what would make `1brain recall` instant from cold.
