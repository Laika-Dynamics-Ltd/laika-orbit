/**
 * Supabase: every account's projects in one place, their schemas, and a raw SQL console.
 *
 * An account is a Supabase personal access token (`sbp_…`), kept in the macOS Keychain and
 * addressed by a label you choose. The token never reaches the browser: the panel asks for
 * projects, schema and query results by label, and this module attaches the token here.
 *
 *   Keychain   service "laika-orbit supabase", account = the label
 *
 * A PAT is account-wide and the query endpoint runs with full rights on the project's database,
 * so this is a console for databases you own, not a credential to hand around. Tokens live in
 * their own Keychain service rather than the chat one (secrets.mjs), so a chat's `secret_list`
 * never sees them and nothing here can read a chat's secrets.
 *
 * Everything goes through the Management API (api.supabase.com) with plain fetch: project
 * discovery is one call per account, and schema is SQL against `information_schema` through the
 * same query endpoint the console uses, so there is one code path to keep right and no Postgres
 * driver to add.
 *
 * Read-only is the default and is enforced *here*, before the statement leaves this machine:
 * `readOnly()` (src/sql.ts, shared with the panel) classifies the SQL, and anything it will not
 * vouch for is refused without being sent. The check is lexical, not the database's own —
 * Postgres never sees the statement to veto it — so it is a guard against a mistyped `DELETE`,
 * not a sandbox for hostile SQL. Turning writes on is a per-request flag the panel makes you
 * set deliberately.
 *
 * Routes:
 *   GET    /api/supabase/accounts                    { available, accounts: [{label, source}] }
 *   POST   /api/supabase/accounts  {label, token}    store a PAT in the Keychain
 *   PATCH  /api/supabase/accounts/<label> {label}    rename one (the token moves with it)
 *   DELETE /api/supabase/accounts/<label>            forget one
 *   GET    /api/supabase/orgs?account=<label>        the organisations that token can see
 *   GET    /api/supabase/project?account=&ref=       one project: region, status, URL, API keys
 *   GET    /api/supabase/projects?account=<label>    that account's projects (cached 60s)
 *   GET    /api/supabase/schema?account=&ref=        tables and columns, grouped by schema
 *   POST   /api/supabase/query {account, ref, sql, allowWrites}
 *                                                    { columns, rows, rowCount, ms, truncated }
 */
import { execFile } from 'node:child_process'
import { firstWrite, readOnly } from './src/sql.ts'

const API = 'https://api.supabase.com/v1'
const SERVICE = 'laika-orbit supabase'
/** a label names an account; it is never a value, and it goes into a Keychain query */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const validLabel = (l) => typeof l === 'string' && LABEL.test(l)
/** a PAT as Supabase issues it; checked so a mistyped paste fails here rather than at the API */
const TOKEN = /^sbp_[A-Za-z0-9]{20,}$/
/** rows past this are dropped before the result is sent: a stray `select *` must not wedge the UI */
const MAX_ROWS = 2000
/** the Management API is rate limited and some queries are slow; neither should hang the panel */
const TIMEOUT_MS = 30_000
const PROJECTS_TTL = 60_000

export const available = () => process.platform === 'darwin' || Boolean(process.env.SUPABASE_ACCESS_TOKEN)

// ------------------------------------------------------------------ the keychain ----

const security = (args, input) =>
  new Promise((resolve, reject) => {
    const p = execFile('security', args, { timeout: 15_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).trim().slice(0, 200))) : resolve(stdout),
    )
    if (input !== undefined) p.stdin.end(input)
  })

/** quoted for `security -i`, which splits its lines like a shell: backslash and quote escaped */
const quote = (s) => `"${String(s).replace(/[\\"]/g, '\\$&')}"`

