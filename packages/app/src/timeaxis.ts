/**
 * One clock, shared by everything that draws over time.
 *
 * Two thirds of a day on a project is nothing happening — on a straight axis the night eats
 * the width and the work is crushed into a corner — so a silence longer than the threshold is
 * COMPRESSED to a stub that prints its own length, the way a broken axis is drawn on paper.
 * The clock stays honest because every break states its own size.
 *
 * No renderer, no DOM: this is the arithmetic, so two charts over the same window cannot
 * drift apart.
 */

export const dur = (ms: number): string =>
  ms < 60e3
    ? `${Math.round(ms / 1e3)}s`
    : ms < 36e5
      ? `${Math.round(ms / 6e4)}m`
      : ms < 864e5
        ? `${Math.floor(ms / 36e5)}h${
            Math.round((ms % 36e5) / 6e4) ? ` ${Math.round((ms % 36e5) / 6e4)}m` : ''
          }`
        : `${Math.round(ms / 864e5)}d`

const HOUR = 36e5
const DAY = 864e5

/**
 * Ticks a person reads: whole hours while the window is short, three- and six-hour marks as it
 * widens, midnights once it is days. A tick every tenth of an arbitrary span gives 14:37,
 * which nobody wants.
 */
export function tickStep(ms: number): number {
  for (const s of [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY])
    if (ms / s <= 13) return s
  return 14 * DAY
}

export type Tick = { t: number; date: boolean; d: Date }

/** Every tick in the window, as local time, plus whether it is a midnight. */
export function ticks(from: number, to: number): Tick[] {
  const step = tickStep(to - from)
  const tz = new Date().getTimezoneOffset() * 60e3
  const out: Tick[] = []
  for (let t = Math.ceil((from - tz) / step) * step + tz; t <= to; t += step) {
    const d = new Date(t)
    out.push({ t, date: d.getHours() === 0 && d.getMinutes() === 0, d })
  }
  return out
}

export type Seg = { t0: number; t1: number; x0: number; x1: number; gap?: boolean }
export type Axis = {
  segs: Seg[]
  xOf: (v: number) => number
  inGap: (v: number) => boolean
  gapOf: (v: number) => Seg | undefined
  breaks: Seg[]
  perMs: number
}

export type AxisSpec = {
  /** the stretches that must stay on the live scale, as [t0, t1] pairs */
  busy?: Array<[number, number]>
  from: number
  to: number
  /** the width to lay the whole window across, in whatever units the caller draws in */
  span: number
  /** a silence shorter than this is not worth breaking for */
  minGap?: number
  /**
   * The width to give a break. A stub narrower than the words printed on it steals the tick
   * labels either side, which are exactly the two you need to read a break.
   */
  stubOf?: (a: number, b: number) => number
  /**
   * May the live run between two breaks be swallowed? A break stands for SILENCE, so this must
   * refuse anything with real work in it — a stub labelled quiet in front of a burst of
   * overnight work is the one lie this whole scheme has to avoid.
   */
  foldIf?: (a: number, b: number) => boolean
}

export function buildAxis({ from, to, span, busy = [], minGap, stubOf, foldIf }: AxisSpec): Axis {
  const MIN = minGap || Math.max(45 * 60e3, (to - from) / 16)
  const gaps: Array<[number, number]> = []
  let cur = from
  for (const [a, b] of [...busy].sort((x, y) => x[0] - y[0])) {
    if (a - cur > MIN) gaps.push([cur, a])
    cur = Math.max(cur, b)
  }
  if (to - cur > MIN) gaps.push([cur, to])
  if (foldIf)
    for (let i = 0; i < gaps.length - 1; ) {
      const a = gaps[i]!
      const b = gaps[i + 1]!
      if (b[0] - a[1] < MIN / 2 && foldIf(a[1], b[0])) {
        gaps[i] = [a[0], b[1]]
        gaps.splice(i + 1, 1)
      } else i++
    }
  let ws = gaps.map(([a, b]) => Math.max(1, stubOf ? stubOf(a, b) : span * 0.06))
  const room = span * 0.42
  const tot = ws.reduce((s, w) => s + w, 0)
  if (tot > room) ws = ws.map((w) => (w * room) / tot) // never let the breaks own the chart
  const dead = gaps.reduce((s, [a, b]) => s + (b - a), 0)
  const k = (span - ws.reduce((s, w) => s + w, 0)) / Math.max(1, to - from - dead)

  const segs: Seg[] = []
  let x = 0
  let t = from
  gaps.forEach(([a, b], i) => {
    if (a > t) {
      segs.push({ t0: t, t1: a, x0: x, x1: x + (a - t) * k })
      x += (a - t) * k
    }
    segs.push({ t0: a, t1: b, x0: x, x1: x + ws[i]!, gap: true })
    x += ws[i]!
    t = b
  })
  if (to > t) segs.push({ t0: t, t1: to, x0: x, x1: x + (to - t) * k })
  if (!segs.length) segs.push({ t0: from, t1: to, x0: 0, x1: span })

  const xOf = (v: number) => {
    const first = segs[0]!
    if (v <= first.t0) return first.x0
    for (const s of segs)
      if (v <= s.t1) return s.x0 + ((v - s.t0) / Math.max(1, s.t1 - s.t0)) * (s.x1 - s.x0)
    return segs[segs.length - 1]!.x1
  }
  const gapOf = (v: number) => segs.find((s) => s.gap && v > s.t0 && v < s.t1)
  return { segs, xOf, inGap: (v) => !!gapOf(v), gapOf, breaks: segs.filter((s) => s.gap), perMs: k }
}

/**
 * Labels along a ruler collide once the axis is compressed. The line is always worth drawing;
 * the label is dropped when it would sit on one already placed. Claim the important ones FIRST.
 */
export function placer() {
  const taken: Array<{ x: number; w: number }> = []
  return {
    claim(x: number, half: number) {
      taken.push({ x, w: half })
    },
    free(x: number, half: number) {
      return !taken.some((o) => Math.abs(o.x - x) < (o.w + half) * 0.95)
    },
    fit(x: number, half: number) {
      if (!this.free(x, half)) return false
      this.claim(x, half)
      return true
    },
  }
}
