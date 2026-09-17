// Feasibility: can we score a 60k-file workspace's catalogue in <10ms, zero LLM?
const N_FILES = 60000,
  N_CATALOGUE = 40000,
  N_TOPICS = 500
const words = [
  'voice',
  'tts',
  'content',
  'client',
  'render',
  'pipeline',
  'brand',
  'script',
  'invoice',
  'deploy',
  'sprint',
  'laika',
  'skill',
  'router',
  'memory',
  'index',
  'graph',
  'audio',
  'model',
  'token',
]
const rnd = (n) =>
  words[Math.floor(Math.random() * words.length)] + (Math.random() < 0.3 ? '_' + n : '')
// build a synthetic index
const filenames = Array.from({ length: N_FILES }, (_, i) => `${rnd(i)}/${rnd(i)}-${rnd(i)}.md`)
const catalogue = Array.from(
  { length: N_CATALOGUE },
  (_, i) => `- Files: ${rnd(i)}/${rnd(i)}.md — ${rnd(i)} ${rnd(i)} ${rnd(i)} notes`,
)
const topics = new Map(Array.from({ length: N_TOPICS }, (_, i) => [rnd(i), `${rnd(i)}.md`]))

// PRE-TOKENISED inverted index (built once at index time, not query time)
const t0 = performance.now()
const post = new Map() // token -> [docId, weight][]
const add = (tok, id, w) => {
  let a = post.get(tok)
  if (!a) {
    a = []
    post.set(tok, a)
  }
  a.push(id, w)
}
const tok = (s) => s.toLowerCase().match(/[a-z0-9]+/g) ?? []
filenames.forEach((f, i) => {
  for (const t of tok(f)) add(t, i, 3)
})
catalogue.forEach((c, i) => {
  for (const t of tok(c)) add(t, i, 2)
})
for (const [k, v] of topics) for (const t of tok(k)) add(t, filenames.indexOf(v) >>> 0, 8)
const buildMs = performance.now() - t0

const scores = new Float32Array(N_FILES)
function recall(q) {
  scores.fill(0)
  const qt = tok(q).filter((w) => w.length > 2)
  for (const t of qt) {
    const a = post.get(t)
    if (!a) continue
    for (let i = 0; i < a.length; i += 2) scores[a[i]] += a[i + 1]
  }
  let best = -1,
    bestS = 0,
    second = 0
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i]
    if (s > bestS) {
      second = bestS
      bestS = s
      best = i
    } else if (s > second) second = s
  }
  return { best, bestS, margin: bestS ? (bestS - second) / bestS : 0 }
}
recall('warmup query voice') // jit warm
const qs = [
  'which tts voice do we use',
  'what is the render pipeline',
  'laika brand script',
  'client invoice deploy',
]
const times = []
for (let r = 0; r < 2000; r++) {
  const s = performance.now()
  recall(qs[r % qs.length])
  times.push(performance.now() - s)
}
times.sort((a, b) => a - b)
const pct = (p) => times[Math.floor(times.length * p)].toFixed(3)
console.log(`index build (60k files + 40k catalogue lines): ${buildMs.toFixed(0)}ms`)
console.log(`postings tokens: ${post.size.toLocaleString()}`)
console.log(
  `recall p50=${pct(0.5)}ms  p95=${pct(0.95)}ms  p99=${pct(0.99)}ms  max=${times.at(-1).toFixed(3)}ms`,
)
console.log(`heap: ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)}MB`)
