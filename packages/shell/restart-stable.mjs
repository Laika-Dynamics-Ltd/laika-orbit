#!/usr/bin/env node
/**
 * Restart the stable Laika Orbit into the version stable-rebuild.mjs built beside it. Run detached
 * by the app when you click "Restart", never on its own:
 *
 *   1. asks the app to quit, the way ⌘Q does, and waits for it;
 *   2. stops the stable chat host if no chat is mid-turn (as make-stable does; its chats come back
 *      on the next host), otherwise leaves it for the server to replace once they finish;
 *   3. swaps the folders: orbit-stable → orbit-stable-prev, orbit-stable-next → orbit-stable;
 *   4. opens the app again.
 *
 * If the app does not quit, nothing is swapped. Every step goes to ~/.laika/stable-restart.log.
 *
 *   node restart-stable.mjs --app "Laika Orbit" --next <dir> --stable <dir> --source <checkout> [--port 5300]
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const arg = (k, d = null) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? process.argv[i + 1] : d
}
const APP = arg('app', 'Laika Orbit')
const NEXT = arg('next')
const STABLE = arg('stable')
const SOURCE = arg('source')
const PORT = arg('port', '5300')
const PREV = `${STABLE}-prev`
const LOG = join(homedir(), '.laika', 'stable-restart.log')
const say = (m) => appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`)
const git = (...a) => execFileSync('git', ['-C', SOURCE, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const running = () => {
  try {
    execFileSync('pgrep', ['-f', `/${APP}.app/Contents/MacOS/${APP}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

try {
  if (!NEXT || !STABLE || !SOURCE || !existsSync(join(NEXT, '.git'))) throw new Error(`nothing to restart into (${NEXT})`)
  say(`restart: ${APP} into ${NEXT}`)

  // 1 · quit, as ⌘Q does, so the app saves what it saves on quit
  if (running()) {
    execFileSync('osascript', ['-e', `tell application "${APP}" to quit`], { stdio: 'ignore', timeout: 20_000 })
    const until = Date.now() + 45_000
    while (running() && Date.now() < until) await sleep(500)
    if (running()) throw new Error(`${APP} did not quit: nothing swapped`)
  }

  // 2 · the chat host outlives the app: stop it when no chat is mid-turn
  try {
    const st = JSON.parse(readFileSync(join(tmpdir(), `laika-agent-host-${PORT}.json`), 'utf8'))
    const get = async (p) => (await fetch(`http://127.0.0.1:${st.port}${p}`, { headers: { 'x-agent-token': st.token }, signal: AbortSignal.timeout(5000) })).json()
    const [health, chats] = await Promise.all([get('/health'), get('/sessions')])
    const busy = chats.filter((c) => c.state === 'running' || c.state === 'starting')
    if (busy.length || health.sessions > chats.length) say(`chat host kept: ${busy.length} chat(s) working; the server replaces it once they finish`)
    else {
      process.kill(st.pid, 'SIGKILL')
      say(`chat host stopped; its ${chats.length} chat(s) come back on the new one`)
    }
  } catch {
    say('no chat host running')
  }

  // 3 · swap the folders, keeping the old one as -prev until the next restart
  if (existsSync(PREV)) {
    try {
      git('worktree', 'remove', '--force', PREV)
    } catch {
      rmSync(PREV, { recursive: true, force: true })
      git('worktree', 'prune')
    }
  }
  git('worktree', 'move', STABLE, PREV)
  try {
    git('worktree', 'move', NEXT, STABLE)
  } catch (e) {
    git('worktree', 'move', PREV, STABLE)
    throw e
  }
  rmSync(join(homedir(), '.laika', 'stable-next.json'), { force: true })
  say(`swapped: ${STABLE} is now ${git('-C', STABLE, 'rev-parse', '--short', 'HEAD').trim()}`)
} catch (e) {
  say(`stopped: ${e?.message ?? e}`)
}

// 4 · open it again, whatever happened above: you asked for the app back
try {
  execFileSync('open', ['-a', APP], { stdio: 'ignore' })
  say('opened')
} catch (e) {
  say(`could not open ${APP}: ${e?.message ?? e}`)
}
