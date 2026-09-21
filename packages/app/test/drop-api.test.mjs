import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dropZone, handleDrop, startDropZone } from '../drop-api.mjs'
import { startDrop } from '../drop.mjs'

/**
 * The panel's side of it: what /api/drop/* does when a file is dropped on this machine and sent
 * to another. Both Orbits are real — one is this process's drop zone (the one the routes drive),
 * the other a second zone standing in for the Mac across the room.
 */
describe('the drop zone behind the panel', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drop-api-'))
  const theirInbox = join(dir, 'theirs')
  /** every offer the far end was told about, so the test can play the person who answers it */
  const asked = []
  let them
  let api
  let base

  const get = async (path, init) => {
    const r = await fetch(`${base}${path}`, init)
    return { status: r.status, body: await r.json() }
  }
  const waitFor = async (cond, ms = 4000) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const got = await cond()
      if (got) return got
      await new Promise((ok) => setTimeout(ok, 20))
    }
    throw new Error('timed out waiting')
  }

  beforeAll(async () => {
    them = await startDrop({ port: 0, host: '127.0.0.1', inbox: theirInbox, announce: false, me: { id: 'them', name: 'other-orbit' }, onOffer: (o) => asked.push(o) })
    await startDropZone({ port: 0, host: '127.0.0.1', inbox: join(dir, 'mine'), announce: false, me: { id: 'mine', name: 'this-mac' } })
    // mDNS is the usual way a peer turns up; here it is put in by hand, which the same address
    // check guards either way
    dropZone().add({ id: 'them', name: 'other-orbit', host: '127.0.0.1', port: them.port })
    api = createServer((req, res) => {
      handleDrop(new URL(req.url, 'http://x'), req, res).then((took) => {
        if (!took) {
          res.writeHead(404)
          res.end()
        }
      })
    })
    await new Promise((ok) => api.listen(0, '127.0.0.1', ok))
    base = `http://127.0.0.1:${api.address().port}`
  })
  afterAll(async () => {
    await new Promise((ok) => api?.close(ok))
    await them?.close()
    await dropZone()?.close()
  })

  it('tells the panel who is here, in one poll', async () => {
    const { body } = await get('/api/drop/state')
    expect(body.me.name).toBe('this-mac')
    expect(body.peers).toHaveLength(1)
    expect(body.peers[0]).toMatchObject({ id: 'them', name: 'other-orbit', host: '127.0.0.1' })
    expect(body.offers).toEqual([])
    expect(body.sends).toEqual([])
  })

  it('will not send to an address of the caller’s choosing, only to a peer it has seen', async () => {
    const { status, body } = await get('/api/drop/send?to=203.0.113.9%3A80&name=x.txt', { method: 'POST', body: 'x' })
    expect(status).toBe(404)
    expect(body.error).toMatch(/no longer on the network/)
  })

  it('sends a dropped file, and shows it waiting until the far end says yes', async () => {
    const bytes = 'what the panel dropped\n'
    const sent = get('/api/drop/send?to=them&name=notes.md', { method: 'POST', body: bytes })
    const offer = await waitFor(() => asked[0])
    expect(offer).toMatchObject({ state: 'pending', file: { name: 'notes.md', size: bytes.length } })
    // the offer is out and the browser's request has already been answered, but nothing has been
    // written at the far end
    expect((await sent).body.send).toBeTruthy()
    expect(existsSync(theirInbox)).toBe(false)
    const waitingOn = await waitFor(async () => (await get('/api/drop/state')).body.sends.find((s) => s.state === 'waiting'))
    expect(waitingOn).toMatchObject({ to: { name: 'other-orbit' }, file: { name: 'notes.md' } })

    them.decide(offer.id, true)
    const done = await waitFor(async () => (await get('/api/drop/state')).body.sends.find((s) => s.state === 'done'))
    expect(done).toMatchObject({ saved: 'notes.md', file: { name: 'notes.md' } })
    expect(readFileSync(join(theirInbox, 'notes.md'), 'utf8')).toBe(bytes)
    expect(readdirSync(dir).includes('spool')).toBe(false)
  })

  it('reports a refusal as a stopped transfer rather than a silent nothing', async () => {
    await get('/api/drop/send?to=them&name=no-thanks.md', { method: 'POST', body: 'nope' })
    const offer = await waitFor(() => asked[1])
    them.decide(offer.id, false)
    const stopped = await waitFor(async () => (await get('/api/drop/state')).body.sends.find((s) => s.state === 'failed'))
    expect(stopped.error).toMatch(/declined/)
    expect(readdirSync(theirInbox)).toEqual(['notes.md'])
  })

  it('accepts an offer of its own through the route the panel presses', async () => {
    const theirs = them.sendFile({ id: 'mine', name: 'this-mac', host: '127.0.0.1', port: dropZone().port }, join(theirInbox, 'notes.md'), { poll: 20 })
    const waiting = await waitFor(async () => (await get('/api/drop/state')).body.offers.find((o) => o.state === 'pending'))
    expect(waiting.from.name).toBe('other-orbit')
    expect(existsSync(join(dir, 'mine'))).toBe(false)

    expect((await get(`/api/drop/offers/${waiting.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"accept":true}' })).body.offer.state).toBe('accepted')
    expect(await theirs).toMatchObject({ ok: true, saved: 'notes.md' })
    expect(readdirSync(join(dir, 'mine'))).toEqual(['notes.md'])

    // and the same offer cannot be answered twice
    expect((await get(`/api/drop/offers/${waiting.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"accept":true}' })).status).toBe(409)
  })
})
