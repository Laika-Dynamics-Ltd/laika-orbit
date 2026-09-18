/**
 * The chat library: every Claude Code chat on this machine, not just the last two days, and what
 * you have decided about each one (a name, a colour, pinned, archived).
 *
 *   ~/.laika/chat-library.json   { "<sdk session id>": { title?, pinned?, archived?, colour? } }
 *
 * The decisions live on disk rather than in one browser's localStorage, so a chat you renamed
 * keeps its name in the pop-out window, the macOS app and any other browser.
 *
 * Transcripts are read, never rewritten. Listing stats every transcript and reads only its head
 * and tail for a title, cached by size and mtime, so a folder of thousands stays quick. Searching
 * inside messages streams files line by line under a time and a byte budget. Deleting moves the
 * transcript to the Trash, and only from inside a known transcript folder.
 *
 * Everything here takes its folders as arguments (control-api.mjs passes the real ones), so tests
 * run against temp dirs.
 */
import { createReadStream } from 'node:fs'
import {
  cp,
  mkdir,
  open as fsOpen,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, sep } from 'node:path'

const HOME = homedir()

/** a test points it elsewhere, as LAIKA_CONDUCTOR_NOTES does for the conductor */
export const libraryFile = () => process.env.LAIKA_CHAT_LIBRARY ?? join(HOME, '.laika', 'chat-library.json')
export const trashDir = () => process.env.LAIKA_TRASH_DIR ?? join(HOME, '.Trash')
export const briefsDir = () => process.env.LAIKA_BRIEFS_DIR ?? join(HOME, '.laika', 'briefs')

/** a Claude session id: letters, digits, dashes. Anything else (a slash, a dot) is refused. */
export const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id)
const HEX = /^#[0-9a-f]{6}$/i

// -------------------------------------------------------------------- the store ----
export async function readLibrary(file = libraryFile()) {
  try {
    const x = JSON.parse(await readFile(file, 'utf8'))
    return x && typeof x === 'object' && !Array.isArray(x) ? x : {}
  } catch {
    return {}
  }
}

async function writeLibrary(lib, file = libraryFile()) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  // a crash mid-write must not leave half a file: write beside it, then swap it in
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(lib, null, 1), { mode: 0o600 })
  await rename(tmp, file)
}

/** writes one at a time, so two quick patches cannot each read the old file and lose the other */
let queue = Promise.resolve()
const serial = (fn) => {
  const job = queue.then(fn, fn)
  queue = job.catch(() => {})
  return job
}

/**
 * Change one chat's entry. `title` and `colour` set to null or '' clear them; booleans set to false
 * are dropped. An entry left empty is removed. Returns the entry as stored, or null when gone.
 */
