/**
 * Jobs: a command run to completion on this machine for someone elsewhere (a Unity test run, a
 * build), its output kept and streamed, and its exit code. Unlike a terminal there is no shell
 * and no screen: only the command's own output, and whether it worked.
 *
 * A job runs in a folder under the work root (~/orbit-work), which is where the Mac syncs its
 * projects with rsync. `unity: <version>` runs that version's Unity Editor, looked for where
 * Unity Hub keeps editors, so the Mac never needs to know where it is installed here.
 *
 * Each job gets its own process group, so ending one ends everything it started.
 *
 * Memory is guarded twice, because a job that runs a machine out of memory gets the kernel killing
 * whatever it picks (the agent host, a camera recorder): a job that would leave less than the
 * reserve free is refused as busy (the Mac queues it or runs it itself), and with `slice` set every
 * job runs inside one systemd slice capped below the machine's memory, so a job that grows past
 * it is the one stopped, reported as `oom`, and the Mac can run it instead.
 */
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { freemem, homedir, setPriority, totalmem } from 'node:os'
import { isAbsolute, join, normalize, sep } from 'node:path'

export const WORK_ROOT = process.env.AGENT_WORK_ROOT || join(homedir(), 'orbit-work')
export const UNITY_DIRS = [join(homedir(), 'Unity', 'Hub', 'Editor'), '/Applications/Unity/Hub/Editor', '/opt/unity/editors']

const KEEP_MS = 60 * 60_000
const KEEP_MAX = 50
const KILL_GRACE_MS = 10_000

/** a folder under the root, named relative to it; never outside it */
export function insideRoot(root, dir) {
  if (typeof dir !== 'string' || !dir || isAbsolute(dir)) return null
  const rel = normalize(dir)
  if (rel === '..' || rel.startsWith(`..${sep}`)) return null
  return join(root, rel)
}

/** the Unity Editor binary for a version, or null when this machine does not have it */
export function unityEditor(version, dirs = UNITY_DIRS, platform = process.platform) {
  if (!/^\d+\.\d+\.\d+[abfp]\d+$/.test(String(version))) return null
  for (const d of dirs) {
    const bin = platform === 'darwin' ? join(d, version, 'Unity.app', 'Contents', 'MacOS', 'Unity') : join(d, version, 'Editor', 'Unity')
    if (existsSync(bin)) return bin
  }
  return null
}

/** the Unity versions this machine can run, so the Mac knows where a project can go */
export function unityVersions(dirs = UNITY_DIRS, platform = process.platform) {
  const found = new Set()
  for (const d of dirs) {
    try {
      for (const v of readdirSync(d)) if (unityEditor(v, [d], platform)) found.add(v)
    } catch {}
  }
  return [...found].sort()
}

/**
 * `maxRunning` caps how many jobs run at once on this machine (a box that also has its own work,
 * like recording cameras); `nice` runs every job, and all it starts, at that CPU priority (19 is
 * the lowest). Both unset: no cap, normal priority.
 */
/**
 * memory a new process could have now: MemAvailable on Linux (free alone ignores reclaimable
 * cache). Elsewhere there is no such honest figure (macOS counts its file cache as used), so no
 * limit is assumed and the check before a job never refuses one.
 */
export function memAvailable() {
  if (process.platform !== 'linux') return Number.POSITIVE_INFINITY
  try {
    const kb = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1]
    if (kb) return Number(kb) * 1024
  } catch {}
  return freemem()
}

/** memory to keep free for the machine itself, whatever jobs want */
export const RESERVE = 1.2e9
/** what a job is expected to need when it does not say: Unity and Blender are heavy */
export const needOf = (o) =>
  Number(o.memory) > 0 ? Number(o.memory) : o.unity ? 3e9 : /(^|\/)blender$/i.test(String(o.cmd)) ? 3e9 : /(^|\/)ffmpeg$/.test(String(o.cmd)) ? 1e9 : 1.5e9

/**
 * A systemd user slice that holds every job, capped at the machine's memory less the reserve;
 * returns its name, or null where systemd or its memory controller is not there (then jobs run
 * uncapped, guarded only by the check before they start).
 */
export function prepareJobSlice(name = 'orbit-jobs.slice', max = totalmem() - RESERVE) {
  if (process.platform !== 'linux') return null
  try {
    execFileSync('systemctl', ['--user', 'set-property', '--runtime', name, `MemoryMax=${Math.floor(max)}`, 'MemorySwapMax=0'], { stdio: 'ignore', timeout: 5000 })
    execFileSync('systemd-run', ['--user', '--scope', '--quiet', `--slice=${name}`, '--', 'true'], { stdio: 'ignore', timeout: 5000 })
    return name
  } catch {
    return null
  }
}

