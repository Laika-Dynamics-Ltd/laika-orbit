import { afterEach, describe, expect, it } from 'vitest'
import { createRelayTransport } from '../relay-transport.mjs'
import { sealedChannel } from '../sealed-envelope.mjs'
import { isTransport } from '../transport.mjs'
import { createRelayStub, createStubPhone } from './relay-stub.mjs'

/**
 * The relay, against a database that is not one (relay-stub.mjs), because which database Orbit
 * uses has not been chosen and nothing here may go and pick it. What is being proven is that the
 * wire works, that it is the same handler the LAN gets, and — the part the whole idea rests on —
 * that the table holds nothing a person wrote.
 */
const TOKEN = 'd'.repeat(48)
const SECRET = TOKEN

/** a stand-in for the agent host's front door, gate and all, so the relay is not given a special one */
const hostHandler = (req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.headers['x-agent-token'] !== TOKEN) return json(401, { error: 'unauthorised' })
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/fleet') return json(200, [{ title: 'Fixing the Toaster repo', cwd: '/Users/sam/code/toaster', state: 'running' }])
  if (url.pathname === '/boom') throw new Error('the kitchen is on fire')
  if (url.pathname === '/echo' && req.method === 'POST') {
    return (async () => {
      const parts = []
      for await (const c of req) parts.push(c)
      json(200, { heard: JSON.parse(Buffer.concat(parts).toString('utf8') || '{}') })
    })()
  }
  if (url.pathname === '/fleet/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    let n = 0
    const tick = setInterval(() => res.write(`event: tick\ndata: ${JSON.stringify({ n: ++n })}\n\n`), 5)
    req.on('close', () => clearInterval(tick))
    return
  }
  return json(404, { error: 'not found' })
}

const shut = []
afterEach(async () => {
  while (shut.length) await shut.pop()()
})

/** a Mac carrying the relay, and a phone paired with it, both wired to the same stand-in database */
const paired = async ({ secret = SECRET, token = TOKEN, handler = hostHandler, ...opts } = {}) => {
  const stub = createRelayStub(opts)
  const mac = createRelayTransport({ handler, secret, db: stub.db })
  await mac.open()
  await mac.carry(true)
  const phone = createStubPhone({ stub, secret, token, channel: sealedChannel({ secret, side: 'phone' }) })
  shut.push(async () => {
    await phone.stop()
    await mac.close()
  })
  return { stub, mac, phone }
}

describe('the relay is a transport like any other', () => {
  it('answers the four calls', async () => {
    const { mac } = await paired()
    expect(isTransport(mac)).toBe(true)
    expect(mac.status()).toMatchObject({ name: 'relay', carrying: true, host: null, port: null })
  })

  it('carries nothing until it is asked to', async () => {
    const stub = createRelayStub()
    const mac = createRelayTransport({ handler: hostHandler, secret: SECRET, db: stub.db })
    expect(mac.status().carrying).toBe(false)
    await mac.open()
    expect(mac.status().carrying).toBe(false)
    expect(stub.subscribers).toBe(0)
    await mac.carry(true)
    expect(stub.subscribers).toBe(1)
    await mac.close()
    expect(stub.subscribers).toBe(0)
  })

  it('refuses to be built without a handler or without a database', () => {
    expect(() => createRelayTransport({ secret: SECRET, db: createRelayStub().db })).toThrow(/handler/)
    expect(() => createRelayTransport({ handler: hostHandler, secret: SECRET })).toThrow(/send and subscribe/)
    expect(() => createRelayTransport({ handler: hostHandler, secret: SECRET, db: { send() {} } })).toThrow(/send and subscribe/)
  })
})

