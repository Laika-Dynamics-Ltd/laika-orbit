/**
 * A database, for the purpose of not having one yet.
 *
 * Which database Orbit relays through is the user's choice and has not been made. Nothing in
 * this repo may create a project, hold a credential or open a socket to one — so the relay is
 * proven against this instead: an in-process stand-in that does the two things a real one has to
 * do, and keeps every row it was ever given so a test can look at exactly what the provider
 * would have been able to see.
 *
 *   send(room, dir, envelope)        append a row
 *   subscribe(room, dir, onMessage)  hear the ones addressed that way, from now on
 *
 * A Supabase Realtime adapter is an insert and a channel subscription against the same pair.
 *
 * It is a little hostile on purpose, because a real pipe is: delivery is asynchronous, it can be
 * asked to deliver late or twice, and `rows` is there so a test can assert that what the
 * database holds is ciphertext and routing and nothing a person wrote.
 */
export function createRelayStub({ latency = 0, duplicate = false } = {}) {
  /** every row ever sent, in order: this is what a provider's table would contain */
  const rows = []
  const listeners = new Set()
  let down = null

  const fan = (row) => {
    for (const l of [...listeners]) {
      if (l.room !== row.room || l.dir !== row.dir) continue
      const hand = () => {
        if (!listeners.has(l)) return
        l.onMessage(structuredClone(row.envelope))
        if (duplicate) l.onMessage(structuredClone(row.envelope))
      }
      if (latency > 0) setTimeout(hand, latency)
      else queueMicrotask(hand)
    }
  }

  return {
    rows,
    /**
     * Pretend the provider is unreachable, the way a train tunnel does. With a direction, only
     * that way stops working — which is how a test puts the Mac in the position of having an
     * answer and nowhere to put it.
     */
    fail(why = 'the relay is unreachable', { dir = null } = {}) {
      down = { why, dir }
    },
    up() {
      down = null
    },
    /** hand a row that was already delivered to the listeners again — a replay, from the pipe */
    replay(i) {
      fan(rows[i])
    },
    /** hand a row over with a field bent, as a provider with write access could */
    tamper(i, change) {
      fan({ ...rows[i], envelope: { ...rows[i].envelope, ...change } })
    },
    /** what a reader of this table could learn, as a single string to search */
    dump: () => JSON.stringify(rows),

    db: {
      async send(room, dir, envelope) {
        if (down && (!down.dir || down.dir === dir)) throw new Error(down.why)
        const row = { at: rows.length, room, dir, envelope, created_at: Date.now() }
        rows.push(row)
        fan(row)
      },
      async subscribe(room, dir, onMessage) {
        if (down && !down.dir) throw new Error(down.why)
        const l = { room, dir, onMessage }
        listeners.add(l)
        return async () => {
          listeners.delete(l)
        }
      },
    },
    get subscribers() {
      return listeners.size
    },
  }
}

/**
 * The other end: a phone, as far as the relay is concerned. It seals requests into the room and
 * waits for the sealed answers, so a test can ask the Mac a question the way the iOS app will.
 */
export function createStubPhone({ stub, secret, token, channel }) {
  const seen = new Map()
  let n = 0
  const inbox = []
  let stopped = null

  const start = async () => {
    if (stopped) return
    stopped = await stub.db.subscribe(channel.room, channel.in, (envelope) => {
      const got = channel.open(envelope)
      if (!got.ok) return inbox.push({ unreadable: got.reason })
      const m = got.payload
      const waiting = seen.get(m.id)
      if (!waiting) return inbox.push(m)
      if (m.t === 'res') {
        seen.delete(m.id)
        waiting.settle({ status: m.status, body: m.body })
      } else if (m.t === 'head') waiting.stream.head = { status: m.status, headers: m.headers }
      else if (m.t === 'chunk') waiting.stream.chunks.push(m.data)
      else if (m.t === 'end') {
        seen.delete(m.id)
        waiting.settle(waiting.stream)
      }
    })
  }

  const ask = async (path, { method = 'GET', body, headers, stream = false, timeout = 2000 } = {}) => {
    await start()
    const id = `r${++n}`
    const answer = new Promise((ok, fail) => {
      const t = setTimeout(() => {
        seen.delete(id)
        fail(new Error(`no answer to ${method} ${path} within ${timeout}ms`))
      }, timeout)
      seen.set(id, { stream: { head: null, chunks: [] }, settle: (v) => (clearTimeout(t), ok(v)) })
    })
    await stub.db.send(channel.room, channel.out, channel.seal({ id, method, path, headers: { 'x-agent-token': token, ...headers }, body }))
    if (stream) return { id, answer, cancel: () => stub.db.send(channel.room, channel.out, channel.seal({ cancel: id })) }
    return answer
  }

  return { ask, inbox, secret, channel, stop: () => stopped?.() }
}
