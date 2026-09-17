/**
 * The workbench: a slim nav rail down the left edge that arranges the page for daily work.
 * The browser (or, without the desktop shell, the knowledge ring) fills the left, Claude docks
 * on the right, and the rail brings the ring, the browser, Claude and the widget column in and
 * out. Below a rule sit the views that open over all of it: agent control (what needs you),
 * History (what happened), Mission Control (the build panel) and Showreel. Everything it toggles already exists; this only drives it
 * and remembers the choice.
 */
import './workbench.css'

type Panel = { open(): void; close(): void; isOpen(): boolean }
type Host = {
  browser: { open(on?: boolean): void; isOpen(): boolean; inShell: boolean }
  claude: Panel
  rail: { hidden(i: number): boolean; set(i: number, hidden: boolean): void }
  /** Showreel Studio; announces itself with `laika:showreel-open` */
  showreel: Panel
  /** agent control; announces itself with `laika:control-open` */
  control: Panel
  /** History; toggles body.hist-open, which the observer below already watches */
  history: Panel
  /** Mission Control, the build panel; announces itself with `laika:mission-open` */
  mission: Panel
}

const SETUP_KEY = 'laika.workbench'
const CLAUDE_KEY = 'laika.claudeOpen'

const svg = (body: string) =>
  `<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const ICONS = {
  browser: svg(
    '<circle cx="10" cy="10" r="7.2"/><path d="M2.8 10h14.4M10 2.8c2.3 2.1 2.3 12.3 0 14.4M10 2.8c-2.3 2.1-2.3 12.3 0 14.4"/>',
  ),
  ring: svg(
    '<circle cx="10" cy="10" r="7.2"/><circle cx="10" cy="10" r="3.6"/><circle cx="10" cy="2.8" r="1.2" fill="currentColor"/><circle cx="16.2" cy="13.6" r="1.2" fill="currentColor"/><circle cx="3.8" cy="13.6" r="1.2" fill="currentColor"/>',
  ),
  claude: svg(
    '<path d="M10 2.5v15M2.5 10h15M4.7 4.7l10.6 10.6M15.3 4.7 4.7 15.3" stroke-width="1.7"/>',
  ),
  showreel: svg(
    '<rect x="2.8" y="4.2" width="14.4" height="11.6" rx="2"/><path d="M2.8 7.4h14.4M2.8 12.6h14.4M6 4.2v3.2M10 4.2v3.2M14 4.2v3.2M6 12.6v3.2M10 12.6v3.2M14 12.6v3.2"/>',
  ),
  control: svg(
    '<rect x="3" y="3.2" width="14" height="13.6" rx="2.2"/><circle cx="6.6" cy="7.4" r="1.1" fill="currentColor"/><circle cx="6.6" cy="12.6" r="1.1" fill="currentColor"/><path d="M9.4 7.4h4.4M9.4 12.6h4.4"/>',
  ),
  mission: svg(
    '<circle cx="10" cy="10" r="7.2"/><circle cx="10" cy="10" r="3.4"/><path d="M10 1.4v3.2M10 15.4v3.2M1.4 10h3.2M15.4 10h3.2"/>',
  ),
  history: svg(
    '<path d="M3.4 10a6.6 6.6 0 1 0 1.9-4.7"/><path d="M3 2.9v3.2h3.2"/><path d="M10 6.2V10l2.6 1.7"/>',
  ),
  widgets: svg(
    '<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="11" y="3" width="6" height="6" rx="1.5"/><rect x="3" y="11" width="6" height="6" rx="1.5"/><rect x="11" y="11" width="6" height="6" rx="1.5"/>',
  ),
}

/** The rail choices that open over the page rather than rearranging it. */
const VIEWS = ['showreel', 'control', 'history', 'mission'] as const
type View = (typeof VIEWS)[number]
const isView = (k: string): k is View => (VIEWS as readonly string[]).includes(k)

export function createWorkbench(host: Host) {
  const nav = document.createElement('nav')
  nav.id = 'wbn'
  nav.setAttribute('aria-label', 'Workbench')
  nav.innerHTML = `
    <button type="button" data-nav="browser" title="Browser (b)" aria-label="Browser">${ICONS.browser}<span>Web</span></button>
    <button type="button" data-nav="ring" title="Knowledge ring" aria-label="Knowledge ring">${ICONS.ring}<span>Ring</span></button>
    <button type="button" data-nav="claude" title="Claude (s)" aria-label="Claude">${ICONS.claude}<span>Claude</span></button>
    <i class="wbn-sep"></i>
    <button type="button" data-nav="control" title="Agent control: what needs you (c)" aria-label="Agent control">${ICONS.control}<span>Agents</span><b class="wbn-badge" hidden></b></button>
    <button type="button" data-nav="history" title="History: what happened (h)" aria-label="History">${ICONS.history}<span>History</span></button>
    <button type="button" data-nav="mission" title="Mission Control: builds, lanes, verdicts" aria-label="Mission Control">${ICONS.mission}<span>Mission</span><b class="wbn-badge" hidden></b></button>
    <button type="button" data-nav="showreel" title="Showreel Studio" aria-label="Showreel Studio">${ICONS.showreel}<span>Reel</span></button>
    <i class="wbn-fill"></i>
    <button type="button" data-nav="widgets" title="Widget column ([)" aria-label="Widget column">${ICONS.widgets}<span>Widgets</span></button>`
  document.body.appendChild(nav)
  document.body.classList.add('has-wbn')

  const paint = () => {
    const web = host.browser.isOpen()
    const set = (k: string, on: boolean) =>
      nav.querySelector(`[data-nav="${k}"]`)?.classList.toggle('on', on)
    set('browser', web)
    set('ring', !web)
    set('claude', host.claude.isOpen())
    for (const v of VIEWS) set(v, host[v].isOpen())
    set('widgets', !host.rail.hidden(0))
  }

  nav.addEventListener('click', (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]')?.dataset.nav
    if (!k) return
    // The views cover the page (agent control, its right half), so choosing anything clears
    // the ones it is not; otherwise the rail would change something you cannot see.
    for (const v of VIEWS) if (v !== k) host[v].close()
    if (isView(k)) host[k].isOpen() ? host[k].close() : host[k].open()
    if (k === 'browser') host.browser.open(true)
    if (k === 'ring') host.browser.open(false)
    if (k === 'claude') host.claude.isOpen() ? host.claude.close() : host.claude.open()
    if (k === 'widgets') host.rail.set(0, !host.rail.hidden(0))
    paint()
  })

  addEventListener('laika:claude-open', (e) => {
    try {
      localStorage.setItem(CLAUDE_KEY, (e as CustomEvent<boolean>).detail ? '1' : '')
    } catch {}
    paint()
  })
  addEventListener('laika:showreel-open', paint)
  addEventListener('laika:control-open', paint)
  addEventListener('laika:mission-open', paint)
  // sessions waiting on you, counted where the agents widget refreshes
  const badge = nav.querySelector<HTMLElement>('[data-nav="control"] .wbn-badge')
  addEventListener('laika:waiting', (e) => {
    const n = (e as CustomEvent<number>).detail
    if (!badge) return
    badge.hidden = !n
    badge.textContent = n > 9 ? '9+' : String(n)
    badge.parentElement?.setAttribute(
      'aria-label',
      n ? `Agent control, ${n} waiting on you` : 'Agent control',
    )
  })
  // builds waiting on your verdict in Mission Control; -1 while the panel is down
  const missionBadge = nav.querySelector<HTMLElement>('[data-nav="mission"] .wbn-badge')
  addEventListener('laika:mission-waiting', (e) => {
    const n = (e as CustomEvent<number>).detail
    if (!missionBadge) return
    missionBadge.hidden = n < 1
    missionBadge.textContent = n > 9 ? '9+' : String(n)
    const btn = missionBadge.parentElement
    if (btn) btn.hidden = n === -2
    btn?.classList.toggle('down', n < 0)
    btn?.setAttribute(
      'aria-label',
      n < 0
        ? 'Mission Control, not running'
        : n
          ? `Mission Control, ${n} ${n === 1 ? 'build waits' : 'builds wait'} on your verdict`
          : 'Mission Control',
    )
  })
  // the browser and the rails change from their own keys and buttons too
  new MutationObserver(paint).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  })

  // first run: the daily layout. After that, whatever you left open comes back.
  let first = false
  let claudeWas = false
  try {
    first = !localStorage.getItem(SETUP_KEY)
    claudeWas = localStorage.getItem(CLAUDE_KEY) === '1'
    if (first) localStorage.setItem(SETUP_KEY, '1')
  } catch {}
  if (first) {
    host.rail.set(0, true)
    // without the desktop shell the browser cannot show sites, so the ring keeps the left
    if (host.browser.inShell) host.browser.open(true)
  }
  if (first || claudeWas) host.claude.open()
  paint()
}
