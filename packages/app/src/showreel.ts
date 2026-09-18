/**
 * The Showreel window: Showreel Studio (script, voice, film, setup) inside Laika Orbit.
 *
 * The studio's page is laika-showreel's own, loaded from that checkout and drawn in a shadow
 * root, so its styles and Laika Orbit's cannot reach each other. showreel-embed.css maps its colours
 * onto the active theme and turns its scrolling page into a window. The API is the server's
 * /api/showreel mount.
 */
import './showreel.css'
import embedCss from './showreel-embed.css?inline'

let overlay: HTMLDivElement | null = null
let studio: { refresh(): Promise<void> } | null = null

export const isShowreelOpen = () => overlay?.classList.contains('on') ?? false
const announce = () =>
  dispatchEvent(new CustomEvent('laika:showreel-open', { detail: isShowreelOpen() }))

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !isShowreelOpen()) return
  // the projects dialog closes itself first
  if (overlay?.querySelector('.sr-host')?.shadowRoot?.querySelector('dialog[open]')) return
  e.stopImmediatePropagation()
  closeShowreel()
}

export function closeShowreel() {
  overlay?.classList.remove('on')
  removeEventListener('keydown', onKey, true)
  announce()
}

async function load(win: HTMLElement) {
  const host = document.createElement('div')
  host.className = 'sr-host'
  const shadow = host.attachShadow({ mode: 'open' })
  try {
    const probe = await fetch('/api/showreel/state')
    if (!probe.ok)
      throw new Error((await probe.json().catch(() => ({}))).error ?? `${probe.status}`)
    const [{ mount }, { default: css }] = await Promise.all([
      import('@showreel/studio/app.js'),
      import('@showreel/studio/style.css?inline'),
    ])
    const app = document.createElement('div')
    app.className = 'app'
    shadow.innerHTML = `<style>${css}\n${embedCss}</style>`
    shadow.append(app)
    win.prepend(host)
    studio = mount(app, { apiBase: '/api/showreel' })
  } catch (e) {
    const msg = document.createElement('p')
    msg.className = 'sr-missing'
    msg.textContent = `Showreel Studio could not load. ${e instanceof Error ? e.message : String(e)}`
    win.prepend(msg)
  }
}

export function openShowreel() {
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = 'sr'
    overlay.innerHTML =
      '<div class="sr-win"><button class="sr-x" type="button" title="Close (esc)" aria-label="Close">×</button></div>'
    const win = overlay.querySelector<HTMLElement>('.sr-win')!
    win.querySelector('.sr-x')!.addEventListener('click', closeShowreel)
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) closeShowreel()
    })
    // typing in the studio must not reach Laika Orbit's single-key shortcuts, which see the shadow
    // host rather than the field
    overlay.addEventListener('keydown', (e) => e.stopPropagation())
    document.body.appendChild(overlay)
    void load(win)
  } else {
    void studio?.refresh()
  }
  overlay.classList.add('on')
  addEventListener('keydown', onKey, true)
  announce()
}
