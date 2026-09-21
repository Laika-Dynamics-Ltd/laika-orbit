#!/usr/bin/env node
/**
 * Agent host: keeps in-app Claude Code sessions alive, separate from the web server.
 *
 * The web server restarts often (every edit to server.mjs); an agent mid-turn must not die with
 * it. So sessions live here, in a small detached process that the server starts on first use
 * and talks to over loopback with a per-launch token. The browser never reaches this process.
 *
 * Each session is one Claude Agent SDK query() in streaming-input mode, so it behaves like
 * Claude Code: same tools, CLAUDE.md, settings, MCP, permission rules. What the CLI would draw
 * in the terminal becomes events the app renders: text, tool cards, diffs, question cards,
 * permission prompts. Accounts are Claude Code config folders (CLAUDE_CONFIG_DIR), so each
 * session runs on the login in the folder it was started with.
 *
 * Until an account is connected, the `demo` account runs a scripted offline agent with the
 * same event stream — for building and filming the UI without using anyone's quota.
 *
 *   state file  <tmpdir>/laika-agent-host-<APP_PORT>.json   { port, token, pid }  (mode 0600)
 *
 * Installed on another machine (packages/node-bundle), it runs as a service on a fixed loopback
 * port with a token kept on disk, both set by the installer, and the Mac reaches it through SSH:
 *   AGENT_PORT        port to listen on (0 or unset picks a free one)
 *   AGENT_TOKEN_FILE  file holding the token (otherwise a new one each launch)
 *   AGENT_LAN=1       answer the local network as well as loopback, for the iOS app
 *
 * AGENT_LAN is off unless it is asked for, and it is the only way this process is reachable from
 * another machine without an SSH tunnel: updating must never be what puts a fleet on a café wifi.
 * With it on, every request passes refuseRequest (local-net.mjs) before anything else — the
 * address first, so something off the link cannot so much as time a guess at the token, then the
 * token, which is what it always was.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { execFile, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { bindAddress, refuseRequest } from './local-net.mjs'
import { homedir, hostname, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { briefSoon, loadBrief } from './chat-brief.mjs'
import { CONDUCTOR_PROMPT, FROM_CONDUCTOR, ROLE, fleetServer, restoredCloseAfter, savedCloseAfter, setAwayBudget, setAwayDigest, setFleetReport, settleCheckpointClose, watchFleet } from './conductor.mjs'
import { ACTIONS, createAutopilot } from './autopilot.mjs'
import { createAway } from './away.mjs'
import { fleetBoard } from './fleet-board.mjs'
import { allowBashPattern, DEFAULT_POLICY, explainRefusal, listPolicyAdditions, loadPolicy, readAwayLog, removeBashPattern, removeRepoPattern, restoreDefault, saveBudget } from './away-policy.mjs'
import { gpus, sysres } from './feeds/sysres.mjs'
import { available as secretsAvailable, secretsServer } from './secrets.mjs'
import { createJobs, memAvailable, prepareJobSlice, unityVersions, WORK_ROOT } from './jobs.mjs'
import { boardTasks, createParked, createTaskTracker, expandFleetCommand, FLEET_COMMANDS, groupLabel, inferGroup, parkedRow, BUDGET_LOW, spawnHold, spawnRefusal } from './fleet-work.mjs'
import { createSummaries } from './summary.mjs'
import { createQueue } from './queue.mjs'
import { createQueueHost } from './queue-host.mjs'
import { createFleetStream } from './fleet-stream.mjs'
import { createLedger } from './work-ledger.mjs'
import { createStableRebuild, isStableHost } from './stable-rebuild.mjs'
import { macBusy } from './feeds/loadwatch.mjs'
import { createTrain, createTrainStore, FROM_TRAIN, readyRefusal, WORK_PROMPT } from './merge-train.mjs'

const APP_PORT = process.env.APP_PORT ?? '5200'
const STATE = join(tmpdir(), `laika-agent-host-${APP_PORT}.json`)
const TOKEN = process.env.AGENT_TOKEN_FILE ? readFileSync(process.env.AGENT_TOKEN_FILE, 'utf8').trim() : randomBytes(24).toString('hex')
if (TOKEN.length < 32) throw new Error('AGENT_TOKEN_FILE holds no usable token')
/** changes every time a host starts: a page that sees a new one knows event numbers restarted */
const EPOCH = randomUUID()
const MAX_EVENTS = 4000
/** which build of this file is running, so the server can replace a stale host when idle */
const BUILD = statSync(new URL(import.meta.url)).mtimeMs

/** @type {Map<string, Session>} */
const sessions = new Map()
/** each chat's work as git sees it: worktree, branch, ahead/behind, uncommitted files (work-ledger.mjs) */
const trainStore = createTrainStore()
const ledger = createLedger({
  sessions,
  onChange: (x) => {
    fleetStream.touch(x, { t: 'ledger' })
    // a new commit may carry "Ready: yes"
    train.kick()
  },
  marks: trainStore.marks,
  trainOf: (worktree) => trainStore.records.get(worktree),
  // two chats' unmerged work touches the same file: both hear it now, not at merge time
  onOverlap: (x, y, files) => {
    const list = files.slice(0, 12).join(', ') + (files.length > 12 ? ` and ${files.length - 12} more` : '')
    const name = (c) => `${c.id.slice(0, 8)} (${c.title || c.repo})`
    for (const [me, other] of [[x, y], [y, x]])
      tellChat(me, `Heads up: chat ${name(other)} is also changing ${list} in ${me.repo}. Whichever slice lands second has to resolve any conflict, so keep your changes there small and commit them soon; say so if you need the other chat to hold off.`)
    fleetStream.broadcast('train', { at: Date.now(), repo: x.repo, phase: 'overlap', batch: [], chats: [x.id, y.id], files })
  },
})
/** a message from the merge train to a chat: a note in a demo chat, a turn in a real one */
const tellChat = (x, text) => (x.account?.demo ? x.emit({ t: 'note', text: `${FROM_TRAIN}${text}` }) : x.send(`${FROM_TRAIN}${text}`, [], { auto: true }))
/**
 * Mark a chat's slice ready at its current tip (docs/MERGE-TRAIN-CONTRACT.md): the same as a
 * "Ready: yes" trailer. `worktree` pins where the chat works when the host could not tell.
 */
async function markReady(x, { worktree = null, by = 'you' } = {}) {
  if (worktree) x.workPin = resolve(worktree)
  const l = await ledger.facts(x, { fresh: true })
  const why = readyRefusal(l)
  if (why) throw new Error(why)
  trainStore.marks.set(l.worktree, { sha: l.head, at: Date.now(), chat: x.id, by })
  // marked again after a red check or a conflict: the train tries it afresh
  trainStore.records.clear(l.worktree)
  train.kick()
  x.emit({ t: 'note', text: `Marked ready at ${l.head.slice(0, 7)} (${l.branch ?? 'detached'}): the merge train takes it from here` })
  await ledger.facts(x, { fresh: true })
  return ledger.get(x)
}
/** conductor chats wake when the chats they lead change (conductor.mjs) */
const fleet = watchFleet(sessions, { dirty: ledger.dirty })
/**
 * "I'm away": the conductor on autopilot, safe permissions approved without you, stuck chats
 * recovered (away.mjs). Kept beside the open-chat registry, so it survives a restart.
 */
const away = createAway({
  sessions,
  fleet,
  file: process.env.LAIKA_AWAY_STATE ?? join(homedir(), '.laika', `away-${APP_PORT}.json`),
  deps: {
    startConductor: (o) => startAwayConductor(o),
    revive: (s) => revive(s),
    interrupt: (s) => interruptSession(s, 'Interrupted while you were away: it had gone quiet'),
    carryOn: (s) => carryOn(s),
    accounts: () => accounts(),
    switchAccount: (s, account) => switchAccount(s, account, { resume: true }),
    saved: () => saveRegistry(),
    ended: (view) => summaries.awayEnded(view).catch(() => {}),
  },
})
setAwayDigest(() => away.digest())
/**
 * Autopilot as you see it: the mode (off / on / away), the ledger behind the timeline, and the
 * kill switch (autopilot.mjs). It is the only thing that changes the mode — away mode is one of
 * its three — and its gate goes ahead of the away budget, so the kill switch wins over everything.
 */
const autopilot = createAutopilot({
  sessions,
  fleet,
  away,
  file: process.env.LAIKA_AUTOPILOT_STATE ?? join(homedir(), '.laika', `autopilot-${APP_PORT}.json`),
  deps: {
    startConductor: (o) => startAwayConductor(o),
    saved: () => saveRegistry(),
    undo: {
      park: (id, reason) => parkChat(sessions.get(id), { reason }),
      unpark: (id) => unparkChat(null, id, {}),
      rename: (id, title, group) => renameChat(sessions.get(id), { title, group }),
      unallow: (pattern) => removeBashPattern(pattern),
      stop: (id) => interruptSession(sessions.get(id), 'Stopped from the autopilot timeline'),
    },
  },
})
// one gate for the fleet tools that act: the kill switch first, then the away budget
setAwayBudget((kind) => autopilot.refusal(kind) ?? away.budgetRefusal(kind))
// what the conductor did, for the activity timeline
setFleetReport((e) => autopilot.report(e))
/** chats a conductor parked (fleet_park): closed, but resumable by you or by it (fleet-work.mjs) */
const parked = createParked()
/** true once the host is stopping: closing every chat on the way out must not empty their queues */
let shuttingDown = false
/**
 * The work queue (queue.mjs, queue-host.mjs; the contract is docs/QUEUE-CONTRACT.md): work that
 * outlives the chat it was given to. An idle chat's next ready item goes out on autopilot, through
 * the same gate as fleet_send.
 */
const queue = createQueue()
const queueHost = createQueueHost({
  queue,
  sessions,
  deps: {
    gate: () => (autopilot.mode() === 'off' ? 'autopilot is off: it waits for you' : (autopilot.refusal('send') ?? away.budgetRefusal('send'))),
    send: (x, text) => x.send(`${FROM_CONDUCTOR}${text}`),
    report: (e) => autopilot.report(e),
    busy: () => restoring || shuttingDown,
    isConductor: (x) => x.role === ROLE,
  },
})
/** every open chat as a row, pushed as it changes (fleet-stream.mjs): the cockpit's feed */
const fleetStream = createFleetStream({ sessions, queue, ledger })
/**
 * The merge train (merge-train.mjs): ready slices onto an integration branch, the repo's light
 * check, then a fast-forward of local main. Never a push. What it has to say about a slice goes to
 * that slice's chat.
 */
const train = createTrain({
  sessions,
  ledger,
  store: trainStore,
  tell: tellChat,
  emit: (frame) => fleetStream.broadcast('train', frame),
  onLanded: () => rebuild?.kick(),
})
/**
 * The stable app only: when local main moves, its next version is built beside it and the page
 * offers a restart (stable-rebuild.mjs). It never restarts on its own.
 */
const rebuild = isStableHost()
  ? createStableRebuild({
      source: resolve(process.env.BRAIN_ROOT),
      emit: (frame) => fleetStream.broadcast('rebuild', frame),
      busy: () => (macBusy() ? 'this Mac is busy: the build waits until it is not' : null),
    })
  : null

// ----------------------------------------------------------------- sessions ----
class Session {
  constructor(o) {
    // a recovered chat keeps its id, so the page's tabs and groups still find it
    this.id = o.id ?? randomUUID()
    this.cwd = o.cwd
    this.repo = o.repo ?? o.cwd.split('/').pop()
    this.account = o.account
    this.mode = o.mode ?? 'default'
    this.model = o.model ?? null
    this.effort = o.effort ?? null
    this.resume = o.resume ?? null
    this.sdkSessionId = o.resume ?? null
    this.title = o.title ?? ''
    // a conductor leads the other chats toward `goal`; on autopilot it checks in without you
    this.role = o.role === ROLE ? ROLE : null
    this.autopilot = this.role === ROLE && !!o.autopilot
    this.goal = String(o.goal ?? '').slice(0, 2000)
    this.autopilotUntil = this.autopilot ? (o.autopilotUntil ?? null) : null
    // opened by a conductor's fleet_spawn: that conductor's id
    this.spawnedBy = o.spawnedBy ?? null
    // the project it belongs to, set by a conductor's fleet_rename; the app lists chats by it
    this.group = o.group ?? null
    this.state = 'starting' // starting | running | waiting | idle | closed | error
    this.createdAt = Date.now()
    this.updatedAt = Date.now()
    this.events = []
    this.seq = 0
    this.listeners = new Set()
    this.pending = new Map() // requestId → { resolve, kind, event }
    this.inbox = [] // queued user messages
    this.wake = null
    this.cost = 0
    this.turns = 0
    // the working line: output tokens this turn (finished messages exact, the streaming one estimated)
    this.work = { start: 0, done: 0, chars: 0, phase: null, sentAt: 0, timer: null }
    // background shells and agents, with a rough ETA each (fleet-work.mjs)
    this.tasks = createTaskTracker()
    this.bgBeat = null
    this.bgMemo = { at: 0, view: [] }
  }

