#!/usr/bin/env node
/**
 * `pnpm shell:stable` — a Laika Orbit to live in while the checkout keeps changing.
 *
 * Takes a snapshot of the current commit into its own git worktree (~/.laika/orbit-stable by
 * default), installs it, and builds two apps:
 *
 *   Laika Orbit        the stable snapshot, on :5300, with the usual browser profile (your
 *                      logins) and the Dock pin. Nothing in the checkout touches it: no live
 *                      reload, no server restarts, no half-finished edits.
 *   Laika Orbit Dev    the checkout itself, on :5200, with a profile of its own, for trying
 *                      what is being built. Not pinned; `open -a "Laika Orbit Dev"`.
 *
 * Both read the same brain, Claude accounts and .env.local, so chats, history and settings are
 * shared. Each has its own chat host, so a chat started in one lives in that one. Run this again
 * to move the stable app to the current commit.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const STABLE = process.env.LAIKA_STABLE_DIR ?? join(homedir(), '.laika', 'orbit-stable')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', env, ...opts })
const out = (cmd, args, opts = {}) => execFileSync(cmd, args, { env, encoding: 'utf8', ...opts }).trim()
const step = (s) => console.log(`\n▸ ${s}`)

if (process.platform !== 'darwin') {
  console.error('make-stable builds macOS apps; on this platform run `pnpm shell` instead')
  process.exit(1)
}

// ------------------------------------------------------------------ snapshot ----
const sha = out('git', ['-C', ROOT, 'rev-parse', 'HEAD'])
const subject = out('git', ['-C', ROOT, 'log', '-1', '--format=%s'])
step(`snapshot ${sha.slice(0, 7)} “${subject}” → ${STABLE}`)
if (existsSync(join(STABLE, '.git'))) {
  // the stable tree is never edited by hand: move it to the new commit whatever it holds
  sh('git', ['-C', STABLE, 'checkout', '--quiet', '--force', '--detach', sha])
} else {
  sh('git', ['-C', ROOT, 'worktree', 'add', '--force', '--detach', STABLE, sha])
}

// secrets stay in one place: the stable tree reads the checkout's .env.local
const envLocal = join(ROOT, '.env.local')
const link = join(STABLE, '.env.local')
if (existsSync(envLocal)) {
  try {
    if (lstatSync(link, { throwIfNoEntry: false })) unlinkSync(link)
  } catch {}
  symlinkSync(envLocal, link)
}

// ------------------------------------------------------------------- install ----
step('installing dependencies in the snapshot')
sh('pnpm', ['install', '--frozen-lockfile'], { cwd: STABLE })

// ---------------------------------------------------------------------- apps ----
step('building Laika Orbit (stable, :5300)')
sh(process.execPath, [join(STABLE, 'packages/shell/make-app.mjs')], {
  cwd: STABLE,
  env: {
    ...env,
    LAIKA_APP_NAME: 'Laika Orbit',
    LAIKA_APP_PORT: '5300',
    LAIKA_USER_DATA: 'Laika Orbit',
    LAIKA_BUNDLE_ID: 'com.laikadynamics.laikaorbit',
    LAIKA_BRAIN_ROOT: ROOT,
    LAIKA_STABLE: '1',
  },
})

// ---------------------------------------------------------------- chat host ----
// The chat host outlives the app, and the server keeps a stale one while it has chats open, so
// without this the stable app would go on running the old snapshot's chats: new routes answer
// "not found". When no chat is mid-turn it is stopped; the next host brings its chats back.
step('replacing the stable chat host')
await (async () => {
  const stateFile = join(tmpdir(), 'laika-agent-host-5300.json')
  let st
  try {
    st = JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    return console.log('  none running')
  }
  const get = async (p) => {
    const r = await fetch(`http://127.0.0.1:${st.port}${p}`, { headers: { 'x-agent-token': st.token }, signal: AbortSignal.timeout(5000) })
    return r.json()
  }
  let health, chats
  try {
    ;[health, chats] = await Promise.all([get('/health'), get('/sessions')])
  } catch {
    return console.log('  none running')
  }
  const busy = chats.filter((c) => c.state === 'running' || c.state === 'starting')
  // /health counts open terminals too: a terminal would be lost, a chat is only paused
  if (busy.length || health.sessions > chats.length) {
    return console.log(`  kept: ${busy.length ? `${busy.length} chat(s) working` : 'a terminal is open'}. It is replaced once they finish.`)
  }
  try {
    process.kill(st.pid, 'SIGKILL')
    console.log(`  stopped; its ${chats.length} chat(s) come back on the new one`)
  } catch {
    console.log('  none running')
  }
})()

step('building Laika Orbit Dev (the checkout, :5200)')
sh(process.execPath, [join(ROOT, 'packages/shell/make-app.mjs')], {
  cwd: ROOT,
  env: {
    ...env,
    LAIKA_APP_NAME: 'Laika Orbit Dev',
    LAIKA_APP_PORT: '5200',
    LAIKA_USER_DATA: 'Laika Orbit Dev',
    LAIKA_BUNDLE_ID: 'com.laikadynamics.laikaorbit.dev',
    LAIKA_NO_DOCK: '1',
  },
})

console.log(`
Stable: Laika Orbit (Dock) runs ${sha.slice(0, 7)} on :5300.
Dev:    open -a "Laika Orbit Dev" runs this checkout on :5200.
Quit the running app first: the stable app takes over the usual browser profile.
Update the stable app to the latest commit any time with:  pnpm shell:stable
`)
