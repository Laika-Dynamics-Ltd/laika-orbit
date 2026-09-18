import { describe, expect, it } from 'vitest'
import { attentionOf, boardRow, decisionOf, etaOf, fleetBoard, progressOf, shipKind, statusOf } from '../fleet-board.mjs'

/** enough of agent-host's Session for the board */
function chat(id, o = {}) {
  const pending = new Map()
  for (const [i, event] of (o.pending ?? []).entries()) pending.set(`r${i}`, { kind: event.t, event: { requestId: `r${i}`, at: 1000, ...event } })
  return {
    id,
    sdkSessionId: o.sdk ?? `sdk-${id}`,
    repo: 'repo',
    cwd: '/tmp/repo',
    title: o.title ?? `chat ${id}`,
    role: null,
    state: o.state ?? 'idle',
    brief: o.brief ?? null,
    events: o.events ?? [],
    pending,
    work: { start: o.start ?? 0, phase: null, bg: o.bg },
    cost: 0,
    turns: 1,
    updatedAt: o.updatedAt ?? 5000,
  }
}

describe('shipKind: what cannot be taken back gets its own button', () => {
  it.each([
    ['git push origin main', 'push'],
    ['git -C ../x push --tags', 'push'],
    ['cd app && pnpm publish --access public', 'publish'],
    ['gh pr merge 12 --squash', 'release'],
    ['npm run deploy', 'deploy'],
    ['fly deploy', 'deploy'],
    ['./scripts/deploy.sh prod', 'deploy'],
    ['vercel --prod', 'deploy'],
    ['npx vercel', 'deploy'],
    ['terraform apply -auto-approve', 'deploy'],
  ])('%s → %s', (command, kind) => expect(shipKind('Bash', { command })).toBe(kind))

  it.each(['git stash push -m wip', 'git status', 'cat deploy.md', 'vercel env pull', 'cat vercel.json', 'npm test'])(
    '%s is an ordinary permission',
    (command) => expect(shipKind('Bash', { command })).toBeNull(),
  )

  it('reads MCP tool names', () => {
    expect(shipKind('mcp__vercel__deploy_to_vercel', {})).toBe('deploy')
    expect(shipKind('mcp__github__merge_pull_request', {})).toBe('release')
    expect(shipKind('Edit', { file_path: '/x/deploy.sh' })).toBeNull()
  })
})

describe('decisionOf', () => {
  it('labels a push, an edit and a question', () => {
    expect(decisionOf({ t: 'permission', requestId: 'a', tool: 'Bash', input: { command: 'git push' } })).toMatchObject({ kind: 'ship', ship: 'push', label: 'Approve push' })
    expect(decisionOf({ t: 'permission', requestId: 'b', tool: 'Edit', input: { file_path: '/r/src/a.ts' }, canAlways: true })).toMatchObject({ kind: 'permission', label: 'Edit a.ts', canAlways: true })
    const q = decisionOf({ t: 'question', requestId: 'c', questions: [{ header: 'Retries', question: 'How?', options: [] }] })
    expect(q).toMatchObject({ kind: 'question', label: 'Retries', detail: 'How?' })
  })
})

describe('statusOf: one line on where a chat stands', () => {
  it('a decision says what it wants', () => {
    const d = [decisionOf({ t: 'permission', requestId: 'a', tool: 'Bash', input: { command: 'git push origin main' } })]
    expect(statusOf(chat('a'), d)).toBe('Wants to push: git push origin main')
  })
  it('a running chat says what it is doing, from its todos first', () => {
    const events = [
      { t: 'tool', name: 'TodoWrite', at: 20, input: { todos: [{ content: 'Fix it', activeForm: 'Fixing it', status: 'in_progress' }] } },
      { t: 'tool', name: 'Read', at: 30, input: { file_path: '/r/a.ts' } },
    ]
    expect(statusOf(chat('a', { state: 'running', start: 10, events }))).toBe('Reading a.ts')
    expect(statusOf(chat('a', { state: 'running', start: 10, events: events.slice(0, 1) }))).toBe('Fixing it')
    // steps from an earlier turn are not this turn's
    expect(statusOf(chat('a', { state: 'running', start: 50, events }))).toBe('Thinking')
  })
  it('an idle chat uses its brief, else what Claude last said', () => {
    expect(statusOf(chat('a', { brief: { now: 'Tests pass, waiting on review' } }))).toBe('Tests pass, waiting on review')
    expect(statusOf(chat('a', { events: [{ t: 'text', text: '\nAll done.\nMore' }] }))).toBe('All done.')
  })
})

