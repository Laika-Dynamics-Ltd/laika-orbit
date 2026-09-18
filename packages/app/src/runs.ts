/**
 * Runs — the views, as plain mount functions over an element the caller owns.
 *
 * One feature for every kind of live tracking: the run list across all chats, one run's page
 * (lanes, jobs, artefacts, verdicts, waves), a compare view for artefacts side by side, and a
 * compact strip. None of them draw any chrome of their own — no fixed positioning, no width, no
 * z-index — so the same code serves /runs and a sliding panel (see runs-panel.ts).
 *
 * Every view reads /api/runs through one shared poller, so ten mounted strips still make one
 * request every few seconds. Polling rather than a stream, because the app's own chats already
 * hold several of the browser's six connections to this origin.
 */
import './runs.css'
import * as activity from './activity.ts'

export type Status = 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'skipped'
export type State =
  | 'running'
  | 'stalled'
  | 'orphaned'
  | 'blocked'
  | 'idle'
  | 'done'
  | 'failed'
  | 'cancelled'

export type Job = {
  id: string
  name: string
  status: Status
  pct?: number
  note?: string
  ms?: number
  updatedAt: number
}
export type Lane = {
  id: string
  name: string
  status: Status
  pct: number
  done?: number
  total?: number
  note?: string
  where?: string
  etaAt: number | null
  etaDerived: boolean
  overdue: boolean
  stalled: boolean
  stallMin: number
  startedAt?: number
  endedAt?: number
  ms?: number
  updatedAt: number
  jobs: Job[]
}
export type Artifact = {
  id: string
  label: string
  path: string
  medium: 'image' | 'video' | 'page' | 'log'
  compare?: string
  lane?: string
  wave?: number
  source?: string
  note?: string
  suspect?: boolean
  missing?: boolean
  addedAt: number
}
export type Verdict = {
  id: string
  piece?: string
  wave?: number
  winner: 'candidate' | 'reference' | 'tie'
  slot?: 'a' | 'b'
  confirmed?: boolean
  why?: string
  critic?: string
  gap?: string
  candidate?: string
  reference?: string
  at: number
}
export type Run = {
  rerun?: { command: string; args?: string[] }
  id: string
  title: string
  note?: string
  kind?: string
  project?: string
  where?: string
  cwd?: string
  chat?: string
  createdAt: number
  updatedAt: number
  endedAt?: number
  stallMin: number
  pct: number
  etaAt: number | null
  etaDerived: boolean
  etaPartial: boolean
  etaFrom: 'given' | 'lanes' | 'history' | null
  etaRuns: number | null
  silent: boolean
  stalledLanes: number
  stuckLanes: string[]
  state: State
  waves: number[]
  lanes: Lane[]
  artifacts: Artifact[]
  verdicts: Verdict[]
}

const POLL_MS = 3000

// ─── the shared poller ──────────────────────────────────────────────────────────────────────────

/** an offload machine as the app last saw it (machines.mjs saveMachineState) */
type MachineState = {
  name: string
  os: string | null
  online: boolean
  caps: { gpu: string | null; render: boolean } | null
  jobs: number
}
type Feed = { runs: Run[]; here: string; lastOk: number; error: string | null }
/** by name, so a run's "where" can say whether that machine is up and what it has */
let machines = new Map<string, MachineState>()
const feed: Feed = { runs: [], here: '', lastOk: 0, error: null }
const listeners = new Set<(f: Feed) => void>()
let timer: (() => void) | undefined
let skew = 0 // the server's clock minus ours, so "ago" is right even when the two differ

export const now = () => Date.now() + skew

