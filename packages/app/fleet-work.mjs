/**
 * Fleet work: what a chat is doing in the background, how long it has left, and the built-in fleet
 * commands (/checkpoint, /resume-offload) that work the same in every chat and every account.
 *
 * Background work comes from the SDK's task messages (task_started, task_progress, task_updated,
 * task_notification, background_tasks_changed). Its ETA is rough and says what it rests on:
 *  - progress: the task's output ends in a percentage or an "n/total" count, so the time taken so
 *    far is scaled by what is left;
 *  - history: the same kind of task (by its description) took this long before, so the median of
 *    those runs, less the time taken so far;
 *  - neither: no ETA, only how long it has been running.
 *
 * THE SHAPE (stable: the fleet board, the hourly summary and the conductor read it). Every chat
 * summary from the host (GET /api/control/agent/sessions, and each chat's `summary`/`progress`
 * stream events) has `work.bg`, an array, empty when nothing runs in the background:
 *
 *   {
 *     id: string            the SDK task id, or "board:<id>" for a live-progress board
 *     source: 'task' | 'board'
 *     label: string         what it is, in the model's words ("Run the test suite")
 *     type: string | null   'local_bash' | 'local_agent' | 'local_workflow' | 'mcp_task' | 'progress_board' | …
 *     startedAt: number     ms epoch, when this host saw it start (a board: when it was created)
 *     backgrounded: boolean false while a foreground tool call still blocks on it
 *     pct: number | null    0–100, when its output (or board) shows progress
 *     etaAt: number | null  ms epoch it should finish by; null when there is no basis
 *     etaDerived: boolean   true when etaAt is projected, false when someone stated it (a board's --eta)
 *     etaPartial: boolean   true when etaAt is a lower bound (a board where only some lanes have an ETA)
 *     basis: 'explicit' | 'progress' | 'history' | null   what etaAt rests on
 *     typicalMs: number | null   median of earlier runs of the same kind of task
 *     summary: string | null     the SDK's one-line progress note, or the board's note
 *     state: string | null  a board's state (running | stalled | blocked | …); null for a task
 *   }
 *
 * etaAt and etaDerived mean what they mean in the runs store (runs.mjs): a chat that
 * reports to a board (board.chat is its Claude session id) shows that board here too, and a
 * stated ETA wins over a projected one.
 *
 * `etaText(task)` turns one into words ("~3m left", "overdue (usually 5m)", "4m in"). The
 * summary is refreshed every 10s while any task runs; etaAt is absolute, so count down locally.
 */
import { execFile } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// the runs store, where it is installed (packages/app/runs.mjs)
const progress = await import('./runs.mjs').catch(() => null)
// unfinished: 'idle' is a board between steps; 'orphaned' cannot belong to a live chat
const LIVE_BOARD = new Set(['running', 'stalled', 'blocked', 'idle'])

/** a chat's own live-progress boards that are still going, in the shape above */
let boardsMemo = { at: 0, boards: [] }
export function boardTasks(sessionId, { list = progress?.listBoards } = {}) {
  if (!sessionId || !list) return []
  // every chat asks; the store is read once for all of them
  if (list !== progress?.listBoards || Date.now() - boardsMemo.at > 1500) {
    try {
      boardsMemo = { at: Date.now(), boards: list() }
    } catch {
      boardsMemo = { at: Date.now(), boards: [] }
    }
  }
  const boards = boardsMemo.boards
  return boards
    .filter((b) => b.chat === sessionId && LIVE_BOARD.has(b.state))
    .map((b) => ({
      id: `board:${b.id}`,
      source: 'board',
      label: String(b.title || b.id).slice(0, 80),
      type: 'progress_board',
      startedAt: b.createdAt,
      backgrounded: true,
      pct: typeof b.pct === 'number' ? Math.round(b.pct) : null,
      etaAt: b.etaAt ?? null,
      etaDerived: b.etaAt ? !!b.etaDerived : false,
      etaPartial: !!(b.etaAt && b.etaPartial),
      basis: b.etaAt ? (b.etaDerived ? 'progress' : 'explicit') : null,
      typicalMs: null,
      summary: b.note ? String(b.note).slice(0, 120) : null,
      state: b.state,
    }))
}

