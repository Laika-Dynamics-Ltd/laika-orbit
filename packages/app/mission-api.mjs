/**
 * Mission Control API — the build panel (lanes, checkpoints, verdicts, learning, chat) for each
 * repo that declares one with a mission.config.mjs.
 *
 * The panel is Mission Control's own server (MISSION_DIR, a checkout of mission-control), one
 * process per repo. A repo's panel is found wherever it already runs — a launchd service
 * (dev.laika.<name>.panel, which mission-control's service.mjs installs) or one this server
 * started — by asking each
 * candidate port's /health which root it serves. A panel is only ever started when asked, because
 * it writes <repo>/.panel/ and runs the repo's checks on every source save. Panels started here
 * stop with this server.
 *
 * Routes:
 *   GET  /api/mission                     the rail's panel (MISSION_URL, else 7317): up, waiting on a verdict
 *   GET  /api/mission/roots?root=<path>   the repos at or inside a folder that have a panel of their own
 *   GET  /api/mission/panel?root=<path>   that repo's panel: configured, running, url, waiting
 *   POST /api/mission/panel/start {root}  start it (a known repo with its own config only)
 *   POST /api/mission/panel/stop  {root}  stop one this server started
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const HOME = homedir()
const MISSION_URL = (process.env.MISSION_URL || 'http://127.0.0.1:7317').replace(/\/+$/, '')
// without MISSION_URL, and with nothing answering, the rail leaves the Mission button out
const MISSION_SET = Boolean(process.env.MISSION_URL)
const AGENTS = join(HOME, 'Library', 'LaunchAgents')
/** ports of panels this server (or a previous run of it that died without cleaning up) started */
const STATE = join(HOME, '.laika', `mission-panels-${process.env.PORT || 5200}.json`)

/**
 * root (real path, no trailing slash) → the panel process this server started: its child, or
 * only a pid when it was adopted from a run of this server that died without stopping it
 */
const started = new Map()
const kill = (p) => {
  try {
    p.child ? p.child.kill() : process.kill(p.pid, 'SIGTERM')
  } catch {}
}

const clean = (p) => String(p).replace(/\/+$/, '')
const real = (p) => realpath(p).then(clean, () => clean(resolve(p)))

/**
 * A panel answers /health between rebuilds, and a rebuild of a big repo takes seconds (~4s has
 * been seen), so a slow answer is a busy panel, not a missing one.
 */
const HEALTH_MS = 6000
async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(HEALTH_MS) })
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}

/** Something is accepting connections on the port: a panel too busy to answer is still there. */
const listening = (port) =>
  new Promise((ok) => {
    const sock = connect({ port, host: '127.0.0.1' })
    const done = (yes) => {
      sock.destroy()
      ok(yes)
    }
    sock.setTimeout(800, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })

/**
 * A repo that has a panel of its own: its own mission.config.mjs in a main checkout. A worktree
 * carries a copy of the config, but it belongs to the repo it came from, whose panel already
 * reads its worktrees.
 */
export function configured(root) {
  try {
    return existsSync(join(root, 'mission.config.mjs')) && statSync(join(root, '.git')).isDirectory()
  } catch {
    return false
  }
}

const unxml = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/**
 * The mission-control checkout to start panels from: MISSION_DIR, else the one an installed panel
 * service already runs, so a machine that has a panel needs no setting.
 */
async function missionDir() {
  if (process.env.MISSION_DIR) return resolve(process.env.MISSION_DIR)
  for (const l of await launchdPanels()) if (l.server) return dirname(l.server)
  return null
}

/** Panels installed as launchd services (mission-control's service.mjs writes these). */
async function launchdPanels() {
  let names = []
  try {
    names = (await readdir(AGENTS)).filter((n) => n.endsWith('.panel.plist'))
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    try {
      const x = await readFile(join(AGENTS, n), 'utf8')
      const val = (k) => x.match(new RegExp(`<key>${k}</key>\\s*<string>([^<]*)</string>`))?.[1]
      const root = val('PANEL_ROOT')
      const port = Number(val('PANEL_PORT'))
      const server = x.match(/<string>([^<]*\/server\.mjs)<\/string>/)?.[1]
      if (root && port)
        out.push({
          label: n.replace(/\.plist$/, ''),
          root: unxml(root),
          port,
          server: server ? unxml(server) : null,
        })
    } catch {}
  }
  return out
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return {}
  }
}
function writeState() {
  try {
    mkdirSync(join(HOME, '.laika'), { recursive: true })
    const s = {}
    for (const [root, p] of started) s[root] = { port: p.port, pid: p.pid }
    writeFileSync(STATE, JSON.stringify(s))
  } catch {}
}

