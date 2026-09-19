/**
 * Other machines this Mac sends work to, and the two ways in, both with Laika Orbit's own SSH key
 * (~/.laika/node, made by tools/node-bundle/build.mjs and allowed on a machine by its installer):
 *   - a tunnel to the machine's agent host, which listens on its loopback only
 *   - rsync into the machine's work folder (~/orbit-work), which is all else the key may do
 *
 * The list lives in brain/nodes.local.json:  { "machines": [{ "name", "user", "host", "port" }] }
 * An entry may also say what the machine is and can do; everything is optional, and an entry with
 * none of it (box1's) is a Linux machine with an agent host, as it always was:
 *   "os": "linux" | "windows" | "mac"
 *   "can": { "gpu": "NVIDIA RTX 4090" | true | false, "browsers": true, "simulators": false }
 *   "limits": { "jobs": 2, "reserve": 4e9 }   jobs this Mac sends at once; memory left free there
 * What a machine reports about itself (cores, memory, GPUs, Unity versions) fills in the rest.
 * Windows machines have no agent host: they are reached through windows.mjs (ssh to a gate).
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isWindows, openGate, winBringBack, winHealth, winSyncDown, winSyncUp } from './windows.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const BRAIN_ROOT = resolve(process.env.BRAIN_ROOT ?? resolve(HERE, '../..'))
export const LIST = join(BRAIN_ROOT, 'brain', 'nodes.local.json')
export const KEY_DIR = join(homedir(), '.laika', 'node')
/** the agent host's port on every machine; the installer allows the key to forward to this one */
const AGENT_PORT = 7420

/**
 * Left on the Mac: Unity's caches and per-user files (each machine builds its own Library, and
 * keeps it between runs), build output, dependencies, and git internals (a worktree's .git
 * points at a path only this Mac has). A project's .offloadignore adds to these.
 */
export const SYNC_EXCLUDES = ['/Library/', '/Temp/', '/Logs/', '/obj/', '/Build/', '/Builds/', '/UserSettings/', '/MemoryCaptures/', '/Recordings/', '.git', 'node_modules/', '.DS_Store']

export function readMachines(file = LIST) {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).machines ?? []
  } catch {
    return []
  }
}
export function writeMachines(list, file = LIST) {
  writeFileSync(file, `${JSON.stringify({ machines: list }, null, 2)}\n`, { mode: 0o600 })
}

/** "user@host" or "user@host:port" → { user, host, port } */
export function parseAddress(s) {
  const m = /^([a-z_][\w.-]*)@([\w.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?$/i.exec(String(s).trim())
  return m ? { user: m[1], host: m[2].replace(/^\[|\]$/g, ''), port: Number(m[3] ?? 22) } : null
}

/** where a project lives on the machines: its folder name, and a hash of its path so two never share */
export function remoteDir(localPath) {
  const abs = resolve(localPath)
  const name =
    basename(abs)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|-+$/g, '') || 'project'
  return `${name}-${createHash('sha256').update(abs).digest('hex').slice(0, 8)}`
}

export const token = () => readFileSync(join(KEY_DIR, 'token'), 'utf8').trim()

/** ssh settings for Laika Orbit's key: never a password prompt, and its hosts in their own known_hosts */
export function sshOptions(m) {
  return [
    '-i',
    join(KEY_DIR, 'id_ed25519'),
    '-p',
    String(m.port ?? 22),
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=8',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `UserKnownHostsFile=${join(KEY_DIR, 'known_hosts')}`,
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'LogLevel=ERROR',
  ]
}

const freePort = () =>
  new Promise((ok, no) => {
    const s = createServer()
    s.on('error', no)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => ok(port))
    })
  })

/**
 * A tunnel to a machine's agent host. Resolves once the host answers through it, with `call` for
 * requests and `close` to end it.
 */
