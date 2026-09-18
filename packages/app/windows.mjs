/**
 * Windows machines: reached over Windows' own OpenSSH server with Laika Orbit's key, which that
 * machine lets run one thing only, its gate (tools/windows-node/gate.ps1, installed by setup.ps1).
 * There is no agent host there: the gate starts jobs, streams their output, and moves files.
 *
 * Files move as tar over ssh, never rsync. Windows ships tar.exe (bsdtar) and OpenSSH and nothing
 * else is needed: rsync there means WSL or a Cygwin build, a second system to keep working, slow
 * access to NTFS from WSL and path translation both ways; scp has no idea what changed, so it
 * would send a whole Unity project every time, and cannot remove files. So the Mac asks the gate
 * for a manifest (path, size, modified time), sends one tar of what differs plus a list of what
 * to remove, and gets outputs back the same way: rsync's behaviour, in two round trips.
 *
 * `openGate(m)` looks like machines.mjs openTunnel to the code that runs jobs: `call` answers the
 * agent host routes offload uses (GET /health, POST /jobs, GET /jobs, GET /jobs/:id/events,
 * DELETE /jobs/:id), so offload, followJob and blender-offload work unchanged.
 */
import { spawn } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { KEY_DIR, SYNC_EXCLUDES, sshOptions } from './machines.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const KIT_SOURCE = resolve(HERE, '../../tools/windows-node')
export const KIT_FILES = ['setup.ps1', 'gate.ps1', 'runner.ps1', 'CHECKLIST.md']

export const isWindows = (m) => m?.os === 'windows'

/** one gate verb over ssh: its exit code, stdout as bytes and stderr as text; `input` goes to stdin */
export function gate(m, words, { input = null, pipeIn = null, timeout = 60_000 } = {}) {
  return new Promise((ok) => {
    const proc = spawn('ssh', [...sshOptions(m), '-T', `${m.user}@${m.host}`, words.join(' ')], { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    let err = ''
    const timer = timeout ? setTimeout(() => proc.kill(), timeout) : null
    proc.stdout.on('data', (d) => out.push(d))
    proc.stderr.on('data', (d) => {
      err += d
    })
    proc.on('error', (e) => ok({ code: -1, out: Buffer.alloc(0), err: String(e.message) }))
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer)
      ok({ code, out: Buffer.concat(out), err })
    })
    if (pipeIn) pipeIn.pipe(proc.stdin)
    else proc.stdin.end(input ?? undefined)
  })
}

/** the gate's JSON answer ({ status, body }) out of a verb's output, or an error saying why not */
export function replyOf(r, who) {
  const line = r.out
    .toString('utf8')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('{"'))
  if (line) {
    try {
      return JSON.parse(line)
    } catch {}
  }
  const why = (r.err || r.out.toString('utf8')).trim().split('\n').slice(-2).join(' / ') || `ssh exited ${r.code}`
  throw new Error(`cannot reach ${who}: ${why}`)
}

/** this machine's state, shaped like the agent host's /health?machine=1 */
export async function winHealth(m, { timeout = 20_000 } = {}) {
  const rep = replyOf(await gate(m, ['health'], { timeout }), m.name ?? m.host)
  if (rep.status !== 200) throw new Error(`${m.name}: ${rep.body?.error ?? rep.status}`)
  return rep.body.machine
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** a handle with the same `call` / `close` as a tunnel to an agent host */
export function openGate(m) {
  const who = m.name ?? m.host
  const live = new Set()
  async function call(path, init = {}) {
    const method = (init.method ?? 'GET').toUpperCase()
    const url = new URL(path, 'http://gate')
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] === 'health' && method === 'GET') return json(200, { ok: true, machine: await winHealth(m) })
    if (parts[0] !== 'jobs') return json(404, { error: `${who} (Windows) has no ${url.pathname}` })
    if (parts.length === 1 && method === 'GET') {
      const rep = replyOf(await gate(m, ['jobs']), who)
      return json(rep.status, rep.body)
    }
    if (parts.length === 1 && method === 'POST') {
      const job = JSON.parse(init.body ?? '{}')
      const rep = replyOf(await gate(m, ['start', job.dir], { input: JSON.stringify(job) }), who)
      return json(rep.status, rep.body)
    }
    if (parts.length === 2 && method === 'DELETE') {
      const rep = replyOf(await gate(m, ['kill', parts[1]]), who)
      return json(rep.status, rep.body)
    }
    if (parts.length === 3 && parts[2] === 'events' && method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0) || 0
      const proc = spawn('ssh', [...sshOptions(m), '-T', `${m.user}@${m.host}`, `follow ${parts[1]} ${since}`], { stdio: ['ignore', 'pipe', 'ignore'] })
      live.add(proc)
      proc.on('close', () => live.delete(proc))
      return new Response(Readable.toWeb(proc.stdout), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return json(404, { error: `${who} (Windows) has no ${method} ${url.pathname}` })
  }
  return {
    base: null,
    call,
    proc: null,
    close() {
      for (const p of live) p.kill()
    },
  }
}

