import './drop.css'
import { type PanelHandle, registerPanel } from './panels.ts'

/**
 * The drop zone, as a panel: drag a file onto it, pick one of the Orbits on the network, watch it
 * go. The other half — a file someone else is offering this machine — arrives in the same panel
 * as a question with two buttons, because nothing is written here until one of them is pressed.
 *
 * All of it is polled from /api/drop/state (drop-api.mjs) rather than pushed: the panel is a
 * handful of short lists, the poll is on loopback, and it drops to a slow beat when nothing is
 * moving. The rail badge keeps ticking over on its own so an offer arriving while the panel is
 * closed still lights the button.
 */
type Peer = { id: string; name: string; host: string; port: number }
type Offer = {
  id: string
  from: { id: string; name: string; address: string }
  file: { name: string; size: number }
  state: 'pending' | 'accepted' | 'receiving' | 'done' | 'declined' | 'expired' | 'failed'
  received?: number
  saved?: string
  error?: string
}
type Send = {
  id: string
  to: { id: string; name: string }
  file: { name: string; size: number }
  sent: number
  state: 'spooling' | 'waiting' | 'sending' | 'done' | 'failed'
  saved?: string
  error?: string
}
type State = {
  me: { id: string; name: string }
  inbox: string
  port: number
  peers: Peer[]
  offers: Offer[]
  sends: Send[]
  error?: string
}

const ICON =
  '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.6v8.2"/><path d="m6.9 7.9 3.1 3.1 3.1-3.1"/><path d="M3.2 12.4v3a2 2 0 0 0 2 2h9.6a2 2 0 0 0 2-2v-3"/></svg>'

