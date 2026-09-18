import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalisePolicy, readAwayLog } from '../away-policy.mjs'
import { createAway, DEFAULT_GOAL, parseReset } from '../away.mjs'
import { ROLE } from '../conductor.mjs'

const MIN = 60_000

/** enough of agent-host's Session for away mode */
function chat(id, o = {}) {
  return {
    id,
    repo: o.repo ?? 'repo',
    cwd: o.cwd ?? '/nowhere',
    role: o.role ?? null,
    state: o.state ?? 'idle',
    account: o.account ?? { id: 'me', label: 'Me' },
    goal: o.goal ?? '',
    autopilot: false,
    updatedAt: Date.now(),
    events: [],
    sent: [],
    seq: 0,
    emit(e) {
      const ev = { seq: ++this.seq, at: Date.now(), ...e }
      this.events.push(ev)
      this.updatedAt = ev.at
      return ev
    },
    send(text, _images, opts) {
      this.sent.push(text)
      this.emit({ t: 'user', text, ...(opts?.auto ? { auto: true } : {}) })
      this.state = 'running'
    },
  }
}

/** watchFleet's surface, recorded */
const fakeFleet = () => ({
  calls: [],
  notes: [],
  setAutopilot(c, on, o = {}) {
    this.calls.push({ id: c.id, on, minutes: o.minutes })
    c.autopilot = on
    c.autopilotUntil = on && o.minutes ? Date.now() + o.minutes * MIN : null
  },
  awayNote(line) {
    this.notes.push(line)
  },
})

let dir, file, sessions, fleet, away, deps, policy
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-17T10:00:00'))
  dir = mkdtempSync(join(tmpdir(), 'away-'))
  mkdirSync(join(dir, 'repo'))
  process.env.LAIKA_AWAY_LOG = join(dir, 'away-log.jsonl')
  process.env.LAIKA_AWAY_POLICY = join(dir, 'away-policy.json')
  file = join(dir, 'away-5200.json')
  sessions = new Map()
  fleet = fakeFleet()
  policy = normalisePolicy(null)
  deps = {
    started: [],
    startConductor: vi.fn(async ({ goal }) => {
      const c = chat('lead0000', { role: ROLE, goal })
      sessions.set(c.id, c)
      return c
    }),
    revive: vi.fn((x) => {
      x.state = 'idle'
      x.send('continue', [], { auto: true })
    }),
    interrupt: vi.fn(async (x) => {
      x.state = 'idle'
    }),
    carryOn: vi.fn((x) => x.send('continue', [], { auto: true })),
    accounts: vi.fn(() => [
      { id: 'me', label: 'Me', loggedIn: true },
      { id: 'work', label: 'Work', loggedIn: true },
      { id: 'demo', label: 'Demo', demo: true, loggedIn: true },
    ]),
    switchAccount: vi.fn(async () => {}),
    saved: vi.fn(),
    ended: vi.fn(),
  }
  away = createAway({ sessions, fleet, file, deps, policy: () => policy })
})
afterEach(() => {
  away.close()
  vi.useRealTimers()
})

const add = (x) => (sessions.set(x.id, x), x)