export function patchEntry(id, patch, file = libraryFile()) {
  if (!validId(id)) throw new Error('bad chat id')
  return serial(async () => {
    const lib = await readLibrary(file)
    const next = { ...(lib[id] ?? {}) }
    if ('title' in patch) {
      const t = String(patch.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
      if (t) next.title = t
      else delete next.title
    }
    if ('colour' in patch) {
      if (typeof patch.colour === 'string' && HEX.test(patch.colour)) next.colour = patch.colour.toLowerCase()
      else delete next.colour
    }
    for (const k of ['pinned', 'archived']) {
      if (!(k in patch)) continue
      if (patch[k] === true) next[k] = true
      else delete next[k]
    }
    if (Object.keys(next).length) lib[id] = next
    else delete lib[id]
    await writeLibrary(lib, file)
    return lib[id] ?? null
  })
}

export function removeEntry(id, file = libraryFile()) {
  return serial(async () => {
    const lib = await readLibrary(file)
    if (!(id in lib)) return false
    delete lib[id]
    await writeLibrary(lib, file)
    return true
  })
}

/**
 * Names and colours a browser kept before the library existed. Only fills what the library does
 * not already say, so the first browser to migrate cannot overwrite a later rename.
 */
export function migrateEntries({ names = {}, colours = {} }, file = libraryFile()) {
  return serial(async () => {
    const lib = await readLibrary(file)
    let changed = 0
    for (const [id, t] of Object.entries(names ?? {})) {
      const title = String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
      if (!validId(id) || !title || lib[id]?.title) continue
      lib[id] = { ...(lib[id] ?? {}), title }
      changed++
    }
    for (const [id, c] of Object.entries(colours ?? {})) {
      if (!validId(id) || typeof c !== 'string' || !HEX.test(c) || lib[id]?.colour) continue
      lib[id] = { ...(lib[id] ?? {}), colour: c.toLowerCase() }
      changed++
    }
    if (changed) await writeLibrary(lib, file)
    return { changed, library: lib }
  })
}

// ------------------------------------------------------------------ transcripts ----
const HEAD_BYTES = 96_000
const TAIL_BYTES = 96_000

async function readRange(path, start, bytes) {
  const fh = await fsOpen(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, start)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

const parseLines = (text) =>
  text.split('\n').flatMap((l) => {
    if (!l.trim()) return []
    try {
      return [JSON.parse(l)]
    } catch {
      return []
    }
  })

export const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c?.type === 'text')
    .map((c) => c.text)
    .join(' ')
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** a prompt you typed, not a tool result or a harness wrapper */
const humanText = (r) => {
  if (r?.type !== 'user' || r.isSidechain) return ''
  const c = r.message?.content
  const t = typeof c === 'string' ? c : Array.isArray(c) && c.every((x) => x.type === 'text') ? textOf(c) : ''
  return t.trim() && !/^<(command-|local-command|system-reminder|task-notification)/.test(t.trim()) ? t : ''
}

/** what a transcript says about itself, from its first and last few hundred KB */
export async function readMeta(path) {
  const st = await stat(path)
  const head = await readRange(path, 0, Math.min(st.size, HEAD_BYTES))
  const headRecs = parseLines(st.size > HEAD_BYTES ? head.slice(0, head.lastIndexOf('\n') + 1) : head)
  let tailRecs = []
  if (st.size > HEAD_BYTES) {
    const start = Math.max(HEAD_BYTES, st.size - TAIL_BYTES)
    const tail = await readRange(path, start, st.size - start)
    // the first line of a tail read is usually cut mid-record
    tailRecs = parseLines(tail.slice(tail.indexOf('\n') + 1))
  }
  const all = headRecs.concat(tailRecs)
  const rev = [...all].reverse()
  const aiTitle = rev.find((r) => r.type === 'ai-title' && r.aiTitle)?.aiTitle
  const summary = rev.find((r) => r.type === 'summary' && r.summary)?.summary
  const lastPrompt = rev.find((r) => r.type === 'last-prompt' && r.lastPrompt)?.lastPrompt
  const firstHuman = headRecs.map(humanText).find(Boolean)
  const cwd = rev.find((r) => r.cwd)?.cwd ?? null
  return {
    title: clip(aiTitle ?? summary ?? firstHuman ?? lastPrompt ?? '', 90),
    firstPrompt: clip(firstHuman ?? '', 160),
    cwd,
    branch: rev.find((r) => r.gitBranch)?.gitBranch ?? null,
    started: all.find((r) => r.timestamp)?.timestamp ?? null,
    messages: all.some((r) => r.type === 'user' || r.type === 'assistant'),
  }
}

/** titles by path, kept while a transcript's size and mtime stay the same */
const META = new Map()

/** a few at a time: thousands of opens at once would run into the file limit */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++
        out[k] = await fn(items[k])
      }
    }),
  )
  return out
}

