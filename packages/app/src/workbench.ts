/**
 * The workbench: a slim nav rail down the left edge, and the one place a feature is reached from.
 *
 * The rail is in runs, with a rule between them. First the three that arrange the page — the
 * browser (or, without the desktop shell, the knowledge ring), the ring, and Claude on the right.
 * Then three slots the panel system fills with its own buttons (panels.ts, `group` on a spec):
 * `fleet` for the agents, `know` for what is written down, `make` for the things you build with.
 * The two full-window views that are not panels — Mission Control and Showreel Studio — sit in
 * `make` beside them, and the floating player and the widget column keep the foot of the rail.
 *
 * This file no longer knows what a panel is. Agent control, autopilot, History, the databases,
 * the fleet board, Runs and the profiler all register themselves with the panel system and their
 * buttons arrive in the slots below; what is left here is the handful of views that arrange the
 * page or cover it, which the panel system deliberately does not own.
 */
import './devfeatures.ts'
import './workbench.css'

type Panel = { open(): void; close(): void; isOpen(): boolean }
type Host = {
  browser: { open(on?: boolean): void; isOpen(): boolean; inShell: boolean }
  claude: Panel
  rail: { hidden(i: number): boolean; set(i: number, hidden: boolean): void }
  /** Showreel Studio; announces itself with `laika:showreel-open` */
  showreel: Panel
  /** Mission Control, the build panel; announces itself with `laika:mission-open` */
  mission: Panel
  /** the Brain window: what is indexed, the rules, the ranking */
  brain: { open(): void }
  /** the floating YouTube player; it floats over the page rather than arranging it */
  music: Panel
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
  autopilot: svg(
    '<circle cx="10" cy="10" r="7.2"/><path d="M10 5.4V10l3 1.9"/><path d="M2.8 10h1.6M15.6 10h1.6M10 2.8v1.6"/>',
  ),
  db: svg(
    '<ellipse cx="10" cy="5" rx="6.4" ry="2.6"/><path d="M3.6 5v10c0 1.44 2.87 2.6 6.4 2.6s6.4-1.16 6.4-2.6V5"/><path d="M3.6 10c0 1.44 2.87 2.6 6.4 2.6s6.4-1.16 6.4-2.6"/>',
  ),
  music: svg(
    '<path d="M7.6 14.2V5.2l8-1.7v9M7.6 8.2l8-1.7"/><ellipse cx="5.2" cy="14.4" rx="2.4" ry="2"/><ellipse cx="13.2" cy="12.6" rx="2.4" ry="2"/>',
  ),
  brain: svg(
    '<path d="M8.2 3a2.4 2.4 0 0 0-2.4 2.4 2.2 2.2 0 0 0-1.6 3.5 2.3 2.3 0 0 0 .5 3.5A2.3 2.3 0 0 0 8.2 17V3Z"/><path d="M11.8 3a2.4 2.4 0 0 1 2.4 2.4 2.2 2.2 0 0 1 1.6 3.5 2.3 2.3 0 0 1-.5 3.5A2.3 2.3 0 0 1 11.8 17V3Z"/>',
  ),
  widgets: svg(
    '<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="11" y="3" width="6" height="6" rx="1.5"/><rect x="3" y="11" width="6" height="6" rx="1.5"/><rect x="11" y="11" width="6" height="6" rx="1.5"/>',
  ),
}

/**
 * The rail choices that cover the page rather than rearranging it or docking beside it. They
 * still close each other, because two full-window views at once means changing something you
 * cannot see. Panels do not need that rule: they take space instead of covering it.
 */
const VIEWS = ['showreel', 'mission'] as const
type View = (typeof VIEWS)[number]
const isView = (k: string): k is View => (VIEWS as readonly string[]).includes(k)

export function createWorkbench(host: Host) {
  const nav = document.createElement('nav')
  nav.id = 'wbn'
  nav.setAttribute('aria-label', 'Workbench')
  nav.innerHTML = `
    <button type="button" data-nav="browser" title="Browser (b)" aria-label="Browser">${ICONS.browser}<span>Web</span></button>
    <button type="button" data-nav="ring" title="Knowledge ring (k)" aria-label="Knowledge ring">${ICONS.ring}<span>Ring</span></button>
    <button type="button" data-nav="claude" title="Claude (s)" aria-label="Claude">${ICONS.claude}<span>Claude</span></button>
    <i class="wbn-sep"></i>
    <i class="wbn-slot" data-group="fleet"></i>
    <i class="wbn-sep"></i>
    <button type="button" data-nav="brain" title="Brain: what is indexed, the rules, the ranking (i)" aria-label="Brain">${ICONS.brain}<span>Brain</span></button>
    <i class="wbn-slot" data-group="know"></i>
    <i class="wbn-slot" data-group="make"></i>
    <i class="wbn-sep"></i>
    <button type="button" data-nav="music" title="Floating YouTube player (m)" aria-label="Floating YouTube player">${ICONS.music}<span>Play</span></button>
    <i class="wbn-fill"></i>
    <button type="button" data-nav="widgets" title="Widget column ([)" aria-label="Widget column">${ICONS.widgets}<span>Widgets</span></button>
    <i class="wbn-sep wbn-dev-sep" data-dev aria-hidden="true"></i>
    <button type="button" data-nav="mission" data-dev title="Mission Control: builds, lanes, verdicts (g)" aria-label="Mission Control">${ICONS.mission}<span>Mission</span><b class="wbn-badge" hidden></b></button>
    <button type="button" data-nav="showreel" data-dev title="Showreel Studio (v)" aria-label="Showreel Studio">${ICONS.showreel}<span>Reel</span></button>
    <i class="wbn-slot" data-group="dev" data-dev></i>`
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
    // the panel buttons paint themselves (panels.ts); nothing here reaches into the slots
    set('music', host.music.isOpen())
    set('widgets', !host.rail.hidden(0))
  }

  nav.addEventListener('click', (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]')?.dataset.nav
    if (!k) return
    // the player floats over whatever is open rather than replacing it, so it closes nothing
    if (k === 'music') {
      host.music.isOpen() ? host.music.close() : host.music.open()
      return paint()
    }
    // the Brain window is a window, not a view: it opens over whatever is there and closes itself
    if (k === 'brain') {
      host.brain.open()
      return paint()
    }
    // The full-window views cover the page, so choosing one clears the others; otherwise the
    // rail would change something you cannot see.
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
  // a panel opening under Mission or Reel would open out of sight: the full-window views step
  // aside for it, as they do for each other
  addEventListener('laika:panel', (e) => {
    if (!(e as CustomEvent<{ open: boolean }>).detail.open) return
    for (const v of VIEWS) if (host[v].isOpen()) host[v].close()
    paint()
  })
  addEventListener('laika:showreel-open', paint)
  addEventListener('laika:mission-open', paint)
  addEventListener('laika:youtube-open', paint)
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
