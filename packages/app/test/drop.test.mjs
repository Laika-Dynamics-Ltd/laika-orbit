import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isLocalAddress } from '../local-net.mjs'
import { peerFrom, safeName, safeRelPath, sendFile, startDrop, uniquePath } from '../drop.mjs'

describe('what may reach the drop zone', () => {
  // the address check itself is local-net.mjs's, and is tested there; this is that the drop zone
  // is the thing using it
  it('takes the local link and nothing else', () => {
    expect(isLocalAddress('192.168.1.20')).toBe(true)
    expect(isLocalAddress('203.0.113.7')).toBe(false)
  })

  it('keeps a sender from naming a path', () => {
    expect(safeName('../../.ssh/authorized_keys')).toBe('authorized_keys')
    expect(safeName('/etc/passwd')).toBe('passwd')
    expect(safeName('..')).toBe('dropped-file')
    expect(safeName('')).toBe('dropped-file')
    expect(safeName('C:\\Users\\me\\notes.md')).toBe('notes.md')
    expect(safeName('a\nb.txt')).toBe('ab.txt')
  })

  it('keeps a folder inside the inbox whatever its paths say', () => {
    expect(safeRelPath('photos/holiday/../../../etc/hosts')).toBe('photos/holiday/etc/hosts')
    expect(safeRelPath('/Users/me/photos/a.jpg')).toBe('Users/me/photos/a.jpg')
    expect(safeRelPath('..')).toBe('dropped-file')
    expect(safeRelPath('deck/../../..')).toBe('deck')
    expect(safeRelPath('a/b/c/d/e/f/g/h/i/j/k/l/m/n.txt').split('/')).toHaveLength(12)
  })

  it('never overwrites what is already in the inbox', () => {
    const taken = new Set(['/in/notes.md', '/in/notes (2).md'])
    expect(uniquePath('/in/notes.md', (p) => taken.has(p))).toBe('/in/notes (3).md')
    expect(uniquePath('/in/other.md', (p) => taken.has(p))).toBe('/in/other.md')
  })

  it('reads a peer out of its Bonjour record, and never itself', () => {
    const service = { name: 'Orbit box1 aaaa', port: 7422, txt: { id: 'peer-id', name: 'box1' }, addresses: ['203.0.113.9', '192.168.1.31'] }
    expect(peerFrom(service, 'me')).toEqual({ id: 'peer-id', name: 'box1', host: '192.168.1.31', port: 7422, addresses: ['192.168.1.31'] })
    expect(peerFrom(service, 'peer-id')).toBe(null)
    expect(peerFrom({ port: 7422, txt: {}, addresses: ['192.168.1.31'] }, 'me')).toBe(null)
  })
})

describe('offer, answer, transfer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drop-test-'))
  const inbox = join(dir, 'inbox')
  const source = join(dir, 'notes.md')
  writeFileSync(source, 'the file that crossed the room\n')
  /** every offer the receiver was told about, so a test can answer them the way a person would */
  const asked = []
  let them
  const me = { id: 'sender-id', name: 'mac' }
  let peer

  beforeAll(async () => {
    them = await startDrop({ port: 0, host: '127.0.0.1', inbox, announce: false, me: { id: 'receiver-id', name: 'box1' }, onOffer: (o) => asked.push(o) })
    peer = { id: them.me.id, name: them.me.name, host: '127.0.0.1', port: them.port }
  })
  afterAll(async () => {
    await them?.close()
  })

  it('says who it is', async () => {
    const r = await fetch(`http://127.0.0.1:${them.port}/drop/hello`)
    expect(await r.json()).toMatchObject({ orbit: 'drop', id: 'receiver-id', name: 'box1' })
  })

  it('writes nothing while an offer waits, and nothing at all when it is declined', async () => {
    const sent = sendFileFrom(peer, source, { poll: 20 })
    await waitFor(() => asked.length === 1)
    expect(inboxFiles()).toEqual([])
    expect(them.offers()[0]).toMatchObject({ state: 'pending', file: { name: 'notes.md' } })
    expect(them.offers()[0].ticket).toBeUndefined()
    them.decide(asked[0].id, false)
    await expect(sent).rejects.toThrow(/declined/)
    expect(inboxFiles()).toEqual([])
  })

  it('accepts the file once someone says yes, and reports the bytes as they go', async () => {
    const seen = []
    const sent = sendFileFrom(peer, source, { poll: 20, onProgress: (p) => seen.push(p) })
    await waitFor(() => asked.length === 2)
    them.decide(asked[1].id, true)
    expect(await sent).toMatchObject({ ok: true, saved: 'notes.md' })
    expect(readFileSync(join(inbox, 'notes.md'), 'utf8')).toBe('the file that crossed the room\n')
    expect(seen.at(-1)).toEqual({ sent: 31, size: 31 })
    expect(them.offers().find((o) => o.id === asked[1].id)).toMatchObject({ state: 'done', saved: 'notes.md' })
  })

  it('takes a second file of the same name beside the first', async () => {
    const sent = sendFileFrom(peer, source, { poll: 20 })
    await waitFor(() => asked.length === 3)
    them.decide(asked[2].id, true)
    expect(await sent).toMatchObject({ saved: 'notes (2).md' })
    expect(inboxFiles()).toEqual(['notes (2).md', 'notes.md'])
  })

  it('refuses bytes that no ticket was minted for', async () => {
    const r = await fetch(`http://127.0.0.1:${them.port}/drop/file/not-a-ticket`, { method: 'PUT', body: 'x' })
    expect(r.status).toBe(403)
    expect(inboxFiles().length).toBe(2)
  })

  it('will not answer an offer twice', async () => {
    expect(them.decide(asked[0].id, true)).toBe(null)
  })

  /** the sender is this test process, with its own identity rather than the machine's */
  const sendFileFrom = (to, path, opts) => sendFile(to, path, { ...opts, from: me })
  const inboxFiles = () => (existsSync(inbox) ? readdirSync(inbox).filter((f) => !f.startsWith('.')).sort() : [])
})

