import * as THREE from 'three'
import './jarvis.css'

/**
 * JARVIS layer — the holographic HUD dressing around the ARMS ring.
 *
 * Everything that moves is line geometry spun by an object rotation, so the per-frame
 * cost is a handful of matrix updates and a few thin draw calls. There is no filled
 * geometry; the hex grid already costs about 5 fps headless covering the disc.
 *
 * A rotating radar sweep (wedge, beam and a wake on the nodes) was built and then
 * removed at Joe's request.
 *
 * Off with `J` (remembered). Motion stops under prefers-reduced-motion.
 */

const CYAN = 0x56d8ff
const TAU = Math.PI * 2
const PULSE_EVERY = 6 // s between core pulses

export type JarvisRadii = {
  skills: number
  disc: number
  routines: number
  apps: number
}

export type JarvisFrame = {
  now: number
  camera: THREE.Camera
  rect: DOMRect
  /** the committed or hovered node, in world space */
  focus: THREE.Vector3 | null
  committed: boolean
  focusLinks: number
  nodes: number
  links: number
  groups: number
}

const lineMat = (opacity: number) =>
  new THREE.LineBasicMaterial({
    color: CYAN,
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  })

/** Push a flat arc (in XZ) into a segment list as consecutive line pairs. */
function arc(out: number[], r: number, a0: number, a1: number, step = 0.02) {
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / step))
  for (let k = 0; k < n; k++) {
    const p = a0 + ((a1 - a0) * k) / n
    const q = a0 + ((a1 - a0) * (k + 1)) / n
    out.push(Math.cos(p) * r, 0, Math.sin(p) * r, Math.cos(q) * r, 0, Math.sin(q) * r)
  }
}

/** A radial tick from r0 to r1 at angle a. */
function tick(out: number[], a: number, r0: number, r1: number) {
  const c = Math.cos(a)
  const s = Math.sin(a)
  out.push(c * r0, 0, s * r0, c * r1, 0, s * r1)
}

function segments(pts: number[], opacity: number) {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  const obj = new THREE.LineSegments(geo, lineMat(opacity))
  obj.frustumCulled = false
  obj.renderOrder = -5 // above the disc (-10), below the nodes
  return obj
}

