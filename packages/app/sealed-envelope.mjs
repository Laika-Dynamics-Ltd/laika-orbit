/**
 * What a relay is allowed to see, which is nothing.
 *
 * Orbit is local-first, and that has to survive a phone being in another country. The way it
 * survives is that the database in the middle is a dumb pipe: the Mac and the paired phone hold
 * a secret the database was never given, everything between them is sealed with it, and the row
 * that lands in the table holds ciphertext and routing and no more. Someone with full read
 * access to that table — the provider, a leaked service key, a subpoena — learns how many
 * messages there were, roughly how big, and when. Not a chat title, not a repo name, not a
 * command, not which machine.
 *
 * That is a claim, so here is what backs it.
 *
 * **The key is the pairing.** It comes from the secret already in the QR (pair-api.mjs), which
 * is this launch's agent-host token: minted on a press, dead when the host restarts, and known
 * only to the Mac that made it and the phone that was shown it. HKDF-SHA256 turns it into three
 * things that cannot be turned back: a room id, a key for phone→Mac, and a key for Mac→phone.
 * No account, no new secret to store, nothing uploaded. Pairing again is rekeying.
 *
 * **The room id is derived too**, so the QR payload does not change — it is a contract with a
 * shipped iOS app — and so the database's own row key says nothing about which machine it
 * belongs to. It is one-way out of a secret that rotates every launch.
 *
 * **Each direction has its own key.** A message the Mac sealed cannot be opened by the Mac, so
 * an attacker with write access to the table cannot bounce our own traffic back at us and have
 * it accepted as a command. The direction is in the sealed header as well, which is belt to
 * that bracers, and costs nothing.
 *
 * **AES-256-GCM, with the header authenticated.** The version, direction and sequence travel in
 * the clear because the pipe has to route on them, and they are the additional data, so a
 * database that edits them breaks the seal rather than redirecting a message.
 *
 * **Nonces never repeat.** A nonce is eight random bytes chosen once per sealer, then a counter.
 * The random half is what makes a restart safe: the token can outlive a process (AGENT_TOKEN_FILE),
 * so a counter alone would start again at one against a key it had already used, and a repeated
 * nonce is the one mistake GCM does not survive.
 *
 * **Replay needs two answers, because one does not cover it.** Within a stream, a sliding window
 * over the counter refuses anything already seen or long past — the usual one. Across streams it
 * is useless, because a fresh stream legitimately starts at one, so every message also carries a
 * timestamp *inside* the seal, and one older than a couple of minutes is refused. An old stream
 * replayed wholesale gets past the window and dies on the clock; a message repeated inside a live
 * stream gets past the clock and dies on the window.
 *
 * **A message that will not open produces silence.** Not an error row, not a nack, nothing — the
 * counters here go up and the host can say so on the pairing panel, but the pipe gets no answer,
 * because an answer that varies with the reason is an oracle, and one kind of failure is reported
 * for every kind of tampering for the same reason.
 *
 * The plaintext is JSON and is padded to a size bucket before sealing, so the length a database
 * sees is coarse rather than exact. Sizes and timings are what remain; the brief says so, and
 * this is where the line is drawn.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

export const VERSION = 1
/** phone→Mac and Mac→phone: two keys, so a message can only travel the way it was sealed to */
export const TO_MAC = 'p2m'
export const TO_PHONE = 'm2p'

const SALT = 'orbit-relay-v1'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const STREAM_BYTES = 8
const TAG_BYTES = 16
/** a counter that has run out means rekey by pairing again, not wrap around onto a used nonce */
const MAX_SEQ = 0xffffffff
const DEFAULT_WINDOW = 1024
const DEFAULT_MAX_AGE_MS = 120_000
/** a phone's clock can be a little ahead of the Mac's without that being an attack */
const FUTURE_SLACK_MS = 30_000
/** how many streams an opener remembers; a phone that reconnects often must not grow memory */
const STREAMS_KEPT = 64
/**
 * Plaintext is rounded up before sealing, so a row's length is a band and not a fact: a database
 * should not be able to tell a one-word reply from a yes. Small messages step through these;
 * anything larger rounds to the next BLOCK, which keeps the padding on a big diff bounded.
 */
const BUCKETS = [256, 1024, 4096, 16_384, 65_536]
const BLOCK = 65_536

