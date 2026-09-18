/**
 * Agent control: what needs you across every agent session and repo, at a glance.
 * Mounted twice — as the drawer inside the brain map (`c`) and as the standalone /control
 * page. Data comes from /api/control/* (control-api.mjs); everything is local to this machine.
 */

import * as presence from './activity.ts'
import { makeSpans, type Span } from './spanview.ts'

export type Session = {
  id: string
  project: string
  repo: string
  repoPath: string | null
  cwd: string | null
  branch: string | null
  title: string
  ask: string
  latest: string
  lastTool: string | null
  state: 'needs-you' | 'blocked' | 'working' | 'ended' | 'idle'
  live: boolean
  started: string | null
  updated: string
  /** [t0, t1] epoch-ms stretches the session was actually worked; see runsOf in control-api.mjs */
  runs: Array<[number, number]>
  waitingMin: number
}
type Repo = {
  path: string
  name: string
  branch: string | null
  upstream: string | null
  uncommitted: number
  untracked: number
  unpushed: number | null
  noUpstream: boolean
  behind: number
  lastCommit: string | null
  commits24h: number
  risk: number
}
type Activity = {
  project: string
  sessions: number
  commits: number
  memory: number
  lastAt: number
}
type Listener = {
  pid: number
  ports: number[]
  command: string
  cwd: string | null
  where: string | null
  uptime: string | null
  memory: number
  self: boolean
  /** how many identical processes in this folder were collapsed into this row */
  count: number
}

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[<>&"']/g,
    (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[m] as string,
  )

function ago(iso: string | null | number): string {
  if (!iso) return 'never'
  const ms = Date.now() - (typeof iso === 'number' ? iso : Date.parse(iso))
  const m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

// agent replies are markdown; a summary line reads better without the syntax
const plain = (s: string) =>
  s
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/\*\*|__|`|^#+\s*/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+-\s+/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim()
// the folder a repo lives in is context, its own name is the label
const short = (name: string) => name.split('/').pop() ?? name

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const resumeCmd = (s: Session) => `cd ${shq(s.cwd ?? '')} && claude --resume ${s.id}`

function sessionCard(s: Session): string {
  const where = `<span title="${esc(s.repo)}">${esc(short(s.repo))}</span>${s.branch ? ` <span class="c-branch">${esc(s.branch)}</span>` : ''}`
  const waited =
    s.state === 'needs-you'
      ? `waiting ${ago(s.updated)}`
      : s.state === 'blocked'
        ? `blocked ${ago(s.updated)}`
        : ''
  return `<article class="c-card ${s.state}" data-id="${esc(s.id)}">
    <div class="c-card-top"><span class="c-where">${where}</span><span class="c-age">${waited}</span></div>
    <div class="c-title">${esc(s.title || '(untitled session)')}</div>
    ${s.latest ? `<p class="c-latest">${esc(plain(s.latest))}</p>` : ''}
    ${s.state === 'blocked' && s.lastTool ? `<p class="c-tool">waiting on <code>${esc(s.lastTool)}</code></p>` : ''}
    <div class="c-acts">
      <button type="button" class="c-btn" data-act="open-here" data-id="${esc(s.id)}">Open here</button>
      <button type="button" class="c-btn ghost" data-act="resume" data-id="${esc(s.id)}">Copy resume command</button>
      ${s.cwd ? `<button type="button" class="c-btn ghost" data-act="terminal" data-path="${esc(s.cwd)}">Terminal</button>` : ''}
      ${s.repoPath ? `<button type="button" class="c-btn ghost" data-act="editor" data-path="${esc(s.repoPath)}">Editor</button>` : ''}
    </div>
  </article>`
}

function sessionRow(s: Session): string {
  return `<div class="c-row ${s.state}">
    <span class="c-dot"></span>
    <span class="c-where" title="${esc(s.repo)}">${esc(short(s.repo))}</span>
    <span class="c-title">${esc(s.title || '(untitled)')}</span>
    <span class="c-meta">${s.state === 'working' && s.lastTool ? `<code>${esc(s.lastTool)}</code> · ` : ''}${ago(s.updated)}</span>
  </div>`
}

function repoCard(r: Repo): string {
  const badges = [
    r.unpushed ? `<span class="c-badge bad">${r.unpushed} unpushed</span>` : '',
    r.noUpstream ? '<span class="c-badge warn">no upstream</span>' : '',
    r.uncommitted ? `<span class="c-badge warn">${r.uncommitted} uncommitted</span>` : '',
    r.behind ? `<span class="c-badge">${r.behind} behind</span>` : '',
  ].join('')
  return `<article class="c-repo">
    <div class="c-card-top"><span class="c-where" title="${esc(r.path)}">${esc(short(r.name))}${r.branch ? ` <span class="c-branch">${esc(r.branch)}</span>` : ''}</span><span class="c-age">last commit ${ago(r.lastCommit)}</span></div>
    <div class="c-badges">${badges}</div>
    <div class="c-acts">
      <button type="button" class="c-btn ghost" data-act="editor" data-path="${esc(r.path)}">Editor</button>
      <button type="button" class="c-btn ghost" data-act="terminal" data-path="${esc(r.path)}">Terminal</button>
      <button type="button" class="c-btn ghost" data-act="finder" data-path="${esc(r.path)}">Finder</button>
    </div>
  </article>`
}

const SHELL = `<header class="c-top">
    <div class="c-brand"><span class="c-mark"></span><b>agent control</b></div>
    <div class="c-chips" data-el="chips"></div>
    <div class="c-right">
      <button data-el="notify" type="button" class="c-btn ghost">Enable notifications</button>
      <span data-el="extra"></span>
    </div>
  </header>
  <div class="c-grid">
    <section class="c-col">
      <h2>Needs you <em data-el="n-needs"></em></h2>
      <div data-el="needs" class="c-list"></div>
      <h2>Blocked <em data-el="n-blocked"></em><small>a tool call is waiting, usually for approval</small></h2>
      <div data-el="blocked" class="c-list"></div>
      <h2>Working now <em data-el="n-working"></em></h2>
      <div data-el="working" class="c-list compact"></div>
      <details class="c-more">
        <summary>Recently finished <em data-el="n-done"></em></summary>
        <div data-el="done" class="c-list compact"></div>
      </details>
    </section>
    <section class="c-col">
      <h2>Loose ends <em data-el="n-risk"></em><small>work that isn't safe on a remote yet</small></h2>
      <div data-el="risk" class="c-list"></div>
      <h2>Last 24 hours</h2>
      <div data-el="activity" class="c-table"></div>
      <h2>Listening <em data-el="n-ports"></em><small>local servers, and the project each one belongs to</small></h2>
      <div data-el="ports" class="c-table"></div>
    </section>
  </div>
  <section class="c-spans">
    <h2>When they ran <small>last two days · a bar is a stretch of actual work; long silences are compressed and say so</small></h2>
    <div data-el="spans" class="c-spanhost"></div>
  </section>`

export type ControlCounts = { needs: number; blocked: number; working: number; unpushed: number }

/** Desktop notification when a session starts waiting on you — the reason to keep this open. */
export function sessionNotifier() {
  let seen: Map<string, Session['state']> | null = null
  return (list: Session[], onClick?: (s: Session) => void) => {
    if (seen && 'Notification' in window && Notification.permission === 'granted') {
      for (const s of list) {
        if ((s.state !== 'needs-you' && s.state !== 'blocked') || seen.get(s.id) === s.state)
          continue
        const n = new Notification(
          s.state === 'blocked' ? `Blocked: ${short(s.repo)}` : `Your turn: ${short(s.repo)}`,
          {
            body: s.title || plain(s.latest),
            tag: s.id,
          },
        )
        n.onclick = () => {
          window.focus()
          onClick?.(s)
        }
      }
    }
    seen = new Map(list.map((s) => [s.id, s.state]))
  }
}

export type ControlView = { start(): void; stop(): void; el: HTMLElement }

/**
 * Render agent control into `root`. Nothing polls until start(); a hidden drawer should
 * not be scanning 80 repos a minute.
 */
export function mountControl(
  root: HTMLElement,
  opts: { extra?: string; notify?: boolean; onCounts?: (c: ControlCounts) => void } = {},
): ControlView {
  root.classList.add('ctl')
  root.innerHTML = SHELL
  const $ = (k: string) => root.querySelector(`[data-el="${k}"]`) as HTMLElement
  if (opts.extra) $('extra').outerHTML = opts.extra

  let sessions: Session[] = []
  let repos: Repo[] = []
  let activity: Activity[] = []
  let ports: Listener[] = []
  const notifier = sessionNotifier()
  const timers: (() => void)[] = []

  const scrollTo = (s: Session) =>
    root.querySelector(`[data-id="${CSS.escape(s.id)}"]`)?.scrollIntoView({ block: 'center' })

  const spanHost = $('spans')
  let drawnAt = 0
  const spans = makeSpans(spanHost, {
    pick: (id) => {
      const s = sessions.find((x) => x.id === id)
      if (s) scrollTo(s)
    },
  })

  /** How far back the chart looks. */
  const WINDOW = 48 * 3600e3

  /**
   * Sessions as spans — a bar per RUN, not per session, so a bar means "worked here" rather
   * than "existed here" and the clock has real silences left to compress.
   *
   * Only the newest run of a session carries its state: `needs-you` describes the session now,
   * not what it was doing yesterday afternoon, so older runs stay muted. A run is left open —
   * drawn out to NOW — only while a session is genuinely mid-turn; a session waiting on you
   * gets a closed bar, and the empty stretch between it and NOW is how long it has waited.
   *
   * Busiest repos first, capped: past a dozen rows this is a wall and the lists above read
   * better anyway.
   */
  function drawSpans() {
    drawnAt = spanHost.clientWidth
    const now = Date.now()
    const from = now - WINDOW
    const items: Span[] = []
    for (const s of sessions) {
      const runs = (s.runs ?? []).filter(([, t1]) => t1 >= from)
      runs.forEach(([t0, t1], i) => {
        const newest = i === runs.length - 1
        const open = newest && s.live && s.state === 'working'
        items.push({
          id: s.id,
          lane: s.repo,
          t0: Math.max(t0, from),
          t1: open ? null : Math.max(t1, Math.max(t0, from)),
          label: s.title || '(untitled)',
          state: newest ? s.state : 'idle',
          live: newest && s.live,
        })
      })
    }
    if (!items.length) {
      spans.dispose()
      spanHost.innerHTML = '<p class="c-empty">No sessions worked in the last two days.</p>'
      return
    }
    const latest = new Map<string, number>()
    for (const s of items) latest.set(s.lane, Math.max(latest.get(s.lane) ?? 0, s.t1 ?? now))
    const lanes = [...latest]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([id]) => ({ id, name: short(id) }))
    const keep = new Set(lanes.map((l) => l.id))
    spans.draw({ from, to: now, now, lanes, items: items.filter((s) => keep.has(s.lane)) })
  }

  // The drawer and the page are both resizable, and the chart is laid out in pixels.
  new ResizeObserver(() => {
    const w = spanHost.clientWidth
    if (w && w !== drawnAt) {
      drawnAt = w
      drawSpans()
    }
  }).observe(spanHost)

  async function loadSessions() {
    try {
      sessions = await (await fetch('/api/control/sessions')).json()
    } catch {
      return
    }
    if (opts.notify) notifier(sessions, scrollTo)
    render()
  }

  async function loadSlow() {
    try {
      ;[repos, activity, ports] = await Promise.all([
        fetch('/api/control/repos').then((r) => r.json()),
        fetch('/api/control/activity').then((r) => r.json()),
        fetch('/api/control/ports').then((r) => r.json()),
      ])
    } catch {
      return
    }
    render()
  }

  function render() {
    const by = (st: Session['state']) => sessions.filter((s) => s.state === st)
    const needs = by('needs-you')
    const blocked = by('blocked')
    const working = by('working')
    const done = sessions.filter((s) => s.state === 'ended' || s.state === 'idle').slice(0, 20)
    const risky = repos.filter((r) => r.risk > 0)

    $('needs').innerHTML = needs.length
      ? needs.map(sessionCard).join('')
      : '<p class="c-empty">Nothing is waiting on you.</p>'
    $('blocked').innerHTML = blocked.length
      ? blocked.map(sessionCard).join('')
      : '<p class="c-empty">None.</p>'
    $('working').innerHTML = working.length
      ? working.map(sessionRow).join('')
      : '<p class="c-empty">No sessions running.</p>'
    $('done').innerHTML = done.map(sessionRow).join('')
    $('risk').innerHTML = risky.length
      ? risky.slice(0, 12).map(repoCard).join('') +
        (risky.length > 12 ? `<p class="c-empty">and ${risky.length - 12} more</p>` : '')
      : '<p class="c-empty">Every repo is committed and pushed.</p>'
    $('activity').innerHTML = activity.length
      ? `<div class="c-tr head"><span>Project</span><span>Sessions</span><span>Commits</span><span>Memory</span></div>` +
        activity
          .map(
            (a) =>
              `<div class="c-tr"><span title="${esc(a.project)}">${esc(short(a.project))}</span><span>${a.sessions || ''}</span><span>${a.commits || ''}</span><span>${a.memory || ''}</span></div>`,
          )
          .join('')
      : '<p class="c-empty">No activity in the last day.</p>'

    $('n-needs').textContent = String(needs.length)
    $('n-blocked').textContent = String(blocked.length)
    $('n-working').textContent = String(working.length)
    $('n-done').textContent = String(done.length)
    $('ports').innerHTML = ports.length
      ? '<div class="c-tr ports head"><span>Port</span><span>Project</span><span>Up</span><span>Mem</span></div>' +
        ports
          .map(
            (p) =>
              `<div class="c-tr ports${p.self ? ' self' : ''}" title="${esc(p.command)}">
                <span class="c-port">${p.ports[0]}${p.ports.length > 1 ? `<em>+${p.ports.length - 1}</em>` : ''}</span>
                <span title="${esc(p.cwd ?? '')}">${esc(p.where ?? '—')}${p.count > 1 ? ` <em>×${p.count}</em>` : ''}${p.self ? ` <em>${p.count > 1 ? 'incl. this app' : 'this app'}</em>` : ''}</span>
                <span>${esc(p.uptime ?? '')}</span>
                <span>${p.memory}MB</span>
              </div>`,
          )
          .join('')
      : '<p class="c-empty">Nothing is listening.</p>'
    $('n-ports').textContent = String(ports.length)
    $('n-risk').textContent = String(risky.length)
    drawSpans()
    const unpushed = repos.reduce((n, r) => n + (r.unpushed ?? 0), 0)
    $('chips').innerHTML = [
      `<span class="c-chip ${needs.length ? 'hot' : ''}"><b>${needs.length}</b> need you</span>`,
      `<span class="c-chip ${blocked.length ? 'warn' : ''}"><b>${blocked.length}</b> blocked</span>`,
      `<span class="c-chip live"><b>${working.length}</b> working</span>`,
      `<span class="c-chip ${unpushed ? 'bad' : ''}"><b>${unpushed}</b> unpushed commits</span>`,
    ].join('')
    opts.onCounts?.({
      needs: needs.length,
      blocked: blocked.length,
      working: working.length,
      unpushed,
    })
  }

  root.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
    if (!b) return
    const act = b.dataset.act
    if (act === 'open-here') {
      const s = sessions.find((x) => x.id === b.dataset.id)
      if (!s) return
      // the sessions view (sessions.ts) listens for this and resumes the conversation there
      dispatchEvent(
        new CustomEvent('laika:open-session', {
          detail: {
            id: s.id,
            cwd: s.cwd ?? s.repoPath ?? '',
            repo: s.repo.split('/').pop(),
            title: s.title,
            state: s.state,
            account: (s as { account?: string | null }).account ?? null,
          },
        }),
      )
      return
    }
    if (act === 'resume') {
      const s = sessions.find((x) => x.id === b.dataset.id)
      if (!s) return
      await navigator.clipboard.writeText(resumeCmd(s)).catch(() => {})
      b.textContent = 'Copied'
      setTimeout(() => {
        b.textContent = 'Copy resume command'
      }, 1400)
      return
    }
    const path = b.dataset.path
    if (path)
      fetch(`/api/control/open?kind=${act}&path=${encodeURIComponent(path)}`, {
        method: 'POST',
        headers: { 'x-control': '1' },
      }).catch(() => {})
  })

  const notifyBtn = $('notify')
  const syncNotify = () => {
    notifyBtn.hidden = !('Notification' in window) || Notification.permission === 'granted'
  }
  notifyBtn.addEventListener('click', async () => {
    await Notification.requestPermission().catch(() => {})
    syncNotify()
  })
  syncNotify()

  return {
    el: root,
    start() {
      if (timers.length) return
      loadSessions()
      loadSlow()
      timers.push(
        presence.every(5_000, loadSessions, { now: false }),
        presence.every(60_000, loadSlow, { now: false }),
        presence.every(30_000, render, { now: false }),
      )
    },
    stop() {
      for (const stop of timers.splice(0)) stop()
    },
  }
}
