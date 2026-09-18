/**
 * The fleet board: every open chat as one line, and each decision waiting on you as a button.
 *
 * With a dozen chats going, reading each one to find out which is stuck on you is the cost. The
 * board asks the host for a row per chat (title, state, a one-line status and the status line's ETA) and
 * lists what each chat waits on: a permission, a question, or a push or deploy to approve. The
 * page shows only that until you open a row; the chat itself keeps every word, so nothing is lost
 * by looking at less.
 *
 * Status and ETA are not guessed here. They come from what the other views already keep:
 *   - runs (runs.mjs, ~/.laika/progress): a run a chat reports to, with its etaAt
 *     and a state; blocked, stalled or orphaned becomes an attention button on the row
 *   - the status line (workSummary().bg, fleet-work.mjs): background shells and agents, each with
 *     an etaAt
 * Both may be absent (neither is merged everywhere yet); the row then shows time spent instead.
 *
 *   GET /fleet   { at, rows: [{ id, repo, title, state, status, eta, decisions, progress, … }] }
 */
import { inputSummary } from './away-policy.mjs'

/** the runs store, when this build has it */
let progressStore = null
import('./runs.mjs').then(
  (m) => (progressStore = m),
  () => {},
)
/** every progress board, newest first; [] when the store is not there or cannot be read */
export function progressBoards() {
  try {
    return progressStore?.listBoards() ?? []
  } catch {
    return []
  }
}

const clip = (t, n) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}
const base = (p) => String(p ?? '').split('/').pop()

/**
 * A command or tool call that sends work out of this Mac: a push, a publish, a deploy, a merge or
 * release on GitHub. These get their own button, because approving one cannot be taken back.
 * Returns the verb for the button, or null.
 */
export function shipKind(tool, input = {}) {
  if (tool === 'Bash') {
    const c = String(input.command ?? '')
    if (/\bgit\s+(?:-[Cc]\s+\S+\s+)*push\b/.test(c)) return 'push'
    if (/\b(?:docker|podman)\s+push\b/.test(c)) return 'push'
    if (/\b(?:npm|pnpm|yarn|bun|cargo|wrangler)\s+publish\b|\btwine\s+upload\b/.test(c)) return 'publish'
    if (/\bgh\s+(?:pr\s+merge|release\s+create)\b/.test(c)) return 'release'
    // `npm run deploy`, `fly deploy`, `./scripts/deploy.sh`, `pnpm deploy:prod`; not `cat deploy.md`
    if (/(?:^|[\s:/])deploy[:\w-]*(?:\.sh)?(?=\s|$|[;&|)])/m.test(c)) return 'deploy'
    // vercel deploys unless given a subcommand that only reads or sets up (`vercel env pull`)
    if (/\bvercel(?![.\w-])(?!\s+(?:env|link|login|logout|whoami|ls|list|logs|inspect|pull|dev|build|domains|dns|projects?|teams|switch|help|git|certs)\b)/.test(c)) return 'deploy'
    if (/\b(?:terraform|tofu)\s+apply\b|\bkubectl\s+(?:apply|rollout)\b|\bhelm\s+(?:install|upgrade)\b/.test(c)) return 'deploy'
    return null
  }
  // MCP tools: mcp__vercel__deploy_to_vercel, mcp__github__merge_pull_request, …
  if (/^mcp__/.test(tool)) {
    if (/deploy/i.test(tool)) return 'deploy'
    if (/publish/i.test(tool)) return 'publish'
    if (/push/i.test(tool)) return 'push'
    if (/merge|release/i.test(tool)) return 'release'
  }
  return null
}

const SHIP_LABEL = { push: 'Approve push', publish: 'Approve publish', deploy: 'Approve deploy', release: 'Approve release' }

/** one pending request as a board button, with enough to answer it without opening the chat */
export function decisionOf(event) {
  if (event.t === 'question') {
    const qs = Array.isArray(event.questions) ? event.questions : []
    const first = qs[0]
    return {
      requestId: event.requestId,
      kind: 'question',
      label: clip(first?.header || 'Question', 24),
      detail: clip(qs.map((q) => q.question).join(' / '), 200),
      questions: qs,
      at: event.at,
    }
  }
  const tool = String(event.tool ?? '')
  const input = event.input ?? {}
  const ship = shipKind(tool, input)
  const target = tool === 'Bash' ? clip(input.description || input.command, 40) : base(input.file_path ?? input.notebook_path ?? input.path) || tool
  return {
    requestId: event.requestId,
    kind: ship ? 'ship' : 'permission',
    ship,
    label: ship ? SHIP_LABEL[ship] : clip(`${tool === 'Bash' ? 'Run' : tool} ${target === tool ? '' : target}`, 40),
    detail: clip(event.description || inputSummary(tool, input), 200),
    tool,
    input,
    canAlways: !!event.canAlways,
    at: event.at,
  }
}

