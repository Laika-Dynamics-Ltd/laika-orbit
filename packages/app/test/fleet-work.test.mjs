import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalisePolicy, readAwayLog } from '../away-policy.mjs'
import { createAway } from '../away.mjs'
import { fleetTools, ROLE, settleCheckpointClose } from '../conductor.mjs'
import { closeRefusal, createTaskTracker, etaText, groupLabel, worktreeDirty, expandFleetCommand, FLEET_COMMANDS, inferGroup, progressOf, recordDuration, spawnRefusal, taskKey } from '../fleet-work.mjs'
import { setAwayBudget, watchFleet } from '../conductor.mjs'
import { createParked, MAX_SPAWNED, parkedRow, spawnHold, spawnSlots, STALE_MS, staleHint } from '../fleet-work.mjs'

const MIN = 60_000

describe('fleet commands', () => {
  it('expands /checkpoint and /resume-offload, with extra words, and leaves anything else alone', () => {
    const cp = expandFleetCommand('/checkpoint')
    expect(cp).toMatch(/^\[\/checkpoint\]/)
    expect(cp).toMatch(/Never push/)
    expect(cp).toMatch(/Checkpoint: <short sha/)
    expect(expandFleetCommand('/checkpoint  skip the docs')).toMatch(/Also: skip the docs$/)
    const ro = expandFleetCommand('/resume-offload')
    expect(ro).toMatch(/offload\.mjs"? run \[--needs gpu\]/)
    expect(ro).toMatch(/BRAIN_ROOT=/)
    expect(expandFleetCommand('/compact')).toBeNull()
    expect(expandFleetCommand('please /checkpoint')).toBeNull()
    expect(expandFleetCommand('')).toBeNull()
    expect(Object.keys(FLEET_COMMANDS)).toEqual(['checkpoint', 'resume-offload'])
  })
})

describe('progress in output', () => {
  it('reads the last percentage or count, ignoring colour codes and older lines', () => {
    expect(progressOf('building\n\x1b[32m 45%\x1b[0m')).toBeCloseTo(0.45)
    expect(progressOf('10%\n20%\r30%')).toBeCloseTo(0.3)
    expect(progressOf('[12/80] compiling foo.c')).toBeCloseTo(0.15)
    expect(progressOf('test 3 of 4 done')).toBeCloseTo(0.75)
    expect(progressOf('no numbers here')).toBeNull()
    // a date or a ratio above 1 is not progress
    expect(progressOf('ran 9/3 cases')).toBeNull()
    expect(progressOf('150% zoom')).toBeNull()
  })
})

describe('background task tracker', () => {
  let dir, now
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-work-'))
    process.env.LAIKA_TASK_DURATIONS = join(dir, 'durations.json')
    now = 1_000_000
  })

  it('follows tasks from start to end, skips ambient ones, and ETAs from the output', () => {
    const out = join(dir, 'task.output')
    writeFileSync(out, 'step 1\n')
    const t = createTaskTracker({ now: () => now, output: () => out })
    expect(t.handle({ subtype: 'task_started', task_id: 'a', task_type: 'local_bash', description: 'Run build', is_backgrounded: true })).toBe(true)
    expect(t.handle({ subtype: 'task_started', task_id: 'w', task_type: 'local_bash', description: 'watch', ambient: true })).toBe(false)
    expect(t.size).toBe(1)
    let [v] = t.view('sdk')
    expect(v).toMatchObject({ id: 'a', label: 'Run build', type: 'local_bash', backgrounded: true, pct: null, etaAt: null, basis: null })
    expect(etaText(v, now + 30_000)).toBe('30s in')

    now += 60_000
    writeFileSync(out, 'step 1\n[25/100] compiling\n')
    ;[v] = t.view('sdk')
    expect(v.pct).toBe(25)
    expect(v.basis).toBe('progress')
    // a quarter done in a minute: three more to go
    expect(v.etaAt).toBe(now + 3 * MIN)
    expect(etaText(v, now)).toBe('~3m left')

    expect(t.handle({ subtype: 'task_notification', task_id: 'a', status: 'completed' })).toBe(true)
    expect(t.size).toBe(0)
  })

  it('learns how long a kind of task takes and ETAs the next one from it', () => {
    recordDuration(taskKey('local_bash', 'Run tests 42'), 4 * MIN)
    recordDuration(taskKey('local_bash', 'Run tests 7'), 6 * MIN)
    recordDuration(taskKey('local_bash', 'Run tests 9'), 5 * MIN)
    const t = createTaskTracker({ now: () => now, output: () => null })
    t.handle({ subtype: 'task_started', task_id: 'b', task_type: 'local_bash', description: 'Run tests 11' })
    now += MIN
    const [v] = t.view('sdk')
    expect(v).toMatchObject({ basis: 'history', typicalMs: 5 * MIN, etaAt: now + 4 * MIN })
    expect(etaText(v, now)).toBe('~4m left')
    expect(etaText(v, now + 6 * MIN)).toBe('overdue (usually 5m)')
  })

  it('takes the background level as the truth, and forgets everything when Claude Code restarts', () => {
    const t = createTaskTracker({ now: () => now, output: () => null })
    t.handle({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'x', task_type: 'local_agent', description: 'Explore' }, { task_id: 'y', task_type: 'local_bash', description: 'poll', ambient: true }] })
    expect(t.view('s').map((v) => v.id)).toEqual(['x'])
    now += 90_000
    expect(t.handle({ subtype: 'background_tasks_changed', tasks: [] })).toBe(true)
    expect(t.size).toBe(0)
    // the notification after the level still records how long it took, to when it left the level
    now += 5_000
    expect(t.handle({ subtype: 'task_notification', task_id: 'x', status: 'completed' })).toBe(false)
    const again = createTaskTracker({ now: () => now, output: () => null })
    again.handle({ subtype: 'task_started', task_id: 'x2', task_type: 'local_agent', description: 'Explore' })
    expect(again.view('s')[0].typicalMs).toBe(90_000)
    t.handle({ subtype: 'task_started', task_id: 'z', description: 'Deploy' })
    // init starts every turn, not only a new process: background work carries on through it
    expect(t.handle({ subtype: 'init' })).toBe(false)
    expect(t.size).toBe(1)
    expect(t.reset()).toBe(true)
    expect(t.size).toBe(0)
    t.handle({ subtype: 'task_started', task_id: 'k', description: 'Killed one' })
    expect(t.handle({ subtype: 'task_updated', task_id: 'k', patch: { status: 'killed' } })).toBe(true)
  })
})

