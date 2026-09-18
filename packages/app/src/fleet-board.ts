/**
 * The fleet board: every open chat on one line, and a button for each decision waiting on you.
 *
 *   ● Title  repo   where it stands, in one line          [Approve push] [Retries]   ~4m left
 *
 * A line is all you see until you open it: click the row for the goal, next step, tasks and the
 * last few steps; click a decision for the whole command or question and answer it there. The
 * chat keeps every word, and "Open chat" is one click from any row, so looking at less loses
 * nothing. The rows come from the host's /fleet (fleet-board.mjs), whose ETA is the live progress
 * board's or the status line's, never a guess of its own.
 *
 * The host orders the rows: a "Needs you" strip first (every chat stopped on a decision or a
 * blocked, stalled or orphaned progress board, each tagged with its group), then ungrouped chats,
 * then each group. ⌥1–⌥9 jumps to the Nth header on the page, the strip counting as 1 when it is
 * there; each header shows its key. Not ⌘1–9 (the shell's tab switching) nor ⌥⌘1–4 (the chat
 * groups in sessions.ts), and it is left alone while you type in one of the board's own fields.
 */
import './fleet-board.css'

type Question = {
  question: string
  header: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
}
type Decision = {
  requestId: string
  kind: 'permission' | 'question' | 'ship' | 'attention'
  /** attention: the live progress board's state */
  state?: 'blocked' | 'stalled' | 'orphaned'
  ship?: 'push' | 'publish' | 'deploy' | 'release' | null
  label: string
  detail: string
  tool?: string
  input?: Record<string, unknown>
  canAlways?: boolean
  questions?: Question[]
  at?: number
}
type Todo = { content: string; status: string; activeForm?: string }
type Eta = {
  at: number
  source: 'progress' | 'status'
  basis: string | null
  typicalMs: number | null
  label: string
}
type Progress = {
  id: string
  title: string
  note: string
  pct: number
  state: string
  lanes: { name: string; status: string; pct: number; note: string; stalled: boolean }[]
}
type Row = {
  id: string
  sdkSessionId: string | null
  repo: string
  cwd: string
  title: string
  role: string | null
  /** the conductor's label for a set of chats (fleet_rename); rows arrive with each group together */
  group?: string | null
  /** 'needs-you': pinned above the groups, a decision or attention waiting; 'group': in its group's block */
  section?: 'needs-you' | 'group'
  state: string
  status: string
  eta: Eta | null
  since: number | null
  decisions: Decision[]
  progress: Progress | null
  goal: string
  next: string
  todos: Todo[]
  recent: { who: string; text: string }[]
  cost: number
  turns: number
  updatedAt: number
}

/** the load watcher's view of this Mac (GET /api/loadwatch, feeds/loadwatch.mjs) */
type Load = {
  busy: boolean
  since: number | null
  notice: string | null
  heavy: {
    label: string
    owner: string
    cpu: number
    mem: number
    offloadable?: boolean
    goesTo?: string | null
  }[]
}