describe('ETA comes from the views that keep one, never a guess of its own', () => {
  const board = (o = {}) => ({ id: 'b1', chat: 'sdk-a', title: 'Build', pct: 40, etaAt: 90_000, etaDerived: true, state: 'running', lanes: [], ...o })

  it('the live progress board first', () => {
    const p = progressOf(chat('a'), [board()])
    expect(etaOf(chat('a', { bg: [{ etaAt: 50_000, label: 'x' }] }), p)).toMatchObject({ at: 90_000, source: 'progress', basis: 'progress rate' })
  })
  it('else the status line: the background task that finishes last', () => {
    const bg = [{ etaAt: 50_000, label: 'tests', basis: 'history' }, { etaAt: 70_000, label: 'build', basis: 'progress' }, { etaAt: null, label: 'watch' }]
    expect(etaOf(chat('a', { bg }))).toMatchObject({ at: 70_000, source: 'status', label: 'build' })
  })
  it('null with no basis, and for a finished board', () => {
    expect(etaOf(chat('a'))).toBeNull()
    expect(etaOf(chat('a'), progressOf(chat('a'), [board({ state: 'done' })]))).toBeNull()
  })
  it('matches boards by the chat’s session id only', () => {
    expect(progressOf(chat('a'), [board({ chat: 'sdk-other' })])).toBeNull()
    expect(progressOf(chat('a', { sdk: null }), [board({ chat: null })])).toBeNull()
  })
  it('a blocked or stalled board is an attention button; a running one is not', () => {
    const blocked = progressOf(chat('a'), [board({ state: 'blocked', lanes: [{ id: 'l', name: 'Sign-off', status: 'blocked' }] })])
    expect(attentionOf(blocked)).toMatchObject({ kind: 'attention', state: 'blocked', label: 'Blocked: Sign-off' })
    expect(attentionOf(progressOf(chat('a'), [board()]))).toBeNull()
  })
})

describe('fleetBoard', () => {
  it('puts decisions first, then attention, and leaves closed chats out', () => {
    const push = { t: 'permission', tool: 'Bash', input: { command: 'git push' } }
    const sessions = [
      chat('idle', { updatedAt: 9000 }),
      chat('run', { state: 'running', start: 1 }),
      chat('gone', { state: 'closed' }),
      chat('stuck', { sdk: 'sdk-stuck' }),
      chat('push', { state: 'waiting', pending: [push] }),
    ]
    const boards = [{ id: 'b', chat: 'sdk-stuck', title: 'T', state: 'stalled', lanes: [] }]
    const { rows } = fleetBoard(sessions, { now: 10_000, boards })
    expect(rows.map((r) => r.id)).toEqual(['push', 'stuck', 'run', 'idle'])
    expect(rows[0].decisions[0]).toMatchObject({ requestId: 'r0', kind: 'ship' })
    expect(rows[0].since).toBe(1000)
    expect(rows[1].decisions[0].kind).toBe('attention')
  })
  it('keeps ungrouped chats first, then each group together in urgency order', () => {
    const sessions = [
      Object.assign(chat('a', { updatedAt: 9000 }), { group: 'Orbit' }),
      chat('b', { updatedAt: 8000 }),
      Object.assign(chat('c', { state: 'running', start: 1 }), { group: 'Atlas' }),
      Object.assign(chat('d', { updatedAt: 7000 }), { group: 'Orbit' }),
      Object.assign(chat('e', { updatedAt: 6000 }), { group: '  ' }),
    ]
    const { rows } = fleetBoard(sessions, { now: 10_000, boards: [] })
    expect(rows.map((r) => [r.id, r.group, r.section])).toEqual([
      ['b', null, 'group'],
      ['e', null, 'group'],
      ['c', 'Atlas', 'group'],
      ['a', 'Orbit', 'group'],
      ['d', 'Orbit', 'group'],
    ])
  })
  it('pins every chat that needs you above the groups, whatever its group', () => {
    const ask = { t: 'question', questions: [{ header: 'Which', question: 'Which?', options: [] }] }
    const sessions = [
      chat('loose', { updatedAt: 9000 }),
      Object.assign(chat('orbit-idle', { updatedAt: 8000 }), { group: 'Orbit' }),
      Object.assign(chat('orbit-ask', { state: 'waiting', pending: [ask] }), { group: 'Orbit' }),
      Object.assign(chat('atlas-stuck', { sdk: 'sdk-fs' }), { group: 'Atlas' }),
      Object.assign(chat('atlas-run', { state: 'running', start: 1 }), { group: 'Atlas' }),
      chat('loose-ask', { state: 'waiting', pending: [ask], updatedAt: 1 }),
    ]
    const boards = [{ id: 'b', chat: 'sdk-fs', title: 'T', state: 'blocked', lanes: [] }]
    const { rows } = fleetBoard(sessions, { now: 10_000, boards })
    expect(rows.map((r) => [r.id, r.section])).toEqual([
      // decisions first, then attention; each keeps its group for the page's tag
      ['orbit-ask', 'needs-you'],
      ['loose-ask', 'needs-you'],
      ['atlas-stuck', 'needs-you'],
      // then ungrouped, and the groups by their most urgent chat still in this section
      ['loose', 'group'],
      ['atlas-run', 'group'],
      ['orbit-idle', 'group'],
    ])
    expect(rows[0].group).toBe('Orbit')
    expect(rows[2].group).toBe('Atlas')
  })
  it('keeps the detail for an opened row small', () => {
    const events = Array.from({ length: 30 }, (_, i) => ({ t: 'text', text: `line ${i}`, at: i }))
    const row = boardRow(chat('a', { events }), { boards: [] })
    expect(row.recent).toHaveLength(6)
    expect(row.recent.at(-1)).toEqual({ who: 'claude', text: 'line 29' })
  })
})