describe('fleet_spawn', () => {
  let dir, sessions, lead, tools, spawn, away
  const stand = (name, _d, _schema, handler) => ({ name, handler })
  const call = async (name, args) => {
    const r = await tools.find((t) => t.name === name).handler(args)
    return { error: !!r.isError, text: r.content[0].text }
  }
  beforeEach(() => {
    vi.useFakeTimers()
    dir = mkdtempSync(join(tmpdir(), 'spawn-'))
    mkdirSync(join(dir, 'web'))
    process.env.LAIKA_CONDUCTOR_NOTES = join(dir, 'notes.json')
    process.env.LAIKA_AWAY_LOG = join(dir, 'away-log.jsonl')
    process.env.LAIKA_AWAY_POLICY = join(dir, 'away-policy.json')
    sessions = new Map()
    lead = { id: 'lead0000', role: ROLE, state: 'idle', autopilot: true, pending: new Map(), events: [], account: { id: 'me', label: 'Me' }, emit() {} }
    sessions.set(lead.id, lead)
    sessions.set('webchat1', { id: 'webchat1', repo: 'web', cwd: join(dir, 'web'), state: 'idle', role: null, pending: new Map(), events: [], cost: 0, updatedAt: Date.now() })
    away = createAway({ sessions, fleet: { awayNote() {}, setAutopilot() {} }, file: join(dir, 'away.json'), deps: { startConductor: async () => lead }, policy: () => normalisePolicy(null) })
    spawn = vi.fn(async (c, o) => {
      const x = { id: `new${sessions.size}0000`, repo: 'web', cwd: o.cwd, account: { label: 'Me' }, spawnedBy: c.id }
      away.spawned(c, x, o.prompt)
      return x
    })
    tools = fleetTools(lead, sessions, stand, { spawn })
  })
  afterEach(() => {
    away.close()
    vi.useRealTimers()
  })

  it('opens a chat by repo name or path, and the spawn is in the away log and summary', async () => {
    await away.start({ minutes: 60 })
    const r = await call('fleet_spawn', { cwd: 'web', prompt: 'Fix the footer' })
    expect(r.error).toBe(false)
    expect(spawn).toHaveBeenCalledWith(lead, expect.objectContaining({ cwd: join(dir, 'web'), prompt: 'Fix the footer' }))
    expect(readAwayLog().some((row) => row.kind === 'spawn' && row.input === 'Fix the footer')).toBe(true)
    expect(away.digest().spawned[0]).toMatch(/opened by the conductor lead0000 on Me: Fix the footer/)
  })

  it("passes the host's refusal back to the conductor", async () => {
    spawn.mockRejectedValueOnce(new Error('3 conductor-spawned chats are already open'))
    const r = await call('fleet_spawn', { cwd: '/x', prompt: 'more' })
    expect(r).toEqual({ error: true, text: '3 conductor-spawned chats are already open' })
  })

  it('shows spawned chats and their background work in fleet_list', async () => {
    const web = sessions.get('webchat1')
    web.spawnedBy = lead.id
    web.background = () => [{ label: 'Run build', startedAt: Date.now() - MIN, etaAt: Date.now() + 2 * MIN, basis: 'history', typicalMs: 3 * MIN }]
    const r = JSON.parse((await call('fleet_list', {})).text)
    expect(r.chats[0]).toMatchObject({ spawnedByConductor: 'lead0000', background: ['Run build: ~2m left (history)'] })
  })
})

