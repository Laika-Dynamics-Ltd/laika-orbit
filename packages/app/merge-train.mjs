/**
 * The merge train (docs/MERGE-TRAIN-CONTRACT.md): host code that takes the slices chats have
 * marked ready, merges them onto an integration branch from local main, runs the repo's light
 * check, and fast-forwards local main when it is green. It never pushes.
 *
 * This file holds the train's state: the ready marks and what the train last did with each slice,
 * kept in ~/.laika/train-<port>.json (LAIKA_TRAIN_STATE points a test elsewhere).
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { putBoard, putLane } from './runs.mjs'

/** what every chat is told about slices, appended to its system prompt */
export const WORK_PROMPT = `
Laika Orbit merges finished work into local main for you with its merge train. Work in your own git worktree and branch.
When a slice is done, mark it ready: add the trailer "Ready: yes" to its last commit (git commit -m "Title" -m "Ready: yes").
Ready means all three: committed (no uncommitted files), typechecked, and the tests affected by the change passing.
The train re-checks it on top of main and fast-forwards local main when green. Never merge into main or push yourself.
Messages that start with "[from the merge train]" are about your slice: a failed check, a conflict with main, or another
chat changing the same files. Fix what they name, commit, and mark it ready again.`.trim()

export const FROM_TRAIN = '[from the merge train] '

/**
 * The train's state on disk: `marks` (worktree → { sha, at, chat }), a slice marked ready without
 * a trailer; `records` (worktree → { sha, status, at, output, chat }), what the train last did.
 */
export function createTrainStore({ file = process.env.LAIKA_TRAIN_STATE ?? join(homedir(), '.laika', `train-${process.env.APP_PORT ?? '5200'}.json`) } = {}) {
  let state = null
  const load = () => {
    if (state) return state
    try {
      const s = JSON.parse(readFileSync(file, 'utf8'))
      state = { marks: s.marks ?? {}, records: s.records ?? {}, order: s.order ?? {} }
    } catch {
      state = { marks: {}, records: {}, order: {} }
    }
    return state
  }
  const save = () => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
  return {
    marks: {
      get: (worktree) => load().marks[worktree] ?? null,
      set(worktree, m) {
        load().marks[worktree] = m
        save()
      },
      clear(worktree) {
        if (!load().marks[worktree]) return
        delete state.marks[worktree]
        save()
      },
    },
    records: {
      get: (worktree) => load().records[worktree] ?? null,
      all: () => ({ ...load().records }),
      set(worktree, r) {
        load().records[worktree] = r
        save()
      },
      clear(worktree) {
        if (!load().records[worktree]) return
        delete state.records[worktree]
        save()
      },
    },
    /** when each worktree's current ready tip was first seen: the train takes slices in this order */
    order: {
      get: (worktree, sha) => {
        const o = load().order[worktree]
        return o?.sha === sha ? o.at : null
      },
      set(worktree, sha, at) {
        load().order[worktree] = { sha, at }
        save()
      },
    },
  }
}

/**
 * Why a chat's slice cannot be marked ready now, or null when it can. `l` is its ledger facts
 * (work-ledger.mjs). Typecheck and tests are the chat's word; the train runs them again.
 */
export function readyRefusal(l) {
  if (!l) return 'Its folder is not in a git repo.'
  if (l.worktree === l.root && (l.branch === l.base || !l.branch)) return `It works in ${l.base} itself: put the slice on a branch in its own worktree first.`
  if (l.dirty.count) return `It has ${l.dirty.count} uncommitted file${l.dirty.count === 1 ? '' : 's'}: ready means committed.`
  if (!l.ahead) return `Nothing to merge: the branch has no commits ahead of ${l.base}.`
  return null
}

// ------------------------------------------------------------------ the train ----

/** slices merged and checked together; a red batch is bisected */
export const BATCH = 4
/** how long a repo's check may run */
const CHECK_MS = 20 * 60_000
/** what a red check or a conflict sends back: the tail of it */
const OUTPUT_MAX = 4000
/** settle this long after a kick before looking, so a burst of events is one look */
const KICK_MS = 2_000
/** when the Mac is busy, look again this much later */
const BUSY_RETRY_MS = 60_000

