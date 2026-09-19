/**
 * A chat's work as git sees it (work-ledger.mjs, docs/MERGE-TRAIN-CONTRACT.md): where it works,
 * how far it is from main, what is not committed yet, and what the merge train made of it.
 *
 * One renderer for the two places it shows: the cockpit's fleet strip (cockpit.ts) and the bar at
 * the top of every chat (sessions.ts). Both read the same row off the cockpit's one stream, so
 * they cannot disagree, and neither ever reads the model's own status line.
 */
import './work-ledger.css'
import { every } from './activity.ts'
import { fleetRow, subscribeFleet } from './cockpit.ts'

export type LedgerState =
  | 'merged'
  | 'ready'
  | 'checking'
  | 'failed'
  | 'conflict'
  | 'not-ready'
  | 'none'
export type Ledger = {
  repo: string
  root: string
  worktree: string
  branch: string | null
  base: string
  behind: number | null
  ahead: number | null
  commits: { sha: string; title: string; at: number }[]
  dirty: { count: number; oldestAt: number | null }
  lastCommitAt: number | null
  state: LedgerState
  ready: { sha: string; at: number; via: 'trailer' | 'mark' } | null
  overlaps: { file: string; chat: string; repo?: string }[]
  train: { status: string; at: number; output: string | null } | null
}

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
/** "4m", "3h", "2d": how long ago */
export const ago = (t: number | null, now = Date.now()) => {
  if (!t) return ''
  const m = Math.max(0, Math.round((now - t) / 60_000))
  return m < 1
    ? 'now'
    : m < 60
      ? `${m}m`
      : m < 48 * 60
        ? `${Math.round(m / 60)}h`
        : `${Math.round(m / 1440)}d`
}

const STATE: Record<LedgerState, string> = {
  merged: 'Merged',
  ready: 'Ready',
  checking: 'Checks running',
  failed: 'Checks failed',
  conflict: 'Conflicts with main',
  'not-ready': 'Not ready',
  none: '',
}
const STATE_TIP: Record<LedgerState, string> = {
  merged: 'Everything on this branch is in main',
  ready: 'Marked ready: waiting for the merge train',
  checking: 'The merge train is checking this slice now',
  failed: 'The merge train’s check failed on this slice',
  conflict: 'This slice does not merge onto main: its chat has the files and hunks',
  'not-ready': 'Work not marked ready yet (commit it, then Ready: yes)',
  none: '',
}

/** the worktree's folder name, or "main checkout" */
const place = (l: Ledger) =>
  l.worktree === l.root ? 'main checkout' : (l.worktree.split('/').pop() ?? '')

/**
 * The ledger as a row of chips. `compact` (the cockpit's nodes) leaves out the worktree and the
 * branch when the node is narrow; hover titles carry the detail either way.
 */
