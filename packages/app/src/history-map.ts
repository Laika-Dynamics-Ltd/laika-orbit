/**
 * History as a network in the ring's own language.
 *
 * Read it like the ARMS map: a clock face, starting at 12 o'clock. NOW is the hub in the
 * middle and time runs OUTWARD — each ring is an age (an hour ago, three, twelve), its title
 * stacked in the gap at the top where the map keeps its ring titles. Every project owns a
 * sector with a hub of its own, and what happened in it sits at the radius of when it happened:
 * runs of work in the project's colour, commits in green, memory notes in blue. Anything
 * waiting on you or blocked wears that colour instead and pulses, as on the agents ring.
 *
 * The lines are the point:
 *   arm      the project's spine out from its hub, each moment on a short tether from it
 *   made     a run of work to the commits it led to (landing during it, or soon after)
 *   noted    a run of work to a memory note written around it
 *   session  one Claude session picked up again later, run to run
 *
 * Hovering a node drains everything unrelated, as the map does for a pick, so one thread of
 * cause and effect is the only lit thing on screen. Flat and top-down on purpose: drag pans,
 * the wheel zooms toward the pointer, nothing tilts.
 */
import * as THREE from 'three'
import { LabelLayer, type LabelSpec } from './labels.ts'

export type Level = 'info' | 'good' | 'warn' | 'bad'
export type Kind = 'work' | 'commit' | 'note'

export type Moment = {
  id: string
  kind: Kind
  t0: number
  t1: number
  t: number
  lvl: Level
  project: string
  title: string
  sub: string
  meta: string
  clock: string
  card: boolean
  score: number
  session?: { id: string }
  commits?: Array<unknown>
}

export type MapData = { from: number; to: number; moments: Moment[] }

export type HistoryMap = {
  build(data: MapData, refit?: boolean): void
  resize(): void
  fit(): void
  select(id: string | null): void
  dispose(): void
}

// ── geometry ─────────────────────────────────────────────────────────────────────────────
const R_NOW = 0
const R_HUB = 46 // project hubs, inside the first ring
const R0 = 78 // age zero
const RMAX = 470 // the oldest moment in the window
const TOP_GAP = (40 * Math.PI) / 180 // 12 o'clock stays clear for the ring titles, as on the map
const SECTOR_GAP = (2.2 * Math.PI) / 180
const MIN_SECTOR = (7 * Math.PI) / 180
const MAX_SECTORS = 14
const TAU_AGE = 20 * 60e3 // how fast the rings open out: recent hours get the room
const ARC_SEG = 18
const MADE_WINDOW = 45 * 60e3
const NOTE_WINDOW = 60 * 60e3
const FOV = 32

/** the rings drawn for each window, as ages */
const H = 3600e3
const RINGS: Record<number, number[]> = {
  12: [0.5 * H, H, 3 * H, 6 * H, 12 * H],
  24: [H, 3 * H, 6 * H, 12 * H, 24 * H],
  48: [H, 3 * H, 6 * H, 12 * H, 24 * H, 48 * H],
}
const ringName = (age: number) =>
  age < H ? `${Math.round(age / 60e3)} MIN AGO` : age === H ? '1 HOUR AGO' : `${age / H} HOURS AGO`

// ── colour ───────────────────────────────────────────────────────────────────────────────
const tok = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || 'gray'
const col = (name: string) => new THREE.Color(tok(name))

function palette() {
  return {
    now: col('--acc'),
    yours: col('--acc'),
    blocked: col('--warn'),
    running: col('--cyan'),
    commit: col('--ok'),
    note: col('--info'),
    ring: col('--n14'),
    ringTitle: col('--n27'),
    leaf: col('--n29'),
    disc: col('--n3'),
    hex: col('--n8'),
  }
}

/** Evenly spread hues round the wheel, in sector order, so neighbours never share a colour. */
function projectColours(n: number): THREE.Color[] {
  return Array.from({ length: n }, (_, i) =>
    new THREE.Color().setHSL((0.58 + (i / Math.max(1, n)) * 0.86) % 1, 0.62, 0.64),
  )
}

