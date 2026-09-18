// What does Orbit spend when nothing is in view or in use? A sweep over isolated copies of the app
// (NO_HMR=1 PORT=528x node packages/app/server.mjs), headless Chromium on the real GPU at Joe's
// 3440x1440, with offline demo chats that stream real events through the real host.
//
//   node sweep.mjs <label>=<port> [...]   SCENARIOS=idle,stream,streamhidden,away,hidden WINDOW=60
//   ATTRIB=1 adds per-source attribution (timers, frames, streams, animations, requests); it costs
//   a little overhead, so benchmark numbers come from runs without it.
//
// Per scenario: renderer and GPU process CPU (CDP SystemInfo), main-thread time split into
// script/style/layout (Performance.getMetrics), WebGL frames, requests per path.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'

const pw = (
  await import(
    process.env.PLAYWRIGHT ??
      new URL('../../node_modules/playwright/index.js', import.meta.url).href
  )
).default

const DIR = process.env.PROFILER_DIR ?? `${os.homedir()}/.laika/profiler`
const OUT = process.env.OUT ?? `${DIR}/sweep.json`
const BUILDS = process.argv.slice(2).map((a) => a.split('='))
const WINDOW = Number(process.env.WINDOW ?? 60)
const SETTLE = Number(process.env.SETTLE ?? 25)
const ATTRIB = process.env.ATTRIB === '1'
const RUN = process.env.RUN ?? 'idle-zero-0918'
const LANE = process.env.LANE ?? 'measure'
const REPOS = (process.env.REPOS ?? '').split(',').filter(Boolean)
const progress = (...a) => {
  try {
    execFileSync(`${os.homedir()}/.local/bin/runs`, a)
  } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ demo chats ----
/** offline demo chats on the copy's own host: they never reach Joe's chats or any account */
async function demoChats(port) {
  const api = `http://127.0.0.1:${port}/api/control/agent`
  const list = await (await fetch(`${api}/sessions`)).json()
  const mine = list.filter((s) => s.account === 'demo' && s.state !== 'closed')
  if (mine.length >= 5) return mine
  const made = []
  for (let i = 0; i < 5; i++) {
    const cwd = REPOS[i % REPOS.length]
    const r = await fetch(`${api}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-control': '1' },
      body: JSON.stringify({
        account: 'demo',
        cwd,
        repo: cwd.split('/').pop(),
        mode: 'bypassPermissions',
        title: `Demo chat ${i + 1}`,
      }),
    })
    const s = await r.json()
    if (!s.id) throw new Error(`could not make a demo chat: ${JSON.stringify(s)}`)
    made.push(s)
  }
  // one turn each so every log has history
  await Promise.all(made.map((s) => turn(port, s.id, 'Tidy the webhook retry notes')))
  return made
}

/** send one message to a demo chat and answer its question, so the turn runs to the end */
async function turn(port, id, text) {
  const api = `http://127.0.0.1:${port}/api/control/agent/sessions/${id}`
  const post = (p, b) =>
    fetch(`${api}/${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-control': '1' },
      body: JSON.stringify(b),
    })
  const before = (
    await (await fetch(`http://127.0.0.1:${port}/api/control/agent/sessions`)).json()
  ).find((s) => s.id === id)
  await post('message', { text })
  const ac = new AbortController()
  const res = await fetch(`${api}/events?since=0`, { signal: ac.signal })
  const dec = new TextDecoder()
  let buf = ''
  let done = false
  const answered = new Set()
  const deadline = Date.now() + 30_000
  try {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true })
      let i
      for (i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n')
        if (!data) continue
        let e
        try {
          e = JSON.parse(data)
        } catch {
          continue
        }
        if (e.t === 'question' && !answered.has(e.requestId)) {
          answered.add(e.requestId)
          const pending = !e.resolved
          if (pending)
            await post('respond', {
              requestId: e.requestId,
              reply: { answers: { Retries: 'Exponential backoff' } },
            })
        }
        if (e.t === 'result' && e.turns > (before?.turns ?? 0)) done = true
      }
      if (done || Date.now() > deadline) break
    }
  } catch {}
  ac.abort()
}

