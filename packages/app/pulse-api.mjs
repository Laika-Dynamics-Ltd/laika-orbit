/**
 * /api/pulse — everything the node network draws, from one shape.
 *
 * Both sources land in the same store (packages/app/pulse.mjs) before the page ever sees them:
 * GitHub's public counts are fetched here, and opt-in telemetry is *pulled* from the ingest
 * worker rather than pushed at this server, so the page has no idea which source a node came
 * from beyond the `cohort` flag that says whether it stands for one person or many.
 *
 * Routes:
 *   GET  /api/pulse                 { v, now, graph, features, sources, consent }
 *   GET  /api/pulse/consent         this machine's own opt-in state
 *   PUT  /api/pulse/consent         { on: true|false }
 *   POST /api/pulse/sync            fetch both sources now, ignoring the refresh interval
 *
 * The consent routes are about *this* install reporting itself, and are here rather than in the
 * settings API so that everything touching the pulse is in one file a reviewer can read.
 */
import { syncGithub } from './feeds/github.mjs'
import { buildGraph, featureRoll, putSignals, readCache, readSignals, writeCache } from './pulse.mjs'
import { consent, setConsent } from './pulse-client.mjs'

const ENDPOINT = process.env.PULSE_ENDPOINT || ''
const READ_TOKEN = process.env.PULSE_READ_TOKEN || ''
const REFRESH_MS = 5 * 60_000

/**
 * Whether this machine is the operator's — the only one that gets the /pulse window.
 *
 * WHAT THIS IS: a visibility gate, so a public build does not show every user a dashboard of
 * adoption numbers that is meaningless to them and confusing next to the privacy promise.
 *
 * WHAT THIS IS NOT: a security boundary. The app is MIT and open source, so anyone can read this
 * file and set the variable. What actually keeps the numbers private is that they are not here to
 * read: GitHub traffic needs a repo-scoped token, the telemetry aggregates need PULSE_READ_TOKEN
 * against your worker, and a user who forces this open sees their own empty local store. The
 * secrets protect the data; this only hides the door.
 *
 * Presence of either credential means operator, because a plain user has neither. PULSE_OPERATOR
 * forces it either way.
 */
export const isOperator = () =>
  process.env.PULSE_OPERATOR === '1' ||
  (process.env.PULSE_OPERATOR !== '0' && !!(process.env.PULSE_READ_TOKEN || process.env.PULSE_GITHUB_TOKEN || process.env.GITHUB_TOKEN))

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function body(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 16_000) throw new Error('body too large')
  }
  return raw.trim() ? JSON.parse(raw) : {}
}

/**
 * The worker's aggregates → signals in the local store.
 *
 * An install becomes one node; its per-day event counts become `session` weight and `feature`
 * rows for the behaviour readout. Ids are prefixed so a telemetry node can never collide with a
 * GitHub cohort node for the same day.
 */
export function telemetrySignals(pulse, { now = Date.now() } = {}) {
  const out = []
  for (const i of pulse?.installs ?? []) {
    const at = Date.parse(`${i.first_day}T12:00:00Z`)
    if (!Number.isFinite(at)) continue
    out.push({
      at,
      kind: 'install',
      id: `install-${i.install}`,
      count: 1,
      uniques: 1,
      meta: { features: i.features ?? [], region: i.region ?? null, app: i.app ?? null, platform: i.platform ?? null },
    })
  }
  for (const d of pulse?.daily ?? []) {
    const at = Date.parse(`${d.day}T12:00:00Z`)
    if (!Number.isFinite(at)) continue
    out.push({ at, kind: 'session', id: `session-${d.day}`, count: Number(d.events) || 0, uniques: Number(d.installs) || 0 })
  }
  for (const f of pulse?.features ?? []) {
    out.push({
      at: now,
      kind: 'feature',
      id: `feature-${f.name}`,
      count: Number(f.uses) || 0,
      uniques: Number(f.installs) || 0,
      meta: { feature: f.name, install: null },
    })
  }
  return out
}

/** Pull the worker's aggregates. Unconfigured is a state, not an error — say which. */
export async function syncTelemetry({ force = false, now = Date.now(), fetchImpl = fetch } = {}) {
  if (!ENDPOINT) return { ok: false, reason: 'no-endpoint', hint: 'set PULSE_ENDPOINT to your deployed worker' }
  if (!READ_TOKEN) return { ok: false, reason: 'no-read-token', hint: 'set PULSE_READ_TOKEN to the worker secret' }
  const last = readCache('telemetry', null)
  if (!force && last?.at && now - last.at < REFRESH_MS) return { ...last.status, cached: true, at: last.at }
  try {
    const res = await fetchImpl(`${ENDPOINT.replace(/\/$/, '')}/v1/pulse?days=30`, {
      headers: { authorization: `Bearer ${READ_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`http ${res.status}`)
    const data = await res.json()
    const signals = telemetrySignals(data, { now })
    if (signals.length) putSignals(signals)
    const status = { ok: true, installs: data.installs?.length ?? 0, signals: signals.length }
    writeCache('telemetry', { at: now, status })
    return { ...status, at: now }
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 120) }
  }
}

export async function handlePulse(url, req, res) {
  if (url.pathname === '/pulse') {
    // a user who is not the operator has no dashboard to see; send them back to the app
    res.writeHead(302, { location: isOperator() ? '/pulse.html' : '/' })
    res.end()
    return true
  }
  if (!url.pathname.startsWith('/api/pulse')) return false

  // the operator's own flag, for the rail button. Always answers, so the check is cheap.
  if (url.pathname === '/api/pulse/access' && req.method === 'GET') {
    send(res, 200, { operator: isOperator() })
    return true
  }

  if (url.pathname === '/api/pulse/consent') {
    if (req.method === 'GET') {
      const c = consent()
      // the install id is this machine's business; the page only needs to know the state
      send(res, 200, { state: c.state, at: c.at, reporting: !!ENDPOINT })
      return true
    }
    if (req.method === 'PUT') {
      try {
        const b = await body(req)
        const c = setConsent(b.on === true)
        send(res, 200, { state: c.state, at: c.at, reporting: !!ENDPOINT })
      } catch (e) {
        send(res, 400, { error: String(e.message || e) })
      }
      return true
    }
  }

  // everything past here is the dashboard, and belongs to the operator alone. Consent above is
  // deliberately left open: a user must always be able to see and change their own answer.
  if (!isOperator()) {
    send(res, 404, { error: 'not found' })
    return true
  }

  if (url.pathname === '/api/pulse/sync' && req.method === 'POST') {
    const [github, telemetry] = await Promise.all([syncGithub({ force: true }), syncTelemetry({ force: true })])
    send(res, 200, { github, telemetry })
    return true
  }

  if (url.pathname === '/api/pulse' && req.method === 'GET') {
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 30))
    const now = Date.now()
    // a slow or dead source must not hold the page: fetch both, take what answers
    const [github, telemetry] = await Promise.all([
      syncGithub({ now }).catch((e) => ({ ok: false, reason: String(e.message || e).slice(0, 120) })),
      syncTelemetry({ now }).catch((e) => ({ ok: false, reason: String(e.message || e).slice(0, 120) })),
    ])
    const signals = readSignals({ days, now })
    send(res, 200, {
      v: 1,
      now,
      graph: buildGraph(signals, { now, days }),
      features: featureRoll(signals, { now, days }),
      sources: { github, telemetry },
      consent: consent().state,
    })
    return true
  }
  return false
}
