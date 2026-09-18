/**
 * Away mode: one switch for leaving your chats running for hours.
 *
 * Turning it on for a while finds the conductor chat (or starts one), puts it on autopilot for the
 * same time, and switches on the away policy (away-policy.mjs), so the plainly safe permission
 * prompts stop stalling chats. While away, the host also looks after chats that get stuck:
 *  - Claude Code stopped and could not be restarted: wait (longer each time), bring it back, "continue"
 *  - a turn failed: wait the same way, then "continue"
 *  - a usage limit: move to another of your own signed-in accounts if the policy allows,
 *    otherwise wait for the reset and carry on
 *  - running with no sign of life for a long time: interrupt and "continue", a few times at most
 * Each of those is logged, shown in the chat, and told to the conductor for its summary.
 *
 * When the time is up, or you say you are back, all of it switches off, whatever state the
 * conductor is in, and the conductor is asked for its summary of the time away.
 *
 * The state is kept in ~/.laika/away-<port>.json beside the open-chat registry, so a host that
 * restarts mid-afternoon carries on (or finishes, if the time ran out while it was down).
 * Nothing here touches the SDK: the host passes in what it needs, so tests can drive it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ensurePolicyFile, explainRefusal, inputSummary, loadPolicy, logAway } from './away-policy.mjs'
import { ROLE } from './conductor.mjs'

export const DEFAULT_GOAL = 'Keep every open chat moving on its current task'
export const MAX_MINUTES = 24 * 60
const TICK_MS = 30_000
/** how long a summary may wait for a busy conductor before the host gives up on it */
const SUMMARY_WAIT_MS = 20 * 60_000
/** as Claude Code words a usage limit (the same test the page uses) */
export const LIMIT_RE = /\b(session|usage|weekly|opus|sonnet)? ?limit\b.*\breset|hit your .*limit/i
const TIME_UP = '[autopilot] Time is up'

const clip = (t, n) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/**
 * When a usage limit resets, from Claude Code's message: "…|1726502400", "resets 3pm",
 * "resets at 15:30". The next such time after `now`, a minute late to be safe; null if unsaid.
 */
export function parseReset(text, now = Date.now()) {
  const t = String(text ?? '')
  const epoch = /\|(\d{10})\b/.exec(t)
  if (epoch) return Number(epoch[1]) * 1000 + 60_000
  const m = /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(t)
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2] ?? 0)
  const ap = m[3]?.toLowerCase()
  if (ap) {
    if (h < 1 || h > 12) return null
    h = (h % 12) + (ap === 'pm' ? 12 : 0)
  } else if (h > 23 || !m[2]) return null
  if (min > 59) return null
  const d = new Date(now)
  d.setHours(h, min, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime() + 60_000
}

/** the last turn boundary in a chat: your message, or how a turn ended */
const lastTurn = (x) => {
  for (let i = x.events.length - 1; i >= 0; i--) {
    const e = x.events[i]
    if (e.t === 'user' || e.t === 'result') return e
  }
  return null
}

/**
 * @param {object} o
 * @param {Map<string, any>} o.sessions  the host's open chats
 * @param {object} o.fleet               watchFleet's handle (setAutopilot, awayNote)
 * @param {string} o.file                where the state is kept
 * @param {object} o.deps                the host's own actions:
 *   startConductor({ goal, cwd }) → Promise<Session>
 *   revive(s)                          bring back a chat whose Claude Code could not restart, and continue
 *   interrupt(s) → Promise             stop the turn in progress
 *   carryOn(s)                         resend or continue after a limit
 *   accounts() → account[]             every account, with loggedIn
 *   switchAccount(s, account) → Promise   move a chat and carry on there
 *   saved()                            the registry should be written
 *   ended(view)                        away mode has just ended (the summary routine writes its page)
 */
