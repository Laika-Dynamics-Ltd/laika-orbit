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
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { execFile, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { briefSoon, loadBrief } from './chat-brief.mjs'
import { CONDUCTOR_PROMPT, ROLE, fleetServer, watchFleet } from './conductor.mjs'

const APP_PORT = process.env.APP_PORT ?? '5200'
const STATE = join(tmpdir(), `laika-agent-host-${APP_PORT}.json`)
const TOKEN = randomBytes(24).toString('hex')
/** changes every time a host starts: a page that sees a new one knows event numbers restarted */
const EPOCH = randomUUID()
const MAX_EVENTS = 4000
/** which build of this file is running, so the server can replace a stale host when idle */
const BUILD = statSync(new URL(import.meta.url)).mtimeMs

/** @type {Map<string, Session>} */
const sessions = new Map()
/** conductor chats wake when the chats they lead change (conductor.mjs) */
const fleet = watchFleet(sessions)

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
    return { start: w.start, tokens: w.done + Math.round(w.chars / 4), phase: w.phase }
  }

  emit(ev) {
    const e = { seq: ++this.seq, at: Date.now(), ...ev }
    this.events.push(e)
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
    this.updatedAt = e.at
    for (const fn of this.listeners) fn(e)
    return e
  }

  setState(state) {
    if (state === this.state) return
    this.state = state
    this.emit({ t: 'status', state })
    fleet.onState(this)
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
    const content = [
      ...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })),
      ...(text ? [{ type: 'text', text }] : []),
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
    this.setState('closed')
    this.wake?.()
  }
}

const summariseReply = (kind, r) =>
  kind === 'question' ? { answers: r.answers ?? {} } : { behavior: r.behavior, always: !!r.always, message: r.message ?? '' }

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
  const s = new Session(o)
  sessions.set(s.id, s)
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
      await startSession(
        { id: r.id, cwd: r.cwd, repo: r.repo, account, mode: r.mode, model: r.model, effort: r.effort, resume: r.sdkSessionId, title: r.title, role: r.role, autopilot: r.autopilot, autopilotUntil: r.autopilotUntil, goal: r.goal },
        { recovered: r.busy ? 'busy' : 'idle' },
      )
      n++
    } catch (e) {
      console.log(`could not recover a chat: ${e?.message ?? e}`)
    }
  }
  restoring = false
  fleet.restored()
  saveRegistry()
  if (n) console.log(`recovered ${n} chat(s)`)
  if (deferred.length) console.log(`${deferred.length} chat(s) wait for their copy elsewhere to close`)
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
      await startSession(
        { id: r.id, cwd: r.cwd, repo: r.repo, account, mode: r.mode, model: r.model, effort: r.effort, resume: r.sdkSessionId, title: r.title, role: r.role, autopilot: r.autopilot, autopilotUntil: r.autopilotUntil, goal: r.goal },
        { recovered: 'idle' },
      )
      console.log(`brought back ${r.sdkSessionId.slice(0, 8)}: its other copy closed`)
    } catch (e) {
      console.log(`could not bring back ${r.sdkSessionId.slice(0, 8)}: ${e?.message ?? e}`)
    }
  }
  deferred = waiting
  saveRegistry()
}

