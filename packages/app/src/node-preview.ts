import * as THREE from 'three'
import './node-preview.css'
import { highlight, renderMarkdown } from './quicklook.ts'

/**
 * Live previews on the graph — what a file looks like, before you open it.
 *
 * Three places, one loader:
 *  - the hover tooltip grows a preview under the file name
 *  - the inspector shows a larger one, and clicking it opens Quick Look
 *  - zoomed in, the nodes themselves carry thumbnail cards, sized by how close the
 *    camera is; overview distance shows none, a cluster or ring up close shows dozens
 *
 * Documents, slides, PDFs, HTML and images come as PNGs from /api/thumb (macOS's own
 * thumbnailer, cached by mtime). Markdown and code are fetched and rendered here as a live
 * snippet — a 160px page of the real text reads better than a page-shaped smudge.
 *
 * The DOM layer (#np-layer) owns pointer events on its cards only, so a card is clickable
 * while the canvas underneath still orbits and picks; main.ts lists it in onOverlay().
 */

export type PreviewNode = {
  path: string
  name: string
  bytes: number
  mtime?: number | undefined
  kind: string
  group: string
}

export type PreviewHost = {
  stage: HTMLElement
  nodes: () => PreviewNode[]
  /** world position of node i, written into out */
  pos: (i: number, out: THREE.Vector3) => THREE.Vector3
  /** false when a group isolate has dimmed the node out */
  visible: (i: number) => boolean
  colour: (i: number) => string
  /** a card was clicked */
  open: (i: number) => void
}

const THUMB =
  /\.(pdf|docx?|pptx?|rtf|odt|pages|key|numbers|html?|png|jpe?g|gif|webp|svg|avif|heic|bmp|tiff?)$/i
const MARKDOWN = /\.(md|markdown|mdx|mdc)$/i
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const SNIPPET_CHARS = 1400
const SNIPPET_LINES = 34

// in-scene cards: size from camera distance, hidden below MIN_PX
const SCALE = 50_000 // px = SCALE / radius → 96px at the fly-to distance (520)
const MIN_PX = 48
const MAX_PX = 168
const MAX_CARDS = 36
const HOVER_DELAY = 110