/** keep one chat streaming for the whole window: turn after turn */
function streamLoop(port, id) {
  let on = true
  ;(async () => {
    while (on) await turn(port, id, 'Keep going on the retry notes')
  })()
  return () => {
    on = false
  }
}

// ---------------------------------------------------------------- attribution ----
/** wraps timers, frames and stream handlers to charge their time to the file:line that made them */
const ATTRIB_SCRIPT = () => {
  const cost = new Map()
  const site = () => {
    const s = new Error().stack?.split('\n').slice(3) ?? []
    const f = s.find((l) => !l.includes('__attrib') && /\/src\/|\.ts|\.js/.test(l)) ?? s[0] ?? '?'
    return f
      .replace(/^\s*at\s+/, '')
      .replace(/https?:\/\/[^/]+/, '')
      .replace(/\?[^:)]*/, '')
  }
  const charge = (kind, where, fn) =>
    function __attrib(...a) {
      const t0 = performance.now()
      try {
        return fn.apply(this, a)
      } finally {
        const k = `${kind} ${where}`
        const c = cost.get(k) ?? { n: 0, ms: 0 }
        c.n++
        c.ms += performance.now() - t0
        cost.set(k, c)
      }
    }
  const wrap = (name, kind) => {
    const orig = window[name]
    window[name] = (fn, ...rest) =>
      typeof fn === 'function'
        ? orig.call(window, charge(kind, site(), fn), ...rest)
        : orig.call(window, fn, ...rest)
  }
  wrap('setInterval', 'interval')
  wrap('setTimeout', 'timeout')
  wrap('requestAnimationFrame', 'raf')
  const add = EventTarget.prototype.addEventListener
  EventTarget.prototype.addEventListener = function (type, fn, o) {
    if (typeof fn === 'function' && (this instanceof EventSource || this instanceof WebSocket))
      fn = charge(`es:${type}`, site(), fn)
    return add.call(this, type, fn, o)
  }
  for (const p of ['onmessage']) {
    const d = Object.getOwnPropertyDescriptor(EventSource.prototype, p)
    Object.defineProperty(EventSource.prototype, p, {
      set(fn) {
        d.set.call(this, typeof fn === 'function' ? charge('es:message', site(), fn) : fn)
      },
      get() {
        return d.get.call(this)
      },
    })
  }
  window.__attrib = { cost, reset: () => cost.clear() }
}

