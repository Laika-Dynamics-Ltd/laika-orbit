/**
 * /runs — every chat's runs on one page: the list across all projects, one run, or two artefacts
 * side by side, picked by the address bar so a row can be linked to from anywhere.
 *
 *   #                       the run list
 *   #run/<id>               that run: lanes, jobs, artefacts, verdicts, waves
 *   #compare/<id>/<group>   the artefacts in that compare group, beside each other
 *
 * The views themselves live in runs.ts and draw no chrome, because the sliding-panel host shows
 * the same ones (runs-panel.ts). This file is only the page around them.
 */
import './themes.css'
import {
  mountCompare,
  mountRun,
  mountRunList,
  mountStrip,
  type Run,
  type State,
  span,
  subscribe,
  why,
} from './runs.js'

const root = document.getElementById('pg') as HTMLElement
root.innerHTML = `
  <header class="rn-top">
    <div class="rn-brand"><span class="rn-brand-dot"></span><b>Runs</b></div>
    <div class="rn-right">
      <span class="rn-feed" data-el="feed"></span>
      <button class="rn-btn" data-el="notify" hidden>Notify me of stalls</button>
      <a class="rn-btn ghost" href="/control">Agent control →</a>
    </div>
  </header>
  <div class="rn-banner" data-el="banner" hidden></div>
  <main class="rn-main" data-el="main"></main>`

const el = (n: string) => root.querySelector(`[data-el="${n}"]`) as HTMLElement
const main = el('main')

// ─── the address bar picks the view ─────────────────────────────────────────────────────────────

let dispose: (() => void) | undefined
const go = (hash: string) => {
  window.location.hash = hash
}

function route() {
  dispose?.()
  main.innerHTML = ''
  const [what, id, group] = window.location.hash
    .replace(/^#/, '')
    .split('/')
    .map(decodeURIComponent)
  if (what === 'run' && id)
    dispose = mountRun(main, id, {
      onBack: () => go(''),
      onCompare: (r, g) => go(`compare/${encodeURIComponent(r)}/${encodeURIComponent(g)}`),
    })
  else if (what === 'compare' && id && group)
    dispose = mountCompare(main, id, group, { onBack: () => go(`run/${encodeURIComponent(id)}`) })
  else dispose = mountRunList(main, { onOpen: (r) => go(`run/${encodeURIComponent(r)}`) })
}

window.addEventListener('hashchange', route)
route()

// ─── the page's own furniture: is the data live, and tell me when something stalls ───────────────

let runs: Run[] = []
let seen: Map<string, State> | null = null

subscribe((f) => {
  runs = f.runs
  const banner = el('banner')
  banner.hidden = !f.error
  if (f.error)
    banner.textContent = `Can't reach the app (${f.error}). ${f.lastOk ? `Showing what it said ${span(Date.now() - f.lastOk)} ago; ` : ''}retrying.`
  const quiet = f.lastOk ? Date.now() - f.lastOk : 0
  const feed = el('feed')
  feed.textContent = f.lastOk ? (quiet < 8000 ? 'live' : `last data ${span(quiet)} ago`) : ''
  feed.className = `rn-feed${quiet && quiet < 8000 ? ' ok' : ' bad'}`
  notify()
})

/** a run that stalls or whose chat died is the one thing worth interrupting for */
function notify() {
  if (seen && 'Notification' in window && Notification.permission === 'granted') {
    for (const r of runs) {
      if ((r.state !== 'stalled' && r.state !== 'orphaned') || seen.get(r.id) === r.state) continue
      const n = new Notification(
        r.state === 'stalled' ? `Stalled: ${r.title}` : `Chat ended: ${r.title}`,
        {
          body: why(r).replace(/<[^>]+>/g, ''),
          tag: `run-${r.id}`,
        },
      )
      n.onclick = () => {
        window.focus()
        go(`run/${encodeURIComponent(r.id)}`)
      }
    }
  }
  seen = new Map(runs.map((r) => [r.id, r.state]))
}

const notifyBtn = el('notify')
const syncNotify = () => {
  notifyBtn.hidden = !('Notification' in window) || Notification.permission !== 'default'
}
notifyBtn.addEventListener('click', async () => {
  await Notification.requestPermission().catch(() => {})
  syncNotify()
})
syncNotify()

// the strip is the same view a chat shows inline; keeping it exported here proves it mounts alone
export { mountStrip }
