/**
 * Laika Orbit shell: the dashboard as a desktop window, with a browser inside it.
 *
 * The window is the :5200 page, unchanged. The browser is a set of Chromium WebContentsViews
 * drawn over the page's browser dock, one per tab, each bound to a *profile*: its own
 * cookie jar, storage and cache (`persist:profile-<id>`), so several accounts can be signed
 * in at once, in one window. Real Chrome cannot do that without a window per profile.
 *
 * The page owns the UI (tab strip, omnibox, profiles); this process owns the tabs. They
 * talk over the preload bridge: the page sends the dock's rectangle and every tab action,
 * this process pushes the state snapshot after every change.
 *
 * Starts the app server if nothing is listening on APP_URL (default :5200).
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  MenuItem,
  nativeTheme,
  screen,
  session,
  shell,
  WebContentsView,
  webContents,
} from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { installChromeWebStore, installExtension, uninstallExtension } from 'electron-chrome-web-store'
import { chromeProfiles } from './chrome-profiles.mjs'
import { orbitKey } from './orbit-keys.mjs'
import { readState } from './state-file.mjs'
import { publicTab } from './tab-state.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// Inside the .app built by make-app.mjs, repo.json says where the checkout is and which node
// to use: an app launched from the Dock has none of the terminal's environment. It also names
// the app, its port and its profile folder, so a stable build and a dev build run side by side.
// the Dock app's launcher hands over its repo.json; `pnpm shell` from the checkout has none
const REPO = globalThis.__laikaRepo ?? (existsSync(join(HERE, 'repo.json')) ? JSON.parse(readFileSync(join(HERE, 'repo.json'), 'utf8')) : null)
const PORT = String(REPO?.port ?? process.env.PORT ?? 5200)
/**
 * The window loads the app over `localhost`, never `127.0.0.1`, even though the server binds the
 * loopback address either name reaches. The two are the same machine but not the same origin, and
 * YouTube refuses to play an embed whose page origin is a bare IP: its /embed response comes back
 * `playabilityStatus: UNPLAYABLE` for `http://127.0.0.1:<port>` and `OK` for `http://localhost:<port>`,
 * with everything else held identical. That is decided by the page's Referer, so nothing inside the
 * player (youtube.ts) can work around it — the frame's own origin has to be a name. An APP_URL
 * given by hand is normalised the same way, so a dev build cannot quietly lose video either.
 */
const APP_URL = (process.env.APP_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '').replace(/^(https?:\/\/)127\.0\.0\.1(?=[:/]|$)/, '$1localhost')
const APP_ORIGIN = new URL(APP_URL).origin
const SERVER = REPO ? join(REPO.root, 'packages/app/server.mjs') : resolve(HERE, '../app/server.mjs')
const NODE = REPO?.node ?? 'node'
const SEARCH = process.env.SHELL_SEARCH ?? 'https://www.google.com/search?q=%s'
const SMOKE = process.env.LAIKA_SHELL_SMOKE // a directory: run the self-test and write screenshots there
/**
 * LAIKA_SHELL_HIDDEN=1: a test copy that stays out of your way, yet still draws (so CDP
 * screenshots and a remote-debugging driver work). Every window it makes is fully transparent,
 * lets every click through, can never take focus and stays out of Mission Control; there is no
 * Dock icon and no pop-out comes back. (Moving the window off screen is not enough: macOS puts
 * it back on screen, which is how an earlier version kept appearing over your work.) Pair it
 * with LAIKA_SHELL_USER_DATA and PORT.
 */
const HIDDEN = process.env.LAIKA_SHELL_HIDDEN === '1'
if (HIDDEN) {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.on('browser-window-created', (_e, w) => {
    w.setOpacity(0)
    w.setIgnoreMouseEvents(true)
    w.setFocusable(false)
    w.setHiddenInMissionControl?.(true)
  })
}
// one Chrome-looking UA for every profile: Google's sign-in refuses anything that says "Electron"
const UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
const COLOURS = ['#5b9dff', '#ff7a45', '#3ddc97', '#c07bff', '#ffc94f', '#ff4f9d', '#4fe0e0', '#a3d15c']
const MAX_HISTORY = 400
const isHttp = (u) => /^https?:/i.test(u)

app.setName(REPO?.name ?? 'Laika Orbit')
// the self-test keeps its profiles and tabs to itself; each installed app has its own folder
app.setPath(
  'userData',
  process.env.LAIKA_SHELL_USER_DATA ?? (SMOKE ? join(SMOKE, 'userData') : join(app.getPath('appData'), REPO?.userData ?? 'Laika Orbit')),
)
app.userAgentFallback = UA
nativeTheme.themeSource = 'dark'
const STATE_FILE = join(app.getPath('userData'), 'browser.json')

// ------------------------------------------------------------------ state ----
/** @type {{profiles: {id:string,name:string,colour:string}[], defaultProfile: string|null, history: any[], window: any, popouts: Record<string, any>, zoom: Record<string, Record<string, number>>, appZoom: number, bookmarks: Record<string, {id:string,url:string,title:string,favicon:string|null}[]>, bookmarkBar: boolean}} */
let store = { profiles: [], defaultProfile: null, history: [], window: null, popouts: {}, zoom: {}, appZoom: 1, bookmarks: {}, bookmarkBar: true }
/** @type {{id:string, profile:string, url:string|null, title:string, favicon:string|null, loading:boolean, audible:boolean, muted:boolean, failed:any, opener:string|null, nav:any, zoom:number, view:WebContentsView|null}[]} */
let tabs = []
let active = null
/** tabs shown side by side: a on the left, b on the right, ratio = a's share of the width */
let splits = []
let closed = [] // recently closed, for ⇧⌥T: where they sat and their back/forward history
let downloads = [] // newest first, kept across launches
const MAX_DOWNLOADS = 30
const liveDownloads = new Map() // id → DownloadItem, while it runs
let bounds = null // dock rectangle from the page; null = dock closed
let covered = false // page UI drawn over the dock; the view steps aside
let win = null
let serverChild = null
let nextId = 1
const sessions = new Map()
const permissionMemo = new Map()

async function loadStore() {
  try {
    const raw = await readState(STATE_FILE)
    if (!raw) throw new Error('no saved state')
    store = { ...store, ...raw }
    // tabs come back asleep: no renderer until one is activated
    for (const t of raw.tabs ?? []) {
      if (!store.profiles.some((p) => p.id === t.profile)) continue
      const tab = blankTab(t.profile, t.url, t.title)
      if (Array.isArray(t.nav?.entries) && t.nav.entries[t.nav.index]) tab.nav = t.nav
      tabs.push(tab)
    }
    // tab ids restart each launch; the saved `active` is an index into the saved list
    active = tabs[raw.active]?.id ?? tabs[0]?.id ?? null
    // saved splits name their tabs by index too
    for (const x of raw.splits ?? []) {
      const [a, b] = [tabs[x.a], tabs[x.b]]
      if (a && b && a !== b && !splitOf(a.id) && !splitOf(b.id)) splits.push({ a: a.id, b: b.id, ratio: clampRatio(x.ratio) })
    }
    // a download the last launch did not finish cannot resume: it stopped when the app did
    downloads = (raw.downloads ?? []).map((d) => (d.state === 'progressing' ? { ...d, state: 'interrupted' } : d))
  } catch {}
  store.zoom ??= {}
  store.bookmarks ??= {}
  if (store.profiles.length === 0) {
    store.profiles.push({ id: newId(), name: 'Personal', colour: COLOURS[0] })
  }
  if (!store.profiles.some((p) => p.id === store.defaultProfile)) store.defaultProfile = store.profiles[0].id
}

function storeData() {
  return {
    profiles: store.profiles,
    defaultProfile: store.defaultProfile,
    history: store.history.slice(0, MAX_HISTORY),
    window: win && !win.isDestroyed() ? win.getNormalBounds() : store.window,
    tabs: tabs.map((t) => ({ profile: t.profile, url: t.url, title: t.title, nav: tabHistory(t) })),
    active: tabs.findIndex((t) => t.id === active),
    splits: splits.map((x) => ({ a: tabs.findIndex((t) => t.id === x.a), b: tabs.findIndex((t) => t.id === x.b), ratio: x.ratio })),
    popouts: store.popouts,
    zoom: store.zoom,
    appZoom: store.appZoom,
    bookmarks: store.bookmarks,
    bookmarkBar: store.bookmarkBar,
    downloads: downloads.slice(0, MAX_DOWNLOADS),
  }
}
let saveTimer = null
let saving = null // the write in flight; another waits for it rather than racing it
function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    await saving
    saving = (async () => {
      const tmp = `${STATE_FILE}.tmp`
      await mkdir(dirname(STATE_FILE), { recursive: true })
      await writeFile(tmp, JSON.stringify(storeData(), null, 2))
      await rename(tmp, STATE_FILE)
    })().catch((e) => console.error('saving browser.json:', e?.message))
    await saving
    saving = null
  }, 400)
}

const newId = () => Math.random().toString(36).slice(2, 10)
const blankTab = (profile, url = null, title = '') => ({
  id: String(nextId++),
  profile,
  url,
  title,
  favicon: null,
  loading: false,
  audible: false,
  muted: false,
  failed: null,
  opener: null, // the tab a link opened this from: its next links line up after this one
  nav: null, // back/forward history kept while the tab has no renderer: {entries, index}
  zoom: 1, // page zoom factor, for the toolbar's indicator
  view: null,
  heard: false, // you let this page play sound (it started while shown, or you unmuted it)
  sleepTimer: null, // suspends the tab once it has been out of view for SLEEP_AFTER_MS
  gone: null, // why its page crashed or was ended (render-process-gone), until reloaded
  hung: false, // its page stopped answering
})
const tabOf = (id) => tabs.find((t) => t.id === id)
const activeTab = () => tabOf(active)
const profileOf = (id) => store.profiles.find((p) => p.id === id)

function snapshot() {
  return {
    profiles: store.profiles,
    defaultProfile: store.defaultProfile,
    tabs: tabs.map((t) =>
      publicTab(t, { sleeping: !!t.url && !t.view, wcId: t.view?.webContents.id ?? null, canGoBack: canStep(t, -1), canGoForward: canStep(t, 1) }),
    ),
    active,
    splits,
    history: store.history.slice(0, 120),
    bookmarks: store.bookmarks,
    bookmarkBar: store.bookmarkBar,
    // a finished file you have since moved or deleted shows as gone, not as openable
    downloads: downloads.slice(0, MAX_DOWNLOADS).map((d) => ({ ...d, exists: d.state === 'completed' && existsSync(d.path) })),
    dockOpen: bounds !== null,
    popouts: [...pops.keys()],
    versions: { electron: process.versions.electron, chrome: process.versions.chrome },
  }
}
let pushQueued = false
function push() {
  if (pushQueued) return
  pushQueued = true
  setImmediate(() => {
    pushQueued = false
    if (win && !win.isDestroyed()) win.webContents.send('shell:state', snapshot())
    save()
  })
}
const cmd = (name, args = {}) => win?.webContents.send('shell:cmd', { cmd: name, ...args })

