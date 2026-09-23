/**
 * How a paired phone reaches this Mac's agent host — the shape of it, not one way of doing it.
 *
 * There is one fleet and one front door: the request handler in agent-host.mjs. What changes is
 * the wire a request arrives on. Today that is the local network (lan-transport.mjs): the phone
 * and the Mac are in the same room, so the phone opens a socket. That is the fast path and the
 * one that still works when the internet does not, so it stays the default.
 *
 * Away from the room there is no socket to open — no port forwarding, no relay of our own to
 * host — so the Mac instead holds an *outbound* connection to a database and reads the requests
 * the phone left there (relay-transport.mjs). Same handler, same routes, same token; a different
 * wire underneath.
 *
 * Hence this file: the four calls both wires answer, so the panel, the pairing switch and the
 * host itself never learn which one is carrying.
 *
 *   open()        bring the wire up in the state it should launch in. Answers a status.
 *   carry(on)     start or stop answering remote peers, without dropping what is already open.
 *                 This is the /lan route's `{ on }` exactly: a deliberate act, both ways.
 *   close()       take the wire down for good; the process is going.
 *   status()      { name, carrying, host, port, detail } — what the pairing panel draws.
 *
 * A transport is built with a node-style `handler(req, res)` and nothing else it could route
 * with. That is on purpose: a transport that knew what `/sessions` meant would be a second copy
 * of the host, and a second copy is where the two drift apart. The LAN transport hands the
 * handler real sockets; the relay transport hands it a request it built from a sealed message
 * and collects the answer, which is why both can be the same handler.
 *
 * `carrying` is the word the whole app uses for "reachable from off this machine", and it is
 * false until something deliberately asks otherwise. An update must never be what puts a fleet
 * on a café wifi, and it must never be what puts one in a database either.
 */

/**
 * @typedef {Object} TransportStatus
 * @property {string} name       which wire: 'lan', 'relay'
 * @property {boolean} carrying  is it answering peers off this machine right now
 * @property {string|null} host  where a peer should look, when that is a place at all
 * @property {number|null} port  the port, when the wire has one
 * @property {string} [detail]   one line a person can read when something is off
 */

/**
 * @typedef {Object} Transport
 * @property {string} name
 * @property {() => Promise<TransportStatus>} open
 * @property {(on: boolean) => Promise<TransportStatus>} carry
 * @property {() => Promise<TransportStatus>} close
 * @property {() => TransportStatus} status
 */

const CALLS = ['open', 'carry', 'close', 'status']

/** Does this object answer the four calls? Used where a wire is accepted from outside this file. */
export const isTransport = (t) => Boolean(t) && typeof t.name === 'string' && CALLS.every((c) => typeof t[c] === 'function')

/**
 * Every wire this host has, driven as one.
 *
 * The host has more than one from the moment a relay exists, and they are not alternatives: a
 * phone on the sofa should take the LAN, the same phone on a train should take the relay, and
 * nobody should have to switch anything in between. So both can carry at once, and each is
 * turned on and off by name.
 *
 * Opening is all-or-nothing in the sense that matters: a wire that will not open is reported
 * and skipped, never thrown past, because the LAN failing to bind must not stop the relay and
 * the relay failing to reach a database must certainly not stop the LAN.
 */
export function createSwitchboard(transports = []) {
  for (const t of transports) if (!isTransport(t)) throw new Error(`not a transport: ${t?.name ?? typeof t}`)
  const wires = new Map(transports.map((t) => [t.name, t]))
  const failed = new Map()

  const one = (name) => {
    const t = wires.get(name)
    if (!t) throw new Error(`no such transport: ${name}`)
    return t
  }
  const stat = (t) => ({ ...t.status(), ...(failed.has(t.name) ? { detail: failed.get(t.name) } : {}) })

  /** run a call on one wire, keeping its failure as a line to read rather than an exception */
  const attempt = async (t, run) => {
    try {
      const s = await run(t)
      failed.delete(t.name)
      return { ...s, ...(s.detail ? { detail: s.detail } : {}) }
    } catch (e) {
      failed.set(t.name, String(e?.message ?? e))
      return stat(t)
    }
  }

  return {
    get names() {
      return [...wires.keys()]
    },
    has: (name) => wires.has(name),
    get: (name) => wires.get(name) ?? null,
    /** bring every wire up; the answer says how each one went */
    open: () => Promise.all([...wires.values()].map((t) => attempt(t, (w) => w.open()))),
    /** start or stop one wire answering peers */
    carry: async (name, on) => attempt(one(name), (w) => w.carry(on === true)),
    /** take them all down; never throws, because this runs while the process is leaving */
    close: () => Promise.all([...wires.values()].map((t) => attempt(t, (w) => w.close()))),
    status: () => [...wires.values()].map(stat),
    statusOf: (name) => stat(one(name)),
    /** is anything at all reachable from off this machine? the one line the panel leads with */
    get carrying() {
      return [...wires.values()].some((t) => t.status().carrying)
    },
  }
}
