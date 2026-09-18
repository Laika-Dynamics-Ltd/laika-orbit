import './youtube.css'
import * as activity from './activity.ts'

/**
 * The floating player: YouTube music and videos in a small window that lives over the app,
 * wherever you put it.
 *
 * It is a plain `<iframe>` embed rather than the YouTube IFrame API, so nothing is loaded
 * from Google until you actually play something. `enablejsapi=1` is enough to drive it:
 * commands go in as postMessage, and the same channel sends back title, time and play state
 * (the `listening` handshake below), which is what makes the mini bar useful. If that
 * handshake ever stops working the buttons still work — only the readout goes quiet.
 *
 * Dragging is the title bar, and the window snaps to the edges of the screen it is near.
 * Position, size, volume and the last thing played are remembered, so it comes back where
 * you left it.
 *
 * Mini mode keeps the iframe laid out and pushes it outside the window's clip, rather than
 * hiding it: a `display:none` iframe is free to stop the audio, a clipped one is not.
 */

export type YouTubeHost = {
  /** open what the player cannot embed — a search, or "watch on YouTube" */
  openWeb?: (url: string) => void
}

export type YouTubePlayer = {
  open: (what?: string) => void
  close: () => void
  toggle: () => void
  isOpen: () => boolean
}

const KEY = 'orbit:yt'
const ORIGIN = 'https://www.youtube-nocookie.com'
/** how close to an edge before the window snaps to it */
const SNAP = 14
const EDGE = 12
const MIN_W = 256
const MAX_W = 1000

export type YouTubeSrc = { video?: string; list?: string; start?: number }

const ID = /^[\w-]{11}$/
const LIST = /^(PL|UU|LL|FL|RD|OLAK5uy_)[\w-]{10,}$/

/** "1h2m3s", "90s" or plain seconds — the `t` on a shared link. */
function seconds(t: string | null): number | undefined {
  if (!t) return undefined
  if (/^\d+$/.test(t)) return Number(t)
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/)
  if (!m?.[0]) return undefined
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}

/**
 * A pasted link, a bare video id or a bare playlist id → what to play. Anything else
 * (including a non-YouTube URL) is null, and the caller treats it as a search.
 */
