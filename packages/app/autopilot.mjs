/**
 * Autopilot: the feature you can see, over the machinery that already runs it.
 *
 * Until now autopilot was a hidden mode a conductor chat happened to be in (conductor.mjs), and
 * away mode (away.mjs) was the only way to switch it on — which welded four separate things
 * together. This module is the one place that says what autopilot is doing, keeps the ledger of
 * what it has done, and is the only way to change it:
 *
 *   off    the conductor only suggests; nothing is sent for you
 *   on     the conductor sends work to your chats, and you answer every permission prompt yourself
 *   away   as `on`, plus the away policy approves the plainly safe (away-policy.mjs), stuck chats
 *          are recovered, a budget applies, and the conductor writes you a summary when you return
 *
 * The mode is never stored: it is read back from the chats themselves (is a conductor on
 * autopilot?) and from away mode, so the control cannot drift from what is really happening.
 *
 * Nothing here decides anything on your behalf that reaches outside this machine. Permission
 * prompts are never answered here: the decision inbox only shows you what is waiting, and only
 * your click answers it.
 *
 * The kill switch is the point of the whole thing. `halt()` takes every conductor off autopilot
 * and, from the next call, refuses every fleet tool that sends — `refusal(kind)` is the gate the
 * host hands conductor.mjs, ahead of the away budget. It stops the conductor and nothing else: a
 * chat already working carries on, and while away, the policy keeps approving the plainly safe and
 * recovery keeps chats alive. Switching to `off` ends all of that. The control says which is which.
 * The same gate is where a future "pause all chats" belongs: one more reason in `refusal`.
 *
 * The ledger is one append-only file (~/.laika/autopilot-log.jsonl): every action with its reason
 * and, where the action can be taken back, how. The away log stays where it is and is still what
 * the away summary reads — this is the fleet's story, not away mode's.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { inputSummary, loadPolicy } from './away-policy.mjs'
import { ROLE } from './conductor.mjs'
import { boardRow, shipKind } from './fleet-board.mjs'

/** the modes, in the order the control shows them */
export const MODES = ['off', 'on', 'away']

/** the ledger (a test points it elsewhere) */
export const logFile = () => process.env.LAIKA_AUTOPILOT_LOG ?? join(homedir(), '.laika', 'autopilot-log.jsonl')

/** how much of the ledger the timeline will ever read back */
const MAX_READ = 4000

const clip = (t, n) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/**
 * Every kind of thing the conductor does, in the words the timeline uses, and what taking it back
 * would mean. A message already sent cannot be unsent, so `send` and `handoff` offer to stop the
 * chat instead — said as "Stop it", never as "Undo", because they are not the same thing. Closing
 * a chat has no inverse at all: Claude Code's conversation goes with it, and the timeline says so
 * rather than showing a button that lies. `why` is what the row shows when there is nothing to do.
 */
export const ACTIONS = {
  send: { verb: 'sent to', can: 'stop', label: 'Stop that chat' },
  answer: { verb: 'answered a question for', why: 'the chat has the answer and has moved on' },
  spawn: { verb: 'opened', can: 'park', label: 'Park it' },
  close: { verb: 'closed', why: 'a closed chat cannot be brought back: its conversation went with it' },
  park: { verb: 'parked', can: 'unpark', label: 'Resume it' },
  unpark: { verb: 'resumed', can: 'park', label: 'Park it again' },
  rename: { verb: 'renamed', can: 'rename', label: 'Put the name back' },
  handoff: { verb: 'handed work to', can: 'stop', label: 'Stop that chat' },
  suggest: { verb: 'suggested to', why: 'a suggestion does nothing until you click it' },
  mode: { verb: 'autopilot', why: 'choose a mode on the control instead' },
  halt: { verb: 'kill switch', can: 'resume', label: 'Release it' },
  allow: { verb: 'always-allowed', can: 'unallow', label: 'Stop allowing it' },
  queue: { verb: 'queued work for', why: 'change it on the queue instead: fleet_queue_update, or the queue page' },
}