async function saveToken(label, token) {
  if (!validLabel(label)) throw new Error('A label is letters, digits, dot, dash and underscore')
  if (!TOKEN.test(String(token ?? '').trim())) throw new Error('That is not a Supabase personal access token (they start with sbp_)')
  if (process.platform !== 'darwin') throw new Error('Storing a token needs the macOS Keychain; elsewhere set SUPABASE_ACCESS_TOKEN')
  const line = ['add-generic-password', '-U', '-s', quote(SERVICE), '-a', quote(label), '-l', quote(`${SERVICE}: ${label}`), '-w', quote(String(token).trim())]
  // the token goes in on stdin, never on a command line, so `ps` cannot show it
  // `security -i` exits 0 even when a command in it fails, so check the item is really there
  await security(['-i'], `${line.join(' ')}\n`)
  if (!(await readToken(label))) throw new Error('The Keychain did not accept it')
}

async function readToken(label) {
  if (!validLabel(label)) return null
  if (label === 'env') return process.env.SUPABASE_ACCESS_TOKEN || null
  if (process.platform !== 'darwin') return null
  try {
    return (await security(['find-generic-password', '-s', SERVICE, '-a', label, '-w'])).trim() || null
  } catch {
    return null
  }
}

async function forgetToken(label) {
  if (!validLabel(label) || process.platform !== 'darwin') return false
  try {
    await security(['delete-generic-password', '-s', SERVICE, '-a', label])
    return true
  } catch {
    return false
  }
}

/** renaming is a move: the same token under a new label, and the old item gone only once it lands */
async function renameToken(from, to) {
  if (!validLabel(to)) throw new Error('A label is letters, digits, dot, dash and underscore')
  if (from === to) return
  if (from === 'env') throw new Error('The env account comes from SUPABASE_ACCESS_TOKEN and cannot be renamed')
  const token = await readToken(from)
  if (!token) throw new Error(`No token stored for "${from}"`)
  if (await readToken(to)) throw new Error(`"${to}" is already connected`)
  await saveToken(to, token)
  await forgetToken(from)
}

/** labels only: parsed from the attributes `security` lists, which never include the values */
async function listAccounts() {
  const accounts = []
  if (process.env.SUPABASE_ACCESS_TOKEN) accounts.push({ label: 'env', source: 'env' })
  if (process.platform !== 'darwin') return accounts
  let out
  try {
    out = await security(['dump-keychain'])
  } catch {
    return accounts
  }
  const labels = new Set()
  for (const item of out.split(/^keychain: /m)) {
    if (!item.includes(`"svce"<blob>="${SERVICE}"`)) continue
    const m = /"acct"<blob>="([^"]*)"/.exec(item)
    if (m && validLabel(m[1])) labels.add(m[1])
  }
  for (const label of [...labels].sort()) accounts.push({ label, source: 'keychain' })
  return accounts
}

// ------------------------------------------------------------------ the API ----

async function call(token, path, init = {}) {
  let r
  try {
    r = await fetch(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? `Supabase did not answer within ${TIMEOUT_MS / 1000}s` : `Could not reach Supabase: ${e.message}`)
  }
  const text = await r.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    // an error page rather than JSON; the status and the text below say enough
  }
  if (!r.ok) {
    const why = body?.message ?? body?.error ?? body?.msg ?? text.slice(0, 300)
    if (r.status === 401) throw new Error('Supabase rejected that token. It may have been revoked — make a new one and save it again.')
    if (r.status === 429) throw new Error('Supabase is rate limiting this token. Wait a minute and try again.')
    throw new Error(why ? `Supabase: ${why}` : `Supabase returned ${r.status}`)
  }
  return body
}

/** token by label, or a clear error naming what is missing */
async function tokenFor(label) {
  const token = await readToken(label)
  if (!token) throw new Error(`No token stored for "${label}". Add the account again.`)
  return token
}

const projectCache = new Map()

export async function projects(label, { fresh = false } = {}) {
  const hit = projectCache.get(label)
  if (!fresh && hit && Date.now() - hit.at < PROJECTS_TTL) return hit.list
  const raw = await call(await tokenFor(label), '/projects')
  const list = (Array.isArray(raw) ? raw : [])
    .map((p) => ({
      ref: String(p.id ?? p.ref ?? ''),
      name: String(p.name ?? p.id ?? ''),
      org: p.organization_id ?? null,
      region: p.region ?? null,
      status: p.status ?? null,
      createdAt: p.created_at ?? null,
    }))
    .filter((p) => p.ref)
    .sort((a, b) => a.name.localeCompare(b.name))
  projectCache.set(label, { at: Date.now(), list })
  return list
}

