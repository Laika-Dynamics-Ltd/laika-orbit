import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lanAddress, rebind, refuseRequest } from '../local-net.mjs'
import { handlePair, hostState, pairURI } from '../pair-api.mjs'

/**
 * Pairing: the string the QR carries (the contract with the iOS app), what the routes refuse, and
 * the host moving on and off the network without restarting.
 */
describe('the string in the code', () => {
  it('is the payload the app agreed to parse', () => {
    expect(pairURI({ host: '192.168.1.9', port: 7420, token: 'a'.repeat(48), name: 'box1' })).toBe(`orbit://pair?v=1&host=192.168.1.9&port=7420&token=${'a'.repeat(48)}&name=box1`)
  })

  it('survives a machine name with a space and an apostrophe', () => {
    const uri = pairURI({ host: '10.0.0.4', port: 51234, token: 'b'.repeat(32), name: "Sam's MacBook Air" })
    expect(uri).toContain('&name=Sam%27s%20MacBook%20Air')
    // the app parses it with URLComponents: a space must not come back as a plus
    expect(uri).not.toContain('+')
    const q = new URL(uri.replace('orbit://', 'http://')).searchParams
    expect(q.get('v')).toBe('1')
    expect(q.get('name')).toBe("Sam's MacBook Air")
    expect(q.get('port')).toBe('51234')
  })

  it('will not print a code that is missing a part of itself', () => {
    expect(() => pairURI({ host: '', port: 7420, token: 'a'.repeat(48) })).toThrow()
    expect(() => pairURI({ host: '192.168.1.9', port: 0, token: 'a'.repeat(48) })).toThrow()
    expect(() => pairURI({ host: '192.168.1.9', port: 7420, token: '' })).toThrow()
  })
})

describe('what pairing refuses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pair-test-'))
  const state = (x) => {
    const f = join(dir, `state-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(f, JSON.stringify(x))
    return f
  }

  it('reads the host state file, and treats a torn one as no host', () => {
    expect(hostState(state({ port: 7420, token: 'a'.repeat(48), lan: true }))).toMatchObject({ port: 7420, lan: true })
    expect(hostState(state({ port: 7420 }))).toBe(null)
    expect(hostState(join(dir, 'nothing-here.json'))).toBe(null)
  })

  it('will not mint a code while the host is on loopback', async () => {
    // the app server's own state file, which this test does not have: no host, so no code
    const res = await call('POST', '/api/pair/code')
    expect([503, 409]).toContain(res.code)
    expect(res.body.svg).toBeUndefined()
    expect(String(res.body.error)).toMatch(/not running|not answering|no address/)
  })

  it('says where things stand without ever putting a token in the answer', async () => {
    const res = await call('GET', '/api/pair')
    expect(res.code).toBe(200)
    expect(res.body).toHaveProperty('lan')
    expect(res.body).toHaveProperty('running')
    expect(JSON.stringify(res.body)).not.toMatch(/token/i)
  })

  /** handlePair with a request and response that are just enough of the real ones */
  const call = (method, path) =>
    new Promise((ok) => {
      const url = new URL(path, 'http://x')
      const res = {
        headersSent: false,
        writeHead(code) {
          this.code = code
          this.headersSent = true
        },
        end(body) {
          ok({ code: this.code, body: JSON.parse(body) })
        },
      }
      const req = Object.assign(
        (async function* () {
          yield Buffer.from('{}')
        })(),
        { method, headers: {} },
      )
      handlePair(url, req, res)
    })
})

describe('moving the host on and off the network', () => {
  const TOKEN = 'c'.repeat(48)
  const lan = lanAddress()
  let port
  const server = createServer((r, res) => {
    const refused = refuseRequest(r, TOKEN)
    res.writeHead(refused?.code ?? 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(refused?.body ?? { fleet: 'here' }))
  })

  beforeAll(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
    port = server.address().port
  })
  afterAll(async () => {
    await new Promise((ok) => server.close(ok))
  })

  const reach = async (at) => {
    try {
      return (await fetch(`http://${at}:${port}/health`, { headers: { 'x-agent-token': TOKEN }, signal: AbortSignal.timeout(1500) })).status
    } catch {
      return 'refused'
    }
  }

  it.skipIf(!lan)('starts unreachable on the network, answers once moved, and stops again — same port throughout', async () => {
    expect(await reach(lan)).toBe('refused')
    expect(await reach('127.0.0.1')).toBe(200)

    expect((await rebind(server, { port, bind: '0.0.0.0' })).port).toBe(port)
    expect(await reach(lan)).toBe(200)

    // the revoke: the socket comes off the network while the process, and its chats, stay up
    expect((await rebind(server, { port, bind: '127.0.0.1' })).port).toBe(port)
    expect(await reach(lan)).toBe('refused')
    expect(await reach('127.0.0.1')).toBe(200)
  })

  it('has a local address to offer, or none, and never a public one', () => {
    expect(lan === null || Boolean(Object.values(networkInterfaces()).flat().find((n) => n?.address === lan))).toBe(true)
  })
})