// --------------------------------------------------------------- sessions ----
function sessionFor(profileId) {
  if (sessions.has(profileId)) return sessions.get(profileId)
  const ses = session.fromPartition(`persist:profile-${profileId}`)
  ses.setUserAgent(UA)
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const origin = safeOrigin(details.requestingUrl ?? wc.getURL())
    if (['fullscreen', 'clipboard-read', 'clipboard-sanitized-write', 'notifications', 'pointerLock', 'keyboardLock', 'window-management'].includes(permission)) return cb(true)
    if (['media', 'geolocation', 'display-capture', 'midi', 'midiSysex', 'openExternal'].includes(permission)) {
      const key = `${profileId}|${origin}|${permission}`
      if (permissionMemo.has(key)) return cb(permissionMemo.get(key))
      const what = { media: 'use your camera or microphone', geolocation: 'know your location', 'display-capture': 'record your screen', midi: 'use MIDI devices', midiSysex: 'use MIDI devices', openExternal: 'open another app' }[permission]
      // a tab asks in its own bar above the page; a sheet over the window blocked all of Orbit
      const t = tabs.find((x) => x.view?.webContents === wc)
      if (t) return askInTab(t, { key, origin, what }, cb)
      dialog
        .showMessageBox(win, { type: 'question', buttons: ['Allow', 'Block'], defaultId: 1, cancelId: 1, message: `${origin} wants to ${what}`, detail: `Profile: ${profileOf(profileId)?.name ?? profileId}` })
        .then(({ response }) => {
          const ok = response === 0
          permissionMemo.set(key, ok)
          cb(ok)
        })
      return
    }
    cb(false)
  })
  ses.on('will-download', (_e, item) => {
    const dir = join(homedir(), 'Downloads')
    let name = item.getFilename()
    const ext = extname(name)
    const stem = basename(name, ext)
    // a file of that name on disk, or one still arriving (it has no file yet), takes the next number
    const taken = (n) => existsSync(join(dir, n)) || downloads.some((d) => d.state === 'progressing' && d.name === n)
    for (let n = 1; taken(name); n++) name = `${stem} (${n})${ext}`
    const path = join(dir, name)
    item.setSavePath(path)
    const d = { id: newId(), name, path, url: item.getURL(), profile: profileId, state: 'progressing', received: 0, total: item.getTotalBytes(), at: Date.now() }
    downloads.unshift(d)
    downloads = downloads.slice(0, MAX_DOWNLOADS)
    liveDownloads.set(d.id, item)
    item.on('updated', (_e2, state) => {
      d.state = state
      d.received = item.getReceivedBytes()
      d.total = item.getTotalBytes()
      dockProgress()
      push()
    })
    item.once('done', (_e2, state) => {
      d.state = state
      d.received = item.getReceivedBytes()
      d.at = Date.now()
      liveDownloads.delete(d.id)
      if (state === 'completed') app.dock?.downloadFinished(path)
      dockProgress()
      push()
    })
    dockProgress()
    push()
  })
  sessions.set(profileId, ses)
  // extensions must know the session before any tab in it exists
  extensionsFor(profileId)
  return ses
}
/**
 * A page's permission request, asked in its tab: the dock shows a bar above the page with Allow
 * and Block (tab op 'permit'). Requests queue per tab; leaving the page or closing the tab
 * blocks whatever is still waiting.
 */
function askInTab(t, { key, origin, what, text = null, yes = null, no = null, remember = true }, cb) {
  t.asks ??= []
  const same = t.asks.find((a) => a.key === key)
  if (same) same.cbs.push(cb)
  else t.asks.push({ key, origin, what, text, yes, no, remember, cbs: [cb] })
  push()
}
function answerAsk(t, allow) {
  const a = t?.asks?.shift()
  if (!a) return
  if (a.remember) permissionMemo.set(a.key, allow)
  for (const cb of a.cbs) cb(allow)
  push()
}
function dropAsks(t) {
  for (const a of t.asks ?? []) for (const cb of a.cbs) cb(false)
  t.asks = []
}
/** all running downloads as one bar on the Dock icon */
function dockProgress() {
  if (!win || win.isDestroyed()) return
  const running = downloads.filter((d) => d.state === 'progressing')
  const total = running.reduce((n, d) => n + d.total, 0)
  const got = running.reduce((n, d) => n + d.received, 0)
  win.setProgressBar(!running.length ? -1 : total > 0 ? got / total : 2) // 2: indeterminate
}
const safeOrigin = (u) => {
  try {
    return new URL(u).origin
  } catch {
    return u
  }
}

// ------------------------------------------------------------------- tabs ----
function attach(t) {
  if (!win || !t.view) return
  clearTimeout(t.sleepTimer)
  t.sleepTimer = null
  if (!win.contentView.children.includes(t.view)) win.contentView.addChildView(t.view)
}
function detach(t) {
  if (!win || !t.view) return
  if (!win.contentView.children.includes(t.view)) return
  win.contentView.removeChildView(t.view)
  // out of view: Chromium throttles it, and after a while it gives its renderer back
  clearTimeout(t.sleepTimer)
  t.sleepTimer = setTimeout(() => sleepTab(t), SLEEP_AFTER_MS)
}
/**
 * A tab out of view this long is suspended: its renderer closes, its address and back/forward
 * history stay (the same state a restored tab starts in), and it loads again when shown.
 * A tab playing sound stays awake; it is checked again later.
 */
const SLEEP_AFTER_MS = 10 * 60_000
function sleepTab(t) {
  t.sleepTimer = null
  if (!t.view || !tabs.includes(t) || win?.contentView.children.includes(t.view)) return
  if (t.audible) {
    t.sleepTimer = setTimeout(() => sleepTab(t), SLEEP_AFTER_MS)
    return
  }
  t.nav = tabHistory(t)
  const wc = t.view.webContents
  t.view = null
  t.loading = false
  if (!wc.isDestroyed()) wc.close()
  push()
}
const shownNow = (t) => !!(win && t.view && win.contentView.children.includes(t.view))
let fullscreenTab = null
/**
 * The native views on show: the active tab's, and its split partner's, only while the dock is
 * open and uncovered. A split's two rectangles come from the page, which lays out the panes.
 */
function layout() {
  if (!win) return
  const t = activeTab()
  const s = t && splitOf(t.id)
  // until the page has measured the panes, the active tab alone fills the dock
  const panes = s && bounds?.panes?.[s.a] && bounds.panes[s.b] ? bounds.panes : null
  const shown = panes ? [tabOf(s.a), tabOf(s.b)] : t ? [t] : []
  for (const x of tabs) if (!shown.includes(x)) detach(x)
  // a crashed tab stays down until you reload it
  for (const x of shown) if (x.url && !x.view && !x.gone) wake(x)
  if (fullscreenTab && shown.includes(fullscreenTab) && fullscreenTab.view) {
    for (const x of shown) if (x !== fullscreenTab) detach(x)
    attach(fullscreenTab)
    const [w, h] = win.getContentSize()
    fullscreenTab.view.setBounds({ x: 0, y: 0, width: w, height: h })
    return
  }
  for (const x of shown) {
    if (!x.view) continue
    if (!bounds || covered || x.gone || x.hung) {
      detach(x)
      continue
    }
    attach(x)
    const { panes: _, ...whole } = bounds
    x.view.setBounds(panes ? panes[x.id] : whole)
  }
}

// ------------------------------------------------------------------ split ----
const clampRatio = (r) => Math.min(0.85, Math.max(0.15, Number.isFinite(r) ? r : 0.5))
function splitOf(id) {
  return splits.find((x) => x.a === id || x.b === id) ?? null
}
function partnerOf(id) {
  const s = splitOf(id)
  return s ? tabOf(s.a === id ? s.b : s.a) : null
}
/** put the pair next to each other in the strip, a first, where a (or b) was */
function keepTogether(s) {
  const a = tabOf(s.a)
  const b = tabOf(s.b)
  const at = Math.min(tabs.indexOf(a), tabs.indexOf(b))
  tabs = tabs.filter((x) => x !== a && x !== b)
  tabs.splice(at, 0, a, b)
}
/** t beside another tab, or beside a new tab of its profile (which then gets the address bar) */
function splitTab(t, withId = null, side = 'right') {
  if (!t || splitOf(t.id)) return null
  let other = withId ? tabOf(withId) : null
  if (other && (other === t || splitOf(other.id))) return null
  const fresh = !other
  other ??= openTab(t.profile, null, { after: t, activate: false })
  const s = side === 'left' ? { a: other.id, b: t.id, ratio: 0.5 } : { a: t.id, b: other.id, ratio: 0.5 }
  splits.push(s)
  keepTogether(s)
  activateTab(fresh ? other.id : t.id)
  if (fresh) cmd('focus-omnibox')
  return s
}
function unsplit(id) {
  splits = splits.filter((x) => x.a !== id && x.b !== id)
  layout()
  push()
}
/** a blank pane takes a tab you picked for it; the blank tab goes */
function fillSplit(blankId, withId) {
  const s = splitOf(blankId)
  const other = tabOf(withId)
  if (!s || !other || splitOf(withId) || tabOf(blankId)?.url) return
  if (s.a === blankId) s.a = withId
  else s.b = withId
  closeTab(blankId)
  keepTogether(s)
  activateTab(withId)
}
/**
 * The divider is dragged in the page, but the cursor soon crosses a native view, which then
 * gets the mouse. So the shell follows the drag from every view's mouse events until release.
 */
let splitDrag = null
function startSplitDrag(s) {
  endSplitDrag()
  const wcs = [win.webContents, tabOf(s.a)?.view?.webContents, tabOf(s.b)?.view?.webContents].filter(Boolean)
  const offs = []
  for (const wc of wcs) {
    const h = (e, m) => {
      if (m.type !== 'mouseMove' && m.type !== 'mouseUp') return
      e.preventDefault()
      const lb = Array.isArray(m.modifiers) && m.modifiers.some((k) => k.toLowerCase() === 'leftbuttondown')
      if (m.type === 'mouseUp' || !lb) return endSplitDrag()
      const view = [tabOf(s.a), tabOf(s.b)].find((x) => x?.view?.webContents === wc)
      const x = (view ? view.view.getBounds().x : 0) + m.x
      if (!bounds) return
      s.ratio = clampRatio((x - bounds.x) / bounds.width)
      push()
    }
    wc.on('before-mouse-event', h)
    offs.push(() => !wc.isDestroyed() && wc.off('before-mouse-event', h))
  }
  splitDrag = { offs }
}
function endSplitDrag() {
  for (const off of splitDrag?.offs ?? []) off()
  splitDrag = null
}

