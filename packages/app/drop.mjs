/**
 * The drop zone — hand a file to another Laika Orbit on the same network, the way AirDrop does,
 * except that both ends are this app and neither end is a Mac by necessity.
 *
 * Two rules shape everything here, and both are load-bearing rather than polish:
 *
 *   1. Nothing is ever written to someone's disk until they have said yes. A sender opens an
 *      *offer* (who I am, what the file is called, how big it is); the offer sits in memory until
 *      the person at the receiving machine accepts or declines it. Accepting mints a single-use
 *      ticket, and only a request carrying that ticket may put bytes anywhere. A declined,
 *      unanswered or expired offer leaves no trace at all.
 *   2. It stays on the local network. The receiving socket answers private addresses only
 *      (RFC1918, link-local, unique-local, loopback) and a peer is only sent to at one of those,
 *      so there is nothing to relay through and nothing an outside host can reach even if the
 *      port were forwarded by accident. Discovery is multicast DNS, which does not leave the link.
 *
 * Discovery is bought, not built: bonjour-service advertises and browses `_orbitdrop._tcp` in
 * process on every platform. machines.mjs already browses `_laikaorbit._tcp` by shelling out to
 * `dns-sd`, which is macOS only and describes a different thing (an SSH compute node); this is a
 * second service type for a second question — "which Orbits are here?" — on the same Bonjour.
 *
 * The transfer is plain HTTP on the LAN, on its own port and its own server. The app's own server
 * (server.mjs, :5200) stays on loopback where it belongs: it reads indexed personal files and has
 * no login, so it must never be the thing that hears the network.
 *
 *   startDrop()          → the service: peers(), offers(), decide(), sendFile(), close()
 *   GET  /drop/hello                 who this Orbit is, for a peer to check it is really here
 *   POST /drop/offer                 { from, file } → an offer id; writes nothing
 *   GET  /drop/offer/<id>            the sender waits here: pending | accepted+ticket | declined
 *   PUT  /drop/file/<ticket>         the bytes, once, into the inbox
 */
import { Bonjour } from 'bonjour-service'
import { randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rename, rm, stat } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { homedir, hostname } from 'node:os'
import { basename, extname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** the drop port, next to the agent host's 7420; an instance may move it to run two on one Mac */
export const DROP_PORT = Number(process.env.ORBIT_DROP_PORT || 7422)
/** where accepted files land, and the only folder this module ever writes to */
export const INBOX = process.env.ORBIT_DROP_DIR || join(homedir(), 'Downloads', 'Orbit Drops')
export const SERVICE_TYPE = 'orbitdrop'
/** an offer nobody answers is forgotten; an accepted one must start moving soon after */
const OFFER_TTL_MS = 3 * 60_000
const TICKET_TTL_MS = 60_000
/** a hostile peer on the LAN should not be able to fill the disk or the offer list */
const MAX_BYTES = 16 * 1024 ** 3
const MAX_PENDING = 24

/** this Orbit, as the network sees it: a name a person recognises and an id that never collides */
export function identity(file = join(homedir(), '.laika', 'drop.json')) {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    if (saved?.id) return { id: saved.id, name: saved.name || hostname().replace(/\.local$/i, '') }
  } catch {}
  const me = { id: randomUUID(), name: hostname().replace(/\.local$/i, '') }
  try {
    mkdirSync(join(homedir(), '.laika'), { recursive: true })
    writeFileSync(file, `${JSON.stringify(me, null, 2)}\n`, { mode: 0o600 })
  } catch {}
  return me
}

/**
 * Is this address on the local link? Private IPv4 (10/8, 172.16/12, 192.168/16), link-local
 * (169.254/16, fe80::/10), unique-local IPv6 (fc00::/7) and loopback — nothing else, so a request
 * that reached this port from the internet is refused before it can even open an offer.
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
 * A name from the network is a string, not a path: only its last component survives, separators
 * and control characters go, and what is left can never be empty, "." or ".." — so a file always
 * lands inside the inbox whatever the sender called it.
 */
