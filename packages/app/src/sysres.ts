import './sysres.css'
import * as activity from './activity.ts'

/**
 * CPU and memory in the top bar. Kept deliberately cheap: one small request every few seconds
 * while the page is visible, nothing while it is hidden, and the DOM is touched only when a
 * number actually changes. Bars move by transform, so an update never reflows the header.
 *
 * Hovering opens a card: the last two minutes of both (kept from the readings already being
 * taken), load, where memory went, and the busiest processes. Only while the card is open
 * does the request ask the server for swap and processes.
 */
type Proc = { pid: number; cpu: number; mem: number; name: string }
type Sysres = {
  cpu: number
  cores: number
  load: number
  loads?: number[]
  mem: number
  memUsed: number
  memTotal: number
  memApp?: number | null
  memWired?: number | null
  memCompressed?: number | null
  swap?: { used: number; total: number } | null | undefined
  top?: { cpu: Proc[]; mem: Proc[] } | null | undefined
}

const EVERY_MS = 3000
const KEEP = 40 // two minutes of readings

const box = document.createElement('div')
box.className = 'sr'
box.hidden = true
box.tabIndex = 0
box.setAttribute('role', 'group')
box.setAttribute('aria-label', 'System resources')
box.setAttribute('aria-describedby', 'sr-card')
box.innerHTML = ['cpu', 'mem']
  .map(
    (k) =>
      `<span class="sr-row" data-k="${k}"><em>${k}</em><span class="sr-bar"><i></i></span><small></small></span>`,
  )
  .join('')
document.querySelector('header #hdr')?.before(box)

const card = document.createElement('div')
card.className = 'sr-card'
card.id = 'sr-card'
card.setAttribute('role', 'tooltip')
card.hidden = true
document.body.append(card)

const rows = Object.fromEntries(
  [...box.querySelectorAll<HTMLElement>('.sr-row')].map((row) => [
    row.dataset.k,
    {
      row,
      bar: row.querySelector('i') as HTMLElement,
      num: row.querySelector('small') as HTMLElement,
      at: -1,
    },
  ]),
)

const level = (n: number) => (n >= 90 ? 'hot' : n >= 75 ? 'warm' : '')

function paint(k: 'cpu' | 'mem', pct: number) {
  const r = rows[k]
  const n = Math.max(0, Math.min(100, pct))
  if (r.at === n) return
  r.at = n
  r.bar.style.transform = `scaleX(${Math.max(0.02, n / 100)})`
  r.num.textContent = `${n}%`
  r.row.dataset.level = level(n)
}

// ------------------------------------------------------------ the hover card
const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  )
const gb = (b: number) => (b / 1024 ** 3).toFixed(1)
const size = (b: number) => (b >= 1024 ** 3 ? `${gb(b)} GB` : `${Math.round(b / 1024 ** 2)} MB`)
const history: { t: number; cpu: number; mem: number }[] = []
let latest: Sysres | null = null
let open = false
let hideTimer = 0

/** A two-minute area line of one measure, 0–100. The newest reading sits at the right edge. */
function spark(k: 'cpu' | 'mem') {
  const W = 272
  const H = 34
  const n = history.length
  if (n < 2) return `<div class="sr-spark sr-wait">collecting…</div>`
  const x = (i: number) => (W * (KEEP - n + i)) / (KEEP - 1)
  const y = (v: number) => 1 + (H - 2) * (1 - v / 100)
  const pts = history.map((h, i) => `${x(i).toFixed(1)},${y(h[k]).toFixed(1)}`)
  return `<svg class="sr-spark" data-k="${k}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${k} over the last two minutes">
    <line class="sr-grid" x1="0" x2="${W}" y1="${y(50)}" y2="${y(50)}"/>
    <path class="sr-area" d="M${x(0).toFixed(1)},${H}L${pts.join('L')}L${W},${H}Z"/>
    <polyline class="sr-line" points="${pts.join(' ')}"/>
    <line class="sr-x" y1="0" y2="${H}" x1="-9" x2="-9"/>
  </svg>`
}

function procList(title: string, hint: string, list: Proc[], show: (p: Proc) => string) {
  return `<div class="sr-ps"><div class="sr-pt" title="${hint}">${title}</div>${list
    .map(
      (p) =>
        `<div class="sr-p" title="pid ${p.pid}"><span>${esc(p.name)}</span><b>${show(p)}</b></div>`,
    )
    .join('')}</div>`
}

