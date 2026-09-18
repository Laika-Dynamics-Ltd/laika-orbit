/**
 * Mission control API — what a developer running many AI agent sessions across many
 * projects needs to see at a glance: which sessions are waiting on them, which are
 * working, which repos hold work that isn't safe yet, and what happened in the last day.
 *
 * Everything is read from this machine: Claude Code session transcripts under
 * ~/.claude/projects, git state under the dev roots, and agent memory notes. Nothing is
 * sent anywhere, and the server only listens on loopback.
 *
 * Routes (all GET unless noted):
 *   /api/control/sessions   sessions touched in the last 48h, with state
 *   /api/control/repos      git repos with branch, uncommitted, unpushed, recency
 *   /api/control/projects   folders under a dev root that hold several repos
 *   /api/control/usage      plan usage (5-hour, week) for each signed-in Claude account
 *   /api/control/activity   last 24h per project: sessions, commits, memory notes
 *   /api/control/moments    ?hours=12|24|48[&project=] — work, commits and notes as one history
 *   /api/control/ring       sessions and loose-end repos, addressed as index paths for the ring
 *   /api/control/open       POST-free action: open a known path in Finder/editor/terminal
 *   /api/control/library    every chat, paged and filtered (see chat-library.mjs):
 *                           ?q=&project=&account=&state=here|other&pinned=1&archived=1|only
 *                           &sort=updated|created|title&limit=&cursor=
 *   /api/control/library/search  ?q=[&archived=1][&cursor=] — words inside messages, a bounded step at a time
 *   /api/control/library/meta    GET the store · POST { id, patch } · POST { migrate: { names, colours } }
 *   /api/control/library/delete  POST { id } — transcript, brief and entry to the Trash
 */
import { execFile, spawn } from 'node:child_process'
import { openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { open as fsOpen, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadIndexConfig, sourceDir } from '@laika/core'
import { createNodeRouter, LOCAL } from './nodes.mjs'
import { canRun, capsOf, createTunnelPool, discover, openTunnel, parseAddress, readMachines, remoteDir, routesOf, saveMachineState, syncDown, syncUp, writeMachines } from './machines.mjs'
import { isWindows, openGate, winHealth } from './windows.mjs'
import { promisify } from 'node:util'
import { deleteChat, listChats, migrateEntries, patchEntry, readLibrary, scanChats, searchChats } from './chat-library.mjs'

const run = promisify(execFile)
const HOME = homedir()
const PROJECTS = join(HOME, '.claude', 'projects')

/**
 * Every Claude account's transcript folder: the default login (~/.claude) plus each account
 * added in the app (brain/agents.local.json), so sessions on a second account show up too and
 * resume on the account they belong to.
 */
function projectRoots() {
  let list = []
  try {
    list = JSON.parse(readFileSync(join(BRAIN_ROOT, 'brain', 'agents.local.json'), 'utf8')).accounts ?? []
  } catch {}
  const expand = (d) => resolve(String(d).replace(/^~(?=\/|$)/, HOME))
  const roots = new Map([[PROJECTS, list.find((a) => expand(a.configDir) === join(HOME, '.claude'))?.id ?? null]])
  for (const a of list) {
    if (!a?.configDir) continue
    roots.set(join(expand(a.configDir), 'projects'), String(a.id))
  }
  return [...roots].map(([dir, account]) => ({ dir, account }))
}
const DEV_ROOTS = (process.env.DEV_ROOTS ?? join(HOME, 'dev')).split(':').filter(Boolean)
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', '.venv', 'Pods', 'DerivedData'])

// ------------------------------------------------------------------ helpers ----
async function readTail(path, bytes) {
  const fh = await fsOpen(path, 'r')
  try {
    const { size } = await fh.stat()
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    const text = buf.toString('utf8')
    // the first line of a tail read is usually cut mid-record
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    await fh.close()
  }
}

async function readHead(path, bytes) {
  const fh = await fsOpen(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    const cut = text.lastIndexOf('\n')
    return cut > 0 ? text.slice(0, cut) : text
  } finally {
    await fh.close()
  }
}

const parseLines = (text) =>
  text.split('\n').flatMap((l) => {
    if (!l.trim()) return []
    try {
      return [JSON.parse(l)]
    } catch {
      return []
    }
  })

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c?.type === 'text')
    .map((c) => c.text)
    .join(' ')
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** A user message that is a real prompt, not a tool result or a harness wrapper. */
const isHumanPrompt = (r) => {
  if (r.type !== 'user' || r.isSidechain) return false
  const c = r.message?.content
  const t = typeof c === 'string' ? c : Array.isArray(c) && c.every((x) => x.type === 'text') ? textOf(c) : ''
  return !!t.trim() && !/^<(command-|local-command|system-reminder|task-notification)/.test(t.trim())
}

async function cached(key, ttlMs, fn) {
  const hit = CACHE.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value
  const value = await fn()
  CACHE.set(key, { at: Date.now(), value })
  return value
}
const CACHE = new Map()
const INFLIGHT = new Map()
/**
 * Like cached, but an expired value is served at once while a fresh one is worked out behind it:
 * for results that take seconds to compute and are fine a minute old.
 */
async function fresh(key, ttlMs, fn) {
  const hit = CACHE.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value
  if (!INFLIGHT.has(key)) {
    const job = fn()
      .then((value) => CACHE.set(key, { at: Date.now(), value }))
      .finally(() => INFLIGHT.delete(key))
    INFLIGHT.set(key, job)
  }
  if (hit) {
    INFLIGHT.get(key).catch(() => {})
    return hit.value
  }
  await INFLIGHT.get(key)
  return CACHE.get(key).value
}

// ----------------------------------------------------------------- sessions ----
/** Working directories of running `claude` processes, with a count per directory. */
async function liveCwds() {
  const out = new Map()
  try {
    const { stdout } = await run('pgrep', ['-x', 'claude'])
    const pids = stdout.split('\n').filter(Boolean)
    await Promise.all(
      pids.map(async (pid) => {
        try {
          const { stdout: l } = await run('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'])
          const cwd = l.split('\n').find((x) => x.startsWith('n'))?.slice(1)
          if (cwd) out.set(cwd, (out.get(cwd) ?? 0) + 1)
        } catch {}
      }),
    )
  } catch {}
  return out
}

/**
 * State of a session from how its main thread last stood:
 *   working   the model or a tool is mid-turn, and the file moved in the last few minutes
 *   blocked   a tool call has sat unanswered — usually a permission prompt, sometimes a long build
 *   needs-you the model finished its turn; it is your move
 *   idle      finished and older than the attention window
 *   ended     mid-turn but no claude process is running in its folder any more
 */
function stateOf(last, ageMin, live) {
  if (!last) return 'idle'
  const stop = last.message?.stop_reason
  const midTurn =
    (last.type === 'assistant' && stop === 'tool_use') ||
    (last.type === 'user' && !isHumanPrompt(last)) ||
    (last.type === 'user' && isHumanPrompt(last))
  if (midTurn) {
    if (!live) return 'ended'
    if (ageMin <= 3) return 'working'
    // an unanswered tool call is usually a permission prompt, and those can wait a long time
    if (last.type === 'assistant') return ageMin <= 12 * 60 ? 'blocked' : 'ended'
    // a model or tool still going after half an hour has stopped, whatever the file says
    return ageMin <= 30 ? 'working' : 'ended'
  }
  // a finished turn only waits on you while the session is still open
  if (live && ageMin <= 12 * 60) return 'needs-you'
  return 'idle'
}

// -------------------------------------------------------------------- ports ----
/** `ps -Ao pid=,lstart=,rss=,args=`: lstart is five fixed tokens, so args can safely run last. */
const PS_LINE = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(\d+)\s+(.*)$/

const ago = (ms) =>
  ms < 60e3
    ? `${Math.round(ms / 1e3)}s`
    : ms < 36e5
      ? `${Math.round(ms / 6e4)}m`
      : ms < 864e5
        ? `${Math.round(ms / 36e5)}h`
        : `${Math.round(ms / 864e5)}d`

/**
 * What is listening locally, and whose it is.
 *
 * Running a dozen agents across a dozen repos means a dozen dev servers, and "what is on 5200,
 * and is it mine" is a question nothing else in the app can answer — you go to the terminal for
 * it. The cwd is the useful half: a port number says nothing, the repo's folder name says everything.
 *
 * Kept to processes that are plausibly yours — a node/bun/python/ruby runtime, or anything
 * whose working directory sits under a dev root. Without that filter this is a list of macOS
 * daemons. POSIX only, which is no loss: the shell ships as a .app.
 */
