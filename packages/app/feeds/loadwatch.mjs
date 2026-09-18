/**
 * The load watcher: notices when this Mac stays under pressure, says what is heavy and whose it
 * is, and tells the offload tools to send new work to the machines while it lasts.
 *
 * Every 10 seconds it reads CPU, memory and thermal state. Busy means a minute of CPU at 85% or
 * more, memory at 90% or more, or macOS limiting CPU speed for heat; it clears after 30 seconds
 * back under 70% CPU and 85% memory with no thermal limit. While busy it lists the heaviest
 * processes, each with what it is (Unity, Blender, ffmpeg, a headless browser, a build) and who
 * started it: the Claude chat it runs under (its title when Laika Orbit hosts the chat, otherwise the
 * repo the Claude Code session is in), or the app it belongs to.
 *
 * The state is served at /api/loadwatch, for the fleet board to show: `notice` is the one line to
 * put in front of Joe ("Mac busy: Unity (batch) is heavy"), `heavy` the detail behind it. It is
 * also written to ~/.laika/load.json, where offload tools read `busy` to send even work they would
 * normally keep here to a machine (see macBusy()).
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { machineState } from '../machines.mjs'
import { sysres } from './sysres.mjs'

export const STATE_FILE = join(homedir(), '.laika', 'load.json')
const EVERY_MS = 10_000
const HIGH = { cpu: 85, mem: 90 }
const LOW = { cpu: 70, mem: 85 }
const SUSTAIN = 6 // samples: a minute
const RECOVER = 3 // samples: 30 seconds
/** a busy state older than this was left by a watcher that stopped: not busy */
const STALE_MS = 60_000

const run = (cmd, args, timeout = 4000) =>
  new Promise((done) => execFile(cmd, args, { timeout, maxBuffer: 16 << 20 }, (err, out) => done(err ? null : String(out))))

/** `ps -Axo pid=,ppid=,pcpu=,rss=,command=` → processes, rss in bytes */
export function parsePs(text) {
  const out = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line)
    if (m) out.push({ pid: +m[1], ppid: +m[2], cpu: +m[3], mem: +m[4] * 1024, command: m[5] })
  }
  return out
}

/** macOS `pmset -g therm`: the CPU speed limit in percent, 100 when nothing is limited */
export function parseTherm(text) {
  const m = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(text ?? '')
  return m ? Number(m[1]) : 100
}

/**
 * What a process is, and whether the same work could run on a Linux machine instead: Unity,
 * Blender, ffmpeg, headless browsers and cross-platform builds can; Xcode and Swift builds,
 * simulators and apps cannot.
 */
export function classify(command) {
  const c = command
  // GPU work draws (Unity, Blender, browsers); the rest is CPU work
  const tool = (kind, label, offloadable) => ({ kind, label, offloadable, needs: kind === 'unity' || kind === 'blender' || kind === 'browser' ? 'gpu' : 'cpu' })
  if (/Unity\.app\/Contents\/MacOS\/Unity\b/.test(c)) return tool('unity', /-batchmode/.test(c) ? 'Unity (batch)' : 'Unity Editor', /-batchmode/.test(c))
  if (/Blender\.app\/Contents\/MacOS\/Blender\b|(^|\/)blender(\s|$)/i.test(c)) return tool('blender', /\s-b(\s|$)|--background/.test(c) ? 'Blender render' : 'Blender', /\s-b(\s|$)|--background/.test(c))
  if (/(^|\/)ff(mpeg|probe)(\s|$)/.test(c)) return tool('ffmpeg', 'ffmpeg', !/\s-i\s+-(\s|$)/.test(c))
  if (/--headless|headless_shell|chrome-headless-shell/.test(c)) return tool('browser', 'Headless browser', true)
  if (/xcodebuild|swift-frontend|swift-build|\/usr\/bin\/swiftc|clang(\+\+)?\s|ibtool|actool/.test(c)) return tool('build', 'Xcode / Swift build', false)
  if (/Simulator\.app|CoreSimulator|launchd_sim/.test(c)) return tool('simulator', 'iOS Simulator', false)
  if (/\b(cargo|rustc|go build|gradle|tsc|esbuild|rollup|webpack|vite build|next build|turbo run)\b|\b(pnpm|npm|yarn) (run )?build\b/.test(c))
    return tool('build', 'Build', true)
  if (/(^|\/)claude(\s|$)|claude-agent-sdk/.test(c)) return tool('claude', 'Claude Code', false)
  const app = /\/([^/]+)\.app\/Contents\//.exec(c)?.[1]
  return tool('app', app ?? basename(c.split(/\s+/)[0] ?? c), false)
}