  /** the background work and the chat's live-progress boards, read at most every 2s: an ETA may read files */
  background() {
    if (Date.now() - this.bgMemo.at > 2000) this.bgMemo = { at: Date.now(), view: [...boardTasks(this.sdkSessionId), ...(this.tasks.size ? this.tasks.view(this.sdkSessionId) : [])] }
    return this.bgMemo.view
  }

  /** a task started or ended: tell the page now, and keep its ETA fresh while any are running */
  tasksChanged() {
    this.bgMemo.at = 0
    this.progress(true)
    // a conductor may be waiting for this chat's background work to end (fleet_wait)
    fleet.tasksChanged(this)
    if (this.tasks.size && !this.bgBeat) {
      this.bgBeat = setInterval(() => (this.tasks.size ? this.progress(true) : this.tasksChanged()), 10_000)
      this.bgBeat.unref?.()
    } else if (!this.tasks.size && this.bgBeat) {
      clearInterval(this.bgBeat)
      this.bgBeat = null
    }
  }

  /** the turn's token count and phase, straight to whoever is watching; not kept in the log */
  progress(force = false) {
    const w = this.work
    const send = () => {
      w.timer = null
      w.sentAt = Date.now()
      const e = { t: 'progress', live: true, seq: this.seq, at: w.sentAt, ...this.workSummary() }
      for (const fn of this.listeners) fn(e)
    }
    if (force || Date.now() - w.sentAt > 250) {
      clearTimeout(w.timer)
      send()
    } else w.timer ??= setTimeout(send, 250)
  }

  workSummary() {
    const w = this.work
    return { start: w.start, tokens: w.done + Math.round(w.chars / 4), phase: w.phase, bg: this.background() }
  }

  emit(ev) {
    const e = { seq: ++this.seq, at: Date.now(), ...ev }
    this.events.push(e)
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
    this.updatedAt = e.at
    for (const fn of this.listeners) fn(e)
    fleetStream.touch(this, e)
    // an edit or a command may change its files or commit: the ledger (and the overlap check) re-reads
    if (e.t === 'tool' && !e.sub && /^(Edit|Write|MultiEdit|NotebookEdit|Bash)$/.test(e.name ?? '')) ledger.poke(this)
    return e
  }

  setState(state) {
    if (state === this.state) return
    this.state = state
    this.emit({ t: 'status', state })
    fleet.onState(this)
    queueHost.onState(this)
    // a turn ended: its commits (and any "Ready: yes") are in git now
    if (state === 'idle') ledger.poke(this)
    // asked by a conductor to checkpoint and close: close it once that turn is over, if it may be
    // (not while chats are coming back: its conductor may not be back yet)
    if (this.closeAfter && !restoring)
      settleCheckpointClose(this, sessions, { dirty: ledger.dirty, close: closeFromConductor, tell: fleet.tell }).catch((e) => console.log(`checkpoint close: ${e?.message ?? e}`))
    saveRegistry()
  }

  summary() {
    return {
      id: this.id,
      sdkSessionId: this.sdkSessionId,
      cwd: this.cwd,
      repo: this.repo,
      account: this.account.id,
      accountLabel: this.account.label,
      mode: this.mode,
      model: this.model,
      effort: this.effort,
      title: this.title,
      role: this.role,
      autopilot: this.autopilot,
      autopilotUntil: this.autopilotUntil ?? null,
      goal: this.goal,
      spawnedBy: this.spawnedBy,
      group: this.group,
      state: this.state,
      elsewhere: this.elsewhere ?? null,
      waiting: [...this.pending.values()].map((p) => p.kind),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      cost: this.cost,
      turns: this.turns,
      work: this.workSummary(),
    }
  }

  /**
   * the SDK pulls user messages from here, one per turn. A restarted Claude Code gets a new
   * reader; the old one lets go, so a message sent meanwhile cannot vanish into the dead process
   */
  async *input() {
    this.dropReader()
    const me = this.reader
    for (;;) {
      while (this.reader === me && this.inbox.length) yield this.inbox.shift()
      if (this.state === 'closed' || this.reader !== me) return
      let wake
      await new Promise((r) => {
        wake = this.wake = r
      })
      if (this.wake === wake) this.wake = null
    }
  }

  /** a stopped Claude Code's reader lets go, before anything else is sent */
  dropReader() {
    this.reader = (this.reader ?? 0) + 1
    this.wake?.()
  }

  send(text, images = [], { auto = false } = {}) {
    // /checkpoint and the other fleet commands: the chat shows what you typed, the model gets the whole instruction
    const said = expandFleetCommand(text) ?? text
    const content = [
      ...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })),
      ...(said ? [{ type: 'text', text: said }] : []),
    ]
    if (!content.length) return
    if (!this.title && text) this.title = text.replace(/\s+/g, ' ').slice(0, 80)
    // a conductor's first word from you is its goal, unless one was given
    if (this.role === ROLE && !this.goal && text && !auto) this.goal = text.trim().slice(0, 2000)
    // kept whole, so a message a usage limit stopped can be sent again on another account
    this.lastSent = { text, images }
    this.emit({
      t: 'user',
      text,
      ...(auto ? { auto: true } : {}),
      // thumbnails only: the full image already went to the model, the page needs a preview
      images: images.map((im) => ({ mediaType: im.mediaType, thumb: im.thumb ?? null, name: im.name ?? null })),
    })
    this.inbox.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content } })
    if (this.state !== 'running' && this.state !== 'waiting') Object.assign(this.work, { start: Date.now(), done: 0, chars: 0, phase: null })
    this.setState('running')
    this.progress(true)
    this.wake?.()
  }

  /** a permission or question the model is waiting on; resolves when the page answers */
  ask(kind, payload) {
    const requestId = randomUUID()
    return new Promise((resolveAnswer) => {
      const event = this.emit({ t: kind, requestId, ...payload })
      this.pending.set(requestId, { resolve: resolveAnswer, kind, event })
      this.setState('waiting')
    })
  }

  answer(requestId, reply) {
    const p = this.pending.get(requestId)
    if (!p) return false
    this.pending.delete(requestId)
    this.emit({ t: 'resolved', requestId, kind: p.kind, reply: summariseReply(p.kind, reply) })
    if (!this.pending.size) this.setState('running')
    p.resolve(reply)
    return true
  }

  close() {
    for (const [id] of this.pending) this.answer(id, { behavior: 'deny', message: 'Session closed' })
    this.abort?.abort()
    clearInterval(this.bgBeat)
    this.bgBeat = null
    this.setState('closed')
    this.wake?.()
  }
}

// a secret's reply carries its value: only whether it was given is kept or shown
const summariseReply = (kind, r) =>
  kind === 'question'
    ? { answers: r.answers ?? {} }
    : kind === 'secret'
      ? { behavior: typeof r.value === 'string' && r.value ? 'allow' : 'deny' }
      : { behavior: r.behavior, always: !!r.always, message: r.message ?? '' }

// ------------------------------------------------------------------ history ----
/**
 * A resumed chat shows where it left off: the tail of its saved transcript, replayed as the
 * same events a live session emits. Transcripts can be hundreds of MB, so only the end is read.
 */
const HISTORY_BYTES = 16_000_000
const HISTORY_EVENTS = 600

async function loadHistory(configDir, sessionId) {
  const projects = join(configDir, 'projects')
  let file = null
  try {
    for (const d of readdirSync(projects)) {
      const f = join(projects, d, `${sessionId}.jsonl`)
      if (existsSync(f)) {
        file = f
        break
      }
    }
  } catch {}
  if (!file) return { events: [], skipped: false }
  const size = statSync(file).size
  const start = Math.max(0, size - HISTORY_BYTES)
  const fh = await openFile(file, 'r')
  const buf = Buffer.alloc(size - start)
  await fh.read(buf, 0, buf.length, start)
  await fh.close()
  let text = buf.toString('utf8')
  if (start > 0) text = text.slice(text.indexOf('\n') + 1)
  const clip = (t, n = 20000) => (t.length > n ? `${t.slice(0, n)}\n… (truncated)` : t)
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (r.isSidechain || r.isMeta) continue
    const at = Date.parse(r.timestamp ?? '') || 0
    const content = r.message?.content
    if (r.type === 'user') {
      if (typeof content === 'string') {
        if (!/^\s*<(command-|local-command|system-reminder|task-notification)/.test(content)) events.push({ t: 'user', text: clip(content, 8000), images: [], at })
        continue
      }
      if (!Array.isArray(content)) continue
      const texts = content.filter((c) => c.type === 'text' && !/^\s*<(system-reminder|command-)/.test(c.text ?? '')).map((c) => c.text)
      const images = content.filter((c) => c.type === 'image').map(() => ({ mediaType: 'image', thumb: null, name: 'image' }))
      if (texts.length || images.length) events.push({ t: 'user', text: clip(texts.join('\n\n'), 8000), images, at })
      for (const c of content) {
        if (c.type !== 'tool_result') continue
        const out = Array.isArray(c.content) ? c.content.map((x) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n') : String(c.content ?? '')
        events.push({ t: 'tool_result', id: c.tool_use_id, error: !!c.is_error, text: clip(out, 6000), at })
      }
    } else if (r.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'text' && c.text?.trim()) events.push({ t: 'text', text: c.text, at })
        else if (c.type === 'tool_use') events.push({ t: 'tool', id: c.id, name: c.name, input: c.input ?? {}, at })
      }
    }
  }
  const skipped = start > 0 || events.length > HISTORY_EVENTS
  return { events: events.slice(-HISTORY_EVENTS), skipped }
}

// ---------------------------------------------------------------- starting ----
async function startSession(o, { recovered = null } = {}) {
  // a new chat with no group joins the one its repo's other open chats share (fleet_spawn's too)
  const joined = !recovered && !groupLabel(o.group) ? inferGroup(sessions.values(), { cwd: o.cwd, repo: o.repo }) : null
  if (joined) o = { ...o, group: joined }
  const s = new Session(o)
  sessions.set(s.id, s)
  if (joined) s.emit({ t: 'note', text: `In ${joined}, like the other chats open in ${o.repo || 'this folder'}` })
  ;(o.account.demo ? runDemo(s) : runRecovering(s)).catch((e) => {
    s.emit({ t: 'error', message: String(e?.message ?? e) })
    s.setState('error')
  })
  if (o.resume && !o.account.demo) {
    // show where it left off before anything new arrives
    const h = await loadHistory(o.account.configDir, o.resume).catch(() => ({ events: [], skipped: false }))
    if (h.skipped) s.emit({ t: 'note', text: 'Earlier messages are not shown here', history: true })
    for (const e of h.events) {
      const { at, ...rest } = e
      const ev = s.emit({ ...rest, history: true })
      ev.at = at || ev.at
    }
    if (recovered) {
      s.emit({
        t: 'note',
        text:
          recovered === 'busy'
            ? 'Recovered after a restart. Claude was in the middle of a task: say “continue” to carry on.'
            : 'Recovered after a restart',
      })
    } else if (h.events.length) s.emit({ t: 'note', text: 'Resumed here', history: true })
    // what the chat was for, straight away; brought up to date once it settles
    const brief = loadBrief(o.resume)
    if (brief) {
      s.brief = brief
      s.emit({ t: 'brief', ...brief, history: true })
    }
    briefSoon(s, envFor)
  }
  // recovered with nothing to send: ready for you, not working
  if (recovered && s.state === 'starting') s.setState('idle')
  saveRegistry()
  return s
}

// -------------------------------------------------------------- recovery ----
/**
 * The chats open in this host, on disk, so a host that dies (killed, crashed, the Mac restarting)
 * brings them back when it starts again: same ids, same conversations, their history replayed.
 * Kept in ~/.laika, not the temp folder, which macOS clears on restart.
 */