/** The running panel for a repo, wherever it was started, or null. */
async function findPanel(root) {
  const want = await real(root)
  const candidates = []
  const own = started.get(want)
  if (own) candidates.push({ port: own.port, managed: true })
  for (const l of await launchdPanels())
    if ((await real(l.root)) === want) candidates.push({ port: l.port, label: l.label })
  const left = readState()[want]
  if (!own && left?.port) candidates.push({ port: left.port, pid: left.pid, managed: true })
  for (const c of candidates) {
    const h = await health(c.port)
    // too busy to answer, yet listening where this repo's panel was put: it is still this repo's.
    // Starting another would give the repo two panels writing the same verdicts.
    if (!h && (await listening(c.port))) {
      if (c.pid && !started.has(want)) started.set(want, { port: c.port, pid: c.pid })
      return { ...c, busy: true, health: {} }
    }
    // gone: forget a panel of ours that is no longer there
    if (!h && started.get(want)?.port === c.port) {
      started.delete(want)
      writeState()
    }
    if (!h || (await real(h.root ?? '')) !== want) continue
    // left running by an earlier run of this server: it is ours to stop again
    if (c.pid && !started.has(want)) started.set(want, { port: c.port, pid: c.pid })
    return { ...c, health: h }
  }
  return null
}

function describe(root, panel) {
  const base = { root, configured: configured(root) }
  if (!panel) return { ...base, running: false }
  const h = panel.health
  return {
    ...base,
    running: true,
    url: `http://127.0.0.1:${panel.port}`,
    port: panel.port,
    name: h.name ?? null,
    waiting: Number(h.status?.waiting ?? 0),
    /** started by this server, so it can stop it; a launchd service is the user's to manage */
    managed: !!panel.managed,
    service: panel.label ?? null,
    /** listening but did not answer in time: its page loads once it has finished rebuilding */
    busy: !!panel.busy,
  }
}

const freePort = () =>
  new Promise((ok, fail) => {
    const probe = createServer()
    probe.on('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => ok(port))
    })
  })

async function startPanel(root) {
  const dir = await missionDir()
  if (!dir || !existsSync(join(dir, 'server.mjs')))
    throw new Error(
      dir
        ? `Mission Control is not at ${dir}. Set MISSION_DIR to its checkout.`
        : 'No Mission Control checkout found. Set MISSION_DIR to it when starting the server.',
    )
  const found = await findPanel(root)
  if (found) return found
  const want = await real(root)
  const port = await freePort()
  mkdirSync(join(want, '.panel'), { recursive: true })
  const log = openSync(join(want, '.panel', 'panel.log'), 'a')
  const env = { ...process.env }
  // this server's own settings must not leak into the panel's
  for (const k of ['PANEL_ROOT', 'PANEL_PORT', 'PORT', 'NO_HMR']) delete env[k]
  const child = spawn(
    process.execPath,
    [join(dir, 'server.mjs'), '--root', `${want}/`, '--port', String(port)],
    { cwd: want, env, stdio: ['ignore', log, log] },
  )
  let exited = null
  child.once('exit', (code, signal) => {
    exited = code ?? signal
    if (started.get(want)?.child === child) {
      started.delete(want)
      writeState()
    }
  })
  started.set(want, { port, pid: child.pid, child })
  writeState()
  for (const until = Date.now() + 20_000; Date.now() < until; ) {
    if (exited !== null) break
    const h = await health(port)
    if (h) return { port, managed: true, health: h }
    await new Promise((r) => setTimeout(r, 300))
  }
  child.kill()
  let tail = ''
  try {
    tail = readFileSync(join(want, '.panel', 'panel.log'), 'utf8').trim().split('\n').slice(-6).join('\n')
  } catch {}
  throw new Error(
    `the panel did not start${exited !== null ? ` (exited with ${exited})` : ''}${tail ? `:\n${tail}` : ''}`,
  )
}