export async function openTunnel(m, { timeout = 15_000 } = {}) {
  const port = await freePort()
  const tok = token()
  const proc = spawn('ssh', [...sshOptions(m), '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${port}:127.0.0.1:${AGENT_PORT}`, `${m.user}@${m.host}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let err = ''
  let exited = false
  proc.stderr.on('data', (d) => {
    err += d
  })
  proc.on('exit', () => {
    exited = true
  })
  const close = () => {
    try {
      proc.kill()
    } catch {}
  }
  const base = `http://127.0.0.1:${port}`
  const call = (path, init = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init.headers, 'x-agent-token': tok } })
  const who = m.name ?? m.host
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (exited) throw new Error(`cannot reach ${who}: ${err.trim() || 'ssh exited'}`)
    const r = await call('/health', { signal: AbortSignal.timeout(2000) }).catch(() => null)
    if (r?.ok) return { base, token: tok, call, close, proc }
    if (r?.status === 401) {
      close()
      throw new Error(`${who} refused this Mac's token: reinstall it from a bundle built on this Mac`)
    }
    await new Promise((ok) => setTimeout(ok, 150))
  }
  close()
  throw new Error(`${who}: the agent host did not answer through the tunnel`)
}

function rsync(args) {
  return new Promise((ok) => {
    const proc = spawn('rsync', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    proc.stdout.on('data', (d) => {
      out += d
    })
    proc.stderr.on('data', (d) => {
      out += d
    })
    proc.on('error', (e) => ok({ code: -1, out: String(e.message) }))
    proc.on('close', (code) => ok({ code, out }))
  })
}
/**
 * The ssh that rsync runs. macOS's rsync (openrsync) asks the far side for --dirs and --relative
 * by their long names, which rrsync (what the key is allowed to run there) does not accept; they
 * mean exactly -d and -R, so the wrapper spells them that way. It lives beside the key because
 * rsync splits -e on spaces and this repo's path has them.
 */
const SSH_WRAPPER = `#!/bin/sh
# made by Laika Orbit (packages/app/machines.mjs): ssh for rsync to Laika Orbit machines
for a do
  shift
  case "$a" in --dirs) a=-d ;; --relative) a=-R ;; esac
  set -- "$@" "$a"
done
exec ssh "$@"
`
function sshCommand(m) {
  const wrapper = join(KEY_DIR, 'rsync-ssh')
  if (!existsSync(wrapper) || readFileSync(wrapper, 'utf8') !== SSH_WRAPPER) {
    mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(wrapper, SSH_WRAPPER)
    chmodSync(wrapper, 0o755)
  }
  const opts = sshOptions(m)
  if (opts.some((a) => /\s/.test(a))) throw new Error('Laika Orbit key paths must not contain spaces')
  return [wrapper, ...opts].join(' ')
}

/** copy a project to a machine's work folder; files the Mac no longer has are removed there too */
export async function syncUp(m, local, dir) {
  if (isWindows(m)) return winSyncUp(m, local, dir)
  const ignore = join(local, '.offloadignore')
  const r = await rsync([
    '-az',
    '--delete',
    ...SYNC_EXCLUDES.map((e) => `--exclude=${e}`),
    ...(existsSync(ignore) ? [`--exclude-from=${ignore}`] : []),
    '-e',
    sshCommand(m),
    `${local}/`,
    `${m.user}@${m.host}:${dir}/`,
  ])
  if (r.code !== 0) throw new Error(`sync to ${m.name ?? m.host} failed (rsync ${r.code}): ${r.out.trim().slice(-400)}`)
}

/**
 * copy what changed in a machine's copy back into the project here: newer files only, nothing
 * deleted, the same things left out as going over. Returns the paths that came back.
 */
export async function syncDown(m, local, dir) {
  if (isWindows(m)) return winSyncDown(m, local, dir)
  const ignore = join(local, '.offloadignore')
  const r = await rsync([
    '-az',
    '--update',
    '--itemize-changes',
    ...SYNC_EXCLUDES.map((e) => `--exclude=${e}`),
    ...(existsSync(ignore) ? [`--exclude-from=${ignore}`] : []),
    '-e',
    sshCommand(m),
    `${m.user}@${m.host}:${dir}/`,
    `${local}/`,
  ])
  if (r.code !== 0) throw new Error(`copying back from ${m.name ?? m.host} failed (rsync ${r.code}): ${r.out.trim().slice(-400)}`)
  return r.out
    .split('\n')
    .map((l) => /^[<>ch.][fdLDS]\S*\s+(.+)$/.exec(l)?.[1])
    .filter((f) => f && !f.endsWith('/'))
}

/**
 * One tunnel per machine for a long-lived process (the app server), opened when first needed
 * and opened again when it has died. Tunnel pids are written down, so a server that was killed
 * without closing them has its strays stopped by the next one.
 */
export function createTunnelPool({ open = openTunnel, pidFile = join(tmpdir(), 'laika-machine-tunnels.json') } = {}) {
  const live = new Map()
  const note = () => {
    const pids = []
    for (const p of live.values()) if (p.proc?.pid) pids.push(p.proc.pid)
    try {
      writeFileSync(pidFile, JSON.stringify(pids))
    } catch {}
  }
  try {
    for (const pid of JSON.parse(readFileSync(pidFile, 'utf8'))) {
      try {
        process.kill(pid, 0)
        // only ssh tunnels this module started: their command line names the agent port forward
        const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
        if (cmd.includes(`127.0.0.1:${AGENT_PORT}`)) process.kill(pid)
      } catch {}
    }
  } catch {}
  const alive = (t) => t?.proc && t.proc.exitCode === null && t.proc.signalCode === null
  return {
    async get(m) {
      const cur = live.get(m.name)
      if (cur) {
        const t = await cur.promise.catch(() => null)
        if (alive(t)) return t
        live.delete(m.name)
      }
      const entry = { promise: open(m), proc: null }
      live.set(m.name, entry)
      try {
        const t = await entry.promise
        entry.proc = t.proc
        note()
        return t
      } catch (e) {
        if (live.get(m.name) === entry) live.delete(m.name)
        throw e
      }
    },
    forget(name) {
      const cur = live.get(name)
      live.delete(name)
      cur?.promise.then((t) => t.close(), () => {})
      note()
    },
    closeAll() {
      for (const name of [...live.keys()]) this.forget(name)
    },
  }
}

/** machines announcing a Laika Orbit node on the local network (Bonjour, _laikaorbit._tcp), as user@host */
export async function discover(ms = 3000) {
  const browse = (args, wait) =>
    new Promise((ok) => {
      const p = spawn('dns-sd', args)
      let out = ''
      p.stdout.on('data', (d) => {
        out += d
      })
      p.on('error', () => ok(''))
      setTimeout(() => {
        p.kill()
        ok(out)
      }, wait)
    })
  const names = [...new Set([...(await browse(['-B', '_laikaorbit._tcp', 'local.'], ms)).matchAll(/\s_Laika Orbit\._tcp\.\s+(.+)$/gm)].map((x) => x[1].trim()))]
  return Promise.all(
    names.map(async (name) => {
      const out = await browse(['-L', name, '_laikaorbit._tcp', 'local.'], 1500)
      const host = /can be reached at (\S+?)\.?:(\d+)/.exec(out)
      const user = /\buser=(\S+)/.exec(out)?.[1]
      return host && user ? { name, user, host: host[1], port: Number(host[2]), address: `${user}@${host[1]}${host[2] === '22' ? '' : `:${host[2]}`}` } : null
    }),
  ).then((all) => all.filter(Boolean))
}

/** copy files a run made on the machine back into the project, at the same places; missing ones are reported */
export async function bringBack(m, local, dir, paths) {
  if (isWindows(m)) return winBringBack(m, local, dir, paths)
  const missing = []
  for (const p of paths) {
    const r = await rsync(['-azR', '-e', sshCommand(m), `${m.user}@${m.host}:${dir}/./${p}`, `${local}/`])
    if (r.code !== 0) missing.push(p)
  }
  return missing
}

/** a path on this Mac as the same place inside the project, or null when it is outside the project */
export function inProject(root, cwd, p) {
  const abs = isAbsolute(p) ? p : resolve(cwd, p)
  const rel = relative(root, abs)
  return rel === '' ? '.' : rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel) ? null : rel
}

