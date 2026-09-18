/**
 * /api/users — the real people behind the Users panel, read server-side from where they already are.
 *
 *   step        source                           what it gives, per person
 *   site        pulse worker /v1/hit counts      daily page views: a count, never people
 *   waitlist    Resend audience                  sign-up time
 *   pro         Stripe checkout sessions         purchase time (completed Orbit Pro checkouts)
 *   licence     Stripe subscription metadata     activated_at, written by the site's licence check
 *   app         licence checks (Pro), telemetry  Pro: activation and the last day it checked in;
 *                                                free: first and last day an opted-in install reported
 *   feature     opt-in telemetry                 which features, by day
 *
 * PRIVACY, WHICH IS THE POINT OF DOING THIS SERVER-SIDE: emails leave Resend and Stripe only into
 * this process, where they are hashed with a salt that never leaves this Mac and then dropped. The
 * page gets `p_<hash>` ids and times, never an address, a name or a customer id, and nothing here
 * logs an email. The hash is what lets a waitlist sign-up and a later purchase be one person.
 * Telemetry installs are anonymous by design and are never joined to anyone: they stay their own
 * people, starting at "opened the app".
 *
 * KEYS come from the Keychain (service "laika-orbit secret", see secrets.mjs), never from a file:
 *   orbit-resend-api-key   the Orbit site's Resend key (Vercel production RESEND_API_KEY)
 *   orbit-resend-audience  the site's waitlist audience id (RESEND_AUDIENCE_ID); not secret
 *   resend-api-key         fallback: an older key, on an account without the waitlist
 *   stripe-read-key    a Stripe *restricted* key: Checkout Sessions and Subscriptions, Read
 * Env overrides for testing: RESEND_API_KEY, RESEND_AUDIENCE_ID, STRIPE_READ_KEY. Without an
 * audience id, the audience named "Laika Orbit waitlist" (the site's resend:setup) is used.
 * Telemetry uses the pulse worker's PULSE_ENDPOINT and PULSE_READ_TOKEN, as pulse-api.mjs does.
 *
 * The site: its privacy page promises aggregate, cookie-free statistics and no profiles, so visits
 * are a daily count from the pulse worker (fed by the site's beacon) and are never drawn as people.
 * Vercel's own analytics has no read API on this plan.
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SERVICE } from './secrets.mjs'

const DAY = 86_400_000
const RANGE_DAYS = 8
const CACHE_MS = 5 * 60_000
const AUDIENCE_NAME = 'Laika Orbit waitlist'
const DIR = join(homedir(), '.laika', 'users')

/** a secret from the Keychain by name, or null; the value is never logged */
export function keychain(name) {
  if (process.platform !== 'darwin') return Promise.resolve(null)
  return new Promise((resolve) =>
    execFile('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], { timeout: 10_000 }, (err, out) =>
      resolve(err ? null : String(out).trim() || null),
    ),
  )
}

/** the per-Mac salt: made once, kept out of the repo and out of every response */
function salt() {
  const f = join(DIR, 'salt')
  if (existsSync(f)) return readFileSync(f, 'utf8').trim()
  mkdirSync(DIR, { recursive: true })
  const s = randomBytes(32).toString('hex')
  writeFileSync(f, s, { mode: 0o600 })
  return s
}

export const personId = (email, s) =>
  `p_${createHash('sha256').update(`${s}:${String(email).trim().toLowerCase()}`).digest('hex').slice(0, 16)}`

async function getJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

// ------------------------------------------------------------------ sources ----

/** waitlist sign-ups: [{ email, at }] */
export async function readResend({ key, audience, fetchJson = getJson }) {
  const h = { authorization: `Bearer ${key}` }
  let id = audience
  if (!id) {
    const list = await fetchJson('https://api.resend.com/audiences', h)
    id = (list.data ?? []).find((a) => a.name === AUDIENCE_NAME)?.id
    // never fall back to another audience: a newsletter list is not the waitlist
    if (!id) return { rows: [], missing: `This Resend account has no "${AUDIENCE_NAME}" audience. Add the site's key as orbit-resend-api-key and its audience id as orbit-resend-audience.` }
  }
  const out = []
  let after = ''
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ limit: '100', ...(after ? { after } : {}) })
    const res = await fetchJson(`https://api.resend.com/audiences/${id}/contacts?${q}`, h)
    const rows = res.data ?? []
    for (const c of rows) if (c.email && !c.unsubscribed) out.push({ email: c.email, at: Date.parse(c.created_at) })
    if (!res.has_more || !rows.length) break
    after = rows[rows.length - 1].id
  }
  return { rows: out.filter((r) => Number.isFinite(r.at)) }
}

/** every page of a Stripe list, up to a bound that a young product will not reach */
async function stripeList(path, params, h, fetchJson) {
  const out = []
  let starting = ''
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ limit: '100', ...params })
    if (starting) q.set('starting_after', starting)
    const res = await fetchJson(`https://api.stripe.com/v1/${path}?${q}`, h)
    const rows = res.data ?? []
    out.push(...rows)
    if (!res.has_more || !rows.length) break
    starting = rows[rows.length - 1].id
  }
  return out
}

