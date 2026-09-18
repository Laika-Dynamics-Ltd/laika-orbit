/**
 * The Mission window: Mission Control, the build panel (lanes, checkpoints, verdicts, learning,
 * chat), inside Laika Orbit.
 *
 * The panel is its own server (7317, MISSION_URL on the server to change it), so its
 * page is framed as it is rather than re-drawn here: same code, same verdict card, same files
 * written. The frame is made on first open and kept, so the panel's own tab, lane and scroll
 * survive closing it. /api/mission says whether the panel is up and how many builds wait on a
 * verdict; when it is down the window says so and how to start it, rather than framing an error.
 */
import './mission.css'
import * as activity from './activity.ts'

type State = {
  url: string
  configured?: boolean
  up: boolean
  name?: string | null
  waiting?: number
  error?: string
}

let overlay: HTMLDivElement | null = null
let frame: HTMLIFrameElement | null = null

export const isMissionOpen = () => overlay?.classList.contains('on') ?? false
const announce = () =>
  dispatchEvent(new CustomEvent('laika:mission-open', { detail: isMissionOpen() }))

async function state(): Promise<State | null> {
  try {
    return await (await fetch('/api/mission')).json()
  } catch {
    return null
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !isMissionOpen()) return
  e.stopImmediatePropagation()
  closeMission()
}

export function closeMission() {
  overlay?.classList.remove('on')
  removeEventListener('keydown', onKey, true)
  announce()
}

async function load(win: HTMLElement) {
  const s = await state()
  if (s?.up) {
    win.querySelector('.mc-down')?.remove()
    if (frame) return
    frame = document.createElement('iframe')
    frame.className = 'mc-frame'
    frame.title = s.name ? `Mission Control: ${s.name}` : 'Mission Control'
    // the panel copies deep links (⌘⇧C) from inside the frame
    frame.allow = 'clipboard-read; clipboard-write'
    frame.src = `${s.url}/`
    win.append(frame)
    return
  }
  if (frame) return // it was up once; the panel's own page shows its reconnecting state
  let down = win.querySelector<HTMLElement>('.mc-down')
  if (!down) {
    down = document.createElement('div')
    down.className = 'mc-down'
    win.append(down)
  }
  const where = s?.url ?? 'http://127.0.0.1:7317'
  down.innerHTML = `
    <h2>Mission Control is not running</h2>
    <p>Nothing answered at <code></code>.</p>
    <p>Start the panel, or point Laika Orbit at another one with <code>MISSION_URL</code> when starting the server.</p>
    <button type="button" class="mc-retry">Try again</button>`
  down.querySelector('p code')!.textContent = where
  down.querySelector('.mc-retry')!.addEventListener('click', () => void load(win))
}

export function openMission() {
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = 'mc'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-label', 'Mission Control')
    overlay.innerHTML = '<div class="mc-win"></div>'
    // keys pressed on the window's own chrome must not reach Laika Orbit's single-key shortcuts;
    // keys inside the frame never leave it
    overlay.addEventListener('keydown', (e) => e.stopPropagation())
    document.body.appendChild(overlay)
  }
  void load(overlay.querySelector<HTMLElement>('.mc-win')!)
  overlay.classList.add('on')
  addEventListener('keydown', onKey, true)
  announce()
}

/** Builds waiting on a verdict, for the rail's badge; -1 while the panel is down. */
export function watchMission() {
  // -1: down, -2: never set up here (no MISSION_URL, never answered), so the rail hides the button
  let seen = false
  const tick = async () => {
    const s = await state()
    seen ||= Boolean(s?.up)
    const detail = s?.up ? (s.waiting ?? 0) : s?.configured || seen ? -1 : -2
    dispatchEvent(new CustomEvent('laika:mission-waiting', { detail }))
  }
  activity.every(15_000, tick)
}

type Panel = {
  root: string
  configured: boolean
  running: boolean
  url?: string
  port?: number
  name?: string | null
  waiting?: number
  managed?: boolean
  service?: string | null
  busy?: boolean
  error?: string
}

export type MissionPane = {
  el: HTMLElement
  /** the pane is being shown: find the chosen repo's panel and frame it, or offer to start it */
  open(): void
}

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/**
 * The Build view of a Claude workspace: Mission Control for each repo in it that has a
 * mission.config.mjs of its own (a project folder can hold several; the choice is remembered).
 * A repo's panel is framed wherever it already runs (a launchd service, or one Laika Orbit started);
 * otherwise the pane says so and starts one only when asked, because a panel writes .panel/ in
 * the repo and runs its checks on every source save. Each repo keeps its own frame, so switching
 * between them keeps each panel's place.
 */
