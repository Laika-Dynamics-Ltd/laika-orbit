import type { BrainIndex } from './index-build.ts'
import type { Candidate } from './types.ts'

/**
 * Step 2-3. Score every candidate WITHOUT opening a single file — pure arithmetic
 * over the postings. Returns ranked candidates plus a confidence margin, so an
 * ambiguous answer is surfaced rather than silently resolved to top-1.
 */
export function score(
  index: BrainIndex,
  tokens: string[],
  topK = 5,
): {
  candidates: Candidate[]
  margin: number
  scoredDocs: number
} {
  const acc = new Map<number, number>()
  for (const t of tokens) {
    const post = index.postings.get(t)
    if (!post) continue
    for (let i = 0; i < post.length; i += 2) {
      const id = post[i]!,
        w = post[i + 1]!
      acc.set(id, (acc.get(id) ?? 0) + w)
    }
  }
  const ranked = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK)
  const top = ranked[0]?.[1] ?? 0
  const second = ranked[1]?.[1] ?? 0
  const margin = top > 0 ? (top - second) / top : 0
  return {
    candidates: ranked.map(([docId, s]) => ({
      docId,
      path: index.docs[docId]!.path,
      score: s,
      relative: top ? s / top : 0,
    })),
    margin,
    scoredDocs: acc.size,
  }
}
