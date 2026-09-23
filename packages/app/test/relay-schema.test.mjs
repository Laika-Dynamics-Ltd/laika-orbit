import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TO_MAC, TO_PHONE, createSealer, relayKeys } from '../sealed-envelope.mjs'

/**
 * The relay's migration, checked against the code it exists to serve.
 *
 * This is not the RLS test — that one needs a Postgres and lives in supabase/tests. This is the
 * half that can run anywhere, and it is the half that catches the mistakes that are actually
 * likely: a column added to the table that holds something a person wrote, a retention window that
 * drifts away from the age at which a message stops being openable, a grant to `anon` quietly
 * reappearing, a schema that cannot hold what createSealer actually produces.
 *
 * Every number below is read out of the source rather than typed here twice, so the test fails
 * when the two disagree rather than when someone forgets to update it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const dir = join(root, 'supabase', 'migrations')
const migrations = readdirSync(dir).filter((f) => f.endsWith('.sql'))
const sql = migrations.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')

const envelope = readFileSync(join(here, '..', 'sealed-envelope.mjs'), 'utf8')
const transport = readFileSync(join(here, '..', 'relay-transport.mjs'), 'utf8')
/** a `const NAME = <number>` out of a module that does not export it */
const constant = (src, name) => {
  const m = src.match(new RegExp(`const ${name} = ([0-9_ehx.]+)`))
  if (!m) throw new Error(`${name} is not in that file any more; this test is reading the wrong thing`)
  return Number(m[1].replaceAll('_', ''))
}

/** the body of one `create table` statement */
const table = (name) => {
  const start = sql.indexOf(`create table if not exists public.${name} (`)
  expect(start, `${name} is not created by any migration`).toBeGreaterThan(-1)
  return sql.slice(start, sql.indexOf('\n);', start))
}
/** the column names it declares, by their types — a new type is a thing worth noticing too */
const columns = (name) => [...table(name).matchAll(/^ {2}([a-z_]+) (text|uuid|bigint|smallint|timestamptz)\b/gm)].map((m) => m[1])

describe('the relay migration holds what the envelope actually produces', () => {
  const secret = 'a'.repeat(48)
  const keys = relayKeys(secret)
  const sealed = createSealer({ key: keys[TO_MAC], dir: TO_MAC }).seal({ id: 'r1', method: 'GET', path: '/api/fleet' })

  it('has a column for every field of a sealed envelope and no field without one', () => {
    // if the envelope grows a field, this fails — which is the moment to decide whether the
    // database is allowed to see it, not six months later
    expect(Object.keys(sealed).sort()).toEqual(['ct', 'dir', 'n', 'seq', 'v'])
  })

  it('accepts a real room id', () => {
    const check = table('relay_room').match(/check \(id ~ '(.+)'\)/)[1]
    expect(keys.room).toMatch(new RegExp(check))
  })

  it('accepts a real nonce, and only a real nonce', () => {
    const check = table('relay_message').match(/check \(nonce ~ '(.+)'\)/)[1]
    expect(sealed.n).toMatch(new RegExp(check))
    expect(`${sealed.n}x`).not.toMatch(new RegExp(check))
  })

  it('names the two directions the envelope names', () => {
    const inList = table('relay_message').match(/check \(dir in \((.+)\)\)/)[1]
    expect(inList).toBe(`'${TO_MAC}', '${TO_PHONE}'`)
  })

  it('accepts a sequence number up to the one that ends a stream', () => {
    const maxSeq = Number(table('relay_message').match(/seq between 1 and (\d+)/)[1])
    expect(maxSeq).toBe(constant(envelope, 'MAX_SEQ') || 0xffffffff)
  })

  it('has room for the largest body the transport would carry', () => {
    const cap = Number(table('relay_message').match(/octet_length\(ct\) between 1 and (\d+)/)[1])
    const maxBody = constant(transport, 'MAX_BODY')
    const block = constant(envelope, 'BLOCK')
    // what MAX_BODY becomes by the time it is a row: JSON-wrapped, padded up to a block, sealed
    // with a 16-byte tag, then base64url
    const padded = Math.ceil((maxBody + 64) / block) * block
    expect(cap).toBeGreaterThan(Math.ceil((padded + 16) / 3) * 4)
    expect(sealed.ct.length).toBeLessThan(cap)
  })
})