export function createMissionPane(key: string, roots: string[]): MissionPane {
  const MEMO = `laika.build:${key}`
  let root = roots[0] as string
  try {
    const was = localStorage.getItem(MEMO)
    if (was && roots.includes(was)) root = was
  } catch {}
  const el = document.createElement('div')
  el.className = 'mcp'
  el.innerHTML = `
    <div class="mcp-bar"><span class="mcp-repos" role="tablist" aria-label="Repo"></span><span class="mcp-where"></span><i class="mcp-fill"></i><span class="mcp-acts"></span></div>
    <div class="mcp-body"></div>`
  const repos = el.querySelector<HTMLElement>('.mcp-repos')!
  const where = el.querySelector<HTMLElement>('.mcp-where')!
  const acts = el.querySelector<HTMLElement>('.mcp-acts')!
  const body = el.querySelector<HTMLElement>('.mcp-body')!
  const frames = new Map<string, HTMLIFrameElement>()
  let busy = false

  repos.hidden = roots.length < 2
  for (const r of roots) {
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('role', 'tab')
    b.dataset.root = r
    b.textContent = baseName(r)
    b.title = r
    repos.append(b)
  }
  repos.addEventListener('click', (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>('[data-root]')?.dataset.root
    if (!r || r === root) return
    root = r
    try {
      localStorage.setItem(MEMO, r)
    } catch {}
    void load()
  })

  const post = async (what: 'start' | 'stop'): Promise<Panel> => {
    const r = await fetch(`/api/mission/panel/${what}`, {
      method: 'POST',
      headers: { 'x-control': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ root }),
    })
    const j = await r.json().catch(() => ({ error: `${r.status}` }))
    if (!r.ok) throw new Error(j.error ?? `${r.status}`)
    return j
  }
  const act = (label: string, run: () => Promise<Panel>) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'mcp-btn'
    b.textContent = label
    b.addEventListener('click', async () => {
      if (busy) return
      busy = true
      try {
        paint(await run())
      } catch (e) {
        paint(null, e instanceof Error ? e.message : String(e))
      } finally {
        busy = false
      }
    })
    return b
  }

  function paint(p: Panel | null, error?: string) {
    for (const b of repos.querySelectorAll<HTMLElement>('[data-root]')) {
      const on = b.dataset.root === root
      b.classList.toggle('on', on)
      b.setAttribute('aria-selected', String(on))
    }
    for (const [r, f] of frames) f.hidden = r !== root || !p?.running
    acts.replaceChildren()
    body.querySelector('.mcp-off')?.remove()
    if (p?.running && p.url) {
      const how = p.service ? 'launchd service' : p.managed ? 'started by Laika Orbit' : ''
      where.textContent = `${p.name ?? baseName(root)} · :${p.port}${how ? ` · ${how}` : ''}${p.busy ? ' · busy, still loading' : ''}`
      const out = document.createElement('a')
      out.className = 'mcp-btn'
      out.href = `${p.url}/`
      out.target = '_blank'
      out.rel = 'noopener'
      out.textContent = 'Open in browser ↗'
      acts.append(out)
      if (p.managed) acts.append(act('Stop panel', () => post('stop')))
      let frame = frames.get(root)
      if (frame && frame.dataset.url !== p.url) {
        frame.remove()
        frame = undefined
      }
      if (!frame) {
        frame = document.createElement('iframe')
        frame.className = 'mcp-frame'
        frame.title = `Mission Control: ${p.name ?? baseName(root)}`
        frame.allow = 'clipboard-read; clipboard-write'
        frame.dataset.url = p.url
        frame.src = `${p.url}/`
        frames.set(root, frame)
        body.append(frame)
      }
      frame.hidden = false
      return
    }
    // stopped: its frame would only show the panel's reconnecting page
    frames.get(root)?.remove()
    frames.delete(root)
    where.textContent = roots.length < 2 ? baseName(root) : ''
    const off = document.createElement('div')
    off.className = 'mcp-off'
    off.innerHTML = `
      <h2>Mission Control is not running for <span></span></h2>
      <p>It has a <code>mission.config.mjs</code>, so it can have one. The panel writes <code>.panel/</code> in the repo and runs its checks when source files change, until you stop it or this app stops.</p>
      <button type="button" class="mcp-start">Start panel</button>
      <pre class="mcp-err" hidden></pre>`
    off.querySelector('h2 span')!.textContent = baseName(root)
    const err = off.querySelector<HTMLElement>('.mcp-err')!
    if (error) {
      err.hidden = false
      err.textContent = error
    }
    const start = off.querySelector<HTMLButtonElement>('.mcp-start')!
    start.addEventListener('click', async () => {
      if (busy) return
      busy = true
      start.disabled = true
      start.textContent = 'Starting…'
      try {
        paint(await post('start'))
      } catch (e) {
        paint(null, e instanceof Error ? e.message : String(e))
      } finally {
        busy = false
      }
    })
    body.append(off)
  }

  async function load() {
    const asked = root
    try {
      const r = await fetch(`/api/mission/panel?root=${encodeURIComponent(asked)}`)
      const p: Panel = await r.json()
      if (!r.ok) throw new Error(p.error ?? `${r.status}`)
      if (asked === root) paint(p)
    } catch (e) {
      if (asked === root) paint(null, e instanceof Error ? e.message : String(e))
    }
  }

  return { el, open: () => void load() }
}

/** The repos at or inside a workspace's folder that have a Mission Control panel of their own. */
export async function missionRoots(path: string): Promise<string[]> {
  try {
    const r = await fetch(`/api/mission/roots?root=${encodeURIComponent(path)}`)
    return r.ok ? ((await r.json()).roots ?? []) : []
  } catch {
    return []
  }
}