/** the Unity version a project is made with, from ProjectSettings/ProjectVersion.txt */
export function unityVersionOf(project) {
  try {
    return /^m_EditorVersion:\s*(\S+)/m.exec(readFileSync(join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8'))?.[1] ?? null
  } catch {
    return null
  }
}

/** Unity options whose value is a file or folder the run writes, to bring back to the Mac */
const UNITY_OUTPUTS = new Set([
  '-testResults',
  '-logFile',
  '-coverageResultsPath',
  '-buildLinux64Player',
  '-buildOSXUniversalPlayer',
  '-buildWindows64Player',
  '-buildWindowsPlayer',
])

/**
 * A Unity command line from this Mac, made to run in the project's copy on a machine: the project
 * path becomes the copy, output paths become paths inside it, and batch mode is added if it was
 * left out, since no machine has a screen for the editor. `args` excludes the Unity binary.
 *
 * What comes back: a player build's folder, and for a log or test results file the whole folder
 * it is written into, because a run's other outputs (captures, recordings) usually sit beside
 * them without being named on the command line.
 */
export function planUnity(args, cwd) {
  const a = [...args]
  const pi = a.indexOf('-projectPath')
  const project = resolve(cwd, pi >= 0 && a[pi + 1] ? a[pi + 1] : '.')
  if (pi >= 0) a[pi + 1] = '.'
  else a.push('-projectPath', '.')
  if (!a.includes('-batchmode')) a.unshift('-batchmode')
  const bring = []
  const mkdirs = []
  for (let i = 0; i < a.length - 1; i++) {
    if (!UNITY_OUTPUTS.has(a[i]) || a[i + 1] === '-' || a[i + 1].startsWith('-')) continue
    const rel = inProject(project, cwd, a[i + 1])
    if (!rel) throw new Error(`${a[i]} ${a[i + 1]} is outside the project, so it cannot come back from another machine`)
    a[i + 1] = rel
    const parent = dirname(rel)
    if (/^-build/.test(a[i]) || parent === '.') {
      bring.push(rel)
      continue
    }
    bring.push(parent)
    mkdirs.push(parent)
  }
  return { project, version: unityVersionOf(project), args: a, bring: [...new Set(bring)], mkdirs: [...new Set(mkdirs)] }
}

/** every machine with an open tunnel and its state (cores, load, jobs, Unity, work folder); offline ones carry the reason */
export async function surveyMachines(list = readMachines()) {
  return Promise.all(
    list.map(async (m) => {
      try {
        if (isWindows(m)) return { m, t: openGate(m), machine: await winHealth(m) }
        const t = await openTunnel(m)
        const h = await (await t.call('/health?machine=1', { signal: AbortSignal.timeout(8000) })).json()
        return { m, t, machine: h.machine ?? {} }
      } catch (e) {
        return { m, error: String(e?.message ?? e) }
      }
    }),
  )
}

/** GPU names that are software or virtual: a machine with only these has no GPU to render on */
const SOFTWARE_GPU = /llvmpipe|softpipe|swiftshader|basic (display|render)|microsoft remote|virtual|vmware|virtio|hyper-v|parsec/i

/**
 * What a machine can do, from its entry (`can`, which wins) and what it reported (`h`, its health):
 *   gpu      the GPU's name, or null
 *   render   work drawn on that GPU comes out right: a GPU, and on Windows someone signed in at
 *            the screen (the background session can render black, box1's dark-render problem)
 *   unity    Unity versions installed
 *   posix    runs shell scripts and Unix commands (not Windows)
 */
export function capsOf(m, h = {}) {
  const can = m.can ?? {}
  const found = (h.gpus ?? []).map((g) => g.name).filter((n) => n && !SOFTWARE_GPU.test(n))
  const gpu = can.gpu === false ? null : typeof can.gpu === 'string' ? can.gpu : (found[0] ?? (can.gpu === true ? 'GPU' : null))
  return {
    os: m.os ?? 'linux',
    cpu: can.cpu !== false,
    gpu,
    render: !!gpu && (!isWindows(m) || h.desktop !== false),
    unity: h.unity ?? [],
    browsers: can.browsers ?? (Array.isArray(h.browsers) ? h.browsers.length > 0 : null),
    simulators: can.simulators ?? (m.os === 'mac'),
    posix: !isWindows(m),
  }
}

/** the one line saying what a machine can run, for health and the fleet board */
export function canRun(c) {
  return [
    c.cpu && 'CPU work',
    c.gpu && (c.render ? 'GPU work (renders, captures, Unity)' : 'GPU work, but renders may come out black (nobody signed in)'),
    c.unity.length && `Unity ${c.unity.join(', ')}`,
    c.browsers && 'browsers',
    c.simulators && 'simulators',
    !c.posix && 'no shell scripts (Windows)',
  ].filter(Boolean)
}

/**
 * Where work would go now, by what it needs, from machines' last known state ([{ name, online,
 * caps, jobs }]): GPU work to the least busy machine that renders properly, else one with a GPU,
 * else any; CPU work to any. Null means this Mac.
 */
export function routesOf(rows) {
  const up = rows.filter((r) => r.online && r.caps)
  const best = (ok) => up.filter(ok).sort((a, b) => (a.jobs ?? 0) - (b.jobs ?? 0))[0]?.name ?? null
  return {
    gpu: best((r) => r.caps.render) ?? best((r) => r.caps.gpu) ?? best(() => true),
    cpu: best(() => true),
    cpuAll: up.map((r) => r.name),
  }
}

/** the machines as the app last saw them, for the load watcher and chats: ~/.laika/machines.json */
export const STATE_FILE = join(homedir(), '.laika', 'machines.json')
const STATE_STALE_MS = 2 * 60_000
export function saveMachineState(rows, file = STATE_FILE) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const slim = rows.map((r) => ({ name: r.name, os: r.os ?? r.caps?.os ?? null, online: !!r.online, caps: r.caps ?? null, jobs: r.jobs ?? 0, load: r.load ?? null, cores: r.cores ?? null }))
    writeFileSync(`${file}.tmp`, JSON.stringify({ at: Date.now(), machines: slim, routes: routesOf(slim) }))
    renameSync(`${file}.tmp`, file)
  } catch {}
}
/** the last saved state, or null when the app has not seen the machines lately */
export function machineState(file = STATE_FILE) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'))
    return Date.now() - s.at < STATE_STALE_MS ? s : null
  } catch {
    return null
  }
}

