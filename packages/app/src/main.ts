import * as THREE from 'three'
import { openBrainWindow } from './brain-panel.ts'
import { createBrowser } from './browser.ts'
import { bindCalendar } from './calendar.ts'
import { mountCockpit } from './cockpit.ts'
import { createCore } from './core.ts'
import { makeHUD } from './hud.ts'
import { createJarvis } from './jarvis.ts'
import { LabelLayer, type LabelSpec } from './labels.ts'
import { mountQueue, queueCounts } from './queue-view.ts'
import { initSettings, openSettings } from './settings-panel.ts'
import './control.css'
import { createAgentsRing } from './agents-ring.ts'
import { startAutopilot } from './autopilot-panels.ts'
import { mountControl, type Session, sessionNotifier } from './control.ts'
import { devFeatures } from './devfeatures.ts'
import { registerHistoryPanel } from './history.ts'
import { closeMission, isMissionOpen, openMission, watchMission } from './mission.ts'
import { createNodePreview } from './node-preview.ts'
import { canPop, POP_ICON, popOut, watchPop } from './popout.ts'
import './pulse-consent.ts'
import { registerProfilerPanel } from './profiler-panel.ts'
import { openPulse } from './pulse-panel.ts'
import { createQuickLook, type QLItem } from './quicklook.ts'
import { createRoutinesRing, hoursOf } from './routines-ring.ts'
import { registerRunsPanel } from './runs-panel.ts'
import { createSessions } from './sessions.ts'
import { closeShowreel, isShowreelOpen, openShowreel } from './showreel.ts'
import './sysres.ts'
import './offload.ts'
import * as activity from './activity.ts'
import {
  closeTopPanel,
  panelCommands,
  registerPanel,
  restorePanels,
  ruleCommands,
  windowCommands,
  workspaceCommands,
} from './panels.ts'
import { createSpotlight, type SpotCommand } from './spotlight.ts'
import { initStableUpdate } from './stable-update.ts'
import { registerDatabasesPanel } from './supabase.ts'
import { applyTheme, initTheme, themeId } from './themes.ts'
import { registerUsersPanel } from './users-panel.ts'
import { initWidgetDrag, isDragging } from './widget-drag.ts'
import { initWidgetFold, isFolding } from './widget-fold.ts'
import { initWidgetResize, isResizing } from './widget-resize.ts'
import { openWidgetSettings, patch as patchWidgets, restoreHidden } from './widget-settings.ts'
import { renderRail, tickClocks, type Widget } from './widgets.ts'
import { createWorkbench } from './workbench.ts'
import { createYouTube } from './youtube.ts'

type Node = {
  id: number
  path: string
  name: string
  dir: string
  bytes: number
  mtime?: number
  group: string
  depth: number
  kind: string
  arms: 'SKILLS' | 'MEMORY' | 'ROUTINES'
  /** facets from the server's categoriser */
  source?: string
  project?: string
  docType?: string
  folder?: string
  /** the server's smart band, kept so another grouping can be undone */
  smart?: string
}
type Link = { s: number; t: number; type: string }
type Group = { name: string; n: number }
type App = { id: string; name: string; via: string; live: boolean }
type Routine = { id: string; title: string; at: string; status: string; via: string }
type Graph = {
  nodes: Node[]
  links: Link[]
  groups: Group[]
  apps: App[]
  routines?: Routine[]
  armsCounts: Record<string, number>
  pointerLinks: number
}

type Cand = { path: string; score: number; relative: number }
type Ev = { path: string; heading: string | null; lines: string; text: string; viaHop: boolean }
type Recall = {
  noMatch: boolean
  lowConfidence: boolean
  margin: number
  tokens: string[]
  candidates: Cand[]
  evidence: Ev[]
  stats: { bytesRead: number; msScore: number; msTotal: number; hops: number }
}

// the first eight are the original set; the rest keep a smart grouping (~30 bands) from
// cycling back to the same colour within a screen
const PALETTE = [
  0x5b9dff, 0xff7a45, 0x3ddc97, 0xc07bff, 0xffc94f, 0xff4f9d, 0x4fe0e0, 0xa3d15c, 0x8f7bff,
  0xff9e7a, 0x6fd6ff, 0xe0c060, 0x57c28e, 0xd982c9, 0xb3b8ff, 0xf07070,
]
const EXTRACTED = /\.(pdf|docx?|rtf|odt)$/i

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T
const esc = (s: string) =>
  s.replace(/[<>&]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[m] as string)

const stage = $('#stage')
const panelShell = $('#panel')
const panel = $('#panel-body') // re-rendered wholesale; the shell keeps the close button
const hdr = $('#hdr')
const toolFps = $('#tool-fps')
const qInput = $<HTMLInputElement>('#q')

// ------------------------------------------------------------------ scene ----
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
stage.appendChild(renderer.domElement)
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x04050a)
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 9000)
// holographic HUD dressing around the ARMS ring; `J` toggles it (see jarvis.ts)
const jarvis = createJarvis(scene, stage)
// the centrepiece: root badge, skills band, and the live recall path (see core.ts)
const core = createCore(scene, stage)
// the ROUTINES ring as a 24-hour dial of the scheduled jobs (see routines-ring.ts)
const routinesRing = createRoutinesRing(scene, stage)
// live sessions and loose ends on the ring; a marker opens agent control at its session
const agentsRing = createAgentsRing(scene, stage, {
  // a session running in this app opens in the dock beside the ring; others in agent control
  onOpen: (id) => sessionsView.openBySdkId(id) || openControlAt(id),
})
/** false while the stage has no room to draw in (wide docked chats take its whole column) */
let stageShown = true
/** the chats panel (#ss), found on the first frame: it is built after the map */
let chatsEl: HTMLElement | null = null
const fit = () => {
  // the dock animates its column for ~180ms; measuring the stage on every frame of that would
  // reallocate the WebGL drawing buffer 11 times. panels.ts holds `pnl-anim` for the slide and
  // fires `laika:panels-settled` once at the end (see the header of panels.ts).
  if (document.body.classList.contains('pnl-anim')) return
  const r = stage.getBoundingClientRect()
  stageShown = r.width >= 2 && r.height >= 2
  // a zero-size stage would leave the camera with a NaN aspect; the next resize fits it again
  if (!stageShown) return
  renderer.setSize(r.width, r.height)
  camera.aspect = r.width / r.height
  camera.updateProjectionMatrix()
}
addEventListener('resize', fit)
// a panel opened, closed or was dragged wider: one real resize, once the column has stopped
addEventListener('laika:panels-settled', () => {
  fit()
  requestAnimationFrame(() => checkCovered())
})

// GPU colour-ID picking: each node renders a unique colour into a 1x1 scissored
// read. O(1) per pick regardless of node count — raycasting 60k points is not viable.
const pickTarget = new THREE.WebGLRenderTarget(1, 1)
const pickScene = new THREE.Scene()
let pickPoints: THREE.Points | null = null
const pickBuf = new Uint8Array(4)
const PICK_SCALE = 0.5
// spiral outward from the exact pixel so a 2px dot is still clickable
const PICK_OFFSETS: [number, number][] = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [2, 0],
  [-2, 0],
  [0, 2],
  [0, -2],
]

let g: Graph = { nodes: [], links: [], groups: [], apps: [], armsCounts: {}, pointerLinks: 0 }
let pos = new Float32Array(0)
const groupColor = new Map<string, number>()
let points: THREE.Points | null = null
let lines: THREE.LineSegments | null = null
let highlight = new Set<number>()
let dimGroup: string | null = null
let frameRadius = 900
let centre = new THREE.Vector3()
// Radii measured from sb_000310 as fractions of the applications ring (500 here):
// skills annulus 0.13–0.24, department bands 0.30–0.70, memory disc edge 0.72,
// routines ring 0.85. MEMORY's r is the disc edge; it has no ring line of its own.
const ARMS = [
  { id: 'SKILLS', colour: 0xff7a45, r: 92 },
  { id: 'MEMORY', colour: 0xc07bff, r: 360 },
  { id: 'ROUTINES', colour: 0xffc94f, r: 425 },
  { id: 'APPLICATIONS', colour: 0x5b9dff, r: 500 },
] as const
const BAND_IN = 150 // innermost department row
const BAND_OUT = 350 // where the heaviest department's rows should end
const HUB_R = 133 // department hubs sit just inside their band, as in the reference
/** per-node size multiplier set by the band layout; 1 for everything not in a band */
let bandScale = new Float32Array(0)
let ringArcs: THREE.Object3D[] = []
let appPos: { app: App; v: THREE.Vector3 }[] = []
type LayoutMode = 'arms' | 'rings' | 'force'
let layoutMode: LayoutMode = 'arms' // always open on ARMS; the choice is per-visit
let ringMeta: { name: string; r: number; colour: number }[] = []
const memSector = new Map<string, number>()
/** Department arms: hub node at the arm's root, count tag partway along its trail. */
let memHubs: {
  name: string
  count: number
  colour: number
  hub: THREE.Vector3
  tag: THREE.Vector3
}[] = []

/**
 * The router recall starts from: the shallowest CLAUDE.md, ties broken A→Z. Taking the
 * first match in index order put whichever CLAUDE.md happened to be listed first at the
 * centre of the ring.
 */
function rootIndex(): number {
  let best = -1
  g.nodes.forEach((nd, i) => {
    if (!/(^|\/)CLAUDE\.md$/.test(nd.path)) return
    const cur = g.nodes[best]
    if (
      !cur ||
      nd.depth < cur.depth ||
      (nd.depth === cur.depth && COLLATE.compare(nd.path, cur.path) < 0)
    )
      best = i
  })
  return best
}

/** Natural, case-insensitive ordering: "file2" before "file10", "Alpha" beside "alpha". */
const COLLATE = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Base hue per index source (0–1). Bands of one source share a family. */
const SOURCE_HUE: Record<string, number> = {
  claude: 0.06, // warm orange
  dev: 0.58, // blue
  documents: 0.4, // green
  workspace: 0.78, // violet
}

/** One labelled arc per source, set by layoutArms and drawn in build(). */
/** real skills in the current ARMS layout */
let skillCount = 0
let sourceArcs: { source: string; a0: number; a1: number; n: number }[] = []
/** world angle that sits at 12 o'clock for the current ARMS layout */
let indexTop = Math.PI

/** A group's name without its source prefix, for sorting: "dev/the-khanban" → "the-khanban". */
const bandLabel = (grp: string) =>
  grp.replace(/^(claude|dev|documents|workspace)\s*[/·]\s*/i, '').replace(/^[.(]+/, '')

/** Root group first, named groups, then catch-all buckets last. */
const bandRank = (grp: string) => (grp === '(root)' ? 0 : /(^|\s)other$/i.test(grp) ? 2 : 1)

/** Longest shared directory of a set of paths, with its trailing slash ('' if none). */
function commonDir(paths: string[]): string {
  if (!paths.length) return ''
  let pre = paths[0] as string
  for (const p of paths) {
    while (pre && !p.startsWith(pre)) pre = pre.slice(0, -1)
  }
  const cut = pre.lastIndexOf('/')
  return cut < 0 ? '' : pre.slice(0, cut + 1)
}

/**
 * Angular width per department band: proportional to the given weights (sqrt of file
 * count), but never below `min`. Bands that fall under the floor are pinned to it and the
 * remaining angle is re-shared among the rest, until nothing else drops under.
 */
function bandWidths(weights: number[], total: number, min: number): number[] {
  const pinned = new Set<number>()
  for (;;) {
    const free = total - pinned.size * min
    const sum = weights.reduce((acc, w, i) => (pinned.has(i) ? acc : acc + w), 0) || 1
    const out = weights.map((w, i) => (pinned.has(i) ? min : (w / sum) * free))
    let changed = false
    out.forEach((w, i) => {
      if (!pinned.has(i) && w < min) {
        pinned.add(i)
        changed = true
      }
    })
    if (!changed || pinned.size === weights.length) return out.map((w) => Math.max(w, min))
  }
}
let labels: LabelLayer
let hud: ReturnType<typeof makeHUD>
let adj = new Map<number, { id: number; type: string }[]>()
let widgets: Widget[] = []
let frames = 0
let lastT = performance.now()

function buildAdjacency() {
  adj = new Map()
  const push = (a: number, b: number, t: string) => {
    const list = adj.get(a) ?? []
    list.push({ id: b, type: t })
    adj.set(a, list)
  }
  for (const l of g.links) {
    push(l.s, l.t, l.type)
    push(l.t, l.s, l.type)
  }
}

/**
 * Rings layout — the reference's signature view. Root at dead centre, each group
 * a concentric labelled band, hubs sitting ON the ring like badges.
 * Ordered smallest-innermost so the dense folders form the outer halo rather than
 * swamping the middle.
 */
/**
 * ARMS layout — the reference's signature view. Concentric layers outward from
 * CLAUDE.md: skills, memory (subdivided into per-department arcs), routines, and
 * the applications ring of connector badges.
 */
function layoutArms() {
  const n = g.nodes.length
  pos = new Float32Array(n * 3)
  ringMeta = []
  // ---- ordering: location first, then alphabet --------------------------------------
  //
  // The ring is a clock-face index. Reading clockwise from 12 o'clock: sources A→Z
  // (claude, dev, documents, workspace), each a contiguous sector; inside a source, its
  // groups A→Z with the root group first and "· other" catch-alls last; inside a band, files
  // in path order, so every sub-folder is one contiguous slice. An earlier version ordered
  // bands heavy/light for visual balance and files by size — it looked even and meant
  // nothing. Colour follows the same model: one hue family per source.
  //
  // World angle increases clockwise on screen, and with the camera at azimuth θ the top of
  // the screen is world angle θ + π, so the index starts there.
  const TOP = Math.PI + want.theta
  // 12 o'clock is kept clear: it is where the ring titles stack, and a gap there marks
  // where the index starts and ends, like the top of a clock face
  const TOP_GAP = (40 * Math.PI) / 180
  const START = TOP + TOP_GAP / 2
  indexTop = TOP
  const byArms = new Map<string, number[]>()
  g.nodes.forEach((nd, i) => {
    const a = byArms.get(nd.arms) ?? []
    a.push(i)
    byArms.set(nd.arms, a)
  })
  const byPath = (p: number, q: number) =>
    COLLATE.compare(g.nodes[p]?.path ?? '', g.nodes[q]?.path ?? '')

  bandScale = new Float32Array(n).fill(1)
  // SKILLS: one star per SKILL.md, A→Z by skill name (its folder) from 12 o'clock. A skill
  // that changed in the last week is drawn larger; the band's guide rows are in core.ts.
  const skillName = (i: number) => (g.nodes[i]?.path ?? '').split('/').slice(-2, -1)[0] ?? ''
  const skillIds = [...(byArms.get('SKILLS') ?? [])].sort((p, q) =>
    COLLATE.compare(skillName(p), skillName(q)),
  )
  skillCount = skillIds.length
  const WEEK = 7 * 864e5
  skillIds.forEach((idx, k) => {
    const a = START + (k / Math.max(1, skillIds.length)) * (Math.PI * 2 - TOP_GAP)
    const r = ARMS[0].r
    pos[idx * 3] = Math.cos(a) * r
    pos[idx * 3 + 1] = 0
    pos[idx * 3 + 2] = Math.sin(a) * r
    const age = Date.now() - (g.nodes[idx]?.mtime ?? 0)
    bandScale[idx] = age < WEEK ? 1.7 : 1.15
  })

  // MEMORY: one BAND of concentric arcs per group, wrapping around the root. Width goes
  // with sqrt(count) and has a floor, depth (rows) carries the rest — the lesson from the
  // first version, where angle proportional to count let one folder eat the circle.
  const mem = byArms.get('MEMORY') ?? []
  const memBy = new Map<string, number[]>()
  for (const idx of mem) {
    const grp = g.nodes[idx]?.group ?? '(root)'
    const a = memBy.get(grp) ?? []
    a.push(idx)
    memBy.set(grp, a)
  }
  // a band belongs to the source most of its files come from (pure under smart grouping)
  const bandSource = new Map<string, string>()
  for (const [grp, ids] of memBy) {
    const tally = new Map<string, number>()
    for (const i of ids) {
      const src = g.nodes[i]?.source ?? 'workspace'
      tally.set(src, (tally.get(src) ?? 0) + 1)
    }
    bandSource.set(grp, [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'workspace')
  }
  const depts = [...memBy].sort(([ga], [gb]) => {
    const sa = bandSource.get(ga) ?? ''
    const sb = bandSource.get(gb) ?? ''
    if (sa !== sb) return COLLATE.compare(sa, sb)
    return bandRank(ga) - bandRank(gb) || COLLATE.compare(bandLabel(ga), bandLabel(gb))
  })

  // colour: hue family per source, a spread of shades across its bands
  const perSource = new Map<string, string[]>()
  for (const [grp] of depts) {
    const src = bandSource.get(grp) ?? 'workspace'
    perSource.set(src, [...(perSource.get(src) ?? []), grp])
  }
  const c = new THREE.Color()
  for (const [src, grps] of perSource) {
    const hue = SOURCE_HUE[src] ?? 0.6
    grps.forEach((grp, k) => {
      const t = grps.length > 1 ? k / (grps.length - 1) : 0.5
      // alternate lightness so neighbouring bands of one source still separate
      c.setHSL((hue + (t - 0.5) * 0.09 + 1) % 1, 0.78, k % 2 ? 0.58 : 0.66)
      groupColor.set(grp, c.getHex())
    })
  }
  // groups outside ARMS (rings/packed) keep the size-ranked palette
  g.groups.forEach((x, i) => {
    if (!groupColor.has(x.name)) groupColor.set(x.name, PALETTE[i % PALETTE.length] as number)
  })

  const GAP = (1.8 * Math.PI) / 180 // between bands of one source
  const SOURCE_GAP = (7 * Math.PI) / 180 // between sources — the category boundary
  const nSources = perSource.size
  const avail =
    Math.PI * 2 -
    TOP_GAP -
    GAP * Math.max(0, depts.length - nSources) -
    SOURCE_GAP * Math.max(0, nSources - 1)
  const minW = Math.min((9 * Math.PI) / 180, avail / Math.max(1, depts.length))
  // count^0.72 rather than sqrt: big bands get wider and shallower, which keeps them
  // crescents; with sqrt the largest were narrow and deep and read as radial combs
  const span = bandWidths(
    depts.map(([, ids]) => ids.length ** 0.72),
    avail,
    minW,
  )
  // Files fill COLUMNS (angular slices), not rows, so alphabetical order runs clockwise and a
  // sub-folder is a contiguous wedge. Column pitch is set at COL_R; a band of width w holds
  // about (w·COL_R/s)·(ΔR/s) files at spacing s, so solve for the s the fullest band needs.
  const COL_R = 205
  const DR = BAND_OUT - BAND_IN
  const need = depts.map(([, ids], i) =>
    Math.sqrt(((span[i] ?? minW) * COL_R * DR) / (1.1 * Math.max(1, ids.length))),
  )
  const step = Math.max(5, Math.min(34, ...need))
  const maxRows = Math.floor(DR / step) + 1
  const dotScale = Math.max(0.35, Math.min(1.2, step / 12))
  const SHEAR = 0.3 // outer rows lead clockwise; every band shears alike, so none overlap

  memHubs = []
  sourceArcs = []
  let cursor = START
  let prevSrc = ''
  depts.forEach(([grp, ids], di) => {
    const src = bandSource.get(grp) ?? 'workspace'
    if (di > 0) cursor += src === prevSrc ? GAP : SOURCE_GAP
    if (src !== prevSrc) sourceArcs.push({ source: src, a0: cursor, a1: cursor, n: 0 })
    prevSrc = src
    const w = span[di] ?? minW
    const a0 = cursor
    cursor += w
    const arcRec = sourceArcs[sourceArcs.length - 1]
    if (arcRec) {
      arcRec.a1 = cursor
      arcRec.n += ids.length
    }

    // path order, grouped by first sub-folder under the band's common directory; files
    // sitting directly in that directory come first
    const paths = ids.map((i) => g.nodes[i]?.path ?? '')
    const base = commonDir(paths)
    const sub = (i: number) => {
      const rest = (g.nodes[i]?.path ?? '').slice(base.length)
      const cut = rest.indexOf('/')
      return cut < 0 ? '' : rest.slice(0, cut)
    }
    const sorted = [...ids].sort(
      (p, q) =>
        Number(sub(p) !== '') - Number(sub(q) !== '') ||
        COLLATE.compare(sub(p), sub(q)) ||
        byPath(p, q),
    )
    const minDepth = Math.min(...ids.map((i) => g.nodes[i]?.depth ?? 0))

    // lay out columns; an empty column marks each sub-folder boundary when there is room
    const colsAvail = Math.max(1, Math.floor((w * COL_R) / step))
    const subs = new Set(sorted.map(sub)).size
    const place = (withGaps: boolean) => {
      const usable = Math.max(1, colsAvail - (withGaps ? subs - 1 : 0))
      const rows = Math.max(1, Math.ceil(sorted.length / usable))
      const cells: [number, number][] = []
      let col = 0
      let row = 0
      let last = sub(sorted[0] as number)
      for (const i of sorted) {
        const sfd = sub(i)
        if (sfd !== last) {
          if (row > 0) {
            col++
            row = 0
          }
          if (withGaps) col++
          last = sfd
        }
        cells.push([col, row])
        row++
        if (row >= rows) {
          row = 0
          col++
        }
      }
      return { cells, rows, cols: (cells[cells.length - 1]?.[0] ?? 0) + 1 }
    }
    let lay = place(subs > 1)
    if (lay.rows > maxRows || lay.cols > colsAvail) lay = place(false)

    sorted.forEach((idx, k) => {
      const [col, row] = lay.cells[k] as [number, number]
      const r = BAND_IN + row * step
      const t = Math.min(1, (r - BAND_IN) / DR)
      const a = a0 + SHEAR * t + ((col + 0.5) / lay.cols) * w
      pos[idx * 3] = Math.cos(a) * r
      pos[idx * 3 + 1] = 0
      pos[idx * 3 + 2] = Math.sin(a) * r
      // shallower files are bigger: the folder's own files read as its anchors
      const rel = Math.min(3, (g.nodes[idx]?.depth ?? 0) - minDepth)
      bandScale[idx] = ([1.5, 1.15, 0.92, 0.76][rel] ?? 0.76) * dotScale
    })

    const lastR = BAND_IN + (lay.rows - 1) * step
    const colour = groupColor.get(grp) ?? 0x63708f
    const mid = a0 + w / 2
    const tagR = (BAND_IN + lastR) / 2
    const tagA = mid + SHEAR * Math.min(1, (tagR - BAND_IN) / DR)
    ringMeta.push({ name: grp, r: tagR, colour })
    memHubs.push({
      name: grp,
      count: ids.length,
      colour,
      hub: new THREE.Vector3(Math.cos(mid) * HUB_R, 0, Math.sin(mid) * HUB_R),
      tag: new THREE.Vector3(Math.cos(tagA) * tagR, 0, Math.sin(tagA) * tagR),
    })
    memSector.set(grp, tagA)
  })

  // applications are capabilities, not files — their own ring, A→Z from the top
  const apps = [...g.apps].sort((p, q) => COLLATE.compare(p.name, q.name))
  appPos = apps.map((app, k) => {
    const a = START + (k / Math.max(1, apps.length)) * Math.PI * 2
    const r = ARMS[3].r
    return { app, v: new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r) }
  })
  // the app ring is the widest thing on screen — frame to IT, or its badges get
  // clamped out of view and the ring reads as empty
  frameRadius = ARMS[3].r

  const rootIdx = rootIndex()
  if (rootIdx >= 0) {
    pos[rootIdx * 3] = 0
    pos[rootIdx * 3 + 1] = 0
    pos[rootIdx * 3 + 2] = 0
  }
  centre = new THREE.Vector3()
}

function layoutRings() {
  sourceArcs = []
  const n = g.nodes.length
  bandScale = new Float32Array(n).fill(1)
  pos = new Float32Array(n * 3)
  ringMeta = []
  const order = g.groups.map((x) => x.name)
  order.forEach((name, i) => {
    groupColor.set(name, PALETTE[i % PALETTE.length] as number)
  })

  const members = new Map<string, number[]>()
  g.nodes.forEach((nd, i) => {
    const a = members.get(nd.group) ?? []
    a.push(i)
    members.set(nd.group, a)
  })

  // smallest group innermost; band width grows with population so dense folders
  // get room without pushing everything else to the rim
  const bySize = [...order].sort(
    (a, b) => (members.get(a)?.length ?? 0) - (members.get(b)?.length ?? 0),
  )
  let r = 210
  for (const name of bySize) {
    const ids = members.get(name) ?? []
    const band = 34 + Math.sqrt(ids.length) * 7.5
    const mid = r + band / 2
    ringMeta.push({ name, r: mid, colour: groupColor.get(name) ?? 0x63708f })
    ids.forEach((idx, k) => {
      const nd = g.nodes[idx]
      // deterministic angular spread; hubs pulled onto the ring centre-line
      const a = (k / Math.max(1, ids.length)) * Math.PI * 2 + (k % 7) * 0.031
      const isHub = nd?.kind === 'router'
      const rr = isHub ? mid : mid + (((k * 2654435761) % 1000) / 1000 - 0.5) * band * 0.92
      pos[idx * 3] = Math.cos(a) * rr
      pos[idx * 3 + 1] = (((k * 40503) % 1000) / 1000 - 0.5) * band * 0.22
      pos[idx * 3 + 2] = Math.sin(a) * rr
    })
    r += band + 26
  }
  // the root sits at dead centre
  const rootIdx = rootIndex()
  if (rootIdx >= 0) {
    pos[rootIdx * 3] = 0
    pos[rootIdx * 3 + 1] = 0
    pos[rootIdx * 3 + 2] = 0
  }
  centre = new THREE.Vector3()
  frameRadius = r
}

function layoutPacked() {
  sourceArcs = []
  const n = g.nodes.length
  bandScale = new Float32Array(n).fill(1)
  pos = new Float32Array(n * 3)
  const order = g.groups.map((x) => x.name)
  order.forEach((name, i) => {
    groupColor.set(name, PALETTE[i % PALETTE.length] as number)
  })

  const members = new Map<string, number[]>()
  g.nodes.forEach((nd, i) => {
    const a = members.get(nd.group) ?? []
    a.push(i)
    members.set(nd.group, a)
  })

  // Circle-pack the groups: size each cluster first, then choose an orbit whose
  // circumference actually fits the sum of their diameters. Placing groups at a
  // fixed radius made the biggest cluster swallow the centre and the small ones
  // overlap each other.
  const radiusOf = (count: number) => 46 + Math.sqrt(count) * 13
  const pad = 1.32
  const totalSpan = order.reduce(
    (acc, name) => acc + 2 * radiusOf((members.get(name) ?? []).length) * pad,
    0,
  )
  const orbit = Math.max(420, totalSpan / (Math.PI * 2))
  let angle = 0
  order.forEach((name) => {
    const ids = members.get(name) ?? []
    const rad = radiusOf(ids.length)
    const span = (2 * rad * pad) / orbit // angular width this cluster needs
    const a = angle + span / 2
    angle += span
    const cx = Math.cos(a) * orbit
    const cz = Math.sin(a) * orbit
    ids.forEach((idx, k) => {
      const golden = k * 2.399963
      // sqrt keeps density even instead of piling everything at the centre
      const rr = Math.sqrt((k + 0.5) / Math.max(1, ids.length)) * rad
      pos[idx * 3] = cx + Math.cos(golden) * rr
      pos[idx * 3 + 1] = Math.sin(golden * 1.7) * rad * 0.22
      pos[idx * 3 + 2] = cz + Math.sin(golden) * rr
    })
  })
  // frame on the actual point cloud rather than the origin — the largest folder
  // pulls the visual mass off-centre otherwise
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3] ?? 0
    const z = pos[i * 3 + 2] ?? 0
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  centre = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2)
  frameRadius =
    Math.max(maxX - minX, maxZ - minZ) / 2 +
    radiusOf(Math.max(...order.map((nm) => (members.get(nm) ?? []).length))) * 0.4
}