// ------------------------------------------------------------ what reaches outside ----
/**
 * The kinds of thing you said you always want to decide yourself: pushing, deploying, merging to
 * main, spending money, messaging people, deleting. `shipKind` (fleet-board.mjs) already names the
 * first of those for the board's buttons; this adds the rest, and keeps its words.
 *
 * This only ranks and labels. Nothing is ever hidden from the inbox because it was not matched:
 * everything a chat waits on is in the list, and an unmatched one simply sits below the ones that
 * reach outside. A miss costs you a scroll, never a surprise.
 */
export const OUTWARD = ['push', 'publish', 'deploy', 'release', 'merge', 'message', 'delete']

const MERGE_MAIN = /\bgit\s+(?:-[Cc]\s+\S+\s+)*(?:merge|rebase)\b[^&|;]*\b(?:main|master|origin\/(?:main|master))\b/
const MERGE_INTO_MAIN = /\bgit\s+(?:-[Cc]\s+\S+\s+)*(?:checkout|switch)\s+(?:main|master)\b[^&|;]*(?:&&|;)[^&|;]*\bgit\s+merge\b/
const MESSAGE = /\b(?:sendmail|mailx?)\s|\bgh\s+(?:issue|pr)\s+comment\b|hooks\.slack\.com|discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org|\bosascript\b[^&|;]*\b(?:Mail|Messages)\b/i
const DELETE = /\brm\s+(?:-\w*[rf]\w*\s+)+|\bgit\s+branch\s+-[dD]\b|\bgh\s+(?:repo|release)\s+delete\b|\bdropdb\b|\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b|\baws\s+s3\s+rm\b|\bfind\b[^&|;]*-delete\b/i

/** which of OUTWARD a tool call is, or null. Bash and MCP tools only: an edit stays on this Mac. */
export function outwardKind(tool, input = {}) {
  const ship = shipKind(tool, input)
  if (ship) return ship
  if (tool === 'Bash') {
    const c = String(input.command ?? '')
    if (MERGE_MAIN.test(c) || MERGE_INTO_MAIN.test(c)) return 'merge'
    if (MESSAGE.test(c)) return 'message'
    if (DELETE.test(c)) return 'delete'
    return null
  }
  if (/^mcp__/.test(tool)) {
    if (/gmail|slack|discord|twilio|resend|sendgrid|email|message|post_comment/i.test(tool)) return 'message'
    if (/delete|remove|drop/i.test(tool)) return 'delete'
    if (/merge/i.test(tool)) return 'merge'
  }
  return null
}

/** how the inbox orders itself: what reaches outside, then questions, then the rest */
const RANK = { push: 0, publish: 0, deploy: 0, release: 0, merge: 0, delete: 0, message: 1, budget: 1, question: 3, permission: 4 }

/**
 * @param {object} o
 * @param {Map<string, any>} o.sessions  the host's open chats
 * @param {object} o.fleet               watchFleet's handle (setAutopilot)
 * @param {object} o.away                createAway's handle (get, start, stop)
 * @param {string} o.file                where the kill switch and the spend are kept
 * @param {object} o.deps
 *   startConductor({ goal, cwd }) → Promise<Session>   the host's own, as away mode uses
 *   saved()                                           the registry should be written
 *   undo                                              the inverses the host can perform:
 *     close(chat, reason), park(chat, reason), unpark(chat), rename(chat, title, group), unallow(pattern)
 */
