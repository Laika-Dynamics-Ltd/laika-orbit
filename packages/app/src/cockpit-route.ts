/**
 * @ routing in the conductor's composer.
 *
 * Typing @ lists the open chats, by title and repo, narrowing as you type; ↑↓ move, ↵ or ⇥ pick,
 * esc closes. "@panels fix the scroll" then goes to that chat instead of the conductor:
 *   - queued for it (the work queue, docs/QUEUE-CONTRACT.md), or
 *   - sent straight away when the chat is idle and autopilot is on, because that is exactly what
 *     the queue would do with it a moment later.
 * A chat that has closed is never written to silently: the message stays in the box and a bar
 * says so, with the unassigned pile as the one-click way to keep it.
 *
 * The chats come from the cockpit's store (cockpit.ts), so this holds no connection of its own.
 */
import {
  chatName,
  closedChats,
  type FleetRow,
  fleetChats,
  queueFor,
  subscribeFleet,
} from './cockpit.ts'

const API = '/api/control/agent'
const WRITE = { 'x-control': '1', 'content-type': 'application/json' }

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 28)
    .replace(/-$/, '')

/** what you type after @ for this chat: its repo when that is unique, else its title */
export function handleOf(r: FleetRow, among: FleetRow[] = fleetChats()) {
  const repo = slug(r.repo)
  return repo && among.filter((x) => slug(x.repo) === repo).length === 1
    ? repo
    : slug(chatName(r)) || r.id.slice(0, 8)
}

const matches = (r: FleetRow, h: string, among: FleetRow[]) =>
  handleOf(r, among) === h || slug(r.repo) === h || slug(chatName(r)) === h || r.id.startsWith(h)

type Target =
  | { open: FleetRow }
  | { closed: FleetRow }
  | { ambiguous: FleetRow[] }
  | { unknown: string }

export function resolveHandle(h: string): Target {
  const key = slug(h)
  const open = fleetChats()
  const hit = open.filter((r) => matches(r, key, open))
  if (hit.length === 1) return { open: hit[0] as FleetRow }
  if (hit.length > 1) return { ambiguous: hit }
  const closed = closedChats().filter((r) => matches(r, key, closedChats()))
  if (closed.length) return { closed: closed[closed.length - 1] as FleetRow }
  return { unknown: h }
}

/** "@handle the rest": the handle and the message, or null when it is for the conductor itself */
export function parseRouted(text: string) {
  const m = /^@([\w.-]+)\s+([\s\S]+)$/.exec(text.trim())
  return m ? { handle: m[1] as string, body: (m[2] as string).trim() } : null
}

const rank = (r: FleetRow, q: string) => {
  if (!q) return 1
  const hay = [handleOf(r), slug(r.repo), slug(chatName(r)), chatName(r).toLowerCase()]
  if (hay.some((h) => h.startsWith(q))) return 3
  if (hay.some((h) => h.includes(q))) return 2
  return 0
}

/**
 * The @ list on a composer's textarea. Keys are taken in the capture phase, so while the list is
 * open ↵ picks a chat rather than sending the message.
 */
