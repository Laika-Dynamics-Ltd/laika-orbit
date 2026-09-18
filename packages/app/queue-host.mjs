/**
 * The work queue inside the agent host: its routes, its event stream, and the one thing that sends
 * work without being asked: a chat going idle with a ready item (queue.mjs has the store; the
 * contract is docs/QUEUE-CONTRACT.md).
 *
 * What it hears from the host (onState, from Session.setState):
 *  - idle: the chat's next ready item goes out, but only on autopilot and within the away budget.
 *    Off autopilot it stays ready, and the stream says so once. A chat still holding a running item
 *    gets nothing new: that item has to be marked done (or fail) first, so work never piles up.
 *  - idle after a turn that ended in an error (a usage limit), or error: its running item failed.
 *  - closed (closed, parked, or gone elsewhere): its unfinished items go back to the pile.
 * Nothing happens while the host restores its chats or shuts down: a restart closes every chat,
 * and that must not empty their lists.
 */
import { holdReason, QueueError } from './queue.mjs'

/** after a chat goes idle, wait this long: a turn often ends a moment before the next one starts */
const SETTLE_MS = 3_000
/** a failed item is not tried again for this long, times the retries spent, so a usage limit cannot burn both retries at once */
const RETRY_BACKOFF_MS = 2 * 60_000

/**
 * `deps`:
 *  - gate(): why a send may not happen now (autopilot off, the kill switch, the away budget), or null
 *  - send(x, text): send a chat the brief, marked as the conductor's
 *  - report(entry): the autopilot timeline (autopilot.report)
 *  - busy(): true while the host restores or shuts down
 *  - isConductor(x): conductor chats never take queue work
 */