// ------------------------------------------------------------------ files ----
/**
 * Whether a path is left out of a sync: SYNC_EXCLUDES and a project's .offloadignore, read the
 * way rsync reads them for the usual cases. A leading / anchors to the project, a trailing / means
 * folders only, a pattern with no / matches a name at any depth, * and ? stay within a name and
 * ** crosses folders.
 */
export function excluder(patterns) {
  const rules = []
  for (const raw of patterns) {
    let p = raw.trim()
    if (!p || p.startsWith('#')) continue
    if (p.startsWith('- ')) p = p.slice(2)
    else if (/^[+!] /.test(p) || p === '!') continue
    const dirOnly = p.endsWith('/')
    if (dirOnly) p = p.slice(0, -1)
    const anchored = p.startsWith('/')
    if (anchored) p = p.slice(1)
    const glob = p
      .split('**')
      .map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
      .join('.*')
    const re = anchored ? new RegExp(`^${glob}$`) : new RegExp(`(^|/)${glob}$`)
    rules.push({ re, dirOnly, anchored, name: !p.includes('/') })
  }
  /** `rel` is a path from the project root with / between names; `dir` whether it is a folder */
  return (rel, dir) => {
    const names = rel.split('/')
    for (const r of rules) {
      if (r.dirOnly && !dir) {
        // a folder rule still excludes everything under a matching folder
        for (let i = 1; i < names.length; i++) if (test(r, names.slice(0, i))) return true
        continue
      }
      for (let i = 1; i <= names.length; i++) if (test(r, names.slice(0, i))) return true
    }
    return false
  }
  function test(r, names) {
    if (r.anchored) return r.re.test(names.join('/'))
    if (r.name) return r.re.test(names[names.length - 1])
    return r.re.test(names.join('/'))
  }
}

export function excludesFor(local) {
  const extra = (() => {
    try {
      return readFileSync(join(local, '.offloadignore'), 'utf8').split('\n')
    } catch {
      return []
    }
  })()
  return excluder([...SYNC_EXCLUDES, ...extra])
}

/** the files under a folder, as path → { size, mtime in whole seconds }, left-out paths skipped */
export function localManifest(root, skip = excludesFor(root)) {
  const files = new Map()
  const walk = (rel) => {
    let names
    try {
      names = readdirSync(rel ? join(root, rel) : root)
    } catch {
      return
    }
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n
      let st
      try {
        st = lstatSync(join(root, r))
      } catch {
        continue
      }
      const dir = st.isDirectory()
      if (skip(r, dir)) continue
      if (dir) walk(r)
      else if (st.isFile() || st.isSymbolicLink()) files.set(r, { size: st.size, mtime: Math.floor(st.mtimeMs / 1000) })
    }
  }
  walk('')
  return files
}

/** the gate's manifest text → path → { size, mtime } */
export function parseManifest(text) {
  const files = new Map()
  for (const line of text.split('\n')) {
    const [p, size, mtime] = line.replace(/\r$/, '').split('\t')
    if (p && size !== undefined) files.set(p, { size: Number(size), mtime: Number(mtime) })
  }
  return files
}

/** what to send up and what to remove there so the copy matches the project (rsync -a --delete) */
export function planUp(local, remote, skip) {
  const send = []
  for (const [p, f] of local) {
    const r = remote.get(p)
    if (!r || r.size !== f.size || r.mtime !== f.mtime) send.push(p)
  }
  const remove = [...remote.keys()].filter((p) => !local.has(p) && !skip(p, false))
  return { send, remove }
}

/** what to bring down: files there that are missing here or newer (rsync -a --update) */
export function planDown(local, remote, skip) {
  const bring = []
  for (const [p, r] of remote) {
    if (skip(p, false)) continue
    const f = local.get(p)
    // differs, and the copy here is not the newer one
    if (!f || ((r.size !== f.size || r.mtime !== f.mtime) && f.mtime <= r.mtime)) bring.push(p)
  }
  return bring
}

async function remoteManifest(m, dir) {
  const r = await gate(m, ['manifest', dir], { timeout: 300_000 })
  if (r.code !== 0) throw new Error(`listing ${dir} on ${m.name} failed: ${(r.err || r.out.toString()).trim().slice(-300)}`)
  const text = r.out.toString('utf8')
  if (text.startsWith('{"')) throw new Error(`${m.name}: ${replyOf(r, m.name).body?.error}`)
  return parseManifest(text)
}

/** tar on this Mac: no AppleDouble files or macOS metadata in what Windows receives */
function tar(args, cwd) {
  return spawn('tar', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, COPYFILE_DISABLE: '1' } })
}