export function createJobs({
  root = WORK_ROOT,
  unityDirs = UNITY_DIRS,
  maxLog = 2_000_000,
  run = spawn,
  maxRunning = 0,
  nice = 0,
  slice = null,
  available = memAvailable,
  reserve = RESERVE,
} = {}) {
  /** @type {Map<string, any>} */
  const jobs = new Map()

  const summary = (j) => ({
    id: j.id,
    dir: j.dir,
    cmd: j.cmd,
    args: j.args,
    unity: j.unity,
    state: j.state,
    oom: j.oom,
    code: j.code,
    signal: j.signal,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
  })

  /** finished jobs are kept for an hour, and only the newest fifty */
  function prune() {
    const done = [...jobs.values()].filter((j) => j.state !== 'running').sort((a, b) => b.endedAt - a.endedAt)
    for (const [i, j] of done.entries()) if (i >= KEEP_MAX || Date.now() - j.endedAt > KEEP_MS) jobs.delete(j.id)
  }

  function start(o) {
    const cwd = insideRoot(root, o.dir)
    if (!cwd) throw new Error('dir must be a folder under the work root')
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`no folder ${o.dir} on this machine: sync it first`)
    const args = Array.isArray(o.args) ? o.args.map(String) : []
    let cmd = o.cmd ? String(o.cmd) : null
    if (o.unity) {
      cmd = unityEditor(o.unity, unityDirs)
      if (!cmd) throw new Error(`Unity ${o.unity} is not installed on this machine`)
    }
    if (!cmd) throw new Error('cmd or unity is required')
    // one job per folder: two Unity runs on one project fight over its Library and lock file,
    // and a sync under a running job changes its files mid-run
    if ([...jobs.values()].some((x) => x.state === 'running' && insideRoot(root, x.dir) === cwd)) {
      throw Object.assign(new Error(`busy: another job is running in ${o.dir}`), { busy: true })
    }
    const running = [...jobs.values()].filter((x) => x.state === 'running').length
    if (maxRunning > 0 && running >= maxRunning) {
      throw Object.assign(new Error(`busy: this machine runs ${maxRunning} job${maxRunning === 1 ? '' : 's'} at a time`), { busy: true })
    }
    const need = needOf({ ...o, cmd })
    const free = available()
    if (free - need < reserve) {
      const gb = (b) => (b / 1e9).toFixed(1)
      throw Object.assign(new Error(`busy: not enough memory (${gb(free)} GB free, this job needs about ${gb(need)} GB)`), { busy: true, memory: true })
    }
    // folders the command writes into (a test results file's), inside the job's folder only
    for (const d of Array.isArray(o.mkdirs) ? o.mkdirs : []) {
      const p = insideRoot(cwd, d)
      if (p) mkdirSync(p, { recursive: true })
    }
    const env = { ...process.env }
    for (const [k, v] of Object.entries(o.env ?? {})) if (/^[A-Z_][A-Z0-9_]*$/i.test(k)) env[k] = String(v)
    prune()
    const j = {
      id: randomUUID(),
      dir: o.dir,
      cmd,
      args,
      unity: o.unity ?? null,
      state: 'running',
      code: null,
      signal: null,
      startedAt: Date.now(),
      endedAt: null,
      log: '',
      dropped: 0, // bytes cut from the front of log, so a reader can resume by position
      listeners: new Set(),
      proc: null,
    }
    const emit = (e) => {
      for (const fn of j.listeners) fn(e)
    }
    const out = (chunk) => {
      const data = chunk.toString('utf8')
      j.log += data
      if (j.log.length > maxLog) {
        const cut = j.log.length - maxLog
        j.log = j.log.slice(cut)
        j.dropped += cut
      }
      emit({ t: 'out', data, at: j.dropped + j.log.length })
    }
    const finish = (code, signal, error) => {
      if (j.state !== 'running') return
      if (error) out(Buffer.from(`\n${error}\n`))
      j.code = code
      j.signal = signal
      // SIGKILL that nobody here sent, inside the capped slice: the slice ran out of memory
      j.oom = !j.killed && !!slice && (signal === 'SIGKILL' || code === 137)
      if (j.oom) out(Buffer.from('\nstopped: the job used more memory than this machine keeps for jobs\n'))
      j.state = j.killed ? 'killed' : code === 0 ? 'done' : 'failed'
      j.endedAt = Date.now()
      emit({ t: 'exit', code, signal, state: j.state, oom: j.oom })
    }
    jobs.set(j.id, j)
    try {
      const [file, argv] = slice ? ['systemd-run', ['--user', '--scope', '--quiet', `--slice=${slice}`, '--', cmd, ...args]] : [cmd, args]
      j.proc = run(file, argv, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      // set before the command starts anything, so what it starts inherits the priority
      if (nice && j.proc.pid) {
        try {
          setPriority(j.proc.pid, nice)
        } catch {}
      }
    } catch (e) {
      finish(null, null, String(e?.message ?? e))
      return summary(j)
    }
    j.proc.stdout?.on('data', out)
    j.proc.stderr?.on('data', out)
    j.proc.on('error', (e) => finish(null, null, String(e?.message ?? e)))
    j.proc.on('close', (code, signal) => finish(code, signal))
    return summary(j)
  }

  /** stop a job and everything it started; SIGKILL if it has not gone after a grace period */
  function kill(id) {
    const j = jobs.get(id)
    if (!j) return false
    if (j.state !== 'running' || !j.proc?.pid) return true
    j.killed = true
    const group = (sig) => {
      try {
        process.kill(-j.proc.pid, sig)
      } catch {
        try {
          j.proc.kill(sig)
        } catch {}
      }
    }
    group('SIGTERM')
    setTimeout(() => j.state === 'running' && group('SIGKILL'), KILL_GRACE_MS).unref()
    return true
  }

  /**
   * output from byte `since` on, then live output and the exit; returns the unsubscribe.
   * A finished job sends its backlog and exit at once.
   */
  function watch(id, since, fn) {
    const j = jobs.get(id)
    if (!j) return null
    const from = Math.max(0, Number(since) - j.dropped || 0)
    const backlog = j.log.slice(from)
    if (backlog) fn({ t: 'out', data: backlog, at: j.dropped + j.log.length, replay: true })
    if (j.state !== 'running') {
      fn({ t: 'exit', code: j.code, signal: j.signal, state: j.state })
      return () => {}
    }
    j.listeners.add(fn)
    return () => j.listeners.delete(fn)
  }

  return {
    start,
    kill,
    watch,
    get: (id) => (jobs.has(id) ? summary(jobs.get(id)) : null),
    list: () => [...jobs.values()].map(summary),
    cap: { jobs: maxRunning || null, nice: nice || null },
    killAll: () => {
      for (const id of jobs.keys()) kill(id)
    },
  }
}
