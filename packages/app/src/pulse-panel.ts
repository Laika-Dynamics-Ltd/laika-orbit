/**
 * The Pulse window: the adoption node network inside Laika Orbit, and the rail button that opens
 * it — both shown only on the operator's own machine.
 *
 * The window frames /pulse.html rather than re-drawing the scene, the same way the Mission window
 * frames its panel: one renderer, one set of shaders, one place a change lands. The frame is made
 * on first open and kept, so the camera you left the tunnel at is still there when you come back.
 *
 * WHO SEES IT: /api/pulse/access answers from the server's own credentials (see pulse-api.mjs).
 * A public build has none, so the button never mounts and the routes behind it 404. That hides
 * the door; what actually keeps the numbers private is that a user's own store is empty and the
 * tokens to fill it are not on their machine.
 *
 * The button is re-attached whenever the rail re-renders, because renderOS() in main.ts replaces
 * the rail's HTML wholesale every refresh and would otherwise sweep it away.
 */
import './pulse-panel.css'

let overlay: HTMLDivElement | null = null
let frame: HTMLIFrameElement | null = null

export const isPulseOpen = () => overlay?.classList.contains('on') ?? false

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !isPulseOpen()) return
  e.stopImmediatePropagation()
  closePulse()
}

export function closePulse() {
  overlay?.classList.remove('on')
  removeEventListener('keydown', onKey, true)
  dispatchEvent(new CustomEvent('laika:pulse-open', { detail: false }))
}

export function openPulse() {
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = 'pw'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-label', 'Adoption pulse')
    overlay.innerHTML = `
      <div class="pw-win">
        <header class="pw-bar">
          <b>Adoption pulse</b>
          <span class="pw-tag">operator only</span>
          <div class="pw-sp"></div>
          <a class="pw-pop" href="/pulse.html" target="_blank" rel="noopener" title="Open in its own window">↗</a>
          <button class="pw-close" type="button" title="Close (esc)" aria-label="Close">×</button>
        </header>
      </div>`
    // the window's own chrome must not leak keys into Orbit's single-key shortcuts
    overlay.addEventListener('keydown', (e) => e.stopPropagation())
    overlay.querySelector('.pw-close')?.addEventListener('click', () => closePulse())
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closePulse() // click the backdrop to dismiss
    })
    document.body.appendChild(overlay)
  }
  if (!frame) {
    frame = document.createElement('iframe')
    frame.className = 'pw-frame'
    frame.title = 'Adoption pulse'
    frame.src = '/pulse.html'
    overlay.querySelector('.pw-win')?.append(frame)
  }
  overlay.classList.add('on')
  addEventListener('keydown', onKey, true)
  dispatchEvent(new CustomEvent('laika:pulse-open', { detail: true }))
}

/** The rail button, kept at the top of the left rail through every re-render. */
function mountRailButton() {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.id = 'pulse-rail'
  btn.className = 'pu-rail'
  btn.title = 'Adoption pulse — who is arriving (operator only)'
  // a small constellation: an outer shell of arrivals narrowing to a lit core
  btn.innerHTML = `
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1" opacity=".38"/>
      <circle cx="8" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="1" opacity=".62"/>
      <circle cx="8" cy="8" r="1.5" fill="currentColor"/>
      <circle cx="8" cy="1.6" r="1.15" fill="currentColor" opacity=".85"/>
      <circle cx="14.4" cy="10" r="1" fill="currentColor" opacity=".6"/>
      <circle cx="3" cy="12.4" r="1" fill="currentColor" opacity=".6"/>
    </svg>
    <span>Pulse</span>`
  btn.addEventListener('click', () => (isPulseOpen() ? closePulse() : openPulse()))

  const rail = document.getElementById('rail-l')
  if (!rail) return
  const attach = () => {
    if (rail.firstElementChild !== btn) rail.prepend(btn)
  }
  attach()
  // renderOS() replaces the rail's innerHTML on every widget refresh; put the button back
  new MutationObserver(attach).observe(rail, { childList: true })
}

async function init() {
  try {
    const res = await fetch('/api/pulse/access')
    if (!res.ok) return
    const { operator } = await res.json()
    if (operator) mountRailButton()
  } catch {
    // no access route, no button: a build without the pulse routes is simply a build without it
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => void init())
  else void init()
}