// ── shaders: the map's node sprite, trimmed ──────────────────────────────────────────────
const NODE_VS = `
attribute float aSize; attribute vec3 aCol; attribute float aHi; attribute float aPulse; attribute float aShape;
uniform float uTime, uPx, uFocus;
varying vec3 vCol; varying float vA; varying float vHi; varying float vShape;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float pulse = 1.0 + aPulse * 0.18 * sin(uTime * 3.4 + position.x * 0.02);
  float px = aSize * projectionMatrix[1][1] * uPx / -mv.z;
  gl_PointSize = clamp(px, 2.5, 120.0) * pulse * (1.0 + step(0.99, aHi) * 0.3);
  gl_Position = projectionMatrix * mv;
  // drain the unrelated: with a focus, only the node and its neighbours keep their colour
  float lit = max(aHi, 1.0 - uFocus);
  vCol = mix(aCol * 0.22, aCol, lit);
  vA = mix(0.28, 1.0, lit);
  vHi = aHi; vShape = aShape;
}`

const NODE_FS = `
precision highp float;
varying vec3 vCol; varying float vA; varying float vHi; varying float vShape;
void main(){
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float glow = pow(smoothstep(1.0, 0.0, r), 2.6) * 0.42;
  float core = smoothstep(0.44, 0.22, r);
  float ring = smoothstep(0.50, 0.58, r) * smoothstep(0.86, 0.75, r);
  float a;
  vec3 c = vCol;
  if (vShape > 0.5) {
    // a hub is a ring, as the map draws them: it holds its hue at any size
    a = ring * 1.1 + glow * 0.6 + smoothstep(0.16, 0.0, r) * 0.9;
  } else {
    float soft = pow(smoothstep(1.0, 0.0, r), 1.5);
    float hi = step(0.99, vHi);
    a = mix(max(core * 0.9, soft * 0.95) + glow * 0.4, core * 0.85 + ring + glow, hi);
    c = mix(vCol, vec3(1.0), core * (0.25 + 0.35 * hi));
  }
  gl_FragColor = vec4(c, clamp(a, 0.0, 1.0) * vA);
}`

const DISC_VS = `
varying vec2 vXY;
void main(){ vXY = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`

const DISC_FS = `
precision highp float;
varying vec2 vXY;
uniform float uR, uHex; uniform vec3 uTint, uLine; uniform sampler2D uGrid;
void main(){
  float rad = length(vXY) / uR;
  if (rad > 1.0) discard;
  float rim = 1.0 - smoothstep(0.86, 1.0, rad);
  float core = mix(1.0, 1.35, 1.0 - smoothstep(0.0, 0.7, rad));
  vec2 guv = vec2(vXY.x / (3.0 * uHex), vXY.y / (1.7320508 * uHex));
  float line = texture2D(uGrid, guv, -1.0).r * (1.0 - smoothstep(0.78, 1.04, rad));
  gl_FragColor = vec4(uTint * core + uLine * line, rim * (0.85 + line * 0.9));
}`

/** One tile of a flat-top hex grid, repeated across the disc (the map bakes the same tile). */
function hexTexture(): THREE.Texture {
  const s = 32
  const W = 3 * s
  const Ht = Math.round(Math.sqrt(3) * s)
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = Ht
  const x = cv.getContext('2d') as CanvasRenderingContext2D
  x.fillStyle = 'black'
  x.fillRect(0, 0, W, Ht)
  x.strokeStyle = 'white'
  x.lineWidth = 1.4
  const hex = (cx: number, cy: number) => {
    x.beginPath()
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3
      if (k) x.lineTo(cx + s * Math.cos(a), cy + s * Math.sin(a))
      else x.moveTo(cx + s * Math.cos(a), cy + s * Math.sin(a))
    }
    x.closePath()
    x.stroke()
  }
  for (const dx of [-W, 0, W])
    for (const dy of [-Ht, 0, Ht]) {
      hex(dx, dy)
      hex(dx + 1.5 * s, dy + Ht / 2)
    }
  const t = new THREE.CanvasTexture(cv)
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.RepeatWrapping
  return t
}

