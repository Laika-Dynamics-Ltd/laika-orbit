import { describe, expect, it } from 'vitest'
import { parseRouter, serialiseRouter } from '../src/router.ts'

const SRC = `## 2 — select idea

- Skills: master-content-selection — surfaces best from backlog
- Files: shared/data/tasks.json — all C- prefixed tasks
- Reference: project_queue.md — current production queue

## 3 — research and write

- Thinking: core-content-notes.md — hook patterns
- Rules: feedback_au_english.md — AU spelling always
`

describe('parseRouter', () => {
  it('extracts typed pointers with their stage', () => {
    const { pointers, issues } = parseRouter(SRC, 'CONTENT.md')
    expect(issues).toEqual([])
    expect(pointers).toHaveLength(5)
    expect(pointers[0]).toMatchObject({
      type: 'Skills',
      path: 'master-content-selection',
      description: 'surfaces best from backlog',
      stage: '2 — select idea',
    })
    expect(pointers[4]!.stage).toBe('3 — research and write')
  })

  it('round-trips byte-identically', () => {
    expect(serialiseRouter(parseRouter(SRC, 'x.md'))).toBe(SRC)
  })

  it('reports a malformed pointer with a line number instead of skipping it', () => {
    const { issues } = parseRouter('- Widgets: thing.md — nope\n', 'x.md')
    expect(issues).toHaveLength(1)
    expect(issues[0]!.line).toBe(1)
    expect(issues[0]!.reason).toMatch(/unknown pointer type/)
  })

  it('flags a pointer with no path', () => {
    expect(parseRouter('- Files:   \n', 'x.md').issues[0]!.reason).toMatch(/no path/)
  })
})
