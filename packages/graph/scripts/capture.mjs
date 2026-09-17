/**
 * Gauntlet capture harness. Produces the artifacts critics judge.
 * Usage: node scripts/capture.mjs <outDir> [label]
 * Emits: <out>/still-rest.png  still-mid.png  still-close.png  fps.json  stats.json
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const out = process.argv[2] || './.capture'
const label = process.argv[3] || 'run'
const PORT = process.env.CAPTURE_PORT || '4173'   // per-piece, so concurrent runs don't collide
mkdirSync(out, { recursive: true })

const srv = spawn('npx', ['vite', 'preview', '--port', PORT, '--strictPort'], { stdio: 'ignore', detached: false })
const stop = () => { try { srv.kill('SIGKILL') } catch {} }
process.on('exit', stop)

try {
  await sleep(3500)
  const b = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--disable-frame-rate-limit'] })
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
  const errors = []
  p.on('pageerror', e => errors.push(String(e).slice(0, 300)))
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)) })

  await p.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 90000 })
  await p.waitForFunction('window.__BRAIN_READY === true', null, { timeout: 120000 })

  // --- fps over a scripted path: free-run, sample the app's own counter ---
  await p.evaluate(() => window.__brainAuto?.(true))
  await sleep(2000) // settle / JIT warm
  const samples = []
  for (let i = 0; i < 24; i++) { samples.push(await p.evaluate(() => window.__brainStats().fps)); await sleep(500) }
  samples.sort((a, b) => a - b)
  const pct = q => samples[Math.floor(samples.length * q)]
  const fps = { label, min: samples[0], p05: pct(0.05), p50: pct(0.5), max: samples.at(-1), samples }

  // --- deterministic stills: same camera positions every round, so rounds are comparable ---
  // Stop the render loop so the page can reach stability for screenshots.
  await p.evaluate(() => { window.__brainAuto?.(false); window.__brainPause?.() })
  for (const [t, name] of [[0.00, 'still-rest'], [0.33, 'still-mid'], [0.62, 'still-close']]) {
    await p.evaluate(tt => window.__brainCamera(tt), t)
    await sleep(400)
    await p.screenshot({ path: `${out}/${name}.png`, animations: 'disabled', timeout: 60000 })
  }

  // --- P1 artifact: still with an fps/scale HUD burned in, so it is directly
  // --- comparable to the cosmos.gl bar shot, which carries its own fps counter.
  await p.evaluate(({ f, st }) => {
    const d = document.createElement('div')
    d.style.cssText = 'position:fixed;top:14px;right:16px;z-index:99999;font:600 15px ui-monospace,Menlo,monospace;color:#eaf0ff;background:rgba(10,12,22,.82);border:1px solid rgba(150,175,255,.35);border-radius:9px;padding:9px 13px;line-height:1.5;text-align:right'
    d.innerHTML = `${f.p50} FPS<br><span style="opacity:.72;font-weight:400">${st.nodes.toLocaleString()} points · ${st.links.toLocaleString()} links</span>`
    document.body.appendChild(d)
  }, { f: fps, st: await p.evaluate(() => window.__brainStats()) })
  await p.evaluate(t => window.__brainCamera(t), 0.33)
  await sleep(400)
  await p.screenshot({ path: `${out}/scale-hud.png`, animations: 'disabled', timeout: 60000 })

  // --- P3 artifact: interaction states. Generic canvas-level hover + click so
  // --- the identical script also runs against the bar page.
  await p.evaluate(() => { document.querySelectorAll('div[style*="99999"]').forEach(e => e.remove()); window.__brainResume?.() })
  await p.evaluate(() => window.__brainAuto?.(false))
  const cx = 800, cy = 500
  await p.mouse.move(cx, cy); await sleep(900)
  await p.evaluate(() => window.__brainPause?.())
  await p.screenshot({ path: `${out}/feel-hover.png`, animations: 'disabled', timeout: 60000 })
  await p.evaluate(() => window.__brainResume?.())
  await p.mouse.click(cx, cy); await sleep(1400)
  await p.evaluate(() => window.__brainPause?.())
  await p.screenshot({ path: `${out}/feel-select.png`, animations: 'disabled', timeout: 60000 })

  const stats = await p.evaluate(() => window.__brainStats())
  // --- HARD INTEGRITY PROBE -------------------------------------------------
  // Data honesty is enforced here, not by a critic. A builder cannot produce a
  // valid artifact from decimated or faked data: this exits non-zero and says so.
  const viol = []
  if (stats.nodes !== 60000) viol.push(`nodes=${stats.nodes}, expected 60000`)
  if (stats.links !== 65079) viol.push(`links=${stats.links}, expected 65079`)
  if (errors.length)          viol.push(`${errors.length} console error(s): ${errors[0]}`)
  if (fps.p50 < 60)           viol.push(`fps p50=${fps.p50}, must be >= 60`)
  writeFileSync(`${out}/integrity.json`, JSON.stringify({ ok: !viol.length, violations: viol }, null, 2))

  writeFileSync(`${out}/fps.json`, JSON.stringify(fps, null, 2))
  writeFileSync(`${out}/stats.json`, JSON.stringify({ ...stats, errors, label }, null, 2))
  console.log(`[${label}] fps p50=${fps.p50} min=${fps.min} | nodes=${stats.nodes} links=${stats.links} draws=${stats.drawCalls} | errors=${errors.length}`)
  if (errors.length) console.log('  ERR:', errors.slice(0, 3).join(' | '))
  await b.close()
  if (viol.length) {
    console.error('\n*** INTEGRITY FAILURE — this artifact is INVALID and must not be submitted ***')
    viol.forEach(v => console.error('  - ' + v))
    console.error('Fix the renderer and re-run capture. Do not hand this artifact to a judge.\n')
    process.exitCode = 1
  }
} finally { stop() }