describe('live-progress boards', () => {
  it("shows a chat's own running boards, with a stated ETA as not derived", async () => {
    const { boardTasks } = await import('../fleet-work.mjs')
    const list = () => [
      { id: 'site', chat: 'sdk-1', title: 'Site build', state: 'running', createdAt: 5, pct: 40.4, etaAt: 9000, etaDerived: false, note: 'lane 2 of 5' },
      { id: 'old', chat: 'sdk-1', title: 'Old', state: 'done', createdAt: 1, etaAt: null },
      { id: 'other', chat: 'sdk-2', title: 'Theirs', state: 'running', createdAt: 1, etaAt: 7000, etaDerived: true },
    ]
    expect(boardTasks('sdk-1', { list })).toEqual([
      { id: 'board:site', source: 'board', label: 'Site build', type: 'progress_board', startedAt: 5, backgrounded: true, pct: 40, etaAt: 9000, etaDerived: false, etaPartial: false, basis: 'explicit', typicalMs: null, summary: 'lane 2 of 5', state: 'running' },
    ])
    expect(boardTasks(null, { list })).toEqual([])
  })
})

describe('spawn limit', () => {
  it('refuses a ninth open conductor-spawned chat; closed ones and ordinary chats do not count', () => {
    const m = new Map()
    const add = (id, o) => m.set(id, { id, repo: 'r', state: 'idle', spawnedBy: null, ...o })
    for (const id of 'abcdefg') add(id, { spawnedBy: 'lead' })
    add('x', { spawnedBy: 'lead', state: 'closed' })
    add('y', {})
    expect(spawnRefusal(m)).toBeNull()
    add('h', { spawnedBy: 'lead2' })
    expect(spawnRefusal(m)).toMatch(/^8 conductor-spawned chats are already open \(the limit is 8\)/)
  })

  it('holds new chats under the cap while this Mac or box1 is loaded or the away budget is low, and says why', () => {
    const m = new Map([['a', { id: 'a', repo: 'r', state: 'idle', spawnedBy: 'lead' }]])
    const now = Date.now()
    const box1 = (load) => ({ at: now, routes: { cpuAll: ['box1'] }, machines: [{ name: 'box1', online: true, load, cores: 8 }] })
    const hold = (o) => () => spawnHold({ load: null, machines: null, now, ...o })
    expect(spawnRefusal(m, { hold: hold({ machines: box1(2) }) })).toBeNull()
    expect(spawnRefusal(m, { hold: hold({ load: { busy: true, at: now, notice: 'Mac busy: Unity is heavy' } }) })).toMatch(/^Holding new chats for now: Mac busy: Unity is heavy/)
    expect(spawnRefusal(m, { hold: hold({ machines: box1(7.5) }) })).toMatch(/box1 is loaded \(load 7\.5 on 8 cores\)/)
    expect(spawnRefusal(m, { hold: hold({ budgetLow: () => 'the away budget is low ($0.80 of $10 left)' }) })).toMatch(/away budget is low/)
    // a stale reading is unknown, never busy
    expect(spawnRefusal(m, { hold: hold({ load: { busy: true, at: now - 3_600_000 } }) })).toBeNull()
    expect(spawnSlots(m, { hold: hold({ machines: box1(8) }) })).toMatchObject({ free: 0, held: expect.stringMatching(/box1/) })
  })
})

