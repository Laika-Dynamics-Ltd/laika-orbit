import { tokenise } from './tokenise.ts'

export interface Slice {
  heading: string | null
  lines: string
  text: string
}

const SECTION_MAX = 26
const BACK = 10
const FWD = 16

/**
 * Step 5. Keep only the section that answers, never the whole document.
 * Primary: a `##` heading whose word tokens intersect the query.
 * Fallback: a window around the line where query tokens appear most densely.
 */
export function sliceOf(text: string, tokens: string[], maxLines = SECTION_MAX): Slice {
  const lines = text.split(/\r?\n/)
  const want = new Set(tokens)

  type H = { idx: number; level: number; title: string; hits: number }
  const heads: H[] = []
  lines.forEach((l, i) => {
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(l)
    if (!m) return
    const title = m[2]!
    const hits = tokenise(title).filter((t) => want.has(t)).length
    heads.push({ idx: i, level: m[1]!.length, title, hits })
  })

  const best = heads.filter((h) => h.hits > 0).sort((a, b) => b.hits - a.hits || a.idx - b.idx)[0]
  if (best) {
    let end = lines.length
    for (const h of heads) {
      if (h.idx > best.idx && h.level <= best.level) {
        end = h.idx
        break
      }
    }
    end = Math.min(end, best.idx + maxLines)
    return {
      heading: best.title,
      lines: `${best.idx + 1}-${end}`,
      text: lines.slice(best.idx, end).join('\n').trim(),
    }
  }

  // densest-line fallback
  let bestLine = 0,
    bestScore = -1
  lines.forEach((l, i) => {
    const toks = tokenise(l)
    const s = toks.filter((t) => want.has(t)).length
    if (s > bestScore) {
      bestScore = s
      bestLine = i
    }
  })
  const from = Math.max(0, bestLine - BACK)
  const to = Math.min(lines.length, bestLine + FWD)
  return {
    heading: null,
    lines: `${from + 1}-${to}`,
    text: lines.slice(from, to).join('\n').trim(),
  }
}

/** Step 6. Follow at most ONE pointer out of a slice. Hard cap, enforced by caller. */
export function findHop(sliceText: string, known: (p: string) => boolean): string | null {
  for (const m of sliceText.matchAll(/([A-Za-z0-9._/-]+\.md)/g)) {
    const p = (m[1] ?? '').replace(/^\.\//, '')
    if (!p) continue
    if (/(^|\/)(index|log|processed)\.md$/i.test(p)) continue // never hop into an index
    if (known(p)) return p
  }
  return null
}
