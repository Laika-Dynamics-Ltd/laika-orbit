/**
 * The summary routine: one page on what your chats did, every hour and when you come back.
 *
 * At the top of each hour, and when away mode ends (covering the whole time away), the host
 * writes a one-page summary of that window:
 *  - needs you, most urgent first: a question or permission prompt a chat is stopped on, a
 *    progress board that is blocked, stalled or orphaned, a chat that crashed or whose recovery
 *    gave up, a failed turn, a chat that ended its turn on a question
 *  - running, soonest first: chats mid-turn and their progress boards and background work, jobs,
 *    and chats paused on a usage limit or a retry with when they resume
 *  - finished: per chat, the prompts that ended in the window (named by the chat's brief), and
 *    the progress boards that finished
 *  - auto-approved and recovered: from the away log (away-policy.mjs)
 *
 * It keeps no store and makes no estimates of its own. It reads what the other parts already
 * keep, so the summary, the fleet board, the progress page and the chat never disagree:
 *  - runs (runs.mjs listBoards: state, pct, etaAt, endedAt, lanes)
 *  - the status line's background work (fleet-work.mjs: `work.bg[]` on each chat's summary)
 *  - chat briefs (chat-brief.mjs) for the words, so no model is called and an hourly page costs nothing
 *  - away mode's state and log (away.mjs, away-policy.mjs)
 *
 * Each summary is kept as JSON and Markdown in ~/.laika/summaries-<port>/ for three days, served
 * at GET /summary (the host) and /api/control/agent/summary (the app), and the latest is written as
 * the `summary` widget, the card on Orbit's rail. THE SHAPE (read by the card and the fleet board):
 *
 *   { id, kind: 'hourly'|'away'|'now', from, to, writtenAt, headline,
 *     away: { on, until, goal } | null,
 *     needs:    [{ rank, repo, title, what, since, chat, sdk, board }]      rank 0 is most urgent
 *     running:  [{ kind: 'chat'|'board'|'background'|'job'|'limit'|'retry', repo, title, what,
 *                  startedAt, pct, eta: { at, basis, typical, over } | null, tasks: [...], chat, sdk, board }]
 *     finished: [{ repo, title, tasks: [label], failed, now, at, chat, sdk, board }]
 *     auto:     { approved, left, recoveries, byChat: [{ repo, title, n, tools }], recovered: [{ at, repo, action, text }] },
 *     groups:   [{ key, label, kind: 'group'|'repo', rank, needs, running, finished, approved, recovered }] }
 *
 * Every row in needs, running, finished, auto.byChat and auto.recovered also carries `group`, the key
 * of its entry in `groups`: the chat's conductor-set group (fleet_rename) when it has one, else its
 * repo, which is also where a chat that has closed since lands (its group went with it). Groups come
 * most urgent first, then named groups before repos, then the busiest. The away page is laid out by
 * them: what needs you stays one list, the rest sits under a heading per project.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { LIMIT_RE } from './away.mjs'
import { promptKey } from './chat-brief.mjs'

const MIN = 60_000
const HOUR = 60 * MIN
/** summaries older than this are deleted */
const KEEP_MS = 3 * 24 * HOUR
/** a chat that ended on a question this long ago no longer counts as waiting on you */
const QUESTION_MS = 24 * HOUR
/** an away summary still shows on the card below the hourly ones for this long */
const RECAP_MS = 12 * HOUR