describe('retention is the window in which a message could still be opened', () => {
  it('sweeps at exactly max age plus clock slack', () => {
    const seconds = Number(sql.match(/created_at < now\(\) - interval '(\d+) seconds'/)[1])
    const maxAge = constant(envelope, 'DEFAULT_MAX_AGE_MS') / 1000
    const slack = constant(envelope, 'FUTURE_SLACK_MS') / 1000
    // not "about three minutes": the exact point past which createOpener would refuse it anyway
    expect(seconds).toBe(maxAge + slack)
  })

  it('sweeps from the traffic as well as from cron, so retention needs no extension', () => {
    expect(sql).toMatch(/create trigger relay_message_sweep\s+after insert on public\.relay_message/)
    expect(sql).toMatch(/cron\.schedule\('relay-sweep'/)
  })

  it('drops rooms that stopped saying they were there', () => {
    expect(sql).toMatch(/delete from public\.relay_room where last_seen_at < now\(\) - interval '24 hours'/)
  })
})

describe('what the table is allowed to hold', () => {
  // The allowlist. Adding a column means changing this line, and changing this line means reading
  // the threat note at the top of the migration and deciding the new column does not break it.
  it('holds routing and time and nothing a person wrote', () => {
    expect(columns('relay_room')).toEqual(['id', 'owner', 'created_at', 'last_seen_at'])
    expect(columns('relay_message')).toEqual(['id', 'room', 'owner', 'dir', 'v', 'seq', 'nonce', 'ct', 'created_at', 'pipe'])
  })

  it('indexes routing and time, never content', () => {
    const indexed = [...sql.matchAll(/create index if not exists \w+ on public\.\w+ \(([^)]+)\)/g)].flatMap((m) => m[1].split(', '))
    for (const col of indexed) expect(['owner', 'last_seen_at', 'pipe', 'id', 'created_at', 'room']).toContain(col)
  })

  it('never names a licence, a machine or anything that would name the pairing', () => {
    // the names, not the prose: columns, constraints, indexes, triggers, policies and functions are
    // what a reader of \d sees even with every policy in force, so they are the surface that leaks
    const named = [table('relay_room'), table('relay_message'), ...sql.split('\n').filter((l) => /^create (index|policy|trigger|or replace function)/.test(l))].join('\n').toLowerCase()
    for (const word of ['license', 'licence', 'hostname', 'machine', 'title', 'repo', 'path', 'token', 'email', 'chat', 'session'])
      expect(named, `a schema object named after "${word}"`).not.toMatch(new RegExp(`\\b${word}\\b`))
  })
})

