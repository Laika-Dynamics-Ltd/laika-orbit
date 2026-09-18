/**
 * Opt-in, anonymous usage reporting — off until the user turns it on, and silent when off.
 *
 * WHY THIS EXISTS AT ALL, IN AN APP THAT PROMISES TO STAY ON YOUR MACHINE: because the promise is
 * what makes the opt-in meaningful. Nothing here runs, and no network call is made, unless the
 * user has said yes; declining does not even create an identifier. The consent file is the whole
 * gate, and it starts as 'unset'.
 *
 * WHY IT SHIPS IN THE FIRST PUBLIC BUILD even though the dashboard came later: consent cannot be
 * applied retroactively. Someone who installs today and is never asked can never be counted
 * honestly, so the ask has to be in the build they install.
 *
 * What may be sent, in full:
 *   - a random uuid, made on this Mac the moment consent was given, and belonging to no account
 *   - the app version and the platform string ('darwin')
 *   - counts of the coarse events in ALLOWED, per UTC day
 *
 * What is never sent, and has no code path that could: file names, paths, folder names, search
 * queries, recall results, chat text, prompts, model names, email, calendar entries, browser URLs,
 * account names, hostnames, IP addresses (the endpoint does not log them either), or any
 * timestamp finer than a day.
 *
 *   ~/.laika/pulse/consent.json   { state: 'unset' | 'on' | 'off', at, install }
 *   ~/.laika/pulse/outbox.json    unsent daily counts, so a restart loses nothing
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIR } from './pulse.mjs'

/** the same list the worker enforces; kept here so a typo fails locally, not in the database */
export const ALLOWED = new Set([
  'app_open', 'session_start', 'map_open', 'recall_run', 'chat_open', 'chat_message',
  'browser_open', 'widget_open', 'index_rebuild', 'offload_run', 'settings_open',
  'progress_open', 'pulse_open',
])

const ENDPOINT = process.env.PULSE_ENDPOINT || ''
const FLUSH_MS = Number(process.env.PULSE_FLUSH_MINS || 30) * 60_000
const consentPath = () => join(DIR, 'consent.json')
const outboxPath = () => join(DIR, 'outbox.json')
const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)

function read(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function write(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, path)
}

/** Current consent. 'unset' means the user has not been asked, or has not answered. */
export function consent() {
  const c = read(consentPath(), null)
  const state = c?.state === 'on' || c?.state === 'off' ? c.state : 'unset'
  return { state, at: c?.at ?? null, install: state === 'on' ? (c?.install ?? null) : null }
}

/**
 * Record an answer.
 *
 * Turning it on mints the install id; turning it off destroys it along with anything queued, so
 * a user who changes their mind leaves nothing behind and comes back as a new install rather
 * than being re-joined to their old one.
 */
export function setConsent(on, { now = Date.now() } = {}) {
  if (!on) {
    write(consentPath(), { state: 'off', at: now })
    if (existsSync(outboxPath())) write(outboxPath(), {})
    return consent()
  }
  const prior = consent()
  write(consentPath(), { state: 'on', at: now, install: prior.install ?? randomUUID() })
  return consent()
}

/**
 * Count one event. The hot path: called from the app on ordinary actions, so when consent is off
 * it must cost nothing but a file-less check.
 */
export function count(name, n = 1, { now = Date.now() } = {}) {
  if (!ALLOWED.has(name)) return false // a typo here would be silently dropped by the worker
  if (consent().state !== 'on') return false
  const day = today(now)
  const box = read(outboxPath(), {})
  box[day] = box[day] ?? {}
  box[day][name] = (box[day][name] ?? 0) + Math.max(1, Math.floor(n))
  // days older than the worker's window would be refused, so never keep them
  for (const d of Object.keys(box)) if (d < today(now - 45 * 86_400_000)) delete box[d]
  write(outboxPath(), box)
  return true
}

/** The outbox as the wire shape, or null when there is nothing to say. */
export function batch({ now = Date.now(), app = null } = {}) {
  const c = consent()
  if (c.state !== 'on' || !c.install) return null
  const box = read(outboxPath(), {})
  const events = []
  for (const [day, names] of Object.entries(box)) {
    for (const [name, n] of Object.entries(names)) {
      if (ALLOWED.has(name) && n > 0) events.push({ name, day, count: n })
    }
  }
  if (!events.length) return null
  return { v: 1, install: c.install, app, platform: process.platform, events: events.slice(0, 60) }
}

/**
 * Send what is queued.
 *
 * The outbox is not cleared on success: the client sends running daily totals and the worker
 * keeps the larger of the two, so a lost response or a duplicate delivery settles to the right
 * number instead of losing or doubling a day. Only days past the window are ever dropped.
 */
export async function flush({ now = Date.now(), app = null, endpoint = ENDPOINT, fetchImpl = fetch } = {}) {
  if (!endpoint) return { ok: false, reason: 'no-endpoint' }
  const body = batch({ now, app })
  if (!body) return { ok: false, reason: consent().state === 'on' ? 'nothing-queued' : 'not-consented' }
  try {
    const res = await fetchImpl(`${endpoint.replace(/\/$/, '')}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { ok: false, reason: `http-${res.status}` }
    return { ok: true, sent: body.events.length }
  } catch (e) {
    // never let reporting break the app, and never retry hard: the next flush carries the same
    // totals anyway
    return { ok: false, reason: String(e?.message || e).slice(0, 80) }
  }
}

/** Flush on a timer for as long as the server runs. Unref'd, so it never holds the process open. */
export function startReporting({ app = null } = {}) {
  if (!ENDPOINT) return null
  const t = setInterval(() => {
    if (consent().state === 'on') flush({ app }).catch(() => {})
  }, FLUSH_MS)
  t.unref?.()
  return t
}