function layout() {
  if (layoutMode === 'arms') layoutArms()
  else if (layoutMode === 'rings') layoutRings()
  else layoutPacked()
  buildLabels()
}

/** Ring titles, plus hub names — the two tiers worth reading at a glance. */
function buildLabels() {
  const specs: LabelSpec[] = []
  if (layoutMode === 'arms') {
    // Ring titles stack on the vertical centreline, each at the top of its own ring,
    // as in sb_000310. "Top" is the ring's FAR side from the camera, which moves as the
    // scene drifts, so these vectors are re-aimed every frame in aimRingTitles().
    // An earlier pass parked them on a fixed 135° diagonal, which put them across the arms.
    ringTitles = []
    for (const layer of ARMS) {
      const world = new THREE.Vector3()
      ringTitles.push({ world, r: RING_TITLE_R[layer.id] ?? layer.r })
      // ~20px at 1080p in the reference, which is 14px on our stage; tracked less widely
      specs.push({ text: layer.id, world, colour: layer.colour, tier: 0, px: 14, spacing: 0.1 })
    }
    // The reference puts its file counts out on the trail (3236 / 2655 / 1883) because
    // its arms are thousands of dots long. Ours top out in the dozens, so a number at
    // the arm's end landed almost on top of its own hub and every count was rendered
    // twice. The count lives in the hub pill instead; revisit when pointed at a corpus
    // large enough for the trail to carry it (memHubs[].tag is already the anchor).
  }
  if (layoutMode !== 'arms') ringTitles = []
  if (layoutMode === 'rings') {
    for (const rm of ringMeta) {
      specs.push({
        text: rm.name.length > 26 ? `${rm.name.slice(0, 25)}…` : rm.name,
        world: new THREE.Vector3(0, 70, -rm.r),
        colour: rm.colour,
        tier: 0,
        px: 20,
      })
    }
  }
  if (layoutMode === 'arms') {
    // one label per source sector, outside the disc at the sector's middle
    for (const sa of sourceArcs) {
      // Just outside the coloured arc, between the disc and the routines ring, and always
      // inside its own sector where possible, so a label never sits over another source's
      // bands. Within the sector it prefers a gap between two app badges (a badge 40° away
      // can't touch it), and it keeps 27° from 12 o'clock, which is where a ~100px label
      // clears the ±60px ring-title stack at this radius.
      const mid = (sa.a0 + sa.a1) / 2
      const CLEAR = (27 * Math.PI) / 180
      const fromTop = (x: number) => Math.atan2(Math.sin(x - indexTop), Math.cos(x - indexTop))
      // things on the rings outside that a wide label must not sit under: app badges and
      // routine markers, both at known angles
      const blockers = [
        ...appPos.map((p) => Math.atan2(p.v.z, p.v.x)),
        ...(g.routines ?? []).flatMap((rt) => {
          const h = hoursOf(rt.at)
          return h === null ? [] : [indexTop + (h / 24) * Math.PI * 2]
        }),
      ]
      const gapTo = (x: number) =>
        Math.min(
          Math.PI,
          ...blockers.map((b) => Math.abs(Math.atan2(Math.sin(x - b), Math.cos(x - b)))),
        )
      // candidates across the sector (and just past it, for a narrow one), scored by
      // clearance, then by closeness to the sector's middle
      const cands: number[] = []
      for (let k = 0; k <= 16; k++) cands.push(sa.a0 + ((sa.a1 - sa.a0) * k) / 16)
      const ok = cands.filter((x) => Math.abs(fromTop(x)) >= CLEAR)
      const best = (ok.length ? ok : [mid]).sort((p, q) => {
        const cp = Math.min(gapTo(p), 0.24)
        const cq = Math.min(gapTo(q), 0.24)
        return cq - cp || Math.abs(p - mid) - Math.abs(q - mid)
      })[0]
      let at = best ?? mid
      const off = fromTop(at)
      if (Math.abs(off) < CLEAR) at = indexTop + Math.sign(off || 1) * CLEAR
      const r = ARMS[1].r + 42
      specs.push({
        text: `${sa.source.toUpperCase()} · ${sa.n.toLocaleString()}`,
        world: new THREE.Vector3(Math.cos(at) * r, 0, Math.sin(at) * r),
        colour: new THREE.Color().setHSL(SOURCE_HUE[sa.source] ?? 0.6, 0.72, 0.68).getHex(),
        tier: 1,
        px: 11,
        spacing: 0.14,
      })
    }
  }
  // the root sits at the origin in ARMS; its name goes BELOW it, as in sb_000310, which
  // leaves the space above the root for the SKILLS title
  const rootIdx = layoutMode === 'arms' ? rootIndex() : -1
  g.nodes.forEach((nd, i) => {
    if (nd.kind !== 'router') return
    let world: THREE.Vector3
    if (i === rootIdx) {
      world = new THREE.Vector3()
      ringTitles.push({ world, r: -44 }) // clear of the 34px root badge
    } else {
      world = new THREE.Vector3(pos[i * 3] ?? 0, (pos[i * 3 + 1] ?? 0) + 16, pos[i * 3 + 2] ?? 0)
    }
    specs.push({ text: nd.name, world, colour: 0xe8ecf8, tier: 1, px: 13 })
  })
  for (const i of highlight) {
    const nd = g.nodes[i]
    if (!nd) continue
    specs.push({
      text: nd.name.length > 34 ? `${nd.name.slice(0, 33)}…` : nd.name,
      world: new THREE.Vector3(pos[i * 3] ?? 0, (pos[i * 3 + 1] ?? 0) + 20, pos[i * 3 + 2] ?? 0),
      colour: 0xffffff,
      tier: 0,
      px: 15,
    })
  }
  labels?.set(specs)
}

// ------------------------------------------------------------ memory disc ----
// The reference's memory region is a FILLED DISC — a violet-tinted surface carrying a
// hex grid, bounded by the routines ring, with the arms sitting on top of it. Ours was
// black wherever there were no nodes, so sparse regions read as nothing at all.
//
// This is the fix for an empty-looking centre, and it is deliberately NOT a change to
// node positions: their dense core is 35,466 files, which is a corpus, not a layout
// setting. Giving the region a surface works at any corpus size; compressing 107 nodes
// into a clump would only destroy the arm structure.
let discMesh: THREE.Mesh | null = null

const DISC_VS = `
varying vec2 vXZ;
void main(){
  // CircleGeometry is authored in XY and the mesh is rotated into XZ, so local .xy
  // is already the world ground plane and stays stable under that rotation
  vXZ = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const DISC_FS = `
precision highp float;
varying vec2 vXZ;
uniform float uR, uHex;
uniform vec3 uTint, uLine;
uniform sampler2D uGrid;

