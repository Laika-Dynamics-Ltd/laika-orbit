/**
 * The summary card: the summary routine's latest page (packages/app/summary.mjs) as one card.
 *
 * Needs you comes first and in the host's order, most urgent at the top; then what is running
 * with its ETA, what finished, and what away mode approved or recovered. A row that belongs to a
 * chat opens it (data-sdk). Rendering is a pure function of the summary, so the rail widget and
 * the fleet board can both show it: `summaryBody(summary)` for the page, `summaryCompact(summary)`
 * for a folded card. An away page with `groups` is laid out by project: needs you stays one list,
 * each row tagged with its group, and the rest sits under a heading per group (or repo).
 */
import './summary-card.css'

type Eta = { at: number; basis: string | null; typical: number | null; over: boolean } | null
type Row = {
  chat: string | null
  sdk: string | null
  board: string | null
  repo: string
  title: string
  /** the key of its entry in Summary.groups; absent on summaries written before groups */
  group?: string
}
type Group = {
  key: string
  label: string
  kind: 'group' | 'repo'
  rank: number | null
  needs: number
  running: number
  finished: number
  approved: number
  recovered: number
}
export type Summary = {
  id: string
  kind: 'hourly' | 'away' | 'now'
  from: number
  to: number
  writtenAt: number
  headline: string
  away: { on: boolean; until: number; goal: string } | null
  needs: (Row & { rank: number; what: string; since: number })[]
  running: (Row & {
    kind: string
    what: string
    startedAt: number | null
    pct: number | null
    eta: Eta
    tasks?: { label: string; pct: number | null; eta: Eta }[]
  })[]
  finished: (Row & { tasks: string[]; failed: number; now: string; at: number })[]
  auto: {
    approved: number
    left: number
    recoveries: number
    byChat: {
      sdk: string | null
      repo: string
      title: string
      n: number
      tools: string
      group?: string
    }[]
    recovered: {
      at: number
      repo: string
      action: string
      done: boolean
      text: string
      group?: string
    }[]
  }
  groups?: Group[]
}

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[<>&"]/g,
    (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[m] as string,
  )
const clock = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
const span = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`
}
const BASIS: Record<string, string> = {
  progress: 'from its progress',
  history: 'from earlier runs',
  reported: 'as reported',
  retry: 'next retry',
  'limit reset': 'when the usage limit resets',
}

/** an ETA against the time now: the page was written earlier, and ETAs are absolute */
function etaText(e: Eta, now = Date.now()): { text: string; title: string; late: boolean } | null {
  if (!e) return null
  const why = e.basis ? (BASIS[e.basis] ?? e.basis) : ''
  if (e.at <= now) {
    return {
      text: e.typical ? `overdue` : `due ${clock(e.at)}`,
      title: `Due ${clock(e.at)}${e.typical ? `, usually takes ${span(e.typical)}` : ''}${why ? ` (${why})` : ''}`,
      late: true,
    }
  }
  return {
    text: `~${clock(e.at)}`,
    title: `${span(e.at - now)} left, by ${clock(e.at)}${why ? ` (${why})` : ''}`,
    late: false,
  }
}

/** the repo, and the chat's name when it says more than the repo does */
const name = (r: { repo: string; title: string }) =>
  `<b>${esc(r.repo)}</b>${r.title && r.title !== r.repo ? ` ${esc(r.title)}` : ''}`

/** the row opens its chat when there is one */
const open = (r: Row) =>
  r.sdk ? ` data-sdk="${esc(r.sdk)}" role="button" tabindex="0" title="Open this chat"` : ''

const URGENCY = ['now', 'now', 'soon', 'soon', 'later']

function needsHtml(x: Summary, byProject = false) {
  if (!x.needs.length) return '<div class="sm-clear">Nothing is waiting on you.</div>'
  const tag = (n: Row) => {
    const g = byProject ? x.groups?.find((y) => y.key === n.group) : undefined
    return g?.kind === 'group' ? `<span class="sm-tag">${esc(g.label)}</span>` : ''
  }
  return x.needs
    .map(
      (n) => `<div class="sm-row sm-need u-${URGENCY[n.rank] ?? 'later'}"${open(n)}>
        <i class="sm-dot"></i>
        <span class="sm-main">${name(n)}${tag(n)}<span class="sm-what">${esc(n.what)}</span></span>
        <em title="waiting since ${esc(clock(n.since))}">${esc(span(x.to - n.since))}</em></div>`,
    )
    .join('')
}

function runningHtml(x: Summary, rows = x.running) {
  return rows
    .map((r) => {
      const eta = etaText(r.eta)
      const tasks = (r.tasks ?? [])
        .slice(0, 4)
        .map((t) => {
          const te = etaText(t.eta)
          return `<span class="sm-task"><span>${esc(t.label)}</span>${t.pct !== null ? `<em>${Math.round(t.pct)}%</em>` : ''}${te ? `<em class="${te.late ? 'late' : ''}" title="${esc(te.title)}">${esc(te.text)}</em>` : ''}</span>`
        })
        .join('')
      const since = r.startedAt ? `${span(x.to - r.startedAt)} in` : ''
      return `<div class="sm-row sm-run"${open(r)}>
        <i class="sm-dot"></i>
        <span class="sm-main">${name(r)}<span class="sm-what">${esc(r.what)}${since ? ` · ${esc(since)}` : ''}</span>${tasks ? `<span class="sm-tasks">${tasks}</span>` : ''}
          ${r.pct !== null ? `<span class="sm-bar"><i style="width:${Math.max(2, Math.min(100, r.pct))}%"></i></span>` : ''}</span>
        <em class="sm-eta${eta?.late ? ' late' : ''}"${eta ? ` title="${esc(eta.title)}"` : ' title="No ETA: nothing has reported one"'}>${esc(eta?.text ?? '—')}</em></div>`
    })
    .join('')
}

function finishedHtml(x: Summary, rows = x.finished) {
  return rows
    .map(
      (f) => `<div class="sm-row sm-done"${open(f)}>
        <i class="sm-dot${f.failed ? ' bad' : ''}"></i>
        <span class="sm-main">${name(f)}<span class="sm-what">${esc(f.tasks.join(' · ') === f.title ? f.now : f.tasks.join(' · ') || f.now)}</span></span>
        <em>${f.tasks.length ? `${f.tasks.length}✓` : ''}${f.failed ? ` <span class="bad">${f.failed}✕</span>` : ''}</em></div>`,
    )
    .join('')
}

const autoRows = (rows: Summary['auto']['byChat']) =>
  rows
    .map(
      (c) =>
        `<div class="sm-row sm-auto"${open({ ...c, chat: null, board: null })}><i class="sm-dot"></i><span class="sm-main">${name(c)}<span class="sm-what">${esc(c.tools)}</span></span><em>${c.n}</em></div>`,
    )
    .join('')
const recoveredRows = (rows: Summary['auto']['recovered']) =>
  rows
    .map(
      (r) =>
        `<div class="sm-row sm-rec${r.done ? '' : ' gave'}"><i class="sm-dot"></i><span class="sm-main"><b>${esc(r.repo)}</b><span class="sm-what">${esc(r.text)}</span></span><em>${esc(clock(r.at))}</em></div>`,
    )
    .join('')
const autoSec = (a: Summary['auto']) =>
  `<div class="w-sec">auto-approved ${a.approved} · recovered ${a.recoveries}${a.left ? ` · ${a.left} left for you` : ''}</div>`

function autoHtml(x: Summary) {
  const a = x.auto
  if (!a.approved && !a.recovered.length) return ''
  return `${autoSec(a)}${autoRows(a.byChat.slice(0, 4))}${recoveredRows(a.recovered.slice(-5))}`
}

/** the time away by project: a heading per group (or repo), with its running, finished, approved and recovered rows */
function byProjectHtml(x: Summary, groups: Group[]) {
  const a = x.auto
  const body = groups
    .filter((g) => g.running + g.finished + g.approved + g.recovered)
    .map((g) => {
      const mine = <T extends { group?: string }>(rows: T[]) =>
        rows.filter((r) => r.group === g.key)
      const bits = [
        g.running ? `${g.running} running` : '',
        g.finished ? `${g.finished} finished` : '',
        g.approved ? `${g.approved} auto-approved` : '',
      ].filter(Boolean)
      return `<div class="w-sec sm-group${g.kind === 'repo' ? ' repo' : ''}"><b>${esc(g.label)}</b>${bits.length ? ` · ${esc(bits.join(' · '))}` : ''}</div>
        ${runningHtml(x, mine(x.running))}${finishedHtml(x, mine(x.finished))}${autoRows(mine(a.byChat))}${recoveredRows(mine(a.recovered).slice(-5))}`
    })
    .join('')
  return `${a.approved || a.recovered.length ? autoSec(a) : ''}${body}`
}

const windowText = (x: Summary) =>
  x.kind === 'away'
    ? `Away ${clock(x.from)}–${clock(x.to)} · ${span(x.to - x.from)}`
    : `${clock(x.from)}–${clock(x.to)}`

/** the page: needs you, running, finished, auto; `recap` is a time away the page has moved past */
export function summaryBody(
  x: Summary | null,
  o: { nextAt?: number | null; recap?: Summary | null; inner?: boolean } = {},
): string {
  if (!x)
    return '<div class="w-empty">The first summary is written when the chat host starts, then every hour.</div>'
  const sec = (label: string, n: number, html: string) =>
    n ? `<div class="w-sec">${esc(label)} · ${n}</div>${html}` : ''
  const tasks = x.finished.reduce((n, f) => n + f.tasks.length, 0)
  const byProject = x.kind === 'away' && Array.isArray(x.groups)
  const recap = o.recap
    ? `<details class="sm-recap"><summary><span>While you were away</span> ${esc(windowText(o.recap))} · ${esc(o.recap.headline)}</summary>${summaryBody(o.recap, { inner: true })}</details>`
    : ''
  return `<div class="sm">
    ${
      o.inner
        ? ''
        : `<div class="sm-head"><span class="sm-win">${esc(x.kind === 'away' ? 'While you were away' : 'This hour')} · ${esc(windowText(x))}</span>${o.nextAt ? `<span class="sm-next" title="The next summary is written at the top of the hour">next ${esc(clock(o.nextAt))}</span>` : ''}</div>
    <div class="sm-headline">${esc(x.headline)}</div>`
    }
    ${x.away?.on ? `<div class="sm-away">☾ Away until ${esc(clock(x.away.until))}</div>` : ''}
    <div class="w-sec">needs you${x.needs.length ? ` · ${x.needs.length}` : ''}</div>${needsHtml(x, byProject)}
    ${
      byProject && x.groups
        ? byProjectHtml(x, x.groups)
        : `${sec('running', x.running.length, runningHtml(x))}
    ${sec('finished', tasks || x.finished.length, finishedHtml(x))}
    ${autoHtml(x)}`
    }
    ${recap}
  </div>`
}

/** the folded card: how many things need you, and the most urgent of them */
export function summaryCompact(x: Summary | null): string {
  if (!x)
    return '<div class="wc"><div class="wc-side"><span class="wc-line"><span class="wc-dim">No summary yet</span></span></div></div>'
  const first = x.needs[0]
  const hero = x.needs.length
    ? `<b>$x.needs.length</b><em>need${x.needs.length === 1 ? 's' : ''} you</em>`
    : `<b>✓</b><em>all clear</em>`
  const line = first
    ? `<span class="wc-k">most urgent</span><span class="wc-line sm-need u-${URGENCY[first.rank] ?? 'later'}"${open(first)}><i class="sm-dot"></i><span>${esc(first.repo)} · ${esc(first.what)}</span></span>`
    : `<span class="wc-k">${esc(windowText(x))}</span><span class="wc-line"><span>${esc(x.headline)}</span></span>`
  return `<div class="wc sm-compact"><div class="wc-hero">${hero}</div><div class="wc-side">${line}</div></div>`
}
