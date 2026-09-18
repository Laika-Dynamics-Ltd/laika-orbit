/**
 * Public adoption signals: who is arriving at the repo, from GitHub's own numbers.
 *
 * Nothing here is telemetry and nothing here needs a user's consent — these are counts GitHub
 * already keeps about a public repo, and they are the only view of adoption available before
 * anyone opts in to anything.
 *
 * WHY IT IS FETCHED ON A TIMER AND KEPT: `/traffic/*` is a 14-day rolling window and GitHub
 * throws away what falls out of it. Miss a fortnight and that fortnight is gone for good, so the
 * feed folds every fetch into the pulse store (packages/app/pulse.mjs) and the page reads the
 * store, never the API. That also means a rate limit, an expired token or no network costs only
 * freshness.
 *
 *   traffic/views · traffic/clones   daily count + uniques, last 14 days   (needs push access)
 *   repo                             stars and forks, a running total
 *   releases                         per-asset download counts, a running total
 *
 * The token needs `repo` scope to read traffic, which is why it lives in the Keychain rather
 * than .env.local: it is a credential for your own repo, not a setting.
 *
 *   Keychain   service "laika-orbit secret", account "pulse-github-token"
 *   or         PULSE_GITHUB_TOKEN / GITHUB_TOKEN in the environment
 */
import { execFile } from 'node:child_process'
import { putSignals, readCache, writeCache } from '../pulse.mjs'

const API = 'https://api.github.com'
export const REPO = process.env.PULSE_REPO || 'Laika-Dynamics-Ltd/laika-orbit'
const SERVICE = 'laika-orbit secret'
const ACCOUNT = 'pulse-github-token'
/** GitHub's traffic numbers only move once an hour; asking faster just spends rate limit */
const REFRESH_MS = Number(process.env.PULSE_REFRESH_MINS || 30) * 60_000

/** the token, from the environment or this Mac's Keychain; null when the feed is unconfigured */
export function token() {
  const env = process.env.PULSE_GITHUB_TOKEN || process.env.GITHUB_TOKEN
  if (env) return Promise.resolve(env.trim())
  if (process.platform !== 'darwin') return Promise.resolve(null)
  return new Promise((done) =>
    execFile('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], { timeout: 10_000 }, (err, out) =>
      done(err ? null : String(out).trim() || null),
    ),
  )
}

/**
 * A traffic response → signals. `views` and `clones` differ only in the array's name, so one
 * parser does both. Pure: the tests drive it with GitHub's documented shape.
 */
export function parseTraffic(body, kind) {
  const rows = body?.[kind === 'view' ? 'views' : 'clones']
  if (!Array.isArray(rows)) return []
  return rows
    .filter((r) => r?.timestamp)
    .map((r) => ({
      at: Date.parse(r.timestamp),
      kind,
      id: `${kind}-${String(r.timestamp).slice(0, 10)}`,
      count: Number(r.count) || 0,
      uniques: Number(r.uniques) || 0,
    }))
    .filter((s) => Number.isFinite(s.at) && s.uniques > 0)
}

/**
 * Stars and forks are running totals, not a daily series, so a signal is only worth writing when
 * the total moved. `prior` is the last total we saw; the signal carries the delta.
 */
export function parseCounts(repo, prior, now = Date.now()) {
  const out = []
  const d = new Date(now).toISOString().slice(0, 10)
  for (const [kind, field] of [['star', 'stargazers_count'], ['fork', 'forks_count']]) {
    const total = Number(repo?.[field])
    if (!Number.isFinite(total)) continue
    const was = Number(prior?.[field])
    const delta = Number.isFinite(was) ? total - was : total
    if (delta > 0) out.push({ at: now, kind, id: `${kind}-${d}`, count: delta, uniques: delta, meta: { total } })
  }
  return out
}

/** Release assets → one download signal for the day, counting the whole catalogue's movement. */
export function parseReleases(releases, prior, now = Date.now()) {
  if (!Array.isArray(releases)) return []
  const total = releases.reduce((t, r) => t + (Array.isArray(r?.assets) ? r.assets.reduce((a, x) => a + (Number(x?.download_count) || 0), 0) : 0), 0)
  const was = Number(prior)
  const delta = Number.isFinite(was) ? total - was : total
  if (delta <= 0) return []
  const d = new Date(now).toISOString().slice(0, 10)
  return [{ at: now, kind: 'download', id: `download-${d}`, count: delta, uniques: delta, meta: { total } }]
}

async function get(path, tok) {
  const res = await fetch(`${API}${path}`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${tok}`, 'user-agent': 'laika-orbit-pulse' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`${path}: ${res.status}`)
  return res.json()
}

/**
 * Fetch every public signal and fold it into the store.
 *
 * Returns a status the settings panel and the page can show, including *why* it is idle, because
 * "no data" and "no token" look the same on a graph and mean very different things.
 */
export async function syncGithub({ force = false, now = Date.now() } = {}) {
  const last = readCache('github', null)
  if (!force && last?.at && now - last.at < REFRESH_MS) {
    return { ...last.status, cached: true, at: last.at }
  }
  const tok = await token()
  if (!tok) {
    return { ok: false, reason: 'no-token', repo: REPO, hint: 'add a repo-scoped token: pulse-github-token in the Keychain, or PULSE_GITHUB_TOKEN' }
  }
  const signals = []
  const status = { ok: true, repo: REPO, fetched: [], failed: [] }
  const step = async (name, fn) => {
    try {
      await fn()
      status.fetched.push(name)
    } catch (e) {
      // one dead endpoint must not lose the others: a token without push access still reads
      // stars and releases, and that is a useful page
      status.failed.push({ name, error: String(e.message || e).slice(0, 120) })
    }
  }

  await step('views', async () => signals.push(...parseTraffic(await get(`/repos/${REPO}/traffic/views`, tok), 'view')))
  await step('clones', async () => signals.push(...parseTraffic(await get(`/repos/${REPO}/traffic/clones`, tok), 'clone')))
  await step('repo', async () => {
    const repo = await get(`/repos/${REPO}`, tok)
    signals.push(...parseCounts(repo, last?.repo, now))
    status.repo_counts = { stars: repo.stargazers_count, forks: repo.forks_count }
    status.raw = { stargazers_count: repo.stargazers_count, forks_count: repo.forks_count }
  })
  await step('releases', async () => {
    const rel = await get(`/repos/${REPO}/releases?per_page=100`, tok)
    const sig = parseReleases(rel, last?.downloads, now)
    signals.push(...sig)
    status.downloads = sig[0]?.meta?.total ?? last?.downloads ?? 0
  })

  if (signals.length) putSignals(signals)
  status.ok = status.fetched.length > 0
  status.signals = signals.length
  writeCache('github', { at: now, status, repo: status.raw ?? last?.repo, downloads: status.downloads ?? last?.downloads })
  return { ...status, at: now }
}
