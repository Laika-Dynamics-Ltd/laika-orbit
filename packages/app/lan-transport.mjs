/**
 * The local link as a transport (transport.mjs): the wire the agent host has always used, now
 * behind the four calls a relay can also answer.
 *
 * Nothing here is new. The socket, the gate and the move between addresses are the same ones
 * local-net.mjs has always done; this file is where the host used to keep them inline, so that
 * `carry(true)` and a rebind to 0.0.0.0 are the same sentence from two directions.
 *
 * The rule it enforces is the old one: loopback unless something deliberately asked otherwise,
 * and a failed move lands on loopback rather than nowhere. A host that cannot hold the address
 * it was asked for must still hold the one that is always safe — the chats in it are mid-turn.
 */
import { createServer } from 'node:http'
import { bindAddress, lanAddress, rebind } from './local-net.mjs'

const LOOPBACK = '127.0.0.1'
const EVERYWHERE = '0.0.0.0'

/**
 * @param {Object} o
 * @param {(req: any, res: any) => void} o.handler  the host's whole front door
 * @param {number} [o.port]   0 picks a free one, as the host has always done
 * @param {Object} [o.env]    AGENT_LAN=1 here is the launch-time opt-in, and only "1"
 * @param {() => string|null} [o.address]  this machine on the link; injectable for tests
 */
export function createLanTransport({ handler, port = 0, env = process.env, address = lanAddress } = {}) {
  if (typeof handler !== 'function') throw new Error('a transport carries a handler')
  const server = createServer(handler)
  let bind = bindAddress(env)
  let listening = false

  const status = () => ({
    name: 'lan',
    carrying: listening && bind !== LOOPBACK,
    host: listening && bind !== LOOPBACK ? address() : null,
    port: listening ? (server.address()?.port ?? null) : null,
    bind,
  })

  const listen = (at, on) =>
    new Promise((ok, fail) => {
      const failed = (e) => fail(e)
      server.once('error', failed)
      server.listen(on, at, () => {
        server.off('error', failed)
        ok()
      })
    })

  return {
    name: 'lan',
    /** the raw server, for the few things that are genuinely about sockets and not about routes */
    server,
    status,

    async open() {
      if (listening) return status()
      await listen(bind, port)
      listening = true
      return status()
    },

    /**
     * Answer the local network, or stop. The port is kept either way, so a phone paired before a
     * stop finds the same address after a start — stopping revokes a route, not a pairing.
     *
     * Open connections are cut rather than drained: one of them is usually the request that asked
     * for this, and the rest are exactly what a stop is for.
     */
    async carry(on) {
      const want = on === true ? EVERYWHERE : LOOPBACK
      if (!listening || want === bind) return status()
      const at = server.address().port
      bind = want
      try {
        await rebind(server, { port: at, bind })
      } catch (e) {
        // the port went while it was unbound: back to loopback, which is always safe to hold
        bind = LOOPBACK
        await rebind(server, { port: at, bind: LOOPBACK }).catch(() => {
          listening = false
        })
        throw new Error(`could not move to ${want}: ${e?.message ?? e}`)
      }
      return status()
    },

    async close() {
      if (!listening) return status()
      server.closeAllConnections?.()
      await new Promise((ok) => server.close(() => ok()))
      listening = false
      return status()
    },
  }
}
