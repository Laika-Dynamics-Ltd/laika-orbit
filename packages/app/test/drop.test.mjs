import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isLocalAddress, peerFrom, safeName, sendFile, startDrop, uniquePath } from '../drop.mjs'

describe('what may reach the drop zone', () => {
  it('takes the local link and nothing else', () => {
    for (const a of ['192.168.1.20', '10.0.0.4', '172.16.9.1', '172.31.255.254', '169.254.3.3', '127.0.0.1', '::1', '::ffff:192.168.1.20', 'fe80::1c2b%en0', 'fd12:3456::1'])
      expect(isLocalAddress(a), a).toBe(true)
    for (const a of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '203.0.113.7', '2606:4700::1111', '999.1.1.1', '', null])
      expect(isLocalAddress(a), String(a)).toBe(false)
  })

  it('keeps a sender from naming a path', () => {
    expect(safeName('../../.ssh/authorized_keys')).toBe('authorized_keys')
    expect(safeName('/etc/passwd')).toBe('passwd')
    expect(safeName('..')).toBe('dropped-file')
    expect(safeName('')).toBe('dropped-file')
    expect(safeName('C:\\Users\\me\\notes.md')).toBe('notes.md')
    expect(safeName('a\nb.txt')).toBe('ab.txt')
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
    expect(them.offers().find((o) => o.id === asked[1].id)).toMatchObject({ state: 'done' })
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
  const inboxFiles = () => (existsSync(inbox) ? readdirSync(inbox).sort() : [])
})

/** a small wait-for, so a test can let the offer arrive before answering it */
async function waitFor(cond, ms = 2000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (cond()) return
    await new Promise((ok) => setTimeout(ok, 10))
  }
  throw new Error('timed out waiting')
}
