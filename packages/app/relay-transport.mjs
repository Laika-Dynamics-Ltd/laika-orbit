/**
 * Reaching this Mac from somewhere that is not this room.
 *
 * A transport (transport.mjs), like the local link, and the same host handler behind it — what
 * changes is that there is no socket to open. The Mac holds an *outbound* connection to a
 * database and reads what the paired phone left there; the phone does the same in reverse.
 * Nothing listens, no port is forwarded, no relay of ours is hosted anywhere. A firewall that
 * allows an outbound HTTPS connection is the whole requirement.
 *
 * Everything that crosses is sealed (sealed-envelope.mjs) with a key derived from the pairing,
 * so the database routes ciphertext it cannot read. See that file for what is and is not given
 * away; the short version is sizes and timings and nothing else.
 *
 * ## The database is a variable
 *
 * Which database has not been chosen yet, so this file does not know. It is given a `db` with
 * two methods, and that is deliberately all the surface a real one has to match:
 *
 *   db.send(room, dir, envelope)       put one sealed message in the pipe
 *   db.subscribe(room, dir, onMessage) read the ones addressed this way; returns an unsubscribe
 *
 * A Supabase Realtime adapter is an insert and a channel subscription. Anything with a durable
 * queue and a live feed fits the same two calls. test/relay-stub.mjs is an in-process one, which
 * is what the tests run against — nothing here has ever spoken to a network.
 *
 * ## Why the host handler does not know
 *
 * A request arrives as a sealed payload, not a socket, so it is dressed as one: a small
 * IncomingMessage-shaped object and a ServerResponse-shaped sink that collects the answer
 * instead of writing it to a wire. That is the whole trick, and it is why the relay adds no
 * routes — every route the LAN has, it has, including the event streams, which become a run of
 * sealed chunks.
 *
 * The request presents as loopback because that is true: this process is making it. It is not a
 * way past the front door — the token still has to be in the request, and the phone puts it
 * there itself from the QR it scanned. The relay grants nothing it was not handed.
 *
 * ## When a message will not open
 *
 * Nothing happens. No reply, no error row, no log line the pipe can time. It is counted, so the
 * pairing panel can say "11 messages arrived that this Mac could not read", which is the honest
 * signal that someone is writing into the room — and it is the only signal, because any answer
 * at all would tell whoever wrote it something.
 */
import { sealedChannel } from './sealed-envelope.mjs'

/** headers a phone may set on a relayed request; anything else it sends is dropped unread */
const HEADERS_THROUGH = ['x-agent-token', 'content-type', 'accept']
/** a stream is answered chunk by chunk; everything else is one message when the handler is done */
const STREAMING = /^text\/event-stream/i
/** how many requests may be in flight at once, so one phone cannot spend the whole Mac */
const MAX_INFLIGHT = 32
/** a single relayed request body; the same ceiling the host puts on a socket */
const MAX_BODY = 30e6

/** what a request has to look like before it is worth dressing up as one */
const wellFormed = (r) => Boolean(r) && typeof r === 'object' && typeof r.id === 'string' && typeof r.path === 'string' && r.path.startsWith('/')

/**
 * A sealed request, dressed as the node request and response a handler expects.
 *
 * `emit` is called with each message to seal and send back: one `res` for an ordinary answer, or
 * `head` then `chunk`s then `end` for a stream. The answer is `{ cancel }`, which fires the
 * request's close — how a phone hangs up on an event stream it no longer wants, and what the
 * host's own stream cleanup already listens for.
 */
