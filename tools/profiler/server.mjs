// Live, outside-in profiler for the Laika Orbit desktop app.
// Samples every process in the app's tree once a second (CPU from cumulative CPU-time deltas,
// resident memory) and probes the local server's response time. Streams to the page over SSE.
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.PROFILER_PORT ?? 5491)
const APP_PORT = Number(process.env.PROFILER_APP_PORT ?? 5300)
/** the app's main process, which the whole tree hangs off */
const APP_MATCH = new RegExp(
  process.env.PROFILER_APP_MATCH ?? 'Laika Orbit\\.app/Contents/MacOS/Laika Orbit',
)
/** written state lives outside the skill: samples, benchmark runs, findings, A/B results */
const DIR = process.env.PROFILER_DIR ?? join(os.homedir(), '.laika', 'profiler')
mkdirSync(DIR, { recursive: true })
const LOG = join(DIR, 'samples.ndjson')
const HISTORY = 600

const ps = () =>
  new Promise((res, rej) =>
    execFile('ps', ['-axo', 'pid=,ppid=,time=,rss=,command='], { maxBuffer: 16e6 }, (e, out) =>
      e ? rej(e) : res(out),
    ),
  )

// ps time: [[dd-]hh:]mm:ss.cc
const secs = (t) => {
  let d = 0
  if (t.includes('-')) [d, t] = [Number(t.split('-')[0]), t.split('-')[1]]
  return t.split(':').reduce((a, p) => a * 60 + Number(p), 0) + d * 86400
}

const classify = (cmd) => {
  if (APP_MATCH.test(cmd)) return ['main', 'Electron main']
  if (/--type=gpu-process/.test(cmd)) return ['gpu', 'GPU process']
  if (/--type=renderer/.test(cmd)) return ['renderer', 'Renderer']
  if (/--type=utility/.test(cmd))
    return [
      'other',
      `Utility · ${cmd.match(/--utility-sub-type=([\w.]+)/)?.[1]?.split('.')[0] ?? '?'}`,
    ]
  if (/server\.mjs/.test(cmd)) return ['server', 'App server (node)']
  if (/agent-host\.mjs/.test(cmd)) return ['agents', 'Agent host (node)']
  if (/claude-agent-sdk.*\/claude /.test(cmd)) return ['agents', 'Claude agent']
  const bin = cmd.split(' ')[0].split('/').pop()
  return ['other', bin]
}

let prev = new Map()
let prevAt = 0
const history = (() => {
  try {
    return readFileSync(LOG, 'utf8')
      .trim()
      .split('\n')
      .slice(-HISTORY)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
})()
const clients = new Set()
let latency = null

// ── benchmarks: record a fixed window of samples, reduce it to a few numbers, keep every run ──
const RUNS = join(DIR, 'runs.json')
const loadRuns = () => (existsSync(RUNS) ? JSON.parse(readFileSync(RUNS, 'utf8')) : [])
const saveRuns = (runs) => writeFileSync(RUNS, JSON.stringify(runs, null, 2))
let bench = null // { id, label, secs, startedAt, samples: [] }

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
const pct = (a, p) => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]
}
function summarise(samples) {
  const cpu = (s, f) => s.procs.filter(f).reduce((a, p) => a + p.cpu, 0)
  const window = (s) =>
    s.procs.filter((p) => p.group === 'renderer').sort((a, b) => b.rss - a.rss)[0]?.cpu ?? 0
  const appCpu = samples.map((s) => cpu(s, (p) => p.group !== 'agents'))
  const lat = samples.map((s) => s.latency?.ms).filter((v) => v != null)
  return {
    appCpu: avg(appCpu),
    appCpuP95: pct(appCpu, 0.95),
    window: avg(samples.map(window)),
    gpu: avg(samples.map((s) => cpu(s, (p) => p.group === 'gpu'))),
    main: avg(samples.map((s) => cpu(s, (p) => p.group === 'main'))),
    server: avg(samples.map((s) => cpu(s, (p) => p.group === 'server'))),
    chats: avg(samples.map((s) => cpu(s, (p) => p.group === 'agents'))),
    memGB: avg(
      samples.map(
        (s) => s.procs.filter((p) => p.group !== 'agents').reduce((a, p) => a + p.rss, 0) / 2 ** 30,
      ),
    ),
    latP50: pct(lat, 0.5),
    latP95: pct(lat, 0.95),
    load: avg(samples.map((s) => s.load)),
    n: samples.length,
  }
}
function benchState() {
  return {
    active: bench && {
      id: bench.id,
      label: bench.label,
      secs: bench.secs,
      startedAt: bench.startedAt,
      n: bench.samples.length,
    },
    runs: loadRuns(),
  }
}
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const c of clients) c.write(msg)
}
function benchSample(sample) {
  if (!bench) return
  bench.samples.push(sample)
  if (bench.samples.length >= bench.secs) {
    const runs = loadRuns()
    runs.push({
      id: bench.id,
      label: bench.label,
      at: bench.startedAt,
      secs: bench.secs,
      baseline: runs.length === 0,
      ...summarise(bench.samples),
    })
    saveRuns(runs)
    console.log(`benchmark done: ${bench.label}`)
    bench = null
  }
  broadcast('bench', benchState())
}

