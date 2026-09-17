/**
 * Runs the browser suite against a server of its own: `pnpm test:e2e`.
 *
 * WHY A RUNNER AND NOT JUST `node --test`: the suites each need a live server, and
 * `node --test` gives every file its own process. Letting each one start a server would
 * mean rebuilding the index once per file. So the server is started here, once, and the
 * suites are told where it is through E2E_URL.
 *
 * The port is claimed from the kernel rather than fixed at 5200. A fixed port loses the
 * moment a second worktree, a dev server you forgot, or a run killed mid-flight is still
 * holding it — and the failure reads as a test failure rather than a port collision.
 * server.mjs binds the port with no fallback, so if something does take it in the gap
 * between claiming and binding, it dies loudly instead of serving somewhere else.
 *
 * NO_HMR=1 because a file save in another session live-reloads the page under the suite,
 * which the suite detects and reports as unreliable.
 *
 * E2E_URL set by hand is taken at its word: no server is started and nothing is torn down.
 *   E2E_URL=http://localhost:5200 pnpm test:e2e
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const SUITES = 'packages/app/test/e2e/*.e2e.mjs'

/** A port the kernel says is free right now, rather than one that merely looks unoccupied. */
const freePort = () =>
  new Promise((ok, fail) => {
    const probe = createServer()
    probe.on('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => ok(port))
    })
  })

/** Resolves once the server answers, rejects the moment it dies instead of waiting out the clock. */
function waitReady(base, child) {
  return new Promise((ok, fail) => {
    let done = false
    child.once('exit', (code) => {
      if (!done) fail(new Error(`server exited with code ${code} before it was ready`))
    })
    const until = Date.now() + 90_000
    const poll = async () => {
      if (done) return
      try {
        const r = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(3000) })
        if (r.ok) {
          done = true
          return ok()
        }
      } catch {}
      if (Date.now() > until) {
        done = true
        return fail(new Error(`server never answered on ${base}`))
      }
      setTimeout(poll, 500)
    }
    poll()
  })
}

const run = (base) =>
  new Promise((ok) => {
    const t = spawn(process.execPath, ['--test', '--test-concurrency=1', SUITES], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, E2E_URL: base },
    })
    t.on('exit', (code) => ok(code ?? 1))
  })

if (process.env.E2E_URL) {
  console.log(`[e2e] using the server already at ${process.env.E2E_URL}`)
  process.exit(await run(process.env.E2E_URL))
}

const port = await freePort()
const base = `http://localhost:${port}`
const server = spawn(process.execPath, ['packages/app/server.mjs'], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, PORT: String(port), NO_HMR: '1' },
})

// An orphaned server holds its port and keeps indexing; make sure ours never outlives the run.
const stop = () => server.killed || server.kill()
process.on('exit', stop)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1))

console.log(`[e2e] starting a server on ${base}`)
try {
  await waitReady(base, server)
} catch (e) {
  stop()
  console.error(`[e2e] ${e.message}`)
  process.exit(1)
}

const code = await run(base)
stop()
process.exit(code)