async function listeners() {
  return cached('ports', 4000, async () => {
    const [lsofOut, psOut] = await Promise.all([
      run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn'])
        .then((r) => r.stdout)
        .catch(() => ''),
      run('ps', ['-Ao', 'pid=,lstart=,rss=,args='])
        .then((r) => r.stdout)
        .catch(() => ''),
    ])

    // lsof -F emits a "p<pid>" record, then an "n<addr>" record per socket it owns
    const ports = new Map()
    let pid = null
    for (const line of lsofOut.split('\n')) {
      if (line.startsWith('p')) pid = line.slice(1).trim()
      else if (line.startsWith('n') && pid) {
        const port = Number(line.trim().match(/:(\d+)$/)?.[1])
        if (!port) continue
        const seen = ports.get(pid) ?? new Set()
        seen.add(port)
        ports.set(pid, seen)
      }
    }
    if (!ports.size) return []

    const info = new Map()
    for (const line of psOut.split('\n')) {
      const m = line.match(PS_LINE)
      if (m && ports.has(m[1])) info.set(m[1], { started: Date.parse(m[2]), rss: Number(m[3]) * 1024, args: m[4] })
    }

    // one lsof for every listening pid at once, rather than one call each
    const cwds = new Map()
    try {
      const { stdout } = await run('lsof', ['-a', '-p', [...ports.keys()].join(','), '-d', 'cwd', '-Fn'])
      let cur = null
      for (const line of stdout.split('\n')) {
        if (line.startsWith('p')) cur = line.slice(1).trim()
        else if (line.startsWith('n') && cur) cwds.set(cur, line.slice(1).trim())
      }
    } catch {}

    const now = Date.now()
    const roots = DEV_ROOTS.map((r) => `${r}/`)
    const out = []
    for (const [id, set] of ports) {
      const p = info.get(id)
      if (!p) continue
      const cwd = cwds.get(id) ?? null
      const runtime = /^\S*\/?(node|bun|deno|python3?|ruby|php)\b/.test(p.args)
      if (!runtime && !(cwd && roots.some((r) => cwd.startsWith(r)))) continue
      out.push({
        pid: Number(id),
        ports: [...set].sort((a, b) => a - b),
        command: p.args.length > 160 ? `${p.args.slice(0, 159)}…` : p.args,
        cwd,
        where: cwd ? cwd.replace(`${HOME}/`, '').replace(/^dev\//, '') : null,
        uptime: Number.isFinite(p.started) ? ago(now - p.started) : null,
        memory: Math.round(p.rss / 1048576),
        self: Number(id) === process.pid,
      })
    }
    // One agent host per session means ten identical rows on ephemeral ports, which buries the
    // handful you actually went looking for. Same command in the same folder collapses to one
    // row carrying the count — which also makes a pile of orphaned helpers visible as a pile.
    const grouped = new Map()
    for (const l of out) {
      const key = `${l.cwd} ${l.command}`
      const g = grouped.get(key)
      if (!g) grouped.set(key, { ...l, count: 1 })
      else {
        g.ports.push(...l.ports)
        g.count++
        g.memory += l.memory
        g.self ||= l.self
      }
    }
    return [...grouped.values()]
      .map((g) => ({ ...g, ports: g.ports.sort((a, b) => a - b) }))
      .sort((a, b) => a.ports[0] - b.ports[0])
  })
}

/** A silence longer than this ends a run of work rather than sitting inside one. */
const RUN_GAP = 15 * 60e3

/**
 * The stretches a session was actually worked, from the timestamps already in its transcript.
 *
 * `started`..`updated` is a LIFETIME, not work: a session first opened a month ago and answered
 * this morning spans both and describes neither, and anything drawing it on a clock has to
 * either lie or give up compressing the silence. Runs are the honest shape.
 *
 * Built from the records the caller already parsed, so this costs no extra read. The price is
 * that a very chatty session can have older runs sitting beyond what the tail reaches; that
 * clips a run short rather than inventing one.
 */
function runsOf(recs, from) {
  const ts = recs
    .map((r) => Date.parse(r.timestamp))
    .filter((t) => Number.isFinite(t) && t >= from)
    .sort((a, b) => a - b)
  const runs = []
  for (const t of ts) {
    const last = runs[runs.length - 1]
    if (last && t - last[1] <= RUN_GAP) last[1] = t
    else runs.push([t, t])
  }
  return runs
}

async function sessions() {
  // reads transcripts from disk: a busy disk must not make every click wait for the rescan
  return fresh('sessions', 4000, async () => {
    const live = await liveCwds()
    const cutoff = Date.now() - 48 * 3600e3
    const files = []
    for (const root of projectRoots()) {
      let dirs = []
      try {
        dirs = await readdir(root.dir)
      } catch {
        continue
      }
      for (const d of dirs) {
        let entries = []
        try {
          entries = await readdir(join(root.dir, d))
        } catch {
          continue
        }
        for (const f of entries) {
          if (!f.endsWith('.jsonl')) continue
          const p = join(root.dir, d, f)
          const st = await stat(p).catch(() => null)
          if (st && st.mtimeMs >= cutoff && st.size > 0) files.push({ p, st, account: root.account })
        }
      }
    }
    const out = await Promise.all(
      files.map(async ({ p, st, account }) => {
        const tail = parseLines(await readTail(p, 400_000))
        let recs = tail
        let cwd = [...recs].reverse().find((r) => r.cwd)?.cwd
        let title = [...recs].reverse().find((r) => r.type === 'ai-title')?.aiTitle
        if (!title || !cwd) {
          const head = parseLines(await readHead(p, 200_000))
          cwd ??= head.find((r) => r.cwd)?.cwd
          title ??= [...head].reverse().find((r) => r.type === 'ai-title')?.aiTitle
          recs = head.concat(tail)
        }
        const main = tail.filter((r) => (r.type === 'user' || r.type === 'assistant') && !r.isSidechain)
        const last = main[main.length - 1]
        const lastPrompt = [...tail].reverse().find((r) => r.type === 'last-prompt')?.lastPrompt
        const lastHuman = [...main].reverse().find(isHumanPrompt)
        const lastAssistantText = [...main].reverse().find((r) => r.type === 'assistant' && textOf(r.message?.content).trim())
        const firstTs = recs.find((r) => r.timestamp)?.timestamp
        const ageMin = (Date.now() - st.mtimeMs) / 60000
        const lastTool =
          last?.type === 'assistant' && Array.isArray(last.message?.content)
            ? last.message.content.find((c) => c.type === 'tool_use')?.name
            : undefined
        return {
          id: basename(p, '.jsonl'),
          account,
          project: cwd ? cwd.replace(`${HOME}/`, '').replace(/^dev\//, '') : basename(join(p, '..')),
          cwd: cwd ?? null,
          branch: [...tail].reverse().find((r) => r.gitBranch)?.gitBranch ?? null,
          title: clip(title ?? lastPrompt ?? textOf(lastHuman?.message?.content), 90),
          ask: clip(lastPrompt ?? textOf(lastHuman?.message?.content), 160),
          latest: clip(textOf(lastAssistantText?.message?.content), 240),
          lastTool: lastTool ?? null,
          last,
          ageMin,
          started: firstTs ?? null,
          updated: new Date(st.mtimeMs).toISOString(),
          runs: runsOf(recs, cutoff),
          waitingMin: Math.round(ageMin),
        }
      }),
    )
    // Several sessions can share a folder, and a running process can't be tied to its
    // transcript directly. Per folder, only as many of the most recently updated sessions as
    // there are running processes count as live.
    const byCwd = new Map()
    for (const x of out) {
      if (!x.cwd) continue
      byCwd.set(x.cwd, [...(byCwd.get(x.cwd) ?? []), x])
    }
    for (const [cwd, group] of byCwd) {
      group.sort((a, b) => a.ageMin - b.ageMin)
      // CONTROL_ASSUME_LIVE: a demo world has no claude processes to find
      const n = process.env.CONTROL_ASSUME_LIVE === '1' ? Number.POSITIVE_INFINITY : (live.get(cwd) ?? 0)
      group.forEach((x, k) => {
        x.live = k < n
      })
    }
    for (const x of out) {
      x.live ??= false
      x.state = stateOf(x.last, x.ageMin, x.live)
      delete x.last
      delete x.ageMin
    }
    const rank = { 'needs-you': 0, blocked: 1, working: 2, ended: 3, idle: 4 }
    return out.sort((a, b) => rank[a.state] - rank[b.state] || a.waitingMin - b.waitingMin)
  })
}

// -------------------------------------------------------------------- repos ----
async function findRepos(root, depth = 0, out = []) {
  if (depth > 3) return out
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  if (entries.some((e) => e.name === '.git')) {
    out.push(root)
    return out // don't descend into a repo's own folders
  }
  for (const e of entries) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
      await findRepos(join(root, e.name), depth + 1, out)
    }
  }
  return out
}

async function repoState(path) {
  const git = (...args) => run('git', ['-C', path, ...args], { timeout: 8000, maxBuffer: 8e6 }).then((r) => r.stdout)
  try {
    const status = await git('status', '--porcelain=v1', '--branch')
    const [head, ...lines] = status.split('\n')
    const files = lines.filter(Boolean)
    const m = /^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.*)\])?/.exec(head ?? '')
    const ahead = Number(/ahead (\d+)/.exec(m?.[3] ?? '')?.[1] ?? 0)
    const behind = Number(/behind (\d+)/.exec(m?.[3] ?? '')?.[1] ?? 0)
    const upstream = m?.[2] ?? null
    const [lastTs, day] = await Promise.all([
      git('log', '-1', '--format=%ct').catch(() => ''),
      git('rev-list', '--count', '--since=24.hours', 'HEAD').catch(() => '0'),
    ])
    // commits on a branch with no upstream have never left this machine
    // with no upstream, "unpushed" is unknown rather than zero: the branch may never have left
    const unpushed = upstream ? ahead : -1
    const lastCommit = Number(lastTs.trim()) * 1000 || null
    const oldestChangeDays = files.length && lastCommit ? (Date.now() - lastCommit) / 864e5 : 0
    return {
      path,
      name: path.replace(`${HOME}/`, '').replace(/^dev\//, ''),
      branch: m?.[1] ?? null,
      upstream,
      uncommitted: files.length,
      untracked: files.filter((l) => l.startsWith('??')).length,
      unpushed: unpushed === -1 ? null : unpushed,
      noUpstream: !upstream,
      behind,
      lastCommit: lastCommit ? new Date(lastCommit).toISOString() : null,
      commits24h: Number(day.trim()) || 0,
      // how much work would be lost if this disk died today: unpushed commits weigh most,
      // then changes that have sat uncommitted for days
      risk: (upstream ? ahead * 10 : 0) + Math.min(files.length, 200) * (1 + Math.min(oldestChangeDays, 14) / 2),
    }
  } catch {
    return null
  }
}