/**
 * Who a heavy process belongs to: the nearest Claude Code process above it (a chat), or else the
 * app it is part of. `chats` maps a conversation id (from --resume) to a chat's title; `cwdOf`
 * gives a process's working folder, for chats Laika Orbit does not host.
 */
export function ownerOf(p, byPid, { chats = new Map(), cwdOf = () => null } = {}) {
  let q = byPid.get(p.ppid)
  for (let hops = 0; q && hops < 40; hops++, q = byPid.get(q.ppid)) {
    if (/(^|\/)claude(\s|$)/.test(q.command)) {
      const resume = /--resume[= ]([0-9a-f-]{36})/.exec(q.command)?.[1]
      const title = resume && chats.get(resume)
      if (title) return { kind: 'chat', label: `chat “${title}”` }
      const cwd = cwdOf(q.pid)
      return { kind: 'chat', label: cwd ? `Claude Code in ${basename(cwd)}` : 'a Claude Code session' }
    }
  }
  const app = /\/([^/]+)\.app\/Contents\//.exec(p.command)?.[1]
  return app ? { kind: 'app', label: app } : { kind: 'system', label: basename(p.command.split(/\s+/)[0] ?? '') }
}

/**
 * The heaviest work, one line per tool and owner: a process's descendants count toward it
 * (Unity's helpers, a build's compilers), and only lines using a core or more, or 1.5 GB, show.
 */
export function heaviest(procs, ctx = {}, top = 5) {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const groups = new Map()
  for (const p of procs) {
    if (p.pid === process.pid) continue
    const what = classify(p.command)
    if (what.kind === 'claude') continue
    const who = ownerOf(p, byPid, ctx)
    const key = `${what.label}\0${who.label}`
    const g = groups.get(key) ?? { ...what, owner: who.label, ownerKind: who.kind, cpu: 0, mem: 0, pids: [] }
    g.cpu += p.cpu
    g.mem += p.mem
    g.pids.push(p.pid)
    groups.set(key, g)
  }
  return [...groups.values()]
    .filter((g) => g.cpu >= 100 || g.mem >= 1.5e9)
    .sort((a, b) => b.cpu - a.cpu || b.mem - a.mem)
    .slice(0, top)
    .map((g) => ({ ...g, cpu: Math.round(g.cpu), pids: g.pids.slice(0, 6) }))
}

/** is this Mac busy right now, as the watcher last saw it (read by the offload tools) */
export function macBusy(file = STATE_FILE) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'))
    return !!s.busy && Date.now() - s.at < STALE_MS
  } catch {
    return false
  }
}

/**
 * The decision over a run of samples: busy after SUSTAIN high ones in a row, clear after RECOVER
 * low ones in a row, otherwise unchanged. Returns the new state and why.
 */
export function judge(prev, samples) {
  const last = samples.slice(-SUSTAIN)
  const hot = (s) => s.cpu >= HIGH.cpu || s.mem >= HIGH.mem || s.speedLimit < 100
  const calm = (s) => s.cpu < LOW.cpu && s.mem < LOW.mem && s.speedLimit >= 100
  if (!prev && last.length === SUSTAIN && last.every(hot)) return true
  if (prev && samples.length >= RECOVER && samples.slice(-RECOVER).every(calm)) return false
  return prev
}
export const reasonsOf = (s) =>
  [s.cpu >= HIGH.cpu && `CPU ${s.cpu}%`, s.mem >= HIGH.mem && `memory ${s.mem}%`, s.speedLimit < 100 && `CPU limited to ${s.speedLimit}% for heat`].filter(Boolean)