const fmt = (n: number) => {
  if (!Number.isFinite(n)) return ''
  for (const [unit, size] of [
    ['GB', 1e9],
    ['MB', 1e6],
    ['kB', 1e3],
  ] as const)
    if (n >= size) return `${(n / size).toFixed(n / size < 10 ? 1 : 0)} ${unit}`
  return `${n} B`
}
const esc = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`)
const pct = (done: number, all: number) => (all > 0 ? Math.min(100, Math.round((done / all) * 100)) : 0)

/** offers waiting on an answer, for the rail badge — the one thing that matters when the panel is shut */
let waiting = 0
let panel: PanelHandle | null = null

async function ask(path: string, init?: RequestInit) {
  const r = await fetch(path, init)
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error ?? `the drop zone answered ${r.status}`)
  return body
}

function mountDrop(host: HTMLElement) {
  host.classList.add('dz')
  host.innerHTML = `
    <div class="dz-me"><span class="dz-name"></span><button class="dz-inbox" type="button" title="Show the inbox in the Finder"></button></div>
    <div class="dz-zone" tabindex="0"><p class="dz-hint">Drop a file here</p></div>
    <div class="dz-list dz-offers"></div>
    <div class="dz-list dz-peers"></div>
    <div class="dz-list dz-sends"></div>`
  const q = <T extends HTMLElement>(sel: string) => host.querySelector(sel) as T
  const zone = q<HTMLDivElement>('.dz-zone')
  const nameEl = q<HTMLSpanElement>('.dz-name')
  const inboxBtn = q<HTMLButtonElement>('.dz-inbox')
  const offersEl = q<HTMLDivElement>('.dz-offers')
  const peersEl = q<HTMLDivElement>('.dz-peers')
  const sendsEl = q<HTMLDivElement>('.dz-sends')

  /** the file the person has dropped and not yet sent anywhere; the panel is waiting for a peer */
  let held: File | null = null
  /** the last thing that went wrong here, shown until the next thing happens */
  let trouble = ''
  let state: State | null = null
  let timer = 0
  let visible = true
  let stopped = false

  const busy = () => Boolean(held) || Boolean(state?.sends.some((s) => s.state === 'sending' || s.state === 'waiting' || s.state === 'spooling')) || Boolean(state?.offers.some((o) => o.state === 'pending' || o.state === 'receiving'))

  const schedule = () => {
    clearTimeout(timer)
    if (stopped || !visible) return
    timer = window.setTimeout(refresh, busy() ? 600 : 2500)
  }

  async function refresh() {
    try {
      state = await ask('/api/drop/state')
      waiting = state?.offers.filter((o) => o.state === 'pending').length ?? 0
      panel?.refreshBadge()
    } catch (e) {
      state = { me: { id: '', name: '' }, inbox: '', port: 0, peers: [], offers: [], sends: [], error: String((e as Error).message) }
    }
    render()
    schedule()
  }

  function render() {
    if (!state) return
    nameEl.textContent = state.error ? state.error : `You are ${state.me.name} · files land in`
    inboxBtn.textContent = state.inbox.split('/').pop() ?? 'Orbit Drops'
    inboxBtn.hidden = Boolean(state.error)

    zone.classList.toggle('held', Boolean(held))
    zone.classList.toggle('bad', Boolean(trouble))
    q<HTMLParagraphElement>('.dz-hint').innerHTML = trouble
      ? `<b>${esc(trouble)}</b><button class="dz-drop-cancel" type="button">Try again</button>`
      : held
        ? `<b>${esc(held.name)}</b><span>${fmt(held.size)} · pick where it goes</span><button class="dz-drop-cancel" type="button">Not this one</button>`
        : 'Drop a file here'

    const pending = state.offers.filter((o) => o.state === 'pending' || o.state === 'receiving')
    const lately = state.offers.filter((o) => o.state === 'done').slice(0, 3)
    offersEl.innerHTML = [
      pending.length || lately.length ? '<h4>Coming in</h4>' : '',
      ...pending.map((o) =>
        o.state === 'receiving'
          ? row(`${esc(o.file.name)}`, `from ${esc(o.from.name)}`, bar(pct(o.received ?? 0, o.file.size)))
          : row(
              `${esc(o.file.name)}`,
              `${esc(o.from.name)} · ${fmt(o.file.size)}`,
              `<span class="dz-ask"><button type="button" class="dz-yes" data-yes="${o.id}">Accept</button><button type="button" class="dz-no" data-no="${o.id}">Decline</button></span>`,
            ),
      ),
      ...lately.map((o) => row(esc(o.saved ?? o.file.name), `from ${esc(o.from.name)}`, '<span class="dz-ok">saved</span>')),
    ].join('')

    peersEl.innerHTML = [
      `<h4>On this network${state.peers.length ? '' : ' <em>— nobody yet</em>'}<button class="dz-again" type="button">Look again</button></h4>`,
      ...state.peers.map(
        (p) =>
          `<button class="dz-peer" type="button" data-peer="${p.id}"${held ? '' : ' disabled'}><b>${esc(p.name)}</b><small>${esc(p.host)}</small>${held ? '<span class="dz-go">Send</span>' : ''}</button>`,
      ),
    ].join('')

    sendsEl.innerHTML = state.sends.length
      ? [
          '<h4>Going out</h4>',
          ...state.sends.map((s) =>
            row(
              esc(s.file.name),
              `to ${esc(s.to.name)}${s.state === 'waiting' ? ' · waiting for them to accept' : s.state === 'failed' ? ` · ${esc(s.error ?? 'failed')}` : ''}`,
              s.state === 'done' ? '<span class="dz-ok">sent</span>' : s.state === 'failed' ? '<span class="dz-bad">stopped</span>' : bar(s.state === 'sending' ? pct(s.sent, s.file.size) : 0),
            ),
          ),
        ].join('')
      : ''
  }

  const row = (title: string, sub: string, right: string) => `<div class="dz-row"><div class="dz-what"><b>${title}</b><small>${sub}</small></div>${right}</div>`
  const bar = (p: number) => `<span class="dz-bar" role="progressbar" aria-valuenow="${p}"><i style="width:${p}%"></i></span>`

  // the drop target: the panel only ever takes files, and only one at a time for now
  const over = (on: boolean) => (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    zone.classList.toggle('over', on)
  }
  host.addEventListener('dragenter', over(true))
  host.addEventListener('dragover', over(true))
  // a dragleave fires for every child the pointer crosses; only the one that leaves the panel counts
  host.addEventListener('dragleave', (e) => {
    if (!host.contains(e.relatedTarget as Node | null)) zone.classList.remove('over')
  })
  host.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0]
    if (!file) return
    e.preventDefault()
    zone.classList.remove('over')
    held = file
    trouble = ''
    render()
    refresh()
  })

  host.addEventListener('click', async (e) => {
    const el = e.target as HTMLElement
    const hit = (attr: string) => el.closest<HTMLElement>(`[data-${attr}]`)?.dataset[attr]
    if (el.closest('.dz-drop-cancel')) {
      held = null
      trouble = ''
      return render()
    }
    if (el.closest('.dz-again')) {
      await ask('/api/drop/peers/refresh', { method: 'POST' }).catch(() => {})
      return refresh()
    }
    if (el.closest('.dz-inbox')) return void ask('/api/drop/reveal', { method: 'POST' }).catch(() => {})
    const yes = hit('yes')
    const no = hit('no')
    if (yes || no) {
      await ask(`/api/drop/offers/${yes ?? no}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accept: Boolean(yes) }) }).catch(() => {})
      return refresh()
    }
    const peer = hit('peer')
    if (peer && held) {
      const file = held
      held = null
      render()
      await ask(`/api/drop/send?to=${encodeURIComponent(peer)}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file }).catch((e2: Error) => {
        trouble = e2.message
        held = file
      })
      refresh()
    }
  })

  refresh()
  return {
    setVisible(on: boolean) {
      visible = on
      if (on) refresh()
      else clearTimeout(timer)
    },
    dispose() {
      stopped = true
      clearTimeout(timer)
    },
  }
}

let live: ReturnType<typeof mountDrop> | null = null

panel = registerPanel({
  id: 'drop',
  title: 'Drop',
  group: 'fleet',
  chord: 'alt+meta+KeyD',
  icon: ICON,
  width: { min: 320, default: 420, snaps: [360, 420, 560] },
  terms: 'drop zone airdrop send file transfer share peer lan network receive inbox',
  hint: 'send a file to another Orbit on this network',
  mount: (host) => {
    live = mountDrop(host)
    return () => {
      live?.dispose()
      live = null
    }
  },
  onVisible: (on) => live?.setVisible(on),
  badge: () => (waiting ? { count: waiting, tone: 'warn' } : 0),
})

// someone can offer this machine a file at any moment, so the badge keeps its own slow beat even
// with the panel shut; the panel's own faster poll takes over while it is open
setInterval(async () => {
  if (panel?.isOpen()) return
  try {
    const { offers } = await (await fetch('/api/drop/offers')).json()
    waiting = (offers ?? []).filter((o: Offer) => o.state === 'pending').length
    panel?.refreshBadge()
  } catch {}
}, 6000)

export const openDrop = () => panel?.open()
