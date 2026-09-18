/**
 * Users — the people coming into Laika Orbit, as a live node network.
 *
 * Each person is a node that flows in from the edge and moves inward through the steps they have
 * taken: visited the site → joined the waitlist → bought Pro → activated a licence → opened the
 * app → used features. The network shows where people gather, where they stop, and who is active
 * right now. Hover a node for its journey; the scrubber replays the last day or week.
 *
 * REAL OR DEMO, NEVER BOTH. The panel opens on real data (/api/users, see users-api.mjs), which
 * says per source what is connected and what is not. Demo traffic is generated in the page
 * (users-data.ts), only when asked for, and while it shows the stage carries a band saying so and
 * every count reads as demo. Nothing remembers the choice: the next open is real again.
 *
 * The panel is registered through the panel API, so the rail button (Users), the shortcut (u) and
 * the palette entry come from there. The scene draws only while the panel is on screen.
 */
import { registerPanel } from './panels.ts'
import {
  DAY,
  demoFeed,
  type Feed,
  HOUR,
  lastSeen,
  type Person,
  STEP_INDEX,
  STEPS,
  stepsAt,
} from './users-data.ts'
import { type Level, watchLevel } from './users-level.ts'
import { createUsersScene, type Hover, type UsersScene } from './users-scene.ts'
import './users.css'

const ICON =
  '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="10" cy="10" r="2"/><circle cx="4" cy="5" r="1.4"/><circle cx="16" cy="6" r="1.4"/><circle cx="5" cy="15.5" r="1.4"/><circle cx="15.5" cy="15" r="1.4"/><path d="M5.2 5.9 8.4 8.9M14.8 6.8l-3.3 2.3M6.3 14.6l2.3-3.2M14.3 14l-2.8-2.9"/></svg>'

/** real data is re-read this often while the panel is on screen, and never while it is not */
const POLL_MS = 5 * 60_000
/** hidden this long and the WebGL context is given back; the next show makes a new one */
const RELEASE_AFTER = 30_000
/** a replay of the whole range takes this long */
const REPLAY_MS = { day: 16_000, week: 24_000 }
const RANGE = { day: DAY, week: 7 * DAY }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

