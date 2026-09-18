/**
 * The one place that knows whether anything is worth drawing.
 *
 * Rule: anything not in view or in use costs nothing. Hidden (closed panel, covered, other tab,
 * window minimised or behind another app, off screen) means no drawing, no animation, no polling.
 * Idle (in view, nothing changing) means the lowest rate that still looks right, waking at once
 * on input or new data. Features subscribe here instead of each keeping its own blur, visibility
 * and panel bookkeeping.
 *
 * Levels, from most to least awake:
 *   live     the window is focused and someone touched it in the last IDLE_MS
 *   idle     focused and visible, nobody has touched it for IDLE_MS
 *   away     visible, but another app has focus (Orbit is in the background)
 *   hidden   minimised, fully covered by other windows, or another tab: nothing is on screen
 *
 * What each level does for you:
 *   - `every()` polls at its rate when live or idle, at a quarter of it when away, never when
 *     hidden or when the element or panel it serves is out of view; waking runs it at once if due
 *   - `watch()` tells an element's owner when it comes into and goes out of view
 *   - infinite CSS animations are paused (and put back to their first frame) whenever the level is
 *     idle or lower, and play again on the next input
 *   - `html[data-act]` carries the level, for CSS that wants its own rules
 */

export type Level = 'live' | 'idle' | 'away' | 'hidden'

/** no input for this long and the window counts as idle */
export const IDLE_MS = 20_000
/** how much slower `every()` polls while another app is in front */
const AWAY_FACTOR = 4

const RANK: Record<Level, number> = { live: 0, idle: 1, away: 2, hidden: 3 }

let level: Level = 'live'
let lastInput = performance.now()
let focused = document.hasFocus()
const subs = new Set<(l: Level, was: Level) => void>()

export const current = () => level
/** true when the level is at least as asleep as `l` */
export const atLeast = (l: Level) => RANK[level] >= RANK[l]
export const sinceInput = () => performance.now() - lastInput

/** run on every level change; returns an unsubscribe */
export function onLevel(fn: (l: Level, was: Level) => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

function compute(): Level {
  if (document.visibilityState === 'hidden') return 'hidden'
  if (!focused) return 'away'
  return sinceInput() >= IDLE_MS ? 'idle' : 'live'
}

let idleTimer: ReturnType<typeof setTimeout> | null = null
function update() {
  const next = compute()
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  // the only timer this module keeps: the moment a focused, untouched window turns idle
  if (next === 'live') idleTimer = setTimeout(update, Math.max(50, IDLE_MS - sinceInput()))
  if (next === level) return
  const was = level
  level = next
  document.documentElement.dataset.act = level
  for (const fn of [...subs]) fn(level, was)
}

// input: cheap on every event (a timestamp), and a level change only when waking
for (const ev of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'touchstart'] as const)
  addEventListener(
    ev,
    () => {
      lastInput = performance.now()
      if (level !== 'live' && focused) update()
    },
    { passive: true, capture: true },
  )
// A blur that only moved focus into an iframe on the page (mission control, a preview) leaves the
// document focused, so look after the event rather than trusting it.
for (const ev of ['focus', 'blur'] as const)
  addEventListener(ev, () =>
    setTimeout(() => {
      focused = document.hasFocus()
      if (focused) lastInput = performance.now()
      update()
    }),
  )
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    focused = document.hasFocus()
    if (focused) lastInput = performance.now()
  }
  update()
})
document.documentElement.dataset.act = level
update()

// ------------------------------------------------------------------ panels ----

const panels = new Map<string, boolean>()
const panelSubs = new Map<string, Set<(on: boolean) => void>>()

/** panels.ts calls this whenever a panel starts or stops being on screen */
export function setPanelShown(id: string, on: boolean) {
  if (panels.get(id) === on) return
  panels.set(id, on)
  for (const fn of [...(panelSubs.get(id) ?? [])]) fn(on)
}
/** is this panel open and on screen (docked, floating or peeking, and not folded to its icon)? */
export const panelShown = (id: string) => panels.get(id) === true
export function onPanel(id: string, fn: (on: boolean) => void): () => void {
  const set = panelSubs.get(id) ?? new Set()
  panelSubs.set(id, set)
  set.add(fn)
  return () => set.delete(fn)
}

