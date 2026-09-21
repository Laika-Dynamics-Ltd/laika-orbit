/**
 * The drop zone's routes on the app's own (loopback) server, so the UI can see peers and answer
 * offers without anything on the network being able to reach these.
 *
 *   GET  /api/drop                  this Orbit's drop zone: name, inbox, port, whether it is up
 *   GET  /api/drop/peers            the other Orbits on this link right now
 *   POST /api/drop/peers/refresh    ask the network again instead of waiting for the next advert
 *   GET  /api/drop/offers           what has been offered to this machine, and what came of it
 *   POST /api/drop/offers/<id>      { accept: true | false } — the yes, or the no
 *
 * The LAN side lives in drop.mjs; this file only starts it and passes questions to it. Set
 * ORBIT_DROP=0 and nothing binds to the network at all — the routes then answer 503 and say so.
 */
import { startDrop } from './drop.mjs'

const OFF = process.env.ORBIT_DROP === '0'
let zone = null
let starting = null

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
  return json(res, 404, { error: 'not a drop route' })
}
