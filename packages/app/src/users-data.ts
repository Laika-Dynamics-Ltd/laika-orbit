/**
 * Users: the shape the panel draws, and the demo traffic that fills it until real data flows.
 *
 * A person is the steps they have taken and when: visited the site, joined the waitlist, bought
 * Pro, activated a licence, opened the app, used features. Steps are not a strict ladder: Orbit
 * itself is free, so plenty of people go from the site straight to the app. `active` holds the
 * spans they were using the app, at whatever grain the source knows (`Feed.activeGrain`).
 *
 * DEMO TRAFFIC IS NEVER REAL. It is generated here, in the page, from a seeded random stream; the
 * server never sees it and cannot return it, every id starts `demo-`, and the panel draws a band
 * across the stage for as long as it is showing. Real and demo people are never mixed in a feed.
 */

export const STEPS = [
  { id: 'site', label: 'Visited site', short: 'Site' },
  { id: 'waitlist', label: 'Joined waitlist', short: 'Waitlist' },
  { id: 'pro', label: 'Bought Pro', short: 'Pro' },
  { id: 'licence', label: 'Activated licence', short: 'Licence' },
  { id: 'app', label: 'Opened the app', short: 'App' },
  { id: 'feature', label: 'Used features', short: 'Features' },
] as const
export type StepId = (typeof STEPS)[number]['id']
export const STEP_INDEX = Object.fromEntries(STEPS.map((s, i) => [s.id, i])) as Record<
  StepId,
  number
>

export type Person = {
  id: string
  /** step → when it happened (epoch ms); a missing step was never taken */
  steps: Partial<Record<StepId, number>>
  /** features used, first time each */
  features: { name: string; at: number }[]
  /** spans of app use, [start, end] epoch ms */
  active: [number, number][]
}

export type Source = {
  id: string
  name: string
  /** connected: read just now · missing: exists, needs a key or setting · none: nothing to read yet */
  state: 'connected' | 'missing' | 'none' | 'error'
  /** which steps it can fill */
  steps: StepId[]
  note: string
  count?: number
}

export type Feed = {
  mode: 'real' | 'demo'
  now: number
  people: Person[]
  sources: Source[]
  /** 'minute' when "active now" is really now; 'day' when the source only knows the day */
  activeGrain: 'minute' | 'day'
  /** a step no source can fill for individuals, with a count if one is known (site visits) */
  counts?: Partial<Record<StepId, { n: number; note: string }>>
}

export const HOUR = 3_600_000
export const DAY = 24 * HOUR

/** the steps a person has taken by time t, in the order they took them */
export function stepsAt(p: Person, t: number): StepId[] {
  const out: [StepId, number][] = []
  for (const s of STEPS) {
    const at = p.steps[s.id]
    if (at !== undefined && at <= t) out.push([s.id, at])
  }
  return out.sort((a, b) => a[1] - b[1] || STEP_INDEX[a[0]] - STEP_INDEX[b[0]]).map((x) => x[0])
}

export const activeAt = (p: Person, t: number, grain: Feed['activeGrain']) =>
  p.active.some(([a, b]) =>
    grain === 'day' ? Math.floor(a / DAY) === Math.floor(t / DAY) && a <= t : a <= t && t <= b,
  )

export const lastSeen = (p: Person, t: number) => {
  let last = -1
  for (const [a, b] of p.active) if (a <= t) last = Math.max(last, Math.min(b, t))
  for (const at of Object.values(p.steps))
    if (at !== undefined && at <= t) last = Math.max(last, at)
  return last
}

// ------------------------------------------------------------------------- demo ----

/** mulberry32: small, fast, seeded; the same seed gives the same week every time */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** the features the telemetry would count (pulse-client.mjs ALLOWED), in words */
export const FEATURES = [
  'Map',
  'Recall',
  'Chats',
  'Browser',
  'Widgets',
  'Offload',
  'Index rebuild',
  'Settings',
]
const FEATURE_WEIGHT = [9, 8, 10, 5, 4, 2, 2, 3]

