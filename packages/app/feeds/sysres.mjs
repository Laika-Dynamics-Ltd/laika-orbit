/**
 * System resources for the top bar: CPU and memory, sampled only when the page asks.
 *
 * There is no timer here. CPU is the busy share of the time that passed between two
 * requests, so the first reading after a quiet spell covers that whole spell. Readings are
 * shared for a couple of seconds, so several open windows cost one sample between them.
 *
 * The hover card asks for more (swap and the busiest processes). Listing processes is the
 * one costly thing here, so it is only done while a card is open and shared for longer.
 */
import { cpus, freemem, loadavg, totalmem } from 'node:os'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const SHARE_MS = 2000
const PROCS_MS = 5000
const TOP = 5

const run = (cmd, args, timeout = 1500) =>
  new Promise((done) => execFile(cmd, args, { timeout, maxBuffer: 4 << 20 }, (err, out) => done(err ? null : out)))

/** Sums every core's clock ticks into busy and total. */
function ticks() {
  let busy = 0
  let total = 0
  for (const { times: t } of cpus()) {
    const all = t.user + t.nice + t.sys + t.idle + t.irq
    total += all
    busy += all - t.idle
  }
  return { busy, total }
}

/**
 * Memory in use the way Activity Monitor counts it: app memory (anonymous pages less the
 * purgeable ones), wired and compressed. os.freemem() on macOS counts only pages nobody has
 * touched, which reads as nearly full on any Mac that has been up a while.
 */
export function parseVmStat(text) {
  const size = Number(/page size of (\d+) bytes/.exec(text)?.[1])
  const pages = (label) => Number(new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(text)?.[1]) * size
  const app = pages('Anonymous pages') - pages('Pages purgeable')
  const wired = pages('Pages wired down')
  const compressed = pages('Pages occupied by compressor')
  const used = app + wired + compressed
  return Number.isFinite(used) ? { used, app, wired, compressed } : null
}

/** Linux: everything but MemAvailable is in use; MemFree alone would count the page cache as used */
export function parseMeminfo(text) {
  const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(text)?.[1]) * 1024
  const used = kb('MemTotal') - kb('MemAvailable')
  return Number.isFinite(used) ? { used } : null
}

async function memory() {
  const fallback = { used: totalmem() - freemem() }
  if (process.platform === 'linux') {
    const info = await readFile('/proc/meminfo', 'utf8').catch(() => '')
    return parseMeminfo(info) ?? fallback
  }
  if (process.platform !== 'darwin') return fallback
  const out = await run('vm_stat', [])
  return (out && parseVmStat(out)) || fallback
}

/** "total = 13312.00M  used = 11956.31M  free = 1355.69M" → bytes */
export function parseSwapUsage(text) {
  const mb = (k) => Number(new RegExp(`${k} = ([\\d.]+)M`).exec(text)?.[1]) * 1024 ** 2
  const total = mb('total')
  const used = mb('used')
  return Number.isFinite(total) && Number.isFinite(used) ? { used, total } : null
}

async function swap() {
  if (process.platform === 'darwin') {
    const out = await run('sysctl', ['-n', 'vm.swapusage'])
    return out && parseSwapUsage(out)
  }
  try {
    const info = await readFile('/proc/meminfo', 'utf8')
    const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(info)?.[1]) * 1024
    const total = kb('SwapTotal')
    return Number.isFinite(total) ? { used: total - kb('SwapFree'), total } : null
  } catch {
    return null
  }
}

/** `ps` rows of "pid pcpu rss(KB) name" → the busiest by CPU and the largest by memory. */
export function parsePs(text, top = TOP) {
  const all = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (m) all.push({ pid: Number(m[1]), cpu: Number(m[2]), mem: Number(m[3]) * 1024, name: m[4] })
  }
  const by = (k) => [...all].sort((a, b) => b[k] - a[k]).slice(0, top)
  return { cpu: by('cpu'), mem: by('mem') }
}

let procs = null
let procsAt = 0
function processes() {
  if (procs && Date.now() - procsAt < PROCS_MS) return procs
  procsAt = Date.now()
  const args =
    process.platform === 'darwin' ? ['-Aceo', 'pid=,pcpu=,rss=,comm='] : ['-Ao', 'pid=,pcpu=,rss=,comm=']
  procs = run('ps', args, 4000).then((out) => (out ? parsePs(out) : null))
  return procs
}

/** `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total` rows, memory in MiB */
export function parseNvidiaSmi(text) {
  const gpus = []
  for (const line of text.split('\n')) {
    const f = line.split(',').map((x) => x.trim())
    if (f.length !== 4 || !f[0]) continue
    const [util, used, total] = f.slice(1).map(Number)
    if ([util, used, total].some((n) => !Number.isFinite(n))) continue
    gpus.push({ name: f[0], util, memUsed: used * 1024 ** 2, memTotal: total * 1024 ** 2 })
  }
  return gpus
}

let gpuList = null
let gpuAt = 0
/** NVIDIA GPUs and how busy they are; empty where there are none (every Mac) */
export function gpus() {
  if (process.platform === 'darwin') return Promise.resolve([])
  if (gpuList && Date.now() - gpuAt < SHARE_MS) return gpuList
  gpuAt = Date.now()
  gpuList = run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], 4000).then(
    (out) => (out ? parseNvidiaSmi(out) : []),
  )
  return gpuList
}

let last = ticks()
let shared = null
let sharedAt = 0

function sample() {
  if (shared && Date.now() - sharedAt < SHARE_MS) return shared
  sharedAt = Date.now()
  shared = memory().then((m) => {
    const now = ticks()
    const span = now.total - last.total
    const cpu = span > 0 ? Math.round(((now.busy - last.busy) / span) * 100) : 0
    last = now
    const total = totalmem()
    const [l1, l5, l15] = loadavg().map((n) => Math.round(n * 100) / 100)
    return {
      cpu,
      cores: cpus().length,
      load: l1,
      loads: [l1, l5, l15],
      mem: Math.round((m.used / total) * 100),
      memUsed: m.used,
      memTotal: total,
      memApp: m.app ?? null,
      memWired: m.wired ?? null,
      memCompressed: m.compressed ?? null,
    }
  })
  return shared
}

/**
 * { cpu, mem } as whole percents, memory in bytes and load averages. With `detail`, also swap
 * and the top processes, for the hover card.
 */
export function sysres({ detail = false } = {}) {
  if (!detail) return sample()
  return Promise.all([sample(), swap(), processes()]).then(([s, sw, top]) => ({ ...s, swap: sw, top }))
}
