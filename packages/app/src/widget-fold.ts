/**
 * Collapse and expand widgets in place.
 *
 * The chevron in the header toggles one widget; double-clicking the header does too.
 * Option/Alt-click folds or unfolds every widget in that rail at once. The height is
 * animated from what is on screen to what will be, so it glides for both auto-height
 * and fixed-height (resized) widgets. Saved as `collapsed` in _settings.json.
 */
import type { Widget } from './widgets.ts'

type Patch = Record<string, { collapsed: true | null }>
type Opts = {
  rails: [HTMLElement, HTMLElement]
  widgets: () => Widget[]
  save: (patch: Patch) => Promise<void> | void
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
let animating = 0
/** true while a fold animation runs, so a background re-render waits for it */
export const isFolding = () => animating > 0

/** Toggle one widget element to `collapse`, animating its height. */
function fold(el: HTMLElement, w: Widget | undefined, collapse: boolean) {
  if (el.classList.contains('collapsed') === collapse) return
  const from = el.getBoundingClientRect().height
  el.classList.toggle('collapsed', collapse)
  // a resized widget keeps its height only while open
  const fixed = !collapse && w?.height ? w.height : null
  el.style.height = fixed ? `${fixed}px` : ''
  el.classList.toggle('sized', !!fixed)
  el.querySelector('.w-fold')?.setAttribute('aria-expanded', String(!collapse))
  if (w) {
    if (collapse) w.collapsed = true
    else delete w.collapsed
  }
  if (reduced()) return
  const to = el.getBoundingClientRect().height
  if (Math.abs(to - from) < 1) return
  animating++
  el.classList.add('folding')
  const anim = el.animate([{ height: `${from}px` }, { height: `${to}px` }], {
    duration: Math.min(320, 140 + Math.abs(to - from) * 0.25),
    easing: 'cubic-bezier(.2,.8,.2,1)',
  })
  anim.onfinish = anim.oncancel = () => {
    el.classList.remove('folding')
    animating--
  }
}

export function initWidgetFold(o: Opts) {
  const byId = () => new Map(o.widgets().map((w) => [w.id, w]))

  const toggle = (el: HTMLElement, allInRail: boolean) => {
    const known = byId()
    const collapse = !el.classList.contains('collapsed')
    const targets = allInRail
      ? [...(el.parentElement?.querySelectorAll<HTMLElement>(':scope > .widget') ?? [])]
      : [el]
    const patch: Patch = {}
    for (const t of targets) {
      const id = t.dataset.id
      if (!id || t.classList.contains('collapsed') === collapse) continue
      fold(t, known.get(id), collapse)
      patch[id] = { collapsed: collapse ? true : null }
    }
    if (Object.keys(patch).length) o.save(patch)
  }

  for (const rail of o.rails) {
    rail.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.w-fold')
      const el = b?.closest<HTMLElement>('.widget')
      if (!b || !el) return
      e.preventDefault()
      toggle(el, e.altKey)
    })
    rail.addEventListener('dblclick', (e) => {
      const t = e.target as HTMLElement
      const head = t.closest('.w-h')
      if (!head || t.closest('button, a, input, select, textarea')) return
      const el = head.closest<HTMLElement>('.widget')
      if (!el) return
      getSelection()?.removeAllRanges()
      toggle(el, e.altKey)
    })
  }
}
