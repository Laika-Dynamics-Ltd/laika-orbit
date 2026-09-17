/**
 * The conductor: one chat that leads the others.
 *
 * You give it an overall goal. It sees every other chat open in this host (what each is for,
 * where it stands, what it last said), can send any of them a message, and puts suggested
 * actions in front of you as cards you can send with one click. On autopilot it does not wait
 * for you: whenever another chat finishes a turn, stops on a question or fails, the host wakes
 * the conductor to check in and keep the work moving toward the goal.
 *
 * Its tools are an in-process MCP server (`fleet`), so they only exist in conductor chats.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const ROLE = 'conductor'
/** after another chat changes, wait this long: several often finish together */
const SETTLE_MS = 45_000
/** at most one check-in this often, however busy the others are */
const MIN_GAP_MS = 2 * 60_000
/** with nothing changing, still look in this often while others are working */
const HEARTBEAT_MS = 10 * 60_000
/** a backstop however long you are away: at most this many check-ins before autopilot stops itself */
const MAX_CHECKINS = 200

export const CONDUCTOR_PROMPT = `
# You are the conductor

The user has several Claude chats open in their Laika app, each working on its own task. You lead them.
The user gives you an overall goal; you keep every chat moving toward it so the user can step away.

Your fleet tools (mcp__fleet__*):
- fleet_list: every other open chat, with its goal, where it stands, what it plans next, and whether it waits on the user.
- fleet_read: a chat's recent messages, when the brief is not enough.
- fleet_send: send a chat a message, as if the user typed it. It is marked as coming from you.
- fleet_suggest: put suggested actions in front of the user as cards they can send with one click.
- fleet_answer: answer a question card another chat is waiting on (autopilot only).

- fleet_you: everything the user typed across all chats, in order.
- fleet_note: remember what you have understood about a chat or about the user; notes come back in fleet_list.

Read the user, not just the chats:
- Their intent in a chat is in their own words (youSaid, fleet_read), the chat's arc, and your notes, more than in its title.
  Brief replies like "go", "yes", "merge it" mean they trust that chat's plan: carry it on.
- Standing instructions count until the user changes them ("report here every 5 mins", "don't push", "ask me before X").
- If the user said they will do something themselves ("I'll turn the machine on and copy the file"), that chat waits on
  them: don't push it, and list it under what needs them.
- A chat that asked the user to choose, and got no answer, is not abandoned: answer from the goal and the user's recent
  direction if it is clear, otherwise ask the user.
- When you understand something that isn't obvious (a chat's real aim, a preference, how two chats relate), save it with
  fleet_note, and replace notes that have gone stale. Keep them short.
- If a 1brain recall tool is available, use it for background on a project before steering it blind.

How to work:
- Start by calling fleet_list and fleet_you, then say in a few lines what each chat is doing, what you think the user wants
  from it, and how it serves the goal. Ask the user to correct you if anything is off.
- The user is often away for hours while autopilot is on: your job is that no chat sits waiting for them.
- A chat waiting on a question: on autopilot, answer it with fleet_answer when one option is marked (Recommended) or is
  clearly right for the goal and reversible. Otherwise leave it and say which chat and why.
- A chat waiting on a permission always needs the user: never try to get around it. Say which chat and why.
- A chat that ended its turn with a plain-text question ("Which do you want?") is waiting too: on autopilot, reply with
  fleet_send when the answer is clear from the goal; otherwise suggest.
- A chat that failed or stopped: read it, and send it what it needs to carry on (often just "continue").
- When a next step is clear, safe and inside the goal, and autopilot is on, send it with fleet_send.
  Anything irreversible or outward-facing (pushing, merging to main, deploying, deleting, spending money, messaging people)
  goes to the user as a suggestion instead, whatever the mode.
- With autopilot off, do not send anything yourself: offer every next step with fleet_suggest.
- Messages starting with "[autopilot]" come from the host, not the user: check the chats that changed, act or suggest, and
  reply in a few lines. If nothing needs doing, say so in one line.
- Do not do the chats' work yourself, and do not edit files: you steer, they build.
- Keep replies short: what changed, what you sent, what needs the user.
- "[autopilot] Time is up" means the user is due back: write them a summary of the time away, chat by chat: what got done,
  what you sent or answered on their behalf, and what now needs them, most urgent first.
`.trim()