export function createAutopilot({ sessions, fleet, away, file = join(homedir(), '.laika', 'autopilot.json'), deps = {}, log = logFile }) {
  const blank = () => ({ halted: null, since: null, spend: { chats: {}, dollars: 0 } })
  let state = blank()
  let seq = 0

  const save = () => {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1), { mode: 0o600 })
      renameSync(`${file}.tmp`, file)
    } catch {}
  }

  const live = (x) => x && x.state !== 'closed'
  const leads = () => [...sessions.values()].filter((x) => x.role === ROLE && live(x))
  /** the conductor autopilot means: the one on autopilot, else away mode's, else the latest real one */
  const lead = () => {
    const all = leads().sort(
      (a, b) => Number(!!a.account?.demo) - Number(!!b.account?.demo) || Number(!!b.autopilot) - Number(!!a.autopilot) || b.updatedAt - a.updatedAt,
    )
    const id = away.get().conductorId
    return all.find((x) => x.autopilot) ?? all.find((x) => x.id === id) ?? all[0] ?? null
  }

  /** read back from what is really happening, never stored: the control cannot drift */
  const mode = () => (away.get().on ? 'away' : leads().some((x) => x.autopilot) ? 'on' : 'off')

  // ------------------------------------------------------------ the ledger
  /**
   * One thing the conductor (or you) did, with its reason. Appended, never rewritten: an undo is
   * itself an entry, and the timeline folds the two together.
   */
  function report({ action, conductor = null, chat = null, repo = null, text = '', reason = '', undo = null, of = null }) {
    const e = {
      at: Date.now(),
      id: `${Date.now().toString(36)}-${(seq++).toString(36)}`,
      action,
      mode: mode(),
      conductor: conductor?.id ?? conductor ?? null,
      chat: chat?.id ?? chat ?? null,
      repo: repo ?? chat?.repo ?? null,
      text: clip(text, 500),
      reason: clip(reason, 500),
      ...(undo ? { undo } : {}),
      // an undo names the action it takes back, so the ledger can stay append-only
      ...(of ? { of } : {}),
    }
    try {
      mkdirSync(dirname(log()), { recursive: true, mode: 0o700 })
      appendFileSync(log(), `${JSON.stringify(e)}\n`, { mode: 0o600 })
    } catch {}
    return e
  }

  /** the ledger back, newest last, since a time; undone entries marked rather than hidden */
  function ledger({ since = 0, limit = 300 } = {}) {
    let lines = []
    try {
      lines = readFileSync(log(), 'utf8').split('\n').filter(Boolean).slice(-MAX_READ)
    } catch {
      return []
    }
    const rows = []
    const undone = new Map()
    for (const l of lines) {
      let e = null
      try {
        e = JSON.parse(l)
      } catch {
        continue
      }
      if (e.action === 'undo') {
        undone.set(e.of, e)
        continue
      }
      if (e.at >= since) rows.push(e)
    }
    for (const r of rows) {
      const u = undone.get(r.id)
      if (u) r.undone = { at: u.at, text: u.text }
    }
    return rows.slice(-limit)
  }

  // ------------------------------------------------------------ spend
  /**
   * What the chats have spent since autopilot came on. A chat's cost is its Claude Code process's
   * running total, which starts again at 0 when that process restarts, so each chat's spend is
   * added up from what it grew by. Away mode keeps its own count for its own window (away.mjs);
   * this one is the fleet's, and says plainly which window it measures.
   */
  function tally(x) {
    if (!state.since || x.account?.demo) return
    const k = state.spend.chats[x.id] ?? (state.spend.chats[x.id] = { last: Number(x.cost) || 0, spent: 0 })
    const cost = Number(x.cost) || 0
    const grew = cost >= k.last ? cost - k.last : cost
    k.last = cost
    if (grew > 0) {
      k.spent += grew
      state.spend.dollars += grew
      save()
    }
  }
  const spent = () => {
    if (state.since) for (const x of sessions.values()) if (live(x)) tally(x)
    return Math.round(state.spend.dollars * 100) / 100
  }

  // ------------------------------------------------------------ the kill switch
  const halted = () => state.halted

  /**
   * Stop the conductor sending, now. Every conductor comes off autopilot, so no check-in is
   * scheduled, and every fleet tool that sends is refused from its next call. Away mode's
   * approvals and recovery are deliberately left alone: they keep the chats you already have
   * alive, and `set('off')` is what ends those.
   */
  function halt(reason = '') {
    if (state.halted) return view()
    state.halted = { at: Date.now(), reason: clip(reason, 200) }
    for (const c of leads()) if (c.autopilot) fleet.setAutopilot(c, false, { note: 'Kill switch: autopilot is off and the conductor cannot send anything' })
    report({ action: 'halt', text: 'Kill switch: the conductor was stopped', reason, undo: { kind: 'resume' } })
    save()
    deps.saved?.()
    return view()
  }

  /** take the kill switch off; autopilot stays off until you choose a mode */
  function resume() {
    if (!state.halted) return view()
    state.halted = null
    report({ action: 'halt', text: 'Kill switch released: autopilot can be switched on again' })
    save()
    return view()
  }

  /**
   * The gate conductor.mjs consults before a fleet tool acts: why it may not, or null.
   * The host puts this ahead of the away budget, so the kill switch wins over everything.
   */
  function refusal(kind = 'send') {
    if (!state.halted) return null
    return `The user hit the kill switch${state.halted.reason ? ` (${state.halted.reason})` : ''}: autopilot is off and nothing may be sent to another chat. Do not try again. Say what you were about to do and leave it for them.`
  }

  // ------------------------------------------------------------ the mode
  /**
   * Choose a mode. `off` ends everything; `on` puts the conductor to work with every permission
   * still coming to you; `away` is `on` plus the away policy, recovery, a budget and a summary.
   * Choosing `on` or `away` releases the kill switch: you are explicitly arming it again.
   */
  async function set(next, { minutes = 0, goal = '', cwd = null, budget, reason = '' } = {}) {
    if (!MODES.includes(next)) throw new Error(`Autopilot mode must be one of ${MODES.join(', ')}`)
    const was = mode()
    if (next !== 'off' && state.halted) resume()

    if (next === 'off') {
      if (away.get().on) away.stop('back')
      for (const c of leads()) if (c.autopilot) fleet.setAutopilot(c, false, { note: 'Autopilot off: the conductor only suggests' })
      state.since = null
      state.spend = { chats: {}, dollars: 0 }
      report({ action: 'mode', text: 'Autopilot off', reason })
      save()
      deps.saved?.()
      return view()
    }

    // the spend window starts when autopilot first comes on, and survives off → on → off
    if (!state.since) {
      state.since = Date.now()
      state.spend = { chats: {}, dollars: 0 }
      for (const x of sessions.values()) if (live(x) && !x.account?.demo) state.spend.chats[x.id] = { last: Number(x.cost) || 0, spent: 0 }
    }

    if (next === 'away') {
      // the budget and the time come from the policy you edited in the app, unless this ask says
      const p = loadPolicy()
      const mins = minutes || p.minutes || 60
      const v = await away.start({ minutes: mins, goal, cwd, budget: budget === undefined ? (p.budget ?? undefined) : budget })
      report({ action: 'mode', chat: v.conductorId, text: `Away for ${mins} minutes: the conductor leads, safe tools are approved, stuck chats are recovered`, reason: goal || reason })
      save()
      return view()
    }

    // on: the conductor works, every permission still comes to you
    if (away.get().on) away.stop('back')
    let c = lead()
    if (!c) {
      if (!deps.startConductor) throw new Error('No conductor chat, and none can be started')
      c = await deps.startConductor({ goal: goal || 'Keep every open chat moving on its current task', cwd })
    }
    if (goal) c.goal = goal
    fleet.setAutopilot(c, true, { minutes })
    report({ action: 'mode', conductor: c, text: `Autopilot on${minutes ? ` for ${minutes} minutes` : ''}: the conductor sends work, you answer every permission`, reason: goal || reason })
    save()
    deps.saved?.()
    return view()
  }

  // ------------------------------------------------------------ undo
  /**
   * Take back one action, where it can be taken back. Nothing here reaches outside this machine,
   * and an undo is itself an entry in the ledger. An action with no inverse says so instead.
   */
  async function undo(id) {
    const e = ledger({ limit: MAX_READ }).find((x) => x.id === id)
    if (!e) throw new Error('No such action')
    if (e.undone) throw new Error('That was already taken back')
    const kind = e.undo?.kind
    if (!kind) throw new Error(ACTIONS[e.action]?.why ?? 'That cannot be taken back')
    const u = deps.undo ?? {}
    const say = async () => {
      switch (kind) {
        case 'resume':
          resume()
          return 'The kill switch is off'
        case 'park':
          await u.park?.(e.chat, 'Taken back from the autopilot timeline')
          return 'The chat is parked: its conversation is kept and you can resume it'
        case 'unpark':
          await u.unpark?.(e.chat)
          return 'The chat is back where it left off'
        case 'rename':
          await u.rename?.(e.chat, e.undo.title ?? null, e.undo.group ?? null)
          return `The chat is “${e.undo.title}” again`
        case 'unallow':
          await u.unallow?.(e.undo.pattern)
          return `“${e.undo.pattern}” is no longer always allowed`
        case 'stop':
          await u.stop?.(e.chat)
          return 'That chat was stopped: what it had already done stands'
        default:
          throw new Error('That cannot be taken back')
      }
    }
    const text = await say()
    report({ action: 'undo', of: e.id, chat: e.chat, text })
    return { ok: true, text, of: e.id }
  }

  // ------------------------------------------------------------ what the app sees
  /** the control: the mode, what it may do, what it has done, and what it has cost */
  function view() {
    const m = mode()
    const a = away.get()
    const c = lead()
    const rows = state.since ? ledger({ since: state.since, limit: MAX_READ }) : []
    const counts = {}
    for (const r of rows) if (r.action !== 'mode' && r.action !== 'halt') counts[r.action] = (counts[r.action] ?? 0) + 1
    const actions = Object.values(counts).reduce((n, v) => n + v, 0)
    return {
      mode: m,
      since: state.since,
      halted: state.halted,
      conductor: c ? { id: c.id, repo: c.repo, goal: c.goal ?? '', state: c.state, autopilot: !!c.autopilot, until: c.autopilotUntil ?? null, checkins: c.checkins ?? 0 } : null,
      /** what it may do in this mode, in the words the control shows */
      may: may(m),
      actions,
      counts,
      spend: { dollars: spent(), since: state.since },
      // away mode's budget while it runs, otherwise the one in the policy: the control shows what
      // would apply, not nothing, so the number you edited is the number you see
      budget: a.budget ?? loadPolicy().budget ?? null,
      budgetHit: a.budgetHit ?? null,
      away: { on: a.on, until: a.until, left: a.left ?? 0, goal: a.goal, approved: a.counts?.approved ?? 0, asked: a.counts?.asked ?? 0, recovered: a.counts?.recovered ?? 0, summary: a.summary, endedAt: a.endedAt, conductorId: a.conductorId },
    }
  }

  /** plain words for what each mode allows, so the control never has to be guessed at */
  const may = (m) =>
    m === 'off'
      ? ['Suggest work to you as cards', 'Nothing is sent for you']
      : m === 'on'
        ? ['Send work to your chats', 'Open, park and close chats it opened', 'Answer its own questions', 'You answer every permission prompt']
        : [
            'Send work to your chats',
            'Open, park and close chats it opened',
            'Approve plainly safe tools in your folders (reading, editing, tests, git status)',
            'Bring back chats that fail or go quiet',
            'You answer everything that reaches outside this machine',
          ]

  // ------------------------------------------------------------ the conductor panel
  /**
   * Every chat on one row, so the fleet can be watched without opening any of it: where it stands
   * and its ETA (the fleet board already works those out from live progress and the status line),
   * plus the three things only the conductor knows — what it last sent this chat and why, what is
   * queued behind that, and what the conductor is waiting on before it looks again.
   */
  function panel({ now = Date.now() } = {}) {
    const rows = [...sessions.values()].filter((x) => x.state !== 'closed').map((x) => boardRow(x, { now }))
    const sent = new Map()
    for (const e of state.since ? ledger({ since: state.since, limit: MAX_READ }) : []) {
      if (e.action === 'send' || e.action === 'handoff' || e.action === 'answer') sent.set(e.chat, e)
    }
    const c = lead()
    const waits = (c?.waits ?? []).map((w) => ({ chat: w.chat, until: w.until, at: w.at, endsAt: w.endsAt ?? null }))
    return {
      at: now,
      mode: mode(),
      conductor: c
        ? {
            id: c.id,
            repo: c.repo,
            title: c.title,
            state: c.state,
            goal: c.goal ?? '',
            autopilot: !!c.autopilot,
            until: c.autopilotUntil ?? null,
            checkins: c.checkins ?? 0,
            lastCheckIn: c.lastCheckIn ?? null,
            /** what it is waiting for before its next check-in (fleet_wait) */
            waits,
          }
        : null,
      rows: rows
        .filter((r) => r.id !== c?.id)
        .map((r) => {
          const s = sent.get(r.id)
          return {
            ...r,
            /** the last thing the conductor sent this chat, and the reason it gave */
            lastSent: s ? { at: s.at, action: s.action, text: s.text, reason: s.reason, id: s.id } : null,
            /** messages typed while it was busy, which it has not read yet */
            queued: sessions.get(r.id)?.queue?.length ?? 0,
            /** the conductor is holding for this chat to reach a point */
            waitingFor: waits.find((w) => w.chat === r.id)?.until ?? null,
          }
        }),
    }
  }

  // ------------------------------------------------------------ the decision inbox
  /**
   * Everything waiting on you, from every chat, in one list — what reaches outside this machine
   * first. Nothing here is ever answered for you: the rows carry the chat and request id, and your
   * click goes to the same route the chat's own permission card uses.
   */
  function inbox({ now = Date.now() } = {}) {
    const items = []
    for (const x of sessions.values()) {
      if (x.state === 'closed') continue
      for (const p of x.pending?.values() ?? []) {
        const e = p.event ?? {}
        const tool = String(e.tool ?? '')
        const out = p.kind === 'question' ? null : outwardKind(tool, e.input ?? {})
        items.push({
          id: `${x.id}:${e.requestId}`,
          chat: x.id,
          requestId: e.requestId,
          repo: x.repo,
          title: x.title || x.repo,
          group: x.group ?? null,
          spawnedBy: x.spawnedBy ?? null,
          kind: out ?? (p.kind === 'question' ? 'question' : 'permission'),
          outward: !!out,
          tool: tool || null,
          /** the one line that says what it would do */
          what: p.kind === 'question' ? (e.questions?.[0]?.question ?? 'A question') : inputSummary(tool, e.input ?? {}),
          questions: p.kind === 'question' ? (e.questions ?? []) : null,
          /** away mode's plain reason for leaving it to you, when it had one */
          why: e.plain ?? e.reason ?? null,
          /** the allowlist entry that would let this through unattended, when there is one */
          allowPattern: e.allowPattern ?? null,
          /** a built-in default your own policy file switched off: this is only waiting because of that */
          removedDefault: e.removedDefault ?? null,
          canAlways: !!e.canAlways,
          at: e.at ?? now,
        })
      }
    }
    // the budget is a decision too: reaching it stops the conductor until you say otherwise
    const a = away.get()
    if (a.budgetHit) items.push({ id: 'budget', chat: null, kind: 'budget', outward: false, what: a.budgetHit.what, why: 'Autopilot stopped sending and opening chats when it reached your budget', at: a.budgetHit.at })
    items.sort((p, q) => (RANK[p.kind] ?? 5) - (RANK[q.kind] ?? 5) || p.at - q.at)
    return { at: now, items, outward: items.filter((i) => i.outward).length }
  }

  /** after a host restart: the kill switch and the spend so far */
  function restore() {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      state = { ...blank(), ...saved, spend: { chats: {}, dollars: 0, ...(saved.spend ?? {}) } }
    } catch {}
    return view()
  }

  return { view, mode, set, halt, resume, halted, refusal, report, ledger, undo, panel, inbox, restore, tally, spent, MODES }
}
