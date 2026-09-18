/**
 * Laika Orbit adoption pulse — the ingest endpoint for opt-in, anonymous usage events.
 *
 * This is the only piece of Laika Orbit that is not on the user's machine, so it is written to
 * deserve that: it stores the least it can, it refuses anything it did not ask for, and it can be
 * read end to end in one sitting.
 *
 *   POST /v1/events   a batch from one install. Open by default (that is what opt-in means):
 *                     anyone running the app may report. Validated hard, see below.
 *   GET  /v1/pulse    the aggregates the /pulse page draws. Requires PULSE_READ_TOKEN, because
 *                     adoption numbers are the operator's, not the public's.
 *   POST /v1/hit      one page view on laikaorbit.com, from the site's beacon. Adds one to a
 *                     daily count of (path, referrer host, country) and stores nothing else, as
 *                     the site's privacy page promises: aggregate, cookie-free, no profiles.
 *   GET  /v1/health   liveness, no auth, no data.
 *
 * WHAT IS REFUSED, AND WHY IT IS REFUSED HERE AND NOT ONLY IN THE CLIENT: the client is open
 * source and runs on other people's machines, so it is not a trustworthy gate — a modified build,
 * or a bug, could send anything. The allowlist below is the real boundary. An event whose name is
 * not on it is dropped, not stored-and-ignored; free text never reaches the database because no
 * field in the accepted shape is free text.
 *
 * Deliberately never stored: IP address, user agent, hostname, file paths, search queries,
 * account names, precise timestamps. CF-IPCountry is narrowed to a continent before it is used
 * and the raw header is never written.
 */

/** the only event names that exist. Coarse on purpose: a feature was used, not what it was used on. */
const EVENTS = new Set([
  'app_open',
  'session_start',
  'map_open',
  'recall_run',
  'chat_open',
  'chat_message',
  'browser_open',
  'widget_open',
  'index_rebuild',
  'offload_run',
  'settings_open',
  'progress_open',
  'pulse_open',
])

const PLATFORMS = new Set(['darwin', 'linux', 'win32'])
/** per install, per batch — a generous cap that still bounds a runaway or malicious client */
const MAX_EVENTS = 60
const MAX_COUNT = 100_000
const MAX_BODY = 16 * 1024

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,15}$/

/** site paths worth counting: the page, never its query or fragment */
const PATH = /^\/[A-Za-z0-9/_.-]{0,120}$/
const HOST = /^[a-z0-9.-]{1,100}$/
/** automated clients by user agent; the agent is read here and never stored */
const BOT = /bot|crawl|spider|slurp|preview|monitor|headless|lighthouse|curl|wget|python|node-fetch|go-http/i
const SITE_ORIGINS = new Set(['https://laikaorbit.com', 'https://www.laikaorbit.com', 'https://laika-orbit-site.vercel.app'])

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

/** a country header → continent, so the map can show "someone in Oceania" and nothing sharper */
const CONTINENT = {
  NZ: 'OC', AU: 'OC', FJ: 'OC', PG: 'OC',
  US: 'NA', CA: 'NA', MX: 'NA',
  GB: 'EU', IE: 'EU', DE: 'EU', FR: 'EU', ES: 'EU', IT: 'EU', NL: 'EU', SE: 'EU', NO: 'EU', DK: 'EU', FI: 'EU', PL: 'EU', PT: 'EU', CH: 'EU', AT: 'EU', BE: 'EU', CZ: 'EU', RO: 'EU', UA: 'EU',
  IN: 'AS', CN: 'AS', JP: 'AS', KR: 'AS', SG: 'AS', ID: 'AS', TH: 'AS', VN: 'AS', PH: 'AS', MY: 'AS', IL: 'AS', AE: 'AS', TR: 'AS',
  BR: 'SA', AR: 'SA', CL: 'SA', CO: 'SA', PE: 'SA',
  ZA: 'AF', NG: 'AF', KE: 'AF', EG: 'AF', MA: 'AF',
}
export const continentOf = (cc) => CONTINENT[String(cc || '').toUpperCase()] ?? null

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)