export function safeName(name) {
  const bare = String(name ?? '')
    .replace(/[\\/]+/g, '/')
    .split('/')
    .pop()
    .split('')
    .filter((c) => c.codePointAt(0) > 31 && c.codePointAt(0) !== 127 && c !== ':')
    .join('')
    .replace(/^\.+$/, '')
    .trim()
  return (bare || 'dropped-file').slice(0, 120)
}

/** the first free name at this path: "notes.md", then "notes (2).md", and so on — never an overwrite */
export function uniquePath(path, exists = existsSync) {
  if (!exists(path)) return path
  const ext = extname(path)
  const stem = path.slice(0, path.length - ext.length)
  for (let n = 2; n < 1000; n++) {
    const next = `${stem} (${n})${ext}`
    if (!exists(next)) return next
  }
  return `${stem} (${Date.now()})${ext}`
}

/** a Bonjour service as a peer, or null when it is not an Orbit we can reach on the local link */
export function peerFrom(service, selfId) {
  const txt = service?.txt ?? {}
  const id = txt.id
  if (!id || id === selfId) return null
  const addresses = (service.addresses ?? []).filter((a) => isLocalAddress(a))
  const host = addresses.find((a) => a.includes('.')) ?? addresses[0]
  if (!host || !service.port) return null
  return { id, name: txt.name || service.name || host, host, port: service.port, addresses }
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** read a small JSON body; anything larger than an offer is not an offer */
async function readJson(req, limit = 64 * 1024) {
  let size = 0
  const parts = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    parts.push(chunk)
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')
}

/**
 * Start the drop zone: a server on the LAN, an advertisement so other Orbits can find this one,
 * and a browser so this one can list them.
 *
 * `announce: false` leaves Bonjour out entirely (the tests, and anyone who would rather type an
 * address than be discoverable); the server and the offer flow are unchanged by it.
 */
export async function startDrop({ port = DROP_PORT, inbox = INBOX, announce = true, me = identity(), onOffer = () => {}, host = '0.0.0.0' } = {}) {
  /** offer id → { id, from, file, state, at, ticket, saved, error } — in memory only, by design */
  const offers = new Map()
  const seen = new Map()
  let bonjour = null
  let advert = null
  let browser = null

  const prune = () => {
    const now = Date.now()
    for (const o of offers.values()) {
      if (o.state === 'pending' && now - o.at > OFFER_TTL_MS) o.state = 'expired'
      if (o.state === 'accepted' && now - o.decidedAt > TICKET_TTL_MS) {
        o.state = 'expired'
        o.ticket = null
      }
      if (!['pending', 'accepted', 'receiving'].includes(o.state) && now - o.at > 30 * 60_000) offers.delete(o.id)
    }
  }
  const byTicket = (t) => (t ? [...offers.values()].find((o) => o.ticket === t) : null)

  const server = createServer(async (req, res) => {
    // rule 2, at the front door: this port answers the local link and nothing else
    if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error: 'the drop zone answers the local network only' })
    prune()
    const path = new URL(req.url, 'http://drop').pathname

    if (req.method === 'GET' && path === '/drop/hello') return json(res, 200, { orbit: 'drop', v: 1, id: me.id, name: me.name })

    // an offer: what someone would like to send. It is a question, so it touches no disk.
    if (req.method === 'POST' && path === '/drop/offer') {
      let body
      try {
        body = await readJson(req)
      } catch {
        return json(res, 400, { error: 'not an offer' })
      }
      const size = Number(body?.file?.size)
      if (!body?.file?.name || !Number.isFinite(size) || size < 0) return json(res, 400, { error: 'an offer needs a file name and a size' })
      if (size > MAX_BYTES) return json(res, 413, { error: 'that file is larger than the drop zone accepts' })
      if ([...offers.values()].filter((o) => o.state === 'pending').length >= MAX_PENDING) return json(res, 429, { error: 'too many offers are already waiting' })
      const offer = {
        id: randomUUID(),
        from: { id: String(body?.from?.id ?? '').slice(0, 64), name: String(body?.from?.name ?? 'someone').slice(0, 64), address: req.socket.remoteAddress },
        file: { name: safeName(body.file.name), size },
        state: 'pending',
        at: Date.now(),
      }
      offers.set(offer.id, offer)
      try {
        onOffer(offer)
      } catch {}
      return json(res, 200, { offer: offer.id, state: 'pending', expires: OFFER_TTL_MS })
    }

    // the sender waiting on a person: pending until someone here answers it
    if (req.method === 'GET' && path.startsWith('/drop/offer/')) {
      const o = offers.get(path.slice('/drop/offer/'.length))
      if (!o) return json(res, 404, { error: 'no such offer' })
      return json(res, 200, { state: o.state, ticket: o.state === 'accepted' ? o.ticket : undefined, saved: o.saved ? basename(o.saved) : undefined })
    }

    // the bytes. Only a ticket minted by an accept opens this, and only once.
    if (req.method === 'PUT' && path.startsWith('/drop/file/')) {
      const offer = byTicket(path.slice('/drop/file/'.length))
      if (!offer || offer.state !== 'accepted') return json(res, 403, { error: 'that transfer was not accepted' })
      if (Number(req.headers['content-length'] ?? offer.file.size) !== offer.file.size) return json(res, 400, { error: 'that is not the file that was accepted' })
      offer.ticket = null // single use: a second request carrying the same ticket finds nothing
      offer.state = 'receiving'
      offer.received = 0
      mkdirSync(inbox, { recursive: true })
      const target = uniquePath(join(inbox, offer.file.name))
      const part = `${target}.part`
      const limit = new Transform({
        transform(chunk, _enc, cb) {
          offer.received += chunk.length
          cb(offer.received > offer.file.size ? new Error('more bytes than were offered') : null, chunk)
        },
      })
      try {
        await pipeline(req, limit, createWriteStream(part))
        if (offer.received !== offer.file.size) throw new Error('the transfer ended early')
        await rename(part, target)
      } catch (e) {
        await rm(part, { force: true }).catch(() => {})
        offer.state = 'failed'
        offer.error = String(e?.message ?? e).slice(0, 160)
        return json(res, 400, { error: offer.error })
      }
      offer.state = 'done'
      offer.saved = target
      return json(res, 200, { ok: true, saved: basename(target) })
    }

    json(res, 404, { error: 'not a drop route' })
  })

  await new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(port, host, ok)
  })
  const bound = server.address().port

  if (announce) {
    bonjour = new Bonjour()
    advert = bonjour.publish({ name: `Orbit ${me.name} ${me.id.slice(0, 4)}`, type: SERVICE_TYPE, port: bound, txt: { id: me.id, name: me.name, v: '1' } })
    browser = bonjour.find({ type: SERVICE_TYPE })
    browser.on('up', (s) => {
      const p = peerFrom(s, me.id)
      if (p) seen.set(p.id, { ...p, at: Date.now() })
    })
    browser.on('down', (s) => {
      if (s?.txt?.id) seen.delete(s.txt.id)
    })
  }

  return {
    me,
    port: bound,
    inbox,
    /** the other Orbits on this link, most recently seen first */
    peers: () => [...seen.values()].sort((a, b) => b.at - a.at),
    /** ask the network again rather than waiting for the next announcement */
    refresh: () => browser?.update(),
    /**
     * Put a peer in the list by hand rather than by advertisement — a network that filters
     * multicast still has the two machines on it, and the address is checked the same way a
     * discovered one is.
     */
    add: (p) => {
      if (!p?.id || !p?.port || !isLocalAddress(p.host) || p.id === me.id) return null
      const peer = { id: p.id, name: p.name || p.host, host: p.host, port: Number(p.port), addresses: [p.host], manual: true, at: Date.now() }
      seen.set(peer.id, peer)
      return peer
    },
    offers: () => {
      prune()
      // the ticket never leaves this module, and `saved` is the name it went under, not the path
      return [...offers.values()].map(({ ticket, saved, ...o }) => (saved ? { ...o, saved: basename(saved) } : o))
    },
    /**
     * The whole of rule 1: until this is called with true, the sender has been told "pending" and
     * this machine has written nothing. Returns the offer, or null when there is no such offer to
     * answer — already decided, or expired while it waited.
     */
    decide: (id, accept) => {
      prune()
      const o = offers.get(id)
      if (!o || o.state !== 'pending') return null
      o.state = accept ? 'accepted' : 'declined'
      o.decidedAt = Date.now()
      if (accept) o.ticket = randomBytes(24).toString('hex')
      return { ...o, ticket: undefined }
    },
    sendFile: (peer, path, opts) => sendFile(peer, path, { ...opts, from: me }),
    close: async () => {
      browser?.stop()
      if (advert) await new Promise((ok) => advert.stop(ok))
      bonjour?.destroy()
      await new Promise((ok) => server.close(ok))
    },
  }
}

