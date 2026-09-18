/**
 * Autopilot in the app: the control you can always see, and the four views behind it.
 *
 * Every view here is a mount function over a plain element and nothing else: no overlay, no close
 * button, no key handler, no memory of whether it is open. The chrome around them is somebody
 * else's job — today workbench.ts, shortly the sliding panel system (autopilot-panels.ts is the
 * one file that knows which). Keep it that way: adopting the panel API should be a wrapper change.
 *
 *   mountAutopilotControl   off / on / away, what it may do, actions taken, spend, kill switch
 *   mountConductorPanel     every chat: state, ETA, what the conductor last sent, queued, waiting on
 *   mountDecisionInbox      everything outward-facing waiting on you, in one list
 *   mountPolicyView         what may happen unattended, the budget, per-repo overrides, overridden defaults
 *   mountTimeline           every conductor action with its reason, and undo where there is one
 *
 * Nothing in this file ever answers a permission for you. The inbox's buttons post your click to
 * the same route a chat's own permission card uses, and that is the only way one is answered.
 */
import './autopilot.css'
import * as activity from './activity.ts'

const API = '/api/control/agent'
const WRITE = { 'x-control': '1', 'content-type': 'application/json' }

export type Mode = 'off' | 'on' | 'away'
export type Unmount = () => void

export type Control = {
  mode: Mode
  since: number | null
  halted: { at: number; reason: string } | null
  conductor: {
    id: string
    repo: string
    goal: string
    state: string
    autopilot: boolean
    until: number | null
    checkins: number
  } | null
  may: string[]
  actions: number
  counts: Record<string, number>
  spend: { dollars: number; since: number | null }
  budget: { dollars?: number; spawns?: number } | null
  budgetHit: { what: string; at: number } | null
  away: {
    on: boolean
    until: number | null
    left: number
    goal: string
    approved: number
    asked: number
    recovered: number
    summary: string | null
    endedAt: number | null
    conductorId: string | null
  }
}

type Decision = {
  id: string
  chat: string | null
  requestId?: string
  repo?: string
  title?: string
  kind: string
  outward: boolean
  tool: string | null
  what: string
  questions:
    | { question: string; header?: string; options?: { label: string; description?: string }[] }[]
    | null
  why: string | null
  allowPattern: string | null
  removedDefault: string | null
  canAlways: boolean
  at: number
}

type Row = {
  id: string
  repo: string
  title: string
  group: string | null
  state: string
  status: string
  eta: string | null
  decisions: { kind: string; label: string }[]
  goal: string
  next: string
  cost: number
  updatedAt: number
  lastSent: { at: number; action: string; text: string; reason: string; id: string } | null
  queued: number
  waitingFor: string | null
}

type Action = {
  id: string
  at: number
  action: string
  mode: Mode
  chat: string | null
  repo: string | null
  text: string
  reason: string
  undo?: { kind: string }
  undone?: { at: number; text: string }
}

// ---------------------------------------------------------------- helpers ----
const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[<>&"']/g,
    (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[m] as string,
  )

const el = (tag: string, cls?: string, html?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html !== undefined) e.innerHTML = html
  return e
}

const get = async <T>(path: string): Promise<T | null> => {
  try {
    const r = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(10_000) })
    return r.ok ? ((await r.json()) as T) : null
  } catch {
    return null
  }
}

const send = async (path: string, body?: unknown, method = 'POST') => {
  try {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: WRITE,
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(20_000),
    })
    const j = await r.json().catch(() => null)
    if (!r.ok) throw new Error(j?.error ?? `${r.status}`)
    return j
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e))
  }
}

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  return m < 60 * 36 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}
const left = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}
const money = (n: number) => `$${n.toFixed(2)}`

/**
 * Poll while the view is on screen and stop when it is not. The panel system will call
 * `onVisible`, but a view mounted anywhere should not keep a chat's host busy when nobody is
 * looking at it, so this watches the document too.
 */
function poll(run: () => void | Promise<void>, ms: number): Unmount {
  let timer: number | undefined
  let stopped = false
  const tick = async () => {
    if (stopped) return
    if (!document.hidden) await run()
    // a quarter as often while another app is in front
    timer = setTimeout(tick, activity.atLeast('away') ? ms * 4 : ms) as unknown as number
  }
  tick()
  const wake = () => {
    if (!document.hidden) run()
  }
  document.addEventListener('visibilitychange', wake)
  return () => {
    stopped = true
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', wake)
  }
}

