import * as THREE from 'three'
import { Text } from 'troika-three-text'

/**
 * SDF label layer, ported from the gauntlet's `readability` build (which passed
 * blind judging against cosmos.gl in both slot orderings).
 *
 * The part that matters is the screen-space overlap rejector: labels are ranked,
 * projected, and any that would collide with a higher-ranked one is hidden. Without
 * it, labels pile up into an unreadable mat at exactly the density where you need
 * them most.
 */
export interface LabelSpec {
  text: string
  world: THREE.Vector3
  colour: number
  /** 0 = ring/section title, 1 = hub, 2 = leaf. Lower wins collisions. */
  tier: number
  px: number
  /** letter spacing in em; ring titles are tracked out like the reference's */
  spacing?: number
}

const PAD: Record<number, number> = { 0: 26, 1: 14, 2: 9 }

export class LabelLayer {
  #group = new THREE.Group()
  #pool: InstanceType<typeof Text>[] = []
  #specs: LabelSpec[] = []
  /**
   * Screen-space boxes owned by something OUTSIDE this layer — the DOM department
   * hubs. They are drawn by the browser, not by troika, so the rejector below could
   * not see them and happily stacked a node label straight through a hub pill.
   * Seeding them as already-taken makes one occupancy map for the whole screen.
   */
  #reserved: { x: number; y: number; hw: number; hh: number; tag?: string }[] = []
  /** what each hidden label last collided with — a verification hook */
  #why = new Map<string, string>()
  visible = 0

  constructor(scene: THREE.Scene) {
    this.#group.renderOrder = 10
    scene.add(this.#group)
  }

  set(specs: LabelSpec[]) {
    this.#specs = [...specs].sort((a, b) => a.tier - b.tier)
    while (this.#pool.length < this.#specs.length) {
      const t = new Text()
      t.font = undefined
      t.anchorX = 'center'
      t.anchorY = 'middle'
      t.fontSize = 1 // world scale applied per frame
      t.sdfGlyphSize = 64
      t.outlineWidth = '13%'
      t.outlineColor = 0x04050a
      t.material.depthTest = false
      t.material.transparent = true
      this.#pool.push(t)
      this.#group.add(t)
    }
    this.#specs.forEach((s, i) => {
      const t = this.#pool[i]
      if (!t) return
      t.text = s.text
      t.fontWeight = s.tier < 2 ? 700 : 400
      t.letterSpacing = s.spacing ?? 0
      t.color = s.colour
      t.position.copy(s.world)
      t.sync()
    })
    for (let i = this.#specs.length; i < this.#pool.length; i++) {
      const t = this.#pool[i]
      if (t) t.visible = false
    }
  }

  /** Why a hidden label was hidden: the text or tag of the box it hit. */
  why(text: string) {
    return this.#why.get(text) ?? null
  }

  /** Every hidden label with what it last collided with — a verification hook. */
  hidden() {
    return this.#specs
      .filter((_, i) => !this.#pool[i]?.visible)
      .map((s) => [s.text, this.#why.get(s.text) ?? 'offscreen'] as const)
  }

  /** Texts currently shown — a verification hook for headless checks. */
  shown() {
    return this.#specs.filter((_, i) => this.#pool[i]?.visible).map((s) => s.text)
  }

  /** Boxes that outrank every label, in stage-relative pixels. */
  reserve(boxes: { x: number; y: number; hw: number; hh: number; tag?: string }[]) {
    this.#reserved = boxes
  }

  /** Project, scale to a constant on-screen size, and reject overlaps. */
  update(camera: THREE.PerspectiveCamera, w: number, h: number) {
    const taken: { x: number; y: number; hw: number; hh: number; tag?: string }[] = [
      ...this.#reserved,
    ]
    let shown = 0
    const v = new THREE.Vector3()

    this.#specs.forEach((s, i) => {
      const t = this.#pool[i]
      if (!t) return
      v.copy(s.world).project(camera)
      if (v.z > 1 || v.x < -1.15 || v.x > 1.15 || v.y < -1.15 || v.y > 1.15) {
        t.visible = false
        return
      }
      t.position.copy(s.world) // specs may be re-aimed between frames
      const dist = camera.position.distanceTo(s.world)
      // world units per screen pixel at this distance
      const perPx = (2 * Math.tan((camera.fov * Math.PI) / 360) * dist) / h
      t.scale.setScalar(s.px * perPx)
      t.quaternion.copy(camera.quaternion) // billboard

      const sx = ((v.x + 1) / 2) * w
      const sy = ((1 - v.y) / 2) * h
      // Name labels render at ~0.66em per glyph in bold (ENGINEERING.md: 120px at 13px);
      // 0.31 was half that, so two hub names could stack flush against each other.
      // Tracked ring titles keep the old factor — their clearance of the app badges is
      // tuned to it (see RING_TITLE_R).
      const em = s.spacing ? 0.31 : s.tier < 2 ? 0.64 : 0.55
      const hw = (s.text.length * s.px * (em + (s.spacing ?? 0))) / 2 + (PAD[s.tier] ?? 9)
      // titles get a tight vertical pad so the four ring names can stack down the
      // centreline; lower tiers keep the spacing the readability build was judged on
      const hh = s.px * 0.62 + (PAD[s.tier] ?? 9) * (s.tier === 0 ? 0.05 : 0.4)

      const hit = taken.find(
        (o) => Math.abs(o.x - sx) < o.hw + hw && Math.abs(o.y - sy) < o.hh + hh,
      )
      if (hit) {
        t.visible = false
        this.#why.set(s.text, hit.tag ?? 'label')
        return
      }
      this.#why.delete(s.text)
      taken.push({ x: sx, y: sy, hw, hh, tag: s.text })
      t.visible = true
      shown++
    })
    this.visible = shown
  }
}
