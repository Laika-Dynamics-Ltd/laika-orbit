/**
 * Drag widgets between and within the rails.
 *
 * The header is the handle. Past a 4px threshold the widget lifts into a floating
 * ghost and leaves a SOCKET — a glowing slot the size of the widget — where it will
 * land. The socket moves as the pointer crosses the midpoints of other widgets, and
 * those widgets glide aside (FLIP). Near its socket the ghost is pulled in
 * magnetically, so a drop feels like clicking into place rather than letting go.
 *
 * The ghost is driven by a per-frame spring toward its target, not set directly from
 * pointer events: pointer events arrive unevenly, the spring does not.
 */
import type { Widget } from './widgets.ts'

type Patch = Record<string, { order: number; rail: 'left' | 'right' }>
type Opts = {
  rails: [HTMLElement, HTMLElement]
  /** called on drop with the new order of every widget in both rails */
  commit: (patch: Patch) => Promise<void> | void
  widgets: () => Widget[]
}

const THRESHOLD = 4
/** within this distance of its socket the ghost is pulled in */
const SNAP = 72
/** a socket only moves once the pointer is this far past a neighbour's midpoint */
const HYSTERESIS = 10
const EASE = 'cubic-bezier(.2,.8,.2,1)'
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

let active = false
/** pointer is down on a header but the drag has not started: a re-render now would detach it */
let pending = false
export const isDragging = () => active || pending

/** Record where every widget is, move the DOM, then animate each from old to new. */
function flip(els: HTMLElement[], mutate: () => void) {
  const before = new Map(els.map((el) => [el, el.getBoundingClientRect()]))
  mutate()
  if (reduced()) return
  for (const el of els) {
    const a = before.get(el)
    if (!a || !el.isConnected) continue
    const b = el.getBoundingClientRect()
    const dx = a.left - b.left
    const dy = a.top - b.top
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
      duration: 200,
      easing: EASE,
    })
  }
}

export function initWidgetDrag(o: Opts) {
  for (const rail of o.rails) {
    rail.addEventListener('pointerdown', (e) => start(e, o))
  }
}

function start(e: PointerEvent, o: Opts) {
  if (e.button !== 0 || active) return
  const t = e.target as HTMLElement
  const head = t.closest<HTMLElement>('.w-h')
  // controls inside the header keep their own clicks
  if (!head || t.closest('button, a, input, select, textarea')) return
  const widget = head.closest<HTMLElement>('.widget')
  if (!widget) return
  pending = true

  const x0 = e.clientX
  const y0 = e.clientY
  const pointerId = e.pointerId
  let started = false

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return
    if (!started) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD) return
      started = true
      teardownPending()
      // a background re-render may still have replaced the element; drag its live copy
      const live = widget.isConnected
        ? widget
        : document.querySelector<HTMLElement>(
            `.rail > .widget[data-id="${CSS.escape(widget.dataset.id ?? '')}"]`,
          )
      if (live) drag(live, x0, y0, ev, o)
    }
  }
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) teardownPending()
  }
  const teardownPending = () => {
    pending = false
    removeEventListener('pointermove', onMove)
    removeEventListener('pointerup', onUp)
    removeEventListener('pointercancel', onUp)
  }
  addEventListener('pointermove', onMove)
  addEventListener('pointerup', onUp)
  addEventListener('pointercancel', onUp)
}

