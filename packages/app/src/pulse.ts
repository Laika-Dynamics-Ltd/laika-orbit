/**
 * /pulse — adoption as a node network you fly through.
 *
 * The shape is the funnel, drawn in space rather than as four bars: visitors sit on the widest
 * shell, cloners inside them, installs inside those, and active use at the core. Time runs into
 * the screen, one ring per day, today nearest the camera. So a node "flowing in" is literal —
 * arrivals appear on the outer shell and the arcs carry them inward, and a healthy week is a
 * tunnel that narrows evenly rather than one that flares at the mouth and dies before the core.
 *
 * HONESTY, WHICH MATTERS MORE HERE THAN ANYWHERE ELSE IN THE APP: a cohort node is drawn as a
 * ring, not a disc, and says "9 cloners" rather than pretending to be nine people. GitHub gives
 * daily counts, not individuals, and no amount of rendering makes them individuals. Only the
 * filled discs are one-per-install, and only because those users opted in. The inward arcs are
 * inferred from the funnel's ordering — nobody is followed from one stage to the next — and the
 * legend says so.
 *
 * Reads /api/pulse only (see packages/app/pulse-api.mjs). Polls rather than holding a stream, for
 * the same reason /runs does: never take one of the browser's six connections to this origin.
 */
import * as THREE from 'three'
import './themes.css'
import './pulse.css'

type Node = {
  id: string
  kind: string
  day: string
  at: number
  cohort: boolean
  weight: number
  count: number
  label: string
  features: string[]
  region: string | null
}
type Link = { a: string; b: string; kind: 'flow' | 'shared'; inferred: boolean; w: number }
type Series = {
  day: string
  at: number
  view: number
  clone: number
  install: number
  session: number
}
type Graph = {
  nodes: Node[]
  links: Link[]
  totals: Record<string, number>
  series: Series[]
  days: number
  now: number
}
type Feature = { feature: string; uses: number; installs: number }
type Source = {
  ok: boolean
  reason?: string
  hint?: string
  repo?: string
  signals?: number
  installs?: number
}
type Pulse = {
  v: number
  now: number
  graph: Graph
  features: Feature[]
  sources: { github: Source; telemetry: Source }
  consent: string
}

/** the shells, outermost first. Radius is the funnel: each stage sits inside the last. */
const STAGES = [
  { kind: 'view', r: 44, color: 0x2e7fa8, label: 'visitors' },
  { kind: 'clone', r: 31, color: 0x56d8ff, label: 'cloners' },
  { kind: 'install', r: 17, color: 0xff8a4c, label: 'installs' },
  { kind: 'session', r: 6.5, color: 0xffd2a8, label: 'active' },
]
const STAGE_OF = new Map(STAGES.map((s, i) => [s.kind, i]))
/** distance between two days' rings */
const SPACING = 13
const POLL_MS = 30_000

export type Placed = Node & { x: number; y: number; z: number; stage: number }

/**
 * Where every node sits. Pure, and exported so a test can assert the funnel's geometry without
 * a WebGL context: stage decides the radius, the day decides the depth, and nodes sharing both
 * are spread evenly around their ring so installs never stack into one point.
 */
export function layout(graph: Graph): Placed[] {
  const days = [...new Set(graph.nodes.map((n) => n.day))].sort()
  const last = days.length - 1
  const groups = new Map<string, { day: string; kind: string; list: Node[] }>()
  for (const n of graph.nodes) {
    const key = `${n.day}:${n.kind}`
    const g = groups.get(key) ?? { day: n.day, kind: n.kind, list: [] }
    g.list.push(n)
    groups.set(key, g)
  }
  const out: Placed[] = []
  for (const { day, kind, list } of groups.values()) {
    const stage = STAGE_OF.get(kind)
    const shell = stage === undefined ? undefined : STAGES[stage]
    if (stage === undefined || !shell) continue
    const dayIndex = days.indexOf(day)
    const z = (dayIndex - last) * SPACING
    list.forEach((n, i) => {
      // a lone cohort node would always sit at the same angle on every ring, drawing a straight
      // seam down the tunnel; offsetting by the day keeps the shells looking like shells
      const a = (i / list.length) * Math.PI * 2 + dayIndex * 0.6
      out.push({ ...n, stage, x: Math.cos(a) * shell.r, y: Math.sin(a) * shell.r, z })
    })
  }
  return out
}

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector(sel) as T