async function repos() {
  // git in every repo takes seconds: never make a request wait for it twice
  return fresh('repos', 30_000, async () => {
    const paths = (await Promise.all(DEV_ROOTS.map((r) => findRepos(r)))).flat()
    const results = []
    // bounded concurrency — dozens of git processes at once slows the whole machine
    for (let i = 0; i < paths.length; i += 8) {
      results.push(...(await Promise.all(paths.slice(i, i + 8).map(repoState))))
    }
    return results.filter(Boolean).sort((a, b) => b.risk - a.risk)
  })
}

// warm the repo list as the server starts, so the Claude panel's first open finds it ready
setTimeout(() => repos().catch(() => {}), 1500).unref?.()

/**
 * Project folders: a folder directly under a dev root that holds repos rather than being one
 * (~/dev/my-studio holding several game repos). Claude can work across a whole project.
 */
async function projects() {
  const rs = await repos()
  const out = new Map()
  for (const r of rs) {
    for (const root of DEV_ROOTS) {
      if (!r.path.startsWith(`${root}/`)) continue
      const rel = r.path.slice(root.length + 1).split('/')
      if (rel.length < 2) continue
      const path = `${root}/${rel[0]}`
      if (!out.has(path)) out.set(path, { path, name: rel[0], repos: [] })
      out.get(path).repos.push(r.path)
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// ----------------------------------------------------------------- activity ----
async function activity() {
  return cached('activity', 30_000, async () => {
    const [ss, rs] = await Promise.all([sessions(), repos()])
    const dayAgo = Date.now() - 24 * 3600e3
    const by = new Map()
    const entry = (name) => {
      if (!by.has(name)) by.set(name, { project: name, sessions: 0, commits: 0, memory: 0, lastAt: 0 })
      return by.get(name)
    }
    const home = (cwd) =>
      cwd ? rs.filter((r) => cwd === r.path || cwd.startsWith(`${r.path}/`)).sort((a, b) => b.path.length - a.path.length)[0]?.name : undefined
    for (const s of ss) {
      if (Date.parse(s.updated) < dayAgo) continue
      const e = entry(home(s.cwd) ?? s.project)
      e.sessions++
      e.lastAt = Math.max(e.lastAt, Date.parse(s.updated))
    }
    for (const r of rs) {
      if (!r.commits24h) continue
      const e = entry(r.name)
      e.commits += r.commits24h
      e.lastAt = Math.max(e.lastAt, Date.parse(r.lastCommit ?? 0) || 0)
    }
    // memory notes agents wrote in the last day, attributed through the project folder name
    try {
      for (const { dir, d } of (
        await Promise.all(projectRoots().map((r) => readdir(r.dir).then((ds) => ds.map((x) => ({ dir: r.dir, d: x })), () => [])))
      ).flat()) {
        const mem = join(dir, d, 'memory')
        let notes = []
        try {
          notes = await readdir(mem)
        } catch {
          continue
        }
        let n = 0
        for (const f of notes) {
          if (!f.endsWith('.md') || f === 'MEMORY.md') continue
          const st = await stat(join(mem, f)).catch(() => null)
          if (st && st.mtimeMs >= dayAgo) n++
        }
        if (!n) continue
        // Claude Code names project folders by replacing / . and spaces with -
        const homeSlug = HOME.replace(/[/ .]/g, '-').replace(/[-]/g, '\\-')
        const name = d.replace(new RegExp(`^${homeSlug}-?`), '').replace(/^dev-/, '')
        const match = [...by.keys()].find((k) => k.replace(/[/ .]/g, '-') === name) ?? name
        entry(match).memory += n
      }
    } catch {}
    return [...by.values()].sort((a, b) => b.lastAt - a.lastAt)
  })
}

/** Sessions attributed to the git repo that contains their folder, so a session started in
 * packages/app counts towards its repo rather than a project of its own. */
async function attributedSessions() {
  const rs = await repos()
  const home = (cwd) =>
    cwd ? rs.filter((r) => cwd === r.path || cwd.startsWith(`${r.path}/`)).sort((a, b) => b.path.length - a.path.length)[0] : undefined
  return (await sessions()).map((x) => {
    const r = home(x.cwd)
    const { last, ageMin, ...rest } = x
    return { ...rest, repo: r?.name ?? x.project, repoPath: r?.path ?? x.cwd }
  })
}

// ------------------------------------------------------------------ moments ----
/*
 * History: what actually happened across every agent and repo, as a few dozen readable
 * MOMENTS rather than the thousands of transcript lines and file saves underneath.
 *
 * Three kinds, all read off this machine:
 *   work    a run of a session (see runsOf) — the newest run carries the session's state, so
 *           something waiting on you or stuck on a permission prompt stands out now
 *   commit  commits landing in a repo, bursts within COMMIT_GAP folded into one
 *   note    a memory note an agent wrote
 *
 * A moment worth reading gets `card: true`; the rest stay posts on the spine. Everything
 * counts towards `buckets`, the activity profile under the spine, so a noisy hour looks noisy
 * even where nothing earned a card.
 */
const COMMIT_GAP = 45 * 60e3
const LVL_RANK = { info: 0, good: 1, warn: 2, bad: 3 }
const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
const mins = (ms) => {
  const m = Math.round(ms / 60e3)
  return m < 1 ? '<1m' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
}

async function commitsIn(repo, from) {
  try {
    const { stdout } = await run(
      'git',
      ['-C', repo.path, 'log', `--since=@${Math.floor(from / 1000)}`, '--no-merges', '--format=%ct%x1f%H%x1f%s'],
      { timeout: 8000, maxBuffer: 4e6 },
    )
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [ct, full, subject] = l.split('\x1f')
        return { t: Number(ct) * 1000, full, hash: full.slice(0, 7), subject: subject ?? '' }
      })
      .filter((c) => c.t >= from)
      .sort((a, b) => a.t - b.t)
  } catch {
    return []
  }
}

/** Memory notes written since `from`, with the name and description from their frontmatter. */
async function notesSince(from, projectNames) {
  const homeSlug = HOME.replace(/[/ .]/g, '-')
  const out = []
  for (const root of projectRoots()) {
    let dirs = []
    try {
      dirs = await readdir(root.dir)
    } catch {
      continue
    }
    for (const d of dirs) {
      const mem = join(root.dir, d, 'memory')
      let files = []
      try {
        files = await readdir(mem)
      } catch {
        continue
      }
      // Claude Code names a project folder by its path with / . and spaces turned into -
      const slug = d.startsWith(homeSlug) ? d.slice(homeSlug.length).replace(/^-/, '').replace(/^dev-/, '') : d
      const project = projectNames.find((n) => n.replace(/[/ .]/g, '-') === slug) ?? slug
      for (const f of files) {
        if (!f.endsWith('.md') || f === 'MEMORY.md') continue
        const p = join(mem, f)
        const st = await stat(p).catch(() => null)
        if (!st || st.mtimeMs < from) continue
        let text = ''
        try {
          text = (await readHead(p, 4000)) ?? ''
        } catch {}
        const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text)
        // one-line YAML scalars; a quoted one loses its quotes and escapes, or they show on the card
        const field = (k) => {
          const v = fm && new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm[1])?.[1]?.trim()
          if (!v) return undefined
          const q = /^(["'])([\s\S]*)\1$/.exec(v)
          if (!q) return v
          return q[1] === '"' ? q[2].replace(/\\(["\\])/g, '$1') : q[2].replace(/''/g, "'")
        }
        out.push({
          t: st.mtimeMs,
          path: p,
          project,
          name: field('name') ?? f.replace(/\.md$/, ''),
          description: field('description') ?? '',
          type: fm && /^\s*type:\s*(\w+)/m.exec(fm[1])?.[1],
          body: clip((fm ? text.slice(fm[0].length) : text).trim(), 600),
        })
      }
    }
  }
  return out
}

async function moments(hours) {
  const span = hours * 3600e3
  return fresh(`moments:${hours}`, 20_000, async () => {
    const now = Date.now()
    const from = now - span
    const [ss, rs] = await Promise.all([attributedSessions(), repos()])
    const list = []

    // ── work ──
    for (const s of ss) {
      const runs = (s.runs ?? []).filter(([, t1]) => t1 >= from)
      runs.forEach(([a, b], i) => {
        const newest = i === runs.length - 1
        const t0 = Math.max(a, from)
        const state = newest ? s.state : 'idle'
        const lvl = state === 'blocked' ? 'bad' : state === 'needs-you' ? 'warn' : state === 'working' ? 'good' : 'info'
        const took = b - t0
        list.push({
          id: `w:${s.id}:${a}`,
          kind: 'work',
          t0,
          t1: b,
          t: b,
          lvl,
          project: s.repo,
          title: s.title || '(untitled session)',
          sub: newest && s.latest ? s.latest : (s.ask ?? ''),
          meta: `${mins(took)} of work · ${s.repo.split('/').pop()}${s.branch ? ` · ${s.branch}` : ''}${
            state === 'needs-you' ? ' · your turn' : state === 'blocked' ? ` · waiting on ${s.lastTool ?? 'a tool'}` : state === 'working' ? ' · working now' : ''
          }`,
          clock: clock(b),
          card: lvl !== 'info' || took >= 8 * 60e3,
          score: (lvl === 'bad' || lvl === 'warn' ? 100 : 0) + Math.min(60, took / 60e3),
          session: { id: s.id, cwd: s.cwd, repoPath: s.repoPath, account: s.account ?? null, state: s.state },
        })
      })
    }

    // ── commits ── only repos whose last commit falls in the window are asked. A worktree
    // shares its repo's history, so the same commit turns up once per checkout; the main
    // checkout (a real .git folder, not a .git file) is asked first and claims each hash.
    const isWorktree = (p) => {
      try {
        return statSync(join(p, '.git')).isFile()
      } catch {
        return false
      }
    }
    const recent = rs
      .filter((r) => r.lastCommit && Date.parse(r.lastCommit) >= from)
      .sort((a, b) => Number(isWorktree(a.path)) - Number(isWorktree(b.path)))
    const seen = new Set()
    for (let i = 0; i < recent.length; i += 8) {
      const batch = recent.slice(i, i + 8)
      const logs = await Promise.all(batch.map((r) => commitsIn(r, from)))
      batch.forEach((r, k) => {
        let burst = []
        const flush = () => {
          if (!burst.length) return
          const last = burst[burst.length - 1]
          const n = burst.length
          list.push({
            id: `c:${r.path}:${burst[0].hash}`,
            kind: 'commit',
            t0: burst[0].t,
            t1: last.t,
            t: last.t,
            lvl: 'good',
            project: r.name,
            title: last.subject,
            sub: n > 1 ? burst.slice(0, -1).reverse().slice(0, 3).map((c) => c.subject).join(' · ') : '',
            meta: `${n} commit${n === 1 ? '' : 's'} · ${r.name.split('/').pop()}${r.branch ? ` · ${r.branch}` : ''} · ${last.hash}`,
            clock: clock(last.t),
            card: true,
            score: 30 + n * 6,
            commits: burst.map((c) => ({ t: c.t, hash: c.hash, subject: c.subject })).reverse(),
            repo: { path: r.path, name: r.name },
          })
          burst = []
        }
        for (const c of logs[k]) {
          if (seen.has(c.full)) continue
          seen.add(c.full)
          if (burst.length && c.t - burst[burst.length - 1].t > COMMIT_GAP) flush()
          burst.push(c)
        }
        flush()
      })
    }

    // ── notes ──
    const names = [...new Set([...rs.map((r) => r.name), ...ss.map((s) => s.repo)])]
    for (const n of await notesSince(from, names)) {
      list.push({
        id: `n:${n.path}`,
        kind: 'note',
        t0: n.t,
        t1: n.t,
        t: n.t,
        lvl: 'info',
        project: n.project,
        title: n.name,
        sub: n.description,
        meta: `memory${n.type ? ` · ${n.type}` : ''} · ${String(n.project).split('/').pop()}`,
        clock: clock(n.t),
        card: true,
        score: 15,
        note: { path: n.path, body: n.body },
      })
    }

    const states = ss.map((s) => ({ repo: s.repo, state: s.state }))
    return { from, to: now, list: list.sort((a, b) => a.t - b.t), states }
  })
}

/**
 * The history for one window, optionally narrowed to a project. The expensive read above is
 * shared; narrowing only re-derives the activity profile and the counts, so the bars under the
 * spine describe the project you are looking at rather than everything.
 */
async function momentsFor(hours, project) {
  const { from, to, list, states } = await moments(hours)
  const shown = project ? list.filter((m) => m.project === project) : list

  // ── the activity profile ── work by the minute, a commit or a note as a spike
  const COUNT = 96
  const size = (to - from) / COUNT
  const buckets = Array.from({ length: COUNT }, (_, i) => ({ t: from + (i + 0.5) * size, n: 0, lvl: 'info' }))
  const touch = (i, n, lvl) => {
    const b = buckets[i]
    if (!b) return
    b.n += n
    if (LVL_RANK[lvl] > LVL_RANK[b.lvl]) b.lvl = lvl
  }
  for (const m of shown) {
    if (m.kind !== 'work') {
      touch(Math.floor((m.t - from) / size), m.kind === 'commit' ? 4 * m.commits.length : 2, m.lvl)
      continue
    }
    const last = Math.min(COUNT - 1, Math.floor((m.t1 - from) / size))
    for (let i = Math.max(0, Math.floor((m.t0 - from) / size)); i <= last; i++) {
      const lo = from + i * size
      const overlap = Math.max(0, Math.min(m.t1, lo + size) - Math.max(m.t0, lo))
      touch(i, Math.max(1, overlap / 60e3 / 4), m.lvl)
    }
  }

  // the project list always comes from everything, or you could never switch to another one
  const byProject = new Map()
  for (const m of list) {
    const e = byProject.get(m.project) ?? { project: m.project, work: 0, commits: 0, notes: 0 }
    if (m.kind === 'work') e.work += m.t1 - m.t0
    if (m.kind === 'commit') e.commits += m.commits.length
    if (m.kind === 'note') e.notes++
    byProject.set(m.project, e)
  }
  // ten minutes of work per commit, so a build loop that commits every few minutes and a long
  // hand-written session can share one ranking
  const weight = (e) => e.work + e.commits * 6e5 + e.notes * 3e5
  const ranked = [...byProject.values()].sort((a, b) => weight(b) - weight(a))
  const projects = ranked.slice(0, 8)
  if (project && !projects.some((p) => p.project === project)) {
    const picked = byProject.get(project)
    if (picked) projects.push(picked)
  }
  const inScope = project ? states.filter((s) => s.repo === project) : states
  return {
    from,
    to,
    hours,
    project: project ?? null,
    moments: shown,
    buckets,
    summary: {
      sessions: new Set(shown.filter((m) => m.kind === 'work').map((m) => m.session.id)).size,
      commits: shown.reduce((n, m) => n + (m.kind === 'commit' ? m.commits.length : 0), 0),
      notes: shown.filter((m) => m.kind === 'note').length,
      needsYou: inScope.filter((s) => s.state === 'needs-you').length,
      blocked: inScope.filter((s) => s.state === 'blocked').length,
      working: inScope.filter((s) => s.state === 'working').length,
      projects,
      totalProjects: byProject.size,
    },
  }
}

const minsLabel = (iso) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000)
  return m < 1 ? 'now' : m < 60 ? `${m}m` : `${Math.round(m / 60)}h`
}

/**
 * The rail widget for the brain map: sessions waiting on you first, then what is running.
 * Built at read time (like brainstat) rather than written to brain/widgets/, so it is never
 * stale and never churns a tracked file.
 */
/** this Mac's hosted chats, for naming who a heavy process belongs to (feeds/loadwatch.mjs) */
export async function localChats() {
  const r = await nodes.call(LOCAL, '/sessions', { signal: AbortSignal.timeout(5000) })
  return r.ok ? r.json() : []
}

export async function agentsWidget() {
  const all = await attributedSessions()
  const pick = (st) => all.filter((s) => s.state === st)
  const needs = pick('needs-you')
  const blocked = pick('blocked')
  const working = pick('working')
  const name = (s) => s.repo.split('/').pop()
  const items = [
    ...needs.map((s) => ({ title: `${name(s)} · ${s.title || 'untitled'}`, meta: `your turn ${minsLabel(s.updated)}`, accent: '#ff8a4c', tag: s.id })),
    ...blocked.map((s) => ({ title: `${name(s)} · ${s.title || 'untitled'}`, meta: `blocked ${minsLabel(s.updated)}`, accent: '#f2c14e', tag: s.id })),
    ...working.map((s) => ({ title: `${name(s)} · ${s.title || 'untitled'}`, meta: s.lastTool ?? 'working', accent: '#56d8ff', tag: s.id })),
  ]
  return {
    id: 'agents',
    kind: 'list',
    title: 'Agents',
    icon: 'bolt',
    source: 'claude code sessions',
    refreshedAt: new Date().toISOString(),
    rail: 'right',
    order: 1,
    actions: [{ label: 'control', action: 'control' }],
    config: {
      meta: `${needs.length + blocked.length} waiting · ${working.length} running`,
      empty: 'No agent sessions running.',
      waiting: needs.length + blocked.length,
    },
    items,
  }
}

// --------------------------------------------------------------------- ring ----
const BRAIN_ROOT = resolve(process.env.BRAIN_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'))

/**
 * Turn an absolute folder into how the index names it: the first source keeps plain relative
 * paths, every other source is `@<id>/…` (see SourcedStore). The deepest matching source
 * wins, so a repo inside ~/dev maps to @dev even when the workspace source also covers it.
 */
async function indexAddress() {
  const cfg = await loadIndexConfig(BRAIN_ROOT)
  const on = cfg.sources.filter((s) => s.enabled)
  const roots = on
    .map((s, i) => ({ dir: sourceDir(BRAIN_ROOT, s), prefix: i === 0 && s === cfg.sources[0] ? '' : `@${s.id}/` }))
    .sort((a, b) => b.dir.length - a.dir.length)
  return (abs) => {
    if (!abs) return null
    const hit = roots.find((r) => abs === r.dir || abs.startsWith(r.dir + sep))
    if (!hit) return null
    const rel = relative(hit.dir, abs).split(sep).join('/')
    return { prefix: hit.prefix, rel }
  }
}

/** What the ring draws: live sessions as markers and at-risk repos as heat, by index path. */
async function ring() {
  const [ss, rs, addr] = await Promise.all([attributedSessions(), repos(), indexAddress()])
  return {
    agents: ss
      .filter((s) => s.state === 'needs-you' || s.state === 'blocked' || s.state === 'working')
      .map((s) => ({
        id: s.id,
        state: s.state,
        title: s.title,
        repo: s.repo.split('/').pop(),
        branch: s.branch,
        lastTool: s.lastTool,
        updated: s.updated,
        at: addr(s.repoPath ?? s.cwd),
      })),
    repos: rs
      .filter((r) => r.risk > 0)
      .map((r) => ({
        name: r.name.split('/').pop(),
        unpushed: r.unpushed,
        uncommitted: r.uncommitted,
        noUpstream: r.noUpstream,
        risk: r.risk,
        at: addr(r.path),
      })),
  }
}

// ---------------------------------------------------------------- agent host ----
/**
 * In-app Claude sessions run in agent-host.mjs, a separate process, so they survive this
 * server restarting. The browser talks to /api/control/agent/*; this proxies to the host over
 * loopback with the host's token. The host is started on first use and replaced when its file
 * has changed and it has no live sessions.
 */
const HOST_FILE = join(dirname(fileURLToPath(import.meta.url)), 'agent-host.mjs')
const HOST_STATE = join(tmpdir(), `laika-agent-host-${process.env.PORT || 5200}.json`)
let hostStarting = null

const readHostState = () => {
  try {
    return JSON.parse(readFileSync(HOST_STATE, 'utf8'))
  } catch {
    return null
  }
}

async function hostHealth(st, ms = 1500) {
  try {
    const r = await fetch(`http://127.0.0.1:${st.port}/health`, { headers: { 'x-agent-token': st.token }, signal: AbortSignal.timeout(ms) })
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}

/**
 * Every proxied request needs the host. Checking its health each time doubled every request and,
 * on a loaded machine, stalled clicks for seconds; a host verified in the last 15s is reused, and
 * a request that fails to reach it forgets it so the next one checks again.
 */
let hostKnown = null
const HOST_TTL = 15_000
const forgetHost = () => {
  hostKnown = null
}
async function agentHost() {
  if (hostKnown && Date.now() - hostKnown.at < HOST_TTL) {
    const cur = readHostState()
    if (cur && cur.pid === hostKnown.st.pid && cur.port === hostKnown.st.port) return hostKnown.st
  }
  const found = await findAgentHost()
  hostKnown = { st: found, at: Date.now() }
  return found
}
async function findAgentHost() {
  const st = readHostState()
  if (st) {
    // a busy host can miss a short health check; a live process is never written off for it,
    // or its running chats would be stranded behind a new, empty host
    let h = await hostHealth(st)
    const alive = (() => {
      try {
        process.kill(st.pid, 0)
        return true
      } catch {
        return false
      }
    })()
    if (!h && alive) h = (await hostHealth(st, 8000)) ?? { build: null, sessions: 1, slow: true }
    const build = statSync(HOST_FILE).mtimeMs
    if (h && (h.build === build || h.sessions > 0)) return st
    if (h) {
      try {
        process.kill(st.pid, 'SIGTERM')
      } catch {}
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  hostStarting ??= (async () => {
    try {
      rmSync(HOST_STATE, { force: true })
    } catch {}
    const log = openSync(join(tmpdir(), `laika-agent-host-${process.env.PORT || 5200}.log`), 'a')
    const child = spawn(process.execPath, [HOST_FILE], {
      cwd: dirname(HOST_FILE),
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, APP_PORT: String(process.env.PORT || 5200), BRAIN_ROOT },
    })
    child.unref()
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100))
      const next = readHostState()
      if (next && next.pid === child.pid && (await hostHealth(next))) return next
    }
    throw new Error('agent host did not start')
  })().finally(() => {
    hostStarting = null
  })
  return hostStarting
}

/** folders a session may start in: known repos, project folders, and folders sessions already ran in */
async function allowedCwds() {
  const [rs, ps, ss] = await Promise.all([repos(), projects(), sessions()])
  return new Set([...rs.map((r) => r.path), ...ps.map((p) => p.path), ...ss.map((s) => s.cwd).filter(Boolean)])
}

/**
 * Machines that run chats and terminals (see nodes.mjs): this Mac, and the machines listed in
 * brain/nodes.local.json (machines.mjs), each reached through an SSH tunnel kept open here.
 *
 * A chat on another machine works in that machine's copy of the repo (~/orbit-work/<name-hash>),
 * copied over when the chat starts. The page never sees the copy's path: repo paths in what comes
 * back are rewritten to the repo's path on this Mac, and paths in what the page sends are
 * rewritten the other way, so workspaces, tool cards and file links work as for a local chat.
 * What the chat changes stays on the machine until it is copied back (POST nodes/pull).
 */
const tunnels = createTunnelPool()
process.once('exit', () => tunnels.closeAll())
const machineNamed = (name) => readMachines().find((m) => m.name === name) ?? null
const nodes = createNodeRouter({
  // Windows machines run jobs only (windows.mjs), not chats or terminals: no agent host to reach
  ids: () => [LOCAL, ...readMachines().filter((m) => !isWindows(m)).map((m) => m.name)],
  reach: async (node) => {
    if (node === LOCAL) {
      const st = await agentHost()
      return { base: `http://127.0.0.1:${st.port}`, token: st.token }
    }
    const m = machineNamed(node)
    if (!m) throw new Error(`no machine named ${node}`)
    return tunnels.get(m)
  },
  forget: forgetNode,
})
function forgetNode(node) {
  if (node === LOCAL) return forgetHost()
  tunnels.forget(node)
  workRoots.delete(node)
}

/** each machine's work folder, as its host reports it */
const workRoots = new Map()
async function workRoot(node) {
  if (!workRoots.has(node)) {
    const r = await nodes.call(node, '/health?machine=1', { signal: AbortSignal.timeout(10_000) })
    const work = (await r.json()).machine?.work
    if (!work) throw new Error(`${node} does not say where its work folder is: reinstall it from a newer bundle`)
    workRoots.set(node, work)
  }
  return workRoots.get(node)
}

/** [path on the machine, path here] for every repo this Mac knows */
async function pathPairs(node) {
  const work = await workRoot(node)
  return [...(await allowedCwds())].map((p) => [`${work}/${remoteDir(p)}`, p])
}
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/**
 * JSON text with repo paths swapped between a machine's copies and this Mac's repos. A path only
 * matches whole, so /dev/game never rewrites part of /dev/game-wr.
 */
export function swapPaths(text, pairs, toLocal) {
  let out = text
  for (const [remote, local] of pairs) {
    const [from, to] = toLocal ? [remote, local] : [local, remote]
    const f = JSON.stringify(from).slice(1, -1)
    if (!out.includes(f)) continue
    out = out.replace(new RegExp(`${escRe(f)}(?![\\w.-])`, 'g'), () => JSON.stringify(to).slice(1, -1))
  }
  return out
}

async function proxyAgent(sub, url, req, res) {
  const fail = (code, error) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error }))
  }
  const writes = req.method !== 'GET'
  if (writes) {
    // same rule as /open: a page on another site can't send this header without a preflight
    const site = req.headers['sec-fetch-site']
    if (req.headers['x-control'] !== '1' || (site && site !== 'same-origin' && site !== 'none')) return fail(403, 'forbidden')
  }
  const [kind, id] = sub.split('/')
  const owned = kind === 'sessions' || kind === 'terms'
  const creates = owned && !id && req.method === 'POST'
  // chats and terminals are found by id; accounts belong to the machine the page names
  let node = kind === 'accounts' ? url.searchParams.get('node') || LOCAL : LOCAL
  let body
  let copy = null
  if (writes && req.method !== 'DELETE') {
    const chunks = []
    for await (const c of req) chunks.push(c)
    body = Buffer.concat(chunks)
    if (creates) {
      const b = JSON.parse(body.toString('utf8') || '{}')
      // a chat's terminal opens on the machine the chat runs on
      node = typeof b.node === 'string' && b.node ? b.node : b.owner ? await nodes.where(String(b.owner)) : LOCAL
      if (!nodes.has(node)) return fail(400, `unknown machine ${node}`)
      if (!(await allowedCwds()).has(b.cwd)) return fail(403, 'folder is not a known repo')
      // a chat on another machine starts from a fresh copy of the repo; its terminal uses that copy
      if (node !== LOCAL && kind === 'sessions') copy = b.cwd
    }
    // away mode may start a conductor in a folder the page names: the same rule holds
    else if (sub === 'away' && req.method === 'POST') {
      const b = JSON.parse(body.toString('utf8') || '{}')
      if (b.cwd != null && !(await allowedCwds()).has(b.cwd)) return fail(403, 'folder is not a known repo')
    }
  }
  let upstream
  let pairs = null
  try {
    if (owned && !id && req.method === 'GET') {
      const items = await nodes.list(kind)
      const byNode = new Map()
      for (const x of items) if (x.node !== LOCAL && !byNode.has(x.node)) byNode.set(x.node, await pathPairs(x.node).catch(() => []))
      const out = items.map((x) => (x.node === LOCAL ? x : JSON.parse(swapPaths(JSON.stringify(x), byNode.get(x.node), true))))
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(out))
    }
    if (owned && id) node = await nodes.where(id)
    if (node !== LOCAL) {
      pairs = await pathPairs(node)
      if (copy) await syncUp(machineNamed(node), copy, remoteDir(copy))
      if (body?.length) body = Buffer.from(swapPaths(body.toString('utf8'), pairs, false))
    }
    // event streams stay open; everything else must answer within 20s or fail visibly
    const stream = /\/events$/.test(sub)
    upstream = await nodes.call(node, `/${sub}${url.search}`, {
      method: req.method,
      headers: { 'content-type': 'application/json' },
      body,
      ...(stream ? {} : { signal: AbortSignal.timeout(20_000) }),
    })
  } catch (e) {
    const who = node === LOCAL ? 'The Claude host' : `${node}`
    return fail(503, `${who} did not answer: ${String(e?.message ?? e).slice(0, 160)}`)
  }
  const local = (text) => (pairs ? swapPaths(text, pairs, true) : text)
  if (creates && upstream.ok) {
    // the new chat or terminal is remembered on its machine, and says which one it is on
    const made = JSON.parse(local(await upstream.text()))
    nodes.remember(made.id, node)
    res.writeHead(upstream.status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    return res.end(JSON.stringify({ ...made, node }))
  }
  if (sub === `${kind}/${id}` && owned && req.method === 'DELETE' && upstream.ok) nodes.drop(id)
  const type = upstream.headers.get('content-type') ?? 'application/json'
  res.writeHead(upstream.status, { 'content-type': type, 'cache-control': 'no-store' })
  if (!upstream.body) return res.end()
  if (pairs && !type.startsWith('text/event-stream')) return res.end(local(await upstream.text()))
  const reader = upstream.body.getReader()
  req.on('close', () => reader.cancel().catch(() => {}))
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true }))
    if (done) break
    if (!pairs) {
      res.write(value)
      continue
    }
    // events from another machine are rewritten whole, a frame at a time
    buf += dec.decode(value, { stream: true })
    const cut = buf.lastIndexOf('\n\n')
    if (cut < 0) continue
    res.write(local(buf.slice(0, cut + 2)))
    buf = buf.slice(cut + 2)
  }
  res.end(buf ? local(buf) : undefined)
}

