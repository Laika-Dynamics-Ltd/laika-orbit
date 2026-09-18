// A/B benchmark of the 3D map: isolated copies of the app, headless Chromium on the real GPU at
// Joe's 3440x1440 display. Per run: load, settle past the map's 20 s idle threshold, then measure
// a fixed window: renderer + GPU process CPU (CDP SystemInfo cpuTime deltas), frames the page drew
// (WebGL clears) and draw calls per second.
//   node ab.mjs <label>=<port> [<label>=<port> ...]   (SCENARIOS=inview,panel,unfocused WINDOW=60)
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'

// Playwright comes from the repo the worktrees belong to
const pw = (
  await import(
    process.env.PLAYWRIGHT ??
      new URL('../../node_modules/playwright/index.js', import.meta.url).href
  )
).default

const DIR = process.env.PROFILER_DIR ?? `${os.homedir()}/.laika/profiler`
const OUT = `${DIR}/ab.json`
const BUILDS = process.argv.slice(2).map((a) => a.split('='))
const WINDOW = Number(process.env.WINDOW ?? 60)
const SETTLE = Number(process.env.SETTLE ?? 25)
const SCENARIOS = {
  inview: { name: 'Map in view, left alone', setup: async () => {} },
  panel: {
    name: 'Solid panel covering the map',
    setup: (p) =>
      p.evaluate(() => {
        const d = document.createElement('div')
        d.style.cssText = 'position:fixed;inset:0;z-index:50;background:rgb(18,18,17)'
        document.body.append(d)
      }),
  },
  unfocused: {
    name: 'Another app in front (window blurred)',
    setup: (p) =>
      p.evaluate(() => {
        document.hasFocus = () => false
        window.dispatchEvent(new Event('blur'))
      }),
  },
}
const pick = (process.env.SCENARIOS ?? 'inview,panel,unfocused').split(',')
const progress = (...a) => {
  try {
    execFileSync(`${os.homedir()}/.claude/skills/live-progress/runs.mjs`, a)
  } catch {}
}

const browser = await pw.chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'],
})
const cdp = await browser.newBrowserCDPSession()
const cpuByType = async () => {
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo')
  const out = {}
  for (const p of processInfo)
    out[p.type.toLowerCase()] = (out[p.type.toLowerCase()] ?? 0) + p.cpuTime
  return out
}

async function run(port, sc) {
  const ctx = await browser.newContext({
    viewport: { width: 3440, height: 1440 },
    deviceScaleFactor: 1,
  })
  const page = await ctx.newPage()
  await page.addInitScript(() => {
    window.__draws = 0
    window.__frames = 0
    for (const C of [WebGL2RenderingContext, WebGLRenderingContext]) {
      for (const m of [
        'drawElements',
        'drawArrays',
        'drawElementsInstanced',
        'drawArraysInstanced',
      ]) {
        const f = C.prototype[m]
        if (f)
          C.prototype[m] = function (...a) {
            window.__draws++
            return f.apply(this, a)
          }
      }
      const clear = C.prototype.clear
      C.prototype.clear = function (...a) {
        window.__frames++
        return clear.apply(this, a)
      }
    }
  })
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await page.waitForSelector('#stage canvas', { timeout: 30000 })
  await page.waitForTimeout(6000)
  await SCENARIOS[sc].setup(page)
  await page.waitForTimeout(SETTLE * 1000)
  const read = () => page.evaluate(() => [window.__draws, window.__frames])
  const [d0, f0] = await read()
  const c0 = await cpuByType()
  const t0 = performance.now()
  await page.waitForTimeout(WINDOW * 1000)
  const secs = (performance.now() - t0) / 1000
  const c1 = await cpuByType()
  const [d1, f1] = await read()
  await ctx.close()
  const pct = (k) => (((c1[k] ?? 0) - (c0[k] ?? 0)) / secs) * 100
  return {
    renderer: pct('renderer'),
    gpu: pct('gpu'),
    framesPerSec: (f1 - f0) / secs,
    drawsPerSec: (d1 - d0) / secs,
    secs,
    types: Object.keys(c1),
  }
}

const doc = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { runs: [] }
doc.scenarios = Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, v.name]))
doc.window = WINDOW
const plan = []
for (const sc of pick) for (const [label, port] of BUILDS) plan.push([label, port, sc])
for (const [i, [label, port, sc]] of plan.entries()) {
  progress(
    'lane',
    'orbit-map-pause-0918',
    'ab',
    '--done',
    String(i),
    '--total',
    String(plan.length),
    '--note',
    `${SCENARIOS[sc].name} · ${label}`,
  )
  const r = await run(Number(port), sc)
  const rec = { label, scenario: sc, at: Date.now(), load: os.loadavg()[0], ...r }
  doc.runs = doc.runs.filter((x) => !(x.label === label && x.scenario === sc))
  doc.runs.push(rec)
  writeFileSync(OUT, JSON.stringify(doc, null, 2))
  console.log(JSON.stringify(rec))
}
progress(
  'lane',
  'orbit-map-pause-0918',
  'ab',
  '--done',
  String(plan.length),
  '--total',
  String(plan.length),
  '--note',
  `Done: ${BUILDS.map((b) => b[0]).join(', ')}`,
)
await browser.close()
