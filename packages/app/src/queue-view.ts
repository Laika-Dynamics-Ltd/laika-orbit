/**
 * The work queue, as a view: each chat's list, the unassigned pile, and what finished.
 *
 * Built only on the published contract (docs/QUEUE-CONTRACT.md): GET /api/control/agent/queue for
 * the state, its /events stream to know when to look again, and the write routes for the few
 * things a person does here: add work, mark it done, retry it, move it, cancel it.
 *
 * Like runs.ts it draws no chrome and takes no position, width or z-index, so the /queue page
 * shows it today and the panel system can host the same mount later (see runs-panel.ts).
 */
import './queue.css'

const API = '/api/control/agent/queue'
const WRITE = { 'x-control': '1', 'content-type': 'application/json' }

type Done = { committed: boolean; reachable: boolean; verified: boolean }
export type QueueItem = {
  id: string
  repo: string
  chatId: string | null
  title: string
  brief: string
  state: 'queued' | 'running' | 'blocked' | 'done' | 'cancelled'
  blockedBy: string[]
  order: number
  estimate: number | null
  machine: 'mac' | 'box1' | 'any'
  createdBy: 'user' | 'conductor' | 'chat'
  done: Done
  artefacts: string[]
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  lastError: string | null
  retries: number
  needsUser: boolean
  ready: boolean
  waitingOn: string[]
}
type View = { v: number; now: number; items: QueueItem[]; counts: Record<string, number> }
type Chat = { id: string; repo: string; title?: string; state: string; role?: string | null }

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
const ago = (t: number | null, now: number) => {
  if (!t) return ''
  const m = Math.round((now - t) / 60_000)
  return m < 1
    ? 'just now'
    : m < 60
      ? `${m}m`
      : m < 48 * 60
        ? `${Math.round(m / 60)}h`
        : `${Math.round(m / 1440)}d`
}
const FLAGS: (keyof Done)[] = ['committed', 'reachable', 'verified']

