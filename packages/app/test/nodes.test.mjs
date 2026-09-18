import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNodeRouter, LOCAL } from '../nodes.mjs'

/** a stand-in agent host: lists its sessions and terminals, and answers only with its token */
function fakeHost(token, sessions, terms = []) {
  const seen = []
  const server = createServer((req, res) => {
    seen.push(req.url)
    if (req.headers['x-agent-token'] !== token) {
      res.writeHead(401)
      return res.end()
    }
    const body =
      req.url === '/sessions' ? sessions : req.url === '/terms' ? terms : req.url === '/health?machine=1' ? { ok: true, sessions: sessions.length, machine: { cores: 8 } } : { url: req.url }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  return { server, seen, token }
}

const listen = (h) => new Promise((ok) => h.server.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${h.server.address().port}`)))

describe('node router', () => {
  const mac = fakeHost('mac-token', [{ id: 'a' }])
  const box = fakeHost('box-token', [{ id: 'b' }], [{ id: 't' }])
  const bases = {}
  const forgotten = []
  let offline = false
  const router = createNodeRouter({
    ids: () => [LOCAL, 'box1'],
    reach: async (node) => {
      if (node === 'box1' && offline) throw new Error('box1 is not connected')
      return node === LOCAL ? { base: bases.mac, token: mac.token } : { base: bases.box, token: box.token }
    },
    forget: (node) => forgotten.push(node),
  })

  beforeAll(async () => {
    bases.mac = await listen(mac)
    bases.box = await listen(box)
  })
  afterAll(() => {
    mac.server.close()
    box.server.close()
  })

  it('lists every machine, each item tagged with its machine', async () => {
    offline = false
    expect(await router.list('sessions')).toEqual([
      { id: 'a', node: LOCAL },
      { id: 'b', node: 'box1' },
    ])
  })

  it('finds the machine of an id it has not seen by asking every machine', async () => {
    const fresh = createNodeRouter({ ids: () => [LOCAL, 'box1'], reach: async (n) => (n === LOCAL ? { base: bases.mac, token: mac.token } : { base: bases.box, token: box.token }) })
    expect(await fresh.where('t')).toBe('box1')
    expect(await fresh.where('b')).toBe('box1')
    expect(await fresh.where('nowhere')).toBe(LOCAL)
  })

  it('sends a call to the machine with that machine’s token', async () => {
    const r = await router.call('box1', '/sessions/b/message', { method: 'POST' })
    expect(await r.json()).toEqual({ url: '/sessions/b/message' })
    expect(box.seen).toContain('/sessions/b/message')
    expect(mac.seen).not.toContain('/sessions/b/message')
  })

  it('leaves an offline machine out of lists but fails when this Mac cannot answer', async () => {
    offline = true
    expect(await router.list('sessions')).toEqual([{ id: 'a', node: LOCAL }])
    const broken = createNodeRouter({ reach: async () => ({ base: 'http://127.0.0.1:1', token: 'x' }), forget: (n) => forgotten.push(n) })
    await expect(broken.list('sessions')).rejects.toThrow()
    expect(forgotten).toContain(LOCAL)
  })

  it('reports each machine online or not', async () => {
    offline = true
    expect(await router.status()).toEqual([
      { id: LOCAL, online: true, sessions: 1, machine: { cores: 8 } },
      { id: 'box1', online: false, error: 'box1 is not connected' },
    ])
  })

  it('forgets a dropped id and falls back to this Mac once no machine has it', async () => {
    offline = false
    router.remember('gone', 'box1')
    expect(await router.where('gone')).toBe('box1')
    router.drop('gone')
    expect(await router.where('gone')).toBe(LOCAL)
  })
})
