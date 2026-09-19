/**
 * The fleet as a stream: a row per open chat, pushed when it changes, so the cockpit never polls.
 *
 *   GET /fleet/events   SSE
 *     event: snapshot   { at, rows }   on connect: every open chat
 *     event: row        { at, row }    a chat changed (state, text, spend, a decision, its tree)
 *     event: gone       { at, id }     a chat closed or was removed
 *     event: queue      <queue frame>  every queue event, exactly as /queue/events sends it
 *     event: train      { at, repo, phase, batch, … }  the merge train (merge-train.mjs)
 *
 * The snapshot also carries `queue` (the queue's GET view, done items included), and the queue's
 * frames ride on this stream, so a page that shows the fleet and its work holds one connection
 * rather than two. The queue contract (docs/QUEUE-CONTRACT.md) is unchanged: this only forwards it.
 *
 * A row is fleet-board.mjs's boardRow (the same read model the fleet board and the conductor
 * panel use) plus two things the cockpit needs and the board does not keep:
 *   - dirty: uncommitted files in the chat's folder (`git status --porcelain`), null when the
 *     folder is not a repo. Checked when the chat's state changes and when a page connects, never
 *     on a timer.
 *   - last: the last line the chat said.
 *   - ledger: the chat's work as git sees it (work-ledger.mjs, docs/MERGE-TRAIN-CONTRACT.md),
 *     re-read when its state changes or a tool finishes, and when a page connects.
 *
 * Changes are gathered and sent once per FLUSH_MS, so a streaming reply costs a few frames a
 * second, not one per token. Nothing here runs while nobody is connected.
 */
import { execFile } from 'node:child_process'
import { boardRow, progressBoards } from './fleet-board.mjs'

const FLUSH_MS = 250
/** progress boards are files on disk: read at most this often */
const BOARDS_MS = 2_000
/** a folder's git status is trusted this long */
const DIRTY_MS = 5_000

export function createFleetStream({ sessions, queue, ledger = null }) {
  const clients = new Set()
  const touched = new Set()
  let timer = null
  let boards = { at: 0, list: [] }
  const dirty = new Map() // cwd -> { at, n, pending }

  const boardsNow = () => {
    if (Date.now() - boards.at > BOARDS_MS) boards = { at: Date.now(), list: progressBoards() }
    return boards.list
  }

  /** uncommitted files in cwd; answers from cache and refreshes in the background */
  const dirtyOf = (cwd, fresh = false) => {
    let d = dirty.get(cwd)
    if (!d) dirty.set(cwd, (d = { at: 0, n: null, pending: false }))
    if ((fresh || Date.now() - d.at > DIRTY_MS) && !d.pending && cwd) {
      d.pending = true
      execFile('git', ['-C', cwd, 'status', '--porcelain'], { timeout: 5_000, maxBuffer: 4e6 }, (err, out) => {
        d.pending = false
        d.at = Date.now()
        const n = err ? null : String(out).split('\n').filter(Boolean).length
        if (n === d.n) return
        d.n = n
        for (const s of sessions.values()) if (s.cwd === cwd) touch(s)
      })
    }
    return d.n
  }

  const rowOf = (s) => {
    const r = boardRow(s, { boards: boardsNow() })
    const last = r.recent.findLast((x) => x.who === 'claude')?.text ?? ''
    return {
      ...r,
      recent: undefined,
      autopilot: !!s.autopilot,
      waiting: [...(s.pending?.values() ?? [])].map((p) => p.kind),
      dirty: dirtyOf(s.cwd),
      // the chat's work as git sees it (work-ledger.mjs); null until its first read lands
      ledger: ledger?.peek(s) ?? null,
      last,
    }
  }

  const write = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  const flush = () => {
    timer = null
    const at = Date.now()
    for (const id of touched) {
      const s = sessions.get(id)
      for (const res of clients)
        if (!s || s.state === 'closed') write(res, 'gone', { at, id })
        else write(res, 'row', { at, row: rowOf(s) })
    }
    touched.clear()
  }

  /** a chat changed; called from Session.emit */
  function touch(s, ev) {
    if (!clients.size) return
    if (ev?.t === 'status') dirtyOf(s.cwd, true)
    // its work may have moved: a turn ended or a tool (an edit, a commit) finished
    if (ev?.t === 'status' || ev?.t === 'tool_result') ledger?.poke(s)
    touched.add(s.id)
    timer ??= setTimeout(flush, FLUSH_MS)
  }

  /** GET /fleet/events */
  function serve(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    const open = [...sessions.values()].filter((s) => s.state !== 'closed')
    for (const s of open) {
      dirtyOf(s.cwd, true)
      ledger?.poke(s)
    }
    write(res, 'snapshot', { at: Date.now(), rows: open.map(rowOf), queue: queue?.view({ includeDone: true }) ?? null })
    clients.add(res)
    const unwatch = queue?.watch((e) => write(res, 'queue', e))
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000)
    req.on('close', () => {
      clearInterval(ping)
      unwatch?.()
      clients.delete(res)
    })
  }

  /** a frame for every page watching: the merge train's progress (`train`), the rebuild (`rebuild`) */
  function broadcast(event, data) {
    for (const res of clients) write(res, event, data)
  }

  return { touch, serve, broadcast }
}