void main(){
  float rad = length(vXZ) / uR;
  if (rad > 1.0) discard;
  // soft rim so the disc reads as a body rather than a cut-out circle, and a gentle
  // lift toward the middle so the root sits on the brightest part of the surface
  float rim  = 1.0 - smoothstep(0.86, 1.0, rad);
  float core = mix(1.0, 1.42, 1.0 - smoothstep(0.0, 0.7, rad));

  // The tile is 3s wide by sqrt(3)s tall, so each axis needs its own divisor or the
  // hexagons come out squashed. uHex is the hex circumradius in world units.
  vec2 guv = vec2(vXZ.x / (3.0 * uHex), vXZ.y / (1.7320508 * uHex));
  // Negative LOD bias: the far half of a tilted disc minifies hard, and without
  // anisotropic filtering the default mip choice averages the lines away entirely.
  // Biasing toward a sharper level keeps them readable at a little aliasing cost.
  float line = texture2D(uGrid, guv, -1.25).r;
  // fade the grid out near the rim so it does not terminate on a hard edge
  line *= 1.0 - smoothstep(0.78, 1.04, rad);

  vec3 cc = uTint * core + uLine * line;
  float a = rim * (0.85 + line * 0.9);
  gl_FragColor = vec4(cc, a);
}`

/**
 * One tile of a flat-top hex grid, drawn once to a canvas and repeated.
 *
 * Baked rather than computed per fragment: measured over three runs each, headless p50
 * was 32 with no disc, 28 with this texture and 23 with the procedural version — the
 * texture costs under half as much. Lines are drawn thick on purpose so they survive
 * mipmapping on the tilted far half of the disc.
 *
 * Hex centres sit on the lattice (1.5s·i, √3·s·(j + (i mod 2)/2)), so a 3s × √3s tile
 * holds exactly two centres and repeats seamlessly. Neighbours are drawn at ±W/±H too,
 * or strokes would be clipped at the seams.
 */
function makeHexTexture(s = 48, line = 5) {
  const W = Math.round(3 * s)
  const H = Math.round(Math.sqrt(3) * s)
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const ctx = cv.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable for hex texture')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = line
  ctx.lineJoin = 'round'
  const hex = (cx: number, cy: number) => {
    ctx.beginPath()
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3
      const x = cx + s * Math.cos(a)
      const y = cy + s * Math.sin(a)
      if (k === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.stroke()
  }
  for (const dx of [-W, 0, W]) {
    for (const dy of [-H, 0, H]) {
      hex(dx, dy)
      hex(dx + 1.5 * s, dy + H / 2)
    }
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 8 // honoured on real GPUs; headless ignores it, hence the LOD bias
  return tex
}

let hexTex: THREE.Texture | null = null

function buildDisc(radius: number) {
  if (discMesh) {
    scene.remove(discMesh)
    discMesh.geometry.dispose()
    discMesh = null
  }
  if (layoutMode !== 'arms' || new URLSearchParams(location.search).get('disc') === '0') return
  // baked once and shared across rebuilds: the pattern never changes
  if (!hexTex) hexTex = makeHexTexture()
  const geo = new THREE.CircleGeometry(radius, 128)
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uR: { value: radius },
      uHex: { value: 26 },
      uGrid: { value: hexTex },
      uTint: { value: new THREE.Color(0x1d1636) },
      uLine: { value: new THREE.Color(0x2f2758) },
    },
    vertexShader: DISC_VS,
    fragmentShader: DISC_FS,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  })
  discMesh = new THREE.Mesh(geo, mat)
  discMesh.rotation.x = -Math.PI / 2
  discMesh.position.y = -2 // just under the node plane
  discMesh.renderOrder = -10 // a surface: everything else draws on top of it
  discMesh.frustumCulled = false
  scene.add(discMesh)
}

// ---------------------------------------------------- node treatment (ported) ----
// Ported from the gauntlet `feel` build. The important idea is that relatedness lives
// in a per-node ATTRIBUTE rather than in recomputed vertex colours: aS1 is the state a
// node is moving TO, aS0 the state it came FROM, and uMix crossfades between them on
// the GPU. Hovering 2,383 nodes therefore costs one uniform write per frame instead of
// rebuilding a Float32Array of colours.
//
//   aS -> 0      unrelated field
//         0.55   second-degree structure
//         1      direct neighbour
//         2      the pick itself
const NODE_U = {
  uMix: { value: 1 },
  uDim: { value: 0 },
  uTime: { value: 0 },
  uPR: { value: Math.min(devicePixelRatio, 2) },
  uSel: { value: 0 },
  uPass: { value: 0 }, // 0 = field pass, 1 = crisp overlay pass
}

const NODE_VS = `
attribute float aSize; attribute float aCap; attribute vec3 aCol;
attribute float aS0; attribute float aS1; attribute float aShape;
uniform float uMix, uDim, uTime, uPR, uSel, uPass;
varying vec3 vCol; varying float vA; varying float vHi; varying float vFoc; varying float vShape;
void main(){
  vShape = aShape;
  float s   = mix(aS0, aS1, uMix);
  float hi  = smoothstep(0.62, 1.0, s);
  float ctx = clamp(s / 0.6, 0.0, 1.0) * (1.0 - hi);
  float foc = clamp(s - 1.0, 0.0, 1.0);
  // the overlay pass carries ONLY the pick and its direct neighbours, drawn crisply
  // over the additive field so a lit node never muddies into the dots behind it
  if (uPass > 0.5 && s < 0.9) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0;
    vCol = vec3(0.0); vA = 0.0; vHi = 0.0; vFoc = 0.0; return;
  }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float pulse = 1.0 + foc * 0.10 * sin(uTime * 3.4) + hi * 0.05 * sin(uTime * 2.1 + position.x * 0.01);
  float px = clamp(aSize * (620.0 / -mv.z), 1.05 * uPR, aCap * uPR);
  px *= (1.0 + hi * (0.70 + uSel * 0.20) + foc * (0.34 + uSel * 0.14) + ctx * 0.55) * pulse;
  gl_PointSize = px;
  gl_Position = projectionMatrix * mv;

  // "drain the unrelated": anything that is not the pick, a neighbour or second-degree
  // structure loses its colour toward cold ash AND is crushed in luminance, so the lit
  // subgraph is the only saturated thing left in frame.
  float bg   = clamp(1.0 - hi - ctx * 0.86, 0.0, 1.0);
  float dim  = uDim * bg;
  float luma = dot(aCol, vec3(0.30, 0.59, 0.11));
  vec3 ash   = vec3(luma * 0.70) * vec3(0.62, 0.71, 0.98);
  vec3 cc    = mix(aCol, ash, dim * 0.96);
  cc *= mix(1.0, 0.60, dim);
  cc = mix(cc, mix(aCol, vec3(1.0), 0.10 + foc * 0.62), hi);
  cc *= 1.0 + hi * (0.30 + uSel * 0.12) + foc * (0.42 + uSel * 0.10) + ctx * 0.55;
  vCol = cc;
  // the field pass hands the lit subgraph to the overlay pass rather than drawing it
  // twice; the crossfade keeps that handover invisible mid-transition
  float passFade = (uPass > 0.5) ? 1.0 : 1.0 - smoothstep(0.78, 0.94, s);
  vA   = mix(1.0, 0.34, dim) * (1.0 + hi * 0.35 + ctx * 0.30) * passFade;
  vHi  = hi; vFoc = foc;
}`

const NODE_FS = `
precision highp float;
varying vec3 vCol; varying float vA; varying float vHi; varying float vFoc; varying float vShape;
void main(){
  if (vShape > 0.5) {
    // a skill: a four-point star, as in the reference's skills band. An astroid-style
    // distance gives the pinched points; a soft halo keeps it from reading as a cut-out.
    vec2 q = abs(gl_PointCoord - 0.5) * 2.0;
    float d = pow(q.x, 0.55) + pow(q.y, 0.55);
    float star = 1.0 - smoothstep(0.92, 1.08, d);
    float halo = pow(max(0.0, 1.0 - length(q)), 2.4) * 0.35;
    float sa = clamp(star + halo, 0.0, 1.0);
    if (sa < 0.01) discard;
    vec3 sc = mix(vCol, vec3(1.0), star * (0.35 + 0.4 * vHi));
    gl_FragColor = vec4(sc, sa * vA);
    return;
  }
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float soft  = pow(smoothstep(1.0, 0.0, r), 1.75);
  // A lit node is an annulus with a tight core, not a filled disc, so a hub keeps its
  // department hue when the camera dollies in instead of clipping to cream.
  float core  = smoothstep(mix(0.33, 0.54, vFoc), mix(0.15, 0.32, vFoc), r);
  float ring  = smoothstep(0.50, 0.57, r) * smoothstep(0.83, 0.72, r);
  float glow  = pow(smoothstep(1.0, 0.0, r), 2.6) * 0.38;
  float hiA   = core * 0.82 + ring * (0.98 + 0.30 * vFoc) + glow;
  float a     = mix(soft, hiA, vHi);
  vec3  cc    = mix(vCol, vec3(1.0), clamp(core, 0.0, 1.0) * (0.50 + 0.40 * vFoc) * vHi);
  gl_FragColor = vec4(cc, clamp(a, 0.0, 1.0) * vA);
}`

/** state a node is coming from / going to, and the set touched by the last change */
let s0 = new Float32Array(0)
let s1 = new Float32Array(0)
let touched: number[] = []
let mixStart = performance.now()
const MIX_MS = 260
let focusIdx: number | null = null
let committed = false
let neighbours: number[] = []
let hiPoints: THREE.Points | null = null
/** last frame's hub-pill screen boxes, handed to the label layer as no-go areas */
let hubBoxes: { x: number; y: number; hw: number; hh: number; tag?: string }[] = []
let appBoxes: { x: number; y: number; hw: number; hh: number; tag?: string }[] = []

/**
 * Where each ring's title sits, radially: just INSIDE its own ring, as in sb_000310,
 * which stacks them down the centreline APPLICATIONS → ROUTINES → MEMORY with SKILLS
 * above the root. Spacing is set so neighbouring titles clear the rejector; badge
 * names now hang outward, which is what frees the space under the top badge.
 */
const RING_TITLE_R: Record<string, number> = {
  // Measured from sb_000310 (0.93 / 0.79 / 0.665 / 0.12 of the app ring), then adjusted
  // where our drifting badges and hubs differ from the reference's static ones. With the
  // top-down camera the scale is a uniform 0.644px per unit; a badge 6–15° off the top
  // sits low enough to clip a title at 452, which hid APPLICATIONS 47% of frames, so it
  // moves in to 436. Worked through in UI-CHANGES.md.
  SKILLS: 56,
  MEMORY: 333,
  ROUTINES: 395,
  APPLICATIONS: 436,
}
let ringTitles: { world: THREE.Vector3; r: number }[] = []

// Headless verification hook: which labels are on screen, and what hid the rest.
;(globalThis as { __labelDbg?: unknown }).__labelDbg = {
  shown: () => labels?.shown() ?? [],
  why: (t: string) => labels?.why(t) ?? null,
  hidden: () => labels?.hidden() ?? [],
  reserved: () => hubBoxes,
}

/** Put every ring title on its ring's far side from the camera — top-centre on screen. */
function aimRingTitles() {
  if (!ringTitles.length) return
  // the camera sits at (cos θ, sin θ) around the target, so the far side is the opposite
  const fx = -Math.cos(cam.theta)
  const fz = -Math.sin(cam.theta)
  for (const t of ringTitles) {
    // on the plane, not lifted: a lift reads as a shift UP the screen at this tilt and
    // pushed each title onto its own ring line. Negative r aims at the NEAR side, which
    // is how the root's own label sits below it.
    // relative to the RING centre, not the camera target: after a click the camera flies
    // to the chosen node, and anchoring to the target dragged every title along with it
    t.world.set(centre.x + fx * t.r, 2, centre.z + fz * t.r)
  }
}

const currentMix = () => Math.min(1, (performance.now() - mixStart) / MIX_MS)

/**
 * Set which node is lit, and light its neighbours with it.
 *
 * `commit` is the difference between hover and click: both drain the field, but a
 * commit drains it harder and swells the lit subgraph further, so the click reads as
 * a physical lift rather than a change of caption.
 */
function setFocus(i: number | null, commit = false) {
  if (!points || !s1.length) return
  const m = currentMix()
  const next: number[] = []
  neighbours = []
  if (i !== null) {
    next.push(i)
    const seen = new Set<number>([i])
    for (const { id } of adj.get(i) ?? []) {
      if (seen.has(id)) continue
      seen.add(id)
      neighbours.push(id)
    }
    for (const t of neighbours) next.push(t)
  }
  // freeze the in-flight crossfade into aS0 before retargeting, or a fast hover across
  // several nodes snaps instead of blending
  for (const k of new Set<number>([...touched, ...next])) {
    s0[k] = (s0[k] ?? 0) + ((s1[k] ?? 0) - (s0[k] ?? 0)) * m
    s1[k] = 0
  }
  if (i !== null) {
    s1[i] = 2
    for (const t of neighbours) s1[t] = 1
  }
  touched = next
  focusIdx = i
  ;(globalThis as { __arcCount?: number }).__arcCount = neighbours.length // test hook
  committed = i !== null && commit
  const geo = points.geometry
  geo.attributes.aS0!.needsUpdate = true
  geo.attributes.aS1!.needsUpdate = true
  mixStart = performance.now()
  if (hiPoints) hiPoints.visible = i !== null
  buildArcs(i)
}

/**
 * Curved connectors from the pick to each neighbour.
 *
 * The gauntlet build drew these as screen-space ribbons with their own side/width
 * attributes; this is the same quadratic bezier bowed away from the origin, drawn as
 * plain additive line segments. At our node counts the ribbon machinery bought nothing
 * a 2px additive line does not already give.
 */
const ARC_SEG = 18
const MAX_ARC = 220
let arcLines: THREE.LineSegments | null = null

function buildArcs(focus: number | null) {
  if (arcLines) {
    scene.remove(arcLines)
    arcLines.geometry.dispose()
    arcLines = null
  }
  if (focus === null || !neighbours.length) return
  const list = neighbours.slice(0, MAX_ARC)
  const vp = new Float32Array(list.length * ARC_SEG * 2 * 3)
  const vc = new Float32Array(list.length * ARC_SEG * 2 * 3)
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const mid = new THREE.Vector3()
  const ctl = new THREE.Vector3()
  const cFrom = new THREE.Color(groupColor.get(g.nodes[focus]?.group ?? '') ?? 0xffffff)
  let v = 0
  for (const t of list) {
    a.set(pos[focus * 3] ?? 0, pos[focus * 3 + 1] ?? 0, pos[focus * 3 + 2] ?? 0)
    b.set(pos[t * 3] ?? 0, pos[t * 3 + 1] ?? 0, pos[t * 3 + 2] ?? 0)
    mid.copy(a).add(b).multiplyScalar(0.5)
    const span = a.distanceTo(b)
    const om = mid.length() || 1
    // bow the arc outward from the centre and lift it, so overlapping links separate
    ctl.copy(mid)
    ctl.x += (mid.x / om) * span * 0.2
    ctl.y += (mid.y / om) * span * 0.2 + span * 0.1
    ctl.z += (mid.z / om) * span * 0.2
    const cTo = new THREE.Color(groupColor.get(g.nodes[t]?.group ?? '') ?? 0x8fa3c8)
    let px = 0
    let py = 0
    let pz = 0
    for (let k = 0; k <= ARC_SEG; k++) {
      const u = k / ARC_SEG
      const iu = 1 - u
      const x = iu * iu * a.x + 2 * iu * u * ctl.x + u * u * b.x
      const y = iu * iu * a.y + 2 * iu * u * ctl.y + u * u * b.y
      const z = iu * iu * a.z + 2 * iu * u * ctl.z + u * u * b.z
      if (k > 0) {
        const mixc = u ** 0.58
        const r = cFrom.r + (cTo.r - cFrom.r) * mixc
        const gg = cFrom.g + (cTo.g - cFrom.g) * mixc
        const bb = cFrom.b + (cTo.b - cFrom.b) * mixc
        // fades along its length so the far end does not fight the neighbour's own glow
        const fade = 1 - u * 0.45
        vp[v * 3] = px
        vp[v * 3 + 1] = py
        vp[v * 3 + 2] = pz
        vc[v * 3] = r * fade
        vc[v * 3 + 1] = gg * fade
        vc[v * 3 + 2] = bb * fade
        v++
        vp[v * 3] = x
        vp[v * 3 + 1] = y
        vp[v * 3 + 2] = z
        vc[v * 3] = r * fade
        vc[v * 3 + 1] = gg * fade
        vc[v * 3 + 2] = bb * fade
        v++
      }
      px = x
      py = y
      pz = z
    }
  }
  const ag = new THREE.BufferGeometry()
  ag.setAttribute('position', new THREE.BufferAttribute(vp, 3))
  ag.setAttribute('color', new THREE.BufferAttribute(vc, 3))
  ag.setDrawRange(0, v)
  arcLines = new THREE.LineSegments(
    ag,
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    }),
  )
  arcLines.frustumCulled = false
  arcLines.renderOrder = 2
  scene.add(arcLines)
}

function build() {
  // A rebuild (opening a node, a recall, a filter) must not drop the selection. openNode
  // sets the focus and then calls build(), which used to wipe it a moment later — the
  // inspector opened, but the lit subgraph and the lock never held.
  const keepFocus = focusIdx
  const keepCommitted = committed
  for (const o of [points, lines, hiPoints])
    if (o) {
      scene.remove(o)
      if (o !== hiPoints) o.geometry.dispose()
    }
  const n = g.nodes.length
  const col = new Float32Array(n * 3)
  const siz = new Float32Array(n)
  const cap = new Float32Array(n)
  s0 = new Float32Array(n)
  s1 = new Float32Array(n)
  touched = []
  focusIdx = null
  neighbours = []
  const c = new THREE.Color()
  g.nodes.forEach((nd, i) => {
    // aCol is now the PURE department colour. Dimming and highlighting are the
    // shader's job, so this no longer bakes state into the vertex data.
    c.setHex(
      layoutMode === 'arms' && nd.arms === 'SKILLS'
        ? 0xff8a4c
        : (groupColor.get(nd.group) ?? 0x63708f),
    ).multiplyScalar(1.45)
    col[i * 3] = c.r
    col[i * 3 + 1] = c.g
    col[i * 3 + 2] = c.b
    siz[i] = (nd.kind === 'router' ? 30 : nd.kind === 'doc' ? 19 : 15) * (bandScale[i] ?? 1)
    cap[i] = nd.kind === 'router' ? 30 : nd.kind === 'doc' ? 20 : 15
    // recall matches and an isolated department ride the same relatedness channel as
    // hover does, so there is one dimming model on screen rather than two
    if (highlight.has(i)) s1[i] = 1.2
    else if (dimGroup !== null && nd.group === dimGroup) s1[i] = 0.75
  })
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aCol', new THREE.BufferAttribute(col, 3))
  geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1))
  geo.setAttribute('aCap', new THREE.BufferAttribute(cap, 1))
  geo.setAttribute('aS0', new THREE.BufferAttribute(s0, 1))
  geo.setAttribute('aS1', new THREE.BufferAttribute(s1, 1))
  // skills are drawn as stars in the ARMS layout
  const shape = new Float32Array(n)
  if (layoutMode === 'arms') {
    g.nodes.forEach((nd, i) => {
      shape[i] = nd.arms === 'SKILLS' ? 1 : 0
    })
  }
  geo.setAttribute('aShape', new THREE.BufferAttribute(shape, 1))
  points = new THREE.Points(
    geo,
    new THREE.ShaderMaterial({
      uniforms: NODE_U,
      vertexShader: NODE_VS,
      fragmentShader: NODE_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  )
  points.frustumCulled = false
  scene.add(points)

  // second draw of the SAME geometry carrying only the lit subgraph, so the pick and
  // its neighbours sit crisply on top of the additive field
  hiPoints = new THREE.Points(
    geo,
    new THREE.ShaderMaterial({
      uniforms: { ...NODE_U, uPass: { value: 1 } },
      vertexShader: NODE_VS,
      fragmentShader: NODE_FS,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    }),
  )
  hiPoints.frustumCulled = false
  hiPoints.renderOrder = 3
  hiPoints.visible = false
  scene.add(hiPoints)

  const shown = layoutMode === 'arms' ? g.links.filter((l) => l.type === 'pointer') : g.links
  const lp = new Float32Array(shown.length * 6)
  shown.forEach((l, i) => {
    for (let k = 0; k < 3; k++) {
      lp[i * 6 + k] = pos[l.s * 3 + k] ?? 0
      lp[i * 6 + 3 + k] = pos[l.t * 3 + k] ?? 0
    }
  })
  const lg = new THREE.BufferGeometry()
  lg.setAttribute('position', new THREE.BufferAttribute(lp, 3))
  lines = new THREE.LineSegments(
    lg,
    new THREE.LineBasicMaterial({
      color: layoutMode === 'arms' ? 0xff7a45 : 0x4a5f92,
      transparent: true,
      opacity: layoutMode === 'arms' ? 0.16 : highlight.size ? 0.07 : 0.14,
      depthWrite: false,
    }),
  )
  scene.add(lines)

  // the disc ends at 0.72 of the app ring, leaving a dark gap before the routines ring
  buildDisc(ARMS[1].r)
  jarvis.setActive(layoutMode === 'arms')
  core.setActive(layoutMode === 'arms')
  routinesRing.setActive(layoutMode === 'arms')
  agentsRing.setActive(layoutMode === 'arms')
  if (layoutMode === 'arms') {
    routinesRing.build({ routines: g.routines ?? [], radius: ARMS[2].r, top: indexTop })
    agentsRing.build({
      nodes: g.nodes,
      pos,
      root: rootIndex(),
      memoryR: ARMS[1].r,
      routinesR: ARMS[2].r,
      top: indexTop,
    })
  }
  if (layoutMode === 'arms') {
    const ri = rootIndex()
    core.build({
      root: ri >= 0 ? nodePos(ri) : new THREE.Vector3(),
      skills: skillCount,
      band: [ARMS[0].r - 22, ARMS[0].r + 23],
    })
  }
  if (layoutMode === 'arms') {
    jarvis.build({ skills: ARMS[0].r, disc: ARMS[1].r, routines: ARMS[2].r, apps: ARMS[3].r })
  }

  // --- ARMS ring arcs: thin coloured circles that name the structure ---------
  for (const o of ringArcs) scene.remove(o)
  ringArcs = []
  if (layoutMode === 'arms') {
    for (const layer of ARMS) {
      // memory is a filled disc in the reference, not a ring line
      // memory is a filled disc and skills a star band (core.ts), not ring lines
      if (layer.id === 'MEMORY' || layer.id === 'SKILLS') continue
      const pts: THREE.Vector3[] = []
      for (let i = 0; i <= 160; i++) {
        const a = (i / 160) * Math.PI * 2
        pts.push(new THREE.Vector3(Math.cos(a) * layer.r, 0, Math.sin(a) * layer.r))
      }
      const arc = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: layer.colour, transparent: true, opacity: 0.34 }),
      )
      scene.add(arc)
      ringArcs.push(arc)
    }
    // Source sectors: a thin coloured band just outside the disc spanning each source's
    // bands, so the category boundaries read at a glance. RingGeometry is authored in XY;
    // after the −π/2 turn about X a geometry angle t lands at world angle −t, hence the
    // mirrored start.
    for (const sa of sourceArcs) {
      const col = new THREE.Color().setHSL(SOURCE_HUE[sa.source] ?? 0.6, 0.7, 0.6)
      const band = new THREE.Mesh(
        new THREE.RingGeometry(ARMS[1].r + 17, ARMS[1].r + 21, 64, 1, -sa.a1, sa.a1 - sa.a0),
        new THREE.MeshBasicMaterial({
          color: col,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
          depthTest: false,
          side: THREE.DoubleSide,
        }),
      )
      band.rotation.x = -Math.PI / 2
      band.renderOrder = -4
      scene.add(band)
      ringArcs.push(band)
    }
  }

  // id-coloured twin, same positions/sizes, rendered only for picking
  if (pickPoints) {
    pickScene.remove(pickPoints)
    pickPoints.geometry.dispose()
  }
  const pid = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const id = i + 1 // 0 = background
    pid[i * 3] = ((id >> 16) & 255) / 255
    pid[i * 3 + 1] = ((id >> 8) & 255) / 255
    pid[i * 3 + 2] = (id & 255) / 255
  }
  const pg = new THREE.BufferGeometry()
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  pg.setAttribute('color', new THREE.BufferAttribute(pid, 3))
  pg.setAttribute('aSize', new THREE.BufferAttribute(siz, 1))
  pickPoints = new THREE.Points(
    pg,
    new THREE.ShaderMaterial({
      vertexColors: true,
      vertexShader: `attribute float aSize; varying vec3 vC;
      void main(){ vC=color; vec4 mv=modelViewMatrix*vec4(position,1.0);
        gl_PointSize=max(aSize*(520.0/-mv.z), 6.0); gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `varying vec3 vC;
      void main(){ if(length(gl_PointCoord-0.5)>0.5) discard; gl_FragColor=vec4(vC,1.0); }`,
    }),
  )
  pickScene.add(pickPoints)
  if (keepFocus !== null && keepFocus < n) setFocus(keepFocus, keepCommitted)
}
// debug hook
;(globalThis as { __pick?: (x: number, y: number) => number }).__pick = (x, y) => pickAt(x, y)

