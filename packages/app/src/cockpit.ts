/**
 * The cockpit: the whole fleet from the conductor's window.
 *
 * One lane per open chat. The head of a lane is the chat as a node (the fleet strip): title,
 * repo, state, ETA, spend, what it is waiting on, a dot for uncommitted work. Under it the chat's
 * queue continues downwards: what it finished (greyed), what it is running, what is queued next.
 * The last lane is the unassigned pile. Drag to reorder, drag onto another lane to reassign, type
 * into a lane to add to it.
 *
 * ONE CONNECTION, NO POLLING
 * GET /api/control/agent/fleet/events (fleet-stream.mjs) pushes a row per chat as it changes and
 * forwards the queue's own frames (docs/QUEUE-CONTRACT.md §4), so the store below holds one
 * EventSource for the page, however many views read it: the conductor's cockpit, the Cockpit
 * panel and the conductor composer's @ routing (cockpit-route.ts). It connects while anything is
 * subscribed and lets go a little after the last one leaves.
 *
 * NOTHING HIDDEN TOUCHES THE DOM
 * The store always takes events in, so nothing is missed. A view paints only while it is on
 * screen (in the viewport, the window visible, its panel open), at most once a frame, and a view
 * that comes back applies everything it missed in one paint. Hidden, it runs no timers and no
 * animations. When the central visibility module (activity.ts, perf/idle-zero) lands, `shown()`
 * is the one place to swap for it.
 *
 * Drawn with no chrome and no position of its own: sessions.ts mounts it under the conductor's
 * banner, and main.ts hosts the same view as the Cockpit panel.
 */
import './cockpit.css'
import type { QueueItem } from './queue-view.ts'

const API = '/api/control/agent'
const QAPI = `${API}/queue`
const WRITE = { 'x-control': '1', 'content-type': 'application/json' }
/** the unassigned pile's lane id */
const PILE = '~'
/** finished items shown above the running one; the rest fold into "n earlier" */
const DONE_SHOWN = 3
/** hover a node this long before its last line shows */
const TIP_MS = 260

export type FleetRow = {
  id: string
  sdkSessionId: string | null
  repo: string
  cwd: string
  title: string
  role: 'conductor' | null
  group: string | null
  state: 'starting' | 'running' | 'waiting' | 'idle' | 'closed' | 'error'
  status: string
  eta: { at: number; label?: string } | null
  since: number | null
  decisions: { kind: string; label: string; detail?: string }[]
  cost: number
  autopilot: boolean
  waiting: string[]
  /** uncommitted files in its folder; null when that is not a repo */
  dirty: number | null
  last: string
  updatedAt: number
}

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
const mins = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 1 ? '<1m' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
}
const money = (d: number) => (d >= 10 ? `$${d.toFixed(0)}` : `$${d.toFixed(2)}`)

// ------------------------------------------------------------------ the store ----

const rows = new Map<string, FleetRow>()
/** chats that were open while this page watched and have since closed: @ routing flags them */
const gone = new Map<string, FleetRow>()
const items = new Map<string, QueueItem>()
const subs = new Set<() => void>()
let es: EventSource | null = null
let live = false
let dropTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null

const notify = () => {
  for (const fn of subs) fn()
}