/** what a running chat is doing right now, in a few words */
function doingNow(events, since) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.at < since) break
    if (e.t !== 'tool' || e.sub) continue
    if (e.name === 'TodoWrite') {
      const now = (e.input?.todos ?? []).find((x) => x.status === 'in_progress')
      if (now) return clip(now.activeForm || now.content, 120)
      continue
    }
    if (e.name === 'Bash') return clip(`Running ${e.input?.description || e.input?.command || 'a command'}`, 120)
    if (e.name === 'Agent' || e.name === 'Task') return clip(`Sub-agent: ${e.input?.description ?? ''}`, 120)
    const f = base(e.input?.file_path ?? e.input?.notebook_path)
    const verb = { Read: 'Reading', Edit: 'Editing', MultiEdit: 'Editing', Write: 'Writing', Grep: 'Searching', Glob: 'Finding files', WebFetch: 'Fetching', WebSearch: 'Searching the web' }[e.name]
    return clip(verb ? `${verb}${f ? ` ${f}` : ''}` : `Using ${e.name}`, 120)
  }
  return null
}

/** the latest todo list written this turn */
function todosSince(events, since) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.at < since) break
    if (e.t === 'tool' && !e.sub && e.name === 'TodoWrite' && Array.isArray(e.input?.todos)) return e.input.todos
  }
  return null
}

const ENDED = new Set(['done', 'failed', 'cancelled'])
const ATTENTION = { blocked: 'Blocked', stalled: 'Stalled', orphaned: 'Orphaned' }

/** the progress board this chat reports to: the newest one still going, else the newest */
export function progressOf(s, boards = []) {
  const mine = boards.filter((b) => b && (b.chat === s.sdkSessionId || b.chat === s.id) && b.chat)
  const b = mine.find((x) => !ENDED.has(x.state)) ?? mine[0]
  if (!b) return null
  const laneNames = (pick) => (b.lanes ?? []).filter(pick).map((l) => clip(l.name || l.id, 40))
  return {
    id: b.id,
    title: clip(b.title, 80),
    note: clip(b.note, 160),
    pct: Math.round(Number(b.pct) || 0),
    etaAt: b.etaAt ?? null,
    etaDerived: !!b.etaDerived,
    state: b.state,
    quietMs: b.quietMs ?? null,
    blocked: laneNames((l) => l.status === 'blocked'),
    stalled: laneNames((l) => l.stalled),
    lanes: (b.lanes ?? []).map((l) => ({ name: clip(l.name || l.id, 40), status: l.status, pct: Math.round(Number(l.pct) || 0), note: clip(l.note, 120), stalled: !!l.stalled })),
  }
}

/** a progress board that needs you (blocked, stalled, its chat gone) as a button beside the decisions */
export function attentionOf(p) {
  if (!p || !ATTENTION[p.state]) return null
  const lanes = p.state === 'blocked' ? p.blocked : p.state === 'stalled' ? p.stalled : []
  return {
    requestId: `progress:${p.id}`,
    kind: 'attention',
    state: p.state,
    label: clip(`${ATTENTION[p.state]}${lanes.length ? `: ${lanes[0]}` : ''}`, 40),
    detail: clip(
      p.state === 'orphaned' ? `${p.title}: its chat stopped before it finished` : `${p.title}${lanes.length ? ` · ${lanes.join(', ')}` : ''}${p.note ? ` · ${p.note}` : ''}`,
      200,
    ),
  }
}

/**
 * The ETA, from the views that already keep one: the chat's live progress board first (explicit,
 * or projected from its lanes' rate), else the status line's background tasks (the one that will
 * finish last). null when neither has a basis; the page then shows the time spent so far.
 */
export function etaOf(s, progress = null) {
  if (progress?.etaAt && !ENDED.has(progress.state))
    return { at: progress.etaAt, source: 'progress', basis: progress.etaDerived ? 'progress rate' : 'stated', label: progress.title, typicalMs: null }
  const bg = (typeof s.workSummary === 'function' ? s.workSummary()?.bg : s.work?.bg) ?? []
  const timed = bg.filter((t) => Number(t?.etaAt) > 0)
  if (!timed.length) return null
  const last = timed.reduce((a, b) => (b.etaAt > a.etaAt ? b : a))
  return { at: last.etaAt, source: 'status', basis: last.basis ?? null, typicalMs: last.typicalMs ?? null, label: clip(last.label, 60) }
}