/** every top-level `<project>/<id>.jsonl` under each root, statted */
export async function transcriptFiles(roots) {
  const found = []
  for (const root of roots) {
    let dirs = []
    try {
      dirs = await readdir(root.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      let entries = []
      try {
        entries = await readdir(join(root.dir, d.name))
      } catch {
        continue
      }
      for (const f of entries) {
        if (f.endsWith('.jsonl')) found.push({ path: join(root.dir, d.name, f), dir: d.name, root })
      }
    }
  }
  const statted = await mapLimit(found, 64, async (x) => {
    const st = await stat(x.path).catch(() => null)
    return st?.isFile() && st.size > 0 ? { ...x, size: st.size, mtimeMs: st.mtimeMs } : null
  })
  return statted.filter(Boolean)
}

const projectOf = (cwd, dir) => (cwd ? cwd.replace(`${HOME}/`, '').replace(/^dev\//, '') : dir)

/**
 * Every chat in the roots, one row per session id (a chat carried to another account has a copy
 * in each folder: the newest wins). Titles come from the cache when the file has not changed.
 */
export async function scanChats(roots) {
  const files = await transcriptFiles(roots)
  const seen = new Set()
  const rows = await mapLimit(files, 16, async (f) => {
    seen.add(f.path)
    let hit = META.get(f.path)
    if (!hit || hit.size !== f.size || hit.mtimeMs !== f.mtimeMs) {
      const meta = await readMeta(f.path).catch(() => null)
      if (!meta) return null
      hit = { size: f.size, mtimeMs: f.mtimeMs, meta }
      META.set(f.path, hit)
    }
    const m = hit.meta
    if (!m.messages) return null
    return {
      id: basename(f.path, extname(f.path)),
      account: f.root.account ?? null,
      path: f.path,
      project: projectOf(m.cwd, f.dir),
      cwd: m.cwd,
      branch: m.branch,
      autoTitle: m.title,
      firstPrompt: m.firstPrompt,
      started: m.started ?? new Date(f.mtimeMs).toISOString(),
      updated: new Date(f.mtimeMs).toISOString(),
      size: f.size,
    }
  })
  for (const p of META.keys()) if (!seen.has(p)) META.delete(p)
  const byId = new Map()
  for (const r of rows) {
    if (!r) continue
    const have = byId.get(r.id)
    if (!have || have.updated < r.updated) byId.set(r.id, r)
  }
  return [...byId.values()]
}

/** forget cached titles, all of them or one file's */
export const forgetMeta = (path) => (path ? META.delete(path) : META.clear())

// ---------------------------------------------------------------------- listing ----
const SORTS = {
  updated: (a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0),
  created: (a, b) => (a.started < b.started ? 1 : a.started > b.started ? -1 : 0),
  title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || SORTS.updated(a, b),
}
const MAX_LIMIT = 200

const truthy = (v) => v === '1' || v === 'true' || v === true

/**
 * One page of the library.
 *   rows     from scanChats
 *   library  the store
 *   running  Map of sdk session id -> the host's chat id, for chats open in this app
 *   repoOf   (cwd) -> { repo, repoPath } | undefined, to name a chat after its git repo
 *   params   URLSearchParams or a plain object:
 *     q         text in the title, project, branch or id
 *     project   exact project / repo name
 *     account   account id ('none' for a folder no account claims)
 *     state     'here' (open in this app) | 'other'
 *     pinned    '1': pinned only
 *     archived  '1': archived too · 'only': archived only · otherwise hidden
 *     sort      updated (default) | created | title
 *     limit     1..200 (default 50)
 *     cursor    from the previous page's `next`
 * Pinned chats come first on every sort, so the first page opens with them.
 */
export function listChats({ rows, library = {}, running = new Map(), repoOf = () => undefined, params = {} }) {
  const get = (k) => (params instanceof URLSearchParams ? params.get(k) : params[k]) ?? ''
  const items = rows.map((r) => {
    const e = library[r.id] ?? {}
    const home = r.cwd ? repoOf(r.cwd) : undefined
    return {
      ...r,
      path: undefined,
      repo: home?.repo ?? r.project,
      repoPath: home?.repoPath ?? r.cwd,
      title: e.title || r.autoTitle || r.firstPrompt || 'Untitled',
      named: !!e.title,
      pinned: !!e.pinned,
      archived: !!e.archived,
      colour: e.colour ?? null,
      here: running.get(r.id) ?? null,
    }
  })
  const archived = String(get('archived'))
  const visible = items.filter((x) => (archived === 'only' ? x.archived : truthy(archived) || !x.archived))
  // what the project and account filters can offer, before those filters narrow the list
  const facets = { projects: countBy(visible, (x) => x.repo), accounts: countBy(visible, (x) => x.account ?? 'none') }

  const q = String(get('q')).trim().toLowerCase()
  const project = String(get('project'))
  const account = String(get('account'))
  const state = String(get('state'))
  let list = visible.filter(
    (x) =>
      (!project || x.repo === project || x.project === project) &&
      (!account || (x.account ?? 'none') === account) &&
      (state !== 'here' || x.here) &&
      (state !== 'other' || !x.here) &&
      (!truthy(get('pinned')) || x.pinned) &&
      (!q || [x.title, x.autoTitle, x.repo, x.project, x.branch, x.id].some((s) => s && String(s).toLowerCase().includes(q))),
  )
  const by = SORTS[String(get('sort'))] ?? SORTS.updated
  list = list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || by(a, b))

  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.parseInt(String(get('limit')), 10) || 50))
  const from = Math.max(0, Number.parseInt(String(get('cursor')), 10) || 0)
  const page = list.slice(from, from + limit)
  return {
    items: page,
    total: list.length,
    next: from + limit < list.length ? String(from + limit) : null,
    facets,
  }
}