describe('fleet_close', () => {
  let dir, sessions, lead, tools, close, away, dirty
  const stand = (name, _d, _schema, handler) => ({ name, handler })
  const call = async (name, args) => {
    const r = await tools.find((t) => t.name === name).handler(args)
    return { error: !!r.isError, text: r.content[0].text }
  }
  const chat = (id, o = {}) => {
    const x = { id, repo: 'web', cwd: join(dir, 'web'), state: 'idle', role: null, pending: new Map(), events: [], cost: 0, updatedAt: Date.now(), spawnedBy: lead.id, background: () => [], ...o }
    sessions.set(id, x)
    return x
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'close-'))
    mkdirSync(join(dir, 'web'))
    process.env.LAIKA_CONDUCTOR_NOTES = join(dir, 'notes.json')
    process.env.LAIKA_AWAY_LOG = join(dir, 'away-log.jsonl')
    process.env.LAIKA_AWAY_POLICY = join(dir, 'away-policy.json')
    sessions = new Map()
    lead = { id: 'lead0000', role: ROLE, state: 'idle', autopilot: true, pending: new Map(), events: [], account: { id: 'me', label: 'Me' }, emit() {} }
    sessions.set(lead.id, lead)
    away = createAway({ sessions, fleet: { awayNote() {}, setAutopilot() {} }, file: join(dir, 'away.json'), deps: { startConductor: async () => lead }, policy: () => normalisePolicy(null) })
    dirty = vi.fn(async () => false)
    // the host's close, as far as the tool can see: the chat ends, away mode logs it
    close = vi.fn(async (c, x, o) => {
      x.state = 'closed'
      sessions.delete(x.id)
      away.closed(c, x, o)
    })
    tools = fleetTools(lead, sessions, stand, { close, dirty })
  })
  afterEach(() => away.close())

  it('closes an idle, clean chat it opened, logs it, and frees a spawn slot', async () => {
    for (let i = 1; i <= MAX_SPAWNED; i++) chat(`sp${i}${'abcdefgh'[i - 1].repeat(5)}`)
    expect(spawnRefusal(sessions)).toMatch(/already open/)
    const r = await call('fleet_close', { chat: 'sp1', reason: 'brief done, committed' })
    expect(r).toEqual({ error: false, text: 'Closed sp1aaaaa (web). A spawn slot is free.' })
    expect(close).toHaveBeenCalledWith(lead, expect.objectContaining({ id: 'sp1aaaaa' }), { reason: 'brief done, committed', force: false })
    expect(spawnRefusal(sessions)).toBeNull()
    expect(readAwayLog().some((row) => row.kind === 'close' && row.chat === 'sp1aaaaa' && row.reason === 'brief done, committed')).toBe(true)
    expect(away.digest()?.closed ?? null).toBeNull() // digest is only while away
    await away.start({ minutes: 60 })
    await call('fleet_close', { chat: 'sp2' })
    expect(away.digest().closed.at(-1)).toMatch(/^sp2bbbbb \(web\): closed by the conductor lead0000$/)
  })

  it('refuses a chat the user opened, pointing at fleet_suggest, without checking git', async () => {
    chat('user0000', { spawnedBy: null })
    const r = await call('fleet_close', { chat: 'user0000', force: true })
    expect(r.error).toBe(true)
    expect(r.text).toMatch(/opened by the user.*fleet_suggest/)
    expect(dirty).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('refuses a busy, waiting, background-running or dirty chat; force only skips the first three', async () => {
    chat('busy0000', { state: 'running' })
    chat('wait0000', { state: 'waiting', pending: new Map([['r1', { kind: 'permission' }]]) })
    chat('bgbg0000', { background: () => [{ label: 'Run build' }] })
    chat('dirt0000')
    chat('unkn0000')
    dirty.mockImplementation(async () => false)
    expect((await call('fleet_close', { chat: 'busy0000' })).text).toMatch(/It is running, not idle/)
    expect((await call('fleet_close', { chat: 'wait0000' })).text).toMatch(/waiting on the user \(permission\)/)
    expect((await call('fleet_close', { chat: 'bgbg0000' })).text).toMatch(/background work running: Run build/)
    expect(close).not.toHaveBeenCalled()
    dirty.mockImplementation(async () => true)
    expect((await call('fleet_close', { chat: 'dirt0000' })).text).toMatch(/uncommitted changes.*force does not override/)
    expect((await call('fleet_close', { chat: 'dirt0000', force: true })).error).toBe(true)
    dirty.mockImplementation(async () => null)
    expect((await call('fleet_close', { chat: 'unkn0000', force: true })).text).toMatch(/Could not check/)
    expect(close).not.toHaveBeenCalled()
    dirty.mockImplementation(async () => false)
    expect((await call('fleet_close', { chat: 'busy0000', force: true })).text).toMatch(/\(forced\)/)
    expect(readAwayLog().find((row) => row.kind === 'close')).toMatchObject({ chat: 'busy0000', force: true })
  })

  it('marks conductor-opened chats closable in fleet_list, with the reason when not', async () => {
    chat('done0000')
    chat('busy0000', { state: 'running' })
    chat('user0000', { spawnedBy: null, group: 'Orbit' })
    const r = JSON.parse((await call('fleet_list', {})).text)
    const by = Object.fromEntries(r.chats.map((c) => [c.id, c]))
    expect(by.done0000).toMatchObject({ closable: true })
    expect(by.done0000.notClosableBecause).toBeUndefined()
    expect(by.busy0000).toMatchObject({ closable: false, notClosableBecause: 'It is running, not idle.' })
    expect(by.user0000.closable).toBeUndefined()
    expect(by.user0000.group).toBe('Orbit')
  })
})

describe('fleet_rename', () => {
  it("sets a chat's title and group, clears the group, and tells the host", async () => {
    const sessions = new Map()
    const lead = { id: 'lead0000', role: ROLE, state: 'idle', autopilot: false, pending: new Map(), events: [] }
    const x = { id: 'chat0000', repo: 'site', title: 'old', group: null, state: 'idle', pending: new Map(), events: [] }
    sessions.set(lead.id, lead).set(x.id, x)
    const renamed = vi.fn()
    const tools = fleetTools(lead, sessions, (name, _d, _s, handler) => ({ name, handler }), { renamed })
    const rename = async (a) => (await tools.find((t) => t.name === 'fleet_rename').handler(a)).content[0].text
    expect(await rename({ chat: 'chat', title: '  Hero  video ', group: ' Orbit ' })).toBe('chat0000 is now "Hero video" in Orbit.')
    expect(x).toMatchObject({ title: 'Hero video', group: 'Orbit' })
    expect(renamed).toHaveBeenCalledWith(x)
    expect(await rename({ chat: 'chat', group: '' })).toBe('chat0000 is now "Hero video", with no group.')
    expect(x.group).toBeNull()
    expect(await rename({ chat: 'chat' })).toMatch(/Give a title, a group, or both/)
    expect(await rename({ chat: 'lead0000', title: 'x' })).toMatch(/No single open chat/)
    expect(groupLabel('   ')).toBeNull()
  })
})