/** commands that run the same on Windows; anything else (sh, bash, ./x.sh, make) needs a Unix machine */
const PORTABLE = /^(node|npm|npx|pnpm|yarn|bun|deno|python|git|cargo|go|dotnet|blender|ffmpeg|unity)(\.exe|\.cmd)?$/i
/** what a command needs from a machine: GPU work draws (renders, captures, browsers, Unity, bakes) */
export function needsOf(cmd, args = []) {
  const line = [cmd, ...args].join(' ')
  const name = String(cmd).split('/').pop()
  return {
    gpu: /blender|unity|playwright|puppeteer|chrom(e|ium)|capture|render|bake|hyperframes|remotion|showreel/i.test(line),
    posix: !PORTABLE.test(name),
  }
}

/**
 * The named machine, or the least busy one that can run a job: GPU work goes first to machines
 * that render properly, then to any with a GPU, then (as before there were any) to the rest; then
 * fewest running jobs, then the lowest load for its cores. `unity` narrows to machines with that
 * version, `posix` to machines that are not Windows. Other handles are closed; the pick keeps its
 * open. `notes` says why machines were passed over.
 */
export async function chooseMachine({ on = null, unity = null, memory = 0, gpu = false, posix = false } = {}) {
  const all = readMachines()
  const list = on ? all.filter((m) => m.name === on) : posix ? all.filter((m) => !isWindows(m)) : all
  const seen = await surveyMachines(list)
  const notes = []
  for (const x of seen) {
    if (x.error) notes.push(`${x.m.name}: ${x.error}`)
    else if (unity && !x.machine.unity?.includes(unity)) notes.push(`${x.m.name}: no Unity ${unity} (has ${x.machine.unity?.join(', ') || 'none'})`)
    if (x.t) x.caps = capsOf(x.m, x.machine)
  }
  // a capped machine takes only so many jobs; a job must leave the machine its reserve of free
  // memory (its host refuses it otherwise); Unity wants memory besides: one run per 8 GB
  const room = (x) => {
    const n = x.machine.jobs ?? 0
    if (x.machine.cap?.jobs && n >= x.machine.cap.jobs) return false
    if (x.m.limits?.jobs && n >= x.m.limits.jobs) return false
    const free = x.machine.memFree ?? (x.machine.memTotal ?? 0) - (x.machine.memUsed ?? 0)
    const reserve = x.m.limits?.reserve ?? x.machine.cap?.reserve ?? 1.2e9
    if (memory && x.machine.memTotal && free - memory < reserve) return false
    return !unity || n < Math.max(1, Math.floor((x.machine.memTotal ?? 0) / 8e9))
  }
  for (const x of seen) if (x.t && (!unity || x.machine.unity?.includes(unity)) && !room(x)) notes.push(`${x.m.name}: busy (${x.machine.jobs} job(s) running)`)
  const able = seen.filter((x) => x.t && (!unity || x.machine.unity?.includes(unity)) && room(x))
  const rank = (x) => (!gpu ? 0 : x.caps.render ? 0 : x.caps.gpu ? 1 : 2)
  able.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.machine.jobs ?? 0) - (b.machine.jobs ?? 0) ||
      (a.machine.load ?? 0) / (a.machine.cores || 1) - (b.machine.load ?? 0) / (b.machine.cores || 1),
  )
  const pick = able[0] ?? null
  if (pick && gpu && !pick.caps.render) notes.push(`${pick.m.name} ${pick.caps.gpu ? 'has nobody signed in at the screen' : 'has no GPU'}: renders there may come out dark`)
  for (const x of seen) if (x.t && x !== pick) x.t.close()
  return { pick, notes }
}

