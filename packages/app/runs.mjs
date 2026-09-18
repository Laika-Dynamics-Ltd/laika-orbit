#!/usr/bin/env node
/**
 * Runs — the one place every chat reports work that is worth watching, and the one page (/runs)
 * that shows all of it. A run is work with parts, minutes to hours, producing artefacts:
 *
 *   lanes     parallel tracks (builders and a critic, test shards, this Mac vs box1)
 *   jobs      items inside a lane, each with a state, a start and a duration
 *   artefacts images, pages and logs the run produced, comparable side by side
 *   verdicts  gauntlet only: candidate vs reference, who won, in which slot order, why
 *   waves     gauntlet rounds; plain runs never set one and never show them
 *
 * Progress and ETA are derived from finished work — a lane's own rate, sharpened by how long past
 * runs of the same kind took — and never guessed.
 *
 * WHY FILES AND NOT A SERVER: chats kept standing up their own tracker servers (localhost:7340, a
 * gauntlet monitor, a profiler page), and those died with the chat or stalled on a port clash,
 * taking the progress with them. Here a report is a JSON file written with an atomic rename, so
 * posting works whether or not the app is running, :5200 and :5300 show the same runs, and a
 * restart loses nothing.
 *
 * This file is both the store the server reads (runs-api.mjs) and the CLI chats call. It has no
 * dependencies so the live-progress skill can carry a copy (tools/live-progress/install.sh).
 *
 *   ~/.laika/progress/<run>/board.json            title, kind, project, where, chat, finish state
 *   ~/.laika/progress/<run>/lanes/<lane>.json     status, pct, eta, note, samples, jobs
 *   ~/.laika/progress/<run>/artifacts/<id>.json   one artefact: path, label, compare group, wave
 *   ~/.laika/progress/<run>/verdicts/<id>.json    one gauntlet verdict
 *   ~/.laika/progress/.history/<kind>.jsonl       finished runs of a kind, for honest ETAs
 *
 * The directory keeps its old name and board.json its old shape, because chats that started
 * under the previous live-progress skill are still writing into it and must not break.
 *
 * One file per lane and per artefact, so parallel agents never write the same file. Writes to one
 * file are still serialised by a short lock, for two writers on one lane.
 *
 * Stalled: a lane that is running (or a run that is neither finished nor blocked) with no update
 * for its stall limit. A run whose chat process has exited without finishing is over — that chat
 * will never post again — so it is read as ended rather than left running for ever.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DIR = process.env.LAIKA_PROGRESS_DIR || join(homedir(), '.laika', 'progress')
export const STATUSES = ['queued', 'running', 'blocked', 'done', 'failed', 'skipped']
const ENDED = new Set(['done', 'failed', 'cancelled'])
const SETTLED = new Set(['done', 'failed', 'skipped'])
export const DEFAULT_STALL_MIN = 10
/** progress samples kept per lane, for the derived ETA */
const SAMPLES = 24

/** an id as a safe file name: lower-case letters, digits, dot, dash, underscore */
export function slug(s) {
  const v = String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, 64)
  if (!v) throw new Error(`not a usable id: ${JSON.stringify(s)}`)
  return v
}

