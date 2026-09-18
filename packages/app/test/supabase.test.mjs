import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleSupabase } from '../supabase.mjs'

/**
 * The Supabase routes, with Supabase itself replaced by a recorded fetch. What is worth pinning
 * here is not the happy path but the boundary: a write is refused *before* anything leaves the
 * machine, a project reference is checked before it goes into a URL, and the token never appears
 * in what the panel is sent back.
 *
 * The `env` account (SUPABASE_ACCESS_TOKEN) is used throughout, so no test touches the Keychain.
 */

const TOKEN = 'sbp_0123456789abcdefghijklmnopqrstuvwxyz'

/** enough of ServerResponse to read the status and the body back */
function fakeRes() {
  const res = {
    code: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      res.code = code
      res.headers = headers
    },
    end(body) {
      res.body = body ?? ''
    },
    get json() {
      return JSON.parse(res.body || '{}')
    },
  }
  return res
}

/** a request the route can read a body off, the way node's does */
const fakeReq = (method, body) => ({
  method,
  async *[Symbol.asyncIterator]() {
    if (body !== undefined) yield typeof body === 'string' ? body : JSON.stringify(body)
  },
})

const call = async (path, method = 'GET', body) => {
  const res = fakeRes()
  const handled = await handleSupabase(new URL(path, 'http://x'), fakeReq(method, body), res)
  return { handled, res }
}

/** every fetch the module made, recorded as it is made */
let calls = []
const reply = (value) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) })

beforeEach(() => {
  calls = []
  process.env.SUPABASE_ACCESS_TOKEN = TOKEN
  vi.stubGlobal('fetch', async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', auth: init?.headers?.authorization, body: init?.body ? JSON.parse(init.body) : null })
    if (String(url).endsWith('/projects')) return reply([{ id: 'abcdefghijklmnopqrst', name: 'orbit', region: 'eu-west-2', status: 'ACTIVE_HEALTHY' }])
    return reply([{ id: 1, name: 'ada', email: null }, { id: 2, name: 'grace', nickname: 'amazing' }])
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.SUPABASE_ACCESS_TOKEN
})

describe('supabase routes', () => {
  it('leaves anything that is not its own path alone', async () => {
    expect((await call('/api/graph')).handled).toBe(false)
  })

  it('lists the env account without going near the Keychain', async () => {
    const { res } = await call('/api/supabase/accounts')
    expect(res.code).toBe(200)
    expect(res.json.accounts).toContainEqual({ label: 'env', source: 'env' })
    expect(res.body).not.toContain(TOKEN)
  })

  it('lists projects, and attaches the token itself rather than passing it out', async () => {
    const { res } = await call('/api/supabase/projects?account=env&fresh=1')
    expect(res.code).toBe(200)
    expect(res.json.projects).toEqual([
      { ref: 'abcdefghijklmnopqrst', name: 'orbit', org: null, region: 'eu-west-2', status: 'ACTIVE_HEALTHY', createdAt: null },
    ])
    expect(calls[0].auth).toBe(`Bearer ${TOKEN}`)
    expect(res.body).not.toContain(TOKEN)
  })

  it('runs a read and shapes the columns from every row, not just the first', async () => {
    const { res } = await call('/api/supabase/query', 'POST', { account: 'env', ref: 'abcdefghijklmnopqrst', sql: 'select * from users' })
    expect(res.code).toBe(200)
    // `nickname` is missing from row 1 and set in row 2; `email` is null in row 1 and must survive
    expect(res.json.columns).toEqual(['id', 'name', 'email', 'nickname'])
    expect(res.json.rowCount).toBe(2)
    expect(res.json.wrote).toBe(false)
    expect(calls[0].url).toBe('https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/database/query')
    expect(calls[0].body).toEqual({ query: 'select * from users' })
  })

  it('refuses a write before it leaves the machine', async () => {
    const { res } = await call('/api/supabase/query', 'POST', { account: 'env', ref: 'abcdefghijklmnopqrst', sql: 'delete from users' })
    expect(res.code).toBe(400)
    expect(res.json.error).toMatch(/Read-only: DELETE/)
    expect(calls).toHaveLength(0)
  })

  it('sends the same write once the console unlocks it, and says that it wrote', async () => {
    const { res } = await call('/api/supabase/query', 'POST', {
      account: 'env',
      ref: 'abcdefghijklmnopqrst',
      sql: 'delete from users where id = 1',
      allowWrites: true,
    })
    expect(res.code).toBe(200)
    expect(res.json.wrote).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('takes allowWrites only as a real true, never a truthy string', async () => {
    const { res } = await call('/api/supabase/query', 'POST', { account: 'env', ref: 'abcdefghijklmnopqrst', sql: 'drop table users', allowWrites: 'yes' })
    expect(res.code).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('checks the project reference before it goes into a URL', async () => {
    const { res } = await call('/api/supabase/query', 'POST', { account: 'env', ref: '../../organizations', sql: 'select 1' })
    expect(res.code).toBe(400)
    expect(res.json.error).toMatch(/project reference/)
    expect(calls).toHaveLength(0)
  })

  it('checks the account label, which addresses a Keychain item', async () => {
    const { res } = await call('/api/supabase/projects?account=' + encodeURIComponent("x' -w -s 'laika-orbit secret"))
    expect(res.code).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('refuses an empty statement rather than asking Supabase about it', async () => {
    const { res } = await call('/api/supabase/query', 'POST', { account: 'env', ref: 'abcdefghijklmnopqrst', sql: '   ' })
    expect(res.code).toBe(400)
    expect(res.json.error).toBe('Nothing to run')
    expect(calls).toHaveLength(0)
  })

  it('passes Supabase’s own refusal through in words, without the status code jargon', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ message: 'Unauthorized' }) }))
    const { res } = await call('/api/supabase/projects?account=env&fresh=1')
    expect(res.code).toBe(400)
    expect(res.json.error).toMatch(/rejected that token/)
  })

  it('answers an unknown supabase route rather than falling through to the graph', async () => {
    const { res } = await call('/api/supabase/nonsense')
    expect(res.code).toBe(404)
  })
})

describe('schema', () => {
  it('groups columns into tables and puts public first', async () => {
    vi.stubGlobal('fetch', async (_url, init) => {
      calls.push({ body: JSON.parse(init.body) })
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            { schema: 'auth', name: 'sessions', kind: 'BASE TABLE', column: 'id', type: 'uuid', is_nullable: 'NO', nullable: 'NO', pos: 1 },
            { schema: 'public', name: 'users', kind: 'BASE TABLE', column: 'id', type: 'bigint', nullable: 'NO', pos: 1 },
            { schema: 'public', name: 'users', kind: 'BASE TABLE', column: 'email', type: 'text', nullable: 'YES', pos: 2 },
            { schema: 'public', name: 'active', kind: 'VIEW', column: 'id', type: 'bigint', nullable: 'YES', pos: 1 },
          ]),
      }
    })
    const { res } = await call('/api/supabase/schema?account=env&ref=abcdefghijklmnopqrst')
    expect(res.code).toBe(200)
    const [first, second] = res.json.schemas
    expect(first.name).toBe('public')
    expect(second.name).toBe('auth')
    const users = first.tables.find((t) => t.name === 'users')
    expect(users.kind).toBe('table')
    expect(users.columns).toEqual([
      { name: 'id', type: 'bigint', nullable: false },
      { name: 'email', type: 'text', nullable: true },
    ])
    expect(first.tables.find((t) => t.name === 'active').kind).toBe('view')
    // the schema is read with the same read-only path the console uses
    expect(calls[0].body.query).toMatch(/information_schema\.columns/)
  })
})
