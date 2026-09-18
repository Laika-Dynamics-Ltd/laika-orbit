/**
 * Where autopilot's views are put, and the only file here that knows about chrome.
 *
 * Each view is one panel (panels.ts): the rail button, the palette entry, the shortcut, the
 * width, the tear-off and the saved layout all come from `registerPanel`. Autopilot is the parent
 * and the other four are views `under` it, so the rail shows one Autopilot button with a chevron
 * that folds the four out, rather than five buttons in a row.
 *
 * Two things are deliberately not panels: the chip in the app chrome (`registerChrome`), which
 * has to be visible while a panel is open and while none is, and the one dialog — how long you
 * are away — because it is the only place autopilot needs an answer before it acts.
 *
 * If you are here to add a view: add it to VIEWS. Do not give it chrome of its own.
 */

import * as activity from './activity.ts'
import {
  autopilotChanged,
  mountAutopilotControl,
  mountConductorPanel,
  mountDecisionInbox,
  mountPolicyView,
  mountTimeline,
  startAway,
  type Unmount,
} from './autopilot.ts'
import { getPanel, type PanelHandle, registerChrome, registerPanel } from './panels.ts'

type ViewId = 'control' | 'conductor' | 'inbox' | 'policy' | 'timeline'

const svg = (body: string) =>
  `<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

/** panel id for each view; `control` is the parent, so it keeps the feature's own name */
const pid = (v: ViewId) => (v === 'control' ? 'autopilot' : `autopilot-${v}`)

/**
 * each view, in the order the rail folds them out. `chord` is the shortcut: the autopilot family
 * is ⌥⌘A for the feature and ⇧⌥⌘ plus a letter for its views (⇧⌥⌘A itself is the kill switch).
 */
const VIEWS: {
  id: ViewId
  title: string
  chord: string
  hint: string
  terms: string
  icon: string
  width?: { min?: number; default?: number }
  mount: (host: HTMLElement) => Unmount
}[] = [
  {
    id: 'control',
    title: 'Autopilot',
    chord: 'alt+meta+KeyA',
    hint: 'the mode, what it may do, what it has spent, the kill switch',
    terms: 'autopilot summary mode away off on kill switch budget spend conductor status',
    icon: svg(
      '<circle cx="10" cy="10" r="7.2"/><path d="M10 5.4V10l3 1.9"/><path d="M2.8 10h1.6M15.6 10h1.6M10 2.8v1.6"/>',
    ),
    width: { min: 340, default: 420 },
    mount: (h) =>
      mountAutopilotControl(h, {
        onOpen: (v: string) => (v === 'away' ? awayDialog() : openView(v as ViewId)),
      }),
  },
  {
    id: 'conductor',
    title: 'Conductor',
    chord: 'shift+alt+meta+KeyC',
    hint: 'the chats the conductor leads, their ETAs and what is queued',
    terms: 'conductor fleet chats eta queued waiting lead',
    icon: svg(
      '<path d="M4 16.5 10 4l6 12.5"/><path d="M6.4 11.6h7.2"/><circle cx="10" cy="4" r="1.3" fill="currentColor"/>',
    ),
    mount: mountConductorPanel,
  },
  {
    id: 'inbox',
    title: 'Decisions',
    chord: 'shift+alt+meta+KeyD',
    hint: 'what autopilot left for you: pushes, deploys, merges, permissions',
    terms: 'decision inbox approve decline push deploy merge permission waiting on you',
    icon: svg(
      '<path d="M3 11.5 5.2 4.6a1.4 1.4 0 0 1 1.3-1h7a1.4 1.4 0 0 1 1.3 1L17 11.5V15a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 15Z"/><path d="M3 11.5h4l1 2h4l1-2h4"/>',
    ),
    mount: mountDecisionInbox,
  },
  {
    id: 'policy',
    title: 'Policy',
    chord: 'shift+alt+meta+KeyP',
    hint: 'what it may do unattended, per repo, and what it may spend',
    terms: 'policy allowed budget per-repo defaults unattended rules limits',
    icon: svg(
      '<path d="M10 2.6 4 5v4.6c0 3.6 2.5 6.4 6 7.8 3.5-1.4 6-4.2 6-7.8V5Z"/><path d="m7.4 10 1.8 1.8 3.6-3.8"/>',
    ),
    mount: mountPolicyView,
  },
  {
    id: 'timeline',
    title: 'Activity',
    chord: 'shift+alt+meta+KeyY',
    hint: 'every action autopilot took, why, and how to undo it',
    terms: 'timeline activity history actions undo reason log',
    icon: svg(
      '<path d="M4 4v12"/><circle cx="4" cy="6" r="1.3" fill="currentColor"/><circle cx="4" cy="11" r="1.3" fill="currentColor"/><path d="M7.4 6h8.6M7.4 11h6.2M7.4 15.4h8"/>',
    ),
    mount: mountTimeline,
  },
]

const handles = new Map<ViewId, PanelHandle>()

/** open one of autopilot's views; the control view's own links and the chip both come here */
export function openView(view: ViewId = 'control') {
  ;(handles.get(view) ?? getPanel(pid(view)))?.open()
}

export const isAutopilotOpen = () => [...handles.values()].some((h) => h.isOpen())

/** decisions waiting, for the Decisions button's badge; refreshed whenever autopilot changes */
let waiting = 0
async function countInbox() {
  try {
    const r = await fetch('/api/control/agent/autopilot/inbox')
    const j = (await r.json()) as { items?: unknown[] }
    waiting = j.items?.length ?? 0
  } catch {}
  for (const h of handles.values()) h.refreshBadge()
}

/**
 * How long you are away, and what it may spend: the one thing autopilot asks before it acts. The
 * numbers start from the policy, so answering it is usually pressing return.
 */
async function awayDialog() {
  const box = document.createElement('div')
  box.className = 'ap-ask'
  box.setAttribute('role', 'alertdialog')
  const p = await fetch('/api/control/agent/autopilot/policy')
    .then((r) => r.json())
    .catch(() => null)
  const hours = Math.max(1, Math.round((p?.minutes ?? 240) / 60))
  box.innerHTML = `<div class="dlg">
    <b>☾ Away</b>
    <p>The conductor leads your chats, plainly safe tools are approved in your folders, and stuck chats are brought back. Everything that reaches outside this Mac still waits for you.</p>
    <label>For<input type="number" min="1" max="24" step="1" data-aw="hours" value="${hours}" /> hours</label>
    <input class="dlg-in" data-aw="goal" maxlength="2000" placeholder="Goal (optional): keep every open chat moving on its current task" aria-label="Goal while you are away" />
    <p class="ap-ask-b">Budget: ${p?.budget?.dollars ? `$${p.budget.dollars}` : 'no limit'}${p?.budget?.spawns != null ? `, ${p.budget.spawns} chats it may open` : ''} — change it in Policy.</p>
    <div class="dlg-acts">
      <button type="button" class="ac-btn" data-dlg="no">Cancel</button>
      <button type="button" class="ac-btn go" data-dlg="yes">Start</button>
    </div>
  </div>`
  document.body.appendChild(box)
  const done = (yes: boolean) => {
    const h = Number(box.querySelector<HTMLInputElement>('[data-aw="hours"]')?.value ?? hours)
    const goal = box.querySelector<HTMLInputElement>('[data-aw="goal"]')?.value ?? ''
    box.remove()
    if (yes) startAway(Math.round(Math.min(24, Math.max(1, h)) * 60), goal).catch(() => {})
  }
  box.addEventListener('click', (e) => {
    const d = (e.target as HTMLElement).closest<HTMLElement>('[data-dlg]')?.dataset.dlg
    if (d) done(d === 'yes')
    else if (e.target === box) done(false)
  })
  box.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') done(false)
    if (e.key === 'Enter') done(true)
  })
  box.querySelector<HTMLElement>('[data-dlg="yes"]')?.focus()
}

/** ⇧⌥⌘A, and the palette's "stop the conductor now": no dialog, because a kill switch you have to confirm is not one */
function halt(reason: string) {
  fetch('/api/control/agent/autopilot/halt', {
    method: 'POST',
    headers: { 'x-control': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ reason }),
  })
    .then(() => {
      autopilotChanged()
      openView('control')
    })
    .catch(() => {})
}

/**
 * The chip in the app chrome — the one part of autopilot that is always on screen, whatever
 * panel is open — and the five views as panels. main.ts calls this once, where it wants the
 * buttons to sit in the rail's fleet group.
 */
export function startAutopilot() {
  registerChrome({
    id: 'autopilot',
    mount: (host) =>
      mountAutopilotControl(host, {
        compact: true,
        onOpen: (v: string) => (v === 'away' ? awayDialog() : openView(v as ViewId)),
      }),
  })

  for (const v of VIEWS) {
    let off: Unmount | undefined
    handles.set(
      v.id,
      registerPanel({
        id: pid(v.id),
        title: v.title,
        group: 'fleet',
        ...(v.id === 'control' ? {} : { under: 'autopilot' }),
        chord: v.chord,
        icon: v.icon,
        hint: v.hint,
        terms: v.terms,
        width: v.width ?? { min: 360, default: 480 },
        mount: (host) => {
          host.classList.add('ap-view')
          off = v.mount(host)
          return () => off?.()
        },
        ...(v.id === 'inbox' || v.id === 'control'
          ? { badge: () => ({ count: waiting, tone: 'warn' as const }) }
          : {}),
      }),
    )
  }

  addEventListener('laika:autopilot-away', () => awayDialog())
  addEventListener('laika:autopilot-halt', () => halt('you asked for it from the command palette'))
  addEventListener('laika:autopilot-toggle', () => handles.get('control')?.toggle())
  addEventListener(
    'keydown',
    (e) => {
      if (!(e.shiftKey && e.altKey && e.metaKey && !e.ctrlKey && e.code === 'KeyA')) return
      e.preventDefault()
      e.stopImmediatePropagation()
      halt('you pressed ⇧⌥⌘A')
    },
    true,
  )
  addEventListener('laika:autopilot-changed', () => void countInbox())
  activity.every(15_000, countInbox)
}