describe('a phone asking this Mac something, from anywhere', () => {
  it('gets the answer the LAN would have given', async () => {
    const { phone } = await paired()
    const r = await phone.ask('/fleet')
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toEqual([{ title: 'Fixing the Toaster repo', cwd: '/Users/sam/code/toaster', state: 'running' }])
  })

  it('carries a body up as well as down', async () => {
    const { phone } = await paired()
    const r = await phone.ask('/echo', { method: 'POST', body: { prompt: 'rename the widget' } })
    expect(JSON.parse(r.body)).toEqual({ heard: { prompt: 'rename the widget' } })
  })

  it('gets the same 404 and the same 401 the front door gives', async () => {
    const { phone } = await paired()
    expect((await phone.ask('/nowhere')).status).toBe(404)
    expect((await phone.ask('/fleet', { headers: { 'x-agent-token': 'not the token' } })).status).toBe(401)
  })

  it('is still answered when a route throws, and is not told what threw', async () => {
    const { phone } = await paired()
    const r = await phone.ask('/boom')
    expect(r.status).toBe(500)
    expect(r.body).not.toMatch(/kitchen/)
  })

  it('handles several at once without crossing the answers over', async () => {
    const { phone } = await paired()
    const rs = await Promise.all([phone.ask('/fleet'), phone.ask('/nowhere'), phone.ask('/echo', { method: 'POST', body: { n: 7 } }), phone.ask('/fleet')])
    expect(rs.map((r) => r.status)).toEqual([200, 404, 200, 200])
    expect(JSON.parse(rs[2].body)).toEqual({ heard: { n: 7 } })
  })

  it('works over a pipe that is slow and delivers everything twice', async () => {
    const { phone } = await paired({ latency: 5, duplicate: true })
    const r = await phone.ask('/fleet', { timeout: 4000 })
    expect(r.status).toBe(200)
  })
})

describe('an event stream, over a pipe that has no connection to hold open', () => {
  it('arrives as a run of sealed chunks and stops when the phone hangs up', async () => {
    const { phone, mac } = await paired()
    const s = await phone.ask('/fleet/events', { stream: true })
    await new Promise((r) => setTimeout(r, 40))
    expect(mac.status().inflight).toBe(1)
    await s.cancel()
    const got = await s.answer
    expect(got.head).toMatchObject({ status: 200 })
    expect(got.chunks.length).toBeGreaterThan(1)
    expect(got.chunks[0]).toMatch(/event: tick/)
    expect(mac.status().inflight).toBe(0)
    // the handler's own cleanup ran, so nothing is still ticking into a stream nobody reads
    const after = mac.status().inflight
    await new Promise((r) => setTimeout(r, 30))
    expect(mac.status().inflight).toBe(after)
  })

  it('cuts streams when remote access is taken back', async () => {
    const { phone, mac } = await paired()
    await phone.ask('/fleet/events', { stream: true })
    await new Promise((r) => setTimeout(r, 20))
    expect(mac.status().inflight).toBe(1)
    await mac.carry(false)
    expect(mac.status()).toMatchObject({ carrying: false, inflight: 0 })
  })
})

describe('what the database is left holding', () => {
  it('has ciphertext and routing in every row, and nothing anybody wrote', async () => {
    const { stub, phone } = await paired()
    await phone.ask('/fleet')
    await phone.ask('/echo', { method: 'POST', body: { prompt: 'rename the widget in the Toaster repo' } })
    expect(stub.rows.length).toBeGreaterThan(2)
    for (const row of stub.rows) {
      expect(Object.keys(row).sort()).toEqual(['at', 'created_at', 'dir', 'envelope', 'room'])
      expect(Object.keys(row.envelope).sort()).toEqual(['ct', 'dir', 'n', 'seq', 'v'])
    }
    const table = stub.dump()
    for (const leak of ['Toaster', 'toaster', 'widget', 'rename', '/Users/sam', '/fleet', '/echo', 'prompt', 'running', TOKEN, 'x-agent-token', 'application/json'])
      expect(table, leak).not.toContain(leak)
  })

  it('does not put the pairing secret or the token in the room id', async () => {
    const { stub, phone, mac } = await paired()
    await phone.ask('/fleet')
    expect(mac.status().room).not.toContain(SECRET.slice(0, 16))
    expect(stub.dump()).not.toContain(SECRET.slice(0, 16))
  })
})

