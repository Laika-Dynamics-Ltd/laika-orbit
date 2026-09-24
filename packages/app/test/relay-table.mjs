import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A database that knows one migration, so the relay can be run through the real schema's rules
 * without a Postgres to run them in.
 *
 * There is no container runtime on the machine this was written on, so supabase/tests/*.sql — the
 * proper proof, with real policies in a real Postgres — is written and waiting. This is the other
 * half of that gap: not a substitute for those tests, but the thing they cannot do anyway, which
 * is drive the actual relay transport, the actual sealed envelope and the actual adapter end to
 * end and see whether the column mapping survives the round trip.
 *
 * What makes it worth trusting is that it does not restate the migration. Every rule it enforces
 * is **parsed out of the migration file** at load: the room id and nonce patterns, the directions,
 * the sequence range, the ciphertext ceiling, the sweep interval, the idle-room interval. Change
 * the SQL and this changes with it; change the SQL in a way this cannot parse and it throws rather
 * than quietly enforcing yesterday's rules.
 *
 * What it is NOT: it is not Postgres. It does not prove a policy compiles, that RLS is wired to
 * the right role, or that the publication exists. It reproduces what those things are *for* —
 * rows one account cannot see, writes it cannot make, messages that expire — so that everything
 * above the database can be tested against the shape the database will actually have.
 */

const here = dirname(fileURLToPath(import.meta.url))
const migrations = join(here, '..', '..', '..', 'supabase', 'migrations')
const sql = readdirSync(migrations)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(join(migrations, f), 'utf8'))
  .join('\n')

/** pull one rule out of the migration, or say which one has moved rather than guessing at it */
const rule = (re, what) => {
  const m = sql.match(re)
  if (!m) throw new Error(`the migration no longer says ${what}; this stand-in cannot enforce what it cannot find`)
  return m[1]
}

/** every constraint below is the migration's, read from it, never typed twice */
export const RULES = {
  room: new RegExp(rule(/check \(id ~ '(.+)'\)/, 'what a room id looks like')),
  nonce: new RegExp(rule(/check \(nonce ~ '(.+)'\)/, 'what a nonce looks like')),
  dirs: rule(/check \(dir in \((.+)\)\)/, 'which directions there are')
    .split(', ')
    .map((d) => d.slice(1, -1)),
  maxSeq: Number(rule(/seq between 1 and (\d+)/, 'how long a stream may be')),
  maxCt: Number(rule(/octet_length\(ct\) between 1 and (\d+)/, 'how big a message may be')),
  sweepSeconds: Number(rule(/relay_message where created_at < now\(\) - interval '(\d+) seconds'/, 'when a message expires')),
  idleHours: Number(rule(/relay_room where last_seen_at < now\(\) - interval '(\d+) hours'/, 'when a room expires')),
}

/** what Postgres would say, in the two ways this code path cares about telling them apart */
const denied = (table) => ({ code: '42501', message: `permission denied for table ${table}` })
const violates = (code, message) => ({ code, message })

/**
 * @param {Object} [o]
 * @param {number} [o.realtimeMaxBytes]
 *   the size past which a postgres_changes payload arrives without its row, the way Supabase drops
 *   one over max_record_bytes. The default is roughly what a project ships with.
 */
