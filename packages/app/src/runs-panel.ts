/**
 * Runs, as a panel.
 *
 * The views in runs.ts draw no chrome, so this is all it takes to put them inside a panel: one
 * mount that keeps the little stack of list → run → compare, and a back step that pops it. The
 * panel system brings the rail button, the palette entry, the `r` key, the width and the slide.
 * The /runs page shows the same views for a browser tab, and for the live-progress skill's link.
 */
import { type PanelHandle, registerPanel } from './panels.ts'
import { mountCompare, mountRun, mountRunList } from './runs.js'

export type RunsView =
  | { at: 'list' }
  | { at: 'run'; id: string }
  | { at: 'compare'; id: string; group: string }

/** the panel's whole contents: whichever view is on top of the stack, swapped in place */
export function mountRunsPanel(host: HTMLElement, initial: RunsView = { at: 'list' }) {
  let view = initial
  let dispose: (() => void) | undefined

  const show = (next: RunsView) => {
    view = next
    dispose?.()
    host.innerHTML = ''
    if (view.at === 'run')
      dispose = mountRun(host, view.id, {
        onBack: () => show({ at: 'list' }),
        onCompare: (id, group) => show({ at: 'compare', id, group }),
      })
    else if (view.at === 'compare') {
      const { id, group } = view
      dispose = mountCompare(host, id, group, { onBack: () => show({ at: 'run', id }) })
    } else dispose = mountRunList(host, { onOpen: (id) => show({ at: 'run', id }), title: false })
  }

  show(view)
  return () => {
    dispose?.()
    host.innerHTML = ''
  }
}

/** the rail glyph: three lanes, each with its progress */
const ICON =
  '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h14M3 10h14M3 15h14" opacity=".35"/><path d="M3 5h9M3 10h12M3 15h5"/><circle cx="12" cy="5" r="1.4" fill="currentColor"/><circle cx="15" cy="10" r="1.4" fill="currentColor"/><circle cx="8" cy="15" r="1.4" fill="currentColor"/></svg>'

let panel: PanelHandle | null = null
/** the view stack's `show`, so a deep link can land on one run in a panel already open */
let land: ((v: RunsView) => void) | null = null
let dispose: (() => void) | undefined

/**
 * Runs in the dock: `r`, the rail's Runs button, or "Runs" / "progress" in the palette. The
 * list, one run and the compare view are one panel with a back step, not three.
 */
export function registerRunsPanel() {
  panel ??= registerPanel({
    id: 'runs',
    title: 'Runs',
    group: 'fleet',
    key: 'r',
    icon: ICON,
    width: { min: 380, default: 600, snaps: [480, 600, 900] },
    terms:
      'runs progress lanes jobs eta gauntlet artefacts artifacts verdicts stalled compare waves tracker',
    hint: "every chat's runs: lanes, artefacts, verdicts, stalls",
    mount: (host) => {
      land = (v) => {
        dispose?.()
        dispose = mountRunsPanel(host, v)
      }
      land({ at: 'list' })
      return () => dispose?.()
    },
    onOpen: (arg) => {
      const id = typeof arg === 'string' ? arg : undefined
      if (id) land?.({ at: 'run', id })
    },
  })
  // a chat's run strip, the conductor's timeline or a notification can all deep-link here
  addEventListener('laika:runs-open', (e) => {
    const id = (e as CustomEvent<{ id?: string }>).detail?.id
    e.preventDefault()
    panel?.open(id)
  })
  return panel
}

/**
 * Open a run wherever there is somewhere to open it: the panel when this page has one (it answers
 * the event), otherwise the /runs page.
 */
export function openRunsPanel(id?: string) {
  const ev = new CustomEvent('laika:runs-open', { detail: { id }, cancelable: true })
  const taken = !window.dispatchEvent(ev)
  if (!taken)
    window.open(id ? `/runs#run/${encodeURIComponent(id)}` : '/runs', '_blank', 'noopener')
}