/**
 * Node index under the cursor, or -1.
 *
 * Renders the id-coloured scene into a half-resolution target and reads one pixel.
 * An earlier attempt used camera.setViewOffset into a 1x1 target — theoretically
 * cheaper, but it never produced a hit, and a half-res pass is inexpensive enough.
 */
function pickAt(cx: number, cy: number): number {
  const rect = stage.getBoundingClientRect()
  const sx = (cx - rect.left) / rect.width
  const sy = (cy - rect.top) / rect.height
  if (sx < 0 || sx > 1 || sy < 0 || sy > 1) return -1

  const w = Math.max(1, Math.floor(rect.width * PICK_SCALE))
  const h = Math.max(1, Math.floor(rect.height * PICK_SCALE))
  if (pickTarget.width !== w || pickTarget.height !== h) pickTarget.setSize(w, h)

  const prevClear = renderer.getClearColor(new THREE.Color())
  const prevAlpha = renderer.getClearAlpha()
  renderer.setRenderTarget(pickTarget)
  renderer.setClearColor(0x000000, 1)
  renderer.clear()
  renderer.render(pickScene, camera)

  // readRenderTargetPixels origin is bottom-left; screen y runs top-down
  const px = Math.min(w - 1, Math.max(0, Math.floor(sx * w)))
  const py = Math.min(h - 1, Math.max(0, Math.floor((1 - sy) * h)))
  // sample a small neighbourhood so small points are still catchable
  let found = -1
  for (const [ox, oy] of PICK_OFFSETS) {
    const qx = px + ox
    const qy = py + oy
    if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue
    renderer.readRenderTargetPixels(pickTarget, qx, qy, 1, 1, pickBuf)
    const id = ((pickBuf[0] ?? 0) << 16) | ((pickBuf[1] ?? 0) << 8) | (pickBuf[2] ?? 0)
    if (id > 0 && id <= g.nodes.length) {
      found = id - 1
      break
    }
  }
  renderer.setRenderTarget(null)
  renderer.setClearColor(prevClear, prevAlpha)
  return found
}

// ---------------------------------------------------------------- camera ----
// Spherical orbit around a target, with pan, zoom-to-cursor, keyboard flight, fly-to and
// idle auto-spin. `want` is where the view is heading and `cam` follows it with a
// time-based ease, so the feel is the same at 60 and 120 Hz. Direct manipulation (a drag)
// writes both, so the world stays glued to the pointer; everything else (wheel, keys,
// fly-to) writes `want`. Interaction pauses the idle spin so the view never drifts out
// from under you mid-inspection.
const cam = { theta: 0, phi: 1.05, radius: 1400, target: new THREE.Vector3() }
let want = { ...cam, target: new THREE.Vector3() }
let idleSince = performance.now()
let dragging = false
/** ease time constant, ms: 0.08 per frame at 60 Hz, which is what the old per-frame lerp was */
const EASE = 200
const ZOOM_MIN = 120
const zoomMax = () => frameRadius * 4
/** steepest tilt: the flat ARMS disc must never go edge-on; the 3D layouts can go under */
const phiMax = () => (layoutMode === 'arms' ? 1.25 : Math.PI - 0.15)
/** how far the target may wander from the centre: to the edge of the map, not into the void */
const panMax = () => frameRadius * 1.15
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** The layout's opening view: ARMS straight down with its index at 12 o'clock, the 3D layouts tilted. */
function homeView() {
  return {
    // the ARMS index was laid out for one camera angle (see indexTop); the 3D layouts keep theirs
    theta: layoutMode === 'arms' ? indexTop - Math.PI : want.theta,
    // straight down, as in the reference; the other layouts are 3D and read better tilted
    phi: layoutMode === 'force' ? 1.02 : layoutMode === 'arms' ? 0 : 0.36,
    radius: frameRadius * (layoutMode === 'force' ? 1.5 : 2.24),
    target: centre.clone(),
  }
}

/** Back to the opening view: `0`, Home, a double-click on empty space, or the ⌂ button. */
function resetView() {
  want = homeView()
  idleSince = performance.now() + 4000
}

function flyTo(p: THREE.Vector3, radius: number) {
  // in ARMS the disc is flat, so a fly-to keeps the current (overhead) angle; the 3D
  // layouts still swing to a three-quarter view
  want = {
    theta: cam.theta,
    phi: layoutMode === 'arms' ? want.phi : 0.95,
    radius,
    target: p.clone(),
  }
  idleSince = performance.now() + 4000 // hold still after arriving
}

/** Keep the target on the map: within panMax of the centre, and on the disc plane in ARMS. */
function clampTarget(t: THREE.Vector3) {
  if (layoutMode === 'arms') t.y = centre.y
  const dx = t.x - centre.x
  const dz = t.z - centre.z
  const d = Math.hypot(dx, dz)
  const m = panMax()
  if (d > m) {
    t.x = centre.x + (dx / d) * m
    t.z = centre.z + (dz / d) * m
  }
  return t
}

/** world units per stage pixel at the target's distance */
const unitsPerPx = (stageH: number, radius = cam.radius) =>
  (2 * Math.tan((camera.fov * Math.PI) / 360) * radius) / stageH

// The surface a pan or a zoom-to-cursor grabs: the disc itself in ARMS, or a plane through
// the target facing the camera in the 3D layouts, which reads as "the thing under the
// pointer". Null when the pointer is off the surface (above the horizon at a steep tilt),
// or the hit is so far out along a grazing ray that a step from it would be wild.
const grabPlane = new THREE.Plane()
const grabRay = new THREE.Raycaster()
const grabNdc = new THREE.Vector2()
function grabPoint(clientX: number, clientY: number, out: THREE.Vector3) {
  const r = stage.getBoundingClientRect()
  grabNdc.set(((clientX - r.left) / r.width) * 2 - 1, -(((clientY - r.top) / r.height) * 2 - 1))
  grabRay.setFromCamera(grabNdc, camera)
  if (layoutMode === 'arms') grabPlane.set(new THREE.Vector3(0, 1, 0), -centre.y)
  else grabPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(out).negate(), cam.target)
  const hit = grabRay.ray.intersectPlane(grabPlane, out)
  if (!hit || hit.distanceTo(camera.position) > cam.radius * 4) return null
  return hit
}

/** Move the target by stage pixels along screen-right and screen-up, on the grab surface. */
const panRight = new THREE.Vector3()
const panUp = new THREE.Vector3()
function panBy(rightPx: number, upPx: number, radius = cam.radius) {
  const r = stage.getBoundingClientRect()
  const u = unitsPerPx(r.height, radius)
  panRight.setFromMatrixColumn(camera.matrixWorld, 0)
  panUp.setFromMatrixColumn(camera.matrixWorld, 1)
  if (layoutMode === 'arms') {
    // slide along the disc, however the view is tilted
    panRight.y = 0
    panUp.y = 0
    if (panUp.lengthSq() < 1e-6)
      panUp
        .copy(panRight)
        .cross(new THREE.Vector3(0, 1, 0))
        .negate()
    panRight.normalize()
    panUp.normalize()
  }
  want.target.addScaledVector(panRight, rightPx * u).addScaledVector(panUp, upPx * u)
  clampTarget(want.target)
}

const zoomHit = new THREE.Vector3()
/**
 * Dolly by a factor. Zooming in dollies toward the point under the pointer, so what you
 * aimed at stays put; zooming out drifts the target home, so a full zoom-out always lands
 * on the whole map, centred.
 */
function zoomBy(factor: number, clientX?: number, clientY?: number) {
  const r0 = want.radius
  const max = zoomMax()
  const r1 = clamp(r0 * factor, ZOOM_MIN, max)
  if (factor < 1) {
    if (r1 === r0) return
    if (clientX !== undefined && clientY !== undefined && grabPoint(clientX, clientY, zoomHit)) {
      want.target.lerp(zoomHit, 1 - r1 / r0)
    }
  } else {
    // home by the time the zoom hits its ceiling, and never slower than a third per step
    const toMax = r0 < max ? (r1 - r0) / (max - r0) : 1
    want.target.lerp(centre, Math.min(1, Math.max(toMax, (factor - 1) * 3)))
  }
  clampTarget(want.target)
  want.radius = r1
  idleSince = performance.now()
}

// Keyboard flight: WASD pans, Q/E and ←/→ orbit, ↑/↓ tilt, +/- zoom. Held keys are
// integrated per frame here, so movement is smooth and two keys move diagonally. `s` is
// also the sessions shortcut: a tap opens them, a hold flies backward (see keyup).
const held = new Set<string>()
let shiftDown = false
let sTapAt = 0
let sArmed = false
function flyKeys(dtMs: number) {
  if (!held.size) return
  const s = (dtMs / 1000) * (shiftDown ? 2.4 : 1)
  const back =
    held.has('KeyS') &&
    (performance.now() - sTapAt > 180 || held.has('KeyW') || held.has('KeyA') || held.has('KeyD'))
  if (back) sArmed = false
  const px = Number(held.has('KeyD')) - Number(held.has('KeyA'))
  const py = Number(held.has('KeyW')) - Number(back)
  if (px || py) {
    // 0.8 stage heights per second, wherever the zoom is
    const step = stage.getBoundingClientRect().height * 0.8 * s
    const n = px && py ? Math.SQRT1_2 : 1
    panBy(px * step * n, py * step * n, want.radius)
  }
  const orbit =
    Number(held.has('KeyE') || held.has('ArrowRight')) -
    Number(held.has('KeyQ') || held.has('ArrowLeft'))
  if (orbit) want.theta -= orbit * 1.5 * s // same sense as dragging that way
  const tilt = Number(held.has('ArrowUp')) - Number(held.has('ArrowDown'))
  if (tilt) want.phi = clamp(want.phi + tilt * 1.2 * s, 0, phiMax())
  const zoom =
    Number(held.has('Minus') || held.has('NumpadSubtract')) -
    Number(held.has('Equal') || held.has('NumpadAdd'))
  if (zoom) zoomBy(Math.exp(zoom * 1.6 * s))
  idleSince = performance.now()
}
const FLY_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Equal',
  'Minus',
  'NumpadAdd',
  'NumpadSubtract',
])

const ringProbe = new THREE.Vector3()
// Headless verification hook: the camera's tilt and the applications ring's projected
// outline (stage px), so roundness and centring can be measured rather than eyeballed.
;(globalThis as { __camDbg?: unknown }).__camDbg = {
  phi: () => cam.phi,
  theta: () => ({ cam: cam.theta, want: want.theta, top: indexTop }),
  // the whole state, for the camera e2e suite: where the view is, and where it is heading
  state: () => ({
    cam: { theta: cam.theta, phi: cam.phi, radius: cam.radius, target: cam.target.toArray() },
    want: { theta: want.theta, phi: want.phi, radius: want.radius, target: want.target.toArray() },
    centre: centre.toArray(),
    frameRadius,
    dragging,
    held: [...held],
    vel: { theta: vel.theta, phi: vel.phi, target: vel.target.toArray() },
    sinceMove: performance.now() - lastMoveT,
    dragMode,
    pointers: pointers.size,
  }),
  grab: (x: number, y: number) => grabPoint(x, y, new THREE.Vector3())?.toArray() ?? null,
  reset: resetView,
  /** land the ease now, so a test starts from a known view */
  snap: () => {
    Object.assign(cam, { theta: want.theta, phi: want.phi, radius: want.radius })
    cam.target.copy(want.target)
  },
  ring: () => {
    const r = stage.getBoundingClientRect()
    const out: [number, number][] = []
    for (let k = 0; k < 72; k++) {
      const a = (k / 72) * Math.PI * 2
      const q = new THREE.Vector3(
        centre.x + Math.cos(a) * ARMS[3].r,
        centre.y,
        centre.z + Math.sin(a) * ARMS[3].r,
      ).project(camera)
      out.push([((q.x + 1) / 2) * r.width, ((1 - q.y) / 2) * r.height])
    }
    return { w: r.width, h: r.height, pts: out }
  },
}

/** untouched this long, the map is idle: no drift, and frames only for what still moves */
const IDLE_AFTER = 20_000
/** idle frame gap while something still animates (~15fps: the rings turn slowly) */
const AMBIENT_MS = 66
/** idle frame gap with nothing moving: late data and the clock hand still show within a second */
const HEARTBEAT_MS = 1000

/** true while page UI with a solid background (history, mission control, a full panel) hides the
 *  whole stage: the map is out of view, so it stops drawing until something uncovers it */
let stageCovered = false
/** how much of the window shows map, 0–1: the stage's size times the share of it left uncovered */
let stageShare = 1
/** less than this and the map is only glimpsed (a strip beside panels, a blur under frosted UI):
 *  it draws at GLIMPSE_MS while you use the app and once a second when idle */
const GLIMPSE_SHARE = 0.2
const GLIMPSE_MS = 250
/** the pointer is over the map: whatever shows of it gets full rate */
let pointerOnStage = false
stage.addEventListener('pointerenter', () => {
  pointerOnStage = true
  wakeMap()
})
stage.addEventListener('pointerleave', () => {
  pointerOnStage = false
})
/** a 5 × 3 grid over the stage */
const COVER_PROBES: [number, number][] = [0.15, 0.5, 0.85].flatMap((fy) =>
  [0.1, 0.3, 0.5, 0.7, 0.9].map((fx): [number, number] => [fx, fy]),
)
const alphaOf = (c: string) => {
  if (c === 'transparent') return 0
  const slash = c.match(/\/\s*([\d.]+)(%?)\s*\)$/)
  if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1)
  const rgba = c.match(/^rgba\((?:[^,]+,){3}\s*([\d.]+)\)$/)
  return rgba ? Number(rgba[1]) : 1
}
/**
 * Does page UI at (x, y) hide the stage there? Nearly opaque counts (85%), and so does frosted
 * UI: under a backdrop blur the map is a smear, and redrawing it also re-blurs the panel on
 * every frame. A faded element is looked through to what it sits on.
 */
function coveredAt(x: number, y: number) {
  for (let e = document.elementFromPoint(x, y); e && e !== document.body; e = e.parentElement) {
    // inside the stage, or a wrapper the stage sits in (and so paints behind it)
    if (stage.contains(e) || e.contains(stage)) return false
    const cs = getComputedStyle(e)
    if (e instanceof HTMLIFrameElement || alphaOf(cs.backgroundColor) >= 0.85) return true
    const blur = cs.backdropFilter || cs.getPropertyValue('-webkit-backdrop-filter')
    if (blur && blur !== 'none') return true
  }
  return false
}
function checkCovered() {
  if (document.hidden || !stageShown) return
  // only the part of the stage inside the window: the stage box can run far past it, and a
  // probe off screen finds nothing on top and would count as the map showing
  const b = stage.getBoundingClientRect()
  const x0 = Math.max(0, b.left)
  const y0 = Math.max(0, b.top)
  const w = Math.min(innerWidth, b.right) - x0
  const h = Math.min(innerHeight, b.bottom) - y0
  const seen =
    w < 2 || h < 2
      ? 0
      : COVER_PROBES.filter(([fx, fy]) => !coveredAt(x0 + w * fx, y0 + h * fy)).length
  const was = stageShare
  stageCovered = seen === 0
  stageShare = (seen / COVER_PROBES.length) * ((w * h) / (innerWidth * innerHeight))
  // something may have uncovered it, or new data may want drawing: a sleeping loop looks again
  // (one that is only napping until its next idle frame is left alone, unless it just came out
  // from a glimpse into full view)
  if (stageCovered) return
  if ((!mapRaf && !mapNap) || (was < GLIMPSE_SHARE && stageShare >= GLIMPSE_SHARE)) wakeMap()
}
// stops while the window is hidden; a quarter as often while another app is in front
activity.every(400, checkCovered)
// closing a panel is a click or a key: look again at once rather than on the next tick. One look
// per frame however many events came in, and none for transitions inside a chat: a streaming log
// fires them in bursts, and each look forces a style pass over the page.
let coverSoon = 0
const coverNextFrame = () => {
  coverSoon ||= requestAnimationFrame(() => {
    coverSoon = 0
    checkCovered()
  })
}
for (const ev of ['pointerup', 'keyup'] as const)
  addEventListener(ev, coverNextFrame, { passive: true })
addEventListener(
  'transitionend',
  (e) => {
    if (!(e.target as Element | null)?.closest?.('.ss-chat')) coverNextFrame()
  },
  { passive: true },
)

let lastInput = performance.now()
for (const ev of ['pointermove', 'pointerdown', 'wheel', 'keydown'] as const)
  addEventListener(
    ev,
    () => {
      lastInput = performance.now()
      wakeMap()
    },
    { passive: true, capture: true },
  )
activity.onLevel(() => wakeMap())
addEventListener('resize', () => wakeMap())

/**
 * The loop only asks for frames while it draws. Paused (covered, hidden, squeezed out) it asks for
 * none and waits for wakeMap; idle it naps until the next frame is due. A rAF left running with
 * nothing to draw still costs a main-thread frame and a composite on every vsync.
 */