describe('away mode on and off', () => {
  it('starts a conductor when there is none, with the default goal, and turns autopilot on for the same time', async () => {
    const v = await away.start({ minutes: 120 })
    expect(deps.startConductor).toHaveBeenCalledOnce()
    expect(v).toMatchObject({ on: true, conductorId: 'lead0000', goal: DEFAULT_GOAL, policy: 'safe' })
    expect(v.until - Date.now()).toBe(120 * MIN)
    expect(fleet.calls).toEqual([{ id: 'lead0000', on: true, minutes: 120 }])
    expect(existsSync(process.env.LAIKA_AWAY_POLICY)).toBe(true)
  })

  it('reuses the conductor you have, and takes a new goal', async () => {
    const c = add(chat('mine0000', { role: ROLE, goal: 'old goal' }))
    await away.start({ minutes: 60, goal: 'ship the release notes' })
    expect(deps.startConductor).not.toHaveBeenCalled()
    expect(c.goal).toBe('ship the release notes')
    expect(away.get().conductorId).toBe('mine0000')
  })

  it('refuses a duration out of range', async () => {
    await expect(away.start({ minutes: 0 })).rejects.toThrow()
    await expect(away.start({ minutes: 25 * 60 })).rejects.toThrow()
    await expect(away.start({})).rejects.toThrow()
    expect(away.get().on).toBe(false)
  })

  it('ends when the time is up: autopilot off, and the conductor asked for its summary', async () => {
    const c = add(chat('lead0000', { role: ROLE }))
    await away.start({ minutes: 60 })
    vi.advanceTimersByTime(59 * MIN)
    expect(away.get().on).toBe(true)
    vi.advanceTimersByTime(1 * MIN)
    const v = away.get()
    expect(v).toMatchObject({ on: false, reason: 'expired' })
    expect(v.summary).toMatch(/^Away 1h 0m: 0 auto-approved/)
    expect(fleet.calls.at(-1)).toMatchObject({ id: 'lead0000', on: false })
    expect(c.sent.at(-1)).toMatch(/^\[autopilot\] Time is up: the user is due back/)
  })

  it('tells the summary routine the time away when it ends, however it ends', async () => {
    add(chat('lead0000', { role: ROLE }))
    await away.start({ minutes: 60 })
    const startedAt = away.get().startedAt
    vi.advanceTimersByTime(20 * MIN)
    away.stop('back')
    expect(deps.ended).toHaveBeenCalledOnce()
    expect(deps.ended.mock.calls[0][0]).toMatchObject({ on: false, reason: 'back', startedAt, endedAt: Date.now() })
    await away.start({ minutes: 30 })
    vi.advanceTimersByTime(30 * MIN)
    expect(deps.ended).toHaveBeenCalledTimes(2)
    expect(deps.ended.mock.calls[1][0]).toMatchObject({ reason: 'expired' })
  })

  it('waits for a busy conductor before asking for the summary, and asks once', async () => {
    const c = add(chat('lead0000', { role: ROLE, state: 'running' }))
    await away.start({ minutes: 30 })
    away.stop('back')
    expect(c.sent).toEqual([])
    c.state = 'idle'
    await away.tick()
    await away.tick()
    expect(c.sent.filter((t) => t.includes('Time is up'))).toHaveLength(1)
    expect(c.sent[0]).toMatch(/the user is back/)
  })

  it('switches off cleanly even when the conductor has crashed or gone', async () => {
    const c = add(chat('lead0000', { role: ROLE }))
    await away.start({ minutes: 10 })
    c.state = 'error'
    vi.advanceTimersByTime(10 * MIN)
    expect(away.get().on).toBe(false)
    await away.tick()
    expect(c.events.some((e) => e.t === 'note' && /could not write its summary/.test(e.text))).toBe(true)

    await away.start({ minutes: 10 })
    sessions.delete(away.get().conductorId)
    expect(() => vi.advanceTimersByTime(10 * MIN)).not.toThrow()
    expect(away.get().on).toBe(false)
  })

  it('stops auto-approving the moment it ends', async () => {
    add(chat('lead0000', { role: ROLE }))
    const x = add(chat('aaaa1111', { cwd: join(dir, 'repo') }))
    expect(away.consider(x, 'Read', { file_path: 'a.ts' })).toBeNull()
    await away.start({ minutes: 5 })
    expect(away.consider(x, 'Read', { file_path: 'a.ts' })).toMatchObject({ allow: true })
    expect(away.consider(x, 'AskUserQuestion', {})).toBeNull()
    away.stop('back')
    expect(away.consider(x, 'Read', { file_path: 'a.ts' })).toBeNull()
  })

  it('counts, logs and shows each approval, and tells the conductor what waits for you', async () => {
    add(chat('lead0000', { role: ROLE }))
    const x = add(chat('aaaa1111', { cwd: join(dir, 'repo'), repo: 'web' }))
    await away.start({ minutes: 60 })
    away.consider(x, 'Edit', { file_path: 'src/a.ts' })
    away.consider(x, 'Bash', { command: 'git push' })
    expect(away.get().counts).toMatchObject({ approved: 1, asked: 1 })
    expect(x.events.filter((e) => e.t === 'away').map((e) => e.kind)).toEqual(['approved', 'asked'])
    expect(fleet.notes.at(-1)).toMatch(/aaaa1111 \(web\) needs the user's permission for Bash: git push/)
    const log = readAwayLog({ since: 0 })
    expect(log.filter((r) => r.kind !== 'away').map((r) => [r.kind, r.tool, r.input])).toEqual([
      ['approved', 'Edit', 'src/a.ts'],
      ['asked', 'Bash', 'git push'],
    ])
    expect(away.digest()).toMatchObject({ on: true, autoApproved: 1 })
    expect(away.digest().leftForUser[0]).toMatch(/git push/)
  })

  it('says plainly why it asks, and offers the allowlist entry that would let it through', async () => {
    add(chat('lead0000', { role: ROLE }))
    const x = add(chat('aaaa1111', { cwd: join(dir, 'repo') }))
    policy = { ...policy, bash: policy.bash.filter((b) => b !== 'git rev-parse') }
    await away.start({ minutes: 60 })
    away.consider(x, 'Bash', { command: 'git rev-parse HEAD' })
    away.consider(x, 'Bash', { command: 'git status; git push' })
    away.consider(x, 'Read', { file_path: 'a.ts' })
    const evs = x.events.filter((e) => e.t === 'away')
    expect(evs[0]).toMatchObject({ kind: 'asked', allowPattern: 'git rev-parse', plain: expect.stringMatching(/git rev-parse/) })
    expect(evs[1]).toMatchObject({ kind: 'asked', allowPattern: null, plain: expect.stringMatching(/chains commands with ;/) })
    expect(evs[2].kind).toBe('approved')
    expect(evs[2]).not.toHaveProperty('plain')
    const asked = readAwayLog({ since: 0 }).filter((r) => r.kind === 'asked')
    expect(asked[0]).toMatchObject({ allowPattern: 'git rev-parse', plain: expect.any(String) })
  })

  it('persists, and a restarted host carries on or finishes', async () => {
    add(chat('lead0000', { role: ROLE }))
    await away.start({ minutes: 90, goal: 'finish the docs' })
    vi.advanceTimersByTime(2000)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved).toMatchObject({ on: true, goal: 'finish the docs', conductorId: 'lead0000' })
    away.close()

    // back up within the time: still away, and ends on time
    const again = createAway({ sessions, fleet, file, deps, policy: () => policy })
    expect(again.restore()).toMatchObject({ on: true, goal: 'finish the docs' })
    vi.advanceTimersByTime(90 * MIN)
    expect(again.get()).toMatchObject({ on: false, reason: 'expired' })
    again.close()

    // down past the end: finishes straight away
    await away.start({ minutes: 30 })
    away.close()
    vi.setSystemTime(Date.now() + 45 * MIN)
    const late = createAway({ sessions, fleet, file, deps, policy: () => policy })
    expect(late.restore()).toMatchObject({ on: false, reason: 'expired' })
    late.close()
  })
})