export function createRelayTable({ realtimeMaxBytes = 1024 * 1024 } = {}) {
  /** every row ever inserted and not yet swept: this is what a provider's table would hold */
  const messages = []
  const rooms = []
  const listeners = new Set()
  let id = 0
  let skew = 0
  let down = null

  const now = () => Date.now() + skew

  /** the migration's sweep, on the migration's numbers */
  const sweep = () => {
    const old = now() - RULES.sweepSeconds * 1000
    let gone = 0
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].created_at < old) (messages.splice(i, 1), gone++)
    const idle = now() - RULES.idleHours * 3600 * 1000
    for (let i = rooms.length - 1; i >= 0; i--) {
      if (rooms[i].last_seen_at >= idle) continue
      const [dead] = rooms.splice(i, 1)
      // on delete cascade
      for (let j = messages.length - 1; j >= 0; j--) if (messages[j].room === dead.id) messages.splice(j, 1)
    }
    return gone
  }

  const fan = (row) => {
    for (const l of [...listeners]) {
      if (l.pipe !== row.pipe) continue
      // RLS is evaluated for the subscriber: a feed shows what a select would have shown
      if (l.uid !== row.owner) continue
      const tooBig = row.ct.length > realtimeMaxBytes
      const payload = tooBig ? { new: { ...row, ct: null }, errors: ['Error 413 (Payload Too Large)'] } : { new: { ...row } }
      queueMicrotask(() => listeners.has(l) && l.cb(payload))
    }
  }

  /** insert one message as `uid`, enforcing what the table would enforce, in the order it would */
  const insertMessage = (uid, r) => {
    if (!uid) return { error: denied('relay_message') }
    if (typeof r.room !== 'string' || !RULES.room.test(r.room)) return { error: violates('23514', 'relay_message_room_fkey') }
    if (!RULES.dirs.includes(r.dir)) return { error: violates('23514', 'relay_message_dir_is_a_direction') }
    if (typeof r.nonce !== 'string' || !RULES.nonce.test(r.nonce)) return { error: violates('23514', 'relay_message_nonce_is_a_nonce') }
    if (!Number.isInteger(r.seq) || r.seq < 1 || r.seq > RULES.maxSeq) return { error: violates('23514', 'relay_message_seq_in_range') }
    if (typeof r.ct !== 'string' || r.ct.length < 1 || r.ct.length > RULES.maxCt) return { error: violates('23514', 'relay_message_ct_has_a_size') }
    if (messages.some((m) => m.room === r.room && m.dir === r.dir && m.nonce === r.nonce)) return { error: violates('23505', 'relay_message_no_replays') }
    // the composite key: this room, owned by this account. Not a policy — a key.
    if (!rooms.some((x) => x.id === r.room && x.owner === uid)) return { error: violates('23503', 'relay_message_room_fkey') }

    const row = {
      id: ++id,
      room: r.room,
      owner: uid, // default auth.uid(), never taken from the client
      dir: r.dir,
      v: r.v ?? 1,
      seq: r.seq,
      nonce: r.nonce,
      ct: r.ct,
      created_at: now(), // stamped here, never taken from the client
      pipe: `${r.room}:${r.dir}`,
    }
    messages.push(row)
    sweep() // the statement trigger, which is why retention does not need pg_cron
    fan(row)
    return { data: [row], error: null }
  }

  const upsertRoom = (uid, r) => {
    if (!uid) return { error: denied('relay_room') }
    if (typeof r.id !== 'string' || !RULES.room.test(r.id)) return { error: violates('23514', 'relay_room_id_is_a_room_id') }
    const existing = rooms.find((x) => x.id === r.id)
    if (existing && existing.owner !== uid) return { error: violates('42501', 'new row violates row-level security policy') }
    if (existing) {
      existing.last_seen_at = now()
      return { data: [existing], error: null }
    }
    const row = { id: r.id, owner: uid, created_at: now(), last_seen_at: now() }
    rooms.push(row)
    return { data: [row], error: null }
  }

  /** the slice of a table one account can see — the single equality every policy in the migration is */
  const visible = (uid, name) => (name === 'relay_message' ? messages : rooms).filter((r) => r.owner === uid)

  /** enough of the supabase-js query builder for what relay-supabase.mjs actually calls */
  const builder = (uid, name) => {
    const filters = []
    let op = 'select'
    let payload = null
    let one = false

    const run = () => {
      // a tunnel takes out one direction at a time: the phone's request lands and the Mac's answer
      // has nowhere to go, which is the state worth being able to reach in a test
      if (down && (!down.dir || down.dir === payload?.dir)) return { data: null, error: { code: '08006', message: down.why } }
      if (!uid) return { data: null, error: denied(name) }
      if (op === 'insert') return name === 'relay_message' ? insertMessage(uid, payload) : upsertRoom(uid, payload)
      if (op === 'upsert') return upsertRoom(uid, payload)
      let rowsFound = visible(uid, name).filter((r) => filters.every(([c, v]) => String(r[c]) === String(v)))
      if (op === 'delete') {
        for (const r of rowsFound) {
          const list = name === 'relay_message' ? messages : rooms
          list.splice(list.indexOf(r), 1)
        }
        return { data: rowsFound, error: null }
      }
      if (one) {
        if (rowsFound.length !== 1) return { data: null, error: violates('PGRST116', 'JSON object requested, multiple (or no) rows returned') }
        return { data: { ...rowsFound[0] }, error: null }
      }
      return { data: rowsFound.map((r) => ({ ...r })), error: null }
    }

    const chain = {
      select() {
        return chain
      },
      insert(row) {
        op = 'insert'
        payload = row
        return chain
      },
      upsert(row) {
        op = 'upsert'
        payload = row
        return chain
      },
      delete() {
        op = 'delete'
        return chain
      },
      eq(column, value) {
        filters.push([column, value])
        return chain
      },
      single() {
        one = true
        return chain
      },
      then: (ok, no) => Promise.resolve().then(run).then(ok, no),
    }
    return chain
  }

  const client = (uid) => ({
    uid,
    from: (name) => builder(uid, name),
    channel(name) {
      const l = { uid, name, pipe: null, cb: null }
      const ch = {
        on(_event, opts, cb) {
          l.pipe = String(opts.filter ?? '').replace(/^pipe=eq\./, '')
          l.cb = cb
          return ch
        },
        subscribe() {
          listeners.add(l)
          return ch
        },
        _l: l,
      }
      return ch
    },
    async removeChannel(ch) {
      listeners.delete(ch._l)
    },
  })

  return {
    RULES,
    messages,
    rooms,
    /** a signed-in account. Two different uids are two different people. */
    client,
    /** no session: what a stolen publishable key on its own amounts to */
    anon: () => client(null),
    sweep,
    /** move the clock, so a test can watch retention happen without waiting for it */
    advance: (ms) => {
      skew += ms
      return sweep()
    },
    /** with a direction, only that way stops working — the train-tunnel case */
    fail: (why = 'the relay is unreachable', { dir = null } = {}) => {
      down = { why, dir }
    },
    up: () => {
      down = null
    },
    get subscribers() {
      return listeners.size
    },
    /** everything a reader with full access to this database would have, as one string to search */
    dump: () => JSON.stringify({ messages, rooms }),
  }
}
