import './drop.css'
import { type PanelHandle, registerPanel } from './panels.ts'

/**
 * The drop zone, as a panel: drag files onto it, pick one of the Orbits on the network, watch them
 * go. The other half — what someone else is offering this machine — arrives in the same panel as a
 * question with two buttons, because nothing is written here until one of them is pressed.
 *
 * A drop of many files, or of a folder, is one question and one answer: the panel declares how
 * many files and how many bytes before it sends any of them, the far end shows that, and holds the
 * sender to it. So the row you accept is the row you get.
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
  file: { name: string; size: number; rel: string | null }
  batch: string | null
  state: 'pending' | 'accepted' | 'receiving' | 'done' | 'declined' | 'expired' | 'failed'
  /** how much of this file is already here from an attempt that stopped half way */
  have?: number
  received?: number
  saved?: string
  error?: string
}
type Batch = {
  id: string
  name: string | null
  count: number
  size: number
  files: number
  answered: boolean | null
}
type Send = {
  id: string
  to: { id: string; name: string }
  file: { name: string; size: number; rel: string | null }
  batch: string | null
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
  batches: Batch[]
  sends: Send[]
  error?: string
}
/** a file the person has dropped and not yet sent, with its path inside a dropped folder */
type Held = { file: File; rel: string | null }

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
const pct = (done: number, all: number) =>
  all > 0 ? Math.min(100, Math.round((done / all) * 100)) : 0
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** drops waiting on an answer — a folder of 300 files is one question, so it is one on the badge */
const pendingDrops = (offers: Offer[]) =>
  new Set(offers.filter((o) => o.state === 'pending').map((o) => o.batch ?? o.id)).size
/** what the rail badge shows: the one thing that matters when the panel is shut */
let waiting = 0
let panel: PanelHandle | null = null

async function ask(path: string, init?: RequestInit) {
  const r = await fetch(path, init)
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error ?? `the drop zone answered ${r.status}`)
  return body
}

/**
 * What was dropped, as a flat list of files that remember where they sat. A folder arrives as a
 * directory entry rather than a file, and has to be walked; the entries must be taken while the
 * drop event is still live, which is why they come in already read.
 */