describe('recovering stuck chats', () => {
  beforeEach(async () => {
    add(chat('lead0000', { role: ROLE }))
    await away.start({ minutes: 8 * 60 })
  })

  it('brings back a crashed chat after a wait that grows, then leaves it for you', async () => {
    const x = add(chat('aaaa1111', { state: 'error' }))
    deps.revive.mockImplementation(() => {}) // stays crashed
    const steps = policy.recovery.backoffMinutes
    for (let i = 0; i < steps.length; i++) {
      await away.tick() // sees it, starts the wait
      expect(deps.revive).toHaveBeenCalledTimes(i)
      vi.setSystemTime(Date.now() + steps[i] * MIN - 1000)
      await away.tick()
      expect(deps.revive).toHaveBeenCalledTimes(i)
      vi.setSystemTime(Date.now() + 1000)
      await away.tick()
      expect(deps.revive).toHaveBeenCalledTimes(i + 1)
    }
    await away.tick()
    vi.setSystemTime(Date.now() + 24 * 60 * MIN)
    await away.tick()
    expect(deps.revive).toHaveBeenCalledTimes(steps.length)
    expect(away.recoveryOf(x.id)).toMatchObject({ gaveUp: true, attempts: steps.length })
    expect(x.events.filter((e) => e.t === 'away').at(-1).action).toBe('gave-up')
    expect(away.get().counts.recovered).toBe(steps.length)
    expect(readAwayLog({ since: 0 }).filter((r) => r.kind === 'recovery' && r.action === 'retry')).toHaveLength(steps.length)
  })

  it('tells a chat whose turn failed to continue, after the wait', async () => {
    const x = add(chat('aaaa1111'))
    x.emit({ t: 'user', text: 'do it' })
    x.emit({ t: 'result', error: 'API Error: 529 overloaded' })
    await away.tick()
    expect(x.sent).toEqual([])
    vi.setSystemTime(Date.now() + policy.recovery.backoffMinutes[0] * MIN)
    await away.tick()
    expect(x.sent).toEqual(['continue'])
    expect(fleet.notes.some((n) => /aaaa1111 \(repo\): its turn failed/.test(n))).toBe(true)
  })

  it('moves a chat that hit a usage limit to your other account', async () => {
    const x = add(chat('aaaa1111'))
    x.emit({ t: 'result', error: "You've hit your session limit · resets 3pm" })
    await away.tick()
    expect(deps.switchAccount).toHaveBeenCalledWith(x, expect.objectContaining({ id: 'work' }))
    await away.tick()
    expect(deps.switchAccount).toHaveBeenCalledOnce()
  })

  it('waits for the reset instead when switching is off, then carries on', async () => {
    policy.recovery.switchAccounts = false
    const x = add(chat('aaaa1111'))
    x.emit({ t: 'result', error: "You've hit your session limit · resets 3pm" })
    await away.tick()
    expect(deps.switchAccount).not.toHaveBeenCalled()
    expect(away.recoveryOf(x.id).limitUntil).toBe(new Date('2026-09-17T15:01:00').getTime())
    vi.setSystemTime(new Date('2026-09-17T14:59:00'))
    await away.tick()
    expect(deps.carryOn).not.toHaveBeenCalled()
    vi.setSystemTime(new Date('2026-09-17T15:01:00'))
    await away.tick()
    expect(deps.carryOn).toHaveBeenCalledOnce()
  })

  it('waits for the reset when no other account is free', async () => {
    deps.accounts.mockReturnValue([{ id: 'me', label: 'Me', loggedIn: true }, { id: 'work', label: 'Work', loggedIn: false }])
    const x = add(chat('aaaa1111'))
    x.emit({ t: 'result', error: 'Claude AI usage limit reached, resets 9pm' })
    await away.tick()
    expect(deps.switchAccount).not.toHaveBeenCalled()
    expect(away.recoveryOf(x.id).limitUntil).toBeGreaterThan(Date.now())
  })

  it('nudges a silent chat at most K times', async () => {
    const x = add(chat('aaaa1111', { state: 'running' }))
    const { stallMinutes, maxNudges } = policy.recovery
    for (let i = 0; i < maxNudges + 2; i++) {
      x.state = 'running'
      vi.setSystemTime(Date.now() + (stallMinutes - 1) * MIN)
      await away.tick()
      expect(deps.interrupt).toHaveBeenCalledTimes(Math.min(i, maxNudges))
      x.updatedAt = Date.now() - (stallMinutes - 1) * MIN
      vi.setSystemTime(Date.now() + 2 * MIN)
      x.state = 'running'
      await away.tick()
      expect(deps.interrupt).toHaveBeenCalledTimes(Math.min(i + 1, maxNudges))
    }
    expect(x.sent.filter((t) => t === 'continue')).toHaveLength(maxNudges)
    expect(x.events.filter((e) => e.t === 'away' && e.action === 'stall-gave-up')).toHaveLength(1)
  })

  it('leaves a chat that is working, waiting on you, or a demo alone', async () => {
    const busy = add(chat('aaaa1111', { state: 'running' }))
    const waiting = add(chat('bbbb2222', { state: 'waiting' }))
    const demo = add(chat('cccc3333', { state: 'error', account: { id: 'demo', demo: true } }))
    vi.setSystemTime(Date.now() + 5 * MIN)
    busy.updatedAt = Date.now()
    waiting.updatedAt = Date.now() - 600 * MIN
    await away.tick()
    vi.setSystemTime(Date.now() + 60 * MIN)
    busy.updatedAt = Date.now()
    await away.tick()
    expect(deps.interrupt).not.toHaveBeenCalled()
    expect(deps.revive).not.toHaveBeenCalled()
    expect(demo.events).toEqual([])
  })

  it('does nothing once away mode is off', async () => {
    away.stop('back')
    add(chat('aaaa1111', { state: 'error' }))
    vi.setSystemTime(Date.now() + 120 * MIN)
    await away.tick()
    await away.tick()
    expect(deps.revive).not.toHaveBeenCalled()
  })
})