/** what the conductor has learned about each chat and about you, kept across restarts (a test points it elsewhere) */
const notesFile = () => process.env.LAIKA_CONDUCTOR_NOTES ?? join(homedir(), '.laika', 'conductor-notes.json')
const readNotes = () => {
  try {
    const n = JSON.parse(readFileSync(notesFile(), 'utf8'))
    return { chats: n.chats ?? {}, you: n.you ?? [] }
  } catch {
    return { chats: {}, you: [] }
  }
}
const writeNotes = (n) => {
  mkdirSync(dirname(notesFile()), { recursive: true, mode: 0o700 })
  writeFileSync(`${notesFile()}.tmp`, JSON.stringify(n, null, 1), { mode: 0o600 })
  renameSync(`${notesFile()}.tmp`, notesFile())
}
/** a chat's notes outlive its tab: they follow the conversation */
const noteKey = (x) => x.sdkSessionId ?? x.id
const FROM_CONDUCTOR = '[from the conductor] '
/** what you typed, not what the conductor or the host sent */
const yours = (e) => e.t === 'user' && !e.auto && !String(e.text ?? '').startsWith(FROM_CONDUCTOR) && !/^\[Request interrupted/.test(String(e.text ?? ''))

const clip = (t, n) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}
const ok = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] })
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true })

/** the chats a conductor leads: open, and not conductors themselves */
const fleetOf = (sessions, self) =>
  [...sessions.values()].filter((x) => x !== self && x.state !== 'closed' && x.role !== ROLE)

/** a chat by its id or the first characters of it */
const find = (sessions, self, id) => {
  const key = String(id ?? '').trim()
  if (!key) return null
  const hits = fleetOf(sessions, self).filter((x) => x.id === key || x.id.startsWith(key))
  return hits.length === 1 ? hits[0] : null
}

const card = (x, notes = readNotes()) => {
  const said = x.events.filter(yours)
  const last = said.at(-1)
  return {
    id: x.id.slice(0, 8),
    repo: x.repo,
    title: clip(x.brief?.goal || x.title, 100),
    state: x.state,
    needsUser: [...x.pending.values()].map((p) => p.kind),
    now: clip(x.brief?.now, 200) || null,
    next: clip(x.brief?.next, 200) || null,
    // the arc of the chat, from the host's brief: what each of your prompts was about and how it went
    arc: (x.brief?.turns ?? []).slice(-6).map((t) => `${t.label} (${t.status})`),
    // your own words, most recent last: the best guide to what you want from it
    youSaid: said.slice(-3).map((e) => clip(e.text, 240)),
    youLastSpoke: last ? `${Math.round((Date.now() - last.at) / 60000)}m ago` : null,
    idleFor: x.state === 'idle' ? `${Math.round((Date.now() - x.updatedAt) / 60000)}m` : null,
    cost: Math.round(x.cost * 100) / 100,
    notes: notes.chats[noteKey(x)] ?? [],
  }
}