const NODE_VS = `
attribute float aSize, aBirth, aSeed, aCohort;
attribute vec3 aColor;
uniform float uNow;
varying vec3 vCol; varying float vCohort; varying float vFade;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // arrivals pop: a node scales past its size and settles in about a second
  float age = clamp((uNow - aBirth) / 1.0, 0.0, 1.0);
  float pop = 1.0 + 1.6 * age * (1.0 - age) * 4.0 * (1.0 - age);
  // a slow breath so the field never looks like a still image
  float breath = 0.94 + 0.06 * sin(uNow * 1.1 + aSeed * 6.28);
  gl_PointSize = aSize * pop * breath * (300.0 / max(1.0, -mv.z));
  vCol = aColor; vCohort = aCohort;
  vFade = smoothstep(0.0, 0.35, age);
  gl_Position = projectionMatrix * mv;
}`
const NODE_FS = `
precision highp float;
varying vec3 vCol; varying float vCohort; varying float vFade;
void main(){
  vec2 p = gl_PointCoord - 0.5;
  float d = length(p);
  if (d > 0.5) discard;
  // a cohort stands for many and is drawn hollow; an install is one person and is solid
  float core = vCohort > 0.5
    ? smoothstep(0.5, 0.42, d) * smoothstep(0.28, 0.36, d)
    : smoothstep(0.5, 0.05, d);
  float halo = smoothstep(0.5, 0.0, d) * 0.35;
  float a = (core + halo) * vFade;
  gl_FragColor = vec4(vCol * (0.6 + core), a);
}`

const LINK_VS = `
attribute float aAlpha, aFlow;
attribute vec3 aColor;
uniform float uNow;
varying float vA; varying vec3 vCol;
void main(){
  // a travelling brightness along inferred arcs, so the funnel reads as movement inward
  float pulse = 0.55 + 0.45 * sin(uNow * 1.6 - aFlow * 7.0);
  vA = aAlpha * mix(1.0, pulse, step(0.5, aFlow));
  vCol = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`
const LINK_FS = `
precision highp float;
varying float vA; varying vec3 vCol;
void main(){ gl_FragColor = vec4(vCol * vA, vA); }`

