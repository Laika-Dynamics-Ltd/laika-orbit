import { afterEach, describe, expect, it } from 'vitest'
import { createRelayDb } from '../relay-supabase.mjs'
import { createRelayTransport } from '../relay-transport.mjs'
import { relayKeys, sealedChannel } from '../sealed-envelope.mjs'
import { createStubPhone } from './relay-stub.mjs'
import { RULES, createRelayTable } from './relay-table.mjs'

/**
 * The relay, its adapter and the schema, run as one thing.
 *
 * relay-transport.test.mjs proves the transport against a stub that takes an envelope and hands
 * the same object back. That is the right test for the transport and the wrong one for the
 * database half, because the database does not store an object — it stores five columns, and the
 * question nobody had answered is whether an envelope survives being taken apart into them and
 * put back together, under the constraints the migration actually declares.
 *
 * So: the real createRelayTransport, the real sealed envelope, the real adapter, and a store whose
 * every rule is parsed out of supabase/migrations (relay-table.mjs). What that store cannot prove
 * is that a policy compiles — supabase/tests/relay_rls.test.sql is waiting for a Postgres to prove
 * that, and there is no container runtime here to give it one. What it can prove is everything
 * above the database, against the shape the database will have.
 */

const TOKEN = 'e'.repeat(48)
const SECRET = TOKEN
/** one Supabase account, signed in on both the Mac and the phone — which is the whole topology */
const SAM = '11111111-1111-1111-1111-111111111111'
const SOMEONE_ELSE = '22222222-2222-2222-2222-222222222222'

const hostHandler = (req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.headers['x-agent-token'] !== TOKEN) return json(401, { error: 'unauthorised' })
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/fleet') return json(200, [{ title: 'Fixing the Toaster repo', cwd: '/Users/sam/code/toaster', state: 'running' }])
  if (url.pathname === '/big') return json(200, { diff: 'x'.repeat(8192) })
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

/** a Mac and its phone, both signed in to the same account, both talking to the same table */
const paired = async ({ uid = SAM, handler = hostHandler, ...opts } = {}) => {
  const table = createRelayTable(opts)
  const mac = createRelayTransport({ handler, secret: SECRET, db: createRelayDb(table.client(uid)) })
  await mac.open()
  await mac.carry(true)
  const phone = createStubPhone({
    stub: { db: createRelayDb(table.client(uid)) },
    secret: SECRET,
    token: TOKEN,
    channel: sealedChannel({ secret: SECRET, side: 'phone' }),
  })
  shut.push(async () => {
    await phone.stop()
    await mac.close()
  })
  return { table, mac, phone, room: relayKeys(SECRET).room }
}

describe('an envelope survives being five columns', () => {
  it('carries a request to the handler and the answer back', async () => {
    const { phone } = await paired()
    const answer = await phone.ask('/fleet')
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)[0].title).toBe('Fixing the Toaster repo')
  })

  it('stores exactly the columns the migration declares, and nothing else', async () => {
    const { phone, table } = await paired()
    await phone.ask('/fleet')
    for (const row of table.messages) {
      expect(Object.keys(row).sort()).toEqual(['created_at', 'ct', 'dir', 'id', 'nonce', 'owner', 'pipe', 'room', 'seq', 'v'])
      expect(row.nonce).toMatch(RULES.nonce)
      expect(row.room).toMatch(RULES.room)
      expect(RULES.dirs).toContain(row.dir)
      expect(row.seq).toBeGreaterThanOrEqual(1)
      expect(row.pipe).toBe(`${row.room}:${row.dir}`)
    }
  })

  it('opens the room before it writes into it, because the key says it must', async () => {
    const { table, room } = await paired()
    expect(table.rooms.map((r) => r.id)).toEqual([room])
    expect(table.rooms[0].owner).toBe(SAM)
  })

  it('tells the table nothing a person wrote', async () => {
    const { phone, table } = await paired()
    await phone.ask('/fleet')
    const everything = table.dump()
    for (const leak of ['Toaster', 'toaster', '/Users/sam', 'running', 'fleet', 'x-agent-token', TOKEN])
      expect(everything, `the table can be read for "${leak}"`).not.toContain(leak)
    // and what it does hold is a room id that is one-way out of a secret it was never given
    expect(everything).toContain(relayKeys(SECRET).room)
  })

  it('carries an event stream as a run of rows, each one sealed on its own', async () => {
    const { phone, table } = await paired()
    const { answer, cancel } = await phone.ask('/fleet/events', { stream: true })
    await new Promise((r) => setTimeout(r, 40))
    await cancel()
    const got = await answer
    expect(got.head.status).toBe(200)
    expect(got.chunks.length).toBeGreaterThan(1)
    // every chunk is its own row, with its own sequence number, in order
    const back = table.messages.filter((m) => m.dir === 'm2p').map((m) => m.seq)
    expect(back.length).toBeGreaterThan(1)
    expect([...back].sort((a, b) => a - b)).toEqual(back)
  })
})