// ----------------------------------------------------------------- commands ----
const offloadCmd = () =>
  `BRAIN_ROOT=${JSON.stringify(process.env.BRAIN_ROOT ?? resolveBrainRoot())} node ${JSON.stringify(join(HERE, 'offload.mjs'))}`
const resolveBrainRoot = () => join(HERE, '..', '..')

export const FLEET_COMMANDS = {
  checkpoint: {
    description: 'Pause, stop what this chat started, commit locally, report in one line',
    prompt: (extra) =>
      `[/checkpoint] Checkpoint this chat now.
1. Stop at the nearest safe point. Do not start anything new.
2. Stop the background work this chat started: background shells and tasks, file watchers and trackers, dev servers and any other long-running process you launched (by the task, PID or port you started it on). Leave processes you did not start alone.
3. Commit the unsaved work locally on the current branch. Commit only the changes this chat made: other sessions may share this working tree, so if there are uncommitted changes that are not yours, leave them out (stage by path, or follow the repo's own commit procedure if its CLAUDE.md or memory describes one). Keep hooks on; if a commit is refused, do not force it, say why. Never push.
4. Reply with exactly one line and nothing else:
Checkpoint: <short sha, or "nothing to commit"> · stopped <what, or "nothing"> · resume: <the next step, in a few words>${extra ? `\n\nAlso: ${extra}` : ''}`,
  },
  'resume-offload': {
    description: 'Resume from the last checkpoint, sending heavy compute to the offload machines',
    prompt: (extra) =>
      `[/resume-offload] Resume the work from where this chat stopped: the last "Checkpoint:" line in this conversation and its commit (git log -1) say where. Carry on with the next step.
Send heavy compute to the other machines through Laika Orbit's offload tool instead of running it on this Mac: builds, test suites longer than a minute, Unity, ffmpeg and renders, captures, large installs. Light checks (typecheck, lint, a single test file) stay local.
  ${offloadCmd()} run [--needs gpu] [--bring <dir>] -- <command>
Leave out --on: offload picks the machine by what the work needs. GPU work (Unity, renders, captures, browsers) goes to a machine with a GPU that renders properly, and shell scripts only to Linux machines; add --needs gpu when it cannot tell (\`${offloadCmd()} where --needs gpu\` shows the pick). It copies this folder over, streams the output back and brings written files home. Run it in the background and keep working meanwhile. A Linux machine allows one sync at a time: if it reports another rsync instance, wait a few seconds and retry. If no machine can take it (\`${offloadCmd()} health\`), say so and run the step locally.${extra ? `\n\nAlso: ${extra}` : ''}`,
  },
}

/** `/checkpoint`, `/resume-offload extra words` → the prompt the model gets; null for anything else */
export function expandFleetCommand(text) {
  const m = /^\s*\/([a-z-]+)(?:\s+([\s\S]*))?$/.exec(String(text ?? ''))
  const c = m && Object.hasOwn(FLEET_COMMANDS, m[1]) ? FLEET_COMMANDS[m[1]] : null
  return c ? c.prompt((m[2] ?? '').trim()) : null
}

// -------------------------------------------------------------------- spawns ----
/** at most this many conductor-spawned chats open at once, across every conductor */
export const MAX_SPAWNED = 3
/** the spawn cap as it stands: the open conductor-spawned chats, and how many more may open */
export function spawnSlots(sessions) {
  const open = [...sessions.values()].filter((x) => x.spawnedBy && x.state !== 'closed')
  return { open, used: open.length, max: MAX_SPAWNED, free: Math.max(0, MAX_SPAWNED - open.length) }
}

/** why a conductor may not open another chat now (fleet_spawn, fleet_unpark), or null when it may */
export function spawnRefusal(sessions) {
  const { open } = spawnSlots(sessions)
  if (open.length < MAX_SPAWNED) return null
  return `${open.length} conductor-spawned chats are already open (the limit is ${MAX_SPAWNED}): ${open.map((x) => `${x.id.slice(0, 8)} (${x.repo})`).join(', ')}. Wait for one to finish and be closed, or send the work to an existing chat.`
}

