import * as THREE from 'three'
import './core.css'

/**
 * The centrepiece: what sits at the heart of the ARMS ring.
 *
 * At rest it is an identity — the root router as a badge, and the skills as a band of
 * four-point stars around it (the stars themselves are skill nodes, shaped in the node
 * shader; this module draws the band's guide rows and the badge).
 *
 * On a question it shows the engine working, which nothing else on screen does: the
 * query's tokens leave the core, beams run to every candidate file with brightness set
 * by its score, the losers fade while the winner's beam flares, and a second beam
 * follows the one pointer hop. Then the core reads out what that cost — milliseconds,
 * bytes read, and zero model calls, because recall never calls one.
 */

const ORANGE = 0xff8a4c
const CYAN = 0x56d8ff
const SEG = 28 // segments per beam

export type CoreRecall = {
  tokens: string[]
  /** candidate files, best first; relative is 0–1 against the winner */
  cands: { world: THREE.Vector3; relative: number }[]
  /** the followed pointer, if recall hopped */
  hop: { from: THREE.Vector3; to: THREE.Vector3 } | null
  ms: number
  bytes: number
  noMatch: boolean
}

export type CoreFrame = {
  now: number
  camera: THREE.Camera
  rect: DOMRect
  /** something is focused elsewhere; the core stays quiet */
  focused: boolean
}

const BEAM_VS = `
attribute float aT;       // 0 at the core, 1 at the file
attribute float aBeam;    // beam index, 0 = winner
attribute float aPower;   // relative score
uniform float uProg, uSettle, uHop;
varying float vA; varying float vT; varying float vWin;
void main(){
  // beams leave together but reach their files in score order, the winner first
  float lag = aBeam * 0.05;
  float head = clamp((uProg - lag) * 1.35, 0.0, 1.0);
  float lit = step(aT, head);
  // after arrival the losers fade and the winner holds
  float win = step(aBeam, 0.5);
  float keep = mix(1.0 - uSettle * 0.85, 1.0, win);
  float hot = smoothstep(head - 0.18, head, aT) * (1.0 - step(0.999, head)); // travelling tip
  vA = lit * keep * (0.25 + 0.75 * aPower) + hot * 0.9;
  vT = aT; vWin = win;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`
const BEAM_FS = `
precision highp float;
uniform vec3 uCol, uWin;
uniform float uSettle;
varying float vA; varying float vT; varying float vWin;
void main(){
  vec3 c = mix(uCol, uWin, vWin * uSettle);
  gl_FragColor = vec4(c * vA, vA);
}`

/** Bow a beam away from the straight line so overlapping ones separate. */
function curve(out: number[], ts: number[], a: THREE.Vector3, b: THREE.Vector3, bow: number) {
  const mid = a.clone().add(b).multiplyScalar(0.5)
  const d = b.clone().sub(a)
  // perpendicular in the ground plane
  const ctl = mid.add(new THREE.Vector3(-d.z, 0, d.x).multiplyScalar(bow))
  let px = a.x
  let pz = a.z
  for (let k = 1; k <= SEG; k++) {
    const u = k / SEG
    const iu = 1 - u
    const x = iu * iu * a.x + 2 * iu * u * ctl.x + u * u * b.x
    const z = iu * iu * a.z + 2 * iu * u * ctl.z + u * u * b.z
    out.push(px, 0, pz, x, 0, z)
    ts.push((k - 1) / SEG, u)
    px = x
    pz = z
  }
}