describe('a hostile pipe', () => {
  it('says nothing at all to a message it cannot open', async () => {
    const { stub, mac } = await paired()
    const stranger = sealedChannel({ secret: 'z'.repeat(48), side: 'phone' })
    const before = stub.rows.length
    for (let i = 0; i < 3; i++) await stub.db.send(mac.status().room, 'p2m', stranger.seal({ id: `x${i}`, method: 'GET', path: '/fleet' }))
    await new Promise((r) => setTimeout(r, 30))
    // three rows arrived, three rows are all that is there: not one answer, not one error
    expect(stub.rows.length).toBe(before + 3)
    expect(mac.status().unreadable).toMatchObject({ sealed: 3 })
  })

  it('says nothing to junk written straight into the room', async () => {
    const { stub, mac } = await paired()
    const before = stub.rows.length
    for (const junk of [null, 'hello', { v: 1 }, { v: 1, dir: 'p2m', seq: 1, n: 'AAAA', ct: 'AAAA' }]) await stub.db.send(mac.status().room, 'p2m', junk)
    await new Promise((r) => setTimeout(r, 30))
    expect(stub.rows.length).toBe(before + 4)
    const { malformed, version } = mac.status().unreadable
    expect(malformed + version).toBe(4)
  })

  it('will not run a request twice when the pipe replays a row', async () => {
    const { stub, phone } = await paired()
    await phone.ask('/echo', { method: 'POST', body: { n: 1 } })
    const answers = stub.rows.filter((r) => r.dir === 'm2p').length
    const request = stub.rows.findIndex((r) => r.dir === 'p2m')
    stub.replay(request)
    stub.replay(request)
    await new Promise((r) => setTimeout(r, 30))
    expect(stub.rows.filter((r) => r.dir === 'm2p').length).toBe(answers)
  })

  it('will not be steered by a row the provider edited', async () => {
    const { stub, mac, phone } = await paired()
    await phone.ask('/fleet')
    const answers = stub.rows.filter((r) => r.dir === 'm2p').length
    const i = stub.rows.findIndex((r) => r.dir === 'p2m')
    stub.tamper(i, { seq: 99 })
    stub.tamper(i, { ct: Buffer.from('not what was sealed').toString('base64url') })
    stub.tamper(i, { dir: 'm2p' })
    await new Promise((r) => setTimeout(r, 30))
    expect(stub.rows.filter((r) => r.dir === 'm2p').length).toBe(answers)
    expect(Object.values(mac.status().unreadable).reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
  })

  it('refuses a flood rather than spending the whole Mac on it', async () => {
    const { phone, mac } = await paired()
    const streams = []
    for (let i = 0; i < 32; i++) streams.push(await phone.ask('/fleet/events', { stream: true }))
    await new Promise((r) => setTimeout(r, 30))
    expect(mac.status().inflight).toBe(32)
    expect((await phone.ask('/fleet')).status).toBe(503)
    for (const s of streams) await s.cancel()
  })

  it('carries on when the database goes away mid-answer, rather than taking the host with it', async () => {
    // the request lands, the Mac answers it, and there is nowhere to put the answer
    const { stub, mac, phone } = await paired()
    stub.fail('the relay is unreachable', { dir: 'm2p' })
    await expect(phone.ask('/fleet', { timeout: 200 })).rejects.toThrow(/no answer/)
    expect(mac.status().detail).toMatch(/could not reach the relay/)
    // still carrying, still able to answer the retry the phone makes when the tunnel ends
    stub.up()
    expect((await phone.ask('/fleet')).status).toBe(200)
    expect(mac.status().carrying).toBe(true)
  })
})
