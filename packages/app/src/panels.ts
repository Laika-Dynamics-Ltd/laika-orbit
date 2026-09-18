/**
 * The panel system: one dock, one registry, one set of rules.
 *
 * Every window in Orbit that is not the map itself is a panel — chats, agent control, History,
 * Mission, the databases, autopilot, tracking runs. A panel registers itself once and gets, for
 * free: a button in the rail, an entry in the command palette, a keyboard shortcut, the slide,
 * drag-to-resize with snaps, collapse-to-icon, peek-on-hover, tear-off to float, and a place in
 * the saved layout. Nothing else in the app should position a window itself.
 *
 * HOW IT SLIDES, AND WHY IT DOES NOT JANK
 * The dock is one grid column of `main` whose width is `--dock-w`. Opening a panel grows that
 * column and shrinks the stage; closing gives the space back. The panels inside the dock are a
 * right-aligned row of fixed pixel widths, so as the column grows the new panel is *unveiled*
 * from the right rather than re-laid-out, and the panels already open do not move at all — a
 * new panel is put at the left end of the row, next to the stage, for exactly that reason.
 *
 * The expensive part of a width change is not the grid: it is the WebGL drawing buffer, which a
 * ResizeObserver would otherwise reallocate on every frame of the animation. So the stage clips
 * instead: `body.pnl-anim` is set for the length of the slide, main.ts skips its fit() while it
 * is set, and one `laika:panels-settled` at the end does a single real resize. A panel that ends
 * up covering the map is handled by checkCovered() in main.ts, which already stops the render
 * loop when something opaque is over the stage.
 *
 * See docs/panels.md for the contract a panel author needs.
 */
import { atLeast, setPanelShown } from './activity.ts'
import { devFeatures } from './devfeatures.ts'
import './panels.css'
import * as T from './tiles.ts'

// ---------------------------------------------------------------- the contract ----

export type PanelBadge = number | { count: number; tone?: 'ok' | 'warn' | 'err' }

export type PanelSpec = {
  /** stable, lowercase, used in storage and in the DOM id (`#pnl-<id>`) */
  id: string
  /** shown in the rail, the palette and the panel's own title bar */
  title: string
  /** inline <svg>, 20x20, stroke="currentColor" — see ICONS in this file for the house style */
  icon: string
  /** single-key shortcut, e.g. 't'. Taken as typed; the system handles the typing guards. */
  key?: string
  /**
   * A shortcut with modifiers, for a panel that cannot have a bare letter — `'alt+meta+KeyA'`,
   * `'alt+KeyC'`. Written in `KeyboardEvent.code`, so ⌥C is still ⌥C on a keyboard where the
   * option key types `ç`. The rail and the palette show it as ⌥⌘A.
   */
  chord?: string
  /** extra words the command palette should match on */
  terms?: string
  /** one short line under the palette entry */
  hint?: string
  width?: { min?: number; default?: number; max?: number; snaps?: number[] }
  /**
   * Called once, the first time the panel opens, with the element your content goes in. May
   * return a dispose function. Your DOM is kept afterwards, so this is where setup goes, not
   * rendering — render in onVisible or on your own schedule.
   */
  mount: (host: HTMLElement) => void | (() => void)
  /** every open, after mount, with whatever was passed to open() — use it to land on an item */
  onOpen?: (arg?: unknown) => void
  /**
   * Whenever the panel starts or stops being on screen. Guaranteed false on close and on
   * collapse-to-icon; floating counts as visible. Stop polling when it goes false.
   */
  onVisible?: (on: boolean) => void
  /** the rail badge; called on refreshBadge() and whenever the panel opens or closes */
  badge?: () => PanelBadge
  /** a panel that wants most of the window rather than a column (History, Mission, Databases) */
  wide?: boolean
  /**
   * Which run of rail buttons this one joins — 'work', 'fleet', 'know', 'make'. The workbench
   * rail puts a `.wbn-slot` for each; a panel with no group, or one whose slot is not there,
   * goes at the end of the rail's panel buttons.
   */
  group?: string
  /**
   * This panel is a view of another one (the autopilot views are views of Autopilot). Its rail
   * button sits under its parent's and stays folded away until the parent's chevron is opened,
   * so a feature with five views costs the rail one button and not five.
   */
  under?: string
  /**
   * Which side of the window it docks on. Right (the default) is the tiled dock beside the
   * chats; left is a plain column beside the rail, for a panel you keep an eye on while working
   * (the profiler). Left panels do not tile; they float, peek and resize like any other.
   */
  side?: 'left' | 'right'
  /**
   * A tool for building Orbit, not using it (the profiler). Its rail button goes in the
   * developer section at the bottom of the rail, and it is on no key and in no palette unless
   * Settings → App → Developer features is on (devfeatures.ts).
   */
  dev?: boolean
  /**
   * How it opens the first time, before it has learned anything from you: floating (and where,
   * how big), or tiled at a width — Hyprland's window rules. After that the panel remembers
   * what you did with it (see "rules" in panels.ts), and that wins.
   */
  rule?: WindowRule
}

export type WindowRule = {
  float?: boolean
  /** a float's box; x/y default to the top right of the work area */
  rect?: { x?: number; y?: number; w?: number; h?: number }
  /** a tile's width */
  width?: number
}

export type PanelHandle = {
  id: string
  open(arg?: unknown): void
  close(): void
  toggle(arg?: unknown): void
  isOpen(): boolean
  isFloating(): boolean
  float(): void
  dock(): void
  refreshBadge(): void
}

// ------------------------------------------------------------------- the rules ----

/** the slide, and every other panel transition. Joe's bar: 150-200ms, nothing that bounces. */
const SLIDE_MS = 170
/** how much of the map is always left showing, however many panels are open */
const MIN_STAGE = 220
/** a panel dragged narrower than its minimum collapses to this icon strip */
const ICON_W = 44
/** the default width of a column panel, and of a wide one */
const DEF_W = 480
const DEF_WIDE = 900
/** a drag lands on a snap width within this many pixels */
const SNAP_PX = 18
/** hover the rail this long before a panel peeks */
const PEEK_MS = 220
const STORE = 'laika.panels.v1'
/**
 * Gaps, Hyprland's gaps_in / gaps_out: between two panels, and between the panels and the
 * dock's edges.
 */
const GAP_IN = 5
const GAP_OUT = 6

type Seat = 'closed' | 'dock' | 'float'
type State = {
  spec: PanelSpec
  el: HTMLElement
  body: HTMLElement
  btn: HTMLButtonElement
  seat: Seat
  width: number
  /** the width you last asked for, so a panel squeezed by its neighbours grows back */
  want: number
  collapsed: boolean
  /** where a floating panel sits; kept while docked so tearing off twice lands in the same place */
  rect: { x: number; y: number; w: number; h: number } | null
  mounted: boolean
  dispose?: () => void
  /** most recently opened first, so the dock row can be ordered without touching the DOM order */
  opened: number
  /** the workspace (project tab) it lives on; null is every workspace, which is the default */
  ws: string | null
}

const reg = new Map<string, State>()
let dock: HTMLElement | null = null
let rail: HTMLElement | null = null
let seq = 0
let saveTimer: ReturnType<typeof setTimeout> | null = null
/** how the docked panels are arranged (tiles.ts); the tree remembers every docked panel */
let layout: T.Layout = 'columns'
let tree: T.Tree = null
/** the panel keys act on, and the one with the focus ring */
let focused: State | null = null
/** where each docked panel was last put, in dock coordinates, for moving focus by direction */
let rects = new Map<string, T.Rect>()

const min = (s: State) => s.spec.width?.min ?? 320
const max = (s: State) => s.spec.width?.max ?? 1400
const def = (s: State) => s.spec.width?.default ?? (s.spec.wide ? DEF_WIDE : DEF_W)
const snaps = (s: State) =>
  s.spec.width?.snaps ?? (s.spec.wide ? [720, 900, 1180] : [380, 480, 720])

// ------------------------------------------------------------------- the frame ----

/** ⌥⌘A from 'alt+meta+KeyA', for the rail's tooltip and the palette's key column */
function chordLabel(chord: string) {
  const parts = chord.split('+')
  const code = parts.pop() ?? ''
  const mods = parts.map((m) => ({ shift: '⇧', alt: '⌥', ctrl: '⌃', meta: '⌘' })[m] ?? '').join('')
  return mods + (code.replace(/^(Key|Digit)/, '') || code)
}

/** does this keydown match the chord? Modifiers are exact, so ⌥C never fires on ⇧⌥C. */
function chordHit(chord: string, e: KeyboardEvent) {
  const parts = new Set(chord.split('+'))
  const code = chord.split('+').pop()
  return (
    e.code === code &&
    e.altKey === parts.has('alt') &&
    e.metaKey === parts.has('meta') &&
    e.ctrlKey === parts.has('ctrl') &&
    e.shiftKey === parts.has('shift')
  )
}

/** what a panel's shortcut reads as, whichever kind it has */
const keyLabel = (spec: PanelSpec) =>
  spec.chord ? chordLabel(spec.chord) : spec.key ? spec.key.toUpperCase() : ''