function countBy(xs, key) {
  const m = new Map()
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1)
  return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)))
}

// ----------------------------------------------------------------------- search ----
/**
 * Search the words of every message (yours and Claude's, not tool output) for `q`.
 * Newest chats first; one hit per chat, with a snippet around the first match.
 *
 * Bounded so a huge folder cannot hang the server: a call stops at `maxHits` chats, after
 * `timeMs`, or once `maxBytes` of transcript have been read (checked a megabyte at a time), and
 * `truncated` says which. `next` is where to carry on (pass it back as `skip`), so every chat can
 * still be searched, a bounded step at a time. The first chat of a call is always read to its
 * end, so a transcript bigger than the budget cannot stall the search.
 */
export async function searchChats({ rows, q, skip = 0, maxHits = 40, timeMs = 5000, maxBytes = 768 * 1024 * 1024, maxLine = 4 * 1024 * 1024 }) {
  const needle = String(q ?? '').trim()
  const files = [...rows].filter((r) => r.path).sort((a, b) => (a.updated < b.updated ? 1 : -1))
  const out = { hits: [], scanned: 0, bytes: 0, of: files.length, truncated: null, next: null }
  if (needle.length < 2) return out
  const re = new RegExp(needle.slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  const deadline = Date.now() + timeMs
  const from = Math.max(0, Math.floor(Number(skip) || 0))
  for (let i = from; i < files.length; i++) {
    const first = i === from
    const stop = out.hits.length >= maxHits ? 'hits' : Date.now() > deadline ? 'time' : out.bytes >= maxBytes ? 'bytes' : null
    if (stop && !first) {
      out.truncated = stop
      out.next = i
      break
    }
    const r = files[i]
    out.scanned++
    const hit = await searchFile(r.path, re, first ? { deadline: Number.POSITIVE_INFINITY, budget: Number.POSITIVE_INFINITY, maxLine } : { deadline, budget: maxBytes - out.bytes, maxLine })
    out.bytes += hit.bytes
    if (hit.match) out.hits.push({ id: r.id, ...hit.match })
    if (hit.stopped) {
      // cut off part way through: the next call reads this chat again from its start
      out.truncated = hit.stopped
      out.next = i
      break
    }
  }
  return out
}

/**
 * Reads a transcript a megabyte at a time and only splits into lines a chunk that holds the words
 * somewhere: most of a transcript is tool output and pasted images, and never needs parsing.
 */
async function searchFile(path, re, { deadline, budget, maxLine }) {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 1024 * 1024 })
  let bytes = 0
  let match = null
  let stopped = null
  let carry = ''
  const look = (line) => {
    if (line.length > maxLine || !re.test(line)) return null
    let r
    try {
      r = JSON.parse(line)
    } catch {
      return null
    }
    if ((r.type !== 'user' && r.type !== 'assistant') || r.isSidechain) return null
    const text = textOf(r.message?.content)
    const m = re.exec(text)
    if (!m) return null
    return { role: r.type, at: r.timestamp ?? null, snippet: snippetOf(text, m.index, m[0].length) }
  }
  try {
    for await (const chunk of stream) {
      bytes += Buffer.byteLength(chunk)
      const end = chunk.lastIndexOf('\n')
      if (end < 0) {
        // one line longer than a chunk: nothing a person wrote is that long, so drop it once too big
        carry = carry.length > maxLine ? ' ' : carry + chunk
      } else {
        const block = carry + chunk.slice(0, end)
        carry = chunk.slice(end + 1)
        if (re.test(block)) {
          for (const line of block.split('\n')) {
            match = look(line)
            if (match) break
          }
        }
      }
      if (match) break
      if (bytes > budget) {
        stopped = 'bytes'
        break
      }
      if (Date.now() > deadline) {
        stopped = 'time'
        break
      }
    }
    if (!match && !stopped && carry) match = look(carry)
  } finally {
    stream.destroy()
  }
  return { match, bytes, stopped }
}