const REGISTRY = join(homedir(), '.laika', `agent-sessions-${APP_PORT}.json`)
let registryTimer = null
let restoring = true
/**
 * chats that could not come back because another process (an editor window) has the conversation
 * open: kept in the registry, and brought back here as soon as that copy closes
 */
let deferred = []
function saveRegistry() {
  if (restoring) return
  clearTimeout(registryTimer)
  registryTimer = setTimeout(() => {
    const live = [...sessions.values()]
      .filter((x) => x.state !== 'closed' && !x.account?.demo && x.sdkSessionId)
      .map((x) => ({
        id: x.id,
        sdkSessionId: x.sdkSessionId,
        cwd: x.cwd,
        repo: x.repo,
        account: x.account.id,
        mode: x.mode,
        model: x.model,
        effort: x.effort,
        title: x.title,
        role: x.role,
        autopilot: x.autopilot,
        autopilotUntil: x.autopilotUntil ?? null,
        goal: x.goal,
        spawnedBy: x.spawnedBy ?? null,
        group: x.group ?? null,
        // checkpointing to close (fleet_checkpoint_close): it still closes after a restart
        closeAfter: savedCloseAfter(x.closeAfter),
        busy: x.state === 'running' || x.state === 'starting',
      }))
    const rows = [...live, ...deferred.filter((d) => !live.some((x) => x.sdkSessionId === d.sdkSessionId))]
    try {
      mkdirSync(dirname(REGISTRY), { recursive: true, mode: 0o700 })
      writeFileSync(`${REGISTRY}.tmp`, JSON.stringify(rows, null, 1), { mode: 0o600 })
      renameSync(`${REGISTRY}.tmp`, REGISTRY)
    } catch (e) {
      console.log(`could not save open chats: ${e?.message ?? e}`)
    }
  }, 400)
}

async function restoreSessions() {
  // the dead host's processes first, so they are not mistaken for copies open elsewhere
  sweepOrphans()
  let rows = []
  try {
    rows = JSON.parse(readFileSync(REGISTRY, 'utf8'))
  } catch {}
  let n = 0
  for (const r of Array.isArray(rows) ? rows : []) {
    try {
      if (!r?.sdkSessionId || [...sessions.values()].some((x) => x.sdkSessionId === r.sdkSessionId)) continue
      // held by an old host that survived: it comes back here once that copy closes. Open in
      // another window or an editor: it lives there now, and closing it there must not revive it here
      const other = elsewhere(r.sdkSessionId)
      if (other) {
        if (heldByStray(other)) deferred.push(r)
        continue
      }
      const account = accounts().find((a) => a.id === r.account && !a.demo)
      if (!account || !existsSync(r.cwd)) continue
      const s = await startSession(
        { id: r.id, cwd: r.cwd, repo: r.repo, account, mode: r.mode, model: r.model, effort: r.effort, resume: r.sdkSessionId, title: r.title, role: r.role, autopilot: r.autopilot, autopilotUntil: r.autopilotUntil, goal: r.goal, spawnedBy: r.spawnedBy ?? null, group: r.group ?? null },
        { recovered: r.busy ? 'busy' : 'idle' },
      )
      s.closeAfter = restoredCloseAfter(r.closeAfter, { busy: r.busy })
      n++
    } catch (e) {
      console.log(`could not recover a chat: ${e?.message ?? e}`)
    }
  }
  restoring = false
  fleet.restored()
  // items left running by the old host go back to queued; chats that did not come back give theirs to the pile
  queueHost.restored({ keep: deferred.map((d) => d.id) })
  // chats that were checkpointing to close when the host went down: settled now their conductors are back
  for (const x of sessions.values()) if (x.closeAfter?.restored) settleRestoredClose(x)
  saveRegistry()
  if (n) console.log(`recovered ${n} chat(s)`)
  if (deferred.length) console.log(`${deferred.length} chat(s) wait for their copy elsewhere to close`)
}
/** a restored checkpoint-close: close it now if its checkpoint ran, or tell its conductor why not */
function settleRestoredClose(x) {
  settleCheckpointClose(x, sessions, { dirty: ledger.dirty, close: closeFromConductor, tell: fleet.tell }).catch((e) => console.log(`checkpoint close: ${e?.message ?? e}`))
}
/** bring back parked chats whose other copy has closed (called from tidy, in the current host) */
async function resumeDeferred(procs) {
  if (!deferred.length) return
  const waiting = []
  for (const r of deferred) {
    if ([...sessions.values()].some((x) => x.sdkSessionId === r.sdkSessionId && x.state !== 'closed')) continue
    const other = elsewhere(r.sdkSessionId, procs)
    if (other) {
      if (heldByStray(other)) waiting.push(r)
      continue
    }
    const account = accounts().find((a) => a.id === r.account && !a.demo)
    if (!account || !existsSync(r.cwd)) continue
    try {
      const s = await startSession(
        { id: r.id, cwd: r.cwd, repo: r.repo, account, mode: r.mode, model: r.model, effort: r.effort, resume: r.sdkSessionId, title: r.title, role: r.role, autopilot: r.autopilot, autopilotUntil: r.autopilotUntil, goal: r.goal, spawnedBy: r.spawnedBy ?? null, group: r.group ?? null },
        { recovered: 'idle' },
      )
      s.closeAfter = restoredCloseAfter(r.closeAfter, { busy: r.busy })
      if (s.closeAfter) settleRestoredClose(s)
      console.log(`brought back ${r.sdkSessionId.slice(0, 8)}: its other copy closed`)
    } catch (e) {
      console.log(`could not bring back ${r.sdkSessionId.slice(0, 8)}: ${e?.message ?? e}`)
    }
  }
  deferred = waiting
  saveRegistry()
}

// ------------------------------------------------------------ duplicates ----
/** Claude Code processes on this machine and the conversation each has open (from --resume, or null) */
function claudeProcesses() {
  try {
    return parseClaudeProcesses(execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 20e6 }))
  } catch {
    return []
  }
}
function parseClaudeProcesses(out) {
  const rows = []
  const cmds = new Map()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    cmds.set(Number(m[1]), m[3])
    const resume = /(?:^|\s)--resume[= ]([0-9a-f-]{36})/.exec(m[3])?.[1]
    if (/\/claude(\s|$)/.test(m[3])) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), resume: resume ?? null, command: m[3] })
  }
  for (const r of rows) {
    const parent = cmds.get(r.ppid) ?? ''
    r.host = parent.endsWith('agent-host.mjs')
    // a process whose host died is adopted by launchd (pid 1), or on Linux by the user's
    // systemd when the host ran as a user service
    r.orphan = r.ppid === 1 || /(^|\/)systemd --user\b/.test(parent)
    r.where = r.host
      ? 'another Laika Orbit window'
      : /antigravity/i.test(r.command)
        ? 'Antigravity'
        : /cursor/i.test(r.command)
          ? 'Cursor'
          : /\.vscode/i.test(r.command)
            ? 'VS Code'
            : 'another Claude Code window'
  }
  return rows
}
/**
 * another process with this conversation open, not one of this host's own. A process whose host
 * died (an orphan) holds nothing any more: it is swept, not counted.
 */
function elsewhere(sdkSessionId, procs = claudeProcesses()) {
  if (!sdkSessionId) return null
  return procs.find((p) => p.resume === sdkSessionId && p.ppid !== process.pid && !p.orphan) ?? null
}
/** stop Claude Code processes of this app's binary left behind by a host that died */
function sweepOrphans(procs = claudeProcesses()) {
  const bin = claudeBin()
  if (!bin.startsWith('/')) return
  for (const p of procs) {
    if (!p.orphan || !p.command.startsWith(`${bin} `)) continue
    try {
      process.kill(p.pid, 'SIGTERM')
      console.log(`stopped orphaned Claude Code process ${p.pid}`)
    } catch {}
  }
}
/**
 * Opening a conversation here that a stray copy of Laika Orbit (a host nothing points at any more)
 * still holds: that copy is stopped, so there is one. Copies in an editor are never touched.
 */
function takeOverFromStrays(sdkSessionId) {
  for (const p of claudeProcesses()) {
    if (p.resume !== sdkSessionId || p.ppid === process.pid || !p.host) continue
    if (hostIsCurrent(p.ppid)) continue
    try {
      process.kill(p.pid, 'SIGTERM')
      console.log(`stopped a duplicate of ${sdkSessionId.slice(0, 8)} in stray host ${p.ppid}`)
    } catch {}
  }
}
const heldByStray = (p) => p.host && !hostIsCurrent(p.ppid)
/** is this host pid the one some web server points at (any app port)? */
function hostIsCurrent(pid) {
  try {
    return readdirSync(tmpdir())
      .filter((f) => /^laika-agent-host-\d+\.json$/.test(f))
      .some((f) => {
        try {
          return JSON.parse(readFileSync(join(tmpdir(), f), 'utf8')).pid === pid
        } catch {
          return false
        }
      })
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- real runs ----
const sameDir = (a, b) => resolve(a).replace(/\/+$/, '') === resolve(b).replace(/\/+$/, '')
/**
 * What a chat, a terminal or a job gets from the host's environment: everything but the host's
 * own corpus. BRAIN_ROOT points the host at the main checkout; inherited, it pointed every test
 * server a chat started from its worktree at the main checkout too, so those servers rewrote its
 * runtime files and an older checkout's copy wrote a stale cache there under the old folder name.
 */
const childEnv = (env = process.env) => {
  const { BRAIN_ROOT, LAIKA_BRAIN_ROOT, ...rest } = env
  return rest
}
const withoutConfigDir = (env) => {
  const { CLAUDE_CONFIG_DIR, ...rest } = childEnv(env)
  return rest
}

async function chatServers(s) {
  const mcpServers = {}
  const allowedTools = []
  if (s.role === ROLE) {
    mcpServers.fleet = await fleetServer(s, sessions, { spawn: spawnFromConductor, close: closeFromConductor, renamed: renamedByConductor, park: parkFromConductor, unpark: unparkChat, parked: () => parked.list(), queue, dirty: ledger.dirty, ledger: ledger.get, ready: (x) => markReady(x, { by: 'conductor' }), hold: holdSpawns })
    allowedTools.push('mcp__fleet')
  }
  if (secretsAvailable()) {
    mcpServers.secrets = await secretsServer((p) => s.ask('secret', p))
    allowedTools.push('mcp__secrets')
  }
  return allowedTools.length ? { mcpServers, allowedTools } : {}
}

async function runReal(s) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  s.abort = new AbortController()
  // a new Claude Code process: the background work of the last one is gone with it
  if (s.tasks.reset()) s.tasksChanged()
  const q = query({
    prompt: s.input(),
    options: {
      cwd: s.cwd,
      resume: s.resume ?? undefined,
      model: s.model ?? undefined,
      permissionMode: s.mode,
      effort: s.effort ?? undefined,
      includePartialMessages: true,
      abortController: s.abort,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: s.role === ROLE ? `${CONDUCTOR_PROMPT}\n\n${WORK_PROMPT}` : WORK_PROMPT },
      // secrets come from the Keychain through a password field, never through the chat (secrets.mjs)
      ...(await chatServers(s)),
      // the default login (~/.claude) must run without CLAUDE_CONFIG_DIR: setting it makes
      // Claude Code look for its settings file inside the folder and treat it as a fresh install
      env: sameDir(s.account.configDir, join(homedir(), '.claude'))
        ? withoutConfigDir(process.env)
        : { ...childEnv(), CLAUDE_CONFIG_DIR: s.account.configDir },
      canUseTool: async (toolName, input, opts) => {
        if (toolName === 'AskUserQuestion') {
          const r = await s.ask('question', { toolUseId: opts.toolUseID, questions: input.questions ?? [] })
          if (r.behavior === 'deny') return { behavior: 'deny', message: r.message || 'The user declined to answer' }
          return { behavior: 'allow', updatedInput: { ...input, answers: r.answers ?? {}, annotations: r.annotations ?? {} } }
        }
        // while you are away, the plainly safe goes ahead; everything else asks you as always
        if (away.consider(s, toolName, input)?.allow) return { behavior: 'allow', updatedInput: input }
        const r = await s.ask('permission', {
          toolUseId: opts.toolUseID,
          tool: toolName,
          input,
          title: opts.title ?? null,
          description: opts.description ?? null,
          reason: opts.decisionReason ?? null,
          canAlways: !opts.suppressAlwaysAllowRule && !!opts.suggestions?.length,
        })
        if (r.behavior === 'allow') {
          return {
            behavior: 'allow',
            updatedInput: input,
            ...(r.always && opts.suggestions ? { updatedPermissions: opts.suggestions } : {}),
          }
        }
        return { behavior: 'deny', message: r.message || 'The user denied this', interrupt: !!r.interrupt }
      },
    },
  })
  s.query = q
  try {
    for await (const m of q) handleSdkMessage(s, m)
  } finally {
    s.query = null
  }
}