/**
 * Every open chat's events on one connection. A browser holds at most six connections to a
 * host, so a stream per chat meant that once six chats had been looked at, every other request
 * from the page (sending, ending, refreshing) queued behind them and the chats froze.
 * ?subs=<id>:<since>,… — each event comes back with `sid`; `gone` names a chat the host no
 * longer has. If any chat's upstream ends (a host restart) the whole stream ends, and the page
 * reconnects from the last event it saw in each chat.
 */
async function agentStream(url, req, res) {
  const subs = (url.searchParams.get('subs') ?? '')
    .split(',')
    .map((x) => {
      const i = x.lastIndexOf(':')
      return { id: x.slice(0, i), since: Math.max(0, Number(x.slice(i + 1)) || 0) }
    })
    .filter((s) => /^[\w-]{1,64}$/.test(s.id))
    .slice(0, 64)
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  res.write(': open\n\n')
  const ctl = new AbortController()
  let over = false
  const finish = () => {
    if (over) return
    over = true
    clearInterval(ping)
    ctl.abort()
    res.end()
  }
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000)
  req.on('close', finish)
  const one = async ({ id, since }) => {
    let node = LOCAL
    try {
      node = await nodes.where(id)
      const pairs = node === LOCAL ? null : await pathPairs(node)
      const up = await nodes.call(node, `/sessions/${id}/events?since=${since}`, { signal: ctl.signal })
      if (up.status === 404) return void res.write(`event: gone\ndata: ${JSON.stringify({ sid: id })}\n\n`)
      if (!up.ok || !up.body) throw new Error(String(up.status))
      const reader = up.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      const tag = `{"sid":${JSON.stringify(id)},`
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let cut
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, cut)
          buf = buf.slice(cut + 2)
          const event = /^event: (.+)$/m.exec(frame)?.[1]
          const data = /^data: (\{.+)$/m.exec(frame)?.[1]
          if (!data || over) continue
          const text = pairs ? swapPaths(data, pairs, true) : data
          res.write(`${event ? `event: ${event}\n` : ''}data: ${tag}${text.slice(1)}\n\n`)
        }
      }
    } catch {
      if (!over) forgetNode(node)
    }
    finish()
  }
  if (!subs.length) return
  await Promise.all(subs.map(one))
}