describe('close checks', () => {
  it('reads a worktree as dirty, clean, not a repo (clean) or unknown', async () => {
    const run = (out, err, stderr = '') => (_c, _a, _o, cb) => cb(err, out, stderr)
    expect(await worktreeDirty('/x', { run: run(' M a.js\n', null) })).toBe(true)
    expect(await worktreeDirty('/x', { run: run('', null) })).toBe(false)
    expect(await worktreeDirty('/x', { run: run('', new Error('128'), 'fatal: not a git repository') })).toBe(false)
    expect(await worktreeDirty('/x', { run: run('', new Error('timeout')) })).toBeNull()
    // and for real, on a fresh folder with no repo
    expect(await worktreeDirty(mkdtempSync(join(tmpdir(), 'nogit-')))).toBe(false)
    expect(closeRefusal({ id: 'a', repo: 'r', spawnedBy: 'l', state: 'idle', pending: new Map() }, { dirty: false })).toBeNull()
  })
})

describe('fleet_checkpoint_close and spawn slots', () => {
  let sessions, lead, tools, close, dirty, tell, x, seq
  const stand = (name, _d, _schema, handler) => ({ name, handler })
  const call = async (name, args) => {
    const r = await tools.find((t) => t.name === name).handler(args)
    return { error: !!r.isError, text: r.content[0].text }
  }
  const settle = () => settleCheckpointClose(x, sessions, { dirty, close, tell })
  beforeEach(() => {
    process.env.LAIKA_CONDUCTOR_NOTES = join(mkdtempSync(join(tmpdir(), 'cpc-')), 'notes.json')
    sessions = new Map()
    seq = 0
    lead = { id: 'lead0000', role: ROLE, state: 'idle', autopilot: true, pending: new Map(), events: [], emit() {} }
    sessions.set(lead.id, lead)
    x = {
      id: 'kid00000', repo: 'web', cwd: '/w', state: 'idle', role: null, spawnedBy: lead.id, pending: new Map(), events: [], cost: 0, updatedAt: Date.now(), background: () => [],
      emit(e) { this.events.push({ seq: ++seq, at: Date.now(), ...e }) },
      send: vi.fn(function (text, _i, o) { this.emit({ t: 'user', text, ...o }); this.state = 'running' }),
    }
    sessions.set(x.id, x)
    dirty = vi.fn(async () => false)
    close = vi.fn(async (_c, chat) => { chat.state = 'closed'; sessions.delete(chat.id) })
    tell = vi.fn()
    tools = fleetTools(lead, sessions, stand, { close, dirty })
  })
  const finishTurn = (text = 'Checkpoint: abc1234 · stopped nothing · resume: none') => {
    x.emit({ t: 'text', text })
    x.emit({ t: 'result', error: null })
    x.state = 'idle'
  }

  it('sends /checkpoint as an automatic message, then closes once that turn ends clean', async () => {
    const r = await call('fleet_checkpoint_close', { chat: 'kid', reason: 'brief done' })
    expect(r.error).toBe(false)
    expect(x.send).toHaveBeenCalledWith(expect.stringMatching(/^\/checkpoint /), [], { auto: true })
    expect((await call('fleet_checkpoint_close', { chat: 'kid' })).text).toMatch(/already checkpointing/)
    // still running, then idle before the turn has a result: nothing yet
    expect(await settle()).toBeNull()
    x.state = 'idle'
    expect(await settle()).toBeNull()
    finishTurn()
    expect(await settle()).toBe('closed')
    expect(close).toHaveBeenCalledWith(lead, x, { reason: 'brief done · Checkpoint: abc1234 · stopped nothing · resume: none', force: false })
    expect(tell).toHaveBeenCalledWith(lead, expect.stringMatching(/^Closed kid00000 \(web\) after its checkpoint/))
    expect(x.closeAfter).toBeNull()
  })

  it('leaves it open when the checkpoint left changes, stopped on a permission, or the user wrote meanwhile', async () => {
    await call('fleet_checkpoint_close', { chat: 'kid' })
    finishTurn('Checkpoint: nothing to commit · stopped nothing · resume: x')
    dirty.mockResolvedValueOnce(true)
    expect(await settle()).toBe('left')
    expect(tell.mock.lastCall[1]).toMatch(/not closed after its checkpoint.*uncommitted changes/)

    await call('fleet_checkpoint_close', { chat: 'kid' })
    x.pending.set('r', { kind: 'permission' })
    x.state = 'waiting'
    expect(await settle()).toBe('left')
    expect(tell.mock.lastCall[1]).toMatch(/stopped on permission during its checkpoint/)
    x.pending.clear()
    x.state = 'idle'

    await call('fleet_checkpoint_close', { chat: 'kid' })
    x.emit({ t: 'user', text: 'actually, keep going' })
    finishTurn()
    expect(await settle()).toBe('left')
    expect(close).not.toHaveBeenCalled()
  })

  it('refuses user-opened chats, and needs autopilot', async () => {
    x.spawnedBy = null
    expect((await call('fleet_checkpoint_close', { chat: 'kid' })).text).toMatch(/fleet_suggest/)
    x.spawnedBy = lead.id
    lead.autopilot = false
    expect((await call('fleet_checkpoint_close', { chat: 'kid' })).text).toMatch(/Autopilot is off/)
    expect(x.send).not.toHaveBeenCalled()
  })

  it('shows the spawn slots in fleet_list, with chats closing after a checkpoint', async () => {
    let r = JSON.parse((await call('fleet_list', {})).text)
    expect(r.spawnSlots).toEqual({ used: 1, max: MAX_SPAWNED, free: MAX_SPAWNED - 1, open: ['kid00000 (web)'] })
    await call('fleet_checkpoint_close', { chat: 'kid' })
    r = JSON.parse((await call('fleet_list', {})).text)
    expect(r.spawnSlots.open).toEqual(['kid00000 (web) closing after its checkpoint'])
  })
})

