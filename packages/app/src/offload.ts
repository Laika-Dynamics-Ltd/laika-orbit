import './offload.css'
import * as activity from './activity.ts'

/**
 * Compute sent to other machines, in the top bar beside CPU and memory. Shown only once a
 * machine has been added (brain/nodes.local.json). The meter is one CPU bar per machine and the
 * number of jobs running on them; hovering opens a card with each machine's load, what it is
 * running now, and what it finished in the last hour (hosts keep an hour of finished jobs).
 *
 * Machines answer through SSH tunnels the server keeps open, so the request is slower than
 * /api/sysres: it polls every 5 seconds, and not at all while the page is hidden.
 */
type Job = {
  id: string
  dir: string
  cmd: string
  args: string[]
  unity: string | null
  state: 'running' | 'done' | 'failed' | 'killed'
  code: number | null
  startedAt: number
  endedAt: number | null
}
type Machine = {
  cpu: number
  cores: number
  load: number
  mem: number
  memTotal: number
  gpus?: { name: string; util: number | null }[]
  unity?: string[]
  hostname?: string
  cap?: { jobs: number | null; nice: number | null }
}
/** what a machine can do (capsOf in machines.mjs) */
type Caps = { os: string; gpu: string | null; render: boolean; unity: string[]; posix: boolean }
type Place = {
  id: string
  name: string
  local: boolean
  os?: 'linux' | 'windows' | 'mac'
  caps?: Caps | null
  /** what it can run, one phrase each */
  canRun?: string[]
  /** the kinds of new work that go to it now: 'GPU work', 'CPU work' */
  gets?: string[]
  address: string | null
  online: boolean
  error?: string
  machine?: Machine | null
  jobs: Job[]
}

const EVERY_MS = 5000

const box = document.createElement('div')
box.className = 'ol'
box.hidden = true
box.tabIndex = 0
box.setAttribute('role', 'group')
box.setAttribute('aria-label', 'Offloaded compute')
box.setAttribute('aria-describedby', 'ol-card')
;(document.querySelector('header .sr') ?? document.querySelector('header #hdr'))?.[
  document.querySelector('header .sr') ? 'after' : 'before'
](box)

const card = document.createElement('div')
card.className = 'ol-card'
card.id = 'ol-card'
card.setAttribute('role', 'tooltip')
card.hidden = true
document.body.append(card)

const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  )
const level = (n: number) => (n >= 90 ? 'hot' : n >= 75 ? 'warm' : '')
const dur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60
    ? `${m}m ${String(s % 60).padStart(2, '0')}s`
    : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
const base = (p: string) => p.split('/').pop() ?? p

/** what a job is, in a few words: the tool, and what it works on */
function describe(j: Job): { what: string; on: string } {
  if (j.unity) {
    const i = j.args.indexOf('-executeMethod')
    const task = j.args.includes('-runTests')
      ? `${j.args[j.args.indexOf('-testPlatform') + 1] ?? ''} tests`.trim()
      : i >= 0
        ? (j.args[i + 1]?.split('.').pop() ?? 'method')
        : 'batch'
    return { what: `Unity · ${task}`, on: project(j.dir) }
  }
  const tool = base(j.cmd)
  if (tool === 'ffmpeg') {
    const out = [...j.args].reverse().find((a) => a.startsWith('out/'))
    return { what: 'ffmpeg', on: out ? base(out) : 'encode' }
  }
  return { what: tool, on: project(j.dir) }
}
/** housekeeping the offload tools run after themselves (removing a finished ffmpeg job's folder) */
const chore = (j: Job) => base(j.cmd) === 'rm' && j.dir === '.'
/** a project copy's folder without the hash that keeps copies apart */
const project = (dir: string) => base(dir).replace(/-[0-9a-f]{8}$/, '')

const OS: Record<string, string> = { linux: 'Linux', windows: 'Windows', mac: 'macOS' }

