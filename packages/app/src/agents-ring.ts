import * as THREE from 'three'
import './agents-ring.css'

/**
 * Live agent state on the ARMS ring, so one glance at the map says where work needs you.
 *
 *   heat     an arc just outside the MEMORY ring over each repo holding work that only exists
 *            on this machine: red when commits are unpushed, amber for uncommitted files,
 *            brighter the more there is to lose
 *   markers  one per running Claude Code session, on its repo's arc: orange pulse = your
 *            turn, amber pulse = blocked on a tool call, cyan = working
 *
 * Sessions and repos come from /api/control/ring already addressed as index paths
 * (`@dev/` + `atlas-api`), and are placed over the files the ring drew for that folder.
 * Anything with no files on the ring waits in the gap at 12 o'clock rather than vanishing.
 */

type At = { prefix: string; rel: string } | null
export type RingAgent = {
  id: string
  state: 'needs-you' | 'blocked' | 'working'
  title: string
  repo: string
  branch: string | null
  lastTool: string | null
  updated: string
  at: At
}
export type RingRepo = {
  name: string
  unpushed: number | null
  uncommitted: number
  noUpstream: boolean
  risk: number
  at: At
}
type RingNode = { path: string }

const esc = (s: string) => s.replace(/[<>&"]/g, (m) => `&#${m.charCodeAt(0)};`)
const TAU = Math.PI * 2
const wrap = (a: number) => ((a % TAU) + TAU) % TAU
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000)
  return m < 1 ? 'now' : m < 60 ? `${m}m` : `${Math.round(m / 60)}h`
}
const STATE_LABEL = { 'needs-you': 'your turn', blocked: 'blocked', working: 'working' } as const