function wake(t) {
  if (t.view) return
  const view = new WebContentsView({
    webPreferences: {
      session: sessionFor(t.profile),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundColor: '#ffffff',
    },
  })
  t.view = view
  const wc = view.webContents
  extensionsFor(t.profile).ext.addTab(wc, win)
  wc.setWindowOpenHandler(({ url, disposition }) => {
    // window.open with features is a popup (OAuth flows need window.opener): allow it as a
    // small window on the same profile. Plain target=_blank links become tabs.
    if (disposition === 'new-window') {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 560, height: 700, autoHideMenuBar: true, backgroundColor: '#ffffff', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } } }
    }
    openTab(t.profile, url, { activate: disposition !== 'background-tab', after: t, opener: t })
    return { action: 'deny' }
  })
  wc.on('did-create-window', (child) => {
    child.webContents.setWindowOpenHandler(({ url }) => {
      openTab(t.profile, url, { after: t })
      return { action: 'deny' }
    })
    child.webContents.on('context-menu', (_e, p) => contextMenu(t, p, child.webContents))
  })
  wc.on('page-title-updated', (_e, title) => {
    t.title = title
    const h = store.history.find((x) => x.url === t.url && x.profile === t.profile)
    if (h) h.title = title
    push()
  })
  wc.on('page-favicon-updated', (_e, icons) => {
    t.favicon = icons.find((u) => isHttp(u)) ?? null
    // a bookmark of this page picks up its icon, so the bar shows it without a visit of its own
    for (const b of store.bookmarks[t.profile] ?? []) if (t.favicon && b.url === t.url) b.favicon = t.favicon
    push()
  })
  wc.on('did-start-loading', () => {
    t.loading = true
    push()
  })
  wc.on('did-stop-loading', () => {
    t.loading = false
    push()
  })
  // A page with unsaved changes (a beforeunload guard) used to swallow a new address, a reload or
  // back without a word. Now its tab asks, in the bar above it; Leave does what you asked.
  wc.on('will-prevent-unload', (e) => {
    if (t.leaveOK) {
      t.leaveOK = false
      e.preventDefault() // go anyway
      return
    }
    const retry = t.retry
    t.url = wc.getURL() // it stayed: the address bar says so
    askInTab(t, { key: `leave|${t.id}`, origin: safeOrigin(t.url), what: 'leave', text: 'This page has changes that may not be saved. Leave it?', yes: 'Leave', no: 'Stay', remember: false }, (ok) => {
      if (!ok || !retry) return
      t.leaveOK = true
      retry()
    })
  })
  wc.on('did-navigate', (_e, url) => {
    if (url.startsWith('data:')) return // our own error page keeps the address it failed on
    if (t.asks?.length) dropAsks(t) // a question from the page you left
    t.heard = false // a new page has to be started again to play in the background
    t.url = url
    t.failed = null
    t.favicon = null
    applyZoom(t)
    remember(t)
    push()
  })
  wc.on('did-navigate-in-page', (_e, url, isMain) => {
    if (!isMain) return
    t.url = url
    remember(t)
    push()
  })
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return // -3: aborted by a newer navigation
    t.failed = { code, desc, url }
    t.url = url
    wc.loadURL(errorPage(url, desc, code))
    push()
  })
  // a page that crashes, or stops answering, breaks its own tab and nothing else: the tab
  // shows a card with a reload where the page was (the dead view is taken off)
  wc.on('render-process-gone', (_e, d) => {
    if (t.view !== view || d.reason === 'clean-exit') return
    t.gone = d.reason
    t.hung = false
    t.loading = false
    layout()
    push()
  })
  wc.on('unresponsive', () => {
    if (t.view !== view) return
    t.hung = true
    layout()
    push()
  })
  wc.on('responsive', () => {
    if (t.view !== view || !t.hung) return
    t.hung = false
    layout()
    push()
  })
  // Electron 44 emits a single event object carrying `.audible`; older builds passed the
  // boolean as a second argument. Reading the second argument alone threw the moment a tab
  // started playing audio, which took the whole main process down — so read both shapes.
  wc.on('audio-state-changed', (e, legacy) => {
    t.audible = typeof legacy === 'boolean' ? legacy : (e?.audible ?? false)
    // sound plays where you started it: a tab that starts on its own while out of view is muted
    // (unmuting it from the tab strip lets it play)
    if (t.audible && shownNow(t)) t.heard = true
    else if (t.audible && !t.heard && !t.muted) return setMuted(t, true)
    push()
  })
  // a click in the other half of a split makes that tab the one the toolbar drives
  wc.on('focus', () => {
    if (active !== t.id && splitOf(t.id) && splitOf(t.id) === splitOf(active)) activateTab(t.id)
  })
  wc.on('enter-html-full-screen', () => {
    fullscreenTab = t
    layout()
  })
  wc.on('leave-html-full-screen', () => {
    fullscreenTab = null
    layout()
  })
  // ⌘/ctrl + scroll wheel zooms, as in Chrome (Electron leaves it to the app)
  wc.on('zoom-changed', (_e, d) => zoomTab(t, d === 'in' ? 1 : -1))
  wc.on('found-in-page', (_e, r) => win?.webContents.send('shell:find', { tab: t.id, active: r.activeMatchOrdinal, total: r.matches }))
  wc.on('context-menu', (_e, p) => contextMenu(t, p, wc))
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    const mod = input.meta || input.control
    // the page's palette, from anywhere
    if (mod && !input.shift && input.key.toLowerCase() === 'k') {
      e.preventDefault()
      // the palette covers the dock; when it closes the keyboard comes back here
      refocusTab = true
      win.webContents.focus()
      cmd('spotlight')
    }
    // Orbit's own keys (the window system, the panel chords, the workspaces) belong to Orbit
    // wherever you are; a web page used to swallow them
    if (orbitKey(input)) {
      e.preventDefault()
      win.webContents.focus()
      cmd('key', { code: input.code, key: input.key, alt: input.alt, meta: input.meta, ctrl: input.control, shift: input.shift })
      return
    }
    if (input.key === 'Escape' && t.loading) wc.stop()
  })
  wc.on('destroyed', () => {
    // a revived tab has a new view by now; only this one's own going clears it
    if (t.view === view) t.view = null
  })
  wc.setVisualZoomLevelLimits(1, 3) // trackpad pinch zooms the page, as in Chrome
  const kept = t.nav
  t.nav = null
  if (kept?.entries[kept.index]?.url === t.url) wc.navigationHistory.restore(kept).catch(() => {})
  else wc.loadURL(t.url ?? 'about:blank')
}

/**
 * The history index one step back (-1) or forward (1), or null. A failed load leaves two
 * entries behind, the failed attempt and our data: error page after it; stepping onto either
 * would just fail again, so both are skipped.
 */
function historyStep(wc, dir) {
  if (!wc || wc.isDestroyed()) return null
  const h = wc.navigationHistory
  const entries = h.getAllEntries()
  const dead = (i) => entries[i].url.startsWith('data:') || entries[i + 1]?.url.startsWith('data:')
  for (let i = h.getActiveIndex() + dir; i >= 0 && i < entries.length; i += dir) if (!dead(i)) return i
  return null
}
function go(wc, dir) {
  const i = historyStep(wc, dir)
  if (i !== null) wc.navigationHistory.goToIndex(i)
}
const MAX_TAB_HISTORY = 30
/** A tab's back/forward list to keep past its renderer (sleep, close, quit), without the dead entries. */
function tabHistory(t) {
  const wc = t.view?.webContents
  if (!wc || wc.isDestroyed()) return t.nav
  const h = wc.navigationHistory
  const all = h.getAllEntries()
  const at = h.getActiveIndex()
  const dead = (i) => all[i].url.startsWith('data:') || all[i + 1]?.url.startsWith('data:')
  const entries = []
  let index = -1
  for (const [i, e] of all.entries()) {
    // on an error page the entry to keep is the address that failed, so waking retries it
    if (i === at || (dead(at) && i === at - 1 && !all[at].url.startsWith('data:'))) {
      if (index >= 0) continue
      index = entries.length
      entries.push(dead(i) ? { url: t.url, title: t.title } : e)
    } else if (!dead(i)) entries.push(e)
  }
  if (index < 0 || !t.url) return null
  const from = Math.max(0, Math.min(index - MAX_TAB_HISTORY + 5, entries.length - MAX_TAB_HISTORY))
  return { entries: entries.slice(from, from + MAX_TAB_HISTORY), index: index - from }
}
function canStep(t, dir) {
  if (t.view) return historyStep(t.view.webContents, dir) !== null
  const i = (t.nav?.index ?? -1) + dir
  return !!t.nav && i >= 0 && i < t.nav.entries.length
}
/** back or forward in a tab; a sleeping tab steps through its kept history and wakes there */
function goTab(t, dir) {
  if (!t) return
  if (t.view) {
    t.retry = () => goTab(t, dir)
    return go(t.view.webContents, dir)
  }
  if (!canStep(t, dir)) return
  t.nav.index += dir
  t.url = t.nav.entries[t.nav.index].url
  t.title = t.nav.entries[t.nav.index].title
  layout()
  push()
}
// Chrome's zoom steps. Chromium keeps one zoom per site for the session and applies it to every
// tab of that site; store.zoom carries it over to the next launch, per profile.
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]
const zoomKey = (url) => {
  try {
    const u = new URL(url)
    return u.host || u.protocol
  } catch {
    return null
  }
}
/** dir: 1 in, -1 out, 0 back to 100% */
function zoomTab(t, dir) {
  const wc = t?.view?.webContents
  const key = t?.url && zoomKey(t.url)
  if (!wc || !key) return
  const now = wc.getZoomFactor()
  const next = dir === 0 ? 1 : dir > 0 ? (ZOOMS.find((z) => z > now + 0.001) ?? ZOOMS.at(-1)) : (ZOOMS.findLast((z) => z < now - 0.001) ?? ZOOMS[0])
  wc.setZoomFactor(next)
  const saved = (store.zoom[t.profile] ??= {})
  if (next === 1) delete saved[key]
  else saved[key] = next
  // the other tabs on this site zoomed with it
  for (const x of tabs) if (x.profile === t.profile && x.url && zoomKey(x.url) === key) x.zoom = next
  push()
}
// Orbit's own pages zoom too, between these. Chromium applies one zoom per origin, so the main
// window and every pop-out move together; store.appZoom brings it back next launch.
const APP_ZOOMS = ZOOMS.filter((z) => z >= 0.5 && z <= 2)
function zoomApp(dir) {
  const wc = win && !win.isDestroyed() ? win.webContents : null
  if (!wc) return
  const now = wc.getZoomFactor()
  const next = dir === 0 ? 1 : dir > 0 ? (APP_ZOOMS.find((z) => z > now + 0.001) ?? APP_ZOOMS.at(-1)) : (APP_ZOOMS.findLast((z) => z < now - 0.001) ?? APP_ZOOMS[0])
  store.appZoom = next
  wc.setZoomFactor(next)
  save()
}
/**
 * ⌘+ ⌘- ⌘0 zoom what you are working in: a web tab when it has focus, or when focus is in the
 * browser dock around it; anywhere else in Orbit (or with the dock closed), Orbit itself.
 */