/** the GPU, and whether renders there come out right (a GPU and, on Windows, someone signed in) */
function gpuLine(n: Place) {
  const c = n.caps
  if (!c) return ''
  if (!c.gpu)
    return '<div class="ol-gpu none">No GPU: renders come out dark, so GPU work goes elsewhere when it can</div>'
  return `<div class="ol-gpu${c.render ? '' : ' warn'}">${esc(c.gpu)}${c.render ? '' : ' · nobody signed in at the screen, so renders may come out black'}</div>`
}

let nodes: Place[] = []
let open = false
let hideTimer = 0

function paintMeter() {
  const away = nodes.filter((n) => !n.local)
  box.hidden = !away.length
  if (!away.length) return
  const running = away.reduce((n, x) => n + x.jobs.filter((j) => j.state === 'running').length, 0)
  const bars = away
    .slice(0, 4)
    .map((n) => {
      const cpu = n.online ? Math.max(0, Math.min(100, n.machine?.cpu ?? 0)) : 0
      return `<span class="ol-m${n.online ? '' : ' off'}" data-level="${level(cpu)}" title="${esc(n.name)}"><i style="transform:scaleX(${Math.max(0.04, cpu / 100)})"></i></span>`
    })
    .join('')
  const html = `<em>remote</em><span class="ol-bars">${bars}</span><small class="${running ? 'on' : ''}">${running}</small>`
  if (box.dataset.html !== html) {
    box.dataset.html = html
    box.innerHTML = html
  }
  box.setAttribute(
    'aria-label',
    `Offloaded compute: ${running} job${running === 1 ? '' : 's'} running on ${away.filter((n) => n.online).length} of ${away.length} machines`,
  )
}

function jobRow(j: Job, now: number) {
  const d = describe(j)
  const time =
    j.state === 'running' ? dur(now - j.startedAt) : dur((j.endedAt ?? now) - j.startedAt)
  const mark =
    j.state === 'running'
      ? '<i class="ol-spin"></i>'
      : j.state === 'done'
        ? '✓'
        : j.state === 'killed'
          ? '■'
          : '✗'
  return `<div class="ol-j ${j.state}"><span class="ol-mark">${mark}</span><span class="ol-what">${esc(d.what)}</span><span class="ol-on" title="${esc(d.on)}">${esc(d.on)}</span><b>${time}</b></div>`
}