function renderCard() {
  const s = latest
  if (!s) return
  const loads = s.loads ?? [s.load]
  const busy = (loads[0] ?? 0) > s.cores
  const parts = [
    ['sr-app', 'App', s.memApp],
    ['sr-wired', 'Wired', s.memWired],
    ['sr-comp', 'Compressed', s.memCompressed],
  ].filter((p): p is [string, string, number] => typeof p[2] === 'number' && p[2] > 0)
  const seg = (b: number) => `${((b / s.memTotal) * 100).toFixed(2)}%`
  const swap = s.swap
  card.innerHTML = `
    <div class="sr-s ${level(s.cpu)}" data-k="cpu">
      <div class="sr-h"><span>CPU</span><b data-v="${s.cpu}%">${s.cpu}%</b></div>
      ${spark('cpu')}
      <div class="sr-f"><span>${s.cores} cores</span><span>load <em class="${busy ? 'warm' : ''}">${loads.join(' · ')}</em></span></div>
    </div>
    <div class="sr-s ${level(s.mem)}" data-k="mem">
      <div class="sr-h"><span>Memory</span><b data-v="${gb(s.memUsed)} / ${gb(s.memTotal)} GB">${gb(s.memUsed)} / ${gb(s.memTotal)} GB</b></div>
      ${spark('mem')}
      ${
        parts.length
          ? `<div class="sr-stack">${parts.map(([k, , b]) => `<i class="${k}" style="width:${seg(b)}"></i>`).join('')}<i class="free"></i></div>
      <div class="sr-legend">${parts.map(([k, name, b]) => `<span><i class="${k}"></i>${name} <b>${size(b)}</b></span>`).join('')}</div>`
          : ''
      }
      ${swap?.total ? `<div class="sr-f"><span>Swap</span><span><em class="${swap.used / swap.total >= 0.75 ? 'warm' : ''}">${size(swap.used)}</em> of ${size(swap.total)}</span></div>` : ''}
    </div>
    ${
      s.top
        ? `<div class="sr-top">${procList('Busiest', 'CPU, where 100% is one whole core', s.top.cpu, (p) => `${Math.round(p.cpu)}%`)}${procList('Largest', 'Resident memory', s.top.mem, (p) => size(p.mem))}</div>`
        : `<div class="sr-top sr-wait">reading processes…</div>`
    }`
  place()
}

function place() {
  const r = box.getBoundingClientRect()
  const w = card.offsetWidth
  card.style.top = `${Math.round(r.bottom + 6)}px`
  card.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)))}px`
}

/**
 * The card repaints under the pointer every few seconds, and Chrome can lose track of a
 * pointer whose element was replaced, so its pointerleave never comes. While the card is open
 * the page watches the pointer itself and closes the card once it is over neither.
 */
function watchPointer(ev: PointerEvent) {
  const t = ev.target as Node
  if (box.contains(t) || card.contains(t)) clearTimeout(hideTimer)
  else hideCard()
}
function showCard(ev?: Event) {
  clearTimeout(hideTimer)
  if (ev?.type === 'pointerenter') document.addEventListener('pointermove', watchPointer)
  if (open) return
  open = true
  card.hidden = false
  renderCard()
  tick() // fetch swap and processes now rather than at the next beat
}
function hideCard(now = false) {
  clearTimeout(hideTimer)
  const go = () => {
    open = false
    card.hidden = true
    document.removeEventListener('pointermove', watchPointer)
  }
  if (now) go()
  else hideTimer = window.setTimeout(go, 120)
}
box.addEventListener('pointerenter', showCard)
box.addEventListener('pointerleave', () => hideCard())
box.addEventListener('focus', showCard)
box.addEventListener('blur', () => hideCard(true))
box.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') hideCard(true)
})
card.addEventListener('pointerenter', () => clearTimeout(hideTimer))
card.addEventListener('pointerleave', () => hideCard())

// scrubbing a sparkline reads that moment into the section's heading
card.addEventListener('pointermove', (ev) => {
  const svg = (ev.target as Element).closest<SVGSVGElement>('.sr-spark')
  if (!svg || history.length < 2) return
  const k = svg.dataset.k as 'cpu' | 'mem'
  const r = svg.getBoundingClientRect()
  const slot = Math.round(((ev.clientX - r.left) / r.width) * (KEEP - 1))
  const i = Math.max(0, Math.min(history.length - 1, slot - (KEEP - history.length)))
  const h = history[i]
  if (!h) return
  const x = (272 * (KEEP - history.length + i)) / (KEEP - 1)
  svg.querySelector('.sr-x')?.setAttribute('x1', String(x))
  svg.querySelector('.sr-x')?.setAttribute('x2', String(x))
  const ago = Math.round((Date.now() - h.t) / 1000)
  const v = svg.parentElement?.querySelector('[data-v]')
  if (v) v.textContent = `${h[k]}%${ago >= 2 ? ` · ${ago}s ago` : ''}`
})
// leaving it puts the current reading back
card.addEventListener('pointerout', (ev) => {
  const v = (ev.target as Element).closest('.sr-s')?.querySelector<HTMLElement>('[data-v]')
  if (v && (ev.target as Element).closest('.sr-spark')) v.textContent = v.dataset.v ?? ''
})

// ------------------------------------------------------------ polling
let timer = 0
let busy = false

async function tick() {
  clearTimeout(timer)
  if (document.hidden) return hideCard(true)
  if (!busy) {
    busy = true
    try {
      const r = await fetch(open ? '/api/sysres?detail' : '/api/sysres')
      if (r.ok) {
        const s = (await r.json()) as Sysres
        paint('cpu', s.cpu)
        paint('mem', s.mem)
        history.push({ t: Date.now(), cpu: s.cpu, mem: s.mem })
        if (history.length > KEEP) history.shift()
        // a plain beat that lands while the card is open keeps the processes it already shows
        latest = { ...s, swap: s.swap ?? latest?.swap, top: s.top ?? latest?.top }
        box.hidden = false
        if (open && !card.querySelector('.sr-spark:hover')) renderCard()
      }
    } catch {
    } finally {
      busy = false
    }
  }
  // a quarter as often while another app is in front
  if (!document.hidden)
    timer = window.setTimeout(tick, activity.atLeast('away') ? EVERY_MS * 4 : EVERY_MS)
}

addEventListener('visibilitychange', tick)
activity.onLevel((_, was) => {
  if (was === 'away' && !activity.atLeast('away')) tick()
})
tick()
