/**
 * The two calls the relay makes, spoken to the tables in supabase/migrations.
 *
 * relay-transport.mjs asks a database for `send` and `subscribe` and deliberately knows nothing
 * else about it. This is that pair, against the schema — an insert and a channel subscription,
 * which is all the migration was ever shaped to be:
 *
 *     db.send(room, dir, envelope)        insert one row into relay_message
 *     db.subscribe(room, dir, onMessage)  a postgres_changes INSERT channel, filtered on `pipe`
 *
 * It takes a supabase-js client and never makes one. No URL, no key, no project: which project
 * Orbit relays through is the user's choice, this file has no opinion about it, and importing it
 * connects to nothing. Wiring is one line somewhere else, when there is something to wire to.
 *
 *     import { createClient } from '@supabase/supabase-js'
 *     createRelayTransport({ handler, secret, db: createRelayDb(createClient(url, publishableKey)) })
 *
 * The client must be signed in. Every row is stamped with `auth.uid()` by the table's default and
 * every policy is one equality against it, so an anonymous client is refused at the door rather
 * than allowed to write rows nobody can read. That is the whole of the authorisation story here;
 * the confidentiality story is sealed-envelope.mjs and does not involve the database at all.
 *
 * ## The envelope is five columns
 *
 * What the sealer produces is `{ v, dir, seq, n, ct }` and what the table holds is those five, one
 * per column, with `n` called `nonce` because `n` is not a column name anybody should have to
 * guess at. The mapping is here and only here, in `toRow` and `toEnvelope`, so there is one place
 * for it to be wrong and one place to look.
 *
 * ## Two things worth knowing about Realtime
 *
 * A subscription filters on one equality, so the table carries a generated `pipe` column that is
 * room and direction joined — see the migration. Without it every message in a room would be
 * delivered to both sides and thrown away by one of them.
 *
 * And a postgres_changes payload has a size limit well under the 30 MB body the transport will
 * carry, so a big message arrives as a notification with the row's id and no `ct`. That is what
 * `fetchMissing` is for: the row is already committed and readable, so it is fetched by id and
 * handed on as if it had arrived whole. A relay that silently dropped large replies would be a
 * relay that worked until someone asked for a long diff.
 */

/** the table names, in one place, because a rename is a migration and this should fail loudly */
const MESSAGE = 'relay_message'
const ROOM = 'relay_room'
/** the room says it is still there this often; the table sweeps a room after 24 hours of silence */
const HEARTBEAT_MS = 6 * 60 * 60 * 1000
/** what a postgres_changes payload says when the row was too big to put on the wire */
const TOO_BIG = /413|too large/i

/** envelope → row. `owner` is not here on purpose: the table fills it from auth.uid(). */
const toRow = (room, dir, e) => ({ room, dir, v: e.v, seq: e.seq, nonce: e.n, ct: e.ct })

/** row → envelope, in the shape createOpener expects and refuses anything else */
const toEnvelope = (r) => ({ v: r.v, dir: r.dir, seq: Number(r.seq), n: r.nonce, ct: r.ct })

/** the one equality a Realtime filter can carry */
const pipeOf = (room, dir) => `${room}:${dir}`

/**
 * @param {Object} client        a signed-in supabase-js client
 * @param {Object} [o]
 * @param {string} [o.schema]    where the tables live; the migration puts them in `public`
 * @param {boolean} [o.deleteOnRead]
 *   delete each message once it has been taken off the pipe. The table's DELETE policy exists for
 *   exactly this and it is the promptest retention there is — but it is off by default, because
 *   the transport has no ack and a message deleted before the Mac has finished with it is a
 *   message nobody can retry. The 150-second sweep in the migration is what the promise rests on;
 *   this is a bonus for an adapter that knows it is done.
 * @param {number} [o.heartbeatMs]
 */
export function createRelayDb(client, { deleteOnRead = false, heartbeatMs = HEARTBEAT_MS } = {}) {
  if (!client || typeof client.from !== 'function' || typeof client.channel !== 'function') throw new Error('a relay db needs a supabase client')
  const table = (name) => client.from(name)
  /** @type {Map<string, any>} one channel per pipe being read */
  const channels = new Map()
  let beat = null

  /**
   * Say this Mac is still here. The room row is what the messages hang off — the composite key
   * means a message cannot exist without it — so this runs before the first send and then on a
   * timer, and a room nobody has touched for a day is swept along with anything left in it.
   */
  const touch = async (room) => {
    const { error } = await table(ROOM).upsert({ id: room }, { onConflict: 'id' })
    if (error) throw new Error(`could not open the relay room: ${error.message}`)
  }

  return {
    /**
     * The room is not known until the transport has derived it, and the transport derives it from
     * the pairing secret it was built with — so `open` cannot upsert anything yet. It starts the
     * heartbeat and the first `subscribe` opens the room.
     */
    async open() {},

    async send(room, dir, envelope) {
      const { error } = await table(MESSAGE).insert(toRow(room, dir, envelope))
      // the caller turns this into a line on the pairing panel and carries on; a dropped answer is
      // better than a crashed host, and the phone retries the way it does on a flaky LAN
      if (error) throw new Error(error.message)
    },

    async subscribe(room, dir, onMessage) {
      await touch(room)
      if (!beat && heartbeatMs > 0) {
        beat = setInterval(() => touch(room).catch(() => {}), heartbeatMs)
        // a timer must never be the reason the process will not exit
        beat.unref?.()
      }

      const pipe = pipeOf(room, dir)
      /** a big row arrives without its ciphertext; it is committed and readable, so go and read it */
      const fetchMissing = async (id) => {
        const { data, error } = await table(MESSAGE).select('v,dir,seq,nonce,ct').eq('id', id).single()
        if (error || !data) return null
        return toEnvelope(data)
      }

      const arrived = async (payload) => {
        const row = payload?.new ?? payload?.record ?? null
        let envelope = row && row.ct ? toEnvelope(row) : null
        if (!envelope && row?.id && (payload?.errors?.some?.((e) => TOO_BIG.test(String(e))) || !row.ct)) envelope = await fetchMissing(row.id)
        if (!envelope) return
        onMessage(envelope)
        if (deleteOnRead && row?.id) await table(MESSAGE).delete().eq('id', row.id)
      }

      const channel = client
        .channel(`relay:${pipe}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: MESSAGE, filter: `pipe=eq.${pipe}` }, (payload) => {
          // never let a bad row stop the subscription: the whole point of this wire is that a
          // hostile pipe is the expected case
          Promise.resolve(arrived(payload)).catch(() => {})
        })
        .subscribe()
      channels.set(pipe, channel)

      return async () => {
        channels.delete(pipe)
        await client.removeChannel(channel)
        if (!channels.size && beat) {
          clearInterval(beat)
          beat = null
        }
      }
    },

    async close() {
      if (beat) clearInterval(beat)
      beat = null
      for (const channel of channels.values()) await client.removeChannel(channel)
      channels.clear()
    },
  }
}