/** the reference is in a URL path, so it is checked rather than trusted */
const REF = /^[a-z]{20}$/
const checkRef = (ref) => {
  if (!REF.test(String(ref ?? ''))) throw new Error('That is not a project reference')
  return ref
}

/**
 * Run SQL on a project. `allowWrites` is the panel's deliberate unlock; without it anything
 * `readOnly()` will not vouch for is refused here and never sent.
 */
export async function query(label, ref, sql, { allowWrites = false } = {}) {
  const text = String(sql ?? '').trim()
  if (!text) throw new Error('Nothing to run')
  if (text.length > 100_000) throw new Error('That statement is too long to send')
  if (!allowWrites && !readOnly(text)) {
    const kind = firstWrite(text)
    throw new Error(`Read-only: ${kind} was not run. Turn writes on for this project to run it.`)
  }
  const started = Date.now()
  const rows = await call(await tokenFor(label), `/projects/${checkRef(ref)}/database/query`, {
    method: 'POST',
    body: JSON.stringify({ query: text }),
  })
  const ms = Date.now() - started
  const list = Array.isArray(rows) ? rows : rows == null ? [] : [rows]
  // columns come from the rows, because the endpoint returns records rather than a described
  // result; the union keeps a column that is null in the first row but set in a later one
  const columns = []
  const seen = new Set()
  for (const row of list.slice(0, 200)) {
    if (!row || typeof row !== 'object') continue
    for (const k of Object.keys(row)) if (!seen.has(k)) (seen.add(k), columns.push(k))
  }
  return {
    columns,
    rows: list.slice(0, MAX_ROWS),
    rowCount: list.length,
    truncated: list.length > MAX_ROWS,
    ms,
    wrote: !readOnly(text),
  }
}

/** the organisations a token can see, so an account reads as more than a label you chose */
export async function orgs(label) {
  const raw = await call(await tokenFor(label), '/organizations')
  return (Array.isArray(raw) ? raw : []).map((o) => ({ id: String(o.id ?? ''), name: String(o.name ?? o.id ?? '') })).filter((o) => o.id)
}

/**
 * What a project is, beyond its name: where it lives, the URL its clients use, and its API keys.
 *
 * The keys are fetched only when this is asked for, never with the project list, and the panel
 * keeps them hidden until you ask to see one — a service_role key is a database superuser.
 */
export async function projectInfo(label, ref) {
  checkRef(ref)
  const token = await tokenFor(label)
  const [p, keys] = await Promise.all([
    (await projects(label)).find((x) => x.ref === ref) ?? null,
    call(token, `/projects/${ref}/api-keys?reveal=true`).catch(() => []),
  ])
  return {
    ...(p ?? { ref, name: ref }),
    url: `https://${ref}.supabase.co`,
    dashboard: `https://supabase.com/dashboard/project/${ref}`,
    keys: (Array.isArray(keys) ? keys : [])
      .map((k) => ({ name: String(k.name ?? k.type ?? ''), key: String(k.api_key ?? k.apiKey ?? '') }))
      .filter((k) => k.name && k.key),
  }
}

/** every table and column the console can see, grouped by schema — one query, no extra endpoint */
const SCHEMA_SQL = `
  select c.table_schema as schema,
         c.table_name   as name,
         t.table_type   as kind,
         c.column_name  as column,
         c.data_type    as type,
         c.is_nullable  as nullable,
         c.ordinal_position as pos
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
   where c.table_schema not in ('pg_catalog', 'information_schema', 'pg_toast')
     and c.table_schema not like 'pg_temp_%'
   order by c.table_schema, c.table_name, c.ordinal_position`

