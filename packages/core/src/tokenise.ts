/**
 * Step 1 of recall. Deterministic, no model.
 *
 * The bug this exists to avoid: RoboNuggets' brain.js matched stop words as
 * substrings, so "one" matched inside "Done". We tokenise on word boundaries.
 */
const STOP = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'did',
  'do',
  'does',
  'doing',
  'done',
  'for',
  'from',
  'had',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'no',
  'not',
  'of',
  'off',
  'on',
  'one',
  'or',
  'our',
  'ours',
  'out',
  'over',
  'own',
  'she',
  'he',
  'they',
  'them',
  'the',
  'their',
  'then',
  'there',
  'these',
  'this',
  'those',
  'to',
  'too',
  'under',
  'until',
  'up',
  'use',
  'used',
  'uses',
  'using',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
  'thing',
  'things',
])

export function tokenise(q: string): string[] {
  const raw = q.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []
  // a Set keeps first-seen order and stays linear; Array#includes made a 5 MB file take 80 s
  const out = new Set<string>()
  for (const w of raw) {
    if (w.length < 2) continue
    if (STOP.has(w)) continue // exact word match only — never substring
    out.add(w)
  }
  return [...out]
}

export const isStopWord = (w: string): boolean => STOP.has(w.toLowerCase())