const sh = (run, file, args, { cwd, env, timeout = 60_000 } = {}) =>
  new Promise((done) =>
    run(file, args, { cwd, env, timeout, maxBuffer: 32e6 }, (err, stdout, stderr) =>
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim(), killed: !!err?.killed }),
    ),
  )
const tail = (s, n = OUTPUT_MAX) => (s.length > n ? `…\n${s.slice(-n)}` : s)

/** the integration worktree for a repo: ~/.laika/train/<name>-<hash of its path> */
export const integrationPath = (root, base = join(homedir(), '.laika', 'train')) =>
  join(base, `${basename(root)}-${createHash('sha1').update(root).digest('hex').slice(0, 8)}`)

/**
 * The repo's light check, run in the integration worktree: { cmd, timeoutMs }. Its
 * .laika/train.json { check, timeoutMin } first; else its warden's inner loop (the one
 * <name>-check.sh at its root, run with --fast: compile and tests; a Unity warden sends Unity to an
 * offload machine when it finds one); else
 * typecheck plus the tests related to the changed files for a package.json repo. cmd null: nothing
 * to run, merging cleanly is the check.
 */
export function checkSpec(dir, { exists = existsSync, read = (f) => readFileSync(f, 'utf8'), list = (d) => readdirSync(d) } = {}) {
  let c = {}
  try {
    c = JSON.parse(read(join(dir, '.laika', 'train.json'))) ?? {}
  } catch {}
  const timeoutMs = Number(c.timeoutMin) > 0 ? Number(c.timeoutMin) * 60_000 : null
  if (typeof c.check === 'string' && c.check.trim()) return { cmd: c.check.trim(), timeoutMs: timeoutMs ?? CHECK_MS }
  if (c.check === null) return { cmd: null, timeoutMs: 0 }
  // a Unity project's first check in a fresh integration worktree imports its whole Library
  let wardens = []
  try {
    wardens = list(dir).filter((f) => /^[\w.-]+-check\.sh$/.test(f))
  } catch {}
  if (wardens.length === 1) return { cmd: `./${wardens[0]} --fast`, timeoutMs: timeoutMs ?? 60 * 60_000 }
  if (exists(join(dir, 'package.json'))) {
    let scripts = {}
    try {
      scripts = JSON.parse(read(join(dir, 'package.json'))).scripts ?? {}
    } catch {}
    const steps = []
    if (exists(join(dir, 'pnpm-lock.yaml'))) steps.push('pnpm install --offline --frozen-lockfile --silent')
    if (scripts.typecheck) steps.push('pnpm -s typecheck')
    if (scripts.test && /vitest/.test(scripts.test)) steps.push('pnpm exec vitest related --run --passWithNoTests $TRAIN_FILES')
    return { cmd: steps.length ? steps.join(' && ') : null, timeoutMs: timeoutMs ?? CHECK_MS }
  }
  return { cmd: null, timeoutMs: 0 }
}

/**
 * The train. `ledger` is work-ledger.mjs's; `store` createTrainStore's; `tell(x, text)` sends a
 * chat a message; `emit(frame)` goes out on the cockpit stream; `onLanded(root, sha)` is told
 * when local main moved; `busy()` says why not to run a check now (the Mac is loaded), or null.
 */