/**
 * A job's output, handed to `write` as it happens, until it exits; returns the exit event.
 * Reconnects through a new tunnel if the old one drops, and Ctrl-C stops the job on the machine.
 */
export async function followJob(pick, id, { write, say = () => {} }) {
  let at = 0
  let tries = 0
  let interrupted = false
  const onInt = () => {
    if (interrupted) process.exit(130)
    interrupted = true
    say('stopping the job on the machine…')
    pick.t.call(`/jobs/${id}`, { method: 'DELETE' }).catch(() => {})
  }
  process.on('SIGINT', onInt)
  try {
    for (;;) {
      try {
        const r = await pick.t.call(`/jobs/${id}/events?since=${at}`)
        if (!r.ok || !r.body) throw new Error(`events answered ${r.status}`)
        const dec = new TextDecoder()
        let buf = ''
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true })
          let cut
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            const line = buf.slice(0, cut)
            buf = buf.slice(cut + 2)
            if (!line.startsWith('data: ')) continue
            const e = JSON.parse(line.slice(6))
            if (e.t === 'out') {
              write(e.data)
              at = e.at
            } else if (e.t === 'exit') return e
          }
        }
        throw new Error('the output stream ended early')
      } catch (e) {
        if (++tries > 5) throw e
        say(`lost the connection (${e?.message ?? e}); reconnecting…`)
        pick.t.close()
        await new Promise((ok) => setTimeout(ok, 2000 * tries))
        pick.t = await openTunnel(pick.m)
      }
    }
  } finally {
    process.off('SIGINT', onInt)
  }
}

/** a folder's contents onto a machine as they are: links followed, nothing deleted or left out */
export async function pushTree(m, local, dir) {
  if (isWindows(m)) throw new Error(`${m.name} is Windows: pushTree is for the Linux machines`)
  const r = await rsync(['-aL', '-e', sshCommand(m), `${local}/`, `${m.user}@${m.host}:${dir}/`])
  if (r.code !== 0) throw new Error(`copy to ${m.name ?? m.host} failed (rsync ${r.code}): ${r.out.trim().slice(-400)}`)
}

/** a folder's contents from a machine into a folder here */
export async function pullTree(m, dir, local) {
  if (isWindows(m)) throw new Error(`${m.name} is Windows: pullTree is for the Linux machines`)
  mkdirSync(local, { recursive: true })
  const r = await rsync(['-a', '-e', sshCommand(m), `${m.user}@${m.host}:${dir}/`, `${local}/`])
  if (r.code !== 0) throw new Error(`copy from ${m.name ?? m.host} failed (rsync ${r.code}): ${r.out.trim().slice(-400)}`)
}