describe('a stolen anon key gets nothing', () => {
  it('takes every privilege away from anon and from public', () => {
    for (const t of ['relay_room', 'relay_message']) {
      expect(sql).toContain(`revoke all on public.${t} from anon;`)
      expect(sql).toContain(`revoke all on public.${t} from public;`)
    }
  })

  it('never grants anything to anon', () => {
    expect(sql).not.toMatch(/grant [^;]*\bto\b[^;]*\banon\b/)
  })

  it('turns row level security on for both tables', () => {
    for (const t of ['relay_room', 'relay_message']) expect(sql).toContain(`alter table public.${t} enable row level security;`)
  })

  it('writes every policy for authenticated, so normal operation never needs the service role', () => {
    const policies = [...sql.matchAll(/create policy "([^"]+)"\s+on public\.(\w+) for (\w+) to (\w+)/g)]
    expect(policies.length).toBeGreaterThan(0)
    for (const [, , , , role] of policies) expect(role).toBe('authenticated')
    expect(sql).not.toContain('to service_role')
  })

  it('checks the account on every policy, in both directions where there is a check to make', () => {
    // a policy without `owner = auth.uid()` is a policy that lets one account read another's rows
    for (const [policy] of sql.matchAll(/create policy "[^"]+"[\s\S]+?;\n/g)) {
      expect(policy).toMatch(/owner = \(select auth\.uid\(\)\)/)
      if (policy.includes('with check')) expect(policy).toMatch(/with check \(owner = \(select auth\.uid\(\)\)\)/)
    }
  })

  it('never lets a message be edited once it is written', () => {
    expect(sql).not.toMatch(/on public\.relay_message for update/)
    expect(sql).not.toMatch(/grant [^;]*update[^;]* on public\.relay_message/)
  })

  it('ties a message to its room by key and not only by policy', () => {
    expect(table('relay_message')).toMatch(/foreign key \(room, owner\)\s+references public\.relay_room \(id, owner\)/)
    expect(table('relay_room')).toContain('unique (id, owner)')
  })
})

describe('the policy tests are ready to run', () => {
  // They cannot run here — there is no container runtime on this machine, so no local Postgres.
  // What can be checked without one is that they would not fall over on their own fixtures, which
  // is the failure that would otherwise be found only by the person who runs them first.
  const pg = read('supabase/tests/relay_rls.test.sql')

  it('leaves nothing behind', () => {
    expect(pg).toMatch(/^begin;/m)
    expect(pg.trimEnd()).toMatch(/rollback;$/)
    expect(pg).toContain('select * from finish();')
  })

  it('uses room ids the table would accept', () => {
    const check = new RegExp(table('relay_room').match(/check \(id ~ '(.+)'\)/)[1])
    for (const [lit] of pg.matchAll(/'[0-9a-z]{32}'/g)) expect(lit.slice(1, -1)).toMatch(check)
  })

  it('uses nonces the table would accept', () => {
    const check = new RegExp(table('relay_message').match(/check \(nonce ~ '(.+)'\)/)[1])
    const fixtures = [...pg.matchAll(/'([A-Z])\1{15}'/g)].map((m) => m[0].slice(1, -1))
    expect(fixtures.length).toBeGreaterThan(4)
    for (const n of fixtures) expect(n).toMatch(check)
  })

  it('asks as the wrong account and as anon, not only as nobody', () => {
    expect(pg).toContain("set local role authenticated")
    expect(pg).toContain("set local role anon")
    expect(pg).toMatch(/set local request\.jwt\.claims = '\{"sub": "1{8}-/)
    expect(pg).toMatch(/set local request\.jwt\.claims = '\{"sub": "2{8}-/)
  })

  it('has something to say about every policy the migration writes', () => {
    for (const [, , tbl, verb] of sql.matchAll(/create policy "([^"]+)"\s+on public\.(\w+) for (\w+)/g)) {
      const claim = new RegExp(`${verb}[\\s\\S]{0,400}?${tbl}|${tbl}[\\s\\S]{0,400}?${verb}`)
      expect(pg, `nothing exercises ${verb} on ${tbl}`).toMatch(claim)
    }
  })

  it('covers the sweep, since retention is a promise and not a comment', () => {
    expect(pg).toContain("interval '151 seconds'")
    expect(pg).toContain('public.relay_sweep()')
  })
})

describe('the migration can be applied', () => {
  it('is one file, applied by one command', () => {
    expect(migrations.length).toBeGreaterThan(0)
    expect(read('supabase/config.toml')).toContain('project_id')
  })

  it('creates nothing in the cloud and names no project', () => {
    expect(sql).not.toMatch(/supabase\.co|sbp_|eyJ[A-Za-z0-9]/)
  })
})