/**
 * A chat's Claude Code process can exit under it (a crash, an out-of-memory kill, a lost pipe).
 * The conversation is saved, so it is started again on the same session: at most three times in
 * ten minutes, and never while another process already has the conversation open.
 */
async function runRecovering(s) {
  for (;;) {
    let failure = null
    try {
      await runReal(s)
    } catch (e) {
      failure = e
    }
    s.dropReader()
    if (s.state === 'closed') return
    if (s.switchTo) {
      await finishSwitch(s)
      continue
    }
    const why = failure ? String(failure?.message ?? failure).slice(0, 200) : 'it exited'
    s.recoveries = (s.recoveries ?? []).filter((t) => Date.now() - t < 10 * 60_000)
    if (!s.sdkSessionId || s.recoveries.length >= 3) {
      s.emit({ t: 'error', message: `Claude Code stopped (${why}) and could not be restarted. Your conversation is saved: end this chat and open it again from history.` })
      s.setState('error')
      return
    }
    const other = elsewhere(s.sdkSessionId)
    if (other) {
      s.emit({ t: 'note', text: `Closed here: this conversation is open in ${other.where}` })
      s.close()
      sessions.delete(s.id)
      saveRegistry()
      return
    }
    s.recoveries.push(Date.now())
    for (const [id] of s.pending) s.answer(id, { behavior: 'deny', message: 'Claude Code restarted' })
    s.emit({ t: 'note', text: `Claude Code stopped (${why}). Restarting it on the same conversation…` })
    s.setState('idle')
    await new Promise((r) => setTimeout(r, 1500 * s.recoveries.length))
    if (s.state === 'closed') return
    s.resume = s.sdkSessionId
  }
}

/**
 * Away mode brings back a chat whose Claude Code stopped for good (restarts used up): a fresh
 * run on the same conversation, told to continue. A chat that is not in that state is left alone.
 */
function revive(s) {
  if (s.state !== 'error' || s.query || s.account?.demo || !s.sdkSessionId) return false
  s.recoveries = []
  s.resume = s.sdkSessionId
  s.setState('idle')
  runRecovering(s).catch((e) => {
    s.emit({ t: 'error', message: String(e?.message ?? e) })
    s.setState('error')
  })
  s.send('continue', [], { auto: true })
  return true
}

/** stop the turn in progress: whatever it waits on is denied, and a slow Claude Code gets 3s to acknowledge */
async function interruptSession(s, message = 'Interrupted by the user', note = 'Interrupted') {
  for (const [id] of s.pending) s.answer(id, { behavior: 'deny', message, interrupt: true })
  await Promise.race([s.query?.interrupt().catch(() => {}), new Promise((r) => setTimeout(r, 3000))])
  s.emit({ t: 'note', text: note })
  s.setState('idle')
  briefSoon(s, envFor)
}

/**
 * The conductor away mode starts when there is none: in the folder you name, or the one your most
 * recent chat works in, on that chat's account.
 */
async function startAwayConductor({ goal, cwd }) {
  const recent = [...sessions.values()].filter((x) => x.state !== 'closed').sort((a, b) => b.updatedAt - a.updatedAt)
  const base = recent.find((x) => !x.account?.demo) ?? recent[0]
  const where = cwd && existsSync(cwd) ? cwd : base?.cwd
  if (!where) throw new Error('Open a chat first: away mode needs a folder for its conductor')
  const account = base?.account ?? accounts().find((a) => !a.demo && a.loggedIn) ?? accounts().find((a) => a.demo)
  const s = await startSession({
    cwd: where,
    repo: where === base?.cwd ? base.repo : undefined,
    account,
    mode: 'default',
    role: ROLE,
    goal,
    title: `Conductor: ${goal.replace(/\s+/g, ' ').slice(0, 60)}`,
  })
  if (s.state === 'starting') s.setState('idle')
  s.emit({ t: 'note', text: 'Started for away mode: it keeps your chats moving until you are back' })
  return s
}

/** why new conductor chats should wait even under the cap: the Mac's or box1's load, a low away budget */
const holdSpawns = () => spawnHold({ budgetLow: () => away.budgetLow(BUDGET_LOW) })

/**
 * A conductor's fleet_spawn: a new chat in `cwd` with a first prompt, marked as the conductor's.
 * It is an ordinary chat from then on: the same permission prompts, the same away policy, shown in
 * the fleet and on the page like any other. Every spawn goes in the away log and summary.
 */
async function spawnFromConductor(c, { cwd, prompt, account: wanted, title }) {
  const refused = spawnRefusal(sessions, { hold: holdSpawns })
  if (refused) throw new Error(refused)
  const dir = resolve(String(cwd ?? '').replace(/^~(?=\/|$)/, homedir()))
  if (!dir.startsWith(`${homedir()}/`) || !existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`No folder at ${cwd}`)
  let account = c.account
  if (wanted) {
    const w = String(wanted).toLowerCase()
    account = accounts().find((a) => !a.demo && (a.id.toLowerCase() === w || a.label.toLowerCase() === w || a.email?.toLowerCase() === w))
    if (!account) throw new Error(`No account "${wanted}". Accounts: ${accounts().filter((a) => !a.demo).map((a) => a.label).join(', ')}`)
  }
  if (account.demo) throw new Error('The conductor runs on the offline demo account: it cannot open real chats')
  if (!(account.loggedIn || (await checkAuth(account.configDir)).loggedIn)) throw new Error(`${account.label} is not signed in`)
  const s = await startSession({
    cwd: dir,
    account,
    // the conductor's own mode, but never one that skips the permission prompts
    mode: c.mode === 'bypassPermissions' ? 'default' : c.mode,
    model: c.model ?? undefined,
    title: title ? String(title).slice(0, 80) : '',
    spawnedBy: c.id,
  })
  s.emit({ t: 'note', text: `Opened by the conductor (${c.id.slice(0, 8)})` })
  s.send(String(prompt))
  away.spawned(c, s, String(prompt))
  // undoing this parks the chat rather than closing it: parking keeps the conversation
  autopilot.report({ action: 'spawn', conductor: c, chat: s, text: String(prompt), undo: { kind: 'park' } })
  saveRegistry()
  return s
}

/**
 * A conductor's fleet_close, once conductor.mjs has checked it may (closeRefusal): the chat ends as
 * if you closed its tab, which frees a spawn slot. Every close goes in the away log and summary.
 */
async function closeFromConductor(c, x, { reason, force }) {
  if (!x.spawnedBy) throw new Error('Only a chat a conductor opened can be closed by one')
  deferred = deferred.filter((d) => d.id !== x.id && (!x.sdkSessionId || d.sdkSessionId !== x.sdkSessionId))
  x.emit({ t: 'note', text: `Closed by the conductor (${c.id.slice(0, 8)})${reason ? `: ${reason}` : ''}` })
  x.close()
  sessions.delete(x.id)
  away.closed(c, x, { reason, force })
  // no undo: Claude Code's conversation goes with the chat, and the timeline says so
  autopilot.report({ action: 'close', conductor: c, chat: x, text: `${x.title || x.repo}${force ? ' (forced)' : ''}`, reason })
  saveRegistry()
}

/**
 * Park a chat: it closes like any other, but its conversation goes in the parked list to be
 * resumed later, by you or by a conductor. `by` is the conductor that asked, or null for you —
 * the autopilot timeline's undo comes through here with no conductor.
 */
async function parkChat(x, { reason = '', by = null } = {}) {
  if (!x || x.state === 'closed') throw new Error('That chat is not open')
  if (!x.sdkSessionId || x.account?.demo) throw new Error('That chat has no conversation to keep')
  parked.add(parkedRow(x, { reason, by }))
  deferred = deferred.filter((d) => d.id !== x.id && d.sdkSessionId !== x.sdkSessionId)
  x.emit({ t: 'note', text: `Parked${by ? ` by the conductor (${by.slice(0, 8)})` : ''}${reason ? `: ${reason}` : ''}. It can be resumed.` })
  x.close()
  sessions.delete(x.id)
  saveRegistry()
  return x
}

/**
 * A conductor's fleet_park, once conductor.mjs has checked it may (closeRefusal): the chat closes
 * like fleet_close, but its conversation goes in the parked list, to be resumed later.
 */
async function parkFromConductor(c, x, { reason, force }) {
  if (!x.spawnedBy) throw new Error('Only a chat a conductor opened can be parked by one')
  await parkChat(x, { reason, by: c.id })
  away.parked(c, x, { reason, force })
  autopilot.report({ action: 'park', conductor: c, chat: x, text: x.title || x.repo, reason, undo: { kind: 'unpark' } })
}

/**
 * Resume a parked chat, as restoreSessions brings one back: the same id and conversation. `c` is
 * the conductor (fleet_unpark, which counts against the spawn cap) or null when you resume it.
 */
async function unparkChat(c, key, { text } = {}) {
  const r = parked.find(key)
  if (!r) throw new Error(`No single parked chat matches "${key}".${parked.list().length ? ` Parked: ${parked.list().map((p) => `${p.id.slice(0, 8)} (${p.repo})`).join(', ')}` : ' None are parked.'}`)
  const open = [...sessions.values()].find((x) => x.sdkSessionId === r.sdkSessionId && x.state !== 'closed')
  if (open) {
    parked.remove(r.id)
    return open
  }
  if (c && r.spawnedBy) {
    const refused = spawnRefusal(sessions, { hold: holdSpawns })
    if (refused) throw new Error(refused)
  }
  const other = elsewhere(r.sdkSessionId)
  if (other) throw new Error(`Its conversation is open in ${other.where}: close it there first`)
  const account = accounts().find((a) => a.id === r.account && !a.demo)
  if (!account) throw new Error('The account it ran on is gone')
  if (!existsSync(r.cwd)) throw new Error(`Its folder is gone: ${r.cwd}`)
  const s = await startSession({ id: r.id, cwd: r.cwd, repo: r.repo, account, mode: r.mode, model: r.model ?? undefined, effort: r.effort, resume: r.sdkSessionId, title: r.title, spawnedBy: r.spawnedBy ?? null, group: r.group ?? null })
  parked.remove(r.id)
  s.emit({ t: 'note', text: c ? `Resumed from parked by the conductor (${c.id.slice(0, 8)})` : 'Resumed from parked' })
  if (text) s.send(c ? `[from the conductor] ${text}` : String(text))
  else if (s.state === 'starting') s.setState('idle')
  away.unparked(c, s)
  autopilot.report({ action: 'unpark', conductor: c, chat: s, text: s.title || s.repo, undo: { kind: 'park' } })
  saveRegistry()
  return s
}

/** a conductor's fleet_rename: kept across restarts, and shown now */
function renamedByConductor(x) {
  x.emit({ t: 'note', text: `The conductor set this chat's title to "${x.title}"${x.group ? `, in ${x.group}` : ''}` })
  saveRegistry()
}

/** the autopilot timeline's undo of a rename: the title and group it had before */
function renameChat(x, { title, group }) {
  if (!x || x.state === 'closed') throw new Error('That chat is not open')
  if (title) x.title = String(title).slice(0, 80)
  x.group = group ? groupLabel(group) : null
  x.emit({ t: 'note', text: `Name put back: "${x.title}"${x.group ? `, in ${x.group}` : ''}` })
  saveRegistry()
  return x
}