function drag(widget: HTMLElement, x0: number, y0: number, first: PointerEvent, o: Opts) {
  active = true
  const [left, right] = o.rails
  const r0 = widget.getBoundingClientRect()
  const grabX = x0 - r0.left
  const grabY = y0 - r0.top
  const home = { rail: widget.parentElement as HTMLElement, next: widget.nextElementSibling }

  // the socket takes the widget's place; the widget itself waits, detached
  const socket = document.createElement('div')
  socket.className = 'w-socket'
  socket.style.height = `${r0.height}px`
  widget.replaceWith(socket)

  const ghost = widget.cloneNode(true) as HTMLElement
  ghost.classList.add('w-ghost')
  ghost.removeAttribute('data-id')
  Object.assign(ghost.style, { width: `${r0.width}px`, height: `${r0.height}px` })
  document.body.appendChild(ghost)
  document.body.classList.add('w-dragging')

  // spring state: position and velocity chase `target`
  let px = r0.left
  let py = r0.top
  let vx = 0
  let vy = 0
  let tx = px
  let ty = py
  let pointer = { x: first.clientX, y: first.clientY }
  let raf = 0
  let lastT = performance.now()
  let dropping = false

  const siblings = () =>
    [left, right].flatMap((r) => [
      ...r.querySelectorAll<HTMLElement>(':scope > .widget, :scope > .w-socket'),
    ])

  /** Which rail and slot the pointer is asking for. */
  const aim = () => {
    const lr = left.getBoundingClientRect()
    const rr = right.getBoundingClientRect()
    const usable = [left, right].filter((r) => r.getBoundingClientRect().width > 40)
    const rail =
      usable.find((r) => {
        const b = r.getBoundingClientRect()
        return pointer.x >= b.left && pointer.x <= b.right
      }) ??
      // off both rails: the nearer one, so a drop over the graph still lands somewhere sane
      (usable.length === 2
        ? Math.abs(pointer.x - (lr.left + lr.right) / 2) <
          Math.abs(pointer.x - (rr.left + rr.right) / 2)
          ? left
          : right
        : (usable[0] ?? home.rail))
    const items = [...rail.querySelectorAll<HTMLElement>(':scope > .widget')]
    let before: Element | null = rail.querySelector(':scope > .w-restore')
    for (const it of items) {
      const b = it.getBoundingClientRect()
      const mid = b.top + b.height / 2
      // hysteresis: crossing toward the socket needs a little extra travel
      const socketAbove =
        socket.parentElement === rail &&
        socket.compareDocumentPosition(it) & Node.DOCUMENT_POSITION_FOLLOWING
      const edge = socketAbove ? mid + HYSTERESIS : mid - HYSTERESIS
      if (pointer.y < edge) {
        before = it
        break
      }
    }
    return { rail, before }
  }

  const place = () => {
    const { rail, before } = aim()
    if (socket.parentElement === rail && socket.nextElementSibling === before) return
    if (before === socket) return
    flip(siblings(), () => rail.insertBefore(socket, before))
    // the rails differ in width; the ghost takes the width of the rail it is over
    ghost.style.width = `${socket.offsetWidth}px`
  }

  const autoscroll = () => {
    for (const r of [left, right]) {
      const b = r.getBoundingClientRect()
      if (pointer.x < b.left || pointer.x > b.right) continue
      const zone = 56
      if (pointer.y < b.top + zone) r.scrollTop -= Math.ceil((b.top + zone - pointer.y) / 6)
      else if (pointer.y > b.bottom - zone)
        r.scrollTop += Math.ceil((pointer.y - (b.bottom - zone)) / 6)
    }
  }

  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - lastT) / 1000)
    lastT = now
    // read every frame: the socket may itself still be gliding into place
    const s = socket.getBoundingClientRect()
    if (dropping) {
      tx = s.left
      ty = s.top
    } else {
      autoscroll()
      // free position, then the magnetic pull of the socket
      const fx = pointer.x - grabX
      const fy = pointer.y - grabY
      const d = Math.hypot(fx - s.left, fy - s.top)
      const pull = d < SNAP ? (1 - d / SNAP) ** 2 : 0
      tx = fx + (s.left - fx) * pull
      ty = fy + (s.top - fy) * pull
      socket.classList.toggle('hot', pull > 0.15)
    }
    // critically damped-ish spring: stiff enough to feel attached, damped so it never wobbles
    const k = dropping ? 520 : 900
    const c = 2 * Math.sqrt(k) * (dropping ? 1 : 0.9)
    vx += ((tx - px) * k - vx * c) * dt
    vy += ((ty - py) * k - vy * c) * dt
    px += vx * dt
    py += vy * dt
    const tilt = dropping ? 0 : Math.max(-3, Math.min(3, vx / 260))
    ghost.style.transform = `translate3d(${px}px, ${py}px, 0) rotate(${tilt}deg) scale(${dropping ? 1 : 1.025})`
    if (dropping && Math.hypot(tx - px, ty - py) < 0.6 && Math.hypot(vx, vy) < 8) return finish()
    raf = requestAnimationFrame(frame)
  }

  const onMove = (ev: PointerEvent) => {
    pointer = { x: ev.clientX, y: ev.clientY }
    place()
  }
  const onUp = () => drop(false)
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopImmediatePropagation()
      drop(true)
    }
  }
  // a drag must not also count as a click on the header underneath
  const eatClick = (ev: MouseEvent) => {
    ev.stopPropagation()
    ev.preventDefault()
  }

  const drop = (cancel: boolean) => {
    if (dropping) return
    dropping = true
    removeEventListener('pointermove', onMove)
    removeEventListener('pointerup', onUp)
    removeEventListener('pointercancel', onUp)
    removeEventListener('keydown', onKey, true)
    if (cancel) {
      // the widget that followed it may itself have moved; only reuse it if it is still there
      const back =
        home.next && home.next !== socket && home.next.parentElement === home.rail
          ? home.next
          : null
      flip(siblings(), () => home.rail.insertBefore(socket, back))
    }
    socket.classList.add('hot')
    ghost.style.width = `${socket.offsetWidth}px`
    ghost.classList.add('landing')
    if (reduced()) finish()
    // the landing spring advances per frame; on a starved machine it could crawl, and the
    // drag keeps swallowing clicks until it lands, so it always lands within 450ms
    else setTimeout(finish, 450)
  }

  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    cancelAnimationFrame(raf)
    socket.replaceWith(widget)
    ghost.remove()
    document.body.classList.remove('w-dragging')
    widget.animate(
      [{ boxShadow: '0 0 0 1px #ff7a45aa, 0 0 22px -6px #ff7a4588' }, { boxShadow: 'none' }],
      {
        duration: reduced() ? 0 : 420,
        easing: 'ease-out',
      },
    )
    setTimeout(() => removeEventListener('click', eatClick, true), 0)
    active = false

    // persist the whole layout of both rails as the DOM now shows it. Sending only the
    // rows that changed trusted a local copy that could be stale, and two widgets ended
    // up sharing an order; a full snapshot cannot disagree with what is on screen.
    const patch: Patch = {}
    const known = new Map(o.widgets().map((w) => [w.id, w]))
    let moved = false
    for (const [rail, name] of [
      [left, 'left'],
      [right, 'right'],
    ] as const) {
      let i = 0
      for (const el of rail.querySelectorAll<HTMLElement>(':scope > .widget')) {
        const id = el.dataset.id ?? ''
        const w = known.get(id)
        if (!w) continue
        const order = ++i * 10
        if (w.order !== order || (w.rail ?? 'left') !== name) moved = true
        w.order = order
        w.rail = name
        patch[id] = { order, rail: name }
      }
    }
    if (moved) o.commit(patch)
  }

  addEventListener('pointermove', onMove)
  addEventListener('pointerup', onUp)
  addEventListener('pointercancel', onUp)
  addEventListener('keydown', onKey, true)
  addEventListener('click', eatClick, true)
  ghost.style.transform = `translate3d(${px}px, ${py}px, 0)`
  onMove(first)
  raf = requestAnimationFrame(frame)
}