// ------------------------------------------------------------------- usage ----
/**
 * Each Claude account's plan usage, the numbers behind Claude Code's /usage: the 5-hour window,
 * the week and the per-model weeks, with when each resets. Asked through a Claude Code session
 * that never sends a prompt (control requests only, so no turn and no tokens), without the
 * user's hooks or plugins. The SDK marks this call experimental; if it fails, the meter says so.
 */
async function usageOf(a) {
  const base = { id: a.id, label: a.label, plan: a.plan ?? null, at: Date.now() }
  const dir = String(a.configDir).replace(/^~/, HOME)
  const env = { ...process.env }
  if (resolve(dir) === resolve(HOME, '.claude')) delete env.CLAUDE_CONFIG_DIR
  else env.CLAUDE_CONFIG_DIR = dir
  let release = () => {}
  const hold = new Promise((r) => {
    release = r
  })
  const abort = new AbortController()
  let timer
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    const q = query({
      prompt: (async function* () {
        await hold
      })(),
      options: { cwd: HOME, env, abortController: abort, settingSources: [] },
    })
    const r = await Promise.race([
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise((_, no) => {
        timer = setTimeout(() => no(new Error('usage timed out')), 30_000)
      }),
    ])
    const rl = r?.rate_limits ?? null
    const win = (key, label) =>
      rl?.[key] && typeof rl[key].utilization === 'number'
        ? { key, label, used: rl[key].utilization, resetsAt: rl[key].resets_at ?? null, locked: rl[key].locked_reason ?? null }
        : null
    const windows = [win('five_hour', '5h'), win('seven_day', 'Week'), win('seven_day_opus', 'Opus week'), win('seven_day_sonnet', 'Sonnet week')]
    for (const m of rl?.model_scoped ?? []) {
      if (typeof m.utilization === 'number') windows.push({ key: `model:${m.display_name}`, label: `${m.display_name} week`, used: m.utilization, resetsAt: m.resets_at ?? null })
    }
    // paid usage past the plan's limits, when the account has it turned on
    const x = rl?.extra_usage
    const extra = x?.is_enabled
      ? { used: x.used_credits ?? null, limit: x.monthly_limit ?? null, pct: x.utilization ?? null, currency: x.currency ?? null, decimals: x.decimal_places ?? null, capped: !!x.spend_limit_reached }
      : null
    return { ...base, available: !!r?.rate_limits_available, plan: r?.subscription_type ?? base.plan, windows: windows.filter(Boolean), extra }
  } catch (e) {
    return { ...base, available: false, windows: [], error: String(e?.message ?? e).slice(0, 160) }
  } finally {
    clearTimeout(timer)
    release()
    abort.abort()
  }
}

