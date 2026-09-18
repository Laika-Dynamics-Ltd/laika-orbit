/**
 * How awake the Users scene should be: live, idle, away or hidden.
 *
 * STOPGAP: this is the Users panel's own copy of what `activity.ts` (branch perf/idle-zero) will
 * own for the whole app, using the same four levels and the same 20 s idle rule. When that module
 * lands, replace `watchLevel` with its `onLevel` plus its panel/element visibility and delete this
 * file; the scene only ever sees the level.
 *
 *   hidden  panel closed or collapsed, window minimised or another tab, or the stage is covered
 *   away    on screen, but another window has focus
 *   idle    on screen and focused, nobody has touched the app for IDLE_MS
 *   live    on screen, focused, touched recently
 *
 * While the panel is hidden nothing here runs except the listeners themselves: the cover probe's
 * timer only exists while the panel is visible.
 */
export type Level = 'live' | 'idle' | 'away' | 'hidden'

export const IDLE_MS = 20_000
/** how often the cover probe looks, while visible (the map's checkCovered uses the same) */
const COVER_MS = 400

export function watchLevel(stage: HTMLElement, on: (l: Level) => void) {
  let panelShown = false
  let covered = false
  let focused = document.hasFocus()
  let lastInput = performance.now()
  let level: Level = 'hidden'
  let coverTimer = 0
  let idleTimer = 0

  const compute = (): Level => {
    if (!panelShown || document.hidden || covered) return 'hidden'
    if (!focused) return 'away'
    return performance.now() - lastInput > IDLE_MS ? 'idle' : 'live'
  }
  const update = () => {
    const l = compute()
    clearTimeout(idleTimer)
    if (l === 'live')
      idleTimer = window.setTimeout(update, IDLE_MS - (performance.now() - lastInput) + 50)
    if (l === level) return
    level = l
    on(l)
  }

  // solid page UI over the whole stage (a floating panel, the browser, full-window chats)
  const probe = () => {
    const r = stage.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) {
      covered = true
    } else {
      covered = [
        [0.5, 0.5],
        [0.15, 0.15],
        [0.85, 0.15],
        [0.15, 0.85],
        [0.85, 0.85],
      ].every(([fx = 0.5, fy = 0.5]) => {
        const e = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy)
        return !e || !stage.contains(e)
      })
    }
    update()
  }

  const onInput = () => {
    lastInput = performance.now()
    if (level === 'idle') update()
  }
  const onFocus = () =>
    // a blur that only moved focus into an iframe on the page leaves the document focused
    setTimeout(() => {
      focused = document.hasFocus()
      update()
    })
  const onVisibility = () => update()

  for (const ev of ['pointermove', 'pointerdown', 'wheel', 'keydown'] as const)
    addEventListener(ev, onInput, { passive: true, capture: true })
  addEventListener('focus', onFocus)
  addEventListener('blur', onFocus)
  document.addEventListener('visibilitychange', onVisibility)

  return {
    current: () => level,
    /** from the panel's onVisible */
    setShown(v: boolean) {
      panelShown = v
      clearInterval(coverTimer)
      covered = false
      if (v) {
        coverTimer = window.setInterval(probe, COVER_MS)
        requestAnimationFrame(probe)
      }
      update()
    },
    dispose() {
      clearInterval(coverTimer)
      clearTimeout(idleTimer)
      for (const ev of ['pointermove', 'pointerdown', 'wheel', 'keydown'] as const)
        removeEventListener(ev, onInput, { capture: true })
      removeEventListener('focus', onFocus)
      removeEventListener('blur', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    },
  }
}