function start() {
  const root = $('#pu')
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')

  // --- HUD -------------------------------------------------------------------------
  root.innerHTML = `
    <div class="pu-hud">
      <div class="pu-title">Laika Orbit<b>Adoption pulse</b></div>
      <div class="pu-card">
        <h3>The funnel · <span id="pu-days">30</span>d</h3>
        <div id="pu-funnel"></div>
      </div>
      <div class="pu-card">
        <h3>Behaviour</h3>
        <div id="pu-features"></div>
      </div>
      <div class="pu-card">
        <h3>Sources</h3>
        <div id="pu-sources"></div>
      </div>
      <div class="pu-note" id="pu-legend">
        Hollow rings are <b>cohorts</b> — a day's count, not people. Solid discs are opted-in
        installs. Inward arcs are the funnel's shape, not individuals followed between stages.
      </div>
    </div>
    <div class="pu-tip" id="pu-tip"></div>
    <div class="pu-axis" id="pu-axis"></div>
    <div class="pu-help">drag to orbit · scroll to zoom · <kbd>r</kbd> reset</div>`
  const tip = $('#pu-tip')

  // --- scene ------------------------------------------------------------------------
  const scene = new THREE.Scene()
  scene.fog = new THREE.FogExp2(0x05070d, 0.0075)
  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 900)
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(innerWidth, innerHeight)
  renderer.setClearColor(0x05070d, 1)
  root.appendChild(renderer.domElement)

  // a faint starfield so the tunnel has somewhere to be, and so an empty pulse is still a scene
  const stars = (() => {
    const pos: number[] = []
    for (let i = 0; i < 1400; i++) {
      const r = 180 + Math.random() * 380
      const th = Math.random() * Math.PI * 2
      const ph = Math.acos(2 * Math.random() - 1)
      pos.push(Math.sin(ph) * Math.cos(th) * r, Math.sin(ph) * Math.sin(th) * r, Math.cos(ph) * r)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    const p = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        color: 0x7fa8c8,
        size: 1.1,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
      }),
    )
    scene.add(p)
    return p
  })()

  const NU = { uNow: { value: 0 } }
  const LU = { uNow: { value: 0 } }
  let nodeMesh: THREE.Points | null = null
  let linkMesh: THREE.LineSegments | null = null
  let placed: Placed[] = []
  /** when each node first appeared, in scene seconds — drives the arrival pop */
  const bornAt = new Map<string, number>()
  let clock = 0

  function dispose(o: THREE.Object3D | null) {
    if (!o) return
    scene.remove(o)
    const m = o as THREE.Points
    m.geometry.dispose()
    ;(m.material as THREE.Material).dispose()
  }

  function build(graph: Graph) {
    placed = layout(graph)
    const byId = new Map(placed.map((p) => [p.id, p]))
    dispose(nodeMesh)
    dispose(linkMesh)
    nodeMesh = null
    linkMesh = null
    if (!placed.length) return

    const pos: number[] = []
    const size: number[] = []
    const col: number[] = []
    const birth: number[] = []
    const seed: number[] = []
    const cohort: number[] = []
    for (const p of placed) {
      if (!bornAt.has(p.id)) bornAt.set(p.id, clock)
      const c = new THREE.Color(STAGES[p.stage]?.color ?? 0xffffff)
      pos.push(p.x, p.y, p.z)
      // area, not radius, tracks the weight — a 40-visitor day should not swamp a 4-install one
      size.push(4.2 + Math.sqrt(p.weight) * 2.6)
      col.push(c.r, c.g, c.b)
      birth.push(bornAt.get(p.id)!)
      seed.push(Math.random())
      cohort.push(p.cohort ? 1 : 0)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1))
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3))
    g.setAttribute('aBirth', new THREE.Float32BufferAttribute(birth, 1))
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1))
    g.setAttribute('aCohort', new THREE.Float32BufferAttribute(cohort, 1))
    nodeMesh = new THREE.Points(
      g,
      new THREE.ShaderMaterial({
        uniforms: NU,
        vertexShader: NODE_VS,
        fragmentShader: NODE_FS,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    )
    nodeMesh.frustumCulled = false
    scene.add(nodeMesh)

    // links, bowed so overlapping arcs separate the way the core's beams do
    const lp: number[] = []
    const la: number[] = []
    const lc: number[] = []
    const lf: number[] = []
    const SEG = 14
    for (const l of graph.links) {
      const a = byId.get(l.a)
      const b = byId.get(l.b)
      if (!a || !b) continue
      const c = new THREE.Color(l.kind === 'shared' ? 0xff8a4c : 0x3f94c4)
      const alpha = l.kind === 'shared' ? 0.5 : Math.min(0.34, 0.1 + l.w * 0.02)
      const av = new THREE.Vector3(a.x, a.y, a.z)
      const bv = new THREE.Vector3(b.x, b.y, b.z)
      const mid = av.clone().add(bv).multiplyScalar(0.5).multiplyScalar(1.12)
      let px = av.x
      let py = av.y
      let pz = av.z
      for (let k = 1; k <= SEG; k++) {
        const u = k / SEG
        const iu = 1 - u
        const x = iu * iu * av.x + 2 * iu * u * mid.x + u * u * bv.x
        const y = iu * iu * av.y + 2 * iu * u * mid.y + u * u * bv.y
        const z = iu * iu * av.z + 2 * iu * u * mid.z + u * u * bv.z
        lp.push(px, py, pz, x, y, z)
        for (const t of [(k - 1) / SEG, u]) {
          la.push(alpha)
          lc.push(c.r, c.g, c.b)
          lf.push(l.inferred ? t : 0)
        }
        px = x
        py = y
        pz = z
      }
    }
    if (lp.length) {
      const lg = new THREE.BufferGeometry()
      lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3))
      lg.setAttribute('aAlpha', new THREE.Float32BufferAttribute(la, 1))
      lg.setAttribute('aColor', new THREE.Float32BufferAttribute(lc, 3))
      lg.setAttribute('aFlow', new THREE.Float32BufferAttribute(lf, 1))
      linkMesh = new THREE.LineSegments(
        lg,
        new THREE.ShaderMaterial({
          uniforms: LU,
          vertexShader: LINK_VS,
          fragmentShader: LINK_FS,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      )
      linkMesh.frustumCulled = false
      scene.add(linkMesh)
    }
  }

  // --- camera: orbit, drag, zoom ------------------------------------------------------
  const home = { yaw: 0.35, pitch: 0.22, dist: 96 }
  let cam = { ...home }
  let drag: { x: number; y: number } | null = null
  renderer.domElement.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY }
    renderer.domElement.setPointerCapture(e.pointerId)
  })
  addEventListener('pointerup', () => {
    drag = null
  })
  addEventListener('pointermove', (e) => {
    pointer.x = (e.clientX / innerWidth) * 2 - 1
    pointer.y = -(e.clientY / innerHeight) * 2 + 1
    mouse = { x: e.clientX, y: e.clientY }
    if (!drag) return
    cam.yaw += (e.clientX - drag.x) * 0.005
    cam.pitch = Math.max(-1.2, Math.min(1.2, cam.pitch + (e.clientY - drag.y) * 0.005))
    drag = { x: e.clientX, y: e.clientY }
  })
  renderer.domElement.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      cam.dist = Math.max(26, Math.min(320, cam.dist + e.deltaY * 0.12))
    },
    { passive: false },
  )
  addEventListener('keydown', (e) => {
    if (e.key === 'r') cam = { ...home }
  })

  // --- hover ---------------------------------------------------------------------------
  const ray = new THREE.Raycaster()
  ray.params.Points = { threshold: 2.6 }
  const pointer = new THREE.Vector2(2, 2)
  let mouse = { x: 0, y: 0 }

  function hover() {
    if (!nodeMesh || !placed.length) return tip.classList.remove('on')
    ray.setFromCamera(pointer, camera)
    const hit = ray.intersectObject(nodeMesh, false)[0]
    if (!hit || hit.index === undefined) return tip.classList.remove('on')
    const p = placed[hit.index]
    if (!p) return tip.classList.remove('on')
    const when = new Date(p.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    const extra = p.cohort
      ? `<i class="cohort">a day's count, not individuals</i>`
      : `<i>${p.features.length ? `${p.features.length} feature${p.features.length === 1 ? '' : 's'} used` : 'opted-in install'}${p.region ? ` · ${p.region}` : ''}</i>`
    tip.innerHTML = `<b>${p.label}</b> <i>${when} · ${STAGES[p.stage]?.label ?? ''}</i>${extra}`
    tip.style.left = `${mouse.x}px`
    tip.style.top = `${mouse.y}px`
    tip.classList.add('on')
  }

  // --- the rails ------------------------------------------------------------------------
  function paint(p: Pulse) {
    $('#pu-days').textContent = String(p.graph.days)
    const top = Math.max(1, ...STAGES.map((s) => p.graph.totals[s.kind] ?? 0))
    $('#pu-funnel').innerHTML = STAGES.map((s) => {
      const n = p.graph.totals[s.kind] ?? 0
      const hex = `#${s.color.toString(16).padStart(6, '0')}`
      return `<div class="pu-stage"><i>${s.label}</i><div class="bar"><span style="width:${(n / top) * 100}%;background:${hex}"></span></div><b>${n.toLocaleString()}</b></div>`
    }).join('')

    $('#pu-features').innerHTML = p.features.length
      ? p.features
          .slice(0, 7)
          .map(
            (f) =>
              `<div class="pu-feat"><span>${f.feature.replace(/_/g, ' ')}</span><b>${f.uses.toLocaleString()}</b></div>`,
          )
          .join('')
      : `<div class="pu-empty">No opted-in installs yet. Behaviour appears here once someone turns reporting on.</div>`

    const src = (name: string, s: Source, detail: string) => {
      const cls = s.ok
        ? 'on'
        : s.reason === 'no-token' || s.reason === 'no-endpoint' || s.reason === 'no-read-token'
          ? 'off'
          : 'warn'
      return `<div class="pu-src"><span class="dot ${cls}"></span>${name} <em>${detail}</em></div>`
    }
    $('#pu-sources').innerHTML =
      src(
        'GitHub',
        p.sources.github,
        p.sources.github.ok ? (p.sources.github.repo ?? '') : (p.sources.github.reason ?? ''),
      ) +
      src(
        'Telemetry',
        p.sources.telemetry,
        p.sources.telemetry.ok
          ? `${p.sources.telemetry.installs ?? 0} installs`
          : (p.sources.telemetry.reason ?? ''),
      ) +
      `<div class="pu-src"><span class="dot ${p.consent === 'on' ? 'on' : 'off'}"></span>This Mac <em>${p.consent === 'on' ? 'reporting' : p.consent === 'off' ? 'not reporting' : 'not asked'}</em></div>`

    const days = p.graph.series.slice(-14)
    $('#pu-axis').innerHTML = days
      .map(
        (d, i) =>
          `<i class="${i === days.length - 1 ? 'now' : ''}">${d.day.slice(5).replace('-', '/')}</i>`,
      )
      .join('')
  }

  // --- loop -------------------------------------------------------------------------------
  let lastFrame = performance.now()
  function frame(now: number) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000)
    lastFrame = now
    clock += dt
    NU.uNow.value = clock
    LU.uNow.value = clock
    if (!drag && !reduce.matches) cam.yaw += dt * 0.045 // a slow drift, so the depth reads
    const cp = Math.cos(cam.pitch)
    camera.position.set(
      Math.sin(cam.yaw) * cp * cam.dist,
      Math.sin(cam.pitch) * cam.dist,
      Math.cos(cam.yaw) * cp * cam.dist,
    )
    // look a little down the tunnel rather than at its mouth, so older days stay in frame
    camera.lookAt(0, 0, -SPACING * 3)
    stars.rotation.y += dt * 0.004
    hover()
    renderer.render(scene, camera)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
  })

  // --- data --------------------------------------------------------------------------------
  async function load() {
    try {
      const res = await fetch('/api/pulse?days=30')
      if (!res.ok) return
      const p: Pulse = await res.json()
      build(p.graph)
      paint(p)
    } catch {
      // a failed poll is not worth a banner: the last scene stays up and we try again
    }
  }
  load()
  setInterval(load, POLL_MS)
}

if (typeof document !== 'undefined' && document.getElementById('pu')) start()