/** usage for every signed-in account; a few minutes old is fine, and never makes the page wait twice */
async function accountUsage() {
  return fresh('usage', 150_000, async () => {
    const st = await agentHost()
    const list = await fetch(`http://127.0.0.1:${st.port}/accounts`, { headers: { 'x-agent-token': st.token } }).then((r) => r.json())
    return Promise.all(list.filter((a) => !a.demo && a.loggedIn).map(usageOf))
  })
}

// --------------------------------------------------------------------- git ----
/**
 * The Changes panel: what a session has changed in its repo, the diff per file, and revert or
 * commit. Only folders this API already knows (repos and session folders) are accepted, and
 * file paths must stay inside the repo.
 */
async function gitRepo(cwd) {
  if (!cwd || !(await allowedCwds()).has(cwd)) return null
  try {
    const { stdout } = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 5000 })
    return stdout.trim()
  } catch {
    return null
  }
}

const insideRepo = (root, rel) => {
  if (typeof rel !== 'string' || !rel || rel.startsWith('/') || rel.split('/').includes('..')) return null
  const abs = resolve(root, rel)
  return abs.startsWith(`${root}/`) ? abs : null
}

async function gitStatus(root) {
  const git = (...a) => run('git', ['-C', root, ...a], { timeout: 10000, maxBuffer: 20e6 }).then((r) => r.stdout)
  const [porcelain, head, numWork, numIndex] = await Promise.all([
    git('status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'),
    git('rev-parse', '--abbrev-ref', 'HEAD').catch(() => ''),
    git('diff', '--numstat', '-z').catch(() => ''),
    git('diff', '--cached', '--numstat', '-z').catch(() => ''),
  ])
  const stats = new Map()
  for (const text of [numWork, numIndex]) {
    for (const rec of text.split('\0').filter(Boolean)) {
      const [add, del, path] = rec.split('\t')
      if (!path) continue
      const cur = stats.get(path) ?? { added: 0, deleted: 0, binary: false }
      if (add === '-') cur.binary = true
      else {
        cur.added += Number(add)
        cur.deleted += Number(del)
      }
      stats.set(path, cur)
    }
  }
  const recs = porcelain.split('\0')
  let branchLine = ''
  const files = []
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]
    if (!r) continue
    if (r.startsWith('## ')) {
      branchLine = r.slice(3)
      continue
    }
    const x = r[0]
    const y = r[1]
    const path = r.slice(3)
    let from = null
    if (x === 'R' || x === 'C') from = recs[++i] ?? null // renames carry the old path next
    const untracked = x === '?'
    const kind = untracked ? 'added' : x === 'D' || y === 'D' ? 'deleted' : x === 'A' ? 'added' : x === 'R' ? 'renamed' : 'modified'
    const st = stats.get(path) ?? { added: 0, deleted: 0, binary: false }
    files.push({ path, from, kind, staged: x !== ' ' && x !== '?', untracked, ...st })
  }
  const ahead = Number(/ahead (\d+)/.exec(branchLine)?.[1] ?? 0)
  const behind = Number(/behind (\d+)/.exec(branchLine)?.[1] ?? 0)
  return { root, branch: head.trim() || null, ahead, behind, files }
}

/** one file's text, capped, only if it really lies inside `root` */
async function readInside(root, abs, json) {
  try {
    const real = await realpath(abs)
    if (!real.startsWith(`${root}/`)) return json(403, { error: 'outside the repo' })
    const st = await stat(real)
    if (st.size > 1_000_000) return json(200, { tooBig: true, size: st.size })
    const buf = await readFile(real)
    if (buf.subarray(0, 8000).includes(0)) return json(200, { binary: true, size: st.size })
    return json(200, { text: buf.toString('utf8'), size: st.size })
  } catch {
    return json(404, { error: 'not found' })
  }
}