// -------------------------------------------------------------------- closes ----
/**
 * Whether a conductor may close a chat: null when it may, otherwise why not.
 * `dirty` is the chat's worktree: true with uncommitted changes, false when clean (or not a git
 * repo), null when it could not be checked. Only chats a conductor opened can be closed; `force`
 * skips the idle, background and waiting checks, never the uncommitted-work one.
 */
export function closeRefusal(x, { dirty, force = false } = {}) {
  if (!x.spawnedBy)
    return `${x.id.slice(0, 8)} (${x.repo}) was opened by the user: you cannot close it. Suggest closing it to the user with fleet_suggest instead.`
  if (dirty === true) return `${x.id.slice(0, 8)} has uncommitted changes in ${x.cwd}: have it commit (or /checkpoint) first. force does not override this.`
  if (dirty !== false) return `Could not check ${x.cwd} for uncommitted changes, so it stays open.`
  if (force) return null
  const waits = [...(x.pending?.values() ?? [])].map((p) => p.kind)
  if (waits.length) return `It is waiting on the user (${waits.join(', ')}).`
  if (x.state !== 'idle') return `It is ${x.state}, not idle.`
  const bg = x.background?.() ?? []
  if (bg.length) return `It still has background work running: ${bg.map((t) => t.label).join(', ')}.`
  return null
}

// -------------------------------------------------------------------- parked ----
/**
 * Parked chats: closed by a conductor (fleet_park) but kept resumable. Each row has what it takes
 * to start the conversation again (sdkSessionId, cwd, account, …) and why it was parked. Unlike
 * the host's `deferred` list, nothing comes back on its own: you, or a conductor, resume one.
 * Kept in ~/.laika/parked-chats-<port>.json (LAIKA_PARKED points a test elsewhere).
 */
export function createParked({ file = process.env.LAIKA_PARKED ?? join(homedir(), '.laika', `parked-chats-${process.env.APP_PORT ?? '5200'}.json`) } = {}) {
  const read = () => {
    try {
      const rows = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(rows) ? rows.filter((r) => r?.id && r.sdkSessionId) : []
    } catch {
      return []
    }
  }
  const write = (rows) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(`${file}.tmp`, JSON.stringify(rows, null, 1), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
  /** a parked chat by its id, the first characters of it, or its conversation id */
  const find = (key, rows = read()) => {
    const k = String(key ?? '').trim()
    if (!k) return null
    const hits = rows.filter((r) => r.id === k || r.sdkSessionId === k || r.id.startsWith(k))
    return hits.length === 1 ? hits[0] : null
  }
  return {
    list: read,
    find: (key) => find(key),
    /** park a chat: the one row per conversation, the latest wins */
    add(row) {
      const rows = read().filter((r) => r.id !== row.id && r.sdkSessionId !== row.sdkSessionId)
      rows.push(row)
      write(rows)
      return row
    },
    /** forget a parked chat (resumed, or dropped); the row, or null when there was none */
    remove(key) {
      const rows = read()
      const r = find(key, rows)
      if (r) write(rows.filter((x) => x !== r))
      return r
    },
  }
}

/** a parked row from an open chat */
export const parkedRow = (x, { reason = '', by = null, at = Date.now() } = {}) => ({
  id: x.id,
  sdkSessionId: x.sdkSessionId,
  cwd: x.cwd,
  repo: x.repo,
  account: x.account?.id ?? null,
  mode: x.mode ?? 'default',
  model: x.model ?? null,
  effort: x.effort ?? null,
  title: x.title || x.brief?.goal || '',
  group: x.group ?? null,
  spawnedBy: x.spawnedBy ?? null,
  parkedBy: by,
  parkedAt: at,
  reason: String(reason ?? '').slice(0, 300),
})

// --------------------------------------------------------------------- stale ----
/** idle this long, with a clean worktree and nothing going on: probably done */
export const STALE_MS = 24 * 3_600_000
/**
 * Whether a chat looks finished and forgotten: "idle 26h, clean: probably done", or null. `dirty`
 * as in closeRefusal; leave it undefined for the cheap checks alone (then a stale-looking chat
 * says so without the git check, so call it again with the worktree's state).
 */
export function staleHint(x, { dirty, now = Date.now() } = {}) {
  if (x.state !== 'idle' || x.pending?.size || x.closeAfter) return null
  const idle = now - (x.updatedAt ?? now)
  if (idle <= STALE_MS) return null
  if ((x.background?.() ?? []).length) return null
  if (dirty !== undefined && dirty !== false) return null
  const h = Math.floor(idle / 3_600_000)
  return `idle ${h >= 72 ? `${Math.floor(h / 24)}d` : `${h}h`}, clean: probably done`
}

/** a folder's uncommitted changes: true, false (clean, or not a git repo), or null when git failed */
export function worktreeDirty(cwd, { run = execFile } = {}) {
  return new Promise((done) =>
    run('git', ['-C', cwd, 'status', '--porcelain', '--untracked-files=normal'], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) return done(/not a git repository/i.test(String(stderr ?? err.message)) ? false : null)
      done(String(stdout).trim().length > 0)
    }),
  )
}

