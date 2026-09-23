import { describe, expect, it } from 'vitest'
import { createOpener, createSealer, relayKeys, sealedChannel, TO_MAC, TO_PHONE, VERSION } from '../sealed-envelope.mjs'

/**
 * The seal is the whole of the local-first claim once a database is in the middle, so the tests
 * that matter are the ones where something goes wrong: a wrong key, an edited row, a message
 * played twice, a whole conversation replayed a day later, a pipe that answers with rubbish.
 * The happy path is one test. The rest of this file is the refusals.
 */
const SECRET = 'f'.repeat(48)
const OTHER = 'a'.repeat(48)
const pair = (opts = {}) => ({ phone: sealedChannel({ secret: SECRET, side: 'phone', ...opts }), mac: sealedChannel({ secret: SECRET, side: 'mac', ...opts }) })

describe('the key comes from the pairing and goes nowhere back', () => {
  it('gives a room and a key each way, the same on both machines', () => {
    const a = relayKeys(SECRET)
    const b = relayKeys(SECRET)
    expect(a.room).toEqual(b.room)
    expect(a[TO_MAC].equals(b[TO_MAC])).toBe(true)
    expect(a[TO_PHONE].equals(b[TO_PHONE])).toBe(true)
  })

  it('never repeats itself across secrets, directions or the room', () => {
    const a = relayKeys(SECRET)
    const b = relayKeys(OTHER)
    const all = [a.room, b.room, a[TO_MAC].toString('hex'), a[TO_PHONE].toString('hex'), b[TO_MAC].toString('hex'), b[TO_PHONE].toString('hex')]
    expect(new Set(all).size).toBe(all.length)
  })

  it('leaks nothing of the secret into the room id or the keys', () => {
    const k = relayKeys(SECRET)
    for (const derived of [k.room, k[TO_MAC].toString('hex'), k[TO_PHONE].toString('hex')]) expect(derived).not.toContain(SECRET.slice(0, 16))
  })

  it('refuses a secret too short to be a pairing token', () => {
    for (const weak of ['', 'hunter2', 'a'.repeat(31), null, undefined]) expect(() => relayKeys(weak), String(weak)).toThrow(/at least 32/)
  })
})

describe('what a database is given', () => {
  it('holds ciphertext and routing, and no part of the message', () => {
    const { phone } = pair()
    const e = phone.seal({ title: 'Fixing the Toaster repo', cwd: '/Users/sam/code/toaster', prompt: 'rename the widget' })
    expect(Object.keys(e).sort()).toEqual(['ct', 'dir', 'n', 'seq', 'v'])
    const row = JSON.stringify(e)
    for (const secretish of ['Toaster', 'toaster', 'widget', '/Users/sam', 'rename', 'title', 'prompt']) expect(row, secretish).not.toContain(secretish)
  })

  it('rounds the length up, so a short answer is not distinguishable from a shorter one', () => {
    const { mac } = pair()
    const size = (payload) => mac.seal(payload).ct.length
    expect(size('yes')).toBe(size('no'))
    expect(size({ a: 1 })).toBe(size({ a: 1, b: 2, c: 3 }))
    // and still grows for something genuinely large, rather than hiding it at any price
    expect(size({ big: 'x'.repeat(40_000) })).toBeGreaterThan(size('yes'))
  })

  it('never reuses a nonce, even with the same key and the same message', () => {
    const { phone } = pair()
    const nonces = new Set()
    for (let i = 0; i < 500; i++) nonces.add(phone.seal('same every time').n)
    expect(nonces.size).toBe(500)
  })

  it('starts a fresh stream each time a side is built, because a token can outlive a process', () => {
    const streamOf = (e) => Buffer.from(e.n, 'base64url').subarray(0, 8).toString('hex')
    const a = sealedChannel({ secret: SECRET, side: 'mac' }).seal('x')
    const b = sealedChannel({ secret: SECRET, side: 'mac' }).seal('x')
    expect(a.seq).toBe(b.seq)
    expect(streamOf(a)).not.toBe(streamOf(b))
  })
})