async function projectFiles(project, route, url, json) {
  if (route === 'files') {
    const lists = await Promise.all(
      project.repos.map(async (repo) => {
        const prefix = repo.slice(project.path.length + 1)
        const out = await run('git', ['-C', repo, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { timeout: 20000, maxBuffer: 50e6 })
          .then((r) => r.stdout)
          .catch(() => '')
        return out.split('\0').filter(Boolean).map((f) => `${prefix}/${f}`)
      }),
    )
    return json(200, lists.flat().slice(0, 20000))
  }
  const abs = insideRepo(project.path, url.searchParams.get('path'))
  const repo = abs && project.repos.find((r) => abs.startsWith(`${r}/`))
  if (!repo) return json(400, { error: 'bad path' })
  return readInside(repo, abs, json)
}

async function handleGit(route, url, req, res, json) {
  const writes = req.method === 'POST'
  if (writes) {
    const site = req.headers['sec-fetch-site']
    if (req.headers['x-control'] !== '1' || (site && site !== 'same-origin' && site !== 'none')) return json(403, { error: 'forbidden' })
  }
  let body = {}
  if (writes) {
    const chunks = []
    for await (const c of req) chunks.push(c)
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      return json(400, { error: 'bad json' })
    }
  }
  const cwd = writes ? body.cwd : url.searchParams.get('cwd')
  // a project folder is no repo itself: the Files view and @-mentions see its repos' files
  const project = !writes && (route === 'files' || route === 'file') ? (await projects()).find((p) => p.path === cwd) : null
  if (project) return projectFiles(project, route, url, json)
  const root = await gitRepo(cwd)
  if (!root) return json(403, { error: 'not a known git repo' })
  const git = (...a) => run('git', ['-C', root, ...a], { timeout: 20000, maxBuffer: 20e6 }).then((r) => r.stdout)

  if (route === 'status') return json(200, await gitStatus(root))

  if (route === 'file') {
    // the Files view: one file's text, inside the repo, capped
    const rel = url.searchParams.get('path')
    const abs = insideRepo(root, rel)
    if (!abs) return json(400, { error: 'bad path' })
    try {
      const real = await realpath(abs)
      if (!real.startsWith(`${root}/`)) return json(403, { error: 'outside the repo' })
      const st = await stat(real)
      if (st.size > 1_000_000) return json(200, { tooBig: true, size: st.size })
      const buf = await readFile(real)
      if (buf.subarray(0, 8000).includes(0)) return json(200, { binary: true, size: st.size })
      return json(200, { text: buf.toString('utf8'), size: st.size })
    } catch {
      return json(404, { error: 'not found' })
    }
  }

  if (route === 'files') {
    // for @-mentions: tracked files plus new ones not ignored, most repos well under the cap
    const out = await git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
    return json(200, out.split('\0').filter(Boolean).slice(0, 20000))
  }

  if (route === 'diff') {
    const rel = url.searchParams.get('path')
    const abs = insideRepo(root, rel)
    if (!abs) return json(400, { error: 'bad path' })
    const MAX = 400_000
    const before = await git('show', `HEAD:${rel}`).catch(() => '')
    let after = ''
    try {
      const st = await stat(abs)
      if (st.size > MAX) return json(200, { tooBig: true, size: st.size })
      after = (await readFile(abs)).toString('utf8')
    } catch {}
    if (/\u0000/.test(before.slice(0, 8000)) || /\u0000/.test(after.slice(0, 8000))) return json(200, { binary: true })
    return json(200, { before: before.length > MAX ? '' : before, after })
  }

  if (route === 'revert') {
    const abs = insideRepo(root, body.path)
    if (!abs) return json(400, { error: 'bad path' })
    const s = await gitStatus(root)
    const f = s.files.find((x) => x.path === body.path)
    if (!f) return json(404, { error: 'no change to revert' })
    // a new file has nothing to go back to: reverting it removes it
    if (f.untracked) await rm(abs, { force: true })
    else if (f.kind === 'added') {
      await git('rm', '--cached', '--force', '--', body.path)
      await rm(abs, { force: true })
    } else await git('restore', '--staged', '--worktree', '--source=HEAD', '--', body.path)
    return json(200, await gitStatus(root))
  }

  if (route === 'commit') {
    const message = String(body.message ?? '').trim()
    const paths = Array.isArray(body.paths) ? body.paths : []
    if (!message) return json(400, { error: 'a commit message is required' })
    if (!paths.length || paths.some((p) => !insideRepo(root, p))) return json(400, { error: 'choose files to commit' })
    await git('add', '--all', '--', ...paths)
    try {
      await git('commit', '-m', message, '--', ...paths)
    } catch (e) {
      return json(400, { error: String(e.stderr || e.message).trim().split('\n').slice(-3).join(' ') })
    }
    const hash = (await git('rev-parse', '--short', 'HEAD')).trim()
    CACHE.delete('repos')
    return json(200, { hash, status: await gitStatus(root) })
  }
  return json(404, { error: 'not found' })
}

// ------------------------------------------------------------------ library ----
/**
 * Chats open in this app's host, by Claude session id -> the host's chat id. Asks the host when
 * one is running (never starts one just to ask), and otherwise reads the list it keeps on disk
 * of chats it will bring back, so a stopped host still protects its chats from delete.
 */
async function hostChats() {
  const out = new Map()
  const st = readHostState()
  if (st) {
    try {
      const r = await fetch(`http://127.0.0.1:${st.port}/sessions`, { headers: { 'x-agent-token': st.token }, signal: AbortSignal.timeout(3000) })
      if (r.ok) {
        for (const x of await r.json()) if (x.sdkSessionId && x.state !== 'closed') out.set(x.sdkSessionId, x.id)
        return out
      }
    } catch {}
  }
  try {
    const rows = JSON.parse(await readFile(join(HOME, '.laika', `agent-sessions-${process.env.PORT || 5200}.json`), 'utf8'))
    for (const x of rows) if (x?.sdkSessionId) out.set(x.sdkSessionId, x.id ?? x.sdkSessionId)
  } catch {}
  return out
}

/** every transcript's title, rescanned at most every few seconds however often the page asks */
const libraryRows = () => fresh('library-rows', 3000, () => scanChats(projectRoots()))

async function libraryPage(params, only) {
  const [all, library, running, rs] = await Promise.all([libraryRows(), readLibrary(), hostChats(), repos().catch(() => [])])
  const repoOf = (cwd) => {
    const r = rs.filter((x) => cwd === x.path || cwd.startsWith(`${x.path}/`)).sort((a, b) => b.path.length - a.path.length)[0]
    return r ? { repo: r.name, repoPath: r.path } : undefined
  }
  const rows = only ? all.filter((x) => only(x, library)) : all
  return listChats({ rows, library, running, repoOf, params })
}

async function handleLibrary(route, url, req, json) {
  const writes = req?.method === 'POST'
  let body = {}
  if (writes) {
    const site = req.headers['sec-fetch-site']
    if (req.headers['x-control'] !== '1' || (site && site !== 'same-origin' && site !== 'none')) return json(403, { error: 'forbidden' })
    const chunks = []
    for await (const c of req) chunks.push(c)
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      return json(400, { error: 'bad json' })
    }
  } else if (req && req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'method not allowed' })

  if (route === '' && !writes) return json(200, await libraryPage(url.searchParams))

  if (route === 'search' && !writes) {
    // the chats the list would show: archived ones only when asked
    const arch = url.searchParams.get('archived') ?? ''
    const [rows, library] = await Promise.all([libraryRows(), readLibrary()])
    const shown = rows.filter((x) => (arch === 'only' ? library[x.id]?.archived : arch === '1' || !library[x.id]?.archived))
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 40))
    const r = await searchChats({ rows: shown, q: url.searchParams.get('q') ?? '', skip: Number(url.searchParams.get('cursor')) || 0, maxHits: limit })
    const ids = new Set(r.hits.map((h) => h.id))
    const page = await libraryPage(new URLSearchParams({ archived: '1', limit: '200' }), (x) => ids.has(x.id))
    const byId = new Map(page.items.map((x) => [x.id, x]))
    return json(200, { ...r, hits: r.hits.filter((h) => byId.has(h.id)).map((h) => ({ ...byId.get(h.id), ...h })) })
  }

  if (route === 'meta') {
    if (!writes) return json(200, await readLibrary())
    if (body.migrate) {
      const r = await migrateEntries(body.migrate)
      return json(200, r.library)
    }
    const id = String(body.id ?? '')
    const patch = body.patch && typeof body.patch === 'object' ? body.patch : {}
    try {
      return json(200, { id, entry: await patchEntry(id, patch) })
    } catch (e) {
      return json(400, { error: String(e?.message ?? e) })
    }
  }

  if (route === 'delete' && writes) {
    // a transcript written in the last two minutes may belong to a Claude Code still running in a terminal
    const r = await deleteChat({ id: String(body.id ?? ''), roots: projectRoots(), running: await hostChats(), quietMs: 120_000 })
    if (r.code === 200) {
      CACHE.delete('library-rows')
      CACHE.delete('sessions')
      return json(200, { ok: true, trashed: r.trashed.length })
    }
    return json(r.code, { error: r.error })
  }
  return json(404, { error: 'no such library route' })
}

// ---------------------------------------------------------------- machines ----
/**
 * The Machines settings: this Mac and every other machine, online or not, how busy, what Unity
 * versions it has and what jobs it runs; adding one by address or from the ones announcing
 * themselves; stopping a job; and copying a chat's changes back from its machine.
 *   GET    nodes                       every machine with its state and jobs
 *   GET    nodes/discover              machines on the network that are not added
 *   POST   nodes            {address, name?}   checks it answers, then adds it
 *   DELETE nodes/<name>
 *   DELETE nodes/<name>/jobs/<id>      stop a job
 *   POST   nodes/pull       {session}  copy a chat's changes back to its repo here
 */