export type FleetBoard = {
  el: HTMLElement
  isOpen: () => boolean
  toggle: (on?: boolean) => void
  refresh: () => Promise<void>
}

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
const dur = (ms: number) => {
  const m = Math.round(ms / 60_000)
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

/** the right-hand column: the status line's ETA, else how long it has been waiting or working */
function whenText(r: Row, now: number): { text: string; title: string; cls: string } {
  if (r.decisions.some((d) => d.kind !== 'attention')) {
    const t = r.since ? dur(now - r.since) : ''
    return { text: t ? `on you · ${t}` : 'on you', title: 'Waiting on your decision', cls: 'you' }
  }
  if (r.eta) {
    const left = r.eta.at - now
    const basis = ` (${r.eta.source === 'progress' ? 'live progress' : 'status line'}${r.eta.basis ? `, ${r.eta.basis}` : ''})`
    if (left > 0)
      return {
        text: `~${dur(left)} left`,
        title: `${r.eta.label}: estimated${basis}`,
        cls: 'eta',
      }
    return {
      text: r.eta.typicalMs ? 'overdue' : 'almost done',
      title: r.eta.typicalMs
        ? `${r.eta.label}: usually takes ${dur(r.eta.typicalMs)}`
        : r.eta.label,
      cls: 'eta over',
    }
  }
  if ((r.state === 'running' || r.state === 'starting') && r.since)
    return {
      text: `${dur(now - r.since)} in`,
      title: 'No estimate yet: time spent so far',
      cls: 'run',
    }
  if (r.state === 'error') return { text: 'stopped', title: '', cls: 'err' }
  return {
    text: r.updatedAt ? `${dur(now - r.updatedAt)} ago` : '',
    title: 'Last activity',
    cls: '',
  }
}

const decisionClass = (d: Decision) => `fb-d ${d.kind}${d.ship ? ` ${d.ship}` : ''}`

export function createFleetBoard(o: {
  api: string
  titleOf: (row: { id: string; title: string }) => string
  colourOf: (cwd: string, repo: string) => string
  open: (id: string) => void
  onClose?: () => void
}): FleetBoard {
  const el = document.createElement('div')
  el.className = 'fb'
  el.hidden = true
  el.setAttribute('role', 'region')
  el.setAttribute('aria-label', 'Fleet board')
  el.innerHTML = `
    <div class="fb-h">
      <b>Fleet</b><span class="fb-sum" data-fb="sum"></span>
      <span class="fb-keys" title="⌥1–⌥9 jump to a group"><kbd>⌥⌘B</kbd></span>
      <button type="button" class="fb-x" data-fb="close" title="Close (esc)" aria-label="Close the fleet board">×</button>
    </div>
    <div class="fb-load" data-fb="load" hidden></div>
    <div class="fb-list" data-fb="list" role="list"></div>`
  const list = el.querySelector('[data-fb="list"]') as HTMLElement
  const sum = el.querySelector('[data-fb="sum"]') as HTMLElement
  const loadEl = el.querySelector('[data-fb="load"]') as HTMLElement
  let load: Load | null = null
  let loadOpen = false

  let rows: Row[] = []
  let loaded = false
  let failed = false
  /** rows opened for detail, and the one decision open per chat */
  const expanded = new Set<string>()
  const openDecision = new Map<string, string>()
  /** answers sent and not yet gone from the host */
  const sent = new Set<string>()
  /** a question being answered: picks per question, typed "other" text */
  const picks = new Map<string, { chosen: Set<string>[]; other: string[] }>()
  let timer: ReturnType<typeof setInterval> | null = null
  let clock: ReturnType<typeof setInterval> | null = null

  async function refresh() {
    // the Mac's own load, beside the chats; a build without the load watcher answers 404
    fetch('/api/loadwatch', { signal: AbortSignal.timeout(8000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Load | null) => {
        load = j && typeof j.busy === 'boolean' ? j : null
        paintLoad()
      })
      .catch(() => {})
    try {
      const r = await fetch(`${o.api}/fleet`, { signal: AbortSignal.timeout(8000) })
      if (!r.ok) throw new Error(String(r.status))
      const j = (await r.json()) as { rows: Row[] }
      rows = j.rows ?? []
      failed = false
    } catch {
      failed = true
    }
    loaded = true
    const live = new Set(rows.flatMap((r) => r.decisions.map((d) => d.requestId)))
    for (const id of sent) if (!live.has(id)) sent.delete(id)
    for (const [chat, req] of openDecision) if (!live.has(req)) openDecision.delete(chat)
    for (const req of picks.keys()) if (!live.has(req)) picks.delete(req)
    paint()
  }

  function decisionPanel(r: Row, d: Decision) {
    const waiting = sent.has(d.requestId)
    if (d.kind === 'attention') {
      const p = r.progress
      const lanes = (p?.lanes ?? [])
        .map(
          (l) =>
            `<li class="${esc(l.stalled ? 'stalled' : l.status)}"><span>${esc(l.stalled ? 'stalled' : l.status)}</span>${esc(l.name)}${l.pct ? ` · ${l.pct}%` : ''}${l.note ? ` <em>${esc(l.note)}</em>` : ''}</li>`,
        )
        .join('')
      return `<div class="fb-panel attention" data-req="${esc(d.requestId)}">
        <p class="fb-desc">${esc(d.detail)}</p>
        ${lanes ? `<ul class="fb-lanes">${lanes}</ul>` : ''}
        <div class="fb-acts">
          <a class="fb-go" href="/runs" target="_blank" rel="noopener">Open runs</a>
          <button type="button" class="fb-open" data-fa="open">Open chat</button>
        </div></div>`
    }
    if (d.kind === 'question') {
      const p = picks.get(d.requestId) ?? {
        chosen: (d.questions ?? []).map(() => new Set<string>()),
        other: (d.questions ?? []).map(() => ''),
      }
      picks.set(d.requestId, p)
      const qs = (d.questions ?? [])
        .map(
          (q, qi) => `<div class="fb-q">
            <div class="fb-q-h"><span>${esc(q.header || 'Question')}</span>${esc(q.question)}${q.multiSelect ? ' <small>choose any</small>' : ''}</div>
            <div class="fb-opts">${q.options
              .map(
                (op) =>
                  `<button type="button" class="fb-opt${p.chosen[qi]?.has(op.label) ? ' on' : ''}" data-fq="${qi}" data-fo="${esc(op.label)}" title="${esc(op.description ?? '')}"${waiting ? ' disabled' : ''}>${esc(op.label)}</button>`,
              )
              .join('')}
              <input class="fb-other" data-fq-other="${qi}" placeholder="Something else…" value="${esc(p.other[qi] ?? '')}" aria-label="Another answer"${waiting ? ' disabled' : ''} /></div>
          </div>`,
        )
        .join('')
      return `<div class="fb-panel question" data-req="${esc(d.requestId)}">${qs}
        <div class="fb-acts">
          <button type="button" class="fb-go" data-fa="submit"${waiting ? ' disabled' : ''}>${waiting ? 'Sent…' : 'Answer'}</button>
          <button type="button" data-fa="skip"${waiting ? ' disabled' : ''}>Skip</button>
          <button type="button" class="fb-open" data-fa="open">Open chat</button>
        </div></div>`
    }
    const input = d.input ?? {}
    const cmd =
      d.tool === 'Bash'
        ? String(input.command ?? '')
        : typeof input.file_path === 'string'
          ? [
              input.file_path,
              typeof input.old_string === 'string' ? `\n− ${input.old_string}` : '',
              typeof input.new_string === 'string' ? `\n+ ${input.new_string}` : '',
              typeof input.content === 'string' ? `\n${input.content}` : '',
            ].join('')
          : JSON.stringify(input, null, 2)
    const clipped =
      cmd.length > 4000 ? `${cmd.slice(0, 4000)}\n… (open the chat for the rest)` : cmd
    const yes = d.kind === 'ship' ? d.label : 'Allow'
    return `<div class="fb-panel ${d.kind}" data-req="${esc(d.requestId)}">
      ${d.kind === 'ship' ? `<p class="fb-warn">This sends work out of this Mac and cannot be taken back from here.</p>` : ''}
      ${input.description ? `<p class="fb-desc">${esc(input.description)}</p>` : ''}
      <pre class="fb-cmd"><span>${esc(d.tool ?? '')}</span>${esc(clipped)}</pre>
      <div class="fb-acts">
        <button type="button" class="fb-go${d.kind === 'ship' ? ' ship' : ''}" data-fa="allow"${waiting ? ' disabled' : ''}>${waiting ? 'Sent…' : esc(yes)}</button>
        ${d.canAlways && d.kind !== 'ship' ? `<button type="button" data-fa="always"${waiting ? ' disabled' : ''}>Always allow</button>` : ''}
        <input class="fb-deny-note" data-fa-note placeholder="Deny, and tell Claude what to do instead…" aria-label="Deny with a note"${waiting ? ' disabled' : ''} />
        <button type="button" class="fb-no" data-fa="deny"${waiting ? ' disabled' : ''}>Deny</button>
        <button type="button" class="fb-open" data-fa="open">Open chat</button>
      </div></div>`
  }

  function detail(r: Row) {
    const todos = r.todos.length
      ? `<ol class="fb-todos">${r.todos
          .map(
            (t) =>
              `<li class="${esc(t.status)}">${esc(t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content)}</li>`,
          )
          .join('')}</ol>`
      : ''
    const recent = r.recent.length
      ? `<ul class="fb-recent">${r.recent.map((x) => `<li class="${esc(x.who)}"><span>${esc(x.who)}</span>${esc(x.text)}</li>`).join('')}</ul>`
      : ''
    const meta = [
      r.repo,
      `${r.turns} turn${r.turns === 1 ? '' : 's'}`,
      r.cost ? `$${r.cost.toFixed(2)}` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    return `<div class="fb-more">
      ${r.goal ? `<p><b>Goal</b>${esc(r.goal)}</p>` : ''}
      <p><b>Now</b>${esc(r.status)}</p>
      ${r.progress ? `<p><b>Progress</b>${esc(r.progress.title)} · ${r.progress.pct}% · ${esc(r.progress.state)}</p>` : ''}
      ${r.next ? `<p><b>Next</b>${esc(r.next)}</p>` : ''}
      ${todos}${recent}
      <div class="fb-acts"><span class="fb-meta">${esc(meta)}</span><button type="button" class="fb-open" data-fa="open">Open chat</button></div>
    </div>`
  }

  /** a row in three parts, each replaced only when it changed: a panel you are using stays put */
  function rowParts(r: Row): [string, string, string] {
    const state = r.decisions.some((d) => d.kind !== 'attention')
      ? 'waiting'
      : r.decisions.length
        ? 'blocked'
        : r.state
    const openReq = openDecision.get(r.id)
    const open = openReq ? r.decisions.find((d) => d.requestId === openReq) : undefined
    const buttons = r.decisions
      .map(
        (d) =>
          `<button type="button" class="${decisionClass(d)}${d.requestId === openReq ? ' on' : ''}${sent.has(d.requestId) ? ' sent' : ''}" data-fd="${esc(d.requestId)}" title="${esc(d.detail)}" aria-expanded="${d.requestId === openReq}">${esc(d.label)}</button>`,
      )
      .join('')
    return [
      `<div class="fb-line" data-fl>
        <i class="st ${esc(state)}"></i>
        <span class="fb-t"><span class="fb-title">${r.role === 'conductor' ? '♛ ' : ''}${esc(o.titleOf(r))}</span><em style="--repo:${esc(o.colourOf(r.cwd, r.repo))}">${esc(r.repo)}</em>${r.section === 'needs-you' && r.group ? `<span class="fb-tag" title="Group">${esc(r.group)}</span>` : ''}</span>
        <span class="fb-s" title="${esc(r.status)}">${esc(r.status)}</span>
        <span class="fb-ds">${buttons}</span>
        <span class="fb-w" data-fw></span>
        <button type="button" class="fb-exp" data-fx aria-label="${expanded.has(r.id) ? 'Hide details' : 'Show details'}" aria-expanded="${expanded.has(r.id)}">${expanded.has(r.id) ? '▾' : '▸'}</button>
      </div>`,
      open ? decisionPanel(r, open) : '',
      expanded.has(r.id) ? detail(r) : '',
    ]
  }
  /** the time column ticks every second, so it is written in place rather than re-rendered */
  function paintWhen(n: HTMLElement, r: Row, now: number) {
    const cell = n.querySelector<HTMLElement>('[data-fw]')
    if (!cell) return
    const w = whenText(r, now)
    if (cell.textContent !== w.text) cell.textContent = w.text
    cell.className = `fb-w ${w.cls}`
    cell.title = w.title
  }

  /** one line while the Mac is busy, what is heavy and whose it is when opened */
  function paintLoad() {
    loadEl.hidden = !load?.busy || !load.notice
    if (loadEl.hidden || !load) return
    const heavy = load.heavy
      .map(
        (h) =>
          `<li><b>${esc(h.label)}</b><span>${esc(h.owner)}</span><span>${h.cpu}% CPU · ${(h.mem / 1e9).toFixed(1)} GB</span><em>${h.offloadable ? (h.goesTo ? `new ones go to ${esc(h.goesTo)}` : 'can run on the machines') : 'here only'}</em></li>`,
      )
      .join('')
    const html = `<button type="button" class="fb-load-h" data-fb="loadtoggle" aria-expanded="${loadOpen}"${heavy ? '' : ' disabled'}><i aria-hidden="true"></i>${esc(load.notice)}${load.since ? '<small data-fb="loadfor"></small>' : ''}</button>${loadOpen && heavy ? `<ul>${heavy}</ul>` : ''}`
    if (loadEl.dataset.sig !== html) {
      loadEl.dataset.sig = html
      loadEl.innerHTML = html
    }
    const since = loadEl.querySelector<HTMLElement>('[data-fb="loadfor"]')
    if (since && load.since) since.textContent = `for ${dur(Date.now() - load.since)}`
  }

  function paint() {
    if (el.hidden) return
    paintLoad()
    const now = Date.now()
    const need = rows.reduce(
      (n, r) => n + r.decisions.filter((d) => d.kind !== 'attention').length,
      0,
    )
    const heed = rows.reduce(
      (n, r) => n + r.decisions.filter((d) => d.kind === 'attention').length,
      0,
    )
    const busy = rows.filter((r) => r.state === 'running' || r.state === 'starting').length
    sum.textContent = loaded
      ? `${rows.length} chat${rows.length === 1 ? '' : 's'} · ${busy} working · ${need ? `${need} decision${need === 1 ? '' : 's'} waiting on you` : 'nothing waiting on you'}${heed ? ` · ${heed} need${heed === 1 ? 's' : ''} a look` : ''}${failed ? ' · host not answering' : ''}`
      : 'Loading…'
    sum.classList.toggle('need', need > 0)
    if (loaded && !rows.length) {
      list.innerHTML = `<p class="fb-empty">${failed ? 'The agent host is not answering.' : 'No chats are open.'}</p>`
      return
    }
    const keep = new Map<string, HTMLElement>()
    for (const n of list.querySelectorAll<HTMLElement>(':scope > [data-row], :scope > [data-head]'))
      keep.set(n.dataset.row ?? `head:${n.dataset.head}`, n)
    let prev: HTMLElement | null = null
    const place = (n: HTMLElement) => {
      const at: ChildNode | null = prev ? prev.nextSibling : list.firstChild
      if (n !== at) list.insertBefore(n, at)
      prev = n
    }
    const pinned = rows.filter((x) => x.section === 'needs-you')
    let head: string | null = null
    let heads = 0
    for (const r of rows) {
      // a header above the Needs you strip and each group; ungrouped chats have one only below the strip
      const key =
        r.section === 'needs-you'
          ? 'needs-you'
          : r.group
            ? `group:${r.group}`
            : pinned.length
              ? 'ungrouped'
              : null
      if (key && key !== head) {
        const members = rows.filter((x) =>
          key === 'needs-you'
            ? x.section === 'needs-you'
            : x.section !== 'needs-you' && (x.group ?? null) === (r.group ?? null),
        )
        const above = r.group ? pinned.filter((x) => x.group === r.group).length : 0
        const text = `${members.length} chat${members.length === 1 ? '' : 's'}${above ? ` · ${above} more in Needs you` : ''}`
        let h = keep.get(`head:${key}`)
        keep.delete(`head:${key}`)
        if (!h) {
          h = document.createElement('div')
          h.className = `fb-group${key === 'needs-you' ? ' need' : ''}`
          h.dataset.head = key
          h.setAttribute('role', 'presentation')
          h.innerHTML = `<b>${esc(key === 'needs-you' ? 'Needs you' : (r.group ?? 'Ungrouped'))}</b><span></span><kbd></kbd>`
        }
        heads++
        ;(h.children[1] as HTMLElement).textContent = text
        ;(h.children[2] as HTMLElement).textContent = heads <= 9 ? `⌥${heads}` : ''
        place(h)
      }
      head = key
      const parts = rowParts(r)
      let n = keep.get(r.id)
      keep.delete(r.id)
      if (!n) {
        n = document.createElement('div')
        n.className = 'fb-row'
        n.dataset.row = r.id
        n.setAttribute('role', 'listitem')
        for (const _ of parts) n.appendChild(document.createElement('div')).dataset.part = ''
      }
      for (const [i, html] of parts.entries()) {
        const part = n.children[i] as HTMLElement
        // a part you are typing in is left alone until you finish
        const typing =
          part.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT'
        if (part.dataset.sig === html || typing) continue
        part.dataset.sig = html
        part.innerHTML = html
      }
      paintWhen(n, r, now)
      n.className = `fb-row ${r.decisions.some((d) => d.kind !== 'attention') ? 'need' : r.decisions.length ? 'heed' : r.state}${expanded.has(r.id) || openDecision.has(r.id) ? ' open' : ''}`
      place(n)
    }
    for (const n of keep.values()) n.remove()
    list.querySelector('.fb-empty')?.remove()
  }

  const rowOf = (t: HTMLElement) => {
    const id = t.closest<HTMLElement>('[data-row]')?.dataset.row
    return id ? rows.find((r) => r.id === id) : undefined
  }

  async function respond(r: Row, requestId: string, reply: Record<string, unknown>) {
    sent.add(requestId)
    paint()
    try {
      const res = await fetch(`${o.api}/sessions/${encodeURIComponent(r.id)}/respond`, {
        method: 'POST',
        // agent control refuses a write without it: a page on another site cannot send this header
        headers: { 'content-type': 'application/json', 'x-control': '1' },
        body: JSON.stringify({ requestId, reply }),
      })
      // 404: already answered elsewhere (in the chat, or by away mode); the refresh shows it gone
      if (!res.ok && res.status !== 404) sent.delete(requestId)
    } catch {
      sent.delete(requestId)
    }
    await refresh()
  }

  function answerQuestion(r: Row, d: Decision, skip: boolean) {
    const p = picks.get(d.requestId)
    const qs = d.questions ?? []
    if (skip) return respond(r, d.requestId, { behavior: 'allow', answers: {} })
    const answers: Record<string, string> = {}
    for (const [i, q] of qs.entries()) {
      const typed = p?.other[i]?.trim()
      const all = [...(p?.chosen[i] ?? []), ...(typed ? [typed] : [])]
      if (!all.length) {
        el.querySelector<HTMLElement>(
          `[data-req="${CSS.escape(d.requestId)}"] [data-fq-other="${i}"]`,
        )?.focus()
        return
      }
      answers[q.question] = all.join(', ')
    }
    return respond(r, d.requestId, { behavior: 'allow', answers })
  }

  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.closest('[data-fb="close"]')) return toggle(false)
    if (t.closest('[data-fb="loadtoggle"]')) {
      loadOpen = !loadOpen
      return paintLoad()
    }
    const r = rowOf(t)
    if (!r) return
    const dBtn = t.closest<HTMLElement>('[data-fd]')
    if (dBtn) {
      const req = dBtn.dataset.fd as string
      if (openDecision.get(r.id) === req) openDecision.delete(r.id)
      else openDecision.set(r.id, req)
      paint()
      el.querySelector<HTMLElement>(
        `[data-req="${CSS.escape(req)}"] .fb-go, [data-req="${CSS.escape(req)}"] .fb-opt`,
      )?.focus()
      return
    }
    const act = t.closest<HTMLElement>('[data-fa]')?.dataset.fa
    const req = t.closest<HTMLElement>('[data-req]')?.dataset.req
    const d = req ? r.decisions.find((x) => x.requestId === req) : undefined
    if (act === 'open') {
      toggle(false)
      return o.open(r.id)
    }
    if (d && act === 'allow') return respond(r, d.requestId, { behavior: 'allow' })
    if (d && act === 'always') return respond(r, d.requestId, { behavior: 'allow', always: true })
    if (d && act === 'deny') {
      const note = t.closest('.fb-panel')?.querySelector<HTMLInputElement>('[data-fa-note]')
      return respond(r, d.requestId, { behavior: 'deny', message: note?.value.trim() ?? '' })
    }
    if (d && (act === 'submit' || act === 'skip')) return answerQuestion(r, d, act === 'skip')
    const opt = t.closest<HTMLElement>('[data-fo]')
    if (d && opt) {
      const qi = Number(opt.dataset.fq)
      const q = d.questions?.[qi]
      const p = picks.get(d.requestId)
      const set = p?.chosen[qi]
      if (!q || !set) return
      const label = opt.dataset.fo as string
      if (q.multiSelect) set.has(label) ? set.delete(label) : set.add(label)
      else {
        const was = set.has(label)
        set.clear()
        if (!was) set.add(label)
        // one question, one choice: that is the answer
        if (!was && (d.questions?.length ?? 0) === 1) return answerQuestion(r, d, false)
      }
      return paint()
    }
    // anywhere else on the line opens or closes the detail
    if (t.closest('[data-fl]') && !t.closest('input')) {
      expanded.has(r.id) ? expanded.delete(r.id) : expanded.add(r.id)
      paint()
    }
  })
  el.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement
    const req = t.closest<HTMLElement>('[data-req]')?.dataset.req
    if (req && t.dataset.fqOther !== undefined) {
      const p = picks.get(req)
      if (p) p.other[Number(t.dataset.fqOther)] = t.value
    }
  })
  el.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement
    if (e.key === 'Escape') {
      // out of a field first; after that, in a panel, Escape is the panel's to close it
      if (t.tagName === 'INPUT') {
        e.preventDefault()
        e.stopPropagation()
        return t.blur()
      }
      if (el.closest('.pnl')) return
      e.stopPropagation()
      return toggle(false)
    }
    if (e.key !== 'Enter' || t.tagName !== 'INPUT') return
    const r = rowOf(t)
    const req = t.closest<HTMLElement>('[data-req]')?.dataset.req
    const d = r && req ? r.decisions.find((x) => x.requestId === req) : undefined
    if (!r || !d) return
    e.preventDefault()
    if (t.matches('[data-fa-note]'))
      respond(r, d.requestId, { behavior: 'deny', message: (t as HTMLInputElement).value.trim() })
    else answerQuestion(r, d, false)
  })

  /** ⌥1–⌥9 while the board is on screen: scroll to the Nth header (Needs you is 1 when shown) and flash it */
  addEventListener('keydown', (e) => {
    if (el.hidden || !el.isConnected || !el.getClientRects().length) return
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
    // by code: ⌥ changes e.key (⌥1 is ¡ on a Mac keyboard)
    const n = /^Digit([1-9])$/.exec(e.code)
    // a field of the board's own keeps its keys; one elsewhere is under the board
    if (!n || (e.target as HTMLElement).closest?.('.fb input, .fb textarea')) return
    const h = list.querySelectorAll<HTMLElement>(':scope > [data-head]')[Number(n[1]) - 1]
    if (!h) return
    e.preventDefault()
    h.scrollIntoView({ block: 'start', behavior: 'smooth' })
    h.classList.remove('flash')
    void h.offsetWidth
    h.classList.add('flash')
    setTimeout(() => h.classList.remove('flash'), 1200)
  })

  function toggle(on = el.hidden) {
    if (on === !el.hidden) return
    el.hidden = !on
    if (timer) clearInterval(timer)
    if (clock) clearInterval(clock)
    timer = clock = null
    if (!on) return o.onClose?.()
    paint()
    refresh()
    timer = setInterval(refresh, 3000)
    // the waiting and time-left column moves between fetches
    clock = setInterval(paint, 1000)
  }

  return { el, isOpen: () => !el.hidden, toggle, refresh }
}
