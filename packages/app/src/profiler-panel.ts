/**
 * The profiler, as a panel: live CPU and memory for every process in Orbit's tree, 60-second
 * benchmarks against a baseline, the before/after results of the map A/B, and the findings list.
 *
 * The numbers come from the /profiler skill's sampler (~/.claude/skills/profiler/server.mjs),
 * which watches the app from outside with `ps` and must keep doing so — a profiler inside the
 * thing it profiles measures itself. The server passes it through at /api/profiler/* (see
 * profiler-api.mjs), so this is the page that used to be at :5491, moved into Orbit; the skill's
 * `bench` and `findings` commands still land here, because they write to the same sampler.
 *
 * It only streams while it is on screen: the event stream is a long-lived connection, and the
 * window has six to share with the chats.
 */
import './profiler-panel.css'
import { registerPanel } from './panels.ts'

type Proc = { pid: number; ppid: number; group: string; label: string; cpu: number; rss: number }
type Sample = {
  t: number
  load: number
  cores: number
  running: boolean
  latency: { ms: number | null; status?: number; error?: string } | null
  procs: Proc[]
}
type BenchRun = {
  id: string
  label: string
  at: number
  secs: number
  baseline: boolean
  [k: string]: unknown
}
type BenchState = {
  active: { id: string; label: string; secs: number; startedAt: number; n: number } | null
  runs: BenchRun[]
}
type AB = {
  scenarios?: Record<string, string>
  runs?: {
    scenario: string
    label: string
    renderer: number
    gpu: number
    framesPerSec: number
    drawsPerSec: number
    load: number
  }[]
}

const API = '/api/profiler'
const WINDOWS = [60, 300, 600] as const
const KEEP = 600

const GROUPS: [string, string, string][] = [
  ['renderer', 'Renderers', 'var(--pf-1)'],
  ['gpu', 'GPU process', 'var(--pf-2)'],
  ['main', 'Electron main', 'var(--pf-3)'],
  ['server', 'App server', 'var(--pf-4)'],
  ['agents', 'Chats and their tools', 'var(--pf-5)'],
  ['other', 'Utilities', 'var(--pf-6)'],
]
const COLOUR = Object.fromEntries(GROUPS.map(([g, , c]) => [g, c]))

