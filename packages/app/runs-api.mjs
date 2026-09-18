/**
 * Runs API — the /runs page's data, the way to report without the CLI, and the artefact bytes.
 *
 * The runs are files under ~/.laika/progress (see runs.mjs), so this only reads and writes them;
 * every app instance on this Mac shows the same runs, and so can any other reader (the fleet
 * board, the hourly summary) by calling GET /api/runs or reading the files.
 *
 * Routes:
 *   GET    /api/runs                                  { v, now, dir, here, machines, runs: [run…] }, newest first
 *          machines: the offload machines as the app last saw them (machines.mjs machineState)
 *   GET    /api/runs/<run>                            one run
 *   GET    /api/runs/<run>/artifacts/<id>/file        the artefact's bytes, for a thumbnail or a compare
 *   POST   /api/runs/<run>                            {title, note, stallMin, eta, kind, where, status}
 *   POST   /api/runs/<run>/lanes/<lane>               {name, status, pct, done, total, eta, note, stallMin, where}
 *   POST   /api/runs/<run>/lanes/<lane>/jobs/<job>    {name, status, pct, note}
 *   POST   /api/runs/<run>/artifacts                  {path, label, compare, lane, wave, source, note}
 *   POST   /api/runs/<run>/verdicts                   {piece, wave, winner, slot, confirmed, why, critic, candidate, reference}
 *   DELETE /api/runs/<run>
 *
 * /api/progress answers the same, because chats that started under the previous live-progress
 * skill are still posting there and must not break mid-run.
 *
 * A run as returned: id, title, note, kind, project, where, cwd, chat, pid, createdAt, updatedAt,
 * endedAt, stallMin, pct (0-100), etaAt (epoch ms or null), etaFrom (given | lanes | history),
 * etaRuns, etaDerived, etaPartial, quietMs, chatAlive, stalledLanes, stuckLanes (their names),
 * silent, waves, state (running | stalled | orphaned | blocked | idle | done | failed | cancelled),
 * lanes [{id, name, status, pct, done, total, note, where, etaAt, etaDerived, overdue, stalled,
 * quietMs, startedAt, endedAt, ms, updatedAt, jobs [{id, name, status, pct, note, ms, updatedAt}]}],
 * artifacts [{id, label, path, medium, compare, lane, wave, source, suspect, missing, addedAt}]
 * and verdicts [{id, piece, wave, winner, slot, confirmed, why, critic, gap, at}].
 */
import { createReadStream, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { machineState } from './machines.mjs'
import { DIR, listBoards, putArtifact, putBoard, putJob, putLane, putVerdict, readBoard, removeBoard } from './runs.mjs'

const VERSION = 2

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function body(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 64_000) throw new Error('report too large')
  }
  if (!raw.trim()) return {}
  const v = JSON.parse(raw)
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('send a JSON object')
  return v
}

/** a report posted over HTTP comes from no chat process this server can see, unless it says so */
const HTTP_ENV = {}

const TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
}

/**
 * Serve one artefact's bytes. Only a path the run itself recorded is served — the id picks the
 * artefact and the file comes from what it stored — so this reads no path a caller composes.
 */
function sendArtifact(res, run, id) {
  const a = run.artifacts.find((x) => x.id === id)
  if (!a) return send(res, 404, { error: `no artefact ${id} in ${run.id}` })
  let size
  try {
    size = statSync(a.path).size
  } catch {
    return send(res, 404, { error: `the file this artefact points at is gone: ${a.path}` })
  }
  const ext = a.path.toLowerCase().split('.').at(-1)
  res.writeHead(200, {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': 'no-store',
    // an artefact is someone else's file, shown in a frame or an img; never let it script this origin
    'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    'content-disposition': `inline; filename="${encodeURIComponent(a.label ?? 'artifact')}"`,
  })
  createReadStream(a.path).pipe(res)
}

export async function handleRuns(url, req, res) {
  if (url.pathname === '/runs' || url.pathname === '/progress') {
    res.writeHead(302, { location: '/runs.html' })
    res.end()
    return true
  }
  const base = ['/api/runs', '/api/progress'].find((b) => url.pathname === b || url.pathname.startsWith(`${b}/`))
  if (!base) return false
  const parts = url.pathname.slice(base.length).split('/').map(decodeURIComponent).filter(Boolean)
  try {
    if (req.method === 'GET' && parts.length === 0) {
      const runs = listBoards()
      // `boards` as well as `runs`, for readers written against the old shape (summary, fleet board)
      send(res, 200, { v: VERSION, now: Date.now(), dir: DIR, here: hostname().replace(/\.local$/, ''), machines: machineState()?.machines ?? [], runs, boards: runs })
      return true
    }
    if (req.method === 'GET' && parts.length === 1) {
      const r = readBoard(parts[0])
      send(res, r ? 200 : 404, r ?? { error: `no run ${parts[0]}` })
      return true
    }
    if (req.method === 'GET' && parts.length === 4 && parts[1] === 'artifacts' && parts[3] === 'file') {
      const r = readBoard(parts[0])
      if (!r) send(res, 404, { error: `no run ${parts[0]}` })
      else sendArtifact(res, r, parts[2])
      return true
    }
    if (req.method === 'DELETE' && parts.length === 1) {
      send(res, removeBoard(parts[0]) ? 200 : 404, { ok: true })
      return true
    }
    if (req.method === 'POST') {
      const f = await body(req)
      const opts = { env: HTTP_ENV }
      if (parts.length === 1) putBoard(parts[0], f, opts)
      else if (parts.length === 3 && parts[1] === 'lanes') putLane(parts[0], parts[2], f, opts)
      else if (parts.length === 5 && parts[1] === 'lanes' && parts[3] === 'jobs') putJob(parts[0], parts[2], parts[4], f, opts)
      else if (parts.length === 2 && parts[1] === 'artifacts') putArtifact(parts[0], f.path, f, opts)
      else if (parts.length === 2 && parts[1] === 'verdicts') putVerdict(parts[0], f, opts)
      else {
        send(res, 404, { error: 'unknown runs route' })
        return true
      }
      send(res, 200, readBoard(parts[0]))
      return true
    }
    send(res, 405, { error: 'method not allowed' })
  } catch (e) {
    send(res, 400, { error: e.message })
  }
  return true
}