/**
 * Completed Orbit Pro checkouts, all time (a licence activated this week may have been bought
 * months ago): [{ email, at, sub }]. Then each one's subscription for the licence check the site
 * records on it; without Subscriptions: Read that half is reported missing, not guessed.
 */
export async function readStripe({ key, fetchJson = getJson }) {
  const h = { authorization: `Bearer ${key}` }
  const rows = []
  for (const s of await stripeList('checkout/sessions', { status: 'complete' }, h, fetchJson)) {
    if (s.metadata?.product !== 'orbit-pro') continue
    const email = s.customer_details?.email
    const sub = typeof s.subscription === 'string' ? s.subscription : s.subscription?.id
    if (email) rows.push({ email, at: s.created * 1000, sub: sub ?? null })
  }
  let licences = null
  try {
    licences = new Map()
    for (const sub of await stripeList('subscriptions', { status: 'all' }, h, fetchJson)) {
      const m = sub.metadata ?? {}
      const activated = Number(m.activated_at) * 1000
      const last = Date.parse(`${m.last_check_day}T00:00:00Z`)
      if (Number.isFinite(activated) && activated > 0)
        licences.set(sub.id, { activated, last: Number.isFinite(last) ? last : null })
    }
  } catch (e) {
    if (!/HTTP 40[13]/.test(String(e.message))) throw e
    licences = null
  }
  return { rows, licences, test: /^(rk|sk)_test_/.test(key) }
}

/** opted-in installs from the pulse worker: [{ install, first, last, features }] */
export async function readTelemetry({ endpoint, token, fetchJson = getJson }) {
  const data = await fetchJson(`${endpoint.replace(/\/$/, '')}/v1/pulse?days=${RANGE_DAYS}`, { authorization: `Bearer ${token}` })
  return {
    rows: (data.installs ?? []).map((i) => ({
      install: String(i.install),
      first: Date.parse(`${i.first_day}T00:00:00Z`),
      last: Date.parse(`${i.last_day}T00:00:00Z`),
      features: Array.isArray(i.features) ? i.features : [],
    })),
    site: (data.site ?? []).map((d) => ({ day: String(d.day), views: Number(d.views) || 0 })),
  }
}

// ------------------------------------------------------------------- the feed ----

/** turn the three sources into the panel's people; pure, so it can be checked without a network */
export function buildPeople({ waitlist = [], purchases = [], licences = null, installs = [], salt: s, now = Date.now() }) {
  const since = now - RANGE_DAYS * DAY
  const byId = new Map()
  const person = (id) => {
    let p = byId.get(id)
    if (!p) byId.set(id, (p = { id, steps: {}, features: [], active: [] }))
    return p
  }
  for (const w of waitlist) {
    const p = person(personId(w.email, s))
    p.steps.waitlist = Math.min(p.steps.waitlist ?? Number.POSITIVE_INFINITY, w.at)
  }
  for (const b of purchases) {
    const p = person(personId(b.email, s))
    p.steps.pro = Math.min(p.steps.pro ?? Number.POSITIVE_INFINITY, b.at)
    // the licence is activated in the app, so activating is also opening it; the latest check
    // (the app checks at most hourly) is the last day this person had it open
    const lic = b.sub ? licences?.get(b.sub) : null
    if (lic) {
      p.steps.licence = Math.min(p.steps.licence ?? Number.POSITIVE_INFINITY, lic.activated)
      p.steps.app = Math.min(p.steps.app ?? Number.POSITIVE_INFINITY, lic.activated)
      if (lic.last !== null) p.active.push([lic.last, lic.last + DAY - 1])
    }
  }
  for (const i of installs) {
    if (!Number.isFinite(i.first)) continue
    // anonymous: its own person, keyed by a hash of the install id so the id itself is not shown
    const p = person(`i_${createHash('sha256').update(`${s}:${i.install}`).digest('hex').slice(0, 16)}`)
    p.steps.app = i.first
    if (i.features.length) {
      p.steps.feature = i.first
      p.features = i.features.map((name) => ({ name, at: i.first }))
    }
    if (Number.isFinite(i.last)) p.active.push([i.last, i.last + DAY - 1])
  }
  // keep anyone who did something in the range; older people have left the picture
  return [...byId.values()].filter((p) => Object.values(p.steps).some((at) => at >= since))
}

let cache = null