/** every view refreshes when anything changes autopilot, so two open panels never disagree */
const CHANGED = 'laika:autopilot-changed'
export const autopilotChanged = () => dispatchEvent(new CustomEvent(CHANGED))
const onChanged = (fn: () => void) => {
  addEventListener(CHANGED, fn)
  return () => removeEventListener(CHANGED, fn)
}

const MODE_LABEL: Record<Mode, string> = { off: 'Off', on: 'On', away: 'Away' }
const MODE_HINT: Record<Mode, string> = {
  off: 'The conductor only suggests. Nothing is sent for you.',
  on: 'The conductor sends work to your chats. You answer every permission prompt.',
  away: 'The conductor leads, plainly safe tools are approved in your folders, and stuck chats are brought back.',
}

const KIND_LABEL: Record<string, string> = {
  push: 'Push',
  publish: 'Publish',
  deploy: 'Deploy',
  release: 'Release',
  merge: 'Merge to main',
  message: 'Message someone',
  delete: 'Delete',
  budget: 'Budget',
  question: 'Question',
  permission: 'Permission',
}

// ------------------------------------------------------------- the control ----
/**
 * The control: the mode, what it may do, what it has done, what it has cost, and the kill switch.
 * `compact` is the always-visible chip in the app chrome; without it the same state is laid out
 * in full for a panel. Both are the same code, so they can never say different things.
 */