export function createAgentsRing(
  scene: THREE.Scene,
  stage: HTMLElement,
  opts: { onOpen: (id: string) => void },
) {
  let active = false
  let nodes: RingNode[] = []
  let pos: Float32Array = new Float32Array(0)
  let root = -1
  let heatR = 372
  let markR = 392
  let top = Math.PI
  let agents: RingAgent[] = []
  let repos: RingRepo[] = []
  let placed: { a: RingAgent; world: THREE.Vector3 }[] = []
  let boxes: { x: number; y: number; hw: number; hh: number; tag: string }[] = []
  const heat = new THREE.Group()
  heat.renderOrder = -3
  scene.add(heat)

  const el = document.createElement('div')
  el.id = 'ag'
  stage.appendChild(el)
  el.addEventListener('click', (e) => {
    const m = (e.target as HTMLElement).closest<HTMLElement>('[data-id]')
    if (m?.dataset.id) opts.onOpen(m.dataset.id)
  })

  /** angular span of the ring's files under a folder, or null when it has none */
  const spans = new Map<string, { mid: number; half: number } | null>()
  function spanOf(at: At) {
    if (!at) return null
    const key = `${at.prefix}${at.rel}`
    if (spans.has(key)) return spans.get(key) ?? null
    const dir = at.rel ? `${at.prefix}${at.rel}/` : at.prefix
    const angles: number[] = []
    nodes.forEach((n, i) => {
      if (i === root) return
      // the first source has no prefix: its folder is every path without an @source
      const inside = dir ? n.path.startsWith(dir) : !n.path.startsWith('@')
      if (inside) angles.push(Math.atan2(pos[i * 3 + 2] ?? 0, pos[i * 3] ?? 0))
    })
    let out: { mid: number; half: number } | null = null
    if (angles.length) {
      // circular mean, then the widest distance from it, so a span across 0 rad still works
      const mid = Math.atan2(
        angles.reduce((s, a) => s + Math.sin(a), 0),
        angles.reduce((s, a) => s + Math.cos(a), 0),
      )
      const half = Math.max(
        0.012,
        ...angles.map((a) => Math.abs(wrap(a - mid + Math.PI) - Math.PI)),
      )
      out = { mid, half }
    }
    spans.set(key, out)
    return out
  }

  function drawHeat() {
    for (const m of heat.children as THREE.Mesh[]) {
      m.geometry.dispose()
      ;(m.material as THREE.Material).dispose()
    }
    heat.clear()
    for (const r of repos) {
      const sp = spanOf(r.at)
      if (!sp) continue
      const lossy = (r.unpushed ?? 0) > 0 || (r.noUpstream && r.uncommitted === 0)
      const strength = Math.min(1, r.risk / 150)
      const geo = new THREE.RingGeometry(
        heatR - 2.5 - strength * 2.5,
        heatR + 2.5 + strength * 2.5,
        48,
        1,
        sp.mid - sp.half,
        sp.half * 2,
      )
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: lossy ? 0xff6b6b : 0xf2c14e,
          transparent: true,
          opacity: 0.22 + strength * 0.55,
          side: THREE.DoubleSide,
          depthWrite: false,
          depthTest: false,
        }),
      )
      // RingGeometry lies in XY; +90° about X puts (cos t, sin t) at (cos t, 0, sin t)
      mesh.rotation.x = Math.PI / 2
      mesh.renderOrder = -3
      mesh.frustumCulled = false
      mesh.userData = { repo: r.name }
      heat.add(mesh)
    }
  }

  function placeAgents() {
    // sessions on one repo fan out along its arc, a marker's width apart
    const byKey = new Map<string, RingAgent[]>()
    for (const a of agents) {
      const k = spanOf(a.at) ? `${a.at?.prefix}${a.at?.rel}` : '(elsewhere)'
      byKey.set(k, [...(byKey.get(k) ?? []), a])
    }
    const step = 20 / markR
    const rank = { 'needs-you': 0, blocked: 1, working: 2 }
    placed = []
    // one label per repo: several waiting sessions in one repo read as a count, not a stack
    const labels = new Map<RingAgent, string>()
    for (const [k, list] of byKey) {
      list.sort(
        (p, q) => rank[p.state] - rank[q.state] || Date.parse(p.updated) - Date.parse(q.updated),
      )
      const waiting = list.filter((a) => a.state !== 'working')
      const lead = waiting[0]
      if (lead) {
        const blocked = waiting.filter((a) => a.state === 'blocked').length
        const what =
          waiting.length === 1
            ? ago(lead.updated)
            : blocked === waiting.length
              ? `${blocked} blocked`
              : `${waiting.length} waiting`
        labels.set(lead, `${lead.repo} · ${what}`)
      }
      const mid = k === '(elsewhere)' ? top : (spanOf(list[0]?.at ?? null)?.mid ?? top)
      list.forEach((a, i) => {
        const ang = mid + (i - (list.length - 1) / 2) * step
        placed.push({
          a,
          world: new THREE.Vector3(Math.cos(ang) * markR, 0, Math.sin(ang) * markR),
        })
      })
    }
    el.innerHTML = placed
      .map(({ a }) => {
        const text = labels.get(a)
        const label = text ? `<span class="ag-l">${esc(text)}</span>` : ''
        return `<div class="ag-m ${a.state}${focus?.sdkId === a.id ? ' focus' : ''}" data-id="${esc(a.id)}" role="button" tabindex="-1" aria-label="${esc(`${a.repo}: ${STATE_LABEL[a.state]}`)}">
          <i></i>${label}
          <div class="ag-tip"><b>${esc(a.title || 'untitled session')}</b><span>${esc(a.repo)}${a.branch ? ` · ${esc(a.branch)}` : ''} · ${STATE_LABEL[a.state]} ${ago(a.updated)}${a.state !== 'needs-you' && a.lastTool ? ` · ${esc(a.lastTool)}` : ''}</span><em>click to open agent control</em></div>
        </div>`
      })
      .join('')
  }

  let json = ''
  async function poll() {
    if (!active) return
    try {
      const d: { agents: RingAgent[]; repos: RingRepo[] } = await (
        await fetch('/api/control/ring')
      ).json()
      const next = JSON.stringify(d)
      if (next === json) return
      json = next
      agents = d.agents
      repos = d.repos
      drawHeat()
      placeAgents()
    } catch {}
  }
  setInterval(poll, 5_000)
  // ages in the labels keep moving between changes
  setInterval(() => active && placeAgents(), 30_000)

  // ------------------------------------------------------------ live activity
  // Claude sessions running in the app (sessions.ts) report each tool call. A beam runs from
  // the core to the file it touches, pulsing while the tool runs; edited files keep a glow
  // for the session in focus, and that session's repo arc is lit.
  const live = new THREE.Group()
  live.renderOrder = 20
  scene.add(live)
  let sources: { dir: string; prefix: string }[] = []
  fetch('/api/control/sources')
    .then((r) => r.json())
    .then((d) => {
      sources = d
    })
    .catch(() => {})
  let byPath = new Map<string, number>()
  // a soft round sprite: PointsMaterial draws squares without one
  const disc = (() => {
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const g = c.getContext('2d')
    if (g) {
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
      grad.addColorStop(0, 'rgba(255,255,255,1)')
      grad.addColorStop(0.45, 'rgba(255,255,255,0.9)')
      grad.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = grad
      g.fillRect(0, 0, 64, 64)
    }
    return new THREE.CanvasTexture(c)
  })()
  const FLOW = 7 // particles travelling along a running beam

  type Beam = {
    toolId: string
    line: THREE.Line
    dot: THREE.Points
    flow: THREE.Points
    from: THREE.Vector3
    to: THREE.Vector3
    colour: THREE.Color
    born: number
    ended: number | null
    failed: boolean
  }
  const beams: Beam[] = []
  const footprints = new Map<string, Map<string, THREE.Vector3>>() // session → address → world
  let focus: {
    id: string
    sdkId: string | null
    cwd: string
    state: string
    colour?: string
  } | null = null
  let focusArc: THREE.Mesh | null = null
  let prints: THREE.Points | null = null
  const READ = new THREE.Color(0x56d8ff)
  const EDIT = new THREE.Color(0xff8a4c)
  const FAIL = new THREE.Color(0xff6b7a)

  const addressOf = (abs: string): At => {
    const hit = sources.find((x) => abs === x.dir || abs.startsWith(`${x.dir}/`))
    return hit
      ? { prefix: hit.prefix, rel: abs === hit.dir ? '' : abs.slice(hit.dir.length + 1) }
      : null
  }

  /** where on the ring a path lands: its own dot if indexed, else the nearest folder's arc */
  function targetOf(abs: string): THREE.Vector3 | null {
    const at = addressOf(abs)
    if (!at) return null
    const idx = byPath.get(`${at.prefix}${at.rel}`)
    if (idx !== undefined) return new THREE.Vector3(pos[idx * 3] ?? 0, 0, pos[idx * 3 + 2] ?? 0)
    const parts = at.rel.split('/')
    for (let n = parts.length - 1; n >= 0; n--) {
      const sp = spanOf({ prefix: at.prefix, rel: parts.slice(0, n).join('/') })
      if (sp)
        return new THREE.Vector3(
          Math.cos(sp.mid) * (heatR - 26),
          0,
          Math.sin(sp.mid) * (heatR - 26),
        )
    }
    return null
  }

  const origin = () =>
    root >= 0
      ? new THREE.Vector3(pos[root * 3] ?? 0, 0, pos[root * 3 + 2] ?? 0)
      : new THREE.Vector3()

  function beam(toolId: string, to: THREE.Vector3, colour: THREE.Color) {
    const from = origin()
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([from, to]),
      new THREE.LineBasicMaterial({
        color: colour,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    )
    const flow = new THREE.Points(
      new THREE.BufferGeometry().setFromPoints(Array.from({ length: FLOW }, () => from.clone())),
      new THREE.PointsMaterial({
        color: colour,
        size: 7,
        map: disc,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    )
    const dot = new THREE.Points(
      new THREE.BufferGeometry().setFromPoints([to.clone()]),
      new THREE.PointsMaterial({
        color: colour,
        map: disc,
        size: 16,
        sizeAttenuation: false,
        transparent: true,
        opacity: 1,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    )
    for (const o of [line, dot, flow]) {
      o.renderOrder = 20
      o.frustumCulled = false
      live.add(o)
    }
    beams.push({
      toolId,
      line,
      dot,
      flow,
      from,
      to,
      colour,
      born: performance.now(),
      ended: null,
      failed: false,
    })
  }

  function paintFocus() {
    if (focusArc) {
      live.remove(focusArc)
      focusArc.geometry.dispose()
      ;(focusArc.material as THREE.Material).dispose()
      focusArc = null
    }
    if (prints) {
      live.remove(prints)
      prints.geometry.dispose()
      ;(prints.material as THREE.Material).dispose()
      prints = null
    }
    if (!focus || !active) return
    const at = addressOf(focus.cwd)
    const sp = at
      ? (spanOf(at) ?? spanOf({ prefix: at.prefix, rel: at.rel.split('/').slice(0, -1).join('/') }))
      : null
    if (sp) {
      const waiting = focus.state === 'waiting'
      focusArc = new THREE.Mesh(
        new THREE.RingGeometry(
          heatR - 12,
          heatR - 8,
          64,
          1,
          sp.mid - sp.half - 0.02,
          sp.half * 2 + 0.04,
        ),
        new THREE.MeshBasicMaterial({
          // the repo's workspace colour, orange while it waits on you
          color: waiting ? 0xff8a4c : new THREE.Color(focus.colour ?? '#56d8ff'),
          transparent: true,
          opacity: 0.7,
          side: THREE.DoubleSide,
          depthTest: false,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      )
      focusArc.rotation.x = Math.PI / 2
      focusArc.renderOrder = 19
      focusArc.frustumCulled = false
      live.add(focusArc)
    }
    const fp = footprints.get(focus.id)
    if (fp?.size) {
      prints = new THREE.Points(
        new THREE.BufferGeometry().setFromPoints([...fp.values()]),
        new THREE.PointsMaterial({
          color: 0xff8a4c,
          map: disc,
          size: 14,
          sizeAttenuation: false,
          transparent: true,
          opacity: 0.85,
          depthTest: false,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      )
      prints.renderOrder = 19
      prints.frustumCulled = false
      live.add(prints)
    }
  }

  addEventListener('laika:agent-activity', (ev) => {
    const d = (ev as CustomEvent).detail as {
      id: string
      cwd: string
      toolId: string
      kind?: 'read' | 'edit'
      paths?: string[]
      phase: string
    }
    if (d.phase === 'start') {
      const paths = d.paths?.length ? d.paths : [d.cwd]
      for (const p of paths) {
        const to = targetOf(p)
        if (!to) continue
        beam(d.toolId, to, d.kind === 'edit' ? EDIT : READ)
        if (d.kind === 'edit') {
          const at = addressOf(p)
          const key = at ? `${at.prefix}${at.rel}` : p
          if (!footprints.has(d.id)) footprints.set(d.id, new Map())
          footprints.get(d.id)?.set(key, to)
          if (focus?.id === d.id) paintFocus()
        }
      }
    } else {
      for (const b of beams) {
        if (b.toolId !== d.toolId || b.ended) continue
        b.ended = performance.now()
        b.failed = d.phase === 'failed'
      }
    }
  })
  addEventListener('laika:agent-focus', (ev) => {
    focus = (ev as CustomEvent).detail
    paintFocus()
    for (const e of el.children)
      e.classList.toggle('focus', !!focus?.sdkId && (e as HTMLElement).dataset.id === focus.sdkId)
  })

  /** per frame: running beams pulse, finished ones fade out over a second */
  function animate(now: number) {
    for (let i = beams.length - 1; i >= 0; i--) {
      const b = beams[i] as Beam
      const lm = b.line.material as THREE.LineBasicMaterial
      const dm = b.dot.material as THREE.PointsMaterial
      if (b.failed) {
        lm.color.copy(FAIL)
        dm.color.copy(FAIL)
      }
      const fm = b.flow.material as THREE.PointsMaterial
      if (b.failed) fm.color.copy(FAIL)
      // particles run core → file, spaced along the beam, looping while the tool works
      const fp = b.flow.geometry.getAttribute('position') as THREE.BufferAttribute
      for (let k = 0; k < FLOW; k++) {
        const t = (((now - b.born) / 900 + k / FLOW) % 1) ** 1.4
        fp.setXYZ(k, b.from.x + (b.to.x - b.from.x) * t, 0, b.from.z + (b.to.z - b.from.z) * t)
      }
      fp.needsUpdate = true
      if (b.ended === null) {
        const pulse = 0.55 + 0.45 * Math.sin((now - b.born) / 140)
        lm.opacity = 0.35 + 0.5 * pulse
        dm.size = 14 + 10 * pulse
        // give up on a beam whose tool never reported back
        if (now - b.born > 120_000) b.ended = now
      } else {
        const t = Math.min(1, (now - b.ended) / 1100)
        lm.opacity = 0.85 * (1 - t)
        fm.opacity = 0.95 * (1 - t)
        dm.opacity = 1 - t
        dm.size = 16 + 14 * t
        if (t >= 1) {
          live.remove(b.line, b.dot, b.flow)
          b.line.geometry.dispose()
          b.dot.geometry.dispose()
          b.flow.geometry.dispose()
          lm.dispose()
          dm.dispose()
          fm.dispose()
          beams.splice(i, 1)
        }
      }
    }
    if (focusArc) {
      ;(focusArc.material as THREE.MeshBasicMaterial).opacity = 0.45 + 0.3 * Math.sin(now / 520)
    }
  }

  function apply() {
    heat.visible = active
    live.visible = active
    el.style.display = active ? '' : 'none'
  }

  return {
    /** call after the ARMS layout: node positions, and the radii to draw between */
    build(o: {
      nodes: RingNode[]
      pos: Float32Array
      root: number
      memoryR: number
      routinesR: number
      top: number
    }) {
      nodes = o.nodes
      pos = o.pos
      root = o.root
      top = o.top
      heatR = o.memoryR + 12
      markR = o.memoryR + (o.routinesR - o.memoryR) * 0.47
      spans.clear()
      byPath = new Map(o.nodes.map((n, i) => [n.path, i]))
      paintFocus()
      drawHeat()
      placeAgents()
      json = ''
      poll()
    },
    update(f: { camera: THREE.Camera; rect: DOMRect }) {
      if (!active) {
        boxes = []
        return
      }
      animate(performance.now())
      const v = new THREE.Vector3()
      const next: typeof boxes = []
      const kids = el.children
      placed.forEach((p, k) => {
        const e = kids[k] as HTMLElement | undefined
        if (!e) return
        v.copy(p.world).project(f.camera)
        const x = ((v.x + 1) / 2) * f.rect.width
        const y = ((1 - v.y) / 2) * f.rect.height
        e.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
        // labels always read outward from the centre; near the stage edge they shorten
        // rather than flip inward over the ring's own names
        const c = new THREE.Vector3(0, 0, 0).project(f.camera)
        const hangLeft = v.x < c.x
        e.classList.toggle('left', hangLeft)
        const lab = e.querySelector<HTMLElement>('.ag-l')
        next.push({ x, y, hw: 10, hh: 10, tag: 'agent' })
        if (lab) {
          const room = Math.max(40, (hangLeft ? x : f.rect.width - x) - 24)
          lab.style.maxWidth = `${room}px`
          const lw = Math.min(lab.scrollWidth, room)
          next.push({
            x: hangLeft ? x - 13 - lw / 2 : x + 13 + lw / 2,
            y,
            hw: lw / 2 + 4,
            hh: 9,
            tag: 'agent-label',
          })
        }
      })
      boxes = next
    },
    boxes: () => boxes,
    setActive(on: boolean) {
      active = on
      apply()
      if (on) poll()
    },
  }
}