let mapRaf = 0
let mapNap: ReturnType<typeof setTimeout> | null = null
function wakeMap() {
  if (mapNap) clearTimeout(mapNap)
  mapNap = null
  if (!mapRaf) mapRaf = requestAnimationFrame(frameMap)
}
function napMap(ms: number) {
  if (mapNap || mapRaf) return
  mapNap = setTimeout(() => {
    mapNap = null
    wakeMap()
  }, ms)
}
function frameMap() {
  mapRaf = 0
  loop()
}
/** the camera has eased all the way to where it was asked to be */
function cameraSettled() {
  return (
    Math.abs(want.theta - cam.theta) < 1e-4 &&
    Math.abs(want.phi - cam.phi) < 1e-4 &&
    Math.abs(want.radius - cam.radius) < 1e-3 &&
    cam.target.distanceToSquared(want.target) < 1e-6
  )
}

function loop() {
  const now = performance.now()
  // nothing of the map shows under the browser, under chats that fill the window, under a panel
  // that covers it, or in a stage the wide docked chats have squeezed to nothing, so then it
  // costs nothing
  chatsEl ??= document.getElementById('ss')
  const chats = chatsEl?.classList.contains('on') ?? false
  if (
    document.body.classList.contains('wb-open') ||
    !stageShown ||
    stageCovered ||
    (chats && !chatsEl?.classList.contains('dock'))
  ) {
    // asleep until the cover check, input or a level change wakes it
    lastT = now
    return
  }
  // mostly out of sight: a few frames a second while you use the app, a heartbeat when idle;
  // pointing at it or dragging it brings it straight back to full rate
  const glimpse = stageShare < GLIMPSE_SHARE && !dragging && !held.size && !pointerOnStage
  if (glimpse) {
    const gap = activity.atLeast('idle') ? HEARTBEAT_MS : GLIMPSE_MS
    if (now - lastT < gap) return void napMap(gap - (now - lastT))
    napMap(gap)
  }
  // beside open chats the map runs at 30fps and leaves them the rest of each frame; a drag stays smooth
  if (!glimpse && chats && !dragging && now - lastT < 28) return void wakeMap()
  // left alone, the map stops asking for frames: the drift ends, and once the camera has
  // settled it draws only as fast as what still moves needs (the JARVIS rings, a recall, a
  // running session's beam, a focus pulse), or once a second so data and the clock hand land.
  // With another window in front it is idle at once, and what moves gets ~4fps.
  // In the background the app is at its lowest: a heartbeat only. Idle, the JARVIS rings stop
  // turning (decoration, not news); what reports something (a working agent's beam, the core's
  // pulse, a recall, a focus) keeps the ambient rate.
  const away = activity.atLeast('away')
  const idle = away || now - Math.max(lastInput, idleSince) > IDLE_AFTER
  if (idle && !dragging && !held.size && (away || (hoverIdx < 0 && cameraSettled()))) {
    const moving =
      core.animating() ||
      agentsRing.animating() ||
      focusIdx !== null ||
      highlight.size > 0 ||
      !cameraSettled()
    const gap = away ? HEARTBEAT_MS : moving ? AMBIENT_MS : HEARTBEAT_MS
    if (now - lastT < gap) return void napMap(gap - (now - lastT))
    // draw this one, then nap straight to the next: no in-between frame just to find it too soon
    napMap(gap)
  } else if (!glimpse) wakeMap()
  // a tab in the background gets no frames; when it comes back, ease from here, don't jump
  const dtCam = Math.min(100, now - lastT)
  flyKeys(dtCam)
  // gentle idle drift, except in ARMS: the ring is an A→Z clock-face index there, and it
  // only reads if 12 o'clock stays put (the JARVIS rings still turn)
  if (!dragging && !idle && layoutMode !== 'arms' && now - idleSince > 3500)
    want.theta += 0.066 * (dtCam / 1000)

  const step = 1 - Math.exp(-dtCam / EASE)
  cam.theta += (want.theta - cam.theta) * step
  cam.phi += (want.phi - cam.phi) * step
  cam.radius += (want.radius - cam.radius) * step
  cam.target.lerp(want.target, step)

  const sp = Math.sin(cam.phi)
  camera.position.set(
    cam.target.x + sp * Math.cos(cam.theta) * cam.radius,
    cam.target.y + Math.cos(cam.phi) * cam.radius,
    cam.target.z + sp * Math.sin(cam.theta) * cam.radius,
  )
  // The reference is shot straight down: its rings are true circles (920 × 923px). At
  // phi = 0 the usual world-up is parallel to the view direction and lookAt has no
  // defined roll, so "up" is set explicitly to the continuous orbit up vector
  //   u = (−cosφ·cosθ, sinφ, −cosφ·sinθ)
  // which is world-up for a side view and the ring's far side for a top-down one. That
  // is also exactly the direction aimRingTitles treats as screen-top.
  const cp = Math.cos(cam.phi)
  camera.up.set(-cp * Math.cos(cam.theta), sp, -cp * Math.sin(cam.theta))
  camera.lookAt(cam.target)
  camera.updateMatrixWorld()
  // Keep the application ring vertically centred at ANY tilt. A tilted disc projects its
  // centre off the ellipse's centre, so measure instead of calibrating: project the
  // ring's far and near points and shift the frustum by their midpoint's error. The
  // shift fades out as the camera leaves the ring centre, or a fly-to would drag the
  // view back toward a ring that is no longer the subject.
  const off = stage.getBoundingClientRect()
  camera.clearViewOffset()
  const pull = Math.max(0, 1 - cam.target.distanceTo(centre) / 60)
  if (layoutMode === 'arms' && pull > 0) {
    const fx = -Math.cos(cam.theta) * ARMS[3].r
    const fz = -Math.sin(cam.theta) * ARMS[3].r
    const yf = ringProbe.set(centre.x + fx, centre.y, centre.z + fz).project(camera).y
    const yn = ringProbe.set(centre.x - fx, centre.y, centre.z - fz).project(camera).y
    // px the ring's centre sits BELOW the stage centre; a positive frustum offset moves
    // content up by exactly that many px
    const low = (-(yf + yn) / 2) * (off.height / 2) * pull
    if (Math.abs(low) > 0.25) {
      camera.setViewOffset(off.width, off.height, 0, low, off.width, off.height)
    }
  }
  // node-treatment drive: crossfade the relatedness state, then ease the drain toward
  // whatever the current interaction calls for. Easing rather than snapping is what
  // makes a hover feel like the field receding instead of a lamp switching on.
  NODE_U.uMix.value = currentMix()
  NODE_U.uTime.value = now / 1000
  const wantDim =
    focusIdx !== null
      ? committed
        ? 0.88
        : 0.72
      : highlight.size > 0 || dimGroup !== null
        ? 0.9
        : 0
  NODE_U.uDim.value += (wantDim - NODE_U.uDim.value) * 0.16
  NODE_U.uSel.value += ((committed ? 1 : 0) - NODE_U.uSel.value) * 0.16

  const rect = stage.getBoundingClientRect()
  // hub boxes come from the previous frame's paintHubs; one frame of lag is invisible
  // and avoids ordering the DOM pass before the render
  aimRingTitles()
  labels?.reserve(
    layoutMode === 'arms'
      ? [...hubBoxes, ...appBoxes, ...routinesRing.boxes(), ...agentsRing.boxes()]
      : [],
  )
  labels?.update(camera, rect.width, rect.height)
  core.update({ now, camera, rect, focused: focusIdx !== null })
  routinesRing.update({ camera, rect, now: new Date() })
  agentsRing.update({ camera, rect })
  nodePreview.update({ camera, rect, radius: cam.radius, hover: hoverIdx, focus: focusIdx })
  jarvis.update({
    now,
    camera,
    rect,
    focus: focusIdx !== null ? nodePos(focusIdx) : null,
    committed,
    focusLinks: neighbours.length,
    nodes: g.nodes.length,
    links: g.links.length,
    groups: memHubs.length,
  })
  renderer.render(scene, camera)

  paintApps()
  paintHubs()
  frames++
  const dt = now - lastT
  lastT = now
  hud?.sample(dt)
  if (frames % 10 === 0) {
    const fps = Math.round(1000 / Math.max(0.001, dt))
    toolFps.textContent = `${fps} fps` // same value, same tick as the HUD headline
    hud?.update({
      fps,
      ms: dt,
      nodes: g.nodes.length,
      links: g.links.length,
      draws: renderer.info.render.calls,
      iters: labels?.visible ?? 0,
    })
  }
}

/**
 * Two-letter mark for an app badge. Slicing the first two characters collided
 * "Google Calendar" and "Google Drive" into the same "GO"; one initial per word
 * separates them as GC and GD while leaving single-word names (Slack, Stripe) alone.
 */
function initials(name: string) {
  const words = name
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
  const mark =
    words.length > 1 ? (words[0]?.[0] ?? '') + (words[1]?.[0] ?? '') : (words[0] ?? '').slice(0, 2)
  return mark.toUpperCase()
}

/** Applications ring: DOM hex badges projected from their 3D position each frame. */
function paintApps() {
  const layer = $('#apps')
  if (layoutMode !== 'arms' || !appPos.length) {
    layer.style.display = 'none'
    appBoxes = []
    return
  }
  layer.style.display = 'block'
  if (layer.childElementCount !== appPos.length) {
    layer.innerHTML = appPos
      .map(
        ({ app }) => `<div class="appbadge${app.live ? '' : ' dark'}" data-app="${esc(app.id)}">
        <span class="hex">${esc(initials(app.name))}</span>
        <em>${esc(app.name)}</em>
        <div class="apptip"><b>${esc(app.name)}</b><span>${esc(app.via)}</span></div></div>`,
      )
      .join('')
  }
  const rect = stage.getBoundingClientRect()
  const v = new THREE.Vector3()
  // the ring's centre on screen, so each name can hang radially OUTWARD from its badge
  v.copy(centre).project(camera) // the ring's centre, which the camera leaves on a fly-to
  const cx = ((v.x + 1) / 2) * rect.width
  const cy = ((1 - v.y) / 2) * rect.height
  const abox: { x: number; y: number; hw: number; hh: number; tag?: string }[] = []
  appPos.forEach(({ v: world }, i) => {
    const el = layer.children[i] as HTMLElement | undefined
    if (!el) return
    v.copy(world).project(camera)
    if (v.z > 1) {
      el.style.display = 'none'
      return
    }
    el.style.display = 'block'
    const sx = ((v.x + 1) / 2) * rect.width
    const sy = ((1 - v.y) / 2) * rect.height
    el.style.left = `${sx}px`
    el.style.top = `${sy}px`

    // Names hang outward along the radius rather than below the hex. Below-the-hex put
    // the top badge's name inside the ring, exactly where the ring titles stack — the
    // reference avoids that by showing no names at all, but our initials are not
    // recognisable the way brand glyphs are, so the names stay and move outside.
    const name = el.querySelector('em') as HTMLElement | null
    const hexR = 17
    if (name) {
      let dx = sx - cx
      let dy = sy - cy
      const len = Math.hypot(dx, dy) || 1
      dx /= len
      dy /= len
      const nw = name.offsetWidth
      const nh = name.offsetHeight
      // clear the hex, then half the name's own extent along the same direction
      const d = hexR + 5 + Math.abs(dx) * (nw / 2) + Math.abs(dy) * (nh / 2)
      const nx = dx * d
      const ny = dy * d
      name.style.transform = `translate(-50%, -50%) translate(${nx.toFixed(1)}px, ${ny.toFixed(1)}px)`
      abox.push({ x: sx + nx, y: sy + ny, hw: nw / 2 + 3, hh: nh / 2 + 2, tag: 'app-name' })
    }
    abox.push({ x: sx, y: sy, hw: hexR + 3, hh: hexR + 2, tag: 'app-hex' })
  })
  appBoxes = abox
}

/**
 * Department hubs, projected from the root of each spiral arm.
 *
 * In the reference these live IN the graph and you click them to filter. Ours used to
 * be rows in a side legend — same capability, but a legend teaches you nothing about
 * where a department sits. Putting the hub on its own arm means the structure is the
 * control.
 */
/** half-size of a department marker's dot plus its rim, in px */
const HUB_DOT = 8.5
/** A department's display name: no source prefix (colour and the source arc carry that). */
const hubName = (grp: string) => {
  let n = grp.replace(/^(claude|dev|documents|workspace)\s*[/·]\s*/i, '')
  // a generic leftover ("memory", "other") would read as a ring title or say nothing, so
  // those keep their source: CLAUDE MEMORY, DEV OTHER
  if (/^(other|memory|plans|skills)$/i.test(n)) n = grp.replace(/\s*[/·]\s*/, ' ')
  n = n.toUpperCase()
  return n.length > 18 ? `${n.slice(0, 17)}…` : n
}

function paintHubs() {
  const layer = $('#hubs')
  if (layoutMode !== 'arms' || !memHubs.length) {
    layer.style.display = 'none'
    return
  }
  layer.style.display = 'block'
  if (layer.childElementCount !== memHubs.length) {
    layer.innerHTML = memHubs
      .map(
        (h) =>
          `<div class="hub" data-hub="${esc(h.name)}" style="--hc:#${h.colour.toString(16).padStart(6, '0')}">
        <i></i><span><em>${esc(hubName(h.name))}</em><b>${h.count.toLocaleString()}</b></span></div>`,
      )
      .join('')
    for (const el of layer.querySelectorAll('[data-hub]')) {
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        const name = (el as HTMLElement).dataset.hub ?? null
        dimGroup = dimGroup === name ? null : name
        build()
        renderLegend()
      })
    }
  }
  const rect = stage.getBoundingClientRect()
  const v = new THREE.Vector3()
  v.copy(centre).project(camera) // the ring's centre, which the camera leaves on a fly-to
  const cx = ((v.x + 1) / 2) * rect.width
  const cy = ((1 - v.y) / 2) * rect.height
  // Sunburst labels: each department's name is rotated along its own band's radius,
  // starting at its dot and reading outward over the band it names. Centred-below names
  // spread sideways at 3 and 9 o'clock and ran into the root label and the SKILLS title;
  // radial names stack side by side around the circle and never reach inward.
  const LEAD = 9 // px from the dot's centre to the start of the name
  const placed: {
    i: number
    n: number
    ang: number
    rpx: number
    chain: { x: number; y: number; hw: number; hh: number; tag: string }[]
    dot: { x: number; y: number; hw: number; hh: number; tag: string }
  }[] = []
  memHubs.forEach((h, i) => {
    const el = layer.children[i] as HTMLElement | undefined
    if (!el) return
    v.copy(h.hub).project(camera)
    if (v.z > 1) {
      el.style.display = 'none'
      return // behind the camera: reserves nothing
    }
    el.style.display = 'block'
    el.classList.toggle('on', dimGroup === h.name)
    el.classList.toggle('off', (dimGroup !== null && dimGroup !== h.name) || focusIdx !== null)
    const sx = ((v.x + 1) / 2) * rect.width
    const sy = ((1 - v.y) / 2) * rect.height
    el.style.left = `${sx}px`
    el.style.top = `${sy}px`
    const label = el.querySelector('span') as HTMLElement | null
    if (!label) return
    // label size is measured once, unrotated and unmuted, so muting can't make it flicker
    if (!el.dataset.fw) {
      el.dataset.fw = String(label.offsetWidth)
      el.dataset.fh = String(label.offsetHeight)
    }
    const w = Number(el.dataset.fw)
    const lh = Number(el.dataset.fh)
    const ang = Math.atan2(sy - cy, sx - cx) // screen angle, y down, clockwise positive
    const deg = (ang * 180) / Math.PI
    // keep text upright: on the left half, turn it round and let it end at the dot
    const flip = Math.cos(ang) < 0
    label.style.transform = flip
      ? `rotate(${deg + 180}deg) translate(calc(-100% - ${LEAD}px), -50%)`
      : `rotate(${deg}deg) translate(${LEAD}px, -50%)`
    // For the canvas label layer, the rotated name is reserved as a chain of small squares
    // along its length. One upright bounding box of a diagonal name is mostly empty space,
    // and it hid ring titles and source labels that never touched the text.
    const ux = Math.cos(ang)
    const uy = Math.sin(ang)
    const chain: { x: number; y: number; hw: number; hh: number; tag: string }[] = []
    for (let d = LEAD + lh / 2; d < LEAD + w; d += lh * 0.8) {
      chain.push({ x: sx + ux * d, y: sy + uy * d, hw: lh / 2, hh: lh / 2, tag: 'hub' })
    }
    placed.push({
      i,
      n: h.count,
      ang,
      rpx: Math.hypot(sx - cx, sy - cy),
      chain,
      dot: { x: sx, y: sy, hw: HUB_DOT, hh: HUB_DOT, tag: 'hub' },
    })
  })
  // Radial names collide only when two dots sit closer along the circle than a name is
  // tall. Biggest department first; a name that would sit too close to one already shown
  // collapses to its dot, and shows on hover.
  placed.sort((a, b) => b.n - a.n)
  const kept: (typeof placed)[number][] = []
  const boxes: { x: number; y: number; hw: number; hh: number; tag: string }[] = []
  for (const p of placed) {
    const lh = Number((layer.children[p.i] as HTMLElement).dataset.fh) || 14
    const clash = kept.some((k) => {
      const d = Math.abs(Math.atan2(Math.sin(p.ang - k.ang), Math.cos(p.ang - k.ang)))
      return d * Math.min(p.rpx, k.rpx) < lh + 1
    })
    ;(layer.children[p.i] as HTMLElement).classList.toggle('mute', clash)
    if (!clash) kept.push(p)
    boxes.push(p.dot)
    if (!clash) boxes.push(...p.chain)
  }
  hubBoxes = boxes
}

// ------------------------------------------------------------ interaction ----
const tip = document.createElement('div')
tip.id = 'tip'
stage.appendChild(tip)
let hoverIdx = -1
// live previews: in the tooltip, in the inspector, and on the nodes when zoomed in
// (see node-preview.ts); `p` toggles the in-scene cards
const nodePreview = createNodePreview({
  stage,
  nodes: () => g.nodes,
  pos: (i, out) => out.set(pos[i * 3] ?? 0, pos[i * 3 + 1] ?? 0, pos[i * 3 + 2] ?? 0),
  visible: (i) => dimGroup === null || g.nodes[i]?.group === dimGroup,
  colour: (i) =>
    `#${(groupColor.get(g.nodes[i]?.group ?? '') ?? 0x63708f).toString(16).padStart(6, '0')}`,
  open: (i) => {
    const nd = g.nodes[i]
    if (!nd) return
    setFocus(i, true)
    tip.classList.remove('on')
    openNode(i, nd.path)
  },
})
/** where the primary press landed, for telling a click from a drag */
let downAt = { x: 0, y: 0, t: 0 }
// Pointers on the stage. One pointer pans (the hand cursor's promise) or, with alt/shift,
// the middle or the right button, orbits. Two fingers pinch to zoom and slide to pan.
const pointers = new Map<number, { x: number; y: number }>()
let dragMode: 'pan' | 'orbit' | 'pinch' = 'pan'
let pinched = false
let pinch = { d0: 1, r0: 1 }
// velocity over the last moves, so a flick glides to a stop instead of dead-stopping
const vel = { theta: 0, phi: 0, target: new THREE.Vector3() }
let lastMoveT = 0
const grabA = new THREE.Vector3()
const grabB = new THREE.Vector3()