describe('inferGroup', () => {
  const chat = (id, o = {}) => ({ id, cwd: '/r/web', repo: 'web', state: 'idle', group: null, ...o })

  it('joins the one group the open chats in the same folder or repo share', () => {
    const all = [chat('a', { group: 'Orbit' }), chat('b', { group: ' Orbit ' }), chat('c')]
    expect(inferGroup(all, { cwd: '/r/web', repo: 'web' })).toBe('Orbit')
    expect(inferGroup([chat('a', { cwd: '/elsewhere', group: 'Orbit' })], { cwd: '/r/web2', repo: 'web' })).toBe('Orbit')
    expect(inferGroup([chat('a', { repo: 'other', group: 'Orbit' })], { cwd: '/r/web', repo: 'x' })).toBe('Orbit')
  })

  it('stays out when there is no group, more than one, or only other repos have one', () => {
    expect(inferGroup([], { cwd: '/r/web', repo: 'web' })).toBeNull()
    expect(inferGroup([chat('a'), chat('b')], { cwd: '/r/web', repo: 'web' })).toBeNull()
    expect(inferGroup([chat('a', { group: 'Orbit' }), chat('b', { group: 'Atlas' })], { cwd: '/r/web', repo: 'web' })).toBeNull()
    expect(inferGroup([chat('a', { cwd: '/r/api', repo: 'api', group: 'Orbit' })], { cwd: '/r/web', repo: 'web' })).toBeNull()
  })

  it('ignores closed chats and the new chat itself', () => {
    expect(inferGroup([chat('a', { state: 'closed', group: 'Orbit' })], { cwd: '/r/web', repo: 'web' })).toBeNull()
    expect(inferGroup([chat('n', { group: 'Orbit' })], { cwd: '/r/web', repo: 'web', id: 'n' })).toBeNull()
    expect(inferGroup([chat('a', { state: 'closed', group: 'Atlas' }), chat('b', { group: 'Orbit' })], { cwd: '/r/web' })).toBe('Orbit')
  })
})

describe('parked chats', () => {
  it('keeps one row per conversation, finds one by id prefix or conversation id, and forgets it', () => {
    const store = createParked({ file: join(mkdtempSync(join(tmpdir(), 'parked-')), 'parked.json') })
    expect(store.list()).toEqual([])
    const x = { id: 'park0000-1', sdkSessionId: 'sdk-1', cwd: '/w', repo: 'web', account: { id: 'me' }, mode: 'default', title: 'Footer', group: 'Orbit', spawnedBy: 'lead0000' }
    store.add(parkedRow(x, { reason: 'done for now', by: 'lead0000', at: 5 }))
    store.add(parkedRow({ ...x, title: 'Footer v2' }, { at: 6 }))
    store.add(parkedRow({ ...x, id: 'park1111', sdkSessionId: 'sdk-2' }))
    expect(store.list()).toHaveLength(2)
    expect(store.find('park0')).toMatchObject({ sdkSessionId: 'sdk-1', title: 'Footer v2', account: 'me', group: 'Orbit', spawnedBy: 'lead0000', parkedAt: 6 })
    expect(store.find('park')).toBeNull() // two match
    expect(store.find('sdk-2').id).toBe('park1111')
    expect(store.remove('park1').id).toBe('park1111')
    expect(store.remove('park1')).toBeNull()
    expect(store.list().map((r) => r.id)).toEqual(['park0000-1'])
  })
})