const esc = (s: string) =>
  s.replace(
    /[<>&"]/g,
    (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[m] as string,
  )
const extOf = (p: string) => (p.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()

export type PreviewKind = 'thumb' | 'markdown' | 'code' | 'none'
export function previewKind(n: PreviewNode): PreviewKind {
  if (THUMB.test(n.path)) return 'thumb'
  if (n.bytes > MAX_TEXT_BYTES) return 'none'
  if (MARKDOWN.test(n.path)) return 'markdown'
  return 'code'
}

const thumbUrl = (n: PreviewNode, s: 160 | 320 | 640) =>
  `/api/thumb?path=${encodeURIComponent(n.path)}&s=${s}&v=${Math.round(n.mtime ?? 0)}`

// ------------------------------------------------------------- text snippets ----
const textCache = new Map<string, Promise<string>>() // path → rendered html
let textInFlight = 0
const textQueue: (() => void)[] = []
const TEXT_PARALLEL = 4
const textSlot = () =>
  new Promise<void>((ok) => {
    textQueue.push(ok)
    pumpText()
  })
function pumpText() {
  while (textInFlight < TEXT_PARALLEL && textQueue.length) {
    textInFlight++
    ;(textQueue.shift() as () => void)()
  }
}

/** The first screenful of a text file, rendered: markdown as markdown, code highlighted. */
function snippet(n: PreviewNode): Promise<string> {
  const hit = textCache.get(n.path)
  if (hit) return hit
  const job = (async () => {
    await textSlot()
    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(n.path)}`)
      if (!res.ok) return ''
      let text = await res.text()
      // biome-ignore lint/suspicious/noControlCharactersInRegex: binary sniffing
      if ((text.slice(0, 2000).match(/[\u0000-\u0008\u000e-\u001f]/g)?.length ?? 0) > 8) return ''
      if (MARKDOWN.test(n.path)) {
        text = text.replace(/^---\n[\s\S]*?\n---\n?/, '') // front matter is not the page
        text = text.slice(0, SNIPPET_CHARS)
        return `<div class="np-md">${renderMarkdown(text)}</div>`
      }
      const lines = text.split('\n').slice(0, SNIPPET_LINES).join('\n')
      const ext = extOf(n.path)
      let body = lines
      if (ext === 'json') {
        try {
          body = JSON.stringify(JSON.parse(text), null, 2)
            .split('\n')
            .slice(0, SNIPPET_LINES)
            .join('\n')
        } catch {
          // not valid JSON — show it as written
        }
      }
      return `<pre class="np-code">${highlight(body, ext)}</pre>`
    } catch {
      return ''
    } finally {
      textInFlight--
      pumpText()
    }
  })()
  textCache.set(n.path, job)
  if (textCache.size > 400) textCache.delete(textCache.keys().next().value as string)
  return job
}

/** Fill `el` with a preview of node n; resolves true when there was something to show. */
async function fill(el: HTMLElement, n: PreviewNode, size: 160 | 320 | 640): Promise<boolean> {
  const kind = previewKind(n)
  if (kind === 'none') return false
  if (kind === 'thumb') {
    return new Promise<boolean>((ok) => {
      const img = new Image()
      img.decoding = 'async'
      img.onload = () => {
        el.replaceChildren(img)
        el.dataset.np = 'thumb'
        ok(true)
      }
      img.onerror = () => ok(false)
      img.src = thumbUrl(n, size)
    })
  }
  const html = await snippet(n)
  if (!html) return false
  el.innerHTML = html
  el.dataset.np = kind
  return true
}

export function createNodePreview(host: PreviewHost) {
  // ---------------------------------------------------------------- in-scene ----
  const layer = document.createElement('div')
  layer.id = 'np-layer'
  host.stage.appendChild(layer)
  const cards = new Map<number, HTMLElement>()
  let shown = new Set<number>()
  let lastNodes: PreviewNode[] | null = null
  let enabled = localStorage.getItem('orbit:previews') !== '0'
  layer.classList.toggle('off', !enabled)

  layer.addEventListener('click', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('.np-card')
    if (card) host.open(Number(card.dataset.i))
  })

  function clearLayer() {
    for (const el of cards.values()) el.remove()
    cards.clear()
    shown = new Set()
  }

  function cardFor(i: number, n: PreviewNode): HTMLElement {
    let el = cards.get(i)
    if (el) return el
    el = document.createElement('div')
    el.className = 'np-card'
    el.dataset.i = String(i)
    el.style.setProperty('--np-c', host.colour(i))
    el.innerHTML = `<div class="np-body"></div><div class="np-cap">${esc(n.name)}</div>`
    el.title = n.path
    layer.appendChild(el)
    cards.set(i, el)
    const body = el.querySelector('.np-body') as HTMLElement
    fill(body, n, 160).then((ok) => {
      if (!ok) el?.classList.add('np-none')
      else el?.classList.add('np-ready')
    })
    return el
  }

  const v = new THREE.Vector3()
  type Cand = { i: number; sx: number; sy: number; z: number; d: number }
  const cands: Cand[] = []
  const boxes: { x: number; y: number; w: number; h: number }[] = []

  function update(o: {
    camera: THREE.Camera
    rect: DOMRect
    radius: number
    hover: number
    focus: number | null
  }) {
    const nodes = host.nodes()
    if (nodes !== lastNodes) {
      lastNodes = nodes
      clearLayer()
    }
    const px = Math.min(MAX_PX, SCALE / Math.max(1, o.radius))
    if (!enabled || px < MIN_PX || !nodes.length) {
      if (cards.size) clearLayer()
      return
    }
    layer.style.setProperty('--np-px', `${px.toFixed(1)}px`)
    layer.style.setProperty('--np-k', (px / 320).toFixed(4)) // text snippets are laid out at 320px
    layer.classList.toggle('cap', px >= 96)
    layer.style.opacity = String(Math.min(1, (px - MIN_PX) / 18))
    const W = o.rect.width
    const H = o.rect.height
    const cw = px
    const ch = px * 0.78 + (px >= 96 ? 14 : 0) // caption appears at larger sizes
    cands.length = 0
    for (let i = 0; i < nodes.length; i++) {
      if (!host.visible(i)) continue
      host.pos(i, v).project(o.camera)
      if (v.z > 1) continue
      const sx = ((v.x + 1) / 2) * W
      const sy = ((1 - v.y) / 2) * H
      if (sx < -cw || sy < -ch || sx > W + cw || sy > H + ch) continue
      let d = Math.hypot(sx - W / 2, sy - H / 2)
      if (shown.has(i)) d *= 0.7 // hysteresis: a card on screen keeps its place
      if (i === o.focus) d = -2
      if (i === o.hover) d = -1
      cands.push({ i, sx, sy, z: v.z, d })
    }
    cands.sort((a, b) => a.d - b.d)
    // greedy packing: nearest to the centre first, no two cards overlapping
    boxes.length = 0
    const next = new Set<number>()
    for (const c of cands) {
      if (next.size >= MAX_CARDS) break
      const x = c.sx + 6
      const y = c.sy - 6 - ch
      let clash = false
      for (const b of boxes) {
        if (x < b.x + b.w + 4 && x + cw + 4 > b.x && y < b.y + b.h + 4 && y + ch + 4 > b.y) {
          clash = true
          break
        }
      }
      if (clash) continue
      boxes.push({ x, y, w: cw, h: ch })
      next.add(c.i)
      const n = nodes[c.i] as PreviewNode
      const el = cardFor(c.i, n)
      el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`
      el.style.zIndex = String(
        Math.round((1 - c.z) * 1000) + (c.i === o.hover || c.i === o.focus ? 2000 : 0),
      )
      el.classList.toggle('hot', c.i === o.hover || c.i === o.focus)
    }
    for (const [i, el] of cards) {
      if (!next.has(i)) {
        el.remove()
        cards.delete(i)
      }
    }
    shown = next
  }

  // ------------------------------------------------------------------- hover ----
  let hoverTimer = 0
  let hoverToken = 0
  function hover(i: number | null, tip: HTMLElement) {
    clearTimeout(hoverTimer)
    const my = ++hoverToken
    tip.classList.remove('np-up')
    tip.querySelector('.np-tip')?.remove()
    if (i === null) return
    const n = host.nodes()[i]
    if (!n || previewKind(n) === 'none') return
    hoverTimer = window.setTimeout(async () => {
      if (my !== hoverToken) return
      const el = document.createElement('div')
      el.className = 'np-tip'
      const ok = await fill(el, n, 320)
      if (my !== hoverToken || !ok) return
      tip.appendChild(el)
      // the preview makes the tip taller; flip it above the pointer near the bottom edge
      const r = tip.getBoundingClientRect()
      const s = host.stage.getBoundingClientRect()
      if (r.bottom > s.bottom - 8) tip.classList.add('np-up')
    }, HOVER_DELAY)
  }

  // --------------------------------------------------------------- inspector ----
  function mount(el: HTMLElement, i: number, onClick: () => void) {
    const n = host.nodes()[i]
    if (!n || previewKind(n) === 'none') {
      el.remove()
      return
    }
    el.className = 'np-ins'
    el.title = 'View here'
    el.addEventListener('click', onClick)
    fill(el, n, 640).then((ok) => {
      if (!ok) el.remove()
      else el.classList.add('np-ready')
    })
  }

  function setEnabled(on: boolean) {
    enabled = on
    layer.classList.toggle('off', !on)
    localStorage.setItem('orbit:previews', on ? '' : '0')
    if (!on) clearLayer()
  }

  return {
    update,
    hover,
    mount,
    enabled: () => enabled,
    toggle: () => setEnabled(!enabled),
    /** how many cards are on screen — for tests */
    count: () => cards.size,
  }
}