/**
 * The machine new work like each heavy item would go to, by what it needs (routesOf in
 * machines.mjs), when the app has seen the machines lately; otherwise left unnamed.
 */
export function withRoutes(heavy, state = machineState()) {
  const routes = state?.routes
  return heavy.map((h) => (h.offloadable && routes ? { ...h, goesTo: routes[h.needs ?? 'cpu'] ?? null } : h))
}

/** the one line to show while busy: the heaviest work, or why the Mac counts as busy */
export const noticeOf = (heavy, reasons) =>
  heavy[0]
    ? `Mac busy: ${heavy[0].label} is heavy${heavy[0].offloadable ? (heavy[0].goesTo ? ` (new ones go to ${heavy[0].goesTo})` : heavy[0].goesTo === null ? ' (no machine is free for more)' : ' (new ones go to the other machines)') : ''}`
    : `Mac busy: ${reasons.join(', ')}`

/** start watching; `chats()` resolves Laika Orbit's chats as [{ sdkSessionId, title }] */
export function startLoadWatch({ chats = async () => [], file = STATE_FILE, onChange = () => {} } = {}) {
  const samples = []
  let state = { busy: false, since: null, reasons: [], heavy: [], at: Date.now(), cpu: 0, mem: 0, speedLimit: 100 }
  const save = () => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(`${file}.tmp`, JSON.stringify(state))
      renameSync(`${file}.tmp`, file)
    } catch {}
  }
  const cwdOf = (pid) => {
    // filled below for the processes that need it, so lsof runs a handful of times, not per process
    return cwds.get(pid) ?? null
  }
  const cwds = new Map()
  async function tick() {
    const [r, therm] = await Promise.all([sysres(), process.platform === 'darwin' ? run('pmset', ['-g', 'therm']) : null])
    const s = { cpu: r.cpu, mem: r.mem, speedLimit: parseTherm(therm), at: Date.now() }
    samples.push(s)
    if (samples.length > 30) samples.shift()
    const busy = judge(state.busy, samples)
    let heavy = state.heavy
    if (busy) {
      const ps = await run('ps', ['-Axo', 'pid=,ppid=,pcpu=,rss=,command='])
      const procs = ps ? parsePs(ps) : []
      const titles = new Map((await chats().catch(() => [])).filter((c) => c.sdkSessionId).map((c) => [c.sdkSessionId, c.title || c.repo]))
      // working folders of Claude processes, for chats Laika Orbit does not host
      cwds.clear()
      for (const p of procs.filter((x) => /(^|\/)claude(\s|$)/.test(x.command) && !/--resume[= ]/.test(x.command)).slice(0, 12)) {
        const out = await run('lsof', ['-a', '-p', String(p.pid), '-d', 'cwd', '-Fn'], 2000)
        const cwd = out && /^n(.+)$/m.exec(out)?.[1]
        if (cwd) cwds.set(p.pid, cwd)
      }
      heavy = withRoutes(heaviest(procs, { chats: titles, cwdOf }))
    } else heavy = []
    const changed = busy !== state.busy || JSON.stringify(heavy.map((h) => [h.label, h.owner])) !== JSON.stringify(state.heavy.map((h) => [h.label, h.owner]))
    const reasons = busy ? reasonsOf(s) : []
    state = {
      busy,
      since: busy ? (state.busy ? state.since : s.at) : null,
      notice: busy ? noticeOf(heavy, reasons) : null,
      reasons,
      heavy,
      at: s.at,
      cpu: s.cpu,
      mem: s.mem,
      speedLimit: s.speedLimit,
    }
    save()
    if (changed) onChange(state)
  }
  const loop = async () => {
    await tick().catch(() => {})
    setTimeout(loop, EVERY_MS).unref()
  }
  loop()
  return { state: () => state }
}