export function createTrain({ sessions, ledger, store, tell = () => {}, emit = () => {}, onLanded = () => {}, busy = () => null, run = execFile, trainDir = join(homedir(), '.laika', 'train'), runs = true, log = (m) => console.log(`merge train: ${m}`) }) {
  let timer = null
  let running = null
  let again = false
  let current = null // { repo, phase, batch }
  // a check the host was killed in the middle of is not running any more
  for (const [w, r] of Object.entries(store.records.all())) if (r.status === 'checking') store.records.clear(w)

  const say = (repo, phase, batch, extra = {}) => {
    current = phase === 'idle' ? null : { repo, phase, batch: batch.map((s) => s.chatId) }
    emit({ at: Date.now(), repo, phase, batch: batch.map((s) => ({ chat: s.chatId, branch: s.branch, sha: s.sha.slice(0, 7) })), ...extra })
  }
  const board = (id, fields) => runs && safe(() => putBoard(id, fields, { env: {} }))
  const lane = (id, l, fields) => runs && safe(() => putLane(id, l, fields, { env: {} }))
  const safe = (fn) => {
    try {
      fn()
    } catch {}
  }

  /** the chat a slice belongs to, if it is open */
  const chatOf = (id) => {
    const x = id ? sessions.get(id) : null
    return x && x.state !== 'closed' ? x : null
  }
  const setRecord = (s, status, output = null) => {
    store.records.set(s.worktree, { sha: s.sha, status, at: Date.now(), chat: s.chatId, output })
    const x = chatOf(s.chatId)
    if (x) ledger.poke(x)
  }

  /** every slice that is ready now and not already handled at its tip, by repo, oldest mark first */
  async function readySlices() {
    const seen = new Map()
    const look = async (x) => {
      const l = await ledger.facts(x).catch(() => null)
      if (!l || seen.has(l.worktree)) return
      seen.set(l.worktree, { l, x })
    }
    for (const x of sessions.values()) if (x.state !== 'closed' && x.role !== 'conductor') await look(x)
    const byRepo = new Map()
    for (const { l, x } of seen.values()) {
      if (!l.ready || l.dirty.count || !l.ahead || l.ready.sha !== l.head) continue
      const r = store.records.get(l.worktree)
      if (r?.sha === l.head && ['failed', 'conflict', 'landed'].includes(r.status)) continue
      let at = store.order.get(l.worktree, l.head)
      if (!at) store.order.set(l.worktree, l.head, (at = l.ready.at || Date.now()))
      const s = { worktree: l.worktree, root: l.root, base: l.base, branch: l.branch ?? l.head.slice(0, 7), sha: l.head, title: l.commits[0]?.title ?? '', files: l.changed, chatId: x.id, at }
      if (!byRepo.has(l.root)) byRepo.set(l.root, [])
      byRepo.get(l.root).push(s)
    }
    for (const list of byRepo.values()) list.sort((a, b) => a.at - b.at)
    return byRepo
  }

  /** make the repo's integration worktree sit at `sha`, clean (ignored files, like node_modules, stay) */
  async function resetTo(root, dir, sha) {
    if (!existsSync(dir)) {
      mkdirSync(dirname(dir), { recursive: true })
      const r = await sh(run, 'git', ['-C', root, 'worktree', 'add', '--detach', dir, sha], { timeout: 120_000 })
      if (r.code) throw new Error(`could not make the integration worktree: ${r.out}`)
    }
    await sh(run, 'git', ['-C', dir, 'merge', '--abort'])
    const r = await sh(run, 'git', ['-C', dir, 'checkout', '-q', '-f', '--detach', sha], { timeout: 120_000 })
    if (r.code) throw new Error(`could not reset the integration worktree: ${r.out}`)
    await sh(run, 'git', ['-C', dir, 'clean', '-fdq'])
  }

  const who = { name: null }
  async function identity(root) {
    if (who.name === null) who.name = (await sh(run, 'git', ['-C', root, 'config', 'user.name'])).out.trim()
    return who.name ? [] : ['-c', 'user.name=Laika Orbit merge train', '-c', 'user.email=merge-train@localhost']
  }

  /**
   * Merge `slices` onto main at `baseSha` and check them. Green lands them; red bisects. A slice
   * that conflicts goes back to its chat with the files and hunks, and the rest carry on.
   */
  async function attempt(root, dir, base, baseSha, slices, runId) {
    await resetTo(root, dir, baseSha)
    const merged = []
    say(basename(root), 'merge', slices)
    for (const s of slices) {
      lane(runId, s.worktree, { name: `${s.branch}: ${s.title}`.slice(0, 90), status: 'running', note: 'merging onto main' })
      const r = await sh(run, 'git', ['-C', dir, ...(await identity(root)), 'merge', '--no-ff', '--no-edit', '-m', `Merge ${s.branch}: ${s.title}`, '-m', `Merged-by: Laika Orbit merge train\nChat: ${s.chatId.slice(0, 8)}`, s.sha], { timeout: 120_000 })
      if (!r.code) {
        merged.push(s)
        continue
      }
      const files = (await sh(run, 'git', ['-C', dir, 'diff', '--name-only', '--diff-filter=U'])).out.split('\n').filter(Boolean)
      const hunks = (await sh(run, 'git', ['-C', dir, 'diff'])).out
      await sh(run, 'git', ['-C', dir, 'merge', '--abort'])
      const others = merged.filter((m) => m.files.some((f) => files.includes(f)))
      const against = others.length ? others.map((o) => `${o.chatId.slice(0, 8)} (${o.branch})`).join(', ') : `${base} (local)`
      const text = `Your slice ${s.branch} at ${s.sha.slice(0, 7)} conflicts with ${against} in ${files.length} file${files.length === 1 ? '' : 's'}: ${files.join(', ') || '(git named none)'}.\nRebase or merge ${base} into your branch, resolve these, commit, and mark it ready again.\n\n${tail(hunks, 6000)}`
      setRecord(s, 'conflict', text)
      lane(runId, s.worktree, { status: 'failed', note: `conflicts: ${files.join(', ').slice(0, 120)}` })
      say(basename(root), 'conflict', [s], { files, against: others.map((o) => o.chatId) })
      const x = chatOf(s.chatId)
      if (x) tell(x, text)
      // the ones after it merge onto what merged so far, as if it had never been in the batch
      await resetTo(root, dir, baseSha)
      for (const m of merged) await sh(run, 'git', ['-C', dir, ...(await identity(root)), 'merge', '--no-ff', '--no-edit', '-m', `Merge ${m.branch}: ${m.title}`, '-m', `Merged-by: Laika Orbit merge train\nChat: ${m.chatId.slice(0, 8)}`, m.sha], { timeout: 120_000 })
    }
    if (!merged.length) return
    const { cmd, timeoutMs } = checkSpec(dir)
    let ok = true
    let output = 'no check configured for this repo: merging cleanly was the check'
    if (cmd) {
      for (const s of merged) setRecord(s, 'checking')
      say(basename(root), 'check', merged, { command: cmd })
      lane(runId, 'check', { name: `Check: ${cmd}`.slice(0, 90), status: 'running', eta: '5m' })
      const files = (await sh(run, 'git', ['-C', dir, 'diff', '--name-only', baseSha, 'HEAD'])).out.split('\n').filter(Boolean)
      const r = await sh(run, '/bin/sh', ['-c', cmd], {
        cwd: dir,
        timeout: timeoutMs,
        env: { ...process.env, BRAIN_ROOT: undefined, LAIKA_BRAIN_ROOT: undefined, TRAIN_BASE: baseSha, TRAIN_FILES: files.filter((f) => existsSync(join(dir, f))).join('\n'), CI: '1' },
      })
      ok = !r.code
      output = r.killed ? `the check ran past ${Math.round(timeoutMs / 60_000)} minutes and was stopped\n${r.out}` : r.out
      lane(runId, 'check', { status: ok ? 'done' : 'failed', note: ok ? `green for ${merged.length} slice(s)` : `red: ${output.split('\n').at(-1)?.slice(0, 120) ?? ''}` })
    }
    if (ok) return land(root, base, baseSha, dir, merged, runId)
    if (merged.length === 1) {
      const [s] = merged
      const text = `The merge train's check failed on your slice ${s.branch} at ${s.sha.slice(0, 7)}, merged onto ${base}:\n$ ${cmd}\n\n${tail(output)}\n\nFix it, commit, and mark it ready again.`
      setRecord(s, 'failed', text)
      lane(runId, s.worktree, { status: 'failed', note: 'its check failed' })
      say(basename(root), 'failed', [s], { output: tail(output, 1500) })
      const x = chatOf(s.chatId)
      if (x) tell(x, text)
      return
    }
    // bisect: the first half on its own, then the rest onto whatever main is by then
    const half = Math.ceil(merged.length / 2)
    say(basename(root), 'bisect', merged)
    await attempt(root, dir, base, baseSha, merged.slice(0, half), runId)
    const now = (await sh(run, 'git', ['-C', root, 'rev-parse', `refs/heads/${base}`])).out.trim()
    await attempt(root, dir, base, now, merged.slice(half), runId)
  }

  /** fast-forward local main to the integration worktree's HEAD; never a push */
  async function land(root, base, baseSha, dir, slices, runId) {
    const sha = (await sh(run, 'git', ['-C', dir, 'rev-parse', 'HEAD'])).out.trim()
    const head = (await sh(run, 'git', ['-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD'])).out.trim()
    const r =
      head === base
        ? await sh(run, 'git', ['-C', root, 'merge', '--ff-only', '--quiet', sha], { timeout: 120_000 })
        : await sh(run, 'git', ['-C', root, 'update-ref', '-m', 'merge train: fast-forward', `refs/heads/${base}`, sha, baseSha])
    if (r.code) {
      // main moved under it, or the main checkout has local changes in the way: next look retries
      log(`could not fast-forward ${base} in ${root}: ${r.out}`)
      lane(runId, 'land', { name: `Fast-forward ${base}`, status: 'blocked', note: tail(r.out, 160) })
      say(basename(root), 'blocked', slices, { output: tail(r.out, 1500) })
      return
    }
    lane(runId, 'land', { name: `Fast-forward ${base}`, status: 'done', note: `${base} is now ${sha.slice(0, 7)}` })
    for (const s of slices) {
      setRecord(s, 'landed')
      store.marks.clear(s.worktree)
      lane(runId, s.worktree, { status: 'done', note: `in ${base} at ${sha.slice(0, 7)}` })
      const x = chatOf(s.chatId)
      if (x) x.emit({ t: 'note', text: `The merge train landed ${s.branch} in local ${base} at ${sha.slice(0, 7)}. Not pushed.` })
    }
    say(basename(root), 'landed', slices, { sha: sha.slice(0, 7) })
    ledger.refreshAll()
    safe(() => onLanded(root, sha))
  }

  async function runOnce() {
    const byRepo = await readySlices()
    for (const [root, list] of byRepo) {
      const why = busy()
      if (why) {
        log(`waiting: ${why}`)
        emit({ at: Date.now(), repo: basename(root), phase: 'waiting', batch: [], detail: why })
        timer ??= setTimeout(fire, BUSY_RETRY_MS)
        return
      }
      const base = list[0].base
      const baseSha = (await sh(run, 'git', ['-C', root, 'rev-parse', `refs/heads/${base}`])).out.trim()
      const batch = list.slice(0, BATCH)
      const runId = `merge-train-${basename(root)}-${Date.now().toString(36)}`
      board(runId, { title: `Merge train: ${batch.length} slice${batch.length === 1 ? '' : 's'} into ${basename(root)} ${base}`, kind: 'merge-train', cwd: root, stallMin: 25, status: 'running' })
      try {
        await attempt(root, integrationPath(root, trainDir), base, baseSha, batch, runId)
        board(runId, { status: 'done', note: 'batch handled' })
      } catch (e) {
        log(String(e?.message ?? e))
        board(runId, { status: 'failed', note: String(e?.message ?? e).slice(0, 200) })
      }
      // more were waiting behind this batch: look again
      if (list.length > BATCH) again = true
    }
    say('', 'idle', [])
  }

  function fire() {
    timer = null
    if (running) {
      again = true
      return
    }
    running = runOnce()
      .catch((e) => log(String(e?.stack ?? e)))
      .finally(() => {
        running = null
        if (again) {
          again = false
          kick()
        }
      })
  }

  /** something changed that could make a slice ready: look soon */
  function kick() {
    if (timer) return
    timer = setTimeout(fire, KICK_MS)
    timer.unref?.()
  }

  return { kick, now: () => current, idle: () => !running && !timer, run: () => (fire(), running) }
}
