/**
 * The per-chat work ledger: where each chat works and how its work stands against local main,
 * taken from git and never from what the model says (docs/MERGE-TRAIN-CONTRACT.md).
 *
 * A chat's cwd is usually its repo's main checkout, while its work happens in a worktree of its
 * own. worktreeOf() finds that worktree from the chat's own tool events: the paths it edits and
 * the folders it cds into, matched against `git worktree list`. The most recent match wins.
 *
 * Nothing here runs on a timer. A ledger is read when a chat changes (the host calls touch), when
 * the cockpit connects, or when a conductor asks (fleet_list), and is trusted for FRESH_MS.
 */
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** a worktree's ledger is trusted this long */
const FRESH_MS = 5_000
/** a repo's list of worktrees is trusted this long */
const WORKTREES_MS = 30_000
/** commits listed per chat */
const MAX_COMMITS = 20
/** the tools whose paths say where a chat works */
const WORK_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|Bash)$/
/** tool inputs that name a file */
const PATH_KEYS = ['file_path', 'notebook_path', 'path']

const git = (run, cwd, args, timeout = 10_000) =>
  new Promise((done) =>
    run('git', ['-C', cwd, ...args], { timeout, maxBuffer: 8e6 }, (err, stdout, stderr) => done({ err, out: String(stdout ?? ''), stderr: String(stderr ?? '') })),
  )