// ---------------------------------------------------------------- elements ----

type Watch = { el: Element; fn: (on: boolean) => void; inView: boolean; on: boolean }
const watches = new Map<Element, Set<Watch>>()
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries)
      for (const w of watches.get(e.target) ?? []) {
        w.inView = e.isIntersecting
        settle(w)
      }
  },
  { threshold: 0 },
)
function settle(w: Watch) {
  const on = w.inView && level !== 'hidden'
  if (on === w.on) return
  w.on = on
  w.fn(on)
}
onLevel(() => {
  for (const set of watches.values()) for (const w of set) settle(w)
})

/**
 * Tell `fn` when `el` comes into view and when it leaves: off screen, display:none, detached, or
 * the window hidden. Called once soon after with the first answer. Returns an unwatch.
 */
export function watch(el: Element, fn: (on: boolean) => void): () => void {
  const w: Watch = { el, fn, inView: false, on: false }
  const set = watches.get(el) ?? new Set()
  if (!set.size) io.observe(el)
  set.add(w)
  watches.set(el, set)
  return () => {
    set.delete(w)
    if (!set.size) {
      watches.delete(el)
      io.unobserve(el)
    }
  }
}

// ------------------------------------------------------------------- polling ----

export type EveryOpts = {
  /** only while this element is in view */
  el?: Element
  /** only while this panel is on screen */
  panel?: string
  /** while another app is in front: 'slow' (the default, a quarter of the rate), 'stop', or 'full' */
  away?: 'slow' | 'stop' | 'full'
  /** also run as soon as it is set up (default true) */
  now?: boolean
}

/**
 * Run `fn` every `ms` while it can be seen, and not otherwise. Coming back into view runs it at
 * once when a run is due, so what you see is never stale. Returns a stop.
 */
export function every(ms: number, fn: () => unknown, o: EveryOpts = {}): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let last = Number.NEGATIVE_INFINITY
  let elOn = !o.el
  let stopped = false
  const gap = () => {
    if (level === 'hidden' || !elOn || (o.panel && !panelShown(o.panel))) return null
    if (level === 'away')
      return o.away === 'stop' ? null : o.away === 'full' ? ms : ms * AWAY_FACTOR
    return ms
  }
  const fire = () => {
    timer = null
    last = performance.now()
    try {
      const r = fn()
      if (r instanceof Promise) r.catch(() => {})
    } catch (e) {
      console.error(e)
    }
    arm()
  }
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = null
    if (stopped) return
    const g = gap()
    if (g === null) return
    timer = setTimeout(fire, Math.max(0, last + g - performance.now()))
  }
  const offs = [onLevel(arm)]
  if (o.el)
    offs.push(
      watch(o.el, (on) => {
        elOn = on
        arm()
      }),
    )
  if (o.panel) offs.push(onPanel(o.panel, arm))
  if (o.now === false) last = performance.now()
  arm()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    for (const off of offs) off()
  }
}

// ---------------------------------------------------------------- animations ----

/**
 * Infinite CSS animations (pulses, spinners, shimmers) cost a frame every vsync for as long as they
 * run. At idle or lower they are paused on their first frame, which is how each one looks at rest;
 * any input plays them again. New ones that start while asleep are caught on the next sweep.
 */
const SWEEP_MS = 2000
const paused = new Set<Animation>()
let sweepTimer: ReturnType<typeof setTimeout> | null = null
function isLoop(a: Animation) {
  return a.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY
}
function sweep() {
  sweepTimer = null
  if (level === 'live') return
  for (const a of document.getAnimations()) {
    if (a.playState !== 'running' || !isLoop(a)) continue
    a.pause()
    a.currentTime = 0
    paused.add(a)
  }
  // hidden draws nothing anyway; idle and away look for newcomers now and then
  if (level !== 'hidden') sweepTimer = setTimeout(sweep, SWEEP_MS)
}
onLevel((l) => {
  if (sweepTimer) clearTimeout(sweepTimer)
  sweepTimer = null
  if (l !== 'live') return sweep()
  for (const a of paused) if (a.playState === 'paused') a.play()
  paused.clear()
})
