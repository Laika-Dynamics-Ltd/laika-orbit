/**
 * When local main moves, the stable app's next version is built in the background, and you
 * restart into it when you choose (docs/MERGE-TRAIN-CONTRACT.md, "Rebuild").
 *
 * Only the stable app's own chat host does this: its code lives in the stable snapshot
 * (~/.laika/orbit-stable, make-stable.mjs) and BRAIN_ROOT names the checkout it came from.
 *
 * The build never touches the running app. make-stable moves the snapshot in place, and the
 * stable server serves its page from that folder, so a build there would change the app under
 * you. Instead the new commit goes into a folder beside it (orbit-stable-next), dependencies and
 * all. Restarting (restart-stable.mjs, run detached) quits the app, swaps the two folders and opens
 * it again; nothing else ever restarts it.
 *
 * Nothing polls: a watch on the repo's refs notices main moving (the merge train says so too), a
 * build waits while this Mac is busy (the load watcher's ~/.laika/load.json), and a failed build
 * is not retried until main moves again.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** where this code runs from */
export const SELF_ROOT = resolve(HERE, '../..')
export const STABLE_DIR = process.env.LAIKA_STABLE_DIR ?? join(homedir(), '.laika', 'orbit-stable')
export const NEXT_FILE = join(homedir(), '.laika', 'stable-next.json')
/** main moved: wait this long for the burst to settle (a train lands several merges at once) */
const SETTLE_MS = 20_000
/** the Mac is busy: look again this much later */
const BUSY_RETRY_MS = 3 * 60_000
const INSTALL_MS = 15 * 60_000

const sh = (run, file, args, opts = {}) =>
  new Promise((done) =>
    run(file, args, { maxBuffer: 32e6, timeout: 120_000, ...opts }, (err, stdout, stderr) =>
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim() }),
    ),
  )

/** is this host the stable app's: running from the stable snapshot, reading a checkout's brain */
export const isStableHost = ({ self = SELF_ROOT, stable = STABLE_DIR, brainRoot = process.env.BRAIN_ROOT } = {}) =>
  resolve(self) === resolve(stable) && !!brainRoot && resolve(brainRoot) !== resolve(stable)

/**
 * `source` is the checkout the stable app is snapshotted from; `emit(frame)` goes to the page;
 * `busy()` says why not to build now, or null.
 */