export function mountAutopilotControl(
  host: HTMLElement,
  o: { compact?: boolean; onOpen?: (view: string) => void } = {},
): Unmount {
  let c: Control | null = null
  let busy = false
  let error = ''
  let inbox = 0
  host.classList.add('ap-control', ...(o.compact ? ['ap-compact'] : []))

  const refresh = async () => {
    const [v, i] = await Promise.all([
      get<Control>('/autopilot'),
      get<{ outward: number; items: unknown[] }>('/autopilot/inbox'),
    ])
    if (v) c = v
    if (i) inbox = i.items.length
    paint()
  }

  function paint() {
    if (!c) {
      host.innerHTML = '<div class="ap-load">…</div>'
      return
    }
    const m = c.mode
    const halted = !!c.halted
    host.dataset.mode = halted ? 'halted' : m
    if (o.compact) {
      // the chip: enough to trust at a glance, and a click for the rest
      host.innerHTML = `
        <button type="button" class="ap-chip" data-ap="open" aria-expanded="false" title="${esc(halted ? `Kill switch on: ${c.halted?.reason || 'the conductor cannot send anything'}` : MODE_HINT[m])}">
          <span class="ap-dot" aria-hidden="true"></span>
          <span class="ap-chip-l">Autopilot</span>
          <b>${esc(halted ? 'Stopped' : MODE_LABEL[m])}</b>
          ${m !== 'off' && c.away.until ? `<i class="ap-clock">${esc(left(c.away.until - Date.now()))}</i>` : ''}
          ${inbox ? `<span class="ap-badge" title="${inbox} waiting on you">${inbox}</span>` : ''}
        </button>`
      return
    }
    host.innerHTML = `
      ${error ? `<p class="ap-err" role="alert">${esc(error)}</p>` : ''}
      ${halted ? `<p class="ap-halted" role="status"><b>Kill switch on.</b> The conductor cannot send anything${c.halted?.reason ? `: ${esc(c.halted.reason)}` : ''}. ${m === 'away' ? 'Safe tools are still being approved and stuck chats still recovered — switch to Off to end that too.' : ''}</p>` : ''}
      <div class="ap-seg" role="radiogroup" aria-label="Autopilot">
        ${(['off', 'on', 'away'] as Mode[])
          .map(
            (k) =>
              `<button type="button" role="radio" aria-checked="${m === k}" class="${m === k ? 'on' : ''}" data-ap="mode" data-mode="${k}" title="${esc(MODE_HINT[k])}"${busy ? ' disabled' : ''}>${MODE_LABEL[k]}</button>`,
          )
          .join('')}
      </div>
      <p class="ap-hint">${esc(MODE_HINT[m])}</p>
      <ul class="ap-may">${c.may.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <dl class="ap-nums">
        <div><dt>Actions</dt><dd>${c.actions}</dd></div>
        <div><dt>Spent</dt><dd>${esc(money(c.spend.dollars))}${c.budget?.dollars ? ` <i>of ${esc(money(c.budget.dollars))}</i>` : ''}</dd></div>
        ${m === 'away' ? `<div><dt>Approved</dt><dd>${c.away.approved}</dd></div><div><dt>Left for you</dt><dd>${c.away.asked}</dd></div>` : ''}
        ${c.since ? `<div><dt>Since</dt><dd>${esc(ago(c.since))}</dd></div>` : ''}
      </dl>
      ${c.budgetHit ? `<p class="ap-warn">Budget reached: ${esc(c.budgetHit.what)}</p>` : ''}
      ${c.conductor ? `<p class="ap-lead"><b>♛ ${esc(c.conductor.repo)}</b> ${esc(c.conductor.state)}${c.conductor.checkins ? ` · ${c.conductor.checkins} check-in${c.conductor.checkins === 1 ? '' : 's'}` : ''}${c.conductor.goal ? `<span>${esc(c.conductor.goal)}</span>` : ''}</p>` : '<p class="ap-lead none">No conductor chat yet: choosing On or Away starts one.</p>'}
      <nav class="ap-links">
        <button type="button" data-ap="go" data-view="conductor">Fleet</button>
        <button type="button" data-ap="go" data-view="inbox">Decisions${inbox ? ` <b>${inbox}</b>` : ''}</button>
        <button type="button" data-ap="go" data-view="policy">Policy</button>
        <button type="button" data-ap="go" data-view="timeline">Activity</button>
      </nav>
      <button type="button" class="ap-kill${halted ? ' released' : ''}" data-ap="${halted ? 'release' : 'kill'}"${busy ? ' disabled' : ''}>
        ${halted ? 'Release the kill switch' : 'Stop the conductor now'}
      </button>
      <p class="ap-kill-hint">${halted ? 'Autopilot stays off until you choose a mode.' : 'Every fleet tool that sends is refused from its next call. Work already running carries on.'}</p>`
  }

  const act = async (fn: () => Promise<unknown>) => {
    busy = true
    error = ''
    paint()
    try {
      await fn()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    busy = false
    await refresh()
    autopilotChanged()
  }

  host.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-ap]')
    if (!t) return
    const k = t.dataset.ap
    if (k === 'go') return o.onOpen?.(t.dataset.view as string)
    if (k === 'open') return o.onOpen?.('control')
    if (k === 'kill')
      return void act(() => send('/autopilot/halt', { reason: 'you hit the kill switch' }))
    if (k === 'release') return void act(() => send('/autopilot/halt', {}, 'DELETE'))
    if (k === 'mode') {
      const mode = t.dataset.mode as Mode
      // Away needs to know for how long; the chrome asks, because asking is a dialog and this is not
      if (mode === 'away' && c?.mode !== 'away') return o.onOpen?.('away')
      return void act(() => send('/autopilot', { mode }))
    }
  })

  refresh()
  const stopPoll = poll(refresh, 5_000)
  const stopBus = onChanged(refresh)
  return () => {
    stopPoll()
    stopBus()
  }
}

/** start away mode from the chrome's dialog: the one place that needs an answer before it acts */
export const startAway = (
  minutes: number,
  goal: string,
  budget?: { dollars?: number; spawns?: number } | null,
) =>
  send('/autopilot', {
    mode: 'away',
    minutes,
    goal,
    ...(budget === undefined ? {} : { budget }),
  }).then((r) => {
    autopilotChanged()
    return r
  })

// ---------------------------------------------------- the conductor panel ----
/**
 * The fleet without opening any of it: every chat's state and ETA, what the conductor last sent
 * it and why, what is queued behind that, and what it is waiting on.
 */
