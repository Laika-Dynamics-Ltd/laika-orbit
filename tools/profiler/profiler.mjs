#!/usr/bin/env node
// Live profiler for the Laika Orbit desktop app: start/stop the sampler, open its page, record a
// benchmark, and set the findings panel. State lives in ~/.laika/profiler (PROFILER_DIR).
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIR = process.env.PROFILER_DIR ?? join(homedir(), '.laika', 'profiler')
const PORT = Number(process.env.PROFILER_PORT ?? 5491)
const URL_ = `http://127.0.0.1:${PORT}`
mkdirSync(DIR, { recursive: true })

const [cmd = 'start', ...rest] = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? rest[i + 1] : fallback
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const api = async (path, method = 'GET') => {
  const r = await fetch(`${URL_}${path}`, { method })
  return r.json()
}
const up = async () => {
  try {
    await fetch(`${URL_}/bench`, { signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    return false
  }
}

async function start() {
  if (await up()) return console.log(`already running · ${URL_}`)
  const log = join(DIR, 'server.log')
  const out = openSync(log, 'a')
  const child = spawn(process.execPath, [join(HERE, 'server.mjs')], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, PROFILER_PORT: String(PORT), PROFILER_DIR: DIR },
  })
  child.unref()
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    if (await up()) return console.log(`profiler on ${URL_} · log ${log}`)
  }
  console.error(`did not come up; see ${log}`)
  process.exit(1)
}
async function openPage() {
  if (!(await up())) await start()
  // `open` from an Electron terminal exports ELECTRON_RUN_AS_NODE; strip it or the browser exits
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  execFile('open', [`${URL_}/`], { env })
  console.log(`opened ${URL_}`)
}

async function bench() {
  const label = rest.find((a) => !a.startsWith('--')) ?? `Run ${Date.now()}`
  const secs = Number(arg('secs', 60))
  if (!(await up())) await start()
  const st = await api(`/bench/start?secs=${secs}&label=${encodeURIComponent(label)}`, 'POST')
  if (st.error) {
    console.error(st.error)
    process.exit(1)
  }
  console.log(`recording “${label}” for ${secs}s — leave the app in the state you are measuring`)
  for (;;) {
    await sleep(3000)
    const s = await api('/bench')
    if (!s.active) {
      const run = s.runs.at(-1)
      const base = s.runs.find((r) => r.baseline)
      const d =
        base && base !== run
          ? ` (${(((run.appCpu - base.appCpu) / base.appCpu) * 100).toFixed(0)}% vs baseline “${base.label}”)`
          : ''
      console.log(
        `done: app CPU ${run.appCpu.toFixed(0)}% avg, p95 ${run.appCpuP95.toFixed(0)}%, window renderer ${run.window.toFixed(0)}%, GPU ${run.gpu.toFixed(0)}%, memory ${run.memGB.toFixed(2)} GB, server p95 ${run.latP95?.toFixed(0) ?? '–'} ms, load ${run.load.toFixed(1)}${d}`,
      )
      return
    }
    process.stdout.write(`\r${s.active.n}/${s.active.secs}s`)
  }
}

function findings() {
  const when = arg('when', new Date().toLocaleString())
  const items = []
  for (let i = 0; i < rest.length; i++) if (rest[i] === '--item') items.push(rest[i + 1])
  const f = join(DIR, 'findings.json')
  const doc = items.length ? { when, items } : JSON.parse(readFileSync(f, 'utf8'))
  writeFileSync(f, JSON.stringify(doc, null, 1))
  console.log(`findings: ${doc.items.length} item(s) → the page picks them up within 5s`)
}

switch (cmd) {
  case 'start':
    await start()
    break
  case 'open':
    await openPage()
    break
  case 'stop': {
    execFile('pkill', ['-f', join(HERE, 'server.mjs')], () => console.log('stopped'))
    break
  }
  case 'status': {
    const running = await up()
    console.log(running ? `running · ${URL_}` : 'not running')
    if (running) {
      const s = await api('/bench')
      console.log(
        `${s.runs.length} benchmark run(s)${s.active ? ` · recording “${s.active.label}”` : ''}`,
      )
    }
    break
  }
  case 'bench':
    await bench()
    break
  case 'findings':
    findings()
    break
  case 'url':
    console.log(URL_)
    break
  default:
    console.error(
      'usage: profiler.mjs start|open|stop|status|url | bench "<label>" [--secs 60] | findings --when "…" --item "…"',
    )
    process.exit(2)
}