const u8 = (s) => Buffer.from(String(s), 'utf8')
const b64 = (b) => Buffer.from(b).toString('base64url')
const unb64 = (s) => Buffer.from(String(s), 'base64url')

/**
 * The three things a pairing secret becomes. One way: the secret cannot be recovered from any of
 * them, and none of them can be used to work out another.
 *
 * @param {string} secret the pairing secret — the token in the QR
 */
export function relayKeys(secret) {
  const s = String(secret ?? '')
  // shorter than this is not a pairing token, and quietly accepting one would mean quietly
  // running the whole thing on a guessable key
  if (s.length < 32) throw new Error('a pairing secret is at least 32 characters')
  const derive = (info, bytes = KEY_BYTES) => Buffer.from(hkdfSync('sha256', u8(s), u8(SALT), u8(info), bytes))
  return {
    /** what the database calls this pair of devices; says nothing about either of them */
    room: derive('room', 16).toString('hex'),
    [TO_MAC]: derive(`key:${TO_MAC}`),
    [TO_PHONE]: derive(`key:${TO_PHONE}`),
  }
}

/** the size a body is rounded up to before sealing: coarse, and never smaller than the body */
const bucket = (n) => BUCKETS.find((b) => b >= n) ?? Math.ceil(n / BLOCK) * BLOCK

/**
 * One side sealing to the other. A sealer owns a stream: eight random bytes it keeps, and a
 * counter it never rewinds.
 *
 * @param {Object} o
 * @param {Buffer} o.key   from relayKeys, for the direction being sealed
 * @param {string} o.dir   TO_MAC or TO_PHONE — must match the key, and is authenticated
 * @param {() => number} [o.now]
 */
export function createSealer({ key, dir, now = Date.now } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('a sealer needs a 32-byte key')
  if (dir !== TO_MAC && dir !== TO_PHONE) throw new Error(`not a direction: ${dir}`)
  const stream = randomBytes(STREAM_BYTES)
  let seq = 0

  return {
    dir,
    get seq() {
      return seq
    },
    /**
     * Seal one payload. The answer is the whole of what may touch a database.
     * @param {any} payload anything JSON can carry
     */
    seal(payload) {
      if (seq >= MAX_SEQ) throw new Error('this stream is spent; pair again')
      seq += 1
      const nonce = Buffer.concat([stream, Buffer.alloc(4)])
      nonce.writeUInt32BE(seq, STREAM_BYTES)
      // the timestamp lives inside the seal: it is what refuses a whole stream replayed later,
      // and the database has no business reading it
      const body = u8(JSON.stringify({ ts: now(), m: payload === undefined ? null : payload }))
      const padded = Buffer.alloc(bucket(body.length + 4))
      padded.writeUInt32BE(body.length, 0)
      body.copy(padded, 4)
      const aad = u8(`${VERSION}|${dir}|${seq}`)
      const c = createCipheriv('aes-256-gcm', key, nonce)
      c.setAAD(aad)
      const ct = Buffer.concat([c.update(padded), c.final(), c.getAuthTag()])
      return { v: VERSION, dir, seq, n: b64(nonce), ct: b64(ct) }
    },
  }
}

/** every way an envelope can be turned away. One of them stands for all tampering. */
export const REFUSALS = ['malformed', 'version', 'direction', 'sealed', 'replay', 'stale']

/**
 * The other side, opening. Never throws: a hostile pipe is the expected case, and a thrown
 * exception in a read loop is a way to stop the Mac listening.
 *
 * @param {Object} o
 * @param {Buffer} o.key
 * @param {string} o.dir           the direction this side accepts; anything else is refused
 * @param {() => number} [o.now]
 * @param {number} [o.maxAgeMs]    how stale a sealed timestamp may be
 * @param {number} [o.window]      how far back in a stream a counter may arrive out of order
 */