stage.addEventListener('pointermove', (e) => {
  // Reset the idle timer BEFORE the overlay guard. The department hubs are overlay
  // elements, so returning early left the ring drifting under the pointer while you
  // were reaching for one — a click target that will not hold still.
  idleSince = performance.now()
  if (!dragging && onOverlay(e)) return
  const p = pointers.get(e.pointerId)
  if (dragging && p) {
    const now = performance.now()
    const dtm = Math.max(1, now - lastMoveT)
    const blend = lastMoveT ? 0.5 : 1
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    if (dragMode === 'pinch') {
      const [a, b] = [...pointers.values()]
      if (a && b) {
        const mx0 = (a.x + b.x) / 2
        const my0 = (a.y + b.y) / 2
        p.x = e.clientX
        p.y = e.clientY
        const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))
        want.radius = clamp(pinch.r0 * (pinch.d0 / d), ZOOM_MIN, zoomMax())
        cam.radius = want.radius
        // the fingers' midpoint drags the map
        panBy(-((a.x + b.x) / 2 - mx0), (a.y + b.y) / 2 - my0)
        cam.target.copy(want.target)
      }
    } else if (dragMode === 'orbit') {
      const dTheta = -dx * 0.005
      const dPhi = clamp(want.phi - dy * 0.005, 0, phiMax()) - want.phi
      want.theta += dTheta
      want.phi += dPhi
      cam.theta = want.theta
      cam.phi = want.phi
      vel.theta += (dTheta / dtm - vel.theta) * blend
      vel.phi += (dPhi / dtm - vel.phi) * blend
      p.x = e.clientX
      p.y = e.clientY
    } else {
      // pan: the point that was under the pointer stays under it, exactly; off the
      // surface (above the horizon at a steep tilt) fall back to pixel scaling
      const before = want.target.clone()
      if (grabPoint(p.x, p.y, grabA) && grabPoint(e.clientX, e.clientY, grabB)) {
        want.target.add(grabA).sub(grabB)
        clampTarget(want.target)
      } else {
        panBy(-dx, dy)
      }
      cam.target.copy(want.target)
      grabA.copy(want.target).sub(before).divideScalar(dtm)
      vel.target.lerp(grabA, blend)
      p.x = e.clientX
      p.y = e.clientY
    }
    lastMoveT = now
    return
  }
  const i = pickAt(e.clientX, e.clientY)
  if (i === hoverIdx) {
    if (i >= 0) {
      tip.style.left = `${e.clientX - stage.getBoundingClientRect().left + 14}px`
      tip.style.top = `${e.clientY - stage.getBoundingClientRect().top + 14}px`
    }
    return
  }
  hoverIdx = i
  // a commit outranks hover: once you have clicked a node, moving the pointer around
  // must not quietly re-aim the focus out from under the inspector you are reading
  if (!committed) setFocus(i < 0 ? null : i, false)
  if (i < 0) {
    tip.classList.remove('on')
    nodePreview.hover(null, tip)
    stage.style.cursor = 'grab'
    return
  }
  const nd = g.nodes[i]
  if (!nd) return
  stage.style.cursor = 'pointer'
  if (committed) return
  tip.innerHTML = `<b>${esc(nd.name)}</b><span>${esc(nd.dir || '(root)')}</span>
    <span class="g">${esc(nd.group)} · ${(nd.bytes / 1024).toFixed(1)}KB</span>`
  const r = stage.getBoundingClientRect()
  tip.style.left = `${e.clientX - r.left + 14}px`
  tip.style.top = `${e.clientY - r.top + 14}px`
  tip.classList.add('on')
  nodePreview.hover(i, tip)
})

/** True when the event started on an overlay control rather than the canvas. */
const onOverlay = (e: Event) =>
  !!(e.target as HTMLElement | null)?.closest(
    '.hud, #legend, #inspector, #apps, #hubs, #rt, #ag, #np-layer, #panel, .rail-tab, #wb',
  )

stage.addEventListener('pointerdown', (e) => {
  if (onOverlay(e)) return
  // a right-click on a node opens the ring menu (contextmenu); on empty space it orbits
  if (e.button === 2 && layoutMode === 'arms' && pickAt(e.clientX, e.clientY) >= 0) return
  if (e.button > 2) return
  try {
    stage.setPointerCapture(e.pointerId)
  } catch {} // a synthetic pointer (tests) has no capture to take
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  idleSince = performance.now()
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    if (a && b) pinch = { d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), r0: want.radius }
    dragMode = 'pinch'
    pinched = true
    return
  }
  if (pointers.size > 2) return
  dragging = true
  pinched = false
  dragMode = e.button === 1 || e.button === 2 || e.altKey || e.shiftKey ? 'orbit' : 'pan'
  vel.theta = 0
  vel.phi = 0
  vel.target.set(0, 0, 0)
  lastMoveT = 0
  downAt = { x: e.clientX, y: e.clientY, t: performance.now() }
  stage.style.cursor = dragMode === 'orbit' ? 'move' : 'grabbing'
})

function endPointer(e: PointerEvent) {
  if (!pointers.delete(e.pointerId)) {
    dragging = false
    return
  }
  if (pointers.size) {
    // one of two fingers lifted: carry on as a pan with the one still down
    dragMode = 'pan'
    vel.target.set(0, 0, 0)
    lastMoveT = 0
    return
  }
  dragging = false
  stage.style.cursor = 'grab'
  // a flick keeps going: the ease integrates a velocity v into a glide of v·EASE
  if (e.type === 'pointerup' && lastMoveT && performance.now() - lastMoveT < 120) {
    if (dragMode === 'orbit') {
      want.theta += clamp(vel.theta * EASE, -1.2, 1.2)
      want.phi = clamp(want.phi + clamp(vel.phi * EASE, -0.6, 0.6), 0, phiMax())
    } else if (dragMode === 'pan') {
      const glide = grabA.copy(vel.target).multiplyScalar(EASE)
      const max = frameRadius * 0.6
      if (glide.length() > max) glide.setLength(max)
      clampTarget(want.target.add(glide))
    }
  }
  if (e.type !== 'pointerup' || e.button !== 0 || dragMode !== 'pan' || pinched) return
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y)
  if (moved > 5 || performance.now() - downAt.t > 400) return // a drag, not a click
  const i = pickAt(e.clientX, e.clientY)
  if (i < 0) {
    if (committed) setFocus(null) // click empty space to release
    return
  }
  const nd = g.nodes[i]
  if (nd) {
    setFocus(i, true)
    // the commit promotes this node into the inspector, so the hover tooltip is now a
    // second copy of the same name floating over the HUD
    tip.classList.remove('on')
    nodePreview.hover(null, tip)
    openNode(i, nd.path)
  }
}
stage.addEventListener('pointerup', endPointer)
stage.addEventListener('pointercancel', endPointer)

// double-click a node to fly right up to it; double-click empty space to go home
stage.addEventListener('dblclick', (e) => {
  if (onOverlay(e) || e.button !== 0) return
  const i = pickAt(e.clientX, e.clientY)
  if (i >= 0) flyTo(nodePos(i), 380)
  else resetView()
})

// right-click a file or folder on the ring: start a Claude session in its repo. On empty
// space the right button orbits instead, so the browser's own menu stays out of the way.
stage.addEventListener('contextmenu', (e) => {
  if (onOverlay(e)) return
  e.preventDefault()
  if (layoutMode !== 'arms') return
  const i = pickAt(e.clientX, e.clientY)
  const nd = i >= 0 ? g.nodes[i] : undefined
  if (!nd) return
  sessionsView.menuFor(nd.path, e.clientX, e.clientY)
})

stage.addEventListener('pointerleave', () => {
  tip.classList.remove('on')
  nodePreview.hover(null, tip)
  hoverIdx = -1
  if (!committed) setFocus(null)
})
stage.addEventListener(
  'wheel',
  (e) => {
    if (onOverlay(e)) return // the inspector's own scroll
    e.preventDefault()
    // proportional to the delta, so a trackpad glides and a wheel notch steps ~12%; a
    // trackpad pinch arrives as ctrl+wheel with small deltas and gets a bigger gain
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
    const dy = clamp(e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0012), -0.5, 0.5)
    zoomBy(Math.exp(dy), e.clientX, e.clientY)
  },
  { passive: false },
)

function nodePos(i: number) {
  return new THREE.Vector3(pos[i * 3] ?? 0, pos[i * 3 + 1] ?? 0, pos[i * 3 + 2] ?? 0)
}

/**
 * Floating node inspector, modelled on the reference: identity, type badges,
 * size/age, actions, and the connections list. Floating rather than docked so
 * inspecting a node never costs you the graph you found it in.
 */
function showInspector(i: number) {
  const nd = g.nodes[i]
  if (!nd) return
  const card = $('#inspector')
  const neigh = (adj.get(i) ?? []).slice(0, 12)
  const counts = new Map<string, number>()
  for (const n of adj.get(i) ?? []) counts.set(n.type, (counts.get(n.type) ?? 0) + 1)
  const col = `#${(groupColor.get(nd.group) ?? 0x63708f).toString(16).padStart(6, '0')}`
  const ext = nd.name.includes('.') ? nd.name.split('.').pop() : ''

  card.innerHTML = `
    <div class="ins-h">
      <div><div class="ins-t">${esc(nd.name)}</div>
      <div class="ins-p">${esc(nd.dir || '(root)')}</div></div>
      <button class="ins-x" id="ins-close">×</button></div>
    <div class="ins-badges">
      <span class="bdg" style="border-color:${col};color:${col}">${esc(nd.group)}</span>
      <span class="bdg">${esc(nd.docType ?? nd.kind)}</span>
      ${nd.project && nd.path.startsWith('@') ? `<span class="bdg" title="project">${esc(nd.project)}</span>` : ''}
      ${EXTRACTED.test(nd.name) ? '<span class="bdg">extracted</span>' : ''}
    </div>
    <div class="ins-meta">${(nd.bytes / 1024).toFixed(1)} KB${ext ? ` · .${esc(ext)}` : ''} · ${(adj.get(i) ?? []).length} links</div>
    <div id="ins-prev"></div>
    <div class="ins-acts">
      <button class="ghost" id="ins-view">View here</button>
      <button class="ghost" id="ins-open">Open on device</button>
      <button class="ghost" id="ins-copy">Copy path</button>
      <button class="ghost" id="ins-fly">Fly to</button>
    </div>
    ${
      neigh.length
        ? `<div class="ins-sec">connections</div>
      <div class="ins-conn">${neigh
        .map((nb) => {
          const o = g.nodes[nb.id]
          if (!o) return ''
          const oc = `#${(groupColor.get(o.group) ?? 0x63708f).toString(16).padStart(6, '0')}`
          return `<div class="cn" data-n="${nb.id}"><i style="background:${oc}"></i>
          <span>${esc(o.name)}</span><em>${esc(nb.type)}</em></div>`
        })
        .join('')}</div>
      ${[...counts].map(([t, c]) => `<span class="bdg sm">${esc(t)} ×${c}</span>`).join(' ')}`
        : ''
    }`
  card.classList.add('on')

  $('#ins-close').addEventListener('click', () => card.classList.remove('on'))
  $('#ins-view').addEventListener('click', () => quickLook.open(qlItem(i)))
  nodePreview.mount($('#ins-prev'), i, () => quickLook.open(qlItem(i)))
  $('#ins-open').addEventListener('click', () => {
    fetch(`/api/reveal?path=${encodeURIComponent(nd.path)}`).catch(() => {})
  })
  $('#ins-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(nd.path).catch(() => {})
    flash('path copied')
  })
  $('#ins-fly').addEventListener('click', () => flyTo(nodePos(i), 380))
  for (const el of card.querySelectorAll('.cn')) {
    el.addEventListener('click', () => openNode(Number((el as HTMLElement).dataset.n), ''))
  }
}

/** Frame a node and inspect it. The graph stays visible — that is the point. */
function openNode(i: number, _path: string) {
  highlight = new Set([i])
  build()
  buildLabels()
  flyTo(nodePos(i), 520)
  showInspector(i)
}

// -------------------------------------------------------------------- ui ----
const EXAMPLES = [
  'which TTS voice do we use',
  'contractor agreement',
  'what is the hard cap on pointer hops',
  'where do performance claims live',
]

function emptyState() {
  panel.innerHTML = `<div class="empty">
    <h2>Ask the brain</h2>
    <p>Deterministic retrieval over ${g.nodes.length.toLocaleString()} indexed files.
       No model is called — answers come back in about a millisecond, at zero token cost.</p>
    <div class="ex">${EXAMPLES.map((e) => `<button data-ex="${esc(e)}">${esc(e)}</button>`).join('')}</div>
    <p style="margin-top:20px;font-size:12px">Press <kbd>⌘K</kbd> to search ·
       <kbd>↑</kbd><kbd>↓</kbd> to move through results · <kbd>↵</kbd> to open</p>
  </div>`
  for (const b of panel.querySelectorAll('[data-ex]')) {
    b.addEventListener('click', () => {
      const q = (b as HTMLElement).dataset.ex ?? ''
      qInput.value = q
      ask(q)
    })
  }
}

function splitPath(p: string) {
  const i = p.lastIndexOf('/')
  return { dir: i === -1 ? '' : p.slice(0, i), name: i === -1 ? p : p.slice(i + 1) }
}

let current: Recall | null = null
let selIdx = 0

function renderResult(r: Recall) {
  current = r
  selIdx = 0
  if (r.noMatch) {
    panel.innerHTML = `<div class="kpi"><span class="pill low">no match</span>
      <span>searched <b>${g.nodes.length.toLocaleString()}</b> files</span></div>
      <div class="empty"><p>Nothing in the index matches
      <b>${esc(r.tokens.join(', ') || 'that')}</b>.</p>
      <p style="font-size:12.5px">If it should have matched, that is a gap in the router files rather
      than a bug — <code>/calibrate</code> proposes the fix.</p></div>`
    return
  }
  const conf = r.lowConfidence
    ? '<span class="pill low">low confidence — sources may disagree</span>'
    : `<span class="pill ok">clear match · margin ${(r.margin * 100).toFixed(0)}%</span>`

  panel.innerHTML = `
    <div class="kpi">${conf}
      <span><b>${(r.stats.msTotal).toFixed(1)}</b>ms</span>
      <span><b>${(r.stats.bytesRead / 1024).toFixed(1)}</b>KB read</span>
      <span><b>0</b> model tokens</span>
      ${r.stats.hops ? `<span><b>${r.stats.hops}</b> hop</span>` : ''}</div>
    <div class="sec">${r.candidates.length} candidate${r.candidates.length === 1 ? '' : 's'}</div>
    <div id="cands">${r.candidates
      .map((c, i) => {
        const { dir, name } = splitPath(c.path)
        const tag = EXTRACTED.test(name) ? '<span class="tag">extracted</span>' : ''
        return `<div class="cand${i === 0 ? ' sel' : ''}" data-i="${i}" data-p="${esc(c.path)}">
        <span class="pct">${(c.relative * 100).toFixed(0)}%</span>
        <span><span class="fname">${esc(name)}${tag}</span>
        ${dir ? `<span class="fdir">${esc(dir)}</span>` : ''}</span></div>`
      })
      .join('')}</div>
    <div class="sec">evidence</div>
    ${r.evidence
      .map((e) => {
        const { dir, name } = splitPath(e.path)
        return `<div class="ev"><header>
        <div class="p">${esc(name)}</div>
        <div class="s">${esc(dir)} · lines ${esc(e.lines)}${e.heading ? ` · ${esc(e.heading)}` : ''}${e.viaHop ? ' · followed pointer' : ''}</div>
      </header><div class="body">${esc(e.text)}</div></div>`
      })
      .join('')}
    <div class="acts">
      <button class="ghost" id="reveal">Reveal in Finder</button>
      <button class="ghost" id="copy">Copy path</button>
      <button class="ghost" id="openfile">View full file</button>
    </div>`

  for (const el of panel.querySelectorAll('.cand')) {
    el.addEventListener('click', () => select(Number((el as HTMLElement).dataset.i)))
  }
  $('#reveal').addEventListener('click', () => act('reveal'))
  $('#copy').addEventListener('click', () => act('copy'))
  $('#openfile').addEventListener('click', () => act('open'))
  highlightPaths(r.candidates.map((c) => c.path))
  playRecall(r)
}

/** Hand a recall to the centrepiece, resolved to positions on the ring. */
function playRecall(r: Recall) {
  if (layoutMode !== 'arms') return
  const at = (p: string) => {
    const i = g.nodes.findIndex((n) => n.path === p)
    return i >= 0 ? nodePos(i) : null
  }
  const cands = r.candidates
    .map((c) => ({ world: at(c.path), relative: c.relative }))
    .filter((c): c is { world: THREE.Vector3; relative: number } => c.world !== null)
  const hopEv = r.evidence.find((e) => e.viaHop)
  const from = r.evidence[0] ? at(r.evidence[0].path) : null
  const to = hopEv ? at(hopEv.path) : null
  core.recall({
    tokens: r.tokens,
    cands,
    hop: from && to ? { from, to } : null,
    ms: r.stats.msTotal,
    bytes: r.stats.bytesRead,
    noMatch: r.noMatch,
  })
}

function selectedPath(): string {
  return current?.candidates[selIdx]?.path ?? ''
}

function select(i: number) {
  if (!current) return
  selIdx = Math.max(0, Math.min(current.candidates.length - 1, i))
  for (const el of panel.querySelectorAll('.cand')) {
    el.classList.toggle('sel', Number((el as HTMLElement).dataset.i) === selIdx)
  }
  const el = panel.querySelector(`.cand[data-i="${selIdx}"]`)
  el?.scrollIntoView({ block: 'nearest' })
  // move the camera to whatever is selected, so the list and the graph agree
  const p = selectedPath()
  const idx = g.nodes.findIndex((n) => n.path === p)
  if (idx >= 0) flyTo(nodePos(idx), 620)
}

async function act(kind: 'reveal' | 'copy' | 'open') {
  const p = selectedPath()
  if (!p) return
  if (kind === 'copy') {
    await navigator.clipboard.writeText(p).catch(() => {})
    flash('path copied')
    return
  }
  if (kind === 'reveal') {
    await fetch(`/api/reveal?path=${encodeURIComponent(p)}`).catch(() => {})
    return
  }
  // the full file opens in Quick Look, the same viewer "View here" uses
  const i = indexOfPath(p)
  if (i >= 0) quickLook.open(qlItem(i))
}

function flash(msg: string) {
  const el = document.createElement('div')
  el.textContent = msg
  el.style.cssText =
    'position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:#141726;' +
    'border:1px solid #242a3d;border-radius:8px;padding:8px 16px;font-size:12.5px;z-index:99;color:#e8ecf8'
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 1600)
}

function highlightPaths(paths: string[]) {
  const set = new Set(paths)
  highlight = new Set(g.nodes.map((n, i) => (set.has(n.path) ? i : -1)).filter((i) => i >= 0))
  build()
  buildLabels()
}

function showPanel(on: boolean) {
  panelShell.classList.toggle('on', on)
  if (!on) core.clear()
}
$('#panel .p-close').addEventListener('click', () => showPanel(false))

async function ask(q: string) {
  showPanel(true)
  panel.innerHTML = '<div class="empty"><p>recalling…</p></div>'
  const r: Recall = await (await fetch(`/api/recall?q=${encodeURIComponent(q)}`)).json()
  renderResult(r)
}

