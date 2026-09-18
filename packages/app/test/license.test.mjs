import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
process.env.ORBIT_LICENSE_PUBKEY = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const { decide, readKey, mask, GRACE_DAYS } = await import('../license.mjs')

const b64u = (b) => Buffer.from(b).toString('base64url')
function makeKey(payload, key = privateKey) {
  const body = b64u(JSON.stringify(payload))
  return `LO1.${body}.${b64u(sign(null, Buffer.from(`LO1.${body}`), key))}`
}
const GOOD = { v: 1, lid: 'lic_1', sub: 'sub_1', cus: 'cus_1', plan: 'pro', iat: 1789600000 }
const DAY = 86_400_000

describe('reading a key', () => {
  it('accepts one signed by the site', () => expect(readKey(makeKey(GOOD))).toMatchObject({ sub: 'sub_1', plan: 'pro' }))

  it('rejects a forged signature, a tampered payload and junk', () => {
    const other = generateKeyPairSync('ed25519').privateKey
    expect(readKey(makeKey(GOOD, other))).toBe(null)
    const [p, body, s] = makeKey(GOOD).split('.')
    const swapped = b64u(JSON.stringify({ ...GOOD, sub: 'sub_someone_else' }))
    expect(readKey(`${p}.${swapped}.${s}`)).toBe(null)
    for (const junk of ['', 'LO1', 'not a key', 'LO2.a.b']) expect(readKey(junk)).toBe(null)
  })

  it('rejects a key for another product', () => expect(readKey(makeKey({ ...GOOD, plan: 'team' }))).toBe(null))
})

describe('what the app believes', () => {
  const now = Date.now()
  const state = (over = {}) => ({ key: makeKey(GOOD), valid: true, lastCheck: now, ...over })

  it('no key means no Pro', () => expect(decide(null)).toMatchObject({ pro: false, state: 'none' }))

  it('a genuine key checked just now is active', () => expect(decide(state(), now)).toMatchObject({ pro: true, state: 'active' }))

  it('keeps Pro on while offline, inside the grace period', () => {
    const d = decide(state({ lastCheck: now - 5 * DAY }), now)
    expect(d.pro).toBe(true)
    expect(d.state).toBe('grace')
    expect(d.detail).toMatch(/9 days/)
  })

  it('switches Pro off once the grace period runs out', () => {
    const d = decide(state({ lastCheck: now - (GRACE_DAYS + 1) * DAY }), now)
    expect(d).toMatchObject({ pro: false, state: 'stale' })
  })

  it('switches Pro off when the site says the subscription stopped', () => {
    const d = decide(state({ valid: false, status: 'canceled' }), now)
    expect(d).toMatchObject({ pro: false, state: 'inactive' })
    expect(d.detail).toMatch(/canceled/)
  })

  it('a key that is not genuine never counts, however fresh the check', () => {
    const forged = makeKey(GOOD, generateKeyPairSync('ed25519').privateKey)
    expect(decide({ key: forged, valid: true, lastCheck: now }, now)).toMatchObject({ pro: false, state: 'invalid' })
  })
})

describe('showing a key back', () => {
  it('never shows the whole thing', () => {
    const key = makeKey(GOOD)
    const shown = mask(key)
    expect(shown).not.toContain(key.split('.')[2])
    expect(shown.length).toBeLessThan(20)
    expect(mask('')).toBe(null)
  })
})