function handleSdkMessage(s, m) {
  if (m.session_id) s.sdkSessionId = m.session_id
  switch (m.type) {
    case 'system':
      if (s.tasks.handle(m)) s.tasksChanged()
      if (m.subtype === 'init') {
        s.model = m.model
        s.mode = m.permissionMode ?? s.mode
        s.emit({ t: 'init', model: m.model, mode: s.mode, sessionId: m.session_id, tools: m.tools?.length ?? 0, cwd: m.cwd, commands: [...Object.keys(FLEET_COMMANDS), ...(m.slash_commands ?? [])] })
      } else if (m.subtype === 'compact_boundary') s.emit({ t: 'note', text: 'Conversation compacted' })
      return
    case 'stream_event': {
      const ev = m.event
      const w = s.work
      const top = !m.parent_tool_use_id
      // sub-agents' tokens count toward the turn, as in Claude Code; only the main agent sets the phase
      if (ev?.type === 'message_delta' && typeof ev.usage?.output_tokens === 'number') {
        w.done += ev.usage.output_tokens
        w.chars = 0
      } else if (ev?.type === 'content_block_start' && top) {
        const k = ev.content_block?.type
        w.phase = k === 'thinking' || k === 'redacted_thinking' ? 'thinking' : k === 'tool_use' ? 'tool' : k === 'text' ? 'writing' : w.phase
      } else if (ev?.type === 'content_block_delta') {
        const d = ev.delta
        w.chars += (d?.text ?? d?.thinking ?? d?.partial_json ?? '').length
      }
      if (ev?.type === 'message_delta' || ev?.type === 'content_block_start' || ev?.type === 'content_block_delta') s.progress()
      if (top && ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') s.emit({ t: 'delta', text: ev.delta.text })
      return
    }
    case 'assistant': {
      const sub = m.parent_tool_use_id
      for (const c of m.message?.content ?? []) {
        if (c.type === 'text' && c.text.trim()) s.emit({ t: 'text', text: c.text, sub })
        else if (c.type === 'thinking' && c.thinking) s.emit({ t: 'thinking', text: c.thinking, sub })
        else if (c.type === 'tool_use') s.emit({ t: 'tool', id: c.id, name: c.name, input: c.input, sub })
      }
      return
    }
    case 'user': {
      const content = m.message?.content
      if (!Array.isArray(content)) return
      for (const c of content) {
        if (c.type !== 'tool_result') continue
        const text = Array.isArray(c.content)
          ? c.content.map((x) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n')
          : String(c.content ?? '')
        s.emit({ t: 'tool_result', id: c.tool_use_id, error: !!c.is_error, text: text.length > 20000 ? `${text.slice(0, 20000)}\n… (truncated)` : text })
      }
      return
    }
    case 'result':
      s.turns = m.num_turns ?? s.turns
      s.cost = m.total_cost_usd ?? s.cost
      s.emit({ t: 'result', subtype: m.subtype, turns: m.num_turns, ms: m.duration_ms, cost: m.total_cost_usd, error: m.is_error ? m.result : null })
      if (!s.pending.size && s.state !== 'closed') s.setState('idle')
      briefSoon(s, envFor)
      return
    default:
  }
}

// ---------------------------------------------------------- switching accounts ----
/**
 * A chat can move to another Claude account mid-conversation, for when one hits its usage limit.
 * The conversation is a transcript in the account's own folder, so Claude Code is stopped, the
 * transcript (with its sub-agent logs and file checkpoints) is copied into the other account's
 * folder, and Claude Code starts again there on the same conversation.
 */
function carryConversation(fromDir, toDir, sessionId) {
  const projects = join(fromDir, 'projects')
  let found = null
  try {
    for (const d of readdirSync(projects)) {
      const f = join(projects, d, `${sessionId}.jsonl`)
      if (existsSync(f) && (!found || statSync(f).mtimeMs > statSync(found.file).mtimeMs)) found = { dir: d, file: f }
    }
  } catch {}
  if (!found) throw new Error('its saved conversation was not found')
  const dest = join(toDir, 'projects', found.dir)
  mkdirSync(dest, { recursive: true, mode: 0o700 })
  cpSync(found.file, join(dest, `${sessionId}.jsonl`))
  const extras = [
    [join(projects, found.dir, sessionId), join(dest, sessionId)],
    [join(fromDir, 'file-history', sessionId), join(toDir, 'file-history', sessionId)],
  ]
  for (const [from, to] of extras) if (existsSync(from)) cpSync(from, to, { recursive: true })
}

/** ask for the move; the chat's run loop finishes it once Claude Code has stopped */
function switchAccount(s, account, { resume = false } = {}) {
  return new Promise((done, fail) => {
    s.switchTo = { account, resume, done, fail }
    for (const [id] of s.pending) s.answer(id, { behavior: 'deny', message: 'Switching Claude account' })
    if (s.query) s.abort?.abort()
    // between restarts nothing is running: move straight away
    else finishSwitch(s)
  })
}

async function finishSwitch(s) {
  const { account, resume, done, fail } = s.switchTo
  s.switchTo = null
  const from = s.account
  const busy = s.state === 'running' || s.state === 'waiting'
  // let the stopped process finish writing its transcript
  await new Promise((r) => setTimeout(r, 400))
  try {
    if (s.sdkSessionId) carryConversation(from.configDir, account.configDir, s.sdkSessionId)
  } catch (e) {
    s.emit({ t: 'note', text: `Could not move this chat to ${account.label}: ${e.message}. It stays on ${from.label}.` })
    if (s.state !== 'closed') s.setState('idle')
    fail(e)
    return
  }
  s.account = account
  s.resume = s.sdkSessionId
  s.recoveries = []
  s.emit({ t: 'account', account: account.id, accountLabel: account.label })
  s.emit({ t: 'note', text: `Now on ${account.label}${busy && !resume ? '. Claude was mid-task: say “continue” to carry on.' : ''}` })
  s.setState('idle')
  saveRegistry()
  done()
  if (resume) carryOn(s)
}

/**
 * After a move, pick up where the limit stopped the chat: a message that got no work done
 * before the limit is sent again; a task stopped part-way is told to continue
 */
function carryOn(s) {
  const since = s.events.slice(s.events.findLastIndex((e) => e.t === 'user') + 1)
  const started = since.some((e) => e.t === 'tool' || (e.t === 'text' && !/limit/i.test(e.text)))
  if (!started && s.lastSent) s.send(s.lastSent.text, s.lastSent.images)
  else s.send('continue')
}

// ---------------------------------------------------------------- demo runs ----
/**
 * A scripted agent with the real event stream: streams text, reads a file, asks a question,
 * asks permission for an edit, shows the diff, keeps a todo list. No network, no quota.
 */
async function runDemo(s) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const stream = async (text) => {
    for (const w of text.match(/\S+\s*/g) ?? []) {
      if (s.state === 'closed') return
      s.work.phase = 'writing'
      s.work.chars += w.length
      s.progress()
      s.emit({ t: 'delta', text: w })
      await sleep(18)
    }
    s.emit({ t: 'text', text })
  }
  let tool = 0
  const call = async (name, input, result, needsPermission) => {
    const id = `demo_tool_${++tool}`
    s.emit({ t: 'tool', id, name, input })
    // the demo goes through the away policy too, so away mode can be tried without an account
    if (needsPermission && !away.consider(s, name, input)?.allow) {
      const r = await s.ask('permission', { toolUseId: id, tool: name, input, title: null, description: null, reason: null, canAlways: true })
      if (r.behavior !== 'allow') {
        s.emit({ t: 'tool_result', id, error: true, text: r.message || 'The user denied this' })
        return false
      }
    }
    await sleep(350)
    s.emit({ t: 'tool_result', id, error: false, text: result })
    return true
  }
  s.model = 'demo (offline)'
  s.sdkSessionId = s.resume ?? randomUUID()
  s.emit({ t: 'init', model: s.model, mode: s.mode, sessionId: s.sdkSessionId, tools: 6, cwd: s.cwd, commands: [] })
  s.setState('idle')

  for await (const msg of s.input()) {
    const text = msg.message.content.find((c) => c.type === 'text')?.text ?? ''
    const images = msg.message.content.filter((c) => c.type === 'image').length
    await sleep(250)
    if (images) await stream(`I can see ${images === 1 ? 'the image' : `${images} images`} you pasted. `)
    await stream(`Looking into "${text.slice(0, 60)}" in ${s.repo}.`)
    await call('TodoWrite', { todos: [
      { content: 'Read the current implementation', status: 'in_progress', activeForm: 'Reading the current implementation' },
      { content: 'Agree the approach', status: 'pending', activeForm: 'Agreeing the approach' },
      { content: 'Make the change', status: 'pending', activeForm: 'Making the change' },
    ] }, 'Todos updated')
    await call('Read', { file_path: `${s.cwd}/README.md` }, `# ${s.repo}\n\nService notes and setup.\n\n## Retries\nRetry failed webhooks 3 times with a fixed 5s delay.\n`)
    const q = await s.ask('question', {
      toolUseId: `demo_q_${tool}`,
      questions: [{
        question: 'How should failed webhooks be retried?',
        header: 'Retries',
        multiSelect: false,
        options: [
          { label: 'Exponential backoff', description: 'Waits 5s, 25s, 2m, 10m. Gentle on a struggling receiver.', preview: 'delay = 5s × 5^attempt\nattempts: 4\nmax wait: ~13 minutes' },
          { label: 'Fixed delay', description: 'Keep 5s between the 3 attempts, as it is today.', preview: 'delay = 5s\nattempts: 3\nmax wait: 15 seconds' },
          { label: 'No retries', description: 'Fail fast and surface the error to the dashboard.' },
        ],
      }],
    })
    const choice = Object.values(q.answers ?? {})[0] ?? 'Exponential backoff'
    await call('TodoWrite', { todos: [
      { content: 'Read the current implementation', status: 'completed', activeForm: 'Reading the current implementation' },
      { content: 'Agree the approach', status: 'completed', activeForm: 'Agreeing the approach' },
      { content: 'Make the change', status: 'in_progress', activeForm: 'Making the change' },
    ] }, 'Todos updated')
    await stream(`Going with ${String(choice).toLowerCase()}. Here's the edit:`)
    const ok = await call('Edit', {
      file_path: `${s.cwd}/README.md`,
      old_string: '## Retries\nRetry failed webhooks 3 times with a fixed 5s delay.\n',
      new_string: `## Retries\nRetry failed webhooks with ${String(choice).toLowerCase()}:\n\n- attempt 1 after 5s\n- attempt 2 after 25s\n- attempt 3 after 2m\n- give up after 4 attempts and alert\n`,
    }, 'The file README.md has been updated.', s.mode !== 'acceptEdits' && s.mode !== 'bypassPermissions')
    if (ok) {
      await call('Bash', { command: 'npm test -- webhooks', description: 'Run the webhook tests' }, 'PASS  test/webhooks.test.ts\n  ✓ retries with backoff (12 ms)\n  ✓ gives up after 4 attempts (3 ms)\n\nTests: 2 passed, 2 total', s.mode === 'default')
      await call('TodoWrite', { todos: [
        { content: 'Read the current implementation', status: 'completed', activeForm: 'Reading the current implementation' },
        { content: 'Agree the approach', status: 'completed', activeForm: 'Agreeing the approach' },
        { content: 'Make the change', status: 'completed', activeForm: 'Making the change' },
      ] }, 'Todos updated')
      // asked to ship it: a push to approve, so the fleet board's push button can be tried offline
      if (/\b(push|deploy|ship)\b/i.test(text)) await call('Bash', { command: 'git push origin main', description: 'Push the retry change' }, 'To github.com:example/webhooks.git\n   4f1c2d0..9a7e3b1  main -> main', true)
      await stream('Done. The README documents the new retry schedule and the webhook tests pass. This is the offline demo agent; connect a Claude account to run real sessions.')
    } else {
      await stream('No problem, I left the file as it was. Tell me what you would like instead.')
    }
    s.turns++
    s.emit({ t: 'result', subtype: 'success', turns: s.turns, ms: 0, cost: 0, error: null })
    if (s.state !== 'closed') s.setState('idle')
  }
}

// ----------------------------------------------------------------- accounts ----
const ACCOUNTS_FILE = resolve(process.env.BRAIN_ROOT ?? '.', 'brain', 'agents.local.json')
const DEFAULT_DIR = join(homedir(), '.claude')

function readAccountList() {
  try {
    return JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8')).accounts ?? []
  } catch {
    return []
  }
}
function writeAccountList(list) {
  writeFileSync(ACCOUNTS_FILE, `${JSON.stringify({ accounts: list }, null, 2)}\n`, { mode: 0o600 })
}

function accounts() {
  const real = readAccountList()
    .filter((a) => a?.id && a.configDir)
    .map((a) => {
      const configDir = String(a.configDir).replace(/^~(?=\/|$)/, homedir())
      const st = authCache.get(configDir)
      return {
        id: String(a.id),
        label: String(a.label ?? a.id),
        configDir,
        demo: false,
        // the login lives in the macOS Keychain; the last `claude auth status` says whose it is
        loggedIn: st ? st.loggedIn : null,
        email: st?.email ?? null,
        plan: st?.subscriptionType ?? null,
        checkedAt: st?.at ?? null,
      }
    })
  return [...real, { id: 'demo', label: 'Demo agent (offline)', configDir: '', demo: true, loggedIn: true, email: null, plan: null, checkedAt: null }]
}

/** Claude Code's own binary, the one the SDK runs, so auth checks read the same login store */
const claudeBin = () => {
  try {
    const sdk = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'))
    return sdk.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`)
  } catch {
    return 'claude'
  }
}
const envFor = (configDir) =>
  sameDir(configDir, DEFAULT_DIR) ? withoutConfigDir(process.env) : { ...childEnv(), CLAUDE_CONFIG_DIR: configDir }

const authCache = new Map()
function checkAuth(configDir) {
  return new Promise((done) => {
    execFile(claudeBin(), ['auth', 'status', '--json'], { env: envFor(configDir), timeout: 20000 }, (err, stdout) => {
      let st = { loggedIn: false }
      try {
        st = JSON.parse(String(stdout).trim() || '{}')
      } catch {}
      if (err && !stdout) st = { loggedIn: false, error: String(err.message).slice(0, 200) }
      const out = { loggedIn: !!st.loggedIn, email: st.email ?? null, subscriptionType: st.subscriptionType ?? null, at: Date.now() }
      authCache.set(configDir, out)
      done(out)
    })
  })
}

const slugOf = (label) =>
  String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'account'

// ---------------------------------------------------------------- terminals ----
/**
 * A real shell per session, in its repo: the terminal panel under a conversation. Output is
 * kept as a rolling buffer so a reloaded page repaints the screen, and the shell outlives the
 * page and the web server like the sessions do.
 */
const require = createRequire(import.meta.url)
let pty = null
function loadPty() {
  if (pty) return pty
  try {
    // pnpm does not run install scripts, so the prebuilt spawn helper arrives without its execute
    // bit and every spawn fails with "posix_spawnp failed"
    const root = dirname(require.resolve('node-pty/package.json'))
    for (const arch of ['darwin-arm64', 'darwin-x64']) {
      const helper = join(root, 'prebuilds', arch, 'spawn-helper')
      try {
        if (existsSync(helper) && !(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755)
      } catch {}
    }
    pty = require('node-pty')
  } catch {
    // the installed bundle carries a fork with prebuilt Linux binaries, so nothing compiles there
    pty = require('@lydell/node-pty')
  }
  return pty
}

const TERM_BUFFER = 400_000

/** commands run to completion for the Mac (a Unity test run, a build), in folders it syncs under the work root */
const jobs = createJobs({
  root: WORK_ROOT,
  // a capped machine (installed with --capped) has other work of its own to keep up with
  maxRunning: Number(process.env.AGENT_MAX_JOBS) || 0,
  nice: Number(process.env.AGENT_JOB_NICE) || 0,
  // all jobs together stay under the machine's memory, so one that runs away is the one stopped
  slice: prepareJobSlice(),
})
/** @type {Map<string, Term>} */
/**
 * The summary routine: a page every hour and when away mode ends (summary.mjs). Its card is the
 * `summary` widget, written only where this host serves a brain with a widgets folder.
 */
const WIDGETS = resolve(process.env.BRAIN_ROOT ?? '.', 'brain', 'widgets')
const summaries = createSummaries({
  sessions,
  away,
  jobs,
  readLog: (since) => readAwayLog({ since, limit: 2000 }),
  // runs (runs.mjs), where this build has them
  boards: async () => (await import('./runs.mjs').catch(() => null))?.listBoards?.() ?? [],
  dir: process.env.LAIKA_SUMMARY_DIR ?? join(homedir(), '.laika', `summaries-${APP_PORT}`),
  widget: existsSync(WIDGETS) ? join(WIDGETS, 'summary.json') : null,
})
const terms = new Map()

class Term {
  constructor(o) {
    this.id = randomUUID()
    this.cwd = o.cwd
    this.owner = o.owner ?? null
    this.buf = ''
    this.offset = 0 // bytes dropped from the front of buf, so clients can resume by position
    this.listeners = new Set()
    this.exited = null
    const shell = process.env.SHELL || '/bin/zsh'
    // a terminal is a login shell, unless the host gives it one fixed job (signing in)
    this.proc = loadPty().spawn(o.file ?? shell, o.args ?? ['-l'], {
      name: 'xterm-256color',
      cols: o.cols ?? 100,
      rows: o.rows ?? 24,
      cwd: o.cwd,
      env: { ...(o.env ?? childEnv()), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'laika-orbit' },
    })
    this.proc.onData((d) => {
      this.buf += d
      if (this.buf.length > TERM_BUFFER) {
        const cut = this.buf.length - TERM_BUFFER
        this.buf = this.buf.slice(cut)
        this.offset += cut
      }
      const at = this.offset + this.buf.length
      for (const fn of this.listeners) fn({ t: 'data', data: d, at })
    })
    this.proc.onExit(({ exitCode }) => {
      this.exited = exitCode
      for (const fn of this.listeners) fn({ t: 'exit', code: exitCode })
    })
  }
  summary() {
    return { id: this.id, cwd: this.cwd, owner: this.owner, exited: this.exited }
  }
  close() {
    try {
      this.proc.kill()
    } catch {}
    terms.delete(this.id)
  }
}

// --------------------------------------------------------------------- http ----
const readBody = async (req, limit = 30e6) => {
  const chunks = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > limit) throw new Error('body too large')
    chunks.push(c)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

/** what this machine is and how busy it is, so new work can go where there is room */
async function machine() {
  const [load, gpu] = await Promise.all([sysres(), gpus()])
  return { hostname: hostname(), platform: process.platform, arch: process.arch, ...load, gpus: gpu, unity: unityVersions(), jobs: liveJobs().length, work: WORK_ROOT, cap: jobs.cap, memFree: Number.isFinite(memAvailable()) ? memAvailable() : null }
}

/** off unless asked for: the fleet is not put on a network by an update */
const BIND = bindAddress()
const LAN = BIND !== '127.0.0.1'

const server = createServer(async (req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  // the front door, in this order: on the link, then holding this launch's token
  const refused = refuseRequest(req, TOKEN)
  if (refused) return json(refused.code, refused.body)
  const url = new URL(req.url, 'http://x')
  const parts = url.pathname.split('/').filter(Boolean)
  try {
    if (url.pathname === '/health') return json(200, { ok: true, pid: process.pid, build: BUILD, sessions: [...sessions.values()].filter((x) => x.state !== 'closed').length + [...terms.values()].filter((t) => t.exited === null).length, machine: url.searchParams.has('machine') ? await machine() : undefined })
    const shownAccounts = () => accounts().map((a) => ({ ...a, configDir: a.configDir.replace(homedir(), '~') }))
    if (url.pathname === '/accounts' && req.method === 'GET') {
      // check anything never checked, so the list says whose login each account is
      const unchecked = accounts().filter((a) => !a.demo && a.loggedIn === null)
      if (unchecked.length) await Promise.all(unchecked.map((a) => checkAuth(a.configDir)))
      return json(200, shownAccounts())
    }
    if (url.pathname === '/accounts' && req.method === 'POST') {
      const b = await readBody(req, 1e4)
      const label = String(b.label ?? '').trim().slice(0, 60)
      if (!label) return json(400, { error: 'Give the account a name' })
      const list = readAccountList()
      let id = slugOf(label)
      while (list.some((a) => a.id === id) || id === 'demo') id = `${id}-2`
      // the first account can be your normal login; every other one gets its own folder
      const useDefault = b.useDefault === true && !list.some((a) => sameDir(String(a.configDir).replace(/^~/, homedir()), DEFAULT_DIR))
      const configDir = useDefault ? '~/.claude' : `~/.claude-accounts/${id}`
      if (!useDefault) mkdirSync(join(homedir(), '.claude-accounts', id), { recursive: true, mode: 0o700 })
      list.push({ id, label, configDir })
      writeAccountList(list)
      await checkAuth(configDir.replace(/^~/, homedir()))
      return json(200, shownAccounts().find((a) => a.id === id))
    }
    if (parts[0] === 'accounts' && parts[1]) {
      const acct = accounts().find((a) => a.id === parts[1] && !a.demo)
      if (!acct) return json(404, { error: 'no such account' })
      if (parts[2] === 'check' && req.method === 'POST') {
        await checkAuth(acct.configDir)
        return json(200, shownAccounts().find((a) => a.id === acct.id))
      }
      if (parts[2] === 'login' && req.method === 'POST') {
        const b = await readBody(req, 1e4)
        // a terminal with one job: Claude Code's own sign-in for this account's folder
        const t = new Term({
          cwd: homedir(),
          owner: `login:${acct.id}`,
          cols: b.cols,
          rows: b.rows,
          file: claudeBin(),
          args: ['auth', 'login', '--claudeai'],
          env: envFor(acct.configDir),
        })
        terms.set(t.id, t)
        t.listeners.add((e) => {
          if (e.t === 'exit') checkAuth(acct.configDir)
        })
        return json(200, t.summary())
      }
      if (parts[2] === 'logout' && req.method === 'POST') {
        await new Promise((done) => execFile(claudeBin(), ['auth', 'logout'], { env: envFor(acct.configDir), timeout: 20000 }, () => done()))
        await checkAuth(acct.configDir)
        return json(200, shownAccounts().find((a) => a.id === acct.id))
      }
      if (parts.length === 2 && req.method === 'PATCH') {
        const b = await readBody(req, 1e4)
        const list = readAccountList()
        const row = list.find((a) => a.id === acct.id)
        if (row && typeof b.label === 'string' && b.label.trim()) row.label = b.label.trim().slice(0, 60)
        writeAccountList(list)
        return json(200, shownAccounts().find((a) => a.id === acct.id))
      }
      if (parts.length === 2 && req.method === 'DELETE') {
        // forgets the account here; its folder and Keychain login stay, so re-adding is instant
        writeAccountList(readAccountList().filter((a) => a.id !== acct.id))
        return json(200, { ok: true })
      }
    }
    if (url.pathname === '/jobs' && req.method === 'GET') return json(200, jobs.list())
    if (url.pathname === '/jobs' && req.method === 'POST') {
      try {
        return json(200, jobs.start(await readBody(req)))
      } catch (e) {
        return json(e?.busy ? 409 : 400, { error: String(e?.message ?? e) })
      }
    }
    if (parts[0] === 'jobs') {
      const id = parts[1] ?? ''
      if (!jobs.get(id)) return json(404, { error: 'no such job' })
      if (parts.length === 2 && req.method === 'GET') return json(200, jobs.get(id))
      if (parts.length === 2 && req.method === 'DELETE') return json(200, { ok: jobs.kill(id) })
      if (parts[2] === 'events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        const ping = setInterval(() => res.write(': ping\n\n'), 15000)
        const stop = jobs.watch(id, url.searchParams.get('since') ?? 0, (e) => {
          res.write(`data: ${JSON.stringify(e)}\n\n`)
          if (e.t === 'exit') res.end()
        })
        req.on('close', () => {
          clearInterval(ping)
          stop?.()
        })
        return
      }
      return json(404, { error: 'not found' })
    }
    if (url.pathname === '/terms' && req.method === 'GET') return json(200, [...terms.values()].map((t) => t.summary()))
    if (url.pathname === '/terms' && req.method === 'POST') {
      const b = await readBody(req)
      if (!b.cwd || !existsSync(b.cwd)) return json(400, { error: 'folder not found' })
      // one terminal per owner (a session): reopening the panel reattaches to the same shell
      const existing = b.owner ? [...terms.values()].find((t) => t.owner === b.owner && t.exited === null) : null
      const t = existing ?? new Term({ cwd: b.cwd, owner: b.owner, cols: b.cols, rows: b.rows })
      terms.set(t.id, t)
      return json(200, t.summary())
    }
    if (parts[0] === 'terms') {
      const t = terms.get(parts[1] ?? '')
      if (!t) return json(404, { error: 'no such terminal' })
      if (parts.length === 2 && req.method === 'DELETE') {
        t.close()
        return json(200, { ok: true })
      }
      if (parts[2] === 'events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        const since = Number(url.searchParams.get('since') ?? 0)
        const start = Math.max(0, since - t.offset)
        const backlog = t.buf.slice(start)
        const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`)
        if (backlog) send({ t: 'data', data: backlog, at: t.offset + t.buf.length, replay: since === 0 })
        if (t.exited !== null) send({ t: 'exit', code: t.exited })
        t.listeners.add(send)
        const ping = setInterval(() => res.write(': ping\n\n'), 15000)
        req.on('close', () => {
          clearInterval(ping)
          t.listeners.delete(send)
        })
        return
      }
      if (parts[2] === 'input' && req.method === 'POST') {
        const b = await readBody(req, 1e6)
        if (t.exited === null && typeof b.data === 'string') t.proc.write(b.data)
        return json(200, { ok: true })
      }
      if (parts[2] === 'resize' && req.method === 'POST') {
        const b = await readBody(req, 1e4)
        const cols = Math.max(20, Math.min(500, Number(b.cols) || 80))
        const rows = Math.max(5, Math.min(200, Number(b.rows) || 24))
        if (t.exited === null) t.proc.resize(cols, rows)
        return json(200, { ok: true })
      }
      return json(404, { error: 'not found' })
    }
    // away mode: GET its state (with the parked chats); POST { on: true, minutes, goal?, cwd?, budget?: { dollars?, spawns? } } or { on: false }
    if (url.pathname === '/away' && req.method === 'GET') return json(200, { ...away.get(), parked: parked.list() })
    if (url.pathname === '/away' && req.method === 'POST') {
      const b = await readBody(req, 1e4)
      if (b.on === false) return json(200, away.stop('back'))
      if (b.on !== true) return json(400, { error: 'Say on: true or on: false' })
      try {
        const budget = b.budget && typeof b.budget === 'object' ? { dollars: b.budget.dollars, spawns: b.budget.spawns } : undefined
        return json(200, await away.start({ minutes: b.minutes, goal: typeof b.goal === 'string' ? b.goal : '', cwd: typeof b.cwd === 'string' ? b.cwd : null, budget }))
      } catch (e) {
        return json(400, { error: String(e?.message ?? e) })
      }
    }
    // autopilot: the mode, what it has done, what it cost, and the kill switch (autopilot.mjs)
    if (url.pathname === '/autopilot' && req.method === 'GET') return json(200, autopilot.view())
    if (url.pathname === '/autopilot' && req.method === 'POST') {
      const b = await readBody(req, 1e4)
      try {
        const budget = b.budget === null ? null : b.budget && typeof b.budget === 'object' ? { dollars: b.budget.dollars, spawns: b.budget.spawns } : undefined
        return json(200, await autopilot.set(b.mode, { minutes: Number(b.minutes) || 0, goal: typeof b.goal === 'string' ? b.goal : '', cwd: typeof b.cwd === 'string' ? b.cwd : null, budget, reason: typeof b.reason === 'string' ? b.reason : '' }))
      } catch (e) {
        return json(400, { error: String(e?.message ?? e) })
      }
    }
    // the kill switch: the conductor stops sending, now. POST to halt, DELETE to release it
    if (url.pathname === '/autopilot/halt' && req.method === 'POST') {
      const b = await readBody(req, 1e4)
      return json(200, autopilot.halt(typeof b.reason === 'string' ? b.reason : ''))
    }
    if (url.pathname === '/autopilot/halt' && req.method === 'DELETE') return json(200, autopilot.resume())
    // the conductor panel: every chat's state and ETA, what the conductor last sent it, what is
    // queued and what it waits on — the whole fleet without opening any of it
    if (url.pathname === '/autopilot/fleet' && req.method === 'GET') return json(200, autopilot.panel())
    // the decision inbox: everything waiting on you, what reaches outside this machine first.
    // Answering one goes to POST /sessions/:id/respond, the same route the chat's own card uses:
    // nothing is ever approved here for you.
    if (url.pathname === '/autopilot/inbox' && req.method === 'GET') return json(200, autopilot.inbox())
    // the policy, editable in the app: what may run unattended, the budget, per-repo overrides,
    // and — at the top, because it is the one that catches people out — which safe defaults the
    // policy file is switching off
    if (url.pathname === '/autopilot/policy' && req.method === 'GET') {
      const { removed, repos, budget, minutes, ...additions } = listPolicyAdditions()
      return json(200, { defaults: { read: DEFAULT_POLICY.read, write: DEFAULT_POLICY.write, bash: DEFAULT_POLICY.bash }, additions, removed, repos, budget, minutes, recovery: loadPolicy().recovery })
    }
    if (url.pathname === '/autopilot/policy' && req.method === 'POST') {
      const b = await readBody(req, 1e4)
      try {
        return json(200, saveBudget({ budget: b.budget, minutes: b.minutes }))
      } catch (e) {
        return json(400, { error: String(e?.message ?? e) })
      }
    }
    // stop allowing something the file added: a shell pattern, a tool, or one repo's own pattern
    if (url.pathname === '/autopilot/policy/allow' && req.method === 'POST') {
      const b = await readBody(req, 1e4)
      const pattern = String(b.pattern ?? '').trim()
      if (!pattern) return json(400, { error: 'Say which pattern' })
      if (b.on !== false) return json(400, { error: 'Always-allow is granted from the decision it came from, never from a typed pattern' })
      try {
        if (b.repo) return json(200, removeRepoPattern(pattern, String(b.repo)))
        if (DEFAULT_POLICY.bash.includes(pattern.split(/\s+/).join(' '))) return json(400, { error: 'That is a built-in: take it out under removed.bash in the policy file' })
        return json(200, removeBashPattern(pattern))
      } catch (e) {
        return json(400, { error: String(e?.message ?? e) })
      }
    }
    // put a safe default the file had switched off back
    if (url.pathname === '/autopilot/policy/restore' && req.method === 'POST') {
      const b = await readBody(req, 1e4)
      try {
        return json(200, restoreDefault(String(b.pattern ?? '')))
      } catch (e) {
        return json(400, { error: String(e?.message ?? e) })
      }
    }
    // the activity timeline: every conductor action with its reason, since ?since= (ms)
    if (url.pathname === '/autopilot/timeline' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since')) || 0
      const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 200))
      return json(200, { actions: autopilot.ledger({ since, limit }), can: ACTIONS })
    }
    // take one action back, where it can be taken back; never anything outward-facing
    if (url.pathname === '/autopilot/undo' && req.method === 'POST') {
      const b = await readBody(req, 1e4)
      try {
        return json(200, await autopilot.undo(String(b.id ?? '')))
      } catch (e) {
        return json(400, { error: String(e?.message ?? e) })
      }
    }
    // the away log: every auto-approval, everything left for you and every recovery, since ?since= (ms)
    // summaries: GET the latest (?id= one, ?list=1 their ids, ?md=1 as Markdown); POST writes one now
    if (url.pathname === '/summary' && req.method === 'GET') {
      if (url.searchParams.has('list')) return json(200, { ids: summaries.list(), nextAt: summaries.nextAt() })
      const id = url.searchParams.get('id') ?? summaries.list()[0]
      if (url.searchParams.has('md')) {
        const md = id ? summaries.markdown(id) : null
        if (md === null) return json(404, { error: 'no such summary' })
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(md)
      }
      const x = id ? summaries.get(id) : null
      return x ? json(200, { ...x, nextAt: summaries.nextAt() }) : json(404, { error: 'no summary yet' })
    }
    if (url.pathname === '/summary' && req.method === 'POST') return json(200, await summaries.now())
    if (url.pathname === '/away/log' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since')) || away.get().startedAt || 0
      const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 500))
      return json(200, readAwayLog({ since, limit }))
    }
    // what may run while away: GET the defaults, what the policy file adds and what it removes;
    // POST /away/policy/remove { pattern } takes back a pattern the file added (never a default)
    if (url.pathname === '/away/policy' && req.method === 'GET') {
      const { removed, ...additions } = listPolicyAdditions()
      return json(200, { defaults: { read: DEFAULT_POLICY.read, write: DEFAULT_POLICY.write, bash: DEFAULT_POLICY.bash }, additions, removed })
    }
    if (url.pathname === '/away/policy/remove' && req.method === 'POST') {
      const b = await readBody(req, 1e4)
      if (typeof b.pattern !== 'string' || !b.pattern.trim()) return json(400, { error: 'Say which pattern to remove' })
      if (DEFAULT_POLICY.bash.includes(b.pattern.trim().split(/\s+/).join(' '))) return json(400, { error: 'That is a built-in pattern: take it out under removed.bash in the policy file' })
      try {
        return json(200, removeBashPattern(b.pattern))
      } catch (e) {
        return json(400, { error: String(e?.message ?? e) })
      }
    }
    // parked chats (fleet_park): GET the list; POST /parked/<id>/resume brings one back; DELETE /parked/<id> forgets it
    if (await queueHost.route(url, req, res, { json, readBody })) return
    if (url.pathname === '/parked' && req.method === 'GET') return json(200, parked.list())
    if (parts[0] === 'parked' && parts.length === 3 && parts[2] === 'resume' && req.method === 'POST') {
      try {
        const b = await readBody(req, 1e5)
        return json(200, (await unparkChat(null, parts[1], { text: typeof b.text === 'string' && b.text.trim() ? b.text : undefined })).summary())
      } catch (e) {
        return json(/^No single parked/.test(String(e?.message)) ? 404 : 400, { error: String(e?.message ?? e) })
      }
    }
    if (parts[0] === 'parked' && parts.length === 2 && req.method === 'DELETE') {
      return parked.remove(parts[1]) ? json(200, { ok: true }) : json(404, { error: 'no such parked chat' })
    }
    if (url.pathname === '/sessions' && req.method === 'GET') {
      return json(200, [...sessions.values()].filter((s) => s.state !== 'closed').map((s) => s.summary()))
    }
    // the fleet board: a line per chat and every decision waiting on you (fleet-board.mjs)
    if (url.pathname === '/fleet' && req.method === 'GET') return json(200, fleetBoard(sessions.values()))
    if (url.pathname === '/fleet/events' && req.method === 'GET') return fleetStream.serve(req, res)
    // the stable app's next version: GET its state; POST /stable/restart restarts into it (you asked)
    if (url.pathname === '/stable' && req.method === 'GET') return json(200, rebuild?.view() ?? { state: 'off' })
    if (url.pathname === '/stable/restart' && req.method === 'POST') {
      if (!rebuild) return json(409, { error: 'Only the stable app restarts into a new version' })
      try {
        return json(200, rebuild.restart())
      } catch (e) {
        return json(409, { error: String(e?.message ?? e) })
      }
    }
    // the ready marker: POST { chat, worktree? } marks that chat's slice ready at its tip
    if (url.pathname === '/train/ready' && req.method === 'POST') {
      const b = await readBody(req)
      const x = sessions.get(String(b.chat ?? ''))
      if (!x || x.state === 'closed') return json(404, { error: 'no such chat' })
      try {
        return json(200, { ledger: await markReady(x, { worktree: typeof b.worktree === 'string' && b.worktree ? b.worktree : null }) })
      } catch (e) {
        return json(409, { error: String(e?.message ?? e) })
      }
    }
    if (url.pathname === '/sessions' && req.method === 'POST') {
      const b = await readBody(req)
      const account = accounts().find((a) => a.id === b.account)
      if (!account) return json(400, { error: 'unknown account' })
      if (!b.cwd || !existsSync(b.cwd)) return json(400, { error: 'folder not found' })
      const mode = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].includes(b.mode) ? b.mode : 'default'
      const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(b.effort) ? b.effort : null
      // one conversation, one chat: resuming one this host already has returns that chat
      const already = b.resume ? [...sessions.values()].find((x) => x.sdkSessionId === b.resume && x.state !== 'closed') : null
      if (already) return json(200, already.summary())
      if (b.resume) takeOverFromStrays(b.resume)
      const s = await startSession({ cwd: b.cwd, repo: b.repo, account, mode, effort, model: b.model, resume: b.resume, title: b.title, role: b.role, autopilot: b.autopilot, goal: b.goal })
      if (b.text || b.images?.length) s.send(b.text ?? '', b.images ?? [])
      // nothing sent yet: the chat is ready for you, not working
      else if (s.state === 'starting') s.setState('idle')
      return json(200, s.summary())
    }
    const s = parts[0] === 'sessions' ? sessions.get(parts[1] ?? '') : undefined
    if (parts[0] === 'sessions' && parts.length === 2 && req.method === 'DELETE') {
      // an ended chat is also forgotten where it was parked, so it cannot come back later
      const parked = deferred.length
      deferred = deferred.filter((d) => d.id !== parts[1] && (!s?.sdkSessionId || d.sdkSessionId !== s.sdkSessionId))
      if (s) {
        s.close()
        sessions.delete(s.id)
      }
      if (!s && deferred.length === parked) return json(404, { error: 'no such session' })
      saveRegistry()
      return json(200, { ok: true })
    }
    if (parts[0] === 'sessions' && !s) return json(404, { error: 'no such session' })
    if (s && parts[2] === 'events') {
      const since = Number(url.searchParams.get('since') ?? 0)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      const send = (e) =>
        res.write(e.live ? `event: progress\ndata: ${JSON.stringify(e)}\n\n` : `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`)
      res.write(`event: summary\ndata: ${JSON.stringify({ ...s.summary(), epoch: EPOCH })}\n\n`)
      for (const e of s.events) if (e.seq > since) send(e)
      s.listeners.add(send)
      const ping = setInterval(() => res.write(': ping\n\n'), 15000)
      req.on('close', () => {
        clearInterval(ping)
        s.listeners.delete(send)
      })
      return
    }
    if (s && parts[2] === 'message' && req.method === 'POST') {
      const b = await readBody(req)
      const images = (b.images ?? []).filter((im) => /^image\/(png|jpeg|gif|webp)$/.test(im.mediaType) && typeof im.data === 'string')
      s.send(String(b.text ?? ''), images)
      if (s.role === ROLE) fleet.humanSpoke(s)
      return json(200, { ok: true })
    }
    if (s && parts[2] === 'autopilot' && req.method === 'POST') {
      if (s.role !== ROLE) return json(400, { error: 'Only a conductor chat has autopilot' })
      const b = await readBody(req, 1e4)
      if (typeof b.goal === 'string') s.goal = b.goal.trim().slice(0, 2000)
      const ending = away.get()
      // "I'm back" on the conductor away mode runs: away mode ends with it
      if (b.on === false && ending.on && ending.conductorId === s.id) away.stop('back')
      else if (typeof b.on === 'boolean') fleet.setAutopilot(s, b.on, { minutes: Math.max(0, Math.min(24 * 60, Number(b.minutes) || 0)) })
      saveRegistry()
      return json(200, s.summary())
    }
    if (s && parts[2] === 'respond' && req.method === 'POST') {
      const b = await readBody(req)
      return json(s.answer(String(b.requestId), b.reply ?? {}) ? 200 : 404, { ok: true })
    }
    // "always allow this while away": the pattern is worked out again here, never taken from the page
    if (s && parts[2] === 'away-allow' && req.method === 'POST') {
      const b = await readBody(req, 1e4)
      const requestId = String(b.requestId)
      const p = s.pending.get(requestId)
      if (!p || p.kind !== 'permission') return json(404, { error: 'That permission is no longer waiting' })
      const x = explainRefusal(p.event.tool, p.event.input, s, loadPolicy())
      if (!x.allow && !x.allowPattern) return json(400, { error: 'Away mode has no pattern to offer for this' })
      if (x.allowPattern) {
        try {
          allowBashPattern(x.allowPattern)
        } catch (e) {
          return json(400, { error: String(e?.message ?? e) })
        }
        s.emit({ t: 'note', text: `Always allowed “${x.allowPattern}” while you are away` })
      }
      s.answer(requestId, { behavior: 'allow' })
      return json(200, { ok: true, pattern: x.allowPattern })
    }
    if (s && parts[2] === 'interrupt' && req.method === 'POST') {
      // a busy Claude Code can take its time to acknowledge: the Stop button must not hang on it
      await interruptSession(s)
      return json(200, { ok: true })
    }
    if (s && parts[2] === 'model' && req.method === 'POST') {
      // switch the model mid-conversation; an empty value means Claude Code's default
      const b = await readBody(req)
      const model = typeof b.model === 'string' && b.model.trim() ? b.model.trim().slice(0, 80) : null
      s.model = model
      if (s.query) {
        try {
          await s.query.setModel(model ?? undefined)
        } catch (e) {
          return json(400, { error: String(e?.message ?? e) })
        }
      }
      s.emit({ t: 'model', model })
      return json(200, { ok: true })
    }
    if (s && parts[2] === 'account' && req.method === 'POST') {
      // carry this conversation over to another Claude account; `resume` says “continue” there
      const b = await readBody(req, 1e4)
      const account = accounts().find((a) => a.id === b.account && !a.demo)
      if (!account) return json(400, { error: 'unknown account' })
      if (s.account.demo) return json(400, { error: 'A demo chat cannot move to a real account: start a new chat' })
      if (account.id === s.account.id) return json(200, s.summary())
      if (s.switchTo) return json(409, { error: 'This chat is already switching account' })
      // a login already seen is trusted (asking Claude Code again takes seconds)
      const loggedIn = account.loggedIn || (await checkAuth(account.configDir)).loggedIn
      if (!loggedIn) return json(400, { error: `${account.label} is not signed in` })
      try {
        await switchAccount(s, account, { resume: b.resume === true })
      } catch (e) {
        return json(400, { error: String(e?.message ?? e) })
      }
      return json(200, s.summary())
    }
    // you move a chat to a group (or out of one), and optionally rename it, from the app
    if (s && parts[2] === 'group' && req.method === 'POST') {
      const b = await readBody(req)
      if (b.group === undefined && b.title === undefined) return json(400, { error: 'give a group, a title, or both' })
      if (b.title !== undefined) s.title = String(b.title ?? '').slice(0, 80)
      if (b.group !== undefined) {
        const g = groupLabel(b.group)
        if (g !== s.group) s.emit({ t: 'note', text: g ? `Moved to ${g}` : `Taken out of ${s.group}` })
        s.group = g
      }
      saveRegistry()
      return json(200, s.summary())
    }
    if (s && parts[2] === 'mode' && req.method === 'POST') {
      const b = await readBody(req)
      if (!['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].includes(b.mode)) return json(400, { error: 'bad mode' })
      s.mode = b.mode
      await s.query?.setPermissionMode(b.mode).catch(() => {})
      s.emit({ t: 'mode', mode: b.mode })
      return json(200, { ok: true })
    }
    return json(404, { error: 'not found' })
  } catch (e) {
    return json(500, { error: String(e?.message ?? e) })
  }
})