async function filesFrom(entries: (FileSystemEntry | null)[], fallback: FileList | undefined) {
  const held: Held[] = []
  const fileOf = (e: FileSystemFileEntry) => new Promise<File>((ok, no) => e.file(ok, no))
  const readAll = async (reader: FileSystemDirectoryReader) => {
    const all: FileSystemEntry[] = []
    for (;;) {
      const some = await new Promise<FileSystemEntry[]>((ok, no) => reader.readEntries(ok, no))
      if (!some.length) return all
      all.push(...some)
    }
  }
  const walk = async (entry: FileSystemEntry, prefix: string) => {
    if (entry.isFile) {
      const file = await fileOf(entry as FileSystemFileEntry)
      held.push({ file, rel: prefix ? `${prefix}/${file.name}` : null })
    } else if (entry.isDirectory) {
      const under = prefix ? `${prefix}/${entry.name}` : entry.name
      for (const child of await readAll((entry as FileSystemDirectoryEntry).createReader()))
        await walk(child, under)
    }
  }
  for (const e of entries) if (e) await walk(e, '')
  // a browser that gave no entries still gave files
  if (!held.length && fallback) for (const file of fallback) held.push({ file, rel: null })
  return held.slice(0, 2000)
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

  /** what has been dropped and not yet sent anywhere; the panel is waiting for a peer to be picked */
  let held: Held[] = []
  /** the last drop that was sent, so one that stopped can be picked up where it left off */
  let lastSent: { peer: string; list: Held[] } | null = null
  /** the last thing that went wrong here, shown until the next thing happens */
  let trouble = ''
  let state: State | null = null
  let timer = 0
  let visible = true
  let stopped = false

  const moving = (s: State | null) =>
    Boolean(
      s?.sends.some(
        (x) => x.state === 'sending' || x.state === 'waiting' || x.state === 'spooling',
      ),
    ) ||
    Boolean(
      s?.offers.some(
        (o) => o.state === 'pending' || o.state === 'receiving' || o.state === 'accepted',
      ),
    )

  const schedule = () => {
    clearTimeout(timer)
    if (stopped || !visible) return
    timer = window.setTimeout(refresh, held.length || moving(state) ? 600 : 2500)
  }

  async function refresh() {
    try {
      state = await ask('/api/drop/state')
      waiting = pendingDrops(state?.offers ?? [])
      panel?.refreshBadge()
    } catch (e) {
      state = {
        me: { id: '', name: '' },
        inbox: '',
        port: 0,
        peers: [],
        offers: [],
        batches: [],
        sends: [],
        error: String((e as Error).message),
      }
    }
    render()
    schedule()
  }

  const row = (title: string, sub: string, right: string) =>
    `<div class="dz-row"><div class="dz-what"><b>${title}</b><small>${sub}</small></div>${right}</div>`
  const bar = (p: number) =>
    `<span class="dz-bar" role="progressbar" aria-valuenow="${p}"><i style="width:${p}%"></i></span>`
  /** the top folder of a drop, when everything in it came from one */
  const folderOf = (list: Held[]) => {
    const tops = new Set(list.map((h) => h.rel?.split('/')[0] ?? ''))
    return (tops.size === 1 && [...tops][0]) || null
  }
  const heldLabel = () => {
    const bytes = held.reduce((n, h) => n + h.file.size, 0)
    const folder = folderOf(held)
    if (held.length === 1) return { name: held[0]?.file.name ?? '', sub: fmt(bytes) }
    return {
      name: folder ?? plural(held.length, 'file'),
      sub: `${folder ? `${plural(held.length, 'file')} · ` : ''}${fmt(bytes)}`,
    }
  }

  /** one line per drop: a lone file on its own, a batch as the single thing it was offered as */
  function groups<T extends { batch: string | null; id: string }>(list: T[]) {
    const out = new Map<string, T[]>()
    for (const x of list) {
      const key = x.batch ?? x.id
      out.set(key, [...(out.get(key) ?? []), x])
    }
    return [...out]
  }

  function render() {
    if (!state) return
    nameEl.textContent = state.error ? state.error : `You are ${state.me.name} · files land in`
    inboxBtn.textContent = state.inbox.split('/').pop() ?? 'Orbit Drops'
    inboxBtn.hidden = Boolean(state.error)

    zone.classList.toggle('held', held.length > 0)
    zone.classList.toggle('bad', Boolean(trouble))
    const label = heldLabel()
    q<HTMLParagraphElement>('.dz-hint').innerHTML = trouble
      ? `<b>${esc(trouble)}</b><button class="dz-drop-cancel" type="button">Try again</button>`
      : held.length
        ? `<b>${esc(label.name)}</b><span>${label.sub} · pick where it goes</span><button class="dz-drop-cancel" type="button">Not ${held.length > 1 ? 'these' : 'this one'}</button>`
        : 'Drop files here'

    const batch = new Map(state.batches.map((b) => [b.id, b]))
    const incoming = groups(state.offers)
      .map(([key, list]) => {
        const first = list[0]
        if (!first) return ''
        const b = batch.get(key)
        const size = b ? b.size : list.reduce((n, o) => n + o.file.size, 0)
        const got = list.reduce(
          (n, o) => n + (o.state === 'done' ? o.file.size : (o.received ?? 0)),
          0,
        )
        const name = b ? (b.name ?? plural(b.count, 'file')) : (first.saved ?? first.file.name)
        const already = list.reduce((n, o) => n + (o.have ?? 0), 0)
        const from = `${first.from.name}${b ? ` · ${plural(b.count, 'file')}` : ''} · ${fmt(size)}${already ? ` · ${fmt(already)} already here` : ''}`
        if (list.some((o) => o.state === 'pending'))
          return row(
            esc(name),
            esc(from),
            `<span class="dz-ask"><button type="button" class="dz-yes" data-${b ? 'yesbatch' : 'yes'}="${b ? b.id : first.id}">Accept</button><button type="button" class="dz-no" data-${b ? 'nobatch' : 'no'}="${b ? b.id : first.id}">Decline</button></span>`,
          )
        if (list.some((o) => o.state === 'accepted' || o.state === 'receiving'))
          return row(esc(name), `from ${esc(first.from.name)}`, bar(pct(got, size)))
        if (list.every((o) => o.state === 'done'))
          return row(esc(name), `from ${esc(first.from.name)}`, '<span class="dz-ok">saved</span>')
        if (list.some((o) => o.state === 'failed'))
          return row(
            esc(name),
            `from ${esc(first.from.name)}`,
            '<span class="dz-bad">stopped</span>',
          )
        return ''
      })
      .filter(Boolean)
      .slice(0, 6)
    offersEl.innerHTML = incoming.length ? `<h4>Coming in</h4>${incoming.join('')}` : ''

    peersEl.innerHTML = [
      `<h4>On this network${state.peers.length ? '' : ' <em>— nobody yet</em>'}<button class="dz-again" type="button">Look again</button></h4>`,
      ...state.peers.map(
        (p) =>
          `<button class="dz-peer" type="button" data-peer="${p.id}"${held.length ? '' : ' disabled'}><b>${esc(p.name)}</b><small>${esc(p.host)}</small>${held.length ? '<span class="dz-go">Send</span>' : ''}</button>`,
      ),
    ].join('')

    const going = groups(state.sends)
      .map(([, list]) => {
        const first = list[0]
        if (!first) return ''
        const size = list.reduce((n, s) => n + s.file.size, 0)
        const gone = list.reduce((n, s) => n + (s.state === 'done' ? s.file.size : s.sent), 0)
        const done = list.filter((s) => s.state === 'done').length
        const name = list.length > 1 ? plural(list.length, 'file') : first.file.name
        const stuck = list.find((s) => s.state === 'failed')
        const sub = `to ${first.to.name}${stuck ? ` · ${stuck.error ?? 'stopped'}` : list.some((s) => s.state === 'waiting') ? ' · waiting for them to accept' : list.length > 1 ? ` · ${done} of ${list.length}` : ''}`
        const right =
          done === list.length
            ? '<span class="dz-ok">sent</span>'
            : stuck
              ? '<span class="dz-bad">stopped</span>'
              : bar(pct(gone, size))
        return row(esc(name), esc(sub), right)
      })
      .filter(Boolean)
      .slice(0, 6)
    sendsEl.innerHTML = going.length ? `<h4>Going out</h4>${going.join('')}` : ''
  }

  // the drop target: files and folders, and nothing else the pointer might be carrying
  const over = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    zone.classList.add('over')
  }
  host.addEventListener('dragenter', over)
  host.addEventListener('dragover', over)
  // a dragleave fires for every child the pointer crosses; only the one that leaves the panel counts
  host.addEventListener('dragleave', (e) => {
    if (!host.contains(e.relatedTarget as Node | null)) zone.classList.remove('over')
  })
  host.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    zone.classList.remove('over')
    // the entries have to be taken now: the transfer is emptied as soon as this handler returns
    const entries = [...e.dataTransfer.items]
      .filter((i) => i.kind === 'file')
      .map((i) => i.webkitGetAsEntry())
    const fallback = e.dataTransfer.files
    filesFrom(entries, fallback).then((list) => {
      if (!list.length) return
      held = list
      trouble = ''
      render()
      refresh()
    })
  })

  /** send what is held, as one drop: every file declares the shape of the whole so it is one question */
  async function sendHeld(peerId: string) {
    const list = held
    lastSent = { peer: peerId, list }
    const label = heldLabel()
    const bytes = list.reduce((n, h) => n + h.file.size, 0)
    const id = crypto.randomUUID()
    held = []
    render()
    for (const { file, rel } of list) {
      const args = new URLSearchParams({ to: peerId, name: file.name })
      if (rel) args.set('rel', rel)
      if (list.length > 1) {
        args.set('batch', id)
        args.set('label', label.name)
        args.set('count', String(list.length))
        args.set('bytes', String(bytes))
      }
      try {
        await ask(`/api/drop/send?${args}`, { method: 'POST', body: file })
      } catch (e) {
        trouble = (e as Error).message
        held = list
        break
      }
    }
    refresh()
  }

  host.addEventListener('click', async (e) => {
    const el = e.target as HTMLElement
    const hit = (attr: string) => el.closest<HTMLElement>(`[data-${attr}]`)?.dataset[attr]
    if (el.closest('.dz-drop-cancel')) {
      held = []
      trouble = ''
      return render()
    }
    if (el.closest('.dz-retry')) {
      // the far end kept what arrived, so this carries on rather than starting again
      if (!lastSent) return
      held = lastSent.list
      render()
      return sendHeld(lastSent.peer)
    }
    if (el.closest('.dz-again')) {
      await ask('/api/drop/peers/refresh', { method: 'POST' }).catch(() => {})
      return refresh()
    }
    if (el.closest('.dz-inbox'))
      return void ask('/api/drop/reveal', { method: 'POST' }).catch(() => {})
    const answers: [string, string, boolean][] = [
      ['yes', 'offers', true],
      ['no', 'offers', false],
      ['yesbatch', 'batches', true],
      ['nobatch', 'batches', false],
    ]
    for (const [attr, where, accept] of answers) {
      const id = hit(attr)
      if (!id) continue
      await ask(`/api/drop/${where}/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accept }),
      }).catch(() => {})
      return refresh()
    }
    const peer = hit('peer')
    if (peer && held.length) await sendHeld(peer)
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
  terms: 'drop zone airdrop send file folder transfer share peer lan network receive inbox',
  hint: 'send files to another Orbit on this network',
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
    waiting = pendingDrops(offers ?? [])
    panel?.refreshBadge()
  } catch {}
}, 6000)

export const openDrop = () => panel?.open()
