/**
 * Who was working, when, and for how long.
 *
 * "Working now" and "Recently finished" are lists: every session gets the same amount of room,
 * so a four-hour session and a two-minute one look identical, and two agents running at once
 * look consecutive. Sessions are SPANS — each has a start and a last sign of life — which is
 * the one shape a list cannot show. So: a row per repo, a bar per session, on the shared
 * broken clock from timeaxis.ts.
 *
 * Flat on purpose. Comparing where two bars begin is the whole job of a chart like this.
 *
 * Nothing here names a colour: bars carry their state as a class and control.css paints them
 * from the same tokens the cards use, so the chart follows the theme and matches the list it
 * sits under.
 */
import { type Axis, buildAxis, dur, placer, ticks } from './timeaxis.ts'

const NS = 'http://www.w3.org/2000/svg'
const el = <K extends keyof SVGElementTagNameMap>(
  n: K,
  a: Record<string, string | number> = {},
): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, n)
  for (const k in a) e.setAttribute(k, String(a[k]))
  return e
}

const GUT = 132 // room for the repo name and its count
const PAD = 14
const BAR = 20
const PITCH = 25 // one stacked sub-row
const ROWPAD = 12
const RULER = 34
const CH = 6.4 // a monospace-ish character, for deciding whether a label fits its bar
const HALF = 3.1 // half a character, for keeping ruler labels inside the frame
const LANE_CHARS = 18 // what fits in the gutter at the lane-name size

export type SpanState = 'needs-you' | 'blocked' | 'working' | 'ended' | 'idle'

export type Span = {
  id: string
  /** the lane this belongs in — a repo */
  lane: string
  t0: number
  /** null while it is still running */
  t1: number | null
  label: string
  state: SpanState
  live: boolean
}

export type SpanData = {
  from: number
  to: number
  now: number
  lanes: Array<{ id: string; name: string }>
  items: Span[]
}

export type SpanView = {
  draw(data: SpanData): void
  dispose(): void
}

type Placed = Span & { row: number }

/** Two sessions in one repo at the same time are two bars, not one on top of the other. */
function stack(items: Span[], now: number): { placed: Placed[]; rows: number } {
  const ends: number[] = []
  const placed: Placed[] = []
  for (const s of [...items].sort((a, b) => a.t0 - b.t0)) {
    let r = ends.findIndex((e) => e <= s.t0)
    if (r < 0) {
      r = ends.length
      ends.push(0)
    }
    ends[r] = (s.t1 ?? now) + 1
    placed.push({ ...s, row: r })
  }
  return { placed, rows: Math.max(1, ends.length) }
}