async function zoomFocused(dir) {
  const focused = webContents.getFocusedWebContents()
  const tab = tabs.find((t) => t.view && t.view.webContents === focused)
  if (tab) return zoomTab(tab, dir)
  if (bounds !== null && !covered && activeTab()?.url && focused === win?.webContents) {
    const inDock = await win.webContents.executeJavaScript(`!!document.activeElement?.closest('#wb')`).catch(() => false)
    if (inDock) return zoomTab(activeTab(), dir)
  }
  zoomApp(dir)
}
/** a page arrived: give its site the zoom it had last time */
function applyZoom(t) {
  const wc = t.view?.webContents
  const want = (t.url && store.zoom[t.profile]?.[zoomKey(t.url)]) || 1
  if (wc && Math.abs(wc.getZoomFactor() - want) > 0.001) wc.setZoomFactor(want)
  t.zoom = want
}
/**
 * A crashed or hung page starts again in a fresh renderer, where it was, with its back and
 * forward history. A hung renderer is ended first (if other tabs of the same site share it,
 * they get their own reload card).
 */
function reviveTab(t) {
  const old = t.view
  try {
    t.nav = tabHistory(t)
  } catch {
    t.nav = null
  }
  const wasHung = t.hung
  t.gone = null
  t.hung = false
  t.failed = null
  if (old) {
    detach(t)
    clearTimeout(t.sleepTimer)
    t.sleepTimer = null
    t.view = null
    const wc = old.webContents
    if (!wc.isDestroyed()) {
      if (wasHung) wc.forcefullyCrashRenderer()
      wc.close()
    }
  }
  layout()
  push()
}
/** "Wait" on a hung page: show it again, and ask again if it is still stuck later */
function waitTab(t) {
  if (!t?.hung) return
  t.hung = false
  layout()
  push()
}
/** a tab showing our error page retries the address that failed instead of reloading the error page */
function reloadTab(t, hard = false) {
  const wc = t?.view?.webContents
  if (!t) return
  if (t.gone || t.hung) return reviveTab(t)
  if (t.failed) return nav(t.id, t.url)
  t.retry = () => reloadTab(t, hard)
  return hard ? wc?.reloadIgnoringCache() : wc?.reload()
}

function remember(t) {
  if (!t.url || !isHttp(t.url)) return
  store.history = store.history.filter((h) => !(h.url === t.url && h.profile === t.profile))
  store.history.unshift({ url: t.url, title: t.title || t.url, profile: t.profile, at: Date.now() })
  store.history.length = Math.min(store.history.length, MAX_HISTORY)
}