export function mountConductorPanel(host: HTMLElement): Unmount {
  host.classList.add('ap-panel', 'ap-fleet')
  let data: {
    conductor:
      | (Control['conductor'] & { title?: string; waits?: { chat: string; until: string }[] })
      | null
    rows: Row[]
  } | null = null

  const refresh = async () => {
    const d = await get<typeof data>('/autopilot/fleet')
    if (d) data = d
    paint()
  }

  const rowHtml = (r: Row) => `
    <li class="ap-row st-${esc(r.state)}${r.decisions.length ? ' need' : ''}">
      <div class="ap-row-top">
        <span class="ap-row-t">${esc(r.title || r.repo)}</span>
        <em>${esc(r.repo)}</em>
        ${r.group ? `<span class="ap-tag">${esc(r.group)}</span>` : ''}
        <span class="ap-state">${esc(r.state)}</span>
        ${r.eta ? `<span class="ap-eta">${esc(r.eta)}</span>` : ''}
      </div>
      <p class="ap-status">${esc(r.status || r.goal || '')}</p>
      ${
        r.lastSent
          ? `<p class="ap-sent"><b>Conductor ${esc(r.lastSent.action === 'answer' ? 'answered' : r.lastSent.action === 'handoff' ? 'handed over' : 'sent')}</b> ${esc(ago(r.lastSent.at))}: ${esc(r.lastSent.text)}${r.lastSent.reason ? `<i>why: ${esc(r.lastSent.reason)}</i>` : ''}</p>`
          : '<p class="ap-sent none">The conductor has not sent this chat anything</p>'
      }
      <p class="ap-waits">
        ${r.queued ? `<span class="ap-q">${r.queued} queued</span>` : ''}
        ${r.waitingFor ? `<span class="ap-w">conductor waiting for: ${esc(r.waitingFor)}</span>` : ''}
        ${r.decisions.length ? `<span class="ap-d">${r.decisions.length} waiting on you</span>` : ''}
      </p>
    </li>`

  function paint() {
    if (!data) {
      host.innerHTML = '<div class="ap-load">…</div>'
      return
    }
    const c = data.conductor
    host.innerHTML = `
      <header class="ap-head">
        ${c ? `<b>♛ ${esc(c.title || c.repo)}</b><span class="ap-state">${esc(c.state)}</span>${c.goal ? `<p>${esc(c.goal)}</p>` : ''}` : '<b>No conductor</b><p>Switch autopilot on and one starts.</p>'}
        ${c?.waits?.length ? `<p class="ap-waiting">Waiting for ${c.waits.map((w) => `${esc(w.chat.slice(0, 8))} to be ${esc(w.until)}`).join(', ')}</p>` : ''}
      </header>
      ${data.rows.length ? `<ul class="ap-rows">${data.rows.map(rowHtml).join('')}</ul>` : '<p class="ap-empty">No other chats are open.</p>'}`
  }

  refresh()
  const stopPoll = poll(refresh, 5_000)
  const stopBus = onChanged(refresh)
  return () => {
    stopPoll()
    stopBus()
  }
}

// ------------------------------------------------------- the decision inbox ----
/**
 * Everything waiting on you, in one list, what reaches outside this machine first. Approving here
 * posts to the same route the chat's own card uses; "always allow this kind" hands the command to
 * the host, which works the pattern out again itself and never takes one from this page.
 */
