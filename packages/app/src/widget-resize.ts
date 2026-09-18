/**
 * Resizing, in the two directions a rail layout has.
 *
 * - Height, per widget: a handle on each widget's bottom edge. The height snaps to the
 *   widget's natural content height (sticky, like the drag sockets) and otherwise to an
 *   8px grid. Double-click, or drag back to natural, returns it to auto. Arrow keys on
 *   the focused handle nudge it. Saved per widget in brain/widgets/_settings.json.
 * - Width, per rail: every widget in a rail shares its width, so the rail edge is the
 *   handle. Snaps back to the default width near it; double-click resets. Saved per
 *   browser, since it depends on the screen more than on the brain.
 */
type HeightPatch = Record<string, { height: number | null }>
type Opts = {
  main: HTMLElement
  rails: [HTMLElement, HTMLElement]
  saveHeight: (patch: HeightPatch) => Promise<void> | void
  /** the widget list, so a saved height stays in step without a refetch */
  setLocalHeight: (id: string, height: number | undefined) => void
}

const GRID = 8
/** within this many px of the natural height, the handle sticks to "auto" */
const SNAP_AUTO = 14
const MAX_H = 1400
const RAIL_MIN = 220
const RAIL_MAX = 620
/** within this many px of a rail's default width, it sticks to the default */
const SNAP_RAIL = 12
const KEY = (side: 'l' | 'r') => `orbit:rail-${side}-w`

let resizing = false
export const isResizing = () => resizing

export function initWidgetResize(o: Opts) {
  // a press or double-click on a handle must never start a text selection nearby
  for (const type of ['mousedown', 'dblclick'] as const) {
    o.main.addEventListener(type, (e) => {
      if (!(e.target as HTMLElement).closest('.w-rsz, .rail-edge')) return
      e.preventDefault()
      getSelection()?.removeAllRanges()
    })
  }
  for (const rail of o.rails) {
    rail.addEventListener('pointerdown', (e) => {
      const h = (e.target as HTMLElement).closest<HTMLElement>('.w-rsz')
      if (h && e.button === 0) startHeight(e, h, o)
    })
    rail.addEventListener('dblclick', (e) => {
      const h = (e.target as HTMLElement).closest<HTMLElement>('.w-rsz')
      if (h) setHeight(h, null, o, true)
    })
    rail.addEventListener('keydown', (e) => {
      const h = (e.target as HTMLElement).closest<HTMLElement>('.w-rsz')
      if (!h || !['ArrowUp', 'ArrowDown', 'Home'].includes(e.key)) return
      e.preventDefault()
      const w = h.closest<HTMLElement>('.widget')
      if (!w) return
      if (e.key === 'Home') return setHeight(h, null, o, true)
      const step = e.shiftKey ? GRID * 6 : GRID * 2
      const cur = w.getBoundingClientRect().height
      setHeight(h, clampH(w, cur + (e.key === 'ArrowDown' ? step : -step)), o, true)
    })
  }
  initRails(o)
}

// ------------------------------------------------------------------ height ----
function minHeight(w: HTMLElement) {
  const head = w.querySelector('.w-h')?.getBoundingClientRect()
  const top = w.getBoundingClientRect().top
  return head ? Math.ceil(head.bottom - top + 56) : 96
}
const clampH = (w: HTMLElement, h: number) => Math.round(Math.max(minHeight(w), Math.min(MAX_H, h)))

/** The height the widget would take with no constraint. */
function naturalHeight(w: HTMLElement) {
  const prev = w.style.height
  const sized = w.classList.contains('sized')
  w.style.height = ''
  w.classList.remove('sized')
  const h = w.getBoundingClientRect().height
  w.style.height = prev
  w.classList.toggle('sized', sized)
  return h
}

function apply(w: HTMLElement, h: number | null) {
  w.style.height = h === null ? '' : `${h}px`
  w.classList.toggle('sized', h !== null)
}

function setHeight(handle: HTMLElement, h: number | null, o: Opts, save: boolean) {
  const w = handle.closest<HTMLElement>('.widget')
  const id = w?.dataset.id
  if (!w || !id) return
  apply(w, h)
  handle.setAttribute('aria-valuenow', String(Math.round(w.getBoundingClientRect().height)))
  if (!save) return
  o.setLocalHeight(id, h ?? undefined)
  o.saveHeight({ [id]: { height: h } })
}