/** one line on where a chat stands */
export function statusOf(s, decisions = []) {
  const events = s.events ?? []
  if (decisions.length) {
    const d = decisions[0]
    const more = decisions.length > 1 ? ` (+${decisions.length - 1} more)` : ''
    if (d.kind === 'question') return `Asks: ${clip(d.detail, 110)}${more}`
    const verb = d.ship ?? { Bash: 'run', Edit: 'edit', MultiEdit: 'edit', Write: 'write', NotebookEdit: 'edit', WebFetch: 'fetch' }[d.tool] ?? `use ${d.tool}`
    return `Wants to ${verb}: ${clip(d.detail, 100)}${more}`
  }
  if (s.state === 'running' || s.state === 'starting') {
    const doing = doingNow(events, s.work?.start || 0)
    if (doing) return doing
    return s.state === 'starting' ? 'Starting' : s.work?.phase === 'writing' ? 'Writing a reply' : 'Thinking'
  }
  if (s.state === 'error') {
    const err = events.findLast((e) => e.t === 'error' || (e.t === 'result' && e.error))
    return clip(err ? `Stopped: ${err.message ?? err.error}` : 'Stopped with an error', 140)
  }
  if (s.brief?.now) return clip(s.brief.now, 140)
  const said = events.findLast((e) => e.t === 'text' && !e.sub)
  if (said) return clip(String(said.text).split('\n').find((l) => l.trim()) ?? '', 140)
  return 'Ready for a first message'
}

/** the last few things said and done, for an opened row */
function recentOf(events, n = 6) {
  const out = []
  for (let i = events.length - 1; i >= 0 && out.length < n; i--) {
    const e = events[i]
    if (e.sub) continue
    if (e.t === 'user' && !e.auto) out.push({ who: 'you', text: clip(e.text, 160) })
    else if (e.t === 'text') out.push({ who: 'claude', text: clip(e.text, 200) })
    else if (e.t === 'tool' && e.name !== 'TodoWrite') out.push({ who: 'step', text: clip(`${e.name} ${inputSummary(e.name, e.input ?? {})}`, 140) })
    else if (e.t === 'error') out.push({ who: 'error', text: clip(e.message, 160) })
  }
  return out.reverse()
}

/** a chat as one board row */
export function boardRow(s, { now = Date.now(), boards = [] } = {}) {
  const decisions = [...(s.pending?.values() ?? [])].map((p) => decisionOf(p.event))
  const progress = progressOf(s, boards)
  const attention = attentionOf(progress)
  const todos = todosSince(s.events ?? [], 0)
  return {
    id: s.id,
    sdkSessionId: s.sdkSessionId ?? null,
    repo: s.repo,
    cwd: s.cwd,
    title: s.title,
    role: s.role ?? null,
    /** the conductor's label for a set of chats (fleet_rename); null when ungrouped */
    group: typeof s.group === 'string' && s.group.trim() ? s.group.trim() : null,
    state: s.state,
    status: statusOf(s, decisions),
    eta: etaOf(s, progress),
    since: decisions.length ? Math.min(...decisions.map((d) => d.at ?? now)) : s.state === 'running' || s.state === 'starting' ? s.work?.start || null : s.updatedAt,
    decisions: attention ? [...decisions, attention] : decisions,
    // the rest is only shown when the row is opened
    progress,
    goal: s.brief?.goal || s.goal || '',
    next: s.brief?.next || '',
    todos: todos ?? [],
    recent: recentOf(s.events ?? []),
    cost: s.cost ?? 0,
    turns: s.turns ?? 0,
    updatedAt: s.updatedAt,
  }
}

const RANK = { waiting: 0, error: 2, running: 3, starting: 3, idle: 4 }

/**
 * the whole board: decisions waiting on you first, then attention, stopped, busy, and the rest.
 *
 * Two sections, each row saying which it is in (`section`), so the page only paints:
 *  - 'needs-you': every chat with a decision waiting (rank 0) or a progress board blocked, stalled
 *    or orphaned (rank 1), whatever its group. Both stop until you look, so neither may sit below
 *    a quiet group; the page tags each with its group.
 *  - 'group': the rest, ungrouped chats first, then each group as one block, in the order its most
 *    urgent remaining chat ranks.
 */
export function fleetBoard(sessions, { now = Date.now(), boards = progressBoards() } = {}) {
  const rows = [...sessions].filter((s) => s.state !== 'closed').map((s) => boardRow(s, { now, boards }))
  const rank = (r) => (r.decisions.some((d) => d.kind !== 'attention') ? 0 : r.decisions.length ? 1 : (RANK[r.state] ?? 4))
  rows.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
  const needs = rows.filter((r) => rank(r) <= 1).map((r) => ({ ...r, section: 'needs-you' }))
  const rest = rows.filter((r) => rank(r) > 1).map((r) => ({ ...r, section: 'group' }))
  const order = new Map([[null, 0]])
  for (const r of rest) if (!order.has(r.group)) order.set(r.group, order.size)
  rest.sort((a, b) => order.get(a.group) - order.get(b.group))
  return { at: now, rows: [...needs, ...rest] }
}