export async function schema(label, ref) {
  const { rows } = await query(label, ref, SCHEMA_SQL)
  /** schema name → tables, each with its columns in declaration order */
  const schemas = new Map()
  for (const r of rows) {
    const s = schemas.get(r.schema) ?? { name: r.schema, tables: new Map() }
    schemas.set(r.schema, s)
    const t = s.tables.get(r.name) ?? { name: r.name, kind: r.kind === 'VIEW' ? 'view' : 'table', columns: [] }
    s.tables.set(r.name, t)
    t.columns.push({ name: r.column, type: r.type, nullable: r.nullable === 'YES' })
  }
  // `public` first: it is what a Supabase project's own tables are in, and what you want open
  return [...schemas.values()]
    .map((s) => ({ name: s.name, tables: [...s.tables.values()] }))
    .sort((a, b) => (a.name === 'public' ? -1 : b.name === 'public' ? 1 : a.name.localeCompare(b.name)))
}

// ------------------------------------------------------------------ routes ----

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function body(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 200_000) throw new Error('that is too much to send')
  }
  if (!raw.trim()) return {}
  const v = JSON.parse(raw)
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('send a JSON object')
  return v
}

export async function handleSupabase(url, req, res) {
  if (!url.pathname.startsWith('/api/supabase')) return false
  const rest = url.pathname.slice('/api/supabase'.length).replace(/^\//, '')
  try {
    if (rest === 'accounts' && req.method === 'GET') {
      send(res, 200, { available: available(), keychain: process.platform === 'darwin', accounts: await listAccounts() })
      return true
    }
    if (rest === 'accounts' && req.method === 'POST') {
      const { label, token } = await body(req)
      await saveToken(String(label ?? '').trim(), token)
      projectCache.delete(String(label).trim())
      send(res, 200, { ok: true, accounts: await listAccounts() })
      return true
    }
    if (rest.startsWith('accounts/') && req.method === 'PATCH') {
      const from = decodeURIComponent(rest.slice('accounts/'.length))
      const { label } = await body(req)
      await renameToken(from, String(label ?? '').trim())
      projectCache.delete(from)
      send(res, 200, { ok: true, accounts: await listAccounts() })
      return true
    }
    if (rest.startsWith('accounts/') && req.method === 'DELETE') {
      const label = decodeURIComponent(rest.slice('accounts/'.length))
      const gone = await forgetToken(label)
      projectCache.delete(label)
      send(res, gone ? 200 : 404, gone ? { ok: true, accounts: await listAccounts() } : { error: `No account "${label}"` })
      return true
    }
    if (rest === 'projects' && req.method === 'GET') {
      const label = url.searchParams.get('account') ?? ''
      if (!validLabel(label)) throw new Error('account required')
      send(res, 200, { projects: await projects(label, { fresh: url.searchParams.has('fresh') }) })
      return true
    }
    if (rest === 'orgs' && req.method === 'GET') {
      const label = url.searchParams.get('account') ?? ''
      if (!validLabel(label)) throw new Error('account required')
      send(res, 200, { orgs: await orgs(label) })
      return true
    }
    if (rest === 'project' && req.method === 'GET') {
      const label = url.searchParams.get('account') ?? ''
      if (!validLabel(label)) throw new Error('account required')
      send(res, 200, await projectInfo(label, url.searchParams.get('ref')))
      return true
    }
    if (rest === 'schema' && req.method === 'GET') {
      const label = url.searchParams.get('account') ?? ''
      if (!validLabel(label)) throw new Error('account required')
      send(res, 200, { schemas: await schema(label, url.searchParams.get('ref')) })
      return true
    }
    if (rest === 'query' && req.method === 'POST') {
      const { account, ref, sql, allowWrites } = await body(req)
      if (!validLabel(account)) throw new Error('account required')
      send(res, 200, await query(account, ref, sql, { allowWrites: allowWrites === true }))
      return true
    }
    send(res, 404, { error: 'unknown supabase route' })
  } catch (e) {
    send(res, 400, { error: e.message })
  }
  return true
}