export function parseYouTube(text: string): YouTubeSrc | null {
  const s = text.trim()
  if (!s) return null
  if (ID.test(s)) return { video: s }
  if (LIST.test(s)) return { list: s }
  let u: URL
  try {
    u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`)
  } catch {
    return null
  }
  if (!/(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i.test(u.hostname)) return null
  const seg = u.pathname.replace(/^\/+/, '').split('/')
  let video = u.searchParams.get('v') ?? undefined
  if (/(^|\.)youtu\.be$/i.test(u.hostname)) video = seg[0]
  else if (['embed', 'shorts', 'live', 'v'].includes(seg[0] ?? '')) video = seg[1]
  if (video && !ID.test(video)) video = undefined
  const list = u.searchParams.get('list')
  const start = seconds(u.searchParams.get('t') ?? u.searchParams.get('start'))
  if (!video && !list) return null
  const out: YouTubeSrc = {}
  if (video) out.video = video
  if (list) out.list = list
  if (start) out.start = start
  return out
}

function embedUrl(src: YouTubeSrc, autoplay: boolean): string {
  const p = new URLSearchParams({
    enablejsapi: '1',
    widgetid: '1',
    origin: location.origin,
    autoplay: autoplay ? '1' : '0',
    playsinline: '1',
    rel: '0',
    modestbranding: '1',
  })
  if (src.list) p.set('list', src.list)
  if (src.start) p.set('start', String(Math.round(src.start)))
  return `${ORIGIN}/embed/${src.video ?? 'videoseries'}?${p}`
}

const watchUrl = (src: YouTubeSrc) =>
  src.video
    ? `https://www.youtube.com/watch?v=${src.video}${src.list ? `&list=${src.list}` : ''}`
    : `https://www.youtube.com/playlist?list=${src.list}`

const searchUrl = (q: string) =>
  `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`

function clock(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00'
  const t = Math.floor(s)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

const svg = (body: string, size = 14) =>
  `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const ICON = {
  play: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M5 3.4v9.2a.6.6 0 0 0 .92.5l7.2-4.6a.6.6 0 0 0 0-1l-7.2-4.6a.6.6 0 0 0-.92.5z"/></svg>',
  pause:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M4.4 3h2.2v10H4.4zM9.4 3h2.2v10H9.4z"/></svg>',
  prev: svg('<path d="M12.5 3.5v9L6 8zM4 3.5v9"/>'),
  next: svg('<path d="M3.5 3.5v9L10 8zM12 3.5v9"/>'),
  mini: svg('<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><path d="M7 9.5h5"/>'),
  full: svg('<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><path d="M6 6.5h4M6 9.5h4"/>'),
  out: svg(
    '<path d="M9 3h4v4M13 3 7.5 8.5M12.5 9.6v3a.9.9 0 0 1-.9.9H3.9a.9.9 0 0 1-.9-.9V4.9a.9.9 0 0 1 .9-.9h3"/>',
  ),
  vol: svg(
    '<path d="M8 3 4.8 5.6H2.6v4.8h2.2L8 13zM10.8 6a2.8 2.8 0 0 1 0 4M12.8 4.2a5.4 5.4 0 0 1 0 7.6"/>',
  ),
  muted: svg('<path d="M8 3 4.8 5.6H2.6v4.8h2.2L8 13zM11 6.5l3 3M14 6.5l-3 3"/>'),
}

type Saved = {
  x: number
  y: number
  w: number
  mini: boolean
  vol: number
  /** what was playing, and how far in, so reopening picks it up where it stopped */
  url: string
  t: number
  title: string
}

function restore(): Partial<Saved> {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return s && typeof s === 'object' ? s : {}
  } catch {
    return {}
  }
}

export function createYouTube(host: YouTubeHost = {}): YouTubePlayer {
  const saved = restore()
  let w = Math.min(MAX_W, Math.max(MIN_W, Math.round(Number(saved.w) || 420)))
  let mini = !!saved.mini
  let vol = Number.isFinite(Number(saved.vol)) ? Math.max(0, Math.min(100, Number(saved.vol))) : 70
  let muted = false
  let src: YouTubeSrc | null = typeof saved.url === 'string' ? parseYouTube(saved.url) : null
  if (src && Number(saved.t) > 0) src.start = Math.round(Number(saved.t))
  let playing = false
  let at = 0
  let dur = 0
  /** true while the seek bar is being dragged, so the ticking readout leaves it alone */
  let seeking = false
  let open = false

  const el = document.createElement('section')
  el.id = 'ytp'
  el.hidden = true
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-label', 'YouTube player')
  el.innerHTML = `
    <header class="yt-bar" title="Drag to move · double-click for the mini bar">
      <span class="yt-dot"></span>
      <span class="yt-title">YouTube</span>
      <button class="yt-btn yt-out" type="button" title="Watch on YouTube" aria-label="Watch on YouTube">${ICON.out}</button>
      <button class="yt-btn yt-mini" type="button" title="Mini bar (audio only)" aria-label="Mini bar">${ICON.mini}</button>
      <button class="yt-btn yt-x" type="button" title="Close (esc)" aria-label="Close">×</button>
    </header>
    <form class="yt-omni">
      <input class="yt-in" type="text" spellcheck="false" autocomplete="off"
        placeholder="paste a YouTube link, or search" aria-label="YouTube link or search"/>
      <button class="yt-go" type="submit">play</button>
    </form>
    <div class="yt-stage"><div class="yt-empty">
      <b>Nothing playing</b>
      <span>Paste a video, playlist or YouTube Music link above. Type anything else to search.</span>
    </div></div>
    <footer class="yt-foot">
      <button class="yt-btn yt-play" type="button" title="Play / pause" aria-label="Play">${ICON.play}</button>
      <button class="yt-btn yt-prev" type="button" title="Previous" aria-label="Previous">${ICON.prev}</button>
      <button class="yt-btn yt-next" type="button" title="Next" aria-label="Next">${ICON.next}</button>
      <input class="yt-seek" type="range" min="0" max="1000" value="0" aria-label="Seek"/>
      <span class="yt-time">0:00</span>
      <button class="yt-btn yt-mute" type="button" title="Mute" aria-label="Mute">${ICON.vol}</button>
      <input class="yt-vol" type="range" min="0" max="100" value="${vol}" aria-label="Volume"/>
    </footer>
    <div class="yt-rsz" role="separator" aria-label="Resize player" title="Drag to resize"></div>`
  document.body.appendChild(el)

  const $ = <T extends HTMLElement>(s: string) => el.querySelector(s) as T
  const bar = $('.yt-bar')
  const titleEl = $('.yt-title')
  if (src && typeof saved.title === 'string' && saved.title) titleEl.textContent = saved.title
  const stage = $('.yt-stage')
  const input = $<HTMLInputElement>('.yt-in')
  const playBtn = $('.yt-play')
  const muteBtn = $('.yt-mute')
  const seek = $<HTMLInputElement>('.yt-seek')
  const volIn = $<HTMLInputElement>('.yt-vol')
  const timeEl = $('.yt-time')
  let frame: HTMLIFrameElement | null = null
  let titleWait: ReturnType<typeof setTimeout> | undefined

  // ------------------------------------------------------------------ geometry ----
  const barH = 30
  /** the rows, plus the window's own top and bottom border */
  const chrome = () => 2 + (mini ? barH + 34 : barH + 34 + Math.round((w * 9) / 16) + 34)
  let x = Number(saved.x)
  let y = Number(saved.y)

  /**
   * The highest the window may go: just under the app's top bar. In the desktop shell that bar
   * is a window-drag region, and macOS takes any press over it to move the window, so a player
   * sitting on it could never be grabbed again. Measured, because the bar's height is not fixed.
   */
  const topBar = document.querySelector<HTMLElement>('body > header')
  const top = () => Math.max(EDGE, (topBar?.getBoundingClientRect().bottom ?? 0) + EDGE)

  const clamp = () => {
    // a narrow window (or a smaller screen than the one it was sized on) caps the width first,
    // because the height follows from it
    w = Math.min(w, Math.max(MIN_W, innerWidth - EDGE * 2))
    const h = chrome()
    x = Math.max(EDGE, Math.min(innerWidth - w - EDGE, x))
    // the top wins over the bottom: a window too short for the player keeps its bar reachable
    y = Math.max(top(), Math.min(innerHeight - h - EDGE, y))
  }

  function place(snap = false) {
    const h = chrome()
    if (snap) {
      if (x - EDGE < SNAP) x = EDGE
      if (innerWidth - (x + w) - EDGE < SNAP) x = innerWidth - w - EDGE
      if (y - top() < SNAP) y = top()
      if (innerHeight - (y + h) - EDGE < SNAP) y = innerHeight - h - EDGE
    }
    clamp()
    el.style.left = `${Math.round(x)}px`
    el.style.top = `${Math.round(y)}px`
    el.style.width = `${w}px`
    el.style.setProperty('--yt-stage-h', `${Math.round((w * 9) / 16)}px`)
  }

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    x = innerWidth - w - 24
    y = innerHeight - chrome() - 24
  }
  // a position saved before the top bar was off limits (or on a bigger window) is repaired
  // now, and kept, so it comes back in view without anyone clearing storage
  {
    const x0 = x
    const y0 = y
    clamp()
    if (x !== x0 || y !== y0) queueMicrotask(() => save())
  }

  const save = () => {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          x: Math.round(x),
          y: Math.round(y),
          w,
          mini,
          vol,
          url: src ? watchUrl(src) : '',
          t: Math.round(at),
          title: titleEl.textContent ?? '',
        }),
      )
    } catch {}
  }

  // --------------------------------------------------------------- the embed ----
  /** commands ride the same channel the API uses; without an iframe there is nothing to tell */
  function tell(func: string, args: unknown[] = []) {
    frame?.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func, args, id: 'ytp', channel: 'widget' }),
      ORIGIN,
    )
  }

  function listen() {
    frame?.contentWindow?.postMessage(
      JSON.stringify({ event: 'listening', id: 'ytp', channel: 'widget' }),
      ORIGIN,
    )
  }

  /** `start` false loads the embed ready but silent — what reopening the window should do */
  function play(next: YouTubeSrc, start = true) {
    src = next
    at = next.start ?? 0
    dur = 0
    playing = start
    if (start) titleEl.textContent = 'Loading…'
    // the embed reports its title over postMessage; if that never lands (an embed that will
    // not play, a blocked frame) the bar must not sit on "Loading…" for the rest of the day
    clearTimeout(titleWait)
    titleWait = setTimeout(() => {
      if (titleEl.textContent === 'Loading…') titleEl.textContent = 'YouTube'
    }, 6000)
    el.classList.add('has-src')
    frame?.remove()
    frame = document.createElement('iframe')
    frame.className = 'yt-frame'
    frame.title = 'YouTube player'
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; clipboard-write'
    frame.setAttribute('allowfullscreen', '')
    frame.referrerPolicy = 'strict-origin-when-cross-origin'
    frame.src = embedUrl(next, start)
    // the handshake only lands once the embed is up; a couple of tries covers a slow load
    frame.addEventListener('load', () => {
      listen()
      setTimeout(listen, 600)
      setTimeout(() => {
        tell('setVolume', [vol])
        if (muted) tell('mute')
      }, 700)
    })
    stage.appendChild(frame)
    paint()
    save()
  }

  /** a link plays; anything else is a search, which only the web view can answer */
  function submit(text: string) {
    const q = text.trim()
    if (!q) return
    const parsed = parseYouTube(q)
    if (parsed) {
      input.value = ''
      input.blur()
      return play(parsed)
    }
    if (host.openWeb) {
      host.openWeb(searchUrl(q))
      titleEl.textContent = `searching “${q}”`
    } else {
      window.open(searchUrl(q), '_blank', 'noopener')
    }
  }

  addEventListener('message', (e) => {
    if (e.origin !== ORIGIN || !frame || e.source !== frame.contentWindow) return
    let msg: { event?: string; info?: Record<string, unknown> }
    try {
      msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
    } catch {
      return
    }
    if (msg?.event === 'onReady') {
      tell('setVolume', [vol])
      if (muted) tell('mute')
    }
    const info = msg?.info
    if (!info) return
    if (typeof info.playerState === 'number') playing = info.playerState === 1
    if (typeof info.duration === 'number' && info.duration > 0) dur = info.duration
    if (typeof info.currentTime === 'number') at = info.currentTime
    const data = info.videoData as { title?: string } | undefined
    if (data?.title) {
      clearTimeout(titleWait)
      titleEl.textContent = data.title
    }
    if (typeof info.volume === 'number' && !Number.isNaN(info.volume)) {
      vol = Math.round(info.volume)
      if (document.activeElement !== volIn) volIn.value = String(vol)
    }
    if (typeof info.muted === 'boolean') muted = info.muted
    paint()
  })

  // ------------------------------------------------------------------ painting ----
  function paint() {
    el.classList.toggle('mini', mini)
    el.classList.toggle('playing', playing)
    playBtn.innerHTML = playing ? ICON.pause : ICON.play
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play')
    muteBtn.innerHTML = muted || vol === 0 ? ICON.muted : ICON.vol
    muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute')
    $('.yt-mini').innerHTML = mini ? ICON.full : ICON.mini
    $('.yt-mini').setAttribute('aria-label', mini ? 'Full player' : 'Mini bar')
    timeEl.textContent = dur ? `${clock(at)} / ${clock(dur)}` : clock(at)
    if (!seeking) seek.value = String(dur ? Math.round((at / dur) * 1000) : 0)
    seek.disabled = !dur
    place()
  }

  // the readout only arrives while something is playing; between beats the clock still moves
  // it runs only while the player is open, and not while the window is hidden
  let last = performance.now()
  let stopClock: (() => void) | null = null
  const clockTick = () => {
    const t = performance.now()
    const dt = (t - last) / 1000
    last = t
    if (!open || !playing || !dur) return
    at = Math.min(dur, at + dt)
    if (!seeking) seek.value = String(Math.round((at / dur) * 1000))
    timeEl.textContent = `${clock(at)} / ${clock(dur)}`
  }

  // -------------------------------------------------------------------- drag ----
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    const dx = e.clientX - x
    const dy = e.clientY - y
    const id = e.pointerId
    el.classList.add('dragging')
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      x = ev.clientX - dx
      y = ev.clientY - dy
      place(true)
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      el.classList.remove('dragging')
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
      save()
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  })
  bar.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('button')) return
    setMini(!mini)
  })

  // ------------------------------------------------------------------ resize ----
  $('.yt-rsz').addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const x0 = e.clientX
    const w0 = w
    const id = e.pointerId
    el.classList.add('dragging')
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      w = Math.max(MIN_W, Math.min(MAX_W, Math.round(w0 + (ev.clientX - x0))))
      place()
    }
    const up = () => {
      el.classList.remove('dragging')
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
      save()
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  })

  function setMini(on: boolean) {
    mini = on
    // the window grows upward from where it sits, so the bar does not jump off the bottom
    const before = chrome()
    paint()
    y += before - chrome()
    place()
    save()
  }

  // ----------------------------------------------------------------- controls ----
  $('.yt-omni').addEventListener('submit', (e) => {
    e.preventDefault()
    submit(input.value)
  })
  $('.yt-x').addEventListener('click', () => close())
  $('.yt-mini').addEventListener('click', () => setMini(!mini))
  $('.yt-out').addEventListener('click', () => {
    if (!src) return
    const url = watchUrl(src)
    if (host.openWeb) host.openWeb(url)
    else window.open(url, '_blank', 'noopener')
  })
  playBtn.addEventListener('click', () => {
    if (!src) return input.focus()
    playing = !playing
    tell(playing ? 'playVideo' : 'pauseVideo')
    paint()
  })
  $('.yt-prev').addEventListener('click', () => tell('previousVideo'))
  $('.yt-next').addEventListener('click', () => tell('nextVideo'))
  muteBtn.addEventListener('click', () => {
    muted = !muted
    tell(muted ? 'mute' : 'unMute')
    paint()
  })
  volIn.addEventListener('input', () => {
    vol = Number(volIn.value)
    if (muted && vol > 0) {
      muted = false
      tell('unMute')
    }
    tell('setVolume', [vol])
    paint()
  })
  volIn.addEventListener('change', save)
  seek.addEventListener('pointerdown', () => {
    seeking = true
  })
  const endSeek = () => {
    if (!seeking) return
    seeking = false
    if (!dur) return
    at = (Number(seek.value) / 1000) * dur
    tell('seekTo', [at, true])
    paint()
  }
  seek.addEventListener('pointerup', endSeek)
  seek.addEventListener('change', endSeek)

  // the player's own keys stay its own: the app's single-key shortcuts must not fire here
  el.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      if (document.activeElement === input && input.value) {
        input.value = ''
        return
      }
      input.blur()
      close()
    }
  })

  addEventListener('resize', () => {
    if (open) place()
  })
  // the top bar can change height without the window resizing (it wraps, or a mode hides it)
  if (topBar)
    new ResizeObserver(() => {
      if (open) place()
    }).observe(topBar)

  // ------------------------------------------------------------------- opening ----
  function show(what?: string) {
    open = true
    last = performance.now()
    stopClock ??= activity.every(500, clockTick, { away: 'full', now: false })
    el.hidden = false
    place()
    paint()
    if (what) submit(what)
    else if (!src) setTimeout(() => input.focus(), 30)
    announce()
  }

  /**
   * Closing stops the audio: the iframe goes, rather than playing on from a window that is
   * not there. What was playing is remembered, so opening again brings it back.
   */
  function close() {
    open = false
    playing = false
    stopClock?.()
    stopClock = null
    el.hidden = true
    frame?.remove()
    frame = null
    save()
    paint()
    announce()
  }

  const announce = () => dispatchEvent(new CustomEvent('laika:youtube-open', { detail: open }))

  /** Opening again brings back what was playing — loaded where it stopped, but not started. */
  function reopen(what?: string) {
    show(what)
    if (!what && src && !frame) play(src, false)
  }

  return {
    open: reopen,
    close,
    toggle: () => (open ? close() : reopen()),
    isOpen: () => open,
  }
}
