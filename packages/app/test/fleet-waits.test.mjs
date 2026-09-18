import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fleetTools, restoredCloseAfter, ROLE, savedCloseAfter, settleCheckpointClose, watchFleet } from '../conductor.mjs'
import { gitHead, handoffBrief } from '../fleet-work.mjs'

const MIN = 60_000
const stand = (name, _d, _schema, handler) => ({ name, handler })

describe('fleet_wait', () => {
  let sessions, lead, x, tools, fleet
  const call = async (name, args) => {
    const r = await tools.find((t) => t.name === name).handler(args)
    return { error: !!r.isError, text: r.content[0].text }
  }
  const sent = () => lead.send.mock.calls.map((c) => c[0]).join('\n')
  beforeEach(() => {
    vi.useFakeTimers()
    process.env.LAIKA_CONDUCTOR_NOTES = join(mkdtempSync(join(tmpdir(), 'waits-')), 'notes.json')
    sessions = new Map()
    lead = { id: 'lead0000', role: ROLE, state: 'idle', autopilot: true, pending: new Map(), events: [], emit: vi.fn(), send: vi.fn() }
    x = { id: 'web00000', repo: 'web', cwd: '/w', state: 'running', role: null, pending: new Map(), events: [], cost: 0, updatedAt: Date.now(), background: () => [] }
    sessions.set(lead.id, lead).set(x.id, x)
    fleet = watchFleet(sessions)
    tools = fleetTools(lead, sessions, stand, {})
  })
  afterEach(() => vi.useRealTimers())

  it('wakes the conductor within seconds when the chat goes idle, with its note, and shows the wait in fleet_list', async () => {
    expect((await call('fleet_wait', { chat: 'web', until: 'idle', note: 'build done?' })).text).toMatch(/^Waiting for web00000 \(web\) until idle, for at most 60m/)
    expect(JSON.parse((await call('fleet_list', {})).text).waits).toEqual(['web00000 (web) until idle, 60m left: build done?'])
    // running to waiting on a permission: not idle yet
    x.state = 'waiting'
    x.pending.set('r', { kind: 'permission' })
    fleet.onState(x)
    expect(lead.waits).toHaveLength(1)
    x.pending.clear()
    x.state = 'idle'
    fleet.onState(x)
    expect(lead.waits).toEqual([])
    await vi.advanceTimersByTimeAsync(4_000)
    expect(lead.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(lead.send).toHaveBeenCalledTimes(1)
    expect(sent()).toMatch(/^\[autopilot\] A chat you were waiting on has news:\n- web00000 \(web\) is now idle \(you were waiting: build done\?\)/)
    // the wait's line replaces the plain "is now idle" one
    expect(sent().match(/is now idle/g)).toHaveLength(1)
  })

  it('says so when the chat is already there, and asking again replaces the wait', async () => {
    x.state = 'idle'
    expect((await call('fleet_wait', { chat: 'web', until: 'idle' })).text).toBe('web00000 (web) is now idle already: nothing to wait for.')
    expect(lead.waits).toBeUndefined()
    await call('fleet_wait', { chat: 'web', until: 'needs-user', timeoutMinutes: 5 })
    await call('fleet_wait', { chat: 'web', until: 'needs-user', timeoutMinutes: 30 })
    expect(lead.waits).toHaveLength(1)
    expect(lead.waits[0].timeoutAt - lead.waits[0].at).toBe(30 * MIN)
    expect((await call('fleet_wait', { chat: 'nope', until: 'idle' })).error).toBe(true)
  })

  it('wakes when background work ends, from the host telling it tasks changed', async () => {
    x.state = 'idle'
    let bg = [{ label: 'Run build' }]
    x.background = () => bg
    await call('fleet_wait', { chat: 'web', until: 'background-done', note: 'then deploy' })
    fleet.tasksChanged(x)
    expect(lead.waits).toHaveLength(1)
    bg = []
    fleet.tasksChanged(x)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(sent()).toMatch(/- web00000 \(web\) has no background work left \(you were waiting: then deploy\)/)
  })

  it('times out with a line saying where the chat stands', async () => {
    await call('fleet_wait', { chat: 'web', until: 'idle', timeoutMinutes: 2 })
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(lead.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(MIN + 6_000)
    expect(sent()).toMatch(/- Wait timed out after 2m: web00000 \(web\) is running, not yet idle \(you were waiting for idle\)/)
    expect(lead.waits).toEqual([])
  })

  it('ends with "was closed" when the chat closes, or is gone', async () => {
    await call('fleet_wait', { chat: 'web', until: 'idle', note: 'merge after' })
    x.state = 'closed'
    fleet.onState(x)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(sent()).toMatch(/- web00000 \(web\) was closed \(you were waiting: merge after\)/)
  })

  it('without autopilot, leaves a note in the conductor chat instead of a check-in', async () => {
    lead.autopilot = false
    await call('fleet_wait', { chat: 'web', until: 'any-change' })
    fleet.onState(x) // nothing changed yet
    expect(lead.emit).not.toHaveBeenCalled()
    x.state = 'idle'
    fleet.onState(x)
    expect(lead.emit).toHaveBeenCalledWith({ t: 'note', text: 'web00000 (web) changed: now idle (you were waiting for any-change)' })
    await vi.advanceTimersByTimeAsync(3 * MIN)
    expect(lead.send).not.toHaveBeenCalled()
  })
})

describe('checkpoint-close across a restart', () => {
  let sessions, lead, x, close, tell, dirty
  const since = 1_700_000_000_000
  const settle = () => settleCheckpointClose(x, sessions, { dirty, close, tell })
  beforeEach(() => {
    sessions = new Map()
    lead = { id: 'lead0000', role: ROLE, state: 'idle', autopilot: true, pending: new Map(), events: [] }
    // a restored chat: fresh seqs, the history's own times, and the checkpoint prompt no longer marked automatic
    x = {
      id: 'kid00000', repo: 'web', cwd: '/w', state: 'idle', role: null, spawnedBy: lead.id, pending: new Map(), background: () => [],
      events: [
        { seq: 1, at: since - 60_000, t: 'user', text: 'build the footer', history: true },
        { seq: 2, at: since + 1_000, t: 'user', text: '[/checkpoint] Checkpoint this chat now.', history: true },
        { seq: 3, at: since + 9_000, t: 'text', text: 'Checkpoint: abc1234 · stopped nothing · resume: none', history: true },
        { seq: 4, at: Date.now(), t: 'note', text: 'Recovered after a restart' },
      ],
    }
    sessions.set(lead.id, lead).set(x.id, x)
    close = vi.fn(async () => {})
    tell = vi.fn()
    dirty = vi.fn(async () => false)
  })

  it('keeps only what survives a restart in the registry row', () => {
    expect(savedCloseAfter({ conductor: 'lead0000', reason: 'done', mark: 42, since, settling: false })).toEqual({ conductor: 'lead0000', reason: 'done', since })
    expect(savedCloseAfter(null)).toBeNull()
    expect(restoredCloseAfter(null)).toBeNull()
    expect(restoredCloseAfter({ conductor: 'lead0000', reason: 'done', since }, { busy: true })).toEqual({ conductor: 'lead0000', reason: 'done', since, mark: null, restored: 'busy' })
  })

  it('closes a chat restored idle: its checkpoint had run, even with no result event in the history', async () => {
    x.closeAfter = restoredCloseAfter({ conductor: 'lead0000', reason: 'brief done', since })
    expect(await settle()).toBe('closed')
    expect(close).toHaveBeenCalledWith(lead, x, { reason: 'brief done · Checkpoint: abc1234 · stopped nothing · resume: none', force: false })
    expect(x.closeAfter).toBeNull()
  })

  it('leaves it open when the user wrote after the checkpoint was asked, or the host died mid-checkpoint', async () => {
    x.events.push({ seq: 5, at: since + 20_000, t: 'user', text: 'wait, one more thing', history: true })
    x.closeAfter = restoredCloseAfter({ conductor: 'lead0000', reason: '', since })
    expect(await settle()).toBe('left')
    expect(tell.mock.lastCall[1]).toMatch(/The user wrote to kid00000/)

    x.events.pop()
    x.closeAfter = restoredCloseAfter({ conductor: 'lead0000', reason: '', since }, { busy: true })
    expect(await settle()).toBe('left')
    expect(tell.mock.lastCall[1]).toMatch(/host restarted during kid00000 \(web\)'s checkpoint: left open/)
    expect(close).not.toHaveBeenCalled()
  })

  it('drops it quietly when its conductor did not come back', async () => {
    sessions.delete(lead.id)
    x.closeAfter = restoredCloseAfter({ conductor: 'lead0000', reason: '', since })
    expect(await settle()).toBe('orphaned')
    expect(tell).not.toHaveBeenCalled()
  })
})

describe('fleet_handoff', () => {
  const head = { branch: 'feat/footer', sha: 'abc1234', changed: 0 }
  const from = (o = {}) => ({
    id: 'from0000', repo: 'site', cwd: '/r/site', state: 'idle', role: null, pending: new Map(),
    brief: { goal: 'Build the footer', now: 'Footer done and committed' },
    events: [
      { t: 'text', text: 'Checkpoint: abc1234 · stopped nothing · resume: none' },
      { t: 'text', text: 'sub-agent chatter', sub: true },
      { t: 'text', text: 'The footer is in, tests pass.\nBranch feat/footer.' },
    ],
    ...o,
  })

  it('builds the brief from the checkpoint, git, the chat brief and its last reply', () => {
    const b = handoffBrief(from(), { head, note: 'Merge it into the landing page' })
    expect(b).toBe(
      [
        'Handoff from chat from0000 (site), in /r/site.',
        'Its goal: Build the footer',
        'Where it stands: Footer done and committed',
        'Checkpoint: abc1234 · stopped nothing · resume: none',
        'Git: feat/footer at abc1234',
        '',
        'Its last reply:',
        'The footer is in, tests pass.\nBranch feat/footer.',
        '',
        'What to do with it: Merge it into the landing page',
      ].join('\n'),
    )
    const long = handoffBrief(from({ brief: null, events: [{ t: 'text', text: 'x'.repeat(4000) }] }), { head: { branch: 'main', sha: null, changed: 2 } })
    expect(long).toMatch(/Git: main at no commits yet, 2 file\(s\) with uncommitted changes/)
    expect(long).toMatch(new RegExp(`\\n${'x'.repeat(1500)}…\\n`))
    expect(long).toMatch(/What to do with it: carry on from here\.$/)
    expect(handoffBrief(from({ events: [] }), {})).not.toMatch(/Git:|last reply/)
  })

  it('reads branch, HEAD and changes from one git call, and null outside a repo', async () => {
    const run = (out, err = null) => (_c, _a, _o, cb) => cb(err, out, '')
    expect(await gitHead('/x', { run: run('# branch.oid 0123456789abcdef\n# branch.head cc-waits\n1 .M N... 100644 100644 100644 a b f.mjs\n') })).toEqual({ branch: 'cc-waits', sha: '0123456', changed: 1 })
    expect(await gitHead('/x', { run: run('# branch.oid (initial)\n# branch.head main\n') })).toEqual({ branch: 'main', sha: null, changed: 0 })
    expect(await gitHead(mkdtempSync(join(tmpdir(), 'nogit-')))).toBeNull()
  })

  it('sends it to an open chat marked as from the conductor, or opens a new chat with it', async () => {
    const sessions = new Map()
    const lead = { id: 'lead0000', role: ROLE, state: 'idle', autopilot: true, pending: new Map(), events: [] }
    const to = { id: 'to000000', repo: 'site', cwd: '/r/site', state: 'idle', role: null, pending: new Map(), events: [], send: vi.fn() }
    const x = from()
    sessions.set(lead.id, lead).set(x.id, x).set(to.id, to)
    const spawn = vi.fn(async (_c, o) => ({ id: 'new00000', repo: 'site', cwd: o.cwd }))
    const tools = fleetTools(lead, sessions, stand, { spawn, head: vi.fn(async () => head) })
    const call = async (a) => {
      const r = await tools.find((t) => t.name === 'fleet_handoff').handler(a)
      return { error: !!r.isError, text: r.content[0].text }
    }
    expect(await call({ from: 'from', to: 'to0', note: 'review it' })).toEqual({ error: false, text: "Handed from0000's result to to000000 (site). It was idle and has started." })
    expect(to.send.mock.lastCall[0]).toMatch(/^\[from the conductor\] Handoff from chat from0000 \(site\)[\s\S]*Git: feat\/footer at abc1234[\s\S]*What to do with it: review it$/)

    expect((await call({ from: 'from', toCwd: 'site', note: 'deploy a preview' })).text).toMatch(/^Opened new00000 in site with from0000's result/)
    expect(spawn).toHaveBeenCalledWith(lead, expect.objectContaining({ cwd: '/r/site', prompt: expect.stringMatching(/^\[from the conductor\] Handoff[\s\S]*deploy a preview$/) }))

    expect((await call({ from: 'from', to: 'to0', toCwd: '/r', note: 'n' })).text).toMatch(/either to/)
    to.pending.set('q', { kind: 'question' })
    expect((await call({ from: 'from', to: 'to0', note: 'n' })).text).toMatch(/waiting on the user \(question\)/)
    x.state = 'running'
    expect((await call({ from: 'from', to: 'to0', note: 'n' })).text).toMatch(/still working: wait for it \(fleet_wait until idle\)/)
    lead.autopilot = false
    expect((await call({ from: 'from', to: 'to0', note: 'n' })).text).toMatch(/Autopilot is off/)
    expect(to.send).toHaveBeenCalledTimes(1)
  })
})
