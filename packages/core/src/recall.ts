import { type BrainIndex, buildIndex } from './index-build.ts'
import { score } from './score.ts'
import { findHop, sliceOf } from './slice.ts'
import { tokenise } from './tokenise.ts'
import type { Evidence, RecallResult, Store } from './types.ts'

export const EVIDENCE_CAP = 9 * 1024
export const MAX_HOPS = 1
export const LOW_CONFIDENCE_MARGIN = 0.25

export interface RecallOpts {
  topK?: number
  evidenceCap?: number
}

/**
 * The full seven-step path. Contains ZERO model calls, by rule — enforced by test.
 */
export async function recall(
  index: BrainIndex,
  store: Store,
  question: string,
  opts: RecallOpts = {},
): Promise<RecallResult> {
  const t0 = performance.now()
  const tokens = tokenise(question) // 1
  const sc = score(index, tokens, opts.topK ?? 5) // 2-3
  const msScore = performance.now() - t0

  const evidence: Evidence[] = []
  let bytesRead = 0
  let hops = 0
  const noMatch = sc.candidates.length === 0
  const lowConfidence = !noMatch && sc.candidates.length > 1 && sc.margin < LOW_CONFIDENCE_MARGIN
  // Ambiguous? read the runner-up too and say so, rather than guessing silently.
  const take = lowConfidence ? sc.candidates.slice(0, 2) : sc.candidates.slice(0, 1)

  for (const c of take) {
    const text = await store.readDoc(c.path).catch(() => '')
    if (!text) continue
    bytesRead += text.length
    const s = sliceOf(text, tokens) // 4-5
    evidence.push({ path: c.path, heading: s.heading, lines: s.lines, text: s.text, viaHop: false })

    if (hops < MAX_HOPS) {
      // 6 — hard cap 1
      const next = findHop(s.text, (p) => index.byPath.has(p))
      if (next && next !== c.path) {
        const t2 = await store.readDoc(next).catch(() => '')
        if (t2) {
          bytesRead += t2.length
          hops++
          const s2 = sliceOf(t2, tokens, 45)
          evidence.push({
            path: next,
            heading: s2.heading,
            lines: s2.lines,
            text: s2.text,
            viaHop: true,
          })
        }
      }
    }
  }

  const prompt = buildAsk(
    question,
    evidence,
    opts.evidenceCap ?? EVIDENCE_CAP,
    lowConfidence,
    noMatch,
  ) // 7
  return {
    question,
    tokens,
    candidates: sc.candidates,
    margin: sc.margin,
    lowConfidence,
    noMatch,
    evidence,
    prompt,
    stats: { scoredDocs: sc.scoredDocs, msScore, msTotal: performance.now() - t0, bytesRead, hops },
  }
}

/** Step 7. Question on top, evidence under it, one instruction at the end. */
export function buildAsk(
  question: string,
  evidence: Evidence[],
  cap = EVIDENCE_CAP,
  lowConfidence = false,
  noMatch = false,
): string {
  const head = [`Question: ${question}`, '']
  if (noMatch) {
    return [
      ...head,
      'The knowledge base returned NO match for this question.',
      'Say so plainly. Do not answer from general knowledge as if it came from the brain.',
    ].join('\n')
  }
  if (lowConfidence) {
    head.push(
      'NOTE: retrieval confidence was low — two candidate sources are given.',
      'If they disagree, say so rather than picking one.',
      '',
    )
  }
  const parts: string[] = []
  let used = 0
  for (const e of evidence) {
    const block = `--- ${e.path}${e.heading ? ` › ${e.heading}` : ''} (lines ${e.lines})${e.viaHop ? ' [followed pointer]' : ''}\n${e.text}\n`
    if (used + block.length > cap) {
      parts.push(`--- [evidence truncated at ${cap} bytes]`)
      break
    }
    parts.push(block)
    used += block.length
  }
  return [
    ...head,
    ...parts,
    '',
    'Answer using only the evidence above. Quote the line you used and name the file.',
  ].join('\n')
}

export type { BrainIndex }
export { buildIndex }
