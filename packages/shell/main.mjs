/**
 * laika-1brain shell: the dashboard as a desktop window, with a browser inside it.
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
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
} from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { installChromeWebStore, installExtension, uninstallExtension } from 'electron-chrome-web-store'
import { chromeProfiles } from './chrome-profiles.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// Inside the .app built by make-app.mjs, repo.json says where the checkout is and which node
// to use: an app launched from the Dock has none of the terminal's environment. It also names
// the app, its port and its profile folder, so a stable build and a dev build run side by side.
// the Dock app's launcher hands over its repo.json; `pnpm shell` from the checkout has none
const REPO = globalThis.__laikaRepo ?? (existsSync(join(HERE, 'repo.json')) ? JSON.parse(readFileSync(join(HERE, 'repo.json'), 'utf8')) : null)
const PORT = String(REPO?.port ?? process.env.PORT ?? 5200)
const APP_URL = (process.env.APP_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '')
const APP_ORIGIN = new URL(APP_URL).origin
const SERVER = REPO ? join(REPO.root, 'packages/app/server.mjs') : resolve(HERE, '../app/server.mjs')
const NODE = REPO?.node ?? 'node'
const SEARCH = process.env.SHELL_SEARCH ?? 'https://www.google.com/search?q=%s'
const SMOKE = process.env.LAIKA_SHELL_SMOKE // a directory: run the self-test and write screenshots there
// one Chrome-looking UA for every profile: Google's sign-in refuses anything that says "Electron"
const UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
const COLOURS = ['#5b9dff', '#ff7a45', '#3ddc97', '#c07bff', '#ffc94f', '#ff4f9d', '#4fe0e0', '#a3d15c']
const MAX_HISTORY = 400
const isHttp = (u) => /^https?:/i.test(u)

app.setName(REPO?.name ?? 'Laika Orbit')
// the self-test keeps its profiles and tabs to itself; each installed app has its own folder
app.setPath(
  'userData',
  process.env.LAIKA_SHELL_USER_DATA ?? (SMOKE ? join(SMOKE, 'userData') : join(app.getPath('appData'), REPO?.userData ?? 'laika-1brain')),
)
app.userAgentFallback = UA
nativeTheme.themeSource = 'dark'
const STATE_FILE = join(app.getPath('userData'), 'browser.json')

// ------------------------------------------------------------------ state ----
/** @type {{profiles: {id:string,name:string,colour:string}[], defaultProfile: string|null, history: any[], window: any, popouts: Record<string, any>, zoom: Record<string, Record<string, number>>, bookmarks: Record<string, {id:string,url:string,title:string,favicon:string|null}[]>, bookmarkBar: boolean}} */
let store = { profiles: [], defaultProfile: null, history: [], window: null, popouts: {}, zoom: {}, bookmarks: {}, bookmarkBar: true }
/** @type {{id:string, profile:string, url:string|null, title:string, favicon:string|null, loading:boolean, audible:boolean, muted:boolean, failed:any, opener:string|null, nav:any, zoom:number, view:WebContentsView|null}[]} */
let tabs = []
let active = null
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
    const raw = JSON.parse(await readFile(STATE_FILE, 'utf8'))
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
    popouts: store.popouts,
    zoom: store.zoom,
    bookmarks: store.bookmarks,
    bookmarkBar: store.bookmarkBar,
    downloads: downloads.slice(0, MAX_DOWNLOADS),
  }
}
let saveTimer = null
function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    await mkdir(dirname(STATE_FILE), { recursive: true })
    await writeFile(STATE_FILE, JSON.stringify(storeData(), null, 2))
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
})
const tabOf = (id) => tabs.find((t) => t.id === id)
const activeTab = () => tabOf(active)
const profileOf = (id) => store.profiles.find((p) => p.id === id)