/** "15m", "2h", "90s", "1h30m", a bare number of minutes, or a date → epoch ms (null if blank) */
export function parseEta(v, now = Date.now()) {
  if (v === undefined || v === null || v === '') return null
  if (typeof v === 'number') return now + v * 60_000
  const s = String(v).trim()
  if (/^\d+(\.\d+)?$/.test(s)) return now + Number(s) * 60_000
  const parts = [...s.matchAll(/(\d+(?:\.\d+)?)\s*(h|m|s)/g)]
  if (parts.length && parts.map((p) => p[0]).join('') === s.replace(/\s+/g, '')) {
    const unit = { h: 3_600_000, m: 60_000, s: 1000 }
    return now + parts.reduce((t, p) => t + Number(p[1]) * unit[p[2]], 0)
  }
  const at = Date.parse(s)
  if (Number.isNaN(at)) throw new Error(`not an ETA: ${JSON.stringify(v)} (try 15m, 2h, 1h30m or a time)`)
  return at
}

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(f, v) {
  const tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`)
  renameSync(tmp, f)
}

/** read-modify-write one file under a mkdir lock; a lock older than 5s is a dead writer's */
function update(f, fn) {
  const lock = `${f}.lock`
  const until = Date.now() + 3000
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5000) rmdirSync(lock)
      } catch {}
      if (Date.now() > until) throw new Error(`${f} is locked by another writer`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15)
    }
  }
  try {
    const next = fn(readJson(f))
    writeJson(f, next)
    return next
  } finally {
    try {
      rmdirSync(lock)
    } catch {}
  }
}

const boardDir = (dir, run) => join(dir, slug(run))
const HISTORY = '.history'
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]))
const clampPct = (n) => Math.max(0, Math.min(100, Number(n)))

function checkStatus(s) {
  if (s !== undefined && !STATUSES.includes(s)) throw new Error(`status must be one of ${STATUSES.join(', ')}`)
}

/**
 * The chat that is reporting, from Claude Code's environment, so the page can tell when it is gone.
 *
 * A chat's *process* is not stable — Claude Code re-execs it, and CLAUDE_PID changes underneath a
 * chat that is still very much alive — so this is re-stamped on every report rather than recorded
 * once at the start, and a dead process only means the chat is gone once the run has also gone
 * quiet (see readBoard).
 */
function reporter(env = process.env) {
  const out = {}
  if (env.CLAUDE_CODE_SESSION_ID) out.chat = env.CLAUDE_CODE_SESSION_ID
  if (env.CLAUDE_PID && /^\d+$/.test(env.CLAUDE_PID)) out.pid = Number(env.CLAUDE_PID)
  return out
}

/**
 * Create or update a run. Fields: title, note, stallMin, cwd, chat, pid, eta, kind, project,
 * where, wave, status (done/failed/cancelled finishes it; running reopens it). A finished run
 * leaves a history entry behind, which is what sharpens the next run of its kind's ETA.
 */
export function putBoard(board, fields = {}, { dir = DIR, now = Date.now(), env = process.env } = {}) {
  const id = slug(board)
  const d = boardDir(dir, id)
  mkdirSync(join(d, 'lanes'), { recursive: true })
  let finished = false
  const b = update(join(d, 'board.json'), (prev) => {
    const cwd = fields.cwd ?? process.cwd()
    const b = prev ?? {
      id,
      title: fields.title || board,
      createdAt: now,
      stallMin: DEFAULT_STALL_MIN,
      ...reporter(env),
      cwd,
      kind: kindOf(fields.kind ?? board),
      project: projectOf(cwd),
      where: here(),
    }
    // the reporting chat, as it is now; starting also re-homes a run whose name a crashed chat used
    Object.assign(b, reporter(env))
    if (fields.status === 'running' && prev) b.cwd = cwd
    Object.assign(b, pick(fields, ['title', 'note', 'cwd', 'chat', 'pid', 'project', 'where']))
    if (fields.kind !== undefined) b.kind = kindOf(fields.kind)
    // "Run again": a registered command (commands.mjs) and its plain-token arguments, e.g. "game-playtest-squad --build c99bf30"
    if (fields.rerun !== undefined) {
      const parts = String(fields.rerun).trim().split(/\s+/).filter(Boolean)
      if (parts.length) b.rerun = { command: parts[0], args: parts.slice(1) }
      else delete b.rerun
    }
    if (fields.wave !== undefined) b.wave = Number(fields.wave)
    if (fields.stallMin !== undefined) {
      const m = Number(fields.stallMin)
      if (!(m > 0)) throw new Error('stall limit must be a positive number of minutes')
      b.stallMin = m
    }
    if (fields.eta !== undefined) b.etaAt = parseEta(fields.eta, now)
    if (fields.status !== undefined) {
      if (fields.status === 'running') {
        delete b.status
        delete b.endedAt
      } else if (ENDED.has(fields.status)) {
        b.status = fields.status
        b.endedAt = now
        finished = true
      } else throw new Error('a run status is running, done, failed or cancelled')
    }
    b.updatedAt = now
    return b
  })
  if (finished)
    try {
      recordHistory(id, { dir })
    } catch {}
  return b
}

/** Create or update a lane: name, status, pct, done+total, eta, note, stallMin, order, where */
export function putLane(board, lane, fields = {}, { dir = DIR, now = Date.now(), env = process.env } = {}) {
  checkStatus(fields.status)
  const id = slug(lane)
  const d = boardDir(dir, board)
  if (!existsSync(join(d, 'board.json'))) putBoard(board, {}, { dir, now, env })
  else update(join(d, 'board.json'), (b) => ({ ...b, ...reporter(env), updatedAt: now }))
  return update(join(d, 'lanes', `${id}.json`), (prev) => {
    const l = prev ?? { id, name: fields.name || lane, status: 'queued', pct: 0, createdAt: now, order: now, samples: [], jobs: {} }
    Object.assign(l, pick(fields, ['name', 'note', 'order', 'where']))
    if (fields.stallMin !== undefined) l.stallMin = Number(fields.stallMin)
    if (fields.total !== undefined) l.total = Number(fields.total)
    if (fields.done !== undefined) l.done = Number(fields.done)
    if (fields.pct !== undefined) {
      l.pct = clampPct(fields.pct)
      l.ownPct = true
    } else if (fields.done !== undefined && l.total > 0) {
      l.pct = clampPct((100 * l.done) / l.total)
      l.ownPct = true
    }
    if (fields.status !== undefined) {
      if (fields.status === 'running' && !l.startedAt) l.startedAt = now
      if (SETTLED.has(fields.status) && !SETTLED.has(l.status)) l.endedAt = now
      if (!SETTLED.has(fields.status)) delete l.endedAt
      if (fields.status === 'done') l.pct = 100
      l.status = fields.status
      // a status the author set is theirs: jobs no longer reopen or close the lane by themselves
      delete l.autoDone
      if (l.startedAt && l.endedAt) l.ms = l.endedAt - l.startedAt
    } else if ((fields.pct !== undefined || fields.done !== undefined) && l.status === 'queued') {
      l.status = 'running'
      l.startedAt ??= now
    }
    if (fields.eta !== undefined) l.etaAt = parseEta(fields.eta, now)
    const last = l.samples.at(-1)
    if (!last || last[1] !== l.pct) l.samples = [...l.samples, [now, l.pct]].slice(-SAMPLES)
    l.updatedAt = now
    return l
  })
}

/** Create or update one job inside a lane: name, status, pct, note. A job update counts as lane activity, and a job that settles keeps how long it took. */
export function putJob(board, lane, job, fields = {}, opts = {}) {
  checkStatus(fields.status)
  const now = opts.now ?? Date.now()
  const id = slug(job)
  putLane(board, lane, {}, opts)
  const f = join(boardDir(opts.dir ?? DIR, board), 'lanes', `${slug(lane)}.json`)
  return update(f, (l) => {
    const j = l.jobs[id] ?? { id, name: fields.name || job, status: 'queued', createdAt: now }
    const was = j.status
    Object.assign(j, pick(fields, ['name', 'note', 'status']))
    if (fields.pct !== undefined) j.pct = clampPct(fields.pct)
    if (fields.status === 'done') j.pct = 100
    if (fields.pct !== undefined && j.status === 'queued') j.status = 'running'
    if (j.status === 'running' && !j.startedAt) j.startedAt = now
    if (SETTLED.has(j.status) && !SETTLED.has(was)) {
      j.endedAt = now
      j.ms = now - (j.startedAt ?? j.createdAt)
    }
    j.updatedAt = now
    l.jobs = { ...l.jobs, [id]: j }
    // a job that has started or already settled puts its lane under way; batches often report
    // items only once they are done, and the lane must not sit at "queued" while it fills up
    if (l.status === 'queued' && j.status !== 'queued') {
      l.status = 'running'
      l.startedAt ??= now
    }
    // a lane that tracks its jobs, and states no progress of its own, moves as they settle
    const all = Object.values(l.jobs)
    if (!l.ownPct && all.length) {
      l.done = all.filter((x) => SETTLED.has(x.status)).length
      l.total = all.length
      l.pct = clampPct((100 * all.reduce((t, x) => t + (SETTLED.has(x.status) ? 100 : (x.pct ?? 0)), 0)) / (100 * all.length))
      const last = l.samples.at(-1)
      if (!last || last[1] !== l.pct) l.samples = [...l.samples, [now, l.pct]].slice(-SAMPLES)
      // ...and finishes when they have: every job settled, none failed. Left "running" at 100% it
      // would be flagged stalled after its quiet limit. A job added later reopens it.
      const settled = l.done === l.total
      if (settled && l.status === 'running' && !all.some((x) => x.status === 'failed')) {
        l.status = 'done'
        l.autoDone = true
        l.endedAt ??= now
        if (l.startedAt) l.ms = l.endedAt - l.startedAt
      } else if (!settled && l.status === 'done' && l.autoDone) {
        l.status = 'running'
        delete l.autoDone
        delete l.endedAt
        delete l.ms
      }
    }
    l.updatedAt = now
    return l
  })
}


// ─── what a run is about: its project, its kind, and where it runs ──────────────────────────────

/** the project a run belongs to: the name of the git repository above its working directory */
const projectCache = new Map()

export function projectOf(cwd = process.cwd()) {
  if (projectCache.has(cwd)) return projectCache.get(cwd)
  const v = gitProject(cwd)
  projectCache.set(cwd, v)
  return v
}

function gitProject(cwd) {
  try {
    const root = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    // a worktree under .claude/worktrees belongs to the repository it was cut from, not to itself
    const name = root.split('/').filter(Boolean).at(-1)
    const parent = root.includes('/.claude/worktrees/') ? root.split('/.claude/worktrees/')[0].split('/').filter(Boolean).at(-1) : null
    return parent ?? name ?? null
  } catch {
    return null
  }
}

/**
 * The kind of run, which is how history finds comparable past runs: the name with any trailing
 * date, counter or id taken off, so `site-rebuild-0918` and `site-rebuild-0921` are one kind.
 */
export function kindOf(name) {
  return (
    slug(name)
      .replace(/[-_.](\d{2,8}|v?\d+|[0-9a-f]{6,})$/i, '')
      .replace(/[-_.]+$/, '') || slug(name)
  )
}

/** where the run is doing its work; anything but this Mac has to say so */
const here = () => hostname().replace(/\.local$/, '')

// ─── artefacts: what the run produced ───────────────────────────────────────────────────────────

/** an artefact's medium, from its extension, so the page knows whether to show or link it */
export function mediumOf(path) {
  const ext = String(path).toLowerCase().split('.').at(-1)
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(ext)) return 'image'
  if (['mp4', 'mov', 'webm'].includes(ext)) return 'video'
  if (['html', 'htm', 'pdf', 'svg'].includes(ext)) return 'page'
  return 'log'
}

/**
 * An artefact has to come from the thing being built. A capture of Laika Orbit itself is not
 * evidence about anything a run made, and chats have posted one by mistake before, so an artefact
 * whose source is Orbit's own address is kept but marked, and the page says so rather than
 * letting it pass as the work.
 */
export function suspectSource(source) {
  const v = String(source ?? '').toLowerCase()
  return /localhost:(5200|5300)|127\.0\.0\.1:(5200|5300)|laika ?orbit/.test(v)
}

/**
 * Record an artefact: a file the run produced. `compare` groups artefacts that belong side by
 * side (the same shot from two candidates, before and after, ours and the reference).
 * Fields: label, compare, lane, wave, source, note, medium.
 */
export function putArtifact(run, path, fields = {}, { dir = DIR, now = Date.now(), env = process.env } = {}) {
  if (!path) throw new Error('an artefact needs a path')
  const d = boardDir(dir, run)
  if (!existsSync(join(d, 'board.json'))) putBoard(run, {}, { dir, now, env })
  else update(join(d, 'board.json'), (b) => ({ ...b, ...reporter(env), updatedAt: now }))
  mkdirSync(join(d, 'artifacts'), { recursive: true })
  const full = isAbsolute(path) ? path : resolve(process.cwd(), path)
  const id = fields.id ? slug(fields.id) : slug(`${Date.now().toString(36)}-${full.split('/').at(-1)}`)
  return update(join(d, 'artifacts', `${id}.json`), (prev) => {
    const a = prev ?? { id, addedAt: now }
    Object.assign(a, pick(fields, ['label', 'compare', 'lane', 'wave', 'source', 'note']))
    a.path = full
    a.medium = fields.medium ?? mediumOf(full)
    a.missing = !existsSync(full)
    a.suspect = suspectSource(fields.source)
    a.label ??= full.split('/').at(-1)
    if (a.compare) a.compare = slug(a.compare)
    if (a.wave !== undefined) a.wave = Number(a.wave)
    a.updatedAt = now
    return a
  })
}

// ─── verdicts: the gauntlet's layer on the same run ─────────────────────────────────────────────

/**
 * Record one blind comparison. The judging itself stays in the gauntlet skill; this only keeps
 * the result, including which slot our candidate sat in, because a verdict trail is evidence
 * only if the work moved slots (see the gauntlet skill on silent parity failures).
 *
 * Fields: piece, wave, candidate, reference, winner (candidate | reference | tie), slot (a | b),
 * confirmed (won again with the slots flipped), why, critic, gap.
 */
export function putVerdict(run, fields = {}, { dir = DIR, now = Date.now(), env = process.env } = {}) {
  const winner = fields.winner ?? 'tie'
  if (!['candidate', 'reference', 'tie'].includes(winner)) throw new Error('winner is candidate, reference or tie')
  if (fields.slot !== undefined && !['a', 'b'].includes(String(fields.slot).toLowerCase())) throw new Error('slot is a or b')
  const d = boardDir(dir, run)
  if (!existsSync(join(d, 'board.json'))) putBoard(run, {}, { dir, now, env })
  else update(join(d, 'board.json'), (b) => ({ ...b, ...reporter(env), updatedAt: now }))
  mkdirSync(join(d, 'verdicts'), { recursive: true })
  const id = fields.id ? slug(fields.id) : slug(`${Date.now().toString(36)}-${fields.piece ?? 'verdict'}`)
  return update(join(d, 'verdicts', `${id}.json`), (prev) => {
    const v = prev ?? { id, at: now }
    Object.assign(v, pick(fields, ['piece', 'candidate', 'reference', 'why', 'critic', 'gap']))
    v.winner = winner
    if (fields.wave !== undefined) v.wave = Number(fields.wave)
    if (fields.slot !== undefined) v.slot = String(fields.slot).toLowerCase()
    if (fields.confirmed !== undefined) v.confirmed = Boolean(fields.confirmed)
    v.updatedAt = now
    return v
  })
}

// ─── history: how long runs of this kind actually take ──────────────────────────────────────────

/** what a finished run leaves behind for the next one of its kind */
export function recordHistory(run, { dir = DIR } = {}) {
  const r = readBoard(run, { dir })
  if (!r?.kind || !r.endedAt) return null
  const lanes = {}
  for (const l of r.lanes) if (l.startedAt && l.endedAt) lanes[l.id] = l.endedAt - l.startedAt
  const entry = {
    run: r.id,
    at: r.endedAt,
    status: r.status,
    ms: r.endedAt - r.createdAt,
    lanes,
    jobs: r.lanes.reduce((t, l) => t + l.jobs.length, 0),
  }
  mkdirSync(join(dir, HISTORY), { recursive: true })
  appendFileSync(join(dir, HISTORY, `${r.kind}.jsonl`), `${JSON.stringify(entry)}\n`)
  return entry
}

/** past runs of a kind, newest last, capped so one busy kind cannot slow a page load */
export function history(kind, { dir = DIR, limit = 40 } = {}) {
  try {
    return readFileSync(join(dir, HISTORY, `${slug(kind)}.jsonl`), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter((e) => e && e.ms > 0)
      .slice(-limit)
  } catch {
    return []
  }
}

const median = (xs) => {
  if (!xs.length) return null
  const v = [...xs].sort((a, b) => a - b)
  const i = v.length >> 1
  return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2
}

/**
 * An ETA from how long runs of this kind took before — the median of past runs that finished
 * cleanly, from this run's start. Only for kinds with a real track record; two runs is enough to
 * have a middle, one is an anecdote.
 */
export function historyEta(kind, startedAt, { dir = DIR, min = 2 } = {}) {
  const past = history(kind, { dir }).filter((e) => e.status === 'done')
  if (past.length < min) return null
  const m = median(past.map((e) => e.ms))
  return m ? { at: startedAt + m, from: past.length } : null
}

export function removeBoard(board, { dir = DIR } = {}) {
  const d = boardDir(dir, board)
  if (!existsSync(d)) return false
  rmSync(d, { recursive: true, force: true })
  return true
}

/** remove boards that finished (or went silent) more than `days` ago */
export function prune(days = 7, { dir = DIR, now = Date.now() } = {}) {
  const gone = []
  for (const b of listBoards({ dir, now })) {
    const at = b.endedAt ?? b.updatedAt
    if (now - at > days * 86_400_000) {
      removeBoard(b.id, { dir })
      gone.push(b.id)
    }
  }
  return gone
}

/** ETA from the lane's own progress rate: the pace since its oldest sample, projected to 100% */
export function derivedEta(samples, now = Date.now()) {
  if (!samples || samples.length < 2) return null
  const [t0, p0] = samples[0]
  const [t1, p1] = samples.at(-1)
  // under a minute or a point of progress is too little to project from
  if (p1 >= 100 || p1 - p0 < 1 || t1 - t0 < 60_000) return null
  const at = t1 + ((100 - p1) * (t1 - t0)) / (p1 - p0)
  return at > now - 60_000 ? at : null
}

export function alive(pid) {
  if (!pid) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** every .json in one of a run's folders, oldest first, missing folder included */
function readAll(d, sub) {
  let files = []
  try {
    files = readdirSync(join(d, sub)).filter((f) => f.endsWith('.json'))
  } catch {}
  return files.map((f) => readJson(join(d, sub, f))).filter(Boolean)
}

/** one run with everything the page shows worked out: stall state, ETAs, progress, artefacts, verdicts */
export function readBoard(board, { dir = DIR, now = Date.now(), isAlive = alive } = {}) {
  const d = boardDir(dir, board)
  const b = readJson(join(d, 'board.json'))
  if (!b) return null
  const stallMin = b.stallMin ?? DEFAULT_STALL_MIN
  let files = []
  try {
    files = readdirSync(join(d, 'lanes')).filter((f) => f.endsWith('.json'))
  } catch {}
  const ended = ENDED.has(b.status)
  const lanes = files
    .map((f) => readJson(join(d, 'lanes', f)))
    .filter(Boolean)
    .sort((x, y) => (x.order ?? 0) - (y.order ?? 0))
    .map((l) => {
      const limit = l.stallMin ?? stallMin
      const quietMs = now - l.updatedAt
      const stalled = !ended && l.status === 'running' && quietMs > limit * 60_000
      const derived = l.etaAt ? null : derivedEta(l.samples, now)
      const etaAt = SETTLED.has(l.status) ? null : (l.etaAt ?? derived)
      const jobs = Object.values(l.jobs ?? {}).sort((x, y) => x.createdAt - y.createdAt)
      const { samples, ...rest } = l
      return {
        ...rest,
        jobs,
        stallMin: limit,
        quietMs,
        stalled,
        etaAt,
        etaDerived: Boolean(etaAt && !l.etaAt),
        overdue: Boolean(etaAt && !SETTLED.has(l.status) && now > etaAt + 5 * 60_000),
      }
    })
  const artifacts = readAll(d, 'artifacts')
    .map((a) => ({ ...a, missing: !existsSync(a.path) }))
    .sort((x, y) => x.addedAt - y.addedAt)
  const verdicts = readAll(d, 'verdicts').sort((x, y) => x.at - y.at)
  const waves = [...new Set([...verdicts, ...artifacts].map((x) => x.wave).filter((w) => Number.isFinite(w)))].sort((x, y) => x - y)
  const updatedAt = Math.max(b.updatedAt, ...lanes.map((l) => l.updatedAt))
  const open = lanes.filter((l) => !SETTLED.has(l.status))
  const blocked = !ended && open.some((l) => l.status === 'blocked')
  const quietMs = now - updatedAt
  const chatAlive = ended ? null : isAlive(b.pid)
  const stalledLanes = lanes.filter((l) => l.stalled).length
  // a run goes quiet between lanes too; blocked is waiting on a person, which is not a stall
  const silent = !ended && !blocked && quietMs > stallMin * 60_000
  /*
   * A run ends when its chat ends — but a chat's process id is not a chat. Claude Code re-execs
   * the process and CLAUDE_PID changes underneath a chat that is still working, so a dead pid on
   * its own would declare every live run over. The pid on a run is re-stamped by every report, so
   * a dead one means: nothing has reported since that process died. Only when the run has also
   * gone quiet for a good while — twice its stall limit, and never less than 20 minutes — is the
   * chat taken to be gone. Before that the run is stalled, which is amber and says so.
   */
  const chatGone = !ended && chatAlive === false && quietMs > Math.max(stallMin * 2, 20) * 60_000
  const pct = lanes.length ? lanes.reduce((t, l) => t + (l.status === 'skipped' ? 100 : (l.pct ?? 0)), 0) / lanes.length : 0
  // the run finishes with its last lane; when only some lanes have an ETA that is a lower bound.
  // With no lane able to say, past runs of this kind can: never a guess, only a measured middle.
  const laneEtas = open.map((l) => l.etaAt).filter(Boolean)
  const over = ended || chatGone
  const past = over || b.etaAt || laneEtas.length ? null : historyEta(b.kind, b.createdAt, { dir })
  const etaAt = over ? null : (b.etaAt ?? (laneEtas.length ? Math.max(...laneEtas) : (past?.at ?? null)))
  const etaPartial = Boolean(etaAt && !b.etaAt && !past && laneEtas.length < open.length)
  const etaFrom = etaAt ? (b.etaAt ? 'given' : past ? 'history' : 'lanes') : null
  let state = 'running'
  if (ended) state = b.status
  else if (chatGone) state = 'orphaned'
  else if (stalledLanes || silent) state = 'stalled'
  else if (blocked) state = 'blocked'
  else if (open.length === 0 && lanes.length) state = 'idle'
  return {
    ...b,
    // runs reported before a run knew its project still have a working directory to place them
    project: b.project ?? (b.cwd ? projectOf(b.cwd) : null),
    endedAt: b.endedAt ?? (chatGone ? updatedAt : undefined),
    stallMin,
    lanes,
    artifacts,
    verdicts,
    waves,
    updatedAt,
    quietMs,
    pct: b.status === 'done' ? 100 : pct,
    etaAt,
    etaDerived: Boolean(etaAt && !b.etaAt && (past || open.some((l) => l.etaDerived))),
    etaPartial,
    etaFrom,
    etaRuns: past?.from ?? null,
    stuckLanes: lanes.filter((l) => l.stalled).map((l) => l.name),
    chatAlive,
    stalledLanes,
    silent,
    state,
  }
}

export function listBoards({ dir = DIR, now = Date.now(), isAlive = alive } = {}) {
  let ids = []
  try {
    ids = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {}
  return ids
    .map((id) => readBoard(id, { dir, now, isAlive }))
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

// ─── CLI ────────────────────────────────────────────────────────────────────────────────────

const USAGE = `runs — report a run to Laika Orbit's runs page (/runs)

  runs.mjs start    <run> --title "..." [--lanes build,critic] [--kind site-rebuild] [--eta 40m] [--rerun "<command> args"]
                          [--stall 10] [--where box1] [--note "..."]
  runs.mjs lane     <run> <lane> [--name] [--status S] [--pct N | --done N --total N] [--eta 15m]
                          [--note] [--where box1]
  runs.mjs job      <run> <lane> <job> [--name] [--status S] [--pct N] [--note]
  runs.mjs artifact <run> <path> [--compare hud-shot] [--label "..."] [--lane] [--wave 3]
                          [--source "what made it"] [--note]
  runs.mjs verdict  <run> --winner candidate|reference|tie [--piece hud] [--wave 3] [--slot a|b]
                          [--confirmed] [--why "..."] [--candidate path] [--reference path] [--critic]
  runs.mjs beat     <run> [--note "..."]        still alive, nothing new to report
  runs.mjs finish   <run> [--status done|failed|cancelled] [--note "..."]
  runs.mjs show     [<run>]                     what the page shows, as JSON
  runs.mjs history  [<kind>]                    how long past runs of a kind took
  runs.mjs url                                  the page's address, if the app is up
  runs.mjs rm       <run>
  runs.mjs prune    [--days 7]

  status: ${STATUSES.join(' | ')}     blocked = waiting on a person (never flagged as stalled)
  --compare puts artefacts side by side on the page; artefacts must come from the thing being
  built, so --source is recorded and a capture of Orbit itself is marked, not counted.
  store:  ${DIR}  (LAIKA_PROGRESS_DIR overrides)`

function parseArgs(argv) {
  const pos = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s)
      const next = argv[i + 1]
      flags[k] = inline !== undefined ? inline : next !== undefined && !next.startsWith('--') ? (i++, next) : true
    } else pos.push(a)
  }
  return { pos, flags }
}

const num = (v) => (v === undefined ? undefined : Number(v))

/** the page on whichever app is up: stable :5300 first, then dev :5200 (LAIKA_RUNS_URL overrides) */
export async function pageUrl() {
  if (process.env.LAIKA_RUNS_URL || process.env.LAIKA_PROGRESS_URL) return process.env.LAIKA_RUNS_URL || process.env.LAIKA_PROGRESS_URL
  for (const port of [5300, 5200]) {
    try {
      const r = await fetch(`http://localhost:${port}/api/runs`, { signal: AbortSignal.timeout(800) })
      // the app answers unknown paths with its page, so only the runs API's own reply counts
      if (r.ok && Array.isArray((await r.json().catch(() => null))?.runs)) return `http://localhost:${port}/runs`
    } catch {}
  }
  return null
}

