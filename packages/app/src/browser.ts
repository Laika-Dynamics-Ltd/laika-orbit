/**
 * The browser dock: Chromium tabs inside 1brain, one storage profile per account, so a
 * second Chrome window is not needed. Opens over the map with `b` (or ⌘⇧B from a tab).
 *
 * This file is the UI only: tab strip, omnibox with history suggestions, find bar,
 * profiles. The tabs themselves are native WebContentsViews owned by the desktop shell
 * (packages/shell), reached through `window.laikaShell` (typed in shell-api.ts). The shell
 * draws the active tab over the `.wb-view` area; this side reports that rectangle and,
 * because a native view always paints above the page, tells the shell to step aside while
 * anything of the page's own (spotlight, settings, a menu) is drawn over that area.
 *
 * In a plain browser there is no shell, and a web page cannot embed other sites (they
 * refuse to be framed), so the dock explains how to launch the shell instead.
 */
import './browser.css'
import type {
  ChromeExtension,
  ShellBookmark,
  ShellDownload,
  ShellExtension,
  ShellState,
  ShellTab,
} from './shell-api.ts'

export type BrowserHost = { spotlight: () => void }
export type BrowserDock = {
  open: (on?: boolean) => void
  toggle: () => void
  isOpen: () => boolean
  /** open a URL as a tab (default profile); in a plain browser, a new window */
  openUrl: (url: string) => void
  inShell: boolean
}

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[<>&"']/g,
    (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[m] as string,
  )
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html !== undefined) e.innerHTML = html
  return e
}
const hostOf = (u: string | null) => {
  if (!u) return ''
  try {
    return new URL(u).host.replace(/^www\./, '')
  } catch {
    return u
  }
}
const COLOURS = [
  '#5b9dff',
  '#ff7a45',
  '#3ddc97',
  '#c07bff',
  '#ffc94f',
  '#ff4f9d',
  '#4fe0e0',
  '#a3d15c',
]
const icon = (d: string, size = 16) =>
  `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
const ICON = {
  back: icon('<path d="M13 8H3.5M7.5 3.5 3 8l4.5 4.5"/>'),
  fwd: icon('<path d="M3 8h9.5M8.5 3.5 13 8l-4.5 4.5"/>'),
  reload: icon('<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3"/>'),
  stop: icon('<path d="M4 4l8 8M12 4l-8 8"/>'),
  find: icon('<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3"/>'),
  close: icon('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>', 12),
  plus: icon('<path d="M8 3v10M3 8h10"/>'),
  x: icon('<path d="M4 4l8 8M12 4l-8 8"/>', 14),
  audio: icon('<path d="M3 6.2h2.2L8.4 3.5v9L5.2 9.8H3zM11 5.6a3.4 3.4 0 0 1 0 4.8"/>', 13),
  muted: icon('<path d="M3 6.2h2.2L8.4 3.5v9L5.2 9.8H3zM10.5 6l3 3M13.5 6l-3 3"/>', 13),
  star: icon(
    '<path d="M8 2.3l1.75 3.6 3.95.55-2.87 2.77.7 3.93L8 11.28l-3.53 1.87.7-3.93L2.3 6.45l3.95-.55z"/>',
  ),
  more: icon('<path d="M4 4.5 7.5 8 4 11.5M8.5 4.5 12 8l-3.5 3.5"/>', 14),
  puzzle: icon(
    '<path d="M6.5 2.5a1.5 1.5 0 0 1 3 0V4H12a.5.5 0 0 1 .5.5V7h-1.2a1.5 1.5 0 0 0 0 3h1.2v2.5a.5.5 0 0 1-.5.5H9.5v-1.2a1.5 1.5 0 0 0-3 0V13H4a.5.5 0 0 1-.5-.5V10H4.8a1.5 1.5 0 0 0 0-3H3.5V4.5A.5.5 0 0 1 4 4h2.5z"/>',
  ),
}
const GLOBE =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1.7 8h12.6M8 1.7c2.2 2 2.2 10.6 0 12.6M8 1.7c-2.2 2-2.2 10.6 0 12.6" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>'

export function createBrowser(host: BrowserHost): BrowserDock {
  const shell = window.laikaShell
  const inShell = !!shell
  document.body.classList.toggle('in-shell', inShell)

  const root = el('section')
  root.id = 'wb'
  // Mounted inside #stage, but it is chrome rather than graph, so it follows the theme
  // instead of the stage's fixed dark palette (see themes.css).
  root.className = 'themed'
  root.setAttribute('role', 'region')
  root.setAttribute('aria-label', 'Browser')
  root.innerHTML = `
    <div class="wb-tabs">
      <div class="wb-strip" data-el="strip" role="tablist"></div>
      <button class="wb-new" type="button" data-act="new" title="New tab (⌘T) · right-click for a profile · double-click the strip" aria-label="New tab">${ICON.plus}</button>
    </div>
    <div class="wb-nav">
      <button class="wb-ib" type="button" data-act="back" title="Back (⌘[)" aria-label="Back">${ICON.back}</button>
      <button class="wb-ib" type="button" data-act="fwd" title="Forward (⌘])" aria-label="Forward">${ICON.fwd}</button>
      <button class="wb-ib" type="button" data-act="reload" title="Reload (⌘R)" aria-label="Reload">${ICON.reload}</button>
      <button class="wb-prof" type="button" data-act="prof" title="This tab's profile"><i></i><span data-el="profname"></span></button>
      <form class="wb-omni" data-el="omni">
        <span class="wb-lock" data-el="lock"></span>
        <input data-el="url" placeholder="Search or enter a URL" spellcheck="false" autocomplete="off" aria-label="Address"/>
        <button class="wb-star" type="button" data-act="star" data-el="star" hidden aria-label="Bookmark this tab">${ICON.star}</button>
      </form>
      <button class="wb-zoom" type="button" data-act="zoom-reset" data-el="zoom" hidden></button>
      <button class="wb-dl" type="button" data-el="dl" hidden></button>
      <span class="wb-actions" data-el="actions"></span>
      <button class="wb-ib" type="button" data-act="exts" title="Extensions" aria-label="Extensions" hidden>${ICON.puzzle}</button>
      <button class="wb-ib" type="button" data-act="find" title="Find in page (⌘F)" aria-label="Find in page">${ICON.find}</button>
      <button class="wb-ib" type="button" data-act="profiles" title="Profiles">${GLOBE}</button>
      <button class="wb-ib wb-close" type="button" data-act="close" title="Close browser (⌘⇧B)" aria-label="Close browser">${ICON.close}</button>
    </div>
    <div class="wb-bmarks" data-el="bmarks" hidden role="toolbar" aria-label="Bookmarks">
      <div class="wb-bmlist" data-el="bmlist"></div>
      <button class="wb-bm wb-bmmore" type="button" data-el="bmmore" title="More bookmarks" aria-label="More bookmarks" hidden>${ICON.more}</button>
    </div>
    <div class="wb-find" data-el="find" hidden>
      <input data-el="findq" placeholder="Find in page" spellcheck="false" aria-label="Find in page"/>
      <span data-el="findn"></span>
      <button class="wb-ib" type="button" data-act="find-prev" title="Previous (⇧↵)">‹</button>
      <button class="wb-ib" type="button" data-act="find-next" title="Next (↵)">›</button>
      <button class="wb-ib" type="button" data-act="find-close" title="Done (esc)">×</button>
    </div>
    <div class="wb-sugg" data-el="sugg" hidden role="listbox"></div>
    <div class="wb-view" data-el="view"></div>
    <div class="wb-pop" data-el="pop" hidden role="menu"></div>
    <form class="wb-bmedit" data-el="bmedit" hidden role="dialog" aria-label="Edit bookmark"></form>
    <div class="wb-profiles" data-el="profiles" hidden></div>
    <div class="wb-profiles wb-exts" data-el="exts" hidden></div>
    <div class="wb-profiles wb-exts wb-dls" data-el="dls" hidden></div>`
  ;(document.getElementById('stage') ?? document.body).appendChild(root)
  const $ = <T extends HTMLElement = HTMLElement>(k: string) =>
    root.querySelector(`[data-el="${k}"]`) as T
  const strip = $('strip')
  const viewEl = $('view')
  const urlIn = $<HTMLInputElement>('url')
  const sugg = $('sugg')
  const pop = $('pop')
  const findBar = $('find')
  const findIn = $<HTMLInputElement>('findq')
  const dlBtn = $<HTMLButtonElement>('dl')

  // header button: the count of open tabs while the dock is closed
  const hbtn = el('button', 'tool-btn icon wb-hbtn')
  hbtn.id = 'wb-btn'
  hbtn.type = 'button'
  hbtn.title = 'Browser (b)'
  hbtn.innerHTML = `${GLOBE}<b data-el="count" hidden></b>`
  const keys = document.getElementById('tool-keys')
  keys?.parentElement?.insertBefore(hbtn, keys)
  const countEl = hbtn.querySelector('b') as HTMLElement
  hbtn.addEventListener('click', () => toggle())

  let open = false
  let state: ShellState | null = null
  let editing = false // omnibox has the keyboard; state pushes must not overwrite it
  let suggSel = -1
  let popCleanup: (() => void) | null = null

  const activeTab = () => state?.tabs.find((t) => t.id === state?.active) ?? null
  const profileOf = (id: string) => state?.profiles.find((p) => p.id === id)
  const tab = (op: string, args: Record<string, unknown> = {}) => shell?.tab(op, args)

  // ------------------------------------------------------------- open / close ----
  function setOpen(on: boolean) {
    if (on === open) return
    open = on
    root.classList.toggle('on', on)
    document.body.classList.toggle('wb-open', on)
    try {
      localStorage.setItem('wb-open', on ? '1' : '')
    } catch {}
    if (on) {
      if (inShell && state && state.tabs.length === 0) newTab(state.defaultProfile)
      reportBounds()
      startSampling()
      if (activeTab()?.url) tab('focus', { id: state?.active })
      else urlIn.focus()
    } else {
      closePop()
      closeEditor(false)
      $('profiles').hidden = true
      $('exts').hidden = true
      $('dls').hidden = true
      hideFind()
      hideSugg()
      editing = false
      urlIn.blur()
      stopSampling()
      shell?.setBounds(null)
      // the shell now has no rectangle: the next open must send one even if nothing moved
      lastRect = ''
    }
    paintCount()
  }
  const toggle = () => setOpen(!open)

  // -------------------------------------------------------------- geometry ----
  let lastRect = ''
  function reportBounds() {
    if (!shell) return
    if (!open) return shell.setBounds(null)
    const r = viewEl.getBoundingClientRect()
    const key = [r.x, r.y, r.width, r.height].map(Math.round).join(',')
    if (key === lastRect) return
    lastRect = key
    shell.setBounds({ x: r.x, y: r.y, width: r.width, height: r.height })
  }
  new ResizeObserver(() => reportBounds()).observe(viewEl)
  addEventListener('resize', reportBounds)

  /**
   * Is anything of the page drawn over the view area? Sampled with elementFromPoint at six
   * points: a native view is not in the DOM, so a hit that is not the view placeholder is
   * page UI (spotlight, settings, a menu, the profiles panel, suggestions) that must show.
   */
  let covered = false
  let sampleTimer: ReturnType<typeof setInterval> | null = null
  let sampleRaf = 0
  function sample() {
    sampleRaf = 0
    if (!shell || !open) return
    const r = viewEl.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return
    const pts: [number, number][] = [
      [r.x + r.width / 2, r.y + r.height / 2],
      [r.x + 10, r.y + 10],
      [r.right - 10, r.y + 10],
      [r.x + 10, r.bottom - 10],
      [r.right - 10, r.bottom - 10],
      [r.x + r.width / 2, r.y + 10],
    ]
    // a card or menu over one edge can miss every point, so those are checked by their box too
    const floating = [
      ...document.querySelectorAll<HTMLElement>(
        '[role="tooltip"]:not([hidden]), [role="menu"]:not([hidden]), #wb [role="dialog"]:not([hidden])',
      ),
    ].some((e) => {
      if (viewEl.contains(e)) return false
      const b = e.getBoundingClientRect()
      return (
        b.width > 0 && b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top
      )
    })
    const hit =
      floating ||
      pts.some(([x, y]) => {
        const e = document.elementFromPoint(x, y)
        return e && e !== viewEl && !viewEl.contains(e)
      })
    if (hit !== covered) {
      covered = hit
      shell.setCovered(hit)
    }
  }
  const scheduleSample = () => {
    if (!sampleRaf) sampleRaf = requestAnimationFrame(sample)
  }
  const mo = new MutationObserver(scheduleSample)
  function startSampling() {
    mo.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'style', 'open'],
    })
    sampleTimer = setInterval(() => {
      reportBounds()
      sample()
    }, 300)
    scheduleSample()
  }
  function stopSampling() {
    mo.disconnect()
    if (sampleTimer) clearInterval(sampleTimer)
    sampleTimer = null
    // closed while page UI overlapped the view: clear it in the shell too, or the view stays
    // detached on the next open (sample() only reports changes)
    if (covered) shell?.setCovered(false)
    covered = false
  }

  // ----------------------------------------------------------------- paint ----
  function paint() {
    paintTabs()
    paintNav()
    paintView()
    paintDownload()
    paintBookmarks()
    paintCount()
    if (!$('profiles').hidden) paintProfiles()
    if (!$('dls').hidden) paintDownloads()
  }
  function paintCount() {
    const n = state?.tabs.length ?? 0
    countEl.hidden = open || n === 0
    countEl.textContent = String(n)
    hbtn.classList.toggle('on', open)
  }
  const tabTitle = (t: ShellTab) => t.title || hostOf(t.url) || 'New tab'
  function paintTabs() {
    strip.innerHTML = ''
    if (!state) return
    for (const t of state.tabs) {
      const p = profileOf(t.profile)
      const b = el('button', 'wb-tab')
      b.type = 'button'
      b.setAttribute('role', 'tab')
      b.dataset.id = t.id
      b.draggable = true
      b.title = `${tabTitle(t)}\n${t.url ?? ''}\n${p?.name ?? ''}`
      b.style.setProperty('--pc', p?.colour ?? '#888')
      b.classList.toggle('on', t.id === state.active)
      b.classList.toggle('loading', t.loading)
      b.classList.toggle('sleeping', t.sleeping)
      b.innerHTML = `<i class="wb-sep"></i>${
        t.favicon && !t.loading
          ? `<img class="wb-fav" src="${esc(t.favicon)}" alt="" referrerpolicy="no-referrer"/>`
          : '<i class="wb-fav"></i>'
      }<span class="wb-title">${esc(tabTitle(t))}</span>${
        t.audible || t.muted
          ? `<b class="wb-audio" data-x="mute" title="${t.muted ? 'Unmute' : 'Mute'} tab">${t.muted ? ICON.muted : ICON.audio}</b>`
          : ''
      }<span class="wb-x" data-x="close" title="Close (⌘W)">${ICON.x}</span>`
      const img = b.querySelector('img')
      if (img) img.onerror = () => img.replaceWith(el('i', 'wb-fav'))
      strip.appendChild(b)
    }
    strip.querySelector('.wb-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  /** the profile's extension icons, for the active tab (their badges and popups follow it) */
  function paintActions() {
    const t = activeTab()
    const pid = t?.profile ?? state?.defaultProfile
    const can = !!shell?.extensions && !!pid && !!customElements.get('browser-action-list')
    ;(root.querySelector('[data-act="exts"]') as HTMLElement).hidden = !shell?.extensions
    const box = $('actions')
    if (!can) return
    let list = box.querySelector<HTMLElement>('browser-action-list')
    if (!list) {
      list = document.createElement('browser-action-list')
      list.setAttribute('alignment', 'bottom right')
      box.appendChild(list)
    }
    const part = `persist:profile-${pid}`
    if (list.getAttribute('partition') !== part) list.setAttribute('partition', part)
    const tabId = t?.wcId != null ? String(t.wcId) : null
    if (tabId && list.getAttribute('tab') !== tabId) list.setAttribute('tab', tabId)
    else if (!tabId) list.removeAttribute('tab')
  }
  function paintNav() {
    paintActions()
    const t = activeTab()
    const p = t ? profileOf(t.profile) : profileOf(state?.defaultProfile ?? '')
    const prof = root.querySelector('.wb-prof') as HTMLElement
    prof.style.setProperty('--pc', p?.colour ?? '#888')
    $('profname').textContent = p?.name ?? '—'
    if (!editing) {
      urlIn.value = t?.url ?? ''
    }
    const lock = $('lock')
    lock.className = `wb-lock ${t?.url?.startsWith('https:') ? 'https' : t?.url ? 'plain' : ''}`
    lock.title = t?.url?.startsWith('https:') ? 'Secure connection' : t?.url ? 'Not secure' : ''
    root.classList.toggle('loading', !!t?.loading)
    ;(root.querySelector('[data-act="reload"]') as HTMLElement).innerHTML = t?.loading
      ? ICON.stop
      : ICON.reload
    ;(root.querySelector('[data-act="reload"]') as HTMLElement).title = t?.loading
      ? 'Stop (esc)'
      : 'Reload (⌘R)'
    for (const a of ['reload', 'find']) {
      ;(root.querySelector(`[data-act="${a}"]`) as HTMLButtonElement).disabled = !t?.url
    }
    const zoom = $<HTMLButtonElement>('zoom')
    const pct = Math.round((t?.zoom ?? 1) * 100)
    zoom.hidden = !t?.url || pct === 100
    zoom.textContent = `${pct}%`
    zoom.title = `Zoom ${pct}% for ${hostOf(t?.url ?? null)} · click for 100% (⌘0)`
    ;(root.querySelector('[data-act="back"]') as HTMLButtonElement).disabled =
      !t?.url || !t.canGoBack
    ;(root.querySelector('[data-act="fwd"]') as HTMLButtonElement).disabled =
      !t?.url || !t.canGoForward
  }
  function paintView() {
    const t = activeTab()
    if (!inShell) {
      viewEl.innerHTML = `<div class="wb-card wb-noshell">
        <h2>A browser inside Laika Orbit needs the desktop app</h2>
        <p>Web pages refuse to be framed by other pages, so this dock can only hold real
        Chromium tabs when Laika Orbit runs in its own window. Launch it from the repo:</p>
        <pre><code>pnpm shell</code><button type="button" class="ghost" data-act="copy-cmd">copy</button></pre>
        <p>The window is this page. Its browser keeps <b>one profile per account</b>, each with
        its own cookies and logins, all open at once, and every link in Laika Orbit opens there.</p>
      </div>`
      return
    }
    if (!state) return
    if (t?.url) {
      // the native view covers this; what is here shows only for a sleeping tab's instant
      viewEl.innerHTML = t.sleeping ? `<div class="wb-waking">${esc(hostOf(t.url))}</div>` : ''
      return
    }
    const p = t ? profileOf(t.profile) : null
    const recent = state.history.filter((h) => !t || h.profile === t.profile).slice(0, 9)
    const others = state.profiles
    viewEl.innerHTML = `<div class="wb-start">
      ${
        t
          ? `<div class="wb-start-prof"><i style="background:${esc(p?.colour)}"></i>${esc(p?.name)}<small>· new tab</small></div>`
          : ''
      }
      ${
        recent.length
          ? `<div class="wb-lt">Recent</div><div class="wb-recent">${recent
              .map(
                (h) =>
                  `<button type="button" class="wb-rc" data-url="${esc(h.url)}"><span>${esc(h.title || h.url)}</span><small>${esc(hostOf(h.url))}</small></button>`,
              )
              .join('')}</div>`
          : ''
      }
      <div class="wb-lt">${t ? 'Or a new tab in' : 'Open a tab in'}</div>
      <div class="wb-profcards">${others
        .map(
          (x) =>
            `<button type="button" class="wb-pcard" data-profile="${esc(x.id)}" style="--pc:${esc(x.colour)}"><i></i>${esc(x.name)}${x.id === state?.defaultProfile ? '<small>default</small>' : ''}</button>`,
        )
        .join(
          '',
        )}<button type="button" class="wb-pcard add" data-act="profiles"><i>+</i>profile</button></div>
      <div class="wb-hint">Type above to search or open a site · <kbd>⌘T</kbd> new tab · <kbd>⌘⇧T</kbd> new tab in a profile · <kbd>⇧⌥T</kbd> reopen a closed tab · <kbd>⌘⇧B</kbd> hide the browser</div>
    </div>`
  }
  /** the toolbar pill: what is downloading, or what just finished; a plain icon otherwise */
  function paintDownload() {
    const all = state?.downloads ?? []
    const d = all[0]
    dlBtn.hidden = !d
    if (!d) return
    const running = all.filter((x) => x.state === 'progressing')
    const fresh = Date.now() - d.at < 90_000
    if (running.length > 1) {
      const got = running.reduce((n, x) => n + x.received, 0)
      const total = running.reduce((n, x) => n + x.total, 0)
      dlBtn.textContent = `↓ ${running.length} files ${total ? `${Math.round((got / total) * 100)}%` : ''}`
    } else if (running[0]) {
      const r = running[0]
      dlBtn.textContent = `↓ ${r.name} ${r.total ? `${Math.round((r.received / r.total) * 100)}%` : ''}`
    } else if (fresh) {
      dlBtn.textContent = `${d.state === 'completed' ? '✓' : '✕'} ${d.name}`
    } else dlBtn.textContent = '↓'
    dlBtn.classList.toggle('idle', !running.length && !fresh)
    dlBtn.title = 'Downloads (⌥⌘L)'
  }
  const size = (n: number) =>
    n < 1024
      ? `${n} B`
      : n < 1024 ** 2
        ? `${(n / 1024).toFixed(0)} KB`
        : n < 1024 ** 3
          ? `${(n / 1024 ** 2).toFixed(1)} MB`
          : `${(n / 1024 ** 3).toFixed(2)} GB`
  function paintDownloads() {
    const box = $('dls')
    const all = state?.downloads ?? []
    const row = (d: ShellDownload) => {
      const pct = d.total ? Math.round((d.received / d.total) * 100) : 0
      const gone = d.state === 'completed' && d.exists === false
      const meta =
        d.state === 'progressing'
          ? `${d.total ? `${pct}% · ${size(d.received)} of ${size(d.total)}` : size(d.received)}`
          : gone
            ? 'Deleted or moved'
            : d.state === 'completed'
              ? `${size(d.total || d.received)} · ${hostOf(d.url ?? null)}`
              : d.state === 'cancelled'
                ? 'Cancelled'
                : 'Failed'
      const btn = (act: string, label: string) =>
        `<button type="button" class="wb-xbtn" data-act="${act}">${label}</button>`
      const actions =
        d.state === 'progressing'
          ? btn('dl-cancel', 'Cancel')
          : d.state === 'completed' && !gone
            ? btn('dl-show', 'Show in Finder')
            : d.url
              ? btn('dl-retry', 'Retry')
              : ''
      return `<div class="wb-xrow wb-dlrow ${d.state} ${gone ? 'gone' : ''}" data-id="${esc(d.id)}">
        <button type="button" class="wb-dlname" data-act="dl-open" ${d.state === 'completed' && !gone ? '' : 'disabled'} title="${esc(d.path)}"><b>${esc(d.name)}</b><small>${esc(meta)}</small>${
          d.state === 'progressing' ? `<i class="wb-dlbar"><i style="width:${pct}%"></i></i>` : ''
        }</button>
        ${actions}
        <button type="button" class="wb-ib" data-act="dl-remove" title="Remove from list" aria-label="Remove from list">${ICON.x}</button>
      </div>`
    }
    box.innerHTML = `<div class="wb-card wb-ext-card">
      <div class="wb-card-h"><h2>Downloads</h2><span>saved to your Downloads folder</span><button type="button" class="wb-ib" data-act="dls-close" title="Done (esc)">${ICON.close}</button></div>
      <div class="wb-xlist">${all.length ? all.map(row).join('') : '<p class="wb-xnone">Nothing downloaded yet.</p>'}</div>
      <div class="wb-xfoot"><button type="button" class="wb-xbtn" data-act="dl-folder">Open Downloads folder</button>${
        all.some((d) => d.state !== 'progressing')
          ? '<button type="button" class="wb-xbtn" data-act="dl-clear">Clear list</button>'
          : ''
      }<small>Files stay on disk when they leave the list.</small></div>
    </div>`
  }
  function showDownloads(on: boolean) {
    const box = $('dls')
    box.hidden = !on
    if (on) {
      closePop()
      $('profiles').hidden = true
      $('exts').hidden = true
      paintDownloads()
    } else if (activeTab()?.url) tab('focus', { id: state?.active })
    scheduleSample()
  }

  // -------------------------------------------------------------- profiles ----
  async function paintProfiles() {
    const box = $('profiles')
    if (!state) return
    const chrome = await shell!.chromeProfiles()
    const have = new Set(state.profiles.map((p) => p.name.toLowerCase()))
    const fromChrome = chrome.filter((c) => !have.has(c.name.toLowerCase()))
    box.innerHTML = `<div class="wb-card wb-prof-card">
      <div class="wb-card-h"><h2>Profiles</h2><span>each has its own cookies, logins and storage</span><button type="button" class="wb-ib" data-act="profiles-close" title="Done (esc)">×</button></div>
      <div class="wb-plist">${state.profiles
        .map(
          (p) => `<div class="wb-prow" data-profile="${esc(p.id)}" style="--pc:${esc(p.colour)}">
          <button type="button" class="wb-pdot" data-act="colour" title="Change colour"><i></i></button>
          <input class="wb-pname" value="${esc(p.name)}" aria-label="Profile name" data-act="rename"/>
          <span class="wb-pmeta">${state!.tabs.filter((t) => t.profile === p.id).length || 'no'} tab${state!.tabs.filter((t) => t.profile === p.id).length === 1 ? '' : 's'}</span>
          <button type="button" class="wb-pstar ${p.id === state!.defaultProfile ? 'on' : ''}" data-act="default" title="Default profile: where links from Laika Orbit open">${p.id === state!.defaultProfile ? '★' : '☆'}</button>
          <button type="button" class="wb-ib" data-act="open-in" title="New tab in this profile">+</button>
          <button type="button" class="wb-ib" data-act="remove" title="Remove profile and its data" ${state!.profiles.length < 2 ? 'disabled' : ''}>🗑</button>
        </div>`,
        )
        .join('')}</div>
      <form class="wb-padd" data-el="padd">
        <input placeholder="New profile name" aria-label="New profile name" maxlength="60"/>
        <div class="wb-swatches">${COLOURS.map((c, i) => `<label title="${c}"><input type="radio" name="colour" value="${c}" ${i === state!.profiles.length % COLOURS.length ? 'checked' : ''}/><i style="background:${c}"></i></label>`).join('')}</div>
        <button type="submit">Add</button>
      </form>
      ${
        fromChrome.length
          ? `<div class="wb-lt">From your Chrome <small>names and colours only; sign in once here</small></div>
      <div class="wb-chrome">${fromChrome
        .map(
          (c) =>
            `<button type="button" class="wb-pcard" data-chrome="${esc(c.name)}" data-colour="${esc(c.colour ?? '')}" style="--pc:${esc(c.colour ?? '#888')}"><i></i>${esc(c.name)}${c.person ? `<small>${esc(c.person)}</small>` : ''}</button>`,
        )
        .join('')}</div>`
          : ''
      }
    </div>`
  }
  // --------------------------------------------------------------- extensions ----
  let extsBusy = ''
  async function paintExtensions() {
    const box = $('exts')
    const pid = activeTab()?.profile ?? state?.defaultProfile
    if (!shell?.extensions || !pid) return
    const p = profileOf(pid)
    if (!box.innerHTML) box.innerHTML = '<div class="wb-card"><p>Loading extensions…</p></div>'
    const [installed, chrome] = (await Promise.all([
      shell.extensions('list', { profile: pid }),
      shell.extensions('chrome', { profile: pid }),
    ])) as [ShellExtension[], ChromeExtension[]]
    const warn =
      '<em class="wb-xwarn" title="Talks to a desktop app through native messaging, which this browser cannot do">needs its desktop app</em>'
    const fromChrome = chrome.filter((c) => !c.installed)
    box.innerHTML = `<div class="wb-card wb-ext-card">
      <div class="wb-card-h"><h2>Extensions</h2><span class="wb-xprof" style="--pc:${esc(p?.colour ?? '#888')}"><i></i>${esc(p?.name ?? '')}</span><span>each profile has its own</span><button type="button" class="wb-ib" data-act="exts-close" title="Done (esc)">${ICON.close}</button></div>
      <div class="wb-xlist">${
        installed.length
          ? installed
              .map(
                (
                  x,
                ) => `<div class="wb-xrow"><b>${esc(x.name)}</b><small>${esc(x.version)}</small>${x.nativeMessaging ? warn : ''}<span class="wb-xfill"></span>
                  <button type="button" class="wb-xbtn" data-act="ext-remove" data-id="${esc(x.id)}" ${extsBusy === x.id ? 'disabled' : ''}>Remove</button></div>`,
              )
              .join('')
          : '<p class="wb-xnone">No extensions in this profile yet.</p>'
      }</div>
      ${
        fromChrome.length
          ? `<div class="wb-lt">From your Chrome <small>installed fresh from the Chrome Web Store</small></div>
        <div class="wb-xlist">${fromChrome
          .map(
            (
              x,
            ) => `<div class="wb-xrow"><b>${esc(x.name)}</b>${x.nativeMessaging ? warn : ''}<span class="wb-xfill"></span>
              <button type="button" class="wb-xbtn add" data-act="ext-add" data-id="${esc(x.id)}" ${extsBusy === x.id ? 'disabled' : ''}>${extsBusy === x.id ? 'Adding…' : 'Add'}</button></div>`,
          )
          .join('')}</div>`
          : ''
      }
      <div class="wb-xfoot"><button type="button" class="wb-xbtn" data-act="ext-store">Browse the Chrome Web Store</button><small>Its “Add to Chrome” buttons install into this profile.</small></div>
    </div>`
  }
  function showExtensions(on: boolean) {
    const box = $('exts')
    box.hidden = !on
    if (on) {
      closePop()
      $('profiles').hidden = true
      $('dls').hidden = true
      box.innerHTML = ''
      paintExtensions()
    } else if (activeTab()?.url) tab('focus', { id: state?.active })
    scheduleSample()
  }
  async function extensionAction(act: string, id: string) {
    const pid = activeTab()?.profile ?? state?.defaultProfile
    if (!shell?.extensions || !pid) return
    if (act === 'ext-store') {
      showExtensions(false)
      return void shell.extensions('store', { profile: pid })
    }
    extsBusy = id
    await paintExtensions()
    const r = (await shell.extensions(act === 'ext-add' ? 'install' : 'remove', {
      profile: pid,
      id,
    })) as {
      error?: string
    }
    extsBusy = ''
    await paintExtensions()
    if (r && typeof r === 'object' && r.error)
      $('exts')
        .querySelector('.wb-xfoot')
        ?.insertAdjacentHTML('beforebegin', `<p class="wb-xerr">${esc(r.error)}</p>`)
  }

  function showProfiles(on: boolean) {
    const box = $('profiles')
    box.hidden = !on
    if (on) {
      closePop()
      $('exts').hidden = true
      $('dls').hidden = true
      paintProfiles().then(() => box.querySelector<HTMLInputElement>('.wb-padd input')?.focus())
    } else if (activeTab()?.url) tab('focus', { id: state?.active })
    scheduleSample()
  }

  // ------------------------------------------------------------- bookmarks ----
  // The bar shows the active tab's profile: each profile keeps its own bookmarks.
  const bmBar = $('bmarks')
  const bmList = $('bmlist')
  const bmMore = $<HTMLButtonElement>('bmmore')
  const bmEdit = $<HTMLFormElement>('bmedit')
  const starBtn = $<HTMLButtonElement>('star')
  const barProfile = () => activeTab()?.profile ?? state?.defaultProfile ?? ''
  const bookmarksOf = (pid = barProfile()) => state?.bookmarks?.[pid] ?? []
  const bm = (op: string, args: Record<string, unknown>) =>
    shell?.bookmark?.(op as 'add', { profile: barProfile(), ...args })
  const pageBookmark = () => {
    const t = activeTab()
    return t?.url ? bookmarksOf(t.profile).find((b) => b.url === t.url) : undefined
  }
  const favIcon = (src: string | null) =>
    src
      ? `<img class="wb-fav" src="${esc(src)}" alt="" referrerpolicy="no-referrer"/>`
      : '<i class="wb-fav"></i>'
  let barKey = ''
  function paintBookmarks() {
    const can = !!shell?.bookmark
    const t = activeTab()
    starBtn.hidden = !can || !t?.url
    const saved = !!pageBookmark()
    starBtn.classList.toggle('on', saved)
    starBtn.title = saved ? 'Edit bookmark (⌘D)' : 'Bookmark this tab (⌘D)'
    bmBar.hidden = !can || !state?.bookmarkBar
    if (bmBar.hidden) return
    bmBar.style.setProperty('--pc', profileOf(barProfile())?.colour ?? 'var(--n24)')
    const list = bookmarksOf()
    const key = JSON.stringify([barProfile(), list])
    if (key === barKey) return
    barKey = key
    bmList.innerHTML = list.length
      ? list
          .map(
            (b) =>
              `<button type="button" class="wb-bm" draggable="true" data-id="${esc(b.id)}" title="${esc(`${b.title}\n${b.url}`)}">${favIcon(b.favicon)}<span>${esc(b.title || hostOf(b.url))}</span></button>`,
          )
          .join('')
      : '<span class="wb-bmnone">Bookmark a page with <kbd>⌘D</kbd> or the star, or drag a tab here</span>'
    for (const img of bmList.querySelectorAll('img'))
      img.onerror = () => img.replaceWith(el('i', 'wb-fav'))
    fitBookmarks()
  }
  /** what does not fit goes behind », as in Chrome */
  function fitBookmarks() {
    const items = [...bmList.querySelectorAll<HTMLElement>('.wb-bm')]
    for (const b of items) b.hidden = false
    bmMore.hidden = true
    if (bmBar.hidden || !items.length) return
    bmMore.hidden = false
    // measured with » showing; once one spills, the rest follow it
    const room = bmList.clientWidth
    const first = items.findIndex((b) => b.offsetLeft + b.offsetWidth > room)
    for (const b of first < 0 ? [] : items.slice(first)) b.hidden = true
    bmMore.hidden = first < 0
  }
  new ResizeObserver(() => fitBookmarks()).observe(bmBar)
  function openBookmark(b: ShellBookmark, where: 'here' | 'tab' | 'front') {
    const t = activeTab()
    if (where === 'here' && t) {
      tab('navigate', { id: t.id, text: b.url })
      tab('focus', { id: t.id })
    } else if (where === 'here') newTab(barProfile(), b.url)
    else tab('open', { profile: barProfile(), url: b.url, activate: where === 'front' })
  }
  const bookmarkAt = (target: EventTarget | null) => {
    const id = (target as HTMLElement).closest<HTMLElement>('.wb-bm[data-id]')?.dataset.id
    return bookmarksOf().find((b) => b.id === id)
  }
  const whereFor = (e: MouseEvent) =>
    e.metaKey || e.ctrlKey ? (e.shiftKey ? 'front' : 'tab') : 'here'
  bmBar.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-el="bmmore"]')) {
      const hidden = [...bmList.querySelectorAll<HTMLElement>('.wb-bm[hidden]')]
      const list = bookmarksOf()
      return showPop(
        bmMore,
        hidden
          .map((h) => list.find((b) => b.id === h.dataset.id))
          .filter((b): b is ShellBookmark => !!b)
          .map((b) => ({
            label: b.title || hostOf(b.url),
            hint: hostOf(b.url),
            run: () => openBookmark(b, 'here'),
          })),
      )
    }
    const b = bookmarkAt(e.target)
    if (b) openBookmark(b, whereFor(e))
  })
  bmBar.addEventListener('auxclick', (e) => {
    const b = bookmarkAt(e.target)
    if (b && e.button === 1) openBookmark(b, e.shiftKey ? 'front' : 'tab')
  })
  bmBar.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    bm('menu', { id: bookmarkAt(e.target)?.id ?? null })
  })

  // the editor: under the star for this page, under its button for one from the bar
  let bmEditing: { id: string; profile: string } | null = null
  let editCleanup: (() => void) | null = null
  async function editBookmark(id?: string) {
    if (!shell?.bookmark) return
    if (bmEditing) closeEditor(true)
    const t = activeTab()
    const profile = barProfile()
    let b = id ? bookmarksOf(profile).find((x) => x.id === id) : pageBookmark()
    let fresh = false
    if (!b) {
      if (id || !t?.url) return
      const title = tabTitle(t)
      const nid = (await bm('add', { url: t.url, title, favicon: t.favicon })) as string | null
      if (!nid) return
      b = { id: nid, url: t.url, title, favicon: t.favicon }
      fresh = true
    }
    showEditor(
      b,
      profile,
      fresh,
      id ? bmList.querySelector(`[data-id="${CSS.escape(b.id)}"]`) : null,
    )
  }
  function showEditor(b: ShellBookmark, profile: string, fresh: boolean, from: Element | null) {
    closePop()
    bmEditing = { id: b.id, profile }
    bmEdit.innerHTML = `<h3>${fresh ? 'Bookmark added' : 'Edit bookmark'}</h3>
      <label><span>Name</span><input data-f="title" value="${esc(b.title)}" spellcheck="false"/></label>
      <label><span>URL</span><input data-f="url" value="${esc(b.url)}" spellcheck="false"/></label>
      <div class="wb-bmfoot"><small>${esc(profileOf(profile)?.name ?? '')}</small><button type="button" class="wb-xbtn" data-act="bm-remove">Remove</button><button type="submit" class="wb-xbtn add">Done</button></div>`
    bmEdit.hidden = false
    const r = root.getBoundingClientRect()
    const anchor = (
      from && !(from as HTMLElement).hidden ? from : starBtn.hidden ? bmBar : starBtn
    ).getBoundingClientRect()
    const w = bmEdit.offsetWidth
    const left = from ? anchor.left - r.left : anchor.right - r.left - w
    bmEdit.style.left = `${Math.max(8, Math.min(left, r.width - w - 8))}px`
    bmEdit.style.top = `${anchor.bottom - r.top + 6}px`
    const input = bmEdit.querySelector<HTMLInputElement>('[data-f="title"]')!
    input.focus()
    input.select()
    const away = (e: Event) => {
      const n = e.target as Node
      if (!bmEdit.contains(n) && !starBtn.contains(n)) closeEditor(true)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeEditor(false)
      }
    }
    setTimeout(() => document.addEventListener('pointerdown', away, true))
    bmEdit.addEventListener('keydown', key)
    editCleanup = () => {
      document.removeEventListener('pointerdown', away, true)
      bmEdit.removeEventListener('keydown', key)
    }
    scheduleSample()
  }
  function closeEditor(keep: boolean) {
    if (!bmEditing) return
    const { id, profile } = bmEditing
    if (keep) {
      const f = (k: string) =>
        bmEdit.querySelector<HTMLInputElement>(`[data-f="${k}"]`)?.value ?? ''
      shell?.bookmark?.('update', { profile, id, title: f('title'), url: f('url') })
    }
    bmEditing = null
    editCleanup?.()
    editCleanup = null
    bmEdit.hidden = true
    scheduleSample()
    if (activeTab()?.url && document.activeElement !== urlIn) tab('focus', { id: state?.active })
  }
  bmEdit.addEventListener('submit', (e) => {
    e.preventDefault()
    closeEditor(true)
  })

  // ------------------------------------------------------------------ menus ----
  type PopItem = {
    label: string
    dot?: string
    hint?: string
    run: () => void
  }
  function showPop(anchor: HTMLElement, items: PopItem[]) {
    closePop()
    pop.innerHTML = items
      .map(
        (it, i) =>
          `<button type="button" role="menuitem" data-i="${i}">${it.dot ? `<i style="background:${esc(it.dot)}"></i>` : '<i class="none"></i>'}<span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</button>`,
      )
      .join('')
    const a = anchor.getBoundingClientRect()
    const r = root.getBoundingClientRect()
    pop.style.left = `${Math.min(a.left - r.left, r.width - 260)}px`
    pop.style.top = `${a.bottom - r.top + 4}px`
    pop.hidden = false
    pop.querySelector('button')?.focus()
    pop.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-i]')
      if (!b) return
      closePop()
      items[Number(b.dataset.i)]?.run()
    }
    const away = (e: Event) => {
      if (!pop.contains(e.target as Node) && e.target !== anchor) closePop()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePop()
    }
    setTimeout(() => {
      document.addEventListener('pointerdown', away, true)
      document.addEventListener('keydown', key, true)
    })
    popCleanup = () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', key, true)
    }
    scheduleSample()
  }
  function closePop() {
    pop.hidden = true
    popCleanup?.()
    popCleanup = null
    scheduleSample()
  }
  function profileMenu(anchor: HTMLElement, url: string | null) {
    if (!state) return
    const items: PopItem[] = state.profiles.map((p) => ({
      label: url ? `Open here in ${p.name}` : `New tab in ${p.name}`,
      dot: p.colour,
      hint: p.id === state?.defaultProfile ? 'default' : '',
      run: () => newTab(p.id, url ?? undefined),
    }))
    items.push({ label: 'Manage profiles…', run: () => showProfiles(true) })
    showPop(anchor, items)
  }

  // ---------------------------------------------------------------- actions ----
  async function newTab(profile: string, url?: string) {
    if (!shell) return
    setOpen(true)
    await tab('open', { profile, url: url ?? null })
    if (!url) {
      editing = false
      urlIn.value = ''
      urlIn.focus()
    }
  }
  function navigate(text: string) {
    const t = activeTab()
    if (!text.trim()) return
    if (t) tab('navigate', { id: t.id, text })
    else tab('open', { profile: state?.defaultProfile, url: text })
    editing = false
    hideSugg()
    urlIn.blur()
  }
  function openUrl(url: string) {
    if (shell) newTab(state?.defaultProfile ?? '', url)
    else window.open(url, '_blank', 'noopener')
  }

  // omnibox
  urlIn.addEventListener('focus', () => {
    editing = true
    setTimeout(() => urlIn.select(), 0)
  })
  urlIn.addEventListener('blur', () => {
    // a click on a suggestion blurs first; keep the list for that click
    setTimeout(() => {
      if (document.activeElement !== urlIn) {
        editing = false
        hideSugg()
        paintNav()
      }
    }, 120)
  })
  urlIn.addEventListener('input', () => paintSugg(urlIn.value))
  $('omni').addEventListener('submit', (e) => {
    e.preventDefault()
    const pick = suggSel >= 0 ? sugg.children[suggSel] : null
    navigate((pick as HTMLElement | null)?.dataset.url ?? urlIn.value)
  })
  urlIn.addEventListener('keydown', (e) => {
    // ⌘↵ / ⌥↵: open what was typed in a new tab, leaving this one where it is
    if (e.key === 'Enter' && (e.metaKey || e.altKey) && activeTab()?.url) {
      e.preventDefault()
      const pick = suggSel >= 0 ? (sugg.children[suggSel] as HTMLElement) : null
      const text = pick?.dataset.url ?? urlIn.value
      if (!text.trim()) return
      editing = false
      hideSugg()
      urlIn.blur()
      return void newTab(activeTab()!.profile, text)
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      editing = false
      hideSugg()
      paintNav()
      urlIn.blur()
      if (activeTab()?.url) tab('focus', { id: state?.active })
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (sugg.hidden) return
      e.preventDefault()
      const n = sugg.children.length
      suggSel = (suggSel + (e.key === 'ArrowDown' ? 1 : -1) + n + 1) % (n + 1)
      if (suggSel === n) suggSel = -1
      for (const [i, c] of [...sugg.children].entries()) c.classList.toggle('sel', i === suggSel)
    }
  })
  function hideSugg() {
    sugg.hidden = true
    sugg.innerHTML = ''
    suggSel = -1
    scheduleSample()
  }
  function paintSugg(q: string) {
    const t = activeTab()
    const needle = q.trim().toLowerCase()
    if (!state || !needle) return hideSugg()
    const rows = state.history
      .filter(
        (h) =>
          (!t || h.profile === t.profile) &&
          (h.url.toLowerCase().includes(needle) || h.title.toLowerCase().includes(needle)),
      )
      .slice(0, 6)
    const looksLikeUrl =
      /^(\/|~\/|file:)/.test(needle) || (!/\s/.test(needle) && /[.:]/.test(needle))
    sugg.innerHTML =
      `<button type="button" role="option" data-url="${esc(q)}"><i class="wb-sg ${looksLikeUrl ? 'go' : 'q'}"></i><span>${esc(q)}</span><small>${looksLikeUrl ? 'open' : 'search'}</small></button>` +
      rows
        .map(
          (h) =>
            `<button type="button" role="option" data-url="${esc(h.url)}"><i class="wb-sg h"></i><span>${esc(h.title || h.url)}</span><small>${esc(hostOf(h.url))}</small></button>`,
        )
        .join('')
    suggSel = -1
    sugg.hidden = false
    scheduleSample()
  }
  sugg.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-url]')
    if (b) navigate(b.dataset.url ?? '')
  })

  // find bar
  function showFind() {
    if (!activeTab()?.url) return
    findBar.hidden = false
    findIn.focus()
    findIn.select()
    if (findIn.value) tab('find', { id: state?.active, text: findIn.value })
  }
  function hideFind() {
    if (findBar.hidden) return
    findBar.hidden = true
    $('findn').textContent = ''
    tab('stop-find', { id: state?.active })
    if (activeTab()?.url) tab('focus', { id: state?.active })
  }
  findIn.addEventListener('input', () =>
    tab('find', { id: state?.active, text: findIn.value, next: false }),
  )
  findIn.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return hideFind()
    if (e.key === 'Enter') {
      e.preventDefault()
      tab('find', {
        id: state?.active,
        text: findIn.value,
        next: true,
        forward: !e.shiftKey,
      })
    }
  })
  shell?.onFind((r) => {
    if (r.tab === state?.active)
      $('findn').textContent = r.total ? `${r.active}/${r.total}` : 'none'
  })

  // clicks
  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const t = activeTab()
    const act = target.closest<HTMLElement>('[data-act]')?.dataset.act
    const tabBtn = target.closest<HTMLElement>('.wb-tab')
    if (tabBtn) {
      const id = tabBtn.dataset.id!
      const x = target.closest<HTMLElement>('[data-x]')?.dataset.x
      if (x === 'close') return void tab('close', { id })
      if (x === 'mute') {
        const tt = state?.tabs.find((y) => y.id === id)
        return void tab('mute', { id, on: !tt?.muted })
      }
      return void tab('activate', { id })
    }
    const rc = target.closest<HTMLElement>('.wb-rc')
    if (rc) return navigate(rc.dataset.url ?? '')
    const pc = target.closest<HTMLElement>('.wb-pcard[data-profile]')
    if (pc) return void newTab(pc.dataset.profile!)
    const cp = target.closest<HTMLElement>('.wb-pcard[data-chrome]')
    if (cp) {
      shell?.profile('create', {
        name: cp.dataset.chrome,
        colour: cp.dataset.colour || undefined,
      })
      return
    }
    const prow = target.closest<HTMLElement>('.wb-prow')
    const pid = prow?.dataset.profile
    switch (act) {
      case 'new':
        return void newTab(t?.profile ?? state?.defaultProfile ?? '')
      case 'back':
        return void tab('back', { id: t?.id })
      case 'fwd':
        return void tab('forward', { id: t?.id })
      case 'reload':
        return void tab(t?.loading ? 'stop' : 'reload', { id: t?.id })
      case 'prof':
        return profileMenu(target.closest('[data-act]')!, t?.url ?? null)
      case 'find':
        return showFind()
      case 'find-next':
        return void tab('find', { id: t?.id, text: findIn.value, next: true })
      case 'find-prev':
        return void tab('find', {
          id: t?.id,
          text: findIn.value,
          next: true,
          forward: false,
        })
      case 'find-close':
        return hideFind()
      case 'profiles':
        return showProfiles($('profiles').hidden)
      case 'profiles-close':
        return showProfiles(false)
      case 'exts':
        return showExtensions($('exts').hidden)
      case 'exts-close':
        return showExtensions(false)
      case 'ext-add':
      case 'ext-remove':
      case 'ext-store':
        return void extensionAction(act, target.closest<HTMLElement>('[data-id]')?.dataset.id ?? '')
      case 'star':
        return void (bmEditing ? closeEditor(true) : editBookmark())
      case 'bm-remove': {
        const ed = bmEditing
        closeEditor(false)
        return void (ed && shell?.bookmark?.('remove', ed))
      }
      case 'zoom-reset':
        return void tab('zoom', { id: t?.id, dir: 0 })
      case 'dls-close':
        return showDownloads(false)
      case 'dl-folder':
        return void shell?.download('folder')
      case 'dl-clear':
        return void shell?.download('clear')
      case 'dl-open':
      case 'dl-show':
      case 'dl-cancel':
      case 'dl-retry':
      case 'dl-remove': {
        const id = target.closest<HTMLElement>('.wb-dlrow')?.dataset.id
        const op = act.slice(3) as 'open' | 'show' | 'cancel' | 'retry' | 'remove'
        return void (id && shell?.download(op, id))
      }
      case 'close':
        return setOpen(false)
      case 'copy-cmd':
        navigator.clipboard?.writeText('pnpm shell').catch(() => {})
        target.textContent = 'copied'
        return
      case 'default':
        return void shell?.profile('default', { id: pid })
      case 'remove':
        return void shell?.profile('remove', { id: pid })
      case 'open-in':
        showProfiles(false)
        return void newTab(pid!)
      case 'colour': {
        const p = pid ? profileOf(pid) : null
        if (!p) return
        const next = COLOURS[(COLOURS.indexOf(p.colour) + 1) % COLOURS.length]
        return void shell?.profile('update', { id: pid, colour: next })
      }
    }
  })
  root.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement
    if (input.dataset.act === 'rename') {
      const pid = input.closest<HTMLElement>('.wb-prow')?.dataset.profile
      if (pid && input.value.trim()) shell?.profile('update', { id: pid, name: input.value })
    }
  })
  root.addEventListener('submit', (e) => {
    const form = e.target as HTMLFormElement
    if (form.dataset.el !== 'padd') return
    e.preventDefault()
    const name = form.querySelector<HTMLInputElement>('input:not([type=radio])')!
    const colour = form.querySelector<HTMLInputElement>('input[name=colour]:checked')?.value
    if (!name.value.trim()) return
    shell?.profile('create', { name: name.value, colour })
    name.value = ''
  })
  root.querySelector('[data-act="new"]')!.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    profileMenu(e.currentTarget as HTMLElement, null)
  })
  strip.addEventListener('contextmenu', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.wb-tab')
    if (!b) return
    e.preventDefault()
    tab('menu', { id: b.dataset.id })
  })
  // double-click the empty strip for a new tab, as in Chrome
  strip.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('.wb-tab')) return
    newTab(activeTab()?.profile ?? state?.defaultProfile ?? '')
  })
  strip.addEventListener('auxclick', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.wb-tab')
    if (b && e.button === 1) tab('close', { id: b.dataset.id })
  })
  dlBtn.addEventListener('click', () => showDownloads($('dls').hidden))
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('profiles').hidden) showProfiles(false)
    if (e.key === 'Escape' && !$('exts').hidden) showExtensions(false)
    if (e.key === 'Escape' && !$('dls').hidden) showDownloads(false)
  })

  // tab reorder by drag
  let dragId: string | null = null
  strip.addEventListener('dragstart', (e) => {
    dragId = (e.target as HTMLElement).closest<HTMLElement>('.wb-tab')?.dataset.id ?? null
    e.dataTransfer?.setData('text/plain', dragId ?? '')
  })
  strip.addEventListener('dragover', (e) => {
    if (dragId) e.preventDefault()
  })
  strip.addEventListener('drop', (e) => {
    e.preventDefault()
    const over = (e.target as HTMLElement).closest<HTMLElement>('.wb-tab')
    if (!dragId || !state) return
    const ids = state.tabs.map((t) => t.id)
    let index = over ? ids.indexOf(over.dataset.id!) : ids.length - 1
    const from = ids.indexOf(dragId)
    if (from < index && over) {
      const r = over.getBoundingClientRect()
      if (e.clientX < r.left + r.width / 2) index--
    } else if (over) {
      const r = over.getBoundingClientRect()
      if (e.clientX > r.left + r.width / 2) index++
    }
    tab('move', { id: dragId, index: Math.max(0, index) })
    dragId = null
  })
  strip.addEventListener('dragend', () => {
    dragId = null
  })

  // bookmarks: reorder by drag; a tab or a link dropped on the bar is bookmarked there
  let bmDrag: string | null = null
  const clearDrop = () => {
    for (const x of bmList.querySelectorAll('.drop, .drop-after'))
      x.classList.remove('drop', 'drop-after')
  }
  /** where a drop lands: the index in the profile's list, and the button to mark */
  function dropSpot(e: DragEvent) {
    const items = [...bmList.querySelectorAll<HTMLElement>('.wb-bm:not([hidden])')]
    const before = items.find((b) => {
      const r = b.getBoundingClientRect()
      return e.clientX < r.left + r.width / 2
    })
    const ids = bookmarksOf().map((b) => b.id)
    return before
      ? { index: ids.indexOf(before.dataset.id!), mark: before, after: false }
      : { index: ids.length, mark: items.at(-1) ?? null, after: true }
  }
  bmList.addEventListener('dragstart', (e) => {
    bmDrag = (e.target as HTMLElement).closest<HTMLElement>('.wb-bm')?.dataset.id ?? null
    const b = bookmarksOf().find((x) => x.id === bmDrag)
    if (b) {
      e.dataTransfer?.setData('text/uri-list', b.url)
      e.dataTransfer?.setData('text/plain', b.url)
    }
  })
  bmList.addEventListener('dragend', () => {
    bmDrag = null
    clearDrop()
  })
  bmBar.addEventListener('dragover', (e) => {
    if (!bmDrag && !dragId && !e.dataTransfer?.types.includes('text/uri-list')) return
    e.preventDefault()
    clearDrop()
    const { mark, after } = dropSpot(e)
    mark?.classList.add(after ? 'drop-after' : 'drop')
  })
  bmBar.addEventListener('dragleave', (e) => {
    if (!bmBar.contains(e.relatedTarget as Node)) clearDrop()
  })
  bmBar.addEventListener('drop', async (e) => {
    e.preventDefault()
    clearDrop()
    let { index } = dropSpot(e)
    if (bmDrag) {
      const from = bookmarksOf().findIndex((b) => b.id === bmDrag)
      if (from >= 0 && from < index) index--
      bm('move', { id: bmDrag, index })
      bmDrag = null
      return
    }
    const t = dragId ? state?.tabs.find((x) => x.id === dragId) : null
    dragId = null
    const url =
      t?.url ??
      e.dataTransfer
        ?.getData('text/uri-list')
        .split(/\r?\n/)
        .find((l) => l && !l.startsWith('#'))
    if (!url) return
    const id = await bm('add', {
      url,
      title: t ? tabTitle(t) : hostOf(url),
      favicon: t?.favicon ?? null,
    })
    if (id) bm('move', { id, index })
  })

  // ------------------------------------------------------------- shell wiring ----
  if (shell) {
    shell.onState((s) => {
      state = s
      paint()
    })
    shell.onCommand((c) => {
      switch (c.cmd) {
        case 'open':
          return setOpen(true)
        case 'toggle':
          return toggle()
        case 'focus-omnibox':
          setOpen(true)
          editing = false
          urlIn.focus()
          return
        case 'find':
          return showFind()
        case 'downloads':
          setOpen(true)
          return showDownloads(true)
        case 'bookmark-edit':
          setOpen(true)
          return void editBookmark(c.id)
        case 'spotlight':
          return host.spotlight()
        case 'pick-profile':
          setOpen(true)
          return profileMenu(root.querySelector('[data-act="new"]')!, null)
      }
    })
    shell.state().then((s) => {
      state = s
      paint()
      let wanted = false
      try {
        wanted = localStorage.getItem('wb-open') === '1'
      } catch {}
      if (wanted) setOpen(true)
    })
  } else paint()

  return {
    open: (on = true) => setOpen(on),
    toggle,
    isOpen: () => open,
    openUrl,
    inShell,
  }
}
