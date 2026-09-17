/**
 * Chat briefs: what a chat is for, where it stands, and a short label for each of your prompts.
 *
 * You switch between many chats; coming back to one should not mean rereading it. After each turn
 * the host condenses the chat (your prompts, what Claude did, how each turn ended) and asks a small
 * model, on the chat's own login, to interpret it. The answer goes out as a `brief` event, so the
 * track beside the chat can show the goal and label its nodes, and is kept on disk so a resumed
 * chat has it straight away.
 *
 *   ~/.laika/briefs/<sdk session id>.json   { goal, now, next, turns: [{ p, label, status }], count, at }
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = join(homedir(), '.laika', 'briefs')
const MODEL = process.env.LAIKA_BRIEF_MODEL ?? 'haiku'
/** after a turn ends, wait this long: a quick follow-up would make the brief stale at once */
const SETTLE_MS = 4000
const MAX_TURNS = 40
const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

const clip = (t, n) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}
/** how the page and the host match a label to a prompt: its opening words */
export const promptKey = (text) => clip(text, 60)

/** the chat as turns: a prompt, what Claude did about it, and how it ended */
export function turnsOf(events) {
  const turns = []
  let t = null
  for (const e of events) {
    // Claude Code writes an interruption into the transcript as if you had said it
    if (e.t === 'user' && /^\[Request interrupted/.test(String(e.text ?? ''))) {
      if (t) t.end = 'interrupted'
      continue
    }
    if (e.t === 'user') {
      t = { prompt: String(e.text ?? ''), images: e.images?.length ?? 0, steps: 0, files: new Set(), commands: [], errors: 0, answer: '', end: 'open' }
      turns.push(t)
      continue
    }
    if (!t || e.sub) continue
    if (e.t === 'tool') {
      if (e.name === 'TodoWrite') continue
      t.steps++
      const input = e.input ?? {}
      const path = input.file_path ?? input.notebook_path
      if (EDITS.has(e.name) && typeof path === 'string') t.files.add(path.split('/').pop())
      if (e.name === 'Bash' && t.commands.length < 3) t.commands.push(clip(input.command, 70))
      if ((e.name === 'Agent' || e.name === 'Task') && t.commands.length < 3) t.commands.push(`sub-agent: ${clip(input.description, 60)}`)
    } else if (e.t === 'tool_result' && e.error) t.errors++
    else if (e.t === 'text') t.answer = String(e.text ?? '')
    else if (e.t === 'result') t.end = e.error ? 'error' : 'done'
    else if (e.t === 'note' && e.text === 'Interrupted') t.end = 'interrupted'
    else if (e.t === 'error') t.end = 'error'
  }
  // a replayed transcript has no result events: a turn Claude answered counts as ended
  for (const x of turns) if (x.end === 'open' && x !== turns.at(-1) && x.answer) x.end = 'done'
  return turns
}

function digest(turns, previous) {
  const shown = turns.slice(-MAX_TURNS)
  const skipped = turns.length - shown.length
  const lines = []
  if (skipped) lines.push(`(${skipped} earlier prompts not shown. The goal as understood before them: ${previous?.goal || 'unknown'})`, '')
  shown.forEach((t, k) => {
    const i = skipped + k
    lines.push(`## Prompt ${i}${t.images ? ` (+${t.images} image)` : ''}`, clip(t.prompt, 700) || '(image only)')
    const did = [`${t.steps} steps`]
    if (t.files.size) did.push(`edited ${[...t.files].slice(0, 6).join(', ')}`)
    if (t.commands.length) did.push(`ran ${t.commands.join(' | ')}`)
    if (t.errors) did.push(`${t.errors} failed steps`)
    lines.push(`Claude: ${did.join('; ')}. Ended: ${t.end}.`)
    if (t.answer) lines.push(`Claude's last words: ${clip(t.answer, 450)}`)
    lines.push('')
  })
  return lines.join('\n')
}

const SYSTEM = `You keep the task log for one coding chat between a developer and Claude Code. The developer runs many chats at once and switches between them; your log is how they remember what this chat is doing without rereading it.

Read the chat and give:

- goal: the outcome the whole chat is working towards, as the developer would say it. At most 12 words. Interpret: a series of fixes to one feature has that feature as its goal.
- now: where it stands at this moment: what was just finished, what is in progress, or what Claude is waiting on from the developer. At most 16 words.
- next: the obvious next step, or "" if there is none. At most 12 words.
- turns: one entry per prompt shown, "i" is its number. label: what that prompt asked for, 3 to 7 words, starting with a verb (Fix, Add, Explain, Review…). status: done if Claude completed it; partial if it only got part way or the developer had to follow up about the same thing; blocked if it failed or was interrupted; open if it is the latest and still running or unanswered.
Plain words. No quotes around names, no trailing full stops.`

const SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string' },
    now: { type: 'string' },
    next: { type: 'string' },
    turns: {
      type: 'array',
      items: {
        type: 'object',
        properties: { i: { type: 'number' }, label: { type: 'string' }, status: { type: 'string', enum: ['done', 'partial', 'blocked', 'open'] } },
        required: ['i', 'label', 'status'],
      },
    },
  },
  required: ['goal', 'now', 'next', 'turns'],
}