function connect() {
  if (es || !subs.size) return
  const src = new EventSource(`${API}/fleet/events`)
  es = src
  src.addEventListener('snapshot', (m) => {
    const d = JSON.parse((m as MessageEvent).data) as {
      rows: FleetRow[]
      queue: { items: QueueItem[] } | null
    }
    const now = new Set(d.rows.map((r) => r.id))
    for (const [id, r] of rows) if (!now.has(id)) gone.set(id, r)
    rows.clear()
    for (const r of d.rows) {
      rows.set(r.id, r)
      gone.delete(r.id)
    }
    if (d.queue) {
      items.clear()
      for (const it of d.queue.items) items.set(it.id, it)
    }
    live = true
    notify()
  })
  src.addEventListener('row', (m) => {
    const { row } = JSON.parse((m as MessageEvent).data) as { row: FleetRow }
    rows.set(row.id, row)
    gone.delete(row.id)
    notify()
  })
  src.addEventListener('gone', (m) => {
    const { id } = JSON.parse((m as MessageEvent).data) as { id: string }
    const r = rows.get(id)
    if (r) gone.set(id, { ...r, state: 'closed' })
    rows.delete(id)
    notify()
  })
  src.addEventListener('queue', (m) => {
    const e = JSON.parse((m as MessageEvent).data) as { item?: QueueItem }
    if (e.item) items.set(e.item.id, e.item)
    notify()
  })
  src.onerror = () => {
    // the host may be restarting: the next snapshot puts everything right again
    src.close()
    if (es !== src) return
    es = null
    live = false
    notify()
    retryTimer = setTimeout(connect, 1500)
  }
}

/** watch the fleet; the first subscriber connects, the last one leaving disconnects soon after */
export function subscribeFleet(fn: () => void): () => void {
  subs.add(fn)
  if (dropTimer) clearTimeout(dropTimer)
  dropTimer = null
  connect()
  return () => {
    subs.delete(fn)
    if (subs.size) return
    dropTimer = setTimeout(() => {
      if (subs.size) return
      if (retryTimer) clearTimeout(retryTimer)
      es?.close()
      es = null
      live = false
    }, 5_000)
  }
}

/** open chats the cockpit leads: every open chat but conductors */
export const fleetChats = () => [...rows.values()].filter((r) => r.role !== 'conductor')
export const closedChats = () => [...gone.values()].filter((r) => r.role !== 'conductor')
export const fleetLive = () => live
export const chatName = (r: Pick<FleetRow, 'title' | 'repo'>) => r.title || r.repo

/** anything in the app opens a chat this way (sessions.ts listens) */
export const openChat = (id: string) =>
  dispatchEvent(new CustomEvent('laika:open-chat', { detail: { id } }))

/** the dependencies still not done, worked out here so a finish elsewhere shows at once */
const waitingOn = (it: QueueItem) => it.blockedBy.filter((id) => items.get(id)?.state !== 'done')
/** a chat's suggestion: held (blocked) until you accept it */
const proposed = (it: QueueItem) => it.createdBy === 'chat' && it.state === 'blocked'
const orderable = (it: QueueItem) => it.state === 'queued' || it.state === 'blocked'

async function write(path: string, method: string, body?: unknown) {
  const r = await fetch(`${QAPI}${path}`, {
    method,
    headers: WRITE,
    body: body === undefined ? null : JSON.stringify(body),
  })
  const out = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(out.error ?? `The queue said no (${r.status}).`)
  return out
}

/** add work to a chat's list (null: the unassigned pile) */
export async function queueFor(
  chatId: string | null,
  text: string,
  createdBy: QueueItem['createdBy'] = 'user',
) {
  const line = text.replace(/\s+/g, ' ').trim()
  const title = line.length > 120 ? `${line.slice(0, 117)}…` : line
  const it = (await write('', 'POST', {
    title,
    brief: text.trim().slice(0, 8000),
    chatId,
    createdBy,
  })) as QueueItem
  items.set(it.id, it)
  notify()
  return it
}

// -------------------------------------------------------------------- the view ----

type Lane = {
  el: HTMLElement
  head: HTMLElement
  list: HTMLElement
  add: HTMLInputElement
  headHtml: string
  listHtml: string
}

