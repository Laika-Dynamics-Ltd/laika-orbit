/**
 * The drop zone's routes on the app's own (loopback) server, so the UI can see peers, answer
 * offers and start a send without anything on the network being able to reach these.
 *
 *   GET  /api/drop                  this Orbit's drop zone: name, inbox, port
 *   GET  /api/drop/state            all of it in one poll: peers, offers in, transfers out
 *   GET  /api/drop/peers            the other Orbits on this link right now
 *   POST /api/drop/peers/refresh    ask the network again instead of waiting for the next advert
 *   GET  /api/drop/offers           what has been offered to this machine, and what came of it
 *   POST /api/drop/offers/<id>      { accept: true | false } — the yes, or the no
 *   POST /api/drop/batches/<id>     the same answer for a whole many-file drop, given once
 *   POST /api/drop/send?to=&name=   the dropped file's bytes as the body; answers with a send id
 *                                   &rel= its path inside a dropped folder, &batch=&count=&bytes=
 *                                   the shape of the drop it belongs to
 *   POST /api/drop/reveal           show the inbox in the Finder
 *
 * A send names a *peer id*, never a host: the address comes from what Bonjour saw, so this route
 * cannot be talked into opening a connection to somewhere of the caller's choosing.
 *
 * The bytes are spooled to a temporary file before the offer goes out. A browser cannot hand the
 * server a path (Electron 44 dropped `File.path`, and exposing `webUtils` is the shell's business,
 * not this package's), and holding a half-read upload open while a person decides whether to
 * accept would leave the browser streaming into a socket nobody is draining. The spool is on
 * loopback, it is deleted whatever happens, and it is the one copy.
 *
 * The LAN side lives in drop.mjs; this file only starts it and passes questions to it. Set
 * ORBIT_DROP=0 and nothing binds to the network at all — the routes then answer 503 and say so.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { safeName, safeRelPath, startDrop } from './drop.mjs'

const OFF = process.env.ORBIT_DROP === '0'
let zone = null
let starting = null
/** what this machine is sending, newest first; the panel polls these for the progress bar */
const sends = new Map()

/** start the drop zone once; later calls get the same one. Failing to bind is not fatal to the app. */
export function startDropZone(opts = {}) {
  if (OFF) return Promise.resolve(null)
  if (!starting) {
    starting = startDrop(opts).then(
      (z) => {
        zone = z
        return z
      },
      (e) => {
        starting = null
        throw e
      },
    )
  }
  return starting
}

export const dropZone = () => zone

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
  return true
}

async function readJson(req) {
  const parts = []
  for await (const chunk of req) parts.push(chunk)
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')
  } catch {
    return {}
  }
}

/** the transfers out, newest first, with the last few finished ones kept for the panel to show */
function outgoing() {
  const now = Date.now()
  for (const s of sends.values()) if (s.state !== 'sending' && s.state !== 'waiting' && now - s.at > 10 * 60_000) sends.delete(s.id)
  return [...sends.values()].sort((a, b) => b.at - a.at)
}

/**
 * Take the dropped bytes, then offer the file to the peer and stream it once they say yes. The
 * request answers as soon as the bytes are safely spooled, because the wait that follows belongs
 * to a person at the other end and may be a minute long — the panel watches `sends` for the rest.
 */
async function startSend(z, req, res, url) {
  const peer = z.peers().find((p) => p.id === url.searchParams.get('to'))
  if (!peer) return json(res, 404, { error: 'that Orbit is no longer on the network' })
  const rel = url.searchParams.get('rel') ? safeRelPath(url.searchParams.get('rel')) : null
  const name = rel ? rel.split('/').pop() : safeName(url.searchParams.get('name') || 'dropped-file')
  const batchId = url.searchParams.get('batch')
  const batch = batchId ? { id: batchId, name: url.searchParams.get('label') || null, count: Number(url.searchParams.get('count') || 1), size: Number(url.searchParams.get('bytes') || 0) } : null
  const send = { id: randomUUID(), to: { id: peer.id, name: peer.name }, file: { name, size: Number(req.headers['content-length'] ?? 0), rel }, batch: batchId, sent: 0, state: 'spooling', at: Date.now() }
  sends.set(send.id, send)

  let dir
  try {
    dir = await mkdtemp(join(tmpdir(), 'orbit-drop-'))
    const spool = join(dir, name)
    await pipeline(req, createWriteStream(spool))
    send.state = 'waiting'
    json(res, 200, { send: send.id })
    // from here the browser is no longer waiting: the offer goes out, and the person at the other
    // end takes as long as they take
    const out = await z.sendFile(peer, spool, {
      rel,
      batch,
      onProgress: ({ sent, size }) => {
        send.state = 'sending'
        send.sent = sent
        send.file.size = size
      },
    })
    send.state = 'done'
    send.saved = out.saved
  } catch (e) {
    send.state = 'failed'
    send.error = String(e?.message ?? e).slice(0, 200)
    if (!res.headersSent) return json(res, 502, { error: send.error, send: send.id })
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  return true
}

export async function handleDrop(url, req, res) {
  const path = url.pathname
  if (path !== '/api/drop' && !path.startsWith('/api/drop/')) return false
  if (OFF) return json(res, 503, { error: 'the drop zone is off (ORBIT_DROP=0)', off: true })

  let z
  try {
    z = await startDropZone()
  } catch (e) {
    return json(res, 503, { error: `the drop zone could not open its port: ${String(e?.message ?? e)}` })
  }

  if (req.method === 'GET' && path === '/api/drop') return json(res, 200, { me: z.me, inbox: z.inbox, port: z.port })
  if (req.method === 'GET' && path === '/api/drop/state') return json(res, 200, { me: z.me, inbox: z.inbox, port: z.port, peers: z.peers(), offers: z.offers(), batches: z.batches(), sends: outgoing() })
  if (req.method === 'GET' && path === '/api/drop/peers') return json(res, 200, { peers: z.peers() })
  if (req.method === 'POST' && path === '/api/drop/peers/refresh') {
    z.refresh()
    return json(res, 200, { peers: z.peers() })
  }
  if (req.method === 'GET' && path === '/api/drop/offers') return json(res, 200, { offers: z.offers() })
  if (req.method === 'POST' && path.startsWith('/api/drop/offers/')) {
    const { accept } = await readJson(req)
    const decided = z.decide(path.slice('/api/drop/offers/'.length), accept === true)
    if (!decided) return json(res, 409, { error: 'that offer is no longer waiting for an answer' })
    return json(res, 200, { offer: decided })
  }
  if (req.method === 'POST' && path.startsWith('/api/drop/batches/')) {
    const { accept } = await readJson(req)
    const decided = z.decideBatch(path.slice('/api/drop/batches/'.length), accept === true)
    if (!decided) return json(res, 409, { error: 'that drop is no longer waiting for an answer' })
    return json(res, 200, { batch: decided })
  }
  if (req.method === 'POST' && path === '/api/drop/send') return startSend(z, req, res, url)
  if (req.method === 'POST' && path === '/api/drop/reveal') {
    // a folder this module owns, never a path from the caller; it may not exist until the first file
    mkdirSync(z.inbox, { recursive: true })
    execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [z.inbox], () => {})
    return json(res, 200, { ok: true, inbox: z.inbox })
  }
  return json(res, 404, { error: 'not a drop route' })
}