export function mountDecisionInbox(host: HTMLElement): Unmount {
  host.classList.add('ap-panel', 'ap-inbox')
  let items: Decision[] = []
  let sent = new Set<string>()
  let error = ''

  const refresh = async () => {
    const d = await get<{ items: Decision[] }>('/autopilot/inbox')
    if (d) {
      items = d.items
      // anything answered elsewhere has gone from the list; stop remembering it
      sent = new Set([...sent].filter((id) => items.some((i) => i.id === id)))
    }
    paint()
  }

  const itemHtml = (d: Decision) => `
    <li class="ap-dec${d.outward ? ' out' : ''}${sent.has(d.id) ? ' sent' : ''}" data-dec="${esc(d.id)}">
      <div class="ap-dec-top">
        <span class="ap-kind k-${esc(d.kind)}">${esc(KIND_LABEL[d.kind] ?? d.kind)}</span>
        ${d.title ? `<span class="ap-dec-t">${esc(d.title)}</span><em>${esc(d.repo)}</em>` : ''}
        <span class="ap-when">${esc(ago(d.at))}</span>
      </div>
      <p class="ap-what">${esc(d.what)}</p>
      ${d.why ? `<p class="ap-why">${esc(d.why)}</p>` : ''}
      ${
        d.kind === 'budget'
          ? '<p class="ap-acts-note">Raise the budget in Policy, or switch autopilot off.</p>'
          : `<div class="ap-acts">
              <button type="button" data-do="yes"${sent.has(d.id) ? ' disabled' : ''}>${d.kind === 'question' ? 'Answer in the chat' : 'Approve'}</button>
              <button type="button" data-do="no"${sent.has(d.id) ? ' disabled' : ''}>Decline</button>
              ${d.removedDefault ? `<button type="button" class="ap-restore" data-do="restore" title="Your policy file switches this built-in off; put it back for every repo">Put back “${esc(d.removedDefault)}”</button>` : d.allowPattern ? `<button type="button" class="ap-always" data-do="always" title="Add “${esc(d.allowPattern)}” to what may run while you are away">Always allow ${esc(d.allowPattern)}</button>` : ''}
            </div>`
      }
    </li>`

  function paint() {
    const out = items.filter((i) => i.outward)
    host.innerHTML = `
      ${error ? `<p class="ap-err" role="alert">${esc(error)}</p>` : ''}
      <header class="ap-head">
        <b>${items.length} waiting on you</b>
        ${out.length ? `<span class="ap-out">${out.length} reach${out.length === 1 ? 'es' : ''} outside this Mac</span>` : ''}
        <p>Nothing here is ever approved for you. Autopilot leaves all of it, whatever mode it is in.</p>
      </header>
      ${items.length ? `<ul class="ap-decs">${items.map(itemHtml).join('')}</ul>` : '<p class="ap-empty">Nothing is waiting on you.</p>'}`
  }

  host.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-do]')
    if (!b) return
    const id = b.closest<HTMLElement>('[data-dec]')?.dataset.dec
    const d = items.find((x) => x.id === id)
    if (!d || !d.chat || !d.requestId) return
    error = ''
    try {
      if (b.dataset.do === 'restore') {
        await send('/autopilot/policy/restore', { pattern: d.removedDefault })
      } else if (b.dataset.do === 'always') {
        await send(`/sessions/${encodeURIComponent(d.chat)}/away-allow`, { requestId: d.requestId })
      } else if (b.dataset.do === 'yes' && d.kind === 'question') {
        // a question wants a considered answer, not a yes: the chat's own card is the place
        dispatchEvent(new CustomEvent('laika:open-chat', { detail: d.chat }))
        return
      } else {
        sent.add(d.id)
        paint()
        await send(`/sessions/${encodeURIComponent(d.chat)}/respond`, {
          requestId: d.requestId,
          reply:
            b.dataset.do === 'yes'
              ? { behavior: 'allow' }
              : { behavior: 'deny', message: 'You declined this from the decision inbox' },
        })
      }
    } catch (err) {
      sent.delete(d.id)
      error = err instanceof Error ? err.message : String(err)
    }
    await refresh()
    autopilotChanged()
  })

  refresh()
  const stopPoll = poll(refresh, 4_000)
  const stopBus = onChanged(refresh)
  return () => {
    stopPoll()
    stopBus()
  }
}

// --------------------------------------------------------- the policy view ----
/**
 * What may happen unattended, in the app rather than in a file you have to remember you edited.
 * The part that matters most is at the top: the safe defaults your own policy file is switching
 * off. One of those, left in silently, is what once left four hours with no approvals at all.
 */
