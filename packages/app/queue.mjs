/**
 * The work queue: what the fleet has been told to do but has not done yet.
 *
 * Work the conductor was holding lived only in its head: a chat closed mid-flight took the intent
 * with it, and spare chat capacity sat idle while work waited. This is that work, on disk, outliving
 * the chat it was given to.
 *
 * The contract every reader and every UI builds against is docs/QUEUE-CONTRACT.md: the item shape,
 * the routes (the agent host's /queue), the event names below and the conductor's fleet_queue_*
 * tools (conductor.mjs). It is published: change none of it silently.
 *
 * Kept in ~/.laika/queue-<port>.json beside the parked chats, written with an atomic rename so a
 * half-written file is never read (LAIKA_QUEUE points a test elsewhere). The file is the truth: no
 * item is held in memory between calls, so a host restart loses nothing. Only the event ring is in
 * memory; a page that reconnects after a restart refetches rather than trusting old sequence numbers.
 *
 * Two rules hold whatever else happens:
 *  - a blocked item never starts early, whatever autopilot says (nextFor and start check it);
 *  - an item is never deleted because a chat went away (release): it goes back to the pile.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** the contract version the API reports */
export const QUEUE_VERSION = 1

export const STATES = ['queued', 'running', 'blocked', 'done', 'cancelled']
export const MACHINES = ['mac', 'box1', 'any']
export const CREATED_BY = ['user', 'conductor', 'chat']
/** the definition of done: genuinely finished when all three are true */
export const DONE_FLAGS = ['committed', 'reachable', 'verified']
export const EVENTS = ['queue.added', 'queue.started', 'queue.finished', 'queue.blocked', 'queue.failed', 'queue.reassigned', 'queue.ready', 'queue.updated', 'queue.cancelled']

/** neither satisfies a dependency, and neither is ever sent */
const FINISHED = new Set(['done', 'cancelled'])

/** automatic retries after a chat error or a usage limit; then it waits for the user */
export const MAX_RETRIES = 2
/** how many events a reconnecting page can replay */
const RING = 500

export const MAX_TITLE = 120
export const MAX_BRIEF = 8000
const MAX_ARTEFACTS = 60
/** the unassigned pile's key among the lists */
const PILE = '#pile'

export const queueFile = () => process.env.LAIKA_QUEUE ?? join(homedir(), '.laika', `queue-${process.env.APP_PORT ?? '5200'}.json`)

/** a refusal that changed nothing; `code` is the HTTP status the API answers with */
export class QueueError extends Error {
  constructor(message, code = 400) {
    super(message)
    this.name = 'QueueError'
    this.code = code
  }
}
const refuse = (message, code = 400) => {
  throw new QueueError(message, code)
}