export function createStableRebuild({ source, stableDir = STABLE_DIR, nextDir = `${stableDir}-next`, nextFile = NEXT_FILE, emit = () => {}, busy = () => null, run = execFile, log = (m) => console.log(`stable rebuild: ${m}`), settleMs = SETTLE_MS }) {
  let state = { state: 'idle', sha: null, subject: null, at: 0, error: null, running: null }
  let timer = null
  let building = null
  let failedSha = null

  const set = (s) => {
    state = { ...state, ...s, at: Date.now() }
    emit(view())
  }
  const view = () => ({ at: state.at, state: state.state, sha: state.sha, subject: state.subject, running: state.running, error: state.error })
  const shaOf = async (dir, ref = 'HEAD') => (await sh(run, 'git', ['-C', dir, 'rev-parse', ref])).out.trim() || null

  async function look() {
    timer = null
    if (building) return
    const [main, running] = await Promise.all([shaOf(source, 'refs/heads/main'), shaOf(stableDir)])
    if (!main || !running) return
    state.running = running
    if (main === running) {
      if (state.state !== 'idle') set({ state: 'idle', sha: null, subject: null, error: null })
      return
    }
    // already built and waiting for your restart, or failed at this very commit
    if ((state.state === 'ready' && state.sha === main) || failedSha === main) return
    // built before this host started: still good if the folder is at that commit
    try {
      const n = JSON.parse(readFileSync(nextFile, 'utf8'))
      if (n.sha === main && (await shaOf(nextDir)) === main) return set({ state: 'ready', sha: main, subject: n.subject, error: null })
    } catch {}
    const why = busy()
    if (why) {
      set({ state: 'waiting', sha: main, error: why })
      timer = setTimeout(look, BUSY_RETRY_MS)
      timer.unref?.()
      return
    }
    building = build(main).finally(() => {
      building = null
    })
  }

  async function build(sha) {
    const subject = (await sh(run, 'git', ['-C', source, 'log', '-1', '--format=%s', sha])).out.trim()
    set({ state: 'building', sha, subject, error: null })
    log(`building ${sha.slice(0, 7)} “${subject}” in ${nextDir}`)
    const step = async (what, file, args, opts) => {
      const r = await sh(run, file, args, opts)
      if (r.code) throw new Error(`${what}: ${r.out.split('\n').slice(-6).join('\n')}`)
      return r
    }
    try {
      if (existsSync(join(nextDir, '.git'))) {
        await step('checkout', 'git', ['-C', nextDir, 'checkout', '--quiet', '--force', '--detach', sha])
        await step('clean', 'git', ['-C', nextDir, 'clean', '-fdq'])
      } else {
        mkdirSync(dirname(nextDir), { recursive: true })
        await step('snapshot', 'git', ['-C', source, 'worktree', 'add', '--force', '--detach', nextDir, sha])
      }
      // secrets stay in one place, as make-stable does it
      const envLocal = join(source, '.env.local')
      const link = join(nextDir, '.env.local')
      if (existsSync(envLocal)) {
        try {
          if (lstatSync(link, { throwIfNoEntry: false })) unlinkSync(link)
        } catch {}
        symlinkSync(envLocal, link)
      }
      // gently: the lowest priority, and from the local store first
      await step('install', 'nice', ['-n', '15', 'pnpm', 'install', '--frozen-lockfile', '--prefer-offline', '--silent'], { cwd: nextDir, timeout: INSTALL_MS })
      for (const f of ['packages/app/server.mjs', 'packages/app/agent-host.mjs', 'packages/shell/main.mjs'])
        await step(`syntax check ${f}`, process.execPath, ['--check', join(nextDir, f)])
      // main may have moved again while this built: the next look builds that one
      const still = await shaOf(nextDir)
      if (still !== sha) throw new Error('the snapshot moved while it was built')
      writeFileSync(`${nextFile}.tmp`, JSON.stringify({ sha, subject, at: Date.now(), dir: nextDir, stable: stableDir, source }, null, 1))
      renameSync(`${nextFile}.tmp`, nextFile)
      set({ state: 'ready', sha, subject })
      log(`ready: ${sha.slice(0, 7)}`)
    } catch (e) {
      failedSha = sha
      set({ state: 'failed', sha, subject, error: String(e?.message ?? e).slice(0, 1500) })
      log(`failed at ${sha.slice(0, 7)}: ${e?.message ?? e}`)
    }
    // main moved on while this built
    kick()
  }

  /** main may have moved: look after it settles */
  function kick(ms = settleMs) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(look, ms)
    timer.unref?.()
  }

  // git moves a branch by writing refs/heads/<name> (or packed-refs) through a rename: watch both
  const watchers = []
  const common = existsSync(join(source, '.git', 'refs')) ? join(source, '.git') : null
  if (common)
    for (const dir of [join(common, 'refs', 'heads'), common])
      try {
        const w = watch(dir, (_e, name) => {
          if (name === 'main' || name === 'packed-refs' || name === 'main.lock') kick()
        })
        w.unref?.()
        watchers.push(w)
      } catch {}
  kick(5_000)

  /**
   * Restart into the built version: a detached helper quits the app, swaps the folders and opens
   * it again. Only when you ask.
   */
  function restart({ app = 'Laika Orbit' } = {}) {
    if (state.state !== 'ready') throw new Error('No new version is ready')
    const helper = join(nextDir, 'packages', 'shell', 'restart-stable.mjs')
    if (!existsSync(helper)) throw new Error(`The new version has no ${helper}`)
    const child = spawn(process.execPath, [helper, '--app', app, '--next', nextDir, '--stable', stableDir, '--source', source, '--port', process.env.APP_PORT ?? '5300'], {
      detached: true,
      stdio: 'ignore',
      cwd: homedir(),
    })
    child.unref()
    set({ state: 'restarting' })
    return view()
  }

  return { view, kick, restart, close: () => watchers.forEach((w) => w.close()) }
}
