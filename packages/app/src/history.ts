/**
 * History (`h`): what actually happened across every agent and repo, so a day of many parallel
 * sessions reads as a sequence of events rather than a blur.
 *
 * The overlay owns the chrome — window, project filter, the counts, and a detail panel for the
 * moment you pick. The network is history-map.ts; the moments come from /api/control/moments.
 * The WebGL context is only created the first time History opens, and nothing polls while it
 * is shut.
 */
import './history.css'
import { type HistoryMap, type MapData, type Moment, makeHistoryMap } from './history-map.ts'
import { registerPanel } from './panels.ts'
import { onTheme } from './themes.ts'

type HistMoment = Omit<Moment, 'session' | 'commits'> & {
  session?: {
    id: string
    cwd: string | null
    repoPath: string | null
    account: string | null
    state: string
  }
  commits?: Array<{ t: number; hash: string; subject: string }>
  repo?: { path: string; name: string }
  note?: { path: string; body: string }
}
type ProjectRow = { project: string; work: number; commits: number; notes: number }
type Payload = Omit<MapData, 'moments'> & {
  hours: number
  project: string | null
  moments: HistMoment[]
  summary: {
    sessions: number
    commits: number
    notes: number
    needsYou: number
    blocked: number
    working: number
    projects: ProjectRow[]
    totalProjects: number
  }
}

/** the rail's clock-with-an-arrow, the same glyph the workbench rail used for History */
const ICON =
  '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.4 10a6.6 6.6 0 1 0 1.9-4.7"/><path d="M3 2.9v3.2h3.2"/><path d="M10 6.2V10l2.6 1.7"/></svg>'

export type HistoryView = {
  open(): void
  close(): void
  toggle(): void
  isOpen(): boolean
  fit(): void
}

