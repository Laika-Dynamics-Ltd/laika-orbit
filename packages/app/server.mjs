/**
 * Laika Orbit app server. One process, one port:
 *   - Vite in middleware mode  → HMR for the UI
 *   - /api/*                   → the real @laika/core engine over the real workspace
 * No separate API port, so fetch() is same-origin and nothing needs a proxy.
 */
import { createServer as createHttp } from 'node:http'
import { resolve, dirname, join, sep } from 'node:path'
import { existsSync, createReadStream } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer as createVite, searchForWorkspaceRoot } from 'vite'
import { agentsWidget, handleControl, localChats } from './control-api.mjs'
import { handleMission } from './mission-api.mjs'
import { handleRuns } from './runs-api.mjs'
import { handleCommands } from './commands.mjs'
import { handleProfiler } from './profiler-api.mjs'
import { handlePulse } from './pulse-api.mjs'
import { handleUsers } from './users-api.mjs'
import { startReporting } from './pulse-client.mjs'
import { handleSupabase } from './supabase.mjs'
import { handleLicense } from './license.mjs'
import { handleVoice } from './voice.mjs'
import { readdir, readFile as fsRead, writeFile, mkdir, stat, realpath, rename, rm } from 'node:fs/promises'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import {
  buildIndex, buildOptions, loadIndexConfig, saveIndexConfig, normaliseConfig,
  SourcedStore, DEFAULT_CONFIG, CONFIG_PATH, sourceDir, recall, parseRouter,
  DEFAULT_IGNORE, BINARY, IMAGE, NOISE, compilePattern,
  categorise, smartGroups, PROJECT_MARKERS,
} from '@laika/core'

import { refreshCalendar } from './feeds/calendar.mjs'
import { startLoadWatch } from './feeds/loadwatch.mjs'
import { sysres } from './feeds/sysres.mjs'
import { authorizeUrl, deleteRefreshToken, exchangeCode, readRefreshToken, refreshEmail, resetEmailCache, revokeToken, saveRefreshToken } from './feeds/gmail.mjs'
import { createHash, randomBytes } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
// feed credentials (the calendar's secret iCal address) live here, never in the repo
// the standalone app keeps secrets in Application Support (LAIKA_ENV_FILE); a checkout keeps them at its root
try { process.loadEnvFile(process.env.LAIKA_ENV_FILE ?? resolve(HERE, '../../.env.local')) } catch {}
/**
 * Which corpus this instance is about. `--root` beats BRAIN_ROOT beats the repo itself, so
 * pointing an instance at another project is a flag rather than an exported variable you have
 * to remember to unset in the next shell.
 */