const clip = (t, n) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}
export const span = (ms) => {
  const m = Math.max(1, Math.round(ms / MIN))
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`
}
export const clock = (t) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
/** the next top of the hour after `t` */
export const nextHour = (t) => {
  const d = new Date(t)
  d.setMinutes(60, 0, 0)
  return d.getTime()
}

/** a chat's prompts as turns with when each started and ended; a replayed transcript has no result events */
export function turnsWithTimes(s) {
  const turns = []
  let t = null
  for (const e of s.events ?? []) {
    if (e.t === 'user' && !/^\[Request interrupted/.test(String(e.text ?? ''))) {
      if (t && t.endAt === null && t.lastAt) t.endAt = t.lastAt
      t = { prompt: String(e.text ?? ''), startAt: e.at, endAt: null, error: null, lastAt: 0, lastText: '' }
      turns.push(t)
      continue
    }
    if (!t || e.sub) continue
    if (e.t === 'text') t.lastText = String(e.text ?? '')
    if (e.t === 'result') {
      t.endAt = e.at
      t.error = e.error ?? null
    } else if (e.at && ['text', 'tool', 'tool_result'].includes(e.t)) t.lastAt = e.at
  }
  // the latest turn of a chat that is not working has ended, whether or not the transcript said so
  const last = turns.at(-1)
  if (last && last.endAt === null && last.lastAt && !['running', 'starting', 'waiting'].includes(s.state)) last.endAt = last.lastAt
  return turns
}

const nameOf = (s) => clip(s.brief?.goal || s.title || s.repo, 90)
const labelOf = (s, turn) => {
  const b = s.brief?.turns?.find((x) => x.p === promptKey(turn.prompt))
  return clip(b?.label || turn.prompt || '(image)', 70)
}
const who = (s) => ({ chat: s.id, sdk: s.sdkSessionId ?? null, board: null, repo: s.repo, title: nameOf(s) })
const base = (p) => String(p ?? '').replace(/\/+$/, '').split('/').pop() || ''

/** a chat's background work as the status line reports it (fleet-work.mjs); [] where that is not running */
function backgroundOf(s) {
  try {
    const bg = (typeof s.summary === 'function' ? s.summary()?.work?.bg : s.work?.bg) ?? []
    return Array.isArray(bg) ? bg : []
  } catch {
    return []
  }
}

/** an ETA as whoever made it gave it: `etaAt` is absolute; `typicalMs` and `basis` say what it rests on */
const etaOf = (etaAt, to, { basis = null, typical = null } = {}) => (etaAt ? { at: etaAt, basis, typical, over: etaAt < to } : null)
const latestEta = (etas) => etas.filter(Boolean).sort((a, b) => b.at - a.at)[0] ?? null

const taskOf = (t, to) => ({ label: clip(t.label, 80), pct: t.pct ?? null, startedAt: t.startedAt ?? null, eta: etaOf(t.etaAt, to, { basis: t.basis, typical: t.typicalMs }) })
const laneOf = (l, to) => ({ label: clip(l.name || l.id, 80), pct: l.pct ?? null, startedAt: l.startedAt ?? null, status: l.status, eta: etaOf(l.etaAt, to, { basis: l.etaDerived ? 'progress' : 'reported' }) })
const boardEta = (b, to) => etaOf(b.etaAt, to, { basis: b.etaDerived ? 'progress' : 'reported' })

/** "Bash pnpm test" → "pnpm test"; anything else by its tool name */
const toolWord = (r) => (r.tool === 'Bash' ? clip(String(r.input ?? '').split(/\s+/).slice(0, 2).join(' '), 30) : r.tool)

/**
 * Build one summary. Pure: everything it reads is passed in.
 *
 * @param {object} o
 * @param {Iterable<any>} o.sessions      the host's chats (agent-host Session, or the same shape)
 * @param {any[]} [o.boards]              runs (runs.mjs listBoards)
 * @param {any[]} [o.log]                 away log rows (away-policy.mjs readAwayLog)
 * @param {any[]} [o.jobs]                jobs.list()
 * @param {object|null} [o.away]          away.get()
 * @param {(id: string) => any} [o.recovery]  away.recoveryOf
 * @param {(id: string) => string|null|undefined} [o.groupOf]  a chat's group: null when it has none,
 *                                        undefined when the chat is gone; by default read from `sessions`
 * @param {number} o.from
 * @param {number} o.to
 * @param {'hourly'|'away'|'now'} o.kind
 */
export function buildSummary({ sessions, boards = [], log = [], jobs = [], away = null, recovery = () => null, groupOf = null, from, to, kind }) {
  const all = [...sessions]
  const chats = all.filter((s) => s.state !== 'closed')
  const needs = []
  const running = []
  const finished = []
  const bySdk = new Map(chats.filter((s) => s.sdkSessionId).map((s) => [s.sdkSessionId, s]))
  /** boards that belong to a chat on this host are shown on that chat's row */
  const boardsOf = new Map()
  const loose = []
  for (const b of boards) {
    const s = b.chat ? bySdk.get(b.chat) : null
    if (s) boardsOf.set(s.id, [...(boardsOf.get(s.id) ?? []), b])
    else loose.push(b)
  }

  for (const s of chats) {
    const turns = turnsWithTimes(s)
    const mine = boardsOf.get(s.id) ?? []
    const open = mine.filter((b) => !['done', 'failed', 'cancelled'].includes(b.state))
    // a board that waits on you is listed there, not also as running
    const going = open.filter((b) => b.state === 'running' || b.state === 'idle')

    // ---- finished in the window
    const done = turns.filter((x) => x.endAt && x.endAt > from && x.endAt <= to)
    const boardsDone = mine.filter((b) => b.endedAt > from && b.endedAt <= to)
    if (done.length || boardsDone.length) {
      const ok = done.filter((x) => !x.error)
      finished.push({
        ...who(s),
        tasks: [...ok.map((x) => labelOf(s, x)), ...boardsDone.filter((b) => b.state === 'done').map((b) => clip(b.title, 70))],
        failed: done.length - ok.length + boardsDone.filter((b) => b.state !== 'done').length,
        now: clip(s.brief?.now, 160),
        at: Math.max(0, ...done.map((x) => x.endAt), ...boardsDone.map((b) => b.endedAt)),
      })
    }

    // ---- stopped on you
    for (const b of open.filter((x) => ['blocked', 'stalled', 'orphaned'].includes(x.state))) needs.push(boardNeed(b, { ...who(s), board: b.id }))
    const r = recovery(s.id)
    const pend = [...(s.pending?.values?.() ?? [])]
    const since = (p) => p.event?.at ?? s.updatedAt
    for (const p of pend.filter((x) => x.kind === 'question')) {
      const q = p.event?.questions?.[0]
      needs.push({ ...who(s), rank: 0, what: `asks you: ${clip(q?.question ?? 'a question', 120)}`, since: since(p) })
    }
    for (const p of pend.filter((x) => x.kind === 'permission')) {
      const e = p.event ?? {}
      const path = String(e.input?.file_path ?? e.input?.path ?? e.input?.url ?? '')
      // a path inside the chat's own folder reads better without the folder
      const inside = s.cwd && path.startsWith(`${s.cwd}/`) ? path.slice(s.cwd.length + 1) : path
      const detail = e.tool === 'Bash' ? clip(e.input?.command, 90) : clip(inside, 90)
      needs.push({ ...who(s), rank: 1, what: `needs permission for ${e.tool ?? 'a tool'}${detail ? `: ${detail}` : ''}`, since: since(p) })
    }
    if (pend.length) continue

    const last = turns.at(-1)
    const bg = backgroundOf(s).filter((t) => s.state === 'running' || t.backgrounded !== false)
    const tasks = [...going.flatMap((b) => b.lanes.filter((l) => !['done', 'skipped'].includes(l.status)).map((l) => laneOf(l, to))), ...bg.map((t) => taskOf(t, to))]
    const eta = latestEta([...going.map((b) => boardEta(b, to)), ...bg.map((t) => etaOf(t.etaAt, to, { basis: t.basis, typical: t.typicalMs }))])
    const pct = going.length === 1 ? Math.round(going[0].pct) : null

    if (s.state === 'error') {
      if (!r || r.gaveUp || !away?.on) needs.push({ ...who(s), rank: 2, what: r?.gaveUp ? 'Claude Code stopped; away mode tried and gave up' : 'Claude Code stopped and could not restart', since: s.updatedAt })
      else running.push({ ...who(s), kind: 'retry', what: 'Claude Code stopped; away mode is bringing it back', startedAt: null, pct: null, eta: r.nextAt ? etaOf(r.nextAt, to, { basis: 'retry' }) : null, tasks: [] })
      continue
    }
    if (s.state === 'running' || s.state === 'starting') {
      if (r?.stallGaveUp) {
        needs.push({ ...who(s), rank: 2, what: `silent for a long time; ${r.nudges} nudge${r.nudges === 1 ? '' : 's'} did not wake it`, since: s.updatedAt })
        continue
      }
      running.push({ ...who(s), kind: 'chat', what: clip(last ? labelOf(s, last) : s.brief?.now, 120), startedAt: s.work?.start || last?.startAt || s.updatedAt, pct, eta, tasks })
      continue
    }
    // idle from here, though its board or background work may still be going
    if (tasks.length) {
      running.push({ ...who(s), kind: 'background', what: going.length ? clip(going[0].title, 120) : `${bg.length} background task${bg.length === 1 ? '' : 's'}`, startedAt: Math.min(...[...going.map((b) => b.createdAt), ...bg.map((t) => t.startedAt)].filter(Boolean)), pct, eta, tasks })
    }
    if (last?.error && LIMIT_RE.test(String(last.error))) {
      if (r?.limitUntil) running.push({ ...who(s), kind: 'limit', what: 'paused on a usage limit', startedAt: null, pct: null, eta: etaOf(r.limitUntil, to, { basis: 'limit reset' }), tasks: [] })
      else needs.push({ ...who(s), rank: 3, what: `stopped on a usage limit: ${clip(last.error, 90)}`, since: last.endAt ?? s.updatedAt })
      continue
    }
    if (last?.error) {
      if (away?.on && r && !r.gaveUp && r.nextAt) running.push({ ...who(s), kind: 'retry', what: 'turn failed; away mode retries it', startedAt: null, pct: null, eta: etaOf(r.nextAt, to, { basis: 'retry' }), tasks: [] })
      else needs.push({ ...who(s), rank: 3, what: `last turn failed: ${clip(last.error, 100)}`, since: last.endAt ?? s.updatedAt })
      continue
    }
    const said = last?.lastText.trim() ?? ''
    if (!tasks.length && last?.endAt && to - last.endAt < QUESTION_MS && /\?\s*(\*\*)?\s*$/.test(said)) {
      const ask = said.split(/(?<=[.!?])\s+|\n+/).filter((x) => x.trim().endsWith('?')).at(-1) ?? said
      needs.push({ ...who(s), rank: 4, what: `ended on a question: ${clip(ask.replace(/^[#>*\-\s]+/, ''), 120)}`, since: last.endAt })
    }
  }

  // ---- boards whose chat is not one of this host's (a terminal Claude Code, another Mac)
  for (const b of loose) {
    const row = { chat: null, sdk: b.chat ?? null, board: b.id, repo: base(b.cwd) || 'progress', title: clip(b.title, 90) }
    if (b.endedAt > from && b.endedAt <= to) {
      finished.push({ ...row, tasks: b.state === 'done' ? [clip(b.note || 'done', 70)] : [], failed: b.state === 'done' ? 0 : 1, now: b.state === 'done' ? '' : clip(b.note, 160), at: b.endedAt })
    }
    if (['done', 'failed', 'cancelled'].includes(b.state)) continue
    if (['blocked', 'stalled', 'orphaned'].includes(b.state)) {
      needs.push(boardNeed(b, row))
      continue
    }
    const lanes = b.lanes.filter((l) => !['done', 'skipped'].includes(l.status))
    running.push({ ...row, kind: 'board', what: clip(b.note || `${lanes.length} lane${lanes.length === 1 ? '' : 's'} open`, 120), startedAt: b.createdAt, pct: Math.round(b.pct), eta: boardEta(b, to), tasks: lanes.map((l) => laneOf(l, to)) })
  }

  for (const j of jobs.filter((x) => x.state === 'running')) {
    running.push({
      chat: null,
      sdk: null,
      board: null,
      repo: base(j.dir),
      title: clip(j.unity ? `Unity ${j.unity}${j.args?.length ? ` ${j.args.join(' ')}` : ''}` : [j.cmd, ...(j.args ?? [])].join(' '), 90),
      kind: 'job',
      what: 'job',
      startedAt: j.startedAt,
      pct: null,
      eta: null,
      tasks: [],
    })
  }

  running.sort((a, b) => (a.eta?.at ?? Number.POSITIVE_INFINITY) - (b.eta?.at ?? Number.POSITIVE_INFINITY))
  needs.sort((a, b) => a.rank - b.rank || a.since - b.since)
  finished.sort((a, b) => b.tasks.length + b.failed - (a.tasks.length + a.failed) || b.at - a.at)

  // ---- the away log
  const rows = log.filter((x) => {
    const t = Date.parse(x.at)
    return t > from && t <= to
  })
  const approvedRows = rows.filter((x) => x.kind === 'approved')
  const groups = new Map()
  for (const x of approvedRows) {
    const g = groups.get(x.chat) ?? { chat: x.chat, repo: x.repo, n: 0, tools: new Map() }
    g.n++
    const w = toolWord(x)
    g.tools.set(w, (g.tools.get(w) ?? 0) + 1)
    groups.set(x.chat, g)
  }
  const byId = new Map(chats.map((s) => [s.id, s]))
  const COUNTED = new Set(['retry', 'nudge', 'switch-account', 'limit-continue'])
  const recovered = rows
    .filter((x) => x.kind === 'recovery' && x.action !== 'waiting')
    .map((x) => ({ at: Date.parse(x.at), chat: x.chat, repo: x.repo, action: x.action, done: COUNTED.has(x.action), text: clip(x.reason, 160) }))
  const auto = {
    approved: approvedRows.length,
    left: rows.filter((x) => x.kind === 'asked').length,
    recoveries: recovered.filter((x) => x.done).length,
    byChat: [...groups.values()]
      .sort((a, b) => b.n - a.n)
      .map((g) => ({
        chat: g.chat,
        sdk: byId.get(g.chat)?.sdkSessionId ?? null,
        repo: g.repo,
        title: byId.has(g.chat) ? nameOf(byId.get(g.chat)) : g.repo,
        n: g.n,
        tools: [...g.tools].sort((a, b) => b[1] - a[1]).map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(', '),
      })),
    recovered,
  }

  // ---- by project: the chat's group, else its repo
  const known = new Map(all.map((s) => [s.id, typeof s.group === 'string' ? s.group.trim() || null : null]))
  const groupOfChat = groupOf ?? ((id) => known.get(id))
  const projects = new Map()
  const place = (row, field, n = 1) => {
    const g = row.chat ? groupOfChat(row.chat) : undefined
    const named = typeof g === 'string' && g.trim() ? g.trim() : null
    const key = named ? `group:${named}` : `repo:${row.repo || 'other'}`
    const entry = projects.get(key) ?? { key, label: named ?? (row.repo || 'Other'), kind: named ? 'group' : 'repo', rank: null, needs: 0, running: 0, finished: 0, approved: 0, recovered: 0 }
    entry[field] += n
    if (field === 'needs' && (entry.rank === null || row.rank < entry.rank)) entry.rank = row.rank
    projects.set(key, entry)
    row.group = key
  }
  for (const r of needs) place(r, 'needs')
  for (const r of running) place(r, 'running')
  for (const r of finished) place(r, 'finished')
  for (const r of auto.byChat) place(r, 'approved', r.n)
  for (const r of auto.recovered) place(r, 'recovered')
  const busy = (g) => g.needs + g.running + g.finished + g.approved + g.recovered

  const summary = {
    id: `${new Date(to).toISOString().replace(/[:.]/g, '-')}-${kind}`,
    kind,
    from,
    to,
    writtenAt: to,
    away: away?.on ? { on: true, until: away.until, goal: away.goal } : null,
    needs,
    running,
    finished,
    auto,
    groups: [...projects.values()].sort(
      (a, b) => (a.rank ?? 9) - (b.rank ?? 9) || (a.kind === b.kind ? 0 : a.kind === 'group' ? -1 : 1) || busy(b) - busy(a) || a.label.localeCompare(b.label),
    ),
  }
  summary.headline = headline(summary)
  return summary
}

/** a board that waits on a person, went quiet, or lost its chat */
function boardNeed(b, row) {
  const lane = b.lanes.find((l) => l.status === 'blocked' || l.stalled)
  const where = lane ? ` (${clip(lane.name || lane.id, 40)}${lane.note ? `: ${clip(lane.note, 80)}` : ''})` : ''
  if (b.state === 'blocked') return { ...row, board: b.id, rank: 1, what: `progress board "${clip(b.title, 60)}" is blocked on you${where}`, since: lane?.updatedAt ?? b.updatedAt }
  if (b.state === 'orphaned') return { ...row, board: b.id, rank: 2, what: `progress board "${clip(b.title, 60)}" lost its chat before finishing`, since: b.updatedAt }
  return { ...row, board: b.id, rank: 2, what: `progress board "${clip(b.title, 60)}" has gone quiet for ${span(b.quietMs)}${where}`, since: b.updatedAt }
}

export function headline(x) {
  const parts = []
  if (x.needs.length) parts.push(`${x.needs.length} need${x.needs.length === 1 ? 's' : ''} you`)
  if (x.running.length) {
    const next = x.running.find((r) => r.eta && !r.eta.over)
    parts.push(`${x.running.length} running${next ? `, next done ~${clock(next.eta.at)}` : ''}`)
  }
  const tasks = x.finished.reduce((n, f) => n + f.tasks.length, 0)
  if (tasks) parts.push(`${tasks} finished in ${x.finished.length} chat${x.finished.length === 1 ? '' : 's'}`)
  if (x.auto.approved) parts.push(`${x.auto.approved} auto-approved`)
  if (x.auto.recoveries) parts.push(`${x.auto.recoveries} recovered`)
  return parts.length ? parts.join(' · ') : 'Quiet: nothing finished, running or waiting on you'
}

export const titleOf = (x) =>
  x.kind === 'away' ? `While you were away · ${clock(x.from)}–${clock(x.to)} (${span(x.to - x.from)})` : `${x.kind === 'hourly' ? 'Hourly summary' : 'Summary'} · ${clock(x.from)}–${clock(x.to)}`

const BASIS = { progress: 'from its progress', history: 'from earlier runs', reported: 'as reported', retry: 'next retry', 'limit reset': 'when the limit resets' }
/** an ETA in words, as of `to`: the status line's wording (fleet-work.mjs etaText) */
export function etaText(e, to) {
  if (!e) return null
  if (e.over) return e.typical ? `overdue (usually ${span(e.typical)})` : `due ${clock(e.at)}, overdue`
  const why = BASIS[e.basis] ?? e.basis
  return `~${span(e.at - to)} left, by ${clock(e.at)}${why ? ` (${why})` : ''}`
}

const named = (r) => (r.title && r.title !== r.repo ? `${r.repo} · ${r.title}` : r.repo)

function runningLines(x, r) {
  const eta = etaText(r.eta, x.to)
  const bits = [r.pct !== null && r.pct !== undefined ? `${r.pct}%` : '', r.startedAt ? `${span(x.to - r.startedAt)} in` : '', eta ?? ''].filter(Boolean)
  const L = [`- **${named(r)}** ${r.what}${bits.length ? ` · ${bits.join(' · ')}` : ''}`]
  for (const t of r.tasks ?? []) {
    const te = etaText(t.eta, x.to)
    L.push(`  - ${t.label}${t.pct !== null && t.pct !== undefined ? ` · ${Math.round(t.pct)}%` : ''}${te ? ` · ${te}` : ''}`)
  }
  return L
}
function finishedLines(f) {
  const L = [`- **${named(f)}**${f.failed ? ` (${f.failed} failed)` : ''}`]
  for (const t of f.tasks) L.push(`  - ${t}`)
  if (f.now) L.push(`  - _Now:_ ${f.now}`)
  return L
}

/** the time away by project: a heading per group (or repo), its chats' running, finished, approved and recovered lines under it */
function byProjectMarkdown(x, L) {
  const byKey = new Map(x.groups.map((g) => [g.key, g]))
  // the repo is already in the line; a named group is added beside it
  const pinned = (n) => (byKey.get(n.group)?.kind === 'group' ? ` _(${byKey.get(n.group).label})_` : '')
  L.push('## Needs you', '')
  if (!x.needs.length) L.push('Nothing is waiting on you.', '')
  else {
    x.needs.forEach((n, i) => L.push(`${i + 1}. **${named(n)}**${pinned(n)} ${n.what} _(${span(x.to - n.since)})_`))
    L.push('')
  }
  if (x.auto.approved) L.push(`${x.auto.approved} permission prompt${x.auto.approved === 1 ? '' : 's'} approved by the away policy${x.auto.left ? `; ${x.auto.left} left for you` : ''}.`, '')
  const shown = x.groups.filter((g) => g.running + g.finished + g.approved + g.recovered)
  if (!shown.length) L.push('Nothing ran, finished, was approved or recovered while you were away.', '')
  for (const g of shown) {
    L.push(`## ${g.label}`, '')
    const mine = (rows) => rows.filter((r) => r.group === g.key)
    for (const r of mine(x.running)) L.push(...runningLines(x, r))
    for (const f of mine(x.finished)) L.push(...finishedLines(f))
    for (const a of mine(x.auto.byChat)) L.push(`- **${named(a)}** auto-approved ${a.n}: ${a.tools}`)
    for (const r of mine(x.auto.recovered)) L.push(`- ${clock(r.at)} **${r.repo}** ${r.text}`)
    L.push('')
  }
}

/** the one page, as Markdown */
export function renderMarkdown(x) {
  const L = [`# ${titleOf(x)}`, '', `**${x.headline}**`, '']
  if (x.away) L.push(`Away mode is on until ${clock(x.away.until)}: ${x.away.goal}`, '')
  if (x.kind === 'away' && Array.isArray(x.groups)) {
    byProjectMarkdown(x, L)
    L.push(`_Written ${new Date(x.writtenAt).toLocaleString()} from this Mac's chats, progress boards and away log._`)
    return L.join('\n')
  }
  L.push('## Needs you', '')
  if (!x.needs.length) L.push('Nothing is waiting on you.', '')
  else {
    x.needs.forEach((n, i) => L.push(`${i + 1}. **${named(n)}** ${n.what} _(${span(x.to - n.since)})_`))
    L.push('')
  }
  L.push('## Running', '')
  if (!x.running.length) L.push('Nothing is running.', '')
  else {
    for (const r of x.running) L.push(...runningLines(x, r))
    L.push('')
  }
  L.push('## Finished', '')
  if (!x.finished.length) L.push('Nothing finished in this window.', '')
  else {
    for (const f of x.finished) L.push(...finishedLines(f))
    L.push('')
  }
  L.push('## Auto-approved and recovered', '')
  if (!x.auto.approved && !x.auto.recovered.length) L.push('Nothing was approved or recovered for you.', '')
  else {
    if (x.auto.approved) {
      L.push(`${x.auto.approved} permission prompt${x.auto.approved === 1 ? '' : 's'} approved by the away policy${x.auto.left ? `; ${x.auto.left} left for you` : ''}:`, '')
      for (const a of x.auto.byChat) L.push(`- **${named(a)}** ${a.n}: ${a.tools}`)
      L.push('')
    }
    if (x.auto.recovered.length) {
      L.push('Recovery:', '')
      for (const r of x.auto.recovered) L.push(`- ${clock(r.at)} **${r.repo}** ${r.text}`)
      L.push('')
    }
  }
  L.push(`_Written ${new Date(x.writtenAt).toLocaleString()} from this Mac's chats, progress boards and away log._`)
  return L.join('\n')
}

/** the card on Orbit's rail (brain/widgets/_CONTRACT.md, kind `summary`) */
export function toWidget(x, { nextAt = null, recap = null } = {}) {
  return {
    id: 'summary',
    kind: 'summary',
    title: 'Summary',
    icon: 'doc',
    source: 'summary routine',
    refreshedAt: new Date(x.writtenAt).toISOString(),
    rail: 'right',
    order: 0,
    actions: [{ label: 'now', action: 'summary-now' }],
    config: { staleAfterMins: 75, nextAt, summary: x, recap },
  }
}

/**
 * The routine: writes a summary at the top of each hour and when away mode ends.
 *
 * @param {object} o
 * @param {Map<string, any>} o.sessions
 * @param {object} [o.away]              createAway's handle
 * @param {object} [o.jobs]              createJobs's handle
 * @param {(since: number) => any[]} o.readLog
 * @param {() => Promise<any[]>|any[]} [o.boards]  progress boards
 * @param {string} o.dir                 where summaries are kept
 * @param {string|null} [o.widget]       the widget file to write, or null for none
 */
export function createSummaries({ sessions, away = null, jobs = null, readLog, boards = () => [], dir, widget = null }) {
  let timer = null
  let nextAt = nextHour(Date.now())

  const files = () => {
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
    } catch {
      return []
    }
  }
  const load = (f) => {
    try {
      return JSON.parse(readFileSync(join(dir, f), 'utf8'))
    } catch {
      return null
    }
  }
  const put = (file, text) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(`${file}.tmp`, text, { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }

  /** the latest away summary from the last 12 hours, other than `x` */
  const recentAway = (x) => {
    const f = files()
      .filter((n) => n.endsWith('-away.json') && n !== `${x.id}.json`)
      .at(-1)
    const a = f ? load(f) : null
    return a && x.to - a.to < RECAP_MS ? a : null
  }

  async function write({ kind, from, to = Date.now() }) {
    let bs = []
    try {
      bs = (await boards()) ?? []
    } catch {}
    const x = buildSummary({
      sessions: sessions.values(),
      boards: bs,
      log: readLog(from),
      jobs: jobs?.list?.() ?? [],
      away: away?.get?.() ?? null,
      recovery: (id) => away?.recoveryOf?.(id) ?? null,
      from,
      to,
      kind,
    })
    try {
      put(join(dir, `${x.id}.json`), JSON.stringify(x))
      put(join(dir, `${x.id}.md`), renderMarkdown(x))
      for (const f of readdirSync(dir)) {
        const m = /^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)/.exec(f)
        if (m && Date.now() - Date.parse(`${m[1]}:${m[2]}:${m[3]}Z`) > KEEP_MS) unlinkSync(join(dir, f))
      }
      if (widget) put(widget, JSON.stringify(toWidget(x, { nextAt, recap: x.kind === 'away' ? null : recentAway(x) }), null, 1))
    } catch (e) {
      console.log(`summary not written: ${e?.message ?? e}`)
    }
    return x
  }

  function schedule() {
    clearTimeout(timer)
    nextAt = nextHour(Date.now())
    // a second past the hour, so a timer that fires a touch early still lands in the new hour
    timer = setTimeout(() => {
      const to = Date.now()
      write({ kind: 'hourly', from: to - HOUR, to }).finally(schedule)
    }, nextAt - Date.now() + 1000)
    timer.unref?.()
  }

  return {
    /** start the hourly timer; a host with nothing from the last hour fills the card straight away */
    async start() {
      schedule()
      const last = files().at(-1)
      const x = last ? load(last) : null
      if (!x || Date.now() - x.to > HOUR) await write({ kind: 'now', from: Date.now() - HOUR })
    },
    /** away mode ended: the whole time away, on one page */
    awayEnded: (view) => (view?.startedAt ? write({ kind: 'away', from: view.startedAt, to: view.endedAt ?? Date.now() }) : Promise.resolve(null)),
    /** one written now, for the last hour */
    now: () => write({ kind: 'now', from: Date.now() - HOUR }),
    latest: () => {
      const f = files().at(-1)
      return f ? load(f) : null
    },
    list: () =>
      files()
        .reverse()
        .map((f) => f.replace(/\.json$/, '')),
    get: (id) => (/^[\w-]+$/.test(id) ? load(`${id}.json`) : null),
    markdown(id) {
      try {
        return /^[\w-]+$/.test(id) ? readFileSync(join(dir, `${id}.md`), 'utf8') : null
      } catch {
        return null
      }
    },
    nextAt: () => nextAt,
    close: () => clearTimeout(timer),
  }
}
