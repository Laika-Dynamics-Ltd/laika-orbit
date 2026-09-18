// The profiler, inside Orbit: /api/profiler/* is the /profiler skill's own sampler, passed through.
//
// There is one sampler and it lives outside the app on purpose — it watches Orbit's process tree
// with `ps` once a second, so it has to keep running when the app is slow, and it must not be a
// thing the app can skew by being profiled. The page that used to sit beside it at :5491 is now
// a panel (src/profiler-panel.ts); this file is the only bridge. The skill keeps working
// unchanged: `profiler bench`, `profiler findings` and its own page all talk to the same server.
//
//   GET  /api/profiler/stream          the sampler's SSE: `history`, then a sample a second, `bench`
//   GET  /api/profiler/bench           benchmark runs and the one in progress
//   POST /api/profiler/bench/{start,stop,baseline,delete}?label=&secs=&id=
//   GET  /api/profiler/findings.json   the findings the skill wrote
//   GET  /api/profiler/ab.json         before/after results from the skill's ab.mjs
//   GET  /api/profiler/status          { up, port, canStart }
//   POST /api/profiler/start           start the sampler if it is not running
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import http from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.PROFILER_PORT ?? 5491)
/** the skill's sampler; override when the skill is installed somewhere else */
const SERVER = process.env.PROFILER_SERVER ?? join(homedir(), '.claude', 'skills', 'profiler', 'server.mjs')
const DIR = process.env.PROFILER_DIR ?? join(homedir(), '.laika', 'profiler')

const PASS = new Set(['/stream', '/bench', '/bench/start', '/bench/stop', '/bench/baseline', '/bench/delete', '/findings.json', '/ab.json'])

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** is the sampler answering? A GET on /bench is cheap and always there */
const up = () =>
  new Promise((ok) => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: '/bench', timeout: 1200 }, (x) => {
      x.resume()
      ok(x.statusCode === 200)
    })
    r.on('timeout', () => r.destroy())
    r.on('error', () => ok(false))
  })

let starting = null
/** start the skill's sampler detached, logging where the skill does, and wait for it to answer */
function start() {
  starting ??= (async () => {
    if (await up()) return true
    if (!existsSync(SERVER)) return false
    mkdirSync(DIR, { recursive: true })
    const log = openSync(join(DIR, 'server.log'), 'a')
    spawn(process.execPath, [SERVER], { detached: true, stdio: ['ignore', log, log], env: process.env }).unref()
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250))
      if (await up()) return true
    }
    return false
  })().finally(() => {
    starting = null
  })
  return starting
}

/** @returns {Promise<boolean>} true when the request was ours */
export async function handleProfiler(url, req, res) {
  if (!url.pathname.startsWith('/api/profiler/')) return false
  const sub = url.pathname.slice('/api/profiler'.length)
  if (sub === '/status') {
    json(res, 200, { up: await up(), port: PORT, canStart: existsSync(SERVER) })
    return true
  }
  if (sub === '/start' && req.method === 'POST') {
    const ok = await start()
    json(res, ok ? 200 : 503, ok ? { up: true } : { up: false, error: existsSync(SERVER) ? 'the sampler did not answer' : `no sampler at ${SERVER}` })
    return true
  }
  if (!PASS.has(sub)) {
    json(res, 404, { error: 'not a profiler route' })
    return true
  }
  // pass it through as it is, the event stream included; a closed tab closes the upstream too
  const up2 = http.request(
    { host: '127.0.0.1', port: PORT, path: sub + url.search, method: req.method, headers: { accept: req.headers.accept ?? '*/*' } },
    (x) => {
      res.writeHead(x.statusCode ?? 502, {
        'content-type': x.headers['content-type'] ?? 'application/json',
        'cache-control': 'no-store',
        ...(sub === '/stream' ? { connection: 'keep-alive' } : {}),
      })
      x.pipe(res)
    },
  )
  up2.on('error', () => {
    if (!res.headersSent) json(res, 503, { error: 'the profiler is not running', down: true })
    else res.end()
  })
  // on the response, not the request: a GET's request 'closes' as soon as it has been read
  res.on('close', () => up2.destroy())
  up2.end()
  return true
}