/** a small wait-for, so a test can let the offer arrive before answering it */
async function waitFor(cond, ms = 2000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const got = cond()
    if (got) return got
    await new Promise((ok) => setTimeout(ok, 10))
  }
  throw new Error('timed out waiting')
}

describe('a folder, or an armful of files, as one question', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drop-batch-'))
  const inbox = join(dir, 'inbox')
  const src = join(dir, 'src')
  mkdirSync(join(src, 'sub'), { recursive: true })
  for (const [p, body] of [
    ['a.txt', 'one'],
    ['b.txt', 'two'],
    ['sub/c.txt', 'three'],
    ['d.txt', 'four'],
  ])
    writeFileSync(join(src, p), body)
  /** a snapshot per offer as it arrived, because the offer itself goes on changing */
  const asked = []
  const me = { id: 'sender-id', name: 'mac' }
  let them
  let peer

  beforeAll(async () => {
    them = await startDrop({ port: 0, host: '127.0.0.1', inbox, announce: false, me: { id: 'receiver-id', name: 'box1' }, onOffer: (o) => asked.push({ id: o.id, state: o.state, rel: o.file.rel, batch: o.batch }) })
    peer = { id: 'receiver-id', name: 'box1', host: '127.0.0.1', port: them.port }
  })
  afterAll(async () => {
    await them?.close()
  })

  const send = (file, rel, batch) => sendFile(peer, join(src, file), { from: me, poll: 20, rel, batch })
  const under = (root) => {
    const out = []
    const walk = (at, prefix) => {
      for (const e of readdirSync(at, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).sort((x, y) => x.name.localeCompare(y.name))) {
        if (e.isDirectory()) walk(join(at, e.name), `${prefix}${e.name}/`)
        else out.push(prefix + e.name)
      }
    }
    if (existsSync(root)) walk(root, '')
    return out
  }

  it('asks once for the whole folder, then keeps its shape', async () => {
    const batch = { id: 'b1', name: 'photos', count: 3, size: 11 }
    const first = send('a.txt', 'photos/a.txt', batch)
    await waitFor(() => asked.length === 1)
    expect(them.batches()[0]).toMatchObject({ name: 'photos', count: 3, size: 11, answered: null })
    expect(under(inbox)).toEqual([])

    them.decideBatch('b1', true)
    expect(await first).toMatchObject({ ok: true, saved: 'a.txt' })
    // the rest of an answered batch are not asked about again
    await Promise.all([send('b.txt', 'photos/b.txt', batch), send('sub/c.txt', 'photos/sub/c.txt', batch)])
    expect(asked.slice(1).map((a) => a.state)).toEqual(['accepted', 'accepted'])
    expect(under(inbox)).toEqual(['photos/a.txt', 'photos/b.txt', 'photos/sub/c.txt'])
    expect(readFileSync(join(inbox, 'photos', 'sub', 'c.txt'), 'utf8')).toBe('three')
  })

  it('will not let a batch grow past the answer it was given', async () => {
    await expect(send('d.txt', 'photos/d.txt', { id: 'b1', name: 'photos', count: 3, size: 11 })).rejects.toThrow(/already full/)
    expect(under(inbox)).toEqual(['photos/a.txt', 'photos/b.txt', 'photos/sub/c.txt'])
  })

  it('declines all of them at once, and keeps the second folder beside the first', async () => {
    const no = { id: 'b2', name: 'photos', count: 2, size: 7 }
    const both = Promise.allSettled([send('a.txt', 'photos/a.txt', no), send('b.txt', 'photos/b.txt', no)])
    await waitFor(() => them.batches().some((b) => b.id === 'b2'))
    them.decideBatch('b2', false)
    expect((await both).map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(under(inbox)).toEqual(['photos/a.txt', 'photos/b.txt', 'photos/sub/c.txt'])

    const yes = { id: 'b3', name: 'photos', count: 1, size: 3 }
    const again = send('a.txt', 'photos/a.txt', yes)
    await waitFor(() => them.batches().some((b) => b.id === 'b3'))
    them.decideBatch('b3', true)
    await again
    expect(under(inbox)).toContain('photos (2)/a.txt')
  })

  it('answers a batch once and once only', async () => {
    expect(them.decideBatch('b1', true)).toBe(null)
    expect(them.decideBatch('nothing-like-it', true)).toBe(null)
  })
})