export function attachChatMentions(input: HTMLTextAreaElement, box: HTMLElement): () => void {
  const pop = document.createElement('div')
  pop.className = 'ck-at'
  pop.setAttribute('role', 'listbox')
  pop.hidden = true
  document.body.appendChild(pop)
  let list: FleetRow[] = []
  let sel = 0
  let token: { start: number; q: string } | null = null

  const tokenAt = () => {
    const upto = input.value.slice(0, input.selectionStart ?? input.value.length)
    const m = /(^|\s)@([\w.-]*)$/.exec(upto)
    return m ? { start: upto.length - (m[2] as string).length - 1, q: slug(m[2] as string) } : null
  }
  const close = () => {
    pop.hidden = true
    token = null
  }
  const paint = () => {
    if (!token) return close()
    const q = token.q
    const open = fleetChats()
    list = open
      .map((r) => ({ r, s: rank(r, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || chatName(a.r).localeCompare(chatName(b.r)))
      .map((x) => x.r)
      .slice(0, 8)
    const shut = q
      ? closedChats()
          .filter((r) => rank(r, q) > 0 && !open.some((o) => o.id === r.id))
          .slice(0, 2)
      : []
    sel = Math.min(sel, Math.max(0, list.length - 1))
    pop.innerHTML =
      (list.length
        ? list
            .map(
              (
                r,
                i,
              ) => `<button type="button" role="option" class="ck-at-i${i === sel ? ' on' : ''}" data-i="${i}" aria-selected="${i === sel}">
            <span class="ck-at-dot st-${esc(r.state)}"></span>
            <span class="ck-at-t"><b>${esc(chatName(r))}</b><em>${esc(r.repo)}</em></span>
            <span class="ck-at-h">@${esc(handleOf(r, open))}</span>
          </button>`,
            )
            .join('')
        : `<p class="ck-at-none">${open.length ? 'No open chat matches' : 'No other chats are open'}</p>`) +
      shut.map((r) => `<p class="ck-at-shut"><b>${esc(chatName(r))}</b> has closed</p>`).join('')
    const b = box.getBoundingClientRect()
    pop.style.left = `${b.left}px`
    pop.style.bottom = `${innerHeight - b.top + 6}px`
    pop.style.width = `${Math.min(420, b.width)}px`
    pop.hidden = false
  }
  const pick = (i: number) => {
    const r = list[i]
    if (!r || !token) return close()
    const h = `@${handleOf(r)} `
    const after = input.value.slice(input.selectionStart ?? input.value.length)
    input.value = `${input.value.slice(0, token.start)}${h}${after.replace(/^[\w.-]*\s?/, '')}`
    const at = token.start + h.length
    input.setSelectionRange(at, at)
    close()
    input.focus()
    input.dispatchEvent(new Event('input'))
  }

  const onInput = () => {
    token = tokenAt()
    if (token) paint()
    else close()
  }
  const onKey = (e: KeyboardEvent) => {
    if (pop.hidden || e.isComposing) return
    const take = () => {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      take()
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % Math.max(1, list.length)
      paint()
    } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      if (!list.length) return close()
      take()
      pick(sel)
    } else if (e.key === 'Escape') {
      take()
      close()
    }
  }
  pop.addEventListener('mousedown', (e) => {
    e.preventDefault()
    const i = (e.target as HTMLElement).closest<HTMLElement>('[data-i]')?.dataset.i
    if (i !== undefined) pick(Number(i))
  })
  input.addEventListener('input', onInput)
  input.addEventListener('keydown', onKey, true)
  input.addEventListener('blur', close)
  // the chats must be current while you type, and the list follows them if it is open
  const unsub = subscribeFleet(() => {
    if (!pop.hidden) paint()
  })
  return () => {
    unsub()
    input.removeEventListener('input', onInput)
    input.removeEventListener('keydown', onKey, true)
    input.removeEventListener('blur', close)
    pop.remove()
  }
}

/**
 * Send "@chat message" where it belongs. Returns false when the text is not routed (it goes to
 * the conductor as usual). `put` puts text back in the box; `note` writes a line in the log; the
 * bar for a closed chat goes just above `box`.
 */
export function routeFromConductor(
  text: string,
  o: {
    box: HTMLElement
    put: (text: string) => void
    note: (text: string, tone?: 'ok' | 'err') => void
  },
): boolean {
  const p = parseRouted(text)
  if (!p) return false
  const t = resolveHandle(p.handle)
  if ('open' in t) {
    void deliver(t.open, p.body, o)
    return true
  }
  o.put(text)
  if ('closed' in t) flagClosed(t.closed, p.body, text, o)
  else if ('ambiguous' in t)
    o.note(
      `@${p.handle} could be ${t.ambiguous.map((r) => `${chatName(r)} (${r.repo})`).join(' or ')}. Pick one from the @ list.`,
      'err',
    )
  else
    o.note(
      `No open chat is called @${p.handle}, so nothing was sent. It is back in the box.`,
      'err',
    )
  return true
}

async function deliver(r: FleetRow, body: string, o: Parameters<typeof routeFromConductor>[1]) {
  try {
    const ap = await fetch(`${API}/autopilot`, { signal: AbortSignal.timeout(5000) })
      .then((x) => x.json())
      .catch(() => null)
    const autopilot = !!ap && ap.mode !== 'off' && !ap.halted
    if (r.state === 'idle' && autopilot) {
      const x = await fetch(`${API}/sessions/${encodeURIComponent(r.id)}/message`, {
        method: 'POST',
        headers: WRITE,
        body: JSON.stringify({ text: body }),
      })
      if (x.status === 404) throw new Error(`${chatName(r)} has closed`)
      if (!x.ok) throw new Error(`could not reach ${chatName(r)} (${x.status})`)
      o.note(`Sent to ${chatName(r)} now: it was idle and autopilot is on.`, 'ok')
    } else {
      await queueFor(r.id, body)
      const why =
        r.state === 'idle'
          ? 'autopilot is off, so it waits for you'
          : `it is ${r.state === 'waiting' ? 'waiting on you' : 'busy'}`
      o.note(`Queued for ${chatName(r)}: ${why}.`, 'ok')
    }
  } catch (e) {
    o.put(`@${handleOf(r)} ${body}`)
    o.note(`Not sent: ${(e as Error).message}. It is back in the box.`, 'err')
  }
}

function flagClosed(
  r: FleetRow,
  body: string,
  full: string,
  o: Parameters<typeof routeFromConductor>[1],
) {
  o.box.parentElement?.querySelector('.ck-flag')?.remove()
  const bar = document.createElement('div')
  bar.className = 'ck-flag'
  bar.setAttribute('role', 'alert')
  bar.innerHTML = `<span><b>${esc(chatName(r))}</b> has closed. Nothing was sent.</span>
    <button type="button" data-f="pile">Queue it unassigned</button>
    <button type="button" data-f="x" aria-label="Dismiss">Keep editing</button>`
  o.box.before(bar)
  bar.addEventListener('click', async (e) => {
    const f = (e.target as HTMLElement).closest<HTMLElement>('[data-f]')?.dataset.f
    if (!f) return
    bar.remove()
    if (f !== 'pile') return
    try {
      await queueFor(null, body)
      o.put('')
      o.note(`Put on the unassigned pile: ${chatName(r)} had closed.`, 'ok')
    } catch (err) {
      o.put(full)
      o.note(`Not queued: ${(err as Error).message}`, 'err')
    }
  })
}