// ── model ────────────────────────────────────────────────────────────────────────────────
type Node = {
  pos: THREE.Vector3
  size: number
  colour: THREE.Color
  shape: 0 | 1
  pulse: 0 | 1
  moment: Moment | null
  /** hubs and NOW: not pickable as moments, but they light their own lines */
  label: string
}
type Link = {
  a: number
  b: number
  from: THREE.Color
  to: THREE.Color
  /** at rest, with nothing hovered */
  alpha: number
  /** when one of its ends is hovered; threads that would scribble at rest show only here */
  lit: number
  /** a bowed arc rather than a straight trail segment */
  curved: boolean
  /** where the line starts and ends when not at its nodes: a tether leaves the spine */
  origin?: THREE.Vector3
  dest?: THREE.Vector3
  /** where its vertices sit in the line buffer */
  start: number
  end: number
}

/** clockwise from 12 o'clock, on the ground plane, with screen-up as world -Z */
const polar = (angle: number, r: number) =>
  new THREE.Vector3(Math.sin(angle) * r, 0, -Math.cos(angle) * r)

function sectorWidths(weights: number[], avail: number): number[] {
  const n = weights.length
  if (!n) return []
  const min = Math.min(MIN_SECTOR, avail / n)
  let w = weights.map(() => 0)
  let fixed = new Set<number>()
  // a sector below the floor is pinned to it, and the rest share what is left
  for (let pass = 0; pass < n; pass++) {
    const free = weights.reduce((s, x, i) => (fixed.has(i) ? s : s + x), 0)
    const room = avail - fixed.size * min
    w = weights.map((x, i) => (fixed.has(i) ? min : (x / Math.max(1e-9, free)) * room))
    const under = w.findIndex((x, i) => !fixed.has(i) && x < min)
    if (under < 0) break
    fixed = new Set([...fixed, under])
  }
  return w
}

