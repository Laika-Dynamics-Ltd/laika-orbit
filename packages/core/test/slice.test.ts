import { describe, expect, it } from 'vitest'
import { findHop, sliceOf } from '../src/slice.ts'

const DOC = `# Tools

Preamble that should not be returned.

## TTS

Voice: William (AU English)
Model: eleven-v3

## Video

Unrelated section.
`

describe('sliceOf', () => {
  it('returns only the matching heading section', () => {
    const s = sliceOf(DOC, ['tts', 'voice'])
    expect(s.heading).toBe('TTS')
    expect(s.text).toContain('William (AU English)')
    expect(s.text).not.toContain('Unrelated section')
    expect(s.text).not.toContain('Preamble')
  })

  it('falls back to a window around the densest line when no heading matches', () => {
    const s = sliceOf(DOC, ['william'])
    expect(s.heading).toBeNull()
    expect(s.text).toContain('William')
  })

  it('caps section length', () => {
    const long = `## Big\n${Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')}`
    expect(sliceOf(long, ['big']).text.split('\n').length).toBeLessThanOrEqual(26)
  })
})

describe('findHop', () => {
  const known = (p: string) => ['TOOLS.md', 'notes/deep.md'].includes(p)
  it('finds a followable pointer', () => {
    expect(findHop('see notes/deep.md for detail', known)).toBe('notes/deep.md')
  })
  it('never hops into an index/log/processed file', () => {
    expect(findHop('see wiki/index.md and wiki/log.md', known)).toBeNull()
  })
  it('ignores unknown paths', () => {
    expect(findHop('see ghost.md', known)).toBeNull()
  })
})
