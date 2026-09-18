import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  deleteChat,
  forgetMeta,
  listChats,
  migrateEntries,
  patchEntry,
  readLibrary,
  scanChats,
  searchChats,
  snippetOf,
} from '../chat-library.mjs'

const temp = (name) => mkdtempSync(join(tmpdir(), `chat-library-${name}-`))

/** a transcript as Claude Code writes one: a line of JSON per record */
function transcript(root, project, id, o = {}) {
  const dir = join(root, project)
  mkdirSync(dir, { recursive: true })
  const at = o.at ?? '2026-09-01T10:00:00.000Z'
  const recs = [
    { type: 'user', cwd: o.cwd ?? `/work/${project}`, gitBranch: o.branch ?? 'main', timestamp: at, message: { role: 'user', content: o.prompt ?? 'fix the login page' } },
    { type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: o.reply ?? 'Done, the login page works.' }] } },
    ...(o.extra ?? []),
    ...(o.title ? [{ type: 'ai-title', aiTitle: o.title }] : []),
  ]
  const p = join(dir, `${id}.jsonl`)
  writeFileSync(p, `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`)
  if (o.mtime) utimesSync(p, o.mtime / 1000, o.mtime / 1000)
  return p
}

describe('the library store', () => {
  let file
  beforeEach(() => {
    file = join(temp('store'), 'nested', 'chat-library.json')
    process.env.LAIKA_CHAT_LIBRARY = file
  })

  it('patches an entry, clears fields, and drops an empty entry', async () => {
    expect(await readLibrary()).toEqual({})
    expect(await patchEntry('abc-1', { title: '  Ship   it ', pinned: true, colour: '#AABBCC' })).toEqual({ title: 'Ship it', pinned: true, colour: '#aabbcc' })
    expect(await patchEntry('abc-1', { archived: true, colour: 'red' })).toEqual({ title: 'Ship it', pinned: true, archived: true })
    await patchEntry('abc-1', { title: '', pinned: false, archived: false })
    expect(await readLibrary()).toEqual({})
    // written through a temp file and renamed: no temp file is left behind
    expect(readdirSync(join(file, '..'))).toEqual(['chat-library.json'])
  })

  it('refuses an id that could name a path', async () => {
    expect(() => patchEntry('../../etc', { title: 'x' })).toThrow()
    expect(() => patchEntry('a/b', { title: 'x' })).toThrow()
  })

  it('keeps every patch when several arrive at once', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => patchEntry(`chat-${i}`, { pinned: true })))
    expect(Object.keys(await readLibrary())).toHaveLength(12)
  })

  it('migrates browser names without overwriting what the library already says', async () => {
    await patchEntry('one', { title: 'Named on disk' })
    const r = await migrateEntries({ names: { one: 'Old browser name', two: 'Second', 'bad/id': 'x' }, colours: { two: '#112233', three: 'nope' } })
    expect(r.changed).toBe(2)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ one: { title: 'Named on disk' }, two: { title: 'Second', colour: '#112233' } })
  })
})