const clip = (t, n) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const idFor = () => `q_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** the stored fields, in the contract's order; anything else a caller sends is dropped */
function clean(row) {
  const done = row.done ?? {}
  return {
    id: String(row.id),
    repo: String(row.repo ?? ''),
    chatId: row.chatId ? String(row.chatId) : null,
    title: clip(row.title, MAX_TITLE),
    brief: String(row.brief ?? '').slice(0, MAX_BRIEF),
    state: STATES.includes(row.state) ? row.state : 'queued',
    blockedBy: [...new Set((row.blockedBy ?? []).map(String))],
    order: Number.isFinite(row.order) ? row.order : 0,
    estimate: Number.isFinite(row.estimate) ? Math.max(0, Math.round(row.estimate)) : null,
    machine: MACHINES.includes(row.machine) ? row.machine : 'any',
    createdBy: CREATED_BY.includes(row.createdBy) ? row.createdBy : 'user',
    done: Object.fromEntries(DONE_FLAGS.map((k) => [k, done[k] === true])),
    artefacts: (row.artefacts ?? []).map(String).slice(0, MAX_ARTEFACTS),
    createdAt: Number(row.createdAt) || Date.now(),
    startedAt: Number(row.startedAt) || null,
    finishedAt: Number(row.finishedAt) || null,
    lastError: row.lastError ? String(row.lastError).slice(0, 500) : null,
    retries: Math.max(0, Math.min(MAX_RETRIES, Number(row.retries) || 0)),
    needsUser: row.needsUser === true,
  }
}

/**
 * The derived fields, recomputed on every read so they never drift: `waitingOn` (the dependencies
 * not done yet) and `ready` (could go out now). A cancelled dependency never becomes done, so it
 * keeps its dependents waiting on purpose: someone has to decide whether that work still matters.
 */
export function decorate(row, byId) {
  const waitingOn = row.blockedBy.filter((id) => byId.get(id)?.state !== 'done')
  return { ...row, ready: row.state === 'queued' && !waitingOn.length && !row.needsUser, waitingOn }
}

/** why an item cannot go out now, in words, or null when it can */
export function holdReason(item) {
  if (item.state !== 'queued') return `it is ${item.state}`
  if (item.needsUser) return `it failed ${item.retries} times and waits for the user${item.lastError ? ` (${clip(item.lastError, 120)})` : ''}`
  if (item.waitingOn.length) return `it waits on ${item.waitingOn.join(', ')}`
  return null
}

/**
 * The cycle `blockedBy` would make for item `id`, as the ids in chain order ending where it began,
 * or null. Anything the item waits on, directly or through others, must never wait on it.
 */
export function findCycle(id, blockedBy, byId) {
  const seen = new Set()
  const walk = (at, path) => {
    if (at === id) return [id, ...path, id]
    if (seen.has(at)) return null
    seen.add(at)
    for (const next of byId.get(at)?.blockedBy ?? []) {
      const hit = walk(next, [...path, at])
      if (hit) return hit
    }
    return null
  }
  for (const dep of blockedBy) {
    const hit = walk(dep, [])
    if (hit) return hit
  }
  return null
}

const listKey = (row) => row.chatId ?? PILE
const byOrder = (a, b) => a.order - b.order || a.createdAt - b.createdAt

export function createQueue({ file = queueFile(), now = () => Date.now() } = {}) {
  const listeners = new Set()
  const events = []
  let seq = 0

  const read = () => {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const rows = Array.isArray(raw) ? raw : (raw?.items ?? [])
      return rows.filter((r) => r?.id && typeof r.id === 'string').map(clean)
    } catch {
      return []
    }
  }
  const write = (rows) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(`${file}.tmp`, JSON.stringify({ v: QUEUE_VERSION, savedAt: now(), items: rows }, null, 1), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
  const index = (rows) => new Map(rows.map((r) => [r.id, r]))
  const find = (rows, id) => rows.find((r) => r.id === String(id ?? '')) ?? null
  const need = (rows, id) => find(rows, id) ?? refuse(`No queue item ${id}. Call fleet_queue_list for the ids.`, 404)
  const out = (row, rows) => decorate(row, index(rows))

  /** one event on the queue's stream; `item` is the item as it is after the change */
  const emit = (t, item, extra = {}) => {
    const e = { seq: ++seq, at: now(), t, item, ...extra }
    events.push(e)
    if (events.length > RING) events.splice(0, events.length - RING)
    for (const fn of listeners) {
      try {
        fn(e)
      } catch {
        // a broken listener never stops the queue
      }
    }
    return e
  }

  /** the next place at the end of a list */
  const endOf = (rows, chatId) => {
    const mine = rows.filter((r) => listKey(r) === (chatId ?? PILE))
    return mine.length ? Math.max(...mine.map((r) => r.order)) + 1 : 0
  }

  /** every field a caller may set, checked before anything is written */
  const validate = (patch, id, rows) => {
    if (patch.title !== undefined && !clip(patch.title, MAX_TITLE)) refuse('An item needs a title: one line saying what the work is.')
    if (patch.brief !== undefined && !String(patch.brief ?? '').trim()) refuse('An item needs a brief: the full text to send to the chat.')
    if (patch.brief !== undefined && String(patch.brief).length > MAX_BRIEF) refuse(`The brief is over ${MAX_BRIEF} characters: put the detail in a file and point at it.`)
    if (patch.state !== undefined && !STATES.includes(patch.state)) refuse(`state must be one of ${STATES.join(', ')}.`)
    if (patch.machine !== undefined && !MACHINES.includes(patch.machine)) refuse(`machine must be one of ${MACHINES.join(', ')}.`)
    if (patch.createdBy !== undefined && !CREATED_BY.includes(patch.createdBy)) refuse(`createdBy must be one of ${CREATED_BY.join(', ')}.`)
    if (patch.done !== undefined) {
      const bad = Object.keys(patch.done ?? {}).filter((k) => !DONE_FLAGS.includes(k))
      if (bad.length) refuse(`done takes ${DONE_FLAGS.join(', ')}, not ${bad.join(', ')}.`)
    }
    if (patch.blockedBy !== undefined) {
      const deps = [...new Set((patch.blockedBy ?? []).map(String))]
      if (deps.includes(id)) refuse('An item cannot wait on itself.')
      const byId = index(rows)
      const missing = deps.filter((d) => !byId.has(d))
      if (missing.length) refuse(`No queue item ${missing.join(', ')}: blockedBy takes ids from fleet_queue_list.`)
      const cycle = findCycle(id, deps, byId)
      if (cycle) refuse(`That would make a dependency cycle: ${cycle.join(' → ')}. Nothing was changed.`, 409)
    }
  }

  const api = {
    file,

    /** every item: each chat's list in order, the unassigned pile last */
    all() {
      const rows = read()
      const byId = index(rows)
      const rank = (r) => (r.chatId === null ? 1 : 0)
      return [...rows].sort((a, b) => rank(a) - rank(b) || String(a.chatId ?? '').localeCompare(String(b.chatId ?? '')) || byOrder(a, b)).map((r) => decorate(r, byId))
    },

    get(id) {
      const rows = read()
      const row = find(rows, id)
      return row ? out(row, rows) : null
    },

    /**
     * The filtered list. `chat` takes a chat id, or 'none' for the unassigned pile. Finished and
     * cancelled items are left out unless asked for (includeDone, or naming those states).
     */
    list({ chat, state, repo, includeDone = false } = {}) {
      let items = api.all()
      if (chat) items = items.filter((r) => (chat === 'none' ? r.chatId === null : r.chatId === chat))
      if (state?.length) items = items.filter((r) => state.includes(r.state))
      else if (!includeDone) items = items.filter((r) => !FINISHED.has(r.state))
      if (repo) items = items.filter((r) => r.repo === repo)
      return items
    },

    /** what GET /queue answers; counts are always of the whole queue, never the filter */
    view(filter = {}) {
      const every = api.all()
      const live = every.filter((r) => !FINISHED.has(r.state))
      const byChat = {}
      for (const r of live) if (r.chatId) (byChat[r.chatId] ??= []).push(r.id)
      const counts = Object.fromEntries(STATES.map((s) => [s, every.filter((r) => r.state === s).length]))
      counts.ready = every.filter((r) => r.ready).length
      counts.needsUser = every.filter((r) => r.needsUser).length
      return {
        v: QUEUE_VERSION,
        now: now(),
        items: api.list(filter),
        unassigned: live.filter((r) => r.chatId === null).map((r) => r.id),
        byChat,
        counts,
      }
    },

    /** put work on the queue; `after` is sugar for a single blockedBy */
    add(fields = {}) {
      const rows = read()
      const id = idFor()
      const blockedBy = fields.blockedBy ?? (fields.after ? [fields.after] : [])
      validate({ title: fields.title ?? '', brief: fields.brief ?? '', ...fields, blockedBy }, id, rows)
      const chatId = fields.chatId ?? null
      const row = clean({
        ...fields,
        id,
        chatId,
        blockedBy,
        state: fields.state === 'blocked' ? 'blocked' : 'queued',
        order: Number.isFinite(fields.order) ? fields.order : endOf(rows, chatId),
        createdAt: now(),
        startedAt: null,
        finishedAt: null,
        lastError: null,
        retries: 0,
        needsUser: false,
      })
      rows.push(row)
      write(rows)
      const item = out(row, rows)
      emit('queue.added', item)
      return item
    },

    /**
     * Change an item. `done` merges, so one flag can be set alone; `blockedBy` and `artefacts`
     * replace. `clearError` is how a person says "try again": the item gets its retries back.
     */
    update(id, patch = {}) {
      const rows = read()
      const row = need(rows, id)
      validate(patch, row.id, rows)
      if (patch.chatId !== undefined && (patch.chatId ?? null) !== row.chatId) refuse('chatId is not patchable: assign it, so the move is on the stream.')
      const state = patch.state ?? row.state
      if (state === 'running' && row.state !== 'running') {
        const deps = patch.blockedBy ?? row.blockedBy
        const waiting = deps.filter((d) => find(rows, d)?.state !== 'done')
        if (waiting.length) refuse(`${row.id} waits on ${waiting.join(', ')}: it cannot start until they are done.`, 409)
      }
      if (state === 'done' && row.state === 'cancelled') refuse(`${row.id} was cancelled: reopen it with state "queued" first.`, 409)

      const was = { ...row, done: { ...row.done } }
      const next = clean({
        ...row,
        ...patch,
        id: row.id,
        chatId: row.chatId,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        done: { ...row.done, ...(patch.done ?? {}) },
        // the engine owns the retry budget; clearing the error gives it back
        retries: patch.clearError ? 0 : row.retries,
        needsUser: patch.clearError ? false : row.needsUser,
        lastError: patch.clearError ? null : patch.lastError !== undefined ? patch.lastError : row.lastError,
      })
      if (next.state !== was.state) {
        if (next.state === 'running') next.startedAt = now()
        if (next.state === 'queued' || next.state === 'blocked') next.startedAt = null
        next.finishedAt = FINISHED.has(next.state) ? now() : null
      }
      Object.assign(row, next)
      write(rows)

      const item = out(row, rows)
      const fields = Object.keys(next).filter((k) => JSON.stringify(was[k]) !== JSON.stringify(next[k]))
      if (!fields.length) return item
      if (was.state !== next.state) {
        if (next.state === 'done') emit('queue.finished', item, { doneFlags: item.done })
        else if (next.state === 'cancelled') emit('queue.cancelled', item, { reason: patch.reason ? clip(patch.reason, 200) : '' })
        else if (next.state === 'blocked') emit('queue.blocked', item, { why: patch.reason ? clip(patch.reason, 200) : 'held' })
        else if (next.state === 'running') emit('queue.started', item, { chatId: item.chatId, auto: false })
        else emit('queue.updated', item, { fields })
      } else emit('queue.updated', item, { fields })
      return item
    },

    /** give an item to a chat, or back to the unassigned pile (chatId null) */
    assign(id, chatId, { why = '' } = {}) {
      const rows = read()
      const row = need(rows, id)
      if (FINISHED.has(row.state)) refuse(`${row.id} is ${row.state}: there is nothing to move.`, 409)
      const to = chatId ? String(chatId) : null
      if (to === row.chatId) return out(row, rows)
      const from = row.chatId
      row.order = endOf(rows.filter((r) => r !== row), to)
      row.chatId = to
      // work that changes hands is no longer running anywhere
      if (row.state === 'running') {
        row.state = 'queued'
        row.startedAt = null
      }
      write(rows)
      const item = out(row, rows)
      emit('queue.reassigned', item, { from, to, why: clip(why, 200) })
      return item
    },

    /** drop an item; also returns the unfinished items now stuck behind it */
    cancel(id, { reason = '' } = {}) {
      const rows = read()
      const row = need(rows, id)
      if (row.state === 'done') refuse(`${row.id} is already done: there is nothing to cancel.`, 409)
      const stuck = rows.filter((r) => r.blockedBy.includes(row.id) && !FINISHED.has(r.state)).map((r) => r.id)
      if (row.state === 'cancelled') return { item: out(row, rows), stuck }
      row.state = 'cancelled'
      row.finishedAt = now()
      row.startedAt = null
      write(rows)
      const item = out(row, rows)
      emit('queue.cancelled', item, { reason: clip(reason, 200) })
      return { item, stuck }
    },

    /** purge a row outright: the UI's delete. The conductor's tools never call it. */
    remove(id) {
      const rows = read()
      const row = find(rows, id)
      if (!row) return false
      write(rows.filter((r) => r !== row))
      return true
    },

    /** one list's order, from the ids the UI dragged into place; unnamed items follow in their old order */
    reorder(chatId, ids = []) {
      const rows = read()
      const key = chatId ?? PILE
      const mine = rows.filter((r) => listKey(r) === key)
      const named = [...new Set(ids.map(String))].map((id) => mine.find((r) => r.id === id)).filter(Boolean)
      const rest = mine.filter((r) => !named.includes(r)).sort(byOrder)
      const moved = []
      ;[...named, ...rest].forEach((r, i) => {
        if (r.order !== i) moved.push(r)
        r.order = i
      })
      write(rows)
      const byId = index(rows)
      for (const r of moved) emit('queue.updated', decorate(r, byId), { fields: ['order'] })
      return [...named, ...rest].map((r) => decorate(r, byId))
    },

    // ------------------------------------------------------------------ dispatch ----

    /** the item that would go out to this chat next, or null: the first ready one in its order */
    nextFor(chatId) {
      if (!chatId) return null
      return api.list({ chat: String(chatId), state: ['queued'] }).find((r) => r.ready) ?? null
    },

    /** the chat's first queued item held back by a dependency, when nothing ahead of it is ready */
    heldFor(chatId) {
      if (!chatId) return null
      const queued = api.list({ chat: String(chatId), state: ['queued'] })
      if (queued.some((r) => r.ready)) return null
      return queued.find((r) => r.waitingOn.length && !r.needsUser) ?? null
    },

    /**
     * Its brief was sent to its chat. `auto`: the engine sent it, not a person. The last gate: a
     * blocked item never gets past here, whatever the caller believed.
     */
    start(id, { auto = true } = {}) {
      const rows = read()
      const row = need(rows, id)
      const hold = holdReason(decorate(row, index(rows)))
      if (hold) refuse(`${row.id} cannot start: ${hold}.`, 409)
      row.state = 'running'
      row.startedAt = now()
      row.finishedAt = null
      write(rows)
      const item = out(row, rows)
      emit('queue.started', item, { chatId: item.chatId, auto })
      return item
    },

    /** ready, but not sent (autopilot off, the budget spent): said once on the stream */
    heldReady(id, why) {
      const item = api.get(id)
      if (item) emit('queue.ready', item, { why: clip(why, 200) })
      return item
    },

    /** a dependency held a chat's next item back: said once on the stream */
    heldBlocked(id, why) {
      const item = api.get(id)
      if (item) emit('queue.blocked', item, { why: clip(why, 200) })
      return item
    },

    /**
     * An attempt failed (the chat errored, a usage limit): back to queued with the reason and one
     * retry spent. It must not spin: after MAX_RETRIES it stops being sent and waits for the user.
     * `costsRetry: false` is for failures that are not the item's (the host restarting).
     */
    fail(id, error, { costsRetry = true } = {}) {
      const rows = read()
      const row = need(rows, id)
      row.state = 'queued'
      row.startedAt = null
      row.finishedAt = null
      row.lastError = clip(error, 500) || 'the attempt failed'
      if (costsRetry) row.retries = Math.min(MAX_RETRIES, row.retries + 1)
      row.needsUser = row.retries >= MAX_RETRIES
      write(rows)
      const item = out(row, rows)
      emit('queue.failed', item, { error: item.lastError, retries: item.retries, needsUser: item.needsUser })
      return item
    },

    /**
     * A chat was closed or parked: everything it held that is not finished goes to the end of the
     * unassigned pile, keeping its state, dependencies, error and retry count. The rule the queue
     * exists for: nothing is binned because a chat went away.
     */
    release(chatId, { why = 'its chat was closed' } = {}) {
      if (!chatId) return []
      const rows = read()
      const mine = rows.filter((r) => r.chatId === String(chatId) && !FINISHED.has(r.state)).sort(byOrder)
      if (!mine.length) return []
      let at = endOf(rows.filter((r) => !mine.includes(r)), null)
      for (const row of mine) {
        row.chatId = null
        row.order = at++
        if (row.state === 'running') {
          row.state = 'queued'
          row.startedAt = null
        }
      }
      write(rows)
      const byId = index(rows)
      return mine.map((row) => {
        const item = decorate(row, byId)
        emit('queue.reassigned', item, { from: String(chatId), to: null, why: clip(why, 200) })
        return item
      })
    },

    /**
     * Once, on boot. An item left running when the host died has nobody working on it: back to
     * queued. The host restarting is not the item's fault, so it costs no retry.
     */
    restore() {
      const rows = read()
      const stranded = rows.filter((r) => r.state === 'running')
      if (!stranded.length) return []
      for (const row of stranded) {
        row.state = 'queued'
        row.startedAt = null
        row.lastError = 'the host restarted while this was running'
      }
      write(rows)
      const byId = index(rows)
      return stranded.map((r) => decorate(r, byId))
    },

    // -------------------------------------------------------------------- events ----

    /** events after `since`, for a page that reconnects */
    since: (from = 0) => events.filter((e) => e.seq > Number(from || 0)),
    /** listen to every event; returns the function that stops listening */
    watch(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
  return api
}