/** CSS animations that are running now, and whether anyone can see them */
const RUNNING_ANIMS = () => {
  const vw = innerWidth
  const vh = innerHeight
  const out = new Map()
  for (const a of document.getAnimations()) {
    if (a.playState !== 'running') continue
    const t = a.effect?.target
    if (!t) continue
    const r = t.getBoundingClientRect()
    const onScreen =
      t.isConnected &&
      t.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) &&
      r.width > 0 &&
      r.right > 0 &&
      r.bottom > 0 &&
      r.left < vw &&
      r.top < vh
    const name = a.animationName ?? a.transitionProperty ?? a.constructor.name
    const who = `${t.tagName.toLowerCase()}${t.id ? `#${t.id}` : ''}${[...t.classList]
      .slice(0, 3)
      .map((c) => `.${c}`)
      .join('')}`
    const k = `${name} ${who} ${onScreen ? 'visible' : 'HIDDEN'}`
    out.set(k, (out.get(k) ?? 0) + 1)
  }
  return [...out].map(([k, n]) => ({ k, n }))
}

// ---------------------------------------------------------------------- scenarios ----
const key = (p, k) => p.keyboard.press(k)
async function normalState(page) {
  // chats docked, a few panels open, the map behind; History and Fleet opened then closed
  await page.mouse.move(1700, 700)
  await key(page, 'h')
  await sleep(1200)
  await key(page, 'h')
  await key(page, 'c')
  await sleep(400)
  await key(page, 'r')
  await sleep(400)
  await page.keyboard.down('s')
  await page.keyboard.up('s')
  await sleep(2500)
  await page.mouse.move(1500, 720)
}
const blur = (p) =>
  p.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true })
    window.dispatchEvent(new Event('blur'))
  })

const SCENARIOS = {
  idle: { name: 'Everything idle: chats docked, panels open, map behind', setup: async () => {} },
  stream: {
    name: 'One chat streaming on screen, others hidden',
    setup: async (page, ctx) => {
      ctx.stop = streamLoop(ctx.port, ctx.shown)
    },
  },
  streamhidden: {
    name: 'A chat streaming that is not on screen',
    setup: async (page, ctx) => {
      ctx.stop = streamLoop(ctx.port, ctx.hidden)
    },
  },
  away: {
    name: 'Window in the background (another app focused), one chat streaming',
    setup: async (page, ctx) => {
      await blur(page)
      ctx.stop = streamLoop(ctx.port, ctx.shown)
    },
  },
  awayidle: { name: 'Window in the background, nothing happening', setup: (page) => blur(page) },
}
const pick = (process.env.SCENARIOS ?? 'idle,stream,streamhidden,away').split(',')

const browser = await pw.chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'],
})
const bcdp = await browser.newBrowserCDPSession()
const cpuByType = async () => {
  const { processInfo } = await bcdp.send('SystemInfo.getProcessInfo')
  const out = { pids: processInfo.map((p) => p.id) }
  for (const p of processInfo)
    out[p.type.toLowerCase()] = (out[p.type.toLowerCase()] ?? 0) + p.cpuTime
  return out
}
const APP = ['renderer', 'gpu', 'browser', 'utility']
const appCpu = (c) => APP.reduce((n, k) => n + (c[k] ?? 0), 0)
/** resident memory of the browser's processes, MB (what Activity Monitor would add up) */
const rssMB = (pids) => {
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' })
    return Math.round(out.split('\n').reduce((n, l) => n + (Number(l.trim()) || 0), 0) / 1024)
  } catch {
    return null
  }
}

async function run(port, sc) {
  const chats = await demoChats(port)
  const ctx = await browser.newContext({
    viewport: { width: 3440, height: 1440 },
    deviceScaleFactor: 1,
  })
  const page = await ctx.newPage()
  if (ATTRIB) await page.addInitScript(ATTRIB_SCRIPT)
  await page.addInitScript(() => {
    window.__frames = 0
    for (const C of [WebGL2RenderingContext, WebGLRenderingContext]) {
      const clear = C.prototype.clear
      C.prototype.clear = function (...a) {
        window.__frames++
        return clear.apply(this, a)
      }
    }
  })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  const reqs = new Map()
  let counting = false
  page.on('request', (r) => {
    if (!counting) return
    const u = new URL(r.url())
    const k = `${r.method()} ${u.pathname.replace(/[0-9a-f-]{20,}/g, ':id')}`
    reqs.set(k, (reqs.get(k) ?? 0) + 1)
  })
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await page.waitForSelector('#stage canvas', { timeout: 30000 })
  await sleep(5000)
  await normalState(page)
  if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}-${port}-${sc}.png` })
  // which chat is on screen, and one that isn't
  const shownTitle = await page.evaluate(
    () =>
      document
        .querySelector('#ss .ws-chat.on, #ss .ws-chat[aria-selected="true"]')
        ?.textContent?.trim() ?? '',
  )
  const s = { port, shown: chats[0].id, hidden: chats[chats.length - 1].id, shownTitle }
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Performance.enable')
  await SCENARIOS[sc].setup(page, s)
  await sleep(SETTLE * 1000)
  if (ATTRIB) await page.evaluate(() => window.__attrib.reset())
  const m0 = Object.fromEntries(
    (await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]),
  )
  const f0 = await page.evaluate(() => window.__frames)
  const c0 = await cpuByType()
  counting = true
  const t0 = performance.now()
  // app CPU each second, for the average and the p95; animations and memory sampled mid-window
  const perSecond = []
  // SERIES=1: what each second spent (main thread split, and with ATTRIB=1 the sources that ran)
  const series = []
  let mPrev = m0
  let prev = c0
  let prevT = t0
  let anims = []
  let mem = null
  for (let i = 0; i < WINDOW; i++) {
    await sleep(1000 - ((performance.now() - t0) % 1000))
    const c = await cpuByType()
    const t = performance.now()
    perSecond.push(((appCpu(c) - appCpu(prev)) / ((t - prevT) / 1000)) * 100)
    if (process.env.SERIES === '1') {
      const m = Object.fromEntries(
        (await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]),
      )
      const d = (k) => Math.round(((m[k] ?? 0) - (mPrev[k] ?? 0)) * 1000)
      const top = ATTRIB
        ? await page.evaluate(() => {
            const out = [...window.__attrib.cost]
              .map(([k, v]) => ({ k, n: v.n, ms: Math.round(v.ms) }))
              .sort((a, b) => b.ms - a.ms)
              .slice(0, 4)
            window.__attrib.reset()
            return out
          })
        : null
      series.push({
        s: i,
        app: Math.round(perSecond[perSecond.length - 1]),
        task: d('TaskDuration'),
        script: d('ScriptDuration'),
        style: d('RecalcStyleDuration'),
        layout: d('LayoutDuration'),
        nodes: m.Nodes,
        top,
      })
      mPrev = m
    }
    prev = c
    prevT = t
    if (i === Math.floor(WINDOW / 2)) {
      anims = await page.evaluate(RUNNING_ANIMS)
      mem = rssMB(c.pids)
    }
  }
  const secs = (performance.now() - t0) / 1000
  const sorted = [...perSecond].sort((a, b) => a - b)
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  counting = false
  const c1 = await cpuByType()
  const f1 = await page.evaluate(() => window.__frames)
  const m1 = Object.fromEntries(
    (await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]),
  )
  const attrib = ATTRIB
    ? await page.evaluate(() =>
        [...window.__attrib.cost]
          .map(([k, v]) => ({ k, n: v.n, ms: Math.round(v.ms) }))
          .sort((a, b) => b.ms - a.ms)
          .slice(0, 40),
      )
    : null
  s.stop?.()
  await ctx.close()
  const pct = (k) => (((c1[k] ?? 0) - (c0[k] ?? 0)) / secs) * 100
  const ms = (k) => Math.round((((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000) / secs) // ms per second
  const per = (k) => Math.round((((m1[k] ?? 0) - (m0[k] ?? 0)) / secs) * 10) / 10
  return {
    app: pct('renderer') + pct('gpu') + pct('browser') + pct('utility'),
    appP95: p95,
    memMB: mem,
    renderer: pct('renderer'),
    gpu: pct('gpu'),
    browser: pct('browser'),
    framesPerSec: (f1 - f0) / secs,
    mainMsPerSec: {
      task: ms('TaskDuration'),
      script: ms('ScriptDuration'),
      style: ms('RecalcStyleDuration'),
      layout: ms('LayoutDuration'),
    },
    perSec: { styles: per('RecalcStyleCount'), layouts: per('LayoutCount') },
    heapMB: Math.round((m1.JSHeapUsedSize ?? 0) / 1e6),
    nodes: m1.Nodes,
    requests: [...reqs].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n),
    anims,
    attrib,
    errors,
    series,
    secs,
  }
}

