import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { fleetTools, ROLE, watchFleet } from '../conductor.mjs'

/** enough of agent-host's Session for the conductor */
function chat(id, o = {}) {
  const x = {
    id,
    sdkSessionId: `sdk-${id}`,
    repo: o.repo ?? 'repo',
    title: o.title ?? `chat ${id}`,
    role: o.role ?? null,
    state: o.state ?? 'idle',
    account: { id: 'me' },
    brief: o.brief ?? null,
    cost: 0,
    updatedAt: Date.now(),
    pending: new Map(),
    events: o.events ?? [],
    sent: [],
    answered: [],
    emit(e) {
      this.events.push({ seq: this.events.length + 1, at: Date.now(), ...e })
    },
    send(text, _images, opts) {
      this.sent.push({ text, ...opts })
      this.state = 'running'
    },
    answer(requestId, reply) {
      this.answered.push({ requestId, reply })
      this.pending.delete(requestId)
    },
  }
  return x
}

const stand = (name, _d, _schema, handler) => ({ name, handler })
const call = async (tools, name, args = {}) => {
  const r = await tools.find((t) => t.name === name).handler(args)
  return { error: !!r.isError, text: r.content[0].text }
}

describe('fleet tools', () => {
  let sessions, lead, a, b, tools
  beforeEach(() => {
    process.env.LAIKA_CONDUCTOR_NOTES = join(mkdtempSync(join(tmpdir(), 'conductor-')), 'notes.json')
    lead = chat('lead0000', { role: ROLE })
    lead.autopilot = false
    a = chat('aaaa1111', {
      repo: 'web',
      brief: { goal: 'Ship the site', now: 'tests pass', next: 'deploy', turns: [{ label: 'Build it', status: 'done' }] },
      events: [
        { t: 'user', text: 'build the site', at: 1 },
        { t: 'user', text: '[from the conductor] carry on', at: 2 },
        { t: 'text', text: 'Which host do you want?', at: 3 },
      ],
    })
    b = chat('bbbb2222', { repo: 'api', role: ROLE })
    sessions = new Map([lead, a, b].map((x) => [x.id, x]))
    tools = fleetTools(lead, sessions, stand)
  })

  it('lists the chats it leads, with your own words and not its or other conductors', async () => {
    const r = JSON.parse((await call(tools, 'fleet_list')).text)
    expect(r.chats.map((c) => c.id)).toEqual(['aaaa1111'])
    expect(r.chats[0].youSaid).toEqual(['build the site'])
    expect(r.chats[0].arc).toEqual(['Build it (done)'])
    expect(r.chats[0].next).toBe('deploy')
  })

  it('only sends on autopilot, and never to a chat waiting on you', async () => {
    expect((await call(tools, 'fleet_send', { chat: 'aaaa', text: 'go' })).error).toBe(true)
    lead.autopilot = true
    a.pending.set('r1', { kind: 'permission', event: {} })
    expect((await call(tools, 'fleet_send', { chat: 'aaaa', text: 'go' })).error).toBe(true)
    a.pending.clear()
    expect((await call(tools, 'fleet_send', { chat: 'aaaa', text: 'go' })).error).toBe(false)
    expect(a.sent[0].text).toBe('[from the conductor] go')
  })

  it('answers questions on autopilot but not permissions', async () => {
    lead.autopilot = true
    a.pending.set('p1', { kind: 'permission', event: {} })
    expect((await call(tools, 'fleet_answer', { chat: 'aaaa', answers: [{ question: 'x', answer: 'y' }] })).error).toBe(true)
    a.pending.set('q1', { kind: 'question', event: { questions: [{ question: 'Which host?' }] } })
    const r = await call(tools, 'fleet_answer', { chat: 'aaaa', answers: [{ question: 'Which host?', answer: 'Vercel' }] })
    expect(r.error).toBe(false)
    expect(a.answered).toEqual([{ requestId: 'q1', reply: { answers: { 'Which host?': 'Vercel' }, annotations: {} } }])
  })

  it('shows suggestions as an event in the conductor chat', async () => {
    await call(tools, 'fleet_suggest', { items: [{ chat: 'aaaa', text: 'deploy it', why: 'tests pass' }] })
    const e = lead.events.at(-1)
    expect(e.t).toBe('suggestions')
    expect(e.items[0]).toMatchObject({ chat: 'aaaa1111', repo: 'web', text: 'deploy it' })
  })

  it('keeps notes about chats and about you', async () => {
    await call(tools, 'fleet_note', { chat: 'aaaa', note: 'really wants Vercel' })
    await call(tools, 'fleet_note', { note: 'likes short replies' })
    const r = JSON.parse((await call(tools, 'fleet_list')).text)
    expect(r.chats[0].notes).toEqual(['really wants Vercel'])
    expect(r.aboutTheUser).toEqual(['likes short replies'])
    const you = JSON.parse((await call(tools, 'fleet_you')).text)
    expect(you.map((y) => y.text)).toEqual(['build the site'])
  })
})

describe('autopilot', () => {
  it('turns on and off, with a time limit', () => {
    const lead = chat('lead0000', { role: ROLE, state: 'running' })
    const sessions = new Map([[lead.id, lead]])
    const w = watchFleet(sessions)
    w.setAutopilot(lead, true, { minutes: 30 })
    expect(lead.autopilot).toBe(true)
    expect(lead.autopilotUntil - Date.now()).toBeGreaterThan(29 * 60_000)
    w.setAutopilot(lead, false)
    expect(lead.autopilot).toBe(false)
    expect(lead.events.filter((e) => e.t === 'autopilot').map((e) => e.on)).toEqual([true, false])
  })
})