describe('what another account can reach, which is nothing', () => {
  it("does not deliver a room's messages to a different account subscribed to the same pipe", async () => {
    const { table, phone, room } = await paired()
    const heard = []
    const intruder = createRelayDb(table.client(SOMEONE_ELSE))
    await expect(intruder.subscribe(room, 'm2p', (e) => heard.push(e))).rejects.toThrow(/could not open the relay room/)
    await phone.ask('/fleet')
    expect(heard).toEqual([])
  })

  it('cannot read the rows either, asked for directly', async () => {
    const { table, phone } = await paired()
    await phone.ask('/fleet')
    expect(table.messages.length).toBeGreaterThan(0)
    const { data } = await table.client(SOMEONE_ELSE).from('relay_message').select('*')
    expect(data).toEqual([])
  })

  it('cannot write into a room it does not own — the key refuses before any policy is asked', async () => {
    const { table, room } = await paired()
    const { error } = await table
      .client(SOMEONE_ELSE)
      .from('relay_message')
      .insert({ room, dir: 'p2m', v: 1, seq: 1, nonce: 'ZZZZZZZZZZZZZZZZ', ct: 'anything at all' })
    expect(error.code).toBe('23503')
  })

  it('gets nothing at all without a session, which is what a stolen publishable key is', async () => {
    const table = createRelayTable()
    const mac = createRelayTransport({ handler: hostHandler, secret: SECRET, db: createRelayDb(table.anon()) })
    await mac.open()
    await expect(mac.carry(true)).rejects.toThrow(/could not open the relay room/)
    expect(table.messages).toEqual([])
    expect(table.rooms).toEqual([])
    await mac.close()
  })
})

describe('the table refuses what the opener would have refused anyway', () => {
  it('will not take the same envelope twice, inside the window where a replay could still work', async () => {
    const { table, room } = await paired()
    const db = createRelayDb(table.client(SAM))
    const envelope = sealedChannel({ secret: SECRET, side: 'phone' }).seal({ id: 'r1', path: '/fleet' })
    await db.send(room, 'p2m', envelope)
    await expect(db.send(room, 'p2m', envelope)).rejects.toThrow(/relay_message_no_replays/)
  })

  it('counts a message it cannot open and answers it with nothing at all', async () => {
    const { table, mac, room } = await paired()
    const before = table.messages.filter((m) => m.dir === 'm2p').length
    await table
      .client(SAM)
      .from('relay_message')
      .insert({ room, dir: 'p2m', v: 1, seq: 7, nonce: 'QQQQQQQQQQQQQQQQ', ct: 'not a real ciphertext at all' })
    await new Promise((r) => setTimeout(r, 20))
    const refused = mac.status().unreadable
    expect(Object.values(refused).reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
    expect(table.messages.filter((m) => m.dir === 'm2p').length).toBe(before)
  })
})

describe('retention, which is the promise this table lives or dies on', () => {
  it('has swept the ciphertext by the time it could no longer be opened', async () => {
    const { phone, table } = await paired()
    await phone.ask('/fleet')
    expect(table.messages.length).toBeGreaterThan(0)
    table.advance(RULES.sweepSeconds * 1000 + 1000)
    expect(table.messages).toEqual([])
  })

  it('keeps carrying afterwards: a swept pipe is an empty one, not a broken one', async () => {
    const { phone, table } = await paired()
    await phone.ask('/fleet')
    table.advance(RULES.sweepSeconds * 1000 + 1000)
    expect(table.messages).toEqual([])
    const again = await phone.ask('/fleet')
    expect(again.status).toBe(200)
  })

  it('takes a room that stopped saying it was there, and its messages with it', async () => {
    const { phone, table } = await paired()
    await phone.ask('/fleet')
    table.advance(RULES.idleHours * 3600 * 1000 + 1000)
    expect(table.rooms).toEqual([])
    expect(table.messages).toEqual([])
  })
})

describe('the things a real Realtime connection does that a stub never would', () => {
  it('fetches a reply too big to arrive on the wire, instead of dropping it', async () => {
    // a postgres_changes payload over max_record_bytes arrives with no row content at all
    const { phone, table } = await paired({ realtimeMaxBytes: 2048 })
    const answer = await phone.ask('/big')
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body).diff).toHaveLength(8192)
    expect(table.messages.some((m) => m.dir === 'm2p' && m.ct.length > 2048)).toBe(true)
  })

  it('keeps the host alive when the database is unreachable, and says so in one line', async () => {
    const { phone, mac, table } = await paired()
    await phone.ask('/fleet')
    // the answer's direction only: the request still lands, so the Mac ends up holding a reply
    // with nowhere to put it, which is the case that must not take the host down with it
    table.fail('the relay is unreachable', { dir: 'm2p' })
    await expect(phone.ask('/fleet', { timeout: 200 })).rejects.toThrow(/no answer/)
    expect(mac.status().detail ?? '').toMatch(/could not reach the relay/)
    table.up()
    const answer = await phone.ask('/fleet')
    expect(answer.status).toBe(200)
  })

  it('stops reading the room when remote access is taken back', async () => {
    const { phone, mac, table } = await paired()
    expect(table.subscribers).toBeGreaterThan(0)
    await mac.carry(false)
    expect(mac.status().carrying).toBe(false)
    await expect(phone.ask('/fleet', { timeout: 200 })).rejects.toThrow(/no answer/)
  })
})