// ------------------------------------------------------------ duplicates ----
/** Claude Code processes on this machine and the conversation each has open (from --resume) */
function claudeProcesses() {
  let out = ''
  try {
    out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 20e6 })
  } catch {
    return []
  }
  const rows = []
  const cmds = new Map()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    cmds.set(Number(m[1]), m[3])
    const resume = /(?:^|\s)--resume[= ]([0-9a-f-]{36})/.exec(m[3])?.[1]
    if (resume && /\/claude(\s|$)/.test(m[3])) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), resume, command: m[3] })
  }
  for (const r of rows) {
    const parent = cmds.get(r.ppid) ?? ''
    r.host = parent.endsWith('agent-host.mjs')
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
 * died (reparented to launchd) holds nothing any more: it is swept, not counted.
 */
function elsewhere(sdkSessionId, procs = claudeProcesses()) {
  return procs.find((p) => p.resume === sdkSessionId && p.ppid !== process.pid && p.ppid !== 1) ?? null
}
/** stop Claude Code processes of this app's binary left behind by a host that died */
function sweepOrphans(procs = claudeProcesses()) {
  const bin = claudeBin()
  if (!bin.startsWith('/')) return
  for (const p of procs) {
    if (p.ppid !== 1 || !p.command.startsWith(`${bin} `)) continue
    try {
      process.kill(p.pid, 'SIGTERM')
      console.log(`stopped orphaned Claude Code process ${p.pid}`)
    } catch {}
  }
}
/**
 * Opening a conversation here that a stray copy of 1brain (a host nothing points at any more)
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
const withoutConfigDir = (env) => {
  const { CLAUDE_CONFIG_DIR, ...rest } = env
  return rest
}

async function runReal(s) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  s.abort = new AbortController()
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
      systemPrompt: { type: 'preset', preset: 'claude_code', ...(s.role === ROLE ? { append: CONDUCTOR_PROMPT } : {}) },
      ...(s.role === ROLE ? { mcpServers: { fleet: await fleetServer(s, sessions) }, allowedTools: ['mcp__fleet'] } : {}),
      // the default login (~/.claude) must run without CLAUDE_CONFIG_DIR: setting it makes
      // Claude Code look for its settings file inside the folder and treat it as a fresh install
      env: sameDir(s.account.configDir, join(homedir(), '.claude'))
        ? withoutConfigDir(process.env)
        : { ...process.env, CLAUDE_CONFIG_DIR: s.account.configDir },
      canUseTool: async (toolName, input, opts) => {
        if (toolName === 'AskUserQuestion') {
          const r = await s.ask('question', { toolUseId: opts.toolUseID, questions: input.questions ?? [] })
          if (r.behavior === 'deny') return { behavior: 'deny', message: r.message || 'The user declined to answer' }
          return { behavior: 'allow', updatedInput: { ...input, answers: r.answers ?? {}, annotations: r.annotations ?? {} } }
        }
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

function handleSdkMessage(s, m) {
  if (m.session_id) s.sdkSessionId = m.session_id
  switch (m.type) {
    case 'system':
      if (m.subtype === 'init') {
        s.model = m.model
        s.mode = m.permissionMode ?? s.mode
        s.emit({ t: 'init', model: m.model, mode: s.mode, sessionId: m.session_id, tools: m.tools?.length ?? 0, cwd: m.cwd, commands: m.slash_commands ?? [] })
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
    if (needsPermission) {
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
  sameDir(configDir, DEFAULT_DIR) ? withoutConfigDir(process.env) : { ...process.env, CLAUDE_CONFIG_DIR: configDir }

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
  return pty
}

const TERM_BUFFER = 400_000
/** @type {Map<string, Term>} */
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
      env: { ...(o.env ?? process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'laika-1brain' },
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

const authed = (req) => {
  const got = Buffer.from(String(req.headers['x-agent-token'] ?? ''))
  const want = Buffer.from(TOKEN)
  return got.length === want.length && timingSafeEqual(got, want)
}

const server = createServer(async (req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  if (!authed(req)) return json(401, { error: 'unauthorised' })
  const url = new URL(req.url, 'http://x')
  const parts = url.pathname.split('/').filter(Boolean)
  try {
    if (url.pathname === '/health') return json(200, { ok: true, pid: process.pid, build: BUILD, sessions: [...sessions.values()].filter((x) => x.state !== 'closed').length + [...terms.values()].filter((t) => t.exited === null).length })
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
    if (url.pathname === '/sessions' && req.method === 'GET') {
      return json(200, [...sessions.values()].filter((s) => s.state !== 'closed').map((s) => s.summary()))
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
      if (typeof b.on === 'boolean') fleet.setAutopilot(s, b.on, { minutes: Math.max(0, Math.min(24 * 60, Number(b.minutes) || 0)) })
      saveRegistry()
      return json(200, s.summary())
    }
    if (s && parts[2] === 'respond' && req.method === 'POST') {
      const b = await readBody(req)
      return json(s.answer(String(b.requestId), b.reply ?? {}) ? 200 : 404, { ok: true })
    }
    if (s && parts[2] === 'interrupt' && req.method === 'POST') {
      for (const [id] of s.pending) s.answer(id, { behavior: 'deny', message: 'Interrupted by the user', interrupt: true })
      // a busy Claude Code can take its time to acknowledge: the Stop button must not hang on it
      await Promise.race([s.query?.interrupt().catch(() => {}), new Promise((r) => setTimeout(r, 3000))])
      s.emit({ t: 'note', text: 'Interrupted' })
      s.setState('idle')
      briefSoon(s, envFor)
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
server.listen(0, '127.0.0.1', () => {
  console.log(`agent host on 127.0.0.1:${writeState()} for app :${APP_PORT}`)
  // bring back the chats a previous host had open
  restoreSessions().catch((e) => {
    restoring = false
    console.log(`recovery failed: ${e?.message ?? e}`)
  })
})
// one chat's failure must not take every chat down with the host
process.on('uncaughtException', (e) => console.log(`uncaught: ${e?.stack ?? e}`))
process.on('unhandledRejection', (e) => console.log(`unhandled: ${e?.stack ?? e}`))
// `kill -USR2 <pid>`: point the web server back at this host if its state file was lost
process.on('SIGUSR2', writeState)

const shutdown = () => {
  for (const s of sessions.values()) s.close()
  for (const t of [...terms.values()]) t.close()
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
    if (!liveSessions().length && !liveTerms().length) return shutdown()
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
    // a stray host closes its own copy; one outside the app, or the other 1brain app, is reported
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
  if (gone && !chats.some(busy) && !liveTerms().length && chats.every((x) => x.account?.demo))
    return shutdown()
}
setInterval(() => tidy().catch(() => {}), 30_000).unref()

/**
 * Claude Code processes left behind by a host that died without closing them (killed, crashed)
 * are reparented to launchd; they belong to nothing and hold a session open. Clear those out
 * once, at start. Only this repo's SDK binary, only processes with no parent host left.
 */
execFile('ps', ['-axo', 'pid=,ppid=,command='], (err, out) => {
  const bin = claudeBin()
  if (err || !bin.startsWith('/')) return
  for (const line of String(out).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m || m[2] !== '1' || !m[3].startsWith(`${bin} `)) continue
    try {
      process.kill(Number(m[1]), 'SIGTERM')
      console.log(`stopped orphaned Claude Code process ${m[1]}`)
    } catch {}
  }
})