describe('listing every chat', () => {
  let a, b, roots
  beforeEach(() => {
    forgetMeta()
    a = temp('acct-a')
    b = temp('acct-b')
    roots = [
      { dir: a, account: 'me' },
      { dir: b, account: 'work' },
      { dir: join(a, 'missing'), account: 'gone' },
    ]
    const day = 24 * 3600e3
    // far older than the old 48 hour window
    transcript(a, 'web', 'old-1', { title: 'Old site work', at: '2025-01-01T00:00:00.000Z', mtime: Date.now() - 300 * day })
    transcript(a, 'web', 'new-1', { title: 'Zebra checkout', at: '2026-09-10T00:00:00.000Z', mtime: Date.now() - day })
    transcript(a, 'api', 'mid-1', { prompt: 'add rate limiting to the api', at: '2026-05-01T00:00:00.000Z', mtime: Date.now() - 30 * day })
    transcript(b, 'api', 'work-1', { title: 'Alpha deploy', at: '2026-08-01T00:00:00.000Z', mtime: Date.now() - 2 * day, branch: 'deploy' })
    // the same chat carried to the other account: one row, the newer copy
    transcript(b, 'web', 'new-1', { title: 'Zebra checkout', mtime: Date.now() - 3 * day })
    // not a chat: no messages
    mkdirSync(join(a, 'web'), { recursive: true })
    writeFileSync(join(a, 'web', 'empty-1.jsonl'), `${JSON.stringify({ type: 'summary', summary: 'x' })}\n`)
  })

  it('finds chats of any age in every root, once each, with titles', async () => {
    const rows = await scanChats(roots)
    expect(rows.map((r) => r.id).sort()).toEqual(['mid-1', 'new-1', 'old-1', 'work-1'])
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId['new-1'].account).toBe('me')
    expect(byId['mid-1'].autoTitle).toBe('add rate limiting to the api')
    expect(byId['work-1']).toMatchObject({ account: 'work', branch: 'deploy', cwd: '/work/api', autoTitle: 'Alpha deploy' })
  })

  it('reads a changed transcript again, and an unchanged one from the cache', async () => {
    await scanChats(roots)
    const p = transcript(a, 'api', 'mid-1', { title: 'Renamed by Claude', mtime: Date.now() - 1000 })
    expect((await scanChats(roots)).find((r) => r.id === 'mid-1').autoTitle).toBe('Renamed by Claude')
    expect(existsSync(p)).toBe(true)
  })

  it('filters, sorts and pages, pinned first and archived hidden', async () => {
    const rows = await scanChats(roots)
    const library = { 'old-1': { pinned: true, title: 'My pinned one' }, 'mid-1': { archived: true } }
    const running = new Map([['work-1', 'host-7']])
    const ids = (params) => listChats({ rows, library, running, params }).items.map((x) => x.id)

    expect(ids({})).toEqual(['old-1', 'new-1', 'work-1'])
    expect(ids({ archived: '1' })).toEqual(['old-1', 'new-1', 'work-1', 'mid-1'])
    expect(ids({ archived: 'only' })).toEqual(['mid-1'])
    expect(ids({ sort: 'title' })).toEqual(['old-1', 'work-1', 'new-1'])
    expect(ids({ sort: 'created' })).toEqual(['old-1', 'new-1', 'work-1'])
    expect(ids({ account: 'work' })).toEqual(['work-1'])
    expect(ids({ project: '/work/web' })).toEqual(['old-1', 'new-1'])
    expect(ids({ state: 'here' })).toEqual(['work-1'])
    expect(ids({ state: 'other' })).toEqual(['old-1', 'new-1'])
    expect(ids({ pinned: '1' })).toEqual(['old-1'])
    expect(ids(new URLSearchParams('q=ZEBRA'))).toEqual(['new-1'])
    expect(ids({ q: 'deploy' })).toEqual(['work-1'])

    const first = listChats({ rows, library, running, params: { limit: '2' } })
    expect(first).toMatchObject({ total: 3, next: '2' })
    expect(first.items[0]).toMatchObject({ title: 'My pinned one', named: true, pinned: true })
    const second = listChats({ rows, library, running, params: { limit: '2', cursor: first.next } })
    expect(second.items.map((x) => x.id)).toEqual(['work-1'])
    expect(second.items[0].here).toBe('host-7')
    expect(second.next).toBeNull()
    // facets count what the archived filter leaves
    expect(first.facets.projects).toEqual([
      { name: '/work/web', count: 2 },
      { name: '/work/api', count: 1 },
    ])
    // no file paths go to the page
    expect(first.items[0].path).toBeUndefined()
  })

  it('names a chat after the git repo holding its folder', async () => {
    const rows = await scanChats(roots)
    const r = listChats({ rows, params: { q: 'work-1' }, repoOf: (cwd) => (cwd === '/work/api' ? { repo: 'org/api', repoPath: '/work/api' } : undefined) })
    expect(r.items[0]).toMatchObject({ repo: 'org/api', repoPath: '/work/api', project: '/work/api' })
  })
})