export function makeHistoryMap(
  canvas: HTMLCanvasElement,
  on: { pick?: (m: Moment | null) => void } = {},
): HistoryMap {
  const stage = canvas.parentElement as HTMLElement
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 20000)
  camera.up.set(0, 0, -1)
  const labels = new LabelLayer(scene)
  const tip = document.createElement('div')
  tip.className = 'hm-tip'
  tip.hidden = true
  stage.appendChild(tip)

  const world = new THREE.Group()
  scene.add(world)
  let hex: THREE.Texture | null = null
  let T = palette()
  let nodes: Node[] = []
  let links: Link[] = []
  let adj: number[][] = []
  let points: THREE.Points | null = null
  let lineGeo: THREE.BufferGeometry | null = null
  let hoverIdx = -1
  let pickedId: string | null = null
  let pulsing = false
  let alive = true
  let raf = 0
  let fitted = false
  const target = new THREE.Vector3()
  let dist = 1400
  const uniforms = {
    uTime: { value: 0 },
    uPx: { value: 500 },
    uFocus: { value: 0 },
  }

  function clear() {
    world.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
      const mat = m.material as THREE.Material | undefined
      if (mat && mat !== pointMat) mat.dispose()
    })
    world.clear()
    points = null
    lineGeo = null
  }
  const pointMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: NODE_VS,
    fragmentShader: NODE_FS,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })

  function build(data: MapData, refit = false) {
    clear()
    T = palette()
    nodes = []
    links = []
    const now = data.to
    const span = Math.max(H, data.to - data.from)
    const hours = Math.round(span / H)
    const rOf = (t: number) => {
      const age = Math.min(span, Math.max(0, now - t))
      return R0 + (RMAX - R0) * (Math.log1p(age / TAU_AGE) / Math.log1p(span / TAU_AGE))
    }

    // ── the ground: disc, age rings and their titles ──
    hex ??= hexTexture()
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(RMAX + 70, 128),
      new THREE.ShaderMaterial({
        uniforms: {
          uR: { value: RMAX + 70 },
          uHex: { value: 26 },
          uGrid: { value: hex },
          uTint: { value: T.disc },
          uLine: { value: T.hex },
        },
        vertexShader: DISC_VS,
        fragmentShader: DISC_FS,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    )
    disc.rotation.x = -Math.PI / 2
    disc.renderOrder = -2
    world.add(disc)

    const specs: LabelSpec[] = []
    const ringAges = (RINGS[hours] ?? RINGS[24]) as number[]
    for (const age of [0, ...ringAges]) {
      const r = age ? rOf(now - age) : R0
      const pts: THREE.Vector3[] = []
      // the ring breaks at 12 o'clock, where its title sits
      for (let k = 0; k <= 160; k++) {
        const a = TOP_GAP * 0.5 + (k / 160) * (Math.PI * 2 - TOP_GAP)
        pts.push(polar(a, r))
      }
      const ring = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({
          color: T.ring,
          transparent: true,
          opacity: age ? 0.75 : 0.45,
          depthTest: false,
        }),
      )
      ring.renderOrder = -1
      world.add(ring)
      if (age)
        specs.push({
          text: ringName(age),
          world: polar(0, r),
          colour: T.ringTitle.getHex(),
          tier: 0,
          px: 10,
          spacing: 0.16,
        })
    }

    // ── sectors ──
    const byProject = new Map<string, Moment[]>()
    for (const m of data.moments) byProject.set(m.project, [...(byProject.get(m.project) ?? []), m])
    let groups = [...byProject].map(([name, list]) => ({ name, list, weight: list.length }))
    if (groups.length > MAX_SECTORS) {
      groups.sort((a, b) => b.weight - a.weight)
      const rest = groups.slice(MAX_SECTORS - 1)
      groups = [
        ...groups.slice(0, MAX_SECTORS - 1),
        {
          name: `${rest.length} more projects`,
          list: rest.flatMap((g) => g.list),
          weight: rest.reduce((s, g) => s + g.weight, 0),
        },
      ]
    }
    const short = (p: string) => p.split('/').pop() ?? p
    groups.sort((a, b) =>
      short(a.name).localeCompare(short(b.name), undefined, { sensitivity: 'base' }),
    )
    const avail = Math.PI * 2 - TOP_GAP - SECTOR_GAP * Math.max(0, groups.length - 1)
    const widths = sectorWidths(
      groups.map((g) => g.weight ** 0.85),
      avail,
    )
    const hues = projectColours(groups.length)

    const nowIdx =
      nodes.push({
        pos: polar(0, R_NOW),
        size: 22,
        colour: T.now,
        shape: 1,
        pulse: 1,
        moment: null,
        label: 'NOW',
      }) - 1
    specs.push({
      text: 'NOW',
      world: new THREE.Vector3(0, 0, 20),
      colour: T.now.getHex(),
      tier: 0,
      px: 12,
      spacing: 0.2,
    })

    let angle = TOP_GAP / 2
    groups.forEach((g, gi) => {
      const w = widths[gi] ?? MIN_SECTOR
      const mid = angle + w / 2
      const half = w / 2
      const hue = hues[gi] as THREE.Color
      angle += w + SECTOR_GAP

      // the sector's rim: an arc just outside the oldest ring, in the project's colour
      const rim: THREE.Vector3[] = []
      for (let k = 0; k <= 24; k++) rim.push(polar(mid - half + (k / 24) * w, RMAX + 22))
      const rimLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(rim),
        new THREE.LineBasicMaterial({
          color: hue,
          transparent: true,
          opacity: 0.8,
          depthTest: false,
        }),
      )
      world.add(rimLine)
      // the same shorthand as the project chips above: time worked, commits, notes
      const worked = g.list.reduce((t, m) => t + (m.kind === 'work' ? m.t1 - m.t0 : 0), 0) / 60e3
      const commits = g.list.reduce(
        (t, m) => t + (m.kind === 'commit' ? (m.commits?.length ?? 1) : 0),
        0,
      )
      const notes = g.list.filter((m) => m.kind === 'note').length
      const bits = [
        worked >= 1 ? (worked < 60 ? `${Math.round(worked)}M` : `${Math.floor(worked / 60)}H`) : '',
        commits ? `${commits}C` : '',
        notes ? `${notes}N` : '',
      ].filter(Boolean)
      specs.push({
        text: [short(g.name).toUpperCase(), ...bits].join(' · '),
        world: polar(mid, RMAX + 48),
        colour: hue.getHex(),
        tier: 1,
        px: 12,
        spacing: 0.04,
      })

      const hubIdx =
        nodes.push({
          pos: polar(mid, R_HUB),
          size: 12,
          colour: hue,
          shape: 1,
          pulse: 0,
          moment: null,
          label: short(g.name),
        }) - 1
      links.push({
        a: nowIdx,
        b: hubIdx,
        from: T.now,
        to: hue,
        alpha: 0.35,
        lit: 0.8,
        curved: false,
        start: 0,
        end: 0,
      })

      // ── the moments, most important placed first so they get their ideal spot ──
      const placed: { p: THREE.Vector3; s: number }[] = []
      const idxOf = new Map<Moment, number>()
      const lane = (m: Moment) => (m.kind === 'commit' ? 0.55 : m.kind === 'note' ? -0.55 : 0)
      for (const m of [...g.list].sort((a, b) => b.score - a.score)) {
        const size =
          m.kind === 'work'
            ? 10 + 3 * Math.sqrt(Math.min(180, (m.t1 - m.t0) / 60e3))
            : m.kind === 'commit'
              ? 10 + 3.5 * Math.sqrt(m.commits?.length ?? 1)
              : 9
        let r = rOf(m.t)
        let best: THREE.Vector3 | null = null
        for (let tries = 0; tries < 8 && !best; tries++) {
          const step = (size * 0.9) / r
          const ideal = mid + lane(m) * half
          for (let k = 0; k < 40; k++) {
            const off = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * step
            const a = ideal + off
            if (a < mid - half * 0.94 || a > mid + half * 0.94) continue
            const p = polar(a, r)
            // a sprite is drawn size across, so two sit clear of each other at half the sum
            if (placed.every((q) => q.p.distanceTo(p) > (q.s + size) * 0.55)) {
              best = p
              break
            }
          }
          r += size * 0.7
        }
        const pos = best ?? polar(mid + lane(m) * half, rOf(m.t))
        placed.push({ p: pos, s: size })
        const colour =
          m.kind === 'commit'
            ? T.commit
            : m.kind === 'note'
              ? T.note
              : m.lvl === 'bad'
                ? T.blocked
                : m.lvl === 'warn'
                  ? T.yours
                  : m.lvl === 'good'
                    ? T.running
                    : hue
        idxOf.set(
          m,
          nodes.push({
            pos,
            size,
            colour,
            shape: 0,
            pulse: m.kind === 'work' && m.lvl !== 'info' ? 1 : 0,
            moment: m,
            label: m.title,
          }) - 1,
        )
        if (m.card)
          specs.push({
            text: m.title.length > 34 ? `${m.title.slice(0, 33)}…` : m.title,
            world: pos.clone().add(new THREE.Vector3(0, 0, size + 9)),
            colour: T.leaf.getHex(),
            tier: 2,
            px: 11,
          })
      }

      // ── the arm: a spine out from the hub, and every moment on a short tether from it ──
      // Chaining the moments in time order zig-zagged across the sector; an arm with leaves,
      // as the map draws its departments, keeps a busy project readable.
      let reach = R0
      for (const m of g.list)
        reach = Math.max(reach, (nodes[idxOf.get(m) as number] as Node).pos.length())
      links.push({
        a: hubIdx,
        b: hubIdx,
        from: hue,
        to: hue,
        alpha: 0.55,
        lit: 0.9,
        curved: false,
        origin: polar(mid, R_HUB),
        dest: polar(mid, reach),
        start: 0,
        end: 0,
      })
      for (const m of g.list) {
        const i = idxOf.get(m) as number
        const p = (nodes[i] as Node).pos
        links.push({
          a: hubIdx,
          b: i,
          from: hue,
          to: (nodes[i] as Node).colour,
          alpha: 0.3,
          lit: 0.95,
          curved: false,
          origin: polar(mid, p.length()),
          start: 0,
          end: 0,
        })
      }

      // ── cause and effect ──
      const work = g.list.filter((m) => m.kind === 'work')
      for (const c of g.list.filter((m) => m.kind === 'commit')) {
        let bestW: Moment | null = null
        let gap = Number.POSITIVE_INFINITY
        for (const w of work) {
          if (c.t0 < w.t0 - 5 * 60e3 || c.t0 > w.t1 + MADE_WINDOW) continue
          const d = Math.max(0, c.t0 - w.t1)
          if (d < gap) {
            gap = d
            bestW = w
          }
        }
        if (bestW) links.push(arcLink(idxOf.get(bestW) as number, idxOf.get(c) as number, 0.32, 1))
      }
      for (const n of g.list.filter((m) => m.kind === 'note')) {
        const w = work
          .filter((x) => Math.abs(n.t - x.t1) < NOTE_WINDOW || (n.t >= x.t0 && n.t <= x.t1))
          .sort((a, b) => Math.abs(n.t - a.t1) - Math.abs(n.t - b.t1))[0]
        if (w) links.push(arcLink(idxOf.get(w) as number, idxOf.get(n) as number, 0, 0.9))
      }
      const bySession = new Map<string, Moment[]>()
      for (const w of work) {
        const s = w.session?.id
        if (s) bySession.set(s, [...(bySession.get(s) ?? []), w])
      }
      for (const runs of bySession.values()) {
        runs.sort((a, b) => a.t0 - b.t0)
        for (let k = 1; k < runs.length; k++)
          links.push(
            arcLink(
              idxOf.get(runs[k - 1] as Moment) as number,
              idxOf.get(runs[k] as Moment) as number,
              0,
              0.9,
            ),
          )
      }
    })

    function arcLink(a: number, b: number, alpha: number, lit: number): Link {
      return {
        a,
        b,
        from: (nodes[a] as Node).colour,
        to: (nodes[b] as Node).colour,
        alpha,
        lit,
        curved: true,
        start: 0,
        end: 0,
      }
    }

    // ── geometry for the nodes ──
    const n = nodes.length
    const g = new THREE.BufferGeometry()
    const P = new Float32Array(n * 3)
    const C = new Float32Array(n * 3)
    const S = new Float32Array(n)
    const Sh = new Float32Array(n)
    const Pu = new Float32Array(n)
    nodes.forEach((d, i) => {
      P.set([d.pos.x, 2, d.pos.z], i * 3)
      C.set([d.colour.r, d.colour.g, d.colour.b], i * 3)
      S[i] = d.size
      Sh[i] = d.shape
      Pu[i] = d.pulse
    })
    g.setAttribute('position', new THREE.BufferAttribute(P, 3))
    g.setAttribute('aCol', new THREE.BufferAttribute(C, 3))
    g.setAttribute('aSize', new THREE.BufferAttribute(S, 1))
    g.setAttribute('aShape', new THREE.BufferAttribute(Sh, 1))
    g.setAttribute('aPulse', new THREE.BufferAttribute(Pu, 1))
    g.setAttribute('aHi', new THREE.BufferAttribute(new Float32Array(n), 1))
    points = new THREE.Points(g, pointMat)
    points.frustumCulled = false
    points.renderOrder = 3
    pulsing = Pu.some((x) => x > 0)

    // ── geometry for the lines: straight for trails, bowed for everything else ──
    let verts = 0
    for (const l of links) verts += l.curved ? ARC_SEG * 2 : 2
    const LP = new Float32Array(verts * 3)
    lineGeo = new THREE.BufferGeometry()
    let v = 0
    const put = (p: THREE.Vector3) => {
      LP.set([p.x, 1, p.z], v * 3)
      v++
    }
    const ctl = new THREE.Vector3()
    for (const l of links) {
      const a = l.origin ?? (nodes[l.a] as Node).pos
      const b = l.dest ?? (nodes[l.b] as Node).pos
      l.start = v
      if (!l.curved) {
        put(a)
        put(b)
      } else {
        // bow sideways from the line between them, so a thread and the trail never overlap
        const mx = (a.x + b.x) / 2
        const mz = (a.z + b.z) / 2
        const dx = b.x - a.x
        const dz = b.z - a.z
        const len = Math.hypot(dx, dz) || 1
        ctl.set(mx - (dz / len) * len * 0.28, 1, mz + (dx / len) * len * 0.28)
        let px = a.x
        let pz = a.z
        for (let k = 1; k <= ARC_SEG; k++) {
          const u = k / ARC_SEG
          const iu = 1 - u
          const x = iu * iu * a.x + 2 * iu * u * ctl.x + u * u * b.x
          const z = iu * iu * a.z + 2 * iu * u * ctl.z + u * u * b.z
          LP.set([px, 1, pz, x, 1, z], v * 3)
          v += 2
          px = x
          pz = z
        }
      }
      l.end = v
    }
    lineGeo.setAttribute('position', new THREE.BufferAttribute(LP, 3))
    lineGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(verts * 3), 3))
    const lines = new THREE.LineSegments(
      lineGeo,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    )
    lines.frustumCulled = false
    lines.renderOrder = 1
    world.add(lines)
    world.add(points)

    adj = nodes.map(() => [])
    for (const l of links) {
      adj[l.a]?.push(l.b)
      adj[l.b]?.push(l.a)
    }
    labels.set(specs)
    const keep = pickedId
    pickedId = keep && nodes.some((d) => d.moment?.id === keep) ? keep : null
    paintFocus()
    if (refit || !fitted) {
      fit()
      fitted = true
    }
    kick()
  }

  // ── focus: one node, its links and its neighbours stay lit ──
  function paintFocus() {
    if (!points || !lineGeo) return
    const pickIdx = pickedId ? nodes.findIndex((d) => d.moment?.id === pickedId) : -1
    const focus = hoverIdx >= 0 ? hoverIdx : pickIdx
    const hi = points.geometry.getAttribute('aHi') as THREE.BufferAttribute
    const near = new Set(focus >= 0 ? (adj[focus] ?? []) : [])
    for (let i = 0; i < nodes.length; i++)
      hi.setX(i, i === focus || i === pickIdx ? 1 : near.has(i) ? 0.7 : 0)
    hi.needsUpdate = true
    uniforms.uFocus.value = focus >= 0 ? 1 : 0
    const C = lineGeo.getAttribute('color') as THREE.BufferAttribute
    const c = new THREE.Color()
    for (const l of links) {
      const touches = focus < 0 || l.a === focus || l.b === focus
      const k = focus < 0 ? l.alpha : touches ? l.lit : l.alpha * 0.12
      const steps = l.end - l.start
      for (let j = 0; j < steps; j++) {
        const u = steps > 2 ? Math.floor(j / 2) / (steps / 2) : j
        c.copy(l.from).lerp(l.to, u)
        // fades along its length, as the map's arcs do, so the far end does not fight the node
        const fade = k * (1 - u * 0.35)
        C.setXYZ(l.start + j, c.r * fade, c.g * fade, c.b * fade)
      }
    }
    C.needsUpdate = true
    kick()
  }

  // ── camera: flat, top-down, pan and zoom ──
  function sync() {
    const r = stage.getBoundingClientRect()
    if (!r.width || !r.height) return false
    renderer.setSize(r.width, r.height, false)
    camera.aspect = r.width / r.height
    camera.updateProjectionMatrix()
    uniforms.uPx.value = (r.height * renderer.getPixelRatio()) / 2
    return true
  }
  function place() {
    camera.position.set(target.x, dist, target.z)
    camera.lookAt(target)
    camera.near = dist / 50
    camera.far = dist * 4
    camera.updateProjectionMatrix()
  }
  function fit() {
    sync()
    const R = RMAX + 125
    const t = Math.tan((FOV * Math.PI) / 360)
    target.set(0, 0, 0)
    dist = R / t / Math.min(1, camera.aspect)
    place()
    kick()
  }
  const ndcOf = (ev: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect()
    return {
      x: ((ev.clientX - r.left) / r.width) * 2 - 1,
      y: -((ev.clientY - r.top) / r.height) * 2 + 1,
    }
  }
  /** the ground point under the pointer */
  const ground = (ev: { clientX: number; clientY: number }) => {
    const n = ndcOf(ev)
    const t = Math.tan((FOV * Math.PI) / 360) * dist
    return new THREE.Vector3(target.x + n.x * t * camera.aspect, 0, target.z - n.y * t)
  }

  let drag: { x: number; y: number; moved: boolean; from: THREE.Vector3 } | null = null
  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId)
    drag = { x: ev.clientX, y: ev.clientY, moved: false, from: target.clone() }
  })
  canvas.addEventListener('pointermove', (ev) => {
    if (drag && (ev.buttons & 1) === 1) {
      const dx = ev.clientX - drag.x
      const dy = ev.clientY - drag.y
      if (Math.hypot(dx, dy) > 4) drag.moved = true
      if (drag.moved) {
        const per = (2 * Math.tan((FOV * Math.PI) / 360) * dist) / canvas.clientHeight
        target.set(drag.from.x - dx * per, 0, drag.from.z - dy * per)
        place()
        tip.hidden = true
        kick()
        return
      }
    }
    hover(ev)
  })
  canvas.addEventListener('pointerup', (ev) => {
    const d = drag
    drag = null
    if (!d || d.moved) return
    const i = nearest(ev)
    const m = i >= 0 ? (nodes[i]?.moment ?? null) : null
    pickedId = m?.id ?? null
    paintFocus()
    on.pick?.(m)
  })
  canvas.addEventListener('pointerleave', () => {
    hoverIdx = -1
    tip.hidden = true
    paintFocus()
  })
  canvas.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault()
      const before = ground(ev)
      dist = Math.min(6000, Math.max(160, dist * Math.exp(ev.deltaY * 0.0015)))
      // zoom toward the pointer: the ground under it stays under it
      const after = ground(ev)
      target.add(before.sub(after))
      place()
      tip.hidden = true
      kick()
    },
    { passive: false },
  )

  const v = new THREE.Vector3()
  function nearest(ev: { clientX: number; clientY: number }) {
    const r = canvas.getBoundingClientRect()
    const px = ev.clientX - r.left
    const py = ev.clientY - r.top
    const perWorld = canvas.clientHeight / (2 * Math.tan((FOV * Math.PI) / 360) * dist)
    let best = -1
    let bestD = Number.POSITIVE_INFINITY
    nodes.forEach((d, i) => {
      if (!d.moment) return
      v.copy(d.pos).project(camera)
      const sx = ((v.x + 1) / 2) * r.width
      const sy = ((1 - v.y) / 2) * r.height
      const dd = Math.hypot(sx - px, sy - py)
      if (dd < Math.max(9, d.size * perWorld * 0.8) && dd < bestD) {
        best = i
        bestD = dd
      }
    })
    return best
  }
  function hover(ev: PointerEvent) {
    const i = nearest(ev)
    canvas.style.cursor = i >= 0 ? 'pointer' : 'grab'
    if (i === hoverIdx) return
    hoverIdx = i
    const m = i >= 0 ? nodes[i]?.moment : null
    if (m) {
      const r = canvas.getBoundingClientRect()
      const state =
        m.kind === 'work'
          ? m.lvl === 'warn'
            ? 'your turn'
            : m.lvl === 'bad'
              ? 'blocked'
              : m.lvl === 'good'
                ? 'working'
                : 'work'
          : m.kind === 'commit'
            ? 'commits'
            : 'memory note'
      tip.innerHTML = ''
      const head = document.createElement('div')
      head.className = `hm-k ${m.kind} ${m.lvl}`
      head.textContent = `${state} · ${m.clock}`
      const title = document.createElement('b')
      title.textContent = m.title
      const meta = document.createElement('span')
      meta.textContent = m.meta
      tip.append(head, title, meta)
      tip.hidden = false
      const x = ev.clientX - r.left
      const y = ev.clientY - r.top
      tip.style.left = `${Math.min(x + 16, r.width - 300)}px`
      tip.style.top = `${Math.min(y + 16, r.height - 90)}px`
    } else tip.hidden = true
    paintFocus()
  }

  // ── frames ──
  const clock = new THREE.Clock()
  let dirty = true
  let drawnAt = 0
  function frame(now: number) {
    raf = 0
    if (!alive || !canvas.isConnected || !canvas.offsetParent) return
    // a pulse alone only needs thirty frames a second; anything that moved gets the next one
    if (!dirty && now - drawnAt < 33) {
      raf = requestAnimationFrame(frame)
      return
    }
    dirty = false
    drawnAt = now
    uniforms.uTime.value = clock.getElapsedTime()
    const r = stage.getBoundingClientRect()
    labels.update(camera, r.width, r.height)
    renderer.render(scene, camera)
    if (pulsing && !matchMedia('(prefers-reduced-motion: reduce)').matches)
      raf = requestAnimationFrame(frame)
  }
  function kick() {
    dirty = true
    if (!raf && alive) raf = requestAnimationFrame(frame)
  }

  return {
    build,
    resize() {
      if (!sync()) return
      if (!fitted && nodes.length) fit()
      else place()
      kick()
    },
    fit,
    select(id) {
      pickedId = id && nodes.some((d) => d.moment?.id === id) ? id : null
      paintFocus()
    },
    dispose() {
      alive = false
      cancelAnimationFrame(raf)
      clear()
      pointMat.dispose()
      hex?.dispose()
      tip.remove()
      renderer.dispose()
    },
  }
}