// ------------------------------------------------------------- grouping ----
type GroupBy = 'smart' | 'source' | 'project' | 'docType' | 'folder'
const GROUP_BY: [GroupBy, string][] = [
  ['smart', 'Smart'],
  ['source', 'Source'],
  ['project', 'Project'],
  ['docType', 'Type'],
  ['folder', 'Folder'],
]
const MAX_GROUPS = 24
let groupBy: GroupBy = 'smart'
try {
  const saved = localStorage.getItem('orbit:group-by') as GroupBy | null
  if (saved && GROUP_BY.some(([k]) => k === saved)) groupBy = saved
} catch {}

/** Re-band every node by the chosen facet; the long tail folds into "other". */
function applyGrouping() {
  const keyOf = (nd: Node): string => {
    nd.smart ??= nd.group
    if (groupBy === 'smart') return nd.smart
    if (groupBy === 'project') {
      // the primary source's "project" is its top folder; others are namespaced
      return nd.path.startsWith('@') ? `${nd.source}/${nd.project}` : (nd.folder ?? nd.smart)
    }
    return nd[groupBy] ?? nd.smart
  }
  const keys = g.nodes.map(keyOf)
  const counts = new Map<string, number>()
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1)
  const ranked = [...counts].sort((a, b) => b[1] - a[1])
  // smart bands are already curated server-side; folding them would bury ROUTERS
  const keep = new Set(
    ranked.slice(0, groupBy === 'smart' ? ranked.length : MAX_GROUPS).map(([k]) => k),
  )
  const folded = new Map<string, number>()
  g.nodes.forEach((nd, i) => {
    const k = keys[i] as string
    nd.group = keep.has(k) ? k : 'other'
    folded.set(nd.group, (folded.get(nd.group) ?? 0) + 1)
  })
  g.groups = [...folded].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }))
}

function setGrouping(mode: GroupBy) {
  groupBy = mode
  try {
    localStorage.setItem('orbit:group-by', mode)
  } catch {}
  dimGroup = null
  applyGrouping()
  layout()
  build()
  renderLegend()
}

function setLayout(mode: LayoutMode) {
  layoutMode = mode
  layout()
  build()
  want = homeView()
  renderLegend()
}

function renderLegend() {
  const total = g.nodes.length
  $('#tool-layout').textContent = { arms: 'ARMS', rings: 'Rings', force: 'Packed' }[layoutMode]
  $('#legend').innerHTML =
    `<div class="lt">layout</div>
     <div class="modes">
       <button class="lmode${layoutMode === 'arms' ? ' on' : ''}" data-lm="arms">ARMS</button>
       <button class="lmode${layoutMode === 'rings' ? ' on' : ''}" data-lm="rings">Rings</button>
       <button class="lmode${layoutMode === 'force' ? ' on' : ''}" data-lm="force">Packed</button>
     </div>
     <div class="lt" style="margin-top:10px">group by</div>
     <div class="modes">${GROUP_BY.map(
       ([k, l]) =>
         `<button class="lmode${groupBy === k ? ' on' : ''}" data-gb="${k}">${l}</button>`,
     ).join('')}</div>
     <div class="lt" style="margin-top:10px">${g.groups.length} groups · click to isolate</div>
     <div class="glist">` +
    g.groups
      .map((gr) => {
        const col = `#${(groupColor.get(gr.name) ?? 0x63708f).toString(16).padStart(6, '0')}`
        return `<div class="g" data-g="${esc(gr.name)}" title="${esc(gr.name)} · ${gr.n} files"><i style="background:${col}"></i>
        <span class="gn">${esc(gr.name)}</span>
        <span class="n">${gr.n} · ${((gr.n / total) * 100).toFixed(0)}%</span></div>`
      })
      .join('') +
    '</div>'
  for (const el of $('#legend').querySelectorAll('[data-lm]')) {
    el.addEventListener('click', () => setLayout((el as HTMLElement).dataset.lm as LayoutMode))
  }
  for (const el of $('#legend').querySelectorAll('[data-gb]')) {
    el.addEventListener('click', () => setGrouping((el as HTMLElement).dataset.gb as GroupBy))
  }
  for (const el of $('#legend').querySelectorAll('.g')) {
    el.addEventListener('click', () => {
      const name = (el as HTMLElement).dataset.g ?? null
      dimGroup = dimGroup === name ? null : name
      build()
    })
  }
}

/** the summary card's "now": the host writes a summary of the last hour, and the card shows it */
async function writeSummaryNow(btn: HTMLElement) {
  btn.textContent = '…'
  try {
    await fetch('/api/control/agent/summary', { method: 'POST', headers: { 'x-control': '1' } })
  } catch {}
  await loadWidgets()
}

async function loadWidgets() {
  try {
    widgets = await (await fetch('/api/widgets')).json()
  } catch {
    widgets = []
  }
  renderOS()
}

let summaryRecapOpen = false
function renderOS() {
  // a refresh mid-drag or mid-resize would pull the rail out from under the pointer
  if (isDragging() || isResizing() || isFolding()) return
  $('#rail-l').innerHTML = renderRail(widgets, 'left')
  $('#rail-r').innerHTML = renderRail(widgets, 'right')
  // the summary card's away recap stays open across the minute refresh
  if (summaryRecapOpen)
    for (const d of document.querySelectorAll('.sm-recap')) d.setAttribute('open', '')
  tickClocks(document)
  for (const r of rails) fadeRail(r)
}

async function load() {
  labels ??= new LabelLayer(scene)
  if (!hud) {
    hud = makeHUD()
    const el = document.querySelector('.hud')
    if (el) $('#tele-pop').appendChild(el) // lives in the header's telemetry tool, off the stage
  }
  g = await (await fetch('/api/graph')).json()
  applyGrouping()
  buildAdjacency()
  layout()
  build()
  renderLegend()
  fit()
  // frame the whole structure. Rings only read as rings from near-overhead —
  // at a 3/4 angle a flat disc collapses to an edge-on smear.
  // the ARMS index is laid out with 12 o'clock at theta 0; the 3D layouts read better
  // from an angle
  if (layoutMode !== 'arms') want.theta = 0.6
  want = homeView()
  Object.assign(cam, { ...want, target: centre.clone() })
  hdr.innerHTML = `
    <span class="st-live"><i></i>indexed</span>
    <span class="st"><b>${g.nodes.length.toLocaleString()}</b><em>files</em></span>
    <span class="st"><b>${g.links.length.toLocaleString()}</b><em>links</em></span>
    <span class="st${g.pointerLinks ? ' accent' : ''}">
      <b>${g.pointerLinks || '—'}</b><em>${g.pointerLinks ? 'curated' : 'no routers'}</em></span>`
  // the ported HUD ships a boot overlay for the winner's long GPU layout build;
  // ours is instant, so dismiss it or it dims the page and eats every click
  hud?.bootDone()
  await loadWidgets()
  activity.every(1000, () => tickClocks(document))
  activity.every(60_000, loadWidgets, { now: false }) // pick up whatever a producer has written
}

$('#qf').addEventListener('submit', (e) => {
  e.preventDefault()
  const q = qInput.value.trim()
  if (q) ask(q)
})

// header tools: one dropdown open at a time; outside click or Escape closes
const tools = [...document.querySelectorAll<HTMLElement>('#tools .tool')]
const openTool = (t: HTMLElement | null) => {
  for (const o of tools) {
    o.classList.toggle('open', o === t)
    o.querySelector('.tool-btn')?.setAttribute('aria-expanded', String(o === t))
  }
}
for (const t of tools) {
  t.querySelector('.tool-btn')?.addEventListener('click', () =>
    openTool(t.classList.contains('open') ? null : t),
  )
}
addEventListener('pointerdown', (e) => {
  if (!(e.target as HTMLElement).closest('#tools')) openTool(null)
})

// side rails: collapse either with [ and ], or both with \ for a graph-only view.
// Remembered per browser — a convenience, so a failed read just means both open.
const rails = [$('#rail-l'), $('#rail-r')]
const railKey = ['rail-l', 'rail-r']
const setRail = (i: number, hidden: boolean) => {
  document.body.classList.toggle(`hide-${railKey[i]}`, hidden)
  try {
    localStorage.setItem(`orbit:${railKey[i]}`, hidden ? '1' : '')
  } catch {}
}
const railHidden = (i: number) => document.body.classList.contains(`hide-${railKey[i]}`)
for (const i of [0, 1]) {
  try {
    if (localStorage.getItem(`orbit:${railKey[i]}`)) setRail(i, true)
  } catch {}
  $(`.rail-tab[data-rail="${i}"]`).addEventListener('click', () => setRail(i, !railHidden(i)))
}
// the grid column animates, so the canvas has to follow it rather than wait for window resize
new ResizeObserver(fit).observe(stage)

// a rail shows a bottom fade only while there is more below
function fadeRail(r: HTMLElement) {
  r.classList.toggle('more', r.scrollTop + r.clientHeight < r.scrollHeight - 4)
}
for (const r of rails) {
  r.addEventListener('scroll', () => fadeRail(r), { passive: true })
  new ResizeObserver(() => fadeRail(r)).observe(r)
  bindCalendar(r, renderOS)
  r.addEventListener(
    'toggle',
    (e) => {
      const d = e.target as HTMLElement
      if (d.classList?.contains('sm-recap')) summaryRecapOpen = (d as HTMLDetailsElement).open
    },
    true,
  )
  // widget header actions declared in brain/widgets/*.json
  r.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    const a = t.closest<HTMLElement>('[data-action]')
    if (a?.dataset.action === 'brain-window') openBrainWindow()
    if (a?.dataset.action === 'showreel') openShowreel()
    if (a?.dataset.action === 'control') openControl(true)
    if (a?.dataset.action === 'claude-open') sessionsView.open()
    if (a?.dataset.action === 'claude-new') sessionsView.newChat()
    if (a?.dataset.action === 'summary-now') writeSummaryNow(a)
    // a summary row that belongs to a chat opens it
    const chat = !a ? t.closest<HTMLElement>('.widget[data-id="summary"] [data-sdk]') : null
    if (chat?.dataset.sdk && !sessionsView.openBySdkId(chat.dataset.sdk)) sessionsView.open()
    if (!a && t.closest('.widget[data-id="agents"] .w-item')) openControl(true)
    const gear = t.closest<HTMLElement>('[data-settings]')
    if (gear) {
      const id = gear.dataset.settings ?? ''
      openWidgetSettings(id, gear, widgets, loadWidgets, () => openBrainWindow())
    }
    const restore = t.closest<HTMLElement>('[data-restore]')
    if (restore) restoreHidden(restore.dataset.restore as 'left' | 'right', widgets, loadWidgets)
  })
}
initWidgetFold({
  rails: [rails[0] as HTMLElement, rails[1] as HTMLElement],
  widgets: () => widgets,
  save: (p) => patchWidgets(p).catch(() => loadWidgets()),
})
initWidgetResize({
  main: $('main'),
  rails: [rails[0] as HTMLElement, rails[1] as HTMLElement],
  saveHeight: (p) => patchWidgets(p).catch(() => loadWidgets()),
  setLocalHeight: (id, h) => {
    const w = widgets.find((x) => x.id === id)
    if (!w) return
    if (h === undefined) delete w.height
    else w.height = h
  },
})
initWidgetDrag({
  rails: [rails[0] as HTMLElement, rails[1] as HTMLElement],
  widgets: () => widgets,
  // the DOM already shows the new order; save it, and re-sync only if saving fails
  commit: (p) => patchWidgets(p).catch(() => loadWidgets()),
})
// the header's index figures open the same window
hdr.addEventListener('click', () => openBrainWindow())

