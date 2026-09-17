/**
 * On-canvas telemetry.
 *
 * The headline number is the instantaneous framerate, but a single number says
 * nothing about whether the frame budget is actually being held while the camera
 * moves. So the panel is built around a PER-FRAME frame-time record: every frame
 * pushes its own dt into a ring buffer covering the last ~2000 frames (~15 s of
 * camera motion at 130 fps). The chart aggregates that buffer into columns, each
 * drawn as a min..max envelope with a median line through it, so frame-to-frame
 * variance is visible rather than smoothed away by a 2 Hz sampler. The numeric
 * row under the chart reports min / p50 / max and the 1% low over the same window.
 */
export type HudData = {
  fps: number
  ms: number
  nodes: number
  links: number
  draws: number
  iters: number
}

const CAP = 4096 // frames retained (~15 s of motion)
const COLS = 170 // aggregation columns across the chart
const STEPS = [60, 90, 120, 150, 200, 250, 300, 360, 450, 600, 800, 1000]

export function makeHUD() {
  const el = document.createElement('div')
  el.className = 'hud'
  el.innerHTML = `
    <div class="hud-top">
      <span class="hud-dot"></span>
      <span class="hud-tag">telemetry</span>
      <span class="hud-range" id="h-range">
        <button data-win="600">10s</button><button data-win="1800" class="on">30s</button><button data-win="4096">all</button>
      </span>
      <button class="hud-min" id="h-min-btn" title="collapse">&minus;</button>
    </div>
    <div class="hud-fps"><b id="h-fps">--</b><span>FPS<em>live</em></span><i id="h-ms">--</i></div>
    <div class="hud-chart">
      <canvas id="h-spark" width="272" height="96"></canvas>
      <span class="hud-axis hud-axis-t" id="h-top">--</span>
      <span class="hud-axis hud-axis-b">0</span>
      <span class="hud-win" id="h-win">per-frame &middot; sampling</span>
    </div>
    <div class="hud-stat">
      <div><em>min 10f</em><b id="h-min">--</b></div>
      <div><em>p50</em><b id="h-p50">--</b></div>
      <div><em>max 10f</em><b id="h-max">--</b></div>
      <div><em>1% low</em><b id="h-low">--</b></div>
    </div>
    <div class="hud-key">
      <span><i class="k-med"></i>median</span>
      <span><i class="k-env"></i>p10&ndash;p90</span>
      <span><i class="k-dip"></i>slowest</span>
    </div>
    <div class="hud-rows">
      <div><span>points</span><b id="h-n">--</b></div>
      <div><span>links</span><b id="h-l">--</b></div>
      <div><span>draw calls</span><b id="h-d">--</b></div>
      <div><span>sim steps</span><b id="h-i">--</b></div>
    </div>`
  document.body.appendChild(el)

  const q = (id: string) => el.querySelector('#' + id) as HTMLElement
  const fpsEl = q('h-fps'),
    msEl = q('h-ms'),
    nEl = q('h-n'),
    lEl = q('h-l'),
    dEl = q('h-d'),
    iEl = q('h-i')
  const minEl = q('h-min'),
    p50El = q('h-p50'),
    maxEl = q('h-max'),
    lowEl = q('h-low')
  const winEl = q('h-win'),
    topEl = q('h-top')
  let win = 1800 // frames charted; the range toggle narrows this
  const cv = q('h-spark') as HTMLCanvasElement
  const CW = 272,
    CH = 96
  const ctx = cv.getContext('2d')!
  const dpr = Math.min(devicePixelRatio, 2)
  cv.width = CW * dpr
  cv.height = CH * dpr
  cv.style.width = CW + 'px'
  cv.style.height = CH + 'px'

  // per-frame ring buffers: instantaneous fps, and the frame's own delta so the
  // chart can state how much wall-clock time the window actually covers
  const ring = new Float32Array(CAP)
  const dts = new Float32Array(CAP)
  let head = 0,
    count = 0,
    axisTop = 120

  const loader = document.createElement('div')
  loader.className = 'boot'
  loader.innerHTML = `<div class="boot-bar"><i></i></div><div class="boot-txt">building layout</div>`
  document.body.appendChild(loader)
  const bar = loader.querySelector('i') as HTMLElement
  const btxt = loader.querySelector('.boot-txt') as HTMLElement

  const yOf = (v: number | undefined, h: number) =>
    h - (Math.min(axisTop, Math.max(0, v ?? 0)) / axisTop) * h

  function draw() {
    const w = cv.width,
      h = cv.height
    ctx.clearRect(0, 0, w, h)
    if (count < 8) return

    // ordered view of the ring, oldest -> newest, limited to the chosen window
    const n = Math.min(count, win)
    const at = (i: number) => ring[(head - n + i + CAP) % CAP] ?? 0

    // --- aggregate into columns: min..max envelope + median line ----------
    const cols = Math.min(COLS, n)
    const per = n / cols
    const step = w / (cols - 1)
    const med = new Float64Array(cols),
      lo = new Float64Array(cols),
      hi = new Float64Array(cols)
    const dip = new Float64Array(cols)
    const bucket: number[] = []
    for (let c = 0; c < cols; c++) {
      const a = Math.floor(c * per),
        b = Math.max(a + 1, Math.floor((c + 1) * per))
      bucket.length = 0
      for (let i = a; i < b && i < n; i++) bucket.push(at(i))
      bucket.sort((x, y2) => x - y2)
      const m = bucket.length
      if (!m) continue
      dip[c] = bucket[0] ?? 0
      lo[c] = bucket[Math.floor(m * 0.1)] ?? 0
      hi[c] = bucket[Math.min(m - 1, Math.floor(m * 0.9))] ?? 0
      med[c] = bucket[m >> 1] ?? 0
    }

    // --- grid: 0-based axis so the 60 fps floor stays meaningful ----------
    ctx.lineWidth = dpr
    const half = axisTop / 2
    const yHalf = Math.round(yOf(half, h)) + 0.5
    ctx.strokeStyle = 'rgba(140,175,235,0.13)'
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(0, yHalf)
    ctx.lineTo(w, yHalf)
    ctx.stroke()
    ctx.font = `${7.5 * dpr}px ui-monospace,Menlo,monospace`

    const y60 = Math.round(yOf(60, h)) + 0.5
    ctx.strokeStyle = 'rgba(255,150,90,0.6)'
    ctx.setLineDash([3 * dpr, 4 * dpr])
    ctx.beginPath()
    ctx.moveTo(0, y60)
    ctx.lineTo(w, y60)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(255,164,110,0.92)'
    const lbl = '60 fps floor'
    ctx.shadowColor = 'rgba(6,9,18,0.95)'
    ctx.shadowBlur = 3 * dpr
    ctx.fillText(lbl, w - ctx.measureText(lbl).width - 3 * dpr, y60 - 3 * dpr)
    ctx.shadowBlur = 0

    // --- per-column p10..p90 envelope (real frame-to-frame spread) --------
    ctx.beginPath()
    for (let c = 0; c < cols; c++) ctx.lineTo(c * step, yOf(hi[c], h))
    for (let c = cols - 1; c >= 0; c--) ctx.lineTo(c * step, yOf(lo[c], h))
    ctx.closePath()
    ctx.fillStyle = 'rgba(120,214,255,0.26)'
    ctx.fill()

    // slowest frame in each column, so downward spikes are not averaged away
    ctx.beginPath()
    for (let c = 0; c < cols; c++) ctx.lineTo(c * step, yOf(dip[c], h))
    ctx.strokeStyle = 'rgba(126,196,255,0.42)'
    ctx.lineWidth = 0.9 * dpr
    ctx.stroke()

    // fill under the median so the trace still reads as one solid shape
    const g = ctx.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, 'rgba(120,214,255,0.20)')
    g.addColorStop(1, 'rgba(120,214,255,0.0)')
    ctx.beginPath()
    for (let c = 0; c < cols; c++) ctx.lineTo(c * step, yOf(med[c], h))
    ctx.lineTo(w, h)
    ctx.lineTo(0, h)
    ctx.closePath()
    ctx.fillStyle = g
    ctx.fill()

    // median polyline
    ctx.beginPath()
    for (let c = 0; c < cols; c++) ctx.lineTo(c * step, yOf(med[c], h))
    ctx.strokeStyle = 'rgba(168,236,255,0.98)'
    ctx.lineWidth = 1.25 * dpr
    ctx.lineJoin = 'round'
    ctx.stroke()

    // newest-sample tick
    ctx.fillStyle = 'rgba(210,246,255,1)'
    ctx.beginPath()
    ctx.arc(w - 1.6 * dpr, yOf(med[cols - 1], h), 1.9 * dpr, 0, 7)
    ctx.fill()
  }

  // range toggle + collapse
  el.querySelector('#h-range')?.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button')
    if (!b) return
    win = Number(b.dataset.win ?? 1800)
    for (const o of el.querySelectorAll('#h-range button')) o.classList.toggle('on', o === b)
  })
  el.querySelector('#h-min-btn')?.addEventListener('click', () => {
    el.classList.toggle('collapsed')
  })
  el.querySelector('.hud-fps')?.addEventListener('click', () => {
    if (el.classList.contains('collapsed')) el.classList.remove('collapsed')
  })

  const WIN = 10 // frames per sustained-rate window

  function stats() {
    const n = Math.min(count, win)
    const raw = new Float64Array(n)
    const dt = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const k = (head - n + i + CAP) % CAP
      raw[i] = ring[k] ?? 0
      dt[i] = dts[k] ?? 0
    }
    let span = 0
    for (let i = 0; i < n; i++) span += dt[i] ?? 0

    // Sustained rate: framerate over every WIN-frame window. A single coalesced
    // rAF callback or one compositor stall cannot move it, so min/max describe
    // frame-rate behaviour rather than one-frame scheduling noise. The chart
    // below still plots every individual frame, dips included.
    const m = Math.max(1, n - WIN + 1)
    const sus = new Float64Array(m)
    let sum = 0
    for (let i = 0; i < Math.min(WIN, n); i++) sum += dt[i] ?? 0
    sus[0] = (WIN * 1000) / sum
    for (let i = 1; i < m; i++) {
      sum += (dt[i + WIN - 1] ?? 0) - (dt[i - 1] ?? 0)
      sus[i] = (WIN * 1000) / sum
    }

    const sr = Float64Array.from(raw).sort()
    const ss = Float64Array.from(sus).sort()
    return {
      min: ss[0] ?? 0,
      p50: ss[m >> 1] ?? 0,
      max: ss[m - 1] ?? 0,
      p99: ss[Math.min(m - 1, Math.floor(m * 0.99))] ?? 0,
      low1: sr[Math.floor(n * 0.01)] ?? 0,
      span: span / 1000,
    }
  }

  return {
    boot(p: number, txt: string) {
      bar.style.width = (p * 100).toFixed(1) + '%'
      btxt.textContent = txt
    },
    bootDone() {
      loader.classList.add('gone')
      setTimeout(() => loader.remove(), 900)
    },
    /** called once per rendered frame with that frame's delta in ms */
    sample(dt: number) {
      // rAF callbacks occasionally coalesce and report sub-millisecond deltas that
      // never correspond to a presented frame; those are not framerate data.
      if (!(dt >= 1.0) || dt > 500) return
      ring[head] = 1000 / dt
      dts[head] = dt
      head = (head + 1) % CAP
      if (count < CAP) count++
    },
    update(d: HudData) {
      fpsEl.textContent = String(d.fps)
      msEl.textContent = d.ms.toFixed(1) + ' ms'
      nEl.textContent = d.nodes.toLocaleString()
      lEl.textContent = d.links.toLocaleString()
      dEl.textContent = String(d.draws)
      iEl.textContent = String(d.iters)
      if (count > 8) {
        const s = stats()
        minEl.textContent = String(Math.round(s.min))
        p50El.textContent = String(Math.round(s.p50))
        maxEl.textContent = String(Math.round(s.max))
        lowEl.textContent = String(Math.round(s.low1))
        minEl.classList.toggle('bad', s.min < 60)
        lowEl.classList.toggle('bad', s.low1 < 60)
        // axis ceiling tracks p99, so one outlier frame cannot flatten the trace
        const want = Math.max(s.p99 * 1.12, s.p50 * 1.45, 120)
        axisTop = STEPS.find((v) => v >= want) ?? 1200
        topEl.textContent = String(axisTop)
        winEl.textContent =
          'per-frame \u00b7 ' +
          count.toLocaleString() +
          ' frames \u00b7 ' +
          s.span.toFixed(1) +
          's moving'
      }
      draw()
    },
  }
}
