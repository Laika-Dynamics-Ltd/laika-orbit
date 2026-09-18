/**
 * The tile tree behind the dock: pure geometry, no DOM. panels.ts owns the panels and asks this
 * where each one goes.
 *
 * A layout is a binary tree. A leaf is a panel; a split puts two subtrees side by side ('h') or
 * one over the other ('v'). The three layouts are three ways of growing that tree:
 *
 *   columns  every panel is its own full-height column, the newest next to the map (the dock as
 *            it has always been)
 *   dwindle  a new panel splits the focused one along its longer side, Hyprland's default
 *   master   the newest panel is the master, full height on the right; the rest stack beside it
 *
 * The dock grows leftward from the window's right edge, so "new goes left" is what keeps the
 * panels already open from moving when one is added.
 *
 * Widths come from the panels themselves (the width you last asked for); heights come from a
 * split's ratio. A tree may name panels that are not on screen (another workspace): they are
 * pruned when it is measured, and come back in the same place when they show again.
 */

export type Layout = 'columns' | 'dwindle' | 'master'
export const LAYOUTS: Layout[] = ['columns', 'dwindle', 'master']

export type Leaf = { id: string }
export type Split = {
  dir: 'h' | 'v'
  a: Tree
  b: Tree /** share of the height 'a' gets, for 'v' */
  ratio: number
}
export type Tree = Leaf | Split | null

export type Rect = { x: number; y: number; w: number; h: number }
export type Dir = 'left' | 'right' | 'up' | 'down'

export const isLeaf = (t: Tree): t is Leaf => !!t && 'id' in t

export function leaves(t: Tree, out: string[] = []): string[] {
  if (!t) return out
  if (isLeaf(t)) out.push(t.id)
  else leaves(t.a, out), leaves(t.b, out)
  return out
}

/** the tree with only the panels that `keep` says are on screen; empty splits fold away */
export function prune(t: Tree, keep: (id: string) => boolean): Tree {
  if (!t) return null
  if (isLeaf(t)) return keep(t.id) ? t : null
  const a = prune(t.a, keep)
  const b = prune(t.b, keep)
  if (!a) return b
  if (!b) return a
  return a === t.a && b === t.b ? t : { ...t, a, b }
}

/** the tree without this panel */
export const remove = (t: Tree, id: string): Tree => prune(t, (x) => x !== id)

/**
 * Add a panel. `target` is the focused panel (dwindle splits it); `shape` is that panel's rect
 * on screen, which decides the direction: wider than tall splits side by side.
 */
export function insert(
  t: Tree,
  id: string,
  layout: Layout,
  target?: string | null,
  shape?: Rect | null,
): Tree {
  const leaf: Leaf = { id }
  if (!t) return leaf
  if (layout === 'columns') return { dir: 'h', a: leaf, b: t, ratio: 0.5 }
  if (layout === 'master') {
    // the newest is the master, on the right; the old master goes to the top of the stack
    const ids = leaves(t)
    return master([id, ...ids])
  }
  // dwindle: split the target leaf (or the newest, if nothing has focus)
  const at = target && leaves(t).includes(target) ? target : leaves(t)[0]
  const dir: 'h' | 'v' = shape && shape.h > shape.w * 1.15 ? 'v' : 'h'
  const swap = (n: Tree): Tree => {
    if (!n) return n
    if (isLeaf(n))
      return n.id === at
        ? dir === 'h'
          ? { dir, a: leaf, b: n, ratio: 0.5 }
          : { dir, a: n, b: leaf, ratio: 0.5 }
        : n
    return { ...n, a: swap(n.a), b: swap(n.b) }
  }
  return swap(t)
}

/** master-stack from an ordered list: first is the master, the rest stacked newest on top */
function master(ids: string[]): Tree {
  const [m, ...rest] = ids
  if (!m) return null
  if (!rest.length) return { id: m }
  let stack: Tree = { id: rest[rest.length - 1] as string }
  for (let i = rest.length - 2; i >= 0; i--)
    stack = { dir: 'v', a: { id: rest[i] as string }, b: stack, ratio: 1 / (rest.length - i) }
  return { dir: 'h', a: stack, b: { id: m }, ratio: 0.5 }
}

/** the same panels re-grown in another layout, newest first in `order` */
export function rebuild(order: string[], layout: Layout, rects?: Map<string, Rect>): Tree {
  if (layout === 'master') return master(order)
  let t: Tree = null
  // oldest first, so the newest ends up where it would have been had it just opened
  for (const id of [...order].reverse()) {
    const target = leaves(t)[0] ?? null
    t = insert(t, id, layout, target, target ? (rects?.get(target) ?? null) : null)
  }
  if (layout === 'dwindle') t = reshape(t, 480, 900)
  return t
}

