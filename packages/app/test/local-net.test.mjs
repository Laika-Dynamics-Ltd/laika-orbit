import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bindAddress, isLocalAddress, refuseRequest, tokenOk } from '../local-net.mjs'

/**
 * The gate in front of the agent host — the process that can halt the fleet and flip autopilot.
 * These are the refusals, which are the part worth testing: the address first, the token second,
 * and nothing behind them reached by anything that fails either.
 */
const TOKEN = 'a'.repeat(48)
const req = (address, token) => ({ socket: { remoteAddress: address }, headers: token === undefined ? {} : { 'x-agent-token': token } })

describe('what counts as the local link', () => {
  it('takes private, link-local and loopback addresses', () => {
    for (const a of ['192.168.1.20', '10.0.0.4', '172.16.9.1', '172.31.255.254', '169.254.3.3', '127.0.0.1', '::1', '::ffff:192.168.1.20', 'fe80::1c2b%en0', 'fd12:3456::1'])
      expect(isLocalAddress(a), a).toBe(true)
  })

  it('takes nothing else', () => {
    for (const a of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '203.0.113.7', '2606:4700::1111', '999.1.1.1', '1.2.3.4', '', null, undefined])
      expect(isLocalAddress(a), String(a)).toBe(false)
  })
})

describe('the agent host front door', () => {
  it('lets through a request from the link holding the token', () => {
    expect(refuseRequest(req('192.168.1.31', TOKEN), TOKEN)).toBe(null)
    expect(refuseRequest(req('127.0.0.1', TOKEN), TOKEN)).toBe(null)
  })

  it('refuses a request with no token at all', () => {
    expect(refuseRequest(req('192.168.1.31'), TOKEN)).toEqual({ code: 401, body: { error: 'unauthorised' } })
    expect(refuseRequest(req('192.168.1.31', ''), TOKEN)).toMatchObject({ code: 401 })
  })

  it('refuses a wrong token, however nearly right', () => {
    for (const bad of [`${TOKEN}x`, TOKEN.slice(0, -1), TOKEN.slice(0, 32), `${'a'.repeat(47)}b`, TOKEN.toUpperCase()]) expect(refuseRequest(req('10.0.0.9', bad), TOKEN), bad).toMatchObject({ code: 401 })
  })

  it('refuses an address off the link before it ever looks at the token', () => {
    // the token here is the real one: what is being refused is where it came from
    expect(refuseRequest(req('203.0.113.7', TOKEN), TOKEN)).toEqual({ code: 403, body: { error: 'this port answers the local network only' } })
    expect(refuseRequest(req('8.8.8.8', TOKEN), TOKEN)).toMatchObject({ code: 403 })
    // and a socket with no address at all is not on the link either
    expect(refuseRequest({ headers: { 'x-agent-token': TOKEN } }, TOKEN)).toMatchObject({ code: 403 })
  })

  it('never accepts an empty or missing host token, whatever is presented', () => {
    expect(tokenOk('', '')).toBe(false)
    expect(tokenOk(undefined, undefined)).toBe(false)
    expect(refuseRequest(req('127.0.0.1', ''), '')).toMatchObject({ code: 401 })
  })
})

describe('the gate on a real socket', () => {
  let base
  const server = createServer((r, res) => {
    const refused = refuseRequest(r, TOKEN)
    if (refused) {
      res.writeHead(refused.code, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(refused.body))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"halt":"the fleet"}')
  })

  beforeAll(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(async () => {
    await new Promise((ok) => server.close(ok))
  })

  it('answers the fleet only to a request carrying the token', async () => {
    expect((await fetch(base)).status).toBe(401)
    expect((await fetch(base, { headers: { 'x-agent-token': 'not-it' } })).status).toBe(401)
    const ok = await fetch(base, { headers: { 'x-agent-token': TOKEN } })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ halt: 'the fleet' })
  })
})

describe('where the agent host listens', () => {
  it('stays on loopback unless it is asked, in as many words', () => {
    expect(bindAddress({})).toBe('127.0.0.1')
    for (const v of ['0', '', 'true', 'yes', 'on', 'lan', '2', ' 1']) expect(bindAddress({ AGENT_LAN: v }), v).toBe('127.0.0.1')
    expect(bindAddress({ AGENT_LAN: '1' })).toBe('0.0.0.0')
  })
})

/**
 * The real thing: bound the way AGENT_LAN=1 binds it, reached over this machine's own network
 * address rather than loopback. Skipped where there is no private address to reach it on.
 */
const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((n) => n && n.family === 'IPv4' && !n.internal && isLocalAddress(n.address))?.address

describe.skipIf(!lanIp)('bound to the network, as the phone would find it', () => {
  let port
  const server = createServer((r, res) => {
    const refused = refuseRequest(r, TOKEN)
    if (refused) {
      res.writeHead(refused.code, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(refused.body))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ from: r.socket.remoteAddress }))
  })

  beforeAll(async () => {
    await new Promise((ok) => server.listen(0, bindAddress({ AGENT_LAN: '1' }), ok))
    port = server.address().port
  })
  afterAll(async () => {
    await new Promise((ok) => server.close(ok))
  })

  it('answers a machine on the link that holds the token, and refuses one that does not', async () => {
    const at = `http://${lanIp}:${port}`
    expect((await fetch(at)).status).toBe(401)
    const ok = await fetch(at, { headers: { 'x-agent-token': TOKEN } })
    expect(ok.status).toBe(200)
    // it really did arrive over the network rather than through loopback
    expect(isLocalAddress((await ok.json()).from)).toBe(true)
  })
})