function openTab(profile, url = null, { activate = true, after = null, opener = null, index = null, nav = null } = {}) {
  if (!profileOf(profile)) profile = store.defaultProfile
  const t = blankTab(profile, url ? toUrl(url) : null)
  t.opener = opener?.id ?? null
  t.nav = nav
  let at = index !== null ? Math.max(0, Math.min(tabs.length, index)) : after ? tabs.indexOf(after) + 1 : tabs.length
  // a second link from the same page goes after the first, not in front of it
  if (opener) while (tabs[at]?.opener === opener.id) at++
  tabs.splice(at, 0, t)
  if (activate || !active) activateTab(t.id)
  else push()
  return t
}
function activateTab(id) {
  const t = tabOf(id)
  if (!t) return
  active = id
  layout()
  if (t.view) extensionsFor(t.profile).ext.selectTab(t.view.webContents)
  if (t.view && bounds && !covered) t.view.webContents.focus()
  push()
}
function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id)
  if (i < 0) return
  const t = tabs[i]
  // the other half of a split takes over the dock
  const partner = partnerOf(id)
  if (partner) splits = splits.filter((x) => x.a !== id && x.b !== id)
  if (t.url) closed.unshift({ profile: t.profile, url: t.url, title: t.title, index: i, nav: tabHistory(t) })
  tabs.splice(i, 1)
  dropAsks(t)
  closed = closed.slice(0, 20)
  detach(t)
  clearTimeout(t.sleepTimer)
  t.view?.webContents.close()
  t.view = null
  if (active === id) {
    active = (partner ?? tabs[i] ?? tabs[i - 1])?.id ?? null
    if (active) activateTab(active)
    else layout()
  } else if (partner) layout()
  push()
}
function reopenTab() {
  const c = closed.shift()
  if (c) openTab(c.profile, c.url, { index: c.index, nav: c.nav })
}
function nav(id, text) {
  const t = tabOf(id)
  if (!t) return
  t.url = toUrl(text)
  t.failed = null
  t.retry = () => nav(id, text)
  if (t.view) t.view.webContents.loadURL(t.url)
  layout() // wakes a sleeping or brand-new tab
  t.view?.webContents.focus()
  push()
}
/** Address-bar text → URL: a scheme is kept, a local path becomes file://, a hostname gets https, anything else is a search. */
function toUrl(text) {
  const s = text.trim()
  // local files: a file:// address, or a path you paste (spaces and all) that exists on disk
  if (/^file:\/\//i.test(s)) return s
  const path = s.replace(/^(['"])(.*)\1$/, '$2').replace(/^~(?=\/|$)/, homedir())
  if (path.startsWith('/') && existsSync(path)) return pathToFileURL(path).href
  if (/^(javascript|data|chrome|devtools):/i.test(s)) return SEARCH.replace('%s', encodeURIComponent(s))
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/|$)/i.test(s)) return `http://${s}`
  if (!/\s/.test(s) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(s)) return `https://${s}`
  return SEARCH.replace('%s', encodeURIComponent(s))
}
function errorPage(url, desc, code) {
  let host = url
  try {
    host = new URL(url).host
  } catch {}
  const esc = (s) => String(s).replace(/[<>&"]/g, (m) => `&#${m.charCodeAt(0)};`)
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(host)}</title>
<style>html{background:#0b0d14;color:#dfe4f0;font:15px/1.6 -apple-system,system-ui,sans-serif}
body{max-width:520px;margin:18vh auto;padding:0 24px}h1{font-size:20px;margin:0 0 6px}p{color:#8a93ab;margin:0 0 20px}
code{color:#5c6680;font-size:12px}button{background:#ff7a45;border:0;border-radius:8px;color:#1a0d06;font:600 14px system-ui;padding:9px 16px;cursor:pointer}</style>
<h1>${esc(host)} can’t be reached</h1><p>${esc(desc.replace(/^ERR_/, '').replace(/_/g, ' ').toLowerCase())} <code>(${code})</code></p>
<button onclick="location.href=${JSON.stringify(url)}">Try again</button>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function contextMenu(t, p, wc) {
  const items = []
  const others = store.profiles.filter((x) => x.id !== t.profile)
  if (p.linkURL) {
    items.push(
      { label: 'Open Link in New Tab', click: () => openTab(t.profile, p.linkURL, { activate: false, after: t, opener: t }) },
      ...(splitOf(t.id) ? [] : [{ label: 'Open Link in Split View', click: () => splitTab(t, openTab(t.profile, p.linkURL, { activate: false, after: t }).id) }]),
      ...(others.length ? [{ label: 'Open Link in Profile', submenu: others.map((pr) => ({ label: pr.name, click: () => openTab(pr.id, p.linkURL, { after: t }) })) }] : []),
      { label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) },
      { type: 'separator' },
    )
  }
  if (p.mediaType === 'image') {
    items.push(
      { label: 'Open Image in New Tab', click: () => openTab(t.profile, p.srcURL, { activate: false, after: t }) },
      { label: 'Copy Image', click: () => wc.copyImageAt(p.x, p.y) },
      { label: 'Copy Image Address', click: () => clipboard.writeText(p.srcURL) },
      { label: 'Save Image…', click: () => wc.downloadURL(p.srcURL) },
      { type: 'separator' },
    )
  }
  if (p.isEditable) {
    for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) })
    if (p.misspelledWord) items.push({ label: 'Add to Dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' })
    items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' })
  } else if (p.selectionText.trim()) {
    const q = p.selectionText.trim()
    items.push(
      { role: 'copy' },
      { label: `Search for “${q.length > 30 ? `${q.slice(0, 30)}…` : q}”`, click: () => openTab(t.profile, q, { after: t }) },
      { label: 'Look Up', click: () => wc.showDefinitionForSelection() },
      { type: 'separator' },
    )
  }
  items.push(
    { label: 'Back', enabled: historyStep(wc, -1) !== null, click: () => go(wc, -1) },
    { label: 'Forward', enabled: historyStep(wc, 1) !== null, click: () => go(wc, 1) },
    { label: 'Reload', click: () => reloadTab(t) },
    { type: 'separator' },
    { label: 'Print…', click: () => wc.print() },
    { label: t.muted ? 'Unmute Tab' : 'Mute Tab', click: () => setMuted(t, !t.muted) },
    { label: 'Copy Page Address', click: () => clipboard.writeText(wc.getURL()) },
    { type: 'separator' },
    { label: 'Inspect Element', click: () => wc.inspectElement(p.x, p.y) },
  )
  const menu = Menu.buildFromTemplate(items)
  // what the profile's extensions add to the menu (a translator, a password manager, …)
  try {
    const extra = extensionsFor(t.profile).ext.getContextMenuItems(wc, p)
    if (extra.length) {
      menu.insert(0, new MenuItem({ type: 'separator' }))
      for (const item of extra.reverse()) menu.insert(0, item)
    }
  } catch {}
  menu.popup({ window: win })
}
/** right-click on a tab in the strip */
function tabMenu(t) {
  const i = tabs.indexOf(t)
  const others = store.profiles.filter((x) => x.id !== t.profile)
  const closeAll = (list) => list.forEach((x) => closeTab(x.id))
  const items = [
    { label: 'New Tab to the Right', click: () => openTab(t.profile, null, { index: i + 1 }) },
    { type: 'separator' },
    { label: 'Reload', enabled: !!t.url, click: () => (t.view ? reloadTab(t) : activateTab(t.id)) },
    { label: 'Duplicate', enabled: !!t.url, click: () => openTab(t.profile, t.url, { index: i + 1, nav: tabHistory(t) }) },
    ...(others.length && t.url ? [{ label: 'Open in Profile', submenu: others.map((pr) => ({ label: pr.name, click: () => openTab(pr.id, t.url, { index: i + 1 }) })) }] : []),
    { label: t.muted ? 'Unmute Tab' : 'Mute Tab', click: () => setMuted(t, !t.muted) },
    { label: 'Copy Address', enabled: !!t.url, click: () => clipboard.writeText(t.url) },
    { type: 'separator' },
    ...(splitOf(t.id)
      ? [
          { label: 'Swap Sides', click: () => ipcSplitSwap(t.id) },
          { label: 'Exit Split View', click: () => unsplit(t.id) },
        ]
      : [
          { label: 'Split View with New Tab', click: () => splitTab(t) },
          ...(splitCandidates(t).length
            ? [{ label: 'Split View With', submenu: splitCandidates(t).map((x) => ({ label: (x.title || x.url || 'New tab').slice(0, 60), click: () => splitTab(t, x.id) })) }]
            : []),
        ]),
    { type: 'separator' },
    { label: 'Close Tab', click: () => closeTab(t.id) },
    { label: 'Close Other Tabs', enabled: tabs.length > 1, click: () => closeAll(tabs.filter((x) => x !== t)) },
    { label: 'Close Tabs to the Right', enabled: i < tabs.length - 1, click: () => closeAll(tabs.slice(i + 1)) },
    { type: 'separator' },
    { label: 'Reopen Closed Tab', enabled: closed.length > 0, click: reopenTab },
  ]
  Menu.buildFromTemplate(items).popup({ window: win })
}
/** tabs that could share the dock with t: not t, not already split */
const splitCandidates = (t) => tabs.filter((x) => x !== t && !splitOf(x.id)).slice(0, 12)
function ipcSplitSwap(id) {
  const s = splitOf(id)
  if (!s) return
  ;[s.a, s.b] = [s.b, s.a]
  s.ratio = 1 - s.ratio
  keepTogether(s)
  layout()
  push()
}
function setMuted(t, on) {
  t.muted = on
  if (!on) t.heard = true
  t.view?.webContents.setAudioMuted(on)
  push()
}

// ---------------------------------------------------------------- profiles ----
function createProfile(name, colour) {
  name = String(name ?? '').trim().slice(0, 60)
  if (!name) return null
  const p = { id: newId(), name, colour: /^#[0-9a-f]{6}$/i.test(colour ?? '') ? colour : COLOURS[store.profiles.length % COLOURS.length] }
  store.profiles.push(p)
  push()
  return p
}
async function removeProfile(id) {
  if (store.profiles.length <= 1) return false
  for (const t of tabs.filter((x) => x.profile === id)) closeTab(t.id)
  store.profiles = store.profiles.filter((p) => p.id !== id)
  if (store.defaultProfile === id) store.defaultProfile = store.profiles[0].id
  store.history = store.history.filter((h) => h.profile !== id)
  delete store.bookmarks[id]
  const ses = sessionFor(id)
  await ses.clearStorageData()
  await ses.clearCache()
  push()
  return true
}

// --------------------------------------------------------------- bookmarks ----
/** each profile keeps its own bookmarks, in bar order */
const bookmarksOf = (profileId) => (store.bookmarks[profileId] ??= [])
function addBookmark(profileId, url, title, favicon = null) {
  if (!profileOf(profileId) || !/^(https?|file):/i.test(url ?? '')) return null
  const list = bookmarksOf(profileId)
  const had = list.find((b) => b.url === url)
  if (had) return had
  const b = { id: newId(), url, title: String(title || url).slice(0, 200), favicon: isHttp(favicon ?? '') ? favicon : null }
  list.push(b)
  push()
  return b
}
function removeBookmark(profileId, id) {
  store.bookmarks[profileId] = bookmarksOf(profileId).filter((b) => b.id !== id)
  push()
}
function setBookmarkBar(on) {
  store.bookmarkBar = on
  buildMenu()
  push()
}
/** right-click on a bookmark in the bar */
function bookmarkMenu(profileId, id) {
  const b = bookmarksOf(profileId).find((x) => x.id === id)
  const toggle = { label: 'Show Bookmarks Bar', type: 'checkbox', checked: store.bookmarkBar, click: () => setBookmarkBar(!store.bookmarkBar) }
  // the bar's empty space: only the toggle
  if (!b) return Menu.buildFromTemplate([toggle]).popup({ window: win })
  const t = activeTab()
  const others = store.profiles.filter((x) => x.id !== profileId)
  const items = [
    { label: 'Open', click: () => (t && t.profile === profileId ? nav(t.id, b.url) : openTab(profileId, b.url)) },
    { label: 'Open in New Tab', click: () => openTab(profileId, b.url, { activate: false, after: t }) },
    ...(others.length ? [{ label: 'Open in Profile', submenu: others.map((pr) => ({ label: pr.name, click: () => openTab(pr.id, b.url, { after: t }) })) }] : []),
    { type: 'separator' },
    { label: 'Edit…', click: () => cmd('bookmark-edit', { id }) },
    { label: 'Copy Address', click: () => clipboard.writeText(b.url) },
    { label: 'Delete', click: () => removeBookmark(profileId, id) },
    { type: 'separator' },
    toggle,
  ]
  Menu.buildFromTemplate(items).popup({ window: win })
}
ipcMain.handle('shell:bookmark', (_e, a) => {
  const list = bookmarksOf(a.profile)
  const b = list.find((x) => x.id === a.id)
  switch (a.op) {
    case 'add':
      return addBookmark(a.profile, a.url, a.title, a.favicon)?.id ?? null
    case 'update':
      if (!b) return false
      if (String(a.title ?? '').trim()) b.title = String(a.title).trim().slice(0, 200)
      if (a.url && a.url !== b.url) {
        const url = toUrl(String(a.url))
        if (/^(https?|file):/i.test(url) && !list.some((x) => x !== b && x.url === url)) {
          b.url = url
          b.favicon = null
        }
      }
      push()
      return true
    case 'remove':
      return removeBookmark(a.profile, a.id)
    case 'move':
      if (!b) return
      list.splice(list.indexOf(b), 1)
      list.splice(Math.max(0, Math.min(list.length, a.index)), 0, b)
      return push()
    case 'menu':
      return bookmarkMenu(a.profile, a.id)
    case 'bar':
      return setBookmarkBar(!!a.on)
  }
})

// ------------------------------------------------------------- extensions ----
/**
 * Chrome extensions, per profile: each profile's session gets its own set, installed from the
 * Chrome Web Store into userData/extensions/<profile> and kept up to date. Tabs, popups and
 * context menus come from electron-chrome-extensions, which is dual-licensed: GPL-3.0 (set below,
 * fine for a personal build) or a paid licence for distributing the app under other terms.
 * Extensions that talk to a desktop app through native messaging (1Password, Claude) cannot work.
 */
const EXTENSIONS_LICENSE = 'GPL-3.0'
const extensionSets = new Map()
const extensionsDir = (profileId) => join(app.getPath('userData'), 'extensions', profileId)
function extensionsFor(profileId) {
  if (extensionSets.has(profileId)) return extensionSets.get(profileId)
  const ses = sessionFor(profileId)
  // creating the session creates its extension set too: use that one
  if (extensionSets.has(profileId)) return extensionSets.get(profileId)
  const tabOfContents = (wc) => tabs.find((x) => x.view?.webContents === wc)
  const opened = (url, activate = true) => {
    const t = openTab(profileId, url ?? null, { activate })
    wake(t)
    return t
  }
  const ext = new ElectronChromeExtensions({
    license: EXTENSIONS_LICENSE,
    session: ses,
    createTab: async (details) => {
      if (bounds === null) cmd('open')
      const t = opened(details.url, details.active !== false)
      return [t.view.webContents, win]
    },
    selectTab: (wc) => {
      const t = tabOfContents(wc)
      if (t) activateTab(t.id)
    },
    removeTab: (wc) => {
      const t = tabOfContents(wc)
      if (t) closeTab(t.id)
    },
    // this browser is one window: a "new window" from an extension becomes a tab
    createWindow: async (details) => {
      const url = [details.url].flat().filter(Boolean)[0]
      if (url) opened(url)
      return win
    },
  })
  const set = { ext, ready: null }
  extensionSets.set(profileId, set)
  set.ready = installChromeWebStore({ session: ses, extensionsPath: extensionsDir(profileId), autoUpdate: true })
    .then(() => push())
    .catch((e) => console.error(`extensions for ${profileId}:`, e?.message ?? e))
  return set
}
/** the toolbar element that shows extension icons and opens their popups, in the dashboard page */
function registerExtensionToolbar() {
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession)
  try {
    const src = readFileSync(createRequire(import.meta.url).resolve('electron-chrome-extensions/browser-action'), 'utf8')
    const file = join(app.getPath('userData'), 'extension-toolbar.preload.js')
    // a sandboxed preload cannot load a module file, so the element's script is wrapped in one
    writeFileSync(
      file,
      `if (location.origin === ${JSON.stringify(APP_ORIGIN)}) {\n  const m = { exports: {} };\n  (function (module, exports) {\n${src}\n  })(m, m.exports);\n  m.exports.injectBrowserAction();\n}\n`,
    )
    session.defaultSession.registerPreloadScript({ id: 'laika-extension-toolbar', type: 'frame', filePath: file })
  } catch (e) {
    console.error('extension toolbar:', e?.message ?? e)
  }
}
const extensionInfo = (e) => {
  const m = e.manifest ?? {}
  const msg = (v) => (typeof v === 'string' && v.startsWith('__MSG_') ? '' : v)
  return {
    id: e.id,
    name: msg(m.name) || e.name || e.id,
    version: m.version ?? '',
    description: msg(m.description) || '',
    hasAction: !!(m.action || m.browser_action),
    nativeMessaging: (m.permissions ?? []).includes('nativeMessaging'),
  }
}
/** the extensions installed in the user's Google Chrome, across its profiles: offered for import */
function chromeExtensions() {
  const root = { darwin: join(homedir(), 'Library/Application Support/Google/Chrome') }[process.platform]
  if (!root || !existsSync(root)) return []
  const found = new Map()
  for (const dir of readdirSync(root)) {
    const extRoot = join(root, dir, 'Extensions')
    if (!existsSync(extRoot)) continue
    for (const id of readdirSync(extRoot)) {
      if (!/^[a-p]{32}$/.test(id) || found.has(id)) continue
      try {
        const version = readdirSync(join(extRoot, id)).sort().pop()
        const m = JSON.parse(readFileSync(join(extRoot, id, version, 'manifest.json'), 'utf8'))
        let name = m.name ?? id
        if (typeof name === 'string' && name.startsWith('__MSG_')) {
          const key = name.slice(6, -2)
          const loc = join(extRoot, id, version, '_locales', m.default_locale ?? 'en', 'messages.json')
          try {
            const msgs = JSON.parse(readFileSync(loc, 'utf8'))
            name = (msgs[key] ?? msgs[key.toLowerCase()])?.message ?? name
          } catch {}
        }
        // Chrome's own bundled components are not in the Web Store
        if (!m.update_url || /clients2\.google\.com\/service\/update2\/crx/.test(m.update_url) === false) continue
        found.set(id, {
          id,
          name,
          nativeMessaging: (m.permissions ?? []).includes('nativeMessaging'),
          mv: m.manifest_version ?? 2,
        })
      } catch {}
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}
ipcMain.handle('shell:extensions', async (_e, a) => {
  const profileId = profileOf(a.profile) ? a.profile : store.defaultProfile
  const set = extensionsFor(profileId)
  await set.ready
  const ses = sessionFor(profileId)
  const opts = { session: ses, extensionsPath: extensionsDir(profileId) }
  switch (a.op) {
    case 'list':
      return ses.extensions.getAllExtensions().map(extensionInfo)
    case 'install':
      if (!/^[a-p]{32}$/.test(a.id ?? '')) return { error: 'not an extension id' }
      try {
        const e = await installExtension(a.id, opts)
        push()
        return extensionInfo(e)
      } catch (e) {
        return { error: String(e?.message ?? e).slice(0, 200) }
      }
    case 'remove':
      try {
        await uninstallExtension(a.id, opts)
      } catch {
        ses.extensions.removeExtension(a.id)
      }
      push()
      return true
    case 'chrome': {
      const have = new Set(ses.extensions.getAllExtensions().map((e) => e.id))
      return chromeExtensions().map((x) => ({ ...x, installed: have.has(x.id) }))
    }
    case 'store':
      if (bounds === null) cmd('open')
      openTab(profileId, 'https://chromewebstore.google.com/')
      return true
  }
})

// ---------------------------------------------------------------------- ipc ----
ipcMain.handle('shell:state', () => snapshot())
ipcMain.on('shell:bounds', (_e, rect) => {
  const wasOpen = bounds !== null
  // the page measures in CSS pixels; zoomed, each one is `z` window pixels
  const z = win && !win.isDestroyed() ? win.webContents.getZoomFactor() : 1
  const box = (r) => ({ x: Math.round(r.x * z), y: Math.round(r.y * z), width: Math.round(r.width * z), height: Math.round(r.height * z) })
  bounds = rect && rect.width > 0 && rect.height > 0 ? box(rect) : null
  // a split's panes, by tab id
  if (bounds && rect.panes) bounds.panes = Object.fromEntries(Object.entries(rect.panes).map(([id, r]) => [id, box(r)]))
  layout()
  if (wasOpen !== (bounds !== null)) push() // dockOpen is part of the snapshot
})
/** a web tab had the keyboard when page UI covered the dock: it gets it back when that goes */
let refocusTab = false
const tabHasFocus = () => {
  const f = webContents.getFocusedWebContents()
  return !!f && tabs.some((t) => t.view?.webContents === f)
}
/** the page says whether its keyboard focus is inside the browser dock (address bar, find, …) */
let dockFocus = false
ipcMain.on('shell:dock-focus', (_e, on) => {
  dockFocus = !!on
})
/**
 * The keyboard is in the browser: a web tab, or the dock's own toolbar. Browser keys (⌘W, ⌘F,
 * ⌘R, ⌘[ …) act on the browser only then; typing in a chat beside it, ⌘W used to close the tab.
 */
const inBrowser = () => bounds !== null && (tabHasFocus() || (dockFocus && webContents.getFocusedWebContents() === win?.webContents))
/**
 * Page UI over the dock takes the native views off (they would paint over it), which left the
 * browser blank under even a small menu. So first each page on show is captured, and the dock
 * draws that still under the menu until it goes; the capture holds the menu back a frame or two.
 */
async function sendFrames() {
  const shown = tabs.filter((t) => shownNow(t))
  const frames = await Promise.all(
    shown.map(async (t) => {
      const img = await t.view.webContents.capturePage().catch(() => null)
      return img && !img.isEmpty() ? { tab: t.id, src: `data:image/jpeg;base64,${img.toJPEG(82).toString('base64')}` } : null
    }),
  )
  win?.webContents.send('shell:frames', frames.filter(Boolean))
}
let wantCovered = false
ipcMain.on('shell:covered', async (_e, on) => {
  if (wantCovered === on) return
  wantCovered = on
  if (on) {
    refocusTab ||= tabHasFocus()
    await sendFrames()
    // uncovered while the capture ran: nothing to step aside for
    if (!wantCovered) return
  }
  covered = on
  layout()
  // Only a tab that had focus gets it back. A tooltip or toast passing over the browser while
  // you type in a chat used to move the keyboard into the web page.
  if (!on && refocusTab) activeTab()?.view?.webContents.focus()
  if (!on) refocusTab = false
})
ipcMain.handle('shell:tab', (_e, a) => {
  const t = tabOf(a.id)
  const wc = t?.view?.webContents
  switch (a.op) {
    case 'open':
      return openTab(a.profile ?? activeTab()?.profile ?? store.defaultProfile, a.url ?? null, { activate: a.activate !== false }).id
    case 'close':
      return closeTab(a.id)
    case 'reopen':
      return reopenTab()
    case 'activate':
      return activateTab(a.id)
    case 'navigate':
      return nav(a.id, a.text)
    case 'back':
      return goTab(t, -1)
    case 'forward':
      return goTab(t, 1)
    case 'reload':
      return reloadTab(t, a.hard)
    case 'wait':
      return waitTab(t)
    case 'permit':
      return answerAsk(t, !!a.allow)
    case 'menu':
      return t && tabMenu(t)
    case 'stop':
      return wc?.stop()
    case 'focus':
      return wc?.focus()
    case 'mute':
      return t && setMuted(t, !!a.on)
    case 'move': {
      if (!t) return
      // a split moves as one
      const s = splitOf(t.id)
      const group = s ? [tabOf(s.a), tabOf(s.b)] : [t]
      const at = tabs.slice(0, a.index).filter((x) => !group.includes(x)).length
      tabs = tabs.filter((x) => !group.includes(x))
      tabs.splice(Math.max(0, Math.min(tabs.length, at)), 0, ...group)
      return push()
    }
    case 'split':
      return !!splitTab(t, a.with ?? null, a.side)
    case 'unsplit':
      return unsplit(a.id)
    case 'split-fill':
      return fillSplit(a.id, a.with)
    case 'split-swap':
      return ipcSplitSwap(a.id)
    case 'split-ratio': {
      const s = splitOf(a.id)
      if (s) s.ratio = clampRatio(a.ratio)
      return push()
    }
    case 'split-drag': {
      const s = splitOf(a.id)
      return s && startSplitDrag(s)
    }
    case 'find':
      return a.text ? wc?.findInPage(a.text, { forward: a.forward !== false, findNext: !!a.next }) : wc?.stopFindInPage('clearSelection')
    case 'stop-find':
      return wc?.stopFindInPage('clearSelection')
    case 'devtools':
      return wc?.toggleDevTools()
    case 'zoom':
      return zoomTab(t, Math.sign(a.dir ?? 0))
    case 'external':
      return isHttp(a.url) || /^mailto:/.test(a.url) ? shell.openExternal(a.url) : null
    case 'clear-history':
      store.history = store.history.filter((h) => a.profile && h.profile !== a.profile)
      return push()
  }
})
ipcMain.handle('shell:profile', async (_e, a) => {
  switch (a.op) {
    case 'create':
      return createProfile(a.name, a.colour)?.id ?? null
    case 'update': {
      const p = profileOf(a.id)
      if (!p) return false
      if (a.name?.trim()) p.name = a.name.trim().slice(0, 60)
      if (/^#[0-9a-f]{6}$/i.test(a.colour ?? '')) p.colour = a.colour
      push()
      return true
    }
    case 'default':
      if (profileOf(a.id)) store.defaultProfile = a.id
      push()
      return true
    case 'remove': {
      const p = profileOf(a.id)
      if (!p) return false
      const { response } = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Remove', 'Cancel'], defaultId: 1, cancelId: 1, message: `Remove the profile “${p.name}”?`, detail: 'Its tabs close and its cookies, logins and site data are deleted. Chrome itself is not touched.' })
      return response === 0 ? removeProfile(a.id) : false
    }
  }
})
ipcMain.handle('shell:chrome-profiles', () => chromeProfiles())
ipcMain.handle('shell:popout', (_e, { part, on }) => (on ? openPopout(part) : closePopout(part)))
ipcMain.handle('shell:download', (_e, { op, id }) => {
  const dir = join(homedir(), 'Downloads')
  if (op === 'folder') return shell.openPath(dir)
  if (op === 'clear') {
    downloads = downloads.filter((d) => d.state === 'progressing')
    return push()
  }
  const d = downloads.find((x) => x.id === id)
  if (!d) return
  switch (op) {
    case 'open':
      return existsSync(d.path) ? shell.openPath(d.path) : null
    case 'show':
      return existsSync(d.path) ? shell.showItemInFolder(d.path) : shell.openPath(dir)
    case 'cancel':
      return liveDownloads.get(d.id)?.cancel()
    case 'retry':
      // the new attempt arrives through will-download as a fresh row
      if (!d.url || !profileOf(d.profile)) return
      downloads = downloads.filter((x) => x !== d)
      sessionFor(d.profile).downloadURL(d.url)
      return push()
    case 'remove':
      liveDownloads.get(d.id)?.cancel()
      downloads = downloads.filter((x) => x !== d)
      return push()
  }
})

// ------------------------------------------------------------------- menu ----
function buildMenu() {
  const dockCmd = (name, fn) => () => {
    if (bounds === null) cmd('open')
    fn?.()
    if (name) cmd(name)
  }
  const wcActive = () => activeTab()?.view?.webContents
  const template = [
    {
      label: app.name,
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: dockCmd('focus-omnibox', () => openTab(activeTab()?.profile ?? store.defaultProfile)) },
        { label: 'New Tab in Profile…', accelerator: 'CmdOrCtrl+Shift+T', click: dockCmd('pick-profile') },
        { label: 'Reopen Closed Tab', accelerator: 'Shift+Alt+T', click: dockCmd(null, reopenTab) },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+Z', visible: false, click: dockCmd(null, reopenTab) },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => inBrowser() && active && closeTab(active) },
        { type: 'separator' },
        { label: 'Open Location…', accelerator: 'CmdOrCtrl+L', click: dockCmd('focus-omnibox') },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => inBrowser() && cmd('find') },
        { label: 'Bookmark This Tab…', accelerator: 'CmdOrCtrl+D', click: () => inBrowser() && activeTab()?.url && cmd('bookmark-edit') },
        { type: 'separator' },
        { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' },
      ],
    },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }, { type: 'separator' }, { role: 'startSpeaking' }, { role: 'stopSpeaking' }],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Browser', accelerator: 'CmdOrCtrl+Shift+B', click: () => cmd('toggle') },
        { type: 'separator' },
        // outside the browser, ⌘R reloads Orbit, as it does with the browser closed
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => (inBrowser() && activeTab()?.url ? reloadTab(activeTab()) : bounds === null || !inBrowser() ? win?.webContents.reload() : null) },
        { label: 'Reload Ignoring Cache', accelerator: 'CmdOrCtrl+Shift+R', click: () => inBrowser() && reloadTab(activeTab(), true) },
        { label: 'Stop', accelerator: 'CmdOrCtrl+.', click: () => inBrowser() && wcActive()?.stop() },
        { type: 'separator' },
        // only while the dock shows: a hidden tab must not move under you
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => inBrowser() && goTab(activeTab(), -1) },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => inBrowser() && goTab(activeTab(), 1) },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => zoomFocused(0) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => zoomFocused(1) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', visible: false, click: () => zoomFocused(1) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoomFocused(-1) },
        { type: 'separator' },
        { label: 'Split View', accelerator: 'CmdOrCtrl+\\', click: () => inBrowser() && activeTab() && (splitOf(active) ? unsplit(active) : splitTab(activeTab())) },
        // ⇧⌘J: ⌥⌘L, Chrome's own, is the Cockpit panel's in Orbit
        { label: 'Downloads', accelerator: 'Shift+CmdOrCtrl+J', click: dockCmd('downloads') },
        { label: 'Always Show Bookmarks Bar', type: 'checkbox', checked: store.bookmarkBar, click: () => setBookmarkBar(!store.bookmarkBar) },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => (inBrowser() && wcActive() ? wcActive() : win?.webContents)?.toggleDevTools() },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => stepTab(1) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => stepTab(-1) },
        { label: 'Next Tab', accelerator: 'CmdOrCtrl+Shift+]', visible: false, click: () => stepTab(1) },
        { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+[', visible: false, click: () => stepTab(-1) },
        { type: 'separator' },
        ...Object.entries(POP_PARTS).map(([part, p]) => ({ label: `Pop Out ${p.title}`, click: () => openPopout(part) })),
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ label: `Tab ${n}`, accelerator: `CmdOrCtrl+${n}`, visible: false, click: () => tabs[n - 1] && bounds !== null && activateTab(tabs[n - 1].id) })),
        { label: 'Last Tab', accelerator: 'CmdOrCtrl+9', visible: false, click: () => tabs.length && bounds !== null && activateTab(tabs[tabs.length - 1].id) },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