async function poll() {
  try {
    const r = await fetch('/api/runs', { cache: 'no-store' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = (await r.json()) as {
      now: number
      here: string
      runs: Run[]
      machines?: MachineState[]
    }
    machines = new Map((data.machines ?? []).map((m) => [m.name, m]))
    skew = data.now - Date.now()
    feed.runs = data.runs
    feed.here = data.here
    feed.lastOk = Date.now()
    feed.error = null
  } catch (e) {
    feed.error = (e as Error).message
  }
  for (const fn of listeners) fn(feed)
}

/** every view shares one request; the last one to leave stops it */
export function subscribe(fn: (f: Feed) => void) {
  listeners.add(fn)
  if (timer === undefined) timer = activity.every(POLL_MS, poll)
  else fn(feed)
  return () => {
    listeners.delete(fn)
    if (!listeners.size && timer !== undefined) {
      timer()
      timer = undefined
    }
  }
}

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function span(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return `${Math.round(h / 24)}d`
}
export const clock = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const ago = (t: number) => `<time data-ago="${t}">${span(now() - t)} ago</time>`

const ENDED: State[] = ['done', 'failed', 'cancelled']
export const isEnded = (r: Run) => ENDED.includes(r.state)
const isAlarm = (r: Run) => r.state === 'stalled' || r.state === 'orphaned'

export const STATE_LABEL: Record<State, string> = {
  running: 'running',
  stalled: 'stalled',
  orphaned: 'chat ended',
  blocked: 'waiting on you',
  idle: 'between steps',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
}

/** how the ETA was arrived at, said plainly, because a guessed ETA is worse than none */
function eta(r: Run) {
  if (isEnded(r)) return ''
  if (!r.etaAt) return '<span class="rn-eta none">no ETA yet</span>'
  const left = r.etaAt - now()
  const from =
    r.etaFrom === 'history'
      ? `<i title="the median of ${r.etaRuns} past runs of this kind">from ${r.etaRuns} past runs</i> `
      : r.etaFrom === 'lanes'
        ? `${r.etaDerived ? '<i title="projected from the rate its lanes are moving at">est.</i> ' : ''}${r.etaPartial ? '<i title="some lanes have no ETA, so this is a lower bound">at least</i> ' : ''}`
        : ''
  return left <= 0
    ? `<span class="rn-eta late" title="ETA ${clock(r.etaAt)}">${from}due ${span(-left)} ago</span>`
    : `<span class="rn-eta" title="ETA ${clock(r.etaAt)}">${from}${span(left)} left · ${clock(r.etaAt)}</span>`
}

function laneEta(l: Lane) {
  if (l.status === 'done' || l.status === 'failed' || l.status === 'skipped')
    return `<span class="rn-eta none">${l.status}${l.ms ? ` in ${span(l.ms)}` : ''}</span>`
  if (!l.etaAt) return '<span class="rn-eta none">—</span>'
  const left = l.etaAt - now()
  const est = l.etaDerived ? '<i>est.</i> ' : ''
  return left <= 0
    ? `<span class="rn-eta ${l.overdue ? 'late' : ''}">${est}due ${span(-left)} ago</span>`
    : `<span class="rn-eta">${est}${span(left)} left</span>`
}

const bar = (pct: number, cls: string) =>
  `<div class="rn-bar ${cls}"><div style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%"></div></div>`

/**
 * where the work runs; the machine serving this page is "this Mac". An offload machine the app
 * knows carries its state: a dot for online or offline, and its GPU (or none) in the title.
 */
const machine = (w: string | undefined, here: string) => {
  if (!w) return ''
  if (w === here) return `<span class="rn-where" title="${esc(w)}">this Mac</span>`
  const m = machines.get(w)
  if (!m) return `<span class="rn-where" title="${esc(w)}">${esc(w)}</span>`
  const gpu = m.caps?.gpu
    ? `GPU ${m.caps.gpu}${m.caps.render ? '' : ', renders may come out dark'}`
    : 'no GPU'
  const title = `${w} · ${m.os ?? 'linux'} · ${m.online ? `online, ${m.jobs} job${m.jobs === 1 ? '' : 's'}` : 'offline'} · ${gpu}`
  return `<span class="rn-where${m.online ? '' : ' off'}" title="${esc(title)}"><i class="rn-dot"></i>${esc(w)}${m.caps?.gpu ? '<small>GPU</small>' : ''}</span>`
}

/** why a run needs a look: which lane went quiet, or that its chat is gone */
export function why(r: Run) {
  if (r.state === 'orphaned')
    return `Nothing has reported since ${ago(r.updatedAt)}, and the process that was reporting is gone. This run is over; it was never finished.`
  if (r.state !== 'stalled') return ''
  const stuck = r.lanes.filter((l) => l.stalled)
  if (stuck.length)
    return stuck
      .map(
        (l) =>
          `<b>${esc(l.name)}</b> is stuck: running, but silent for ${span(now() - l.updatedAt)} (limit ${l.stallMin}m)`,
      )
      .join('<br>')
  return `No report from this run for ${span(now() - r.updatedAt)} (limit ${r.stallMin}m)`
}

/** the "ago" and "left" text moves every second; the data behind it does not */
function ticker(host: HTMLElement) {
  return activity.every(
    1000,
    () => {
      for (const el of host.querySelectorAll<HTMLElement>('time[data-ago]'))
        el.textContent = `${span(now() - Number(el.dataset.ago))} ago`
    },
    { el: host, now: false },
  )
}

/** only redraw when something actually changed, so a hovered row or an open menu stays put */
function ifChanged() {
  let last = ''
  return (v: unknown, draw: () => void) => {
    const json = JSON.stringify(v)
    if (json === last) return
    last = json
    draw()
  }
}

export const artifactUrl = (run: string, id: string) =>
  `/api/runs/${encodeURIComponent(run)}/artifacts/${encodeURIComponent(id)}/file`

// ─── the run list, across every chat, grouped by project ────────────────────────────────────────

export type ListOptions = { onOpen?: (id: string) => void; title?: boolean }

export function mountRunList(host: HTMLElement, opts: ListOptions = {}) {
  host.classList.add('rn')
  host.innerHTML = `<div class="rn-chips" data-el="chips"></div><div class="rn-list" data-el="list"><p class="rn-empty">Loading…</p></div>`
  const el = (n: string) => host.querySelector(`[data-el="${n}"]`) as HTMLElement
  const changed = ifChanged()
  let showAllFinished = false

  const row = (r: Run, here: string) => {
    const alarm = why(r)
    return `<button class="rn-row st-${r.state}" data-open="${esc(r.id)}">
      <span class="rn-rtop">
        <span class="rn-rtitle">${esc(r.title)}</span>
        <span class="rn-state st-${r.state}">${STATE_LABEL[r.state]}</span>
        ${machine(r.where, here)}
        ${r.verdicts.length ? `<span class="rn-tag">gauntlet · ${r.verdicts.length} verdict${r.verdicts.length > 1 ? 's' : ''}</span>` : ''}
        ${r.artifacts.length ? `<span class="rn-tag">${r.artifacts.length} artefact${r.artifacts.length > 1 ? 's' : ''}</span>` : ''}
      </span>
      <span class="rn-rbar">${bar(r.pct, `st-${r.state}`)}<span class="rn-num">${Math.round(r.pct)}%</span>${eta(r)}</span>
      <span class="rn-rfoot">
        ${isEnded(r) ? `${r.state} ${r.endedAt ? ago(r.endedAt) : ''}` : `updated ${ago(r.updatedAt)}`}
        ${r.chat ? ` · chat <code>${esc(r.chat.slice(0, 8))}</code>` : ''}
        ${r.lanes.length ? ` · ${r.lanes.length} lane${r.lanes.length > 1 ? 's' : ''}` : ''}
      </span>
      ${alarm ? `<span class="rn-alarm">${alarm}</span>` : ''}
      ${r.note && !alarm ? `<span class="rn-note">${esc(r.note)}</span>` : ''}
    </button>`
  }

  const draw = (f: Feed) => {
    const runs = f.runs
    const alarm = runs.filter(isAlarm)
    const live = runs.filter((r) => !isEnded(r) && !isAlarm(r))
    const finished = runs.filter(isEnded)
    const recent = finished.filter((r) => now() - (r.endedAt ?? r.updatedAt) < 24 * 3_600_000)
    const chip = (n: number, label: string, cls: string) =>
      n ? `<span class="rn-chip ${cls}"><b>${n}</b> ${label}</span>` : ''
    el('chips').innerHTML =
      chip(
        runs.filter((r) => r.state === 'running' || r.state === 'idle').length,
        'running',
        'live',
      ) +
      chip(runs.filter((r) => r.state === 'stalled').length, 'stalled', 'bad') +
      chip(runs.filter((r) => r.state === 'orphaned').length, 'chat ended', 'bad') +
      chip(runs.filter((r) => r.state === 'blocked').length, 'waiting on you', 'warn') +
      chip(recent.length, 'finished today', '')

    // grouped by project, because runs come from every chat on this Mac at once
    const byProject = (list: Run[]) => {
      const groups = new Map<string, Run[]>()
      for (const r of list) {
        const k = r.project ?? 'elsewhere'
        groups.set(k, [...(groups.get(k) ?? []), r])
      }
      return [...groups].sort((a, b) => b[1].length - a[1].length)
    }
    const section = (title: string, sub: string, list: Run[], cls = '') =>
      list.length
        ? `<section class="rn-sec ${cls}"><h2>${title} <small>${sub}</small></h2>${byProject(list)
            .map(
              ([project, rs]) =>
                `<div class="rn-proj"><h3>${esc(project)} <small>${rs.length}</small></h3>${rs.map((r) => row(r, f.here)).join('')}</div>`,
            )
            .join('')}</section>`
        : ''
    const listed = showAllFinished ? finished : recent
    el('list').innerHTML =
      section('Needs a look', 'stopped reporting — check the chat', alarm, 'alarm') +
        section('In progress', '', live) +
        section(
          'Finished',
          finished.length > recent.length
            ? `<button class="rn-link" data-toggle>${showAllFinished ? 'last 24 hours only' : `show all ${finished.length}`}</button>`
            : 'last 24 hours',
          listed,
          'finished',
        ) ||
      `<div class="rn-empty big"><p>No chat is reporting a run.</p><p>A chat starts one in a line:</p>
       <pre>runs start my-run --title "What this run does" --lanes build,check
runs job my-run build page-1 --status done
runs artifact my-run out/hero.png --compare hero</pre></div>`
    if (opts.title !== false) document.title = alarm.length ? `(${alarm.length}) Runs` : 'Runs'
  }

  const off = subscribe((f) => changed([f.runs, showAllFinished], () => draw(f)))
  const stopTick = ticker(host)
  const onClick = (ev: MouseEvent) => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>('[data-open],[data-toggle]')
    if (!t) return
    if ('toggle' in t.dataset) {
      showAllFinished = !showAllFinished
      draw(feed)
    } else if (t.dataset.open) opts.onOpen?.(t.dataset.open)
  }
  host.addEventListener('click', onClick)
  return () => {
    off()
    stopTick()
    host.removeEventListener('click', onClick)
    host.innerHTML = ''
  }
}

// ─── one run: lanes as rows, jobs filling in, artefacts, verdicts, waves ────────────────────────

export type RunOptions = { onBack?: () => void; onCompare?: (run: string, group: string) => void }

const JOBS_SHOWN = 16

export function mountRun(host: HTMLElement, id: string, opts: RunOptions = {}) {
  host.classList.add('rn')
  host.innerHTML = '<p class="rn-empty">Loading…</p>'
  const changed = ifChanged()
  const openJobs = new Set<string>()

  const jobHtml = (j: Job) => {
    const pct = j.status === 'running' && j.pct !== undefined ? ` ${Math.round(j.pct)}%` : ''
    const took = j.ms ? ` · took ${span(j.ms)}` : ''
    return `<span class="rn-job s-${j.status}" title="${esc(`${j.status}${j.note ? ` — ${j.note}` : ''}${took}`)}">${esc(j.name)}${pct}</span>`
  }

  const laneHtml = (l: Lane, here: string) => {
    const counts = l.total ? `${l.done ?? 0}/${l.total}` : `${Math.round(l.pct)}%`
    const more = l.jobs.length > JOBS_SHOWN && !openJobs.has(l.id)
    const shown = more ? l.jobs.slice(0, JOBS_SHOWN) : l.jobs
    return `<div class="rn-lane s-${l.status}${l.stalled ? ' stalled' : ''}">
      <span class="rn-dot" title="${l.status}"></span>
      <span class="rn-lname">${esc(l.name)}${machine(l.where, here)}</span>
      ${bar(l.pct, `s-${l.status}`)}
      <span class="rn-num">${counts}</span>
      <span class="rn-leta">${laneEta(l)}</span>
      <span class="rn-lago${l.stalled ? ' bad' : ''}">${ago(l.updatedAt)}</span>
      ${l.note ? `<p class="rn-lnote">${esc(l.note)}</p>` : ''}
      ${
        l.jobs.length
          ? `<div class="rn-jobs">${shown.map(jobHtml).join('')}${
              more
                ? `<button class="rn-more" data-more="${esc(l.id)}">+${l.jobs.length - JOBS_SHOWN} more</button>`
                : l.jobs.length > JOBS_SHOWN
                  ? `<button class="rn-more" data-less="${esc(l.id)}">show fewer</button>`
                  : ''
            }</div>`
          : ''
      }
    </div>`
  }

  const thumb = (r: Run, a: Artifact) => {
    const url = artifactUrl(r.id, a.id)
    const face = a.missing
      ? '<span class="rn-gone">file gone</span>'
      : a.medium === 'image'
        ? `<img src="${url}" alt="${esc(a.label)}" loading="lazy">`
        : a.medium === 'video'
          ? `<video src="${url}" muted preload="metadata"></video>`
          : `<span class="rn-kind">${a.medium}</span>`
    return `<figure class="rn-art${a.suspect ? ' suspect' : ''}">
      <a href="${url}" target="_blank" rel="noopener">${face}</a>
      <figcaption>
        <b>${esc(a.label)}</b>
        ${a.compare ? `<button class="rn-link" data-compare="${esc(a.compare)}">compare</button>` : ''}
        ${a.suspect ? '<span class="rn-warn" title="the source given looks like Laika Orbit itself — an artefact has to come from the thing being built">check this source</span>' : ''}
        ${a.note ? `<span class="rn-dim">${esc(a.note)}</span>` : ''}
      </figcaption>
    </figure>`
  }

  const verdictRows = (vs: Verdict[]) =>
    `<table class="rn-verdicts">
      <thead><tr><th>Piece</th><th>Winner</th><th>Slot</th><th>Confirmed</th><th>Why</th></tr></thead>
      <tbody>${vs
        .map(
          (v) => `<tr class="w-${v.winner}">
          <td>${esc(v.piece ?? '—')}</td>
          <td><b>${v.winner === 'candidate' ? 'ours' : v.winner === 'reference' ? 'the bar' : 'tie'}</b></td>
          <td>${v.slot ? `ours in ${v.slot.toUpperCase()}` : '<span class="rn-warn" title="a verdict trail is evidence only if the work changed slots">not recorded</span>'}</td>
          <td>${v.confirmed ? 'flipped too' : v.winner === 'candidate' ? '<span class="rn-warn" title="a win in one slot order alone is often the slot">one order only</span>' : '—'}</td>
          <td class="rn-why">${esc(v.why ?? '')}${v.critic ? `<span class="rn-dim"> — ${esc(v.critic)}</span>` : ''}</td>
        </tr>`,
        )
        .join('')}</tbody>
    </table>`

  const draw = (r: Run | undefined, here: string) => {
    if (!r) {
      host.innerHTML = `<div class="rn-empty big"><p>No run called <code>${esc(id)}</code>.</p>${opts.onBack ? '<button class="rn-link" data-back>← all runs</button>' : ''}</div>`
      return
    }
    const alarm = why(r)
    const waved = r.waves.length > 1 || r.verdicts.some((v) => v.wave !== undefined)
    const waves = waved
      ? r.waves
          .map((w) => {
            const arts = r.artifacts.filter((a) => a.wave === w)
            const vs = r.verdicts.filter((v) => v.wave === w)
            return `<section class="rn-wave"><h3>Wave ${w} <small>${vs.map((v) => (v.winner === 'candidate' ? 'won' : v.winner === 'reference' ? 'lost' : 'tie')).join(' · ')}</small></h3>
              ${arts.length ? `<div class="rn-arts">${arts.map((a) => thumb(r, a)).join('')}</div>` : ''}
              ${vs.length ? verdictRows(vs) : ''}</section>`
          })
          .reverse()
          .join('')
      : ''
    const loose = r.artifacts.filter((a) => !waved || a.wave === undefined)
    const looseVerdicts = r.verdicts.filter((v) => !waved || v.wave === undefined)
    host.innerHTML = `<article class="rn-run st-${r.state}">
      <header class="rn-head">
        ${opts.onBack ? '<button class="rn-link" data-back>← all runs</button>' : ''}
        <h2>${esc(r.title)}</h2>
        <span class="rn-state st-${r.state}">${STATE_LABEL[r.state]}</span>
        ${machine(r.where, here)}
        <span class="rn-meta">${r.project ? `${esc(r.project)} · ` : ''}${r.kind ? `kind <code>${esc(r.kind)}</code> · ` : ''}${r.chat ? `chat <code title="${esc(r.chat)}">${esc(r.chat.slice(0, 8))}</code> · ` : ''}started ${clock(r.createdAt)}</span>
      </header>
      ${alarm ? `<p class="rn-alarm big">${alarm}</p>` : ''}
      <div class="rn-overall">${bar(r.pct, `st-${r.state}`)}<span class="rn-num big">${Math.round(r.pct)}%</span>${eta(r)}
        <span class="rn-dim">${isEnded(r) && r.endedAt ? `${r.state} in ${span(r.endedAt - r.createdAt)}` : `running ${span(now() - r.createdAt)}`}</span>
      </div>
      ${r.note ? `<p class="rn-note">${esc(r.note)}</p>` : ''}
      <div class="rn-lanes">${r.lanes.map((l) => laneHtml(l, here)).join('') || '<p class="rn-empty">No lanes reported yet.</p>'}</div>
      ${loose.length ? `<section class="rn-sec"><h3>Artefacts <small>${loose.length}</small></h3><div class="rn-arts">${loose.map((a) => thumb(r, a)).join('')}</div></section>` : ''}
      ${looseVerdicts.length ? `<section class="rn-sec"><h3>Verdicts</h3>${verdictRows(looseVerdicts)}</section>` : ''}
      ${waves}
      ${r.rerun || isEnded(r) || r.state === 'orphaned' ? `<div class="rn-acts">${r.rerun ? `<button class="rn-link" data-rerun title="${esc([r.rerun.command, ...(r.rerun.args ?? [])].join(' '))}">Run again</button>` : ''}${isEnded(r) || r.state === 'orphaned' ? '<button class="rn-link" data-remove>Remove this run</button>' : ''}</div>` : ''}
    </article>`
  }

  const off = subscribe((f) => {
    const r = f.runs.find((x) => x.id === id)
    changed([r, [...openJobs]], () => draw(r, f.here))
  })
  const stopTick = ticker(host)
  const onClick = (ev: MouseEvent) => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>('button')
    if (!t) return
    if (t.dataset.more) openJobs.add(t.dataset.more)
    else if (t.dataset.less) openJobs.delete(t.dataset.less)
    else if (t.dataset.compare) return opts.onCompare?.(id, t.dataset.compare)
    else if ('back' in t.dataset) return opts.onBack?.()
    else if ('rerun' in t.dataset) {
      // the run's own registered command, again (commands.mjs); the button says so while it starts
      const r = feed.runs.find((x) => x.id === id)
      if (!r?.rerun) return
      t.textContent = 'Starting…'
      fetch(`/api/commands/${encodeURIComponent(r.rerun.command)}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-orbit-command': '1' },
        body: JSON.stringify({ args: r.rerun.args ?? [] }),
      })
        .then((x) => x.json())
        .then((j) => (t.textContent = j.ok ? 'Started' : `Could not: ${j.error}`))
        .catch(() => (t.textContent = 'Could not start it'))
      return
    } else if ('remove' in t.dataset) {
      // history keeps its own record, so removing a finished run only clears it off the page
      fetch(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' })
        .catch(() => {})
        .then(() => opts.onBack?.())
      return
    } else return
    draw(
      feed.runs.find((x) => x.id === id),
      feed.here,
    )
  }
  host.addEventListener('click', onClick)
  return () => {
    off()
    stopTick()
    host.removeEventListener('click', onClick)
    host.innerHTML = ''
  }
}

// ─── compare: two or more artefacts beside each other ───────────────────────────────────────────

export function mountCompare(
  host: HTMLElement,
  id: string,
  group: string,
  opts: { onBack?: () => void } = {},
) {
  host.classList.add('rn')
  host.innerHTML = '<p class="rn-empty">Loading…</p>'
  const changed = ifChanged()

  const draw = (r: Run | undefined) => {
    const arts = (r?.artifacts ?? []).filter((a) => a.compare === group)
    if (!r || !arts.length) {
      host.innerHTML = `<div class="rn-empty big"><p>Nothing to compare under <code>${esc(group)}</code>.</p>${opts.onBack ? '<button class="rn-link" data-back>← back to the run</button>' : ''}</div>`
      return
    }
    // a verdict naming one of these says which way it went, so the winner is marked in place
    const winner = r.verdicts.find((v) =>
      arts.some((a) => a.path === v.candidate || a.path === v.reference),
    )
    const mark = (a: Artifact) => {
      if (!winner) return ''
      const isCand = a.path === winner.candidate
      const won =
        (isCand && winner.winner === 'candidate') || (!isCand && winner.winner === 'reference')
      return `<span class="rn-mark ${won ? 'won' : 'lost'}">${isCand ? 'ours' : 'the bar'}${won ? ' · won' : winner.winner === 'tie' ? ' · tie' : ''}</span>`
    }
    host.innerHTML = `<div class="rn-cmp">
      <header class="rn-head">
        ${opts.onBack ? '<button class="rn-link" data-back>← back to the run</button>' : ''}
        <h2>${esc(group)}</h2><span class="rn-meta">${arts.length} side by side · ${esc(r.title)}</span>
      </header>
      <div class="rn-cmp-grid" style="--cols:${Math.min(arts.length, 4)}">
        ${arts
          .map((a) => {
            const url = artifactUrl(r.id, a.id)
            const face = a.missing
              ? '<span class="rn-gone">file gone</span>'
              : a.medium === 'image'
                ? `<img src="${url}" alt="${esc(a.label)}">`
                : a.medium === 'video'
                  ? `<video src="${url}" controls muted></video>`
                  : a.medium === 'page'
                    ? `<iframe src="${url}" title="${esc(a.label)}" sandbox></iframe>`
                    : `<iframe src="${url}" title="${esc(a.label)}" sandbox class="rn-log"></iframe>`
            return `<figure class="rn-cmp-cell${a.suspect ? ' suspect' : ''}">
              <figcaption><b>${esc(a.label)}</b>${mark(a)}${a.wave !== undefined ? `<span class="rn-dim">wave ${a.wave}</span>` : ''}
                ${a.suspect ? '<span class="rn-warn">source looks like Orbit itself</span>' : ''}</figcaption>
              <a href="${url}" target="_blank" rel="noopener">${face}</a>
            </figure>`
          })
          .join('')}
      </div>
      ${winner?.why ? `<p class="rn-note">${esc(winner.why)}</p>` : ''}
    </div>`
  }

  const off = subscribe((f) => {
    const r = f.runs.find((x) => x.id === id)
    changed(r?.artifacts, () => draw(r))
  })
  const onClick = (ev: MouseEvent) => {
    if ((ev.target as HTMLElement).closest('[data-back]')) opts.onBack?.()
  }
  host.addEventListener('click', onClick)
  return () => {
    off()
    host.removeEventListener('click', onClick)
    host.innerHTML = ''
  }
}

// ─── the compact strip, for inside a chat ───────────────────────────────────────────────────────

/**
 * One line: what is running, how far, how long left, on which machine, and — when it stalls — the
 * lane that went quiet. Follows one run by `id`, or whichever run a `chat` is reporting now.
 */
export function mountStrip(
  host: HTMLElement,
  pick: { id?: string; chat?: string } = {},
  opts: { onOpen?: (id: string) => void } = {},
) {
  host.classList.add('rn', 'rn-strip-host')
  const changed = ifChanged()

  const draw = (r: Run | undefined, here: string) => {
    if (!r) {
      host.innerHTML = ''
      return
    }
    const lane = r.lanes.find((l) => l.stalled) ?? r.lanes.find((l) => l.status === 'running')
    // on a stalled run the lane that went quiet is the news; its ETA is not, so it gives up the room
    const stuck = r.state === 'stalled' && lane?.stalled
    host.innerHTML = `<button class="rn-strip st-${r.state}" data-open="${esc(r.id)}" title="${esc(r.title)}">
      <span class="rn-sdot"></span>
      <span class="rn-stitle">${esc(r.title)}</span>
      ${bar(r.pct, `st-${r.state}`)}
      <span class="rn-num">${Math.round(r.pct)}%</span>
      ${isEnded(r) ? `<span class="rn-eta none">${r.state}</span>` : stuck ? '' : eta(r)}
      ${lane ? `<span class="rn-slane">${stuck ? 'stuck: ' : ''}${esc(lane.name)}</span>` : ''}
      ${machine(r.where, here)}
    </button>`
  }

  const off = subscribe((f) => {
    // runs come back newest first, so a chat's current run is the first one it owns
    const r = pick.id
      ? f.runs.find((x) => x.id === pick.id)
      : f.runs.find((x) => (pick.chat ? x.chat === pick.chat && !isEnded(x) : !isEnded(x)))
    changed(r, () => draw(r, f.here))
  })
  const stopTick = ticker(host)
  const onClick = (ev: MouseEvent) => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>('[data-open]')
    if (t?.dataset.open) opts.onOpen?.(t.dataset.open)
  }
  host.addEventListener('click', onClick)
  return () => {
    off()
    stopTick()
    host.removeEventListener('click', onClick)
    host.innerHTML = ''
  }
}