/**
 * A week of made-up traffic, plus a few hours ahead of `anchor` so the live view keeps flowing:
 * steps later than "now" simply have not happened yet, and appear as the clock reaches them.
 * The funnel numbers are plausible guesses for a small open-source launch, not a forecast.
 */
export function demoPeople(
  anchor: number,
  { days = 8, ahead = 6 * HOUR, seed = 1 } = {},
): Person[] {
  const r = rng(seed)
  const exp = (mean: number) => -Math.log(1 - r()) * mean
  const chance = (p: number) => r() < p
  const pick = () => {
    let x = r() * FEATURE_WEIGHT.reduce((a, b) => a + b, 0)
    for (let i = 0; i < FEATURES.length; i++) {
      x -= FEATURE_WEIGHT[i]!
      if (x < 0) return FEATURES[i]!
    }
    return FEATURES[0]!
  }
  // arrivals follow the working day (UTC-ish), busiest mid-afternoon, never quite zero
  const rate = (t: number) => {
    const h = ((t / HOUR) % 24) / 24
    return 3 + 7 * (0.5 + 0.5 * Math.sin((h - 0.35) * Math.PI * 2)) ** 2
  }
  const people: Person[] = []
  const start = anchor - days * DAY
  const end = anchor + ahead
  let t = start
  let n = 0
  while (t < end) {
    t += exp(HOUR / rate(t))
    if (t >= end) break
    const p: Person = {
      id: `demo-${String(n++).padStart(4, '0')}`,
      steps: { site: t },
      features: [],
      active: [],
    }
    let appAt: number | undefined
    let pro = false
    if (chance(0.17)) {
      const w = t + exp(4 * 60_000)
      p.steps.waitlist = w
      if (chance(0.26)) {
        pro = true
        p.steps.pro = w + exp(1.4 * DAY)
        if (chance(0.93)) {
          p.steps.licence = p.steps.pro + exp(12 * 60_000)
          if (chance(0.95)) appAt = p.steps.licence + exp(4 * 60_000)
        }
      }
    } else if (chance(0.14)) {
      // free and open source: straight from the site to the app, no waitlist
      appAt = t + exp(50 * 60_000)
    }
    if (appAt !== undefined) {
      p.steps.app = appAt
      // sessions: the first starts on opening; then most days, at a working hour
      let s = appAt
      for (let d = 0; s < end; d++) {
        const len = 8 * 60_000 + exp(55 * 60_000)
        p.active.push([s, s + len])
        if (d === 0 && chance(0.86)) {
          const used = new Set<string>()
          let ft = s + exp(6 * 60_000)
          for (let k = 0, m = 1 + Math.floor(r() * 4); k < m; k++, ft += exp(9 * 60_000)) {
            const f = pick()
            if (!used.has(f)) {
              used.add(f)
              p.features.push({ name: f, at: ft })
            }
          }
          if (p.features.length) p.steps.feature = p.features[0]!.at
        }
        // the next session: a day or so later, and fewer people come back each day
        const back = pro ? 0.88 : 0.72
        if (!chance(back ** (1 + d * 0.15))) break
        const nextDay = Math.floor(s / DAY + 1) * DAY
        s = nextDay + r() * 22 * HOUR
      }
      // a later session can reach for a feature the first did not
      if (p.steps.feature === undefined && p.active.length > 1) {
        const [a] = p.active[1]!
        p.features.push({ name: pick(), at: a + exp(5 * 60_000) })
        p.steps.feature = p.features[0]!.at
      }
    }
    people.push(p)
  }
  return people
}

export function demoFeed(now: number, anchor = now): Feed {
  return {
    mode: 'demo',
    now,
    people: demoPeople(anchor),
    activeGrain: 'minute',
    sources: [
      {
        id: 'demo',
        name: 'Generated demo traffic',
        state: 'connected',
        steps: STEPS.map((s) => s.id),
        note: 'Not real people',
      },
    ],
  }
}