/** the match with some words either side, whitespace folded, and where the match sits in it */
export function snippetOf(text, at, len, around = 70) {
  const from = Math.max(0, at - around)
  const to = Math.min(text.length, at + len + around)
  const before = text.slice(from, at).replace(/\s+/g, ' ')
  const hit = text.slice(at, at + len)
  const after = text.slice(at + len, to).replace(/\s+/g, ' ')
  const lead = from > 0 ? '…' : ''
  return {
    text: `${lead}${before}${hit}${after}${to < text.length ? '…' : ''}`,
    start: lead.length + before.length,
    length: hit.length,
  }
}

// ----------------------------------------------------------------------- delete ----
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)

/** move to the Trash under a name not already there; across volumes, copy then remove */
async function toTrash(path, trash, name = basename(path)) {
  await mkdir(trash, { recursive: true })
  const ext = extname(name)
  let dest = join(trash, name)
  for (let n = 1; await stat(dest).then(() => true, () => false); n++) {
    dest = join(trash, `${basename(name, ext)} ${n}${ext}`)
  }
  try {
    await rename(path, dest)
  } catch (e) {
    if (e?.code !== 'EXDEV') throw e
    await cp(path, dest, { recursive: true })
    await rm(path, { recursive: true, force: true })
  }
  return dest
}

/**
 * Move a chat's transcript (every copy, and its folder of sub-agent logs), its brief and its
 * library entry to the Trash. Refuses:
 *   400  an id that is not a plain session id (no slashes, no dots)
 *   409  a chat open in this app (`running`), or one written to in the last `quietMs`
 *   404  no transcript with that id in the roots
 *   403  a transcript whose real path is outside every root (a symlink out)
 */
export async function deleteChat({ id, roots, running = new Map(), quietMs = 0, trash = trashDir(), briefs = briefsDir(), file = libraryFile() }) {
  if (!validId(id)) return { code: 400, error: 'not a chat id' }
  if (running.has(id)) return { code: 409, error: 'This chat is open in the app. End it first, then delete it.' }
  const realRoots = []
  for (const r of roots) {
    const real = await realpath(r.dir).catch(() => null)
    if (real) realRoots.push(real)
  }
  const found = []
  for (const r of roots) {
    let dirs = []
    try {
      dirs = await readdir(r.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      const p = join(r.dir, d.name, `${id}.jsonl`)
      const st = await stat(p).catch(() => null)
      if (st?.isFile()) found.push({ path: p, mtimeMs: st.mtimeMs })
    }
  }
  if (!found.length) return { code: 404, error: 'no transcript for that chat' }
  const moves = []
  for (const f of found) {
    const real = await realpath(f.path).catch(() => null)
    if (!real || !realRoots.some((root) => inside(real, root) && real !== root)) {
      return { code: 403, error: 'that transcript is outside the Claude folders' }
    }
    if (quietMs && Date.now() - f.mtimeMs < quietMs) {
      return { code: 409, error: 'This chat was written to moments ago, so it may still be running somewhere. Close it there first.' }
    }
    moves.push(real)
    // newer Claude Code keeps a chat's sub-agent logs and big tool results in a folder beside it
    const side = join(dirname(real), id)
    const sideReal = await realpath(side).catch(() => null)
    if (sideReal && realRoots.some((root) => inside(sideReal, root) && sideReal !== root) && (await stat(sideReal)).isDirectory()) {
      moves.push(sideReal)
    }
  }
  const trashed = []
  for (const p of moves) {
    trashed.push(await toTrash(p, trash, p.endsWith('.jsonl') ? basename(p) : `${basename(p)} (chat files)`))
    forgetMeta(p)
  }
  const brief = join(briefs, `${id}.json`)
  if (await stat(brief).then((s) => s.isFile(), () => false)) trashed.push(await toTrash(brief, trash, `${id}.brief.json`))
  await removeEntry(id, file)
  return { code: 200, trashed }
}
