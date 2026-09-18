/**
 * Fleet tools on the Claude panel: broadcast one message to many chats, and each chat's background
 * work with a rough ETA (the host's `work.bg`, see fleet-work.mjs for the shape).
 */
import './fleet-ui.css'
import { mountStrip } from './runs.js'
import { openRunsPanel } from './runs-panel.js'
import { attachVoice } from './voice.ts'

/** one running background task or live-progress board, as the host reports it */
export type BgTask = {
  id: string
  source: 'task' | 'board'
  label: string
  type: string | null
  startedAt: number
  backgrounded: boolean
  pct: number | null
  etaAt: number | null
  etaDerived: boolean
  /** etaAt is a lower bound: only some of a board's lanes have an ETA */
  etaPartial: boolean
  basis: 'explicit' | 'progress' | 'history' | null
  typicalMs: number | null
  summary: string | null
  state: string | null
}

/** the chat fields a broadcast needs */
export type FleetChat = {
  id: string
  title: string
  repo: string
  state: string
  role?: string | null
  waiting: string[]
  spawnedBy?: string | null
  bg: BgTask[]
}

/** the fleet commands the host expands (fleet-work.mjs FLEET_COMMANDS) */
export const FLEET_COMMANDS: { name: string; hint: string }[] = [
  { name: 'checkpoint', hint: 'Pause, stop what it started, commit locally, one-line report' },
  { name: 'resume-offload', hint: 'Resume from the checkpoint; heavy compute to box1' },
]

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )

const dur = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`
}

/** "~3m left", "overdue (usually 5m)", "4m in": the same words as the host's etaText */
export function etaText(t: BgTask, at = Date.now()) {
  if (t.etaAt && t.etaAt > at) return `${t.etaPartial ? 'at least ' : '~'}${dur(t.etaAt - at)} left`
  if (t.etaAt && t.typicalMs) return `overdue (usually ${dur(t.typicalMs)})`
  if (t.etaAt) return 'almost done'
  return `${dur(at - t.startedAt)} in`
}

/** the few characters a tab or row has room for: the soonest ETA, else how many are running */
export function bgShort(bg: BgTask[] | undefined, at = Date.now()) {
  if (!bg?.length) return ''
  const next = bg
    .filter((t) => t.etaAt && t.etaAt > at)
    .sort((a, b) => (a.etaAt as number) - (b.etaAt as number))[0]
  if (next)
    return `~${dur((next.etaAt as number) - at)}${bg.length > 1 ? ` +${bg.length - 1}` : ''}`
  return `${bg.length} bg`
}

/** one line per task, for a tooltip */
export const bgTip = (bg: BgTask[] | undefined, at = Date.now()) =>
  (bg ?? [])
    .map((t) => `${t.label}: ${etaText(t, at)}${t.pct !== null ? ` · ${t.pct}%` : ''}`)
    .join('\n')

// ------------------------------------------------------------ the status line ----
const lines = new Map<HTMLElement, BgTask[]>()
let ticker: ReturnType<typeof setInterval> | null = null

function draw(line: HTMLElement, bg: BgTask[]) {
  const at = Date.now()
  const parts = bg.map((t) => {
    const pct = t.pct !== null ? ` · ${t.pct}%` : ''
    return `<span class="bg-t" title="${esc(`${t.summary ?? t.label}${t.basis ? `\nETA from ${t.basis === 'explicit' ? 'what the chat said' : t.basis === 'progress' ? 'its progress so far' : 'earlier runs of the same task'}` : ''}`)}"><b>${esc(t.label)}</b> ${esc(etaText(t, at))}${pct}</span>`
  })
  line.innerHTML = `<i class="bg-glyph" aria-hidden="true">◷</i><span class="bg-lbl">${bg.length === 1 ? 'In the background' : `${bg.length} in the background`}</span>${parts.join('<i class="bg-sep">·</i>')}`
}

/**
 * The chat's background work, as a line at the end of its log (after Claude's working line, if
 * any), counting down each second. Gone when nothing runs.
 */
export function paintBackground(log: HTMLElement, bg: BgTask[] | undefined) {
  let line = log.querySelector<HTMLElement>(':scope > .m-bg')
  if (!bg?.length) {
    if (line) {
      lines.delete(line)
      line.remove()
    }
    return
  }
  if (!line) {
    line = document.createElement('div')
    line.className = 'm-bg'
    line.setAttribute('role', 'status')
  }
  log.appendChild(line)
  lines.set(line, bg)
  draw(line, bg)
  ticker ??= setInterval(() => {
    for (const [l, b] of lines) {
      if (!l.isConnected) lines.delete(l)
      else draw(l, b)
    }
    if (!lines.size && ticker) {
      clearInterval(ticker)
      ticker = null
    }
  }, 1000)
}

// ------------------------------------------------------------ the run strip ----

/**
 * The chat's own run, as one compact line at the end of its log: how far, how long left, where it
 * runs, and the lane that went quiet if it stalls. Clicking it opens the run. Nothing is drawn
 * while the chat has no run going — most chats never start one.
 */
const strips = new Map<HTMLElement, { chat: string; dispose: () => void }>()

/** a chat's log going away (released or ended): stop its strip and let the log go */
export function disposeRunStrip(log: HTMLElement) {
  strips.get(log)?.dispose?.()
  strips.delete(log)
}
export function paintRunStrip(log: HTMLElement, chat: string) {
  const had = strips.get(log)
  if (had?.chat === chat && had.dispose) {
    if (log.querySelector(':scope > .m-run')) return
    had.dispose()
  }
  let host = log.querySelector<HTMLElement>(':scope > .m-run')
  if (!host) {
    host = document.createElement('div')
    host.className = 'm-run'
  }
  log.appendChild(host)
  strips.set(log, {
    chat,
    dispose: mountStrip(host, { chat }, { onOpen: (id) => openRunsPanel(id) }),
  })
}

// ---------------------------------------------------------------- broadcast ----
const STATE_WORD: Record<string, string> = {
  starting: 'Starting',
  running: 'Working',
  waiting: 'Needs you',
  idle: 'Idle',
  error: 'Error',
}

/**
 * The broadcast dialog: pick chats (all by default, conductors left out), write one message or
 * pick a fleet command, send it to each. `send` posts to one chat and says whether it went.
 */
export function openBroadcast(o: {
  host: HTMLElement
  chats: () => FleetChat[]
  send: (id: string, text: string) => Promise<boolean>
  done: (note: string) => void
  preset?: string
}) {
  o.host.querySelector('.bc-dlg')?.remove()
  const chats = o.chats().filter((c) => c.state !== 'closed')
  const picked = new Set(chats.filter((c) => c.role !== 'conductor').map((c) => c.id))
  const box = document.createElement('div')
  box.className = 'bc-dlg'
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-label', 'Broadcast to chats')
  box.innerHTML = `<form class="bc">
    <header><b>Broadcast</b><span>One message to several chats at once</span></header>
    <div class="bc-pick" role="group" aria-label="Select">
      <button type="button" data-bc-sel="all">All</button>
      <button type="button" data-bc-sel="running">Working</button>
      <button type="button" data-bc-sel="idle">Idle</button>
      <button type="button" data-bc-sel="none">None</button>
    </div>
    <ul class="bc-list">${
      chats.length
        ? chats
            .map((c) => {
              const needs = c.waiting.length
                ? `<em class="bc-need">${c.waiting.includes('permission') ? 'needs permission' : 'asks a question'}</em>`
                : ''
              const eta = bgShort(c.bg)
              return `<li><label title="${esc(bgTip(c.bg))}">
                <input type="checkbox" value="${esc(c.id)}" />
                <i class="bc-st st-${esc(c.state)}"></i>
                <span class="bc-t">${c.role === 'conductor' ? '♛ ' : ''}${esc(c.title || 'Untitled')}</span>
                <em class="bc-repo">${esc(c.repo)}</em>
                ${c.spawnedBy ? '<em class="bc-tag" title="Opened by the conductor">spawned</em>' : ''}
                ${needs}
                <small>${esc(STATE_WORD[c.state] ?? c.state)}${eta ? ` · ${esc(eta)}` : ''}</small>
              </label></li>`
            })
            .join('')
        : '<li class="bc-empty">No chats are open.</li>'
    }</ul>
    <div class="bc-cmds">${FLEET_COMMANDS.map((c) => `<button type="button" data-bc-cmd="${esc(c.name)}" title="${esc(c.hint)}">/${esc(c.name)}</button>`).join('')}</div>
    <div class="cx bc-cx">
      <textarea rows="3" placeholder="Message every selected chat… (⌘↵ sends)" aria-label="Broadcast message"></textarea>
      <div class="cx-bar"><span class="cx-chips"></span></div>
    </div>
    <p class="bc-err" role="alert" hidden></p>
    <div class="dlg-acts">
      <button type="button" class="ac-btn" data-bc="cancel">Cancel</button>
      <button type="submit" class="ac-btn go" data-bc="send"></button>
    </div>
  </form>`
  const form = box.querySelector('form') as HTMLFormElement
  const input = box.querySelector('textarea') as HTMLTextAreaElement
  const go = box.querySelector('[data-bc="send"]') as HTMLButtonElement
  const err = box.querySelector('.bc-err') as HTMLElement
  const boxes = [...box.querySelectorAll<HTMLInputElement>('.bc-list input')]
  if (o.preset) input.value = o.preset

  const sync = () => {
    for (const b of boxes) b.checked = picked.has(b.value)
    const n = picked.size
    go.textContent = n ? `Send to ${n} chat${n === 1 ? '' : 's'}` : 'Send'
    go.disabled = !n || !input.value.trim()
  }
  const close = () => box.remove()
  const submit = async () => {
    const text = input.value.trim()
    if (!text || !picked.size) return
    go.disabled = true
    go.textContent = 'Sending…'
    const ids = [...picked]
    const sent = await Promise.all(ids.map((id) => o.send(id, text).catch(() => false)))
    const failed = ids.filter((_, i) => !sent[i])
    if (failed.length) {
      // keep the dialog, with only the ones that did not get it still selected
      picked.clear()
      for (const id of failed) picked.add(id)
      const names = failed.map((id) => chats.find((c) => c.id === id)?.title || id.slice(0, 8))
      err.textContent = `Sent to ${ids.length - failed.length} of ${ids.length}. Not sent to: ${names.join(', ')}. Send again to retry them.`
      err.hidden = false
      sync()
      return
    }
    close()
    o.done(`Sent to ${ids.length} chat${ids.length === 1 ? '' : 's'}`)
  }

  box.addEventListener('change', (e) => {
    const b = e.target as HTMLInputElement
    if (b.type !== 'checkbox') return
    if (b.checked) picked.add(b.value)
    else picked.delete(b.value)
    sync()
  })
  box.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t === box || t.closest('[data-bc="cancel"]')) return close()
    const sel = t.closest<HTMLElement>('[data-bc-sel]')?.dataset.bcSel
    if (sel) {
      picked.clear()
      for (const c of chats) {
        if (sel === 'all' ? c.role !== 'conductor' : sel === 'none' ? false : c.state === sel)
          picked.add(c.id)
      }
      return sync()
    }
    const cmd = t.closest<HTMLElement>('[data-bc-cmd]')?.dataset.bcCmd
    if (cmd) {
      input.value = `/${cmd}`
      input.focus()
      sync()
    }
  })
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    submit()
  })
  input.addEventListener('input', sync)
  box.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') close()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit()
    }
  })
  attachVoice({ box: box.querySelector('.bc-cx') as HTMLElement, input, submit, sync })
  o.host.appendChild(box)
  sync()
  input.focus()
  return { el: box, close }
}
