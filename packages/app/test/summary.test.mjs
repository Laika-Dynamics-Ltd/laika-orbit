import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promptKey } from '../chat-brief.mjs'
import { buildSummary, createSummaries, etaText, nextHour, renderMarkdown, turnsWithTimes } from '../summary.mjs'

const MIN = 60_000
const T = new Date('2026-09-18T14:00:00').getTime()

/** enough of agent-host's Session: events in order, each at a minute offset from T */
function chat(id, o = {}) {
  const events = (o.events ?? []).map(([min, e]) => ({ at: T + min * MIN, ...e }))
  return {
    id,
    sdkSessionId: o.sdk ?? `sdk-${id}`,
    repo: o.repo ?? 'repo',
    title: o.title ?? '',
    state: o.state ?? 'idle',
    updatedAt: o.updatedAt ?? events.at(-1)?.at ?? T,
    events,
    pending: new Map((o.pending ?? []).map((p, i) => [`r${i}`, p])),
    brief: o.brief ?? null,
    work: o.work ?? { start: 0 },
  }
}
const user = (text) => ({ t: 'user', text })
const said = (text) => ({ t: 'text', text })
const ok = { t: 'result', subtype: 'success', ms: 1000, error: null }
const failed = (error) => ({ t: 'result', subtype: 'error', error })

const board = (o) => ({
  id: 'b',
  title: 'Board',
  cwd: '/dev/proj',
  chat: null,
  createdAt: T - 30 * MIN,
  updatedAt: T - MIN,
  endedAt: null,
  pct: 40,
  etaAt: null,
  etaDerived: false,
  quietMs: MIN,
  state: 'running',
  lanes: [],
  ...o,
})

const build = (o) => buildSummary({ sessions: [], from: T - 60 * MIN, to: T, kind: 'hourly', ...o })

describe('turnsWithTimes', () => {
  it('ends a replayed turn at its last event when the next prompt starts, and the latest when the chat is idle', () => {
    const s = chat('a', { events: [[-50, user('one')], [-45, said('did one')], [-40, user('two')], [-30, said('did two')]] })
    const turns = turnsWithTimes(s)
    expect(turns.map((t) => t.endAt)).toEqual([T - 45 * MIN, T - 30 * MIN])
    s.state = 'running'
    expect(turnsWithTimes(s)[1].endAt).toBe(null)
  })
})