function snapshot() {
  return {
    profiles: store.profiles,
    defaultProfile: store.defaultProfile,
    tabs: tabs.map((t) => {
      const { view, nav, ...rest } = t
      return { ...rest, sleeping: !!t.url && !view, wcId: view?.webContents.id ?? null, canGoBack: canStep(t, -1), canGoForward: canStep(t, 1) }
    }),
    active,
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
  if (!win.contentView.children.includes(t.view)) win.contentView.addChildView(t.view)
}
function detach(t) {
  if (!win || !t.view) return
  if (win.contentView.children.includes(t.view)) win.contentView.removeChildView(t.view)
}
let fullscreenTab = null
/** One native view at most: the active tab's, only while the dock is open and uncovered. */
function layout() {
  if (!win) return
  const t = activeTab()
  for (const x of tabs) if (x !== t) detach(x)
  if (!t) return
  if (t.url && !t.view) wake(t)
  if (!t.view) return
  if (fullscreenTab === t) {
    attach(t)
    const [w, h] = win.getContentSize()
    t.view.setBounds({ x: 0, y: 0, width: w, height: h })
    return
  }
  if (!bounds || covered) return detach(t)
  attach(t)
  t.view.setBounds(bounds)
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
  wc.on('did-navigate', (_e, url) => {
    if (url.startsWith('data:')) return // our own error page keeps the address it failed on
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
  wc.on('render-process-gone', (_e, d) => {
    t.failed = { code: 0, desc: `The page crashed (${d.reason})`, url: t.url }
    push()
  })
  wc.on('audio-state-changed', (_e, { audible }) => {
    t.audible = audible
    push()
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
      win.webContents.focus()
      cmd('spotlight')
    }
    if (input.key === 'Escape' && t.loading) wc.stop()
  })
  wc.on('destroyed', () => {
    t.view = null
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
  if (t.view) return go(t.view.webContents, dir)
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
/** a page arrived: give its site the zoom it had last time */
function applyZoom(t) {
  const wc = t.view?.webContents
  const want = (t.url && store.zoom[t.profile]?.[zoomKey(t.url)]) || 1
  if (wc && Math.abs(wc.getZoomFactor() - want) > 0.001) wc.setZoomFactor(want)
  t.zoom = want
}
/** a tab showing our error page retries the address that failed instead of reloading the error page */
function reloadTab(t, hard = false) {
  const wc = t?.view?.webContents
  if (!t) return
  if (t.failed) return nav(t.id, t.url)
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
  if (t.url) closed.unshift({ profile: t.profile, url: t.url, title: t.title, index: i, nav: tabHistory(t) })
  tabs.splice(i, 1)
  closed = closed.slice(0, 20)
  detach(t)
  t.view?.webContents.close()
  t.view = null
  if (active === id) {
    active = (tabs[i] ?? tabs[i - 1])?.id ?? null
    if (active) activateTab(active)
    else layout()
  }
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
    { label: 'Close Tab', click: () => closeTab(t.id) },
    { label: 'Close Other Tabs', enabled: tabs.length > 1, click: () => closeAll(tabs.filter((x) => x !== t)) },
    { label: 'Close Tabs to the Right', enabled: i < tabs.length - 1, click: () => closeAll(tabs.slice(i + 1)) },
    { type: 'separator' },
    { label: 'Reopen Closed Tab', enabled: closed.length > 0, click: reopenTab },
  ]
  Menu.buildFromTemplate(items).popup({ window: win })
}
function setMuted(t, on) {
  t.muted = on
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
  bounds = rect && rect.width > 0 && rect.height > 0 ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null
  layout()
  if (wasOpen !== (bounds !== null)) push() // dockOpen is part of the snapshot
})
ipcMain.on('shell:covered', (_e, on) => {
  if (covered === on) return
  covered = on
  layout()
  // the page keeps focus while its own UI is up; hand it back to the tab afterwards
  if (!on) activeTab()?.view?.webContents.focus()
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
      tabs.splice(tabs.indexOf(t), 1)
      tabs.splice(Math.max(0, Math.min(tabs.length, a.index)), 0, t)
      return push()
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
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => bounds !== null && active && closeTab(active) },
        { type: 'separator' },
        { label: 'Open Location…', accelerator: 'CmdOrCtrl+L', click: dockCmd('focus-omnibox') },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => bounds !== null && cmd('find') },
        { label: 'Bookmark This Tab…', accelerator: 'CmdOrCtrl+D', click: () => bounds !== null && activeTab()?.url && cmd('bookmark-edit') },
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
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => (bounds !== null && activeTab()?.url ? reloadTab(activeTab()) : win?.webContents.reload()) },
        { label: 'Reload Ignoring Cache', accelerator: 'CmdOrCtrl+Shift+R', click: () => bounds !== null && reloadTab(activeTab(), true) },
        { label: 'Stop', accelerator: 'CmdOrCtrl+.', click: () => wcActive()?.stop() },
        { type: 'separator' },
        // only while the dock shows: a hidden tab must not move under you
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => bounds !== null && goTab(activeTab(), -1) },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => bounds !== null && goTab(activeTab(), 1) },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => bounds !== null && zoomTab(activeTab(), 0) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => bounds !== null && zoomTab(activeTab(), 1) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', visible: false, click: () => bounds !== null && zoomTab(activeTab(), 1) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => bounds !== null && zoomTab(activeTab(), -1) },
        { type: 'separator' },
        { label: 'Downloads', accelerator: 'Alt+CmdOrCtrl+L', click: dockCmd('downloads') },
        { label: 'Always Show Bookmarks Bar', type: 'checkbox', checked: store.bookmarkBar, accelerator: 'Alt+CmdOrCtrl+B', click: () => setBookmarkBar(!store.bookmarkBar) },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => (bounds !== null && wcActive() ? wcActive() : win?.webContents)?.toggleDevTools() },
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
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  guardPage(win)
  win.on('resize', layout)
  // trackpad swipes (macOS) and mouse back/forward buttons (Windows, Linux) move the open tab
  const swipe = (dir) => bounds !== null && !covered && goTab(activeTab(), dir)
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
  // the parts you had popped out come back on the screens you left them on
  for (const part of Object.keys(store.popouts ?? {})) openPopout(part)
  if (SMOKE) smoke().catch((e) => console.error('smoke failed', e))
}

app.whenReady().then(async () => {
  registerExtensionToolbar()
  await loadStore()
  buildMenu()
  await createWindow()
  app.on('activate', () => {
    if (!win) createWindow()
  })
})
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  quitting = true
  clearTimeout(saveTimer)
  try {
    writeFileSync(STATE_FILE, JSON.stringify(storeData(), null, 2))
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
  await writeFile(join(dir, 'result.json'), JSON.stringify({ ...r, reopen: { viewWhileClosed: closedView, visibleAfterMs: reopenMs }, fileTab, bookmarkCheck }, null, 2))
  await wait(300)
  app.quit()
}