function stepTab(d) {
  if (!tabs.length || bounds === null) return
  const i = tabs.findIndex((t) => t.id === active)
  activateTab(tabs[(i + d + tabs.length) % tabs.length].id)
}

// ----------------------------------------------------------------- server ----
async function serverUp() {
  try {
    const r = await fetch(`${APP_URL}/api/gmail/status`, { signal: AbortSignal.timeout(2500) })
    return r.ok
  } catch {
    return false
  }
}
async function ensureServer() {
  if (await serverUp()) return true
  const env = {
    ...process.env,
    ...(REPO?.path ? { PATH: REPO.path } : {}),
    PORT,
    // a stable build reads the same brain, accounts and settings as the checkout it came from
    ...(REPO?.brainRoot ? { BRAIN_ROOT: REPO.brainRoot } : {}),
    // nothing edits a stable build's files, so no live reload
    ...(REPO?.stable ? { NO_HMR: '1' } : {}),
  }
  delete env.ELECTRON_RUN_AS_NODE
  serverChild = spawn(NODE, [SERVER], { cwd: dirname(SERVER), stdio: 'inherit', env })
  serverChild.on('exit', () => {
    serverChild = null
  })
  const until = Date.now() + 90_000
  while (Date.now() < until) {
    if (await serverUp()) return true
    if (!serverChild) break
    await new Promise((r) => setTimeout(r, 700))
  }
  return false
}
const WAIT_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><meta charset="utf-8"><style>html{background:#07080d;color:#8892ad;font:14px -apple-system,system-ui}body{display:grid;place-items:center;height:100vh;margin:0}b{color:#e8ecf8;letter-spacing:.17em;text-transform:uppercase;font-size:12px}</style><div><b>laika·orbit</b><br>starting the server on ${APP_URL} …</div>`,
)}`

// ----------------------------------------------------------------- window ----
/** The app's pages never leave their origin: any outside link becomes a tab in the main window. */
function guardPage(w) {
  const toTab = (url) => {
    cmd('open')
    openTab(store.defaultProfile, url)
    if (w !== win) win?.focus()
  }
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttp(url)) toTab(url)
    else if (/^mailto:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(APP_ORIGIN) || url.startsWith('data:')) return
    e.preventDefault()
    if (isHttp(url)) toTab(url)
  })
  w.webContents.on('context-menu', (_e, p) => {
    if (!p.isEditable && !p.selectionText) return
    Menu.buildFromTemplate([{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]).popup({ window: w })
  })
}

// --------------------------------------------------------------- pop-outs ----
/**
 * A part of the page in a window of its own (pop.html?part=…), for a second screen. The page
 * keeps its copy of the part shut while it is out; closing the window puts it back. Where each
 * window was is saved, so a pop-out reopens on the same screen next launch.
 */
const POP_PARTS = { claude: { title: 'Claude', width: 760, height: 940 }, control: { title: 'Agent Control', width: 1180, height: 900 } }
/** @type {Map<string, BrowserWindow>} */
const pops = new Map()
let quitting = false

/** A saved rectangle, if enough of it is still on a connected screen to grab; else null. */
function onScreen(b) {
  if (!b || b.width === undefined) return null
  const seen = screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x)
    const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y)
    return w >= 120 && h >= 60
  })
  return seen ? b : null
}
/** First time out: centred on a screen the main window isn't on, when there is one. */
function placePopout({ width, height }) {
  const here = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay()
  const { workArea: a } = screen.getAllDisplays().find((d) => d.id !== here.id) ?? here
  const w = Math.min(width, a.width - 40)
  const h = Math.min(height, a.height - 40)
  return { x: Math.round(a.x + (a.width - w) / 2), y: Math.round(a.y + (a.height - h) / 2), width: w, height: h }
}
function openPopout(part) {
  const spec = POP_PARTS[part]
  if (!spec) return false
  const open = pops.get(part)
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore()
    open.show()
    open.focus()
    return true
  }
  const b = onScreen(store.popouts?.[part]) ?? placePopout(spec)
  const w = new BrowserWindow({
    ...b,
    minWidth: 420,
    minHeight: 360,
    title: spec.title,
    backgroundColor: '#07080d',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
    show: false,
    webPreferences: { preload: join(HERE, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  pops.set(part, w)
  const keep = () => {
    if (w.isDestroyed()) return
    store.popouts = { ...store.popouts, [part]: w.getNormalBounds() }
    save()
  }
  keep()
  w.once('ready-to-show', () => w.show())
  guardPage(w)
  w.on('moved', keep)
  w.on('resized', keep)
  w.on('closed', () => {
    pops.delete(part)
    // quitting closes every window, and those stay popped out for next launch
    if (quitting) return
    const { [part]: _gone, ...rest } = store.popouts
    store.popouts = rest
    push()
  })
  w.loadURL(`${APP_URL}/pop.html?part=${part}`)
  push()
  return true
}
function closePopout(part) {
  const w = pops.get(part)
  if (w && !w.isDestroyed()) w.close()
  return true
}

async function createWindow() {
  const b = store.window ?? {}
  win = new BrowserWindow({
    width: b.width ?? 1600,
    height: b.height ?? 1000,
    ...(b.x !== undefined ? { x: b.x, y: b.y } : {}),
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#07080d',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    show: false,
    // the hidden test copy: never drawn over your screen, never focused (see HIDDEN)
    ...(HIDDEN ? { opacity: 0, focusable: false, hiddenInMissionControl: true } : {}),
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => (HIDDEN ? win.showInactive() : win.show()))
  guardPage(win)
  win.on('resize', layout)
  // trackpad swipes (macOS) and mouse back/forward buttons (Windows, Linux) move the open tab
  // only with the pointer over the web page: a swipe over a chat beside it is not for the page
  const overDock = () => {
    if (!bounds || !win) return false
    const p = screen.getCursorScreenPoint()
    const c = win.getContentBounds()
    const x = p.x - c.x
    const y = p.y - c.y
    return x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height
  }
  const swipe = (dir) => bounds !== null && !covered && overDock() && goTab(activeTab(), dir)
  win.on('swipe', (_e, d) => (d === 'left' ? swipe(-1) : d === 'right' ? swipe(1) : null))
  win.on('app-command', (_e, c) => (c === 'browser-backward' ? swipe(-1) : c === 'browser-forward' ? swipe(1) : null))
  win.on('closed', () => {
    win = null
    // the pop-outs belong to this window; without it there is no app
    if (pops.size) app.quit()
  })
  win.on('moved', save)
  win.on('resized', save)
  await win.loadURL(WAIT_PAGE)
  if (!(await ensureServer())) {
    dialog.showErrorBox('Laika Orbit', `No server at ${APP_URL}, and starting one failed. Run it yourself:\n\ncd packages/app && node server.mjs`)
    app.quit()
    return
  }
  await win.loadURL(APP_URL)
  if (store.appZoom && store.appZoom !== 1) win.webContents.setZoomFactor(store.appZoom)
  // the parts you had popped out come back on the screens you left them on
  if (!HIDDEN) for (const part of Object.keys(store.popouts ?? {})) openPopout(part)
  if (SMOKE) smoke().catch((e) => console.error('smoke failed', e))
}

// the hidden test copy can be driven from its inspector (--inspect=<port>): globalThis.__shell
if (HIDDEN) {
  globalThis.__shell = {
    get win() {
      return win
    },
    get tabs() {
      return tabs
    },
    get covered() {
      return covered
    },
    inBrowser: () => inBrowser(),
    tabHasFocus: () => tabHasFocus(),
    focused: () => webContents.getFocusedWebContents()?.getURL() ?? null,
    /** run a menu item by its label, as its key would */
    menu: (label) => {
      const find = (items) => {
        for (const i of items) {
          if (i.label === label && i.click) return i
          const sub = i.submenu && find(i.submenu.items)
          if (sub) return sub
        }
      }
      const item = find(Menu.getApplicationMenu().items)
      item?.click()
      return !!item
    },
  }
}

app.whenReady().then(async () => {
  if (HIDDEN) app.dock?.hide()
  registerExtensionToolbar()
  await loadStore()
  buildMenu()
  await createWindow()
  app.on('activate', () => {
    if (!win) createWindow()
  })
})
app.on('window-all-closed', () => app.quit())
/**
 * Sign-ins kept in session cookies (no expiry) used to be gone after every restart, because
 * Chromium drops those at quit. Chrome keeps them when it restores your tabs; so does this: at
 * quit each profile used this run has its session cookies given an expiry two weeks out. They
 * stay in Chromium's own cookie store, encrypted as the rest are; nothing is written elsewhere.
 */
const KEEP_SESSION_COOKIES_S = 14 * 24 * 3600
async function keepSessionCookies() {
  const until = Math.floor(Date.now() / 1000) + KEEP_SESSION_COOKIES_S
  await Promise.all(
    [...sessions.values()].map(async (ses) => {
      const all = await ses.cookies.get({}).catch(() => [])
      await Promise.all(
        all
          .filter((c) => c.session)
          .map((c) =>
            ses.cookies
              .set({
                url: `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path || '/'}`,
                name: c.name,
                value: c.value,
                ...(c.hostOnly ? {} : { domain: c.domain }),
                path: c.path,
                secure: c.secure,
                httpOnly: c.httpOnly,
                sameSite: c.sameSite,
                expirationDate: until,
              })
              .catch(() => {}),
          ),
      )
      await ses.cookies.flushStore().catch(() => {})
    }),
  )
}
let cookiesKept = false
app.on('before-quit', (e) => {
  // first pass: hold the quit while the session cookies are kept (never more than 3 s)
  if (!cookiesKept) {
    cookiesKept = true
    e.preventDefault()
    Promise.race([keepSessionCookies(), new Promise((r) => setTimeout(r, 3000))]).finally(() => app.quit())
    return
  }
  quitting = true
  clearTimeout(saveTimer)
  try {
    writeFileSync(`${STATE_FILE}.quit`, JSON.stringify(storeData(), null, 2))
    renameSync(`${STATE_FILE}.quit`, STATE_FILE)
  } catch {}
  if (serverChild) serverChild.kill()
})

// ---------------------------------------------------------------- self-test ----
/**
 * LAIKA_SHELL_SMOKE=<dir>: two profiles, a tab in each on a page that echoes its cookies,
 * screenshots of the window and of each tab into <dir>, then quit. Proves the profiles
 * really are separate jars and that the view sits inside the dock.
 */
async function smoke() {
  const dir = SMOKE
  await mkdir(dir, { recursive: true })
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  // An honest composite: the page as it is, with the active tab's own capture placed where
  // the shell draws it. (A screen grab depends on what else is on the screen; a window grab
  // of an occluded window is stale.)
  // an occluded window renders no frames and the capture throws; bring it up and retry
  const capture = async (wc) => {
    for (let i = 0; ; i++) {
      try {
        return await wc.capturePage(undefined, { stayAwake: true })
      } catch (e) {
        if (i >= 6) throw e
        win.moveTop()
        app.focus({ steal: true })
        await wait(500)
      }
    }
  }
  const shot = async (name) => {
    const t = activeTab()
    let inject = ''
    if (t?.view && bounds && !covered) {
      const img = await capture(t.view.webContents)
      inject = `(() => { const i = document.createElement('img'); i.id = 'smoke-view'; i.src = ${JSON.stringify(img.toDataURL())}; i.style.cssText = 'position:absolute;inset:0;width:100%;height:100%'; document.querySelector('#wb .wb-view').appendChild(i) })();`
    }
    await win.webContents.executeJavaScript(`${inject} 0`)
    await wait(150)
    const page = await capture(win.webContents)
    await writeFile(join(dir, name), page.toPNG())
    await win.webContents.executeJavaScript(`document.getElementById('smoke-view')?.remove(); 0`)
  }
  const click = (sel) => win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(sel)})?.click()`)
  // an occluded window stops repainting and every capture is the same stale frame
  win.setAlwaysOnTop(true, 'screen-saver')
  win.moveTop()
  app.focus({ steal: true })
  await wait(1500)
  // the page's boot overlay covers the dock until the layout is built; a busy machine takes a while
  let bootStalled = true
  for (let i = 0; i < 40; i++) {
    if (await win.webContents.executeJavaScript(`!document.querySelector('.boot:not(.gone)')`)) {
      bootStalled = false
      break
    }
    await wait(500)
  }
  // this test is about the browser: a stalled page boot is reported, and its overlay moved aside
  if (bootStalled) await win.webContents.executeJavaScript(`document.querySelector('.boot')?.classList.add('gone'); 0`)
  const names = ['Work', 'Personal']
  const ids = names.map((n) => store.profiles.find((p) => p.name === n)?.id ?? createProfile(n).id)
  const [a, b] = ids.map((id, i) => openTab(id, `https://httpbin.org/cookies/set/who/${names[i].toLowerCase()}`))
  cmd('open')
  await wait(6000)
  activateTab(a.id)
  await wait(1200)
  await shot('1-work-tab.png')
  const pageA = await a.view.webContents.executeJavaScript('document.body.innerText')
  activateTab(b.id)
  await wait(1200)
  await shot('2-personal-tab.png')
  const pageB = await b.view.webContents.executeJavaScript('document.body.innerText')
  // the cookie set in one profile must be invisible to the other
  const [jarA, jarB] = await Promise.all([sessionFor(a.profile).cookies.get({ domain: 'httpbin.org' }), sessionFor(b.profile).cookies.get({ domain: 'httpbin.org' })])
  await writeFile(
    join(dir, 'result.json'),
    JSON.stringify({ pageA, pageB, jarA: jarA.map((c) => `${c.name}=${c.value}`), jarB: jarB.map((c) => `${c.name}=${c.value}`), bounds, tabs: snapshot().tabs, versions: { electron: process.versions.electron, chrome: process.versions.chrome } }, null, 2),
  )
  // bookmarks: the bar shows the active profile's, ⌘D saves this page and opens the editor
  addBookmark(b.profile, 'https://example.com/', 'Example Domain')
  cmd('bookmark-edit')
  await wait(1200)
  await shot('2b-bookmarks.png')
  const q = (js) => win.webContents.executeJavaScript(js)
  const bookmarkCheck = {
    bar: await q(`[...document.querySelectorAll('#wb .wb-bmlist .wb-bm')].map((b) => b.textContent)`),
    starOn: await q(`document.querySelector('#wb .wb-star').classList.contains('on')`),
    editorOpen: await q(`!document.querySelector('#wb .wb-bmedit').hidden`),
    otherProfile: (store.bookmarks[a.profile] ?? []).length,
  }
  await q(`(() => { const i = document.querySelector('#wb .wb-bmedit [data-f=title]'); i.value = 'Renamed'; i.form.requestSubmit() })()`)
  await wait(500)
  bookmarkCheck.renamed = bookmarksOf(b.profile).map((x) => x.title)
  bookmarkCheck.coveredAfterClose = covered
  // split view: the two tabs side by side, then a split with a new tab that offers the open tabs
  const onScreen = (t) => !!t.view && win.contentView.children.includes(t.view)
  // a workbench view (History, Mission, …) left open over the dock would hide the panes: Web closes them
  await click('#wbn [data-nav="browser"]')
  splitTab(b, a.id)
  await wait(1500)
  await shot('2c-split.png')
  const splitCheck = {
    order: tabs.map((x) => x.id).join(','),
    pair: [b.id, a.id],
    shown: [onScreen(b), onScreen(a)],
    rects: [b.view?.getBounds(), a.view?.getBounds()],
    covered,
    bounds,
  }
  const s0 = splitOf(b.id)
  s0.ratio = 0.3
  push()
  await wait(600)
  splitCheck.after30 = [b.view.getBounds().width, a.view.getBounds().width]
  unsplit(b.id)
  await wait(500)
  splitCheck.afterUnsplit = { shown: [onScreen(b), onScreen(a)], rect: b.view.getBounds() }
  splitTab(a)
  await wait(1200)
  await shot('2d-split-picker.png')
  const blank = partnerOf(a.id)
  splitCheck.picker = await q(`[...document.querySelectorAll('#wb .wb-pick [data-fill]')].map((b) => b.textContent)`)
  fillSplit(blank.id, b.id)
  await wait(1200)
  splitCheck.filled = { blankGone: !tabOf(blank.id), split: splitOf(a.id), shown: [onScreen(a), onScreen(b)] }
  closeTab(b.id) // closing one half leaves the other, whole
  await wait(500)
  splitCheck.afterClose = { active: active === a.id, splits: splits.length, rect: a.view.getBounds(), bounds }
  openTab(ids[0])
  cmd('focus-omnibox')
  await wait(900)
  await shot('3-start-page.png')
  await win.webContents.executeJavaScript('(() => { const i = document.querySelector("#wb [data-el=url]"); i.value = "httpbin"; i.dispatchEvent(new Event("input", { bubbles: true })) })()')
  await wait(500)
  await shot('4-suggestions.png')
  await click('#wb [data-act="profiles"]')
  await wait(900)
  await shot('5-profiles.png')
  await click('#wb [data-act="profiles-close"]')
  activateTab(a.id)
  await wait(600)
  cmd('spotlight')
  await wait(900)
  await shot('6-spotlight-over-browser.png')
  // close the dock while the spotlight covers it, then reopen: the tab must be back at once
  cmd('toggle')
  await wait(400)
  win.webContents.focus()
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await wait(400)
  const closedView = !!activeTab()?.view && win.contentView.children.includes(activeTab().view)
  const t0 = Date.now()
  cmd('toggle')
  let reopenMs = null
  while (Date.now() - t0 < 5000) {
    const v = activeTab()?.view
    if (v && bounds && !covered && win.contentView.children.includes(v)) {
      reopenMs = Date.now() - t0
      break
    }
    await wait(20)
  }
  await shot('7-reopened.png')
  const r = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'))
  // a local file typed as a plain path (with spaces) opens as file://
  const local = join(HERE, '..', '..', 'showcase', 'index.html')
  const ft = openTab(ids[0], local)
  await wait(2500)
  const fileTab = { typed: local, url: ft.url, title: ft.title, failed: ft.failed }
  await shot('8-local-file.png')
  await writeFile(join(dir, 'result.json'), JSON.stringify({ ...r, reopen: { viewWhileClosed: closedView, visibleAfterMs: reopenMs }, fileTab, bookmarkCheck, splitCheck, bootStalled }, null, 2))
  await wait(300)
  app.quit()
}