async function probe() {
  const t0 = performance.now()
  await new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port: APP_PORT, path: '/', timeout: 5000 }, (r) => {
      r.resume()
      r.on('end', () => {
        latency = { ms: performance.now() - t0, status: r.statusCode }
        res()
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (e) => {
      latency = { ms: null, error: e.message }
      res()
    })
  })
}

async function tick() {
  const now = performance.now()
  const rows = (await ps())
    .split('\n')
    .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, time, rss, cmd]) => ({
      pid: +pid,
      ppid: +ppid,
      cpuSec: secs(time),
      rss: +rss * 1024,
      cmd,
    }))
  const root = rows.find((r) => APP_MATCH.test(r.cmd))
  const byParent = new Map()
  for (const r of rows) byParent.set(r.ppid, [...(byParent.get(r.ppid) ?? []), r])
  const tree = []
  if (root) {
    const stack = [root]
    while (stack.length) {
      const r = stack.pop()
      tree.push(r)
      stack.push(...(byParent.get(r.pid) ?? []))
    }
  }
  const dt = prevAt ? (now - prevAt) / 1000 : 0
  const agentPids = new Set(
    tree.filter((r) => /claude-agent-sdk.*\/claude /.test(r.cmd)).map((r) => r.pid),
  )
  const pidMap = new Map(tree.map((r) => [r.pid, r]))
  const underAgent = (r) => {
    for (let q = pidMap.get(r.ppid); q; q = pidMap.get(q.ppid))
      if (agentPids.has(q.pid)) return true
    return false
  }
  const procs = tree.map((r) => {
    let [group, label] = classify(r.cmd)
    if (underAgent(r))
      [group, label] = ['agents', `Agent tool · ${r.cmd.split(' ')[0].split('/').pop()}`]
    const p = prev.get(r.pid)
    const cpu = dt && p ? Math.max(0, ((r.cpuSec - p) / dt) * 100) : 0
    return { pid: r.pid, ppid: r.ppid, group, label, cpu, rss: r.rss }
  })
  // Name renderers by size: the biggest is almost always the app window itself.
  procs
    .filter((p) => p.group === 'renderer')
    .sort((a, b) => b.rss - a.rss)
    .forEach((p, i) => {
      p.label = i === 0 ? 'Renderer · app window' : `Renderer · tab/view #${i}`
    })
  prev = new Map(tree.map((r) => [r.pid, r.cpuSec]))
  const first = !prevAt
  prevAt = now
  if (first) return
  const sample = {
    t: Date.now(),
    load: os.loadavg()[0],
    cores: os.cpus().length,
    running: !!root,
    latency,
    procs,
  }
  history.push(sample)
  if (history.length > HISTORY) history.shift()
  appendFileSync(LOG, `${JSON.stringify(sample)}\n`)
  const msg = `data: ${JSON.stringify(sample)}\n\n`
  for (const c of clients) c.write(msg)
  benchSample(sample)
}

setInterval(() => tick().catch((e) => console.error(e)), 1000)
setInterval(probe, 2000)
probe()
tick()

http
  .createServer((req, res) => {
    if (req.url === '/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(`event: history\ndata: ${JSON.stringify(history)}\n\n`)
      res.write(`event: bench\ndata: ${JSON.stringify(benchState())}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    const url = new URL(req.url, 'http://x')
    if (url.pathname.startsWith('/bench')) {
      const json = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.method === 'GET') return json(200, benchState())
      if (req.method !== 'POST') return json(405, { error: 'method' })
      const runs = loadRuns()
      const id = url.searchParams.get('id')
      if (url.pathname === '/bench/start') {
        if (bench) return json(409, { error: 'a benchmark is already running' })
        const secs = Math.max(10, Math.min(600, Number(url.searchParams.get('secs')) || 60))
        const label = (url.searchParams.get('label') || `Run ${runs.length + 1}`).slice(0, 80)
        bench = { id: Date.now().toString(36), label, secs, startedAt: Date.now(), samples: [] }
      } else if (url.pathname === '/bench/stop') bench = null
      else if (url.pathname === '/bench/baseline')
        saveRuns(runs.map((r) => ({ ...r, baseline: r.id === id })))
      else if (url.pathname === '/bench/delete') saveRuns(runs.filter((r) => r.id !== id))
      broadcast('bench', benchState())
      return json(200, benchState())
    }
    if (req.url === '/ab.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      const f = join(DIR, 'ab.json')
      return res.end(existsSync(f) ? readFileSync(f) : '{"runs":[]}')
    }
    if (req.url === '/findings.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      const f = join(DIR, 'findings.json')
      return res.end(existsSync(f) ? readFileSync(f) : '{"when":"","items":[]}')
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(readFileSync(new URL('./index.html', import.meta.url)))
  })
  .listen(PORT, '127.0.0.1', () =>
    console.log(
      `profiler on http://127.0.0.1:${PORT} · watching ${APP_MATCH.source} · data in ${DIR}`,
    ),
  )