export function createQueueHost({ queue, sessions, deps }) {
  const timers = new Map() // chat id -> pending dispatch
  const said = new Map() // item id -> the last hold reason told to the stream, so it is said once
  const retryAfter = new Map() // item id -> ms epoch before which it is not retried

  const takesWork = (x) => x && x.state !== 'closed' && !deps.isConductor(x) && !x.account?.demo
  const runningOn = (chatId) => queue.list({ chat: chatId, state: ['running'] })[0] ?? null

  /** the error the chat's last turn ended with, since `at`, or null */
  const turnError = (x, at) => {
    for (let i = x.events.length - 1; i >= 0; i--) {
      const e = x.events[i]
      if (e.at < at) break
      if (e.t === 'result') return e.error ? String(e.error) : null
    }
    return null
  }
  const lastErrorEvent = (x) => [...x.events].reverse().find((e) => e.t === 'error')?.message ?? 'the chat stopped with an error'

  /** tell the stream why an item is held, once per reason */
  const hold = (item, why, kind) => {
    if (said.get(item.id) === why) return
    said.set(item.id, why)
    if (kind === 'ready') queue.heldReady(item.id, why)
    else queue.heldBlocked(item.id, why)
  }

  /** send this chat its next ready item, if it may have one now */
  const dispatch = (x) => {
    if (deps.busy() || !takesWork(x) || x.state !== 'idle' || x.pending?.size) return null
    if (runningOn(x.id)) return null
    const next = queue.nextFor(x.id)
    if (!next) {
      const waiting = queue.heldFor(x.id)
      if (waiting) hold(waiting, holdReason(waiting), 'blocked')
      return null
    }
    const until = retryAfter.get(next.id) ?? 0
    if (Date.now() < until) {
      later(x, until - Date.now() + 500)
      return null
    }
    const refused = deps.gate()
    if (refused) {
      hold(next, refused, 'ready')
      return null
    }
    let item
    try {
      item = queue.start(next.id, { auto: true })
    } catch (e) {
      if (e instanceof QueueError) return null
      throw e
    }
    said.delete(item.id)
    deps.send(x, item.brief)
    deps.report({ action: 'send', chat: x, text: `Queue: ${item.title}`, reason: `next on its queue (${item.id})`, undo: { kind: 'stop' } })
    return item
  }

  const later = (x, ms = SETTLE_MS) => {
    clearTimeout(timers.get(x.id))
    const t = setTimeout(() => {
      timers.delete(x.id)
      const now = sessions.get(x.id)
      if (now) dispatch(now)
    }, ms)
    t.unref?.()
    timers.set(x.id, t)
  }

  /** every idle chat with queued work gets a look: after an item finishes, its dependants may be free */
  let sweepTimer = null
  const sweep = () => {
    clearTimeout(sweepTimer)
    sweepTimer = setTimeout(() => {
      sweepTimer = null
      for (const x of sessions.values()) if (takesWork(x) && x.state === 'idle') later(x, 0)
    }, SETTLE_MS)
    sweepTimer.unref?.()
  }

  const failRunning = (x, error) => {
    const item = runningOn(x.id)
    if (!item) return null
    const failed = queue.fail(item.id, error)
    retryAfter.set(item.id, Date.now() + RETRY_BACKOFF_MS * Math.max(1, failed.retries))
    return failed
  }

  /** Session.setState calls this on every change */
  const onState = (x) => {
    if (deps.busy() || deps.isConductor(x)) return
    if (x.state === 'closed') {
      clearTimeout(timers.get(x.id))
      timers.delete(x.id)
      queue.release(x.id, { why: `${x.id.slice(0, 8)} (${x.repo}) was closed` })
      return
    }
    if (x.state === 'error') {
      failRunning(x, lastErrorEvent(x))
      return
    }
    if (x.state !== 'idle') return
    const running = runningOn(x.id)
    if (running) {
      const err = turnError(x, running.startedAt ?? 0)
      if (err) failRunning(x, err)
      // finished its turn with the item still running: it waits to be marked done
      else return
    }
    later(x)
  }

  // the chat's own transcript shows what the queue did to it
  queue.watch((e) => {
    const note = { t: 'queue', event: e.t, id: e.item.id, title: e.item.title, state: e.item.state }
    const chats = new Set([e.item.chatId, e.from].filter(Boolean))
    for (const id of chats) sessions.get(id)?.emit(note)
    if (['queue.added', 'queue.finished', 'queue.reassigned', 'queue.cancelled', 'queue.updated'].includes(e.t)) sweep()
    if (e.t === 'queue.updated' && e.fields?.includes('lastError') && !e.item.lastError) retryAfter.delete(e.item.id)
  })

  /** once the chats are back after a restart: stranded running items requeued, and lists of chats that did not come back released */
  const restored = ({ keep = [] } = {}) => {
    for (const item of queue.restore()) console.log(`queue: ${item.id} was running when the host stopped: queued again`)
    const alive = new Set([...sessions.keys(), ...keep])
    const orphans = new Set(queue.list().map((r) => r.chatId).filter((id) => id && !alive.has(id)))
    for (const id of orphans) queue.release(id, { why: `${id.slice(0, 8)} did not come back after the host restarted` })
    sweep()
  }

  // ---------------------------------------------------------------------- routes ----
  const words = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean)
  const knownChat = (id) => {
    const x = sessions.get(String(id))
    if (!takesWork(x)) throw new QueueError(`No open chat ${id} that can take queue work.`, 404)
    return x
  }

  /**
   * /queue… on the agent host (the page reaches it as /api/control/agent/queue…). Returns true when
   * it answered. `readBody` and `json` are the host's.
   */
  const route = async (url, req, res, { json, readBody }) => {
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] !== 'queue') return false
    const [, id, verb] = parts
    try {
      if (id === 'events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        // headers only leave with the first write: without this a quiet queue looks like a dead stream for 15s
        res.write(': open\n\n')
        const send = (e) => res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`)
        const since = url.searchParams.get('since')
        if (since !== null) for (const e of queue.since(since)) send(e)
        const stop = queue.watch(send)
        const ping = setInterval(() => res.write(': ping\n\n'), 15000)
        req.on('close', () => {
          clearInterval(ping)
          stop()
        })
        return true
      }
      if (!id && req.method === 'GET') {
        const q = url.searchParams
        return json(200, queue.view({ chat: q.get('chat') || undefined, state: words(q.get('state')), repo: q.get('repo') || undefined, includeDone: q.get('include') === 'done' })), true
      }
      if (!id && req.method === 'POST') {
        const b = await readBody(req, 1e5)
        const chat = b.chatId ?? b.chat ?? null
        const x = chat ? knownChat(chat) : null
        return json(200, queue.add({ ...b, chatId: x?.id ?? null, repo: b.repo || x?.repo || '' })), true
      }
      if (id === 'reorder' && req.method === 'POST') {
        const b = await readBody(req, 1e5)
        return json(200, { ok: true, items: queue.reorder(b.chat ?? null, words(b.ids)) }), true
      }
      if (!queue.get(id)) return json(404, { error: `No queue item ${id}.` }), true
      if (!verb && req.method === 'GET') return json(200, queue.get(id)), true
      if (!verb && req.method === 'PATCH') {
        const b = await readBody(req, 1e5)
        if (b.lastError === null && queue.get(id).lastError) b.clearError = true
        return json(200, queue.update(id, b)), true
      }
      if (!verb && req.method === 'DELETE') return json(200, { ok: queue.remove(id) }), true
      if (verb === 'assign' && req.method === 'POST') {
        const b = await readBody(req, 1e4)
        const x = b.chat ? knownChat(b.chat) : null
        return json(200, queue.assign(id, x?.id ?? null, { why: b.why ?? '' })), true
      }
      if (verb === 'cancel' && req.method === 'POST') {
        const b = await readBody(req, 1e4)
        return json(200, queue.cancel(id, { reason: b.reason ?? '' }).item), true
      }
      return json(404, { error: 'unknown queue route' }), true
    } catch (e) {
      if (e instanceof QueueError) return json(e.code, { error: e.message }), true
      if (e instanceof SyntaxError) return json(400, { error: 'send a JSON object' }), true
      throw e
    }
  }

  return { onState, dispatch, restored, route }
}