const ICON = (body: string) =>
  `<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
/** tear off to float */
const FLOAT_ICON = ICON(
  '<rect x="2.6" y="5.4" width="11" height="9" rx="1.6"/><path d="M8 5.4V3.4a1 1 0 0 1 1-1h7.4a1 1 0 0 1 1 1v7.2a1 1 0 0 1-1 1h-2"/>',
)
/** put a floating panel back in the dock */
const DOCK_ICON = ICON(
  '<rect x="2.6" y="3.4" width="14.8" height="13.2" rx="1.8"/><path d="M12.4 3.4v13.2"/>',
)

function frame(s: State) {
  const el = document.createElement('section')
  el.className = 'pnl'
  el.id = `pnl-${s.spec.id}`
  el.setAttribute('role', 'region')
  el.setAttribute('aria-label', s.spec.title)
  el.hidden = true
  el.classList.toggle('left', s.spec.side === 'left')
  // focusable, so moving focus by key can land on the panel itself
  el.tabIndex = -1
  // a click anywhere on a panel gives it the keyboard, as a window manager's does — the title
  // bar included, whose drag handler would otherwise keep focus where it was
  el.addEventListener('pointerdown', () => focus(s, true), true)
  el.addEventListener('focusin', () => focus(s))
  el.innerHTML = `
    <div class="pnl-edge" role="separator" aria-orientation="vertical" tabindex="0"
         aria-label="${s.spec.title} width" title="Drag to resize · double-click to reset"></div>
    <header class="pnl-bar">
      <span class="pnl-grip" aria-hidden="true"></span>
      <b class="pnl-title">${s.spec.title}</b>
      <span class="pnl-ws" hidden></span>
      <i class="pnl-fill"></i>
      <button type="button" class="pnl-ic pnl-float" title="Tear off to float" aria-label="Tear off to float">${FLOAT_ICON}</button>
      <button type="button" class="pnl-ic pnl-close" title="Close (esc)" aria-label="Close">×</button>
    </header>
    <div class="pnl-body"></div>
    <div class="pnl-edge-y" role="separator" aria-orientation="horizontal"
         aria-label="${s.spec.title} height" title="Drag to resize"></div>
    <button type="button" class="pnl-stub" aria-label="${s.spec.title}, collapsed — click to open">
      ${s.spec.icon}<span>${s.spec.title}</span>
    </button>`
  // a panel's own content must never leak keys into Orbit's single-key shortcuts — but Escape
  // still closes it from inside, unless the content used it first (a sheet, a picked card)
  // Only bare keys are kept in: ⌘K, ⌘, and the ⌥ shortcuts are the app's from anywhere.
  el.addEventListener('keydown', (e) => {
    if (!e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation()
    if (e.key === 'Escape' && !e.defaultPrevented && !e.metaKey && !e.altKey && !e.ctrlKey) {
      e.preventDefault()
      close(s)
    }
  })
  el.querySelector('.pnl-close')?.addEventListener('click', () => close(s))
  el.querySelector('.pnl-float')?.addEventListener('click', () =>
    s.seat === 'float' ? toDock(s) : toFloat(s),
  )
  el.querySelector('.pnl-stub')?.addEventListener('click', () => setCollapsed(s, false))
  return el
}

// ------------------------------------------------------------------ the layout ----

/** the width a panel actually occupies in the dock right now */
const seatW = (s: State) => (s.collapsed ? ICON_W : s.width)

const isLeft = (s: State) => s.spec.side === 'left'

/** panels in the (right, tiled) dock, newest first — which is also left-to-right in the row */
const docked = () =>
  [...reg.values()]
    .filter((s) => s.seat === 'dock' && here(s) && !isLeft(s))
    .sort((a, b) => b.opened - a.opened)

/** panels docked on the left, beside the rail, oldest first — which is left-to-right there */
const dockedLeft = () =>
  [...reg.values()]
    .filter((s) => s.seat === 'dock' && here(s) && isLeft(s))
    .sort((a, b) => a.opened - b.opened)

/**
 * How much width the dock may take before the stage would go below MIN_STAGE. The widget rails
 * are the user's choice, so they are never taken from; the stage gives up its space first, then
 * the panels shrink toward their minimums, then the oldest collapse to icons.
 */
function room() {
  const main = document.querySelector('main')
  if (!main) return Infinity
  // measured, not added up from the grid: the columns change with how the chats pane is docked
  // (one group, wide, three wide) and the widget rails come and go, so the real space is from the
  // map's left edge to the chats pane (or the window's edge), less a right rail between them
  // the map starts after the left dock and the left widget rail; the left dock's width is the one
  // it is going to (leftW), not the one mid-slide
  const left =
    main.getBoundingClientRect().left +
    leftW +
    (document.getElementById('rail-l')?.getBoundingClientRect().width ?? 0)
  const ss = document.getElementById('ss')
  const ssBox = ss?.getBoundingClientRect()
  const chats =
    document.body.classList.contains('ss-docked') && !!ssBox && ssBox.width > 0 && !ss?.hidden
  const right = chats && ssBox ? ssBox.left : main.getBoundingClientRect().right
  const railR = chats ? 0 : (document.getElementById('rail-r')?.getBoundingClientRect().width ?? 0)
  watchChats(ss)
  return Math.max(ICON_W, right - left - railR - MIN_STAGE)
}

/** the docked chats pane changes the room when it resizes, which `main` does not see */
let chatsSeen: HTMLElement | null = null
let roomRO: ResizeObserver | null = null
function watchChats(ss: HTMLElement | null) {
  if (!ss || ss === chatsSeen || !roomRO) return
  chatsSeen = ss
  roomRO.observe(ss)
}

/** a developer panel is only there with developer features on */
const usable = (s: State) => !s.spec.dev || devFeatures()
// turning them off takes the developer panels down with their buttons
addEventListener('laika:dev-features', (e) => {
  if ((e as CustomEvent<boolean>).detail) return
  for (const s of reg.values()) if (s.spec.dev && s.seat !== 'closed') close(s)
})

/** the tile tree cut down to the panels on screen now */
const shown = () =>
  T.prune(tree, (id) => {
    const s = reg.get(id)
    return !!s && s.seat === 'dock' && here(s) && !isLeft(s)
  })

/** how wide the dock wants to be for the panels on screen, gaps included */
function naturalDock() {
  const t = shown()
  if (!t) return 0
  return T.naturalW(t, (id) => seatW(reg.get(id) as State)) + GAP_OUT * 2 - GAP_IN
}

/**
 * Fit the open panels into the room there is. Returns the dock's width. Shrinking runs oldest
 * first so the panel you just opened keeps the size you asked for. The tree decides how widths
 * add up (side by side they add, stacked the widest counts), so the total is measured again
 * after each change rather than kept as a running sum.
 */
function fitDock() {
  const open = docked()
  const cap = room()
  // dwindle and master share whatever room there is, the way tiles do: every panel keeps the
  // width it asked for as its share, and the dock is as wide as they want or as the room allows
  // (never narrower than the newest one's minimum — opening a panel must show it). Only the row of
  // columns collapses panels to icons, because only there does another column cost full width.
  if (layout !== 'columns') {
    for (const s of open) {
      s.width = s.want
      if (s.collapsed) (s.collapsed = false), paintOne(s), s.spec.onVisible?.(true)
    }
    const newest = open[0]
    const floor = newest ? min(newest) + GAP_OUT * 2 : 0
    return Math.min(naturalDock(), Math.max(cap, floor))
  }
  // give back first: a panel that was squeezed grows again when its neighbour closes
  for (const s of [...open].reverse()) {
    if (s.collapsed || s.width >= s.want) continue
    const was = s.width
    s.width = s.want
    if (naturalDock() > cap) s.width = Math.max(was, s.want - (naturalDock() - cap))
  }
  // then squeeze, oldest first, down to each panel's minimum
  for (const s of [...open].reverse()) {
    const over = naturalDock() - cap
    if (over <= 0) break
    if (s.collapsed) continue
    s.width = Math.max(min(s), s.width - over)
  }
  // still short: the oldest panels collapse to icons rather than any of them being clipped —
  // but never the newest, which is the one just asked for. If it cannot fit even at its
  // minimum, the map gives up the rest of its room instead: opening a panel must show it.
  for (const s of [...open].reverse()) {
    if (naturalDock() <= cap) break
    if (s.collapsed || s === open[0]) continue
    s.collapsed = true
    paintOne(s)
    s.spec.onVisible?.(false)
  }
  return naturalDock()
}

/**
 * Put every docked panel in its tile. Tiles are measured from the dock's right edge, so while
 * the column slides wider the panels already there stay exactly where they are.
 */
function placeTiles(dockW: number) {
  if (!dock) return
  const h = dock.clientHeight || innerHeight
  const inset = GAP_OUT - GAP_IN / 2
  const box = {
    x: inset,
    y: inset,
    w: Math.max(0, dockW - inset * 2),
    h: Math.max(0, h - inset * 2),
  }
  const t = shown()
  rects = T.place(t, box, (id) => seatW(reg.get(id) as State))
  for (const [id, r] of rects) {
    const s = reg.get(id)
    if (!s) continue
    const w = Math.max(0, r.w - GAP_IN)
    s.el.style.setProperty('--tr', `${Math.round(dockW - r.x - r.w + GAP_IN / 2)}px`)
    s.el.style.setProperty('--ty', `${Math.round(r.y + GAP_IN / 2)}px`)
    s.el.style.setProperty('--pw', `${Math.round(w)}px`)
    s.el.style.setProperty('--th', `${Math.round(Math.max(0, r.h - GAP_IN))}px`)
    // a tile with another under it has a bottom edge to drag
    s.el.classList.toggle('stacked', r.y + r.h < box.y + box.h - 1)
  }
}

let animTimer: ReturnType<typeof setTimeout> | null = null
/**
 * Hold the stage still for the length of the slide. main.ts skips its fit() while `pnl-anim`
 * is set, so the drawing buffer is reallocated once at the end instead of every frame.
 */
function settleAfter(ms = SLIDE_MS) {
  document.body.classList.add('pnl-anim')
  if (animTimer) clearTimeout(animTimer)
  animTimer = setTimeout(() => {
    animTimer = null
    document.body.classList.remove('pnl-anim')
    dispatchEvent(new Event('laika:panels-settled'))
  }, ms + 20)
}

// ---------------------------------------------------------------------- motion ----

/**
 * Every move, resize, open and close glides, Hyprland-style: short, decelerating, and never in
 * the way. The layout is written first and the panel is drawn back from where it was, with
 * transform and clip-path only, so no frame of it costs a layout. A second action mid-glide
 * reads where the panel is *now* (getBoundingClientRect sees the transform) and starts from
 * there, so it takes over rather than queueing. Nothing loops: when it lands, it costs nothing.
 */
const MOVE_MS = 160
const IN_MS = 170
const OUT_MS = 120
/** Hyprland's emphasizedDecel, the curve the snappy rices use for windows */
const EASE = 'cubic-bezier(.05,.7,.1,1)'
/** emphasizedAccel, for what is leaving */
const EASE_OUT = 'cubic-bezier(.3,0,.8,.15)'
/**
 * No motion when nobody can see it: a change made while the window is hidden (a workspace
 * switched from the palette in another window, a panel closed by code) lands at once, through
 * the same visibility level every other animated thing in the app goes by (activity.ts).
 */
const still = () => atLeast('hidden') || matchMedia('(prefers-reduced-motion: reduce)').matches

type Snap = Map<State, DOMRect>

/** where every panel on screen is right now, mid-glide included; then its glide is dropped */
function snapshot(): Snap {
  const out: Snap = new Map()
  for (const s of reg.values()) {
    if (s.seat === 'closed' || s.el.hidden || !s.el.isConnected) continue
    out.set(s, s.el.getBoundingClientRect())
  }
  for (const s of out.keys()) for (const a of s.el.getAnimations()) if (a.id === 'wm') a.cancel()
  return out
}

/** draw each panel back from where the snapshot saw it; a panel that was not there pops in */
function glide(before: Snap) {
  if (still()) return
  for (const s of reg.values()) {
    if (s.seat === 'closed' || s.el.hidden) continue
    const old = before.get(s)
    if (!old || !old.width) {
      popIn(s)
      continue
    }
    const now = s.el.getBoundingClientRect()
    const dx = old.left - now.left
    const dy = old.top - now.top
    const gw = Math.max(0, now.width - old.width)
    const gh = Math.max(0, now.height - old.height)
    if (
      Math.abs(dx) < 0.5 &&
      Math.abs(dy) < 0.5 &&
      gw < 0.5 &&
      gh < 0.5 &&
      Math.abs(now.width - old.width) < 0.5
    )
      continue
    // growing, the clip starts at the old size and opens out; shrinking, the new size is simply
    // there, which at 160ms reads as the panel settling rather than a jump
    s.el.animate(
      [
        {
          transform: `translate(${dx}px, ${dy}px)`,
          clipPath: `inset(0 ${gw}px ${gh}px 0 round 10px)`,
        },
        { transform: 'none', clipPath: 'inset(0 0 0 0 round 10px)' },
      ],
      { duration: MOVE_MS, easing: EASE, id: 'wm' },
    )
  }
}

function popIn(s: State) {
  if (still()) return
  for (const a of s.el.getAnimations()) if (a.id === 'wm-out') a.cancel()
  s.el.classList.remove('closing')
  s.el.animate(
    [
      { opacity: 0, transform: 'scale(.94)' },
      { opacity: 1, transform: 'none' },
    ],
    { duration: IN_MS, easing: EASE, id: 'wm' },
  )
}

/** fade and shrink away where it stands; close() hides it once this has run */
function popOut(s: State) {
  if (still()) return
  s.el.classList.add('closing')
  s.el.animate(
    [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'scale(.96)' },
    ],
    { duration: OUT_MS, easing: EASE_OUT, fill: 'forwards', id: 'wm-out' },
  )
}

/**
 * Recompute the dock and write it to the DOM. `animate` false is for a live drag. `before` is a
 * snapshot taken before the change, for a change that moved the element itself (float, dock);
 * otherwise the DOM still shows the old layout here, so it is taken now.
 */
function relayout(animate = true, before?: Snap) {
  if (!dock) return
  const was = animate ? (before ?? snapshot()) : null
  placeLeft()
  const w = fitDock()
  for (const s of reg.values()) if (s.seat === 'dock') paintOne(s)
  placeTiles(w)
  document.documentElement.style.setProperty('--dock-w', `${Math.round(w)}px`)
  document.body.classList.toggle('pnl-dock', w > 0)
  if (was) glide(was)
  if (animate) settleAfter()
  else dispatchEvent(new Event('laika:panels-settled'))
  paintRail()
  save()
}

/**
 * The left dock: the panels that asked for the left side, in a row beside the rail at the widths
 * they want. `main` is padded by its width, so the map gives the room up the way it does for the
 * right dock, on the same slide.
 */
let dockL: HTMLElement | null = null
let leftW = 0
function placeLeft() {
  const open = dockedLeft()
  for (const s of open) {
    paintOne(s)
    s.el.style.setProperty('--pw', `${Math.round(seatW(s))}px`)
  }
  leftW = open.length
    ? open.reduce((n, s) => n + seatW(s), 0) + GAP_IN * (open.length - 1) + GAP_OUT * 2
    : 0
  document.documentElement.style.setProperty('--dock-l-w', `${Math.round(leftW)}px`)
  document.body.classList.toggle('pnl-dock-l', leftW > 0)
}

function paintOne(s: State) {
  s.el.classList.toggle('collapsed', s.collapsed)
  s.el.classList.toggle('wide', !!s.spec.wide)
}

// -------------------------------------------------------------------- the rail ----

/**
 * The rail is the workbench nav (#wbn) if it is there — one rail, not two. Until it exists
 * (panels can register before it is built) the buttons wait in a detached list.
 */
function railHost(): HTMLElement | null {
  rail ??= document.getElementById('wbn')
  return rail
}

/** which parents have their views folded open; kept so the rail looks the same next time */
const FOLDS = 'laika.panels.folds.v1'
const openFolds = new Set<string>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(FOLDS) ?? '[]') as string[]
    } catch {
      return []
    }
  })(),
)
const saveFolds = () => {
  try {
    localStorage.setItem(FOLDS, JSON.stringify([...openFolds]))
  } catch {}
}

const CHEVRON =
  '<i class="wbn-more" aria-hidden="true"><svg viewBox="0 0 10 10" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4l2 2 2-2"/></svg></i>'

/** the panels that are views of this one, in the order they registered */
const kidsOf = (id: string) => [...reg.values()].filter((k) => k.spec.under === id)

function railButton(s: State) {
  const b = document.createElement('button')
  b.type = 'button'
  b.dataset.pnl = s.spec.id
  if (s.spec.dev) b.dataset.dev = ''
  if (s.spec.under) b.dataset.under = s.spec.under
  b.className = s.spec.under ? 'wbn-sub' : ''
  const kl = keyLabel(s.spec)
  b.title = kl ? `${s.spec.title} (${kl})` : s.spec.title
  b.setAttribute('aria-label', s.spec.title)
  b.innerHTML = `${s.spec.icon}<span>${s.spec.title}</span><b class="wbn-badge" hidden></b>`
  let hover: ReturnType<typeof setTimeout> | null = null
  b.addEventListener('click', (e) => {
    // a click is a decision: the peek it may have interrupted must not land after it
    if (hover) clearTimeout(hover)
    hover = null
    // the chevron folds this panel's views out into the rail; the rest of the button opens it
    if ((e.target as HTMLElement).closest('.wbn-more')) {
      e.preventDefault()
      openFolds.has(s.spec.id) ? openFolds.delete(s.spec.id) : openFolds.add(s.spec.id)
      saveFolds()
      return paintRail()
    }
    toggle(s)
  })
  // hover peeks, click pins — so you can look without committing the layout to it
  b.addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'mouse' || s.seat !== 'closed') return
    hover = setTimeout(() => peek(s, true), PEEK_MS)
  })
  b.addEventListener('pointerleave', () => {
    if (hover) clearTimeout(hover)
    hover = null
    if (peeking === s) peek(s, false)
  })
  return b
}

/**
 * Put every registered button in the rail: in its group's slot if the rail offers one, and
 * directly under its parent when it is a view of another panel. Called again on every
 * registration, because a panel may register before the rail is built.
 */
function mountRail() {
  const host = railHost()
  if (!host) return
  let tail = host.querySelector<HTMLElement>('.wbn-panels')
  if (!tail) {
    tail = document.createElement('i')
    tail.className = 'wbn-panels'
    host.querySelector('.wbn-fill')?.before(tail) ?? host.appendChild(tail)
  }
  for (const s of reg.values()) {
    if (s.btn.isConnected) continue
    const parent = s.spec.under ? reg.get(s.spec.under) : undefined
    if (parent?.btn.isConnected) {
      // after the parent and any views of it already placed, so registration order holds
      const sibs = kidsOf(parent.spec.id).filter((k) => k !== s && k.btn.isConnected)
      ;(sibs.at(-1)?.btn ?? parent.btn).after(s.btn)
      continue
    }
    const slot = s.spec.group
      ? host.querySelector<HTMLElement>(`.wbn-slot[data-group="${CSS.escape(s.spec.group)}"]`)
      : null
    slot ? slot.appendChild(s.btn) : tail.before(s.btn)
  }
}

function paintRail() {
  for (const s of reg.values()) {
    s.btn.classList.toggle('on', s.seat !== 'closed')
    s.btn.classList.toggle('floating', s.seat === 'float')
    const kids = kidsOf(s.spec.id)
    // a parent grows a chevron once it has views; folded shut, an open view still shows
    if (kids.length && !s.btn.querySelector('.wbn-more'))
      s.btn.insertAdjacentHTML('beforeend', CHEVRON)
    const folded = kids.length ? openFolds.has(s.spec.id) : false
    s.btn.classList.toggle('folded-open', folded)
    s.btn.querySelector('.wbn-more')?.setAttribute('data-open', String(folded))
    if (s.spec.under) {
      const parent = reg.get(s.spec.under)
      s.btn.hidden = !(openFolds.has(s.spec.under) || s.seat !== 'closed' || !parent)
    }
    const badge = s.btn.querySelector<HTMLElement>('.wbn-badge')
    if (!badge) continue
    const raw = s.spec.badge?.()
    const n = typeof raw === 'number' ? raw : (raw?.count ?? 0)
    const tone = typeof raw === 'object' ? (raw.tone ?? '') : ''
    badge.hidden = n < 1
    badge.textContent = n > 9 ? '9+' : String(n)
    badge.dataset.tone = tone
  }
}

/** the rail badges, refreshed together: one place for anything that counts what waits on you */
export function refreshPanelBadges() {
  paintRail()
}

// ------------------------------------------------------------------ open / close ----

function ensureMounted(s: State) {
  if (s.mounted) return
  s.mounted = true
  const d = s.spec.mount(s.body)
  if (typeof d === 'function') s.dispose = d
}

function open(s: State, arg?: unknown) {
  // a click on a rail button lands mid-peek (hover peeks after PEEK_MS): the pin has to take the
  // element out of peek at once, or it docks still translated off the right edge
  if (peeking === s) peeking = null
  s.el.classList.remove('peek', 'peek-in')
  const was = s.seat
  const before = was === 'closed' ? snapshot() : undefined
  ensureMounted(s)
  s.el.hidden = false
  if (was === 'closed') {
    s.opened = ++seq
    s.collapsed = false
    const r = ruleFor(s)
    if (r.width) s.width = r.width
    s.width = s.want = clamp(s.width || def(s), min(s), max(s))
    // a panel sent to a workspace that is not on screen opens here, and its pin moves with it:
    // opening a panel must show it
    if (s.ws && !here(s)) s.ws = null
    else if (r.ws !== undefined && (!r.ws || wsList.some((w) => w.key === r.ws) || !wsList.length))
      s.ws = r.ws
    if (s.ws && !here(s)) s.ws = null
    paintWs(s)
    if (r.float) {
      if (r.rect) s.rect = { ...r.rect }
      s.seat = 'dock'
      toFloat(s, true)
      popIn(s)
    } else {
      s.seat = 'dock'
      seat(s)
      // the dock's width reveals it while it pops in
      relayout(true, before)
      s.spec.onVisible?.(true)
    }
  } else if (s.collapsed) {
    setCollapsed(s, false)
  }
  s.spec.onOpen?.(arg)
  focus(s)
  announce(s, true)
}

/** into its dock: the right one's tile tree, or the left one's row */
function seat(s: State) {
  if (isLeft(s)) {
    dockL?.appendChild(s.el)
    tree = T.remove(tree, s.spec.id)
    return
  }
  dock?.appendChild(s.el)
  tile(s)
}

/** into the tile tree, beside (or, in dwindle, inside) the focused panel */
function tile(s: State) {
  tree = T.remove(tree, s.spec.id)
  const at = focused && focused !== s && focused.seat === 'dock' ? focused.spec.id : null
  tree = T.insert(tree, s.spec.id, layout, at, at ? rects.get(at) : null)
}

/** out of the tile tree; the focus goes to the newest panel left, as Hyprland's does */
function untile(s: State) {
  tree = T.remove(tree, s.spec.id)
  if (focused === s) focus(docked().find((o) => o !== s) ?? null)
}

/**
 * The focused panel: the one with the ring and the one the window keys act on. `take` also
 * moves the keyboard into it, which is what a key that moves focus means.
 */
function focus(s: State | null, take = false) {
  if (focused !== s) {
    focused?.el.classList.remove('focused')
    focused = s
  }
  // (again even when it already was: a chat may have taken the ring meanwhile)
  s?.el.classList.add('focused')
  if (take && s && !s.el.contains(document.activeElement)) s.el.focus({ preventScroll: true })
}

function close(s: State) {
  if (s.seat === 'closed') return
  // focus left in a closing panel would keep the next keystroke from the app's shortcuts; if the
  // keyboard was in it, it goes on to the panel that takes the focus ring, as a window manager's does
  const had = s.el.contains(document.activeElement)
  if (had) (document.activeElement as HTMLElement).blur()
  if (full === s) (full = null), (fullWas = null), s.el.classList.remove('max')
  const before = snapshot()
  untile(s)
  if (had && focused) focus(focused, true)
  s.seat = 'closed'
  s.el.classList.remove('peek')
  s.spec.onVisible?.(false)
  popOut(s)
  // the others glide into the space while it fades, then it leaves the flow
  relayout(true, before)
  setTimeout(() => {
    if (s.seat !== 'closed') return
    s.el.hidden = true
    s.el.classList.remove('float', 'closing')
    for (const a of s.el.getAnimations()) if (a.id === 'wm-out') a.cancel()
  }, SLIDE_MS + 20)
  announce(s, false)
}

const toggle = (s: State, arg?: unknown) => (s.seat === 'closed' ? open(s, arg) : close(s))

function announce(s: State, on: boolean) {
  dispatchEvent(new CustomEvent('laika:panel', { detail: { id: s.spec.id, open: on } }))
  paintRail()
}

function setCollapsed(s: State, on: boolean) {
  if (s.collapsed === on) return
  s.collapsed = on
  if (!on) s.width = clamp(s.want || def(s), min(s), max(s))
  relayout()
  s.spec.onVisible?.(!on)
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

// ---------------------------------------------------------------------- peeking ----

/**
 * A peek shows the panel over the layout without giving it any space: it is the same element,
 * moved to an absolute box on the right and slid in on a transform, so it costs a composite
 * and changes no layout. Clicking the rail button pins it, which is just open().
 */
let peeking: State | null = null

function peek(s: State, on: boolean) {
  // only a closed panel peeks: one already docked or floating is already on screen
  if (on && s.seat !== 'closed') return
  if (on) {
    if (peeking && peeking !== s) peek(peeking, false)
    ensureMounted(s)
    peeking = s
    s.el.hidden = false
    s.el.style.setProperty('--pw', `${Math.round(clamp(s.width || def(s), min(s), max(s)))}px`)
    document.querySelector('main')?.appendChild(s.el)
    s.el.classList.add('peek')
    // one frame at translateX(100%) so the transition has something to run from
    requestAnimationFrame(() => s.el.classList.add('peek-in'))
    s.spec.onVisible?.(true)
  } else {
    if (peeking !== s) return
    peeking = null
    s.el.classList.remove('peek-in')
    setTimeout(() => {
      if (peeking === s || s.seat !== 'closed') return
      s.el.classList.remove('peek')
      s.el.hidden = true
      s.spec.onVisible?.(false)
    }, SLIDE_MS + 20)
  }
}

// ------------------------------------------------------------------- float / dock ----

/** `instant` is for a tear-off under the pointer, which must track the drag from the first frame */
function toFloat(s: State, instant = false) {
  if (s.seat === 'float') return
  const before = instant ? undefined : snapshot()
  const r = s.el.getBoundingClientRect()
  s.rect ??= {
    x: Math.max(70, r.left || innerWidth - def(s) - 40),
    y: Math.max(60, r.top || 90),
    w: Math.round(r.width) || def(s),
    h: Math.round(r.height) || Math.min(620, innerHeight - 140),
  }
  tree = T.remove(tree, s.spec.id)
  s.seat = 'float'
  s.collapsed = false
  s.el.classList.remove('peek', 'peek-in')
  s.el.classList.add('float')
  document.body.appendChild(s.el)
  placeFloat(s)
  relayout(!instant, before)
  s.el.querySelector('.pnl-float')?.replaceChildren()
  ;(s.el.querySelector('.pnl-float') as HTMLElement).innerHTML = DOCK_ICON
  s.el.querySelector('.pnl-float')?.setAttribute('title', 'Put back in the dock')
  s.spec.onVisible?.(true)
  announce(s, true)
}

function toDock(s: State) {
  if (s.seat !== 'float') return
  const before = snapshot()
  s.seat = 'dock'
  s.opened = ++seq
  s.el.classList.remove('float')
  s.el.style.removeProperty('left')
  s.el.style.removeProperty('top')
  s.el.style.removeProperty('height')
  ;(s.el.querySelector('.pnl-float') as HTMLElement).innerHTML = FLOAT_ICON
  s.el.querySelector('.pnl-float')?.setAttribute('title', 'Tear off to float')
  seat(s)
  focus(s)
  relayout(true, before)
  announce(s, true)
}

/** the highest a float may go: under the top bar, which in the desktop shell drags the window */
const floatTop = () =>
  (document.querySelector('body > header')?.getBoundingClientRect().bottom ?? 0) + GAP_OUT

function placeFloat(s: State) {
  if (!s.rect) return
  // fullscreen fills the work area whatever the panel's own limits are
  if (s === full) s.rect = workArea()
  const w = s === full ? s.rect.w : clamp(s.rect.w, min(s), Math.min(max(s), innerWidth - 40))
  const h = s === full ? s.rect.h : clamp(s.rect.h, 160, innerHeight - floatTop() - GAP_OUT)
  s.rect.x = clamp(s.rect.x, 8 - w + 120, innerWidth - 120)
  // the title bar is the handle, so it always stays in reach
  s.rect.y = clamp(s.rect.y, floatTop(), innerHeight - 60)
  s.el.style.left = `${Math.round(s.rect.x)}px`
  s.el.style.top = `${Math.round(s.rect.y)}px`
  s.el.style.setProperty('--pw', `${Math.round(w)}px`)
  s.el.style.height = `${Math.round(h)}px`
}

// -------------------------------------------------------------------- dragging ----

/**
 * The title bar drags. In the dock a drag that pulls far enough away tears the panel off to
 * float; floating, it moves the window; dropped over the rail it docks again. One pointer
 * handler for all three, so there is one place the rules live.
 */
function bindDrag(s: State) {
  const bar = s.el.querySelector<HTMLElement>('.pnl-bar')
  if (!bar) return
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    const x0 = e.clientX
    const y0 = e.clientY
    const from = s.seat
    const start = s.rect ? { ...s.rect } : null
    let tore = from === 'float'
    bar.setPointerCapture(e.pointerId)
    document.body.classList.add('pnl-dragging')

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0
      const dy = ev.clientY - y0
      if (!tore) {
        // a deliberate pull, not a stray click on the title
        if (Math.hypot(dx, dy) < 26) return
        tore = true
        s.rect = {
          x: s.el.getBoundingClientRect().left + dx,
          y: s.el.getBoundingClientRect().top + dy,
          w: Math.round(s.width) || def(s),
          h: Math.round(s.el.getBoundingClientRect().height) || 520,
        }
        toFloat(s, true)
        return
      }
      if (!s.rect) return
      s.rect.x = (start?.x ?? s.rect.x) + dx
      s.rect.y = (start?.y ?? s.rect.y) + dy
      // over the rail: say so, and dock on release
      const overRail = ev.clientX < (railHost()?.getBoundingClientRect().right ?? 0) + 24
      railHost()?.classList.toggle('drop', overRail)
      placeFloat(s)
    }
    const up = (ev: PointerEvent) => {
      bar.releasePointerCapture(ev.pointerId)
      bar.removeEventListener('pointermove', move)
      bar.removeEventListener('pointerup', up)
      bar.removeEventListener('pointercancel', up)
      document.body.classList.remove('pnl-dragging')
      const overRail = ev.clientX < (railHost()?.getBoundingClientRect().right ?? 0) + 24
      railHost()?.classList.remove('drop')
      if (tore && overRail) toDock(s)
      else save()
    }
    bar.addEventListener('pointermove', move)
    bar.addEventListener('pointerup', up)
    bar.addEventListener('pointercancel', up)
  })
}

// -------------------------------------------------------------------- resizing ----

/**
 * The left edge resizes. Snap widths pull within SNAP_PX and light the handle; dragged below
 * the panel's minimum it collapses to an icon. Arrow keys nudge, double-click resets — the
 * same manners the widget rails already have.
 */
function bindResize(s: State) {
  const edge = s.el.querySelector<HTMLElement>('.pnl-edge')
  if (!edge) return
  const apply = (px: number, live: boolean) => {
    if (px < min(s) - 40) {
      if (!s.collapsed) {
        s.collapsed = true
        s.spec.onVisible?.(false)
      }
    } else {
      if (s.collapsed) {
        s.collapsed = false
        s.spec.onVisible?.(true)
      }
      s.width = s.want = clamp(px, min(s), max(s))
    }
    relayout(!live)
  }
  // stacked, the bottom edge moves the line between this panel and the one below
  const edgeY = s.el.querySelector<HTMLElement>('.pnl-edge-y')
  edgeY?.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    let y = e.clientY
    const h = dock?.clientHeight || innerHeight
    edgeY.setPointerCapture(e.pointerId)
    document.body.classList.add('pnl-resizing-y')
    const move = (ev: PointerEvent) => {
      const next = T.nudgeRatio(tree, s.spec.id, (ev.clientY - y) / h, true)
      y = ev.clientY
      if (next) (tree = next), relayout(false)
    }
    const up = (ev: PointerEvent) => {
      edgeY.releasePointerCapture(ev.pointerId)
      edgeY.removeEventListener('pointermove', move)
      edgeY.removeEventListener('pointerup', up)
      edgeY.removeEventListener('pointercancel', up)
      document.body.classList.remove('pnl-resizing-y')
      save()
    }
    edgeY.addEventListener('pointermove', move)
    edgeY.addEventListener('pointerup', up)
    edgeY.addEventListener('pointercancel', up)
  })
  edge.addEventListener('dblclick', () => {
    s.collapsed = false
    s.width = s.want = def(s)
    relayout()
  })
  edge.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 48 : 16
    if (e.key === 'Home') return apply(def(s), false)
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const wider = isLeft(s) ? e.key === 'ArrowRight' : e.key === 'ArrowLeft'
    apply(s.width + (wider ? step : -step), false)
  })
  edge.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const x0 = e.clientX
    const w0 = s.collapsed ? min(s) : s.width
    edge.setPointerCapture(e.pointerId)
    edge.classList.add('active')
    document.body.classList.add('pnl-resizing')
    const move = (ev: PointerEvent) => {
      // a left-docked panel's edge is on its right, so dragging right widens it
      const raw = isLeft(s) ? w0 + (ev.clientX - x0) : w0 - (ev.clientX - x0)
      const hit = snaps(s).find((n) => Math.abs(raw - n) <= SNAP_PX)
      edge.classList.toggle('snap', hit !== undefined)
      apply(hit ?? raw, true)
    }
    const up = (ev: PointerEvent) => {
      edge.releasePointerCapture(ev.pointerId)
      edge.removeEventListener('pointermove', move)
      edge.removeEventListener('pointerup', up)
      edge.classList.remove('active', 'snap')
      document.body.classList.remove('pnl-resizing')
      save()
    }
    edge.addEventListener('pointermove', move)
    edge.addEventListener('pointerup', up)
    edge.addEventListener('pointercancel', up)
  })
}

// ----------------------------------------------------------------- what it keeps ----

type Saved = {
  open: { id: string; width: number; collapsed: boolean }[]
  floats: Record<string, { x: number; y: number; w: number; h: number }>
  layout?: T.Layout
  /** the tile tree, so a dwindle or a stack comes back the shape it was */
  tree?: T.Tree
  /** panels sent to one workspace, by the workspace's key */
  ws?: Record<string, string>
}

function save() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    const out: Saved = { open: [], floats: {}, layout, tree, ws: {} }
    for (const s of reg.values()) if (s.ws && out.ws) out.ws[s.spec.id] = s.ws
    for (const s of [...docked(), ...dockedLeft().reverse()])
      out.open.unshift({ id: s.spec.id, width: Math.round(s.width), collapsed: s.collapsed })
    for (const s of reg.values()) {
      if (s.seat === 'float' && s.rect) out.floats[s.spec.id] = { ...s.rect }
    }
    try {
      localStorage.setItem(STORE, JSON.stringify(out))
    } catch {}
    learn()
  }, 250)
}

function read(): Saved | null {
  try {
    const raw = localStorage.getItem(STORE)
    return raw ? (JSON.parse(raw) as Saved) : null
  } catch {
    return null
  }
}

/**
 * Put back what was open last time. Called once the app has registered its panels and built its
 * rail, so a panel that no longer exists simply does not come back.
 */
export function restorePanels() {
  // the rail may have been built after the panels registered: put their buttons in it now
  mountRail()
  paintRail()
  document.body.dataset.wmLayout = layout
  const saved = read()
  if (!saved) return
  if (saved.layout && T.LAYOUTS.includes(saved.layout)) layout = saved.layout
  for (const [id, key] of Object.entries(saved.ws ?? {})) {
    const s = reg.get(id)
    if (s) s.ws = key
  }
  document.body.dataset.wmLayout = layout
  for (const [id, r] of Object.entries(saved.floats ?? {})) {
    const s = reg.get(id)
    if (s) s.rect = r
  }
  for (const rec of saved.open ?? []) {
    const s = reg.get(rec.id)
    if (!s || !usable(s)) continue
    s.width = s.want = clamp(rec.width || def(s), min(s), max(s))
    open(s)
    if (rec.collapsed) setCollapsed(s, true)
  }
  // the saved shape, if it still names exactly the panels that came back
  const back = new Set(T.leaves(tree))
  const was = T.leaves(saved.tree ?? null)
  if (was.length === back.size && was.every((id) => back.has(id))) {
    tree = saved.tree ?? null
    relayout(false)
  }
  for (const id of Object.keys(saved.floats ?? {})) {
    const s = reg.get(id)
    if (!s || s.seat === 'float') continue
    if (s.seat === 'closed') open(s)
    toFloat(s)
  }
}

// -------------------------------------------------------------------- the chrome ----

/**
 * A status control in the header, for the things that must stay visible whatever is open —
 * the autopilot switch, a kill switch, a spend readout. Not a panel: it has no rail button,
 * no shortcut and no width. Keep it small; the header is not a dashboard.
 */
export function registerChrome(spec: {
  id: string
  side?: 'left' | 'right'
  mount: (host: HTMLElement) => void | (() => void)
}) {
  const host = document.createElement('div')
  host.className = 'chrome-slot'
  host.dataset.chrome = spec.id
  const nav = document.getElementById('tools')
  if (spec.side === 'left') nav?.before(host)
  else nav?.after(host)
  spec.mount(host)
  return host
}

// ------------------------------------------------------------------ registration ----

export function registerPanel(spec: PanelSpec): PanelHandle {
  if (reg.has(spec.id)) throw new Error(`panel "${spec.id}" is registered twice`)
  // every show and hide also reaches activity.ts, which stops what serves a panel nobody sees
  const onVisible = spec.onVisible
  spec = {
    ...spec,
    onVisible: (on) => {
      setPanelShown(spec.id, on)
      onVisible?.(on)
    },
  }
  const s: State = {
    spec,
    el: null as unknown as HTMLElement,
    body: null as unknown as HTMLElement,
    btn: null as unknown as HTMLButtonElement,
    seat: 'closed',
    width: spec.width?.default ?? (spec.wide ? DEF_WIDE : DEF_W),
    want: spec.width?.default ?? (spec.wide ? DEF_WIDE : DEF_W),
    collapsed: false,
    rect: null,
    mounted: false,
    opened: 0,
    ws: null,
  }
  s.el = frame(s)
  s.body = s.el.querySelector('.pnl-body') as HTMLElement
  s.btn = railButton(s)
  bindDrag(s)
  bindResize(s)
  reg.set(spec.id, s)
  ensureDock()
  mountRail()
  paintRail()
  return {
    id: spec.id,
    open: (arg) => open(s, arg),
    close: () => close(s),
    toggle: (arg) => toggle(s, arg),
    isOpen: () => s.seat !== 'closed',
    isFloating: () => s.seat === 'float',
    float: () => toFloat(s),
    dock: () => toDock(s),
    refreshBadge: () => paintRail(),
  }
}

export const getPanel = (id: string) => {
  const s = reg.get(id)
  if (!s) return undefined
  return {
    id,
    open: (arg?: unknown) => open(s, arg),
    close: () => close(s),
    toggle: (arg?: unknown) => toggle(s, arg),
    isOpen: () => s.seat !== 'closed',
    isFloating: () => s.seat === 'float',
    float: () => toFloat(s),
    dock: () => toDock(s),
    refreshBadge: () => paintRail(),
  } as PanelHandle
}

/** every panel, for the command palette. The system owns this so a panel cannot be unreachable. */
export function panelCommands() {
  return [...reg.values()].filter(usable).map((s) => {
    const parent = s.spec.under ? reg.get(s.spec.under)?.spec.title : undefined
    return {
      id: `pnl-${s.spec.id}`,
      // a view reads as its feature's view, so "decisions" and "autopilot" both find it
      title: parent ? `${parent}: ${s.spec.title}` : s.spec.title,
      hint: s.spec.hint ?? 'panel',
      ...(keyLabel(s.spec) ? { keys: keyLabel(s.spec) } : {}),
      terms: `panel window ${parent ?? ''} ${s.spec.title} ${s.spec.terms ?? ''}`,
      run: () => open(s),
    }
  })
}

/** arrange the docked panels another way; the newest keeps the pride of place in each */
export function setTileLayout(next: T.Layout) {
  if (!T.LAYOUTS.includes(next)) return
  layout = next
  document.body.dataset.wmLayout = next
  tree = T.rebuild(
    docked().map((s) => s.spec.id),
    next,
    rects,
  )
  relayout()
}

/** columns → dwindle → master → columns, Hyprland's layout cycle */
export function cycleLayout(by = 1) {
  const i = T.LAYOUTS.indexOf(layout)
  setTileLayout(T.LAYOUTS[(i + by + T.LAYOUTS.length) % T.LAYOUTS.length] as T.Layout)
  return layout
}

export const currentLayout = () => layout

// ---------------------------------------------------------------- the window keys ----

/**
 * Keyboard first, the Hyprland way: one modifier family for everything that moves a window,
 * from wherever the keyboard is — a panel, the map, or a chat:
 *
 *   ⌥⌘ ← ↑ → ↓      move focus          ⌥⌘V   float / tile (panels)
 *   ⌥⌘⇧ ← ↑ → ↓     move the window     ⌥⌘↩   fullscreen
 *   ⌥⌘ - / =        narrower / wider    ⌥⌘/   next layout
 *   ⌥⌘⇧ - / =       shorter / taller    ⌥⌘W   close
 *
 * The windows are the panels and the chat groups: sessions.ts hands its groups in as regions
 * (registerRegions), so focus moves from a chat to the group beside it, to the next project
 * column, and on into the panels, by where they are on screen. A chat group moves, resizes,
 * goes full and closes the chats pane's own way; it does not float.
 *
 * hjkl are not bound: ⌥⌘H is the system's Hide Others and ⌥⌘L already opens a panel.
 */
const DIRS: Record<string, T.Dir> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
}

/** a window that is not a panel — a chat group — as far as the window keys are concerned */
export type Region = {
  id: string
  el: HTMLElement
  /** the one its pane would act on now (the chats pane's focused group) */
  current?: boolean
  focus(): void
  /** each returns false when it had nothing to do */
  move?(dir: T.Dir): boolean
  resize?(by: number, axis: 'x' | 'y'): boolean
  full?(): boolean
  close?(): boolean
}
const regionSources: (() => Region[])[] = []
/** hand the window keys a list of regions; called whenever they need it, so keep it cheap */
export function registerRegions(list: () => Region[]) {
  regionSources.push(list)
}
const regions = () =>
  regionSources
    .flatMap((f) => f())
    .filter((r) => r.el.isConnected && r.el.getBoundingClientRect().width > 0)

/** the window the keys act on: the panel or chat group the keyboard is in, else the focused panel */
type Win = { panel: State } | { region: Region }
function current(): Win | null {
  const a = document.activeElement as HTMLElement | null
  const p = a?.closest('.pnl')
  const s = p ? [...reg.values()].find((x) => x.el === p && x.seat !== 'closed') : undefined
  if (s) return { panel: s }
  if (a && a !== document.body) {
    const rs = regions()
    const r =
      rs.find((x) => x.el.contains(a)) ?? (a.closest('#ss') ? rs.find((x) => x.current) : undefined)
    if (r) return { region: r }
  }
  const t = target()
  return t ? { panel: t } : null
}

/** every window on screen, where it is: panels as `p:<id>`, regions as `r:<id>` */
function screenRects() {
  const out = new Map<string, T.Rect>()
  for (const s of reg.values()) {
    if (s.seat === 'closed' || s.el.hidden) continue
    const r = s.el.getBoundingClientRect()
    if (r.width) out.set(`p:${s.spec.id}`, { x: r.left, y: r.top, w: r.width, h: r.height })
  }
  for (const g of regions()) {
    const r = g.el.getBoundingClientRect()
    out.set(`r:${g.id}`, { x: r.left, y: r.top, w: r.width, h: r.height })
  }
  return out
}

/** what the palette's window commands act on when nothing has the keyboard: a panel */
function target(): State | null {
  if (focused && focused.seat !== 'closed') return focused
  return (
    docked()[0] ??
    dockedLeft().at(-1) ??
    [...reg.values()].find((s) => s.seat === 'float' && here(s)) ??
    null
  )
}

/** the ring belongs to the window with the keyboard; a chat group has its own, so the panel's goes */
const ringOff = () => focused?.el.classList.remove('focused')
addEventListener('focusin', (e) => {
  const t = e.target as HTMLElement | null
  if (t && !t.closest('.pnl') && regions().some((r) => r.el.contains(t))) ringOff()
})

function focusDir(dir: T.Dir) {
  const w = current()
  if (!w) return regions()[0]?.focus()
  const from = 'panel' in w ? `p:${w.panel.spec.id}` : `r:${w.region.id}`
  const next = T.neighbour(screenRects(), from, dir)
  if (!next) {
    // nothing that way: still land the keyboard in the window it is on
    if ('panel' in w) focus(w.panel, true)
    return
  }
  if (next.startsWith('p:')) {
    const s = reg.get(next.slice(2))
    if (s) focus(s, true)
    return
  }
  const r = regions().find((x) => `r:${x.id}` === next)
  if (r) ringOff(), r.focus()
}

/** swap with the neighbour that way; a float is nudged instead; a chat group moves its own way */
function moveDir(dir: T.Dir) {
  const w = current()
  if (!w) return
  if ('region' in w) return void w.region.move?.(dir)
  const s = w.panel
  if (s.seat === 'float' && s.rect) {
    const step = 48
    const before = snapshot()
    s.rect.x += dir === 'left' ? -step : dir === 'right' ? step : 0
    s.rect.y += dir === 'up' ? -step : dir === 'down' ? step : 0
    placeFloat(s)
    glide(before)
    return save()
  }
  if (s.seat !== 'dock' || s.collapsed) return
  const other = T.neighbour(
    new Map([...rects].filter(([id]) => reg.get(id)?.seat === 'dock')),
    s.spec.id,
    dir,
  )
  if (!other) return
  tree = T.swap(tree, s.spec.id, other)
  relayout()
  focus(s, true)
}

/** wider or narrower (`axis` x), taller or shorter (`axis` y) */
function resizeBy(by: number, axis: 'x' | 'y') {
  const w = current()
  if (!w) return
  if ('region' in w) return void w.region.resize?.(by, axis)
  const s = w.panel
  if (s.seat === 'float' && s.rect) {
    const before = snapshot()
    if (axis === 'x') s.rect.w = clamp(s.rect.w + by * 48, min(s), max(s))
    else s.rect.h = clamp(s.rect.h + by * 40, 160, innerHeight - 60)
    placeFloat(s)
    glide(before)
    return save()
  }
  if (s.seat !== 'dock') return
  if (axis === 'x') {
    s.collapsed = false
    s.width = s.want = clamp(s.want + by * 48, min(s), max(s))
    return relayout()
  }
  const next = T.nudgeRatio(tree, s.spec.id, by * 0.06)
  if (next) (tree = next), relayout()
}

/** panels float; a chat group does not, so from a chat this does nothing */
function toggleFloat() {
  const w = current()
  if (!w || !('panel' in w)) return
  const s = w.panel
  if (full === s) setFull(null)
  s.seat === 'float' ? toDock(s) : toFloat(s)
  focus(s, true)
}

function closeFocused() {
  const w = current()
  if (!w) return
  if ('region' in w) return void w.region.close?.()
  close(w.panel)
}

/**
 * Fullscreen, Hyprland's "maximised": the panel takes the whole work area under the top bar,
 * over the tiles and the chats, and gives it back exactly as it was.
 */
let full: State | null = null
let fullWas: { seat: Seat; rect: State['rect'] } | null = null

function workArea() {
  const top =
    (document.querySelector('body > header')?.getBoundingClientRect().bottom ?? 0) + GAP_OUT
  const left = (railHost()?.getBoundingClientRect().right ?? 0) + GAP_OUT
  return { x: left, y: top, w: innerWidth - left - GAP_OUT, h: innerHeight - top - GAP_OUT }
}

function setFull(s: State | null) {
  if (full && full !== s) {
    const was = full
    const back = fullWas
    full = null
    fullWas = null
    was.el.classList.remove('max')
    if (back && was.seat !== 'closed') {
      if (back.seat === 'dock') {
        was.rect = back.rect
        toDock(was)
      } else {
        const before = snapshot()
        was.rect = back.rect
        placeFloat(was)
        glide(before)
      }
    }
  }
  if (!s || s.seat === 'closed') return save()
  full = s
  fullWas = { seat: s.seat, rect: s.rect ? { ...s.rect } : null }
  s.rect = workArea()
  s.el.classList.add('max')
  if (s.seat === 'float') {
    const before = snapshot()
    placeFloat(s)
    glide(before)
  } else toFloat(s)
  focus(s, true)
}

const toggleFull = () => {
  const w = current()
  if (!w) return
  if ('region' in w) return void w.region.full?.()
  setFull(full === w.panel ? null : w.panel)
}

/** the window commands, for the palette: every key above is also a command there */
export function windowCommands() {
  const dirs: [T.Dir, string][] = [
    ['left', '←'],
    ['right', '→'],
    ['up', '↑'],
    ['down', '↓'],
  ]
  return [
    ...dirs.map(([d, k]) => ({
      id: `wm-focus-${d}`,
      title: `Window: focus ${d}`,
      keys: `⌥⌘${k}`,
      hint: 'panels',
      terms: 'window focus move tile',
      run: () => focusDir(d),
    })),
    ...dirs.map(([d, k]) => ({
      id: `wm-move-${d}`,
      title: `Window: move ${d}`,
      keys: `⌥⌘⇧${k}`,
      hint: 'panels',
      terms: 'window swap move tile',
      run: () => moveDir(d),
    })),
    {
      id: 'wm-wider',
      title: 'Window: wider',
      keys: '⌥⌘=',
      hint: 'panels',
      terms: 'window resize grow',
      run: () => resizeBy(1, 'x'),
    },
    {
      id: 'wm-narrower',
      title: 'Window: narrower',
      keys: '⌥⌘-',
      hint: 'panels',
      terms: 'window resize shrink',
      run: () => resizeBy(-1, 'x'),
    },
    {
      id: 'wm-taller',
      title: 'Window: taller',
      keys: '⌥⌘⇧=',
      hint: 'panels',
      terms: 'window resize grow height',
      run: () => resizeBy(1, 'y'),
    },
    {
      id: 'wm-shorter',
      title: 'Window: shorter',
      keys: '⌥⌘⇧-',
      hint: 'panels',
      terms: 'window resize shrink height',
      run: () => resizeBy(-1, 'y'),
    },
    {
      id: 'wm-float',
      title: 'Window: float / tile',
      keys: '⌥⌘V',
      hint: 'panels',
      terms: 'window float tile pop out',
      run: toggleFloat,
    },
    {
      id: 'wm-full',
      title: 'Window: fullscreen',
      keys: '⌥⌘↩',
      hint: 'panels',
      terms: 'window maximise maximize fullscreen',
      run: toggleFull,
    },
    {
      id: 'wm-close',
      title: 'Window: close',
      keys: '⌥⌘W',
      hint: 'panels',
      terms: 'window close',
      run: closeFocused,
    },
    {
      id: 'wm-layout',
      title: 'Window: next layout',
      keys: '⌥⌘/',
      hint: 'columns → dwindle → master',
      terms: 'window layout tiling cycle',
      run: () => cycleLayout(),
    },
    ...T.LAYOUTS.map((l) => ({
      id: `wm-layout-${l}`,
      title: `Window layout: ${l}`,
      hint: layout === l ? 'current' : 'panels',
      terms: 'window layout tiling',
      run: () => setTileLayout(l),
    })),
  ]
}

addEventListener(
  'keydown',
  (e) => {
    if (!e.altKey || !e.metaKey || e.ctrlKey) return
    const active = document.activeElement as HTMLElement | null
    const w = current()
    const inPanel = !!w && 'panel' in w && w.panel.el.contains(active)
    const inRegion = !!w && 'region' in w
    // a field that is in no window (the header's search) keeps its keys
    if (
      !inPanel &&
      !inRegion &&
      active &&
      active !== document.body &&
      active.closest('input, textarea, select, [contenteditable]')
    )
      return
    const dir = DIRS[e.code]
    let act: (() => void) | null = null
    if (dir && !e.shiftKey) act = () => focusDir(dir)
    // from the map ⌥⌘⇧←/→ still shifts the chats' columns (sessions.ts); from a window it moves it
    else if (dir && e.shiftKey && (inPanel || inRegion || dir === 'up' || dir === 'down'))
      act = () => moveDir(dir)
    else if (e.code === 'Equal') act = () => resizeBy(1, e.shiftKey ? 'y' : 'x')
    else if (e.code === 'Minus') act = () => resizeBy(-1, e.shiftKey ? 'y' : 'x')
    else if (e.code === 'KeyV' && !e.shiftKey) act = toggleFloat
    else if (e.code === 'Enter' && !e.shiftKey) act = toggleFull
    else if (e.code === 'KeyW' && !e.shiftKey) act = closeFocused
    else if (e.code === 'Slash' && !e.shiftKey) act = () => cycleLayout()
    // a layout can be chosen with nothing open (it is how the next panels will tile); every
    // other key needs a window to act on
    if (!act || (e.code !== 'Slash' && !w && !regions().length)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    act()
  },
  true,
)

// ----------------------------------------------------------------------- rules ----

/**
 * Window rules, the Hyprland idea kept small: per panel, whether it floats (and where), how
 * wide it tiles and which workspace it lives on. A panel's spec may give a first rule; after
 * that the rule is whatever you last did with it, learned every time the dock is saved, so a
 * panel you float comes back floating where you left it, next time and after a restart.
 */
const RULES = 'laika.panels.rules.v1'
type Learned = {
  float: boolean
  rect?: { x: number; y: number; w: number; h: number } | null
  width?: number
  ws?: string | null
}
const rules: Record<string, Learned> = (() => {
  try {
    return JSON.parse(localStorage.getItem(RULES) ?? '{}') as Record<string, Learned>
  } catch {
    return {}
  }
})()

/** what the panel should open as: what it learned, else its spec's rule */
function ruleFor(s: State): Learned {
  const got = rules[s.spec.id]
  if (got) return got
  const r = s.spec.rule
  if (!r) return { float: false }
  const area = workArea()
  const w = r.rect?.w ?? def(s)
  const h = r.rect?.h ?? Math.min(620, area.h - 40)
  return {
    float: !!r.float,
    ...(r.width ? { width: r.width } : {}),
    rect: r.float
      ? { x: r.rect?.x ?? area.x + area.w - w - 24, y: r.rect?.y ?? area.y + 24, w, h }
      : null,
  }
}

/** learn from every panel that is up; fullscreen is a moment, so it learns what was under it */
function learn() {
  let changed = false
  for (const s of reg.values()) {
    if (s.seat === 'closed') continue
    const seat = s === full && fullWas ? fullWas.seat : s.seat
    const rect = s === full && fullWas ? fullWas.rect : s.rect
    const next: Learned = {
      float: seat === 'float',
      rect: seat === 'float' && rect ? { ...rect } : null,
      width: Math.round(s.want),
      ws: s.ws,
    }
    if (JSON.stringify(rules[s.spec.id]) === JSON.stringify(next)) continue
    rules[s.spec.id] = next
    changed = true
  }
  if (!changed) return
  try {
    localStorage.setItem(RULES, JSON.stringify(rules))
  } catch {}
}

/** forget what a panel learned (or every panel, with no id): it opens by its spec again */
export function forgetRules(id?: string) {
  for (const k of Object.keys(rules)) if (!id || k === id) delete rules[k]
  try {
    localStorage.setItem(RULES, JSON.stringify(rules))
  } catch {}
}

export function ruleCommands() {
  return [
    {
      id: 'wm-rules-forget',
      title: 'Window rules: forget them all',
      hint: 'panels open as they first did',
      terms: 'window rules reset forget defaults',
      run: () => forgetRules(),
    },
    ...[...reg.values()]
      .filter((s) => rules[s.spec.id])
      .map((s) => {
        const r = rules[s.spec.id] as Learned
        const what = r.float ? 'floats' : `tiles at ${r.width ?? def(s)}px`
        const where = r.ws ? ` on ${wsList.find((w) => w.key === r.ws)?.name ?? 'a workspace'}` : ''
        return {
          id: `wm-rule-${s.spec.id}`,
          title: `Window rule: ${s.spec.title} ${what}${where}`,
          hint: 'run to forget it',
          terms: 'window rules forget',
          run: () => forgetRules(s.spec.id),
        }
      }),
  ]
}

// ------------------------------------------------------------------ workspaces ----

/**
 * Each project tab in the chats pane is a workspace (sessions.ts says which there are and which
 * are on screen, as `laika:workspaces`). A panel lives on every workspace until it is sent to
 * one; then it shows only while that project is on screen, and is hidden — with onVisible(false),
 * so it stops everything it runs — while another is. ⌃1–9 switch, ⌃⇧1–9 send the focused panel.
 */
type WsInfo = { key: string; name: string; colour: string }
let wsList: WsInfo[] = []
/** the projects on screen; null until the chats pane has said, and then every panel shows */
let wsShown: Set<string> | null = null

function here(s: State) {
  return !s.ws || !wsShown || wsShown.has(s.ws) || !wsList.some((w) => w.key === s.ws)
}

/** show what belongs here and hide what does not, gliding the tiles into the new shape */
function applyWorkspaces() {
  const before = snapshot()
  for (const s of reg.values()) {
    paintWs(s)
    if (s.seat === 'closed') continue
    const on = here(s)
    if (!on && !s.el.hidden) {
      s.el.hidden = true
      s.spec.onVisible?.(false)
    } else if (on && s.el.hidden) {
      s.el.hidden = false
      if (!s.collapsed) s.spec.onVisible?.(true)
    }
  }
  if (focused && !here(focused)) focus(docked()[0] ?? null)
  relayout(true, before)
}

/** the chip in a panel's title bar that says which workspace it is on */
function paintWs(s: State) {
  const chip = s.el.querySelector<HTMLElement>('.pnl-ws')
  if (!chip) return
  const w = s.ws ? wsList.find((x) => x.key === s.ws) : null
  chip.hidden = !w
  if (!w) return
  chip.textContent = w.name
  chip.style.setProperty('--ws', w.colour)
  chip.title = `On ${w.name} only · ⌃⇧0 to show it everywhere`
}

addEventListener('laika:workspaces', (e) => {
  const d = (e as CustomEvent<{ list: WsInfo[]; shown: string[] }>).detail
  if (!d) return
  wsList = d.list ?? []
  wsShown = new Set(d.shown ?? [])
  applyWorkspaces()
})

/** switch to the nth project tab (1-based), as ⌃1–9 does */
export function goWorkspace(n: number) {
  const w = wsList[n - 1]
  if (w) dispatchEvent(new CustomEvent('laika:workspace-go', { detail: { key: w.key } }))
}

/** send the focused panel to the nth workspace; 0 puts it back on every workspace */
export function sendToWorkspace(n: number) {
  const s = target()
  if (!s) return
  const w = n > 0 ? wsList[n - 1] : null
  if (n > 0 && !w) return
  s.ws = w ? w.key : null
  applyWorkspaces()
  save()
}

addEventListener(
  'keydown',
  (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return
    const n = /^Digit([0-9])$/.exec(e.code)?.[1]
    if (n === undefined) return
    if (e.shiftKey) {
      if (!target()) return
      sendToWorkspace(Number(n))
    } else {
      if (n === '0' || !wsList[Number(n) - 1]) return
      goWorkspace(Number(n))
    }
    e.preventDefault()
    e.stopImmediatePropagation()
  },
  true,
)

/** the workspace commands, for the palette */
export function workspaceCommands() {
  return [
    ...wsList.slice(0, 9).flatMap((w, i) => [
      {
        id: `ws-go-${i + 1}`,
        title: `Workspace ${i + 1}: ${w.name}`,
        keys: `⌃${i + 1}`,
        hint: wsShown?.has(w.key) ? 'on screen' : 'project',
        terms: 'workspace project switch go',
        run: () => goWorkspace(i + 1),
      },
      {
        id: `ws-send-${i + 1}`,
        title: `Window: send to workspace ${i + 1} (${w.name})`,
        keys: `⌃⇧${i + 1}`,
        hint: 'panels',
        terms: 'window workspace move send project',
        run: () => sendToWorkspace(i + 1),
      },
    ]),
    {
      id: 'ws-send-all',
      title: 'Window: show on every workspace',
      keys: '⌃⇧0',
      hint: 'panels',
      terms: 'window workspace sticky pin all',
      run: () => sendToWorkspace(0),
    },
  ]
}

/** true while any panel has the width it asked for — used by the shortcut guards in main.ts */
export const anyPanelOpen = () => [...reg.values()].some((s) => s.seat !== 'closed')

/** close whatever is on top; what Escape means when nothing else claims it */
export function closeTopPanel() {
  if (peeking) return peek(peeking, false), true
  // the newest thing up, whichever dock it is in or floating
  const top = [...reg.values()]
    .filter((s) => s.seat !== 'closed' && here(s))
    .sort((a, b) => b.opened - a.opened)[0]
  if (!top) return false
  close(top)
  return true
}

// -------------------------------------------------------------------------- init ----

function ensureDock() {
  if (dock) return
  const main = document.querySelector('main')
  if (!main) return
  dock = document.createElement('div')
  dock.id = 'dock'
  main.appendChild(dock)
  document.documentElement.style.setProperty('--dock-w', '0px')
  dockL = document.createElement('div')
  dockL.id = 'dock-l'
  main.appendChild(dockL)
  document.documentElement.style.setProperty('--dock-l-w', '0px')
  // the rails and the window change what room there is; re-fit without animating
  const ro = new ResizeObserver(() => {
    if (document.body.classList.contains('pnl-resizing')) return
    relayout(false)
  })
  ro.observe(main)
  roomRO = ro
  // docking or undocking the chats pane changes the room without resizing anything we watch
  addEventListener('laika:claude-open', () => requestAnimationFrame(() => relayout(false)))
  addEventListener('resize', () => {
    for (const s of reg.values()) if (s.seat === 'float') placeFloat(s)
  })
}

/** every registered panel's shortcut, with the app's typing guards */
const TYPING =
  'input, textarea, select, [contenteditable], .pnl, #bw, #ws, #sp, #settings, #ql, #ss, #wb, #ytp'

/**
 * A chord carries its own modifiers, so it is safe anywhere — inside a panel, inside a text box,
 * with another view open. It runs in the capture phase for exactly that reason: ⌥⌘A must reach
 * autopilot whatever else is on screen.
 */
addEventListener(
  'keydown',
  (e) => {
    for (const s of reg.values()) {
      if (!s.spec.chord || !chordHit(s.spec.chord, e) || !usable(s)) continue
      e.preventDefault()
      e.stopImmediatePropagation()
      toggle(s)
      return
    }
  },
  true,
)

/** the bare letters, in the bubble phase, so a view that owns the keyboard keeps owning it */
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
  if ((e.target as HTMLElement).closest?.(TYPING)) return
  for (const s of reg.values()) {
    if (s.spec.key && e.key === s.spec.key && usable(s)) {
      e.preventDefault()
      toggle(s)
      return
    }
  }
})

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading')
    addEventListener('DOMContentLoaded', () => (ensureDock(), mountRail()))
  else ensureDock(), mountRail()
}