export function createAway({ sessions, fleet, file, deps = {}, policy = () => loadPolicy(), log = logAway }) {
  const blank = () => ({ on: false, until: null, startedAt: null, endedAt: null, reason: null, goal: '', conductorId: null, policy: 'safe', counts: { approved: 0, asked: 0, recovered: 0 }, recent: [], summary: null, summaryFor: null, budget: null, spend: { chats: {}, dollars: 0 }, budgetHit: null })
  let state = blank()
  /** chat id → what recovery has done for it this time away */
  const rec = new Map()
  /** account id → when its usage limit resets */
  const limited = new Map()
  let endTimer = null
  let saveTimer = null

  const save = (soon = false) => {
    clearTimeout(saveTimer)
    const write = () => {
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
        writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1), { mode: 0o600 })
        renameSync(`${file}.tmp`, file)
      } catch {}
    }
    if (soon) {
      saveTimer = setTimeout(write, 1000)
      saveTimer.unref?.()
    } else write()
  }

  const arm = () => {
    clearTimeout(endTimer)
    endTimer = null
    if (!state.on || !state.until) return
    endTimer = setTimeout(() => stop('expired'), Math.max(0, state.until - Date.now()))
    endTimer.unref?.()
  }

  const conductor = () => (state.conductorId ? sessions.get(state.conductorId) : null)
  const live = (x) => x && x.state !== 'closed'

  /** what the page and the conductor see */
  const view = () => ({
    on: state.on,
    until: state.until,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    reason: state.reason,
    goal: state.goal,
    policy: state.policy,
    conductorId: state.conductorId,
    counts: { ...state.counts },
    recent: state.recent.slice(-30),
    summary: state.summary,
    left: state.on && state.until ? Math.max(0, state.until - Date.now()) : 0,
    budget: state.budget,
    spent: { dollars: Math.round(spent() * 100) / 100, spawns: spawnsUsed() },
    budgetHit: state.budgetHit,
  })

  /** something away mode did: kept for the summary, shown in the chat, told to the conductor */
  const record = (x, action, text, { count = true } = {}) => {
    if (count) state.counts.recovered++
    const line = `${x.id.slice(0, 8)} (${x.repo}): ${text}`
    state.recent.push({ at: Date.now(), kind: 'recovery', chat: x.id, action, text: line })
    if (state.recent.length > 200) state.recent.splice(0, state.recent.length - 200)
    log({ kind: 'recovery', action, chat: x.id, repo: x.repo, reason: text })
    x.emit({ t: 'away', kind: 'recovery', action, text })
    if (x.role !== ROLE) fleet.awayNote?.(line)
    save(true)
  }

  /** a conductor opened a chat (fleet_spawn): logged and kept for the summary, away or not */
  const spawned = (c, x, prompt) => {
    state.counts.spawned = (state.counts.spawned ?? 0) + 1
    const text = `${x.id.slice(0, 8)} (${x.repo}): opened by the conductor ${c.id.slice(0, 8)} on ${x.account?.label ?? 'its account'}: ${clip(prompt, 200)}`
    state.recent.push({ at: Date.now(), kind: 'spawn', chat: x.id, text })
    if (state.recent.length > 200) state.recent.splice(0, state.recent.length - 200)
    log({ kind: 'spawn', chat: x.id, repo: x.repo, conductor: c.id, account: x.account?.id, input: clip(prompt, 400) })
    save(true)
  }

  /** a conductor closed a chat it opened (fleet_close): logged and kept for the summary, away or not */
  const closed = (c, x, { reason = '', force = false } = {}) => {
    tally(x)
    state.counts.closed = (state.counts.closed ?? 0) + 1
    const text = `${x.id.slice(0, 8)} (${x.repo}): closed by the conductor ${c.id.slice(0, 8)}${force ? ' (forced)' : ''}${reason ? `: ${clip(reason, 200)}` : ''}`
    state.recent.push({ at: Date.now(), kind: 'close', chat: x.id, text })
    if (state.recent.length > 200) state.recent.splice(0, state.recent.length - 200)
    log({ kind: 'close', chat: x.id, repo: x.repo, conductor: c.id, force, reason: clip(reason, 400) })
    save(true)
  }

  /** a conductor parked a chat (fleet_park): closed but resumable; logged and kept for the summary, away or not */
  const parked = (c, x, { reason = '' } = {}) => {
    tally(x)
    state.counts.parked = (state.counts.parked ?? 0) + 1
    const text = `${x.id.slice(0, 8)} (${x.repo}): parked by the conductor ${c.id.slice(0, 8)}, resumable${reason ? `: ${clip(reason, 200)}` : ''}`
    state.recent.push({ at: Date.now(), kind: 'park', chat: x.id, text })
    if (state.recent.length > 200) state.recent.splice(0, state.recent.length - 200)
    log({ kind: 'park', chat: x.id, repo: x.repo, conductor: c.id, reason: clip(reason, 400) })
    save(true)
  }

  /** a parked chat was resumed: by a conductor (fleet_unpark), or by you (c is null) */
  const unparked = (c, x) => {
    state.counts.unparked = (state.counts.unparked ?? 0) + 1
    const text = `${x.id.slice(0, 8)} (${x.repo}): resumed from parked by ${c ? `the conductor ${c.id.slice(0, 8)}` : 'the user'}`
    state.recent.push({ at: Date.now(), kind: 'unpark', chat: x.id, by: c ? 'conductor' : 'user', text })
    if (state.recent.length > 200) state.recent.splice(0, state.recent.length - 200)
    log({ kind: 'unpark', chat: x.id, repo: x.repo, conductor: c?.id ?? null })
    save(true)
  }

  // ------------------------------------------------------------ budget
  /**
   * What the chats have spent since away mode started. A chat's cost is its Claude Code process's
   * running total, which starts again at 0 when that process restarts: so each chat's spend is
   * added up from what it grew by each time it was looked at, and a closed chat's spend stays.
   */
  function tally(x) {
    if (!state.on || x.account?.demo) return
    const k = state.spend.chats[x.id] ?? (state.spend.chats[x.id] = { last: 0, spent: 0 })
    const cost = Number(x.cost) || 0
    const grew = cost >= k.last ? cost - k.last : cost
    k.last = cost
    if (grew > 0) {
      k.spent += grew
      state.spend.dollars += grew
      // kept on disk too: a host restart must not forget money already spent
      save(true)
    }
  }
  const spent = () => {
    if (state.on) for (const x of sessions.values()) if (live(x)) tally(x)
    return state.spend.dollars
  }
  /** conductor spawns and unparks since away mode started */
  const spawnsUsed = () => (state.counts.spawned ?? 0) + (state.recent.filter((r) => r.kind === 'unpark' && r.by === 'conductor' && r.at >= (state.startedAt ?? 0)).length)

  /**
   * Whether the away budget stops a conductor from `kind`: 'send' (fleet_send) or 'spawn'
   * (fleet_spawn, fleet_unpark). Null when it may. The first time a limit is reached, the
   * conductor is told once and the summary says so.
   */
  function budgetRefusal(kind = 'send') {
    const b = state.budget
    if (!state.on || !b) return null
    const dollars = spent()
    const money = b.dollars != null && dollars >= b.dollars
    const spawns = b.spawns != null && spawnsUsed() >= b.spawns
    if (money) reached('dollars', `$${dollars.toFixed(2)} spent of the $${b.dollars} away budget`)
    if (money) return `The away budget is spent ($${dollars.toFixed(2)} of $${b.dollars}): no more sending to chats or opening them until the user is back. Approvals and recoveries carry on; list what is left for the user.`
    if (kind === 'spawn' && spawns) {
      reached('spawns', `${b.spawns} chat${b.spawns === 1 ? '' : 's'} opened, the away budget's limit`)
      return `The away budget allows ${b.spawns} opened chat${b.spawns === 1 ? '' : 's'} and ${b.spawns === 1 ? 'it is' : 'they are'} used: send the work to an open chat, or leave it for the user.`
    }
    return null
  }
  /** a budget limit reached for the first time: said once, to the conductor and in the summary */
  const reached = (key, what) => {
    const hit = state.budgetHit ?? {}
    if (hit[key]) return
    state.budgetHit = { ...hit, at: hit.at ?? Date.now(), [key]: true, what: hit.what ? `${hit.what}; ${what}` : what }
    const line = `Budget reached: ${what}. ${key === 'dollars' ? 'Sends, spawns and unparks' : 'Spawns and unparks'} are refused from now on.`
    state.recent.push({ at: Date.now(), kind: 'budget', text: line })
    log({ kind: 'budget', reason: what })
    fleet.awayNote?.(line)
    save(true)
  }
  /** a budget as the page sends it: { dollars?, spawns? }; null for none */
  const budgetOf = (b) => {
    if (b == null) return null
    const out = {}
    if (b.dollars != null && b.dollars !== '') {
      const d = Number(b.dollars)
      if (!Number.isFinite(d) || d <= 0) throw new Error('The away budget in dollars must be more than 0')
      out.dollars = Math.round(d * 100) / 100
    }
    if (b.spawns != null && b.spawns !== '') {
      const n = Number(b.spawns)
      if (!Number.isInteger(n) || n < 0) throw new Error('The away budget in opened chats must be a whole number, 0 or more')
      out.spawns = n
    }
    return Object.keys(out).length ? out : null
  }

  // ------------------------------------------------------------ approvals
  /**
   * A permission prompt while away: approved here if the policy says so, otherwise left for you
   * (and logged, so the conductor and the log say what is waiting). Null when away mode is off.
   */
  function consider(s, toolName, input) {
    if (!state.on || toolName === 'AskUserQuestion') return null
    if (state.until && Date.now() >= state.until) return null
    const d = explainRefusal(toolName, input, s, policy())
    const summary = inputSummary(toolName, input)
    const kind = d.allow ? 'approved' : 'asked'
    state.counts[kind]++
    // what you are asked, said plainly, with the allowlist entry that would have let it through
    const why = d.allow ? {} : { plain: d.plain, allowPattern: d.allowPattern, removedDefault: d.removedDefault ?? null }
    log({ kind, chat: s.id, repo: s.repo, tool: toolName, input: summary, reason: d.reason, ...why })
    s.emit({ t: 'away', kind, tool: toolName, input: summary, reason: d.reason, ...why })
    if (!d.allow) {
      state.recent.push({ at: Date.now(), kind: 'asked', chat: s.id, text: `${s.id.slice(0, 8)} (${s.repo}): ${toolName} ${summary} waits for the user (${d.reason})` })
      if (s.role !== ROLE) fleet.awayNote?.(`${s.id.slice(0, 8)} (${s.repo}) needs the user's permission for ${toolName}: ${summary}`)
    }
    save(true)
    return d
  }

  // ------------------------------------------------------------ on and off
  async function start({ minutes, goal, cwd, budget } = {}) {
    const m = Math.round(Number(minutes))
    if (!Number.isFinite(m) || m < 1 || m > MAX_MINUTES) throw new Error(`Away time must be between 1 minute and ${MAX_MINUTES / 60} hours`)
    const limit = budgetOf(budget)
    const wanted = typeof goal === 'string' ? goal.trim().slice(0, 2000) : ''
    ensurePolicyFile()
    // the conductor you already have: a real one before a demo, the one on autopilot, the latest
    const leads = [...sessions.values()]
      .filter((x) => x.role === ROLE && live(x))
      .sort(
        (a, b) =>
          Number(!!a.account?.demo) - Number(!!b.account?.demo) ||
          Number(!!b.autopilot) - Number(!!a.autopilot) ||
          b.updatedAt - a.updatedAt,
      )
    let c = leads[0]
    if (!c) {
      if (!deps.startConductor) throw new Error('No conductor chat, and none can be started')
      c = await deps.startConductor({ goal: wanted || DEFAULT_GOAL, cwd })
    }
    if (wanted) c.goal = wanted
    else if (!c.goal) c.goal = DEFAULT_GOAL
    const again = state.on
    const now = Date.now()
    if (!again) rec.clear()
    state = {
      ...(again ? state : blank()),
      on: true,
      startedAt: again ? state.startedAt : now,
      until: now + m * 60_000,
      endedAt: null,
      reason: null,
      goal: c.goal,
      conductorId: c.id,
      policy: 'safe',
      summary: null,
      summaryFor: null,
      // extending keeps the budget unless a new one is given; the spend counts from the first start
      budget: again && budget === undefined ? state.budget : limit,
    }
    if (!again) {
      // the chats' spend so far is not this time away's
      for (const x of sessions.values()) if (live(x) && !x.account?.demo) state.spend.chats[x.id] = { last: Number(x.cost) || 0, spent: 0 }
    } else if (budget !== undefined) state.budgetHit = null
    save()
    arm()
    fleet.setAutopilot(c, true, { minutes: m })
    log({ kind: 'away', action: again ? 'extended' : 'start', chat: c.id, reason: `${m} minutes: ${c.goal}` })
    deps.saved?.()
    return view()
  }

  /** end away mode: 'back' (you said so) or 'expired' (time ran out) */
  function stop(reason = 'back') {
    if (!state.on) return view()
    clearTimeout(endTimer)
    endTimer = null
    const now = Date.now()
    // the spend up to the moment it ends
    spent()
    state.on = false
    state.endedAt = now
    state.reason = reason
    const mins = Math.max(1, Math.round((now - (state.startedAt ?? now)) / 60_000))
    const took = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`
    const k = state.counts
    // parked chats still parked: resumable from the away bar, or GET /parked
    const stillParked = state.recent.filter((r) => r.kind === 'park' && !state.recent.some((u) => u.kind === 'unpark' && u.chat === r.chat && u.at >= r.at)).length
    state.summary = `Away ${took}: ${k.approved} auto-approved, ${k.asked} left for you, ${k.recovered} recover${k.recovered === 1 ? 'y' : 'ies'}.${stillParked ? ` ${stillParked} chat${stillParked === 1 ? '' : 's'} parked: resume ${stillParked === 1 ? 'it' : 'them'} when you want.` : ''}${state.budgetHit ? ` Budget reached: ${state.budgetHit.what}.` : ''}`
    log({ kind: 'away', action: 'end', reason, chat: state.conductorId, input: state.summary })
    const c = conductor()
    // the conductor may have crashed or gone: away mode ends all the same
    try {
      if (live(c) && c.autopilot) fleet.setAutopilot(c, false, { note: reason === 'expired' ? 'Away time is up: autopilot is off' : 'You are back: autopilot is off' })
    } catch {}
    state.summaryFor = live(c) ? c.id : null
    save()
    askSummary()
    deps.saved?.()
    try {
      deps.ended?.(view())
    } catch {}
    return view()
  }

  /** the conductor's summary of the time away, once it is free to write it */
  function askSummary() {
    const c = state.summaryFor ? sessions.get(state.summaryFor) : null
    if (!live(c)) {
      state.summaryFor = null
      return
    }
    // asked already (the conductor's own timer may have got there first)
    const asked = c.events.some((e) => e.t === 'user' && e.auto && e.at >= state.startedAt && String(e.text ?? '').startsWith(TIME_UP))
    if (asked) {
      state.summaryFor = null
      save(true)
      return
    }
    if (c.state === 'idle') {
      c.send(
        `${TIME_UP}: the user ${state.reason === 'expired' ? 'is due back' : 'is back'}. Write them the summary of the time away. Away mode: ${state.summary} Call fleet_list for what was auto-approved, what waits for them and every recovery.`,
        [],
        { auto: true },
      )
      state.summaryFor = null
    } else if (c.state === 'error' || Date.now() - (state.endedAt ?? 0) > SUMMARY_WAIT_MS) {
      c.emit({ t: 'note', text: `${state.summary} The conductor could not write its summary: see the away log.` })
      state.summaryFor = null
    }
    save(true)
  }

  // ------------------------------------------------------------ recovery
  const recOf = (x) => {
    let r = rec.get(x.id)
    if (!r) rec.set(x.id, (r = { attempts: 0, nextAt: 0, failSeq: null, nudges: 0, limitSeq: null, limitUntil: 0, gaveUp: false, stallGaveUp: false }))
    return r
  }
  const nudge = (x) => (x.role === ROLE ? '[autopilot] You stopped part-way while the user is away. Check in on the fleet and carry on.' : 'continue')
  const say = (x, text) => x.send(text, [], { auto: true })

  /** a failure to come back from: wait, longer each time, then act; after the last wait, leave it for the user */
  function backoff(x, r, p, what, act) {
    const steps = p.recovery.backoffMinutes
    if (r.gaveUp) return
    if (!r.nextAt) {
      if (r.attempts >= steps.length) {
        r.gaveUp = true
        record(x, 'gave-up', `${what}; tried ${r.attempts} time${r.attempts === 1 ? '' : 's'}, now it waits for the user`, { count: false })
        return
      }
      const wait = steps[r.attempts] * 60_000
      r.nextAt = Date.now() + wait
      record(x, 'waiting', `${what}; trying again in ${Math.round(wait / 60_000)}m`, { count: false })
      return
    }
    if (Date.now() < r.nextAt) return
    r.nextAt = 0
    r.attempts++
    record(x, 'retry', `${what}; attempt ${r.attempts}: ${act.label}`)
    act.run()
  }

  function limit(x, r, p, e) {
    if (r.limitSeq !== e.seq) {
      r.limitSeq = e.seq
      const resetAt = parseReset(e.error) ?? Date.now() + 30 * 60_000
      limited.set(x.account?.id, resetAt)
      const other = p.recovery.switchAccounts
        ? (deps.accounts?.() ?? []).find((a) => !a.demo && a.loggedIn && a.id !== x.account?.id && !((limited.get(a.id) ?? 0) > Date.now()))
        : null
      if (other && deps.switchAccount) {
        record(x, 'switch-account', `hit a usage limit on ${x.account?.label ?? 'its account'}; moving to ${other.label} to carry on`)
        Promise.resolve(deps.switchAccount(x, other)).catch((err) => {
          r.limitUntil = resetAt
          record(x, 'limit-wait', `could not move to ${other.label} (${clip(err?.message ?? err, 80)}); waiting for the reset at ${new Date(resetAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, { count: false })
        })
        return
      }
      r.limitUntil = resetAt
      record(x, 'limit-wait', `hit a usage limit; waiting for the reset at ${new Date(resetAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${p.recovery.switchAccounts ? ' (no other signed-in account is free)' : ''}`, { count: false })
      return
    }
    if (r.limitUntil && Date.now() >= r.limitUntil) {
      r.limitUntil = 0
      record(x, 'limit-continue', 'the usage limit has reset; carrying on')
      if (deps.carryOn) deps.carryOn(x)
      else say(x, nudge(x))
    }
  }

  async function recover() {
    const p = policy()
    const stallMs = p.recovery.stallMinutes * 60_000
    for (const x of [...sessions.values()]) {
      if (!live(x) || x.account?.demo || x.switchTo) continue
      const r = recOf(x)
      if (x.state === 'error') {
        backoff(x, r, p, 'Claude Code stopped and could not restart', { label: 'bringing it back', run: () => deps.revive?.(x) })
        continue
      }
      const e = lastTurn(x)
      if (x.state === 'idle' && e?.t === 'result' && e.error) {
        if (LIMIT_RE.test(String(e.error))) {
          limit(x, r, p, e)
          continue
        }
        if (r.failSeq !== e.seq) {
          // a new failure: a fresh wait, but the attempts so far still count
          r.failSeq = e.seq
          r.nextAt = 0
        }
        backoff(x, r, p, `its turn failed (${clip(e.error, 80)})`, { label: 'sending "continue"', run: () => say(x, nudge(x)) })
        continue
      }
      if (x.state === 'running' && Date.now() - x.updatedAt > stallMs) {
        if (r.nudges >= p.recovery.maxNudges) {
          if (!r.stallGaveUp) {
            r.stallGaveUp = true
            record(x, 'stall-gave-up', `still silent after ${r.nudges} nudge${r.nudges === 1 ? '' : 's'}; left for the user`, { count: false })
          }
          continue
        }
        r.nudges++
        // nothing new for a while: counts as life again once the nudge goes in
        x.updatedAt = Date.now()
        record(x, 'nudge', `no sign of life for ${p.recovery.stallMinutes}m; interrupting and sending "continue" (${r.nudges} of ${p.recovery.maxNudges})`)
        try {
          await deps.interrupt?.(x)
        } catch {}
        if (live(x)) say(x, nudge(x))
      }
    }
  }

  let ticking = false
  async function tick() {
    if (ticking) return
    ticking = true
    try {
      if (state.on && state.until && Date.now() >= state.until) stop('expired')
      if (state.summaryFor) askSummary()
      // the money budget, looked at every tick: the conductor hears the moment it is spent
      if (state.on) budgetRefusal('send')
      if (state.on) await recover()
    } finally {
      ticking = false
    }
  }
  const beat = setInterval(() => tick().catch(() => {}), TICK_MS)
  beat.unref?.()

  /** after a host restart: pick up where it was, or finish if the time ran out meanwhile */
  function restore() {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      state = { ...blank(), ...saved, counts: { ...blank().counts, ...(saved.counts ?? {}) }, recent: Array.isArray(saved.recent) ? saved.recent : [] }
    } catch {
      return view()
    }
    if (state.on && state.until && Date.now() >= state.until) stop('expired')
    else arm()
    return view()
  }

  /** what fleet_list shows the conductor about the time away */
  const digest = () =>
    state.on || state.endedAt
      ? {
          on: state.on,
          since: state.startedAt ? new Date(state.startedAt).toISOString() : null,
          until: state.until ? new Date(state.until).toISOString() : null,
          autoApproved: state.counts.approved,
          leftForUser: state.recent.filter((x) => x.kind === 'asked').slice(-20).map((x) => x.text),
          recoveries: state.recent.filter((x) => x.kind === 'recovery').slice(-30).map((x) => x.text),
          spawned: state.recent.filter((x) => x.kind === 'spawn').slice(-20).map((x) => x.text),
          closed: state.recent.filter((x) => x.kind === 'close').slice(-20).map((x) => x.text),
          parked: state.recent.filter((x) => x.kind === 'park' || x.kind === 'unpark').slice(-20).map((x) => x.text),
          budget: state.budget ? { ...state.budget, spentDollars: Math.round(spent() * 100) / 100, spawnsUsed: spawnsUsed(), reached: state.budgetHit?.what ?? null } : null,
        }
      : null

  return {
    get: view,
    start,
    stop,
    consider,
    tick,
    restore,
    digest,
    spawned,
    closed,
    parked,
    unparked,
    budgetRefusal,
    /** for tests: what recovery holds for a chat */
    recoveryOf: (id) => rec.get(id) ?? null,
    close: () => {
      clearInterval(beat)
      clearTimeout(endTimer)
      clearTimeout(saveTimer)
    },
  }
}