/** the benchmark columns: key, format, and whether a change against the baseline is scored */
const COLS: [string, string, (v: number) => string, boolean][] = [
  ['appCpu', 'App CPU', (v) => `${v.toFixed(0)}%`, true],
  ['appCpuP95', 'p95', (v) => `${v.toFixed(0)}%`, true],
  ['window', 'Window', (v) => `${v.toFixed(0)}%`, true],
  ['gpu', 'GPU', (v) => `${v.toFixed(0)}%`, true],
  ['memGB', 'Memory', (v) => `${v.toFixed(2)} GB`, true],
  ['latP95', 'Server p95', (v) => `${v.toFixed(0)} ms`, true],
  ['load', 'Load', (v) => v.toFixed(1), false],
]

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[<>&"']/g,
    (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[m] as string,
  )
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
const mb = (b: number) =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${Math.round(b / 1024 ** 2)} MB`
const pct = (v: number, axis = false) => `${axis ? Math.round(v) : v.toFixed(v < 10 ? 1 : 0)}%`
function niceMax(v: number) {
  const m = 10 ** Math.floor(Math.log10(v || 1))
  const step = v / m > 5 ? 2 : 1
  return Math.ceil(v / m / step) * m * step
}

const ICON =
  '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 11h3l2-5.4 3.4 9.4 2.2-6 1.2 2h3"/></svg>'

function mountProfiler(host: HTMLElement) {
  host.classList.add('pf')
  host.innerHTML = `
    <div class="pf-top">
      <span class="pf-live"><i class="pf-dot off" data-el="dot"></i><span data-el="status">not connected</span></span>
      <span class="pf-seg" role="group" aria-label="Window">${WINDOWS.map((s) => `<button type="button" data-win="${s}"${s === 60 ? ' class="on"' : ''}>${s / 60} min</button>`).join('')}</span>
    </div>
    <div class="pf-down" data-el="down" hidden></div>
    <div class="pf-tiles">
      <div class="pf-tile"><span>App CPU</span><b data-el="t-cpu">–</b><i data-el="t-cpu-n"></i></div>
      <div class="pf-tile"><span>Window renderer</span><b data-el="t-ren">–</b><i data-el="t-ren-n"></i></div>
      <div class="pf-tile"><span>Memory</span><b data-el="t-mem">–</b><i data-el="t-mem-n"></i></div>
      <div class="pf-tile"><span>Server response</span><b data-el="t-lat">–</b><i data-el="t-lat-n"></i></div>
      <div class="pf-tile"><span>System load</span><b data-el="t-load">–</b><i data-el="t-load-n"></i></div>
    </div>
    <section class="pf-card"><h3>CPU by component <em>stacked, % of one core</em></h3>
      <div class="pf-legend">${GROUPS.map(([, l, c]) => `<span style="--c:${c}">${l}</span>`).join('')}</div>
      <svg data-el="s-cpu" viewBox="0 0 600 200" preserveAspectRatio="none"></svg><div class="pf-tip"></div></section>
    <section class="pf-card"><h3>Memory by component <em>stacked, resident</em></h3>
      <svg data-el="s-mem" viewBox="0 0 600 200" preserveAspectRatio="none"></svg><div class="pf-tip"></div></section>
    <section class="pf-card"><h3>Benchmarks <em>same state both times · 60 s or longer · green is better</em></h3>
      <div class="pf-bench-bar">
        <input data-el="b-label" placeholder="Label, e.g. map view · before fix" aria-label="Benchmark label" />
        <select data-el="b-secs" aria-label="Length"><option value="30">30 s</option><option value="60" selected>60 s</option><option value="120">2 min</option><option value="300">5 min</option></select>
        <button type="button" class="pf-btn" data-el="b-start">Record</button>
        <button type="button" class="pf-btn ghost" data-el="b-stop" hidden>Cancel</button>
      </div>
      <div class="pf-prog" data-el="b-prog" hidden><i></i><span data-el="b-status"></span></div>
      <div class="pf-scroll"><table class="pf-t"><thead><tr><th>Run</th>${COLS.map(([, h]) => `<th class="r">${h}</th>`).join('')}<th></th></tr></thead><tbody data-el="b-rows"></tbody></table></div>
    </section>
    <section class="pf-card"><h3>What the profile shows <em data-el="f-when"></em></h3><div class="pf-findings" data-el="findings"><p class="pf-none">No findings written yet. <code>profiler findings --item "…"</code> puts them here.</p></div></section>
    <section class="pf-card" data-el="ab" hidden><h3>3D map: before / after <em>renderer + GPU CPU, isolated copies</em></h3><div data-el="ab-grid"></div></section>
    <section class="pf-card"><h3>Processes <em>now, average and peak over the window</em></h3>
      <div class="pf-scroll"><table class="pf-t"><thead><tr><th>Process</th><th class="r">Now</th><th class="r">Avg</th><th class="r">Peak</th><th class="r">Memory</th></tr></thead><tbody data-el="rows"></tbody></table></div>
    </section>`
  const $ = <T extends HTMLElement = HTMLElement>(k: string) =>
    host.querySelector(`[data-el="${k}"]`) as T

  let data: Sample[] = []
  let win = 60
  let es: EventSource | null = null
  let slow: ReturnType<typeof setInterval> | null = null
  let benchTimer: ReturnType<typeof setInterval> | null = null
  let drawQueued = false

  const byGroup = (s: Sample, key: 'cpu' | 'rss') =>
    Object.fromEntries(
      GROUPS.map(([g]) => [g, sum(s.procs.filter((p) => p.group === g).map((p) => p[key]))]),
    )

  function chart(
    svg: SVGSVGElement,
    key: 'cpu' | 'rss',
    fmt: (v: number, axis?: boolean) => string,
  ) {
    const W = 600
    const H = 200
    const L = 44
    const R = 8
    const T = 6
    const B = 20
    const pts = data.filter((s) => s.t >= Date.now() - win * 1000)
    if (!pts.length) {
      svg.innerHTML = ''
      return
    }
    const stacks = pts.map((s) => byGroup(s, key))
    const tot = stacks.map((g) => sum(Object.values(g)))
    const max = niceMax(Math.max(...tot) * 1.05)
    const t1 = Date.now()
    const t0 = t1 - win * 1000
    const x = (t: number) => L + ((t - t0) / (t1 - t0)) * (W - L - R)
    const y = (v: number) => H - B - (v / max) * (H - T - B)
    let out = ''
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i
      out += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="pf-grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v, true)}</text>`
    }
    for (let s = 0; s <= win; s += win / 5)
      out += `<text x="${x(t1 - s * 1000)}" y="${H - 4}" text-anchor="middle">${s ? `-${s >= 60 ? `${s / 60}m` : `${s}s`}` : 'now'}</text>`
    const base = pts.map(() => 0)
    for (const [g, , c] of GROUPS) {
      const top = base.map((b, i) => b + (stacks[i]?.[g] ?? 0))
      const up = pts.map((s, i) => `${x(s.t).toFixed(1)},${y(top[i] ?? 0).toFixed(1)}`)
      const down = pts.map((s, i) => `${x(s.t).toFixed(1)},${y(base[i] ?? 0).toFixed(1)}`).reverse()
      out += `<polygon points="${up.join(' ')} ${down.join(' ')}" fill="${c}" fill-opacity=".85"/>`
      top.forEach((v, i) => {
        base[i] = v
      })
    }
    out += `<line class="pf-xh" y1="${T}" y2="${H - B}" visibility="hidden"/><rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" class="pf-hit"/>`
    svg.innerHTML = out
    const card = svg.parentElement as HTMLElement
    const tip = card.querySelector('.pf-tip') as HTMLElement
    const xh = svg.querySelector('.pf-xh') as SVGLineElement
    const hit = svg.querySelector('.pf-hit') as SVGRectElement
    hit.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect()
      const sx = ((e.clientX - r.left) / r.width) * W
      const t = t0 + ((sx - L) / (W - L - R)) * (t1 - t0)
      let i = 0
      for (let j = 0; j < pts.length; j++)
        if (Math.abs((pts[j]?.t ?? 0) - t) < Math.abs((pts[i]?.t ?? 0) - t)) i = j
      const px = x(pts[i]?.t ?? 0)
      xh.setAttribute('x1', String(px))
      xh.setAttribute('x2', String(px))
      xh.setAttribute('visibility', 'visible')
      tip.style.display = 'block'
      tip.innerHTML =
        `<div class="pf-tip-h">${new Date(pts[i]?.t ?? 0).toLocaleTimeString()} · total <b>${fmt(tot[i] ?? 0)}</b></div>` +
        [...GROUPS]
          .reverse()
          .map(
            ([g, l, c]) =>
              `<div class="pf-tip-r"><i style="background:${c}"></i>${l}<b>${fmt(stacks[i]?.[g] ?? 0)}</b></div>`,
          )
          .join('')
      const cr = card.getBoundingClientRect()
      const cx = e.clientX - cr.left
      tip.style.left = `${cx > cr.width / 2 ? cx - tip.offsetWidth - 14 : cx + 14}px`
      tip.style.top = `${e.clientY - cr.top + 10}px`
    })
    hit.addEventListener('mouseleave', () => {
      tip.style.display = 'none'
      xh.setAttribute('visibility', 'hidden')
    })
  }

  function render() {
    drawQueued = false
    const s = data.at(-1)
    if (!s) return
    const pts = data.filter((p) => p.t >= Date.now() - win * 1000)
    chart($<SVGSVGElement & HTMLElement>('s-cpu'), 'cpu', pct)
    chart($<SVGSVGElement & HTMLElement>('s-mem'), 'rss', (v) => mb(v))
    const totals = pts.map((p) => sum(p.procs.map((q) => q.cpu)))
    const nowCpu = sum(s.procs.map((p) => p.cpu))
    $('t-cpu').textContent = s.running ? pct(nowCpu) : 'not running'
    $('t-cpu-n').textContent = totals.length
      ? `avg ${Math.round(sum(totals) / totals.length)}% · ${(nowCpu / 100).toFixed(1)} of ${s.cores} cores`
      : ''
    const ren = s.procs.find((p) => p.label.startsWith('Renderer · app window'))
    const renAvg = pts.map((p) => p.procs.find((q) => ren && q.pid === ren.pid)?.cpu ?? 0)
    $('t-ren').textContent = ren ? pct(ren.cpu) : '–'
    $('t-ren-n').textContent = ren
      ? `avg ${(sum(renAvg) / renAvg.length).toFixed(0)}% · ${mb(ren.rss)}`
      : ''
    $('t-mem').textContent = mb(sum(s.procs.map((p) => p.rss)))
    $('t-mem-n').textContent = `${s.procs.length} processes`
    const lats = pts
      .map((p) => p.latency?.ms)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b)
    const lat = $('t-lat')
    lat.textContent = s.latency?.ms != null ? `${s.latency.ms.toFixed(0)} ms` : 'down'
    lat.classList.toggle('bad', s.latency?.ms == null)
    $('t-lat-n').textContent = lats.length
      ? `p50 ${(lats[lats.length >> 1] ?? 0).toFixed(0)} · p95 ${(lats[Math.floor(lats.length * 0.95)] ?? 0).toFixed(0)} ms`
      : ''
    $('t-load').textContent = s.load.toFixed(1)
    $('t-load-n').textContent = `${s.cores} cores · ${s.load > s.cores ? 'saturated' : 'headroom'}`
    // this Mac often runs Unity flat out; a benchmark at load 15 does not compare with one at 7
    $('t-load').classList.toggle('bad', s.load > s.cores)

    const stats = new Map<number, { sum: number; n: number; peak: number }>()
    for (const p of pts)
      for (const q of p.procs) {
        const e = stats.get(q.pid) ?? { sum: 0, n: 0, peak: 0 }
        e.sum += q.cpu
        e.n++
        e.peak = Math.max(e.peak, q.cpu)
        stats.set(q.pid, e)
      }
    const avg = (pid: number) => {
      const e = stats.get(pid)
      return e ? e.sum / e.n : 0
    }
    const rows = [...s.procs].sort((a, b) => avg(b.pid) - avg(a.pid) || b.rss - a.rss)
    const shown = rows.slice(0, 14)
    $('rows').innerHTML =
      shown
        .map((p) => {
          const e = stats.get(p.pid) ?? { sum: 0, n: 1, peak: 0 }
          return `<tr><td class="name" title="pid ${p.pid}"><i class="sw" style="background:${COLOUR[p.group] ?? 'var(--dim)'}"></i>${esc(p.label)}</td><td class="r">${p.cpu.toFixed(1)}%</td><td class="r">${(e.sum / e.n).toFixed(1)}%</td><td class="r">${e.peak.toFixed(0)}%</td><td class="r">${mb(p.rss)}</td></tr>`
        })
        .join('') +
      (rows.length > shown.length
        ? `<tr><td colspan="5" class="pf-dim">+ ${rows.length - shown.length} idle processes</td></tr>`
        : '')
  }
  /** a sample a second: draw on the next frame, and never more than once a frame */
  const queue = () => {
    if (drawQueued) return
    drawQueued = true
    requestAnimationFrame(render)
  }

  function renderBench(st: BenchState) {
    const a = st.active
    $<HTMLButtonElement>('b-start').disabled = !!a
    $('b-stop').hidden = !a
    $('b-prog').hidden = !a
    if (benchTimer) clearInterval(benchTimer)
    benchTimer = null
    if (a) {
      const upd = () => {
        const el = Math.min(a.secs, (Date.now() - a.startedAt) / 1000)
        ;($('b-prog').firstElementChild as HTMLElement).style.width = `${(el / a.secs) * 100}%`
        $('b-status').textContent =
          `Recording “${a.label}” · ${Math.ceil(a.secs - el)}s left — keep the app as it is`
      }
      upd()
      benchTimer = setInterval(upd, 500)
    }
    const base = st.runs.find((r) => r.baseline)
    $('b-rows').innerHTML = st.runs.length
      ? [...st.runs]
          .reverse()
          .map((r) => {
            const cells = COLS.map(([k, , f, compare]) => {
              const v = r[k] as number | null | undefined
              if (v == null) return '<td class="r">–</td>'
              let d = ''
              const b = base?.[k] as number | null | undefined
              if (compare && base && base !== r && b != null) {
                const ch = b ? ((v - b) / b) * 100 : 0
                const cls = Math.abs(ch) < 5 ? 'same' : ch < 0 ? 'better' : 'worse'
                d = `<span class="pf-delta ${cls}">${ch > 0 ? '+' : ''}${ch.toFixed(0)}%</span>`
              }
              return `<td class="r">${f(v)}${d}</td>`
            }).join('')
            const when = new Date(r.at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })
            return `<tr><td class="name">${esc(r.label)}${r.baseline ? '<span class="pf-tag">baseline</span>' : ''}<small>${when} · ${r.secs}s</small></td>${cells}<td class="r pf-acts">${r.baseline ? '' : `<button type="button" title="Set as baseline" data-base="${esc(r.id)}">★</button>`}<button type="button" title="Delete run" data-del="${esc(r.id)}">✕</button></td></tr>`
          })
          .join('')
      : `<tr><td colspan="${COLS.length + 2}" class="pf-dim">No runs yet. Put the app in the state you want to measure, then Record.</td></tr>`
  }
  const post = (path: string) =>
    fetch(`${API}${path}`, { method: 'POST' })
      .then((r) => r.json())
      .then(renderBench)
      .catch(() => {})

  async function loadSlow() {
    try {
      const f = (await (await fetch(`${API}/findings.json`)).json()) as {
        when?: string
        items?: string[]
      }
      $('f-when').textContent = f.when ?? ''
      // written by the /profiler skill on this Mac, as HTML (`<b>Headline.</b> detail`)
      if (f.items?.length)
        $('findings').innerHTML = `<ul>${f.items.map((i) => `<li>${i}</li>`).join('')}</ul>`
    } catch {}
    try {
      const doc = (await (await fetch(`${API}/ab.json`)).json()) as AB
      const runs = doc.runs ?? []
      $('ab').hidden = !runs.length
      if (!runs.length) return
      const labels = [...new Set(runs.map((r) => r.label))]
      const max = Math.max(...runs.map((r) => r.renderer + r.gpu), 1)
      $('ab-grid').innerHTML = Object.entries(doc.scenarios ?? {})
        .filter(([k]) => runs.some((r) => r.scenario === k))
        .map(([k, name]) => {
          const base = runs.find((r) => r.scenario === k && r.label === labels[0])
          const rows = labels
            .map((l) => {
              const r = runs.find((x) => x.scenario === k && x.label === l)
              if (!r)
                return `<div class="pf-ab-row"><span>${esc(l)}</span><div class="pf-ab-track"></div><b class="pf-dim">pending</b></div>`
              const tot = r.renderer + r.gpu
              let delta = ''
              if (base && base !== r) {
                const bt = base.renderer + base.gpu
                const ch = ((tot - bt) / bt) * 100
                delta = ` · <span class="pf-delta ${ch < -5 ? 'better' : ch > 5 ? 'worse' : 'same'}">${ch > 0 ? '+' : ''}${ch.toFixed(0)}%</span>`
              }
              return `<div class="pf-ab-row"><span>${esc(l)}</span><div class="pf-ab-track"><i style="width:${(r.renderer / max) * 100}%;background:var(--pf-1)"></i><i style="width:${(r.gpu / max) * 100}%;background:var(--pf-2)"></i></div><b>${tot.toFixed(0)}%</b></div><div class="pf-ab-meta">${r.framesPerSec.toFixed(1)} fps · ${Math.round(r.drawsPerSec).toLocaleString()} draws/s · load ${r.load.toFixed(1)}${delta}</div>`
            })
            .join('')
          return `<div class="pf-ab-sc"><h4>${esc(name)}</h4>${rows}</div>`
        })
        .join('')
    } catch {}
  }

  /** the sampler is not running: say so, and offer to start it */
  async function showDown() {
    const st = (await fetch(`${API}/status`)
      .then((r) => r.json())
      .catch(() => null)) as { up: boolean; canStart: boolean; port: number } | null
    const down = $('down')
    if (st?.up) {
      down.hidden = true
      return
    }
    down.hidden = false
    down.innerHTML = st?.canStart
      ? `<p>The profiler's sampler is not running. It watches Orbit from outside, once a second, so the numbers are the app's and not the profiler's.</p><button type="button" class="pf-btn" data-act="start">Start the sampler</button>`
      : `<p>The profiler's sampler is not installed on this Mac (the <code>/profiler</code> skill's <code>server.mjs</code>). Set <code>PROFILER_SERVER</code> to its path, or install the skill.</p>`
  }

  async function connect() {
    if (es) return
    // ask first: a sampler that is not running would otherwise fail every request on the page
    const st = (await fetch(`${API}/status`)
      .then((r) => r.json())
      .catch(() => null)) as { up: boolean } | null
    if (!st?.up) return void showDown()
    if (es) return
    es = new EventSource(`${API}/stream`)
    es.addEventListener('history', (e) => {
      data = JSON.parse((e as MessageEvent).data)
      $('down').hidden = true
      queue()
    })
    es.addEventListener('bench', (e) => renderBench(JSON.parse((e as MessageEvent).data)))
    es.onmessage = (e) => {
      data.push(JSON.parse(e.data))
      if (data.length > KEEP) data.shift()
      $('status').textContent = `live · ${data.length}s recorded`
      queue()
    }
    es.onopen = () => $('dot').classList.remove('off')
    es.onerror = () => {
      $('dot').classList.add('off')
      $('status').textContent = 'not connected'
      // an EventSource retries on its own; a sampler that is not there at all gets the offer
      if (es?.readyState === EventSource.CLOSED || !data.length) {
        disconnect()
        void showDown()
      }
    }
    loadSlow()
    slow = setInterval(loadSlow, 5000)
  }
  function disconnect() {
    es?.close()
    es = null
    if (slow) clearInterval(slow)
    slow = null
    if (benchTimer) clearInterval(benchTimer)
    benchTimer = null
  }

  host.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    const w = t.closest<HTMLElement>('[data-win]')?.dataset.win
    if (w) {
      win = Number(w)
      for (const b of host.querySelectorAll<HTMLElement>('[data-win]'))
        b.classList.toggle('on', b.dataset.win === w)
      return queue()
    }
    if (t.closest('[data-act="start"]')) {
      $('down').innerHTML = '<p>Starting the sampler…</p>'
      fetch(`${API}/start`, { method: 'POST' })
        .then((r) => r.json())
        .then((j: { up: boolean; error?: string }) => {
          if (j.up) void connect()
          else $('down').innerHTML = `<p>It did not start: ${esc(j.error ?? 'no answer')}.</p>`
        })
        .catch(() => {})
      return
    }
    if (t.closest('[data-el="b-start"]'))
      return post(
        `/bench/start?secs=${$<HTMLSelectElement>('b-secs').value}&label=${encodeURIComponent($<HTMLInputElement>('b-label').value)}`,
      )
    if (t.closest('[data-el="b-stop"]')) return post('/bench/stop')
    const base = t.closest<HTMLElement>('[data-base]')?.dataset.base
    if (base) return post(`/bench/baseline?id=${encodeURIComponent(base)}`)
    const del = t.closest<HTMLElement>('[data-del]')?.dataset.del
    if (del && confirm('Delete this benchmark run?'))
      return post(`/bench/delete?id=${encodeURIComponent(del)}`)
  })

  return {
    visible: (on: boolean) => (on ? void connect() : disconnect()),
    dispose: disconnect,
  }
}

/**
 * The profiler in the dock: ⌥⌘P, the rail's Profiler button, or "Profiler" in the palette.
 * (`p` alone is the map's node previews.)
 */
export function registerProfilerPanel() {
  let view: ReturnType<typeof mountProfiler> | null = null
  return registerPanel({
    id: 'profiler',
    title: 'Profiler',
    group: 'dev',
    dev: true,
    // Joe keeps it in view beside the rail while working, so it docks on the left
    side: 'left',
    chord: 'alt+meta+KeyP',
    icon: ICON,
    width: { min: 420, default: 640, snaps: [520, 640, 900] },
    terms:
      'profiler performance cpu memory ram benchmark baseline fan loud slow renderer gpu processes findings',
    hint: 'CPU and memory per process, 60 s benchmarks, findings',
    mount: (host) => {
      view = mountProfiler(host)
      return () => view?.dispose()
    },
    onVisible: (on) => view?.visible(on),
  })
}