const writeState = () => {
  const { port } = server.address()
  writeFileSync(STATE, JSON.stringify({ port, token: TOKEN, pid: process.pid }), { mode: 0o600 })
  chmodSync(STATE, 0o600)
  return port
}
server.listen(Number(process.env.AGENT_PORT) || 0, BIND, () => {
  const port = writeState()
  console.log(`agent host on ${BIND}:${port} for app :${APP_PORT}`)
  if (LAN) console.log(`  on the local network (AGENT_LAN=1): this machine's fleet can be driven from another machine on this link, with the token and from a private address only`)
  // bring back the chats a previous host had open
  restoreSessions()
    .catch((e) => {
      restoring = false
      console.log(`recovery failed: ${e?.message ?? e}`)
      queueHost.restored({ keep: deferred.map((d) => d.id) })
    })
    // away mode carries on once its chats are back, or ends if its time ran out meanwhile
    .then(() => away.restore())
    // the kill switch and the spend so far outlive a host restart
    .then(() => autopilot.restore())
    // the hourly summary, and a first one now if the card has nothing from the last hour
    .then(() => summaries.start())
    .catch((e) => console.log(`summary routine: ${e?.message ?? e}`))
})
// one chat's failure must not take every chat down with the host
process.on('uncaughtException', (e) => console.log(`uncaught: ${e?.stack ?? e}`))
process.on('unhandledRejection', (e) => console.log(`unhandled: ${e?.stack ?? e}`))
// `kill -USR2 <pid>`: point the web server back at this host if its state file was lost
process.on('SIGUSR2', writeState)