const argRoot = (() => {
  const i = process.argv.indexOf('--root')
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return process.argv.find((a) => a.startsWith('--root='))?.slice('--root='.length)
})()
const ROOT = resolve(argRoot ?? process.env.BRAIN_ROOT ?? resolve(HERE, '../..'))
const PORT = Number(process.env.PORT || 5200)
/** notices when this Mac stays under pressure, names what is heavy, and steers new work to other machines */
const loadWatch = startLoadWatch({ chats: localChats })
// Showreel Studio lives in its own repo, a sibling checkout unless SHOWREEL_DIR says otherwise.
// Its API is mounted at /api/showreel and its page is drawn into the Showreel window.
// "Sibling" means beside the main checkout, so a worktree (the stable app's snapshot) finds it too.
const SHOWREEL_DIR = resolve(process.env.SHOWREEL_DIR ?? (() => {
  const beside = resolve(HERE, '../../../laika-showreel')
  if (existsSync(beside)) return beside
  try {
    const common = execFileSync('git', ['-C', HERE, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
    return resolve(dirname(common), '../laika-showreel')
  } catch {
    return beside
  }
})())
const SHOWREEL_LIB = join(SHOWREEL_DIR, 'lib', 'studio.mjs')
const showreel = existsSync(SHOWREEL_LIB)
  ? (await import(pathToFileURL(SHOWREEL_LIB).href)).createStudio({ base: '/api/showreel' })
  : null
/**
 * The folders agent control knows as repos or project folders, read through its own routes (both
 * cached there), for Mission Control: a repo's panel is only looked up or started for these.
 */
async function knownFolders() {
  const lists = await Promise.all(
    ['repos', 'projects'].map(async (k) => {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/control/${k}`)
      return r.ok ? r.json() : []
    }),
  )
  return new Set(lists.flat().map((x) => x.path))
}
// ------------------------------------------------------------------ index ----
// What gets indexed lives in brain/index.config.json (the Brain window edits it).
let cfg = await loadIndexConfig(ROOT)
let store = new SourcedStore(ROOT, cfg)
let idx = null
let built = 0
let building = null
let lastBuild = null
const history = [] // most recent first

async function index({ force = false, full = false, reason = 'auto' } = {}) {
  const fresh = idx && (cfg.refreshSecs === 0 || Date.now() - built < cfg.refreshSecs * 1000)
  if (!force && fresh) return idx
  if (building) return building // one build at a time; callers share it
  building = (async () => {
    const t0 = performance.now()
    // incremental by default: unchanged files reuse their tokens
    const next = await buildIndex(store, { ...buildOptions(cfg, store), prior: full ? undefined : idx ?? undefined })
    const ms = performance.now() - t0
    idx = next
    built = Date.now()
    lastBuild = { at: built, ms, reason, full, docs: next.docs.length, reread: next.reread }
    // the 10s auto refresh would bury real events; keep those, collapse the rest
    if (reason !== 'auto' || history[0]?.reason !== 'auto') history.unshift(lastBuild)
    else history[0] = lastBuild
    history.length = Math.min(history.length, 12)
    return next
  })().finally(() => { building = null })
  return building
}

const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)

// ---------------------------------------------------------------- version ----
// The app's version is read from git, so it goes up by itself with every commit and there
// is no number to remember to bump: v0.<commits on HEAD> · <short hash>, plus "+" while the
// tree has uncommitted changes. Cached briefly: the shell asks on every load.
const REPO = resolve(HERE, '../..')
const execP = promisify(execFile)
const git = (...args) => execP('git', ['-C', REPO, ...args], { timeout: 4000 }).then((r) => r.stdout.trim())
let versionCache = null
let versionAt = 0
async function appVersion() {
  if (versionCache && Date.now() - versionAt < 10_000) return versionCache
  // a standalone build has no repo: its version was written when it was built, and git is never run
  // (on a Mac without the command line tools, running git pops up an install prompt)
  if (process.env.LAIKA_VERSION_FILE) {
    try {
      versionCache = JSON.parse(await fsRead(process.env.LAIKA_VERSION_FILE, "utf8"))
    } catch {
      versionCache = { version: '0.0', build: 0, hash: null, dirty: false, subject: null, date: null, label: 'v0.0' }
    }
    versionAt = Date.now()
    return versionCache
  }
  try {
    const [count, hash, dirty, subject, date] = await Promise.all([
      git('rev-list', '--count', 'HEAD'),
      git('rev-parse', '--short', 'HEAD'),
      git('status', '--porcelain', '--untracked-files=no', '--', 'packages', 'package.json', 'pnpm-lock.yaml').then((o) => o.length > 0),
      git('log', '-1', '--format=%s'),
      git('log', '-1', '--format=%cI'),
    ])
    versionCache = { version: `0.${count}`, build: Number(count), hash, dirty, subject, date, label: `v0.${count}${dirty ? '+' : ''} · ${hash}` }
  } catch {
    versionCache = { version: '0.0', build: 0, hash: null, dirty: false, subject: null, date: null, label: 'v0.0' }
  }
  versionAt = Date.now()
  return versionCache
}

const tools = new Map()
const hasTool = (cmd) => {
  if (!tools.has(cmd)) {
    tools.set(cmd, new Promise((ok) => execFile('which', [cmd], (e) => ok(!e))))
  }
  return tools.get(cmd)
}

function extOf(p) {
  const m = p.match(/\.([a-z0-9]{1,8})$/i)
  return m ? m[1].toLowerCase() : '(none)'
}

async function indexStatus() {
  const i = idx
  const bySource = new Map()
  const byExt = new Map()
  let bytes = 0
  for (const d of i?.docs ?? []) {
    const src = store.sourceOf(d.path)
    const e = bySource.get(src) ?? { docs: 0, bytes: 0, content: 0 }
    e.docs++
    e.bytes += d.bytes
    if (i.contentTokens.has(d.path)) e.content++
    bySource.set(src, e)
    const x = extOf(d.path)
    byExt.set(x, (byExt.get(x) ?? 0) + 1)
    bytes += d.bytes
  }
  return {
    root: ROOT,
    configPath: CONFIG_PATH,
    building: !!building,
    lastBuild,
    history,
    docs: i?.docs.length ?? 0,
    bytes,
    tokens: i?.postings.size ?? 0,
    routers: i?.routerCount ?? 0,
    pointers: i?.pointerCount ?? 0,
    contentDocs: i?.contentDocs ?? 0,
    tooLarge: i?.tooLarge ?? 0,
    sources: cfg.sources.map((s) => {
      const part = store.parts.find((p) => p.id === s.id)
      return {
        id: s.id,
        dir: sourceDir(ROOT, s),
        prefix: part?.prefix ?? null,
        enabled: s.enabled,
        ...(bySource.get(s.id) ?? { docs: 0, bytes: 0, content: 0 }),
        scan: part?.store.lastScan ?? null,
      }
    }),
    byExt: [...byExt].sort((a, b) => b[1] - a[1]).slice(0, 14),
    largest: [...(i?.docs ?? [])].sort((a, b) => b.bytes - a.bytes).slice(0, 8)
      .map((d) => ({ path: d.path, bytes: d.bytes, content: i.contentTokens.has(d.path) })),
    tools: { pdftotext: await hasTool('pdftotext'), textutil: await hasTool('textutil') },
  }
}

/** Dry run: what a config WOULD index, and how that differs from what is indexed now. */
async function previewIndex(raw) {
  const next = normaliseConfig(raw)
  const s = new SourcedStore(ROOT, next)
  const t0 = performance.now()
  const paths = new Set()
  let partial = false
  for await (const d of s.listDocs()) {
    paths.add(d.path)
    if (performance.now() - t0 > 8000) { partial = true; break }
  }
  const now = new Set(idx?.docs.map((d) => d.path) ?? [])
  const added = [...paths].filter((p) => !now.has(p))
  const removed = partial ? [] : [...now].filter((p) => !paths.has(p))
  return {
    partial,
    ms: performance.now() - t0,
    total: paths.size,
    added: added.length,
    removed: removed.length,
    addedSample: added.slice(0, 40),
    removedSample: removed.slice(0, 40),
    sources: s.parts.map((p) => ({ id: p.id, dir: sourceDir(ROOT, next.sources.find((x) => x.id === p.id)), scan: p.store.lastScan })),
  }
}

async function readJson(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

/**
 * Real graph. Two sources of structure, so it is informative with OR without routers:
 *   - folders  → every corpus has these, and they are what people actually navigate by
 *   - routers  → curated pointers, when the workspace has them
 */
async function graph() {
  const i = await index()

  // group by the first meaningful path segment; that is the user's own taxonomy
  const groupOf = (p) => {
    const parts = p.split('/')
    if (parts.length === 1) return '(root)'
    if (parts[0] === 'brain' && parts[1] === 'routers') return 'ROUTERS'
    return parts[0]
  }
  const dirOf = (p) => p.split('/').slice(0, -1).join('/')

  // ARMS: which ring a file belongs to. Skills and routines are small and
  // specific; everything else is memory. Applications are connectors, not files.
  // A skill is its SKILL.md; the templates and scripts beside it are ordinary files, and the
  // widget JSONs are data, not routines — routines come through as their own list below.
  const armsOf = (p) => {
    const inSkills = /(^|\/)\.claude\/skills\//.test(p) || /^@claude\/skills\//.test(p)
    if (inSkills && /(^|\/)SKILL\.md$/.test(p)) return 'SKILLS'
    return 'MEMORY'
  }

  // Categories: a folder is a project if it holds a marker (.git, package.json, …).
  // Checked fresh per graph so a new repo shows up without a restart; it is a few
  // hundred existsSync calls.
  const rootSeen = new Map()
  const isProjectRoot = (source, dirRel) => {
    const key = `${source}\t${dirRel}`
    let v = rootSeen.get(key)
    if (v === undefined) {
      const part = store.parts.find((p) => p.id === source)
      const abs = part ? part.store.abs(dirRel) : null
      v = !!abs && PROJECT_MARKERS.some((m) => existsSync(join(abs, m)))
      rootSeen.set(key, v)
    }
    return v
  }
  const primary = store.parts.find((p) => !p.prefix)?.id
  const cats = i.docs.map((d) => {
    const c = categorise(d.path, (p) => store.sourceOf(p), isProjectRoot)
    const isPrimary = c.source === primary
    return { ...c, folder: groupOf(d.path), primary: isPrimary, project: isPrimary ? groupOf(d.path) : c.project }
  })
  // Claude files band by what they are (memory / plans / skills); their project stays a facet
  // Bands: Claude files by what they are (memory / plans / skills); other sources by
  // the project's top folder, so an org folder of repos is one band. The full project
  // path stays on the node as a facet.
  const smart = smartGroups(cats.map((c, k) => {
    if (c.primary) return c
    const top = i.docs[k].path.replace(/^@[^/]+\//, '').split('/')[0]
    if (c.source === 'claude') return { ...c, project: top === 'projects' ? 'memory' : top }
    return { ...c, project: c.project === '(top)' ? c.project : c.project.split('/')[0] }
  }), { minSize: (src) => (src === 'claude' ? 1 : 15), maxPerSource: 12 })

  const nodes = i.docs.map((d, k) => ({
    id: d.id,
    path: d.path,
    name: d.path.split('/').pop(),
    dir: dirOf(d.path),
    bytes: d.bytes,
    mtime: d.mtimeMs,
    group: smart[k],
    // facets the UI can regroup by
    source: cats[k].source,
    project: cats[k].project,
    docType: cats[k].kind,
    folder: cats[k].folder,
    depth: d.path.split('/').length,
    arms: armsOf(d.path),
    kind: /^brain\/(CLAUDE\.md|routers\/)/.test(d.path) ? 'router'
      : IMAGE.test(d.path) ? 'image'
      : /\.(md|txt|rtf|docx?|pdf|odt)$/i.test(d.path) ? 'doc' : 'code',
  }))

  // folder edges: each file links to the shallowest file sharing its directory,
  // which produces a real tree without needing an index of directories
  const dirAnchor = new Map()
  for (const n of nodes) {
    const cur = dirAnchor.get(n.dir)
    if (cur === undefined || n.depth < nodes[cur].depth) dirAnchor.set(n.dir, n.id)
  }
  const links = []
  for (const n of nodes) {
    const a = dirAnchor.get(n.dir)
    if (a !== undefined && a !== n.id) links.push({ s: a, t: n.id, type: 'folder' })
  }
  // parent-directory edges tie the tree together
  for (const [dir, anchor] of dirAnchor) {
    const parent = dir.split('/').slice(0, -1).join('/')
    const pa = dirAnchor.get(parent)
    if (pa !== undefined && pa !== anchor) links.push({ s: pa, t: anchor, type: 'tree' })
  }

  // curated router pointers, when present — these are the valuable edges
  for (const d of i.docs) {
    if (!/(^|\/)(brain\/routers\/.+\.md|brain\/CLAUDE\.md)$/.test(d.path)) continue
    const text = await store.readDoc(d.path).catch(() => '')
    if (!text) continue
    for (const p of parseRouter(text, d.path).pointers) {
      const t = i.byPath.get(p.path)
      if (t !== undefined && t !== d.id) links.push({ s: d.id, t, type: 'pointer' })
    }
  }

  // Applications ring: the connectors this workspace can actually reach. Declared,
  // not inferred — an app is a capability, not a file.
  const apps = CONNECTORS

  const counts = {}
  for (const n of nodes) counts[n.group] = (counts[n.group] ?? 0) + 1
  const groups = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }))
  const armsCounts = {}
  for (const n of nodes) armsCounts[n.arms] = (armsCounts[n.arms] ?? 0) + 1
  // Routines ring: the scheduled jobs, read from the routines widget. Like apps, these are
  // not files; the ring places them by time of day.
  let routines = []
  try {
    const w = JSON.parse(await fsRead(resolve(WIDGET_DIR, 'routines.json'), 'utf8'))
    routines = (w.items ?? []).map((it) => ({
      id: String(it.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      title: it.title ?? '',
      at: it.meta ?? '',
      status: String(it.tag ?? '').toUpperCase(),
      via: it.badge ?? '',
    }))
  } catch {}

  return {
    nodes, links, groups, apps, routines, armsCounts,
    pointerLinks: links.filter(l => l.type === 'pointer').length,
  }
}

// ---------------------------------------------------------------- widgets ----
// One JSON file per widget in brain/widgets/. Adding a widget is adding a file,
// so any producer that can write JSON is a first-class integration.
// Quick Look raw-file types
const RAW_MEDIA = /\.(png|jpe?g|gif|webp|svg|avif|ico|bmp|mp4|webm|mov|m4v|mp3|wav|m4a|ogg|aiff?|flac|pdf|css|woff2?|ttf|otf)$/i
const RAW_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', aif: 'audio/aiff',
  aiff: 'audio/aiff', flac: 'audio/flac', pdf: 'application/pdf', css: 'text/css',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8', csv: 'text/csv; charset=utf-8',
  md: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8',
}
const WIDGET_DIR = resolve(ROOT, 'brain', 'widgets')

// ---------------------------------------------------------------- thumbnails ----
// Live previews on the graph: /api/thumb?path=<index path>&s=<px> renders a file's first
// page with macOS's own thumbnailer (qlmanage), the same images Finder shows. Only the
// formats it renders well are offered — documents, slides, PDFs, HTML and images; text and
// code are previewed as text by the app instead. qlmanage hangs on some source files, so
// every run has a hard timeout, and an image that it cannot draw falls back to sips.
// Thumbnails are cached under .orbit/cache/thumbs, keyed by path, mtime and size.
const THUMBABLE = /\.(pdf|docx?|pptx?|rtf|odt|pages|key|numbers|html?|png|jpe?g|gif|webp|svg|avif|heic|bmp|tiff?)$/i
const THUMB_SIZES = [160, 320, 640]
const THUMB_DIR = resolve(ROOT, '.orbit', 'cache', 'thumbs')
const THUMB_TIMEOUT_MS = 8000
const thumbJobs = new Map() // key → promise, so a burst of hovers renders each file once
let thumbRunning = 0
const thumbQueue = []
const THUMB_PARALLEL = 3
const thumbSlot = () => new Promise((ok) => { thumbQueue.push(ok); pumpThumbs() })
function pumpThumbs() {
  while (thumbRunning < THUMB_PARALLEL && thumbQueue.length) { thumbRunning++; thumbQueue.shift()() }
}
const thumbDone = () => { thumbRunning--; pumpThumbs() }

async function thumbnail(rel, size) {
  const abs = store.abs(rel)
  const st = await stat(abs).catch(() => null)
  if (!st?.isFile()) return null
  const key = `${createHash('sha1').update(rel).digest('hex')}-${Math.round(st.mtimeMs)}-${size}`
  const out = join(THUMB_DIR, `${key}.png`)
  if (existsSync(out)) return out
  const inflight = thumbJobs.get(key)
  if (inflight) return inflight
  const job = (async () => {
    await thumbSlot()
    try {
      await mkdir(THUMB_DIR, { recursive: true })
      const work = join(THUMB_DIR, `tmp-${key}-${process.pid}`)
      await mkdir(work, { recursive: true })
      const base = rel.split('/').pop()
      const made = join(work, `${base}.png`)
      try {
        await execP('qlmanage', ['-t', '-s', String(size), '-o', work, abs], { timeout: THUMB_TIMEOUT_MS, killSignal: 'SIGKILL' })
      } catch { /* fall through to sips for images */ }
      if (!existsSync(made) && IMAGE.test(rel) && !/\.svg$/i.test(rel)) {
        await execP('sips', ['-s', 'format', 'png', '-Z', String(size), abs, '--out', made], { timeout: THUMB_TIMEOUT_MS, killSignal: 'SIGKILL' }).catch(() => {})
      }
      if (!existsSync(made)) { await rm(work, { recursive: true, force: true }); return null }
      await rename(made, out)
      await rm(work, { recursive: true, force: true })
      return out
    } finally {
      thumbDone()
      thumbJobs.delete(key)
    }
  })()
  thumbJobs.set(key, job)
  return job
}

// ---------------------------------------------------------------- profile ----
// Personal settings from the Settings panel. `*.local.json` is git-ignored: names, addresses
// and where you live stay on this machine. It sits under ROOT, so another brain root (the
// demo) never sees it.
const PROFILE_FILE = resolve(ROOT, 'brain', 'profile.local.json')
const MAC_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
const PROFILE_DEFAULT = {
  name: '', preferredName: '', emails: [], location: '',
  timeZone: MAC_TZ, workday: { from: 9, to: 17 }, clock: '24h', weekStart: 'mon',
}

async function readProfile() {
  try { return { ...PROFILE_DEFAULT, ...JSON.parse(await fsRead(PROFILE_FILE, 'utf8')) } } catch { return { ...PROFILE_DEFAULT } }
}

function normaliseProfile(raw) {
  const r = raw ?? {}
  const text = (v, max, label) => {
    const t = String(v ?? '').trim()
    if (t.length > max) throw new Error(`${label} is longer than ${max} characters`)
    return t
  }
  const emails = [...new Set((Array.isArray(r.emails) ? r.emails : String(r.emails ?? '').split(/[\s,;]+/))
    .map((e) => String(e).trim().toLowerCase()).filter(Boolean))]
  for (const e of emails) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error(`"${e}" is not an email address`)
  if (emails.length > 12) throw new Error('at most 12 email addresses')
  const timeZone = text(r.timeZone || MAC_TZ, 64, 'time zone')
  try { new Intl.DateTimeFormat('en', { timeZone }) } catch { throw new Error(`unknown time zone "${timeZone}"`) }
  const from = Number(r.workday?.from ?? 9)
  const to = Number(r.workday?.to ?? 17)
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to <= 24 && from < to)) {
    throw new Error('workday must be whole hours, starting before it ends, within 0-24')
  }
  return {
    name: text(r.name, 80, 'name'),
    preferredName: text(r.preferredName, 40, 'preferred name'),
    emails,
    location: text(r.location, 60, 'location'),
    timeZone,
    workday: { from, to },
    clock: r.clock === '12h' ? '12h' : '24h',
    weekStart: r.weekStart === 'sun' ? 'sun' : 'mon',
  }
}

/** "NZST · AUCKLAND" from the zone's abbreviation and the location (or the zone's city). */
function homeLabel(p) {
  const abbr = new Intl.DateTimeFormat(undefined, { timeZone: p.timeZone, timeZoneName: 'short' })
    .formatToParts(new Date()).find((x) => x.type === 'timeZoneName')?.value ?? ''
  const place = (p.location || p.timeZone.split('/').pop().replace(/_/g, ' ')).toUpperCase()
  return abbr && !/^GMT[+-]/.test(abbr) ? `${abbr} · ${place}` : place
}

/**
 * Claude connectors this workspace's agents can reach. Declared, not detected: Claude doesn't
 * say which claude.ai connectors an account has, so they are listed by hand in
 * brain/connectors.local.json as [{ id, name, via, live }]. None until you list them.
 */
const CONNECTORS = await fsRead(resolve(ROOT, 'brain', 'connectors.local.json'), 'utf8')
  .then((s) => JSON.parse(s).filter((c) => c && c.id && c.name))
  .catch(() => [])

async function readWidgets() {
  let files = []
  try { files = await readdir(WIDGET_DIR) } catch { return [] }
  const out = []
  for (const f of files) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue // _settings.json etc. are not widgets
    try { out.push(JSON.parse(await fsRead(resolve(WIDGET_DIR, f), 'utf8'))) } catch {}
  }
  // profile → calendar defaults (the producer's file loses to the profile; the gear wins over both)
  const cal = out.find((w) => w.id === 'calendar')
  if (cal) {
    const p = await readProfile()
    cal.config = {
      ...cal.config,
      home: p.timeZone,
      homeLabel: homeLabel(p),
      workday: p.workday,
      clock: p.clock,
      weekStart: p.weekStart,
    }
  }
  // live agent sessions: computed, not a file, so it goes in before the gear's settings merge
  if (!out.some(w => w.id === 'agents')) {
    try { out.push(await agentsWidget()) } catch {}
  }
  // the Claude widget: its body is drawn live in the page by sessions.ts (accounts, workspaces,
  // chats that need you); the server only gives it a place in the rails and its buttons
  if (!out.some(w => w.id === 'claude')) {
    out.push({
      id: 'claude', kind: 'list', title: 'Claude', icon: 'claude', source: 'claude code',
      rail: 'right', order: 0, refreshedAt: new Date().toISOString(),
      config: { meta: ' ', empty: 'Loading Claude…', staleAfterMins: 100000 },
      actions: [{ label: 'new', action: 'claude-new' }, { label: 'open', action: 'claude-open' }],
      items: [],
    })
  }
  // Settings from the gear live in their own file: producers rewrite widget files
  // wholesale, and would otherwise wipe a person's choices on every refresh.
  const settings = await readWidgetSettings()
  for (const w of out) {
    const o = settings[w.id]
    if (!o) continue
    const { config, ...top } = o
    Object.assign(w, top)
    if (config) w.config = { ...w.config, ...config }
    w.settings = o // so the UI can show what is overridden and reset it
  }
  // until Gmail is signed in, the email widget offers the sign-in instead of stale numbers
  const em = out.find((w) => w.id === 'email')
  if (em && email.status === 'needs-connect') {
    em.actions = [...(em.actions ?? []), { label: 'connect gmail', href: '/api/gmail/connect' }]
  }
  // the brain widget describes this very index, so its counts come from the index at read
  // time — a snapshot in the file drifted from the header (192 vs 108) once files were ignored
  const bs = out.find(w => w.id === 'brainstat')
  if (bs) {
    const g = await graph()
    const curated = g.pointerLinks
    bs.refreshedAt = new Date(built || Date.now()).toISOString()
    bs.config = {
      ...bs.config,
      value: String(g.nodes.length),
      segments: [
        { label: 'CURATED', n: curated, accent: '#ff7a45' },
        { label: 'FOLDER', n: g.links.length - curated, accent: '#5b9dff' },
      ],
    }
    // live rows replace same-named rows from the file; the rest (benchmarks) stay
    const on = cfg.sources.filter((s) => s.enabled).length
    const live = [
      { title: 'sources', meta: `${on} of ${cfg.sources.length} on` },
      { title: 'content indexed', meta: `${idx.contentDocs} / ${idx.docs.length}` },
      { title: 'router pointers', meta: String(idx.pointerCount) },
      { title: 'last build', meta: lastBuild ? `${Math.round(lastBuild.ms)}ms · ${lastBuild.reread} re-read` : '—' },
    ]
    const names = new Set(live.map((r) => r.title))
    bs.items = [...live, ...(bs.items ?? []).filter((r) => !names.has(r.title))]
  }
  return out.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

const SETTINGS_FILE = resolve(WIDGET_DIR, '_settings.json')
const SETTING_KEYS = new Set(['title', 'rail', 'order', 'href', 'collapsed', 'hidden', 'maxItems', 'height', 'config'])

/**
 * Widget layout is runtime state the app rewrites on every drag, so it is git-ignored: a checkout
 * that has none yet starts from the committed _settings.template.json.
 */
async function readWidgetSettings() {
  for (const f of [SETTINGS_FILE, resolve(WIDGET_DIR, '_settings.template.json')]) {
    try { return JSON.parse(await fsRead(f, 'utf8')) } catch {}
  }
  return {}
}

/** Merge a patch of { id: partial | null } into _settings.json; null resets a widget. */
async function patchWidgetSettings(patch) {
  const cur = await readWidgetSettings()
  for (const [id, v] of Object.entries(patch ?? {})) {
    if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error(`bad widget id "${id}"`)
    if (v === null) { delete cur[id]; continue }
    const next = { ...(cur[id] ?? {}) }
    for (const [k, val] of Object.entries(v)) {
      if (!SETTING_KEYS.has(k)) throw new Error(`unknown setting "${k}"`)
      if (val === null) delete next[k]
      else if (k === 'height' && !(Number.isFinite(val) && val >= 40 && val <= 4000)) throw new Error('height must be 40-4000 px')
      else if (k === 'config') {
        const c = { ...(next.config ?? {}) }
        for (const [ck, cv] of Object.entries(val)) cv === null ? delete c[ck] : (c[ck] = cv)
        next.config = c
        if (!Object.keys(c).length) delete next.config
      } else next[k] = val
    }
    if (Object.keys(next).length) cur[id] = next
    else delete cur[id]
  }
  await mkdir(WIDGET_DIR, { recursive: true })
  await writeFile(SETTINGS_FILE, `${JSON.stringify(cur, null, 2)}\n`)
  return cur
}

async function writeWidget(id, body) {
  if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error('bad widget id')
  await mkdir(WIDGET_DIR, { recursive: true })
  const doc = { ...body, id, refreshedAt: body.refreshedAt ?? new Date().toISOString() }
  await writeFile(resolve(WIDGET_DIR, `${id}.json`), JSON.stringify(doc, null, 2))
  return doc
}

// ------------------------------------------------------------------ feeds ----
// Widgets this server fills itself, rather than waiting on an agent to write the file.
// Synced widgets (email, calendar) hold personal data, so they are git-ignored; a fresh
// checkout starts each from its committed `_<id>.template.json`.
for (const id of ['email', 'calendar']) {
  const file = resolve(WIDGET_DIR, `${id}.json`)
  if (!existsSync(file) && existsSync(resolve(WIDGET_DIR, `_${id}.template.json`))) {
    await writeFile(file, await fsRead(resolve(WIDGET_DIR, `_${id}.template.json`), 'utf8'))
  }
}
const CAL_URLS = (process.env.CALENDAR_ICS_URLS ?? '').split(/[\s,]+/).filter(Boolean)
const CAL_MINS = Number(process.env.CALENDAR_REFRESH_MINS) || 5
let calError = null
const calendar = { at: 0, count: 0 }

async function pollCalendar() {
  try {
    const n = await refreshCalendar({ urls: CAL_URLS, file: resolve(WIDGET_DIR, 'calendar.json') })
    if (calError) console.log(`  calendar feed recovered · ${n} events`)
    calError = null
    Object.assign(calendar, { at: Date.now(), count: Number(n) || 0 })
  } catch (e) {
    // say it once per distinct failure; the widget's stale marker carries it from there
    const msg = String(e.message ?? e)
    if (msg !== calError) console.warn(`  calendar feed failed: ${msg}`)
    calError = msg
  }
}

if (CAL_URLS.length) {
  pollCalendar()
  setInterval(pollCalendar, CAL_MINS * 60_000)
}

// Gmail: GOOGLE_CLIENT_ID/SECRET in .env.local, refresh token in the Keychain from a one-time
// sign-in. GMAIL_FEED=0 turns it off entirely (the demo instance must never read the inbox).
const GMAIL_ON = process.env.GMAIL_FEED !== '0'
const G_ID = process.env.GOOGLE_CLIENT_ID ?? ''
const G_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? ''
const EMAIL_SECS = Math.max(30, Number(process.env.EMAIL_REFRESH_SECS) || 60)
const GMAIL_REDIRECT = `http://localhost:${PORT}/api/gmail/callback`
const gmailStates = new Map() // one-time `state` values for the sign-in, by creation time
const email = { status: !GMAIL_ON ? 'off' : G_ID && G_SECRET ? 'starting' : 'unconfigured', error: null, count: 0, at: 0 }
let emailBusy = false

async function pollEmail() {
  if (email.status === 'off' || email.status === 'unconfigured' || emailBusy) return
  emailBusy = true
  try {
    const refreshToken = await readRefreshToken()
    if (!refreshToken) {
      email.status = 'needs-connect'
      return
    }
    const r = await refreshEmail({
      creds: { clientId: G_ID, clientSecret: G_SECRET, refreshToken },
      file: resolve(WIDGET_DIR, 'email.json'),
      selfEmails: (await readProfile()).emails,
    })
    Object.assign(email, { count: r.count, account: r.account, needs: r.needs, unread: r.unread })
    if (email.error) console.log(`  email feed recovered · ${email.count} messages`)
    Object.assign(email, { status: 'live', error: null, at: Date.now() })
  } catch (e) {
    const msg = String(e.message ?? e)
    // a revoked or expired grant needs a person, not a retry
    if (/invalid_grant/.test(msg)) email.status = 'needs-connect'
    if (msg !== email.error) console.warn(`  email feed failed: ${msg}`)
    email.error = msg
  } finally {
    emailBusy = false
  }
}

if (email.status === 'starting') {
  pollEmail()
  setInterval(pollEmail, EMAIL_SECS * 1000)
}

const vite = await createVite({
  root: HERE, appType: 'spa',
  // loopback only: the live-reload socket must not be reachable from the network either
  // NO_HMR=1: no live reload, so another session's file saves cannot reload the page under
  // a browser test (npm run test:e2e against such an instance)
  server: {
    middlewareMode: true,
    hmr: process.env.NO_HMR ? false : { port: PORT + 10000, host: '127.0.0.1' },  // unique per instance
    fs: { allow: [searchForWorkspaceRoot(HERE), SHOWREEL_DIR] },
  },
  resolve: { alias: showreel ? { '@showreel': SHOWREEL_DIR } : {} },
  // without the studio its imports would fail to resolve and take the whole page down; the
  // window's /api/showreel probe reports it missing before these stand-ins are ever used
  plugins: showreel ? [] : [{
    name: 'showreel-missing',
    enforce: 'pre',
    resolveId: (id) => (id.startsWith('@showreel/') ? '\0showreel-missing' : null),
    load: (id) => (id === '\0showreel-missing' ? 'export const mount = () => { throw new Error("Showreel Studio is not installed") }\nexport default ""' : null),
  }],
})

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

createHttp(async (req, res) => {
  // This server reads every indexed file, including personal documents, and has no login.
  // It must only answer this machine: it listens on loopback, and a request whose Host is
  // not a loopback name is refused, which stops a web page from reaching it by rebinding
  // its own domain to 127.0.0.1.
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase()
  if (!LOOPBACK_HOSTS.has(host)) {
    res.writeHead(403, { 'content-type': 'text/plain' })
    return res.end('forbidden host')
  }
  const url = new URL(req.url, 'http://x')
  // The Host check stops reads, not writes: a page on any site can still fire a form POST or an
  // <img> at loopback. Browsers label those requests cross-site, so anything that changes state
  // (every non-GET, and the GETs that launch apps) must come from this origin or be typed in.
  const site = req.headers['sec-fetch-site']
  const acts = !['GET', 'HEAD', 'OPTIONS'].includes(req.method) || url.pathname === '/api/open' || url.pathname === '/api/reveal'
  if (acts && site && site !== 'same-origin' && site !== 'none') {
    res.writeHead(403, { 'content-type': 'application/json' })
    return res.end('{"error":"cross-site request refused"}')
  }
  // mission control: /control is the page, /api/control/* its data (see control-api.mjs)
  if (url.pathname === '/control') {
    res.writeHead(302, { location: '/control.html' })
    return res.end()
  }
  try {
    if (await handleControl(url, res, req)) return
    if (url.pathname.startsWith('/api/showreel/')) {
      if (showreel && (await showreel.handle(req, res))) return
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: `Showreel is not at ${SHOWREEL_DIR}. Clone laika-showreel there, or set SHOWREEL_DIR.` }))
    }
    // Mission Control: the rail's panel and each repo's own (see mission-api.mjs)
    if (await handleMission(url, req, res, { allowed: knownFolders })) return
    // runs: every chat's lanes, jobs, artefacts and verdicts on one page (see runs-api.mjs)
    if (await handleRuns(url, req, res)) return
    // commands a project registered (commands.mjs): the palette's and a run's "Run again"
    if (await handleCommands(url, req, res)) return
    // the profiler panel: the /profiler skill's sampler, passed through (see profiler-api.mjs)
    if (await handleProfiler(url, req, res)) return
    // adoption pulse: the public + opted-in node network at /pulse (see pulse-api.mjs)
    if (await handlePulse(url, req, res)) return
    // the Users panel: waitlist, Stripe and opt-in usage as people (see users-api.mjs)
    if (await handleUsers(url, req, res)) return
    // voice prompting: local whisper transcription (see voice.mjs)
    // Orbit Pro licence: activation and status (see license.mjs)
    if (await handleLicense(url, req, res)) return
    if (await handleVoice(url, req, res)) return
    // Supabase: each account's projects, their schemas and the SQL console (see supabase.mjs)
    if (await handleSupabase(url, req, res)) return
    if (url.pathname === '/api/version') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(await appVersion()))
    }
    if (url.pathname === '/api/loadwatch') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(loadWatch.state()))
    }
    if (url.pathname === '/api/sysres') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(await sysres({ detail: url.searchParams.has('detail') })))
    }
    if (url.pathname === '/api/graph') {
      const g = await graph()
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(g))
    }
    if (url.pathname === '/api/recall') {
      const q = url.searchParams.get('q') || ''
      if (!q) { res.writeHead(400); return res.end('{"error":"q required"}') }
      const r = await recall(await index(), store, q)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(r))
    }
    if (url.pathname === '/api/index' && req.method === 'GET') {
      await index()
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      const builtin = {
        ignoreDirs: DEFAULT_IGNORE,
        binary: BINARY.source.match(/\(([^)]*)\)/)?.[1].split('|') ?? [],
        noise: NOISE.source.match(/\(([^)]*)\)/)?.[1].split('|') ?? [],
      }
      return res.end(JSON.stringify({ config: cfg, defaults: DEFAULT_CONFIG, builtin, status: await indexStatus(), canEdit: isLocal(req) }))
    }
    if (url.pathname === '/api/index/files') {
      const i = await index()
      const q = (url.searchParams.get('q') || '').toLowerCase()
      const src = url.searchParams.get('source') || ''
      const sort = url.searchParams.get('sort') || 'path'
      const limit = Math.min(500, Number(url.searchParams.get('limit')) || 200)
      let rows = i.docs.map((d) => ({
        path: d.path, bytes: d.bytes, mtimeMs: d.mtimeMs, source: store.sourceOf(d.path),
        tokens: i.contentTokens.get(d.path)?.length ?? 0,
      }))
      if (q) rows = rows.filter((r) => r.path.toLowerCase().includes(q))
      // pattern tester: which indexed files a rule would catch (matched per source-relative path)
      const pat = url.searchParams.get('pattern')
      if (pat) {
        const m = compilePattern(pat)
        rows = rows.filter((r) => m(r.path.replace(/^@[^/]+\//, '')))
      }
      if (src) rows = rows.filter((r) => r.source === src)
      const by = { path: (a, b) => a.path.localeCompare(b.path), bytes: (a, b) => b.bytes - a.bytes,
        tokens: (a, b) => b.tokens - a.tokens, mtime: (a, b) => b.mtimeMs - a.mtimeMs }
      rows.sort(by[sort] ?? by.path)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ total: rows.length, rows: rows.slice(0, limit) }))
    }
    if (url.pathname === '/api/index/doc') {
      const i = await index()
      const p = url.searchParams.get('path') || ''
      const id = i.byPath.get(p)
      if (id === undefined) { res.writeHead(404); return res.end('{"error":"not indexed"}') }
      const d = i.docs[id]
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ ...d, source: store.sourceOf(p), tokens: i.contentTokens.get(p) ?? [] }))
    }
    if (url.pathname.startsWith('/api/index/')) {
      // everything below changes what is indexed or looks at the disk: this machine only
      if (!isLocal(req)) { res.writeHead(403); return res.end('{"error":"index controls are local-only"}') }
      if (url.pathname === '/api/index/config' && req.method === 'PUT') {
        let next
        try {
          next = await saveIndexConfig(ROOT, await readJson(req))
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: String(e.message ?? e) }))
        }
        cfg = next
        store = new SourcedStore(ROOT, cfg)
        // settings like token caps change cached tokens, so a config change is a full build
        await index({ force: true, full: true, reason: 'config saved' })
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ config: cfg, status: await indexStatus() }))
      }
      if (url.pathname === '/api/index/rebuild' && req.method === 'POST') {
        const { full = false } = await readJson(req)
        await index({ force: true, full, reason: full ? 'full rebuild' : 'rebuild' })
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ status: await indexStatus() }))
      }
      if (url.pathname === '/api/index/preview' && req.method === 'POST') {
        let out
        try {
          out = await previewIndex(await readJson(req))
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: String(e.message ?? e) }))
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(out))
      }
      if (url.pathname === '/api/index/dirs') {
        // folder picker for adding a source
        const raw = url.searchParams.get('path') || homedir()
        const dir = sourceDir(ROOT, { path: raw })
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
        res.writeHead(entries ? 200 : 404, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({
          path: dir,
          parent: dirname(dir) === dir ? null : dirname(dir),
          dirs: (entries ?? []).filter((e) => e.isDirectory() && !e.name.startsWith('.'))
            .map((e) => e.name).sort((a, b) => a.localeCompare(b)),
        }))
      }
    }
    if (url.pathname === '/api/widgets') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(await readWidgets()))
    }
    if (url.pathname.startsWith('/api/gmail/')) {
      if (!isLocal(req)) { res.writeHead(403); return res.end('{"error":"local-only"}') }
      const page = (title, body) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;background:#07080d;color:#e8ecf8;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:520px"><h2 style="margin:0 0 8px">${title}</h2><p style="color:#8892ad;line-height:1.6">${body}</p></div>`)
      }
      if (url.pathname === '/api/gmail/status') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        return res.end(JSON.stringify({ ...email, redirectUri: GMAIL_REDIRECT, pollSecs: EMAIL_SECS }))
      }
      if (url.pathname === '/api/gmail/connect') {
        if (!GMAIL_ON) return page('Gmail feed is off', 'GMAIL_FEED=0 is set for this server.')
        if (!G_ID || !G_SECRET) {
          return page('Gmail is not configured', 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.local in the repo root, add <code>' + GMAIL_REDIRECT + '</code> as an authorised redirect URI on that OAuth client, then restart the server.')
        }
        const state = randomBytes(18).toString('hex')
        const cutoff = Date.now() - 10 * 60_000
        for (const [k, t] of gmailStates) if (t < cutoff) gmailStates.delete(k)
        gmailStates.set(state, Date.now())
        res.writeHead(302, { location: authorizeUrl({ clientId: G_ID, redirectUri: GMAIL_REDIRECT, state }) })
        return res.end()
      }
      if (url.pathname === '/api/gmail/callback') {
        const state = url.searchParams.get('state') ?? ''
        const issued = gmailStates.get(state)
        gmailStates.delete(state)
        if (!issued || Date.now() - issued > 10 * 60_000) return page('Sign-in expired', 'Start again from the email widget.')
        if (url.searchParams.get('error')) return page('Gmail was not connected', `Google said: ${String(url.searchParams.get('error')).replace(/[<>&]/g, '')}`)
        try {
          const token = await exchangeCode({ clientId: G_ID, clientSecret: G_SECRET, redirectUri: GMAIL_REDIRECT, code: url.searchParams.get('code') ?? '' })
          await saveRefreshToken(token)
          resetEmailCache()
          email.status = 'starting'
          email.error = null
          await pollEmail()
          if (email.status !== 'live') return page('Connected, but the first sync failed', String(email.error ?? '').replace(/[<>&]/g, ''))
          return page('Gmail connected', `Read-only access. ${email.count} messages from the last 7 days synced; the widget now refreshes every ${EMAIL_SECS}s. You can close this tab.`)
        } catch (e) {
          return page('Gmail was not connected', String(e.message ?? e).replace(/[<>&]/g, ''))
        }
      }
    }
    if (url.pathname === '/api/settings' || url.pathname === '/api/profile' || url.pathname.startsWith('/api/settings/') || url.pathname === '/api/calendar/sync') {
      if (!isLocal(req)) { res.writeHead(403); return res.end('{"error":"local-only"}') }
      const json = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        return res.end(JSON.stringify(body))
      }
      if (url.pathname === '/api/profile' && req.method === 'PUT') {
        let p
        try { p = normaliseProfile(await readJson(req)) } catch (e) { return json(400, { error: String(e.message ?? e) }) }
        await mkdir(dirname(PROFILE_FILE), { recursive: true })
        await writeFile(PROFILE_FILE, `${JSON.stringify(p, null, 2)}\n`)
        return json(200, { profile: p })
      }
      if (url.pathname === '/api/calendar/sync' && req.method === 'POST') {
        if (!CAL_URLS.length) return json(400, { error: 'no calendar feeds configured' })
        await pollCalendar()
        return json(calError ? 502 : 200, { ok: !calError, error: calError, count: calendar.count })
      }
      if (url.pathname === '/api/settings/reset-layout' && req.method === 'POST') {
        await writeFile(SETTINGS_FILE, '{}\n')
        return json(200, { ok: true })
      }
      if (url.pathname === '/api/settings') {
        const i = await index()
        let agents = null
        try { agents = (await agentsWidget()).config } catch {}
        const ignored = async (rel) => {
          try { await promisify(execFile)('git', ['-C', ROOT, 'check-ignore', '-q', rel]); return true } catch { return false }
        }
        return json(200, {
          profile: await readProfile(),
          macTimeZone: MAC_TZ,
          connections: {
            gmail: { ...email, enabled: GMAIL_ON, configured: !!(G_ID && G_SECRET), pollSecs: EMAIL_SECS },
            calendar: { feeds: CAL_URLS.length, everyMins: CAL_MINS, at: calendar.at, count: calendar.count, error: calError },
            index: i ? { files: i.docs.length, sources: cfg.sources.filter((s) => s.enabled).length, builtAt: built, ms: lastBuild?.ms ?? null } : null,
            agents,
            connectors: CONNECTORS,
          },
          storage: {
            envLocal: { path: '.env.local', ignored: await ignored('.env.local') },
            profile: { path: 'brain/profile.local.json', ignored: await ignored('brain/profile.local.json') },
            widgetLayout: { path: 'brain/widgets/_settings.json', ignored: await ignored('brain/widgets/_settings.json') },
            indexConfig: { path: CONFIG_PATH, ignored: await ignored(CONFIG_PATH) },
            synced: { path: 'brain/widgets/email.json, calendar.json', ignored: (await ignored('brain/widgets/email.json')) && (await ignored('brain/widgets/calendar.json')) },
          },
        })
      }
    }
    if (url.pathname === '/api/gmail/sync' && req.method === 'POST') {
      if (!isLocal(req)) { res.writeHead(403); return res.end('{}') }
      if (email.status === 'live' || email.status === 'starting') await pollEmail()
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(email))
    }
    if (url.pathname === '/api/gmail/disconnect' && req.method === 'POST') {
      if (!isLocal(req)) { res.writeHead(403); return res.end('{}') }
      const token = await readRefreshToken()
      let revoked = false
      if (token && !process.env.GMAIL_REFRESH_TOKEN) {
        revoked = await revokeToken(token).catch(() => false)
        await deleteRefreshToken()
      }
      resetEmailCache()
      if (email.status !== 'off' && email.status !== 'unconfigured') Object.assign(email, { status: 'needs-connect', error: null, account: '' })
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ revoked, status: email.status }))
    }
    if (url.pathname === '/api/widget-settings' && req.method === 'PATCH') {
      if (!isLocal(req)) { res.writeHead(403); return res.end('{"error":"widget settings are local-only"}') }
      try {
        const cur = await patchWidgetSettings(await readJson(req))
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(cur))
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: String(e.message ?? e) }))
      }
    }
    if (url.pathname.startsWith('/api/widgets/')) {
      const id = url.pathname.slice('/api/widgets/'.length)
      if (req.method === 'POST') {
        // the integration surface for anything outside this repo
        const chunks = []
        for await (const c of req) chunks.push(c)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        const doc = await writeWidget(id, body)
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(doc))
      }
      const all = await readWidgets()
      const one = all.find(w => w.id === id)
      res.writeHead(one ? 200 : 404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(one ?? { error: 'not found' }))
    }
    // Raw file bytes for Quick Look. Path-style (/raw/<index path>) so relative URLs inside
    // a markdown or HTML file resolve to their neighbours. Serves any indexed file, and
    // media/CSS/fonts that sit inside an index source (images a README embeds are not
    // indexed themselves). Nothing may resolve outside its source folder, symlinks included.
    if (url.pathname.startsWith('/raw/')) {
      let rel
      try { rel = decodeURIComponent(url.pathname.slice(5)) } catch { res.writeHead(400); return res.end() }
      if (!rel || rel.split('/').some((s) => s === '..' || s === '')) { res.writeHead(403); return res.end() }
      const known = (await index()).byPath.has(rel)
      if (!known && !RAW_MEDIA.test(rel)) { res.writeHead(403); return res.end() }
      const part = store.parts.find((p) => p.prefix && rel.startsWith(p.prefix)) ?? store.parts.find((p) => !p.prefix)
      if (!part) { res.writeHead(404); return res.end() }
      let abs
      try {
        abs = await realpath(store.abs(rel))
        const root = await realpath(part.store.root())
        if (!abs.startsWith(root + sep)) { res.writeHead(403); return res.end() }
      } catch { res.writeHead(404); return res.end() }
      const st = await stat(abs).catch(() => null)
      if (!st?.isFile()) { res.writeHead(404); return res.end() }
      const ext = (rel.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()
      const headers = {
        'content-type': RAW_TYPES[ext] ?? 'application/octet-stream',
        'accept-ranges': 'bytes',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'content-disposition': 'inline',
      }
      // a served HTML or SVG file must never run script, even if opened directly
      if (ext === 'html' || ext === 'htm' || ext === 'svg') headers['content-security-policy'] = "sandbox; default-src 'self' data:; style-src 'self' 'unsafe-inline' data:"
      // byte ranges, so video can seek and Safari will play it at all
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
      if (range && (range[1] || range[2])) {
        let start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]))
        let end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1
        if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end() }
        res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 })
        return createReadStream(abs, { start, end }).pipe(res)
      }
      res.writeHead(200, { ...headers, 'content-length': st.size })
      return createReadStream(abs).pipe(res)
    }
    if (url.pathname === '/api/thumb') {
      const rel = url.searchParams.get('path') || ''
      const size = THUMB_SIZES.includes(Number(url.searchParams.get('s'))) ? Number(url.searchParams.get('s')) : 320
      if (!(await index()).byPath.has(rel)) { res.writeHead(403); return res.end() }
      if (!THUMBABLE.test(rel)) { res.writeHead(415); return res.end() }
      const file = await thumbnail(rel, size).catch(() => null)
      if (!file) { res.writeHead(404, { 'cache-control': 'no-store' }); return res.end() }
      const st = await stat(file)
      // the URL carries the file's mtime (&v=), so the browser may keep this for good
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': st.size, 'cache-control': 'private, max-age=31536000, immutable' })
      return createReadStream(file).pipe(res)
    }
    if (url.pathname === '/api/open') {
      // open in the default app — Quick Look's "Open with…"
      const rel = url.searchParams.get('path') || ''
      if (!(await index()).byPath.has(rel)) { res.writeHead(403); return res.end('{}') }
      execFile('open', [store.abs(rel)], () => {})
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"ok":true}')
    }
    if (url.pathname === '/api/reveal') {
      // open the file in Finder — the thing you actually want after finding it
      const rel = url.searchParams.get('path') || ''
      if (!(await index()).byPath.has(rel)) { res.writeHead(403); return res.end('{}') }
      execFile('open', ['-R', store.abs(rel)], () => {})
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"ok":true}')
    }
    if (url.pathname === '/api/file') {
      const p = url.searchParams.get('path') || ''
      const known = (await index()).byPath.has(p)
      const text = known ? await store.readDoc(p).catch(() => null) : null
      res.writeHead(text === null ? 404 : 200, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end(text ?? 'not found')
    }
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: String(e) }))
  }
  vite.middlewares(req, res)
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Laika Orbit   →  http://localhost:${PORT}`)
  appVersion().then((v) => console.log(`  version       →  ${v.label}`))
  console.log(`  brain root    →  ${ROOT}`)
  console.log(`  email         →  ${{ off: 'off (GMAIL_FEED=0)', unconfigured: 'no Gmail app (set GOOGLE_CLIENT_ID/SECRET in .env.local)', starting: `Gmail API every ${EMAIL_SECS}s` }[email.status] ?? email.status}`)
  console.log(`  calendar      →  ${CAL_URLS.length ? `${CAL_URLS.length} iCal feed(s) every ${CAL_MINS}m` : 'no feed (set CALENDAR_ICS_URLS in .env.local)'}`)
  console.log(`  showreel      →  ${showreel ? SHOWREEL_DIR : `not found (clone laika-showreel to ${SHOWREEL_DIR}, or set SHOWREEL_DIR)`}`)
  // reporting only ever starts when this Mac has opted in; startReporting is a no-op otherwise
  appVersion().then((v) => startReporting({ app: v.version }))
  console.log(`  HMR live. Edit packages/app/src/*.ts and the browser updates.\n`)
})