describe('buildSummary', () => {
  it('lists what each chat finished in the window, named by its brief', () => {
    const s = chat('a', {
      repo: 'orbit',
      events: [[-90, user('old work')], [-80, ok], [-40, user('add the hourly summary')], [-20, ok], [-10, user('fix the card')], [-5, failed('boom')]],
      brief: { goal: 'Hourly summary card', now: 'Card renders', turns: [{ p: promptKey('add the hourly summary'), label: 'Add hourly summary' }] },
    })
    const x = build({ sessions: [s] })
    expect(x.finished).toEqual([expect.objectContaining({ repo: 'orbit', title: 'Hourly summary card', tasks: ['Add hourly summary'], failed: 1, now: 'Card renders' })])
  })

  it('puts what needs you in order: a question, a permission, a crash, a failed turn, a question in the text', () => {
    const sessions = [
      chat('ask', { state: 'idle', events: [[-30, user('go')], [-20, said('Done. Shall I push it?')], [-20, ok]] }),
      chat('fail', { events: [[-30, user('go')], [-25, failed('Tool exploded')]] }),
      chat('crash', { state: 'error', updatedAt: T - 5 * MIN }),
      chat('perm', { state: 'waiting', pending: [{ kind: 'permission', event: { at: T - 3 * MIN, tool: 'Bash', input: { command: 'rm -rf dist' } } }] }),
      chat('q', { state: 'waiting', pending: [{ kind: 'question', event: { at: T - 2 * MIN, questions: [{ question: 'Which colour?' }] } }] }),
    ]
    const x = build({ sessions })
    expect(x.needs.map((n) => n.chat)).toEqual(['q', 'perm', 'crash', 'fail', 'ask'])
    expect(x.needs[1].what).toBe('needs permission for Bash: rm -rf dist')
    expect(x.needs[4].what).toBe('ended on a question: Shall I push it?')
  })

  it('takes ETAs from progress boards and the status line, never its own guess', () => {
    const sessions = [
      chat('plain', { state: 'running', events: [[-5, user('think')]], work: { start: T - 5 * MIN } }),
      chat('boarded', { state: 'running', events: [[-20, user('build')]], work: { start: T - 20 * MIN } }),
      chat('bg', {
        state: 'idle',
        events: [[-50, user('tests')], [-49, ok]],
        work: { bg: [{ label: 'Run the test suite', startedAt: T - 49 * MIN, backgrounded: true, pct: null, etaAt: T + 25 * MIN, basis: 'history', typicalMs: 74 * MIN }] },
      }),
    ]
    const boards = [
      board({ id: 'mine', chat: 'sdk-boarded', etaAt: T + 10 * MIN, lanes: [{ id: 'l', name: 'Lane one', status: 'running', pct: 50, etaAt: T + 10 * MIN, etaDerived: true }] }),
      board({ id: 'loose', title: 'Render', cwd: '/dev/film', chat: 'elsewhere', etaAt: T + 40 * MIN, pct: 80 }),
    ]
    const x = build({ sessions, boards })
    expect(x.running.map((r) => r.board ?? r.chat)).toEqual(['boarded', 'bg', 'loose', 'plain'])
    expect(x.running[0]).toMatchObject({ kind: 'chat', pct: 40, eta: { at: T + 10 * MIN, basis: 'reported' }, tasks: [{ label: 'Lane one', pct: 50 }] })
    expect(x.running[1]).toMatchObject({ kind: 'background', eta: { at: T + 25 * MIN, basis: 'history', typical: 74 * MIN } })
    expect(x.running[2]).toMatchObject({ kind: 'board', repo: 'film', pct: 80 })
    expect(x.running[3].eta).toBe(null)
    expect(x.headline).toContain('4 running, next done ~14:10')
  })

  it('flags blocked, stalled and orphaned boards, and lists finished ones', () => {
    const boards = [
      board({ id: 'blk', title: 'Deploy', state: 'blocked', lanes: [{ id: 'l', name: 'Approve', status: 'blocked', note: 'needs a DNS record' }] }),
      board({ id: 'stl', state: 'stalled', quietMs: 25 * MIN }),
      board({ id: 'orp', state: 'orphaned' }),
      board({ id: 'fin', title: 'Captures', state: 'done', endedAt: T - 10 * MIN, note: 'all 12 captured' }),
    ]
    const x = build({ boards })
    expect(x.needs.map((n) => n.board)).toEqual(['blk', 'stl', 'orp'])
    expect(x.needs[0].what).toBe('progress board "Deploy" is blocked on you (Approve: needs a DNS record)')
    expect(x.finished).toEqual([expect.objectContaining({ board: 'fin', tasks: ['all 12 captured'], now: '' })])
    expect(x.running).toEqual([])
  })

  it('shows a usage limit away mode is waiting out as running until the reset', () => {
    const s = chat('lim', { events: [[-20, user('go')], [-15, failed("You've hit your session limit · resets 3pm")]] })
    const x = build({ sessions: [s], away: { on: true, until: T + HOUR() }, recovery: () => ({ limitUntil: T + 61 * MIN }) })
    expect(x.needs).toEqual([])
    expect(x.running[0]).toMatchObject({ kind: 'limit', eta: { at: T + 61 * MIN, basis: 'limit reset' } })
  })

  it('groups the away log by chat and keeps recoveries in order', () => {
    const at = (m) => new Date(T + m * MIN).toISOString()
    const log = [
      { at: at(-90), kind: 'approved', chat: 'a', repo: 'orbit', tool: 'Edit' },
      { at: at(-50), kind: 'approved', chat: 'a', repo: 'orbit', tool: 'Edit' },
      { at: at(-40), kind: 'approved', chat: 'a', repo: 'orbit', tool: 'Bash', input: 'pnpm test --run' },
      { at: at(-30), kind: 'approved', chat: 'a', repo: 'orbit', tool: 'Edit' },
      { at: at(-20), kind: 'asked', chat: 'a', repo: 'orbit', tool: 'Bash', input: 'git push' },
      { at: at(-15), kind: 'recovery', action: 'waiting', chat: 'a', repo: 'orbit', reason: 'its turn failed; trying again in 1m' },
      { at: at(-14), kind: 'recovery', action: 'retry', chat: 'a', repo: 'orbit', reason: 'its turn failed; attempt 1: sending "continue"' },
    ]
    const x = build({ sessions: [chat('a', { repo: 'orbit', title: 'Summary card' })], log })
    expect(x.auto).toMatchObject({ approved: 3, left: 1, recoveries: 1 })
    expect(x.auto.byChat).toEqual([expect.objectContaining({ title: 'Summary card', n: 3, tools: 'Edit ×2, pnpm test' })])
    expect(x.auto.recovered.map((r) => r.action)).toEqual(['retry'])
  })

  it('files every row under its chat’s group, else its repo, and lays the away page out by project', () => {
    const at = (m) => new Date(T + m * MIN).toISOString()
    const grouped = (id, group, o) => Object.assign(chat(id, o), { group })
    const sessions = [
      grouped('fin', 'Orbit', { repo: 'orbit', title: 'Card', events: [[-40, user('build it')], [-20, ok]] }),
      grouped('ask', 'Orbit', { repo: 'site', state: 'waiting', pending: [{ kind: 'question', event: { at: T - 2 * MIN, questions: [{ question: 'Ship?' }] } }] }),
      grouped('run', 'Atlas', { repo: 'atlas', state: 'running', events: [[-5, user('go')]], work: { start: T - 5 * MIN } }),
      grouped('loose', '  ', { repo: 'notes', events: [[-30, user('tidy')], [-25, ok]] }),
    ]
    const log = [
      { at: at(-30), kind: 'approved', chat: 'fin', repo: 'orbit', tool: 'Edit' },
      // a chat closed since: its group went with it, so it files under its repo
      { at: at(-20), kind: 'approved', chat: 'gone', repo: 'old-repo', tool: 'Edit' },
      { at: at(-10), kind: 'recovery', action: 'retry', chat: 'run', repo: 'atlas', reason: 'retried' },
    ]
    const x = build({ sessions, log, kind: 'away' })
    expect(x.needs[0]).toMatchObject({ chat: 'ask', group: 'group:Orbit' })
    expect(x.finished.map((f) => [f.chat, f.group])).toEqual(expect.arrayContaining([['fin', 'group:Orbit'], ['loose', 'repo:notes']]))
    expect(x.auto.byChat.map((a) => [a.chat, a.group])).toEqual(expect.arrayContaining([['fin', 'group:Orbit'], ['gone', 'repo:old-repo']]))
    expect(x.auto.recovered[0].group).toBe('group:Atlas')
    // the one that needs you first, then named groups, then repos
    expect(x.groups.map((g) => [g.label, g.kind])).toEqual([['Orbit', 'group'], ['Atlas', 'group'], ['notes', 'repo'], ['old-repo', 'repo']])
    expect(x.groups[0]).toMatchObject({ rank: 0, needs: 1, finished: 1, approved: 1 })
    // the flat lists are still there for older readers
    expect(x.finished).toHaveLength(2)

    const md = renderMarkdown(x)
    expect(md).toContain('1. **site** _(Orbit)_ asks you: Ship?')
    expect(md.indexOf('## Orbit')).toBeLessThan(md.indexOf('## Atlas'))
    expect(md.slice(md.indexOf('## Orbit'), md.indexOf('## Atlas'))).toContain('- **orbit · Card** auto-approved 1: Edit')
    expect(md.slice(md.indexOf('## Atlas'))).toContain('**atlas** retried')
    expect(md).not.toContain('## Running')

    // a chat's group can come from elsewhere, and an hourly page keeps its sections
    const y = build({ sessions, log, groupOf: (id) => (id === 'gone' ? 'Archive' : undefined) })
    expect(y.auto.byChat.find((a) => a.chat === 'gone').group).toBe('group:Archive')
    expect(renderMarkdown(y)).toContain('## Running')
  })

  it('says a quiet hour plainly, and renders every section of the page', () => {
    expect(build({}).headline).toBe('Quiet: nothing finished, running or waiting on you')
    const md = renderMarkdown(build({ sessions: [chat('q', { state: 'waiting', pending: [{ kind: 'question', event: { at: T - 2 * MIN, questions: [{ question: 'Which?' }] } }] })] }))
    for (const h of ['# Hourly summary · 13:00–14:00', '## Needs you', '## Running', '## Finished', '## Auto-approved and recovered']) expect(md).toContain(h)
    expect(md).toContain('1. **repo** asks you: Which? _(2m)_')
  })
})