export function createJarvis(scene: THREE.Scene, stage: HTMLElement) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')
  let enabled = true
  try {
    enabled = localStorage.getItem('jarvis') !== 'off'
  } catch {
    // storage can be unavailable (private mode); the default stands
  }
  let active = false
  let groups: THREE.Object3D[] = []
  let spinners: { obj: THREE.Object3D; speed: number }[] = []
  let pulse: THREE.LineLoop | null = null
  let radii: JarvisRadii | null = null
  let last = performance.now()

  // --- DOM: stage corner brackets, readouts and the lock-on reticle ---------------
  const hud = document.createElement('div')
  hud.id = 'jv'
  hud.innerHTML = `
    <i class="jv-c tl"></i><i class="jv-c tr"></i><i class="jv-c bl"></i><i class="jv-c br"></i>
    <div class="jv-read bl"><b class="jv-dot"></b><span>LIVE</span><span class="jv-sub" id="jv-groups">— GROUPS</span></div>
    <div class="jv-read br"><span id="jv-count">— NODES</span><span class="jv-sub" id="jv-focus">NO LOCK</span></div>
    <div class="jv-lock" id="jv-lock">
      <svg viewBox="-50 -50 100 100" aria-hidden="true">
        <g class="jv-spin"><path d="M-34 -14 A36 36 0 0 1 -14 -34 M14 -34 A36 36 0 0 1 34 -14 M34 14 A36 36 0 0 1 14 34 M-14 34 A36 36 0 0 1 -34 14"/></g>
        <g class="jv-spin rev"><circle r="27" pathLength="100" stroke-dasharray="6 6.5"/></g>
        <path class="jv-x" d="M-46 0H-38M38 0H46M0 -46V-38M0 38V46"/>
      </svg>
      <em id="jv-lock-t">TRACK</em>
    </div>`
  stage.appendChild(hud)
  const groupsEl = hud.querySelector('#jv-groups') as HTMLElement
  const countEl = hud.querySelector('#jv-count') as HTMLElement
  const focusEl = hud.querySelector('#jv-focus') as HTMLElement
  const lock = hud.querySelector('#jv-lock') as HTMLElement
  const lockT = hud.querySelector('#jv-lock-t') as HTMLElement

  function clear() {
    for (const o of groups) {
      scene.remove(o)
      const m = o as THREE.LineSegments
      m.geometry.dispose()
      ;(m.material as THREE.Material).dispose()
    }
    groups = []
    spinners = []
    pulse = null
  }

  function applyVisibility() {
    const on = enabled && active
    for (const o of groups) o.visible = on
    hud.style.display = on ? '' : 'none'
  }

  function build(r: JarvisRadii) {
    // build() in main runs on every filter/highlight change; rebuilding here each time would
    // snap every spinning ring back to zero, so only rebuild when the geometry changes
    if (
      radii &&
      groups.length &&
      radii.skills === r.skills &&
      radii.disc === r.disc &&
      radii.routines === r.routines &&
      radii.apps === r.apps
    ) {
      applyVisibility()
      return
    }
    clear()
    radii = r
    const add = (obj: THREE.Object3D, speed = 0) => {
      scene.add(obj)
      groups.push(obj)
      if (speed) spinners.push({ obj, speed })
    }

    // 1 · bezel: a compass of ticks just outside the application ring
    const bez: number[] = []
    const b0 = r.apps + 26
    for (let d = 0; d < 360; d += 2) {
      const a = (d * Math.PI) / 180
      const len = d % 30 === 0 ? 17 : d % 10 === 0 ? 10 : 4
      tick(bez, a, b0, b0 + len)
    }
    add(segments(bez, 0.22), -0.018)

    // 2 · outer segmented arcs, counter-rotating against the bezel
    const outer: number[] = []
    const o0 = r.apps + 50
    for (const [s, e] of [
      [0.1, 1.85],
      [2.25, 3.3],
      [3.7, 4.4],
      [4.9, 5.95],
    ] as const) {
      arc(outer, o0, s, e)
      tick(outer, s, o0 - 6, o0 + 6) // end caps
      tick(outer, e, o0 - 6, o0 + 6)
    }
    add(segments(outer, 0.3), 0.055)

    // 3 · fine dashes in the gap between the routines and application rings
    const dash: number[] = []
    const d0 = (r.routines + r.apps) / 2
    for (let a = 0; a < TAU; a += 0.105) arc(dash, d0, a, a + 0.045, 0.045)
    add(segments(dash, 0.14), -0.03)

    // 4 · the disc edge: two long arcs with a scale of short ticks on the inside
    const edge: number[] = []
    const e0 = r.disc + 10
    arc(edge, e0, 0.3, 2.6)
    arc(edge, e0, 3.45, 5.75)
    for (let a = 0.3; a < 2.6; a += 0.06) tick(edge, a, e0 - 5, e0)
    add(segments(edge, 0.26), 0.09)

    // 5 · the reactor: fast, tight arcs around the root, just inside the skills ring
    const core: number[] = []
    const c0 = r.skills * 0.62
    for (let k = 0; k < 3; k++) arc(core, c0, (k * TAU) / 3, (k * TAU) / 3 + 1.4)
    const core2: number[] = []
    for (let k = 0; k < 6; k++) arc(core2, c0 - 9, (k * TAU) / 6, (k * TAU) / 6 + 0.55)
    add(segments(core, 0.5), 0.6)
    add(segments(core2, 0.32), -0.9)

    // 6 · a pulse that leaves the core and fades at the disc edge
    const pp: number[] = []
    for (let k = 0; k < 96; k++) {
      const a = (k / 96) * TAU
      pp.push(Math.cos(a), 0, Math.sin(a))
    }
    const pg = new THREE.BufferGeometry()
    pg.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3))
    pulse = new THREE.LineLoop(pg, lineMat(0))
    pulse.frustumCulled = false
    pulse.renderOrder = -5
    add(pulse)

    applyVisibility()
  }

  function toggle(force?: boolean) {
    enabled = force ?? !enabled
    try {
      localStorage.setItem('jarvis', enabled ? 'on' : 'off')
    } catch {
      // not persisted; the toggle still applies for this session
    }
    applyVisibility()
  }

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if ((e.target as HTMLElement).closest?.('input, textarea, select, #bw')) return
    if (e.key === 'j' || e.key === 'J') toggle()
  })

  function update(f: JarvisFrame) {
    const dt = Math.min(0.1, (f.now - last) / 1000)
    last = f.now
    if (!(enabled && active) || !radii) return
    const still = reduce.matches
    const k = still ? 0 : dt
    for (const s of spinners) s.obj.rotation.y += s.speed * k

    // the layer quietens while something is focused, so the HUD never competes with the
    // lit subgraph
    for (const o of groups) {
      if (o === pulse) continue
      const m = (o as THREE.LineSegments).material as THREE.LineBasicMaterial
      m.userData.base ??= m.opacity
      m.opacity = (m.userData.base as number) * (f.focus ? 0.45 : 1)
    }

    if (pulse) {
      const t = ((f.now / 1000) % PULSE_EVERY) / PULSE_EVERY
      pulse.scale.setScalar(radii.skills + t * (radii.disc - radii.skills))
      ;(pulse.material as THREE.LineBasicMaterial).opacity = still
        ? 0
        : 0.45 * (1 - t) ** 1.6 * (f.focus ? 0.4 : 1)
    }

    groupsEl.textContent = `${f.groups} GROUPS · 4 RINGS`
    countEl.textContent = `${f.nodes.toLocaleString()} NODES · ${f.links.toLocaleString()} LINKS`
    focusEl.textContent = f.focus
      ? `${f.committed ? 'LOCKED' : 'TRACKING'} · ${f.focusLinks} LINKS`
      : 'NO LOCK'

    // lock-on reticle over the focused node
    const v = f.focus?.clone().project(f.camera)
    if (v && v.z < 1) {
      lock.style.display = 'block'
      lock.style.left = `${((v.x + 1) / 2) * f.rect.width}px`
      lock.style.top = `${((1 - v.y) / 2) * f.rect.height}px`
      lock.classList.toggle('on', f.committed)
      lockT.textContent = f.committed ? 'LOCKED' : 'TRACK'
    } else {
      lock.style.display = 'none'
    }
  }

  return {
    /** Rebuild for new radii; call on each layout. */
    build,
    /** Show only in layouts that have the ring. */
    setActive(on: boolean) {
      active = on
      applyVisibility()
    },
    update,
    toggle,
  }
}