export function createOpener({ key, dir, now = Date.now, maxAgeMs = DEFAULT_MAX_AGE_MS, window = DEFAULT_WINDOW } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('an opener needs a 32-byte key')
  if (dir !== TO_MAC && dir !== TO_PHONE) throw new Error(`not a direction: ${dir}`)
  /** @type {Map<string, { high: number, seen: Set<number> }>} one per sealer stream, oldest dropped */
  const streams = new Map()
  const refused = Object.fromEntries(REFUSALS.map((r) => [r, 0]))
  const no = (reason) => {
    refused[reason] += 1
    return { ok: false, reason }
  }

  /** has this counter been used in this stream, or fallen out the back of the window? */
  const fresh = (id, seq) => {
    let s = streams.get(id)
    if (!s) {
      if (streams.size >= STREAMS_KEPT) streams.delete(streams.keys().next().value)
      s = { high: 0, seen: new Set() }
      streams.set(id, s)
    } else {
      // touch, so the stream in use is not the one dropped
      streams.delete(id)
      streams.set(id, s)
    }
    if (seq + window <= s.high) return 'stale'
    if (s.seen.has(seq)) return 'replay'
    s.seen.add(seq)
    if (seq > s.high) s.high = seq
    for (const old of s.seen) if (old + window <= s.high) s.seen.delete(old)
    return null
  }

  return {
    dir,
    /** how many arrived that this Mac could not take, by reason — what the panel can say out loud */
    get refused() {
      return { ...refused }
    },
    get streams() {
      return streams.size
    },
    /**
     * @param {any} envelope whatever the pipe handed over, trusted for nothing
     * @returns {{ ok: true, seq: number, ts: number, payload: any } | { ok: false, reason: string }}
     */
    open(envelope) {
      const e = envelope
      if (!e || typeof e !== 'object' || typeof e.n !== 'string' || typeof e.ct !== 'string') return no('malformed')
      if (e.v !== VERSION) return no('version')
      if (e.dir !== dir) return no('direction')
      if (!Number.isInteger(e.seq) || e.seq < 1 || e.seq > MAX_SEQ) return no('malformed')
      const nonce = unb64(e.n)
      const ct = unb64(e.ct)
      if (nonce.length !== NONCE_BYTES || ct.length <= TAG_BYTES) return no('malformed')
      // the counter in the header must be the one the nonce was built from, or the window is
      // being steered from outside the seal
      if (nonce.readUInt32BE(STREAM_BYTES) !== e.seq) return no('malformed')

      let padded
      try {
        const d = createDecipheriv('aes-256-gcm', key, nonce)
        d.setAAD(u8(`${VERSION}|${e.dir}|${e.seq}`))
        d.setAuthTag(ct.subarray(ct.length - TAG_BYTES))
        padded = Buffer.concat([d.update(ct.subarray(0, ct.length - TAG_BYTES)), d.final()])
      } catch {
        // wrong key, edited ciphertext, edited header: one answer for all of it
        return no('sealed')
      }

      let plain
      try {
        const len = padded.readUInt32BE(0)
        if (len > padded.length - 4) return no('malformed')
        plain = JSON.parse(padded.subarray(4, 4 + len).toString('utf8'))
      } catch {
        return no('malformed')
      }
      if (!plain || typeof plain !== 'object' || typeof plain.ts !== 'number') return no('malformed')

      // the clock first, so a whole old stream replayed under a fresh id does not get a window
      const age = now() - plain.ts
      if (age > maxAgeMs || age < -FUTURE_SLACK_MS) return no('stale')
      const bad = fresh(nonce.subarray(0, STREAM_BYTES).toString('base64url'), e.seq)
      if (bad) return no(bad)

      return { ok: true, seq: e.seq, ts: plain.ts, payload: plain.m }
    },
  }
}

/**
 * Both halves for one side of a pairing, wired the only way round that works: you seal towards
 * the other side and open what came from it. Getting this backwards is the mistake that would
 * hand an attacker reflection, so it is made here once rather than at each call site.
 *
 * @param {Object} o
 * @param {string} o.secret the pairing secret from the QR
 * @param {'mac'|'phone'} o.side
 */
export function sealedChannel({ secret, side, ...rest } = {}) {
  if (side !== 'mac' && side !== 'phone') throw new Error(`not a side: ${side}`)
  const keys = relayKeys(secret)
  const out = side === 'mac' ? TO_PHONE : TO_MAC
  const inb = side === 'mac' ? TO_MAC : TO_PHONE
  const sealer = createSealer({ key: keys[out], dir: out, ...rest })
  const opener = createOpener({ key: keys[inb], dir: inb, ...rest })
  return {
    side,
    room: keys.room,
    /** the direction this side writes; also the name of the pipe it writes into */
    out,
    /** the direction this side reads */
    in: inb,
    seal: (payload) => sealer.seal(payload),
    open: (envelope) => opener.open(envelope),
    get refused() {
      return opener.refused
    },
  }
}
