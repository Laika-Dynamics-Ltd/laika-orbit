import { describe, expect, it } from 'vitest'
import { createLanTransport } from '../lan-transport.mjs'
import { createSwitchboard, isTransport } from '../transport.mjs'

/**
 * The wire a phone arrives on, as a thing with four calls. What is worth testing is not that a
 * socket binds — node does that — but the rules the app leans on: loopback until something asks
 * otherwise, the port kept across a move, and one wire's failure kept away from the others.
 */
const hit = async (t, path = '/x') => {
  const { port } = t.status()
  const r = await fetch(`http://127.0.0.1:${port}${path}`)
  return { status: r.status, body: await r.text() }
}

const lanFor = (env = {}) =>
  createLanTransport({
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`saw ${req.url} from ${req.socket.remoteAddress}`)
    },
    env,
    address: () => '192.168.1.31',
  })

describe('the local link as a transport', () => {
  it('answers the four calls', () => {
    expect(isTransport(lanFor())).toBe(true)
    for (const not of [null, {}, { name: 'x' }, { name: 'x', open: 1, carry: 1, close: 1, status: 1 }]) expect(isTransport(not)).toBe(false)
  })

  it('holds loopback until something asks otherwise', async () => {
    const t = lanFor()
    try {
      const up = await t.open()
      expect(up).toMatchObject({ name: 'lan', carrying: false, host: null, bind: '127.0.0.1' })
      expect(up.port).toBeGreaterThan(0)
      expect(await hit(t)).toMatchObject({ status: 200 })
    } finally {
      await t.close()
    }
  })

  it('launches carrying only when AGENT_LAN is exactly 1', async () => {
    for (const [env, carrying] of [
      [{ AGENT_LAN: '1' }, true],
      [{ AGENT_LAN: '0' }, false],
      [{ AGENT_LAN: 'true' }, false],
      [{ AGENT_LAN: 'yes' }, false],
      [{}, false],
    ]) {
      const t = lanFor(env)
      try {
        expect((await t.open()).carrying, JSON.stringify(env)).toBe(carrying)
      } finally {
        await t.close()
      }
    }
  })

  it('keeps the port across a move, so a paired phone finds the same address again', async () => {
    const t = lanFor()
    try {
      const { port } = await t.open()
      const on = await t.carry(true)
      expect(on).toMatchObject({ carrying: true, host: '192.168.1.31', port })
      // still answering, on the same port, from the same handler
      expect(await hit(t)).toMatchObject({ status: 200 })
      const off = await t.carry(false)
      expect(off).toMatchObject({ carrying: false, host: null, port })
      expect(await hit(t)).toMatchObject({ status: 200 })
    } finally {
      await t.close()
    }
  })

  it('does nothing when asked for the state it is already in', async () => {
    const t = lanFor()
    try {
      await t.open()
      const a = await t.carry(false)
      const b = await t.carry(false)
      expect(a).toEqual(b)
    } finally {
      await t.close()
    }
  })

  it('takes only a literal true as a reason to carry', async () => {
    const t = lanFor()
    try {
      await t.open()
      for (const sloppy of ['1', 'true', 1, {}, undefined]) {
        expect((await t.carry(sloppy)).carrying, String(sloppy)).toBe(false)
      }
    } finally {
      await t.close()
    }
  })

  it('refuses to be built without a handler', () => {
    expect(() => createLanTransport({})).toThrow(/handler/)
  })
})

describe('the switchboard', () => {
  const fake = (name, { openFails = false } = {}) => {
    let carrying = false
    let open = false
    return {
      name,
      open: async () => {
        if (openFails) throw new Error(`${name} would not open`)
        open = true
        return { name, carrying, host: null, port: null, open }
      },
      carry: async (on) => {
        carrying = on === true
        return { name, carrying, host: null, port: null }
      },
      close: async () => {
        open = false
        return { name, carrying: false, host: null, port: null }
      },
      status: () => ({ name, carrying, host: null, port: null, open }),
    }
  }

  it('refuses anything that is not a transport', () => {
    expect(() => createSwitchboard([{ name: 'bad' }])).toThrow(/not a transport/)
  })

  it('carries wires by name, independently', async () => {
    const wires = createSwitchboard([fake('lan'), fake('relay')])
    await wires.open()
    expect(wires.names).toEqual(['lan', 'relay'])
    expect(wires.carrying).toBe(false)
    await wires.carry('relay', true)
    expect(wires.statusOf('lan').carrying).toBe(false)
    expect(wires.statusOf('relay').carrying).toBe(true)
    expect(wires.carrying).toBe(true)
  })

  it('keeps one wire failing to open away from the other', async () => {
    const wires = createSwitchboard([fake('lan'), fake('relay', { openFails: true })])
    const [lan, relay] = await wires.open()
    expect(lan.open).toBe(true)
    expect(relay.detail).toMatch(/would not open/)
    // and the failure is a line to read, not a wire that vanished
    expect(wires.has('relay')).toBe(true)
    await wires.close()
  })

  it('will not carry a wire it does not have', async () => {
    const wires = createSwitchboard([fake('lan')])
    await expect(wires.carry('relay', true)).rejects.toThrow(/no such transport/)
  })
})