describe('a transfer that stopped half way', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drop-resume-'))
  const inbox = join(dir, 'inbox')
  const big = join(dir, 'big.bin')
  const SIZE = 200_000
  writeFileSync(big, Buffer.alloc(SIZE, 3))
  const me = { id: 'sender-id', name: 'mac' }
  const asked = []
  let them
  let peer

  beforeAll(async () => {
    them = await startDrop({ port: 0, host: '127.0.0.1', inbox, announce: false, me: { id: 'receiver-id', name: 'box1' }, onOffer: (o) => asked.push(o) })
    peer = { id: 'receiver-id', name: 'box1', host: '127.0.0.1', port: them.port }
  })
  afterAll(async () => {
    await them?.close()
  })

  const offerBig = async () => {
    const r = await fetch(`http://127.0.0.1:${them.port}/drop/offer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: me, file: { name: 'big.bin', size: SIZE, mtime: Math.floor(statSync(big).mtimeMs) } }),
    })
    return (await r.json()).offer
  }
  const ticketFor = async (id) => (await (await fetch(`http://127.0.0.1:${them.port}/drop/offer/${id}`)).json()).ticket

  /** a sender that dies with the file half sent, which is the whole point of the exercise */
  const cutOff = (ticket, bytes) =>
    new Promise((ok) => {
      const req = httpRequest({ host: '127.0.0.1', port: them.port, path: `/drop/file/${ticket}`, method: 'PUT', headers: { 'content-length': SIZE } }, () => {})
      req.on('error', ok)
      req.on('close', ok)
      req.write(Buffer.alloc(bytes, 3))
      setTimeout(() => req.destroy(), 60)
    })

  it('keeps what arrived, and says how much of it there is', async () => {
    const id = await offerBig()
    them.decide(id, true)
    await cutOff(await ticketFor(id), 80_000)
    const failed = await waitFor(() => them.offers().find((o) => o.id === id && o.state === 'failed'))
    expect(failed.have).toBeGreaterThan(0)
    expect(failed.have).toBeLessThan(SIZE)
    // the half that arrived is kept out of the way, not in the inbox as if it were a file
    expect(existsSync(inbox) ? readdirSync(inbox).filter((f) => !f.startsWith('.')) : []).toEqual([])
    expect(readdirSync(join(inbox, '.partials'))).toHaveLength(1)
  })

  it('carries on from there rather than starting again, and still asks first', async () => {
    const seen = []
    const sent = sendFile(peer, big, { from: me, poll: 20, onProgress: (p) => seen.push(p.sent) })
    const again = await waitFor(() => asked.find((o) => o.state === 'pending'))
    // picking a transfer up is a fresh question: the part is what was saved, not the permission
    expect(them.offers().find((o) => o.id === again.id)).toMatchObject({ state: 'pending' })
    them.decide(again.id, true)

    expect(await sent).toMatchObject({ ok: true, saved: 'big.bin' })
    expect(seen[0]).toBeGreaterThan(80_000) // it began where the last attempt stopped
    expect(seen.at(-1)).toBe(SIZE)
    const landed = readFileSync(join(inbox, 'big.bin'))
    expect(landed).toHaveLength(SIZE)
    expect(landed.every((b) => b === 3)).toBe(true)
    // and the part is gone once the file is whole
    expect(existsSync(join(inbox, '.partials'))).toBe(false)
  })

  it('will not take bytes that start anywhere else', async () => {
    const id = await offerBig()
    them.decide(id, true)
    const r = await fetch(`http://127.0.0.1:${them.port}/drop/file/${await ticketFor(id)}`, { method: 'PUT', headers: { 'x-drop-from': '50000' }, body: 'x' })
    expect(r.status).toBe(409)
    expect((await r.json()).have).toBe(0)
  })
})