export function deliver(handler, request, emit) {
  const { id, method = 'GET', path, headers = {}, body } = request
  const closers = new Set()
  let streaming = false
  let done = false
  /** has the message that ends this exchange gone out yet */
  let terminal = false
  let status = 200
  const chunks = []

  const payload = body === undefined || body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  const passed = {}
  for (const h of HEADERS_THROUGH) {
    const v = headers[h] ?? headers[h.toLowerCase()]
    if (typeof v === 'string') passed[h] = v
  }
  if (payload && !passed['content-type']) passed['content-type'] = 'application/json'

  const req = {
    method: String(method).toUpperCase(),
    url: path,
    headers: passed,
    // true: this process is making the request. The token still has to be in it, and the phone
    // put it there — the relay is a courier, not a key.
    socket: { remoteAddress: '127.0.0.1' },
    on(event, fn) {
      if (event === 'close') closers.add(fn)
      return req
    },
    off(event, fn) {
      if (event === 'close') closers.delete(fn)
      return req
    },
    once(event, fn) {
      return req.on(event, fn)
    },
    async *[Symbol.asyncIterator]() {
      if (payload) yield payload
    },
  }

  const send = (m) => {
    if (!done) emit({ id, ...m })
  }
  /**
   * The phone is waiting on something. Whichever way this request ends — answered, cancelled,
   * or cut because remote access was taken back — a stream that was opened is closed out loud,
   * so the other side is never left holding a reply that will not arrive.
   */
  const finish = () => {
    if (done) return
    if (streaming && !terminal) {
      terminal = true
      send({ t: 'end' })
    }
    done = true
    for (const fn of closers) {
      try {
        fn()
      } catch {}
    }
    closers.clear()
  }

  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    flushHeaders() {},
    writeHead(code, headers = {}) {
      status = code
      res.headersSent = true
      streaming = STREAMING.test(headers['content-type'] ?? '')
      if (streaming) send({ t: 'head', status, headers })
      return res
    },
    write(chunk) {
      if (done) return false
      if (streaming) send({ t: 'chunk', data: String(chunk) })
      else chunks.push(String(chunk))
      return true
    },
    end(chunk) {
      if (done) return res
      if (chunk !== undefined && chunk !== null) res.write(chunk)
      res.writableEnded = true
      terminal = true
      send(streaming ? { t: 'end' } : { t: 'res', status, body: chunks.join('') })
      finish()
      return res
    },
    destroy() {
      finish()
    },
  }

  Promise.resolve()
    .then(() => handler(req, res))
    .catch(() => {
      // a handler that threw before answering still owes the phone an answer, and the phone is
      // not told which route failed
      if (!done && !terminal) {
        status = 500
        terminal = true
        send({ t: 'res', status: 500, body: JSON.stringify({ error: 'the agent host could not answer' }) })
        finish()
      }
    })

  return { cancel: finish, get streaming() { return streaming }, get done() { return done } }
}

/**
 * @param {Object} o
 * @param {(req: any, res: any) => void} o.handler  the host's front door, as the LAN gets it
 * @param {string} o.secret  the pairing secret from the QR; the key comes out of this and stays here
 * @param {Object} o.db      send/subscribe — the database, or a stand-in for one
 */
export function createRelayTransport({ handler, secret, db, maxBody = MAX_BODY, ...rest } = {}) {
  if (typeof handler !== 'function') throw new Error('a transport carries a handler')
  if (!db || typeof db.send !== 'function' || typeof db.subscribe !== 'function') throw new Error('a relay needs a db with send and subscribe')
  const channel = sealedChannel({ secret, side: 'mac', ...rest })
  /** @type {Map<string, { cancel: () => void }>} requests still being answered */
  const live = new Map()
  let stop = null
  let opened = false
  let detail = ''

  const status = () => ({
    name: 'relay',
    carrying: Boolean(stop),
    host: null,
    port: null,
    room: channel.room,
    inflight: live.size,
    unreadable: channel.refused,
    ...(detail ? { detail } : {}),
  })

  const reply = (m) => {
    // sealing cannot fail on our own payload; a database that is down can, and a dropped answer
    // is better than a crashed host — the phone retries, which is what it does on the LAN too
    Promise.resolve()
      .then(() => db.send(channel.room, channel.out, channel.seal(m)))
      .catch((e) => {
        detail = `could not reach the relay: ${e?.message ?? e}`
      })
  }

  /** one sealed message off the pipe. Anything wrong with it ends here, silently. */
  const arrived = (envelope) => {
    const got = channel.open(envelope)
    if (!got.ok) return
    const r = got.payload
    if (r && typeof r === 'object' && typeof r.cancel === 'string') {
      live.get(r.cancel)?.cancel()
      live.delete(r.cancel)
      return
    }
    if (!wellFormed(r)) return
    if (live.has(r.id)) return // the same request twice inside one stream: already being answered
    if (live.size >= MAX_INFLIGHT) return reply({ id: r.id, t: 'res', status: 503, body: JSON.stringify({ error: 'too many requests in flight' }) })
    const size = r.body === undefined || r.body === null ? 0 : Buffer.byteLength(typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
    if (size > maxBody) return reply({ id: r.id, t: 'res', status: 413, body: JSON.stringify({ error: 'body too large' }) })

    const run = deliver(handler, r, (m) => {
      reply(m)
      if (m.t === 'res' || m.t === 'end') live.delete(r.id)
    })
    live.set(r.id, run)
  }

  /**
   * Start or stop reading the room. Stopping is how remote access is taken back: the Mac lets go
   * of the pipe, and whatever is written there afterwards is read by nobody. Requests already
   * being answered are cut, exactly as a LAN stop cuts open connections.
   */
  const carry = async (on) => {
    if (!opened) return status()
    if (on === true) {
      if (stop) return status()
      detail = ''
      stop = await db.subscribe(channel.room, channel.in, arrived)
      return status()
    }
    if (!stop) return status()
    const go = stop
    stop = null
    for (const r of live.values()) r.cancel()
    live.clear()
    await go()
    return status()
  }

  return {
    name: 'relay',
    status,
    channel,
    carry,

    async open() {
      opened = true
      await db.open?.()
      return status()
    },

    async close() {
      await carry(false)
      opened = false
      await db.close?.()
      return status()
    },
  }
}