// app version, bottom-left of the stage; the server reads it from git (see /api/version)
type AppVersion = {
  label: string
  dirty: boolean
  subject: string | null
  date: string | null
  hash: string | null
}
async function showVersion() {
  try {
    const v: AppVersion = await (await fetch('/api/version')).json()
    const el = $('#ver') as HTMLAnchorElement
    el.textContent = v.label
    el.classList.toggle('dirty', v.dirty)
    const when = v.date
      ? new Date(v.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
      : ''
    el.title = [v.subject, when, v.dirty ? 'uncommitted changes in the tree' : '']
      .filter(Boolean)
      .join('\n')
    el.hidden = false
  } catch {}
}
showVersion()
initTheme()
// the stable app's next version, once built: a quiet restart prompt in the header
initStableUpdate()
initSettings({
  layout: () => layoutMode,
  setLayout,
  groupBy: () => groupBy,
  setGrouping,
  theme: themeId,
  setTheme: applyTheme,
  railHidden,
  setRail,
  refreshWidgets: loadWidgets,
  openIndex: (tab) => openBrainWindow(tab as Parameters<typeof openBrainWindow>[0]),
  openControl: () => openControl(true),
})
$('#settings-btn').addEventListener('click', () => openSettings())
hdr.title = 'Index settings (i)'

// ----------------------------------------------------------- quick look ----
// Instant preview of a file (see quicklook.ts). "View here" opens it; space toggles it on
// the selected node, as in Finder; ←/→ walk the folder and move the selection with it.
let pathIndex: { nodes: Node[]; map: Map<string, number> } | null = null
const indexOfPath = (p: string) => {
  if (pathIndex?.nodes !== g.nodes) {
    pathIndex = { nodes: g.nodes, map: new Map(g.nodes.map((n, i) => [n.path, i])) }
  }
  return pathIndex.map.get(p) ?? -1
}
const qlItem = (i: number): QLItem => {
  const n = g.nodes[i]
  return { path: n?.path ?? '', name: n?.name ?? '', bytes: n?.bytes ?? 0, group: n?.group }
}
const quickLook = createQuickLook({
  known: (p) => indexOfPath(p) >= 0,
  siblings: (p) => {
    const dir = p.split('/').slice(0, -1).join('/')
    return g.nodes
      .map((n, i) => [n, i] as const)
      .filter(([n]) => n.dir === dir)
      .sort(([a], [b]) => COLLATE.compare(a.name, b.name))
      .map(([, i]) => qlItem(i))
  },
  onShow: (item) => {
    const i = indexOfPath(item.path)
    if (i < 0) return
    setFocus(i, true)
    showInspector(i)
  },
  reveal: (p) => {
    fetch(`/api/reveal?path=${encodeURIComponent(p)}`).catch(() => {})
  },
})

// ------------------------------------------------------------ spotlight ----
// One palette for files, departments, actions and apps, plus "ask the brain" (see
// spotlight.ts). The actions are the same ones the header, shortcuts and Brain window
// already offer, gathered in one place.
const hex = (n: number | undefined) => `#${(n ?? 0x63708f).toString(16).padStart(6, '0')}`
let previewFrom: { i: number | null; committed: boolean } | null = null
const spotlight = createSpotlight({
  files: () =>
    g.nodes.map((n, i) => ({
      i,
      name: n.name,
      path: n.path,
      group: n.group,
      colour: hex(groupColor.get(n.group)),
    })),
  groups: () => {
    const src = new Map<string, string>()
    for (const n of g.nodes) if (!src.has(n.group)) src.set(n.group, n.source ?? 'workspace')
    return g.groups.map((x) => ({
      name: x.name,
      label: x.name,
      count: x.n,
      colour: hex(groupColor.get(x.name)),
      source: src.get(x.name) ?? '',
    }))
  },
  apps: () => g.apps.map((a) => ({ name: a.name, via: a.via, live: a.live })),
  commands: () => spotCommands(),
  openFile: (i) => {
    previewFrom = null
    const nd = g.nodes[i]
    if (!nd) return
    setFocus(i, true)
    openNode(i, nd.path)
  },
  // previewing borrows the focus and hands back whatever was there before
  preview: (i) => {
    if (i !== null) {
      previewFrom ??= { i: focusIdx, committed }
      setFocus(i, false)
    } else if (previewFrom) {
      setFocus(previewFrom.i, previewFrom.committed)
      previewFrom = null
    }
  },
  isolate: (grp) => {
    dimGroup = grp
    build()
    renderLegend()
  },
  ask: (q) => {
    qInput.value = q
    ask(q)
  },
})

// commands a project registered (commands.mjs, ~/.laika/commands): 'Playtest: run squad' and the like
let registered: { id: string; title: string }[] = []
const loadRegistered = () =>
  fetch('/api/commands')
    .then((r) => r.json())
    .then((j) => (registered = Array.isArray(j.commands) ? j.commands : []))
    .catch(() => {})
loadRegistered()
setInterval(loadRegistered, 60_000)
const registeredCommands = (): SpotCommand[] =>
  registered.map((c) => ({
    id: `cmd-${c.id}`,
    title: c.title,
    run: () => {
      fetch(`/api/commands/${encodeURIComponent(c.id)}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-orbit-command': '1' },
        body: '{}',
      }).catch(() => {})
    },
  }))

function spotCommands(): SpotCommand[] {
  const cmds: SpotCommand[] = [
    ...registeredCommands(),
    // every registered panel, from the panel system itself, so a panel cannot be unreachable:
    // add one and it is in the palette, on the rail and on a key without touching this list
    ...panelCommands(),
    // and what moves them: focus, move, resize, float, fullscreen, layouts (panels.ts)
    ...windowCommands(),
    ...workspaceCommands(),
    ...ruleCommands(),
    { id: 'l-arms', title: 'Layout: ARMS', keys: '1', run: () => setLayout('arms') },
    { id: 'l-rings', title: 'Layout: Rings', keys: '2', run: () => setLayout('rings') },
    { id: 'l-packed', title: 'Layout: Packed', keys: '3', run: () => setLayout('force') },
    {
      id: 'jarvis',
      title: 'Toggle JARVIS HUD',
      keys: 'J',
      terms: 'hud rings effects',
      run: () => jarvis.toggle(),
    },
    {
      id: 'previews',
      title: 'Toggle node previews',
      keys: 'p',
      terms: 'thumbnails images documents live preview',
      run: () => nodePreview.toggle(),
    },
    { id: 'rail-l', title: 'Toggle left column', keys: '[', run: () => setRail(0, !railHidden(0)) },
    {
      id: 'rail-r',
      title: 'Toggle right column',
      keys: ']',
      run: () => setRail(1, !railHidden(1)),
    },
    {
      id: 'graph-only',
      title: 'Graph only',
      keys: '\\',
      terms: 'focus fullscreen hide columns',
      run: () => {
        const show = railHidden(0) && railHidden(1)
        setRail(0, !show)
        setRail(1, !show)
      },
    },
    ...GROUP_BY.map(
      ([k, label]): SpotCommand => ({
        id: `group-${k}`,
        title: `Group by: ${label}`,
        terms: 'bands categories',
        run: () => setGrouping(k),
      }),
    ),
    {
      id: 'browser',
      title: 'Browser',
      keys: 'B',
      terms: 'chrome web tab profile internet site url',
      run: () => browserDock.open(),
    },
    {
      id: 'youtube',
      title: 'Floating YouTube player',
      keys: 'M',
      terms: 'music video play song playlist media radio lofi youtube',
      run: () => youtube.open(),
    },
    {
      id: 'sessions',
      title: 'Claude sessions',
      keys: 'S',
      terms: 'claude code chat agent new session resume terminal',
      run: () => sessionsView.open(),
    },
    {
      id: 'col-left',
      title: 'Move column left',
      keys: '⌥⌘⇧←',
      terms: 'project spread reorder side workspace',
      run: () => {
        if (!sessionsView.moveColumn(-1)) flash('Spread projects side by side first (⌥⌘S)')
      },
    },
    {
      id: 'col-right',
      title: 'Move column right',
      keys: '⌥⌘⇧→',
      terms: 'project spread reorder side workspace',
      run: () => {
        if (!sessionsView.moveColumn(1)) flash('Spread projects side by side first (⌥⌘S)')
      },
    },
    {
      id: 'ring',
      title: 'Knowledge ring',
      keys: 'K',
      terms: 'map graph brain nodes back from browser',
      run: () => document.querySelector<HTMLElement>('#wbn [data-nav="ring"]')?.click(),
    },
    {
      id: 'broadcast',
      title: 'Broadcast to chats',
      keys: '⌥⌘E',
      terms: 'send message many all chats fleet same prompt',
      run: () => void sessionsView.broadcast(),
    },
    {
      id: 'accounts',
      title: 'Claude accounts',
      terms: 'login sign in connect subscription usage limits',
      run: () => void sessionsView.accounts(),
    },
    // developer tools: in the palette only with Settings → App → Developer on (devfeatures.ts)
    ...(devFeatures()
      ? [
          {
            id: 'showreel',
            title: 'Open Showreel Studio',
            keys: 'V',
            terms: 'reel film video script voice narration render',
            run: () => openShowreel(),
          },
          {
            id: 'mission',
            title: 'Mission Control',
            keys: 'G',
            terms: 'build panel lanes checkpoints verdicts learning chat game studio forge',
            run: () => openMission(),
          },
        ]
      : []),
    {
      id: 'brain',
      title: 'Open Brain window',
      keys: 'I',
      terms: 'index settings',
      run: () => openBrainWindow(),
    },
    {
      id: 'idx-src',
      title: 'Index: add a folder',
      terms: 'sources',
      run: () => openBrainWindow('sources'),
    },
    {
      id: 'idx-files',
      title: 'Index: find a file',
      terms: 'files browse',
      run: () => openBrainWindow('files'),
    },
    {
      id: 'idx-rules',
      title: 'Index: rules',
      terms: 'ignore exclude',
      run: () => openBrainWindow('rules'),
    },
    {
      id: 'idx-rank',
      title: 'Index: ranking',
      terms: 'weights scoring',
      run: () => openBrainWindow('ranking'),
    },
    {
      id: 'rebuild',
      title: 'Rebuild index',
      hint: 'changed files only',
      terms: 'reindex refresh',
      run: () => {
        flash('Rebuilding index…')
        fetch('/api/index/rebuild', { method: 'POST', body: '{}' }).catch(() =>
          flash('Rebuild failed'),
        )
      },
    },
    {
      id: 'rebuild-full',
      title: 'Rebuild index from scratch',
      hint: 'every file',
      terms: 'reindex full',
      run: () => {
        flash('Full rebuild started…')
        fetch('/api/index/rebuild', { method: 'POST', body: '{"full":true}' }).catch(() =>
          flash('Rebuild failed'),
        )
      },
    },
    {
      id: 'clear',
      title: 'Clear selection and isolation',
      terms: 'reset deselect',
      run: () => {
        dimGroup = null
        highlight = new Set()
        build()
        setFocus(null)
        renderLegend()
      },
    },
    {
      id: 'cal-month',
      title: 'Calendar: month view',
      run: () => {
        try {
          localStorage.setItem('orbit:cal-view', 'month')
        } catch {}
        renderOS()
      },
    },
    {
      id: 'cal-year',
      title: 'Calendar: year view',
      run: () => {
        try {
          localStorage.setItem('orbit:cal-view', 'year')
        } catch {}
        renderOS()
      },
    },
    {
      id: 'restore-l',
      title: 'Show hidden widgets (left)',
      run: () => restoreHidden('left', widgets, loadWidgets),
    },
    {
      id: 'restore-r',
      title: 'Show hidden widgets (right)',
      run: () => restoreHidden('right', widgets, loadWidgets),
    },
    {
      id: 'keys',
      title: 'Keyboard shortcuts',
      keys: '?',
      run: () => openTool(tools.find((t) => t.id === 'tool-keys') ?? null),
    },
    // reachable from the header's gear and ⌘, but, until now, not by name
    {
      id: 'settings',
      title: 'Settings',
      keys: '⌘,',
      terms: 'preferences theme profile account index layout reset appearance',
      run: () => openSettings(),
    },
    {
      id: 'library',
      title: 'Chat library',
      keys: '⌥⌘O',
      terms: 'claude chats search pin archive delete transcripts old',
      hint: 'every Claude chat, to search, pin, archive or delete',
      run: () => dispatchEvent(new Event('laika:library-open')),
    },
    {
      id: 'away',
      title: 'Autopilot: go away',
      terms: 'away mode unattended hours budget goal conductor overnight',
      hint: 'how long you are away, and what it may spend',
      run: () => dispatchEvent(new Event('laika:autopilot-away')),
    },
    {
      id: 'kill',
      title: 'Autopilot: stop the conductor now',
      keys: '⇧⌥⌘A',
      terms: 'kill switch halt stop panic emergency',
      run: () => dispatchEvent(new Event('laika:autopilot-halt')),
    },
  ]
  // the adoption pulse is the operator's own view: offered only where its rail button mounted
  if (document.getElementById('pulse-rail'))
    cmds.push({
      id: 'pulse',
      title: 'Adoption pulse',
      terms: 'nodes network adoption installs operator',
      run: () => openPulse(),
    })
  for (const w of widgets) {
    cmds.push({
      id: `ws-${w.id}`,
      title: `Settings: ${w.title}`,
      hint: 'widget',
      terms: 'gear configure widget',
      run: () => {
        const btn = document.querySelector<HTMLElement>(`[data-settings="${CSS.escape(w.id)}"]`)
        btn?.scrollIntoView({ block: 'nearest' })
        btn?.click()
      },
    })
  }
  return cmds
}

// ---------------------------------------------------------------- agent control ----
// Agents waiting on you, live in the right rail; `c` opens the full view as a panel in the dock.
// Claude Code sessions inside the app (s): start or resume one in any repo
const sessionsView = createSessions()
// Chromium tabs inside the app (b), one storage profile per account; real tabs need the
// desktop shell (packages/shell), a plain browser gets the launch note
const browserDock = createBrowser({ spotlight: () => spotlight.open() })
// the floating player (m): YouTube music and videos in a window you put wherever you like.
// Searches and "watch on YouTube" are pages, not embeds, so they go to the browser.
const youtube = createYouTube({
  openWeb: (url) => {
    browserDock.open(true)
    browserDock.openUrl(url)
  },
})
// ---------------------------------------------------------------- the panels ----
/** the rail glyph for agent control: a list with two status dots, the workbench rail's own */
const CONTROL_ICON =
  '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3.2" width="14" height="13.6" rx="2.2"/><circle cx="6.6" cy="7.4" r="1.1" fill="currentColor"/><circle cx="6.6" cy="12.6" r="1.1" fill="currentColor"/><path d="M9.4 7.4h4.4M9.4 12.6h4.4"/></svg>'
/** sessions waiting on you, kept for the rail badge; refreshAgents() is what counts them */
let waitingNow = 0

/**
 * Every window in Orbit that is not the map is a panel, and this is where they are put in.
 * `registerPanel` brings the rail button, the palette entry, the shortcut, the width, the slide,
 * the tear-off and the saved layout with it (panels.ts), so nothing below positions itself, opens
 * itself or draws a frame. A panel a module owns registers itself in that module; the ones here
 * are the ones whose wiring only main knows.
 */

/** agent control, the widest panel: sessions, repos, activity and the ports they hold */
let controlView: { start(): void; stop(): void } | null = null
let controlHost: HTMLElement | null = null
/** agent control in its own window: the panel stays shut and opening it brings that window up */
let controlOut = false

const controlPanel = registerPanel({
  id: 'control',
  title: 'Agents',
  group: 'fleet',
  key: 'c',
  icon: CONTROL_ICON,
  wide: true,
  width: { min: 520, default: 1040, snaps: [720, 1040, 1320] },
  terms: 'agent control sessions claude waiting repos unpushed ports activity',
  hint: 'what needs you: sessions, repos, what is running',
  mount: (host) => {
    controlHost = host
    controlView = mountControl(host, {
      extra: canPop()
        ? `<button class="c-btn ghost c-popout" type="button" title="Pop out to its own window" aria-label="Pop out to its own window">${POP_ICON}</button>`
        : '',
    })
    host.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.c-popout')) {
        controlPanel.close()
        popOut('control')
      }
    })
    return () => controlView?.stop()
  },
  // a closed panel doesn't scan repos
  onVisible: (on) => (on ? controlView?.start() : controlView?.stop()),
  badge: () => ({ count: waitingNow, tone: 'ok' }),
})

watchPop('control', (out, was) => {
  controlOut = out
  if (out) controlPanel.close()
  else if (was) controlPanel.open()
})

/** open agent control and bring one session's card into view once it has rendered */
function openControlAt(id: string) {
  openControl(true)
  let tries = 0
  const find = () => {
    const card = controlHost?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)
    if (card) {
      card.scrollIntoView({ block: 'center', behavior: 'smooth' })
      card.classList.add('c-flash')
      setTimeout(() => card.classList.remove('c-flash'), 1600)
    } else if (++tries < 20) setTimeout(find, 150)
  }
  find()
}
function openControl(on: boolean) {
  if (on && controlOut) return popOut('control')
  on ? controlPanel.open() : controlPanel.close()
}

// the order here is the order on the rail, within each group:
// fleet — Agents, Autopilot (its four views folded under it), Fleet, Runs
// know  — History, Data, Users (after the Brain button the rail draws itself)
// dev   — Profiler, in the developer section at the bottom (after Mission and Reel)
// autopilot: the chip in the chrome, its five views as panels, and ⌥⌘A / ⇧⌥⌘A
startAutopilot()
// the fleet board is the chats' own view of themselves, so sessions.ts registers it
sessionsView.registerFleetPanel()
registerRunsPanel()
registerHistoryPanel({ openControlAt })
registerDatabasesPanel()
registerUsersPanel()
registerProfilerPanel()

createWorkbench({
  browser: browserDock,
  claude: sessionsView,
  rail: { hidden: railHidden, set: setRail },
  showreel: { open: openShowreel, close: closeShowreel, isOpen: isShowreelOpen },
  mission: { open: openMission, close: closeMission, isOpen: isMissionOpen },
  brain: { open: () => openBrainWindow() },
  music: { open: () => youtube.open(), close: youtube.close, isOpen: youtube.isOpen },
})
// the rail exists now: the panels' buttons go into it, and what was open last time comes back
restorePanels()
watchMission()
// turning developer features off takes their windows down with their buttons
addEventListener('laika:dev-features', (e) => {
  if ((e as CustomEvent<boolean>).detail) return
  if (isMissionOpen()) closeMission()
  if (isShowreelOpen()) closeShowreel()
})
const BASE_TITLE = document.title
const notifySessions = sessionNotifier()
let agentsJson = ''
async function refreshAgents() {
  try {
    const [w, list]: [Widget, Session[]] = await Promise.all([
      fetch('/api/control/widget').then((r) => r.json()),
      fetch('/api/control/sessions').then((r) => r.json()),
    ])
    notifySessions(list, () => openControl(true))
    const waiting = Number(w.config?.waiting ?? 0)
    document.title = waiting ? `(${waiting}) ${BASE_TITLE}` : BASE_TITLE
    waitingNow = waiting
    controlPanel.refreshBadge()
    dispatchEvent(new CustomEvent('laika:waiting', { detail: waiting }))
    const json = JSON.stringify([w.items, w.config?.meta])
    if (json === agentsJson) return
    agentsJson = json
    // keep the gear's settings (collapsed, hidden, rail, order) that /api/widgets merged in
    const cur = widgets.find((x) => x.id === 'agents')
    if (!cur) return
    Object.assign(cur, {
      items: w.items,
      refreshedAt: w.refreshedAt,
      config: { ...cur.config, ...w.config },
    })
    renderOS()
  } catch {}
}
activity.every(5_000, refreshAgents)

addEventListener('keydown', (e) => {
  // Escape from the page closes the newest thing first: a panel opened beside docked Claude
  // goes before Claude does. Not from a field, the palette or a window with its own Escape.
  if (
    e.key === 'Escape' &&
    !(e.target as HTMLElement).closest?.(
      'input, textarea, select, #ss, #sp, #settings, #ql, #bw, #ws, #ytp',
    ) &&
    closeTopPanel()
  )
    return
  // the sessions view handles its own keys; Escape from outside it (focus on the page) closes it
  if (sessionsView.isOpen()) {
    if (e.key === 'Escape') sessionsView.close()
    return
  }
  if (e.key === 'Escape') {
    openTool(null)
    if (document.activeElement !== qInput) showPanel(false)
  }
  if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault()
    openSettings()
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault()
    spotlight.open(document.activeElement === qInput ? qInput.value : '')
    return
  }
  if (document.activeElement === qInput && e.key !== 'Escape') return
  if (e.key === 'Escape') {
    qInput.blur()
    return
  }
  // single-key shortcuts never fire while typing somewhere, or over the Brain window
  if (
    (e.target as HTMLElement).closest?.(
      'input, textarea, select, #bw, #ws, #sp, #settings, #ql, #ctl-drawer, #ss, #wb, #ytp',
    )
  )
    return
  if (!e.metaKey && !e.ctrlKey && !e.altKey) {
    // camera flight (see flyKeys): held keys move the view; ↑/↓ belong to the results
    // list while there is one. `s` is shared with the sessions view: a tap opens it (on
    // keyup, below), a hold flies backward.
    if (FLY_CODES.has(e.code) && !(current && (e.code === 'ArrowUp' || e.code === 'ArrowDown'))) {
      e.preventDefault()
      if (e.repeat) return
      if (e.code === 'KeyS') {
        sTapAt = performance.now()
        sArmed = true
      }
      held.add(e.code)
      shiftDown = e.shiftKey
      return
    }
    if (e.key === '0' || e.key === 'Home') return resetView()
    if (e.key === 'f') {
      if (focusIdx !== null) return flyTo(nodePos(focusIdx), 380)
      return resetView()
    }
    if (e.key === 'i') return openBrainWindow()
    // c, h and t belong to the Agents, History and Data panels; panels.ts binds them, with the
    // same typing guards, so there is one place a panel's key is decided
    if (e.key === 'b') return browserDock.toggle()
    // Mission and Reel cover the page rather than docking, and the ring is the page itself, so
    // they stay the workbench's: the key is its rail button, and follows the same rules
    const nav = (
      { ...(devFeatures() ? { g: 'mission', v: 'showreel' } : {}), k: 'ring' } as Record<
        string,
        string
      >
    )[e.key]
    if (nav) {
      document.querySelector<HTMLElement>(`#wbn [data-nav="${nav}"]`)?.click()
      return
    }
    if (e.key === 'm') return youtube.toggle()
    if (e.key === ' ' && focusIdx !== null && committed) {
      e.preventDefault() // no page scroll
      return quickLook.toggle(qlItem(focusIdx))
    }
    if (e.key === '/') {
      e.preventDefault() // keep the slash out of the palette's input
      return spotlight.open()
    }
    if (e.key === '[') return setRail(0, !railHidden(0))
    if (e.key === ']') return setRail(1, !railHidden(1))
    if (e.key === '\\') {
      const show = railHidden(0) && railHidden(1)
      setRail(0, !show)
      setRail(1, !show)
      return
    }
    if (e.key === '?') return openTool(tools.find((t) => t.id === 'tool-keys') ?? null)
    if (e.key === 'p') {
      nodePreview.toggle()
      return flash(nodePreview.enabled() ? 'node previews on' : 'node previews off')
    }
    const lm = ({ 1: 'arms', 2: 'rings', 3: 'force' } as Record<string, LayoutMode>)[e.key]
    if (lm) return setLayout(lm)
  }
  if (!current) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    select(selIdx + 1)
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    select(selIdx - 1)
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    act('open')
  }
})
addEventListener('keyup', (e) => {
  shiftDown = e.shiftKey
  if (!held.delete(e.code)) return
  // a tap of `s` (released before the hold threshold, and before it moved anything) is
  // the sessions shortcut; only reachable when keydown passed the typing guards above
  if (e.code === 'KeyS' && sArmed && performance.now() - sTapAt < 180) {
    sArmed = false
    if (sessionsView.isOpen() || e.metaKey || e.ctrlKey || e.altKey) return
    openControl(false)
    sessionsView.open()
  }
})
// keys released while another window had focus never send a keyup: nothing may stay held
addEventListener('blur', () => held.clear())
$('#tool-home').addEventListener('click', () => resetView())
// the work queue (queue-view.ts) is a panel like the rest: rail, palette, ⌥⌘Q. Not a bare `q`,
// which is the map's orbit key. The header button opens the same panel and shows the count.
let queueOpen: Record<string, number> | null = null
const openItems = (c: Record<string, number>) =>
  (c.queued ?? 0) + (c.running ?? 0) + (c.blocked ?? 0)
const queuePanel = registerPanel({
  id: 'queue',
  title: 'Queue',
  group: 'fleet',
  chord: 'alt+meta+KeyQ',
  icon: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.4 5h9.2M3.4 10h9.2M3.4 15h6"/><path d="m14.6 12.6 2.4 2.4-2.4 2.4"/></svg>',
  width: { min: 420, default: 640, snaps: [520, 640, 900] },
  terms: 'queue work next todo backlog assign items brief fleet dispatch',
  hint: 'what each chat does next, and what finished',
  mount: (host) => mountQueue(host),
  badge: () =>
    !queueOpen
      ? 0
      : queueOpen.needsUser
        ? { count: openItems(queueOpen), tone: 'err' }
        : openItems(queueOpen),
})
$('#tool-queue').addEventListener('click', () => queuePanel.toggle())
// the cockpit (cockpit.ts): every chat as a node with its queue under it. The conductor's window
// shows the same view under its banner; this is it on its own, for when no conductor is open.
let cockpit: ReturnType<typeof mountCockpit> | null = null
registerPanel({
  id: 'cockpit',
  title: 'Cockpit',
  group: 'fleet',
  chord: 'alt+meta+KeyL',
  icon: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.6" y="3" width="4.2" height="4" rx="1.2"/><rect x="7.9" y="3" width="4.2" height="4" rx="1.2"/><rect x="13.2" y="3" width="4.2" height="4" rx="1.2"/><path d="M4.7 9.6v5.6M10 9.6v3M15.3 9.6v6.8"/></svg>',
  wide: true,
  width: { min: 480, default: 900, snaps: [720, 900, 1180] },
  terms: 'cockpit fleet strip lanes chats queue conductor nodes reorder assign',
  hint: 'every chat as a node, its queue running down beneath it',
  mount: (host) => {
    cockpit = mountCockpit(host)
    return () => {
      cockpit?.dispose()
      cockpit = null
    }
  },
  onVisible: (on) => cockpit?.setVisible(on),
})
const paintQueue = async () => {
  const c = await queueCounts()
  queueOpen = c
  queuePanel.refreshBadge()
  const b = $('#tool-queue-n')
  if (!c) {
    b.textContent = '--'
    return
  }
  b.textContent = String(openItems(c))
  b.title = `${c.running ?? 0} running · ${c.ready ?? 0} ready · ${c.needsUser ?? 0} need you`
  b.style.color = c.needsUser ? 'var(--err)' : ''
}
activity.every(20_000, paintQueue)

await load()
loop()

if (import.meta.hot) import.meta.hot.accept(() => location.reload())