describe('fleet_park and fleet_unpark', () => {
  let dir, sessions, lead, tools, park, unpark, away, dirty, store
  const stand = (name, _d, _schema, handler) => ({ name, handler })
  const call = async (name, args) => {
    const r = await tools.find((t) => t.name === name).handler(args)
    return { error: !!r.isError, text: r.content[0].text }
  }
  const chat = (id, o = {}) => {
    const x = { id, sdkSessionId: `sdk-${id}`, repo: 'web', cwd: join(dir, 'web'), state: 'idle', role: null, pending: new Map(), events: [], cost: 0, updatedAt: Date.now(), spawnedBy: lead.id, account: { id: 'me' }, background: () => [], ...o }
    sessions.set(id, x)
    return x
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'park-'))
    mkdirSync(join(dir, 'web'))
    process.env.LAIKA_CONDUCTOR_NOTES = join(dir, 'notes.json')
    process.env.LAIKA_AWAY_LOG = join(dir, 'away-log.jsonl')
    process.env.LAIKA_AWAY_POLICY = join(dir, 'away-policy.json')
    sessions = new Map()
    lead = { id: 'lead0000', role: ROLE, state: 'idle', autopilot: true, pending: new Map(), events: [], account: { id: 'me', label: 'Me' }, emit() {}, send() {} }
    sessions.set(lead.id, lead)
    store = createParked({ file: join(dir, 'parked.json') })
    away = createAway({ sessions, fleet: { awayNote() {}, setAutopilot() {} }, file: join(dir, 'away.json'), deps: { startConductor: async () => lead }, policy: () => normalisePolicy(null) })
    dirty = vi.fn(async () => false)
    // the host's park and unpark, as far as the tools can see
    park = vi.fn(async (c, x, o) => {
      store.add(parkedRow(x, { reason: o.reason, by: c.id }))
      x.state = 'closed'
      sessions.delete(x.id)
      away.parked(c, x, o)
    })
    unpark = vi.fn(async (c, key, o) => {
      const r = store.find(key)
      if (!r) throw new Error(`No single parked chat matches "${key}".`)
      const refused = spawnRefusal(sessions)
      if (refused) throw new Error(refused)
      store.remove(r.id)
      const x = chat(r.id, { spawnedBy: r.spawnedBy })
      away.unparked(c, x)
      return x
    })
    tools = fleetTools(lead, sessions, stand, { park, unpark, dirty, parked: () => store.list() })
  })
  afterEach(() => {
    away.close()
    setAwayBudget(() => null)
  })

  it('parks an idle, clean chat it opened: it frees a slot, is listed as parked, and is in the away summary', async () => {
    for (const id of ['sp1aaaaa', 'sp2bbbbb', 'sp3ccccc']) chat(id)
    await away.start({ minutes: 60 })
    const r = await call('fleet_park', { chat: 'sp1', reason: 'waits on the design review' })
    expect(r).toEqual({ error: false, text: 'Parked sp1aaaaa (web): resumable with fleet_unpark. A spawn slot is free.' })
    expect(spawnRefusal(sessions)).toBeNull()
    const list = JSON.parse((await call('fleet_list', {})).text)
    expect(list.parked).toEqual([expect.objectContaining({ id: 'sp1aaaaa', repo: 'web', reason: 'waits on the design review' })])
    expect(away.digest().parked[0]).toMatch(/^sp1aaaaa \(web\): parked by the conductor lead0000, resumable: waits on the design review$/)
    expect(readAwayLog().some((row) => row.kind === 'park' && row.chat === 'sp1aaaaa')).toBe(true)
    away.stop('back')
    expect(away.get().summary).toMatch(/1 chat parked: resume it when you want\./)
  })

  it('refuses what fleet_close refuses: user-opened chats (without git), dirty or busy ones', async () => {
    chat('user0000', { spawnedBy: null })
    chat('busy0000', { state: 'running' })
    chat('dirt0000')
    expect((await call('fleet_park', { chat: 'user0000' })).text).toMatch(/opened by the user.*fleet_suggest/)
    expect(dirty).not.toHaveBeenCalled()
    expect((await call('fleet_park', { chat: 'busy0000' })).text).toMatch(/^Not parked: It is running, not idle/)
    dirty.mockImplementation(async () => true)
    expect((await call('fleet_park', { chat: 'dirt0000', force: true })).text).toMatch(/uncommitted changes/)
    expect(park).not.toHaveBeenCalled()
  })

  it('unparks a parked chat against the spawn cap, logs it, and passes refusals back', async () => {
    chat('sp1aaaaa')
    await call('fleet_park', { chat: 'sp1' })
    await away.start({ minutes: 60 })
    for (let i = 2; i <= MAX_SPAWNED + 1; i++) chat(`sp${i}${'abcdefghi'[i - 1].repeat(5)}`)
    expect((await call('fleet_unpark', { chat: 'sp1' })).text).toMatch(/already open/)
    sessions.delete(`sp${MAX_SPAWNED + 1}iiiii`)
    expect(await call('fleet_unpark', { chat: 'sp1', text: 'carry on' })).toEqual({ error: false, text: 'Resumed sp1aaaaa (web) and sent it your message.' })
    expect(unpark).toHaveBeenLastCalledWith(lead, 'sp1', { text: 'carry on' })
    expect(store.list()).toEqual([])
    expect(away.digest().parked.at(-1)).toMatch(/sp1aaaaa \(web\): resumed from parked by the conductor lead0000/)
    expect((await call('fleet_unpark', { chat: 'nope' })).text).toMatch(/No single parked chat/)
  })

  it('refuses spawns, unparks and sends once the away budget says so', async () => {
    chat('sp1aaaaa')
    setAwayBudget((kind) => (kind === 'spawn' ? 'budget: no more opened chats' : null))
    expect((await call('fleet_unpark', { chat: 'sp1' })).text).toBe('budget: no more opened chats')
    expect(unpark).not.toHaveBeenCalled()
    setAwayBudget(() => 'budget spent')
    const t2 = fleetTools(lead, sessions, stand, { spawn: vi.fn() })
    expect((await t2.find((t) => t.name === 'fleet_spawn').handler({ cwd: 'web', prompt: 'x' })).content[0].text).toBe('budget spent')
    const x = chat('user0000', { spawnedBy: null, send: vi.fn() })
    expect((await call('fleet_send', { chat: 'user0000', text: 'go' })).text).toBe('budget spent')
    expect(x.send).not.toHaveBeenCalled()
  })
})