export function mountPolicyView(host: HTMLElement): Unmount {
  host.classList.add('ap-panel', 'ap-policy')
  type Policy = {
    defaults: { read: string[]; write: string[]; bash: string[] }
    additions: { read: string[]; write: string[]; bash: string[] }
    removed: { read: string[]; write: string[]; bash: string[] }
    budget?: { dollars?: number; spawns?: number } | null
    minutes?: number
    repos?: Record<string, { bash?: string[]; removed?: { bash?: string[] } }>
    recovery?: { stallMinutes: number; maxNudges: number; switchAccounts: boolean }
  }
  let p: Policy | null = null
  let c: Control | null = null
  let error = ''
  let saved = ''

  const refresh = async () => {
    const [a, b] = await Promise.all([get<Policy>('/autopilot/policy'), get<Control>('/autopilot')])
    if (a) p = a
    if (b) c = b
    paint()
  }

  const list = (title: string, xs: string[], kind: string, removable: boolean) => `
    <section class="ap-list">
      <h4>${esc(title)} <i>${xs.length}</i></h4>
      ${
        xs.length
          ? `<ul>${xs.map((x) => `<li><code>${esc(x)}</code>${removable ? `<button type="button" data-rm="${esc(x)}" data-kind="${esc(kind)}" title="Stop allowing this">×</button>` : ''}</li>`).join('')}</ul>`
          : '<p class="ap-none">None.</p>'
      }
    </section>`

  function paint() {
    if (!p) {
      host.innerHTML = '<div class="ap-load">…</div>'
      return
    }
    const off = [...p.removed.bash, ...p.removed.read, ...p.removed.write]
    const budget = c?.budget ?? null
    host.innerHTML = `
      ${error ? `<p class="ap-err" role="alert">${esc(error)}</p>` : ''}
      ${saved ? `<p class="ap-saved" role="status">${esc(saved)}</p>` : ''}
      ${
        off.length
          ? `<section class="ap-override">
              <h4>⚠ Your policy file switches off ${off.length} safe default${off.length === 1 ? '' : 's'}</h4>
              <p>These are built in and would be approved without you. Your <code>removed</code> list takes them back out, so every one of them stops a chat until you answer it.</p>
              <ul>${off.map((x) => `<li><code>${esc(x)}</code><button type="button" data-restore="${esc(x)}">Put it back</button></li>`).join('')}</ul>
            </section>`
          : '<section class="ap-override ok"><h4>✓ No safe default is switched off</h4><p>Your policy file only adds to the built-in list.</p></section>'
      }
      <section class="ap-budget">
        <h4>Budget</h4>
        <p>What autopilot may spend and how long it may run before it stops sending and opening chats.</p>
        <div class="ap-fields">
          <label>Dollars<input type="number" min="0" step="1" data-b="dollars" value="${budget?.dollars ?? ''}" placeholder="no limit" /></label>
          <label>Chats it may open<input type="number" min="0" step="1" data-b="spawns" value="${budget?.spawns ?? ''}" placeholder="no limit" /></label>
          <label>Minutes away<input type="number" min="1" step="15" data-b="minutes" value="${p.minutes ?? 240}" /></label>
          <button type="button" data-b="save">Save</button>
        </div>
        ${c?.spend ? `<p class="ap-spent">Spent ${esc(money(c.spend.dollars))}${c.spend.since ? ` since ${esc(ago(c.spend.since))}` : ''}.</p>` : ''}
      </section>
      <section class="ap-repos">
        <h4>Per-repo</h4>
        <p>Commands allowed in one repo only. Everywhere else they still ask you.</p>
        ${
          Object.keys(p.repos ?? {}).length
            ? `<ul>${Object.entries(p.repos ?? {})
                .map(
                  ([repo, r]) =>
                    `<li><b>${esc(repo)}</b>${(r.bash ?? []).map((x) => `<code>${esc(x)}</code><button type="button" data-repo-rm="${esc(x)}" data-repo="${esc(repo)}" title="Stop allowing this here">×</button>`).join('')}</li>`,
                )
                .join('')}</ul>`
            : '<p class="ap-none">None. Add one with “Always allow here” on a decision.</p>'
        }
      </section>
      ${list('You always allow', p.additions.bash, 'bash', true)}
      ${list('Tools you added', [...p.additions.read, ...p.additions.write], 'tool', true)}
      <details class="ap-defaults">
        <summary>Built in: ${p.defaults.bash.length} commands, ${p.defaults.read.length + p.defaults.write.length} tools</summary>
        <ul>${p.defaults.bash.map((x) => `<li><code>${esc(x)}</code></li>`).join('')}</ul>
        <ul>${[...p.defaults.read, ...p.defaults.write].map((x) => `<li><code>${esc(x)}</code></li>`).join('')}</ul>
      </details>`
  }

  const act = async (fn: () => Promise<unknown>, said: string) => {
    error = ''
    saved = ''
    try {
      await fn()
      saved = said
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    await refresh()
    autopilotChanged()
    setTimeout(() => {
      saved = ''
      paint()
    }, 4_000)
  }

  host.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    const rm = t.closest<HTMLElement>('[data-rm]')
    if (rm)
      return void act(
        () =>
          send('/autopilot/policy/allow', {
            pattern: rm.dataset.rm,
            kind: rm.dataset.kind,
            on: false,
          }),
        `“${rm.dataset.rm}” is no longer allowed`,
      )
    const back = t.closest<HTMLElement>('[data-restore]')
    if (back)
      return void act(
        () => send('/autopilot/policy/restore', { pattern: back.dataset.restore }),
        `“${back.dataset.restore}” is a safe default again`,
      )
    const repoRm = t.closest<HTMLElement>('[data-repo-rm]')
    if (repoRm)
      return void act(
        () =>
          send('/autopilot/policy/allow', {
            pattern: repoRm.dataset.repoRm,
            repo: repoRm.dataset.repo,
            on: false,
          }),
        'Taken out',
      )
    if (t.closest('[data-b="save"]')) {
      const num = (k: string) => {
        const v = host.querySelector<HTMLInputElement>(`[data-b="${k}"]`)?.value.trim()
        return v === '' || v === undefined ? null : Number(v)
      }
      return void act(
        () =>
          send('/autopilot/policy', {
            budget: { dollars: num('dollars'), spawns: num('spawns') },
            minutes: num('minutes'),
          }),
        'Budget saved',
      )
    }
  })

  refresh()
  const stopBus = onChanged(refresh)
  return stopBus
}