function ago(ms: number) {
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
const clock = (t: number, withDay: boolean) =>
  new Date(t).toLocaleString(
    undefined,
    withDay
      ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' },
  )

function mountUsers(host: HTMLElement) {
  host.classList.add('usr')
  host.innerHTML = `
    <div class="usr-top">
      <div class="usr-mode" role="tablist" aria-label="Data">
        <button data-mode="real" role="tab">Real</button>
        <button data-mode="demo" role="tab">Demo</button>
      </div>
      <div class="usr-sum" aria-live="polite"></div>
      <button class="usr-src-btn" aria-haspopup="true"></button>
    </div>
    <div class="usr-stage">
      <div class="usr-band" hidden>DEMO · generated, not real users</div>
      <div class="usr-empty" hidden></div>
      <div class="usr-tip" hidden></div>
      <div class="usr-src" hidden></div>
    </div>
    <div class="usr-time">
      <button class="usr-live" title="Follow now">Live</button>
      <div class="usr-range" role="tablist" aria-label="Range">
        <button data-range="day">Day</button>
        <button data-range="week">Week</button>
      </div>
      <button class="usr-play" title="Replay the range" aria-label="Replay"></button>
      <div class="usr-track"><canvas></canvas><div class="usr-head"></div></div>
      <span class="usr-at"></span>
    </div>
    <div class="usr-legend">
      <span><i class="d"></i>person</span><span><i class="d paid"></i>paid for Pro</span>
      <span><i class="d act"></i><em class="usr-act-word">active now</em></span><span><i class="d faded"></i>not seen for 3 days</span>
      <span><i class="rib"></i>moves between steps</span>
      <span class="usr-legend-note"></span>
    </div>`
  const $ = <T extends HTMLElement>(s: string) => host.querySelector(s) as T
  const stageEl = $('.usr-stage')
  const band = $('.usr-band')
  const empty = $('.usr-empty')
  const tip = $('.usr-tip')
  const srcPop = $('.usr-src')
  const sum = $('.usr-sum')
  const srcBtn = $('.usr-src-btn')
  const liveBtn = $('.usr-live')
  const playBtn = $('.usr-play')
  const track = $('.usr-track')
  const hist = track.querySelector('canvas') as HTMLCanvasElement
  const head = $('.usr-head')
  const atEl = $('.usr-at')
  const note = $('.usr-legend-note')
  const actWord = $('.usr-act-word')

  let mode: 'real' | 'demo' = 'real'
  let range: 'day' | 'week' = 'week'
  let feed: Feed | null = null
  let realFeed: Feed | null = null
  let live = true
  let T = Date.now()
  let playing = false
  /** a replay the panel was hidden in the middle of, to resume on the next show */
  let paused = false
  let playTimer = 0
  let playFrom = 0
  let clockTimer = 0
  let pollTimer = 0
  let releaseTimer = 0
  let level: Level = 'hidden'
  let hover: Hover = null
  let demoAnchor = 0

  const scene: UsersScene = createUsersScene(stageEl, { hover: (h) => showTip(h) })
  const levels = watchLevel(stageEl, (l) => setLevel(l))

  // ---------------------------------------------------------------- data ----
  async function loadReal() {
    try {
      const r = await fetch('/api/users', { cache: 'no-store' })
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json'))
        throw new Error(String(r.status))
      realFeed = (await r.json()) as Feed
    } catch (e) {
      realFeed = {
        mode: 'real',
        now: Date.now(),
        people: [],
        activeGrain: 'day',
        sources: [
          {
            id: 'server',
            name: 'Orbit server',
            state: 'error',
            steps: [],
            note: `Could not read /api/users (${String((e as Error).message)})`,
          },
        ],
      }
    }
    if (mode === 'real') use(realFeed)
  }

  function useDemo() {
    const now = Date.now()
    // the demo week runs six hours past its anchor; make a fresh one before it runs out
    if (!demoAnchor || now > demoAnchor + 5 * HOUR) demoAnchor = now
    use(demoFeed(now, demoAnchor))
  }

  function use(f: Feed) {
    feed = f
    const demo = f.mode === 'demo'
    band.hidden = !demo
    host.classList.toggle('is-demo', demo)
    for (const b of host.querySelectorAll<HTMLElement>('[data-mode]'))
      b.setAttribute('aria-selected', String(b.dataset.mode === mode))
    actWord.textContent = f.activeGrain === 'day' ? 'active today' : 'active now'
    note.textContent = demo ? '' : 'App use is anonymous, so it is never joined to a purchase.'
    if (live) T = Date.now()
    scene.setData(f, T)
    drawHist()
    renderEmpty()
    renderSources()
    refresh()
  }

  function renderEmpty() {
    const none = !!feed && feed.mode === 'real' && feed.people.length === 0
    empty.hidden = !none
    if (!none || !feed) return
    const connected = feed.sources.filter((s) => s.state === 'connected')
    empty.innerHTML = `
      <b>No real people to show yet</b>
      <p>${connected.length ? `${connected.map((s) => esc(s.name)).join(', ')} connected, with nobody in this range.` : 'No source is connected yet.'} The sources list says what each one needs.</p>
      <button class="usr-demo-go">Show demo traffic</button>`
  }

  function renderSources() {
    if (!feed) return
    const ok = feed.sources.filter((s) => s.state === 'connected').length
    srcBtn.textContent =
      feed.mode === 'demo' ? 'Demo data' : `${ok} of ${feed.sources.length} sources`
    srcBtn.classList.toggle('warn', feed.mode === 'real' && ok < feed.sources.length)
    srcPop.innerHTML = `<h4>${feed.mode === 'demo' ? 'Demo mode' : 'Where the numbers come from'}</h4>${feed.sources
      .map(
        (s) => `<div class="usr-src-row ${s.state}">
          <i></i><div><b>${esc(s.name)}</b>${s.count !== undefined ? ` <span>${s.count.toLocaleString()}</span>` : ''}
          <p>${esc(s.note)}</p>
          <small>${s.steps.map((id) => STEPS[STEP_INDEX[id]]!.short).join(' · ') || '—'}</small></div></div>`,
      )
      .join('')}`
  }

  // ---------------------------------------------------------------- time ----
  const rangeStart = () => (feed ? Math.min(Date.now(), feed.now) : Date.now()) - RANGE[range]
  const now = () => Date.now()

  function setT(t: number, animate: boolean) {
    T = Math.max(rangeStart(), Math.min(now(), t))
    scene.setTime(T, animate)
    refresh()
  }

  function refresh() {
    const s = scene.stats()
    const dem = feed?.mode === 'demo' ? 'demo ' : ''
    const arrived = feed
      ? feed.people.filter((p) => stepsAt(p, T).length && (firstStep(p) ?? 0) >= rangeStart())
          .length
      : 0
    const act = s.reduce((a, h) => a + h.active, 0)
    sum.innerHTML = feed
      ? `<span><b>${arrived.toLocaleString()}</b> ${dem}people arrived in the ${range}</span><span><b>${s[STEP_INDEX.pro]!.reached.toLocaleString()}</b> bought Pro</span><span class="a"><b>${act}</b> ${feed.activeGrain === 'day' ? 'active today' : 'active now'}</span>`
      : ''
    const f = (T - rangeStart()) / RANGE[range]
    head.style.left = `${Math.max(0, Math.min(1, f)) * 100}%`
    atEl.textContent = live ? 'now' : clock(T, range === 'week')
    liveBtn.classList.toggle('on', live)
    playBtn.classList.toggle('on', playing)
    for (const b of host.querySelectorAll<HTMLElement>('[data-range]'))
      b.setAttribute('aria-selected', String(b.dataset.range === range))
    if (hover) showTip(hover)
  }

  const firstStep = (p: Person) => {
    let m: number | undefined
    for (const v of Object.values(p.steps)) if (v !== undefined && (m === undefined || v < m)) m = v
    return m
  }

  /** arrivals per bucket as quiet bars, Pro purchases as orange ticks above them */
  function drawHist() {
    if (!feed) return
    const r = track.getBoundingClientRect()
    if (r.width < 2) return
    const dpr = Math.min(devicePixelRatio, 2)
    hist.width = Math.round(r.width * dpr)
    hist.height = Math.round(r.height * dpr)
    const g = hist.getContext('2d') as CanvasRenderingContext2D
    g.scale(dpr, dpr)
    const n = range === 'day' ? 96 : 168
    const t0 = rangeStart()
    const span = RANGE[range]
    const arrivals = new Array(n).fill(0)
    const buys = new Array(n).fill(0)
    for (const p of feed.people) {
      const a = firstStep(p)
      if (a !== undefined && a >= t0 && a <= now())
        arrivals[Math.min(n - 1, Math.floor(((a - t0) / span) * n))]++
      const b = p.steps.pro
      if (b !== undefined && b >= t0 && b <= now())
        buys[Math.min(n - 1, Math.floor(((b - t0) / span) * n))]++
    }
    const max = Math.max(1, ...arrivals)
    const bw = r.width / n
    const css = getComputedStyle(host)
    g.fillStyle = css.getPropertyValue('--usr-bar').trim() || '#2a3248'
    for (let i = 0; i < n; i++) {
      const hgt = (arrivals[i] / max) * (r.height - 8)
      if (hgt > 0) g.fillRect(i * bw + 0.5, r.height - hgt, Math.max(1, bw - 1), hgt)
    }
    g.fillStyle = css.getPropertyValue('--acc').trim() || '#ff7a45'
    for (let i = 0; i < n; i++) if (buys[i]) g.fillRect(i * bw + bw / 2 - 1, 1, 2, 3)
    // day boundaries in the week view
    if (range === 'week') {
      g.fillStyle = css.getPropertyValue('--usr-tick').trim() || '#1b2130'
      const d0 = Math.ceil(t0 / DAY) * DAY
      for (let d = d0; d < t0 + span; d += DAY)
        g.fillRect(((d - t0) / span) * r.width, 0, 1, r.height)
    }
  }

  function goLive() {
    stopPlay()
    live = true
    setT(now(), true)
  }

  function startPlay() {
    live = false
    playFrom = performance.now()
    setT(rangeStart(), false)
    playing = true
    tickPlay()
  }
  function stopPlay() {
    clearTimeout(playTimer)
    playing = paused = false
  }
  /** the replay clock: only while playing and on screen */
  function tickPlay() {
    if (!playing || level === 'hidden') return
    const u = (performance.now() - playFrom) / REPLAY_MS[range]
    if (u >= 1) {
      stopPlay()
      live = true
      setT(now(), true)
      return
    }
    setT(rangeStart() + u * RANGE[range], true)
    playTimer = window.setTimeout(tickPlay, level === 'live' ? 50 : 120)
  }

  // the wall clock, while following now: arrivals land as they happen
  function tickClock() {
    clearTimeout(clockTimer)
    clockTimer = 0
    if (level === 'hidden') return
    if (live && !playing) setT(now(), true)
    if (mode === 'demo' && now() > demoAnchor + 5 * HOUR) useDemo()
    clockTimer = window.setTimeout(tickClock, 1000)
  }

  // --------------------------------------------------------------- levels ----
  function setLevel(l: Level) {
    const was = level
    level = l
    scene.setLevel(l)
    clearTimeout(releaseTimer)
    if (l === 'hidden') {
      clearTimeout(clockTimer)
      clearTimeout(pollTimer)
      clockTimer = pollTimer = 0
      if (playing) {
        clearTimeout(playTimer)
        paused = true
      }
      releaseTimer = window.setTimeout(() => scene.releaseGPU(), RELEASE_AFTER)
      return
    }
    if (was === 'hidden') {
      scene.resize()
      if (paused) {
        paused = false
        // resume where it was: shift the start by the time spent hidden
        playFrom = performance.now() - ((T - rangeStart()) / RANGE[range]) * REPLAY_MS[range]
        tickPlay()
      }
      if (mode === 'real') poll()
      else if (live) setT(now(), false)
      tickClock()
      drawHist()
    }
  }

  function poll() {
    clearTimeout(pollTimer)
    pollTimer = 0
    if (level === 'hidden' || mode !== 'real') return
    void loadReal()
    pollTimer = window.setTimeout(poll, POLL_MS)
  }

  // ----------------------------------------------------------------- hover ----
  function showTip(h: Hover) {
    hover = h
    if (!h || !feed) {
      tip.hidden = true
      return
    }
    const demo = feed.mode === 'demo'
    if (h.kind === 'hub') {
      const i = STEP_INDEX[h.step]
      const s = scene.stats()[i]!
      const nxt = STEPS[i + 1]!
      const onward = nxt
        ? feed.people.filter(
            (p) => stepsAt(p, T).includes(h.step) && stepsAt(p, T).includes(nxt.id),
          ).length
        : 0
      tip.innerHTML = `<header>${demo ? '<em>demo</em>' : ''}${STEPS[i]!.label}</header>
        <dl><dt>Ever reached</dt><dd>${s.reached.toLocaleString()}</dd>
        <dt>Here now</dt><dd>${s.here.toLocaleString()}</dd>
        <dt>${feed.activeGrain === 'day' ? 'Active today' : 'Active now'}</dt><dd>${s.active}</dd>
        ${nxt && s.reached ? `<dt>Went on to ${nxt.short.toLowerCase()}</dt><dd>${Math.round((onward / s.reached) * 100)}%</dd>` : ''}</dl>
        ${s.counted ? `<p>${esc(s.counted.note)}: ${s.counted.n.toLocaleString()}</p>` : ''}`
    } else {
      const p = h.person
      const seq = stepsAt(p, T)
      const seen = lastSeen(p, T)
      const activeNow = p.active.some(([a, b]) => a <= T && T <= b)
      const name = demo ? `Demo person ${p.id.slice(5)}` : `Person ${p.id.slice(-6)}`
      const status = activeNow
        ? '<span class="a">using the app now</span>'
        : seen > 0
          ? `last seen ${ago(T - seen)}`
          : ''
      tip.innerHTML = `<header>${demo ? '<em>demo</em>' : ''}${esc(name)}</header>${status ? `<div class="usr-tip-st">${status}</div>` : ''}
        <ol>${STEPS.map((s) => {
          const at = p.steps[s.id]
          const done = at !== undefined && at <= T
          return `<li class="${done ? 'done' : ''}"><i></i>${s.label}${done ? `<time>${ago(T - (at as number))}</time>` : ''}</li>`
        }).join('')}</ol>
        ${
          p.features.filter((f) => f.at <= T).length
            ? `<div class="usr-feats">${p.features
                .filter((f) => f.at <= T)
                .map((f) => `<span>${esc(f.name)}</span>`)
                .join('')}</div>`
            : ''
        }
        ${seq.length === 1 && T - seen > 3 * DAY ? '<p>Stopped at the first step.</p>' : ''}`
    }
    tip.hidden = false
    const r = stageEl.getBoundingClientRect()
    const tw = tip.offsetWidth
    const th = tip.offsetHeight
    const x = h.x + 16 + tw > r.width ? h.x - 16 - tw : h.x + 16
    const y = Math.max(8, Math.min(r.height - th - 8, h.y - 20))
    tip.style.transform = `translate(${x}px, ${y}px)`
  }

  // ---------------------------------------------------------------- events ----
  host.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    const m = t.closest<HTMLElement>('[data-mode]')?.dataset.mode as 'real' | 'demo' | undefined
    if (m && m !== mode) {
      mode = m
      stopPlay()
      live = true
      if (m === 'demo') {
        clearTimeout(pollTimer)
        useDemo()
      } else if (realFeed) {
        use(realFeed)
        poll()
      } else poll()
      return
    }
    if (t.closest('.usr-demo-go')) {
      ;(host.querySelector('[data-mode="demo"]') as HTMLElement).click()
      return
    }
    const rg = t.closest<HTMLElement>('[data-range]')?.dataset.range as 'day' | 'week' | undefined
    if (rg && rg !== range) {
      range = rg
      stopPlay()
      if (!live) T = Math.max(T, rangeStart())
      drawHist()
      setT(live ? now() : T, false)
      return
    }
    if (t.closest('.usr-live')) return goLive()
    if (t.closest('.usr-play')) return playing ? (stopPlay(), refresh()) : startPlay()
    if (t.closest('.usr-src-btn')) {
      srcPop.hidden = !srcPop.hidden
      return
    }
    if (!t.closest('.usr-src')) srcPop.hidden = true
  })

  // scrubbing: press on the track and drag; lets go of live
  track.addEventListener('pointerdown', (e) => {
    stopPlay()
    live = false
    track.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const r = track.getBoundingClientRect()
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width))
      setT(rangeStart() + f * RANGE[range], false)
      // dragged to the right-hand end is the same as following now
      if (f > 0.995) live = true
      refresh()
    }
    move(e)
    const up = () => {
      track.removeEventListener('pointermove', move)
      track.removeEventListener('pointerup', up)
    }
    track.addEventListener('pointermove', move)
    track.addEventListener('pointerup', up)
  })

  const onSettled = () => {
    scene.resize()
    drawHist()
  }
  addEventListener('laika:panels-settled', onSettled)
  const ro = new ResizeObserver(() => {
    if (level === 'hidden') return
    scene.resize()
    drawHist()
  })
  ro.observe(stageEl)

  void loadReal()

  return {
    visible: (on: boolean) => levels.setShown(on),
    dispose() {
      levels.dispose()
      ro.disconnect()
      removeEventListener('laika:panels-settled', onSettled)
      clearTimeout(clockTimer)
      clearTimeout(pollTimer)
      clearTimeout(releaseTimer)
      stopPlay()
      scene.dispose()
    },
  }
}

export function registerUsersPanel() {
  let view: ReturnType<typeof mountUsers> | null = null
  return registerPanel({
    id: 'users',
    title: 'Users',
    group: 'know',
    key: 'u',
    icon: ICON,
    wide: true,
    width: { min: 520, default: 900, snaps: [640, 900, 1200] },
    terms:
      'users people customers waitlist stripe pro licence license funnel journey flow network adoption demo',
    hint: 'People flowing in: site, waitlist, Pro, app',
    mount: (host) => {
      view = mountUsers(host)
      return () => view?.dispose()
    },
    onVisible: (on) => view?.visible(on),
  })
}