const doc = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { runs: [] }
doc.scenarios = Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, v.name]))
const plan = []
for (const sc of pick) for (const [label, port] of BUILDS) plan.push([label, port, sc])
for (const [i, [label, port, sc]] of plan.entries()) {
  progress(
    'lane',
    RUN,
    LANE,
    '--done',
    String(i),
    '--total',
    String(plan.length),
    '--note',
    `${SCENARIOS[sc].name} · ${label}`,
  )
  const r = await run(Number(port), sc)
  const rec = { label, scenario: sc, attrib: ATTRIB, at: Date.now(), load: os.loadavg()[0], ...r }
  doc.runs = doc.runs.filter(
    (x) => !(x.label === label && x.scenario === sc && x.attrib === ATTRIB),
  )
  doc.runs.push(rec)
  writeFileSync(OUT, JSON.stringify(doc, null, 2))
  console.log(
    JSON.stringify({
      label,
      sc,
      app: rec.app.toFixed(1),
      p95: rec.appP95.toFixed(1),
      memMB: rec.memMB,
      renderer: rec.renderer.toFixed(1),
      gpu: rec.gpu.toFixed(1),
      fps: rec.framesPerSec.toFixed(1),
      main: rec.mainMsPerSec,
      errors: rec.errors.length,
      load: rec.load.toFixed(1),
    }),
  )
}
await browser.close()