// ------------------------------------------------------------------ handoffs ----
/**
 * A folder's branch and HEAD, for a handoff: { branch, sha, changed } (changed: how many tracked files
 * have uncommitted changes), or null when it is not a git repo or git failed. One git call.
 */
export function gitHead(cwd, { run = execFile } = {}) {
  return new Promise((done) =>
    run('git', ['-C', cwd, 'status', '--porcelain=v2', '--branch', '--untracked-files=no'], { timeout: 10_000 }, (err, stdout) => {
      if (err) return done(null)
      const lines = String(stdout).split('\n')
      const field = (k) => lines.find((l) => l.startsWith(`# branch.${k} `))?.slice(`# branch.${k} `.length).trim() ?? null
      const oid = field('oid')
      done({
        branch: field('head'),
        sha: oid && /^[0-9a-f]{7,}$/.test(oid) ? oid.slice(0, 7) : null,
        changed: lines.filter((l) => /^[12u] /.test(l)).length,
      })
    }),
  )
}

/** the text of a handoff clipped to n characters, keeping its line breaks */
const clipKeep = (t, n) => {
  const s = String(t ?? '').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/**
 * The brief a conductor's fleet_handoff sends on: one chat's finished result, for another chat to
 * pick up. `head` is gitHead's answer for the chat's folder; `note` says what to do with it.
 */
export function handoffBrief(x, { head = null, note = '' } = {}) {
  const said = (x.events ?? []).filter((e) => e.t === 'text' && !e.sub && String(e.text ?? '').trim())
  const checkpoint = said.filter((e) => /Checkpoint:/.test(e.text)).at(-1)?.text.match(/Checkpoint:.*/)?.[0]
  const last = said.at(-1)?.text
  const lines = [`Handoff from chat ${x.id.slice(0, 8)} (${x.repo}), in ${x.cwd}.`]
  if (x.brief?.goal) lines.push(`Its goal: ${clipKeep(x.brief.goal, 300)}`)
  if (x.brief?.now) lines.push(`Where it stands: ${clipKeep(x.brief.now, 400)}`)
  if (checkpoint) lines.push(clipKeep(checkpoint, 300))
  if (head?.branch || head?.sha)
    lines.push(`Git: ${head.branch ?? '?'} at ${head.sha ?? 'no commits yet'}${head.changed ? `, ${head.changed} file(s) with uncommitted changes` : ''}`)
  if (last) lines.push('', 'Its last reply:', clipKeep(last, 1500))
  lines.push('', `What to do with it: ${String(note ?? '').trim() || 'carry on from here.'}`)
  return lines.join('\n')
}

/** a chat's group label, tidied: null clears it */
export const groupLabel = (g) => {
  const t = String(g ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
  return t || null
}

/**
 * The group a new chat joins by itself: the one group every other open chat in the same folder or
 * repo shares. None when those chats have no group, or more than one (then it is not clear which).
 */
export function inferGroup(sessions, { cwd, repo, id } = {}) {
  const groups = new Set()
  for (const x of sessions) {
    if (!x || x.id === id || x.state === 'closed') continue
    if (!((cwd && x.cwd === cwd) || (repo && x.repo === repo))) continue
    const g = groupLabel(x.group)
    if (g) groups.add(g)
  }
  return groups.size === 1 ? [...groups][0] : null
}

// ----------------------------------------------------------- task durations ----
const durationsFile = () => process.env.LAIKA_TASK_DURATIONS ?? join(homedir(), '.laika', 'task-durations.json')
let durations = null
const loadDurations = () => {
  if (durations) return durations
  try {
    durations = JSON.parse(readFileSync(durationsFile(), 'utf8'))
  } catch {
    durations = {}
  }
  return durations
}
/** tasks of one kind share a key: numbers, paths and ids vary between runs, the words do not */
export const taskKey = (type, label) =>
  `${type ?? 'task'}:${String(label ?? '')
    .toLowerCase()
    .replace(/[0-9a-f]{7,}/g, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)}`
export function recordDuration(key, ms) {
  if (!(ms > 1000)) return
  const d = loadDurations()
  d[key] = [...(d[key] ?? []), Math.round(ms)].slice(-7)
  try {
    mkdirSync(dirname(durationsFile()), { recursive: true, mode: 0o700 })
    writeFileSync(`${durationsFile()}.tmp`, JSON.stringify(d), { mode: 0o600 })
    renameSync(`${durationsFile()}.tmp`, durationsFile())
  } catch {}
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null
}

// --------------------------------------------------------- progress in output ----
/**
 * How far along the output says it is, 0–1, from its last lines: "45%", "[12/80]", "12 of 80",
 * "12/80". Null when it says nothing usable.
 */
export function progressOf(tail) {
  const lines = String(tail ?? '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal colour codes
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .split(/[\r\n]+/)
    .filter((l) => l.trim())
    .slice(-15)
    .reverse()
  for (const l of lines) {
    const pct = [...l.matchAll(/(\d{1,3}(?:\.\d+)?)\s?%/g)].at(-1)
    if (pct && Number(pct[1]) <= 100) return Number(pct[1]) / 100
    const frac = [...l.matchAll(/(?:^|[\s[(])(\d{1,6})\s?(?:\/|of)\s?(\d{1,6})(?=$|[\s\]),:])/g)].at(-1)
    if (frac) {
      const [n, d] = [Number(frac[1]), Number(frac[2])]
      if (d >= 2 && n <= d) return n / d
    }
  }
  return null
}

const readTail = (file, bytes = 6000) => {
  let fd
  try {
    const size = statSync(file).size
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(Math.min(bytes, size))
    readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length))
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Claude Code keeps a background task's output at <tmp>/claude-<uid>/<project>/<session>/tasks/<task>.output */
function findOutput(sessionId, taskId) {
  if (!sessionId || !taskId) return null
  const uid = process.getuid?.() ?? ''
  for (const base of new Set(['/private/tmp', '/tmp', tmpdir()])) {
    const root = join(base, `claude-${uid}`)
    let dirs = []
    try {
      dirs = readdirSync(root)
    } catch {
      continue
    }
    for (const d of dirs) {
      const f = join(root, d, sessionId, 'tasks', `${taskId}.output`)
      if (existsSync(f)) return f
    }
  }
  return null
}

// ------------------------------------------------------------------ tracker ----
/** one chat's background work, fed the SDK's system messages */
export function createTaskTracker({ now = () => Date.now(), output = findOutput } = {}) {
  const tasks = new Map()
  // left the background level before its notification came: kept briefly so the notification can
  // still say how it ended (the level usually arrives first)
  const gone = new Map()
  const end = (id, status) => {
    const t = tasks.get(id) ?? gone.get(id)
    if (!t) return false
    const was = tasks.delete(id)
    gone.delete(id)
    if (status === 'completed') recordDuration(t.key, (t.endedAt ?? now()) - t.startedAt)
    return was
  }
  const drop = (id) => {
    const t = tasks.get(id)
    tasks.delete(id)
    gone.set(id, { ...t, endedAt: now() })
    for (const k of [...gone.keys()].slice(0, -20)) gone.delete(k)
    return true
  }
  const add = (id, o) => {
    if (tasks.has(id) || o.ambient || o.skip_transcript) return false
    const label = String(o.description ?? o.task_type ?? 'task').replace(/\s+/g, ' ').slice(0, 80)
    tasks.set(id, { id, type: o.task_type ?? null, label, key: taskKey(o.task_type, label), startedAt: now(), backgrounded: o.is_backgrounded !== false, file: undefined, fileCheckedAt: 0 })
    return true
  }

  /** a system message; true when the set of tasks changed */
  function handle(m) {
    switch (m?.subtype) {
      case 'task_started':
        return add(m.task_id, m)
      case 'task_updated': {
        const t = tasks.get(m.task_id)
        const st = m.patch?.status
        if (t && typeof m.patch?.is_backgrounded === 'boolean') t.backgrounded = m.patch.is_backgrounded
        if (t && m.patch?.description) t.label = String(m.patch.description).slice(0, 80)
        return st && ['completed', 'failed', 'killed'].includes(st) ? end(m.task_id, st) : false
      }
      case 'task_progress': {
        const t = tasks.get(m.task_id)
        if (t && m.summary) t.summary = String(m.summary).slice(0, 120)
        return false
      }
      case 'task_notification':
        return end(m.task_id, m.status)
      case 'background_tasks_changed': {
        const live = (m.tasks ?? []).filter((x) => !x.ambient)
        const ids = new Set(live.map((x) => x.task_id))
        let changed = false
        // gone from the level without a notification: ended somehow, its duration unknown
        for (const id of [...tasks.keys()]) if (tasks.get(id).backgrounded && !ids.has(id)) changed = drop(id) || changed
        for (const x of live) changed = add(x.task_id, x) || changed
        return changed
      }
      default:
        return false
    }
  }

  /** what the page and the conductor see: each task with its ETA, if there is a basis for one */
  function view(sessionId) {
    const t0 = now()
    return [...tasks.values()].map((t) => {
      const elapsed = t0 - t.startedAt
      let pct = null
      if (t.type === 'local_bash' || t.type === null) {
        if (t.file === undefined || (!t.file && t0 - t.fileCheckedAt > 15_000)) {
          t.fileCheckedAt = t0
          t.file = output(sessionId, t.id)
        }
        if (t.file) pct = progressOf(readTail(t.file))
      }
      const typical = median(loadDurations()[t.key] ?? [])
      let etaAt = null
      let basis = null
      if (pct !== null && pct >= 0.03 && pct < 1 && elapsed > 8000) {
        etaAt = t0 + Math.round((elapsed * (1 - pct)) / pct)
        basis = 'progress'
      } else if (typical) {
        etaAt = t.startedAt + typical
        basis = 'history'
      }
      return { id: t.id, source: 'task', label: t.label, type: t.type, startedAt: t.startedAt, backgrounded: t.backgrounded, pct: pct === null ? null : Math.round(pct * 100), etaAt, etaDerived: etaAt !== null, etaPartial: false, basis, typicalMs: typical, summary: t.summary ?? null, state: null }
    })
  }

  /** a new Claude Code process: whatever the last one ran is gone (init comes every turn, so not on that) */
  const reset = () => {
    const had = tasks.size > 0
    tasks.clear()
    gone.clear()
    return had
  }

  return { handle, view, reset, get size() {
    return tasks.size
  } }
}

/** "~3m left", "~40s left", "overdue (usually 5m)", "4m in": a task's status in a few words */
export function etaText(t, at = Date.now()) {
  const dur = (ms) => {
    const s = Math.max(1, Math.round(ms / 1000))
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`
  }
  if (t.etaAt && t.etaAt > at) return `${t.etaPartial ? 'at least ' : '~'}${dur(t.etaAt - at)} left`
  if (t.etaAt && t.typicalMs) return `overdue (usually ${dur(t.typicalMs)})`
  if (t.etaAt) return 'almost done'
  return `${dur(at - t.startedAt)} in`
}