const shutdown = () => {
  shuttingDown = true
  for (const s of sessions.values()) s.close()
  for (const t of [...terms.values()]) t.close()
  jobs.killAll()
  try {
    if (JSON.parse(readFileSync(STATE, 'utf8')).pid === process.pid) unlinkSync(STATE)
  } catch {}
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ------------------------------------------------------------ tidying up after itself ----
/**
 * Hosts must never pile up. Every 30s this host checks whether it is still the one the web
 * server talks to (the state file) and whether that server is still there, and leaves when it
 * has become a spare:
 *  - not pointed at, with no chats or terminals: exit at once (a replacement took over)
 *  - not pointed at, with chats nobody can reach: close them once they have sat idle for 30
 *    minutes, then exit (conversations stay saved and can be resumed from history)
 *  - its web server gone for 10 minutes and nothing running: exit (a test or demo instance)
 * Real chats survive the app quitting: a host still pointed at keeps them however long.
 * If the state file vanished while this host is alive, it writes it again instead.
 */
const liveSessions = () => [...sessions.values()].filter((x) => x.state !== 'closed')
const liveTerms = () => [...terms.values()].filter((t) => t.exited === null)
const liveJobs = () => jobs.list().filter((j) => j.state === 'running')
const busy = (x) => x.state === 'running' || x.state === 'starting'
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const IDLE_ORPHAN_MS = 30 * 60_000
const SERVER_GONE_MS = 10 * 60_000
let serverGoneSince = 0
async function tidy() {
  let st = null
  try {
    st = JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {}
  const mine = st?.pid === process.pid
  if (!st || (!mine && !pidAlive(st.pid))) {
    // nobody holds the pointer: this host is the one the server should find
    try {
      writeState()
    } catch {}
    return
  }
  const chats = liveSessions()
  const procs = chats.some((x) => x.sdkSessionId) || (mine && deferred.length) ? claudeProcesses() : []
  if (mine) await resumeDeferred(procs)
  if (!mine) {
    // a stray host gives up any conversation that is also open somewhere else, straight away
    for (const x of chats) {
      if (x.sdkSessionId && elsewhere(x.sdkSessionId, procs)) {
        console.log(`closing duplicate ${x.sdkSessionId.slice(0, 8)}: open elsewhere`)
        x.close()
        sessions.delete(x.id)
      }
    }
    if (!liveSessions().length && !liveTerms().length && !liveJobs().length) return shutdown()
    const quiet = liveSessions().every((x) => !busy(x) && Date.now() - x.updatedAt > IDLE_ORPHAN_MS)
    if (quiet) {
      console.log(`closing ${chats.length} unreachable idle chat(s); another host serves :${APP_PORT}`)
      return shutdown()
    }
    return
  }
  for (const x of chats) {
    if (!x.sdkSessionId) continue
    const other = elsewhere(x.sdkSessionId, procs)
    // a stray host closes its own copy; one outside the app, or the other Laika Orbit app, is reported
    const where = other && (!other.host || hostIsCurrent(other.ppid)) ? other.where : null
    if (where !== (x.elsewhere ?? null)) {
      x.elsewhere = where
      x.emit({
        t: 'note',
        text: where
          ? `This conversation is also open in ${where}. Replies from both go into the same conversation: close it there, or end it here.`
          : 'No longer open anywhere else',
      })
    }
  }
  const up = await fetch(`http://127.0.0.1:${APP_PORT}/`, { signal: AbortSignal.timeout(3000) })
    .then(() => true)
    .catch(() => false)
  if (up) serverGoneSince = 0
  else serverGoneSince ||= Date.now()
  const gone = serverGoneSince && Date.now() - serverGoneSince > SERVER_GONE_MS
  if (gone && !chats.some(busy) && !liveTerms().length && !liveJobs().length && chats.every((x) => x.account?.demo))
    return shutdown()
}
setInterval(() => tidy().catch(() => {}), 30_000).unref()

/**
 * Claude Code processes left behind by a host that died without closing them (killed, crashed)
 * are orphans; they belong to nothing and hold a session open. Clear those out once, at start.
 * Only this repo's SDK binary, only processes with no parent host left.
 */
execFile('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 20e6 }, (err, out) => {
  if (!err) sweepOrphans(parseClaudeProcesses(String(out)))
})