export function ledgerChips(l: Ledger | null, { compact = false, now = Date.now() } = {}) {
  if (!l) return ''
  const out: string[] = []
  if (STATE[l.state])
    out.push(
      `<span class="wl-st s-${l.state}" title="${esc(`${STATE_TIP[l.state]}${l.train?.output ? `\n\n${l.train.output.slice(-600)}` : ''}`)}">${STATE[l.state]}</span>`,
    )
  if (!compact || l.worktree !== l.root)
    out.push(
      `<span class="wl-br" title="${esc(`${l.worktree}${l.branch ? `\nbranch ${l.branch}` : '\ndetached'}`)}">${esc(l.branch ?? 'detached')}${compact || l.worktree === l.root ? '' : `<em>${esc(place(l))}</em>`}</span>`,
    )
  if (l.ahead)
    out.push(
      `<span class="wl-ah" title="${esc(`${l.ahead} commit${l.ahead === 1 ? '' : 's'} ahead of ${l.base}:\n${l.commits.map((c) => `${c.sha.slice(0, 7)}  ${c.title}  (${ago(c.at, now)} ago)`).join('\n')}${l.ahead > l.commits.length ? `\n… and ${l.ahead - l.commits.length} more` : ''}`)}">↑${l.ahead}</span>`,
    )
  if (l.behind)
    out.push(
      `<span class="wl-bh${l.behind > 20 ? ' far' : ''}" title="${esc(`${l.behind} commit${l.behind === 1 ? '' : 's'} behind ${l.base}`)}">↓${l.behind}</span>`,
    )
  if (l.dirty.count)
    out.push(
      `<span class="wl-dt" title="${esc(`${l.dirty.count} uncommitted file${l.dirty.count === 1 ? '' : 's'}${l.dirty.oldestAt ? `; the oldest change is ${ago(l.dirty.oldestAt, now)} old` : ''}`)}"><i></i>${l.dirty.count}${l.dirty.oldestAt ? `<em>${ago(l.dirty.oldestAt, now)}</em>` : ''}</span>`,
    )
  if (l.overlaps?.length)
    out.push(
      `<span class="wl-ov" title="${esc(`Also changed by another chat:\n${l.overlaps.map((o) => `${o.file}  (${o.chat.slice(0, 8)})`).join('\n')}`)}">⚠ ${l.overlaps.length} shared</span>`,
    )
  return out.join('')
}

/** "committed 12m ago", for beside a status line, so a stale "now" is obvious */
export const lastCommit = (l: Ledger | null, now = Date.now()) =>
  l?.lastCommitAt
    ? `<span class="wl-lc" title="${esc(`Last commit in ${place(l)}: ${new Date(l.lastCommitAt).toLocaleString()}`)}">committed ${ago(l.lastCommitAt, now)}${ago(l.lastCommitAt, now) === 'now' ? '' : ' ago'}</span>`
    : ''

/**
 * The bar at the top of a chat: its ledger, painted from the cockpit's stream while the chat is
 * on screen. Hidden, it holds no subscription and paints nothing.
 */
export function mountLedgerBar(host: HTMLElement, chatId: string) {
  const bar = document.createElement('div')
  bar.className = 'wl-bar'
  bar.hidden = true
  host.prepend(bar)
  bar.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.wl-ready')
    if (!b) return
    b.disabled = true
    const r = await fetch('/api/control/agent/train/ready', {
      method: 'POST',
      headers: { 'x-control': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ chat: chatId }),
    }).catch(() => null)
    const d = r ? await r.json().catch(() => ({})) : { error: 'The host did not answer' }
    if (!r?.ok) {
      b.disabled = false
      b.textContent = 'Not ready'
      b.title = d.error ?? 'Could not mark it ready'
    }
  })
  let unsub: (() => void) | null = null
  let tick: (() => void) | null = null
  let last = ''
  const paint = () => {
    const l = (fleetRow(chatId)?.ledger ?? null) as Ledger | null
    // committed, ahead of main and not marked yet: one click marks it, as a trailer would
    const can = l && l.state === 'not-ready' && l.ahead && !l.dirty.count && l.worktree !== l.root
    const html = l
      ? `${ledgerChips(l)}<span class="wl-fill"></span>${lastCommit(l)}${can ? '<button type="button" class="wl-ready" title="Mark this slice ready for the merge train: committed, typechecked, affected tests passing">Mark ready</button>' : ''}`
      : ''
    if (html === last) return
    last = html
    bar.innerHTML = html
    bar.hidden = !html
  }
  return {
    setShown(on: boolean) {
      if (on && !unsub) {
        unsub = subscribeFleet(paint)
        // the ages ("committed 12m ago") move on even when nothing else does
        tick = every(
          60_000,
          () => {
            last = ''
            paint()
          },
          { el: host, away: 'stop' },
        )
        paint()
      } else if (!on && unsub) {
        unsub()
        tick?.()
        unsub = tick = null
      }
    },
    dispose() {
      unsub?.()
      tick?.()
      unsub = tick = null
      bar.remove()
    },
  }
}