/** dwindle's rule applied to a whole tree: each split follows the shape of the space it divides */
function reshape(t: Tree, w: number, h: number): Tree {
  if (!t || isLeaf(t)) return t
  const dir: 'h' | 'v' = h > w * 1.15 ? 'v' : 'h'
  const [wa, ha, wb, hb] =
    dir === 'h' ? [w / 2, h, w / 2, h] : [w, h * t.ratio, w, h * (1 - t.ratio)]
  return { ...t, dir, a: reshape(t.a, wa, ha), b: reshape(t.b, wb, hb) }
}

/** how wide this tree wants to be, from each panel's own width */
export function naturalW(t: Tree, width: (id: string) => number): number {
  if (!t) return 0
  if (isLeaf(t)) return width(t.id)
  const a = naturalW(t.a, width)
  const b = naturalW(t.b, width)
  return t.dir === 'h' ? a + b : Math.max(a, b)
}

/** where every panel goes inside a box: side-by-side splits share width by what each wants */
export function place(
  t: Tree,
  box: Rect,
  width: (id: string) => number,
  out = new Map<string, Rect>(),
) {
  if (!t) return out
  if (isLeaf(t)) return out.set(t.id, box)
  if (t.dir === 'h') {
    const wa = naturalW(t.a, width)
    const wb = naturalW(t.b, width)
    const aw = Math.round(box.w * (wa / (wa + wb || 1)))
    place(t.a, { x: box.x, y: box.y, w: aw, h: box.h }, width, out)
    place(t.b, { x: box.x + aw, y: box.y, w: box.w - aw, h: box.h }, width, out)
  } else {
    const ah = Math.round(box.h * t.ratio)
    place(t.a, { x: box.x, y: box.y, w: box.w, h: ah }, width, out)
    place(t.b, { x: box.x, y: box.y + ah, w: box.w, h: box.h - ah }, width, out)
  }
  return out
}

/** the panel you land on moving from `from` in a direction: nearest centre that way, overlap first */
export function neighbour(rects: Map<string, Rect>, from: string, dir: Dir): string | null {
  const r = rects.get(from)
  if (!r) return null
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  let best: string | null = null
  let score = Infinity
  for (const [id, o] of rects) {
    if (id === from) continue
    const ox = o.x + o.w / 2
    const oy = o.y + o.h / 2
    const ahead =
      dir === 'left'
        ? o.x + o.w <= r.x + 2
        : dir === 'right'
          ? o.x >= r.x + r.w - 2
          : dir === 'up'
            ? o.y + o.h <= r.y + 2
            : o.y >= r.y + r.h - 2
    if (!ahead) continue
    const along = dir === 'left' || dir === 'right' ? Math.abs(ox - cx) : Math.abs(oy - cy)
    const across = dir === 'left' || dir === 'right' ? Math.abs(oy - cy) : Math.abs(ox - cx)
    // a panel that shares the edge beats one that is merely nearer
    const overlap =
      dir === 'left' || dir === 'right'
        ? Math.min(r.y + r.h, o.y + o.h) - Math.max(r.y, o.y)
        : Math.min(r.x + r.w, o.x + o.w) - Math.max(r.x, o.x)
    const s = along + across * 2 - (overlap > 0 ? 10000 : 0)
    if (s < score) (score = s), (best = id)
  }
  return best
}

/** two panels trade places; the tree's shape stays the same */
export function swap(t: Tree, a: string, b: string): Tree {
  if (!t) return t
  if (isLeaf(t)) return t.id === a ? { id: b } : t.id === b ? { id: a } : t
  return { ...t, a: swap(t.a, a, b), b: swap(t.b, a, b) }
}

/**
 * Grow or shrink a panel's height in a stack by moving the nearest line between it and a
 * neighbour: `below` only takes the line under it (its bottom edge being dragged), otherwise
 * whichever is nearest, and `by` is always "this panel grows by". (Width is the panel's own, so
 * it is changed in panels.ts, not here.) Returns null when there is no such line.
 */
export function nudgeRatio(t: Tree, id: string, by: number, below = false): Tree | null {
  let hit = false
  const walk = (n: Tree): Tree => {
    if (!n || isLeaf(n)) return n
    const inA = leaves(n.a).includes(id)
    const inB = !inA && leaves(n.b).includes(id)
    if (!inA && !inB) return n
    const a = walk(n.a)
    const b = walk(n.b)
    if (!hit && n.dir === 'v' && (inA || !below)) {
      hit = true
      const ratio = Math.max(0.15, Math.min(0.85, n.ratio + (inA ? by : -by)))
      return { ...n, a, b, ratio }
    }
    return { ...n, a, b }
  }
  const out = walk(t)
  return hit ? out : null
}
