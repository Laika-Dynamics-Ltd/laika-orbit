/**
 * Orbit Pro licences.
 *
 * A licence key is `LO1.<payload>.<signature>`, Ed25519-signed by laikaorbit.com. The app checks it
 * two ways:
 *   - **offline**, against the public key shipped with the app, which proves the key is genuine and
 *     names the subscription it belongs to;
 *   - **online**, against /api/license/verify, which says whether that subscription is still paying.
 *
 * The last online answer is cached, so Pro keeps working on a plane. After GRACE_DAYS without a
 * successful check, Pro switches off and the app carries on as the free version.
 *
 * Where things live:
 *   ~/.laika/license.json            the key and the cached status (chmod 600)
 *   packages/app/license.pub         the public key, written at release by the site's keygen
 *   ORBIT_LICENSE_PUBKEY             overrides the file, for testing
 *   ORBIT_SITE                       defaults to https://laikaorbit.com
 */
import { createPublicKey, verify } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const STORE = join(homedir(), '.laika', 'license.json')
const PUB_FILE = join(HERE, 'license.pub')
const SITE = () => (process.env.ORBIT_SITE || 'https://laikaorbit.com').replace(/\/+$/, '')
export const GRACE_DAYS = 14
const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000

/** The public key licences are signed with, or null when this build has none yet. */
export function publicKey() {
  const pem = process.env.ORBIT_LICENSE_PUBKEY || (existsSync(PUB_FILE) ? readFileSync(PUB_FILE, 'utf8') : '')
  if (!pem.trim()) return null
  try {
    return createPublicKey(pem.includes('BEGIN') ? pem : Buffer.from(pem, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

/** The payload if the key is genuine for this build, else null. Never throws. */
export function readKey(key) {
  const pub = publicKey()
  if (!pub) return null
  try {
    const [prefix, body, sig] = String(key).trim().split('.')
    if (prefix !== 'LO1' || !body || !sig) return null
    if (!verify(null, Buffer.from(`LO1.${body}`), pub, Buffer.from(sig, 'base64url'))) return null
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    return p?.v === 1 && p.plan === 'pro' && p.sub && p.lid ? p : null
  } catch {
    return null
  }
}

async function load() {
  try {
    return JSON.parse(await readFile(STORE, 'utf8'))
  } catch {
    return null
  }
}

async function save(state) {
  await mkdir(dirname(STORE), { recursive: true })
  await writeFile(STORE, JSON.stringify(state, null, 2), { mode: 0o600 })
  return state
}

/** Asks the site whether the subscription behind a key is still paying. */
async function checkOnline(key, { timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(`${SITE()}/api/license/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
      signal: ctrl.signal,
    })
    if (!r.ok) return { reached: false }
    const d = await r.json()
    return { reached: true, valid: Boolean(d.valid), status: d.status ?? null, renewsAt: d.renewsAt ?? null, cancelAtPeriodEnd: Boolean(d.cancelAtPeriodEnd), reason: d.reason ?? null }
  } catch {
    return { reached: false }
  } finally {
    clearTimeout(t)
  }
}

/**
 * What the app should believe right now. Pure read: it never calls the site, so the UI and any
 * feature gate can ask on every render.
 */
export function decide(state, now = Date.now()) {
  if (!state?.key) return { pro: false, state: 'none', detail: 'No licence key' }
  const payload = readKey(state.key)
  if (!payload) return { pro: false, state: 'invalid', detail: 'This key is not genuine for this build' }
  const last = state.lastCheck ?? 0
  const age = now - last
  if (state.valid && age <= GRACE_MS) {
    const daysLeft = Math.max(0, Math.ceil((GRACE_MS - age) / 86_400_000))
    return {
      pro: true,
      state: age < 86_400_000 ? 'active' : 'grace',
      detail: age < 86_400_000 ? 'Active' : `Active offline, ${daysLeft} day${daysLeft === 1 ? '' : 's'} before it needs to check in`,
      renewsAt: state.renewsAt ?? null,
      cancelAtPeriodEnd: Boolean(state.cancelAtPeriodEnd),
    }
  }
  if (state.valid) return { pro: false, state: 'stale', detail: `Not checked for ${GRACE_DAYS} days, so Pro is off until it can check in` }
  return { pro: false, state: 'inactive', detail: state.reason || `Subscription ${state.status ?? 'is not active'}` }
}

/** Current status, checking online at most once an hour unless forced. */
export async function status({ force = false } = {}) {
  const state = await load()
  if (!state?.key) return { ...decide(state), key: null }
  const stale = force || Date.now() - (state.lastCheck ?? 0) > 60 * 60 * 1000
  if (stale) {
    const online = await checkOnline(state.key)
    if (online.reached) {
      Object.assign(state, {
        valid: online.valid,
        status: online.status,
        renewsAt: online.renewsAt,
        cancelAtPeriodEnd: online.cancelAtPeriodEnd,
        reason: online.reason,
        lastCheck: Date.now(),
      })
      await save(state)
    }
  }
  return { ...decide(state), key: mask(state.key), checkedAt: state.lastCheck ?? null }
}

/** Saves a key after proving it is genuine and asking the site about it. */
export async function activate(key) {
  const trimmed = String(key ?? '').trim()
  if (!publicKey()) return { ok: false, error: 'This build has no licence key to check against yet.' }
  if (!readKey(trimmed)) return { ok: false, error: 'That does not look like an Orbit Pro licence key.' }
  const online = await checkOnline(trimmed)
  if (!online.reached) return { ok: false, error: 'Could not reach laikaorbit.com to check the licence. Try again when you are online.' }
  if (!online.valid) return { ok: false, error: online.reason || `That subscription is ${online.status ?? 'not active'}.` }
  const state = await save({
    key: trimmed,
    valid: true,
    status: online.status,
    renewsAt: online.renewsAt,
    cancelAtPeriodEnd: online.cancelAtPeriodEnd,
    lastCheck: Date.now(),
  })
  return { ok: true, ...decide(state), key: mask(state.key) }
}

export async function deactivate() {
  await save({})
  return { ok: true, ...decide(null) }
}

/** Never show a whole key back: it is a credential. */
export function mask(key) {
  const s = String(key ?? '')
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s ? '…' : null
}

/** The gate a Pro feature asks. */
export async function isPro() {
  return (await status()).pro
}

/** Routes: GET /api/license (status), POST /api/license/activate, POST /api/license/deactivate. */
export async function handleLicense(url, req, res) {
  if (!url.pathname.startsWith('/api/license')) return false
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const body = async () => {
    const chunks = []
    for await (const c of req) {
      chunks.push(c)
      if (chunks.reduce((n, b) => n + b.length, 0) > 8192) throw new Error('too big')
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  }

  try {
    if (url.pathname === '/api/license' && req.method === 'GET') {
      send(200, { ...(await status({ force: url.searchParams.has('force') })), configured: Boolean(publicKey()) })
      return true
    }
    if (url.pathname === '/api/license/activate' && req.method === 'POST') {
      const r = await activate((await body()).key)
      send(r.ok ? 200 : 400, r)
      return true
    }
    if (url.pathname === '/api/license/deactivate' && req.method === 'POST') {
      send(200, await deactivate())
      return true
    }
  } catch (e) {
    send(500, { ok: false, error: String(e?.message ?? e) })
    return true
  }
  return false
}