// panels started here stop with this server
const stopAll = () => {
  for (const p of started.values()) kill(p)
  started.clear()
  writeState()
}
process.once('exit', stopAll)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.once(sig, () => {
    stopAll()
    process.exit(0)
  })

async function railState() {
  const up = await (async () => {
    try {
      const r = await fetch(`${MISSION_URL}/health`, { signal: AbortSignal.timeout(HEALTH_MS) })
      if (!r.ok) throw new Error(`health answered ${r.status}`)
      return { h: await r.json() }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })()
  if (!up.h) return { url: MISSION_URL, configured: MISSION_SET, up: false, error: up.error }
  const h = up.h
  return {
    url: MISSION_URL,
    configured: MISSION_SET,
    up: true,
    name: h.name ?? null,
    waiting: Number(h.status?.waiting ?? 0),
    done: h.status?.done ?? null,
    total: h.status?.total ?? null,
    checks: h.status?.checks ?? null,
  }
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * @param {URL} url
 * @param {{ allowed(): Promise<Set<string>> }} opts  the folders already known as repos or projects
 */
export async function handleMission(url, req, res, opts) {
  if (url.pathname === '/api/mission') {
    json(res, 200, await railState())
    return true
  }
  if (url.pathname === '/api/mission/roots') {
    const root = clean(url.searchParams.get('root') ?? '')
    const known = await opts.allowed()
    if (!root || !known.has(root)) {
      json(res, 403, { error: 'folder is not a known repo' })
      return true
    }
    // a project folder (several repos) lists the ones inside it; a repo, itself
    const roots = [...known]
      .filter((p) => (p === root || p.startsWith(`${root}/`)) && configured(p))
      .sort((a, b) => a.localeCompare(b))
    json(res, 200, { root, roots })
    return true
  }
  if (!url.pathname.startsWith('/api/mission/panel')) return false

  let root
  if (req.method === 'GET') {
    root = url.searchParams.get('root')
  } else {
    // same rule as agent control's writes: a page on another site cannot send this header
    const site = req.headers['sec-fetch-site']
    if (req.headers['x-control'] !== '1' || (site && site !== 'same-origin' && site !== 'none')) {
      json(res, 403, { error: 'forbidden' })
      return true
    }
    const chunks = []
    for await (const c of req) chunks.push(c)
    try {
      root = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').root
    } catch {}
  }
  // starting a panel runs the repo's config as code, so only folders 1brain already knows as repos
  if (typeof root !== 'string' || !(await opts.allowed()).has(root)) {
    json(res, 403, { error: 'folder is not a known repo' })
    return true
  }

  if (url.pathname === '/api/mission/panel' && req.method === 'GET') {
    json(res, 200, configured(root) ? describe(root, await findPanel(root)) : { root, configured: false, running: false })
    return true
  }
  if (url.pathname === '/api/mission/panel/start' && req.method === 'POST') {
    if (!configured(root)) {
      json(res, 400, { error: 'this repo has no mission.config.mjs of its own' })
      return true
    }
    try {
      json(res, 200, describe(root, await startPanel(root)))
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) })
    }
    return true
  }
  if (url.pathname === '/api/mission/panel/stop' && req.method === 'POST') {
    const p = started.get(await real(root))
    if (!p) {
      json(res, 400, { error: 'no panel started here for this repo' })
      return true
    }
    kill(p)
    started.delete(await real(root))
    writeState()
    json(res, 200, { root, configured: configured(root), running: false })
    return true
  }
  json(res, 404, { error: 'not found' })
  return true
}