export function makeSpans(host: HTMLElement, on: { pick?: (id: string) => void } = {}): SpanView {
  function draw(next: SpanData) {
    host.textContent = ''
    const W = Math.max(480, host.clientWidth || 900)
    const span = W - GUT - PAD
    const now = next.now || Date.now()

    const rows = next.lanes.map((l) => ({
      ...l,
      ...stack(
        next.items.filter((s) => s.lane === l.id),
        now,
      ),
    }))
    if (!rows.length) return
    const H = rows.reduce((s, r) => s + r.rows * PITCH + ROWPAD, 0) + RULER + PAD

    // the clock: the stretches that must not be compressed are the sessions themselves
    const busy = next.items.map((s) => [s.t0, s.t1 ?? now] as [number, number])
    const label = (a: number, b: number) => `${dur(b - a)} quiet`
    const A: Axis = buildAxis({
      from: next.from,
      to: next.to,
      span,
      busy,
      stubOf: (a, b) => Math.max(46, label(a, b).length * 6.2 + 14),
      foldIf: (a, b) => !next.items.some((s) => s.t0 < b && (s.t1 ?? now) > a),
    })
    const X = (t: number) => GUT + A.xOf(t)

    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'gx' })

    // ── the grid and the breaks ──────────────────────────────────────────────
    const place = placer()
    for (const s of A.breaks) {
      const x0 = GUT + s.x0
      const w = s.x1 - s.x0
      svg.appendChild(
        el('rect', { x: x0, y: PAD - 4, width: w, height: H - RULER - PAD, class: 'gx-break' }),
      )
      for (const gx of [x0, x0 + w])
        svg.appendChild(
          el('line', { x1: gx, y1: PAD - 4, x2: gx, y2: H - RULER, class: 'gx-break-edge' }),
        )
      const txt = label(s.t0, s.t1)
      const half = txt.length * HALF
      const cx = Math.max(GUT + half, Math.min(W - PAD - half, x0 + w / 2))
      place.claim(cx, half + 6)
      const tx = el('text', { x: cx, y: H - RULER + 16, class: 'gx-tick quiet' })
      tx.textContent = txt
      svg.appendChild(tx)
    }
    for (const { t, d, date } of ticks(next.from, next.to)) {
      if (A.inGap(t) && !date) continue
      const g = date ? A.gapOf(t) : null
      const x = g ? GUT + g.x1 : X(t)
      svg.appendChild(
        el('line', {
          x1: x,
          y1: PAD - 4,
          x2: x,
          y2: H - RULER,
          class: date ? 'gx-grid day' : 'gx-grid',
        }),
      )
      const txt = date
        ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
        : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(' ', '')
      const half = txt.length * HALF
      if (!date && !place.fit(x, half + 6)) continue
      const lx = Math.max(GUT + half, Math.min(W - PAD - half, x))
      const tx = el('text', {
        x: lx,
        y: H - RULER + (date ? 30 : 16),
        class: date ? 'gx-tick day' : 'gx-tick',
      })
      tx.textContent = txt
      svg.appendChild(tx)
    }

    // ── a row per repo ───────────────────────────────────────────────────────
    let y = PAD
    for (const r of rows) {
      const h = r.rows * PITCH + ROWPAD
      svg.appendChild(el('rect', { x: 0, y: y - 4, width: W, height: h, rx: 3, class: 'gx-lane' }))
      const nm = el('text', { x: GUT - 12, y: y + 13, class: 'gx-lane-name' })
      // the names are right-aligned into a fixed gutter, so a long one runs off the left edge
      nm.textContent = r.name.length > LANE_CHARS ? `${r.name.slice(0, LANE_CHARS - 1)}…` : r.name
      const full = el('title')
      full.textContent = r.name
      nm.appendChild(full)
      svg.appendChild(nm)
      const sub = el('text', { x: GUT - 12, y: y + 26, class: 'gx-lane-sub' })
      sub.textContent = `${r.placed.length} session${r.placed.length === 1 ? '' : 's'}`
      svg.appendChild(sub)

      for (const s of r.placed) {
        const x0 = X(s.t0)
        const x1 = X(s.t1 ?? now)
        const w = Math.max(3, x1 - x0)
        const by = y + s.row * PITCH
        const g = el('g', {
          class: `gx-bar ${s.state}${s.live ? ' live' : ''}`,
          'data-id': s.id,
          tabindex: 0,
        })
        const title = el('title')
        title.textContent = `${s.label || '(untitled)'} — ${dur((s.t1 ?? now) - s.t0)}`
        g.appendChild(title)
        g.appendChild(el('rect', { x: x0, y: by, width: w, height: BAR, rx: 3 }))
        const took = dur((s.t1 ?? now) - s.t0)
        if (w > s.label.length * CH + 16) {
          const lt = el('text', { x: x0 + 7, y: by + 14, class: 'gx-bar-label' })
          lt.textContent = s.label
          g.appendChild(lt)
          if (w > (s.label.length + took.length) * CH + 34) {
            const dt = el('text', { x: x1 - 7, y: by + 14, class: 'gx-bar-dur' })
            dt.textContent = took
            g.appendChild(dt)
          }
        }
        svg.appendChild(g)
      }
      y += h
    }

    const nx = X(now)
    svg.appendChild(el('line', { x1: nx, y1: PAD - 6, x2: nx, y2: H - RULER + 2, class: 'gx-now' }))
    const nl = el('text', { x: nx, y: PAD - 9, class: 'gx-now-label' })
    nl.textContent = 'NOW'
    svg.appendChild(nl)

    host.appendChild(svg)
    svg.addEventListener('click', (ev) => {
      const b = (ev.target as Element).closest<SVGGElement>('.gx-bar')
      if (b?.dataset.id && on.pick) on.pick(b.dataset.id)
    })
  }

  return {
    draw,
    dispose() {
      host.textContent = ''
    },
  }
}