async function main(argv) {
  const { pos, flags } = parseArgs(argv)
  const [cmd, board, lane, job] = pos
  const need = (n, what) => {
    if (pos.length < n) throw new Error(`${cmd} needs ${what}\n\n${USAGE}`)
  }
  const common = { note: flags.note, eta: flags.eta, name: flags.name, status: flags.status }
  let out
  switch (cmd) {
    case 'start': {
      need(2, '<run>')
      out = putBoard(board, {
        title: flags.title,
        note: flags.note,
        eta: flags.eta,
        stallMin: num(flags.stall),
        kind: flags.kind,
        rerun: flags.rerun,
        where: flags.where,
        status: 'running',
      })
      // --lanes lays the tracks out in order now, so the page shows the shape of the run from the start
      const named = String(flags.lanes === true ? '' : (flags.lanes ?? ''))
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
      named.forEach((name, i) => putLane(board, name, { name, order: i, where: flags.where }))
      break
    }
    case 'lane':
      need(3, '<run> <lane>')
      out = putLane(board, lane, {
        ...common,
        pct: num(flags.pct),
        done: num(flags.done),
        total: num(flags.total),
        stallMin: num(flags.stall),
        where: flags.where,
      })
      break
    case 'job':
      need(4, '<run> <lane> <job>')
      out = putJob(board, lane, job, { name: flags.name, status: flags.status, note: flags.note, pct: num(flags.pct) })
      break
    case 'artifact': {
      need(3, '<run> <path>')
      const a = putArtifact(board, lane, {
        label: flags.label,
        compare: flags.compare === true ? undefined : flags.compare,
        lane: flags.lane,
        wave: num(flags.wave),
        source: flags.source,
        note: flags.note,
      })
      console.log(`ok ${slug(board)} artefact ${a.label}${a.compare ? ` (compare ${a.compare})` : ''}${a.suspect ? ' — marked: this looks like a capture of Orbit itself, not of the work' : ''}${a.missing ? ' — no file at that path yet' : ''}`)
      return
    }
    case 'verdict': {
      need(2, '<run>')
      const v = putVerdict(board, {
        piece: flags.piece,
        wave: num(flags.wave),
        winner: flags.winner,
        slot: flags.slot,
        confirmed: flags.confirmed === true || flags.confirmed === 'true',
        why: flags.why,
        critic: flags.critic,
        gap: flags.gap,
        candidate: flags.candidate,
        reference: flags.reference,
      })
      console.log(`ok ${slug(board)} verdict ${v.piece ?? ''} ${v.winner}${v.slot ? ` (ours in slot ${v.slot})` : ''}${v.confirmed ? ' confirmed flipped' : ''}`)
      return
    }
    case 'history': {
      const past = board ? history(board) : null
      if (!past) {
        const kinds = {}
        for (const r of listBoards()) if (r.kind) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1
        console.log(Object.keys(kinds).length ? `kinds: ${Object.keys(kinds).join(', ')}` : 'no runs yet')
        return
      }
      if (!past.length) {
        console.log(`no finished runs of kind ${slug(board)} yet`)
        return
      }
      for (const e of past) console.log(`${new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')}  ${String(Math.round(e.ms / 60000)).padStart(4)}m  ${e.status}  ${e.run}`)
      const eta = historyEta(board, 0)
      console.log(eta ? `median ${Math.round(eta.at / 60000)}m over ${eta.from} clean runs` : 'not enough clean runs for a median yet')
      return
    }
    case 'beat':
      need(2, '<run>')
      out = putBoard(board, { note: flags.note })
      break
    case 'finish':
      need(2, '<run>')
      out = putBoard(board, { status: flags.status || 'done', note: flags.note })
      break
    case 'show':
      out = board ? readBoard(board) : listBoards()
      console.log(JSON.stringify(out, null, 2))
      return
    case 'url': {
      const u = await pageUrl()
      console.log(u ?? 'No Laika Orbit on :5300 or :5200 serves /runs yet; reports are saved and will show once one does.')
      return
    }
    case 'rm':
      need(2, '<run>')
      console.log(removeBoard(board) ? `removed ${slug(board)}` : `no board ${slug(board)}`)
      return
    case 'prune':
      console.log(`pruned: ${prune(num(flags.days) ?? 7).join(', ') || 'nothing'}`)
      return
    default:
      console.log(USAGE)
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 2
      return
  }
  const what = cmd === 'job' ? `${slug(board)}/${slug(lane)}/${slug(job)}` : cmd === 'lane' ? `${slug(board)}/${slug(lane)}` : slug(board)
  const shown = cmd === 'job' ? out.jobs?.[slug(job)] : out
  console.log(`ok ${what}${shown?.status ? ` ${shown.status}` : ''}${shown?.pct !== undefined ? ` ${Math.round(shown.pct)}%` : ''}`)
}

// run as a command (directly, or through a symlink), not when imported by the server
const self = fileURLToPath(import.meta.url)
const invoked = (() => {
  try {
    return realpathSync(process.argv[1] ?? '')
  } catch {
    return process.argv[1]
  }
})()
if (invoked === self) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`runs: ${e.message}`)
    process.exit(1)
  })
}