describe('the happy path', () => {
  it('carries a payload each way, unchanged', () => {
    const { phone, mac } = pair()
    expect(phone.room).toBe(mac.room)
    const up = mac.open(phone.seal({ path: '/sessions', body: { cwd: '/tmp' } }))
    expect(up).toMatchObject({ ok: true, seq: 1, payload: { path: '/sessions', body: { cwd: '/tmp' } } })
    const down = phone.open(mac.seal({ status: 200, events: ['a', 'b'] }))
    expect(down).toMatchObject({ ok: true, payload: { status: 200, events: ['a', 'b'] } })
  })

  it('carries what JSON carries, including nothing at all', () => {
    const { phone, mac } = pair()
    for (const payload of [null, 0, '', false, [], {}, { nested: { deep: [1, 2, { x: 'y' }] } }]) expect(mac.open(phone.seal(payload)).payload, JSON.stringify(payload)).toEqual(payload)
  })
})

describe('the refusals', () => {
  const sealed = () => {
    const { phone, mac } = pair()
    return { mac, e: phone.seal({ secret: 'the repo name' }) }
  }

  it('will not open a message sealed for another pairing', () => {
    const { mac } = pair()
    const stranger = sealedChannel({ secret: OTHER, side: 'phone' })
    expect(mac.open(stranger.seal('let me in'))).toEqual({ ok: false, reason: 'sealed' })
  })

  it('will not open a message whose ciphertext was edited', () => {
    const { mac, e } = sealed()
    const ct = Buffer.from(e.ct, 'base64url')
    for (const at of [0, 1, Math.floor(ct.length / 2), ct.length - 1]) {
      const bent = Buffer.from(ct)
      bent[at] ^= 1
      expect(mac.open({ ...e, ct: bent.toString('base64url') }), `byte ${at}`).toEqual({ ok: false, reason: 'sealed' })
    }
  })

  it('will not open a message whose authentication tag was edited', () => {
    const { mac, e } = sealed()
    const ct = Buffer.from(e.ct, 'base64url')
    ct[ct.length - 3] ^= 0x80
    expect(mac.open({ ...e, ct: ct.toString('base64url') })).toEqual({ ok: false, reason: 'sealed' })
  })

  it('will not let the database renumber a message', () => {
    // seq is in the clear because the pipe routes on it; it is also under the seal, so moving it
    // breaks the message rather than moving it in the window
    const { phone, mac } = pair()
    phone.seal('one')
    const e = phone.seal('two')
    expect(mac.open({ ...e, seq: 9 })).toEqual({ ok: false, reason: 'malformed' })
    const n = Buffer.from(e.n, 'base64url')
    n.writeUInt32BE(9, 8)
    expect(mac.open({ ...e, seq: 9, n: n.toString('base64url') })).toEqual({ ok: false, reason: 'sealed' })
  })

  it('will not let the database change the nonce', () => {
    const { mac, e } = sealed()
    const n = Buffer.from(e.n, 'base64url')
    n[0] ^= 1
    expect(mac.open({ ...e, n: n.toString('base64url') })).toEqual({ ok: false, reason: 'sealed' })
  })

  it('refuses a message sent the way it did not come', () => {
    // the reflection attack: our own message written back into the pipe we read
    const { mac } = pair()
    const mine = mac.seal('a result of mine')
    expect(mac.open(mine)).toEqual({ ok: false, reason: 'direction' })
    expect(mac.open({ ...mine, dir: TO_MAC })).toEqual({ ok: false, reason: 'sealed' })
  })

  it('refuses a version it does not know', () => {
    const { mac, e } = sealed()
    for (const v of [0, 2, '1', null, undefined]) expect(mac.open({ ...e, v }), String(v)).toEqual({ ok: false, reason: 'version' })
    expect(VERSION).toBe(1)
  })

  it('refuses rubbish without throwing, because a hostile pipe is the expected case', () => {
    const { mac } = pair()
    for (const junk of [null, undefined, 0, '', 'hello', [], {}, { v: 1 }, { v: 1, dir: TO_MAC, seq: 1, n: 'x', ct: 'y' }, { v: 1, dir: TO_MAC, seq: 1.5, n: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAAAAAAAAAAAAAAA' }])
      expect(mac.open(junk), JSON.stringify(junk) ?? String(junk)).toMatchObject({ ok: false })
  })

  it('refuses a truncated envelope rather than reading past it', () => {
    const { mac, e } = sealed()
    expect(mac.open({ ...e, ct: Buffer.from(e.ct, 'base64url').subarray(0, 12).toString('base64url') })).toEqual({ ok: false, reason: 'malformed' })
    expect(mac.open({ ...e, n: Buffer.from(e.n, 'base64url').subarray(0, 8).toString('base64url') })).toEqual({ ok: false, reason: 'malformed' })
  })
})

describe('the same message twice', () => {
  it('takes it once and refuses it after', () => {
    const { phone, mac } = pair()
    const e = phone.seal({ cmd: 'halt the fleet' })
    expect(mac.open(e).ok).toBe(true)
    expect(mac.open(e)).toEqual({ ok: false, reason: 'replay' })
    expect(mac.open(e)).toEqual({ ok: false, reason: 'replay' })
  })

  it('still takes messages that arrive out of order, as a pipe may deliver them', () => {
    const { phone, mac } = pair()
    const es = [1, 2, 3, 4, 5].map((i) => phone.seal(i))
    for (const e of [es[2], es[0], es[4], es[1], es[3]]) expect(mac.open(e).ok, `seq ${e.seq}`).toBe(true)
    expect(mac.open(es[3])).toEqual({ ok: false, reason: 'replay' })
  })

  it('refuses one so far behind that remembering it is no longer affordable', () => {
    const { phone, mac } = pair({ window: 8 })
    const first = phone.seal('the old one')
    for (let i = 0; i < 20; i++) expect(mac.open(phone.seal(i)).ok).toBe(true)
    expect(mac.open(first)).toEqual({ ok: false, reason: 'stale' })
  })

  it('refuses a whole old stream played back later, which no window can catch', () => {
    let clock = 1_000_000_000_000
    const phone = sealedChannel({ secret: SECRET, side: 'phone', now: () => clock })
    const captured = [phone.seal('open the repo'), phone.seal('halt the fleet')]
    // a fresh Mac, hours later: the window knows nothing of this stream, the clock does
    clock += 6 * 60 * 60 * 1000
    const mac = sealedChannel({ secret: SECRET, side: 'mac', now: () => clock })
    for (const e of captured) expect(mac.open(e)).toEqual({ ok: false, reason: 'stale' })
  })

  it('refuses one stamped too far in the future, while allowing a phone a little fast', () => {
    let clock = 1_000_000_000_000
    const phone = sealedChannel({ secret: SECRET, side: 'phone', now: () => clock })
    const soon = phone.seal('ten seconds ahead')
    const wayOff = (() => {
      clock += 60 * 60 * 1000
      return phone.seal('an hour ahead')
    })()
    const mac = sealedChannel({ secret: SECRET, side: 'mac', now: () => 1_000_000_010_000 })
    expect(mac.open(soon).ok).toBe(true)
    expect(mac.open(wayOff)).toEqual({ ok: false, reason: 'stale' })
  })
})

describe('what the Mac can say about what it turned away', () => {
  it('counts the refusals by reason, so a panel can show them', () => {
    const { phone, mac } = pair()
    const good = phone.seal('fine')
    mac.open(good)
    mac.open(good)
    mac.open({ ...good, v: 7 })
    mac.open(sealedChannel({ secret: OTHER, side: 'phone' }).seal('nope'))
    mac.open('rubbish')
    expect(mac.refused).toMatchObject({ replay: 1, version: 1, sealed: 1, malformed: 1, stale: 0, direction: 0 })
  })

  it('forgets old streams rather than growing without limit', () => {
    const opener = createOpener({ key: relayKeys(SECRET)[TO_MAC], dir: TO_MAC })
    for (let i = 0; i < 200; i++) {
      const s = createSealer({ key: relayKeys(SECRET)[TO_MAC], dir: TO_MAC })
      expect(opener.open(s.seal(i)).ok).toBe(true)
    }
    expect(opener.streams).toBeLessThanOrEqual(64)
  })
})

describe('what cannot be built at all', () => {
  it('refuses a side it does not know', () => {
    for (const side of ['server', 'client', '', null]) expect(() => sealedChannel({ secret: SECRET, side }), String(side)).toThrow(/not a side/)
  })

  it('refuses a direction it does not know, and a key of the wrong size', () => {
    const k = relayKeys(SECRET)
    expect(() => createSealer({ key: k[TO_MAC], dir: 'sideways' })).toThrow(/not a direction/)
    expect(() => createOpener({ key: k[TO_MAC], dir: 'sideways' })).toThrow(/not a direction/)
    expect(() => createSealer({ key: Buffer.alloc(16), dir: TO_MAC })).toThrow(/32-byte key/)
    expect(() => createOpener({ key: 'a'.repeat(32), dir: TO_MAC })).toThrow(/32-byte key/)
  })

  it('wires each side to seal out and open in, and not the other way round', () => {
    const { phone, mac } = pair()
    expect([phone.out, phone.in]).toEqual([TO_MAC, TO_PHONE])
    expect([mac.out, mac.in]).toEqual([TO_PHONE, TO_MAC])
  })
})