/**
 * every job still running (a long Unity run must not drop out behind a stream of short encodes),
 * then the newest finished ones; not the offload tools' own housekeeping
 */
export function jobsWorthShowing(jobs, finished = 12) {
  const real = jobs.filter((j) => !(String(j.cmd).split('/').pop() === 'rm' && j.dir === '.')).sort((a, b) => b.startedAt - a.startedAt)
  return [...real.filter((j) => j.state === 'running'), ...real.filter((j) => j.state !== 'running').slice(0, finished)]
}

/**
 * A Windows machine's state for the machines card: its health and recent jobs, over ssh to its gate.
 * Asked at most every 15 seconds whatever the card's polling, since each ask starts PowerShell there;
 * the last answer is served meanwhile.
 */
const WIN_EVERY_MS = 15_000
const winCache = new Map()
function windowsStatus(m) {
  const c = winCache.get(m.name)
  const fresh = c && Date.now() - c.at < WIN_EVERY_MS
  if (!fresh && !c?.pending) {
    const pending = winHealth(m)
      .then((h) => ({ id: m.name, online: true, sessions: 0, machine: h, jobs: h.recent ?? [] }))
      .catch((e) => ({ id: m.name, online: false, error: String(e?.message ?? e).slice(0, 160) }))
      .then((row) => {
        winCache.set(m.name, { at: Date.now(), row })
        return row
      })
    winCache.set(m.name, { at: c?.at ?? 0, row: c?.row, pending })
    if (!c?.row) return pending
  }
  return c?.row ?? winCache.get(m.name).pending
}

async function handleNodes(parts, req, json) {
  if (req.method !== 'GET') {
    const site = req.headers['sec-fetch-site']
    if (req.headers['x-control'] !== '1' || (site && site !== 'same-origin' && site !== 'none')) return json(403, { error: 'forbidden' })
  }
  const body = async () => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      return {}
    }
  }
  const list = readMachines()
  if (!parts.length && req.method === 'GET') {
    const [status, wins] = await Promise.all([nodes.status(), Promise.all(list.filter(isWindows).map(windowsStatus))])
    const rows = await Promise.all(
      [...status, ...wins].map(async (s) => {
        const m = list.find((x) => x.name === s.id)
        const jobs = s.jobs
          ? s.jobs
          : s.online && s.id !== LOCAL
            ? await nodes
                .call(s.id, '/jobs', { signal: AbortSignal.timeout(5000) })
                .then((r) => r.json())
                .catch(() => [])
            : []
        const caps = m && s.online ? capsOf(m, s.machine ?? {}) : null
        return {
          ...s,
          local: s.id === LOCAL,
          name: s.id === LOCAL ? 'This Mac' : s.id,
          os: s.id === LOCAL ? 'mac' : (m?.os ?? 'linux'),
          address: m ? `${m.user}@${m.host}${m.port && m.port !== 22 ? `:${m.port}` : ''}` : null,
          jobs: Array.isArray(jobs) ? jobsWorthShowing(jobs) : [],
          caps,
          canRun: caps ? canRun(caps) : [],
        }
      }),
    )
    // what goes where now, for the card and for the load watcher and chats (~/.laika/machines.json)
    const remote = rows.filter((r) => !r.local).map((r) => ({ name: r.id, os: r.os, online: r.online, caps: r.caps, jobs: r.machine?.jobs ?? 0 }))
    saveMachineState(remote)
    const routes = routesOf(remote)
    for (const r of rows) r.gets = r.local ? [] : [routes.gpu === r.id && 'GPU work', routes.cpuAll.includes(r.id) && 'CPU work'].filter(Boolean)
    return json(200, rows)
  }
  if (parts[0] === 'discover' && req.method === 'GET') {
    const known = new Set(list.map((m) => `${m.user}@${m.host}`))
    return json(200, (await discover()).filter((d) => !known.has(`${d.user}@${d.host}`)))
  }
  if (!parts.length && req.method === 'POST') {
    const b = await body()
    const addr = parseAddress(b.address ?? '')
    if (!addr) return json(400, { error: 'Type it as user@host, like joe@192.168.1.20' })
    let h
    try {
      const t = await openTunnel({ ...addr, name: addr.host })
      h = await (await t.call('/health?machine=1', { signal: AbortSignal.timeout(10_000) })).json()
      t.close()
    } catch (e) {
      return json(502, { error: String(e?.message ?? e) })
    }
    const name =
      String(b.name || h.machine?.hostname || addr.host)
        .split('.')[0]
        .replace(/[^\w-]+/g, '-')
        .slice(0, 40) || 'machine'
    if (name === LOCAL) return json(400, { error: 'That name is taken by this Mac' })
    writeMachines([...list.filter((m) => m.name !== name && !(m.user === addr.user && m.host === addr.host)), { name, ...addr }])
    return json(200, { name })
  }
  const m = list.find((x) => x.name === parts[0])
  if (parts.length === 1 && req.method === 'DELETE') {
    if (!m) return json(404, { error: 'no such machine' })
    writeMachines(list.filter((x) => x !== m))
    forgetNode(m.name)
    return json(200, { ok: true })
  }
  if (m && parts[1] === 'jobs' && parts[2] && req.method === 'DELETE') {
    if (isWindows(m)) {
      const r = await openGate(m).call(`/jobs/${encodeURIComponent(parts[2])}`, { method: 'DELETE' })
      return json(r.status, await r.json())
    }
    const r = await nodes.call(m.name, `/jobs/${encodeURIComponent(parts[2])}`, { method: 'DELETE', signal: AbortSignal.timeout(10_000) })
    return json(r.status, await r.json())
  }
  if (parts[0] === 'pull' && req.method === 'POST') {
    const id = String((await body()).session ?? '')
    const node = await nodes.where(id)
    if (node === LOCAL) return json(400, { error: 'That chat runs on this Mac' })
    const chat = (await nodes.list('sessions')).find((x) => x.id === id)
    if (!chat) return json(404, { error: 'no such chat' })
    const here = (await pathPairs(node)).find(([remote]) => remote === chat.cwd)?.[1]
    if (!here) return json(404, { error: 'this chat’s repo is not one this Mac knows' })
    try {
      const files = await syncDown(machineNamed(node), here, remoteDir(here))
      return json(200, { files, cwd: here, machine: node })
    } catch (e) {
      return json(502, { error: String(e?.message ?? e) })
    }
  }
  return json(404, { error: 'no such machines route' })
}

// ------------------------------------------------------------------- routes ----
/** Handle /api/control/*; returns true when it answered. */
export async function handleControl(url, res, req) {
  if (!url.pathname.startsWith('/api/control/')) return false
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
    return true
  }
  const route = url.pathname.slice('/api/control/'.length)
  if (route === 'sessions') return json(200, await attributedSessions())
  if (route === 'widget') return json(200, await agentsWidget())
  if (route === 'ring') return json(200, await ring())
  if (route === 'sources') {
    // where each index source lives on disk, deepest first, so the page can place a file an
    // agent touches onto the ring (paths under the first source have no @prefix)
    const cfg = await loadIndexConfig(BRAIN_ROOT)
    const on = cfg.sources.filter((x) => x.enabled)
    return json(
      200,
      on
        .map((x, i) => ({ dir: sourceDir(BRAIN_ROOT, x), prefix: i === 0 && x === cfg.sources[0] ? '' : `@${x.id}/` }))
        .sort((a, b) => b.dir.length - a.dir.length),
    )
  }
  if (route.startsWith('git/')) return handleGit(route.slice(4), url, req, res, json)
  if (route === 'library' || route.startsWith('library/')) return handleLibrary(route.slice('library/'.length), url, req, json)
  if (route === 'nodes' || route.startsWith('nodes/')) return handleNodes(route.split('/').slice(1), req, json)
  if (route === 'agent/stream') {
    await agentStream(url, req, res)
    return true
  }
  if (route.startsWith('agent/')) {
    await proxyAgent(route.slice('agent/'.length), url, req, res)
    return true
  }
  if (route === 'repos') return json(200, await repos())
  if (route === 'projects') return json(200, await projects())
  if (route === 'usage') return json(200, await accountUsage())
  if (route === 'activity') return json(200, await activity())
  if (route === 'moments') {
    // sessions are only scanned 48h back, so that is as far as history can honestly reach
    const h = Number(url.searchParams.get('hours'))
    return json(200, await momentsFor([12, 24, 48].includes(h) ? h : 24, url.searchParams.get('project') || null))
  }
  if (route === 'ports') return json(200, await listeners())
  if (route === 'open') {
    // launches apps, so a plain cross-site GET (an <img> on any web page) must not reach it:
    // browsers can't send a custom header cross-origin without a preflight this server never grants
    if (req?.method !== 'POST' || req.headers['x-control'] !== '1') return json(403, { error: 'forbidden' })
    // only folders this API has already reported — never an arbitrary path from the URL
    const p = url.searchParams.get('path') ?? ''
    const kind = url.searchParams.get('kind') ?? 'finder'
    const known = new Set([
      ...(await repos()).map((r) => r.path),
      ...(await sessions()).map((s) => s.cwd).filter(Boolean),
    ])
    if (!known.has(p)) return json(403, { error: 'unknown path' })
    const cmd =
      kind === 'terminal' ? ['open', ['-a', 'Terminal', p]] : kind === 'editor' ? ['code', [p]] : ['open', [p]]
    execFile(cmd[0], cmd[1], (err) => {
      // no `code` on PATH: fall back to opening the folder
      if (err && kind === 'editor') execFile('open', [p], () => {})
    })
    return json(200, { ok: true })
  }
  return json(404, { error: 'no such control route' })
}