/** the given paths (relative, / separated) of `root` as one tar stream, with extra files alongside */
function packUp(root, paths, extra = {}) {
  const stage = mkdtempSync(join(tmpdir(), 'laika-win-'))
  const list = join(stage, 'list')
  writeFileSync(list, paths.map((p) => `${p}\n`).join(''))
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(stage, name), text)
  const args = ['--no-mac-metadata', '-cf', '-', '-C', root, ...(paths.length ? ['-T', list] : []), ...Object.keys(extra).flatMap((n) => ['-C', stage, n])]
  const proc = tar(args)
  proc.stdin.end()
  let err = ''
  proc.stderr.on('data', (d) => {
    err += d
  })
  const done = new Promise((ok) => proc.on('close', (code) => ok({ code, err })))
  return { stream: proc.stdout, done, cleanup: () => rmSync(stage, { recursive: true, force: true }) }
}

/** a tar (bytes) unpacked into `local` */
function unpack(bytes, local) {
  return new Promise((ok, no) => {
    mkdirSync(local, { recursive: true })
    const proc = tar(['-xf', '-', '-C', local])
    let err = ''
    proc.stderr.on('data', (d) => {
      err += d
    })
    proc.on('close', (code) => (code === 0 ? ok() : no(new Error(`unpacking failed: ${err.trim().slice(-300)}`))))
    proc.stdin.end(bytes)
  })
}

/** send what changed in the project to the machine's copy, and remove there what is gone here */
export async function winSyncUp(m, local, dir) {
  const skip = excludesFor(local)
  const { send, remove } = planUp(localManifest(local, skip), await remoteManifest(m, dir), skip)
  if (!send.length && !remove.length) return { sent: 0, removed: 0 }
  const pack = packUp(local, send, remove.length ? { '.laika-delete': `${remove.join('\n')}\n` } : {})
  try {
    const r = await gate(m, ['recv', dir], { pipeIn: pack.stream, timeout: 0 })
    const t = await pack.done
    if (t.code !== 0) throw new Error(`packing ${local} failed: ${t.err.trim().slice(-300)}`)
    const rep = replyOf(r, m.name)
    if (rep.status !== 200) throw new Error(`sync to ${m.name} failed: ${rep.body?.error}`)
    return { sent: send.length, removed: rep.body.removed ?? 0 }
  } finally {
    pack.cleanup()
  }
}

/** named paths (files or folders) from the machine's copy into `local`; returns those not there */
async function fetchPaths(m, dir, paths, local) {
  if (!paths.length) return []
  const r = await gate(m, ['send', dir], { input: JSON.stringify(paths), timeout: 0 })
  if (r.code !== 0) throw new Error(`copying back from ${m.name} failed: ${r.err.trim().slice(-300)}`)
  const missing = [...r.err.matchAll(/^missing: (.+)$/gm)].map((x) => x[1].trim())
  if (r.out.length) await unpack(r.out, local)
  return missing
}

/** what the machine made or changed in its copy, back into the project here; returns the paths */
export async function winSyncDown(m, local, dir) {
  const skip = excludesFor(local)
  const bring = planDown(localManifest(local, skip), await remoteManifest(m, dir), skip)
  await fetchPaths(m, dir, bring, local)
  return bring
}

export const winBringBack = (m, local, dir, paths) => fetchPaths(m, dir, paths, local)

/** remove a project's copy on the machine now (it is otherwise kept for the next sync) */
export async function winClean(m, dir = null) {
  const rep = replyOf(await gate(m, dir ? ['clean', dir] : ['clean']), m.name)
  if (rep.status !== 200) throw new Error(`${m.name}: ${rep.body?.error}`)
}

// -------------------------------------------------------------------- kit ----
/**
 * The folder to copy to a Windows machine: the setup script, the gate and runner, the checklist,
 * and this Mac's Laika Orbit public key (public: the private key never leaves ~/.laika/node).
 * Made outside the repo, so no key ever lands in git.
 */
export function makeKit(out = join(homedir(), '.laika', 'node', 'windows-kit')) {
  const pub = join(KEY_DIR, 'id_ed25519.pub')
  let key
  try {
    key = readFileSync(pub, 'utf8').trim()
  } catch {
    throw new Error(`no Laika Orbit key at ${pub} yet: build a node bundle once (node tools/node-bundle/build.mjs), which makes it`)
  }
  mkdirSync(out, { recursive: true })
  for (const f of KIT_FILES) {
    // CRLF, and a BOM on scripts: PowerShell 5.1 reads a script without one as the ANSI code page
    const text = readFileSync(join(KIT_SOURCE, f), 'utf8').replace(/\r?\n/g, '\r\n')
    writeFileSync(join(out, f), f.endsWith('.ps1') ? `\ufeff${text}` : text)
  }
  writeFileSync(join(out, 'laika-orbit.pub'), `${key.split(/\s+/).slice(0, 2).join(' ')} laika-orbit\r\n`)
  return out
}