export async function usersFeed({ now = Date.now(), force = false } = {}) {
  if (!force && cache && now - cache.at < CACHE_MS) return cache.feed
  const sources = []
  const got = { waitlist: [], purchases: [], licences: null, installs: [] }
  let site = null
  const env = process.env

  const resendKey = env.RESEND_API_KEY || (await keychain('orbit-resend-api-key')) || (await keychain('resend-api-key'))
  const audience = env.RESEND_AUDIENCE_ID || (await keychain('orbit-resend-audience'))
  if (!resendKey) {
    sources.push({ id: 'resend', name: 'Resend waitlist', state: 'missing', steps: ['waitlist'], note: "Add the site's Resend key to the Keychain as orbit-resend-api-key." })
  } else {
    try {
      const r = await readResend({ key: resendKey, audience })
      got.waitlist = r.rows
      sources.push(
        r.missing
          ? { id: 'resend', name: 'Resend waitlist', state: 'missing', steps: ['waitlist'], note: r.missing }
          : { id: 'resend', name: 'Resend waitlist', state: 'connected', steps: ['waitlist'], note: 'Sign-ups, read-only. Emails are hashed here and never reach the page.', count: r.rows.length },
      )
    } catch (e) {
      sources.push({ id: 'resend', name: 'Resend waitlist', state: 'error', steps: ['waitlist'], note: `Could not read: ${String(e.message).slice(0, 80)}` })
    }
  }

  const stripeKey = env.STRIPE_READ_KEY || (await keychain('stripe-read-key'))
  if (!stripeKey) {
    sources.push({ id: 'stripe', name: 'Stripe checkouts', state: 'missing', steps: ['pro'], note: 'Add a restricted, read-only Stripe key (Checkout Sessions: read) to the Keychain as stripe-read-key.' })
  } else {
    try {
      const r = await readStripe({ key: stripeKey })
      got.purchases = r.rows
      got.licences = r.licences
      sources.push({
        id: 'stripe',
        name: r.test ? 'Stripe checkouts · TEST MODE' : 'Stripe checkouts',
        state: 'connected',
        steps: ['pro'],
        note: r.test ? 'A test-mode key: these are test purchases, not customers.' : 'Completed Orbit Pro checkouts, read-only.',
        count: r.rows.length,
      })
    } catch (e) {
      sources.push({ id: 'stripe', name: 'Stripe checkouts', state: 'error', steps: ['pro'], note: `Could not read: ${String(e.message).slice(0, 80)}` })
    }
  }

  if (!env.PULSE_ENDPOINT || !env.PULSE_READ_TOKEN) {
    sources.push({ id: 'telemetry', name: 'App usage (opt-in)', state: 'none', steps: ['app', 'feature'], note: 'Not switched on: the pulse worker is not deployed. Needs legal sign-off first (TELEMETRY.md).' })
  } else {
    try {
      const r = await readTelemetry({ endpoint: env.PULSE_ENDPOINT, token: env.PULSE_READ_TOKEN })
      got.installs = r.rows
      site = r.site
      sources.push({ id: 'telemetry', name: 'App usage (opt-in)', state: 'connected', steps: ['app', 'feature'], note: 'Anonymous installs that said yes. Day-level only; never joined to a purchase.', count: r.rows.length })
    } catch (e) {
      sources.push({ id: 'telemetry', name: 'App usage (opt-in)', state: 'error', steps: ['app', 'feature'], note: `Could not read: ${String(e.message).slice(0, 80)}` })
    }
  }

  sources.push(
    !stripeKey
      ? { id: 'licence', name: 'Licence activations', state: 'missing', steps: ['licence', 'app'], note: 'Read from Stripe subscriptions: needs stripe-read-key.' }
      : got.licences === null
        ? { id: 'licence', name: 'Licence activations', state: 'missing', steps: ['licence', 'app'], note: 'Give stripe-read-key "Subscriptions: Read" as well.' }
        : {
            id: 'licence',
            name: 'Licence activations',
            state: 'connected',
            steps: ['licence', 'app'],
            note: 'Recorded on the subscription by the site\'s licence check (feature/users-signals, not yet deployed). Pro users only.',
            count: got.licences.size,
          },
  )
  const weekViews = (site ?? []).filter((d) => Date.parse(`${d.day}T00:00:00Z`) >= now - 7 * DAY).reduce((a, d) => a + d.views, 0)
  sources.unshift(
    site
      ? { id: 'site', name: 'laikaorbit.com page views', state: 'connected', steps: ['site'], note: 'Daily counts from the site beacon. Counted, never people, as the privacy page promises.', count: weekViews }
      : { id: 'site', name: 'laikaorbit.com page views', state: 'none', steps: ['site'], note: 'Needs the pulse worker deployed and the site built with PUBLIC_PULSE_ENDPOINT (feature/users-signals).' },
  )

  const feed = {
    mode: 'real',
    now,
    activeGrain: 'day',
    sources,
    people: buildPeople({ ...got, salt: salt(), now }),
    ...(site ? { counts: { site: { n: weekViews, note: 'page views this week · counted, not people' } } } : {}),
  }
  cache = { at: now, feed }
  return feed
}

export async function handleUsers(url, req, res) {
  if (url.pathname !== '/api/users') return false
  if (req.method !== 'GET') {
    res.writeHead(405).end()
    return true
  }
  try {
    const feed = await usersFeed({ force: url.searchParams.has('fresh') })
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(feed))
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: String(e?.message || e).slice(0, 200) }))
  }
  return true
}