export function createCore(scene: THREE.Scene, stage: HTMLElement) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')
  let active = false
  let rootWorld: THREE.Vector3 | null = null
  let guides: THREE.Points | null = null
  let beams: THREE.LineSegments | null = null
  let hopBeam: THREE.LineSegments | null = null
  let started = 0
  let skillCount = 0
  const U = {
    uProg: { value: 0 },
    uSettle: { value: 0 },
    uHop: { value: 0 },
    uCol: { value: new THREE.Color(CYAN) },
    uWin: { value: new THREE.Color(ORANGE) },
  }
  const HU = {
    uProg: { value: 0 },
    uSettle: { value: 0 },
    uHop: { value: 0 },
    uCol: { value: new THREE.Color(ORANGE) },
    uWin: { value: new THREE.Color(ORANGE) },
  }

  // --- DOM: the root badge, the token burst, the readout --------------------------
  const el = document.createElement('div')
  el.id = 'core'
  // An original pixel mark — a small brain — on a dark disc with an orange rim, after the
  // reference's root badge.
  const PIX = [
    '.XXX.XXX.',
    'XX.XXX.XX',
    'X.XX.XX.X',
    'XXX.X.XXX',
    'X.XXXXX.X',
    '.XX.X.XX.',
    '..XXXXX..',
  ]
  const px = PIX.flatMap((row, y) =>
    [...row].map((ch, x) => (ch === 'X' ? `<rect x="${x}" y="${y}" width="1" height="1"/>` : '')),
  ).join('')
  el.innerHTML = `
    <div class="core-badge"><svg viewBox="-1 -1.5 11 10" aria-hidden="true">${px}</svg></div>
    <div class="core-burst"></div>
    <div class="core-read"><b id="core-read-a">READY</b><span id="core-read-b"></span><span id="core-read-c"></span></div>`
  stage.appendChild(el)
  const badge = el.querySelector('.core-badge') as HTMLElement
  const burst = el.querySelector('.core-burst') as HTMLElement
  const readA = el.querySelector('#core-read-a') as HTMLElement
  const readB = el.querySelector('#core-read-b') as HTMLElement
  const readC = el.querySelector('#core-read-c') as HTMLElement
  const read = el.querySelector('.core-read') as HTMLElement

  function dispose(o: THREE.Object3D | null) {
    if (!o) return
    scene.remove(o)
    const m = o as THREE.Mesh
    m.geometry.dispose()
    ;(m.material as THREE.Material).dispose()
  }

  // Three short lines rather than two long ones: the readout sits inside the ring of
  // department dots, and a 230px line ran across them.
  function idleReadout() {
    readA.textContent = 'READY'
    readB.textContent = `${skillCount} SKILL${skillCount === 1 ? '' : 'S'}`
    readC.textContent = '0 MODEL CALLS'
  }

  /** Set up the resting state for a layout. */
  function build(o: { root: THREE.Vector3 | null; skills: number; band: [number, number] }) {
    rootWorld = o.root
    skillCount = o.skills
    dispose(guides)
    // the skills band's guide rows: two faint dotted circles marking its inner and outer
    // edge. Structure only — the stars on it are the real skills.
    const pts: number[] = []
    for (const r of o.band) {
      const n = Math.round((r * Math.PI * 2) / 9)
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2
        pts.push(Math.cos(a) * r, 0, Math.sin(a) * r)
      }
    }
    const gg = new THREE.BufferGeometry()
    gg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    guides = new THREE.Points(
      gg,
      new THREE.PointsMaterial({
        color: ORANGE,
        size: 2.2,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        depthTest: false,
      }),
    )
    guides.renderOrder = -4
    guides.frustumCulled = false
    scene.add(guides)
    if (!started) idleReadout()
    apply()
  }

  function apply() {
    if (guides) guides.visible = active
    if (beams) beams.visible = active
    if (hopBeam) hopBeam.visible = active
    el.style.display = active ? '' : 'none'
  }

  function beamMesh(pos: number[], ts: number[], beam: number[], power: number[], u: typeof U) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('aT', new THREE.Float32BufferAttribute(ts, 1))
    geo.setAttribute('aBeam', new THREE.Float32BufferAttribute(beam, 1))
    geo.setAttribute('aPower', new THREE.Float32BufferAttribute(power, 1))
    const m = new THREE.LineSegments(
      geo,
      new THREE.ShaderMaterial({
        uniforms: u,
        vertexShader: BEAM_VS,
        fragmentShader: BEAM_FS,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    )
    m.frustumCulled = false
    m.renderOrder = 4
    scene.add(m)
    return m
  }

  /** Play one recall through the core. */
  function recall(r: CoreRecall) {
    if (!rootWorld) return
    dispose(beams)
    dispose(hopBeam)
    beams = null
    hopBeam = null
    const origin = rootWorld
    const pos: number[] = []
    const ts: number[] = []
    const beam: number[] = []
    const power: number[] = []
    r.cands.slice(0, 12).forEach((c, i) => {
      const before = ts.length
      curve(pos, ts, origin, c.world, (i % 2 ? 1 : -1) * 0.08)
      for (let k = before; k < ts.length; k++) {
        beam.push(i)
        power.push(Math.max(0.15, c.relative))
      }
    })
    if (pos.length) beams = beamMesh(pos, ts, beam, power, U)
    if (r.hop) {
      const hp: number[] = []
      const ht: number[] = []
      curve(hp, ht, r.hop.from, r.hop.to, 0.18)
      hopBeam = beamMesh(
        hp,
        ht,
        ht.map(() => 0),
        ht.map(() => 1),
        HU,
      )
    }

    // tokens leave the core as chips
    burst.innerHTML = r.tokens
      .slice(0, 8)
      .map((t, i, all) => {
        const a = (i / Math.max(1, all.length)) * 360 - 90
        return `<i style="--a:${a}deg;--d:${(i * 0.04).toFixed(2)}s">${t.replace(/[<>&]/g, '')}</i>`
      })
      .join('')
    burst.classList.remove('go')
    void burst.offsetWidth // restart the CSS animation
    burst.classList.add('go')
    badge.classList.remove('pulse')
    void badge.offsetWidth
    badge.classList.add('pulse')

    readA.textContent = r.noMatch ? 'NO MATCH' : 'RECALLING'
    readB.textContent = ''
    readC.textContent = ''
    started = performance.now()
    pending = r
    apply()
  }
  let pending: CoreRecall | null = null

  function update(f: CoreFrame) {
    if (!active) return
    // badge and readout follow the root on screen
    if (rootWorld) {
      const v = rootWorld.clone().project(f.camera)
      const x = ((v.x + 1) / 2) * f.rect.width
      const y = ((1 - v.y) / 2) * f.rect.height
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
    }
    el.classList.toggle('quiet', f.focused)

    if (!started) return
    const t = (f.now - started) / 1000
    const fast = reduce.matches
    // 0–1.0 s: beams travel · 1.0–1.5 s: losers fade, winner flares · 1.3–1.9 s: hop
    U.uProg.value = fast ? 1 : Math.min(1, t / 1.0)
    U.uSettle.value = fast ? 1 : Math.min(1, Math.max(0, (t - 1.0) / 0.5))
    HU.uProg.value = fast ? 1 : Math.min(1, Math.max(0, (t - 1.3) / 0.6))
    if (pending && (fast || t > 1.5)) {
      const r = pending
      pending = null
      const n = r.cands.length
      readA.textContent = r.noMatch
        ? 'NO MATCH'
        : `${r.ms < 10 ? r.ms.toFixed(2) : r.ms.toFixed(0)} MS`
      readB.textContent = r.noMatch ? 'NOT GUESSED' : '0 MODEL CALLS'
      readC.textContent = r.noMatch
        ? ''
        : `${n} FILE${n === 1 ? '' : 'S'}${r.hop ? ' · 1 HOP' : ''}`
      read.classList.remove('flash')
      void read.offsetWidth
      read.classList.add('flash')
    }
    // beams fade out after a while; the readout stays as "last recall"
    const fade = fast ? 1 : Math.max(0, 1 - Math.max(0, t - 9) / 2)
    for (const m of [beams, hopBeam]) {
      if (m) m.visible = active && fade > 0
    }
    U.uCol.value.setHex(CYAN).multiplyScalar(fade)
    U.uWin.value.setHex(ORANGE).multiplyScalar(fade)
    HU.uCol.value.setHex(ORANGE).multiplyScalar(fade)
    HU.uWin.value.setHex(ORANGE).multiplyScalar(fade)
  }

  /** Drop the recall visuals (e.g. when the results panel closes). */
  function clear() {
    dispose(beams)
    dispose(hopBeam)
    beams = null
    hopBeam = null
    burst.innerHTML = ''
  }

  return {
    build,
    recall,
    update,
    clear,
    setActive(on: boolean) {
      active = on
      apply()
    },
  }
}