export function mountCockpit(host: HTMLElement): {
  dispose: () => void
  setVisible: (on: boolean) => void
} {
  host.classList.add('ck')
  host.innerHTML = `<div class="ck-lanes" role="list"></div><div class="ck-err" hidden></div><div class="ck-tip" hidden></div>`
  const lanesEl = host.querySelector('.ck-lanes') as HTMLElement
  const errEl = host.querySelector('.ck-err') as HTMLElement
  const tip = host.querySelector('.ck-tip') as HTMLElement
  const lanes = new Map<string, Lane>()
  let laneOrder = ''

  // ---- when it may paint
  let panelOn = true
  let inView = false
  let stale = true
  let raf = 0
  let drag: { id: string } | null = null
  let tick: ReturnType<typeof setInterval> | null = null
  const shown = () => panelOn && inView && document.visibilityState === 'visible'
  const kick = () => {
    stale = true
    if (!raf && !drag && shown()) raf = requestAnimationFrame(paint)
  }
  const onShown = () => {
    const on = shown()
    host.classList.toggle('off', !on)
    // the elapsed minutes on a running item: only while someone can read them
    if (on && !tick) tick = setInterval(kick, 60_000)
    if (!on && tick) {
      clearInterval(tick)
      tick = null
    }
    if (on) kick()
  }
  const io = new IntersectionObserver((es) => {
    inView = es.some((e) => e.isIntersecting)
    onShown()
  })
  io.observe(host)
  document.addEventListener('visibilitychange', onShown)
  const unsub = subscribeFleet(kick)

  const say = (msg: string | null) => {
    errEl.hidden = !msg
    errEl.textContent = msg ?? ''
  }
  const act = (p: Promise<unknown>) =>
    p.then(() => say(null)).catch((e) => say(String((e as Error).message ?? e)))

  // ---- painting
  const stateWord = (r: FleetRow) =>
    r.waiting.length || r.decisions.some((d) => d.kind !== 'attention')
      ? 'waiting on you'
      : r.state === 'error'
        ? 'failed'
        : r.state === 'starting'
          ? 'running'
          : r.state
  const tone = (r: FleetRow) => {
    const w = stateWord(r)
    return w === 'waiting on you'
      ? 'you'
      : w === 'failed'
        ? 'err'
        : w === 'running'
          ? 'run'
          : 'idle'
  }

  /** the pill: what state, in one word, and for how long */
  const PILL: Record<string, string> = {
    you: 'Needs you',
    run: 'Working',
    err: 'Stopped',
    idle: 'Idle',
  }
  /**
   * The sentence under the title: what it needs from you, what it is doing, why it stopped, or
   * what it last said. fleet-board.mjs's status already reads this way; only the lead-in changes.
   */
  const nowLine = (r: FleetRow, list: QueueItem[]) => {
    const t = tone(r)
    const st = r.status || ''
    if (t === 'you') {
      if (!r.decisions.length && r.waiting.includes('secret'))
        return { k: 'you', text: 'Needs a secret from you to go on' }
      return {
        k: 'you',
        text: st.replace(/^Asks: /, 'Asks you: ').replace(/^Wants to /, 'Wants your OK to '),
      }
    }
    if (t === 'err')
      return { k: 'err', text: st.replace(/^Stopped: /, '') || 'Stopped with an error' }
    if (t === 'run') return { k: 'run', text: st }
    const attention = r.decisions.find((d) => d.kind === 'attention')
    if (attention)
      return {
        k: 'you',
        text: `${attention.label}${attention.detail ? ` · ${attention.detail}` : ''}`,
      }
    // idle with queue work: the queue says more than the last thing it said
    const sent = list.find((i) => i.state === 'running')
    if (sent)
      return {
        k: 'you',
        text: `Mark done to send the next: “${sent.title}”`,
      }
    const ready = list
      .filter((i) => i.state === 'queued' && i.ready)
      .sort((a, b) => a.order - b.order)[0]
    if (ready) return { k: 'next', text: `Idle, with “${ready.title}” ready to go` }
    if (!st || st === 'Ready for a first message') return { k: 'idle', text: 'Nothing sent yet' }
    return { k: 'idle', text: st, said: true }
  }

  const headHtml = (r: FleetRow | null, list: QueueItem[]) => {
    const waiting = list.filter((i) => i.state === 'queued' || i.state === 'blocked')
    if (!r)
      return `<div class="ck-node pile"><span class="ck-row1"><span class="ck-dot"></span><span class="ck-t">Unassigned</span></span>
        <span class="ck-now">${waiting.length ? `${waiting.length} waiting for a chat. Drag one onto a chat to hand it over.` : 'Work no chat has yet lands here.'}</span></div>`
    const t = tone(r)
    const now = Date.now()
    const age = r.since ? mins(now - r.since) : ''
    const line = nowLine(r, list)
    const facts: string[] = []
    if (r.eta?.at) {
      const left = r.eta.at - now
      facts.push(
        left > 0
          ? `<span class="ck-f" title="${esc(r.eta.label ? `Estimated from ${r.eta.label}` : 'Estimated time left')}">~${mins(left)} left</span>`
          : `<span class="ck-f late" title="Past its estimate">${mins(-left)} over</span>`,
      )
    }
    if (r.dirty)
      facts.push(
        `<span class="ck-f dirty" title="Files changed in ${esc(r.repo)} and not committed yet">${r.dirty} uncommitted</span>`,
      )
    if (r.cost >= 0.005)
      facts.push(
        `<span class="ck-f cost" title="Spent in this chat so far">${money(r.cost)}</span>`,
      )
    return `<button type="button" class="ck-node t-${t}" data-open="${esc(r.id)}" aria-label="Open ${esc(chatName(r))}: ${esc(PILL[t])}">
      <span class="ck-row1"><span class="ck-dot"></span><span class="ck-t">${esc(chatName(r))}</span></span>
      <span class="ck-row2"><span class="ck-pill">${esc(PILL[t] ?? '')}${age ? `<em>${esc(age)}</em>` : ''}</span><span class="ck-repo">${esc(r.repo)}${r.group ? ` · ${esc(r.group)}` : ''}</span></span>
      <span class="ck-now k-${line.k}${line.said ? ' said' : ''}" title="${esc(line.text)}">${esc(line.text)}</span>
      ${facts.length ? `<span class="ck-facts">${facts.join('')}</span>` : ''}
    </button>`
  }

  const itemHtml = (it: QueueItem) => {
    const now = Date.now()
    const wait = waitingOn(it)
    const prop = proposed(it)
    const cls = [
      'ck-i',
      `s-${it.state}`,
      prop ? 'proposed' : '',
      it.ready ? 'ready' : '',
      it.needsUser ? 'needs' : '',
      orderable(it) ? 'can' : '',
    ]
      .filter(Boolean)
      .join(' ')
    let prog = ''
    if (it.state === 'running' && it.startedAt) {
      const ran = now - it.startedAt
      if (it.estimate) {
        // no time in the markup, so the list is only rebuilt when something changed; startBars()
        // gives a new bar its place and the rest of the estimate as one compositor animation
        prog = `<div class="ck-bar" data-s="${it.startedAt}" data-e="${it.estimate}"><i></i></div><span class="ck-i-m">${mins(ran)} of ~${it.estimate}m</span>`
      } else
        prog = `<div class="ck-bar open"><i></i></div><span class="ck-i-m">running ${mins(ran)}</span>`
    }
    const tags = [
      prop ? '<span class="ck-tag prop">proposed</span>' : '',
      it.state === 'blocked' && !prop ? '<span class="ck-tag">paused</span>' : '',
      it.ready && it.state === 'queued'
        ? '<span class="ck-tag ok" title="Goes out when this chat is next idle, on autopilot">ready</span>'
        : '',
      it.needsUser ? '<span class="ck-tag bad">needs you</span>' : '',
      it.estimate && it.state !== 'running' && it.state !== 'done'
        ? `<span class="ck-tag dim">~${it.estimate}m</span>`
        : '',
    ].join('')
    const links = wait
      .map((id) => {
        const dep = items.get(id)
        return `<a class="ck-dep" data-goto="${esc(id)}" title="Waits for this to be done">↳ ${esc(dep?.title ?? id)}${dep?.state === 'cancelled' ? ' (cancelled)' : ''}</a>`
      })
      .join('')
    const btn = (a: string, label: string, t: string) =>
      `<button type="button" data-a="${a}" title="${t}">${label}</button>`
    const acts = prop
      ? btn('accept', 'Accept', 'Put it in the queue') +
        btn('cancel', 'Dismiss', 'Drop the suggestion')
      : it.state === 'queued'
        ? btn('pause', 'Pause', 'Hold it: it will not go out') + btn('cancel', '✕', 'Cancel')
        : it.state === 'blocked'
          ? btn('resume', 'Resume', 'Back in the queue') + btn('cancel', '✕', 'Cancel')
          : it.state === 'running'
            ? btn('done', 'Done', 'Mark it done') + btn('cancel', '✕', 'Cancel')
            : ''
    return `<li class="${cls}" data-id="${esc(it.id)}"${orderable(it) ? ' draggable="true"' : ''} title="${esc(it.brief)}">
      <div class="ck-i-t">${it.state === 'done' ? '<span class="ck-tick">✓</span>' : ''}${esc(it.title)}</div>
      ${prog}
      ${tags || links ? `<div class="ck-i-tags">${tags}${links}</div>` : ''}
      ${it.lastError && it.state !== 'done' ? `<div class="ck-i-err">${esc(it.lastError)}${it.needsUser ? ` ${btn('retry', 'Retry', 'Try again')}` : ''}</div>` : ''}
      ${acts ? `<span class="ck-i-a">${acts}</span>` : ''}
    </li>`
  }

  const listHtml = (list: QueueItem[], laneId: string) => {
    const done = list
      .filter((i) => i.state === 'done')
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
    const running = list.filter((i) => i.state === 'running')
    const next = list
      .filter(orderable)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
    const older = done.length - DONE_SHOWN
    return `${older > 0 ? `<li class="ck-more">${older} earlier</li>` : ''}${done.slice(-DONE_SHOWN).map(itemHtml).join('')}${running
      .map(itemHtml)
      .join('')}${next.map(itemHtml).join('')}${
      !running.length && !next.length
        ? `<li class="ck-empty">${laneId === PILE ? 'Drop work here to hold it for later' : 'Nothing queued'}</li>`
        : ''
    }`
  }

  const makeLane = (id: string): Lane => {
    const el = document.createElement('section')
    el.className = 'ck-lane'
    el.dataset.lane = id
    el.setAttribute('role', 'listitem')
    el.innerHTML = `<div class="ck-head"></div><ol class="ck-q"></ol><input class="ck-add" maxlength="8000" spellcheck="false" />`
    const lane: Lane = {
      el,
      head: el.querySelector('.ck-head') as HTMLElement,
      list: el.querySelector('.ck-q') as HTMLElement,
      add: el.querySelector('.ck-add') as HTMLInputElement,
      headHtml: '',
      listHtml: '',
    }
    lane.add.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') return lane.add.blur()
      if (e.key !== 'Enter' || e.isComposing || !lane.add.value.trim()) return
      e.preventDefault()
      const text = lane.add.value
      lane.add.value = ''
      act(queueFor(id === PILE ? null : id, text))
    })
    return lane
  }

  const startBars = (list: HTMLElement) => {
    for (const bar of list.querySelectorAll<HTMLElement>('.ck-bar[data-e]')) {
      const total = Number(bar.dataset.e) * 60_000
      const ran = Date.now() - Number(bar.dataset.s)
      bar.style.setProperty('--p', Math.min(0.97, ran / total).toFixed(3))
      bar.style.setProperty('--left', `${Math.max(1, Math.round((total - ran) / 1000))}s`)
    }
  }

  function paint() {
    raf = 0
    // nothing to lay out before the first snapshot: an empty pile alone would only flash
    if (!stale || !shown() || (!live && !lanes.size)) return
    stale = false
    const chats = fleetChats().sort(
      (a, b) =>
        a.repo.localeCompare(b.repo) ||
        chatName(a).localeCompare(chatName(b)) ||
        a.id.localeCompare(b.id),
    )
    const byLane = new Map<string, QueueItem[]>([[PILE, []]])
    for (const c of chats) byLane.set(c.id, [])
    for (const it of items.values()) {
      if (it.state === 'cancelled') continue
      // an item still assigned to a chat this page no longer sees is on its way to the pile
      byLane.get(it.chatId && byLane.has(it.chatId) ? it.chatId : PILE)?.push(it)
    }
    const ids = [...chats.map((c) => c.id), PILE]
    for (const [id, l] of lanes)
      if (!ids.includes(id)) {
        l.el.remove()
        lanes.delete(id)
      }
    for (const id of ids) {
      const l = lanes.get(id) ?? makeLane(id)
      lanes.set(id, l)
      const r = id === PILE ? null : (rows.get(id) ?? null)
      const list = byLane.get(id) ?? []
      const h = headHtml(r, list)
      if (h !== l.headHtml) {
        l.headHtml = h
        l.head.innerHTML = h
      }
      const q = listHtml(list, id)
      if (q !== l.listHtml) {
        l.listHtml = q
        l.list.innerHTML = q
        startBars(l.list)
      }
      const cls = `ck-lane${r ? ` t-${tone(r)}` : ' pile'}`
      if (l.el.className !== cls) l.el.className = cls
      const ph = r ? `Add to ${chatName(r)}…` : 'Add for later…'
      if (l.add.placeholder !== ph) l.add.placeholder = ph
    }
    const order = ids.join(',')
    if (order !== laneOrder) {
      laneOrder = order
      for (const id of ids) lanesEl.appendChild((lanes.get(id) as Lane).el)
    }
    if (host.classList.contains('connecting') === live) host.classList.toggle('connecting', !live)
    const empty = !chats.length && live
    if (empty !== 'empty' in host.dataset) {
      if (empty) host.dataset.empty = 'No other chats are open.'
      else delete host.dataset.empty
    }
  }

  // ---- clicks: open a chat, act on an item, follow a dependency
  host.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    const goto = t.closest<HTMLElement>('[data-goto]')?.dataset.goto
    if (goto) {
      const li = host.querySelector<HTMLElement>(`.ck-i[data-id="${CSS.escape(goto)}"]`)
      if (!li) return say('That item is finished and folded away, or cancelled.')
      li.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
      li.classList.remove('flash')
      void li.offsetWidth
      li.classList.add('flash')
      return
    }
    const a = t.closest<HTMLElement>('[data-a]')?.dataset.a
    const id = t.closest<HTMLElement>('.ck-i')?.dataset.id
    if (a && id) {
      const p = `/${encodeURIComponent(id)}`
      if (a === 'pause') act(write(p, 'PATCH', { state: 'blocked' }))
      else if (a === 'resume' || a === 'accept') act(write(p, 'PATCH', { state: 'queued' }))
      else if (a === 'done') act(write(p, 'PATCH', { state: 'done' }))
      else if (a === 'retry') act(write(p, 'PATCH', { lastError: null }))
      else if (a === 'cancel')
        act(write(`${p}/cancel`, 'POST', { reason: 'cancelled in the cockpit' }))
      return
    }
    const open = t.closest<HTMLElement>('[data-open]')?.dataset.open
    if (open) openChat(open)
  })

  // ---- hover a node: its last line
  let tipTimer: ReturnType<typeof setTimeout> | null = null
  host.addEventListener('pointerover', (e) => {
    const node = (e.target as HTMLElement).closest<HTMLElement>('[data-open]')
    if (!node || node.contains(e.relatedTarget as Node)) return
    if (tipTimer) clearTimeout(tipTimer)
    tipTimer = setTimeout(() => {
      const r = rows.get(node.dataset.open as string)
      if (!r?.last) return
      tip.textContent = r.last
      const b = node.getBoundingClientRect()
      const hb = host.getBoundingClientRect()
      tip.style.left = `${Math.max(0, Math.min(b.left - hb.left, hb.width - 320))}px`
      tip.style.top = `${b.bottom - hb.top + 6}px`
      tip.hidden = false
    }, TIP_MS)
  })
  host.addEventListener('pointerout', (e) => {
    const node = (e.target as HTMLElement).closest('[data-open]')
    if (!node || node.contains(e.relatedTarget as Node)) return
    if (tipTimer) clearTimeout(tipTimer)
    tip.hidden = true
  })

  // ---- drag: reorder within a lane, or drop on another lane (or its node) to reassign
  const mark = document.createElement('div')
  mark.className = 'ck-mark'
  const spot = (lane: Lane, y: number) => {
    const cands = [...lane.list.querySelectorAll<HTMLElement>('.ck-i.can')].filter(
      (li) => li.dataset.id !== drag?.id,
    )
    let before: HTMLElement | null = null
    for (const li of cands) {
      const b = li.getBoundingClientRect()
      if (y < b.top + b.height / 2) {
        before = li
        break
      }
    }
    return { cands, before }
  }
  host.addEventListener('dragstart', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('.ck-i.can')
    if (!li) return
    drag = { id: li.dataset.id as string }
    tip.hidden = true
    e.dataTransfer?.setData('text/plain', li.querySelector('.ck-i-t')?.textContent ?? '')
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
    requestAnimationFrame(() => li.classList.add('dragging'))
  })
  const laneAt = (t: EventTarget | null) => {
    const id = (t as HTMLElement | null)?.closest<HTMLElement>('.ck-lane')?.dataset.lane
    return id ? { id, lane: lanes.get(id) as Lane } : null
  }
  host.addEventListener('dragover', (e) => {
    if (!drag) return
    const at = laneAt(e.target)
    if (!at) return
    e.preventDefault()
    for (const l of lanes.values()) l.el.classList.toggle('over', l === at.lane)
    const { before } = spot(at.lane, e.clientY)
    if (before) at.lane.list.insertBefore(mark, before)
    else {
      const tail = at.lane.list.querySelector('.ck-empty')
      at.lane.list.insertBefore(mark, tail)
    }
  })
  const endDrag = () => {
    mark.remove()
    for (const l of lanes.values()) l.el.classList.remove('over')
    host.querySelector('.dragging')?.classList.remove('dragging')
    drag = null
    kick()
  }
  host.addEventListener('drop', (e) => {
    if (!drag) return
    e.preventDefault()
    const at = laneAt(e.target)
    const it = items.get(drag.id)
    if (!at || !it) return endDrag()
    const chat = at.id === PILE ? null : at.id
    // the new order: every orderable item in the lane as it will read, the dragged one where it fell
    const ids: string[] = []
    let placed = false
    for (const n of at.lane.list.children) {
      if (n === mark) {
        ids.push(it.id)
        placed = true
      } else {
        const id = (n as HTMLElement).dataset.id
        if (id && id !== it.id && (n as HTMLElement).classList.contains('can')) ids.push(id)
      }
    }
    if (!placed) ids.push(it.id)
    // shown at once; the stream confirms it
    const was = { chatId: it.chatId }
    items.set(it.id, { ...it, chatId: chat })
    ids.forEach((id, i) => {
      const x = items.get(id)
      if (x) items.set(id, { ...x, order: i })
    })
    const moved = (was.chatId ?? null) !== chat
    endDrag()
    act(
      (async () => {
        if (moved)
          await write(`/${encodeURIComponent(it.id)}/assign`, 'POST', {
            chat,
            why: 'moved in the cockpit',
          })
        await write('/reorder', 'POST', { chat, ids })
      })().catch((err) => {
        items.set(it.id, it)
        kick()
        throw err
      }),
    )
  })
  host.addEventListener('dragend', () => drag && endDrag())

  onShown()
  return {
    setVisible(on: boolean) {
      panelOn = on
      onShown()
    },
    dispose() {
      unsub()
      io.disconnect()
      document.removeEventListener('visibilitychange', onShown)
      if (raf) cancelAnimationFrame(raf)
      if (tick) clearInterval(tick)
      if (tipTimer) clearTimeout(tipTimer)
      host.replaceChildren()
      host.classList.remove('ck', 'off', 'connecting')
    },
  }
}