// ------------------------------------------------------ the activity timeline ----
/**
 * Every conductor action with its reason, newest first, and a button where the action can really
 * be taken back. Where it cannot, the row says why instead of showing a button that lies.
 */
export function mountTimeline(host: HTMLElement): Unmount {
  host.classList.add('ap-panel', 'ap-timeline')
  let actions: Action[] = []
  let can: Record<string, { verb: string; can?: string; label?: string; why?: string }> = {}
  let error = ''
  let filter = ''

  const refresh = async () => {
    const d = await get<{ actions: Action[]; can: typeof can }>('/autopilot/timeline?limit=200')
    if (d) {
      actions = d.actions
      can = d.can
    }
    paint()
  }

  const rowHtml = (a: Action) => {
    const k = can[a.action] ?? { verb: a.action }
    return `
      <li class="ap-act a-${esc(a.action)}${a.undone ? ' undone' : ''}" data-act="${esc(a.id)}">
        <span class="ap-when">${esc(ago(a.at))}</span>
        <div class="ap-act-b">
          <p class="ap-act-t"><b>${esc(k.verb)}</b>${a.repo ? ` <em>${esc(a.repo)}</em>` : ''}${a.chat ? ` <span class="ap-id">${esc(a.chat.slice(0, 8))}</span>` : ''} — ${esc(a.text)}</p>
          ${a.reason ? `<p class="ap-why">why: ${esc(a.reason)}</p>` : '<p class="ap-why none">no reason given</p>'}
          ${
            a.undone
              ? `<p class="ap-undone">Taken back ${esc(ago(a.undone.at))}: ${esc(a.undone.text)}</p>`
              : k.can
                ? `<button type="button" class="ap-undo" data-undo="${esc(a.id)}">${esc(k.label ?? 'Undo')}</button>`
                : `<p class="ap-nofix">Cannot be taken back: ${esc(k.why ?? 'no inverse')}</p>`
          }
        </div>
      </li>`
  }

  function paint() {
    const shown = filter ? actions.filter((a) => a.action === filter) : actions
    const kinds = [...new Set(actions.map((a) => a.action))]
    host.innerHTML = `
      ${error ? `<p class="ap-err" role="alert">${esc(error)}</p>` : ''}
      <header class="ap-head">
        <b>${actions.length} action${actions.length === 1 ? '' : 's'}</b>
        <div class="ap-filters">
          <button type="button" data-f="" class="${filter ? '' : 'on'}">All</button>
          ${kinds.map((k) => `<button type="button" data-f="${esc(k)}" class="${filter === k ? 'on' : ''}">${esc(can[k]?.verb ?? k)}</button>`).join('')}
        </div>
      </header>
      ${shown.length ? `<ul class="ap-acts-list">${[...shown].reverse().map(rowHtml).join('')}</ul>` : '<p class="ap-empty">Autopilot has not done anything yet.</p>'}`
  }

  host.addEventListener('click', async (e) => {
    const f = (e.target as HTMLElement).closest<HTMLElement>('[data-f]')
    if (f) {
      filter = f.dataset.f ?? ''
      return paint()
    }
    const u = (e.target as HTMLElement).closest<HTMLElement>('[data-undo]')
    if (!u) return
    error = ''
    u.setAttribute('disabled', '')
    try {
      await send('/autopilot/undo', { id: u.dataset.undo })
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    await refresh()
    autopilotChanged()
  })

  refresh()
  const stopPoll = poll(refresh, 8_000)
  const stopBus = onChanged(refresh)
  return () => {
    stopPoll()
    stopBus()
  }
}