function startHeight(e: PointerEvent, handle: HTMLElement, o: Opts) {
  const w = handle.closest<HTMLElement>('.widget')
  if (!w) return
  e.preventDefault()
  e.stopPropagation()
  resizing = true
  const y0 = e.clientY
  const h0 = w.getBoundingClientRect().height
  const natural = naturalHeight(w)
  const wasAuto = !w.classList.contains('sized')
  let result: number | null = wasAuto ? null : h0
  document.body.classList.add('w-resizing')
  w.classList.add('resizing')
  handle.setPointerCapture(e.pointerId)

  // a tag that shows the height as it changes, and "auto" when it has snapped
  const tag = document.createElement('span')
  tag.className = 'w-rsz-tag'
  w.appendChild(tag)

  const onMove = (ev: PointerEvent) => {
    const raw = clampH(w, h0 + ev.clientY - y0)
    const snapAuto = Math.abs(raw - natural) <= SNAP_AUTO
    result = snapAuto ? null : clampH(w, Math.round(raw / GRID) * GRID)
    apply(w, result)
    w.classList.toggle('snap-auto', snapAuto)
    tag.textContent = snapAuto ? 'auto' : `${result}px`
  }
  const onUp = (ev: PointerEvent) => {
    handle.releasePointerCapture(ev.pointerId)
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('pointercancel', onUp)
    document.body.classList.remove('w-resizing')
    w.classList.remove('resizing', 'snap-auto')
    tag.remove()
    resizing = false
    const moved = Math.abs(ev.clientY - y0) > 2
    if (moved && !(wasAuto && result === null)) setHeight(handle, result, o, true)
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('pointercancel', onUp)
}

// ------------------------------------------------------------------- rails ----
function defaultWidth(side: 'l' | 'r') {
  // mirrors the CSS defaults: minmax(260px, 20vw) and minmax(280px, 22vw)
  return side === 'l' ? Math.max(260, innerWidth * 0.2) : Math.max(280, innerWidth * 0.22)
}

function readWidth(side: 'l' | 'r'): number | null {
  try {
    const v = Number(localStorage.getItem(KEY(side)))
    return v >= RAIL_MIN && v <= RAIL_MAX ? v : null
  } catch {
    return null
  }
}

function writeWidth(side: 'l' | 'r', px: number | null) {
  const root = document.documentElement
  if (px === null) root.style.removeProperty(`--rail-${side}`)
  else root.style.setProperty(`--rail-${side}`, `${Math.round(px)}px`)
}

function saveWidth(side: 'l' | 'r', px: number | null) {
  try {
    if (px === null) localStorage.removeItem(KEY(side))
    else localStorage.setItem(KEY(side), String(Math.round(px)))
  } catch {}
}

function initRails(o: Opts) {
  const sides = [
    ['l', o.rails[0]],
    ['r', o.rails[1]],
  ] as const
  const edges = sides.map(([side]) => {
    writeWidth(side, readWidth(side))
    const el = document.createElement('div')
    el.className = `rail-edge rail-edge-${side}`
    el.setAttribute('role', 'separator')
    el.setAttribute('aria-orientation', 'vertical')
    el.setAttribute('aria-label', `${side === 'l' ? 'Left' : 'Right'} column width`)
    el.tabIndex = 0
    el.title = 'Drag to resize the column · double-click to reset'
    o.main.appendChild(el)
    return el
  })

  // keep each handle on its rail's inner edge as the layout changes
  const position = () => {
    const m = o.main.getBoundingClientRect()
    sides.forEach(([side, rail], i) => {
      const edge = edges[i] as HTMLElement
      const r = rail.getBoundingClientRect()
      const hidden = r.width < 8
      edge.style.display = hidden ? 'none' : ''
      edge.style.left = `${(side === 'l' ? r.right : r.left) - m.left - 4}px`
    })
  }
  const ro = new ResizeObserver(position)
  ro.observe(o.main)
  for (const [, rail] of sides) ro.observe(rail)
  addEventListener('resize', position)
  position()

  sides.forEach(([side, rail], i) => {
    const edge = edges[i] as HTMLElement
    edge.addEventListener('dblclick', () => {
      writeWidth(side, null)
      saveWidth(side, null)
    })
    edge.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home') return
      e.preventDefault()
      if (e.key === 'Home') {
        writeWidth(side, null)
        saveWidth(side, null)
        return
      }
      const grow = (e.key === 'ArrowRight') === (side === 'l')
      const w = rail.getBoundingClientRect().width + (grow ? 1 : -1) * (e.shiftKey ? 48 : 16)
      const px = Math.max(RAIL_MIN, Math.min(RAIL_MAX, w))
      writeWidth(side, px)
      saveWidth(side, px)
    })
    edge.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      resizing = true
      const x0 = e.clientX
      const w0 = rail.getBoundingClientRect().width
      const def = defaultWidth(side)
      let result: number | null = readWidth(side)
      document.body.classList.add('rail-resizing')
      edge.classList.add('active')
      edge.setPointerCapture(e.pointerId)
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - x0
        const raw = Math.max(RAIL_MIN, Math.min(RAIL_MAX, w0 + (side === 'l' ? dx : -dx)))
        const snap = Math.abs(raw - def) <= SNAP_RAIL
        result = snap ? null : raw
        writeWidth(side, result)
        edge.classList.toggle('snap', snap)
      }
      const onUp = (ev: PointerEvent) => {
        edge.releasePointerCapture(ev.pointerId)
        edge.removeEventListener('pointermove', onMove)
        edge.removeEventListener('pointerup', onUp)
        edge.removeEventListener('pointercancel', onUp)
        document.body.classList.remove('rail-resizing')
        edge.classList.remove('active', 'snap')
        resizing = false
        saveWidth(side, result)
      }
      edge.addEventListener('pointermove', onMove)
      edge.addEventListener('pointerup', onUp)
      edge.addEventListener('pointercancel', onUp)
    })
  })
}
