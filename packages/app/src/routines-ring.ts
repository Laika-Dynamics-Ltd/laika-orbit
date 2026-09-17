import * as THREE from 'three'
import './routines-ring.css'

/**
 * The ROUTINES ring as a 24-hour dial.
 *
 * Routines are scheduled jobs, not files, so the ring places them by time of day:
 * 00:00 at 12 o'clock, running clockwise. Each marker is a hollow gold circle with a
 * centre dot (after the reference) whose state follows the job — fired ones dim, the next
 * one pulses, queued ones hold. A cyan hand marks the time now.
 *
 * Before this the ring carried the brain/widgets JSON files, which are data, not routines.
 */

export type RoutineItem = { id: string; title: string; at: string; status: string; via: string }

const TAU = Math.PI * 2
const esc = (s: string) => s.replace(/[<>&"]/g, (m) => `&#${m.charCodeAt(0)};`)

/** "09:30" → 9.5; anything unparseable → null */
export function hoursOf(at: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(at.trim())
  if (!m) return null
  const h = Number(m[1]) + Number(m[2]) / 60
  return h >= 0 && h < 24 ? h : null
}

export function createRoutinesRing(scene: THREE.Scene, stage: HTMLElement) {
  let active = false
  let radius = 425
  let top = Math.PI
  let items: { r: RoutineItem; world: THREE.Vector3 }[] = []
  let ticks: THREE.Points | null = null
  const hourLabels: { text: string; world: THREE.Vector3 }[] = []
  const nowWorld = new THREE.Vector3()

  const el = document.createElement('div')
  el.id = 'rt'
  stage.appendChild(el)

  /** world position of a time of day on the dial */
  const at = (h: number, r: number) => {
    const a = top + (h / 24) * TAU
    return new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)
  }

  function build(o: { routines: RoutineItem[]; radius: number; top: number }) {
    radius = o.radius
    top = o.top
    items = o.routines.flatMap((r) => {
      const h = hoursOf(r.at)
      return h === null ? [] : [{ r, world: at(h, radius) }]
    })

    // hour ticks: 24 small dots, with 00/06/12/18 heavier
    if (ticks) {
      scene.remove(ticks)
      ticks.geometry.dispose()
      ;(ticks.material as THREE.Material).dispose()
    }
    const pts: number[] = []
    for (let h = 0; h < 24; h++) {
      const p = at(h, radius)
      pts.push(p.x, 0, p.z)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    ticks = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: 0xffc94f,
        size: 3,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        depthTest: false,
      }),
    )
    ticks.renderOrder = -4
    ticks.frustumCulled = false
    scene.add(ticks)

    // 00 is left unlabelled: that is where the ring titles stack
    hourLabels.length = 0
    for (const h of [6, 12, 18]) {
      // far enough out to clear a marker sitting on the same hour
      hourLabels.push({ text: String(h).padStart(2, '0'), world: at(h, radius + 34) })
    }

    el.innerHTML =
      items
        .map(({ r }) => {
          const st = r.status.toLowerCase().replace(/[^a-z]/g, '')
          return `<div class="rt-m ${esc(st)}">
            <i></i>
            <div class="rt-tip"><b>${esc(r.title)}</b><span>${esc(r.at)} · ${esc(r.status)}${r.via ? ` · ${esc(r.via)}` : ''}</span></div>
          </div>`
        })
        .join('') +
      hourLabels.map((l) => `<em class="rt-h">${l.text}</em>`).join('') +
      '<div class="rt-now"><i></i></div>'
    apply()
  }

  function apply() {
    if (ticks) ticks.visible = active
    el.style.display = active ? '' : 'none'
  }

  let boxes: { x: number; y: number; hw: number; hh: number; tag: string }[] = []

  function update(f: { camera: THREE.Camera; rect: DOMRect; now: Date }) {
    if (!active) {
      boxes = []
      return
    }
    const next: typeof boxes = []
    const v = new THREE.Vector3()
    const place = (node: Element | undefined, w: THREE.Vector3) => {
      if (!node) return
      v.copy(w).project(f.camera)
      const e = node as HTMLElement
      e.style.transform = `translate(${(((v.x + 1) / 2) * f.rect.width).toFixed(1)}px, ${(((1 - v.y) / 2) * f.rect.height).toFixed(1)}px)`
    }
    const kids = el.children
    let k = 0
    for (const it of items) {
      place(kids[k++], it.world)
      next.push({
        x: ((v.x + 1) / 2) * f.rect.width,
        y: ((1 - v.y) / 2) * f.rect.height,
        hw: 11,
        hh: 11,
        tag: 'routine',
      })
    }
    boxes = next
    for (const l of hourLabels) place(kids[k++], l.world)
    const h = f.now.getHours() + f.now.getMinutes() / 60
    nowWorld.copy(at(h, radius))
    const hand = kids[k] as HTMLElement | undefined
    place(hand, nowWorld)
    if (hand) {
      // point the hand along the radius, outward
      const deg = (h / 24) * 360
      ;(hand.firstElementChild as HTMLElement | null)?.style.setProperty('--r', `${deg}deg`)
    }
  }

  return {
    build,
    update,
    /** routine markers' screen boxes, for the canvas label layer */
    boxes: () => boxes,
    setActive(on: boolean) {
      active = on
      apply()
    },
  }
}
