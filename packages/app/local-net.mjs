/**
 * The local link, and the gate that stands in front of a server put on it.
 *
 * Two things in this app listen to something other than loopback — the drop zone (drop.mjs) and,
 * when it is turned on, the agent host (agent-host.mjs) — and both must answer the machines in
 * the room and nothing else. That is one rule, so it is one piece of code: a second copy of an
 * address check is a second chance to get it subtly different, and the difference is the hole.
 *
 * `refuseRequest` is the agent host's whole front door, in the order that matters. The address is
 * checked first and the token second, so a request from off the link is turned away before it can
 * time a comparison against the token, and every route behind it is reached only by something on
 * this network holding this launch's secret.
 */
import { timingSafeEqual } from 'node:crypto'
import { networkInterfaces } from 'node:os'

/**
 * Is this address on the local link? Private IPv4 (10/8, 172.16/12, 192.168/16), link-local
 * (169.254/16, fe80::/10), unique-local IPv6 (fc00::/7) and loopback — nothing else, so a request
 * that arrived from the internet is refused before anything else looks at it.
 */
export function isLocalAddress(addr) {
  if (!addr) return false
  let a = String(addr).trim().toLowerCase()
  if (a.startsWith('::ffff:')) a = a.slice(7)
  const zone = a.indexOf('%')
  if (zone > 0) a = a.slice(0, zone)
  if (a === '::1' || a === 'localhost') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a)
  if (v4) {
    if (v4.slice(1).some((n) => Number(n) > 255)) return false
    const [x, y] = [Number(v4[1]), Number(v4[2])]
    return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254)
  }
  return /^f[cd][0-9a-f]{0,2}[:0-9a-f]/.test(a) || /^fe[89ab][0-9a-f]?[:0-9a-f]/.test(a)
}

/**
 * Where the agent host listens. Loopback unless AGENT_LAN is exactly "1": every other value,
 * including "0", "true", "yes" and a typo, means the fleet stays on this machine. An opt-in that
 * can be tripped by a stray value is not one.
 */
export const bindAddress = (env = process.env) => (env.AGENT_LAN === '1' ? '0.0.0.0' : '127.0.0.1')

/** the presented token against the real one, in constant time, and never a length that throws */
export function tokenOk(presented, token) {
  const got = Buffer.from(String(presented ?? ''))
  const want = Buffer.from(String(token ?? ''))
  return want.length > 0 && got.length === want.length && timingSafeEqual(got, want)
}

/**
 * The reason to refuse a request, or null to let it through: address first, then token. Returning
 * the same 401 for a token that is missing, short, long or simply wrong keeps the answer from
 * saying which.
 */
export function refuseRequest(req, token) {
  if (!isLocalAddress(req?.socket?.remoteAddress)) return { code: 403, body: { error: 'this port answers the local network only' } }
  if (!tokenOk(req?.headers?.['x-agent-token'], token)) return { code: 401, body: { error: 'unauthorised' } }
  return null
}

/** this machine's address on the link, for a phone to be pointed at; null when there is no network */
export const lanAddress = (nets = networkInterfaces()) =>
  Object.values(nets)
    .flat()
    .find((n) => n && n.family === 'IPv4' && !n.internal && isLocalAddress(n.address))?.address ?? null

/**
 * Move a listening server from one address to another without restarting the process — how the
 * agent host starts and stops answering the network while its chats stay open and running.
 *
 * Open connections are cut rather than waited for: one of them is the request that asked for this,
 * and the others are exactly what a stop is meant to end. The port is kept, so a phone that was
 * paired before a stop finds the same address afterwards.
 */
export async function rebind(server, { port, bind }) {
  server.closeAllConnections?.()
  await new Promise((ok, fail) => server.close((e) => (e ? fail(e) : ok())))
  await new Promise((ok, fail) => {
    const failed = (e) => fail(e)
    server.once('error', failed)
    server.listen(port, bind, () => {
      server.off('error', failed)
      ok()
    })
  })
  return server.address()
}