describe('stale chats', () => {
  const H = 3_600_000
  const at = Date.parse('2026-09-18T12:00:00Z')
  const idle = (o = {}) => ({ id: 'aaaa0000', repo: 'web', cwd: '/w', state: 'idle', pending: new Map(), updatedAt: at - 26 * H, background: () => [], ...o })

  it('flags a chat idle over a day with a clean worktree and nothing going on', () => {
    expect(STALE_MS).toBe(24 * H)
    expect(staleHint(idle(), { dirty: false, now: at })).toBe('idle 26h, clean: probably done')
    expect(staleHint(idle({ updatedAt: at - 80 * H }), { dirty: false, now: at })).toBe('idle 3d, clean: probably done')
    expect(staleHint(idle(), { now: at })).toMatch(/idle 26h/) // the cheap checks alone
    expect(staleHint(idle(), { dirty: true, now: at })).toBeNull()
    expect(staleHint(idle(), { dirty: null, now: at })).toBeNull()
    expect(staleHint(idle({ updatedAt: at - 23 * H }), { dirty: false, now: at })).toBeNull()
    expect(staleHint(idle({ state: 'running' }), { dirty: false, now: at })).toBeNull()
    expect(staleHint(idle({ pending: new Map([['q', { kind: 'question' }]]) }), { dirty: false, now: at })).toBeNull()
    expect(staleHint(idle({ background: () => [{ label: 'build' }] }), { dirty: false, now: at })).toBeNull()
  })

  describe('in fleet_list and at check-ins', () => {
    let sessions, lead, dirty
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(at)
      process.env.LAIKA_CONDUCTOR_NOTES = join(mkdtempSync(join(tmpdir(), 'stale-')), 'notes.json')
      lead = { id: 'lead0000', role: ROLE, state: 'idle', autopilot: true, pending: new Map(), events: [], updatedAt: at, account: { id: 'me' }, emit() {}, sent: [], send(text) { this.sent.push(text); this.state = 'running' } }
      sessions = new Map([[lead.id, lead]])
      const add = (id, o) => sessions.set(id, { ...idle({ id, cwd: `/${id}` }), events: [], cost: 0, role: null, ...o })
      add('user0000', { spawnedBy: null })
      add('mine0000', { spawnedBy: lead.id })
      add('dirt0000', { spawnedBy: null })
      add('new00000', { spawnedBy: null, updatedAt: at - H })
      dirty = vi.fn(async (x) => x.cwd === '/dirt0000')
    })
    afterEach(() => vi.useRealTimers())

    it('marks stale chats, both user-opened and conductor-opened, checking git only for the ones that look it', async () => {
      const tools = fleetTools(lead, sessions, (name, _d, _s, handler) => ({ name, handler }), { dirty })
      const r = JSON.parse((await tools.find((t) => t.name === 'fleet_list').handler({})).content[0].text)
      const by = Object.fromEntries(r.chats.map((c) => [c.id, c]))
      expect(by.user0000.stale).toBe('idle 26h, clean: probably done')
      expect(by.mine0000).toMatchObject({ stale: 'idle 26h, clean: probably done', closable: true })
      expect(by.dirt0000.stale).toBeUndefined()
      expect(by.new00000.stale).toBeUndefined()
      expect(dirty).not.toHaveBeenCalledWith(expect.objectContaining({ cwd: '/new00000' }))
    })

    it('tells conductors on autopilot at most hourly, and once a day per chat', async () => {
      const w = watchFleet(sessions, { dirty })
      lead.lastCheckIn = 0
      vi.advanceTimersByTime(59 * MIN)
      expect(dirty).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(MIN)
      expect(dirty).toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(45_000)
      expect(lead.sent).toHaveLength(1)
      expect(lead.sent[0]).toMatch(/^\[autopilot\] Chats that look done:/)
      expect(lead.sent[0]).toMatch(/user0000 \(web\) is stale: idle 2\dh, clean: probably done; the user opened it: suggest closing it with fleet_suggest/)
      expect(lead.sent[0]).toMatch(/mine0000 \(web\) is stale: .*you opened it: close or park it/)
      expect(lead.sent[0]).not.toMatch(/dirt0000|new00000/)
      // the next hours: nothing new to say about the same chats
      lead.state = 'idle'
      expect(await w.staleCheck()).toEqual([])
      vi.setSystemTime(Date.now() + 25 * H)
      expect((await w.staleCheck()).map((l) => l.slice(0, 8))).toEqual(['user0000', 'mine0000', 'new00000'])
      w.setAutopilot(lead, false)
    })
  })
})
