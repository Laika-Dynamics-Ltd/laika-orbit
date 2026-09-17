/**
 * Email feed: the Gmail API → brain/widgets/email.json.
 *
 * Read-only (gmail.readonly). Each poll lists message ids from the last 7 days and
 * fetches headers only for ids it has not seen, so after the first run a poll is a
 * couple of list calls. "Needs you" is unread mail from a real person: not a Gmail
 * promotions/social/updates/forums category, no List-Unsubscribe header, and not from a
 * no-reply style address.
 *
 * Credentials: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env.local (the OAuth app),
 * and a refresh token from the one-time /api/gmail/connect sign-in, kept in the macOS
 * Keychain. Only `items`, `refreshedAt`, `source` and the figures are replaced; the
 * widget's own settings are kept.
 */
import { execFile } from 'node:child_process'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)
const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
export const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
const KEYCHAIN = { service: 'laika-1brain gmail', account: 'refresh-token' }

// ------------------------------------------------------------ credentials ----
export async function readRefreshToken() {
  if (process.env.GMAIL_REFRESH_TOKEN) return process.env.GMAIL_REFRESH_TOKEN
  try {
    const { stdout } = await run('security', ['find-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-w'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

export async function deleteRefreshToken() {
  await run('security', ['delete-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account]).catch(() => {})
}

/** Tell Google to drop the grant, so a disconnect is real and not just a forgotten token. */
export async function revokeToken(token, fetchImpl = fetch) {
  const res = await fetchImpl('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(20_000),
  })
  return res.ok
}

export async function saveRefreshToken(token) {
  // -U updates an existing item; the token is passed as an argument to a local process only
  await run('security', ['add-generic-password', '-U', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-w', token])
}

export function authorizeUrl({ clientId, redirectUri, state }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent', // always return a refresh token, even on a second connect
    include_granted_scopes: 'true',
    state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`
}

async function tokenCall(body, fetchImpl) {
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(20_000),
  })
  const json = await res.json().catch(() => ({}))
  // never echo the request: it carries the secret
  if (!res.ok) throw new Error(`google token endpoint: ${json.error ?? res.status}${json.error_description ? ` (${json.error_description})` : ''}`)
  return json
}

export async function exchangeCode({ clientId, clientSecret, redirectUri, code, fetchImpl = fetch }) {
  const t = await tokenCall(
    { client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code, grant_type: 'authorization_code' },
    fetchImpl,
  )
  if (!t.refresh_token) throw new Error('Google returned no refresh token; remove the app at myaccount.google.com/permissions and connect again')
  return t.refresh_token
}

let access = { token: '', until: 0 }
async function accessToken({ clientId, clientSecret, refreshToken }, fetchImpl) {
  if (access.token && Date.now() < access.until - 60_000) return access.token
  const t = await tokenCall(
    { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' },
    fetchImpl,
  )
  access = { token: t.access_token, until: Date.now() + (t.expires_in ?? 3600) * 1000 }
  return access.token
}

// --------------------------------------------------------------- classify ----
const header = (msg, name) =>
  msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''

/** `"Jane Doe" <jane@x.com>` → { name: 'Jane Doe', email: 'jane@x.com' } */
export function parseFrom(raw) {
  const m = String(raw).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() }
  return { name: '', email: String(raw).trim().toLowerCase() }
}

// automated senders: by the mailbox name, or by a sending subdomain (post.xero.com, em.x.com)
const ROBOT_NAME = /(^|[.+_-])(no-?reply|do-?not-?reply|notifications?|notify|alerts?|mailer(-daemon)?|bounces?|updates?|news(letter)?|marketing|messaging|support|info|hello|team|billing|accounts?|service|system|automated|postmaster|receipts?|invoices?)([.+_-]|@)/i
const ROBOT_HOST = /@(post|mail|mailer|email|em\d*|e|mg|mta|bounce|notify|notifications?|news|marketing|send|comms)\./i
const isRobot = (email) => ROBOT_NAME.test(email) || ROBOT_HOST.test(email)

/** Default segments, first match wins. `senders` are matched against the sender's domain. */
export const DEFAULT_SEGMENTS = [
  { label: 'ALERTS', accent: '#ff5470', senders: ['sentry.io', 'getsentry.com', 'vercel.com', 'github.com', 'statuspage.io'] },
  { label: 'BILLING', accent: '#ffc94f', senders: ['xero.com', 'stripe.com', 'paypal.com'] },
  { label: 'PEOPLE', accent: '#3ddc97', people: true },
  { label: 'NEWS', accent: '#5b9dff', labels: ['CATEGORY_UPDATES', 'CATEGORY_FORUMS'], bulk: true },
  { label: 'NOISE', accent: '#3a4260', rest: true },
]

/** Reduce a Gmail message (format=metadata) to what the widget needs. */
export function summarise(msg) {
  const from = parseFrom(header(msg, 'From'))
  const labels = msg.labelIds ?? []
  const bulk = !!header(msg, 'List-Unsubscribe') || /bulk|list|junk/i.test(header(msg, 'Precedence'))
  const promo = labels.some((l) => ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'].includes(l))
  return {
    id: msg.id,
    threadId: msg.threadId,
    at: Number(msg.internalDate) || 0,
    from,
    subject: header(msg, 'Subject') || '(no subject)',
    labels,
    bulk,
    person: !bulk && !promo && !isRobot(from.email) && !labels.includes('SPAM') && !labels.includes('SENT'),
  }
}

export function segmentOf(m, segments = DEFAULT_SEGMENTS) {
  const domain = m.from.email.split('@')[1] ?? ''
  for (const s of segments) {
    if (s.senders?.some((d) => domain === d || domain.endsWith(`.${d}`))) return s.label
    if (s.people && m.person) return s.label
    if (s.labels?.some((l) => m.labels.includes(l)) || (s.bulk && m.bulk && !m.labels.includes('CATEGORY_PROMOTIONS'))) return s.label
    if (s.rest) return s.label
  }
  return 'OTHER'
}

function age(ms, now) {
  const m = Math.max(0, Math.round((now - ms) / 60_000))
  if (m < 60) return `${Math.max(1, m)}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

// ------------------------------------------------------------------ fetch ----
async function gmail(path, token, fetchImpl) {
  const res = await fetchImpl(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (res.status === 401) access = { token: '', until: 0 }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    throw new Error(`gmail ${path.split('?')[0]}: ${j.error?.message ?? `HTTP ${res.status}`}`)
  }
  return res.json()
}

async function listIds(q, token, fetchImpl, cap = 1500) {
  const ids = []
  let pageToken = ''
  do {
    const p = new URLSearchParams({ q, maxResults: '500', ...(pageToken ? { pageToken } : {}) })
    const page = await gmail(`/messages?${p}`, token, fetchImpl)
    for (const m of page.messages ?? []) ids.push(m.id)
    pageToken = page.nextPageToken ?? ''
  } while (pageToken && ids.length < cap)
  return ids
}

/** Message summaries by id, kept across polls: headers do not change once sent. */
const cache = new Map()

export function resetEmailCache() {
  cache.clear()
  access = { token: '', until: 0 }
}

/**
 * One poll. Returns the number of messages in the window.
 * `creds` = { clientId, clientSecret, refreshToken }.
 */
export async function refreshEmail({ creds, file, days = 7, flaggedMax = 6, selfEmails = [], now = Date.now(), fetchImpl = fetch }) {
  const widget = JSON.parse(await readFile(file, 'utf8'))
  const token = await accessToken(creds, fetchImpl)
  const window = `newer_than:${days}d -in:chats -in:spam -in:trash`

  const [ids, unread, profile] = await Promise.all([
    listIds(`${window} -in:sent`, token, fetchImpl),
    listIds(`${window} is:unread -in:sent`, token, fetchImpl, 500),
    gmail('/profile', token, fetchImpl),
  ])

  // headers for new ids only, a few at a time
  const missing = ids.filter((id) => !cache.has(id))
  const fields = ['From', 'Subject', 'List-Unsubscribe', 'Precedence'].map((h) => `metadataHeaders=${h}`).join('&')
  for (let i = 0; i < missing.length; i += 10) {
    const batch = await Promise.all(
      missing.slice(i, i + 10).map((id) => gmail(`/messages/${id}?format=metadata&${fields}`, token, fetchImpl)),
    )
    for (const msg of batch) cache.set(msg.id, summarise(msg))
  }
  const keep = new Set(ids)
  for (const id of cache.keys()) if (!keep.has(id)) cache.delete(id)

  const msgs = ids.map((id) => cache.get(id)).filter(Boolean)
  const segDefs = widget.config?.emailSegments ?? DEFAULT_SEGMENTS
  const counts = new Map(segDefs.map((s) => [s.label, 0]))
  for (const m of msgs) {
    const s = segmentOf(m, segDefs)
    counts.set(s, (counts.get(s) ?? 0) + 1)
  }

  const unreadSet = new Set(unread)
  // mail from your own address (notes to self, forwards) never needs you
  const self = new Set([profile.emailAddress, ...selfEmails].filter(Boolean).map((e) => String(e).toLowerCase()))
  const needs = msgs
    .filter((m) => m.person && unreadSet.has(m.id) && !self.has(m.from.email))
    .sort((a, b) => b.at - a.at)
  const shown = needs.slice(0, flaggedMax)

  const synced = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: widget.config?.home ?? undefined,
  }).format(now)

  const next = {
    ...widget,
    source: 'gmail · api',
    refreshedAt: new Date(now).toISOString(),
    config: {
      ...widget.config,
      value: String(msgs.length),
      valueLabel: `EMAILS\\nPAST ${days}D`,
      flaggedLabel: `NEEDS YOU · ${needs.length} UNREAD FROM PEOPLE`,
      segments: segDefs
        .map((s) => ({ label: s.label, n: counts.get(s.label) ?? 0, accent: s.accent }))
        .filter((s) => s.n > 0),
      footer: `SYNCED ${synced} · ${profile.emailAddress ?? ''}`.trim(),
      unread: unread.length,
    },
    items: shown.map((m) => ({
      title: `${m.from.name || m.from.email.split('@')[0]} — ${m.subject}`,
      meta: age(m.at, now),
      href: `https://mail.google.com/mail/u/0/#inbox/${m.threadId}`,
      accent: '#3ddc97',
    })),
  }
  if (!shown.length) next.config.empty = 'Inbox zero from people. Nice.'
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`)
  await rename(tmp, file)
  return { count: msgs.length, account: profile.emailAddress ?? '', needs: needs.length, unread: unread.length }
}