describe('reading when a limit resets', () => {
  const now = new Date('2026-09-17T10:00:00').getTime()
  it.each([
    ['resets 3pm', '2026-09-17T15:01:00'],
    ['resets at 3:30 pm', '2026-09-17T15:31:00'],
    ['resets 9am', '2026-09-18T09:01:00'],
    ['resets 12am', '2026-09-18T00:01:00'],
    ['resets 14:45', '2026-09-17T14:46:00'],
  ])('%s', (text, want) => {
    expect(parseReset(`Session limit reached · ${text}`, now)).toBe(new Date(want).getTime())
  })
  it('reads an epoch, and says nothing when there is no time', () => {
    expect(parseReset('Claude AI usage limit reached|1789660800', now)).toBe(1789660800_000 + MIN)
    expect(parseReset('usage limit reached', now)).toBeNull()
    expect(parseReset('resets 13pm', now)).toBeNull()
  })
})

describe('away budget', () => {
  it('refuses a bad budget, keeps a good one, and shows it with the spend', async () => {
    add(chat('lead0000', { role: ROLE }))
    await expect(away.start({ minutes: 60, budget: { dollars: -1 } })).rejects.toThrow(/dollars/)
    await expect(away.start({ minutes: 60, budget: { spawns: 1.5 } })).rejects.toThrow(/whole number/)
    expect(away.get().on).toBe(false)
    const v = await away.start({ minutes: 60, budget: { dollars: '5', spawns: 2 } })
    expect(v).toMatchObject({ budget: { dollars: 5, spawns: 2 }, spent: { dollars: 0, spawns: 0 }, budgetHit: null })
    // extending keeps it
    expect((await away.start({ minutes: 90 })).budget).toEqual({ dollars: 5, spawns: 2 })
    expect(away.digest().budget).toEqual({ dollars: 5, spawns: 2, spentDollars: 0, spawnsUsed: 0, reached: null })
    expect(away.budgetRefusal('send')).toBeNull()
  })

  it('counts only what the chats spend while away, through restarts and closes, and says once when it is spent', async () => {
    const c = add(chat('lead0000', { role: ROLE }))
    const x = add(chat('aaaa1111', { repo: 'web' }))
    const y = add(chat('bbbb2222', { repo: 'api' }))
    x.cost = 10 // spent before away mode
    await away.start({ minutes: 60, budget: { dollars: 5 } })
    expect(away.budgetRefusal('send')).toBeNull()
    x.cost = 12
    y.cost = 1.5
    expect(away.get().spent.dollars).toBe(3.5)
    // its Claude Code restarted: the running total starts again
    x.cost = 0.5
    expect(away.get().spent.dollars).toBe(4)
    // a closed chat's spend stays
    y.cost = 2
    y.state = 'closed'
    away.closed(c, y)
    sessions.delete(y.id)
    expect(away.get().spent.dollars).toBe(4.5)
    x.cost = 1.2
    const why = away.budgetRefusal('send')
    expect(why).toMatch(/away budget is spent \(\$5\.20 of \$5\)/)
    expect(away.budgetRefusal('spawn')).toBe(why)
    away.budgetRefusal('send')
    await away.tick()
    expect(fleet.notes.filter((n) => /^Budget reached/.test(n))).toEqual(['Budget reached: $5.20 spent of the $5 away budget. Sends, spawns and unparks are refused from now on.'])
    expect(away.get().budgetHit).toMatchObject({ dollars: true })
    // approvals carry on
    expect(away.consider(add(chat('cccc3333', { cwd: join(dir, 'repo') })), 'Read', { file_path: 'a.ts' })).toMatchObject({ allow: true })
    away.stop('back')
    expect(away.get().summary).toMatch(/Budget reached: \$5\.20 spent of the \$5 away budget\.$/)
    expect(away.budgetRefusal('send')).toBeNull()
  })

  it('counts conductor spawns and unparks against the spawn budget, and only stops those', async () => {
    const c = add(chat('lead0000', { role: ROLE }))
    await away.start({ minutes: 60, budget: { spawns: 2 } })
    away.spawned(c, add(chat('sp1aaaaa')), 'one')
    expect(away.budgetRefusal('spawn')).toBeNull()
    away.unparked(null, add(chat('sp2bbbbb'))) // you resumed it: not the conductor's
    expect(away.budgetRefusal('spawn')).toBeNull()
    away.unparked(c, add(chat('sp3ccccc')))
    expect(away.budgetRefusal('send')).toBeNull()
    expect(away.budgetRefusal('spawn')).toMatch(/allows 2 opened chats/)
    away.budgetRefusal('spawn')
    expect(fleet.notes.filter((n) => /^Budget reached/.test(n))).toEqual(['Budget reached: 2 chats opened, the away budget\'s limit. Spawns and unparks are refused from now on.'])
    expect(away.digest().budget).toMatchObject({ spawnsUsed: 2, reached: "2 chats opened, the away budget's limit" })
  })

  it('keeps the budget and spend across a host restart', async () => {
    add(chat('lead0000', { role: ROLE }))
    const x = add(chat('aaaa1111'))
    await away.start({ minutes: 60, budget: { dollars: 3 } })
    x.cost = 2
    away.get()
    away.close()
    const again = createAway({ sessions, fleet, file, deps, policy: () => policy })
    expect(again.restore()).toMatchObject({ budget: { dollars: 3 }, spent: { dollars: 2 } })
    x.cost = 0.4 // the restarted host's chat counts from 0
    expect(again.get().spent.dollars).toBe(2.4)
    again.close()
  })

  it('does not forget spend that was only looked at before the host died (found end to end)', async () => {
    add(chat('lead0000', { role: ROLE }))
    const x = add(chat('aaaa1111'))
    await away.start({ minutes: 60, budget: { dollars: 3 } })
    x.cost = 2
    away.get()
    await vi.advanceTimersByTimeAsync(1500)
    away.close()
    // the new host's Claude Code starts its running total again at 0
    x.cost = 0
    const again = createAway({ sessions, fleet, file, deps, policy: () => policy })
    expect(again.restore().spent.dollars).toBe(2)
    again.close()
  })
})