/** the queue's counts, for a button that shows them; null when the host has no queue yet */
export async function queueCounts(): Promise<Record<string, number> | null> {
  try {
    const r = await fetch(API, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
    if (!r.ok) return null
    return ((await r.json()) as View).counts
  } catch {
    return null
  }
}

export function mountQueue(host: HTMLElement) {
  host.classList.add('qu')
  host.innerHTML = `
    <div class="qu-bar">
      <div class="qu-chips" data-el="chips"></div>
      <span class="qu-feed" data-el="feed">connecting…</span>
    </div>
    <div class="qu-banner" data-el="banner" hidden></div>
    <details class="qu-add" data-el="addbox">
      <summary>Add work</summary>
      <form data-el="add">
        <input name="title" maxlength="120" placeholder="Title: one line saying what the work is" required />
        <textarea name="brief" rows="4" maxlength="8000" placeholder="Brief: the full text the chat will be sent" required></textarea>
        <div class="qu-row">
          <label>Chat <select name="chat" data-el="chatpick"></select></label>
          <label>After <select name="after" data-el="afterpick"></select></label>
          <label>Estimate <input name="estimate" type="number" min="0" max="1440" placeholder="min" /></label>
          <label>Machine <select name="machine"><option value="any">any</option><option value="mac">mac</option><option value="box1">box1</option></select></label>
          <button class="qu-btn" type="submit">Queue it</button>
        </div>
      </form>
    </details>
    <div data-el="lists"></div>`
  const el = (n: string) => host.querySelector(`[data-el="${n}"]`) as HTMLElement
  let view: View | null = null
  let chats: Chat[] = []
  let stopped = false

  const banner = (text: string | null) => {
    el('banner').hidden = !text
    el('banner').textContent = text ?? ''
  }

  const load = async () => {
    try {
      const [q, s] = await Promise.all([
        fetch(`${API}?include=done`, { cache: 'no-store' }),
        fetch('/api/control/agent/sessions', { cache: 'no-store' }),
      ])
      if (!q.ok)
        throw new Error(
          q.status === 404
            ? 'This host has no queue yet: restart the app to load it.'
            : `The queue did not answer (${q.status}).`,
        )
      view = (await q.json()) as View
      chats = s.ok
        ? ((await s.json()) as Chat[]).filter((c) => c.state !== 'closed' && c.role !== 'conductor')
        : []
      banner(null)
      paint()
    } catch (e) {
      banner(String((e as Error)?.message ?? e))
    }
  }
  let loadTimer: ReturnType<typeof setTimeout> | null = null
  const soon = () => {
    if (loadTimer) clearTimeout(loadTimer)
    loadTimer = setTimeout(load, 150)
  }

  const act = async (path: string, method: string, body?: unknown) => {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: WRITE,
      body: body === undefined ? null : JSON.stringify(body),
    })
    const out = await r.json().catch(() => ({}))
    if (!r.ok) banner(out.error ?? `That did not work (${r.status}).`)
    else banner(null)
    soon()
    return r.ok
  }

  const chatName = (id: string | null) => {
    if (!id) return 'Unassigned'
    const c = chats.find((x) => x.id === id)
    return c ? `${c.title || c.repo} · ${c.repo}` : `${id.slice(0, 8)} (closed)`
  }
  const titleOf = (id: string) => view?.items.find((r) => r.id === id)?.title ?? id

  const row = (r: QueueItem, now: number) => {
    const live = r.state !== 'done' && r.state !== 'cancelled'
    const tags = [
      r.ready ? '<span class="qu-tag ok">ready</span>' : '',
      r.waitingOn.length
        ? `<span class="qu-tag">waits on ${r.waitingOn.map((id) => esc(titleOf(id))).join(', ')}</span>`
        : '',
      r.needsUser ? '<span class="qu-tag bad">needs you</span>' : '',
      r.estimate ? `<span class="qu-tag dim">~${r.estimate}m</span>` : '',
      r.machine !== 'any' ? `<span class="qu-tag dim">${esc(r.machine)}</span>` : '',
      r.createdBy !== 'user' ? `<span class="qu-tag dim">by ${esc(r.createdBy)}</span>` : '',
    ].join('')
    const moveTo = [
      `<option value="">Move to…</option>`,
      r.chatId ? `<option value="none">Unassigned</option>` : '',
    ]
      .concat(
        chats
          .filter((c) => c.id !== r.chatId)
          .map(
            (c) =>
              `<option value="${esc(c.id)}">${esc(c.title || c.repo)} · ${esc(c.repo)}</option>`,
          ),
      )
      .join('')
    return `
      <li class="qu-item s-${r.state}" data-id="${esc(r.id)}">
        <div class="qu-main">
          <span class="qu-state">${r.state}</span>
          <b class="qu-title" title="${esc(r.brief)}">${esc(r.title)}</b>
          <span class="qu-meta">${esc(r.repo)}${r.state === 'running' ? ` · running ${ago(r.startedAt, now)}` : r.finishedAt ? ` · ${ago(r.finishedAt, now)} ago` : ` · added ${ago(r.createdAt, now)} ago`}</span>
        </div>
        <div class="qu-tags">${tags}</div>
        ${r.lastError ? `<div class="qu-err">${esc(r.lastError)}${r.retries ? ` (tried ${r.retries}×)` : ''}</div>` : ''}
        <div class="qu-acts">
          <span class="qu-flags">${FLAGS.map((f) => `<label><input type="checkbox" data-flag="${f}" ${r.done[f] ? 'checked' : ''} ${r.state === 'cancelled' ? 'disabled' : ''}/>${f}</label>`).join('')}</span>
          ${live ? `<button class="qu-btn" data-act="done">Mark done</button>` : ''}
          ${live && r.lastError ? `<button class="qu-btn ghost" data-act="retry">Retry</button>` : ''}
          ${live ? `<select class="qu-move" data-act="move">${moveTo}</select>` : ''}
          ${live ? `<button class="qu-btn ghost" data-act="cancel">Cancel</button>` : ''}
          ${r.state === 'cancelled' ? `<button class="qu-btn ghost" data-act="reopen">Reopen</button>` : ''}
          <details class="qu-brief"><summary>Brief</summary><pre>${esc(r.brief)}</pre></details>
        </div>
      </li>`
  }

  const paint = () => {
    if (!view) return
    const now = view.now
    const c = view.counts
    const chips: [string, string][] = [
      ['running', 'live'],
      ['ready', 'ok'],
      ['queued', ''],
      ['needsUser', 'bad'],
      ['done', 'dim'],
    ]
    el('chips').innerHTML = chips
      .map(
        ([k, tone]) =>
          `<span class="qu-chip ${tone}"><b>${c[k] ?? 0}</b>${k === 'needsUser' ? 'need you' : k}</span>`,
      )
      .join('')

    const live = view.items.filter((r) => r.state !== 'done' && r.state !== 'cancelled')
    const finished = view.items
      .filter((r) => r.state === 'done' || r.state === 'cancelled')
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    const groups = new Map<string | null, QueueItem[]>()
    for (const r of live) groups.set(r.chatId, [...(groups.get(r.chatId) ?? []), r])
    if (!groups.has(null)) groups.set(null, [])
    const order = [...groups.keys()].sort((a, b) =>
      a === null ? 1 : b === null ? -1 : chatName(a).localeCompare(chatName(b)),
    )
    el('lists').innerHTML =
      order
        .map((id) => {
          const list = (groups.get(id) ?? []).sort(
            (a, b) => a.order - b.order || a.createdAt - b.createdAt,
          )
          return `<section class="qu-sec"><h2>${esc(chatName(id))} <span>${list.length}</span></h2>${
            list.length
              ? `<ol class="qu-list">${list.map((r) => row(r, now)).join('')}</ol>`
              : `<p class="qu-empty">${id === null ? 'Nothing waiting for a chat.' : 'Empty.'}</p>`
          }</section>`
        })
        .join('') +
      (finished.length
        ? `<details class="qu-sec qu-done"><summary><h2>Finished <span>${finished.length}</span></h2></summary><ol class="qu-list">${finished
            .slice(0, 100)
            .map((r) => row(r, now))
            .join('')}</ol></details>`
        : '')

    const pick = el('chatpick') as HTMLSelectElement
    const was = pick.value
    pick.innerHTML = `<option value="">Unassigned</option>${chats.map((c) => `<option value="${esc(c.id)}">${esc(c.title || c.repo)} · ${esc(c.repo)}</option>`).join('')}`
    pick.value = chats.some((c) => c.id === was) ? was : ''
    const after = el('afterpick') as HTMLSelectElement
    const wasAfter = after.value
    after.innerHTML = `<option value="">nothing</option>${live.map((r) => `<option value="${esc(r.id)}">${esc(r.title)}</option>`).join('')}`
    after.value = live.some((r) => r.id === wasAfter) ? wasAfter : ''
  }

  // one listener for every row: the list is redrawn whole on every change
  host.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null
    const li = b?.closest('li[data-id]') as HTMLElement | null
    if (!b || !li) return
    const id = encodeURIComponent(li.dataset.id as string)
    const a = b.dataset.act
    if (a === 'done') act(`/${id}`, 'PATCH', { state: 'done' })
    else if (a === 'retry') act(`/${id}`, 'PATCH', { lastError: null })
    else if (a === 'reopen') act(`/${id}`, 'PATCH', { state: 'queued' })
    else if (a === 'cancel' && confirm('Cancel this item? It stays in the list as cancelled.'))
      act(`/${id}/cancel`, 'POST', { reason: 'cancelled from the queue page' })
  })
  host.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement
    const li = t.closest('li[data-id]') as HTMLElement | null
    if (!li) return
    const id = encodeURIComponent(li.dataset.id as string)
    if (t instanceof HTMLInputElement && t.dataset.flag)
      act(`/${id}`, 'PATCH', { done: { [t.dataset.flag]: t.checked } })
    else if (t instanceof HTMLSelectElement && t.dataset.act === 'move' && t.value)
      act(`/${id}/assign`, 'POST', {
        chat: t.value === 'none' ? null : t.value,
        why: 'moved on the queue page',
      })
  })
  el('add').addEventListener('submit', async (e) => {
    e.preventDefault()
    const f = new FormData(e.target as HTMLFormElement)
    const est = Number(f.get('estimate'))
    const ok = await act('', 'POST', {
      title: f.get('title'),
      brief: f.get('brief'),
      chatId: f.get('chat') || null,
      blockedBy: f.get('after') ? [f.get('after')] : [],
      estimate: est > 0 ? est : undefined,
      machine: f.get('machine'),
      createdBy: 'user',
    })
    if (ok) (e.target as HTMLFormElement).reset()
  })

  // live: the stream only says something changed; the list is always read whole from the API
  let es: EventSource | null = null
  const connect = () => {
    if (stopped) return
    es = new EventSource(`${API}/events`)
    es.onopen = () => {
      el('feed').textContent = 'live'
      el('feed').className = 'qu-feed ok'
      soon()
    }
    es.onmessage = () => soon()
    es.onerror = () => {
      es?.close()
      el('feed').textContent = 'reconnecting…'
      el('feed').className = 'qu-feed bad'
      if (!stopped) setTimeout(connect, 2000)
    }
  }
  load()
  connect()
  // chats open and close without a queue event; their names are refreshed now and then
  const tick = setInterval(load, 30_000)

  return () => {
    stopped = true
    es?.close()
    clearInterval(tick)
    if (loadTimer) clearTimeout(loadTimer)
    host.innerHTML = ''
    host.classList.remove('qu')
  }
}