/** the fleet MCP server for one conductor chat */
export async function fleetServer(s, sessions) {
  const { tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk')
  return createSdkMcpServer({ name: 'fleet', version: '1.0.0', tools: fleetTools(s, sessions, tool) })
}

/** the conductor's tools; `tool` is the SDK's, or a stand-in in tests */
export function fleetTools(s, sessions, tool) {
  // zod comes with the SDK; this package does not depend on it directly
  const { z } = createRequire(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'))('zod')
  return [
      tool('fleet_list', 'List every other open chat: goal, state, where it stands, its planned next step, and whether it is waiting on the user.', {}, async () => {
        const all = fleetOf(sessions, s)
        const notes = readNotes()
        return ok({
          autopilot: s.autopilot,
          awayUntil: s.autopilotUntil ? new Date(s.autopilotUntil).toISOString() : null,
          goal: s.goal || null,
          aboutTheUser: notes.you,
          chats: all.map((x) => card(x, notes)),
        })
      }),
      tool(
        'fleet_read',
        "Read a chat's recent messages: the user's prompts, Claude's replies, how turns ended and what it is waiting on.",
        { chat: z.string().describe('chat id (the first 8 characters are enough)'), limit: z.number().int().min(1).max(40).optional() },
        async ({ chat, limit = 12 }) => {
          const x = find(sessions, s, chat)
          if (!x) return fail(`No single open chat matches "${chat}". Call fleet_list for the ids.`)
          const rows = []
          for (const e of x.events) {
            if (e.t === 'user') rows.push({ who: 'user', text: clip(e.text, 600) })
            else if (e.t === 'text' && !e.sub) rows.push({ who: 'claude', text: clip(e.text, 1200) })
            else if (e.t === 'result') rows.push({ who: 'host', text: e.error ? `turn failed: ${clip(e.error, 200)}` : 'turn finished' })
            else if (e.t === 'error') rows.push({ who: 'host', text: `error: ${clip(e.message, 200)}` })
            else if (e.t === 'question') rows.push({ who: 'waiting', text: `asks the user: ${clip((e.questions ?? []).map((q) => q.question).join(' / '), 400)}` })
            else if (e.t === 'permission') rows.push({ who: 'waiting', text: `asks permission for ${e.tool}: ${clip(JSON.stringify(e.input), 200)}` })
          }
          return ok({ chat: card(x), messages: rows.slice(-limit) })
        },
      ),
      tool(
        'fleet_you',
        "Everything the user typed across every chat, oldest first, with when and where: read it to understand their priorities, habits and standing instructions.",
        { limit: z.number().int().min(5).max(120).optional() },
        async ({ limit = 50 }) => {
          const rows = []
          for (const x of fleetOf(sessions, s))
            for (const e of x.events) if (yours(e)) rows.push({ at: e.at, chat: x.id.slice(0, 8), repo: x.repo, text: clip(e.text, 300) })
          rows.sort((a, b) => a.at - b.at)
          return ok(rows.slice(-limit).map((r) => ({ ...r, at: new Date(r.at).toISOString().slice(0, 16) })))
        },
      ),
      tool(
        'fleet_note',
        'Remember something you have understood, so you still know it after a restart: about one chat (its real intent, what it waits on, what the user asked of it) or, with no chat, about the user.',
        {
          chat: z.string().optional().describe('chat id; leave out for a note about the user'),
          note: z.string().min(1).max(400),
          replace: z.boolean().optional().describe('drop the earlier notes for this chat (or about the user) first'),
        },
        async ({ chat, note, replace }) => {
          const n = readNotes()
          let list
          if (chat) {
            const x = find(sessions, s, chat)
            if (!x) return fail(`No single open chat matches "${chat}".`)
            list = replace ? [] : (n.chats[noteKey(x)] ?? [])
            n.chats[noteKey(x)] = [...list, note].slice(-12)
          } else {
            list = replace ? [] : n.you
            n.you = [...list, note].slice(-30)
          }
          writeNotes(n)
          return ok('Noted.')
        },
      ),
      tool(
        'fleet_send',
        'Send a chat a message, as if the user typed it. Only for clear, safe next steps inside the goal, and only while autopilot is on.',
        { chat: z.string(), text: z.string().min(1).max(4000) },
        async ({ chat, text }) => {
          if (!s.autopilot) return fail('Autopilot is off: offer this with fleet_suggest instead, and the user will send it.')
          const x = find(sessions, s, chat)
          if (!x) return fail(`No single open chat matches "${chat}".`)
          if (x.pending.size) return fail(`That chat is waiting on the user (${[...x.pending.values()].map((p) => p.kind).join(', ')}). Tell the user instead.`)
          if (x.account?.demo) return fail('That is an offline demo chat.')
          x.send(`${FROM_CONDUCTOR}${text}`)
          return ok(`Sent to ${x.id.slice(0, 8)} (${x.repo}). It was ${x.state === 'running' ? 'already working; the message is queued' : 'idle and has started'}.`)
        },
      ),
      tool(
        'fleet_answer',
        "Answer the question card a chat is waiting on, as the user would. Autopilot only; never for permissions.",
        {
          chat: z.string(),
          answers: z
            .array(z.object({ question: z.string().describe('the question text, as fleet_read shows it'), answer: z.string().describe('the label of the option chosen, or a short free answer') }))
            .min(1),
        },
        async ({ chat, answers }) => {
          if (!s.autopilot) return fail('Autopilot is off: tell the user instead.')
          const x = find(sessions, s, chat)
          if (!x) return fail(`No single open chat matches "${chat}".`)
          const q = [...x.pending.entries()].find(([, p]) => p.kind === 'question')
          if (!q) return fail('That chat is not waiting on a question.')
          const [requestId, p] = q
          const asked = p.event.questions ?? []
          const out = {}
          for (const a of answers) {
            const match = asked.find((k) => k.question === a.question) ?? (asked.length === 1 ? asked[0] : null)
            if (!match) return fail(`No question "${clip(a.question, 80)}". It asks: ${asked.map((k) => k.question).join(' / ')}`)
            out[match.question] = a.answer
          }
          x.answer(requestId, { answers: out, annotations: {} })
          x.emit({ t: 'note', text: 'The conductor answered this for you' })
          return ok(`Answered for ${x.id.slice(0, 8)} (${x.repo}).`)
        },
      ),
      tool(
        'fleet_suggest',
        'Show the user suggested actions as cards; each one sends its text to that chat when clicked. Use for anything that needs their say.',
        {
          items: z
            .array(
              z.object({
                chat: z.string().describe('chat id'),
                text: z.string().min(1).max(2000).describe('the message the chat would receive, written as the user would say it'),
                why: z.string().max(300).optional().describe('one line on why'),
              }),
            )
            .min(1)
            .max(8),
        },
        async ({ items }) => {
          const shown = []
          const missing = []
          for (const it of items) {
            const x = find(sessions, s, it.chat)
            if (!x) missing.push(it.chat)
            else shown.push({ chat: x.id, repo: x.repo, title: clip(x.brief?.goal || x.title, 80), text: it.text, why: it.why ?? '' })
          }
          if (shown.length) s.emit({ t: 'suggestions', items: shown })
          return ok(`Showed ${shown.length} suggestion(s)${missing.length ? `; no chat matched ${missing.join(', ')}` : ''}.`)
        },
      ),
  ]
}

/**
 * Autopilot: wake idle conductors when the chats they lead change. `send` is the conductor's own
 * Session.send, so a check-in looks like any other turn in its chat.
 */
export function watchFleet(sessions) {
  const changed = new Map() // conductor → Map(chat id → state)
  const timers = new Map()

  const checkIn = (c, why) => {
    if (c.state === 'closed' || !c.autopilot) return
    // busy or waiting on you: try again once it is free
    if (c.state !== 'idle') return schedule(c, SETTLE_MS)
    const seen = changed.get(c) ?? new Map()
    changed.delete(c)
    c.checkins = (c.checkins ?? 0) + 1
    c.lastCheckIn = Date.now()
    if (c.checkins > MAX_CHECKINS) {
      setAutopilot(c, false, { note: `Autopilot switched off after ${MAX_CHECKINS} check-ins. Switch it back on to carry on.` })
      return
    }
    const byId = new Map([...sessions.values()].map((x) => [x.id, x]))
    const lines = [...seen].map(([id, state]) => `- ${id.slice(0, 8)} (${byId.get(id)?.repo ?? '?'}) is now ${state}`)
    c.send(
      `[autopilot] ${why}${lines.length ? `\n${lines.join('\n')}` : ''}\nCheck in on the fleet and keep it moving toward the goal${c.goal ? `: ${c.goal}` : ''}.`,
      [],
      { auto: true },
    )
  }

  const schedule = (c, ms, why) => {
    clearTimeout(timers.get(c))
    const wait = Math.max(ms, (c.lastCheckIn ?? 0) + MIN_GAP_MS - Date.now())
    const t = setTimeout(() => {
      timers.delete(c)
      checkIn(c, why ?? (changed.get(c)?.size ? 'Chats changed:' : 'Heartbeat: nothing has changed for a while.'))
    }, wait)
    t.unref?.()
    timers.set(c, t)
  }

  const conductors = () => [...sessions.values()].filter((x) => x.role === ROLE && x.autopilot && x.state !== 'closed')

  // a lead chat's turn ended, or it stopped on you: that is worth a look
  const onState = (x) => {
    if (x.role === ROLE || x.account?.demo) return
    if (!['idle', 'waiting', 'error'].includes(x.state)) return
    for (const c of conductors()) {
      const m = changed.get(c) ?? new Map()
      m.set(x.id, x.state)
      changed.set(c, m)
      schedule(c, SETTLE_MS)
    }
  }

  const beat = setInterval(() => {
    for (const c of conductors()) {
      if (c.autopilotUntil && Date.now() >= c.autopilotUntil) {
        timeUp(c)
        continue
      }
      const working = fleetOf(sessions, c).some((x) => x.state === 'running')
      if (working && !timers.has(c) && Date.now() - (c.lastCheckIn ?? c.updatedAt) > HEARTBEAT_MS) schedule(c, 0)
    }
  }, 60_000)
  beat.unref?.()

  // time is up: one last turn to tell you what happened, then it only suggests again
  const timeUp = (c) => {
    if (c.state !== 'idle') return // the next beat tries again
    setAutopilot(c, false, { note: 'Away time is up: autopilot is off' })
    c.send('[autopilot] Time is up: the user is due back. Write them the summary of the time away.', [], { auto: true })
  }

  /** `minutes`: how long you are away; 0 or missing means until you switch it off */
  const setAutopilot = (c, on, { minutes = 0, note } = {}) => {
    c.autopilot = on
    c.autopilotUntil = on && minutes > 0 ? Date.now() + minutes * 60_000 : null
    if (on) {
      c.checkins = 0
      c.awaySince = Date.now()
    } else {
      clearTimeout(timers.get(c))
      timers.delete(c)
      changed.delete(c)
    }
    c.emit({ t: 'autopilot', on, until: c.autopilotUntil })
    const until = c.autopilotUntil ? ` until ${new Date(c.autopilotUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''
    c.emit({ t: 'note', text: note ?? (on ? `Autopilot on${until}: the conductor keeps the chats going and answers what it safely can` : 'Autopilot off: the conductor only suggests') })
    awake()
    // straight away, rather than at the first change
    if (on) schedule(c, 0, 'Autopilot is on: the user is stepping away. Take stock of every chat and get the waiting ones moving.')
  }

  // the Mac must not sleep while you are away and the chats are meant to keep going
  let caffeinate = null
  const awake = () => {
    const want = conductors().length > 0
    if (want && !caffeinate && process.platform === 'darwin') {
      caffeinate = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
      caffeinate.on('exit', () => (caffeinate = null))
      caffeinate.on('error', () => (caffeinate = null))
    } else if (!want && caffeinate) {
      caffeinate.kill()
      caffeinate = null
    }
  }

  return {
    onState,
    setAutopilot,
    /** a conductor restored after a restart keeps its autopilot */
    restored: () => awake(),
    humanSpoke: (c) => (c.checkins = 0),
  }
}