/** the folders a tool call works in, most specific first: file paths, `cd x`, `git -C x` */
export function toolPaths(ev, cwd) {
  const input = ev?.input ?? {}
  const out = []
  const add = (p) => {
    const s = String(p ?? '').trim().replace(/^["']|["']$/g, '')
    if (!s || s.startsWith('-')) return
    const full = s.startsWith('~') ? null : isAbsolute(s) ? s : cwd ? resolve(cwd, s) : null
    if (full) out.push(full)
  }
  for (const k of PATH_KEYS) if (typeof input[k] === 'string') add(input[k])
  if (typeof input.command === 'string') {
    for (const m of input.command.matchAll(/(?:^|[;&|(]\s*|\bthen\s+)cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) add(m[1])
    for (const m of input.command.matchAll(/\bgit\s+-C\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) add(m[1])
  }
  return out
}

/** the worktree a path is in: the longest worktree path it sits under, or null */
export function worktreeFor(path, worktrees) {
  let best = null
  for (const w of worktrees) if ((path === w.path || path.startsWith(`${w.path}/`)) && (!best || w.path.length > best.path.length)) best = w
  return best
}

/** `git worktree list --porcelain` → [{ path, head, branch }] (branch without refs/heads/, null when detached) */
export function parseWorktrees(text) {
  const rows = []
  let cur = null
  for (const line of String(text).split('\n')) {
    if (line.startsWith('worktree ')) rows.push((cur = { path: line.slice(9), head: null, branch: null }))
    else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5)
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
  }
  return rows
}

/** `git status --porcelain=v1 -z` → the paths with uncommitted changes (the new name of a rename) */
export function parseStatusZ(text) {
  const parts = String(text).split('\0')
  const files = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p.length < 4) continue
    files.push({ code: p.slice(0, 2), path: p.slice(3) })
    if (p[0] === 'R' || p[0] === 'C') i++ // the old name follows
  }
  return files
}

/**
 * The state of a chat's work, from its ledger's git facts and the train's view of its slice.
 * `train` is the train's record for this worktree ({ status } or null).
 */
export function ledgerState(l, train = null) {
  if (!l) return 'none'
  if (train?.status === 'checking' || train?.status === 'merging') return 'checking'
  if (train?.status === 'conflict' && train.sha === l.head) return 'conflict'
  if (train?.status === 'failed' && train.sha === l.head) return 'failed'
  const onMain = l.worktree === l.root || l.branch === l.base
  if (!l.ahead) return l.dirty.count ? 'not-ready' : onMain ? 'none' : 'merged'
  if (l.ready && !l.dirty.count) return 'ready'
  return 'not-ready'
}

/**
 * Reads ledgers for chats. `run` is execFile (a stand-in in tests); `onChange(x)` is told when a
 * chat's ledger changed after a background refresh; `trainOf(worktree)` gives the train's record
 * for a worktree; `marks` is the ready-mark store ({ get(worktree) → { sha, at } | null }).
 */
export function createLedger({ sessions, run = execFile, onChange = () => {}, onOverlap = () => {}, trainOf = () => null, marks = null, now = Date.now } = {}) {
  const repos = new Map() // cwd → Promise<{ root, common } | null>
  const trees = new Map() // root → { at, list, pending }
  const books = new Map() // worktree → { at, value, pending }
  const found = new Map() // chat id → { seq, path }

  /** the main checkout of the repo a folder is in, or null when it is not in one */
  function repoOf(cwd) {
    if (!cwd) return Promise.resolve(null)
    if (!repos.has(cwd))
      repos.set(
        cwd,
        git(run, cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel']).then(({ err, out }) => {
          if (err) {
            repos.delete(cwd)
            return null
          }
          const [common, top] = out.trim().split('\n')
          // a normal repo keeps its objects in <root>/.git; a bare common dir has no main checkout
          return { root: common.endsWith('/.git') ? dirname(common) : top, top }
        }),
      )
    return repos.get(cwd)
  }

  async function worktreesOf(root) {
    let t = trees.get(root)
    if (t && now() - t.at < WORKTREES_MS) return t.list
    if (t?.pending) return t.pending
    t = { at: 0, list: t?.list ?? [], pending: null }
    trees.set(root, t)
    t.pending = git(run, root, ['worktree', 'list', '--porcelain']).then(({ err, out }) => {
      t.pending = null
      t.at = now()
      if (!err) t.list = parseWorktrees(out).filter((w) => !w.path.includes('/.laika/train/'))
      return t.list
    })
    return t.pending
  }

  /** the worktree a chat works in: its pin, the latest one its tool calls touched, or its cwd's */
  async function worktreeOf(x) {
    const repo = await repoOf(x.cwd)
    if (!repo) return null
    if (x.workPin) return { root: repo.root, path: x.workPin }
    const list = await worktreesOf(repo.root)
    const memo = found.get(x.id)
    if (memo?.seq === x.seq && list.some((w) => w.path === memo.path)) return { root: repo.root, path: memo.path }
    let path = null
    for (let i = x.events.length - 1; i >= 0 && !path; i--) {
      const e = x.events[i]
      // where it writes and where it cds to, not what it reads: reading main's copy does not move it
      if (e.t !== 'tool' || e.sub || !WORK_TOOLS.test(e.name ?? '')) continue
      for (const p of toolPaths(e, x.cwd)) {
        const w = worktreeFor(p, list)
        if (w) {
          path = w.path
          break
        }
      }
    }
    path ??= worktreeFor(repo.top, list)?.path ?? repo.top
    found.set(x.id, { seq: x.seq, path })
    return { root: repo.root, path }
  }

  /** the files this chat changed itself: every path its own Edit/Write/NotebookEdit calls named */
  function ownFiles(x) {
    const out = new Set()
    for (const e of x.events) if (e.t === 'tool' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(e.name ?? '')) for (const p of toolPaths(e, x.cwd)) out.add(p)
    return out
  }

  /** the base branch of a repo: main, else master */
  const bases = new Map()
  async function baseOf(root) {
    if (!bases.has(root)) {
      const { err } = await git(run, root, ['rev-parse', '--verify', '--quiet', 'refs/heads/main'])
      bases.set(root, err ? 'master' : 'main')
    }
    return bases.get(root)
  }

  /** read one worktree's ledger from git: five light calls */
  async function read(worktree, root) {
    const base = await baseOf(root)
    const [st, lr, log, tip, changed] = await Promise.all([
      git(run, worktree, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=normal']),
      git(run, worktree, ['rev-list', '--left-right', '--count', `${base}...HEAD`]),
      git(run, worktree, ['log', `-${MAX_COMMITS}`, '--format=%H%x1f%s%x1f%ct%x1f%(trailers:key=Ready,valueonly,separator=%x2C)%x1e', `${base}..HEAD`]),
      git(run, worktree, ['log', '-1', '--format=%H%x1f%ct']),
      git(run, worktree, ['diff', '--name-only', '-z', `${base}...HEAD`]),
    ])
    if (st.err) return null
    const [head, ...rest] = st.out.split('\0')
    const branchLine = head.startsWith('## ') ? head.slice(3) : ''
    const branch = /^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.|$| \[)/.exec(branchLine)?.[1] ?? null
    const files = parseStatusZ(rest.join('\0'))
    const [behind, ahead] = lr.err ? [null, null] : lr.out.trim().split(/\s+/).map(Number)
    const commits = log.err
      ? []
      : log.out
          .split('\x1e')
          .map((r) => r.trim())
          .filter(Boolean)
          .map((r) => {
            const [sha, title, at, ready] = r.split('\x1f')
            return { sha, title, at: Number(at) * 1000, ready: /^\s*yes\b/i.test(ready ?? '') }
          })
    const [sha, at] = tip.out.trim().split('\x1f')
    // the age of the oldest uncommitted change: the oldest mtime among the changed files
    let oldestAt = null
    await Promise.all(
      files.slice(0, 200).map(async (f) => {
        const s = await stat(join(worktree, f.path)).catch(() => null)
        if (s && (oldestAt === null || s.mtimeMs < oldestAt)) oldestAt = Math.round(s.mtimeMs)
      }),
    )
    const mark = marks?.get(worktree) ?? null
    const ready = commits[0]?.ready
      ? { sha: commits[0].sha, at: commits[0].at, via: 'trailer' }
      : mark && mark.sha === sha
        ? { sha, at: mark.at, via: 'mark' }
        : null
    return {
      root,
      worktree,
      branch: branch === 'HEAD (no branch)' ? null : branch,
      base,
      head: sha || null,
      behind,
      ahead,
      commits: commits.map(({ ready: _r, ...c }) => c),
      dirty: { count: files.length, oldestAt, files: files.slice(0, 50).map((f) => f.path) },
      changed: changed.err ? [] : changed.out.split('\0').filter(Boolean),
      lastCommitAt: at ? Number(at) * 1000 : null,
      ready,
    }
  }

  /** the files a ledger's work touches: committed and not in main yet, or not committed */
  const touched = (l) => new Set([...(l?.changed ?? []), ...(l?.dirty.files ?? [])])

  /**
   * Other chats in the same repo, in other worktrees, whose unmerged or uncommitted work touches
   * the same files as this one: [{ file, chat, repo }]. From cache alone, no git.
   */
  function overlapsFor(x, l) {
    if (!l) return []
    const mine = touched(l)
    if (!mine.size) return []
    const out = []
    for (const y of sessions.values()) {
      if (y === x || y.state === 'closed' || y.role === 'conductor') continue
      const path = y.workPin ?? found.get(y.id)?.path
      const o = path && path !== l.worktree ? books.get(path)?.value : null
      if (!o || o.root !== l.root) continue
      for (const f of touched(o)) if (mine.has(f)) out.push({ file: f, chat: y.id, repo: l.root.split('/').pop() })
    }
    return out
  }
  /** overlaps already told, so each pair of chats hears about a file once */
  const told = new Set()
  function checkOverlaps(worktree) {
    for (const x of sessions.values()) {
      if ((x.workPin ?? found.get(x.id)?.path) !== worktree || x.state === 'closed' || x.role === 'conductor') continue
      const fresh = new Map()
      for (const o of overlapsFor(x, books.get(worktree)?.value)) {
        const key = [x.id, o.chat].sort().join('|') + `|${o.file}`
        if (told.has(key)) continue
        told.add(key)
        if (!fresh.has(o.chat)) fresh.set(o.chat, [])
        fresh.get(o.chat).push(o.file)
      }
      for (const [other, files] of fresh) {
        const y = sessions.get(other)
        if (y) onOverlap(x, y, files)
      }
    }
  }

  /** a worktree's ledger, from cache when fresh; refreshes in the background and reports changes */
  function book(worktree, root, { fresh = false } = {}) {
    const root0 = root
    let b = books.get(worktree)
    if (!b) books.set(worktree, (b = { at: 0, value: null, pending: null, later: null }))
    // asked again inside the fresh window: read once more at its end, so the last edit of a burst counts
    if (!fresh && !b.pending && !b.later && now() - b.at <= FRESH_MS) {
      b.later = setTimeout(() => {
        b.later = null
        book(worktree, root, { fresh: true })
      }, Math.max(50, FRESH_MS - (now() - b.at)))
      b.later.unref?.()
    }
    if ((fresh || now() - b.at > FRESH_MS) && !b.pending) {
      b.pending = read(worktree, root)
        .catch(() => null)
        .then((v) => {
          b.pending = null
          b.at = now()
          const was = JSON.stringify(b.value)
          b.value = v
          if (JSON.stringify(v) !== was) {
            // its files changed, so every chat in the repo may share one more or one fewer with it
            const root = v?.root ?? root0
            for (const x of sessions.values()) {
              const path = x.workPin ?? found.get(x.id)?.path
              if (path === worktree || (path && books.get(path)?.value?.root === root)) onChange(x)
            }
            checkOverlaps(worktree)
          }
          return v
        })
    }
    return b
  }

  /** the ledger as the page and fleet_list show it */
  function shape(x, l) {
    if (!l) return null
    const { files: _f, ...dirty } = l.dirty
    const train = trainOf(l.worktree)
    return {
      repo: l.root.split('/').pop(),
      root: l.root,
      worktree: l.worktree,
      branch: l.branch,
      base: l.base,
      behind: l.behind,
      ahead: l.ahead,
      commits: l.commits,
      dirty,
      lastCommitAt: l.lastCommitAt,
      state: ledgerState(l, train),
      ready: l.ready,
      overlaps: overlapsFor(x, l),
      train: train ? { status: train.status, at: train.at, output: train.output ?? null } : null,
    }
  }

  /** the raw git facts for a chat (for the train and the overlap check), fresh or cached */
  async function facts(x, { fresh = false } = {}) {
    const w = await worktreeOf(x)
    if (!w) return null
    const b = book(w.path, w.root, { fresh })
    return b.pending ? await b.pending : b.value
  }

  /** something happened in a chat (its state changed, a tool finished): re-read its ledger soon */
  function poke(x) {
    worktreeOf(x)
      .then((w) => w && book(w.path, w.root))
      .catch(() => {})
  }

  return {
    worktreeOf,
    ownFiles,
    facts,
    /** a chat's ledger now, from cache and without git; null until the first read lands */
    peek: (x) => {
      const path = x.workPin ?? found.get(x.id)?.path
      if (!path) {
        poke(x)
        return null
      }
      return shape(x, books.get(path)?.value ?? null)
    },
    poke,
    /** a chat's ledger, read fresh when older than FRESH_MS (fleet_list) */
    get: async (x) => shape(x, await facts(x)),
    /** re-read every worktree whose ledger is cached (main moved, a slice landed) */
    refreshAll: () => {
      for (const [path, b] of books) if (b.value) book(path, b.value.root, { fresh: true })
    },
    /**
     * Whether a chat has uncommitted work of its own, for the close and park guards: true, false,
     * or null when git failed. In its own worktree every uncommitted file is its own. In the
     * shared main checkout only the files it changed itself count, so a runtime file another
     * process rewrote there does not hold every chat in that repo open.
     */
    dirty: async (x) => {
      const w = await worktreeOf(x)
      if (!w) return false
      const l = await facts(x, { fresh: true })
      if (!l) return null
      if (!l.dirty.count) return false
      if (w.path !== w.root) return true
      const mine = ownFiles(x)
      return l.dirty.files.some((f) => mine.has(join(w.path, f))) || l.dirty.count > l.dirty.files.length
    },
  }
}