function parse(text) {
  const m = /\{[\s\S]*\}/.exec(String(text ?? ''))
  if (!m) return null
  try {
    const j = JSON.parse(m[0])
    return typeof j.goal === 'string' && Array.isArray(j.turns) ? j : null
  } catch {
    return null
  }
}

const fileOf = (sdkSessionId) => join(DIR, `${String(sdkSessionId).replace(/[^\w-]/g, '')}.json`)
export function loadBrief(sdkSessionId) {
  if (!sdkSessionId) return null
  try {
    return JSON.parse(readFileSync(fileOf(sdkSessionId), 'utf8'))
  } catch {
    return null
  }
}
function saveBrief(sdkSessionId, brief) {
  try {
    mkdirSync(DIR, { recursive: true, mode: 0o700 })
    const f = fileOf(sdkSessionId)
    writeFileSync(`${f}.tmp`, JSON.stringify(brief), { mode: 0o600 })
    renameSync(`${f}.tmp`, f)
  } catch {}
}

/** one at a time across every chat: a host coming back with many chats must not start a crowd */
let chain = Promise.resolve()

/**
 * Called when a turn ends (and when a chat comes back). Waits for the chat to settle, then brings
 * its brief up to date if the number of prompts changed since the last one.
 */
export function briefSoon(s, env) {
  if (s.account?.demo || process.env.LAIKA_BRIEFS === '0') return
  clearTimeout(s.briefTimer)
  s.briefTimer = setTimeout(() => {
    chain = chain.then(() => refresh(s, env).catch((e) => console.log(`brief failed: ${e?.message ?? e}`)))
  }, SETTLE_MS)
  s.briefTimer.unref?.()
}

async function refresh(s, env) {
  if (s.state === 'closed' || s.state === 'running' || s.state === 'starting' || !s.sdkSessionId) return
  const turns = turnsOf(s.events).filter((t) => t.prompt.trim() || t.images)
  if (!turns.length) return
  // it is idle: the latest turn has ended even if a replayed transcript never said so
  const latest = turns.at(-1)
  if (latest.end === 'open' && latest.answer) latest.end = 'done'
  const last = s.brief ?? loadBrief(s.sdkSessionId)
  const ends = turns.map((t) => t.end).join()
  // compared by the latest prompt and how it ended, not by counts: a restarted host replays only
  // the tail of a transcript, so its count differs while nothing new has happened
  const tail = `${promptKey(latest.prompt)}|${latest.end}`
  if (last && last.tail === tail) {
    if (!s.brief) publish(s, last)
    return
  }
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 90_000)
  let out = null
  try {
    const q = query({
      prompt: `Repo: ${s.repo}\n\n${digest(turns, last)}`,
      options: {
        cwd: tmpdir(),
        model: MODEL,
        // the answer comes back through a structured-output tool call: one turn to call it, one to end
        maxTurns: 3,
        outputFormat: { type: 'json_schema', schema: SCHEMA },
        // a label is not a puzzle: thinking made each brief take a minute
        thinking: { type: 'disabled' },
        tools: [],
        settingSources: [],
        persistSession: false,
        systemPrompt: SYSTEM,
        abortController: abort,
        env: env(s.account.configDir),
      },
    })
    for await (const m of q) {
      if (m.type !== 'result') continue
      if (m.subtype === 'success') out = m.structured_output ?? parse(m.result)
      else console.log(`brief for ${s.repo}: ${m.subtype}`)
    }
  } finally {
    clearTimeout(timer)
  }
  const j = out && typeof out.goal === 'string' && Array.isArray(out.turns) ? out : null
  if (!j) return
  const skipped = Math.max(0, turns.length - MAX_TURNS)
  const labels = new Map(j.turns.map((x) => [Number(x.i), x]))
  const brief = {
    goal: clip(j.goal, 120),
    now: clip(j.now, 160),
    next: clip(j.next, 120),
    // earlier labels survive a chat that grew past what one brief reads
    turns: turns.map((t, i) => {
      const x = labels.get(i)
      const old = last?.turns?.find((o) => o.p === promptKey(t.prompt))
      return {
        p: promptKey(t.prompt),
        label: x ? clip(x.label, 60) : (old?.label ?? ''),
        status: x && ['done', 'partial', 'blocked', 'open'].includes(x.status) ? x.status : (old?.status ?? ''),
      }
    }),
    count: turns.length,
    ends,
    tail,
    skipped,
    at: Date.now(),
  }
  saveBrief(s.sdkSessionId, brief)
  publish(s, brief)
}

function publish(s, brief) {
  if (s.state === 'closed') return
  s.brief = brief
  const { updatedAt } = s
  // only the latest brief is worth replaying: older ones would pile up in every chat's history
  for (let i = s.events.length - 1; i >= 0; i--) if (s.events[i].t === 'brief') s.events.splice(i, 1)
  s.emit({ t: 'brief', ...brief })
  // a brief is not activity: an idle chat must still look idle to the tidy-up
  s.updatedAt = updatedAt
}