/**
 * Validate a batch into exactly what the database takes, or explain what was wrong.
 *
 * Exported so the tests can drive it without a Worker runtime, and so the shape has one
 * definition rather than one here and one in the client.
 */
export function validate(body, { now = Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'send a JSON object' }
  if (body.v !== 1) return { error: 'unsupported version' }
  if (!UUID.test(String(body.install ?? ''))) return { error: 'install must be a uuid' }
  if (!Array.isArray(body.events)) return { error: 'events must be an array' }
  if (body.events.length > MAX_EVENTS) return { error: `at most ${MAX_EVENTS} events` }

  const app = VERSION.test(String(body.app ?? '')) ? String(body.app) : null
  const platform = PLATFORMS.has(body.platform) ? body.platform : null
  const cutoff = today(now - 45 * 86_400_000)
  const ahead = today(now + 2 * 86_400_000)

  const events = []
  let dropped = 0
  for (const e of body.events) {
    const name = e?.name
    const day = String(e?.day ?? '')
    const count = Number(e?.count)
    // a day outside the window is a clock that is wrong or a client replaying history; either
    // way it would distort the series, so it is dropped rather than clamped
    if (!EVENTS.has(name) || !DAY.test(day) || day < cutoff || day > ahead || !Number.isFinite(count) || count <= 0) {
      dropped++
      continue
    }
    events.push({ name, day, count: Math.min(Math.floor(count), MAX_COUNT) })
  }
  if (!events.length) return { error: dropped ? 'no usable events' : 'events was empty' }
  return { install: String(body.install), app, platform, events, dropped }
}

async function ingest(request, env, now) {
  if (env.PULSE_WRITE_TOKEN && request.headers.get('authorization') !== `Bearer ${env.PULSE_WRITE_TOKEN}`) {
    return json({ error: 'unauthorized' }, 401)
  }
  const raw = await request.text()
  if (raw.length > MAX_BODY) return json({ error: 'batch too large' }, 413)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return json({ error: 'invalid json' }, 400)
  }
  const v = validate(parsed, { now })
  if (v.error) return json({ error: v.error }, 400)

  const day = today(now)
  const region = continentOf(request.headers.get('cf-ipcountry'))
  const stmts = [
    env.DB.prepare(
      `INSERT INTO installs (install, first_day, last_day, app, platform, region) VALUES (?1, ?2, ?2, ?3, ?4, ?5)
       ON CONFLICT(install) DO UPDATE SET last_day = ?2, app = COALESCE(?3, installs.app), platform = COALESCE(?4, installs.platform), region = COALESCE(installs.region, ?5)`,
    ).bind(v.install, day, v.app, v.platform, region),
    ...v.events.map((e) =>
      // the client sends running daily totals, so a retried batch must settle, not add up
      env.DB.prepare(
        `INSERT INTO events (install, day, name, count) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(install, day, name) DO UPDATE SET count = MAX(events.count, ?4)`,
      ).bind(v.install, e.day, e.name, e.count),
    ),
  ]
  await env.DB.batch(stmts)
  return json({ ok: true, accepted: v.events.length, dropped: v.dropped })
}

/**
 * A page view becomes +1 on a daily count. There is no id of any kind: two views from one person
 * and one view each from two people land the same way, which is the point.
 */
export function validateHit(body, { origin = '', ua = '', country = '' } = {}) {
  if (!SITE_ORIGINS.has(origin)) return { error: 'unknown origin' }
  if (BOT.test(ua)) return { skip: 'bot' }
  const path = String(body?.path ?? '')
  if (!PATH.test(path)) return { error: 'bad path' }
  let ref = String(body?.ref ?? '').toLowerCase()
  if (ref && !HOST.test(ref)) ref = ''
  // moving around the site is not a referral
  if (ref.endsWith('laikaorbit.com') || ref.endsWith('laika-orbit-site.vercel.app')) ref = ''
  const cc = /^[A-Z]{2}$/.test(country) && country !== 'XX' && country !== 'T1' ? country : ''
  return { path, ref, country: cc }
}