describe('etaText', () => {
  it('counts down to an ETA and says when it is overdue', () => {
    expect(etaText({ at: T + 25 * MIN, basis: 'history', typical: null, over: false }, T)).toBe('~25m left, by 14:25 (from earlier runs)')
    expect(etaText({ at: T - MIN, basis: 'history', typical: 20 * MIN, over: true }, T)).toBe('overdue (usually 20m)')
    expect(etaText(null, T)).toBe(null)
  })
})

describe('createSummaries', () => {
  let dir
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(T + 20 * MIN))
    dir = mkdtempSync(join(tmpdir(), 'summary-'))
  })
  afterEach(() => vi.useRealTimers())

  const routine = (o = {}) =>
    createSummaries({ sessions: new Map(), readLog: () => [], dir: join(dir, 'kept'), widget: join(dir, 'summary.json'), ...o })

  it('fills the card on start, then writes at the top of every hour', async () => {
    const r = routine()
    await r.start()
    expect(r.list()).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'))).toMatchObject({ id: 'summary', kind: 'summary', config: { nextAt: T + 60 * MIN } })
    await vi.advanceTimersByTimeAsync(41 * MIN)
    const ids = r.list()
    expect(ids).toHaveLength(2)
    expect(ids[0]).toMatch(/-hourly$/)
    expect(r.get(ids[0])).toMatchObject({ kind: 'hourly', to: T + 60 * MIN + 1000 })
    expect(r.markdown(ids[0])).toContain('# Hourly summary · 14:00–15:00')
    r.close()
  })

  it('writes the time away on one page when away mode ends, and keeps it on the card as a recap', async () => {
    const r = routine()
    await r.awayEnded({ startedAt: T - 3 * HOUR(), endedAt: T + 20 * MIN })
    const away = r.latest()
    expect(away).toMatchObject({ kind: 'away', from: T - 3 * HOUR() })
    expect(readdirSync(join(dir, 'kept')).filter((f) => f.endsWith('.md'))).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(MIN)
    await r.now()
    expect(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).config.recap).toMatchObject({ id: away.id })
    r.close()
  })

  it('reads progress boards when there are some, and carries on without them', async () => {
    const r = routine({
      boards: () => {
        throw new Error('no progress store')
      },
    })
    expect((await r.now()).running).toEqual([])
    const r2 = routine({ boards: async () => [board({ id: 'x', title: 'Render', etaAt: T + HOUR() })] })
    expect((await r2.now()).running[0]).toMatchObject({ kind: 'board', title: 'Render' })
    expect(existsSync(join(dir, 'summary.json'))).toBe(true)
  })

  it('knows the next top of the hour', () => {
    expect(nextHour(T)).toBe(T + HOUR())
    expect(nextHour(T + 59 * MIN)).toBe(T + HOUR())
  })
})

function HOUR() {
  return 60 * MIN
}