function renderCard() {
  const now = Date.now()
  const away = nodes.filter((n) => !n.local)
  const all = away.flatMap((n) => n.jobs).filter((j) => !chore(j))
  const running = all.filter((j) => j.state === 'running')
  const hour = all.filter((j) => j.state !== 'running' && (j.endedAt ?? 0) > now - 3600_000)
  const sent =
    hour.reduce((t, j) => t + ((j.endedAt ?? now) - j.startedAt), 0) +
    running.reduce((t, j) => t + (now - j.startedAt), 0)
  card.innerHTML = `
    <div class="ol-head"><span>Offloaded compute</span><b>${running.length} running</b></div>
    <div class="ol-sum">${dur(sent)} of work sent in the last hour · ${hour.filter((j) => j.state === 'done').length} done${hour.some((j) => j.state === 'failed') ? ` · <em>${hour.filter((j) => j.state === 'failed').length} failed</em>` : ''}</div>
    ${away
      .map((n) => {
        const m = n.machine
        const jobs = n.jobs.filter((j) => !chore(j)).sort((a, b) => b.startedAt - a.startedAt)
        const live = jobs.filter((j) => j.state === 'running')
        const recent = jobs.filter((j) => j.state !== 'running').slice(0, 4)
        return `<section class="ol-n${n.online ? '' : ' off'}">
          <div class="ol-nh"><span class="ol-dot"></span><b>${esc(n.name)}</b>${n.os ? `<span class="ol-os">${esc(OS[n.os] ?? n.os)}</span>` : ''}<span class="ol-addr">${esc(n.address ?? '')}</span>${n.online ? '' : '<span class="ol-state">offline</span>'}</div>
          ${
            n.online && m
              ? `<div class="ol-stats">
                  <span class="${level(m.cpu)}">CPU <b>${m.cpu}%</b></span>
                  <span class="${level(m.mem)}">Mem <b>${m.mem}%</b></span>
                  <span>Load <b>${m.load}</b>/${m.cores}</span>
                  ${m.gpus?.length ? m.gpus.map((g) => `<span>GPU <b>${g.util ?? '–'}${g.util == null ? '' : '%'}</b></span>`).join('') : ''}
                </div>
                ${gpuLine(n)}
                <div class="ol-caps">${m.cores} cores · ${(m.memTotal / 1e9).toFixed(0)} GB${m.unity?.length ? ` · Unity ${m.unity.map(esc).join(', ')}` : ''}${m.cap?.jobs ? ` · capped at ${m.cap.jobs} job${m.cap.jobs === 1 ? '' : 's'}${m.cap.nice ? ', low priority' : ''}` : ''}</div>`
              : `<div class="ol-caps err">${esc(n.error ?? 'offline')}</div>`
          }
          ${n.gets?.length ? `<div class="ol-gets">New ${n.gets.map((g) => `<b>${esc(g)}</b>`).join(' and ')} ${n.gets.length > 1 ? 'go' : 'goes'} here</div>` : ''}
          ${live.length ? `<div class="ol-js">${live.map((j) => jobRow(j, now)).join('')}</div>` : n.online ? '<div class="ol-idle">Idle</div>' : ''}
          ${recent.length ? `<div class="ol-js past">${recent.map((j) => jobRow(j, now)).join('')}</div>` : ''}
        </section>`
      })
      .join('')}`
  place()
}

function place() {
  const r = box.getBoundingClientRect()
  const w = card.offsetWidth
  card.style.top = `${Math.round(r.bottom + 6)}px`
  card.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)))}px`
}

/** as in sysres.ts: the card repaints under the pointer, so the page watches the pointer itself */
function watchPointer(ev: PointerEvent) {
  const t = ev.target as Node
  if (box.contains(t) || card.contains(t)) clearTimeout(hideTimer)
  else hideCard()
}
function showCard(ev?: Event) {
  clearTimeout(hideTimer)
  if (ev?.type === 'pointerenter') document.addEventListener('pointermove', watchPointer)
  if (open) return
  open = true
  card.hidden = false
  renderCard()
}
function hideCard(now = false) {
  clearTimeout(hideTimer)
  const go = () => {
    open = false
    card.hidden = true
    document.removeEventListener('pointermove', watchPointer)
  }
  if (now) go()
  else hideTimer = window.setTimeout(go, 120)
}
box.addEventListener('pointerenter', showCard)
box.addEventListener('pointerleave', () => hideCard())
box.addEventListener('focus', showCard)
box.addEventListener('blur', () => hideCard(true))
box.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') hideCard(true)
})
card.addEventListener('pointerenter', () => clearTimeout(hideTimer))
card.addEventListener('pointerleave', () => hideCard())

let timer = 0
let busy = false
async function tick() {
  clearTimeout(timer)
  if (document.hidden) return hideCard(true)
  if (!busy) {
    busy = true
    try {
      const r = await fetch('/api/control/nodes', { signal: AbortSignal.timeout(15_000) })
      if (r.ok) {
        nodes = (await r.json()) as Place[]
        paintMeter()
        if (open) renderCard()
      }
    } catch {
    } finally {
      busy = false
    }
  }
  // a quarter as often while another app is in front
  if (!document.hidden)
    timer = window.setTimeout(tick, activity.atLeast('away') ? EVERY_MS * 4 : EVERY_MS)
}
addEventListener('visibilitychange', tick)
activity.onLevel((_, was) => {
  if (was === 'away' && !activity.atLeast('away')) tick()
})
tick()