async function hit(request, env, now) {
  const origin = request.headers.get('origin') ?? ''
  const cors = { 'access-control-allow-origin': SITE_ORIGINS.has(origin) ? origin : 'null', vary: 'origin' }
  const raw = await request.text()
  if (raw.length > 1024) return new Response(null, { status: 413, headers: cors })
  let body = null
  try {
    body = JSON.parse(raw)
  } catch {}
  const v = validateHit(body, { origin, ua: request.headers.get('user-agent') ?? '', country: request.headers.get('cf-ipcountry') ?? '' })
  if (v.path)
    await env.DB.prepare(
      `INSERT INTO hits (day, path, ref, country, views) VALUES (?1, ?2, ?3, ?4, 1)
       ON CONFLICT(day, path, ref, country) DO UPDATE SET views = hits.views + 1`,
    )
      .bind(today(now), v.path, v.ref, v.country)
      .run()
  // a beacon does not read the answer; say nothing either way
  return new Response(null, { status: 204, headers: cors })
}

async function pulse(request, env) {
  if (!env.PULSE_READ_TOKEN || request.headers.get('authorization') !== `Bearer ${env.PULSE_READ_TOKEN}`) {
    return json({ error: 'unauthorized' }, 401)
  }
  const days = Math.min(90, Math.max(1, Number(new URL(request.url).searchParams.get('days')) || 30))
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

  const [installs, daily, features, pairs, site] = await Promise.all([
    env.DB.prepare('SELECT install, first_day, last_day, app, platform, region FROM installs WHERE last_day >= ?1 ORDER BY first_day').bind(from).all(),
    env.DB.prepare('SELECT day, COUNT(DISTINCT install) AS installs, SUM(count) AS events FROM events WHERE day >= ?1 GROUP BY day ORDER BY day').bind(from).all(),
    env.DB.prepare('SELECT name, SUM(count) AS uses, COUNT(DISTINCT install) AS installs FROM events WHERE day >= ?1 GROUP BY name ORDER BY uses DESC').bind(from).all(),
    // installs that use the same feature — the page's only observed (rather than inferred) edge
    env.DB.prepare('SELECT name, install FROM events WHERE day >= ?1 GROUP BY name, install').bind(from).all(),
    env.DB.prepare('SELECT day, SUM(views) AS views FROM hits WHERE day >= ?1 GROUP BY day ORDER BY day').bind(from).all(),
  ])

  const byInstall = new Map()
  for (const r of pairs.results ?? []) {
    if (!byInstall.has(r.install)) byInstall.set(r.install, [])
    byInstall.get(r.install).push(r.name)
  }
  return json({
    v: 1,
    days,
    installs: (installs.results ?? []).map((r) => ({ ...r, features: byInstall.get(r.install) ?? [] })),
    daily: daily.results ?? [],
    features: features.results ?? [],
    site: site.results ?? [],
  })
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url)
    const now = Date.now()
    try {
      if (request.method === 'POST' && pathname === '/v1/events') return await ingest(request, env, now)
      if (request.method === 'POST' && pathname === '/v1/hit') return await hit(request, env, now)
      if (request.method === 'GET' && pathname === '/v1/pulse') return await pulse(request, env)
      if (request.method === 'GET' && pathname === '/v1/health') return json({ ok: true })
      return json({ error: 'not found' }, 404)
    } catch (e) {
      // never echo an internal error to a client we do not control
      console.error('pulse', e)
      return json({ error: 'server error' }, 500)
    }
  },
}
