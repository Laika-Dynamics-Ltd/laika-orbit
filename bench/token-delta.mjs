/**
 * Token-delta benchmark — the claim the whole design rests on.
 *
 * Compares, for the same question, what an agent actually puts in its context:
 *
 *   BASELINE  what a grep/glob agent does: search the corpus for the query's
 *             terms, then READ each matching file WHOLE. That is the honest
 *             baseline, because an agent cannot read half a file — it reads the
 *             file and every line of it counts against the window.
 *
 *   RECALL    the packed prompt `recall` produces: question + the sliced
 *             sections + one instruction, capped at 9KB.
 *
 * Tokens are estimated at 4 bytes/token. That is an approximation, not a
 * tokeniser — it is stated in the output so the number is never mistaken for
 * an exact count. The RATIO is the finding; the absolute figures are indicative.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildIndex, LocalFsStore, recall, tokenise } from '../packages/core/src/index.ts'

const ROOT = resolve(process.env.BRAIN_ROOT ?? '.')
const BYTES_PER_TOKEN = 4
const tok = (bytes) => Math.round(bytes / BYTES_PER_TOKEN)

const QUESTIONS = [
  'which TTS voice do we use',
  'what is the hard cap on pointer hops',
  'where do performance claims live',
  'what is the capture integrity rule',
  'how does the recall path work',
  'what spelling do we use',
  'what are the hyperframes lint gotchas',
  'what is the BIT framework',
  'how do I rebuild the index',
  'what is the router file format',
  'why was gauntlet run 1 voided',
  'what are the ARMS layers',
]

const store = new LocalFsStore(ROOT)
const index = await buildIndex(store, {
  topics: new Map([['voice', 'brain/routers/CONTENT.md']]),
  indexContent: true,
})

/**
 * What a grep-then-read agent would pull into context for this question.
 *
 * An agent has no relevance ranking from grep, so it picks by the only signal it
 * has: which files mention the terms most. It then reads those files WHOLE,
 * because it cannot read half a file. Ranking by occurrence count is the fairest
 * model of that behaviour.
 *
 * An earlier version of this ranked hits by size ASCENDING and took the smallest
 * five, which made the baseline absurdly cheap and produced nonsense savings of
 * -3300%. Ranking must reflect what an agent would actually choose.
 */
const READ_BUDGET = 5
// Agents truncate very large files rather than ingesting them whole; counting a
// 5MB fixture as 1.4M tokens of "baseline" would flatter us enormously.
const PER_FILE_CAP = 100_000

async function baselineCost(question) {
  const terms = tokenise(question)
  if (!terms.length) return { files: 0, bytes: 0, hitCount: 0 }
  const hits = []
  for (const d of index.docs) {
    const text = await store.readDoc(d.path).catch(() => '')
    if (!text) continue
    const low = `${d.path}\n${text}`.toLowerCase()
    let score = 0
    for (const t of terms) {
      const m = low.split(t).length - 1
      score += m
    }
    if (score > 0) hits.push({ path: d.path, bytes: text.length, score })
  }
  // most-mentions first — the ordering an agent's own judgement approximates
  const read = hits.sort((a, b) => b.score - a.score).slice(0, READ_BUDGET)
  return {
    files: read.length,
    bytes: read.reduce((n, f) => n + Math.min(f.bytes, PER_FILE_CAP), 0),
    hitCount: hits.length,
  }
}

const rows = []
for (const q of QUESTIONS) {
  const base = await baselineCost(q)
  const r = await recall(index, store, q)
  rows.push({
    q,
    baseFiles: base.files,
    baseHits: base.hitCount,
    baseTokens: tok(base.bytes),
    brainTokens: tok(r.prompt.length),
    ms: r.stats.msTotal,
    noMatch: r.noMatch,
  })
}

const sum = (k) => rows.reduce((n, r) => n + r[k], 0)
const baseTotal = sum('baseTokens')
const brainTotal = sum('brainTokens')
const saved = baseTotal ? ((1 - brainTotal / baseTotal) * 100).toFixed(1) : '0'
// the median per-question saving is the honest headline: a total can be carried
// by a single outlier question, a median cannot
const perQ = rows
  .filter((r) => r.baseTokens > 0)
  .map((r) => (1 - r.brainTokens / r.baseTokens) * 100)
  .sort((a, b) => a - b)
const medianSave = perQ.length ? perQ[Math.floor(perQ.length / 2)].toFixed(1) : '0'

console.log(
  `\ncorpus: ${index.docs.length} docs · ${index.routerCount} routers · ${index.pointerCount} pointers`,
)
console.log(`token estimate: ${BYTES_PER_TOKEN} bytes/token (approximate, not a tokeniser)\n`)
console.log('question                                   grep-hits  read  baseline  recall   saving')
console.log('─'.repeat(88))
for (const r of rows) {
  const save = r.baseTokens ? `${((1 - r.brainTokens / r.baseTokens) * 100).toFixed(0)}%` : '—'
  console.log(
    `${r.q.slice(0, 40).padEnd(42)}${String(r.baseHits).padStart(9)}${String(r.baseFiles).padStart(6)}` +
      `${String(r.baseTokens).padStart(10)}${String(r.brainTokens).padStart(8)}${save.padStart(9)}` +
      (r.noMatch ? '  (no match)' : ''),
  )
}
console.log('─'.repeat(88))
console.log(
  `${'TOTAL'.padEnd(42)}${''.padStart(15)}${String(baseTotal).padStart(10)}${String(brainTotal).padStart(8)}${`${saved}%`.padStart(9)}`,
)
console.log(`${'MEDIAN per question'.padEnd(42)}${''.padStart(33)}${`${medianSave}%`.padStart(9)}`)
console.log(`\nmodel calls on the recall path: 0`)
console.log(
  `p50 recall latency: ${rows
    .map((r) => r.ms)
    .sort((a, b) => a - b)
    [Math.floor(rows.length / 2)].toFixed(2)}ms`,
)
