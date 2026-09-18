/**
 * The Users scene: six hubs, one per step, and a node per person that flows in and gathers at the
 * last step they took.
 *
 * READING IT
 *   hubs      left to right in the order a Pro customer meets them; the ring under each grows with
 *             the people gathered there now, the label says how many ever reached it
 *   ribbons   one per step-to-step move people actually made, as thick as the number who made it;
 *             the free path (site → app, no waitlist) arcs over the paid one
 *   nodes     grey is a person, orange has paid, cyan is using the app right now (a ring round
 *             it), faded has not been seen for three days and has stopped short of the end
 *   motion    only when something happens: an arrival flies in from the left, a step taken flies
 *             along its ribbon. Nothing drifts or spins, so an unchanging week is a still picture.
 *
 * COST
 * One renderer, made the first time the scene is shown and released after it has been hidden for
 * a while (see releaseGPU). Frames are drawn on demand: while nothing moves, nothing is drawn. The
 * level (users-level.ts) sets the pace when something does move — every frame when live, the
 * map's ~15fps when idle and ~4fps when another window has focus, and no frames at all when
 * hidden. The pacing constants are the map's (main.ts) so the two feel alike.
 */
import * as THREE from 'three'
import {
  activeAt,
  DAY,
  type Feed,
  lastSeen,
  type Person,
  STEP_INDEX,
  STEPS,
  type StepId,
  stepsAt,
} from './users-data.ts'
import type { Level } from './users-level.ts'

const AMBIENT_MS = 66
const AWAY_MS = 250
const TRANSIT_MS = 1700
/** camera and cluster easing time constant, as the map's EASE */
const EASE = 140
const SETTLE_MS = 320
const STALE_AFTER = 3 * DAY
const FOV = 38

const C = {
  bg: 0x07090d,
  person: new THREE.Color('#8f99b4'),
  paid: new THREE.Color('#ff7a45'),
  active: new THREE.Color('#56d8ff'),
  hub: new THREE.Color('#dfe4f0'),
  ring: new THREE.Color('#2a3248'),
  ribbon: new THREE.Color('#5c6680'),
  path: new THREE.Color('#56d8ff'),
}

/**
 * hub positions: a horseshoe opening toward you, read left to right. The depth is what lets a tall
 * narrow panel use its height: seen from above at an angle, the back of the arc sits higher on
 * screen than its two ends.
 */
const HUB = STEPS.map((_, i) => {
  const a = ((i / (STEPS.length - 1)) * 2 - 1) * 1.85
  return new THREE.Vector3(Math.sin(a) * 235, i * 4 - 10, -Math.cos(a) * 230 + 30)
})
const SPAWN = new THREE.Vector3(-430, 30, 300)

export type Hover =
  | { kind: 'person'; person: Person; x: number; y: number }
  | { kind: 'hub'; step: StepId; x: number; y: number }
  | null

export type HubStats = {
  reached: number
  here: number
  active: number
  counted?: { n: number; note: string }
}

/** a stable pseudo-random unit-ish offset for a person, from their id */
function offsetFor(id: string) {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  const a = ((h >>> 0) % 10007) / 10007
  const b = ((Math.imul(h, 2654435761) >>> 0) % 10009) / 10009
  const c = ((Math.imul(h ^ 0x5bd1e995, 40503) >>> 0) % 10037) / 10037
  const theta = a * Math.PI * 2
  const z = b * 2 - 1
  const s = Math.sqrt(1 - z * z)
  const r = Math.cbrt(0.15 + 0.85 * c)
  // flattened: a cluster reads as a disc lying on its ring, with some depth
  return new THREE.Vector3(Math.cos(theta) * s * r, z * r * 0.42, Math.sin(theta) * s * r)
}

const VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying vec3 vC;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uScale / -mv.z;
  vC = aColor;
  vA = aAlpha;
}`
const FRAG = /* glsl */ `
uniform float uRing;
varying vec3 vC;
varying float vA;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float aa = max(fwidth(r) * 1.5, 0.02);
  float a;
  if (uRing > 0.5) {
    a = smoothstep(0.74 - aa, 0.74, r) * (1.0 - smoothstep(0.9 - aa, 0.9, r)) + (1.0 - smoothstep(0.0, 0.9, r)) * 0.08;
  } else {
    a = 1.0 - smoothstep(1.0 - aa * 2.0, 1.0, r);
  }
  a *= vA;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vC, a);
}`

function pointsMaterial(ring: boolean) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uScale: { value: 1 }, uRing: { value: ring ? 1 : 0 } },
    transparent: true,
    depthWrite: false,
  })
}

const curveCache = new Map<string, THREE.QuadraticBezierCurve3>()
function curveBetween(a: THREE.Vector3, b: THREE.Vector3, key: string) {
  let c = curveCache.get(key)
  if (c) return c
  const d = a.distanceTo(b)
  const mid = a.clone().lerp(b, 0.5)
  // longer moves (the free path skips three hubs) arc higher, so they read as skipping
  mid.y += 10 + d * 0.3
  mid.z += 18
  c = new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone())
  curveCache.set(key, c)
  return c
}
const hubCurve = (a: number, b: number) => curveBetween(HUB[a]!, HUB[b]!, `${a}>${b}`)

const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2)

export function createUsersScene(host: HTMLElement, on: { hover(h: Hover): void }) {
  const scene = new THREE.Scene()
  /**
   * Everything lives in `world`, whose depth is stretched to the panel's shape: a tall narrow panel
   * gets a deeper U, so the network fills its height instead of sitting in a band across it.
   */
  const world = new THREE.Group()
  scene.add(world)
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 5000)
  let renderer: THREE.WebGLRenderer | null = null
  const labels = document.createElement('div')
  labels.className = 'usr-labels'
  host.appendChild(labels)

  // ------------------------------------------------------------------ hubs ----
  const hubGeo = new THREE.BufferGeometry()
  hubGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(HUB.flatMap((v) => [v.x, v.y, v.z])), 3),
  )
  hubGeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(HUB.length).fill(6), 1))
  hubGeo.setAttribute(
    'aAlpha',
    new THREE.BufferAttribute(new Float32Array(HUB.length).fill(0.95), 1),
  )
  hubGeo.setAttribute(
    'aColor',
    new THREE.BufferAttribute(new Float32Array(HUB.flatMap(() => [C.hub.r, C.hub.g, C.hub.b])), 3),
  )
  const hubMat = pointsMaterial(false)
  world.add(new THREE.Points(hubGeo, hubMat))

  const ringGeo = new THREE.BufferGeometry().setFromPoints(
    Array.from({ length: 97 }, (_, k) => {
      const a = (k / 96) * Math.PI * 2
      return new THREE.Vector3(Math.cos(a), 0, Math.sin(a))
    }),
  )
  const ringMat = new THREE.LineBasicMaterial({ color: C.ring, transparent: true, opacity: 0.9 })
  const rings = HUB.map((p) => {
    const l = new THREE.Line(ringGeo, ringMat)
    l.position.copy(p)
    l.position.y -= 1
    world.add(l)
    return l
  })
  /** cluster radius per hub, eased toward `radiusWant` */
  const radius = HUB.map(() => 10)
  const radiusWant = HUB.map(() => 10)

  // --------------------------------------------------------------- ribbons ----
  const ribbonMat = new THREE.MeshBasicMaterial({
    color: C.ribbon,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
  })
  const ribbons = new Map<string, { mesh: THREE.Mesh; n: number }>()
  const pathMat = new THREE.LineBasicMaterial({ color: C.path, transparent: true, opacity: 0.95 })
  let pathLine: THREE.Line | null = null

  // ---------------------------------------------------------------- people ----
  let feed: Feed | null = null
  let people: Person[] = []
  let off: THREE.Vector3[] = []
  let pos = new Float32Array(0)
  let hub = new Int8Array(0)
  let from = new Int8Array(0)
  let tStart = new Float64Array(0)
  let paid = new Uint8Array(0)
  let active = new Uint8Array(0)
  let stale = new Uint8Array(0)
  let transits = 0
  let T = 0
  let stats: HubStats[] = HUB.map(() => ({ reached: 0, here: 0, active: 0 }))
  let hovered = -1

  const geo = new THREE.BufferGeometry()
  const halo = new THREE.BufferGeometry()
  const mat = pointsMaterial(false)
  const haloMat = pointsMaterial(true)
  const pts = new THREE.Points(geo, mat)
  const haloPts = new THREE.Points(halo, haloMat)
  pts.frustumCulled = false
  haloPts.frustumCulled = false
  world.add(haloPts, pts)

  function alloc(n: number) {
    pos = new Float32Array(n * 3)
    hub = new Int8Array(n).fill(-1)
    from = new Int8Array(n).fill(-1)
    tStart = new Float64Array(n)
    paid = new Uint8Array(n)
    active = new Uint8Array(n)
    stale = new Uint8Array(n)
    const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', posAttr)
    geo.setAttribute(
      'aSize',
      new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage),
    )
    geo.setAttribute(
      'aAlpha',
      new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage),
    )
    geo.setAttribute(
      'aColor',
      new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage),
    )
    halo.setAttribute('position', posAttr)
    halo.setAttribute(
      'aSize',
      new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage),
    )
    halo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(n).fill(0.7), 1))
    halo.setAttribute(
      'aColor',
      new THREE.BufferAttribute(
        new Float32Array(n * 3).map((_, k) => [C.active.r, C.active.g, C.active.b][k % 3]!),
        3,
      ),
    )
  }

  const targetOf = (i: number, out: THREE.Vector3) =>
    out.copy(off[i]!).multiplyScalar(radius[hub[i]!]!).add(HUB[hub[i]!]!)
  const spawnOf = (i: number) => SPAWN.clone().addScaledVector(off[i]!, 40)

  function curveFor(i: number) {
    const a = from[i]!
    const b = hub[i]!
    if (a < 0) return curveBetween(spawnOf(i), HUB[b]!, `spawn-${i}>${b}`)
    return hubCurve(a, b)
  }

  /** where everyone is at time t; `animate` flies changes along their ribbons, else they jump */
  function setTime(t: number, animate: boolean, force = false) {
    if (!feed) return
    T = t
    const grain = feed.activeGrain
    const now = performance.now()
    const next: HubStats[] = HUB.map(() => ({ reached: 0, here: 0, active: 0 }))
    // the live clock calls this every second; most seconds nobody moves, and then nothing is drawn
    let changed = force
    const flow = new Map<string, number>()
    const v = new THREE.Vector3()
    for (let i = 0; i < people.length; i++) {
      const p = people[i]!
      const seq = stepsAt(p, t)
      const h = seq.length ? STEP_INDEX[seq[seq.length - 1]!] : -1
      for (const s of seq) next[STEP_INDEX[s]]!.reached++
      for (let k = 1; k < seq.length; k++) {
        const key = `${STEP_INDEX[seq[k - 1]!]}>${STEP_INDEX[seq[k]!]}`
        flow.set(key, (flow.get(key) ?? 0) + 1)
      }
      const pd = p.steps.pro !== undefined && p.steps.pro <= t ? 1 : 0
      const ac = h >= 0 && activeAt(p, t, grain) ? 1 : 0
      const st = h >= 0 && h < STEPS.length - 1 && !ac && t - lastSeen(p, t) > STALE_AFTER ? 1 : 0
      if (pd !== paid[i] || ac !== active[i] || st !== stale[i] || h !== hub[i]) changed = true
      paid[i] = pd
      active[i] = ac
      stale[i] = st
      if (h >= 0) {
        next[h]!.here++
        if (active[i]) next[h]!.active++
      }
      if (h === hub[i]!) continue
      const was = hub[i]!
      hub[i] = h
      if (h >= 0 && animate && (was < 0 || h > was)) {
        if (tStart[i]! === 0) transits++
        from[i] = was
        tStart[i] = now
        continue
      }
      // scrubbed, or went backwards: no flight, just be there
      if (tStart[i] !== 0) transits--
      tStart[i] = 0
      if (h >= 0) {
        targetOf(i, v)
        pos.set([v.x, v.y, v.z], i * 3)
      }
    }
    for (const [k, c] of Object.entries(feed.counts ?? {}))
      if (c) next[STEP_INDEX[k as StepId]]!.counted = c
    stats = next
    for (let h = 0; h < HUB.length; h++) radiusWant[h] = 9 + 2.1 * Math.sqrt(stats[h]!.here)
    if (!changed) return
    setRibbons(flow)
    paint()
    labelText()
    wake()
  }

  function setRibbons(flow: Map<string, number>) {
    for (const [key, r] of ribbons)
      if (!flow.has(key)) {
        world.remove(r.mesh)
        r.mesh.geometry.dispose()
        ribbons.delete(key)
      }
    for (const [key, n] of flow) {
      const r = ribbons.get(key)
      // rebuild only when the thickness would visibly change
      if (r && Math.abs(Math.sqrt(r.n) - Math.sqrt(n)) < 0.25) continue
      const [a, b] = key.split('>').map(Number) as [number, number]
      const g = new THREE.TubeGeometry(hubCurve(a, b), 48, 0.5 + 0.34 * Math.sqrt(n), 8, false)
      if (r) {
        r.mesh.geometry.dispose()
        r.mesh.geometry = g
        r.n = n
      } else {
        const mesh = new THREE.Mesh(g, ribbonMat)
        mesh.renderOrder = -1
        world.add(mesh)
        ribbons.set(key, { mesh, n })
      }
    }
  }

  /** colour, size and alpha for everyone, from their state and the hover */
  function paint() {
    const size = geo.getAttribute('aSize') as THREE.BufferAttribute
    const alpha = geo.getAttribute('aAlpha') as THREE.BufferAttribute
    const col = geo.getAttribute('aColor') as THREE.BufferAttribute
    const hsize = halo.getAttribute('aSize') as THREE.BufferAttribute
    const focus = hovered >= 0
    for (let i = 0; i < people.length; i++) {
      const c = active[i] ? C.active : paid[i] ? C.paid : C.person
      col.setXYZ(i, c.r, c.g, c.b)
      const shown = hub[i]! >= 0
      size.setX(i, !shown ? 0 : i === hovered ? 7 : active[i] ? 4.4 : paid[i] ? 3.8 : 3.2)
      let a = !shown ? 0 : active[i] ? 1 : stale[i] ? 0.26 : paid[i] ? 0.95 : 0.7
      if (focus && i !== hovered) a *= 0.3
      alpha.setX(i, a)
      hsize.setX(i, shown && active[i] && (!focus || i === hovered) ? 15 : 0)
    }
    size.needsUpdate = alpha.needsUpdate = col.needsUpdate = hsize.needsUpdate = true
    ribbonMat.opacity = focus ? 0.07 : 0.16
  }

  // ---------------------------------------------------------------- labels ----
  const hubLabels = STEPS.map((s, i) => {
    const el = document.createElement('div')
    el.className = 'usr-hub'
    el.dataset.step = s.id
    el.innerHTML = `<span class="usr-hub-conv"></span><b></b><span class="usr-hub-name">${s.label}</span><span class="usr-hub-sub"></span>`
    labels.appendChild(el)
    return {
      el,
      n: el.querySelector('b') as HTMLElement,
      sub: el.querySelector('.usr-hub-sub') as HTMLElement,
      i,
    }
  })

  function labelText() {
    for (const L of hubLabels) {
      const s = stats[L.i]!
      const counted = s.counted
      L.el.classList.toggle('counted', !!counted && s.reached === 0)
      if (counted && s.reached === 0) {
        L.n.textContent = counted.n.toLocaleString()
        L.sub.textContent = counted.note
      } else if (s.reached === 0 && feed?.mode === 'real') {
        L.n.textContent = '—'
        L.sub.textContent = 'no data yet'
      } else {
        L.n.textContent = s.reached.toLocaleString()
        const bits = [`${s.here.toLocaleString()} here`]
        if (s.active)
          bits.push(`<i>${s.active} ${feed?.activeGrain === 'day' ? 'today' : 'active'}</i>`)
        L.sub.innerHTML = bits.join(' · ')
      }
      // how many of the step before came on to this one. The free path means more can open the
      // app than activated a licence, so say where the extra came from rather than print 140%.
      const prev = L.i > 0 ? stats[L.i - 1]! : null
      const conv = L.el.querySelector('.usr-hub-conv') as HTMLElement
      conv.textContent =
        prev?.reached && s.reached
          ? s.reached > prev.reached
            ? `+${(s.reached - prev.reached).toLocaleString()} on the free path`
            : `${Math.round((s.reached / prev.reached) * 100)}% of ${STEPS[L.i - 1]!.short.toLowerCase()}`
          : ''
    }
  }

  const scratch = new THREE.Vector3()
  function place(el: HTMLElement, p: THREE.Vector3, w: number, h: number) {
    scratch.copy(p).applyMatrix4(world.matrixWorld).project(camera)
    const hidden = scratch.z > 1
    el.style.transform = `translate(${((scratch.x + 1) / 2) * w}px, ${((1 - scratch.y) / 2) * h}px)`
    el.style.visibility = hidden ? 'hidden' : ''
  }
  function placeLabels(w: number, h: number) {
    for (const L of hubLabels)
      place(L.el, scratch.set(0, -radius[L.i]! * 0.42 - 8, radius[L.i]!).add(HUB[L.i]!), w, h)
  }

  // ---------------------------------------------------------------- camera ----
  const HOME = { theta: 0, phi: 0.54, radius: 640 }
  const cam = { ...HOME }
  const want = { ...HOME }
  let fitRadius = 640
  /** the middle of the hubs' bounding box: what the camera looks at */
  const target = new THREE.Vector3()
  const hubBox = new THREE.Box3().setFromPoints(HUB)
  let dragging = false
  let lastX = 0
  let lastY = 0
  let pointer: { x: number; y: number } | null = null
  let needPick = false

  const settled = () =>
    Math.abs(want.theta - cam.theta) < 1e-4 &&
    Math.abs(want.phi - cam.phi) < 1e-4 &&
    Math.abs(want.radius - cam.radius) < 0.05

  // --------------------------------------------------------------- the loop ----
  let level: Level = 'hidden'
  let raf = 0
  let timer = 0
  let dirty = true
  let lastFrame = 0
  let moving = false
  let w = 1
  let h = 1

  function ensureRenderer() {
    if (renderer) return renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    renderer.setClearColor(C.bg, 1)
    renderer.domElement.className = 'usr-canvas'
    host.prepend(renderer.domElement)
    bindPointer(renderer.domElement)
    resize()
    return renderer
  }

  /** ask for a frame at the pace the level allows; nothing at all while hidden */
  function wake() {
    dirty = true
    schedule()
  }
  function schedule() {
    if (raf || timer || level === 'hidden') return
    if (!dirty && !moving) return
    const gap = level === 'live' || dragging ? 0 : level === 'idle' ? AMBIENT_MS : AWAY_MS
    const wait = gap - (performance.now() - lastFrame)
    if (wait <= 4) raf = requestAnimationFrame(frame)
    else
      timer = window.setTimeout(() => {
        timer = 0
        raf = requestAnimationFrame(frame)
      }, wait)
  }

  function frame(now: number) {
    raf = 0
    if (level === 'hidden' || !renderer) return
    const dt = Math.min(100, now - (lastFrame || now))
    lastFrame = now
    const k = 1 - Math.exp(-dt / EASE)
    cam.theta += (want.theta - cam.theta) * k
    cam.phi += (want.phi - cam.phi) * k
    cam.radius += (want.radius - cam.radius) * k
    const sp = Math.sin(cam.phi)
    camera.position.set(
      target.x + sp * Math.sin(cam.theta) * cam.radius,
      target.y + Math.cos(cam.phi) * cam.radius,
      target.z + sp * Math.cos(cam.theta) * cam.radius,
    )
    camera.lookAt(target)
    let still = settled()

    for (let i = 0; i < HUB.length; i++) {
      radius[i] = radius[i]! + (radiusWant[i]! - radius[i]!) * (1 - Math.exp(-dt / SETTLE_MS))
      if (Math.abs(radiusWant[i]! - radius[i]!) > 0.02) still = false
      rings[i]!.scale.setScalar(radius[i]! * 1.18)
    }

    const v = new THREE.Vector3()
    const settle = 1 - Math.exp(-dt / SETTLE_MS)
    let maxMove = 0
    for (let i = 0; i < people.length; i++) {
      if (hub[i]! < 0) continue
      const o = i * 3
      if (tStart[i]!) {
        const u = (now - tStart[i]!) / TRANSIT_MS
        if (u >= 1) {
          tStart[i] = 0
          transits--
        } else {
          curveFor(i).getPoint(ease(Math.max(0, u)), v)
          pos[o] = v.x
          pos[o + 1] = v.y
          pos[o + 2] = v.z
          maxMove = 1
          continue
        }
      }
      targetOf(i, v)
      const dx = v.x - pos[o]!
      const dy = v.y - pos[o + 1]!
      const dz = v.z - pos[o + 2]!
      const d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz)
      if (d < 0.01) continue
      maxMove = Math.max(maxMove, d)
      pos[o] = v.x - dx * (1 - settle)
      pos[o + 1] = v.y - dy * (1 - settle)
      pos[o + 2] = v.z - dz * (1 - settle)
    }
    ;(geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    if (maxMove > 0.02 || transits > 0) still = false

    if (needPick && pointer && !dragging) pick()
    needPick = false
    placeLabels(w, h)
    renderer.render(scene, camera)
    dirty = false
    moving = !still
    schedule()
  }

  // ---------------------------------------------------------------- picking ----
  function pick() {
    if (!pointer) return
    const { x, y } = pointer
    let best = -1
    let bestD = 12 * 12
    for (let i = 0; i < people.length; i++) {
      if (hub[i]! < 0) continue
      scratch
        .set(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!)
        .applyMatrix4(world.matrixWorld)
        .project(camera)
      const dx = ((scratch.x + 1) / 2) * w - x
      const dy = ((1 - scratch.y) / 2) * h - y
      const d = dx * dx + dy * dy
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    let hubHit = -1
    if (best < 0)
      for (let i = 0; i < HUB.length; i++) {
        scratch.copy(HUB[i]!).applyMatrix4(world.matrixWorld).project(camera)
        const dx = ((scratch.x + 1) / 2) * w - x
        const dy = ((1 - scratch.y) / 2) * h - y
        if (dx * dx + dy * dy < 22 * 22) hubHit = i
      }
    if (best !== hovered) {
      hovered = best
      paint()
      drawPath()
      dirty = true
    }
    if (best >= 0) on.hover({ kind: 'person', person: people[best]!, x, y })
    else if (hubHit >= 0) on.hover({ kind: 'hub', step: STEPS[hubHit]!.id, x, y })
    else on.hover(null)
  }

  /** the hovered person's whole journey, as one bright line through the hubs they passed */
  function drawPath() {
    if (pathLine) {
      world.remove(pathLine)
      pathLine.geometry.dispose()
      pathLine = null
    }
    if (hovered < 0) return
    const seq = stepsAt(people[hovered]!, T).map((s) => STEP_INDEX[s])
    if (!seq.length) return
    const pts: THREE.Vector3[] = [
      ...curveBetween(spawnOf(hovered), HUB[seq[0]!]!, `spawn-${hovered}>${seq[0]!}`).getPoints(24),
    ]
    for (let k = 1; k < seq.length; k++) pts.push(...hubCurve(seq[k - 1]!, seq[k]!).getPoints(32))
    pts.push(new THREE.Vector3(pos[hovered * 3]!, pos[hovered * 3 + 1]!, pos[hovered * 3 + 2]!))
    pathLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), pathMat)
    world.add(pathLine)
  }

  function bindPointer(el: HTMLCanvasElement) {
    el.addEventListener('pointerdown', (e) => {
      dragging = true
      lastX = e.clientX
      lastY = e.clientY
      try {
        el.setPointerCapture(e.pointerId)
      } catch {}
    })
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect()
      pointer = { x: e.clientX - r.left, y: e.clientY - r.top }
      needPick = true
      if (dragging) {
        want.theta = Math.max(-0.9, Math.min(0.9, want.theta - (e.clientX - lastX) * 0.004))
        want.phi = Math.max(0.35, Math.min(1.45, want.phi - (e.clientY - lastY) * 0.004))
        lastX = e.clientX
        lastY = e.clientY
      }
      wake()
    })
    const end = () => {
      dragging = false
    }
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
    el.addEventListener('pointerleave', () => {
      pointer = null
      if (hovered >= 0) {
        hovered = -1
        paint()
        drawPath()
      }
      on.hover(null)
      wake()
    })
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        want.radius = Math.max(
          fitRadius * 0.35,
          Math.min(fitRadius * 1.6, want.radius * Math.exp(e.deltaY * 0.0012)),
        )
        wake()
      },
      { passive: false },
    )
    el.addEventListener('dblclick', () => {
      Object.assign(want, HOME, { radius: fitRadius })
      wake()
    })
  }

  /**
   * The nearest camera distance, at the home angle, that keeps every hub, its cluster and its
   * label inside the frame with a margin: whatever the panel's shape, the network fills it.
   */
  function fitDistance() {
    const probe = new THREE.PerspectiveCamera(FOV, camera.aspect, 1, 5000)
    const pad = HUB.flatMap((p) => [
      p.clone().add(new THREE.Vector3(-70, 0, 0)),
      p.clone().add(new THREE.Vector3(70, 0, 0)),
      p.clone().add(new THREE.Vector3(0, 0, 60)),
      p.clone().add(new THREE.Vector3(0, 0, -50)),
    ])
    const fits = (r: number) => {
      const sp = Math.sin(HOME.phi)
      probe.position.set(
        target.x + sp * Math.sin(HOME.theta) * r,
        target.y + Math.cos(HOME.phi) * r,
        target.z + sp * Math.cos(HOME.theta) * r,
      )
      probe.lookAt(target)
      probe.updateMatrixWorld()
      // labels hang below each hub, so leave more room at the bottom than the top
      return pad.every((p) => {
        const q = p.clone().applyMatrix4(world.matrixWorld).project(probe)
        return Math.abs(q.x) < 0.9 && q.y < 0.82 && q.y > -0.7
      })
    }
    let lo = 150
    let hi = 4000
    for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) / 2
      if (fits(mid)) hi = mid
      else lo = mid
    }
    return hi
  }

  function resize() {
    // the dock animates its width; measure once it settles (panels.ts fires laika:panels-settled)
    if (document.body.classList.contains('pnl-anim')) return
    const r = host.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return
    w = r.width
    h = r.height
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    const tanV = Math.tan(((FOV / 2) * Math.PI) / 180)
    world.scale.z = Math.max(1, Math.min(2, 1.3 / camera.aspect))
    world.updateMatrixWorld(true)
    hubBox.getCenter(target).applyMatrix4(world.matrixWorld)
    const prev = fitRadius
    fitRadius = fitDistance()
    want.radius *= fitRadius / prev
    cam.radius *= fitRadius / prev
    const scale = (h * Math.min(devicePixelRatio, 2)) / (2 * tanV)
    for (const m of [mat, haloMat, hubMat]) m.uniforms.uScale!.value = scale
    if (renderer) renderer.setSize(w, h)
    wake()
  }

  return {
    setData(f: Feed, t: number) {
      feed = f
      people = f.people
      off = people.map((p) => offsetFor(p.id))
      alloc(people.length)
      transits = 0
      hovered = -1
      drawPath()
      for (const k of [...curveCache.keys()]) if (k.startsWith('spawn-')) curveCache.delete(k)
      setTime(t, false, true)
    },
    setTime,
    stats: () => stats,
    /** the level decides the pace; hidden stops the loop outright */
    setLevel(l: Level) {
      level = l
      if (l === 'hidden') {
        cancelAnimationFrame(raf)
        clearTimeout(timer)
        raf = timer = 0
        return
      }
      ensureRenderer()
      wake()
    },
    resize,
    /** free the GPU context; the next show makes a new one from the same scene */
    releaseGPU() {
      if (!renderer || level !== 'hidden') return
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
      renderer = null
    },
    hasGPU: () => !!renderer,
    dispose() {
      level = 'hidden'
      cancelAnimationFrame(raf)
      clearTimeout(timer)
      renderer?.dispose()
      renderer?.forceContextLoss()
      renderer?.domElement.remove()
      renderer = null
      geo.dispose()
      halo.dispose()
      hubGeo.dispose()
      ringGeo.dispose()
      for (const r of ribbons.values()) r.mesh.geometry.dispose()
      labels.remove()
    },
  }
}
export type UsersScene = ReturnType<typeof createUsersScene>
