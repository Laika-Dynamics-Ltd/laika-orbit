/** Incremental indexing: does reusing unchanged files actually pay? */

import { resolve } from 'node:path'
import { buildIndex, LocalFsStore } from '../packages/core/src/index.ts'

const ROOT = resolve(process.env.BRAIN_ROOT ?? '.')
const store = new LocalFsStore(ROOT)
const opts = { indexContent: true }

const t0 = performance.now()
const cold = await buildIndex(store, opts)
const coldMs = performance.now() - t0

const t1 = performance.now()
const warm = await buildIndex(store, { ...opts, prior: cold })
const warmMs = performance.now() - t1

const t2 = performance.now()
const warm2 = await buildIndex(store, { ...opts, prior: warm })
const warm2Ms = performance.now() - t2

console.log(`\ncorpus: ${cold.docs.length} docs`)
console.log(
  `  cold        ${coldMs.toFixed(0).padStart(7)}ms   re-read ${cold.reread}/${cold.docs.length}`,
)
console.log(
  `  incremental ${warmMs.toFixed(0).padStart(7)}ms   re-read ${warm.reread}/${warm.docs.length}`,
)
console.log(
  `  again       ${warm2Ms.toFixed(0).padStart(7)}ms   re-read ${warm2.reread}/${warm2.docs.length}`,
)
console.log(`  speedup     ${(coldMs / Math.max(1, warmMs)).toFixed(1)}x`)

// correctness: the incremental index must be identical to the cold one
const sameTokens = cold.postings.size === warm.postings.size
let sameP = true
for (const [t, a] of cold.postings) {
  const b = warm.postings.get(t)
  if (!b || b.length !== a.length) {
    sameP = false
    break
  }
}
console.log(`\n  identical postings: ${sameTokens && sameP ? 'YES' : 'NO — incremental diverged'}`)
if (!(sameTokens && sameP)) process.exitCode = 1