const HOURS = [12, 24, 48] as const
const REFRESH = 30_000

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[<>&"']/g,
    (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[m] as string,
  )
const short = (p: string) => p.split('/').pop() ?? p
const clock = (t: number) =>
  new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
const took = (ms: number) => {
  const m = Math.round(ms / 60e3)
  return m < 1
    ? 'under a minute'
    : m < 60
      ? `${m}m`
      : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
}
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const STATE_LABEL: Record<string, string> = {
  'needs-you': 'your turn',
  blocked: 'blocked',
  working: 'working now',
  ended: 'ended',
  idle: 'finished',
}

export function createHistory(opts: {
  openControlAt: (id: string) => void
  /** the panel body it lives in; History stopped positioning itself when panels.ts landed */
  host?: HTMLElement
}): HistoryView {
  const hosted = !!opts.host
  const root = document.createElement('div')
  if (!hosted) root.id = 'hist'
  root.className = 'hist'
  root.setAttribute('role', hosted ? 'group' : 'dialog')
  root.setAttribute('aria-label', 'History')
  root.innerHTML = `
    <header class="h-top">
      <div class="h-brand"><span class="h-mark"></span><b>history</b><span class="h-sub">what happened, across every agent and repo</span></div>
      <div class="h-seg" role="group" aria-label="Window">
        ${HOURS.map((h) => `<button type="button" data-hours="${h}">${h}h</button>`).join('')}
      </div>
      <div class="h-right">
        <button type="button" class="h-btn ghost" data-act="fit" title="Fit everything in view (f)">Fit</button>
        ${hosted ? '' : '<button type="button" class="h-btn ghost h-close" data-act="close" title="Close (esc)" aria-label="Close">×</button>'}
      </div>
    </header>
    <div class="h-bar">
      <div class="h-counts" data-el="counts"></div>
      <div class="h-projects" data-el="projects"></div>
    </div>
    <div class="h-stage" data-el="stage">
      <canvas data-el="canvas"></canvas>
      <div class="h-empty" data-el="empty" hidden></div>
      <div class="h-legend">
        <span><i class="k-yours"></i>your turn</span><span><i class="k-blocked"></i>blocked</span>
        <span><i class="k-running"></i>working</span><span><i class="k-quiet"></i>work, in its project’s colour</span>
        <span><i class="k-commit"></i>commits</span><span><i class="k-note"></i>memory</span>
        <span class="h-hint">outward is older · drag to pan · scroll to zoom · hover to trace · click for detail</span>
      </div>
      <aside class="h-detail" data-el="detail" hidden></aside>
    </div>`
  ;(opts.host ?? document.body).appendChild(root)
  const $ = <T extends HTMLElement = HTMLElement>(k: string) =>
    root.querySelector(`[data-el="${k}"]`) as T

  let tl: HistoryMap | null = null
  let hours: number = Number(localStorage.getItem('orbit:hist-hours')) || 24
  if (!HOURS.includes(hours as (typeof HOURS)[number])) hours = 24
  let project: string | null = null
  let data: Payload | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let picked: HistMoment | null = null
  let loading = false

  function stage(): HistoryMap {
    if (tl) return tl
    tl = makeHistoryMap($<HTMLCanvasElement>('canvas'), {
      pick: (m) => showDetail((m as HistMoment | null) ?? null),
    })
    new ResizeObserver(() => tl?.resize()).observe($('stage'))
    return tl
  }

  async function load(refit = false) {
    if (loading) return
    loading = true
    if (!data) empty('Reading sessions, commits and memory notes…')
    try {
      const q = new URLSearchParams({ hours: String(hours) })
      if (project) q.set('project', project)
      const next: Payload = await (await fetch(`/api/control/moments?${q}`)).json()
      // a filter chosen while this was on its way wins
      if (next.hours !== hours || next.project !== project) return
      data = next
      render(refit)
    } catch {
      if (!data) empty('History could not be read. Is the server still running?')
    } finally {
      loading = false
    }
  }

  function empty(text: string | null) {
    const e = $('empty')
    e.hidden = !text
    e.textContent = text ?? ''
  }

  function render(refit: boolean) {
    if (!data) return
    const s = data.summary
    for (const b of root.querySelectorAll<HTMLElement>('[data-hours]'))
      b.classList.toggle('on', Number(b.dataset.hours) === hours)
    const chip = (n: number, label: string, cls = '') =>
      `<span class="h-chip ${n ? cls : ''}"><b>${n}</b> ${label}</span>`
    $('counts').innerHTML = [
      chip(s.needsYou, 'your turn', 'hot'),
      chip(s.blocked, 'blocked', 'warn'),
      chip(s.working, 'working', 'live'),
      chip(s.sessions, s.sessions === 1 ? 'session worked' : 'sessions worked'),
      chip(s.commits, s.commits === 1 ? 'commit' : 'commits'),
      chip(s.notes, s.notes === 1 ? 'memory note' : 'memory notes'),
    ].join('')
    $('projects').innerHTML =
      `<button type="button" class="h-proj ${project ? '' : 'on'}" data-project="">All <em>${s.totalProjects}</em></button>` +
      s.projects
        .map((p) => {
          const bits = [
            p.work ? took(p.work) : '',
            p.commits ? `${p.commits}c` : '',
            p.notes ? `${p.notes}n` : '',
          ]
            .filter(Boolean)
            .join(' · ')
          return `<button type="button" class="h-proj ${p.project === project ? 'on' : ''}" data-project="${esc(p.project)}" title="${esc(p.project)}">${esc(short(p.project))} <em>${esc(bits)}</em></button>`
        })
        .join('')

    const cards = data.moments.filter((m) => m.card).length
    empty(
      data.moments.length
        ? null
        : project
          ? `Nothing happened in ${short(project)} in the last ${hours} hours.`
          : `Nothing happened in the last ${hours} hours.`,
    )
    root.dataset.cards = String(cards)
    stage().build(data, refit)
    if (picked) {
      const still = data.moments.find((m) => m.id === picked?.id)
      if (still) showDetail(still)
      else showDetail(null)
    }
  }

  function showDetail(m: HistMoment | null) {
    picked = m
    const d = $('detail')
    if (!m) {
      d.hidden = true
      d.innerHTML = ''
      tl?.select(null)
      return
    }
    const range =
      m.t1 - m.t0 > 60e3 ? `${clock(m.t0)} – ${clock(m.t1)} · ${took(m.t1 - m.t0)}` : clock(m.t)
    let body = ''
    let acts = ''
    if (m.kind === 'work' && m.session) {
      const st = m.session.state
      body = `
        <p class="h-state ${esc(st)}">${esc(STATE_LABEL[st] ?? st)}</p>
        ${m.sub ? `<p class="h-text">${esc(m.sub)}</p>` : ''}`
      acts = `
        <button type="button" class="h-btn" data-act="open-chat">Open chat</button>
        <button type="button" class="h-btn ghost" data-act="control">Show in agent control</button>
        ${m.session.cwd ? '<button type="button" class="h-btn ghost" data-act="resume">Copy resume command</button>' : ''}`
    } else if (m.kind === 'commit' && m.commits) {
      body = `<ol class="h-commits">${m.commits
        .map(
          (c) =>
            `<li><code>${esc(c.hash)}</code><span>${esc(c.subject)}</span><time>${esc(clock(c.t))}</time></li>`,
        )
        .join('')}</ol>`
      if (m.repo)
        acts = `
          <button type="button" class="h-btn ghost" data-act="editor" data-path="${esc(m.repo.path)}">Editor</button>
          <button type="button" class="h-btn ghost" data-act="terminal" data-path="${esc(m.repo.path)}">Terminal</button>`
    } else if (m.kind === 'note' && m.note) {
      body = `${m.sub ? `<p class="h-text">${esc(m.sub)}</p>` : ''}<pre class="h-note">${esc(m.note.body)}</pre>`
      acts =
        '<button type="button" class="h-btn ghost" data-act="copy-path">Copy file path</button>'
    }
    d.innerHTML = `
      <div class="h-d-top">
        <span class="h-kind ${esc(m.kind)} ${esc(m.lvl)}">${esc(m.kind)}</span>
        <button type="button" class="h-btn ghost h-d-close" data-act="unpick" aria-label="Close detail">×</button>
      </div>
      <h3>${esc(m.title)}</h3>
      <p class="h-where" title="${esc(m.project)}">${esc(m.project)} · ${esc(range)}</p>
      ${body}
      ${acts ? `<div class="h-acts">${acts}</div>` : ''}`
    d.hidden = false
    tl?.select(m.id)
  }

  root.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement
    const hb = t.closest<HTMLElement>('[data-hours]')
    if (hb) {
      hours = Number(hb.dataset.hours)
      localStorage.setItem('orbit:hist-hours', String(hours))
      showDetail(null)
      data = null
      return load(true)
    }
    const pb = t.closest<HTMLElement>('[data-project]')
    if (pb) {
      const next = pb.dataset.project || null
      project = next === project ? null : next
      showDetail(null)
      return load(true)
    }
    const b = t.closest<HTMLElement>('[data-act]')
    if (!b) return
    const act = b.dataset.act
    const m = picked
    if (act === 'close') return view.close()
    if (act === 'fit') return tl?.fit()
    if (act === 'unpick') return showDetail(null)
    if (!m) return
    if (act === 'open-chat' && m.session) {
      // the sessions view listens for this and resumes the conversation there
      view.close()
      dispatchEvent(
        new CustomEvent('laika:open-session', {
          detail: {
            id: m.session.id,
            cwd: m.session.cwd ?? m.session.repoPath ?? '',
            repo: short(m.project),
            title: m.title,
            state: m.session.state,
            account: m.session.account,
          },
        }),
      )
      return
    }
    if (act === 'control' && m.session) {
      view.close()
      return opts.openControlAt(m.session.id)
    }
    if (act === 'resume' && m.session?.cwd) {
      await navigator.clipboard
        .writeText(`cd ${shq(m.session.cwd)} && claude --resume ${m.session.id}`)
        .catch(() => {})
      return flashButton(b, 'Copied')
    }
    if (act === 'copy-path' && m.note) {
      await navigator.clipboard.writeText(m.note.path).catch(() => {})
      return flashButton(b, 'Copied')
    }
    const path = b.dataset.path
    if (path && (act === 'editor' || act === 'terminal'))
      fetch(`/api/control/open?kind=${act}&path=${encodeURIComponent(path)}`, {
        method: 'POST',
        headers: { 'x-control': '1' },
      }).catch(() => {})
  })

  function flashButton(b: HTMLElement, text: string) {
    const was = b.textContent
    b.textContent = text
    setTimeout(() => {
      b.textContent = was
    }, 1400)
  }

  // canvas textures cannot follow the cascade, so a theme change rebuilds the scene
  onTheme(() => {
    if (data && view.isOpen()) render(false)
  })

  const view: HistoryView = {
    open() {
      if (view.isOpen()) return
      root.classList.add('on')
      if (!hosted) document.body.classList.add('hist-open')
      stage().resize()
      load(!data)
      timer = setInterval(() => load(false), REFRESH)
    },
    close() {
      if (!view.isOpen()) return
      root.classList.remove('on')
      if (!hosted) document.body.classList.remove('hist-open')
      if (timer) clearInterval(timer)
      timer = null
    },
    toggle() {
      if (view.isOpen()) view.close()
      else view.open()
    },
    isOpen: () => root.classList.contains('on'),
    fit: () => tl?.fit(),
  }

  /**
   * Keys while History is open. In a panel it is not modal — the panel frame already keeps its
   * keys to itself — so only the two that mean something here are claimed: Escape steps back out
   * of a picked card, `f` fits. Free-standing it stays modal, as it was.
   */
  addEventListener(
    'keydown',
    (ev) => {
      if (!view.isOpen() || ev.metaKey || ev.ctrlKey || ev.altKey) return
      if ((ev.target as HTMLElement).closest?.('input, textarea, select')) return
      // in a panel, History only claims keys while the pointer's work is in it: focus inside it,
      // or a card picked on its clock (a canvas click does not move focus)
      const inside = !hosted || root.contains(ev.target as Node)
      if (ev.key === 'Escape') {
        if (hosted && !picked) return // nothing to step back from: the panel's own Escape closes it
        ev.preventDefault()
        ev.stopImmediatePropagation()
        if (picked) showDetail(null)
        else view.close()
      } else if (ev.key === 'f' && inside) {
        ev.stopImmediatePropagation()
        tl?.fit()
      } else if (!hosted) {
        if (ev.key === 'h') view.close()
        // free-standing, History is modal: nothing typed here flies the map underneath
        ev.stopImmediatePropagation()
      }
    },
    { capture: true },
  )

  return view
}

// ------------------------------------------------------------------- as a panel ----

/**
 * History in the dock: `h`, the rail's History button, or "History" in the palette — all three
 * the same panel. It is wide, because the clock needs room to be read at all.
 */
export function registerHistoryPanel(opts: { openControlAt: (id: string) => void }) {
  let view: HistoryView | null = null
  return registerPanel({
    id: 'history',
    title: 'History',
    group: 'know',
    key: 'h',
    icon: ICON,
    wide: true,
    width: { min: 520, default: 980, snaps: [680, 980, 1320] },
    terms: 'timeline what happened today commits memory notes activity chaos log moments clock',
    hint: 'what happened, across every agent and repo',
    mount: (host) => {
      view = createHistory({ ...opts, host })
      return () => view?.close()
    },
    onVisible: (on) => (on ? view?.open() : view?.close()),
  })
}