/**
 * Send one file to a peer: offer it, wait for the person there to say yes, then stream it.
 *
 * The wait is the point — it resolves 'declined' as readily as 'accepted', and neither answer is
 * assumed. `onProgress({ sent, size })` is called as the bytes go.
 */
export async function sendFile(peer, path, { from = identity(), onProgress = () => {}, poll = 500, timeout = OFFER_TTL_MS, signal } = {}) {
  if (!isLocalAddress(peer?.host)) throw new Error(`${peer?.host ?? 'that peer'} is not on the local network`)
  const info = await stat(path)
  if (!info.isFile()) throw new Error('only a file can be dropped')
  const base = `http://${peer.host.includes(':') ? `[${peer.host}]` : peer.host}:${peer.port}`
  const ask = async (p, init) => {
    const r = await fetch(`${base}${p}`, { ...init, signal: signal ?? AbortSignal.timeout(15_000) })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.error || `${peer.name ?? peer.host} answered ${r.status}`)
    return body
  }
  const file = { name: basename(path), size: info.size }
  const { offer } = await ask('/drop/offer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: { id: from.id, name: from.name }, file }),
  })

  const until = Date.now() + timeout
  let ticket = null
  while (Date.now() < until) {
    const s = await ask(`/drop/offer/${offer}`)
    if (s.state === 'accepted') {
      ticket = s.ticket
      break
    }
    if (s.state !== 'pending') throw new Error(s.state === 'declined' ? `${peer.name ?? 'they'} declined the file` : `the offer ${s.state}`)
    await new Promise((ok) => setTimeout(ok, poll))
  }
  if (!ticket) throw new Error('nobody answered the offer')

  let sent = 0
  const body = createReadStream(path)
  body.on('data', (c) => {
    sent += c.length
    onProgress({ sent, size: file.size })
  })
  return new Promise((ok, fail) => {
    const req = httpRequest(
      {
        host: peer.host,
        port: peer.port,
        path: `/drop/file/${ticket}`,
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'content-length': file.size },
      },
      (r) => {
        let out = ''
        r.on('data', (d) => {
          out += d
        })
        r.on('end', () => {
          let parsed = {}
          try {
            parsed = JSON.parse(out)
          } catch {}
          if (r.statusCode === 200) ok({ ...parsed, size: file.size })
          else fail(new Error(parsed.error || `the transfer was refused (${r.statusCode})`))
        })
      },
    )
    req.on('error', fail)
    body.on('error', fail)
    body.pipe(req)
  })
}