describe('searching inside messages', () => {
  let root, rows
  beforeEach(async () => {
    forgetMeta()
    root = temp('search')
    for (let i = 0; i < 6; i++) {
      transcript(root, 'p', `s-${i}`, {
        reply: i % 2 ? `We replaced the flux capacitor in step ${i}.` : 'Nothing to see.',
        extra: [
          // tool output mentions it too, but that is not a message you read
          { type: 'user', message: { content: [{ type: 'tool_result', content: 'flux capacitor log' }] } },
        ],
        mtime: Date.now() - i * 60e3,
      })
    }
    rows = await scanChats([{ dir: root, account: null }])
  })

  it('returns one hit per chat with a snippet around the match', async () => {
    const r = await searchChats({ rows, q: 'Flux Capacitor' })
    expect(r.hits.map((h) => h.id)).toEqual(['s-1', 's-3', 's-5'])
    expect(r.truncated).toBeNull()
    const s = r.hits[0].snippet
    expect(s.text.slice(s.start, s.start + s.length)).toBe('flux capacitor')
    expect(r.hits[0].role).toBe('assistant')
  })

  it('stops at the hit limit, the byte budget and the time budget, and carries on from there', async () => {
    const hits = await searchChats({ rows, q: 'flux', maxHits: 1 })
    expect(hits).toMatchObject({ truncated: 'hits', next: 2, hits: [{ id: 's-1' }], of: 6 })
    const rest = await searchChats({ rows, q: 'flux', skip: hits.next })
    expect(rest).toMatchObject({ truncated: null, next: null, scanned: 4 })
    expect(rest.hits.map((h) => h.id)).toEqual(['s-3', 's-5'])

    // the first chat of a call is always read, so an over-small budget still moves forward
    const bytes = await searchChats({ rows, q: 'flux', maxBytes: 300 })
    expect(bytes).toMatchObject({ truncated: 'bytes', scanned: 1, next: 1 })
    const time = await searchChats({ rows, q: 'flux', timeMs: -1, skip: 1 })
    expect(time).toMatchObject({ truncated: 'time', scanned: 1, next: 2, hits: [{ id: 's-1' }] })

    // walking the whole folder a step at a time finds everything once
    const found = []
    for (let skip = 0, n = 0; skip !== null && n < 20; n++) {
      const r = await searchChats({ rows, q: 'flux', skip, timeMs: -1 })
      found.push(...r.hits.map((h) => h.id))
      skip = r.next
    }
    expect(found).toEqual(['s-1', 's-3', 's-5'])
    expect((await searchChats({ rows, q: 'x' })).hits).toEqual([])
  })

  it('cuts a snippet with ellipses on both sides', () => {
    const text = `${'a '.repeat(100)}needle${' b'.repeat(100)}`
    const s = snippetOf(text, text.indexOf('needle'), 6, 10)
    expect(s.text.startsWith('…')).toBe(true)
    expect(s.text.endsWith('…')).toBe(true)
    expect(s.text.slice(s.start, s.start + s.length)).toBe('needle')
  })
})

describe('deleting a chat', () => {
  let root, other, trash, briefs, roots
  beforeEach(() => {
    forgetMeta()
    root = temp('del-root')
    other = temp('del-outside')
    trash = temp('del-trash')
    briefs = temp('del-briefs')
    process.env.LAIKA_CHAT_LIBRARY = join(temp('del-lib'), 'chat-library.json')
    roots = [{ dir: root, account: 'me' }]
  })
  const del = (id, o = {}) => deleteChat({ id, roots, trash, briefs, ...o })

  it('moves the transcript, its folder, its brief and its entry to the Trash', async () => {
    const p = transcript(root, 'web', 'gone-1')
    mkdirSync(join(root, 'web', 'gone-1', 'subagents'), { recursive: true })
    writeFileSync(join(briefs, 'gone-1.json'), '{}')
    await patchEntry('gone-1', { pinned: true })
    // something of the same name already in the Trash is not overwritten
    writeFileSync(join(trash, 'gone-1.jsonl'), 'older')

    const r = await del('gone-1')
    expect(r.code).toBe(200)
    expect(existsSync(p)).toBe(false)
    expect(existsSync(join(root, 'web', 'gone-1'))).toBe(false)
    expect(existsSync(join(briefs, 'gone-1.json'))).toBe(false)
    expect(readdirSync(trash).sort()).toEqual(['gone-1 (chat files)', 'gone-1 1.jsonl', 'gone-1.brief.json', 'gone-1.jsonl'])
    expect(readFileSync(join(trash, 'gone-1.jsonl'), 'utf8')).toBe('older')
    expect(await readLibrary()).toEqual({})
  })

  it('refuses ids that walk out of the folders', async () => {
    writeFileSync(join(other, 'secret.jsonl'), 'x')
    for (const id of ['../secret', '..', '../../outside/secret', 'a/b', 'a\\b', '', '.', 'x.jsonl']) {
      expect((await del(id)).code).toBe(400)
    }
    expect(existsSync(join(other, 'secret.jsonl'))).toBe(true)
  })

  it('refuses a chat open in the app, and one written to moments ago', async () => {
    const p = transcript(root, 'web', 'busy-1')
    expect(await del('busy-1', { running: new Map([['busy-1', 'host-1']]) })).toMatchObject({ code: 409 })
    expect((await del('busy-1', { quietMs: 60_000 })).code).toBe(409)
    expect(existsSync(p)).toBe(true)
  })

  it('refuses a transcript that links outside the roots', async () => {
    const target = transcript(other, 'elsewhere', 'link-1')
    mkdirSync(join(root, 'web'), { recursive: true })
    symlinkSync(target, join(root, 'web', 'link-1.jsonl'))
    expect((await del('link-1')).code).toBe(403)
    expect(existsSync(target)).toBe(true)
    expect(readdirSync(trash)).toEqual([])
  })

  it('says when there is nothing to delete', async () => {
    expect((await del('nope-1')).code).toBe(404)
  })
})
