/**
 * Claude workspaces: one tab per repo, in the repo's colour, holding everything you would keep
 * an editor window open for: Claude chats (one, or two side by side), the repo's files, its
 * changes (diff, revert, commit) and a terminal.
 *
 * Each chat reads like the Claude Code VS Code extension:
 *   chat       your messages, Claude's replies, tool calls as one-line rows that expand,
 *              approvals and questions inline with numbered choices
 *   tasks      Claude's todo list, folded above the input
 *   input      the prompt, with mode ▾ · @ · / · attach · send in its toolbar
 *
 * Sessions run in agent-host.mjs (via /api/control/agent/*) on the Claude Agent SDK, so this is
 * Claude Code itself: same tools, CLAUDE.md, settings and permission rules. The page only
 * renders the host's event stream; reloading loses nothing.
 */
import './sessions.css'
import './conductor.css'
import './session-groups.css'
import './chat-tint.css'
import './chat-groups.css'
import { collapsedGroups, groupRuns, knownGroups, tidyGroup } from './chat-groups.ts'
import { mountCockpit } from './cockpit.ts'
import { attachChatMentions, routeFromConductor } from './cockpit-route.ts'
import { diffHtml } from './diff.ts'
import { createFleetBoard } from './fleet-board.ts'
import { type PanelHandle, type Region, registerPanel, registerRegions } from './panels.ts'

/** the rail glyph for the fleet board: rows, each with its status dot */
const FLEET_ICON =
  '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="4.4" cy="5" r="1.3" fill="currentColor"/><circle cx="4.4" cy="10" r="1.3" fill="currentColor"/><circle cx="4.4" cy="15" r="1.3" fill="currentColor"/><path d="M8 5h8.4M8 10h8.4M8 15h5.4"/></svg>'

import * as presence from './activity.ts'
import {
  type BgTask,
  bgShort,
  bgTip,
  disposeRunStrip,
  FLEET_COMMANDS,
  openBroadcast,
  paintBackground,
  paintRunStrip,
} from './fleet-ui.ts'
import { createMissionPane, type MissionPane, missionRoots } from './mission.ts'
import { canPop, POP_ICON, POP_IN_ICON, popOut, watchPop } from './popout.ts'
import { highlight, renderMarkdown } from './quicklook.ts'
import { type ChangesView, createChangesView } from './session-changes.ts'
import { createFilesView, type FilesView } from './session-files.ts'
import { createTerminalPanel, type TerminalPanel } from './session-terminal.ts'
import { attachVoice } from './voice.ts'

type Mode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const effortLabel = (e: Effort) =>
  ({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' })[e]
type Summary = {
  id: string
  sdkSessionId: string | null
  cwd: string
  repo: string
  account: string
  accountLabel: string
  mode: Mode
  model: string | null
  title: string
  state: 'starting' | 'running' | 'waiting' | 'idle' | 'closed' | 'error'
  waiting: ('question' | 'permission' | 'secret')[]
  createdAt: number
  updatedAt: number
  cost: number
  turns: number
  /** set when this conversation is also open outside this host (an editor, the other app) */
  elsewhere?: string | null
  work?: Work
  /** a conductor leads the other chats toward its goal (conductor.mjs) */
  role?: 'conductor' | null
  autopilot?: boolean
  /** when away mode ends; null means until switched off */
  autopilotUntil?: number | null
  goal?: string
  /** opened by this conductor's fleet_spawn */
  spawnedBy?: string | null
  /** the conductor's label for a set of chats (fleet_rename), e.g. "Orbit"; null when ungrouped */
  group?: string | null
}
type Suggestion = { chat: string; repo: string; title: string; text: string; why: string }
/** away mode, as the host keeps it (away.mjs) */
type AwayState = {
  on: boolean
  until: number | null
  startedAt: number | null
  endedAt: number | null
  reason: 'back' | 'expired' | null
  goal: string
  conductorId: string | null
  counts: { approved: number; asked: number; recovered: number }
  summary: string | null
  /** chats a conductor parked (fleet_park): closed, resumable with POST /parked/<id>/resume */
  parked?: { id: string; repo: string; title: string; reason: string; parkedAt: number }[]
}
const FROM_CONDUCTOR = '[from the conductor] '
/** whether the conductor's cockpit is folded, and its height */
const DECK_KEY = 'laika.cockpit.deck'
/** the turn in progress: when it began, output tokens so far, what Claude is doing */
type Work = {
  start: number
  tokens: number
  phase: 'thinking' | 'writing' | 'tool' | null
  /** background tasks and live-progress boards, each with a rough ETA (fleet-work.mjs) */
  bg?: BgTask[]
}
type Ev = { seq: number; at: number; t: string } & Record<string, unknown>
type Account = {
  id: string
  label: string
  demo: boolean
  /** null until Claude Code has been asked */
  loggedIn: boolean | null
  email: string | null
  plan: string | null
  configDir: string
}
type Repo = { path: string; name: string; branch: string | null; lastCommit: string | null }
/** a folder under ~/dev holding several repos; its workspace works across all of them */
type Project = { path: string; name: string; repos: string[] }
type Elsewhere = {
  id: string
  /** the account whose folder holds this transcript; null if not one this app knows */
  account: string | null
  repo: string
  repoPath: string | null
  cwd: string | null
  title: string
  state: string
  updated: string
  branch: string | null
}
type Question = {
  question: string
  header: string
  multiSelect?: boolean
  options: { label: string; description: string; preview?: string }[]
}
type Todo = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}
type Pasted = { mediaType: string; data: string; thumb: string; name: string }

const API = '/api/control/agent'
/** Claude Code's working spinner: the glyph breathes out and back */
const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢', '·']
// biome-ignore format: seventy words read better as a block than as seventy lines
const VERBS = [
  'Accomplishing', 'Actualizing', 'Baking', 'Brewing', 'Calculating', 'Cerebrating', 'Churning',
  'Clauding', 'Coalescing', 'Cogitating', 'Computing', 'Conjuring', 'Considering', 'Cooking',
  'Crafting', 'Creating', 'Crunching', 'Deliberating', 'Determining', 'Discombobulating', 'Doing',
  'Effecting', 'Elucidating', 'Enchanting', 'Envisioning', 'Finagling', 'Forging', 'Forming',
  'Generating', 'Hatching', 'Herding', 'Honking', 'Hustling', 'Ideating', 'Imagining',
  'Incubating', 'Inferring', 'Manifesting', 'Marinating', 'Moseying', 'Mulling', 'Mustering',
  'Musing', 'Noodling', 'Percolating', 'Pondering', 'Processing', 'Puttering', 'Reticulating',
  'Ruminating', 'Schlepping', 'Shucking', 'Simmering', 'Smooshing', 'Spelunking', 'Spinning',
  'Stewing', 'Synthesizing', 'Thinking', 'Tinkering', 'Transmuting', 'Unfurling', 'Vibing',
  'Wandering', 'Whirring', 'Wibbling', 'Wizarding', 'Working', 'Wrangling',
]
const pickVerb = (not: string) => {
  const pool = VERBS.filter((x) => x !== not)
  return pool[Math.floor(Math.random() * pool.length)] as string
}
const WRITE = { 'x-control': '1', 'content-type': 'application/json' }
// the same four modes as the Claude Code extension, in its words
const MODES: { id: Mode; label: string; hint: string; icon: string }[] = [
  {
    id: 'default',
    label: 'Manual',
    hint: 'Claude will ask for approval before making each edit',
    icon: '<path d="M7 11V5.5a1.5 1.5 0 0 1 3 0V10m0-5.5v-1a1.5 1.5 0 0 1 3 0V10m0-4a1.5 1.5 0 0 1 3 0v4m0-2a1.5 1.5 0 0 1 3 0v5.5A6.5 6.5 0 0 1 12.5 21H11a6 6 0 0 1-5.4-3.4L3.3 12a1.5 1.5 0 0 1 2.6-1.5L7 12.5"/>',
  },
  {
    id: 'acceptEdits',
    label: 'Edit automatically',
    hint: 'Claude will edit your selected text or the whole file',
    icon: '<path d="m8 8-4 4 4 4m8-8 4 4-4 4m-2.5-11-3 14"/>',
  },
  {
    id: 'plan',
    label: 'Plan',
    hint: 'Claude will explore the code and present a plan before editing',
    icon: '<path d="M8 4h9a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8m0-16v16m0-16H6a1 1 0 0 0-1 1v2m3 13H6a1 1 0 0 1-1-1v-2m6-9h4m-4 4h4m-4 4h2"/>',
  },
  {
    id: 'auto',
    label: 'Auto',
    hint: 'Claude will approve actions that pass a safety check and pause for anything risky',
    icon: '<path d="M13 3 5 13.5h6L10.5 21 19 10.5h-6z"/>',
  },
]
const modeIcon = (m: Mode) =>
  `<svg class="mi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MODES.find((x) => x.id === m)?.icon ?? ''}</svg>`
const modeLabel = (m: Mode) => MODES.find((x) => x.id === m)?.label ?? m
/** the models offered in the picker; '' is Claude Code's own default */
const MODELS: { id: string; label: string; hint: string }[] = [
  { id: '', label: 'Default', hint: "Claude Code's default for this account" },
  { id: 'opus', label: 'Opus', hint: 'Most capable: hard problems, big refactors' },
  { id: 'sonnet', label: 'Sonnet', hint: 'Fast and capable: everyday coding' },
  { id: 'haiku', label: 'Haiku', hint: 'Fastest and cheapest: small, clear tasks' },
]
const modelLabel = (id: string | null) => {
  const m = MODELS.find((x) => x.id === (id ?? ''))
  if (m) return m.label
  const raw = String(id ?? '')
  const known = /opus|sonnet|haiku|fable/i.exec(raw)?.[0]
  return known
    ? known[0]?.toUpperCase() + known.slice(1).toLowerCase()
    : raw.replace(/^claude-/, '')
}

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[<>&"']/g,
    (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[m] as string,
  )
const short = (p: string) => p.split('/').pop() ?? p
const ago = (t: number | string) => {
  const m = Math.round((Date.now() - (typeof t === 'number' ? t : Date.parse(t))) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  return m < 60 * 36 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}
// a write that hangs fails visibly instead of leaving the chat looking frozen
const post = (path: string, body?: unknown) =>
  fetch(`${API}${path}`, {
    method: 'POST',
    headers: WRITE,
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20_000),
  })
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html !== undefined) e.innerHTML = html
  return e
}

// ---------------------------------------------------------------- tool rows ----
const TOOL_VERB: Record<string, string> = {
  Edit: 'Edit',
  MultiEdit: 'Edit',
  Write: 'Write',
  Bash: 'Bash',
  Read: 'Read',
  Grep: 'Search',
  Glob: 'Find',
  WebFetch: 'Fetch',
  WebSearch: 'Web search',
  Task: 'Agent',
  Agent: 'Agent',
  NotebookEdit: 'Edit notebook',
  ExitPlanMode: 'Plan',
  TodoWrite: 'Tasks',
  SendMessage: 'Message',
  ToolSearch: 'Find tool',
  Skill: 'Skill',
  AskUserQuestion: 'Question',
  ListAgents: 'Agents',
}
/** a readable label for any tool, including MCP ones (mcp__server__tool → tool, server) */
function toolLabel(name: string): string {
  if (TOOL_VERB[name]) return TOOL_VERB[name] as string
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name)
  if (mcp) return (mcp[2] ?? name).replace(/_/g, ' ')
  return name.replace(/([a-z])([A-Z])/g, '$1 $2')
}

/** a Bash command as a short line: drop the cd prefix and tmp paths, keep the first real command */
function commandGist(cmd: string): string {
  let c = cmd.replace(/\s+/g, ' ').trim()
  // `P=$(lsof …)` names the interesting command inside the subshell
  c = c.replace(/^[A-Z_]+=\$\(([^)]*)\)\s*(&&|;)?\s*/, '$1; ')
  // drop leading `cd …;` hops and scratch-variable assignments; they say where, not what
  c = c.replace(/^((cd\s+("[^"]*"|'[^']*'|\S+)|[A-Z_]+=\S+)\s*(&&|;)?\s*)+/, '')
  c = c.replace(/\/private\/tmp\/[^\s"']*/g, 'tmp').replace(/\/Users\/[^/\s"']+/g, '~')
  // a heredoc script is "python3 script" or "cat > file", never the script's first line
  c = c.replace(/\s*-?\s*<<\s*'?\w+'?.*$/, ' (script)')
  // a long quoted echo/printf is noise: keep the verb
  c = c.replace(/^(echo|printf)\s+.{40,}$/, '$1 …')
  const first = c.split(/\s*(?:&&|;|\|\|)\s*/)[0] ?? c
  return first.length > 80 ? `${first.slice(0, 79)}…` : first
}

function toolTitle(name: string, input: Record<string, unknown>, cwd: string): string {
  const rel = (p: unknown) => String(p ?? '').replace(`${cwd}/`, '')
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return String(input.file_path ?? input.notebook_path ?? '')
        .split('/')
        .pop() as string
    case 'Bash':
      return String(input.description ?? '') || commandGist(String(input.command ?? ''))
    case 'SendMessage':
      return String(input.summary ?? input.to ?? '')
    case 'ToolSearch':
      return String(input.query ?? '')
    case 'Skill':
      return String(input.skill ?? '')
    case 'Grep':
      return `"${input.pattern ?? ''}"${input.path ? ` in ${rel(input.path)}` : ''}`
    case 'Glob':
      return String(input.pattern ?? '')
    case 'WebFetch':
      return String(input.url ?? '')
    case 'WebSearch':
      return String(input.query ?? '')
    case 'Task':
    case 'Agent':
      return String(input.description ?? '')
    default:
      return ''
  }
}

/** what a tool does, shown when its row is expanded and in an approval */
function toolBody(name: string, input: Record<string, unknown>): string {
  const path = String(input.file_path ?? '')
  switch (name) {
    case 'Edit':
      return diffHtml(String(input.old_string ?? ''), String(input.new_string ?? ''), path)
    case 'MultiEdit':
      return ((input.edits as { old_string: string; new_string: string }[]) ?? [])
        .map((e) => diffHtml(e.old_string, e.new_string, path, 120))
        .join('')
    case 'Write':
      return diffHtml('', String(input.content ?? ''), path, 160)
    case 'Bash':
      return `<pre class="m-cmd"><b>$</b> ${highlight(String(input.command ?? ''), 'sh')}</pre>`
    case 'ExitPlanMode':
      return `<div class="ss-md m-plan">${renderMarkdown(String(input.plan ?? ''))}</div>`
    case 'Task':
    case 'Agent':
      return input.prompt
        ? `<div class="ss-md m-sub">${renderMarkdown(String(input.prompt))}</div>`
        : ''
    case 'Read':
    case 'Grep':
    case 'Glob':
    case 'WebFetch':
    case 'WebSearch':
      return ''
    default:
      return `<pre class="m-json">${esc(JSON.stringify(input, null, 2))}</pre>`
  }
}

/**
 * As in Claude Code's desktop app: a command shows its IN and OUT (a few lines each, click for
 * all), an edit its diff (height-limited), a plan in full; reads and searches stay one line.
 */
const OPEN_BY_DEFAULT = new Set(['Bash', 'Edit', 'MultiEdit', 'Write', 'ExitPlanMode'])
/** tools that start a sub-agent; its own steps arrive tagged with this tool call's id */
const AGENT_TOOLS = new Set(['Task', 'Agent'])
const PINS_KEY = 'laika.pins'
/** a stable key for a prompt's text, so a pin finds its message again after a reload */
const textKey = (t: string) => {
  let h = 5381
  for (let i = 0; i < Math.min(t.length, 400); i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0
  return h.toString(36)
}
const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
/** the track's panel stays open beside every chat */
const TRACK_DOCK_KEY = 'laika.track.docked'
/** the host labels a prompt by its opening words (promptKey in chat-brief.mjs): the same here */
const promptKey = (t: string) => {
  const s = t.replace(/\s+/g, ' ').trim()
  return s.length > 60 ? `${s.slice(0, 60)}…` : s
}
/** the host's reading of a chat, from a small model after each turn (chat-brief.mjs) */
type Brief = {
  goal: string
  now: string
  next: string
  turns: { p: string; label: string; status: string }[]
  at: number
}

// --------------------------------------------------------------------- images ----
/** Pasted or dropped image → base64 at full quality where the API allows it, plus a thumbnail. */
// the Messages API takes an image up to 8000px a side and 5MB base64; within that, send it as is
const IMG_MAX_SIDE = 8000
const IMG_MAX_B64 = 4_900_000

/** the file's own bytes as base64: no re-encode, so nothing is lost */
const base64Of = (file: Blob) =>
  new Promise<string>((ok, fail) => {
    const r = new FileReader()
    r.onload = () => ok(String(r.result).slice(String(r.result).indexOf(',') + 1))
    r.onerror = () => fail(r.error)
    r.readAsDataURL(file)
  })

/**
 * Draw an image at most `max` px on its long side. Large reductions go down in halving steps
 * with high-quality smoothing: one big jump drops detail and makes small text shimmer.
 */
function drawImage(img: HTMLImageElement, max: number, type: string, q?: number) {
  const w = img.naturalWidth
  const h = img.naturalHeight
  const k = Math.min(1, max / Math.max(w, h))
  const tw = Math.max(1, Math.round(w * k))
  const th = Math.max(1, Math.round(h * k))
  const canvas = (cw: number, ch: number) => {
    const c = document.createElement('canvas')
    c.width = cw
    c.height = ch
    const ctx = c.getContext('2d') as CanvasRenderingContext2D
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    return { c, ctx }
  }
  let src: CanvasImageSource = img
  let sw = w
  let sh = h
  while (sw / 2 >= tw * 1.05) {
    const step = canvas(Math.round(sw / 2), Math.round(sh / 2))
    step.ctx.drawImage(src, 0, 0, step.c.width, step.c.height)
    src = step.c
    sw = step.c.width
    sh = step.c.height
  }
  const out = canvas(tw, th)
  // JPEG has no transparency: a see-through screenshot goes on white, not black
  if (type === 'image/jpeg') {
    out.ctx.fillStyle = '#fff'
    out.ctx.fillRect(0, 0, tw, th)
  }
  out.ctx.drawImage(src, 0, 0, tw, th)
  const url = out.c.toDataURL(type, q)
  return url.slice(url.indexOf(',') + 1)
}

async function readImage(file: File): Promise<Pasted | null> {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return null
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const name = file.name || 'pasted image'
    const thumb = `data:image/jpeg;base64,${drawImage(img, 320, 'image/jpeg', 0.85)}`
    // full resolution, the original bytes, whenever the API will take them
    if (Math.max(img.naturalWidth, img.naturalHeight) <= IMG_MAX_SIDE) {
      const data = await base64Of(file)
      if (data.length <= IMG_MAX_B64) return { mediaType: file.type, data, thumb, name }
    }
    // too big: shrink in steps until it fits; screenshots stay PNG (crisp text) as long as they can
    const lossless = file.type === 'image/png' || file.type === 'image/gif'
    let side = Math.min(Math.max(img.naturalWidth, img.naturalHeight), IMG_MAX_SIDE)
    for (let i = 0; i < 10; i++) {
      if (lossless) {
        const data = drawImage(img, side, 'image/png')
        if (data.length <= IMG_MAX_B64) return { mediaType: 'image/png', data, thumb, name }
      }
      const data = drawImage(img, side, 'image/jpeg', 0.93)
      if (data.length <= IMG_MAX_B64) return { mediaType: 'image/jpeg', data, thumb, name }
      side = Math.round(side * 0.82)
    }
    return null
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

// ------------------------------------------------------------------ composer ----
type Composer = {
  el: HTMLElement
  input: HTMLTextAreaElement
  images: Pasted[]
  setBusy(on: boolean): void
  setMode(m: Mode): void
  setModel(id: string | null): void
  setChips(html: string): void
  focus(): void
}

// what you sent from any chat, newest last, so ↑ in a fresh chat still finds your last prompt
const SENT_KEY = 'laika.sent'
let sentEverywhere: string[] = []
try {
  const got = JSON.parse(localStorage.getItem(SENT_KEY) ?? '[]')
  if (Array.isArray(got)) sentEverywhere = got.filter((x) => typeof x === 'string')
} catch {}
function rememberSent(text: string) {
  sentEverywhere = [...sentEverywhere.filter((x) => x !== text), text].slice(-100)
  try {
    localStorage.setItem(SENT_KEY, JSON.stringify(sentEverywhere))
  } catch {}
}

/**
 * The prompt box, shared by a new chat and a running session. Enter sends, ⇧Enter is a new
 * line, ⇧Tab cycles the mode as it does in the CLI; images paste, drop or attach. ↑ on the
 * first line walks back through what you sent (this chat's first, then your other chats),
 * ↓ on the last line walks forward and back to what you were typing.
 */
function makeComposer(o: {
  placeholder: string
  mode: Mode
  onSend: (text: string, images: Pasted[]) => void
  onStop?: () => void
  onMode: (m: Mode) => void
  onMenu: (kind: 'mode' | 'model' | 'slash' | 'at', anchor: HTMLElement) => void
  model?: string | null
  /** this chat's own sent messages, oldest first */
  sent?: () => string[]
}): Composer {
  const box = el(
    'div',
    'cx',
    `<div class="cx-thumbs"></div>
    <textarea rows="1" placeholder="${esc(o.placeholder)}" aria-label="Message Claude"></textarea>
    <div class="cx-bar">
      <button type="button" class="cx-mode" data-cx="mode" title="How much Claude may do without asking (⇧Tab)"></button>
      <button type="button" class="cx-mode cx-model" data-cx="model" title="Model"></button>
      <button type="button" class="cx-ic" data-cx="at" title="Mention a file (@)">@</button>
      <button type="button" class="cx-ic" data-cx="slash" title="Commands (/)">/</button>
      <label class="cx-ic" title="Attach images"><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden />
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M10.5 5.5 6.2 9.8a1.3 1.3 0 0 0 1.8 1.8l4.6-4.6a2.6 2.6 0 0 0-3.7-3.7L4.3 8a3.9 3.9 0 0 0 5.5 5.5l3.4-3.4"/></svg>
      </label>
      <span class="cx-chips"></span>
      <button type="button" class="cx-send" data-cx="send" title="Send (↵)" aria-label="Send" disabled>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 2.5 13 7.4l-1 1-3.3-3.2V13.5H7.3V5.2L4 8.4l-1-1z"/></svg>
      </button>
    </div>`,
  )
  const input = box.querySelector('textarea') as HTMLTextAreaElement
  const thumbs = box.querySelector('.cx-thumbs') as HTMLElement
  const send = box.querySelector('[data-cx="send"]') as HTMLButtonElement
  const modeBtn = box.querySelector('[data-cx="mode"]') as HTMLButtonElement
  const images: Pasted[] = []
  let busy = false
  let mode = o.mode

  const sync = () => {
    input.placeholder =
      busy && !o.placeholder.startsWith('Ask') ? 'Queue another message…' : o.placeholder
    input.style.height = 'auto'
    input.style.height = `${Math.min(260, input.scrollHeight)}px`
    const empty = !input.value.trim() && !images.length
    send.disabled = busy ? false : empty
    send.classList.toggle('stop', busy && empty)
    send.title = busy && empty ? 'Stop Claude' : 'Send (↵)'
  }
  const paintThumbs = () => {
    thumbs.innerHTML = images
      .map(
        (im, i) =>
          `<span class="cx-thumb"><img src="${im.thumb}" alt="${esc(im.name)}" /><button type="button" data-drop="${i}" aria-label="Remove image">×</button></span>`,
      )
      .join('')
    sync()
  }
  const addFiles = async (files: File[]) => {
    for (const f of files) {
      const im = await readImage(f)
      if (im) images.push(im)
    }
    paintThumbs()
  }
  const setMode = (m: Mode) => {
    mode = m
    modeBtn.innerHTML = `${modeIcon(m)}${esc(modeLabel(m))}<span>▾</span>`
  }
  const modelBtn = box.querySelector('[data-cx="model"]') as HTMLButtonElement
  const setModel = (id: string | null) => {
    modelBtn.innerHTML = `<i class="mdl"></i>${esc(modelLabel(id))}<span>▾</span>`
    modelBtn.title = `Model: ${modelLabel(id)}`
  }
  setModel(o.model ?? null)
  // ↑/↓ history: -1 is the draft you were typing, 0 the newest sent message
  let recall = -1
  let draft = ''
  const past = () => {
    const mine = (o.sent?.() ?? []).filter(Boolean).reverse()
    const rest = sentEverywhere.filter((x) => !mine.includes(x)).reverse()
    return [...mine, ...rest]
  }
  const recallTo = (i: number, up: boolean) => {
    const list = past()
    if (i >= list.length) return false
    if (recall === -1) draft = input.value
    recall = i
    input.value = i === -1 ? draft : (list[i] as string)
    sync()
    // up lands at the start so another ↑ keeps going; down lands at the end for the same reason
    const at = up ? 0 : input.value.length
    input.setSelectionRange(at, at)
    return true
  }
  const submit = () => {
    const text = input.value.trim()
    if (busy && !text && !images.length) return o.onStop?.()
    if (!text && !images.length) return
    // clear first: onSend may put the text back (a new chat that still needs its repo)
    const sent = images.splice(0)
    if (text) rememberSent(text)
    recall = -1
    draft = ''
    input.value = ''
    paintThumbs()
    o.onSend(text, sent)
    sync()
  }

  input.addEventListener('input', () => {
    sync()
    const v = input.value
    if (v === '/') o.onMenu('slash', input)
    else if (v.endsWith(' @') || v === '@') o.onMenu('at', input)
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      submit()
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      const i = MODES.findIndex((x) => x.id === mode)
      const next = (MODES[(i + 1) % MODES.length] as (typeof MODES)[number]).id
      setMode(next)
      o.onMode(next)
    } else if (
      (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
      !e.shiftKey &&
      !e.altKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.isComposing &&
      input.selectionStart === input.selectionEnd
    ) {
      const caret = input.selectionStart
      const up = e.key === 'ArrowUp'
      // only from the first or last line, so ↑/↓ still move through a message you are writing
      const edge = up
        ? !input.value.slice(0, caret).includes('\n')
        : !input.value.slice(caret).includes('\n')
      if (!edge || (!up && recall === -1)) return
      if (recallTo(up ? recall + 1 : recall - 1, up)) e.preventDefault()
    }
  })
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
    if (!files.length) return
    e.preventDefault()
    addFiles(files)
  })
  box.addEventListener('dragover', (e) => {
    e.preventDefault()
    box.classList.add('drop')
  })
  box.addEventListener('dragleave', () => box.classList.remove('drop'))
  box.addEventListener('drop', (e) => {
    e.preventDefault()
    box.classList.remove('drop')
    addFiles([...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/')))
  })
  ;(box.querySelector('input[type="file"]') as HTMLInputElement).addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement
    addFiles([...(t.files ?? [])])
    t.value = ''
  })
  box.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    const drop = t.closest<HTMLElement>('[data-drop]')?.dataset.drop
    if (drop !== undefined) {
      images.splice(Number(drop), 1)
      return paintThumbs()
    }
    const act = t.closest<HTMLElement>('[data-cx]')?.dataset.cx
    if (act === 'send') submit()
    if (act === 'mode') o.onMenu('mode', modeBtn)
    if (act === 'model') o.onMenu('model', modelBtn)
    if (act === 'at' || act === 'slash') {
      const ch = act === 'at' ? '@' : '/'
      input.value =
        act === 'slash' && !input.value
          ? '/'
          : `${input.value}${input.value && !input.value.endsWith(' ') ? ' ' : ''}${ch}`
      input.focus()
      o.onMenu(act, input)
      sync()
    }
    if (t === box || t.closest('.cx-thumbs')) input.focus()
  })
  attachVoice({ box, input, submit, sync })
  setMode(mode)
  sync()
  return {
    el: box,
    input,
    images,
    setBusy(on: boolean) {
      busy = on
      sync()
    },
    setMode,
    setModel,
    setChips(html: string) {
      ;(box.querySelector('.cx-chips') as HTMLElement).innerHTML = html
    },
    focus: () => input.focus(),
  }
}

// ------------------------------------------------------------------ the panel ----
type View = {
  s: Summary
  root: HTMLElement
  /** a conductor's cockpit and @ list (cockpit.ts): let go when the chat ends */
  cockpit?: () => void
  log: HTMLElement
  tasks: HTMLElement
  composer: Composer
  es: EventSource | null
  lastSeq: number
  live: HTMLElement | null
  liveText: string
  rows: Map<string, HTMLElement>
  stick: boolean
  /** events waiting to be drawn, a few milliseconds' worth at a time */
  queue: Ev[]
  draining: boolean
  /** replaying the conversation so far: drawn out of sight, shown once, at the bottom */
  replay: boolean
  replayStart: number
  replayTimer: ReturnType<typeof setTimeout> | null
  stickQueued: boolean
  /** when you last used the wheel, a finger, the scrollbar or a scrolling key in this log */
  userAt: number
  /** when we last set scrollTop ourselves, so our own scroll never reads as yours */
  selfAt: number
  /** watches the log grow, so following the bottom never depends on counting frames */
  grow: MutationObserver | null
  /** watches the log's own box, so resizing the panel keeps the bottom in view */
  fit: ResizeObserver | null
  /** the latest thinking row, until the next event says how long it took */
  lastThink: { el: HTMLElement; at: number } | null
  /** away mode's latest refusal: the permission prompt that follows it gets its plain reason */
  lastAway: Ev | null
  /** Claude's latest text; if a step follows it, it was narration rather than the answer */
  lastText: HTMLElement | null
  /** which host run the events came from; a new one means the host restarted */
  epoch: string | null
  /** the track down the left edge: a point per prompt, pins, progress */
  track: HTMLElement
  trackQueued: boolean
  /** a redraw is owed, not just a scroll: prompts, pins, tasks or the brief changed */
  trackDirty: boolean
  /** each prompt's offsetTop and the log's size at the last redraw, so a scroll only moves the lit one */
  trackTops: number[]
  trackSize: string
  trackHere: number
  /** the prompt the latest steps belong to: its node on the track counts them */
  lastUser: HTMLElement | null
  /** what the chat is for, where it stands and a label per prompt */
  brief: Brief | null
  trackTimer: ReturnType<typeof setTimeout> | null
  /** events older than this are history being replayed, not live work */
  since: number
  commands: string[]
  todos: Todo[]
  tasksOpen: boolean
  /** the working line's word for this turn, and the token count it has counted up to */
  work: Work & { verb: string; shown: number; seen: number }
  /** on screen now (presence.watch): a chat nobody can see queues its events and draws nothing */
  shown: boolean
  unwatch: (() => void) | null
  /** in the background, events are drawn once a second rather than as they come */
  awayTimer: ReturnType<typeof setTimeout> | null
  /** off screen long enough, the view gives its log back (see release) */
  releaseTimer: ReturnType<typeof setTimeout> | null
}

/** a VS Code-style editor group: a tab bar and the chat it shows */
type Group = {
  /** stable across moves; drafts are kept by it */
  id: number
  /** chat ids in tab order, and 'new' for a chat not sent yet */
  tabs: string[]
  active: string
}
/**
 * One repo, one workspace: its Claude chats in up to three groups side by side, its files, its
 * changes and its terminal, under a tab in the repo's own colour.
 */
type Workspace = {
  path: string
  name: string
  colour: string
  el: HTMLElement
  cols: HTMLElement
  /** a project folder's repos; a plain repo lists itself */
  repos: string[]
  project: boolean
  /** where a new chat starts: the project folder or one of its repos */
  where: string
  /** every chat running in this workspace */
  chats: string[]
  groups: Group[]
  /** the tabs each group had when last saved: a chat that reappears goes back there */
  remembered: string[][]
  nextGroup: number
  /** the group you are in */
  focus: number
  /** relative widths of the groups (in a grid: of its two columns) */
  sizes: number[]
  /** four (or three) groups as a 2×2 grid instead of side by side */
  grid: boolean
  /** relative heights of the grid's two rows */
  rows: number[]
  pane: 'chats' | 'files' | 'changes' | 'build'
  /** Mission Control for the repos here that have a mission.config.mjs of their own */
  build: MissionPane | null
  term: TerminalPanel
  changes: ChangesView
  files: FilesView
  filesLoaded: boolean
  changeCount: number
  /** drafts by group id */
  drafts: Map<number, { el: HTMLElement; composer: Composer }>
  /** the tab being dragged */
  drag: string | null
  renaming: boolean
  built: boolean
}
type SavedWs = {
  groups: { tabs: string[]; active: string }[]
  sizes: number[]
  focus: number
  grid?: boolean
  rows?: number[]
}
/**
 * No cap on groups or project columns. Past what fits, a group keeps this much width (and, in a
 * grid, height) and the row scrolls: 200 is about what two groups get in the docked panel today.
 */
const MIN_GROUP_W = 200
const MIN_GROUP_H = 180
const FULL_KEY = 'laika.claudeFull'

// distinct, readable on the dark ground; a repo keeps its colour because it comes from its name
const PALETTE = [
  '#ff8a4c',
  '#56d8ff',
  '#3ddc97',
  '#c792ea',
  '#ffc94f',
  '#ff7eb6',
  '#7aa2ff',
  '#5ee0c1',
  '#f7a26c',
  '#b4e36b',
]
const colourOf = (name: string) => {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length] as string
}
// a colour you gave a repo tab wins over the one from its name, so two repos never have to match
const WS_COLOURS_KEY = 'laika.wsColours'
const wsColours = new Map<string, string>()
try {
  for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(WS_COLOURS_KEY) ?? '{}')))
    if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) wsColours.set(k, v)
} catch {}
const repoColour = (path: string, name: string) => wsColours.get(path) ?? colourOf(name)
function setRepoColour(path: string, hex: string | null) {
  if (hex) wsColours.set(path, hex)
  else wsColours.delete(path)
  try {
    localStorage.setItem(WS_COLOURS_KEY, JSON.stringify(Object.fromEntries(wsColours)))
  } catch {}
}
const LAYOUT_KEY = 'laika.workspaces'
const WS_KEY = 'laika.wsGroups'
const NAMES_KEY = 'laika.chatNames'
const COLOURS_KEY = 'laika.chatColours'
/** set once this browser has handed its names and colours to the chat library */
const MIGRATED_KEY = 'laika.chatLibraryMigrated'
const LIBRARY = '/api/control/library'
/** what the chat library keeps about a chat (chat-library.mjs) */
type LibEntry = { title?: string; pinned?: boolean; archived?: boolean; colour?: string }
/** a chat as the library lists it: every transcript on this machine, not only recent ones */
type LibItem = {
  id: string
  account: string | null
  project: string
  cwd: string | null
  branch: string | null
  autoTitle: string
  started: string
  updated: string
  repo: string
  repoPath: string | null
  title: string
  named: boolean
  pinned: boolean
  archived: boolean
  colour: string | null
  /** the host's chat id when it is open in this app */
  here: string | null
  /** set by a search inside messages: the words around the match */
  snippet?: { text: string; start: number; length: number }
}
const STATIC_KEY = 'laika.panelStatic'
const DOCK_KEY = 'laika.dockWidth'

const svg = (body: string, w = 14, h = 14, box = '0 0 16 16') =>
  `<svg viewBox="${box}" width="${w}" height="${h}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const ICON = {
  build: svg(
    '<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="2.4"/><path d="M8 1v2.4M8 12.6V15M1 8h2.4M12.6 8H15"/>',
    13,
    13,
  ),
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  list: svg('<path d="M3 4.5h10M3 8h10M3 11.5h6"/>'),
  chev: svg('<path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>', 11, 11),
  chat: svg(
    '<path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8l-3 2.2v-2.2H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"/>',
    13,
    13,
  ),
  file: svg('<path d="M4 2h5l3 3v9H4zM9 2v3h3"/>', 13, 13),
  diff: svg(
    '<circle cx="4.5" cy="4" r="1.6"/><circle cx="4.5" cy="12" r="1.6"/><circle cx="11.5" cy="6" r="1.6"/><path d="M4.5 5.6v4.8M11.5 7.6c0 2.4-2 3-5.4 3.6"/>',
    13,
    13,
  ),
  term: svg('<path d="m3 4.5 3.5 3.5L3 11.5M8.5 12h5"/>'),
  max: svg('<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9"/>', 12, 12),
  split: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M8 2.5v11"/>', 15, 15),
  quad: svg(
    '<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M8 2.5v11M1.5 8h13"/>',
    15,
    15,
  ),
  more: svg(
    '<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>',
  ),
  even: svg('<path d="M2 8h12M5 5 2 8l3 3M11 5l3 3-3 3"/>', 13, 13),
  past: svg('<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.8v2.6h2.6M8 5v3.2l2 1.3"/>', 13, 13),
  here: svg('<path d="M2.5 8h9M8 4.5 11.5 8 8 11.5M14 3v10"/>', 13, 13),
  pin: svg('<path d="M6 2.5h4l-.6 4 2.1 2.2H4.5L6.6 6.5zM8 8.7v4.8"/>', 12, 12),
  rename: svg('<path d="M10.5 2.8 13.2 5.5 6 12.7l-3.2.5.5-3.2zM9 4.3l2.7 2.7"/>', 12, 12),
  archive: svg(
    '<rect x="2" y="3" width="12" height="3" rx=".8"/><path d="M3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M6.5 8.8h3"/>',
    12,
    12,
  ),
  trash: svg('<path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 9h6.6l.7-9M6.8 7v4M9.2 7v4"/>', 12, 12),
}

/** `popped`: this is the panel in its own pop-out window (pop.html), not the dock */
export function createSessions(opts: { popped?: boolean } = {}) {
  const popped = !!opts.popped
  const root = el('div')
  root.id = 'ss'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', 'Claude workspaces')
  root.innerHTML = `
    <header class="ss-bar">
      <nav class="ws-tabs" data-el="tabs" aria-label="Repos"></nav>
      <button type="button" class="ss-ic" data-act="add" title="Open a repo" aria-label="Open a repo"><span class="ss-ic-t">＋</span></button>
      <span class="ss-bar-acts">
        <span class="ss-views" data-el="views" hidden>
          <span class="ws-seg" role="tablist" aria-label="View">
            <button type="button" role="tab" data-view="chats" title="Chats">${ICON.chat}<span>Chats</span></button>
            <button type="button" role="tab" data-view="files" title="Files">${ICON.file}<span>Files</span></button>
            <button type="button" role="tab" data-view="changes" title="Changes">${ICON.diff}<span>Changes</span><b data-el="nchg"></b></button>
            <button type="button" role="tab" data-view="build" title="Build: this repo's Mission Control" hidden>${ICON.build}<span>Build</span></button>
          </span>
          <button type="button" class="ss-ic" data-view="term" title="Terminal (⌃\`)" aria-label="Terminal">${ICON.term}</button>
          <i class="ss-vsep"></i>
        </span>
        <button type="button" class="ss-ic" data-act="fleet" title="Fleet board: every chat on one line (⌥⌘B)" aria-label="Fleet board">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M2.5 4h1M6 4h7.5M2.5 8h1M6 8h7.5M2.5 12h1M6 12h7.5"/></svg><b data-el="fleetn" hidden></b>
        </button>
        <button type="button" class="ss-ic bc-open" data-act="broadcast" title="Broadcast: one message to several chats (⌥⌘E)" aria-label="Broadcast to chats">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" d="M2.5 6.2h2.3L10 3v10L4.8 9.8H2.5z"/><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M12.3 6a2.6 2.6 0 0 1 0 4M5.2 9.8l.9 3.2"/></svg>
        </button>
        <button type="button" class="ss-away-btn" data-act="away" data-el="awaybtn" title="I’m away: keep the chats going (⌥⌘A)"><span class="aw-moon" aria-hidden="true">☾</span><span data-el="awaylbl">I’m away</span></button>
        <button type="button" class="ss-ic" data-act="accounts" title="Claude accounts" aria-label="Claude accounts">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="5.5" r="2.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M3 13.5c.6-2.4 2.6-3.6 5-3.6s4.4 1.2 5 3.6"/></svg><b class="ss-acct-warn" data-el="acctwarn" hidden>!</b>
        </button>
        <button type="button" class="ss-ic" data-act="history" title="Chat library: every Claude chat (⌥⌘O)" aria-label="Chat library">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.8v2.6h2.6M8 5v3.2l2 1.3"/></svg><span class="ss-caret">▾</span>
        </button>
        <button type="button" class="ss-ic" data-act="popout" data-el="popout" title="Pop out to its own window" aria-label="Pop out to its own window" hidden>${POP_ICON}</button>
        <button type="button" class="ss-ic" data-act="size" data-el="size" title="Full screen" aria-label="Full screen"><span class="ss-ic-t">⤢</span></button>
        <button type="button" class="ss-ic" data-act="close" title="Close (esc)" aria-label="Close"><span class="ss-ic-t">×</span></button>
      </span>
    </header>
    <div class="ss-away" data-el="away" role="status" hidden></div>
    <div class="ss-history" data-el="history" hidden></div>
    <div class="ss-pane" data-el="pane"></div>
    <div class="ss-grip" data-el="grip" title="Drag to resize · double-click for the default width"></div>`
  document.body.appendChild(root)
  const $ = (k: string) => root.querySelector(`[data-el="${k}"]`) as HTMLElement
  const pane = $('pane')
  if (popped) {
    // the window is the panel: closing it or putting the panel back is the way out
    const back = $('popout')
    back.hidden = false
    back.innerHTML = POP_IN_ICON
    back.title = 'Put back in the main window'
    back.setAttribute('aria-label', back.title)
    $('size').hidden = true
    ;(root.querySelector('[data-act="close"]') as HTMLElement).hidden = true
  } else if (canPop()) $('popout').hidden = false

  /**
   * Questions and notices inside the panel, not browser pop-ups: those are easy to miss and
   * Chrome can silence them, which made a click look like it did nothing.
   * Resolves true / the typed text when confirmed, false / null otherwise.
   */
  function ask(o: {
    title: string
    body?: string
    ok?: string
    cancel?: string | null
    input?: string
    danger?: boolean
  }) {
    return new Promise<boolean | string | null>((done) => {
      const box = el('div', 'ss-ask-dlg')
      box.setAttribute('role', 'alertdialog')
      box.innerHTML = `<div class="dlg">
        <b>${esc(o.title)}</b>
        ${o.body ? `<p>${esc(o.body)}</p>` : ''}
        ${o.input !== undefined ? `<input class="dlg-in" value="${esc(o.input)}" aria-label="${esc(o.title)}" />` : ''}
        <div class="dlg-acts">
          ${o.cancel === null ? '' : `<button type="button" class="ac-btn" data-dlg="no">${esc(o.cancel ?? 'Cancel')}</button>`}
          <button type="button" class="ac-btn ${o.danger ? 'danger-go' : 'go'}" data-dlg="yes">${esc(o.ok ?? 'OK')}</button>
        </div>
      </div>`
      const input = box.querySelector<HTMLInputElement>('.dlg-in')
      const finish = (yes: boolean) => {
        box.remove()
        done(input ? (yes ? input.value : null) : yes)
      }
      box.addEventListener('click', (e) => {
        const d = (e.target as HTMLElement).closest<HTMLElement>('[data-dlg]')?.dataset.dlg
        if (d) finish(d === 'yes')
        else if (e.target === box && o.cancel !== null) finish(false)
      })
      box.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Escape' && o.cancel !== null) finish(false)
        if (e.key === 'Enter') finish(true)
      })
      root.appendChild(box)
      ;(input ?? box.querySelector<HTMLElement>('[data-dlg="yes"]'))?.focus()
      input?.select()
    })
  }

  // ------------------------------------------------------------ away mode
  /**
   * "I'm away": one switch that puts the conductor on autopilot, lets the host approve the plainly
   * safe permission prompts and recover stuck chats, until the time is up or you are back. The
   * host keeps the state (away.mjs); the page shows it above every workspace.
   */
  let awayState: AwayState | null = null
  const AWAY_SEEN = 'laika.away.seen'
  const AWAY_HOURS = 'laika.away.hours'
  const awayLeft = (ms: number) => {
    const m = Math.max(0, Math.ceil(ms / 60_000))
    return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`
  }
  const awayClock = (t: number) =>
    new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  async function refreshAway() {
    const r = await fetch(`${API}/away`, { signal: AbortSignal.timeout(10_000) })
      .then((x) => (x.ok ? x.json() : null))
      .catch(() => null)
    if (r && typeof r.on === 'boolean') {
      awayState = r as AwayState
      paintAway()
    }
  }

  function paintAway() {
    const a = awayState
    const bar = $('away')
    const btn = $('awaybtn')
    const on = !!a?.on
    btn.classList.toggle('on', on)
    btn.setAttribute('aria-pressed', String(on))
    $('awaylbl').textContent =
      on && a?.until ? `Away · ${awayLeft(a.until - Date.now())}` : 'I’m away'
    btn.title = on
      ? 'Away mode is on: the chats keep going (⌥⌘A to come back)'
      : 'I’m away: keep the chats going (⌥⌘A)'
    if (!a) {
      bar.hidden = true
      return
    }
    const lead = a.conductorId ? summaryOf(a.conductorId) : undefined
    if (on) {
      bar.hidden = false
      bar.className = 'ss-away on'
      bar.innerHTML = `<span class="cd-pulse" aria-hidden="true"></span>
        <div class="aw-what"><b>Away${a.until ? ` · ${esc(awayLeft(a.until - Date.now()))} left` : ''}</b><span title="${esc(a.goal)}">${a.until ? `until ${esc(awayClock(a.until))} · ` : ''}${esc(a.goal)}</span></div>
        <span class="aw-acts"><button type="button" data-aw="allowed" title="What runs without you while away">Allowed</button>${lead ? '<button type="button" data-aw="lead">♛ Conductor</button>' : ''}<button type="button" class="aw-go" data-aw="back">I’m back</button></span>`
      return
    }
    let seen = ''
    try {
      seen = localStorage.getItem(AWAY_SEEN) ?? ''
    } catch {}
    // back: what happened, until you close it
    if (a.endedAt && String(a.endedAt) !== seen && Date.now() - a.endedAt < 12 * 3_600_000) {
      bar.hidden = false
      bar.className = 'ss-away back'
      bar.innerHTML = `<span class="aw-sun" aria-hidden="true">☀</span>
        <div class="aw-what"><b>${a.reason === 'expired' ? 'Away time is up' : 'Welcome back'}</b><span>${esc(a.summary ?? '')}</span></div>
        <span class="aw-acts">${lead ? '<button type="button" class="aw-go" data-aw="lead">♛ Read the summary</button>' : ''}${(
          a.parked ?? []
        )
          .slice(-3)
          .map(
            (p) =>
              `<button type="button" data-aw="unpark" data-id="${esc(p.id)}" title="${esc(`Parked: ${p.title || p.repo}${p.reason ? ` · ${p.reason}` : ''}`)}">Resume ${esc(p.repo)}</button>`,
          )
          .join(
            '',
          )}<button type="button" data-aw="seen" title="Dismiss" aria-label="Dismiss">×</button></span>`
      return
    }
    bar.hidden = true
  }

  /** the conductor chat away mode runs, where its summary lands */
  function openAwayLead() {
    const s = awayState?.conductorId ? summaryOf(awayState.conductorId) : undefined
    if (!s) return
    const ws = ensureWs(wsKey(s.cwd))
    setWs(ws.path)
    showChat(ws, s.id)
  }

  function awayDialog() {
    if (root.querySelector('.aw-dlg')) return
    let hours = 2
    try {
      hours = Number(localStorage.getItem(AWAY_HOURS)) || 2
    } catch {}
    const lead = summaries.find((s) => s.role === 'conductor')
    const box = el('div', 'ss-ask-dlg aw-dlg')
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-label', 'I’m away')
    const preset = [1, 2, 4, 8]
    box.innerHTML = `<div class="dlg">
      <b>☾ I’m away</b>
      <p>Your chats keep going without you. ${lead ? 'Your conductor' : 'A conductor chat'} leads them; reading, editing and running checks inside each repo are approved for you; stuck chats are restarted. Anything risky still waits for you. <button type="button" class="aw-link" data-aw-allowed>See what’s allowed</button></p>
      <div class="aw-durs" role="radiogroup" aria-label="For how long">
        ${preset.map((h) => `<button type="button" role="radio" data-h="${h}" aria-checked="${h === hours}">${h}h</button>`).join('')}
        <label class="aw-custom"><input class="dlg-in" data-aw-in="custom" type="number" min="0.25" max="24" step="0.25" value="${preset.includes(hours) ? '' : hours}" placeholder="Custom" aria-label="Custom hours" /><span>hours</span></label>
      </div>
      <input class="dlg-in" data-aw-in="goal" maxlength="2000" placeholder="${esc(lead?.goal ? `Goal: ${lead.goal}` : 'Goal (optional): keep every open chat moving on its current task')}" aria-label="Goal while you are away" />
      <p class="ss-err" hidden></p>
      <div class="dlg-acts">
        <button type="button" class="ac-btn" data-dlg="no">Cancel</button>
        <button type="button" class="ac-btn go" data-dlg="yes">Start away mode</button>
      </div>
    </div>`
    const custom = box.querySelector('[data-aw-in="custom"]') as HTMLInputElement
    const goal = box.querySelector('[data-aw-in="goal"]') as HTMLInputElement
    const err = box.querySelector('.ss-err') as HTMLElement
    const pick = (h: number | null) => {
      for (const b of box.querySelectorAll<HTMLElement>('[data-h]'))
        b.setAttribute('aria-checked', String(Number(b.dataset.h) === h))
    }
    if (!preset.includes(hours)) pick(null)
    custom.addEventListener('input', () => pick(custom.value ? null : 2))
    const go = async () => {
      const chosen = box.querySelector<HTMLElement>('[data-h][aria-checked="true"]')
      const h = custom.value ? Number(custom.value) : Number(chosen?.dataset.h ?? 2)
      if (!(h > 0 && h <= 24)) {
        err.hidden = false
        err.textContent = 'Choose between 15 minutes and 24 hours'
        return
      }
      const yes = box.querySelector('[data-dlg="yes"]') as HTMLButtonElement
      yes.disabled = true
      const ws = activeWs ? workspaces.get(activeWs) : undefined
      const r = await post('/away', {
        on: true,
        minutes: Math.round(h * 60),
        goal: goal.value.trim(),
        // a conductor is started here if there is none
        ...(ws ? { cwd: ws.where } : {}),
      }).catch(() => null)
      const body = await r?.json().catch(() => null)
      if (!r?.ok) {
        yes.disabled = false
        err.hidden = false
        err.textContent = body?.error ?? 'The Claude host did not answer'
        return
      }
      try {
        localStorage.setItem(AWAY_HOURS, String(h))
      } catch {}
      awayState = body as AwayState
      box.remove()
      await refresh()
      paintAway()
    }
    box.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      const h = t.closest<HTMLElement>('[data-h]')
      if (h) {
        custom.value = ''
        return pick(Number(h.dataset.h))
      }
      if (t.closest('[data-aw-allowed]')) return awayAllowed()
      const d = t.closest<HTMLElement>('[data-dlg]')?.dataset.dlg
      if (d === 'yes') go()
      else if (d === 'no' || e.target === box) box.remove()
    })
    box.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') box.remove()
      if (
        e.key === 'Enter' &&
        !(e.target as HTMLElement).closest('[data-dlg="no"],[data-aw-allowed]')
      )
        go()
    })
    root.appendChild(box)
    ;(box.querySelector('[data-h][aria-checked="true"]') as HTMLElement | null)?.focus()
  }

  /**
   * "Allowed while away": the shell patterns you always-allowed (each with a remove button), what
   * your policy file takes out, and the built-in defaults, read-only and folded away.
   */
  async function awayAllowed() {
    if (root.querySelector('.aw-allowed')) return
    type Lists = { read: string[]; write: string[]; bash: string[] }
    const box = el('div', 'ss-ask-dlg aw-allowed')
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-label', 'Allowed while away')
    const code = (x: string) => `<code>${esc(x)}</code>`
    const paint = (p: { defaults: Lists; additions: Lists; removed: Lists } | null, error = '') => {
      const added = p?.additions.bash ?? []
      const gone = p?.removed.bash ?? []
      const builtIn = (p?.defaults.bash ?? []).filter((x) => !gone.includes(x))
      box.innerHTML = `<div class="dlg">
        <b>☾ Allowed while away</b>
        <p>Shell commands that run without you while you are away, as the words they start with.</p>
        ${
          !p
            ? `<p class="ss-err">${esc(error || 'Loading…')}</p>`
            : `<h4>You allowed</h4>
        ${
          added.length
            ? `<ul class="aw-pats">${added.map((x) => `<li>${code(x)}<button type="button" data-aw-rm="${esc(x)}" title="Stop allowing this" aria-label="Stop allowing ${esc(x)}">×</button></li>`).join('')}</ul>`
            : '<p class="aw-none">Nothing yet: use “Always allow” on a permission away mode left for you.</p>'
        }
        ${gone.length ? `<h4>Built in, taken out by your policy file</h4><p class="aw-codes">${gone.map(code).join(' ')}</p>` : ''}
        <details class="aw-defaults"><summary>Built in (${p.defaults.bash.length})</summary><p class="aw-codes">${builtIn.map(code).join(' ')}</p></details>
        ${error ? `<p class="ss-err">${esc(error)}</p>` : ''}`
        }
        <div class="dlg-acts"><button type="button" class="ac-btn" data-dlg="no">Close</button></div>
      </div>`
    }
    const load = async (error = '') => {
      const r = await fetch(`${API}/away/policy`, { signal: AbortSignal.timeout(10_000) })
        .then((x) => (x.ok ? x.json() : null))
        .catch(() => null)
      paint(r?.additions ? r : null, r ? error : 'The Claude host did not answer')
    }
    box.addEventListener('click', async (e) => {
      const t = e.target as HTMLElement
      const rm = t.closest<HTMLButtonElement>('[data-aw-rm]')
      if (rm) {
        rm.disabled = true
        const r = await post('/away/policy/remove', { pattern: rm.dataset.awRm }).catch(() => null)
        const body = await r?.json().catch(() => null)
        return load(r?.ok ? '' : (body?.error ?? 'The Claude host did not answer'))
      }
      if (t.closest('[data-dlg="no"]') || e.target === box) box.remove()
    })
    box.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') box.remove()
    })
    paint(null)
    root.appendChild(box)
    box.querySelector<HTMLElement>('[data-dlg="no"]')?.focus()
    await load()
    box.querySelector<HTMLElement>('[data-aw-rm], [data-dlg="no"]')?.focus()
  }

  async function awayBack() {
    const r = await post('/away', { on: false })
      .then((x) => (x.ok ? x.json() : null))
      .catch(() => null)
    if (r && typeof r.on === 'boolean') awayState = r as AwayState
    paintAway()
    // the conductor writes its summary of the time away in its own chat
    openAwayLead()
  }

  /** a parked chat (fleet_park) back where it left off, from the away bar */
  async function unparkChat(id: string) {
    if (!id) return
    const r = await post(`/parked/${encodeURIComponent(id)}/resume`).catch(() => null)
    const body = await r?.json().catch(() => null)
    if (!r?.ok) {
      await ask({
        title: 'Could not resume that chat',
        body: body?.error ?? 'The Claude host did not answer',
        ok: 'OK',
        cancel: null,
      })
      return
    }
    await refresh()
    await refreshAway()
    const s = summaryOf(body.id)
    if (s) {
      const ws = ensureWs(wsKey(s.cwd))
      setWs(ws.path)
      showChat(ws, s.id)
    }
  }

  /**
   * The dock's away button and ⌥⌘A: autopilot's own control (autopilot-panels.ts) owns all three
   * modes now, so this opens it rather than asking a second time in a second place. Coming back
   * is still here, because "I'm back" is this panel's word for it and the conductor's summary
   * lands in this panel.
   */
  async function toggleAway() {
    if (!awayState?.on) return dispatchEvent(new CustomEvent('laika:autopilot-toggle'))
    const yes = await ask({
      title: 'I’m back?',
      body: 'Away mode ends: autopilot stops, nothing more is approved for you, and the conductor writes up what happened.',
      ok: 'I’m back',
    })
    if (yes) awayBack()
  }

  $('away').addEventListener('click', (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>('[data-aw]')?.dataset.aw
    if (k === 'lead') return openAwayLead()
    if (k === 'back') return awayBack()
    if (k === 'allowed') return awayAllowed()
    if (k === 'unpark')
      return unparkChat(
        (e.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id ?? '',
      )
    if (k === 'seen') {
      try {
        localStorage.setItem(AWAY_SEEN, String(awayState?.endedAt ?? ''))
      } catch {}
      paintAway()
    }
  })

  // a launcher on the map, so Claude is findable without knowing a shortcut
  const launch = el(
    'button',
    'ss-launch',
    '<i></i><span>Claude</span><b data-need hidden></b><kbd>S</kbd>',
  )
  launch.type = 'button'
  launch.title = 'Open Claude (S)'
  launch.addEventListener('pointerdown', (e) => e.stopPropagation())
  launch.addEventListener('click', () => setOpen(true))
  ;(document.getElementById('stage') ?? document.body).appendChild(launch)

  let open = false
  /** full Claude: the panel takes the screen instead of docking beside the map */
  let docked =
    !popped &&
    (() => {
      try {
        return localStorage.getItem(FULL_KEY) !== '1'
      } catch {
        return true
      }
    })()
  /** the panel is in its own window, so this copy stays shut and opening it goes there */
  let poppedOut = false
  let accounts: Account[] = []
  let repos: Repo[] = []
  let projects: Project[] = []
  let elsewhere: Elsewhere[] = []
  let summaries: Summary[] = []
  const views = new Map<string, View>()
  const workspaces = new Map<string, Workspace>()
  let order: string[] = []
  let activeWs: string | null = null
  /** workspaces side by side across the panel, left to right, the active one among them;
   *  empty while one is shown alone */
  let spread: string[] = []
  let spreadSizes: number[] = []
  const visible = (path: string) => (spread.length ? spread.includes(path) : path === activeWs)
  let timer: (() => void) | null = null
  let restored = false
  const prefs: { account: string; mode: Mode; model: string; effort: Effort } = {
    account: '',
    mode: 'default',
    model: '',
    effort: 'high',
  }
  try {
    prefs.model = localStorage.getItem('laika.model') ?? ''
    const e = localStorage.getItem('laika.effort') as Effort | null
    if (e && EFFORTS.includes(e)) prefs.effort = e
    const m = localStorage.getItem('laika.mode') as Mode | null
    if (m && MODES.some((x) => x.id === m)) prefs.mode = m
    prefs.account = localStorage.getItem('laika.account') ?? ''
  } catch {}
  const setPrefMode = (m: Mode) => {
    prefs.mode = m
    try {
      localStorage.setItem('laika.mode', m)
    } catch {}
  }
  const setPrefEffort = (e: Effort) => {
    prefs.effort = e
    try {
      localStorage.setItem('laika.effort', e)
    } catch {}
  }
  const setPrefModel = (id: string) => {
    prefs.model = id
    try {
      localStorage.setItem('laika.model', id)
    } catch {}
  }
  const setAccount = (id: string) => {
    prefs.account = id
    try {
      localStorage.setItem('laika.account', id)
    } catch {}
  }

  const saveLayout = () => {
    try {
      localStorage.setItem(
        LAYOUT_KEY,
        JSON.stringify({ order, active: activeWs, spread, spreadSizes }),
      )
    } catch {}
  }
  const savedLayout = (): {
    order: string[]
    active: string | null
    spread?: string[]
    spreadSizes?: number[]
    /** before the spread: two side by side */
    duo?: [string, string] | null
    duoSize?: number
  } | null => {
    try {
      return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null')
    } catch {
      return null
    }
  }

  const inside = (cwd: string, dir: string) => cwd === dir || cwd.startsWith(`${dir}/`)
  const projectOf = (cwd: string) => projects.find((p) => inside(cwd, p.path))
  /** the workspace a folder belongs to: its project folder, else its repo, else itself */
  const wsKey = (cwd: string) =>
    projectOf(cwd)?.path ??
    repos.filter((r) => inside(cwd, r.path)).sort((a, b) => b.path.length - a.path.length)[0]
      ?.path ??
    cwd
  const repoName = (path: string) => short(repos.find((r) => r.path === path)?.name ?? path)
  /** the repo a folder is in, ignoring projects */
  const wsKey2 = (cwd: string) =>
    repos.filter((r) => inside(cwd, r.path)).sort((a, b) => b.path.length - a.path.length)[0]
      ?.path ?? cwd
  const wsOf = (v: View) => workspaces.get(wsKey(v.s.cwd))
  const activeView = () => {
    const ws = activeWs ? workspaces.get(activeWs) : undefined
    const id = ws?.pane === 'chats' ? ws.groups[ws.focus]?.active : undefined
    return id && id !== 'new' ? views.get(id) : undefined
  }
  const isShown = (v: View) => {
    const ws = wsOf(v)
    return (
      open &&
      !!ws &&
      visible(ws.path) &&
      ws.pane === 'chats' &&
      ws.groups.some((g) => g.active === v.s.id)
    )
  }
  const needs = (s: Summary) => s.state === 'waiting'

  // ------------------------------------------------------------ data
  /**
   * Accounts, repos and projects change rarely but cost seconds to compute cold (git in every
   * repo). The panel draws from the copy remembered in this browser at once and refreshes it
   * behind the scenes; only a first ever open waits for the network.
   */
  let staticFetch: Promise<void> | null = null
  async function loadStatic() {
    if (!repos.length) {
      try {
        const snap = JSON.parse(localStorage.getItem(STATIC_KEY) ?? 'null')
        if (snap?.repos?.length) {
          accounts = snap.accounts ?? []
          repos = snap.repos
          projects = snap.projects ?? []
          applyAccounts()
        }
      } catch {}
    }
    staticFetch ??= fetchStatic().finally(() => {
      staticFetch = null
    })
    if (!repos.length) await staticFetch
  }
  function applyAccounts() {
    $('acctwarn').hidden = accounts.some((a) => !a.demo && a.loggedIn)
    // the account new chats use: the one you picked last, else the first signed-in account
    if (!accounts.some((a) => a.id === prefs.account)) {
      prefs.account =
        (
          accounts.find((a) => !a.demo && a.loggedIn) ??
          accounts.find((a) => !a.demo) ??
          accounts[0]
        )?.id ?? 'demo'
    }
  }
  async function fetchStatic() {
    try {
      const [a, r, p] = await Promise.all([
        fetch(`${API}/accounts`).then((r) => r.json()),
        fetch('/api/control/repos').then((r) => r.json()),
        fetch('/api/control/projects')
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []),
      ])
      if (!Array.isArray(r) || !Array.isArray(a)) return
      r.sort(
        (x: Repo, y: Repo) => Date.parse(y.lastCommit ?? '0') - Date.parse(x.lastCommit ?? '0'),
      )
      accounts = a
      repos = r
      projects = p
      applyAccounts()
      try {
        localStorage.setItem(STATIC_KEY, JSON.stringify({ accounts, repos, projects }))
      } catch {}
      if (open) {
        paintTabs()
        if (!activeWs) paintStart()
      }
    } catch {}
  }

  /**
   * Chats you ended: gone from the page at once, and kept out of it until the host has let go of
   * them (a slow or restarting host must not bring an ended chat back on the next refresh).
   */
  const ending = new Set<string>()
  function endOnHost(id: string) {
    fetch(`${API}/sessions/${id}`, {
      method: 'DELETE',
      headers: { 'x-control': '1' },
      signal: AbortSignal.timeout(15_000),
    })
      .then((r) => {
        if (r.ok || r.status === 404) ending.delete(id)
      })
      .catch(() => {})
  }
  // a refresh that is still waiting is not started again: on a loaded machine they would pile up
  let refreshing: Promise<void> | null = null
  function refresh() {
    refreshing ??= refreshNow().finally(() => {
      refreshing = null
    })
    return refreshing
  }
  async function refreshNow() {
    refreshAway()
    try {
      const [s, e] = await Promise.all([
        fetch(`${API}/sessions`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json()),
        fetch('/api/control/sessions', { signal: AbortSignal.timeout(10_000) }).then((r) =>
          r.json(),
        ),
      ])
      if (!Array.isArray(s)) return
      // ended here but still held by the host: ask again, and keep it off the page meanwhile
      for (const x of s as Summary[]) if (ending.has(x.id)) endOnHost(x.id)
      for (const id of ending) if (!(s as Summary[]).some((x) => x.id === id)) ending.delete(id)
      summaries = (s as Summary[]).filter((x) => !ending.has(x.id))
      if (Array.isArray(e)) elsewhere = e
    } catch {
      return
    }
    const alive = new Set(summaries.map((s) => s.id))
    if (repos.length) {
      // every chat running in the app has a home: open its repo's workspace if needed
      for (const s of summaries) addChat(ensureWs(wsKey(s.cwd)), s.id)
      for (const ws of workspaces.values()) {
        ws.chats = ws.chats.filter((id) => alive.has(id))
        if (placeChats(ws) && visible(ws.path) && ws.built) {
          paintCols(ws)
          saveWs(ws)
        }
      }
    }
    for (const s of summaries) {
      const v = views.get(s.id)
      if (v) v.s = { ...s, state: v.s.state, mode: v.s.mode, model: v.s.model ?? s.model }
    }
    paintTabs()
    const ws = activeWs ? workspaces.get(activeWs) : undefined
    if (ws) paintWsBar(ws)
    if (!$('history').hidden) paintHistory()
    paintWidget()
    const need = summaries.filter(needs).length
    const badge = launch.querySelector('[data-need]') as HTMLElement
    badge.hidden = !need
    badge.textContent = String(need)
    $('fleetn').hidden = !need
    $('fleetn').textContent = String(need)
    launch.classList.toggle('need', need > 0)
  }

  // ------------------------------------------------------------ repo tabs
  /** a repo tab being slid along the bar; the bar is not repainted under it */
  let tabDrag: { path: string; moved: boolean } | null = null
  function paintTabs() {
    if (tabDrag?.moved) return
    $('tabs').innerHTML = order
      .map((p) => {
        const ws = workspaces.get(p)
        if (!ws) return ''
        const mine = summaries.filter((s) => ws.chats.includes(s.id))
        const need = mine.some(needs)
        const busy = mine.some((s) => s.state === 'running' || s.state === 'starting')
        const done = !need && !busy && mine.some((s) => unread.has(s.id))
        return `<button type="button" class="ws-tab${ws.project ? ' project' : ''}${p === activeWs ? ' on' : ''}${spread.includes(p) && p !== activeWs ? ' beside' : ''}${need ? ' need' : ''}${busy ? ' busy' : ''}${done ? ' done' : ''}" data-ws-open="${esc(p)}" style="--ws:${ws.colour}" title="${esc(ws.project ? `${p} · ${ws.repos.length} repos` : p)}">
          <i></i><span>${esc(ws.name)}</span>${mine.length > 1 ? `<small>${mine.length}</small>` : ''}<b data-ws-close="${esc(p)}" title="Close tab (chats keep running)" aria-label="Close ${esc(ws.name)}">×</b>
        </button>`
      })
      .join('')
    const size = $('size')
    size.title = docked ? 'Full Claude (⌥⌘F)' : 'Dock beside the map (⌥⌘F)'
    ;(size.firstElementChild as HTMLElement).textContent = docked ? '⤢' : '⇥'
    announceWorkspaces()
  }

  /**
   * The project tabs are the window system's workspaces (panels.ts): it hears which there are
   * and which are on screen, and asks for one by its key. Said only when something changed.
   */
  let wsSaid = ''
  function announceWorkspaces() {
    const list = order
      .map((p) => workspaces.get(p))
      .filter((w): w is Workspace => !!w)
      .map((w) => ({ key: w.path, name: w.name, colour: w.colour }))
    const detail = { list, shown: order.filter(visible) }
    const said = JSON.stringify(detail)
    if (said === wsSaid) return
    wsSaid = said
    dispatchEvent(new CustomEvent('laika:workspaces', { detail }))
  }
  /**
   * The chat groups are windows too. The window keys (panels.ts) move focus between them, the
   * next project column and the panels by where they are on screen, and act on the group the
   * keyboard is in: ⌥⌘⇧←/→ moves its chat into the group beside (past the last group, the whole
   * column moves across the spread), ⌥⌘-/= resizes it, ⌥⌘↩ is full Claude, ⌥⌘W closes the
   * group (its chats keep running, in the group beside). Nothing here ends a chat.
   */
  registerRegions(() => {
    if (!open) return []
    const out: Region[] = []
    for (const path of order.filter(visible)) {
      const ws = workspaces.get(path)
      if (!ws || ws.pane !== 'chats') continue
      const cells = [...ws.cols.querySelectorAll<HTMLElement>('.ws-col')]
      ws.groups.forEach((g, gi) => {
        const el = cells[gi]
        if (!el) return
        out.push({
          id: `${path}#${g.id}`,
          el,
          current: path === activeWs && gi === ws.focus,
          focus: () => {
            focusSide(path)
            focusGroup(ws, gi)
          },
          move: (dir) => {
            if (dir !== 'left' && dir !== 'right') return false
            const d = dir === 'right' ? 1 : -1
            if ((gi + d < 0 || gi + d >= ws.groups.length) && spread.length > 1) {
              shiftSide(path, d)
              return true
            }
            const id = ws.groups[gi]?.active
            if (!id || id === 'new') return false
            moveSideways(ws, id, d)
            focusInput(ws)
            return true
          },
          resize: (by, axis) => {
            if (axis !== 'x' || ws.groups.length < 2 || isGrid(ws)) return false
            const k = by > 0 ? 1.15 : 1 / 1.15
            ws.sizes[gi] = Math.max(0.25, Math.min(4, (ws.sizes[gi] ?? 1) * k))
            layoutCols(ws)
            saveWs(ws)
            return true
          },
          full: () => {
            setDocked(!docked)
            return true
          },
          close: () => {
            if (ws.groups.length < 2) return false
            closeGroup(ws, gi)
            focusInput(ws)
            return true
          },
        })
      })
    }
    return out
  })
  addEventListener('laika:workspace-go', (e) => {
    const key = (e as CustomEvent<{ key?: string }>).detail?.key
    if (key && workspaces.has(key) && key !== activeWs) setWs(key)
  })

  // right-click a repo tab: side by side, swap, alone, close
  const tmenu = el('div', 'ss-menu ws-cmenu')
  tmenu.setAttribute('role', 'menu')
  tmenu.hidden = true
  document.body.appendChild(tmenu)
  $('tabs').addEventListener('contextmenu', (e) => {
    const path = (e.target as HTMLElement).closest<HTMLElement>('.ws-tab')?.dataset.wsOpen
    if (!path || !workspaces.has(path)) return
    e.preventDefault()
    tabMenu(path, e.clientX, e.clientY)
  })
  /** a folder's menu: from its tab, or from its column's name bar when side by side */
  function tabMenu(path: string, x: number, y: number) {
    const ws = workspaces.get(path)
    if (!ws) return
    const item = (k: string, label: string, hint = '', off = false) =>
      `<button type="button" role="menuitem" data-tm="${k}"${off ? ' disabled' : ''}><span>${label}</span>${hint ? `<kbd>${hint}</kbd>` : ''}</button>`
    const onScreen = visible(path)
    tmenu.innerHTML = [
      `<div class="cm-h"><i class="ws-st" style="border-color:${ws.colour}"></i><span>${esc(ws.name)}</span></div>`,
      !onScreen ? item('beside', 'Open beside', 'drag down', !activeWs) : '',
      spread.length && onScreen ? item('left', 'Move left', '⌥⌘⇧←', spread[0] === path) : '',
      spread.length && onScreen
        ? item('right', 'Move right', '⌥⌘⇧→', spread[spread.length - 1] === path)
        : '',
      spread.length && onScreen ? item('alone', 'Show only this', 'double-click') : '',
      spread.length && onScreen ? item('off', 'Take off the screen', '×') : '',
      order.length > 1 ? item('spread', 'Spread tabs across the screen', '⌥⌘S') : '',
      '<hr>',
      '<hr>',
      `<div class="cm-colours" role="group" aria-label="Colour">${[null, ...PALETTE]
        .map((c) => {
          const on = (wsColours.get(path) ?? null) === c
          return `<button type="button" data-tm="colour:${c ?? ''}" class="${on ? 'on' : ''}" title="${c ? 'Colour this repo' : 'Colour from its name'}" aria-label="${c ? `Colour ${c}` : 'Colour from its name'}" style="--sw:${c ?? colourOf(ws.name)}"></button>`
        })
        .join('')}</div>`,
      '<hr>',
      item('close', 'Close tab', 'chats keep running'),
    ].join('')
    tmenu.dataset.path = path
    tmenu.hidden = false
    tmenu.style.left = `${Math.min(x, innerWidth - tmenu.offsetWidth - 8)}px`
    tmenu.style.top = `${Math.min(y, innerHeight - tmenu.offsetHeight - 8)}px`
  }
  addEventListener('pointerdown', (e) => {
    if (!tmenu.hidden && !tmenu.contains(e.target as Node)) tmenu.hidden = true
  })
  // Escape closes the menu, not the panel under it
  addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || tmenu.hidden) return
      e.preventDefault()
      e.stopPropagation()
      tmenu.hidden = true
    },
    true,
  )
  tmenu.addEventListener('click', (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>('[data-tm]')?.dataset.tm
    const path = tmenu.dataset.path as string
    tmenu.hidden = true
    if (k === 'beside') return openBeside(path)
    if (k === 'left' || k === 'right') return shiftSide(path, k === 'left' ? -1 : 1)
    if (k === 'alone') return showAlone(path)
    if (k === 'off') return takeOff(path)
    if (k === 'spread') return spreadTabs()
    if (k === 'close') return closeWs(path)
    if (k?.startsWith('colour:')) return recolourWs(path, k.slice(7) || null)
  })

  /** a repo's new colour, everywhere its workspace already shows it */
  function recolourWs(path: string, hex: string | null) {
    const ws = workspaces.get(path)
    setRepoColour(path, hex)
    if (!ws) return
    ws.colour = repoColour(path, ws.name)
    ws.el.style.setProperty('--ws', ws.colour)
    ws.term.setAccent(ws.colour)
    for (const m of ws.el.querySelectorAll<HTMLElement>('.ss-hello .ss-mark'))
      m.style.background = ws.colour
    paintTabs()
    paintWsBar(ws)
    paintWidget()
    if (path === activeWs) focusRing()
  }

  // repo tabs slide: press, drag sideways, and the others make room; the order is remembered
  let slid = false
  $('tabs').addEventListener('pointerdown', (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('.ws-tab')
    if (!tab || e.button !== 0 || (e.target as HTMLElement).closest('[data-ws-close]')) return
    const bar = $('tabs')
    const path = tab.dataset.wsOpen as string
    const tabs = [...bar.querySelectorAll<HTMLElement>('.ws-tab')]
    const from = tabs.indexOf(tab)
    const rects = tabs.map((t) => t.getBoundingClientRect())
    const startX = e.clientX
    const startY = e.clientY
    const barBottom = bar.getBoundingClientRect().bottom
    let to = from
    let beside = false
    slid = false
    tabDrag = { path, moved: false }
    const move = (m: PointerEvent) => {
      const dx = m.clientX - startX
      if (!tabDrag) return
      // pulled down out of the bar, into the panel: it will open beside the workspace on screen
      beside = m.clientY > barBottom + 28 && !!activeWs && path !== activeWs
      pane.classList.toggle('drop-beside', beside)
      tab.classList.toggle('to-beside', beside)
      if (!tabDrag.moved) {
        if (Math.abs(dx) < 5 && Math.abs(m.clientY - startY) < 5) return
        tabDrag.moved = true
        tab.setPointerCapture(m.pointerId)
        bar.classList.add('sliding')
        tab.classList.add('lifted')
      }
      const r = rects[from] as DOMRect
      // keep the tab inside the bar
      const min = (rects[0] as DOMRect).left - r.left
      const max = (rects[rects.length - 1] as DOMRect).right - r.right
      const x = Math.max(min, Math.min(max, dx))
      tab.style.transform = `translateX(${x}px)`
      const centre = r.left + r.width / 2 + x
      to = rects.findIndex((q) => centre < q.left + q.width / 2)
      if (to < 0) to = rects.length - 1
      else if (to > from) to -= 1
      // the tabs it passes shift over by its width
      const gap = r.width + 2
      tabs.forEach((t, i) => {
        if (t === tab) return
        const shift =
          from < to && i > from && i <= to ? -gap : from > to && i >= to && i < from ? gap : 0
        t.style.transform = shift ? `translateX(${shift}px)` : ''
      })
    }
    const up = () => {
      tab.removeEventListener('pointermove', move)
      tab.removeEventListener('pointerup', up)
      tab.removeEventListener('pointercancel', up)
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      const moved = tabDrag?.moved
      tabDrag = null
      bar.classList.remove('sliding')
      pane.classList.remove('drop-beside')
      tab.classList.remove('to-beside')
      if (!moved) return
      slid = true
      setTimeout(() => {
        slid = false
      }, 0)
      if (beside) {
        paintTabs()
        return openBeside(path)
      }
      if (to !== from) {
        order = order.filter((p) => p !== path)
        order.splice(to, 0, path)
        saveLayout()
      }
      paintTabs()
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  })

  // ------------------------------------------------------------ a workspace
  // what you called a chat, kept by its Claude session id so the name survives reloads and resumes
  const names = new Map<string, string>()
  try {
    for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(NAMES_KEY) ?? '{}')))
      if (typeof v === 'string') names.set(k, v)
  } catch {}
  const nameKey = (s: Summary) => s.sdkSessionId ?? s.id
  // a colour you gave a chat, kept like its name
  const chatColours = new Map<string, string>()
  try {
    for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(COLOURS_KEY) ?? '{}')))
      if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) chatColours.set(k, v)
  } catch {}
  const colourOfChat = (id: string) => {
    const s = summaryOf(id)
    return s ? chatColours.get(nameKey(s)) : undefined
  }
  function setChatColour(s: Summary, hex: string | null) {
    if (hex) chatColours.set(nameKey(s), hex)
    else chatColours.delete(nameKey(s))
    saveNamesLocally()
    if (s.sdkSessionId) patchLibrary(s.sdkSessionId, { colour: hex ?? '' })
  }
  const saveNamesLocally = () => {
    try {
      localStorage.setItem(NAMES_KEY, JSON.stringify(Object.fromEntries(names)))
      localStorage.setItem(COLOURS_KEY, JSON.stringify(Object.fromEntries(chatColours)))
    } catch {}
  }
  /**
   * Names and colours also live in the chat library on disk (chat-library.mjs), so they follow a
   * chat into the pop-out window and other browsers. localStorage stays as the copy drawn before
   * the library answers. The first time a browser sees the library it hands over what it kept.
   */
  const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  function patchLibrary(id: string, patch: LibEntry) {
    return fetch(`${LIBRARY}/meta`, {
      method: 'POST',
      headers: WRITE,
      body: JSON.stringify({ id, patch }),
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => r.ok)
      .catch(() => false)
  }
  async function syncLibrary() {
    let migrated = false
    try {
      migrated = localStorage.getItem(MIGRATED_KEY) === '1'
    } catch {}
    const mine = (m: Map<string, string>) =>
      Object.fromEntries([...m].filter(([k]) => SESSION_ID.test(k)))
    const lib: Record<string, LibEntry> | null = await (migrated
      ? fetch(`${LIBRARY}/meta`, { signal: AbortSignal.timeout(10_000) })
      : fetch(`${LIBRARY}/meta`, {
          method: 'POST',
          headers: WRITE,
          body: JSON.stringify({ migrate: { names: mine(names), colours: mine(chatColours) } }),
          signal: AbortSignal.timeout(10_000),
        })
    )
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    if (!lib) return
    try {
      localStorage.setItem(MIGRATED_KEY, '1')
    } catch {}
    // the library is the truth for every Claude session; names kept under a host id stay local
    for (const k of [...names.keys()]) if (SESSION_ID.test(k) && !lib[k]?.title) names.delete(k)
    for (const k of [...chatColours.keys()])
      if (SESSION_ID.test(k) && !lib[k]?.colour) chatColours.delete(k)
    for (const [k, e] of Object.entries(lib)) {
      if (e.title) names.set(k, e.title)
      if (e.colour) chatColours.set(k, e.colour)
    }
    saveNamesLocally()
    paintTabs()
    const ws = activeWs ? workspaces.get(activeWs) : undefined
    if (ws) paintWsBar(ws)
  }
  /** each Claude account keeps one colour and a short label everywhere it shows */
  const ACCOUNT_COLOURS = ['#7aa2ff', '#ff7eb6', '#5ee0c1', '#ffc94f', '#c792ea', '#f7a26c']
  const accountOf = (id: string) => accounts.find((a) => a.id === id)
  const accountColour = (id: string) => {
    const real = accounts.filter((a) => !a.demo)
    const i = real.findIndex((a) => a.id === id)
    return i < 0 ? '#8a93ab' : (ACCOUNT_COLOURS[i % ACCOUNT_COLOURS.length] as string)
  }
  /** a short name for the account: an email label shows as the part before the @ */
  const accountLabel = (s: Summary) =>
    (accountOf(s.account)?.label ?? s.accountLabel ?? s.account).replace(/@.*$/, '')
  /** only worth a badge on every tab once more than one real account is connected */
  const manyAccounts = () => accounts.filter((a) => !a.demo).length > 1
  const summaryOf = (id: string) => summaries.find((x) => x.id === id) ?? views.get(id)?.s
  const titleOf = (s: Summary | undefined) =>
    (s && (names.get(nameKey(s)) || s.title)) || 'New chat'
  function rename(s: Summary, to: string) {
    const t = to.trim().slice(0, 120)
    if (t && t !== s.title) names.set(nameKey(s), t)
    else names.delete(nameKey(s))
    saveNamesLocally()
    if (s.sdkSessionId) patchLibrary(s.sdkSessionId, { title: names.get(nameKey(s)) ?? '' })
  }
  /** chats that finished while they were not on screen */
  const unread = new Set<string>()
  const lastState = new Map<string, string>()
  const busyState = (st: string) => st === 'running' || st === 'starting'
  const stateOf = (s: Summary) =>
    unread.has(s.id) && !busyState(s.state) && s.state !== 'waiting' ? 'unread' : s.state
  const STATE_WORD: Record<string, string> = {
    starting: 'Starting',
    running: 'Working',
    waiting: 'Needs you',
    idle: 'Idle',
    unread: 'Finished',
    error: 'Error',
    closed: 'Ended',
    draft: 'Not sent yet',
  }
  const modelName = (m: string | null) =>
    m
      ? m
          .replace(/^claude-/, '')
          .replace(/-\d.*$/, '')
          .replace(/^./, (c) => c.toUpperCase())
      : 'Default model'

  /** each workspace's groups, their tabs and their widths come back as you left them */
  const savedWs = (path: string): SavedWs | null => {
    try {
      const w = JSON.parse(localStorage.getItem(WS_KEY) ?? '{}')[path]
      return Array.isArray(w?.groups) ? w : null
    } catch {
      return null
    }
  }
  function saveWs(ws: Workspace) {
    ws.remembered = ws.groups.map((g) => g.tabs.filter((t) => t !== 'new'))
    try {
      const all = JSON.parse(localStorage.getItem(WS_KEY) ?? '{}')
      all[ws.path] = {
        groups: ws.groups.map((g) => ({
          tabs: g.tabs.filter((t) => t !== 'new'),
          active: g.active,
        })),
        sizes: ws.sizes,
        focus: ws.focus,
        grid: ws.grid,
        rows: ws.rows,
      }
      localStorage.setItem(WS_KEY, JSON.stringify(all))
    } catch {}
  }
  function addChat(ws: Workspace, id: string) {
    if (!ws.chats.includes(id)) ws.chats.push(id)
  }
  const newGroup = (ws: Workspace, tabs: string[] = ['new']): Group => ({
    id: ws.nextGroup++,
    tabs,
    active: tabs[0] ?? 'new',
  })
  const groupIndex = (ws: Workspace, id: string) => ws.groups.findIndex((g) => g.tabs.includes(id))
  const focused = (ws: Workspace) => ws.groups[ws.focus] ?? (ws.groups[0] as Group)

  /**
   * Bring the groups in line with the chats that exist: ended chats leave their tabs, new ones
   * join the group they were last in (or the focused one), and a group left empty closes.
   * Returns whether anything moved.
   */
  function placeChats(ws: Workspace) {
    let changed = false
    for (const g of ws.groups) {
      const keep = g.tabs.filter((t) => t === 'new' || ws.chats.includes(t))
      if (keep.length === g.tabs.length) continue
      if (!keep.includes(g.active)) {
        const i = g.tabs.indexOf(g.active)
        g.active = keep[Math.min(Math.max(i, 0), keep.length - 1)] ?? 'new'
      }
      g.tabs = keep
      changed = true
    }
    for (const id of ws.chats) {
      if (groupIndex(ws, id) >= 0) continue
      const was = ws.remembered.findIndex((tabs) => tabs.includes(id))
      // a group still holding only an untouched draft takes the chat before the focused one does
      const blank = ws.groups.find(
        (x) =>
          x.tabs.length === 1 && x.tabs[0] === 'new' && !ws.drafts.get(x.id)?.composer.input.value,
      )
      const g = ws.groups[was >= 0 && was < ws.groups.length ? was : -1] ?? blank ?? focused(ws)
      const order = ws.remembered[was] ?? []
      const rank = (t: string) => (order.includes(t) ? order.indexOf(t) : Number.MAX_SAFE_INTEGER)
      const at = g.tabs.findIndex((t) => t !== 'new' && rank(t) > rank(id))
      g.tabs.splice(at < 0 ? g.tabs.filter((t) => t !== 'new').length : at, 0, id)
      // an untouched draft that is all the group holds makes way for the chat
      const draft = ws.drafts.get(g.id)
      if (g.active === 'new' && !draft?.composer.input.value && g.tabs.length === 2) {
        g.tabs = g.tabs.filter((t) => t !== 'new')
        g.active = id
      }
      changed = true
    }
    changed = tidyGroups(ws) || changed
    return changed
  }

  /** close groups with nothing in them; there is always at least one */
  function tidyGroups(ws: Workspace, also: Group[] = []) {
    const before = ws.groups.length
    const gone = ws.groups.filter(
      (g) =>
        !g.tabs.length ||
        (also.includes(g) &&
          g.tabs.length === 1 &&
          g.tabs[0] === 'new' &&
          !ws.drafts.get(g.id)?.composer.input.value),
    )
    if (!gone.length) return false
    const focusG = ws.groups[ws.focus]
    for (const g of gone) {
      const i = ws.groups.indexOf(g)
      ws.groups.splice(i, 1)
      ws.sizes.splice(i, 1)
      ws.drafts.delete(g.id)
    }
    if (!ws.groups.length) {
      ws.groups = [newGroup(ws)]
      ws.sizes = [1]
    }
    const f = focusG ? ws.groups.indexOf(focusG) : -1
    ws.focus = f >= 0 ? f : Math.min(ws.focus, ws.groups.length - 1)
    return ws.groups.length !== before
  }

  function ensureWs(path: string): Workspace {
    const have = workspaces.get(path)
    if (have) return have
    const repo = repos.find((r) => r.path === path)
    const proj = projects.find((p) => p.path === path)
    const name = proj?.name ?? short(repo?.name ?? path)
    const colour = repoColour(path, name)
    const saved = savedWs(path)
    let where = path
    try {
      const w = localStorage.getItem(`laika.where:${path}`)
      if (w && proj?.repos.includes(w)) where = w
    } catch {}
    const w = el('section', 'ws')
    w.style.setProperty('--ws', colour)
    w.innerHTML = `
      <div class="ws-head" data-w="head"><span></span><button type="button" class="ws-head-x" data-w="off" title="Take off the screen (its chats keep running)" aria-label="Take ${esc(name)} off the screen">×</button></div>
      <div class="ws-cols" data-w="cols"></div>
      <div class="ws-files" data-w="files" hidden></div>
      <div class="ws-changes" data-w="changes" hidden></div>
      <div class="ws-build" data-w="build" hidden></div>
      <div class="ws-drop" data-w="drop" hidden><span></span></div>
      <div data-w="term"></div>`
    const q = (k: string) => w.querySelector(`[data-w="${k}"]`) as HTMLElement
    const ws: Workspace = {
      path,
      name,
      colour,
      el: w,
      cols: q('cols'),
      repos: proj ? proj.repos : [path],
      project: !!proj,
      where,
      chats: [],
      groups: [],
      remembered: [],
      nextGroup: 1,
      focus: 0,
      sizes: [],
      grid: false,
      rows: [1, 1],
      pane: 'chats',
      term: createTerminalPanel(q('term'), { cwd: path, owner: `ws:${path}`, accent: colour }),
      changes: null as unknown as ChangesView,
      files: createFilesView(path),
      filesLoaded: false,
      build: null,
      changeCount: 0,
      drafts: new Map(),
      drag: null,
      renaming: false,
      built: false,
    }
    // saved groups hold chat ids; placeChats drops the ones that are gone once chats load
    for (const g of saved?.groups ?? []) {
      const tabs = g.tabs.filter((t) => typeof t === 'string' && t !== 'new')
      if (tabs.length)
        ws.groups.push({
          id: ws.nextGroup++,
          tabs,
          active: tabs.includes(g.active) ? g.active : (tabs[0] as string),
        })
      // every group comes back: one that held only a new chat comes back as one
      else ws.groups.push(newGroup(ws))
    }
    // no layout yet: two groups side by side, which chats fill left to right
    if (!ws.groups.length) ws.groups.push(newGroup(ws), newGroup(ws))
    ws.remembered = ws.groups.map((g) => [...g.tabs])
    ws.sizes =
      saved?.sizes?.length === ws.groups.length ? saved.sizes : Array(ws.groups.length).fill(1)
    ws.focus = Math.min(Math.max(saved?.focus ?? 0, 0), ws.groups.length - 1)
    ws.grid = !!saved?.grid
    if (saved?.rows?.length && saved.rows.every((f) => f > 0)) ws.rows = saved.rows
    ws.term.setAccent(colour)
    const onCount = (count: number) => {
      ws.changeCount = count
      if (ws.path === activeWs) paintViews()
    }
    ws.changes = proj ? projectChanges(ws, onCount) : createChangesView(path, onCount)
    q('changes').appendChild(ws.changes.el)
    q('files').appendChild(ws.files.el)
    wireGroups(ws)
    // side by side, the name bar over the column: × takes it off the screen
    ;(q('head').firstElementChild as HTMLElement).textContent = name
    q('off').addEventListener('click', (e) => {
      e.stopPropagation()
      takeOff(path)
    })
    const head = q('head')
    head.title = 'Drag to move · double-click to show only this · right-click for more'
    head.addEventListener('pointerdown', (e) => dragSide(path, e))
    head.addEventListener('dblclick', (e) => {
      if (!(e.target as HTMLElement).closest('button')) showAlone(path)
    })
    // a middle click closes it, as on a tab
    head.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault()
    })
    head.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return
      e.preventDefault()
      takeOff(path)
    })
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      tabMenu(path, e.clientX, e.clientY)
    })
    workspaces.set(path, ws)
    if (!order.includes(path)) order.push(path)
    ws.changes.refresh()
    // repos here with their own mission.config.mjs give the workspace a Build view
    void missionRoots(path).then((roots) => {
      if (!roots.length || ws.build) return
      ws.build = createMissionPane(path, roots)
      q('build').appendChild(ws.build.el)
      if (ws.path === activeWs) paintViews()
    })
    return ws
  }

  /** Changes for a project: each repo's own Changes view, only the repos with something changed */
  function projectChanges(ws: Workspace, onCount: (n: number) => void): ChangesView {
    const el = document.createElement('div')
    el.className = 'sc-project'
    const counts = new Map<string, number>()
    const total = () => [...counts.values()].reduce((a, b) => a + b, 0)
    const sections = ws.repos.map((repo) => {
      const box = document.createElement('section')
      box.className = 'sc-repo'
      box.hidden = true
      box.innerHTML = `<h4><i></i><b>${esc(repoName(repo))}</b><small></small></h4>`
      const view = createChangesView(repo, (n) => {
        counts.set(repo, n)
        box.hidden = n === 0
        ;(box.querySelector('small') as HTMLElement).textContent = `${n} changed`
        empty.hidden = total() > 0
        onCount(total())
      })
      box.appendChild(view.el)
      el.appendChild(box)
      return view
    })
    const empty = document.createElement('p')
    empty.className = 'sc-empty'
    empty.textContent = `No changes in the ${ws.repos.length} repos of ${ws.name}.`
    el.appendChild(empty)
    let busy = false
    return {
      el,
      count: total,
      // a few repos at a time: a dozen git status runs at once slow the machine
      async refresh() {
        if (busy) return
        busy = true
        for (let i = 0; i < sections.length; i += 3)
          await Promise.all(sections.slice(i, i + 3).map((v) => v.refresh()))
        busy = false
      },
    }
  }

  /** clicks, keys, drags and resizing inside a workspace's groups */
  function wireGroups(ws: Workspace) {
    const w = ws.el
    const drop = w.querySelector('[data-w="drop"]') as HTMLElement
    const gIndex = (t: HTMLElement) => Number(t.closest<HTMLElement>('.ws-col')?.dataset.g ?? -1)

    w.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      const gi = gIndex(t)
      const g = ws.groups[gi]
      const x = t.closest<HTMLElement>('[data-x]')
      if (x && g) {
        e.stopPropagation()
        const id = x.dataset.x as string
        return id === 'new' ? closeDraft(ws, g) : endChat(ws, id)
      }
      const tab = t.closest<HTMLElement>('[data-chat]')
      if (tab && g) {
        const id = tab.dataset.chat as string
        if ((e.altKey || e.metaKey) && id !== 'new') return moveChat(ws, id, { newAt: gi + 1 })
        return showChat(ws, id, gi)
      }
      const act = t.closest<HTMLElement>('[data-gact]')
      if (act && g) {
        const a = act.dataset.gact
        if (a === 'new') return showChat(ws, 'new', gi)
        if (a === 'split') return splitRight(ws, gi)
        if (a === 'more') return pop.hidden ? groupMenu(ws, gi, act) : closePop()
      }
    })
    w.addEventListener('dblclick', (e) => {
      const t = e.target as HTMLElement
      if (t.closest('.ws-rz')) {
        ws.sizes = Array(ws.groups.length).fill(1)
        ws.rows = [1, 1]
        layoutCols(ws)
        return saveWs(ws)
      }
      const id = t.closest<HTMLElement>('[data-chat]')?.dataset.chat
      if (id && id !== 'new') return startRename(ws, id)
      // double-click the empty part of a tab bar: a new chat there, as in VS Code
      if (t.classList.contains('ws-chats') || t.classList.contains('ws-gfill'))
        showChat(ws, 'new', gIndex(t))
    })
    w.addEventListener('mousedown', (e) => {
      if (e.button === 1 && (e.target as HTMLElement).closest('[data-chat]')) e.preventDefault()
    })
    w.addEventListener('auxclick', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-chat]')?.dataset.chat
      if (e.button !== 1 || !id) return
      e.preventDefault()
      const g = ws.groups[gIndex(e.target as HTMLElement)]
      if (id === 'new') {
        if (g) closeDraft(ws, g)
      } else endChat(ws, id)
    })
    w.addEventListener('contextmenu', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-chat]')?.dataset.chat
      if (!id || id === 'new') return
      e.preventDefault()
      chatMenu(ws, id, e.clientX, e.clientY)
    })
    w.addEventListener(
      'wheel',
      (e) => {
        const bar = (e.target as HTMLElement).closest<HTMLElement>('.ws-chats')
        if (!bar || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
        e.preventDefault()
        bar.scrollLeft += e.deltaY
      },
      { passive: false },
    )
    w.addEventListener(
      'scroll',
      (e) => {
        const bar = e.target as HTMLElement
        if (bar.classList?.contains('ws-chats')) fades(bar)
      },
      { capture: true, passive: true },
    )

    // drag a tab: along any group's tabs to place it there, onto a group to move it in, or
    // onto a group's left or right edge to split
    const clearMarks = () => {
      for (const m of w.querySelectorAll('.drop-before, .drop-after'))
        m.classList.remove('drop-before', 'drop-after')
    }
    const endDrag = () => {
      ws.drag = null
      w.classList.remove('dragging')
      clearMarks()
      drop.hidden = true
      paintWsBar(ws)
    }
    w.addEventListener('dragstart', (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-chat]')
      const id = tab?.dataset.chat
      if (!tab || !id || id === 'new' || ws.renaming) return e.preventDefault()
      ws.drag = id
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', titleOf(summaryOf(id)))
      }
      requestAnimationFrame(() => {
        tab.classList.add('lifted')
        w.classList.add('dragging')
      })
    })
    w.addEventListener('dragend', endDrag)
    type Zone = { gi: number; where: 'tabs' | 'in' | 'left' | 'right'; before?: string | undefined }
    const zoneAt = (e: DragEvent): Zone | null => {
      const t = e.target as HTMLElement
      const col = t.closest<HTMLElement>('.ws-col')
      if (!col) return null
      const gi = Number(col.dataset.g)
      if (t.closest('.ws-gbar')) {
        const tabs = [...col.querySelectorAll<HTMLElement>('.ws-chat:not(.draft)')]
        const b = tabs.find((x) => {
          const r = x.getBoundingClientRect()
          return e.clientX < r.left + r.width / 2
        })
        return { gi, where: 'tabs', before: b?.dataset.chat }
      }
      const r = col.getBoundingClientRect()
      const edge = Math.min(r.width * 0.28, 160)
      if (e.clientX < r.left + edge) return { gi, where: 'left' }
      if (e.clientX > r.right - edge) return { gi, where: 'right' }
      return { gi, where: 'in' }
    }
    w.addEventListener('dragover', (e) => {
      if (!ws.drag) return
      const z = zoneAt(e)
      if (!z) return
      e.preventDefault()
      clearMarks()
      const col = w.querySelector<HTMLElement>(`.ws-col[data-g="${z.gi}"]`)
      if (!col) return
      if (z.where === 'tabs') {
        drop.hidden = true
        const tabs = [...col.querySelectorAll<HTMLElement>('.ws-chat:not(.draft)')]
        const b = tabs.find((x) => x.dataset.chat === z.before)
        if (b) b.classList.add('drop-before')
        else tabs.at(-1)?.classList.add('drop-after')
        const bar = col.querySelector<HTMLElement>('.ws-chats')
        const r = bar?.getBoundingClientRect()
        if (bar && r) {
          if (e.clientX < r.left + 28) bar.scrollLeft -= 14
          else if (e.clientX > r.right - 28) bar.scrollLeft += 14
        }
        return
      }
      const host = w.getBoundingClientRect()
      const body = col.querySelector<HTMLElement>('.ws-gbody') ?? col
      const r = body.getBoundingClientRect()
      const half = z.where === 'in' ? r.width : r.width / 2
      const left = z.where === 'right' ? r.right - half : r.left
      Object.assign(drop.style, {
        left: `${left - host.left + 4}px`,
        top: `${r.top - host.top + 4}px`,
        width: `${half - 8}px`,
        height: `${r.height - 8}px`,
      })
      const from = groupIndex(ws, ws.drag)
      ;(drop.firstElementChild as HTMLElement).textContent =
        z.where === 'in'
          ? from === z.gi
            ? 'Already in this group'
            : 'Move into this group'
          : `Split ${z.where}`
      drop.classList.toggle('side', z.where !== 'in')
      drop.hidden = false
    })
    w.addEventListener('dragleave', (e) => {
      if (!w.contains(e.relatedTarget as Node)) {
        clearMarks()
        drop.hidden = true
      }
    })
    w.addEventListener('drop', (e) => {
      const id = ws.drag
      const z = id ? zoneAt(e) : null
      if (!id || !z) return
      e.preventDefault()
      endDrag()
      if (z.where === 'tabs') {
        const g = ws.groups[z.gi] as Group
        const index = z.before ? g.tabs.indexOf(z.before) : g.tabs.filter((t) => t !== 'new').length
        return moveChat(ws, id, { group: z.gi, index })
      }
      if (z.where === 'in') return moveChat(ws, id, { group: z.gi })
      moveChat(ws, id, { newAt: z.where === 'left' ? z.gi : z.gi + 1 })
    })

    ws.cols.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement
      const grip = t.closest<HTMLElement>('.ws-rz')
      if (grip) return resizeCols(ws, grip, e)
      const gi = gIndex(t)
      if (gi >= 0 && gi !== ws.focus) focusGroup(ws, gi, false)
    })
  }

  const fades = (bar: HTMLElement) => {
    const strip = bar.parentElement
    if (!strip) return
    strip.classList.toggle('l', bar.scrollLeft > 2)
    strip.classList.toggle('r', bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 2)
  }

  /** the repo a project folder's chat runs in, or '' outside a project */
  const sub0 = (s: Summary) => {
    const w = workspaces.get(wsKey(s.cwd))
    return w?.project && s.cwd !== w.path ? repoName(wsKey2(s.cwd)) : ''
  }
  function tabHtml(g: Group, id: string) {
    if (id === 'new')
      return `<button type="button" role="tab" aria-selected="${g.active === 'new'}" class="ws-chat draft st-draft${g.active === 'new' ? ' on' : ''}" data-chat="new" title="A chat you have not sent yet">
          <i class="ws-st"></i><span class="ws-t">New chat</span><b data-x="new" title="Discard" aria-label="Discard new chat">×</b>
        </button>`
    const s = summaryOf(id)
    if (!s) return ''
    const st = stateOf(s)
    const acct = accountLabel(s)
    const bg = s.work?.bg
    const tip = `${titleOf(s)}\n${STATE_WORD[st] ?? st} · ${modelName(s.model)} · ${acct}${sub0(s) ? ` · ${sub0(s)}` : ''}${s.spawnedBy ? ' · opened by the conductor' : ''}${s.group ? ` · in ${s.group}` : ''}${bg?.length ? `\n${bgTip(bg)}` : ''}\nDrag to move or split · double-click to rename · right-click for more`
    const eta = bgShort(bg)
    const sub = sub0(s)
    const tint = colourOfChat(id)
    const dup = s.elsewhere
      ? `<em class="ws-dup" title="Also open in ${esc(s.elsewhere)}: close it there, or end it here">2×</em>`
      : ''
    const badge = manyAccounts()
      ? `<em class="ws-ac" style="--ac:${accountColour(s.account)}" title="Claude account: ${esc(acct)}">${esc(acct.slice(0, 1).toUpperCase())}</em>`
      : ''
    const lead = s.role === 'conductor'
    return `<button type="button" role="tab" aria-selected="${g.active === id}" class="ws-chat st-${st}${g.active === id ? ' on' : ''}${tint ? ' tinted' : ''}${lead ? ' conductor' : ''}${lead && s.autopilot ? ' away' : ''}" data-chat="${esc(id)}" draggable="true" title="${esc(lead ? `Conductor${s.autopilot ? ' · autopilot on' : ''}\n${tip}` : tip)}"${tint ? ` style="--ws:${tint}"` : ''}>
          <i class="ws-st"></i>${lead ? '<span class="ws-crown" aria-label="Conductor">♛</span>' : ''}<span class="ws-t">${esc(titleOf(s))}</span>${sub ? `<em class="ws-rp" title="${esc(sub)}">${esc(sub)}</em>` : ''}${eta ? `<em class="ws-eta">${esc(eta)}</em>` : ''}${dup}${badge}<b data-x="${esc(id)}" title="End chat" aria-label="End chat">×</b>
        </button>`
  }

  /** repaint every group's tabs in place (their chats stay mounted) */
  function paintWsBar(ws: Workspace) {
    if (ws.path === activeWs) paintViews()
    if (ws.drag || ws.renaming) return
    for (const col of ws.cols.querySelectorAll<HTMLElement>(':scope > .ws-col')) {
      const gi = Number(col.dataset.g)
      const g = ws.groups[gi]
      if (!g) continue
      col.classList.toggle('focus', gi === ws.focus)
      const tint = g.active !== 'new' ? colourOfChat(g.active) : undefined
      if (tint) col.style.setProperty('--ws', tint)
      else col.style.removeProperty('--ws')
      col.classList.toggle('tinted', !!tint)
      const view = g.active !== 'new' ? views.get(g.active) : undefined
      if (view) paintViewChips(view)
      const bar = col.querySelector<HTMLElement>('.ws-chats') as HTMLElement
      const html = g.tabs.map((id) => tabHtml(g, id)).join('')
      if (bar.dataset.html !== html) {
        bar.dataset.html = html
        bar.innerHTML = html
      }
      // keep the active tab in view, without fighting your own scrolling
      if (bar.dataset.on !== g.active) {
        bar.dataset.on = g.active
        const on = bar.querySelector<HTMLElement>('.ws-chat.on')
        if (on) {
          const l = on.offsetLeft - 24
          const r = on.offsetLeft + on.offsetWidth + 24
          if (l < bar.scrollLeft) bar.scrollLeft = l
          else if (r > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = r - bar.clientWidth
        }
      }
      fades(bar)
    }
  }

  /** the workspace's views and terminal, in the panel header */
  function paintViews() {
    const box = $('views')
    const ws = activeWs ? workspaces.get(activeWs) : undefined
    box.hidden = !ws
    if (!ws) return
    for (const b of box.querySelectorAll<HTMLElement>('[data-view]'))
      b.classList.toggle('on', b.dataset.view === ws.pane)
    box.querySelector('[data-view="term"]')?.classList.toggle('on', ws.term.isOpen())
    ;(box.querySelector('[data-view="build"]') as HTMLElement).hidden = !ws.build
    ;(box.querySelector('[data-el="nchg"]') as HTMLElement).textContent = ws.changeCount
      ? String(ws.changeCount)
      : ''
    box.style.setProperty('--ws', ws.colour)
  }

  // ------------------------------------------------ following the bottom of a chat
  /*
   * The rule: only a gesture of yours — the wheel, a finger, the scrollbar, a scrolling key —
   * may stop a chat following its latest message. A scroll we caused ourselves, and the log
   * growing under a reply that is still streaming, never count.
   *
   * That was the whole of the old bug: the scroll listener recomputed `stick` from the
   * position on every scroll event, and during a stream more content had already rendered by
   * the time the event arrived, so the check read as "you scrolled up" and following stopped
   * on its own. The old follow loop also gave up after 60 frames, which is too short for
   * images, code blocks and tool output that lay out late.
   */
  /** how far off the bottom still counts as the bottom — generous on purpose */
  const BOTTOM_SLACK = 140
  /** a scroll this soon after one of your gestures is yours; anything else is the page moving */
  const GESTURE_MS = 320
  /** our own scrollTop writes stay invisible to the scroll listener for this long */
  const SELF_MS = 120
  /** the keys that scroll a log: pressing one is you moving, the same as the wheel */
  const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

  /** scroll to the bottom ourselves, and mark it as ours so the listener ignores it */
  function toBottom(v: View) {
    if (!v.log.isConnected) return
    v.selfAt = performance.now()
    v.log.scrollTop = v.log.scrollHeight
  }

  /** a chat on screen always opens at its latest message */
  function pinBottom(v: View) {
    v.stick = true
    const btn = v.root.querySelector<HTMLElement>('.ss-latest')
    if (btn) btn.hidden = true
    toBottom(v)
    // one more after this frame's layout, for messages that only get their real height once
    // they are on screen. Everything after that is the growth watchers in makeView, so there
    // is no frame budget left to run out on late images, code blocks or tool output.
    requestAnimationFrame(() => {
      if (v.stick) toBottom(v)
    })
  }
  /**
   * Put a view back where it was after a repaint.
   *
   * paintCols() rebuilds every column and re-parents each chat's element, and re-parenting a
   * scroller resets its scrollTop. That is why this used to pin to the bottom unconditionally —
   * which meant any background refresh (a chat changing state, one arriving or leaving) yanked
   * you back down while you were reading further up. So: a chat arriving on screen lands at its
   * latest message, a chat that is following keeps following, and a chat you have scrolled back
   * in is put back on the exact pixel it was on.
   */
  function keepPlace(v: View) {
    if (!v.root.isConnected) return pinBottom(v)
    if (v.stick) return void requestAnimationFrame(() => pinBottom(v))
    const was = v.log.scrollTop
    requestAnimationFrame(() => {
      if (!v.log.isConnected || v.log.scrollTop === was) return
      v.selfAt = performance.now()
      v.log.scrollTop = was
    })
  }

  const pinShown = (ws: Workspace) => {
    for (const g of ws.groups) {
      const v = views.get(g.active)
      if (v) pinBottom(v)
    }
  }

  /** the dock widens while the workspace on screen has groups side by side */
  const syncWidth = () => {
    const ws = activeWs ? workspaces.get(activeWs) : undefined
    const n = open && ws && ws.pane === 'chats' ? ws.groups.length : 1
    // full screen uses the width; the dock keeps the width you gave it, so switching between
    // repos with different numbers of groups never reflows the page (or resizes the map)
    root.classList.toggle('wide', (n > 1 || spread.length > 1) && !docked)
    root.classList.remove('wide3')
    document.body.classList.remove('ss-wide', 'ss-wide3')
  }

  function bodyFor(ws: Workspace, g: Group): HTMLElement {
    const id = g.active
    if (id !== 'new') {
      const s = summaries.find((x) => x.id === id)
      let v = views.get(id)
      if (!v && s) {
        v = makeView(s)
        views.set(id, v)
      }
      if (v) {
        unread.delete(id)
        v.composer.setBusy(v.s.state === 'running' || v.s.state === 'starting')
        keepPlace(v)
        return v.root
      }
    }
    return draftFor(ws, g).el
  }

  /** build the groups: a tab bar over each, dividers between */
  function paintCols(ws: Workspace) {
    placeChats(ws)
    for (const g of ws.groups) {
      if (!g.tabs.includes(g.active)) g.active = g.tabs[0] ?? 'new'
      if (g.active === 'new' && !g.tabs.includes('new')) g.tabs.push('new')
    }
    if (ws.sizes.length !== ws.groups.length) ws.sizes = Array(ws.groups.length).fill(1)
    const n = ws.groups.length
    const grid = isGrid(ws)
    ws.cols.classList.toggle('split', n > 1)
    ws.cols.classList.toggle('grid', grid)
    if (ws.path === activeWs) syncWidth()
    const cols = ws.groups.map((g, gi) => {
      const col = el('div', `ws-col${gi === ws.focus ? ' focus' : ''}`)
      col.dataset.g = String(gi)
      col.innerHTML = `<div class="ws-gbar">
          <div class="ws-strip"><div class="ws-chats" role="tablist" aria-label="Chats"></div></div>
          <button type="button" class="ws-btn ws-new" data-gact="new" title="New chat here (N)" aria-label="New chat">${ICON.plus}</button>
          <span class="ws-gfill"></span>
          <button type="button" class="ws-btn" data-gact="split" title="Split right: a new chat beside (⌥⌘\\)" aria-label="Split right">${ICON.split}</button>
          <button type="button" class="ws-btn" data-gact="more" title="Chats and group actions" aria-label="More">${ICON.more}</button>
        </div>
        <div class="ws-gbody"></div>`
      ;(col.querySelector('.ws-gbody') as HTMLElement).appendChild(bodyFor(ws, g))
      return col
    })
    const grip = (i: number, h = false) => {
      const g = el('div', h ? 'ws-rz h' : 'ws-rz')
      g.dataset.rz = String(i)
      g.title = 'Drag to resize · double-click to even out'
      return g
    }
    // a grid has a divider between each pair of its columns and each pair of its rows
    const shape = gridShape(n)
    const grips = grid
      ? [
          ...Array.from({ length: shape.c - 1 }, (_, i) => grip(i)),
          ...Array.from({ length: shape.r - 1 }, (_, i) => grip(i, true)),
        ]
      : Array.from({ length: n - 1 }, (_, i) => grip(i))
    ws.cols.replaceChildren(...cols, ...grips)
    ws.built = true
    layoutCols(ws)
    paintWsBar(ws)
  }

  /** a grid needs at least three groups; with fewer it is plain columns */
  const isGrid = (ws: Workspace) => ws.grid && ws.groups.length >= 3
  /** a grid's shape: as square as it goes, so it wraps as it grows (5 and 6 are 3×2, 7 to 9 are 3×3) */
  const gridShape = (n: number) => {
    const c = Math.ceil(Math.sqrt(n))
    return { c, r: Math.ceil(n / c) }
  }
  /**
   * Tracks that keep their proportions down to a readable minimum and no further: the smallest
   * track's floor is `min`, the others' floors keep the same ratio, so a row either fits at its
   * fractions or is every floor at once and scrolls. Returns the template and where each boundary
   * sits once it is at its floors.
   */
  const tracks = (sz: number[], min: number, gap = 0) => {
    const lo = Math.min(...sz)
    const floors = sz.map((f) => Math.round((min * f) / lo))
    const at: number[] = []
    let acc = 0
    for (const [k, f] of floors.entries()) {
      acc += f
      at.push(acc + gap * k)
    }
    return {
      template: sz.map((f, k) => `minmax(${floors[k]}px, ${f}fr)`).join(' '),
      at,
      floor: acc,
    }
  }
  /** a boundary as a fraction of the visible width, or at its floors once it scrolls */
  const edge = (frac: number, px: number) => `max(calc(${frac * 100}% - 4px), ${px - 4}px)`

  function layoutCols(ws: Workspace) {
    const n = ws.groups.length
    const sum = (a: number[], k = a.length) => a.slice(0, k).reduce((x, y) => x + y, 0)
    if (isGrid(ws)) {
      const { c, r } = gridShape(n)
      const cs = Array.from({ length: c }, (_, k) => ws.sizes[k] ?? 1)
      if (ws.rows.length !== r) ws.rows = Array(r).fill(1)
      const X = tracks(cs, MIN_GROUP_W, 1)
      const Y = tracks(ws.rows, MIN_GROUP_H, 1)
      ws.cols.style.gridTemplateColumns = X.template
      ws.cols.style.gridTemplateRows = Y.template
      // a short last row: its last group takes the rest of the row (three is two over one)
      const short = n % c !== 0
      for (const col of ws.cols.querySelectorAll<HTMLElement>('.ws-col'))
        col.style.gridColumn =
          short && Number(col.dataset.g) === n - 1 ? `${((n - 1) % c) + 1} / -1` : ''
      const lastTop = edge(sum(ws.rows, r - 1) / sum(ws.rows), (Y.at[r - 2] ?? 0) + 4)
      for (const g of ws.cols.querySelectorAll<HTMLElement>('.ws-rz')) {
        const k = Number(g.dataset.rz)
        if (g.classList.contains('h')) {
          g.style.top = edge(sum(ws.rows, k + 1) / sum(ws.rows), Y.at[k] ?? 0)
          g.style.width = `max(100%, ${X.floor + c - 1}px)`
        } else {
          g.style.left = edge(sum(cs, k + 1) / sum(cs), X.at[k] ?? 0)
          // down the grid, stopping above a short last row that spans it
          g.style.height = short && r > 1 ? lastTop : `max(100%, ${Y.floor + r - 1}px)`
          g.style.bottom = 'auto'
        }
      }
      ws.el.style.setProperty('--ws-min', `${X.floor + c - 1}px`)
      return
    }
    for (const col of ws.cols.querySelectorAll<HTMLElement>('.ws-col')) col.style.gridColumn = ''
    const X = tracks(ws.sizes, MIN_GROUP_W)
    ws.cols.style.gridTemplateRows = ''
    ws.cols.style.gridTemplateColumns = X.template
    for (const g of ws.cols.querySelectorAll<HTMLElement>('.ws-rz')) {
      const k = Number(g.dataset.rz)
      g.style.left = edge(sum(ws.sizes, k + 1) / sum(ws.sizes), X.at[k] ?? 0)
      g.style.height = ''
      g.style.bottom = ''
    }
    // side by side, a project column is never narrower than its groups' floors: the page scrolls
    ws.el.style.setProperty('--ws-min', `${X.floor}px`)
  }

  /**
   * Drag a divider, in pixels, under the pointer. When the row fits, the groups either side trade
   * width until the far one reaches its floor, and past that the near one keeps growing and the
   * row scrolls. When the row already scrolls, only the near group changes and the row gets
   * longer or shorter. Nothing goes under its floor.
   */
  function resizeCols(ws: Workspace, grip: HTMLElement, e: PointerEvent) {
    e.preventDefault()
    const i = Number(grip.dataset.rz)
    const across = grip.classList.contains('h')
    const n = ws.groups.length
    const { c, r } = isGrid(ws) ? gridShape(n) : { c: n, r: 1 }
    const cells = [...ws.cols.querySelectorAll<HTMLElement>('.ws-col')]
    // one cell per track: along the first row for columns, down the first column for rows
    const px0 = Array.from({ length: across ? r : c }, (_, k) => {
      const box = cells[across ? k * c : k]?.getBoundingClientRect()
      return (across ? box?.height : box?.width) ?? 0
    })
    if (!px0[i] || !px0[i + 1]) return
    const sizes = across ? ws.rows : ws.sizes
    const min = across ? MIN_GROUP_H : MIN_GROUP_W
    const over = across
      ? ws.cols.scrollHeight > ws.cols.clientHeight + 1
      : ws.cols.scrollWidth > ws.cols.clientWidth + 1
    const from = across ? e.clientY : e.clientX
    const [a0, b0] = [px0[i] as number, px0[i + 1] as number]
    grip.setPointerCapture(e.pointerId)
    grip.classList.add('drag')
    ws.cols.classList.add('resizing')
    const move = (m: PointerEvent) => {
      const d = (across ? m.clientY : m.clientX) - from
      const px = [...px0]
      if (d >= 0) {
        px[i] = a0 + d
        px[i + 1] = over ? b0 : Math.max(min, b0 - d)
      } else {
        const take = Math.min(-d, a0 - min)
        px[i] = a0 - take
        px[i + 1] = over ? b0 : b0 + take
      }
      // the sizes are the pixel widths, scaled to average 1: at its floors the row is these widths
      const avg = px.reduce((x, y) => x + y, 0) / px.length
      for (const [k, w] of px.entries()) sizes[k] = w / avg
      layoutCols(ws)
    }
    const up = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.classList.remove('drag')
      ws.cols.classList.remove('resizing')
      saveWs(ws)
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
  }

  /** bring a group into view when it is scrolled out of it: after a split, a move, a focus key */
  const revealGroup = (ws: Workspace, gi: number) =>
    ws.cols
      .querySelector<HTMLElement>(`.ws-col[data-g="${gi}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })

  function focusInput(ws: Workspace) {
    const g = focused(ws)
    const v = g.active !== 'new' ? views.get(g.active) : undefined
    const target = v
      ? (v.log.querySelector<HTMLElement>('.m-ask:not(.sent) .opt') ?? v.composer.input)
      : ws.drafts.get(g.id)?.composer.input
    target?.focus({ preventScroll: true })
  }

  /**
   * Show a chat. One already in a group is revealed where it is; one in no group yet opens in
   * group `gi` (the focused group by default). 'new' is that group's draft.
   */
  function showChat(ws: Workspace, id: string, gi = ws.focus) {
    if (ws.pane !== 'chats') setPane(ws, 'chats', false)
    gi = Math.max(0, Math.min(gi, ws.groups.length - 1))
    unread.delete(id)
    let at = id === 'new' ? gi : groupIndex(ws, id)
    if (at < 0) {
      at = gi
      addChat(ws, id)
      const into = ws.groups[at] as Group
      into.tabs.splice(into.tabs.filter((t) => t !== 'new').length, 0, id)
      // a blank draft it lands beside is not worth a tab
      if (into.active === 'new' && !ws.drafts.get(into.id)?.composer.input.value) {
        into.tabs = into.tabs.filter((t) => t !== 'new')
        ws.drafts.delete(into.id)
        into.active = 'new'
      }
    }
    const g = ws.groups[at] as Group
    if (id === 'new' && !g.tabs.includes('new')) g.tabs.push('new')
    if (g.active === id && ws.focus === at && ws.built) {
      // already there: focus it, and leave the tabs alone so a double-click can rename
      focusInput(ws)
      return focusRing()
    }
    const swap = g.active !== id
    g.active = id
    ws.focus = at
    if (swap) {
      const body = ws.cols.querySelector<HTMLElement>(`.ws-col[data-g="${at}"] .ws-gbody`)
      if (body && ws.built) body.replaceChildren(bodyFor(ws, g))
      else paintCols(ws)
    }
    paintWsBar(ws)
    saveWs(ws)
    focusInput(ws)
    focusRing()
  }

  function focusGroup(ws: Workspace, gi: number, withInput = true) {
    if (ws.pane !== 'chats') setPane(ws, 'chats')
    const g = ws.groups[gi]
    if (!g) return
    ws.focus = gi
    unread.delete(g.active)
    paintWsBar(ws)
    revealGroup(ws, gi)
    saveWs(ws)
    if (withInput) focusInput(ws)
    focusRing()
  }

  type Target = { group: number; index?: number } | { newAt: number }
  /** move a chat's tab: to a place in a group, or into a new group at a position */
  function moveChat(ws: Workspace, id: string, to: Target) {
    if (ws.pane !== 'chats') setPane(ws, 'chats', false)
    const from = groupIndex(ws, id)
    const src = ws.groups[from]
    if (!src) return
    let dst: Group
    let index = 'index' in to ? to.index : undefined
    if ('newAt' in to) {
      if (src.tabs.length === 1) {
        // its own group, split off to where it already is: nothing to do but move the group
        const at = Math.max(0, Math.min(to.newAt, ws.groups.length))
        if (at === from || at === from + 1) return focusGroup(ws, from)
      }
      dst = newGroup(ws, [])
      ws.groups.splice(Math.max(0, Math.min(to.newAt, ws.groups.length)), 0, dst)
      ws.sizes = Array(ws.groups.length).fill(1)
    } else dst = ws.groups[to.group] ?? src
    const i = src.tabs.indexOf(id)
    src.tabs.splice(i, 1)
    if (src === dst && index !== undefined && index > i) index -= 1
    if (src !== dst && src.active === id) {
      const rest = src.tabs.filter((t) => t !== 'new')
      src.active = rest[Math.min(i, rest.length - 1)] ?? (src.tabs.includes('new') ? 'new' : '')
    }
    const real = dst.tabs.filter((t) => t !== 'new').length
    dst.tabs.splice(Math.max(0, Math.min(index ?? real, real)), 0, id)
    dst.active = id
    // a group that only held a blank draft goes once a chat is moved in beside it
    if (dst.tabs.includes('new') && !ws.drafts.get(dst.id)?.composer.input.value) {
      dst.tabs = dst.tabs.filter((t) => t !== 'new')
      ws.drafts.delete(dst.id)
    }
    tidyGroups(ws, [src])
    ws.focus = Math.max(0, ws.groups.indexOf(dst))
    paintCols(ws)
    revealGroup(ws, ws.focus)
    saveWs(ws)
    focusInput(ws)
    focusRing()
  }

  function splitRight(ws: Workspace, gi = ws.focus) {
    if (ws.pane !== 'chats') setPane(ws, 'chats', false)
    ws.groups.splice(gi + 1, 0, newGroup(ws))
    ws.sizes = Array(ws.groups.length).fill(1)
    // a split never changes the layout under you: a row stays a row (and scrolls past what
    // fits), a grid takes the new group into its tiling
    ws.focus = gi + 1
    paintCols(ws)
    revealGroup(ws, ws.focus)
    saveWs(ws)
    focusInput(ws)
    focusRing()
  }

  /**
   * The groups as a grid: at least two by two (it adds new-chat groups up to four), and past four
   * it wraps as square as it goes — 3×2, then 3×3 — rather than stopping. Again: back to a row.
   */
  function quad(ws: Workspace, on = !isGrid(ws)) {
    if (ws.pane !== 'chats') setPane(ws, 'chats', false)
    if (on) {
      while (ws.groups.length < 4) ws.groups.push(newGroup(ws))
      ws.grid = true
    } else ws.grid = false
    ws.sizes = Array(ws.groups.length).fill(1)
    ws.rows = [1, 1]
    paintCols(ws)
    saveWs(ws)
    focusInput(ws)
    focusRing()
  }

  /** close a group: its chats keep running and move to the group beside it */
  function closeGroup(ws: Workspace, gi: number) {
    const g = ws.groups[gi]
    if (!g || ws.groups.length < 2) return
    const into = ws.groups[gi > 0 ? gi - 1 : gi + 1] as Group
    const moving = g.tabs.filter((t) => t !== 'new')
    into.tabs = [
      ...into.tabs.filter((t) => t !== 'new'),
      ...moving,
      ...into.tabs.filter((t) => t === 'new'),
    ]
    if (g.active !== 'new' && moving.includes(g.active))
      into.active = into.active === 'new' ? g.active : into.active
    ws.groups.splice(gi, 1)
    ws.sizes.splice(gi, 1)
    ws.drafts.delete(g.id)
    ws.focus = ws.groups.indexOf(into)
    tidyGroups(ws)
    paintCols(ws)
    saveWs(ws)
    focusInput(ws)
    focusRing()
  }

  function closeDraft(ws: Workspace, g: Group) {
    const others = g.tabs.filter((t) => t !== 'new')
    if (!others.length && ws.groups.length < 2) return focusInput(ws) // the last group keeps its draft
    ws.drafts.delete(g.id)
    g.tabs = others
    if (g.active === 'new') g.active = others.at(-1) ?? ''
    tidyGroups(ws)
    paintCols(ws)
    saveWs(ws)
    focusInput(ws)
  }

  function stepChat(ws: Workspace, d: number) {
    const g = focused(ws)
    if (g.tabs.length < 2) return
    const i = g.tabs.indexOf(g.active)
    showChat(ws, g.tabs[(i + d + g.tabs.length) % g.tabs.length] as string, ws.focus)
  }

  function startRename(ws: Workspace, id: string) {
    const s = summaryOf(id)
    const tab = ws.el.querySelector<HTMLElement>(`.ws-chat[data-chat="${CSS.escape(id)}"]`)
    const bar = tab?.parentElement
    const strip = bar?.parentElement
    if (!s || !tab || !bar || !strip || ws.renaming) return
    const l = tab.offsetLeft - 24
    if (l < bar.scrollLeft) bar.scrollLeft = l
    ws.renaming = true
    const input = document.createElement('input')
    input.className = 'ws-rename'
    input.value = titleOf(s)
    input.placeholder = s.title || 'Chat name'
    input.setAttribute('aria-label', 'Chat name')
    input.style.left = `${tab.offsetLeft - bar.scrollLeft}px`
    input.style.width = `${Math.min(Math.max(tab.offsetWidth, 200), strip.clientWidth)}px`
    strip.appendChild(input)
    input.focus()
    input.select()
    let done = false
    const finish = (save: boolean) => {
      if (done) return
      done = true
      if (save) rename(s, input.value)
      input.remove()
      ws.renaming = false
      paintWsBar(ws)
      paintWidget()
    }
    input.addEventListener('keydown', (k) => {
      k.stopPropagation()
      if (k.key === 'Enter') {
        k.preventDefault()
        finish(true)
      }
      if (k.key === 'Escape') finish(false)
    })
    input.addEventListener('blur', () => finish(true))
  }

  /** a small picture of the groups on screen, with one of them lit */
  function groupGlyph(ws: Workspace, lit: number) {
    const n = ws.groups.length
    const cells: [number, number, number, number][] = isGrid(ws)
      ? ([[0, 0, 1, 1], [1, 0, 1, 1], n === 3 ? [0, 1, 2, 1] : [0, 1, 1, 1], [1, 1, 1, 1]].slice(
          0,
          n,
        ) as [number, number, number, number][])
      : Array.from({ length: n }, (_, i) => [i, 0, 1, 2] as [number, number, number, number])
    const cols = isGrid(ws) ? 2 : n
    const W = 14
    const H = 10
    const cw = W / cols
    const ch = H / 2
    const rects = cells
      .map(
        ([x, y, w, h], i) =>
          `<rect x="${(x * cw + 0.6).toFixed(2)}" y="${(y * ch + 0.6).toFixed(2)}" width="${(w * cw - 1.2).toFixed(2)}" height="${(h * ch - 1.2).toFixed(2)}" rx="1"${i === lit ? ' class="lit"' : ''}/>`,
      )
      .join('')
    return `<svg class="gm-glyph" viewBox="0 0 ${W} ${H}" width="${W + 2}" height="${H + 2}" aria-hidden="true">${rects}</svg>`
  }

  // ------------------------------------------------------------ chat groups (chat-groups.ts)
  /** the chat groups you folded away in the lists */
  const folded = collapsedGroups()
  const chatGroupHead = (g: string, n: number, cls: string) =>
    `<div class="cg-h ${cls}${folded.has(g) ? ' folded' : ''}" data-cg="${esc(g)}" role="button" aria-expanded="${!folded.has(g)}" title="${folded.has(g) ? 'Show' : 'Hide'} the chats in ${esc(g)}"><i class="cg-car">▾</i><span>${esc(g)}</span><small>${n}</small></div>`
  /** a list's rows with a group's chats together under its name; a folded group shows only its name */
  const withChatGroups = <T>(
    list: readonly T[],
    groupOf: (x: T) => unknown,
    rowOf: (x: T) => string,
    cls: string,
  ) =>
    groupRuns(list, groupOf)
      .map((r) =>
        r.group
          ? chatGroupHead(r.group, r.items.length, cls) +
            (folded.has(r.group) ? '' : r.items.map(rowOf).join(''))
          : r.items.map(rowOf).join(''),
      )
      .join('')
  /** a chat moved to a group, or out of any ("Move to group…"): the host keeps it */
  async function moveToGroup(id: string, group: string | null) {
    const r = await post(`/sessions/${encodeURIComponent(id)}/group`, { group: group ?? '' }).catch(
      () => null,
    )
    if (!r?.ok) return noServer('Could not move that chat')
    const got = (await r.json().catch(() => null)) as Summary | null
    const g = got ? (got.group ?? null) : tidyGroup(group)
    for (const x of [summaries.find((y) => y.id === id), views.get(id)?.s]) if (x) x.group = g
    if (!$('history').hidden) paintLibRows()
    refresh()
  }
  async function newGroupFor(id: string) {
    const to = await ask({
      title: 'New group',
      body: 'Chats in a group are listed together under its name, e.g. the project they are for.',
      input: '',
      ok: 'Move',
    })
    if (typeof to === 'string' && tidyGroup(to)) moveToGroup(id, to)
  }
  /** "Move to group…" on a chat: the groups in use, a new one, or none */
  function groupPicker(ws: Workspace, id: string, x: number, y: number) {
    const s = summaryOf(id)
    if (!s) return
    cmenuFor = { ws, id }
    const now = tidyGroup(s.group)
    const item = (k: string, label: string, on = false) =>
      `<button type="button" role="menuitem" data-cm="${esc(k)}"${on ? ' disabled' : ''}><span>${esc(label)}</span>${on ? '<kbd>✓</kbd>' : ''}</button>`
    const groups = knownGroups(summaries)
    cmenu.innerHTML = [
      `<div class="cm-h"><span>Move “${esc(titleOf(s))}” to</span></div>`,
      ...groups.map((g) => item(`cg:${g}`, g, g === now)),
      groups.length ? '<hr>' : '',
      item('cg-new', 'New group…'),
      item('cg-none', 'No group', !now),
    ].join('')
    cmenu.style.setProperty('--wsc', ws.colour)
    cmenu.hidden = false
    cmenu.style.left = `${Math.min(x, innerWidth - cmenu.offsetWidth - 8)}px`
    cmenu.style.top = `${Math.min(y, innerHeight - cmenu.offsetHeight - 8)}px`
    ;(cmenu.querySelector('button:not([disabled])') as HTMLElement | null)?.focus()
  }

  /** the ⋯ menu on a group's tab bar: the folder's chats by where they are, and the layout */
  function groupMenu(ws: Workspace, gi: number, anchor: HTMLElement) {
    const n = ws.groups.length
    const chats = ws.chats.map((id) => summaryOf(id)).filter((s): s is Summary => !!s)
    const count = (k: string) => chats.filter((s) => stateOf(s) === k).length
    const need = count('waiting')
    const busy = count('running') + count('starting')
    const done = count('unread')
    const tally = [
      need ? `<span class="gm-need">${need} need${need === 1 ? 's' : ''} you</span>` : '',
      busy ? `<span class="gm-busy">${busy} working</span>` : '',
      done ? `<span class="gm-done">${done} finished</span>` : '',
    ]
      .filter(Boolean)
      .join('')

    const row = (s: Summary, at: number) => {
      const st = stateOf(s)
      const shownHere = at === gi && ws.groups[gi]?.active === s.id
      const shownThere = at >= 0 && at !== gi && ws.groups[at]?.active === s.id
      const badge = shownHere
        ? '<small class="gm-on">On screen</small>'
        : shownThere
          ? '<small class="gm-on">Shown</small>'
          : ''
      const here =
        at !== gi
          ? `<button type="button" class="gm-x" data-val="__here:${esc(s.id)}" title="Move into this group" aria-label="Move into this group">${ICON.here}</button>`
          : ''
      return `<div class="pop-i chat gm-row${shownHere ? ' on' : ''}" role="menuitem" tabindex="-1" data-val="${esc(s.id)}" data-st="${st}">
        <i class="ws-st st-${st}"></i>
        <span><b>${esc(titleOf(s))}</b><em>${esc(STATE_WORD[st] ?? st)}${bgShort(s.work?.bg) ? ` · ${esc(bgShort(s.work?.bg))}` : ''} · ${esc(modelName(s.model))} · ${esc(ago(s.updatedAt))}</em></span>
        ${badge}
        <span class="gm-acts">${here}<button type="button" class="gm-x end" data-val="__end:${esc(s.id)}" title="End chat…" aria-label="End chat">×</button></span>
      </div>`
    }
    const section = (label: string, glyph: string, list: string) =>
      list ? `<div class="gm-sec">${glyph}<span>${label}</span></div>${list}` : ''
    const inGroup = (k: number) =>
      (ws.groups[k]?.tabs ?? [])
        .filter((id) => id !== 'new')
        .map((id) => chats.find((s) => s.id === id))
        .filter((s): s is Summary => !!s)
    // within each, a chat group's chats together under its name
    const rows = (list: Summary[], k: number) =>
      withChatGroups(
        list,
        (s) => s.group,
        (s) => row(s, k),
        'gm-cg',
      )
    const loose = rows(
      chats.filter((s) => groupIndex(ws, s.id) < 0),
      -1,
    )
    const order = [gi, ...ws.groups.map((_, k) => k).filter((k) => k !== gi)]
    const sections =
      n > 1
        ? order
            .map((k) =>
              section(
                k === gi ? `This group` : `Group ${k + 1}`,
                groupGlyph(ws, k),
                rows(inGroup(k), k),
              ),
            )
            .join('') + section('Not on screen', '', loose)
        : rows(inGroup(0), 0) + section('Not on screen', '', loose)

    const tile = (val: string, icon: string, label: string, key: string, off = false, hint = '') =>
      `<button type="button" class="gm-tile" data-val="${val}"${off ? ' disabled' : ''} title="${esc(hint || label)}${key ? ` (${key})` : ''}"><span class="gm-ti">${icon}</span><b>${label}</b>${key ? `<kbd>${key}</kbd>` : '<kbd class="none"></kbd>'}</button>`

    showPop(
      anchor,
      `<div class="gm-head"><b>${esc(ws.name)}</b><span class="gm-tally">${tally || `<span>${chats.length ? `${chats.length} chat${chats.length === 1 ? '' : 's'}, all quiet` : 'No chats yet'}</span>`}</span></div>
       ${chats.length ? sections : '<p class="pop-empty">No chats running in this folder yet. Start one below.</p>'}
       <div class="gm-foot">
         <div class="gm-tiles">
           ${tile('__new', ICON.plus, 'New chat', 'N', false, 'New chat in this group')}
           ${tile('__split', ICON.split, 'Split', '⌥⌘\\', false, 'Split right: a new group beside this one')}
           ${tile('__quad', isGrid(ws) ? ICON.split : ICON.quad, isGrid(ws) ? 'Row' : 'Grid', '⌥⌘G', false, isGrid(ws) ? 'Put the groups back in one row' : 'The groups as a grid: two by two, wrapping past four')}
           ${tile('__even', ICON.even, 'Even', '', n < 2, 'Even out the group sizes')}
         </div>
         <div class="gm-links">
           <button type="button" data-val="__past">${ICON.past}<span>Past chats</span></button>
           ${n > 1 ? `<button type="button" data-val="__close" title="Its chats keep running, in the group beside">×<span>Close group</span></button>` : ''}
           <span class="gm-keys" title="Previous or next tab in this group"><kbd>⌥⌘[</kbd><kbd>]</kbd> tabs</span>
         </div>
       </div>`,
      (val) => {
        if (val === '__new') return showChat(ws, 'new', gi)
        if (val === '__split') return splitRight(ws, gi)
        if (val === '__quad') return quad(ws)
        if (val === '__close') return closeGroup(ws, gi)
        if (val === '__past') return toggleHistory(true)
        if (val === '__even') {
          ws.sizes = Array(ws.groups.length).fill(1)
          ws.rows = [1, 1]
          layoutCols(ws)
          return saveWs(ws)
        }
        if (val.startsWith('__here:')) {
          const id = val.slice(7)
          return groupIndex(ws, id) < 0 ? showChat(ws, id, gi) : moveChat(ws, id, { group: gi })
        }
        if (val.startsWith('__end:')) return void endChat(ws, val.slice(6))
        showChat(ws, val, gi)
      },
      chats.length > 5,
      'gmenu',
    )
    pop.style.setProperty('--ws', ws.colour)
    // a chat group's name folds its chats away, or shows them again
    const pick = pop.onclick
    pop.onclick = (e) => {
      const h = (e.target as HTMLElement).closest<HTMLElement>('[data-cg]')
      if (!h) return pick?.call(pop, e)
      folded.toggle(h.dataset.cg as string)
      groupMenu(ws, gi, anchor)
    }
  }

  // right-click on a chat tab
  const cmenu = el('div', 'ss-menu ws-cmenu')
  cmenu.setAttribute('role', 'menu')
  cmenu.hidden = true
  document.body.appendChild(cmenu)
  let cmenuFor: { ws: Workspace; id: string } | null = null
  function chatMenu(ws: Workspace, id: string, x: number, y: number) {
    const s = summaryOf(id)
    if (!s) return
    cmenuFor = { ws, id }
    const gi = groupIndex(ws, id)
    const g = ws.groups[gi]
    const i = g ? g.tabs.indexOf(id) : -1
    const n = ws.groups.length
    const item = (k: string, label: string, hint = '', off = false, cls = '') =>
      `<button type="button" role="menuitem" class="${cls}" data-cm="${k}"${off ? ' disabled' : ''}><span>${label}</span>${hint ? `<kbd>${hint}</kbd>` : ''}</button>`
    const alone = (g?.tabs.filter((t) => t !== 'new').length ?? 0) < 2
    cmenu.innerHTML = [
      `<div class="cm-h"><i class="ws-st st-${stateOf(s)}"></i><span>${esc(titleOf(s))}</span></div>`,
      item(
        'right',
        gi < n - 1 ? 'Move to the group on the right' : 'Split right',
        '⌃⌘→',
        gi === n - 1 && alone,
      ),
      item(
        'left',
        gi > 0 ? 'Move to the group on the left' : 'Split left',
        '⌃⌘←',
        gi === 0 && alone,
      ),
      '<hr>',
      item('rename', 'Rename…', 'double-click'),
      item('group', 'Move to group…', esc(s.group ?? '')),
      `<div class="cm-colours" role="group" aria-label="Colour">${[null, ...PALETTE]
        .map((c) => {
          const on = (colourOfChat(id) ?? null) === c
          return `<button type="button" data-cm="colour:${c ?? ''}" class="${on ? 'on' : ''}" title="${c ? 'Colour this chat' : 'Repo colour'}" aria-label="${c ? `Colour ${c}` : 'Repo colour'}" style="--sw:${c ?? 'var(--wsc)'}"></button>`
        })
        .join('')}</div>`,
      item('tleft', 'Move tab left', '', i <= 0),
      item('tright', 'Move tab right', '', !g || i >= g.tabs.filter((t) => t !== 'new').length - 1),
      s.sdkSessionId ? item('copy', 'Copy session ID') : '',
      '<hr>',
      item('end', 'End chat…', 'middle-click', false, 'danger'),
    ].join('')
    cmenu.style.setProperty('--wsc', ws.colour)
    cmenu.hidden = false
    cmenu.style.left = `${Math.min(x, innerWidth - cmenu.offsetWidth - 8)}px`
    cmenu.style.top = `${Math.min(y, innerHeight - cmenu.offsetHeight - 8)}px`
    ;(cmenu.querySelector('button:not([disabled])') as HTMLElement | null)?.focus()
  }
  const hideCmenu = () => {
    cmenu.hidden = true
    cmenuFor = null
  }
  addEventListener('pointerdown', (e) => {
    if (!cmenu.hidden && !cmenu.contains(e.target as Node)) hideCmenu()
  })
  cmenu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      hideCmenu()
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const all = [...cmenu.querySelectorAll<HTMLElement>('button:not([disabled])')]
      const i = all.indexOf(document.activeElement as HTMLElement)
      all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus()
    }
  })
  /** the move a ⌃⌘← or ⌃⌘→ makes: into the next group, or a new one at the edge */
  function moveSideways(ws: Workspace, id: string, d: 1 | -1) {
    const gi = groupIndex(ws, id)
    if (gi < 0) return
    const next = gi + d
    if (next >= 0 && next < ws.groups.length) return moveChat(ws, id, { group: next })
    moveChat(ws, id, { newAt: d > 0 ? ws.groups.length : 0 })
  }
  cmenu.addEventListener('click', (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>('[data-cm]')?.dataset.cm
    const f = cmenuFor
    hideCmenu()
    if (!k || !f) return
    const { ws, id } = f
    if (k === 'right' || k === 'left') return moveSideways(ws, id, k === 'right' ? 1 : -1)
    if (k === 'rename') return startRename(ws, id)
    if (k === 'group')
      return groupPicker(
        ws,
        id,
        parseFloat(cmenu.style.left) || 0,
        parseFloat(cmenu.style.top) || 0,
      )
    if (k.startsWith('cg:')) return void moveToGroup(id, k.slice(3))
    if (k === 'cg-none') return void moveToGroup(id, null)
    if (k === 'cg-new') return void newGroupFor(id)
    if (k.startsWith('colour:')) {
      const s = summaryOf(id)
      if (!s) return
      setChatColour(s, k.slice(7) || null)
      return paintWsBar(ws)
    }
    if (k === 'tleft' || k === 'tright') {
      const g = ws.groups[groupIndex(ws, id)]
      if (!g) return
      const i = g.tabs.indexOf(id)
      const j = k === 'tleft' ? i - 1 : i + 1
      if (j < 0 || j >= g.tabs.length || g.tabs[j] === 'new') return
      ;[g.tabs[i], g.tabs[j]] = [g.tabs[j] as string, g.tabs[i] as string]
      saveWs(ws)
      return paintWsBar(ws)
    }
    if (k === 'copy') {
      const sid = summaryOf(id)?.sdkSessionId
      if (sid) navigator.clipboard?.writeText(sid).catch(() => {})
      return
    }
    if (k === 'end') return endChat(ws, id)
  })

  function setPane(ws: Workspace, p: Workspace['pane'], repaint = true) {
    ws.pane = p
    ws.cols.hidden = p !== 'chats'
    ;(ws.el.querySelector('[data-w="files"]') as HTMLElement).hidden = p !== 'files'
    ;(ws.el.querySelector('[data-w="changes"]') as HTMLElement).hidden = p !== 'changes'
    ;(ws.el.querySelector('[data-w="build"]') as HTMLElement).hidden = p !== 'build'
    if (p === 'build') ws.build?.open()
    if (p === 'files' && !ws.filesLoaded) {
      ws.filesLoaded = true
      ws.files.refresh()
    }
    if (p === 'changes') ws.changes.refresh()
    if (repaint) paintWsBar(ws)
    syncWidth()
    focusRing()
  }

  async function endChat(ws: Workspace, id: string) {
    const s = summaries.find((x) => x.id === id)
    const yes = await ask({
      title: `End “${titleOf(s)}”?`,
      body: 'Its conversation stays saved, and you can pick it up again from history.',
      ok: 'End chat',
      danger: true,
    })
    if (!yes) return
    // off the page now; the host is told in the background and asked again until it lets go
    ending.add(id)
    endOnHost(id)
    const v = views.get(id)
    v?.es?.close()
    v?.cockpit?.()
    v?.grow?.disconnect()
    v?.fit?.disconnect()
    v?.unwatch?.()
    if (v) disposeRunStrip(v.log)
    views.delete(id)
    if (!perChat) resubscribe()
    unread.delete(id)
    summaries = summaries.filter((x) => x.id !== id)
    ws.chats = ws.chats.filter((x) => x !== id)
    paintCols(ws)
    saveWs(ws)
    paintTabs()
  }

  function setWs(path: string | null) {
    const prev = activeWs
    activeWs = path
    const ws = path ? workspaces.get(path) : undefined
    if (!ws) {
      activeWs = null
      spread = []
      pane.classList.remove('duo')
      paintStart()
    } else {
      // a workspace not on screen takes the place of the side you were in
      if (spread.length && !spread.includes(ws.path)) {
        const side = prev ? spread.indexOf(prev) : -1
        spread[side < 0 ? spread.length - 1 : side] = ws.path
      }
      mountPane()
    }
    paintTabs()
    saveLayout()
    syncWidth()
    focusRing()
  }

  /** put the workspace (or those spread side by side) into the panel, moving nothing already there */
  const spreadGrips: HTMLElement[] = []
  const spreadGrip = (i: number) => {
    const have = spreadGrips[i]
    if (have) return have
    const g = el('div', 'ws-duo-grip')
    g.title = 'Drag to resize · double-click to even out'
    g.addEventListener('pointerdown', (e) => resizeSpread(i, g, e))
    g.addEventListener('dblclick', () => {
      spreadSizes = spread.map(() => 1)
      mountPane()
      saveLayout()
    })
    spreadGrips[i] = g
    return g
  }
  const flexSpread = () =>
    spread.forEach((p, i) => {
      const w = workspaces.get(p)
      if (w) w.el.style.flex = `${spreadSizes[i] ?? 1} 1 0`
    })
  function mountPane() {
    if (
      spread.length &&
      (spread.length < 2 ||
        !spread.every((p) => workspaces.has(p)) ||
        !activeWs ||
        !spread.includes(activeWs))
    )
      spread = []
    const ws = activeWs ? workspaces.get(activeWs) : undefined
    if (!ws) return
    const shown = spread.length ? spread.map((p) => workspaces.get(p) as Workspace) : [ws]
    const want = shown.flatMap((w, i) => (i ? [spreadGrip(i - 1), w.el] : [w.el]))
    const same =
      pane.children.length === want.length && want.every((n, i) => pane.children[i] === n)
    if (!same) pane.replaceChildren(...want)
    pane.classList.toggle('duo', shown.length > 1)
    pane.dataset.n = String(shown.length)
    if (spreadSizes.length !== spread.length) spreadSizes = spread.map(() => 1)
    if (spread.length) flexSpread()
    else ws.el.style.flex = ''
    for (const w of shown) {
      w.el.classList.toggle('ws-active', shown.length > 1 && w.path === activeWs)
      if (!w.cols.children.length) paintCols(w)
      else if (!same) pinShown(w)
      paintWsBar(w)
    }
  }
  function resizeSpread(i: number, grip: HTMLElement, e: PointerEvent) {
    e.preventDefault()
    // in pixels, under the pointer, so it tracks the same when the columns scroll; a column
    // stops at its groups' floors (its min-width)
    const [a, b] = [spread[i], spread[i + 1]].map((p) => (p ? workspaces.get(p)?.el : undefined))
    if (!a || !b) return
    const floor = (w: HTMLElement) => Number.parseFloat(getComputedStyle(w).minWidth) || 0
    const a0 = a.getBoundingClientRect().width
    const both = a0 + b.getBoundingClientRect().width
    const [minA, minB] = [floor(a), floor(b)]
    const pair = (spreadSizes[i] ?? 1) + (spreadSizes[i + 1] ?? 1)
    const x0 = e.clientX
    grip.setPointerCapture(e.pointerId)
    grip.classList.add('drag')
    pane.classList.add('sizing')
    const move = (m: PointerEvent) => {
      const w = Math.max(minA, Math.min(both - minB, a0 + m.clientX - x0))
      spreadSizes[i] = (pair * w) / both
      spreadSizes[i + 1] = pair - (spreadSizes[i] as number)
      flexSpread()
    }
    const up = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.classList.remove('drag')
      pane.classList.remove('sizing')
      saveLayout()
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
  }
  const settle = () => {
    mountPane()
    paintTabs()
    saveLayout()
    syncWidth()
    focusRing()
  }

  /** open a workspace beside the one you are in; past what fits, the columns scroll */
  function openBeside(path: string) {
    const ws = ensureWs(wsKey(path))
    if (!activeWs) return setWs(ws.path)
    if (ws.path === activeWs) return
    if (spread.includes(ws.path)) return focusSide(ws.path)
    const next = spread.length ? [...spread] : [activeWs]
    next.splice(next.indexOf(activeWs) + 1, 0, ws.path)
    spread = next
    spreadSizes = spread.map(() => 1)
    activeWs = ws.path
    // three or more folders want the whole screen
    if (spread.length > 2 && docked) setDocked(false)
    settle()
  }
  /** every open tab side by side, in tab order; past what fits, the columns scroll */
  function spreadTabs() {
    if (!activeWs) return
    const all = order.filter((p) => workspaces.has(p))
    if (all.length < 2) return
    spread = all
    spreadSizes = spread.map(() => 1)
    if (spread.length > 2 && docked) setDocked(false)
    settle()
  }
  function shiftSide(path: string, by: -1 | 1) {
    const i = spread.indexOf(path)
    const j = i + by
    if (i < 0 || j < 0 || j >= spread.length) return
    moveSide(i, j)
  }
  /** a column to another place in the spread, its width going with it; the others slide over */
  function moveSide(from: number, to: number) {
    if (from === to || !spread[from]) return
    const els = spread.map((p) => workspaces.get(p)?.el)
    const was = new Map(els.map((w) => [w, w?.getBoundingClientRect().left ?? 0]))
    const [p] = spread.splice(from, 1)
    const [size] = spreadSizes.splice(from, 1)
    spread.splice(to, 0, p as string)
    spreadSizes.splice(to, 0, size ?? 1)
    settle()
    // FLIP: each column starts where it was and glides to where it is now
    for (const w of els) {
      if (!w) continue
      w.style.transition = 'none'
      w.style.transform = ''
    }
    const now = new Map(els.map((w) => [w, w?.getBoundingClientRect().left ?? 0]))
    for (const w of els)
      if (w) w.style.transform = `translateX(${(was.get(w) ?? 0) - (now.get(w) ?? 0)}px)`
    void pane.offsetWidth
    for (const w of els) {
      if (!w) continue
      w.style.transition = 'transform 0.22s cubic-bezier(0.2, 0.7, 0.2, 1)'
      w.style.transform = ''
    }
    setTimeout(() => {
      for (const w of els) if (w) w.style.transition = ''
      revealSide(p as string)
    }, 260)
  }
  /** a project column scrolled out of view comes back into it */
  const revealSide = (path: string) =>
    workspaces
      .get(path)
      ?.el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  /** drag a column by its name bar: the others make room, a marker shows where it lands */
  function dragSide(path: string, e: PointerEvent) {
    const from = spread.indexOf(path)
    const head = e.currentTarget as HTMLElement
    if (e.button !== 0 || from < 0 || (e.target as HTMLElement).closest('button')) return
    const els = spread.map((p) => workspaces.get(p)?.el as HTMLElement)
    const me = els[from] as HTMLElement
    const x0 = e.clientX
    let rects: DOMRect[] = []
    let on = false
    let to = from
    const mark = el('div', 'ws-side-mark')
    const move = (m: PointerEvent) => {
      const dx = m.clientX - x0
      if (!on) {
        if (Math.abs(dx) < 5) return
        on = true
        rects = els.map((w) => w.getBoundingClientRect())
        const pr = pane.getBoundingClientRect()
        Object.assign(mark.style, { top: `${pr.top}px`, height: `${pr.height}px` })
        document.body.appendChild(mark)
        pane.classList.add('side-drag')
        me.classList.add('side-lifted')
      }
      const r = rects[from] as DOMRect
      const lo = (rects[0] as DOMRect).left - r.left
      const hi = (rects.at(-1) as DOMRect).right - r.right
      const d = Math.max(lo, Math.min(hi, dx))
      me.style.transform = `translateX(${d}px)`
      // where it lands: the pointer past the middle of a neighbour is past that neighbour
      const px = Math.max(lo + r.left, Math.min(hi + r.right, m.clientX))
      to = rects.filter((x, i) => i !== from && x.left + x.width / 2 < px).length
      const shift = r.width + 6
      els.forEach((w, i) => {
        if (i === from) return
        const by =
          from < to && i > from && i <= to ? -shift : to < from && i >= to && i < from ? shift : 0
        w.style.transform = by ? `translateX(${by}px)` : ''
      })
      mark.hidden = to === from
      // the seam between where it lands and the neighbour that made room
      const t = rects[to] as DOMRect
      const at = to < from ? t.left + r.width + 3 : t.right - r.width - 3
      mark.style.left = `${at - 1.5}px`
    }
    const up = () => {
      head.removeEventListener('pointermove', move)
      head.removeEventListener('pointerup', up)
      head.removeEventListener('pointercancel', up)
      if (!on) return
      mark.remove()
      pane.classList.remove('side-drag')
      me.classList.remove('side-lifted')
      if (to === from) {
        for (const w of els) {
          w.style.transition = 'transform 0.18s ease-out'
          w.style.transform = ''
        }
        return setTimeout(() => {
          for (const w of els) w.style.transition = ''
        }, 200)
      }
      moveSide(from, to)
    }
    try {
      head.setPointerCapture(e.pointerId)
    } catch {}
    head.addEventListener('pointermove', move)
    head.addEventListener('pointerup', up)
    head.addEventListener('pointercancel', up)
  }
  /** back to one workspace: the one given, else the one you are in */
  function showAlone(path = activeWs) {
    if (!spread.length || !path) return
    spread = []
    setWs(path)
  }
  /** one workspace leaves the screen; the rest close up */
  function takeOff(path: string) {
    const i = spread.indexOf(path)
    if (i < 0) return
    spread.splice(i, 1)
    spreadSizes.splice(i, 1)
    const next = activeWs === path || !activeWs ? (spread[Math.max(0, i - 1)] ?? null) : activeWs
    if (spread.length < 2) spread = []
    setWs(next)
  }
  /** make a side the one you are in; `reveal` scrolls it into view (not on a click into it) */
  function focusSide(path: string, reveal = true) {
    if (!spread.includes(path) || path === activeWs) return
    activeWs = path
    for (const p of spread) workspaces.get(p)?.el.classList.toggle('ws-active', p === path)
    if (reveal) revealSide(path)
    paintTabs()
    paintViews()
    saveLayout()
    focusRing()
  }
  // clicking into a side makes it the one the header's views and terminal act on
  pane.addEventListener(
    'pointerdown',
    (e) => {
      if (!spread.length) return
      const w = (e.target as HTMLElement).closest<HTMLElement>('.ws')
      const hit = spread.find((p) => workspaces.get(p)?.el === w)
      if (hit) focusSide(hit, false)
    },
    true,
  )

  function openRepo(path: string, fresh = false) {
    const ws = ensureWs(wsKey(path))
    if (ws.project && ws.repos.includes(path)) {
      ws.where = path
      for (const d of ws.drafts.values()) paintDraftChips(d.composer, ws)
    }
    setWs(ws.path)
    if (fresh || !ws.chats.length) showChat(ws, 'new')
    return ws
  }

  function closeWs(path: string) {
    const ws = workspaces.get(path)
    if (!ws) return
    ws.term.dispose(false)
    workspaces.delete(path)
    order = order.filter((p) => p !== path)
    if (spread.includes(path)) return takeOff(path)
    if (activeWs === path) setWs(order[order.length - 1] ?? null)
    else {
      paintTabs()
      saveLayout()
    }
  }

  // ------------------------------------------------------------ start screen (no repo open)
  function paintStart() {
    const inApp = new Set(summaries.map((s) => s.sdkSessionId))
    const recent = elsewhere.filter((e) => !inApp.has(e.id)).slice(0, 8)
    pane.innerHTML = `
      <div class="ws-start">
        <div class="ss-hello">
          <div class="ss-mark"><i></i></div>
          <h2>Open a repo to work in</h2>
          ${accounts.some((a) => !a.demo && a.loggedIn) ? '' : '<p class="ss-demo-note"><b>Connect your Claude account first.</b> Until then chats run an offline demo agent. <button type="button" class="ss-link" data-act="accounts">Connect Claude account</button></p>'}
          <p>Each repo gets its own workspace, in its own colour: Claude chats (two side by side if you like), its files, its changes and a terminal. Close a tab any time; chats keep running.</p>
        </div>
        <input class="hi-q ws-start-q" placeholder="Search ${projects.length ? `${projects.length} projects and ` : ''}${repos.length} repos" aria-label="Search projects and repos" />
        <div class="ws-start-list" data-start="repos">${repoButtons('')}</div>
        ${
          recent.length
            ? `<h5 class="ws-start-h">Pick up a Claude session</h5><div class="ws-start-list">${recent
                .map(
                  (
                    e,
                  ) => `<button type="button" class="hi ${esc(e.state === 'needs-you' ? 'waiting' : e.state)}" data-resume="${esc(e.id)}">
                    <i class="st ${esc(e.state === 'needs-you' ? 'waiting' : e.state)}"></i>
                    <span class="hi-t">${esc(e.title || 'Untitled')}<em>${esc(short(e.repo))}</em></span>
                    <span class="hi-w">${e.state === 'needs-you' ? '<b>your turn</b>' : esc(ago(e.updated))}</span>
                  </button>`,
                )
                .join('')}</div>`
            : ''
        }
      </div>`
    const q = pane.querySelector('.ws-start-q') as HTMLInputElement
    q.addEventListener('input', () => {
      ;(pane.querySelector('[data-start="repos"]') as HTMLElement).innerHTML = repoButtons(q.value)
    })
    q.addEventListener('keydown', (k) => {
      if (k.key === 'Enter') (pane.querySelector('[data-open-repo]') as HTMLElement | null)?.click()
    })
    q.focus()
  }
  const repoButtons = (needle: string) =>
    projects
      .filter((p) => !needle || p.name.toLowerCase().includes(needle.toLowerCase()))
      .map(
        (
          p,
        ) => `<button type="button" class="ws-repo project" data-open-repo="${esc(p.path)}" style="--ws:${repoColour(p.path, p.name)}">
          <i></i><b>${esc(p.name)}</b><em>project · ${p.repos.length} repos</em><small></small>
        </button>`,
      )
      .join('') +
    (repos
      .filter((r) => !needle || r.name.toLowerCase().includes(needle.toLowerCase()))
      .slice(0, needle ? 30 : 10)
      .map(
        (
          r,
        ) => `<button type="button" class="ws-repo" data-open-repo="${esc(r.path)}" style="--ws:${repoColour(r.path, short(r.name))}">
          <i></i><b>${esc(short(r.name))}</b><em>${esc([r.name.split('/').slice(0, -1).join('/'), r.branch].filter(Boolean).join(' · '))}</em><small>${r.lastCommit ? ago(r.lastCommit) : ''}</small>
        </button>`,
      )
      .join('') ||
      (needle && !projects.some((p) => p.name.toLowerCase().includes(needle.toLowerCase()))
        ? '<p class="hi-empty">Nothing matches.</p>'
        : ''))

  // ------------------------------------------------------------ history: the chat library
  /**
   * Every Claude chat on this machine, from /api/control/library: search titles as you type or
   * the words inside messages, narrow by project and account, pinned ones on top, archived ones
   * out of the way. Rows open, rename, pin, archive or delete (to the Trash), by mouse or keys.
   */
  const lib = {
    q: '',
    deep: false,
    project: '',
    account: '',
    state: '',
    sort: 'updated',
    archived: false,
    items: [] as LibItem[],
    next: null as string | null,
    total: 0,
    facets: { projects: [], accounts: [] } as Record<
      'projects' | 'accounts',
      { name: string; count: number }[]
    >,
    loading: false,
    /** a message search that stopped at its budget: how far it got */
    searched: null as { scanned: number; of: number } | null,
    seq: 0,
    timer: 0,
    /** the chat states last painted */
    sig: '',
    wired: false,
  }
  const libItem = (id: string) => lib.items.find((x) => x.id === id)
  /** how a chat stands, from the app when it is open here, else from the recent-sessions scan */
  function libState(x: LibItem): { state: string; need: string } {
    const s = summaries.find((y) => y.sdkSessionId === x.id)
    if (s) return { state: needs(s) ? 'waiting' : s.state, need: needs(s) ? 'needs you' : '' }
    const e = elsewhere.find((y) => y.id === x.id)
    if (!e) return { state: '', need: '' }
    return {
      state: e.state === 'needs-you' ? 'waiting' : e.state,
      need: e.state === 'needs-you' ? 'your turn' : e.state === 'blocked' ? 'blocked' : '',
    }
  }
  function libRow(x: LibItem) {
    const { state, need } = libState(x)
    const acct =
      manyAccounts() && x.account
        ? (accountOf(x.account)?.label ?? x.account).replace(/@.*$/, '')
        : ''
    const sub = [short(x.repo), x.branch && x.branch !== 'HEAD' ? x.branch : '', acct]
      .filter(Boolean)
      .join(' · ')
    const sn = x.snippet
    const snip = sn
      ? `<small class="lib-snip">${esc(sn.text.slice(0, sn.start))}<mark>${esc(sn.text.slice(sn.start, sn.start + sn.length))}</mark>${esc(sn.text.slice(sn.start + sn.length))}</small>`
      : ''
    const act = (k: string, label: string, key: string, icon: string, on = false) =>
      `<button type="button" class="lib-act${on ? ' on' : ''}" data-la="${k}" title="${label} (${key})" aria-label="${label}" tabindex="-1">${icon}</button>`
    return `<div class="hi lib-row ${esc(state)}${x.archived ? ' archived' : ''}" role="option" tabindex="-1" aria-selected="false" data-lib-id="${esc(x.id)}"${x.colour ? ` style="--chat:${esc(x.colour)}"` : ''}>
        <i class="st ${esc(state)}"></i>
        <span class="hi-t">${x.pinned ? `<b class="lib-pin" title="Pinned">${ICON.pin}</b>` : ''}${esc(x.title)}<em>${esc(sub)}${x.here ? ' · <span class="lib-here">open here</span>' : ''}</em>${snip}</span>
        <span class="hi-w">${need ? `<b>${esc(need)}</b>` : esc(ago(x.updated))}</span>
        <span class="lib-acts">${act('pin', x.pinned ? 'Unpin' : 'Pin', 'P', ICON.pin, x.pinned)}${act('rename', 'Rename', 'R', ICON.rename)}${act('archive', x.archived ? 'Unarchive' : 'Archive', 'E', ICON.archive, x.archived)}${act('delete', 'Delete', '⌫', ICON.trash)}</span>
      </div>`
  }
  function paintLibRows() {
    const h = $('history')
    const rows = h.querySelector<HTMLElement>('[data-lib="rows"]')
    const more = h.querySelector<HTMLElement>('[data-lib="more"]')
    if (!rows || !more) return
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
      '[data-lib-id]',
    )?.dataset.libId
    // a search inside messages comes back unfiltered: the project and account narrow it here
    const shown = lib.deep
      ? lib.items.filter(
          (x) =>
            (!lib.project || x.repo === lib.project) &&
            (!lib.account || (x.account ?? 'none') === lib.account),
        )
      : lib.items
    const pinned = !lib.deep && shown.some((x) => x.pinned)
    let html = ''
    shown.forEach((x, i) => {
      if (pinned && i === 0) html += '<h5>Pinned</h5>'
      if (pinned && !x.pinned && shown[i - 1]?.pinned) html += '<h5>Chats</h5>'
      if (!lib.deep && !x.pinned) return
      html += libRow(x)
    })
    // the rest: a group's chats open here come together under its name (not in a message search)
    if (!lib.deep) {
      const groupOf = new Map(summaries.map((y) => [y.sdkSessionId, y.group]))
      html += withChatGroups(
        shown.filter((x) => !x.pinned),
        (x) => groupOf.get(x.id),
        libRow,
        'lib-cg',
      )
    }
    if (!shown.length && !lib.loading)
      html = `<p class="hi-empty">${
        lib.deep
          ? lib.q.trim().length < 2
            ? 'Type at least two letters to search inside messages.'
            : 'No message says that.'
          : lib.q || lib.project || lib.account || lib.state
            ? 'No chats match.'
            : 'No Claude chats on this machine yet.'
      }</p>`
    rows.innerHTML = html
    more.innerHTML = lib.loading
      ? `<p class="hi-empty">${lib.deep ? 'Searching messages…' : 'Loading…'}</p>`
      : !lib.next
        ? ''
        : lib.deep
          ? `<button type="button" class="lib-more" data-lib-more>Search older chats<small>${lib.searched ? `${lib.searched.scanned} of ${lib.searched.of} read` : ''}</small></button>`
          : `<button type="button" class="lib-more" data-lib-more>Show more<small>${lib.items.length} of ${lib.total}</small></button>`
    const count = h.querySelector<HTMLElement>('[data-lib="count"]')
    if (count)
      count.textContent = lib.deep
        ? `${shown.length} found`
        : `${lib.total} chat${lib.total === 1 ? '' : 's'}`
    if (focused) h.querySelector<HTMLElement>(`[data-lib-id="${CSS.escape(focused)}"]`)?.focus()
  }
  function paintLibFilters() {
    const h = $('history')
    const opt = (v: string, label: string, on: string) =>
      `<option value="${esc(v)}"${v === on ? ' selected' : ''}>${esc(label)}</option>`
    const proj = h.querySelector<HTMLSelectElement>('[data-lf="project"]')
    const fp = lib.facets.projects
    if (proj)
      proj.innerHTML =
        opt('', 'All projects', lib.project) +
        (lib.project && !fp.some((f) => f.name === lib.project)
          ? opt(lib.project, short(lib.project), lib.project)
          : '') +
        fp.map((f) => opt(f.name, `${short(f.name)} · ${f.count}`, lib.project)).join('')
    const acct = h.querySelector<HTMLSelectElement>('[data-lf="account"]')
    if (acct) {
      const fa = lib.facets.accounts
      acct.hidden = fa.length < 2 && !lib.account
      const label = (id: string) =>
        id === 'none' ? 'Other folder' : (accountOf(id)?.label ?? id).replace(/@.*$/, '')
      acct.innerHTML =
        opt('', 'All accounts', lib.account) +
        fa.map((f) => opt(f.name, `${label(f.name)} · ${f.count}`, lib.account)).join('')
    }
  }
  async function loadLibrary(more = false) {
    const seq = ++lib.seq
    lib.loading = true
    if (!more) {
      lib.items = []
      lib.next = null
      lib.searched = null
    }
    paintLibRows()
    const p = new URLSearchParams()
    if (lib.archived) p.set('archived', '1')
    if (more && lib.next) p.set('cursor', lib.next)
    let url = ''
    if (lib.deep) {
      if (lib.q.trim().length < 2) {
        lib.loading = false
        return paintLibRows()
      }
      p.set('q', lib.q.trim())
      url = `${LIBRARY}/search?${p}`
    } else {
      p.set('limit', '60')
      p.set('sort', lib.sort)
      for (const k of ['q', 'project', 'account', 'state'] as const) if (lib[k]) p.set(k, lib[k])
      url = `${LIBRARY}?${p}`
    }
    const r = await fetch(url, { signal: AbortSignal.timeout(lib.deep ? 30_000 : 20_000) })
      .then((x) => (x.ok ? x.json() : null))
      .catch(() => null)
    if (seq !== lib.seq) return
    lib.loading = false
    if (!r) {
      paintLibRows()
      const rows = $('history').querySelector<HTMLElement>('[data-lib="rows"]')
      if (rows && !lib.items.length)
        rows.innerHTML = '<p class="hi-empty">Could not read the chat library.</p>'
      return
    }
    if (lib.deep) {
      const seen = new Set(lib.items.map((x) => x.id))
      lib.items.push(...(r.hits as LibItem[]).filter((x) => !seen.has(x.id)))
      lib.next = r.next == null ? null : String(r.next)
      lib.searched = r.next == null ? null : { scanned: Number(r.next), of: Number(r.of) }
      lib.total = lib.items.length
    } else {
      lib.items = more ? lib.items.concat(r.items) : r.items
      lib.next = r.next
      lib.total = r.total
      lib.facets = r.facets
      paintLibFilters()
    }
    paintLibRows()
  }
  /** after the search changes: titles almost at once, messages once you pause */
  function reloadLibrary() {
    clearTimeout(lib.timer)
    lib.timer = window.setTimeout(() => loadLibrary(), lib.deep ? 400 : 120)
  }
  function openLibItem(x: LibItem) {
    toggleHistory(false)
    const s = summaries.find((y) => y.sdkSessionId === x.id)
    if (s) {
      const ws = ensureWs(wsKey(s.cwd))
      addChat(ws, s.id)
      setWs(ws.path)
      return showChat(ws, s.id)
    }
    const e = elsewhere.find((y) => y.id === x.id)
    resume({
      id: x.id,
      cwd: x.cwd ?? x.repoPath ?? '',
      repo: short(x.repo),
      title: x.title,
      state: e?.state ?? '',
      account: x.account,
    })
  }
  /** keep the place in the list when a row leaves it */
  const neighbour = (id: string) => {
    const rows = [...$('history').querySelectorAll<HTMLElement>('[data-lib-id]')]
    const at = rows.findIndex((r) => r.dataset.libId === id)
    return rows[at + 1]?.dataset.libId ?? rows[at - 1]?.dataset.libId
  }
  const focusRow = (id: string | undefined) =>
    requestAnimationFrame(() => {
      const h = $('history')
      ;(
        (id && h.querySelector<HTMLElement>(`[data-lib-id="${CSS.escape(id)}"]`)) ||
        h.querySelector<HTMLElement>('[data-lib-id]')
      )?.focus()
    })
  const noServer = (title: string) =>
    ask({ title, body: 'The app server did not answer. Try again in a moment.', cancel: null })
  async function libAction(kind: string, x: LibItem) {
    if (kind === 'open') return openLibItem(x)
    if (kind === 'pin' || kind === 'archive') {
      const on = kind === 'pin' ? !x.pinned : !x.archived
      if (!(await patchLibrary(x.id, kind === 'pin' ? { pinned: on } : { archived: on })))
        return noServer('Could not save that')
      const after = neighbour(x.id)
      await loadLibrary()
      return focusRow(libItem(x.id) ? x.id : after)
    }
    if (kind === 'rename') {
      const to = await ask({
        title: 'Rename chat',
        body: 'Leave it empty to go back to the title Claude gave it.',
        input: x.title,
        ok: 'Rename',
      })
      if (typeof to !== 'string') return focusRow(x.id)
      const t = to.replace(/\s+/g, ' ').trim().slice(0, 120)
      const title = t === x.autoTitle ? '' : t
      if (!(await patchLibrary(x.id, { title }))) return noServer('Could not rename it')
      // a chat open in a tab takes the new name too
      if (title) names.set(x.id, title)
      else names.delete(x.id)
      saveNamesLocally()
      paintTabs()
      const ws = activeWs ? workspaces.get(activeWs) : undefined
      if (ws) paintWsBar(ws)
      x.title = title || x.autoTitle || 'Untitled'
      x.named = !!title
      paintLibRows()
      return focusRow(x.id)
    }
    if (kind === 'delete') {
      if (x.here || summaries.some((s) => s.sdkSessionId === x.id)) {
        await ask({
          title: `“${x.title}” is open in the app`,
          body: 'End the chat first (End chat, in its tab menu), then delete it here.',
          cancel: null,
        })
        return focusRow(x.id)
      }
      const yes = await ask({
        title: `Delete “${x.title}”?`,
        body: `Its conversation in ${short(x.repo)} goes to the Trash, with its brief and what the library kept about it. Until you empty the Trash you can put it back from Finder.`,
        ok: 'Move to Trash',
        danger: true,
      })
      if (!yes) return focusRow(x.id)
      const r = await fetch(`${LIBRARY}/delete`, {
        method: 'POST',
        headers: WRITE,
        body: JSON.stringify({ id: x.id }),
        signal: AbortSignal.timeout(20_000),
      })
        .then(async (res) => ({
          ok: res.ok,
          error: ((await res.json().catch(() => ({}))) as { error?: string }).error,
        }))
        .catch(() => ({ ok: false, error: 'The app server did not answer.' }))
      if (!r.ok) {
        await ask({ title: 'Could not delete that chat', body: r.error ?? '', cancel: null })
        return focusRow(x.id)
      }
      const after = neighbour(x.id)
      names.delete(x.id)
      chatColours.delete(x.id)
      saveNamesLocally()
      elsewhere = elsewhere.filter((e) => e.id !== x.id)
      lib.items = lib.items.filter((y) => y.id !== x.id)
      lib.total = Math.max(0, lib.total - 1)
      paintLibRows()
      return focusRow(after)
    }
  }
  /** the popover itself outlives its contents: its listeners are added once */
  function wireLibrary(h: HTMLElement) {
    lib.wired = true
    h.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement
      const f = t.dataset.lf
      if (f === 'deep' || f === 'archived') lib[f] = t.checked
      else if (f === 'project' || f === 'account' || f === 'state' || f === 'sort') lib[f] = t.value
      else return
      h.classList.toggle('deep', lib.deep)
      loadLibrary()
      if (f === 'deep') h.querySelector<HTMLElement>('.hi-q')?.focus()
    })
    h.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      if (t.closest('[data-lib-more]')) return loadLibrary(true)
      const cg = t.closest<HTMLElement>('[data-cg]')?.dataset.cg
      if (cg) {
        folded.toggle(cg)
        return paintLibRows()
      }
      const id = t.closest<HTMLElement>('[data-lib-id]')?.dataset.libId
      const x = id ? libItem(id) : undefined
      if (x) libAction(t.closest<HTMLElement>('[data-la]')?.dataset.la ?? 'open', x)
    })
    h.addEventListener('focusin', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-lib-id]')
      for (const r of h.querySelectorAll<HTMLElement>('[data-lib-id]')) {
        r.classList.toggle('on', r === row)
        r.setAttribute('aria-selected', String(r === row))
      }
    })
  }
  function paintHistory() {
    const h = $('history')
    if (h.querySelector('[data-lib="rows"]')) {
      // chat states moved on: repaint the rows (never the search box or the filters under you),
      // and only when a state did change, so a row is not replaced under the pointer every refresh
      const sig = lib.items
        .map(
          (x) =>
            `${Object.values(libState(x)).join(':')}:${summaries.find((y) => y.sdkSessionId === x.id)?.group ?? ''}`,
        )
        .join()
      if (!lib.loading && sig !== lib.sig) paintLibRows()
      lib.sig = sig
      return
    }
    h.innerHTML = `
      <div class="lib-top">
        <input class="hi-q" placeholder="Search chats" aria-label="Search chats" value="${esc(lib.q)}" />
        <label class="lib-tog" title="Search the words inside messages, not only titles"><input type="checkbox" data-lf="deep"${lib.deep ? ' checked' : ''} /><span>In messages</span></label>
      </div>
      <div class="lib-filters">
        <select data-lf="project" aria-label="Project"></select>
        <select data-lf="account" aria-label="Account" hidden></select>
        <select data-lf="state" aria-label="Where it is open">
          <option value="">Open or not</option>
          <option value="here"${lib.state === 'here' ? ' selected' : ''}>Open in this app</option>
          <option value="other"${lib.state === 'other' ? ' selected' : ''}>Not open here</option>
        </select>
        <select data-lf="sort" aria-label="Sort">
          <option value="updated">Last active</option>
          <option value="created"${lib.sort === 'created' ? ' selected' : ''}>Started</option>
          <option value="title"${lib.sort === 'title' ? ' selected' : ''}>Title</option>
        </select>
        <label class="lib-tog"><input type="checkbox" data-lf="archived"${lib.archived ? ' checked' : ''} /><span>Archived</span></label>
        <span class="lib-count" data-lib="count"></span>
      </div>
      <div class="hi-list" role="listbox" aria-label="Claude chats">
        <div data-lib="rows"></div>
        <div data-lib="more"></div>
      </div>
      <footer class="lib-keys"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>P</kbd> pin</span><span><kbd>R</kbd> rename</span><span><kbd>E</kbd> archive</span><span><kbd>⌫</kbd> delete</span></footer>`
    paintLibFilters()
    const q = h.querySelector('.hi-q') as HTMLInputElement
    const list = h.querySelector('.hi-list') as HTMLElement
    const rowEls = () => [...h.querySelectorAll<HTMLElement>('[data-lib-id]')]
    q.addEventListener('input', () => {
      lib.q = q.value
      reloadLibrary()
    })
    q.addEventListener('keydown', (k) => {
      if (k.key === 'ArrowDown') {
        k.preventDefault()
        rowEls()[0]?.focus()
      }
      if (k.key === 'Enter' && lib.items[0]) {
        k.preventDefault()
        openLibItem(lib.items[0])
      }
    })
    if (!lib.wired) wireLibrary(h)
    list.addEventListener('keydown', (k) => {
      const row = (k.target as HTMLElement).closest<HTMLElement>('[data-lib-id]')
      const x = row?.dataset.libId ? libItem(row.dataset.libId) : undefined
      if (!row || !x || k.metaKey || k.ctrlKey || k.altKey) return
      const all = rowEls()
      const i = all.indexOf(row)
      const go = (j: number) => {
        const to = all[Math.max(0, Math.min(all.length - 1, j))]
        to?.focus()
        to?.scrollIntoView({ block: 'nearest' })
      }
      const keys: Record<string, () => unknown> = {
        ArrowDown: () =>
          i === all.length - 1 && lib.next && !lib.deep ? loadLibrary(true) : go(i + 1),
        ArrowUp: () => (i === 0 ? q.focus() : go(i - 1)),
        Home: () => go(0),
        End: () => go(all.length - 1),
        PageDown: () => go(i + 10),
        PageUp: () => go(i - 10),
        Enter: () => libAction('open', x),
        p: () => libAction('pin', x),
        r: () => libAction('rename', x),
        F2: () => libAction('rename', x),
        e: () => libAction('archive', x),
        Delete: () => libAction('delete', x),
        Backspace: () => libAction('delete', x),
      }
      const fn = keys[k.key.length === 1 ? k.key.toLowerCase() : k.key]
      if (!fn) return
      k.preventDefault()
      k.stopPropagation()
      fn()
    })
    // more as you near the end; a search inside messages reads further only when asked
    list.addEventListener('scroll', () => {
      if (lib.deep || lib.loading || !lib.next) return
      if (list.scrollTop + list.clientHeight > list.scrollHeight - 160) loadLibrary(true)
    })
    h.classList.toggle('deep', lib.deep)
    q.focus()
    q.select()
  }
  function toggleHistory(on = $('history').hidden) {
    const h = $('history')
    h.hidden = !on
    root.querySelector('[data-act="history"]')?.classList.toggle('on', on)
    if (on) {
      h.innerHTML = ''
      paintHistory()
      loadLibrary()
      refresh()
      syncLibrary()
    }
  }
  /** the fleet board: every chat on one line, each decision waiting on you a button (fleet-board.ts) */
  const fleet = createFleetBoard({
    api: API,
    titleOf: (row) => titleOf(summaryOf(row.id)) || row.title,
    colourOf: (cwd, repo) => repoColour(wsKey(cwd), repo),
    open: (id) => {
      const s = summaryOf(id)
      if (!s) return
      const ws = ensureWs(wsKey(s.cwd))
      addChat(ws, s.id)
      setWs(ws.path)
      showChat(ws, s.id)
    },
    onClose: () => root.querySelector('[data-act="fleet"]')?.classList.remove('on'),
  })
  /**
   * The board is a panel of its own (⌥⌘B, the rail's Fleet button, "Fleet" in the palette), so
   * it sits beside the chats instead of over them. Registered on request, from main.ts, so the
   * rail keeps the order main.ts gives it.
   */
  let fleetPanel: PanelHandle | null = null
  function registerFleetPanel() {
    fleetPanel ??= registerPanel({
      id: 'fleet',
      title: 'Fleet',
      group: 'fleet',
      chord: 'alt+meta+KeyB',
      icon: FLEET_ICON,
      width: { min: 380, default: 560, snaps: [420, 560, 760] },
      terms: 'fleet board every chat one line decisions approve waiting eta needs you',
      hint: 'every open chat on one line, and each decision waiting on you',
      mount: (host) => {
        host.appendChild(fleet.el)
      },
      onVisible: (on) => {
        fleet.toggle(on)
        root.querySelector('[data-act="fleet"]')?.classList.toggle('on', on)
      },
    })
    return fleetPanel
  }
  function toggleFleet(on = !fleetPanel?.isOpen()) {
    if (!fleetPanel) return
    on ? fleetPanel.open() : fleetPanel.close()
  }

  /** ⌥⌘O from anywhere: the panel opens on its chat library */
  async function openLibrary() {
    if (poppedOut) return popOut('claude')
    await setOpen(true)
    if ($('history').hidden) toggleHistory(true)
    else ($('history').querySelector('.hi-q') as HTMLInputElement | null)?.focus()
  }
  addEventListener('keydown', (e) => {
    if (e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyO') {
      e.preventDefault()
      openLibrary()
    }
  })
  // the command palette's "Chat library"
  addEventListener('laika:library-open', () => void openLibrary())

  // ------------------------------------------------------------ menus (mode, repo, account, /, @)
  const pop = el('div', 'ss-pop')
  pop.hidden = true
  root.appendChild(pop)
  const closePop = () => {
    pop.hidden = true
  }
  function showPop(
    anchor: HTMLElement,
    html: string,
    onPick: (val: string) => void,
    search = false,
    kind = '',
  ) {
    pop.className = kind ? `ss-pop ${kind}` : 'ss-pop'
    pop.style.removeProperty('--ws')
    pop.innerHTML = `${search ? '<input class="pop-q" placeholder="Find a chat" aria-label="Search" />' : ''}<div class="pop-list">${html}</div>`
    pop.hidden = false
    pop.setAttribute('role', 'menu')
    const r = anchor.getBoundingClientRect()
    const host = root.getBoundingClientRect()
    // measured, not assumed: menus differ in width. Near the right edge a menu ends under its button
    const w = pop.offsetWidth
    const from = r.left - host.left
    const x = from + w > host.width - 8 ? r.right - host.left - w : from
    pop.style.left = `${Math.max(8, Math.min(x, host.width - w - 8))}px`
    // open away from the edge the anchor sits near
    if (r.top - host.top < host.height / 2) {
      pop.style.top = `${r.bottom - host.top + 6}px`
      pop.style.bottom = 'auto'
    } else {
      pop.style.bottom = `${host.bottom - r.top + 6}px`
      pop.style.top = 'auto'
    }
    pop.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-val]')
      if (!b || b.matches(':disabled')) return
      closePop()
      onPick(b.dataset.val ?? '')
    }
    // the rows you can step through with the arrow keys: not the small buttons inside a row
    const items = () =>
      [...pop.querySelectorAll<HTMLElement>('[data-val]')].filter(
        (b) => !b.hidden && !b.matches(':disabled') && !b.parentElement?.closest('[data-val]'),
      )
    pop.onkeydown = (k) => {
      if (k.key !== 'ArrowDown' && k.key !== 'ArrowUp') {
        if (k.key === 'Enter' && document.activeElement?.matches('[data-val]')) {
          k.preventDefault()
          ;(document.activeElement as HTMLElement).click()
        }
        return
      }
      k.preventDefault()
      const all = items()
      const i = all.indexOf(document.activeElement as HTMLElement)
      const next =
        i < 0 ? (k.key === 'ArrowDown' ? 0 : all.length - 1) : i + (k.key === 'ArrowDown' ? 1 : -1)
      all[(next + all.length) % all.length]?.focus()
    }
    const q = pop.querySelector<HTMLInputElement>('.pop-q')
    if (!q) {
      if (kind) items()[0]?.focus({ preventScroll: true })
      return
    }
    q.focus()
    q.oninput = () => {
      const n = q.value.toLowerCase()
      for (const b of pop.querySelectorAll<HTMLElement>('[data-val]')) {
        if (b.parentElement?.closest('[data-val]')) continue
        if (b.closest('.gm-foot')) continue
        b.hidden = !!n && !(b.textContent ?? '').toLowerCase().includes(n)
      }
      for (const h of pop.querySelectorAll<HTMLElement>('.gm-sec')) {
        let x = h.nextElementSibling as HTMLElement | null
        let any = false
        while (x && x.matches('[data-val], .gm-cg')) {
          any ||= !x.hidden
          x = x.nextElementSibling as HTMLElement | null
        }
        h.hidden = !any
      }
    }
    q.onkeydown = (k) => {
      // the Enter that picks must not also land in the box that takes focus next
      if (k.key === 'Enter') k.preventDefault()
      if (k.key === 'Enter')
        items()
          .find((b) => !b.closest('.gm-foot'))
          ?.click()
    }
  }
  addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement
    if (
      !pop.hidden &&
      !pop.contains(t) &&
      !t.closest('[data-cx], .cx-chip, [data-act="add"], [data-gact="more"]')
    )
      closePop()
    const h = $('history')
    if (!h.hidden && !h.contains(t) && !t.closest('[data-act="history"]')) h.hidden = true
  })

  function modelMenu(anchor: HTMLElement, current: string | null, pick: (id: string) => void) {
    showPop(
      anchor,
      MODELS.map(
        (m) =>
          `<button type="button" class="pop-i${m.id === (current ?? '') ? ' on' : ''}" data-val="${m.id}"><i class="mdl"></i><span><b>${esc(m.label)}</b><em>${esc(m.hint)}</em></span></button>`,
      ).join(''),
      pick,
    )
  }

  function modeMenu(
    anchor: HTMLElement,
    current: Mode,
    pick: (m: Mode) => void,
    effort?: { value: Effort; live: boolean; set: (e: Effort) => void; model: string | null },
  ) {
    const idx = EFFORTS.indexOf(effort?.value ?? 'high')
    // Haiku has neither a safety classifier nor effort levels; the menu says so instead of
    // silently falling back (the SDK reports 'default' for an unsupported Auto)
    const can = !/haiku/i.test(effort?.model ?? '')
    showPop(
      anchor,
      `<div class="pop-h"><span>Modes</span><span class="pop-k"><kbd>⇧</kbd>+<kbd>tab</kbd> to switch</span></div>${MODES.map(
        (m) =>
          `<button type="button" class="pop-i mode${m.id === current ? ' on' : ''}${m.id === 'auto' && !can ? ' off' : ''}" data-val="${m.id}"${m.id === 'auto' && !can ? ' disabled' : ''}>${modeIcon(m.id)}<span><b>${esc(m.label)}</b><em>${m.id === 'auto' && !can ? 'Not available on Haiku: pick Sonnet or Opus first' : esc(m.hint)}</em></span>${m.id === current ? '<i class="tick">✓</i>' : ''}</button>`,
      ).join('')}${
        effort
          ? `<div class="pop-effort${can ? '' : ' off'}" title="${!can ? 'Haiku has no effort levels' : effort.live ? 'Applies to the next chat you start' : 'How hard Claude thinks'}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 8h3m0 0V6m0 2v2M10 8h10M4 16h10m0 0v-2m0 2v2m3-2h3"/></svg>
              <b>Effort</b><span class="pop-eff-v">(${esc(effortLabel(effort.value))})</span>
              <input type="range" min="0" max="${EFFORTS.length - 1}" value="${idx}" step="1" aria-label="Effort"${can ? '' : ' disabled'} />
            </div>`
          : ''
      }`,
      (v) => pick(v as Mode),
    )
    const range = pop.querySelector<HTMLInputElement>('.pop-effort input')
    if (range && effort) {
      range.addEventListener('input', () => {
        const e = EFFORTS[Number(range.value)] ?? 'high'
        ;(pop.querySelector('.pop-eff-v') as HTMLElement).textContent = `(${effortLabel(e)})`
        effort.set(e)
      })
      // the slider lives inside the pop: clicks on it must not pick a mode or close it
      range.addEventListener('click', (e) => e.stopPropagation())
      range.addEventListener('pointerdown', (e) => e.stopPropagation())
    }
  }

  function slashMenu(anchor: HTMLElement, commands: string[], input: HTMLTextAreaElement) {
    // the fleet commands work in every chat; the host expands them
    const all = [...new Set([...FLEET_COMMANDS.map((c) => c.name), ...commands])].sort()
    showPop(
      anchor,
      all.length
        ? all
            .map(
              (c) =>
                `<button type="button" class="pop-i" data-val="${esc(c)}"><span><b>/${esc(c)}</b></span></button>`,
            )
            .join('')
        : '<p class="pop-empty">Commands and skills appear here once the session has started.</p>',
      (v) => {
        input.value = `/${v} `
        input.focus()
        input.dispatchEvent(new Event('input'))
      },
      all.length > 0,
    )
  }

  async function atMenu(anchor: HTMLElement, cwd: string, input: HTMLTextAreaElement) {
    if (!cwd) {
      showPop(
        anchor,
        '<p class="pop-empty">Choose a repo first; @ then lists its files.</p>',
        () => {},
      )
      return
    }
    const files: string[] = await fetch(`/api/control/git/files?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => [])
    showPop(
      anchor,
      files.length
        ? files
            .slice(0, 500)
            .map(
              (f) =>
                `<button type="button" class="pop-i file" data-val="${esc(f)}"><span><b>${esc(short(f))}</b><em>${esc(f)}</em></span></button>`,
            )
            .join('')
        : '<p class="pop-empty">No files found.</p>',
      (v) => {
        input.value = `${input.value.replace(/@$/, '')}@${v} `
        input.focus()
        input.dispatchEvent(new Event('input'))
      },
      files.length > 0,
    )
  }

  // ------------------------------------------------------------ a new chat in a workspace
  function draftFor(ws: Workspace, g: Group): { el: HTMLElement; composer: Composer } {
    const have = ws.drafts.get(g.id)
    if (have) {
      paintDraftChips(have.composer, ws)
      return have
    }
    const hasReal = accounts.some((a) => !a.demo && a.loggedIn)
    const chat = el('div', 'ss-chat new')
    chat.innerHTML = `
      <div class="ss-log">
        <div class="ss-hello">
          <div class="ss-mark" style="background:${ws.colour}"><i></i></div>
          <h2>Ask Claude in ${esc(ws.name)}</h2>
          <p>${
            ws.project
              ? `Claude Code across the ${ws.repos.length} repos in this project folder, or inside one of them: pick where below.`
              : 'Claude Code, running in this repo with its tools, your CLAUDE.md and your settings.'
          }</p>
          <ul class="ss-tips">
            <li><kbd>@</kbd> mention a file</li>
            <li><kbd>/</kbd> commands and skills</li>
            <li><kbd>⌘V</kbd> paste a screenshot</li>
            <li><kbd>⇧Tab</kbd> switch mode</li>
            <li><kbd>⌃\`</kbd> terminal</li>
            <li><kbd>⌥⌘\\</kbd> split right</li>
          </ul>
          <button type="button" class="ss-lead-toggle" data-act="lead" aria-pressed="false"><span>♛</span><b>Make this the conductor</b><em>A lead chat that keeps your other chats moving toward one goal, even while you're away</em></button>
          ${hasReal ? '' : '<p class="ss-demo-note"><b>Demo mode.</b> No Claude account is connected, so chats run an offline demo agent. <button type="button" class="ss-link" data-act="accounts">Connect your Claude account</button></p>'}
        </div>
      </div>`
    const composer = makeComposer({
      placeholder: `Ask Claude to work in ${ws.name}…`,
      mode: prefs.mode,
      onMode: (m) => setPrefMode(m),
      model: prefs.model,
      onMenu: (kind, anchor) => {
        if (kind === 'mode') {
          modeMenu(
            anchor,
            prefs.mode,
            (m) => {
              setPrefMode(m)
              composer.setMode(m)
            },
            { value: prefs.effort, live: false, set: setPrefEffort, model: prefs.model },
          )
        }
        if (kind === 'model') {
          modelMenu(anchor, prefs.model, (id) => {
            setPrefModel(id)
            composer.setModel(id)
          })
        }
        if (kind === 'slash') slashMenu(anchor, [], composer.input)
        if (kind === 'at') atMenu(anchor, ws.path, composer.input)
      },
      onSend: async (text, images) => {
        composer.setBusy(true)
        const lead = chat.classList.contains('conductor')
        const r = await post('/sessions', {
          cwd: ws.where,
          repo: ws.where === ws.path ? ws.name : repoName(ws.where),
          account: prefs.account,
          mode: prefs.mode,
          model: prefs.model || undefined,
          effort: prefs.effort,
          text,
          images,
          ...(lead
            ? {
                role: 'conductor',
                goal: text,
                title: `Conductor: ${text.replace(/\s+/g, ' ').slice(0, 60)}`,
              }
            : {}),
        })
        const s = await r.json()
        composer.setBusy(false)
        if (!r.ok) {
          composer.input.value = text
          chat
            .querySelector('.ss-hello p')
            ?.insertAdjacentHTML(
              'afterend',
              `<p class="ss-err">${esc(s.error ?? 'Could not start the chat')}</p>`,
            )
          return
        }
        // the draft's tab becomes the chat, in whichever group it has moved to since
        ws.drafts.delete(g.id)
        summaries.push(s)
        addChat(ws, s.id)
        const gi = ws.groups.indexOf(g)
        if (gi >= 0) g.tabs = g.tabs.map((t) => (t === 'new' ? s.id : t))
        showChat(ws, s.id, Math.max(0, gi))
        paintTabs()
        refresh()
      },
    })
    chat.querySelector('[data-act="lead"]')?.addEventListener('click', (e) => {
      const b = e.currentTarget as HTMLElement
      const on = chat.classList.toggle('conductor')
      b.setAttribute('aria-pressed', String(on))
      composer.input.placeholder = on
        ? 'The overall goal: what should all your chats get done while you are away?'
        : `Ask Claude to work in ${ws.name}…`
      composer.input.focus()
    })
    composer.el.addEventListener('click', (e) => {
      const here = (e.target as HTMLElement).closest<HTMLElement>('[data-chip="where"]')
      if (here) {
        return showPop(
          here,
          [ws.path, ...ws.repos]
            .map(
              (p) =>
                `<button type="button" class="pop-i${p === ws.where ? ' on' : ''}" data-val="${esc(p)}"><i style="background:${p === ws.path ? ws.colour : 'var(--c-dim)'}"></i><span><b>${esc(p === ws.path ? `All of ${ws.name}` : repoName(p))}</b><em>${p === ws.path ? `the project folder, ${ws.repos.length} repos` : esc(p.slice(ws.path.length + 1))}</em></span></button>`,
            )
            .join(''),
          (val) => {
            ws.where = val
            try {
              localStorage.setItem(`laika.where:${ws.path}`, val)
            } catch {}
            for (const d of ws.drafts.values()) paintDraftChips(d.composer, ws)
          },
          ws.repos.length > 6,
        )
      }
      const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-chip="account"]')
      if (!chip) return
      showPop(
        chip,
        accounts
          .map(
            (a) =>
              `<button type="button" class="pop-i${a.id === prefs.account ? ' on' : ''}" data-val="${esc(a.id)}"><i class="acct ${a.demo ? 'demo' : a.loggedIn ? 'ok' : 'off'}"></i><span><b>${esc(a.label)}</b><em>${a.demo ? 'Offline, no quota used' : a.loggedIn ? esc([a.email, a.plan && `${a.plan} plan`].filter(Boolean).join(' · ')) : 'Not signed in'}</em></span></button>`,
          )
          .join('') +
          '<button type="button" class="pop-i manage" data-val="__manage"><span><b>Manage accounts…</b></span></button>',
        (val) => {
          if (val === '__manage') return paintAccounts()
          setAccount(val)
          paintDraftChips(composer, ws)
        },
      )
    })
    chat.appendChild(composer.el)
    paintDraftChips(composer, ws)
    const d = { el: chat, composer }
    ws.drafts.set(g.id, d)
    return d
  }
  function paintDraftChips(composer: Composer, ws: Workspace) {
    const a = accounts.find((x) => x.id === prefs.account)
    const warn = a && !a.demo && !a.loggedIn
    const where = ws.project
      ? `<button type="button" class="cx-chip where" data-chip="where" title="Where this chat works">${ws.where === ws.path ? `All of ${esc(ws.name)}` : esc(repoName(ws.where))}<span>▾</span></button>`
      : ''
    composer.setChips(
      `${where}<button type="button" class="cx-chip${warn ? ' want' : ''}" data-chip="account" title="${esc(a?.email ?? 'Claude account')}"><i class="acct ${a?.demo ? 'demo' : a?.loggedIn ? 'ok' : 'off'}"></i>${esc(a?.label ?? 'Account')}${warn ? ' · sign in' : ''}<span>▾</span></button>`,
    )
  }

  // ------------------------------------------------------------ accounts
  const signIns = new Map<string, TerminalPanel>()
  let backTo: string | null = null
  async function reloadAccounts() {
    try {
      accounts = await fetch(`${API}/accounts`).then((r) => r.json())
    } catch {}
    const warn = !accounts.some((a) => !a.demo && a.loggedIn)
    $('acctwarn').hidden = !warn
  }

  /** Claude accounts: who each is signed in as, sign in, add another, choose the default */
  async function paintAccounts() {
    $('history').hidden = true
    closePop()
    if (activeWs) backTo = activeWs
    activeWs = null
    paintTabs()
    pane.innerHTML = '<div class="ac"><p class="hi-empty">Checking accounts…</p></div>'
    await reloadAccounts()
    const real = accounts.filter((a) => !a.demo)
    pane.innerHTML = `
      <div class="ac">
        <div class="ac-top"><button type="button" class="ss-link" data-ac="back">← Back to workspaces</button></div>
        <h2>Claude accounts</h2>
        <p class="ac-lede">Each chat runs on one account. Sign in once per account: the login is kept in your Mac's Keychain, the same place Claude Code keeps it. Choose which account new chats use, or switch per chat from the button in the message box.</p>
        <div class="ac-list">${
          real.length
            ? real
                .map(
                  (
                    a,
                  ) => `<section class="ac-card ${a.loggedIn ? 'ok' : 'off'}" data-ac-id="${esc(a.id)}">
                    <div class="ac-row">
                      <i class="acct ${a.loggedIn ? 'ok' : 'off'}"></i>
                      <div class="ac-who">
                        <b>${esc(a.label)}${a.id === prefs.account ? ' <span class="ac-def">Used for new chats</span>' : ''}</b>
                        <em>${a.loggedIn ? `Signed in as ${esc(a.email ?? 'unknown')}${a.plan ? ` · ${esc(a.plan)} plan` : ''}` : 'Not signed in yet'}</em>
                        <small>${esc(a.configDir)}</small>
                      </div>
                      <div class="ac-acts">
                        ${a.id !== prefs.account && a.loggedIn ? '<button type="button" class="ac-btn" data-ac="default">Use for new chats</button>' : ''}
                        <button type="button" class="ac-btn${a.loggedIn ? '' : ' go'}" data-ac="login">${a.loggedIn ? 'Sign in again' : 'Sign in'}</button>
                        <button type="button" class="ac-btn" data-ac="check" title="Ask Claude Code who this account is signed in as">Check</button>
                        <button type="button" class="ac-btn" data-ac="rename">Rename</button>
                        <button type="button" class="ac-btn danger" data-ac="remove">Remove</button>
                      </div>
                    </div>
                    <div class="ac-login" hidden>
                      <p><b>Signing in ${esc(a.label)}.</b> Your browser opens a Claude sign-in page: sign in with the account you want here${real.length > 1 ? ' (use a private window or switch accounts in the browser if the other one is already signed in)' : ''}. If no page opens, click the link below. This card updates when it's done.</p>
                      <div class="ac-term"></div>
                    </div>
                  </section>`,
                )
                .join('')
            : '<p class="hi-empty">No accounts yet.</p>'
        }</div>
        <form class="ac-add">
          <input name="label" placeholder="Name, e.g. Second Max" aria-label="Account name" maxlength="60" />
          <button type="submit" class="ac-btn go">Add account</button>
        </form>
        <p class="ac-note">Adding an account creates its own private login folder, so both stay signed in at once and each chat keeps the account it started on. Removing an account here doesn't sign it out.</p>
      </div>`
    const form = pane.querySelector('.ac-add') as HTMLFormElement
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const label = (form.elements.namedItem('label') as HTMLInputElement).value.trim()
      if (!label) return
      const r = await fetch(`${API}/accounts`, {
        method: 'POST',
        headers: WRITE,
        body: JSON.stringify({ label, useDefault: !real.length }),
      })
      const a = await r.json()
      if (!r.ok) {
        await ask({ title: 'Could not add the account', body: a.error ?? '', cancel: null })
        return
      }
      await paintAccounts()
      if (!a.loggedIn) startSignIn(a.id)
    })
  }

  function startSignIn(id: string) {
    const card = pane.querySelector<HTMLElement>(`[data-ac-id="${CSS.escape(id)}"]`)
    if (!card) return
    const box = card.querySelector('.ac-login') as HTMLElement
    box.hidden = false
    const host = box.querySelector('.ac-term') as HTMLElement
    signIns.get(id)?.dispose(true)
    host.innerHTML = ''
    const panel = createTerminalPanel(host, {
      cwd: '~',
      owner: `login:${id}`,
      title: 'Claude sign-in',
      start: (cols, rows) =>
        fetch(`${API}/accounts/${id}/login`, {
          method: 'POST',
          headers: WRITE,
          body: JSON.stringify({ cols, rows }),
        }),
      onExit: async () => {
        await fetch(`${API}/accounts/${id}/check`, { method: 'POST', headers: WRITE }).catch(
          () => {},
        )
        await reloadAccounts()
        const a = accounts.find((x) => x.id === id)
        if (
          a?.loggedIn &&
          (!prefs.account || !accounts.find((x) => x.id === prefs.account)?.loggedIn)
        )
          setAccount(id)
        setTimeout(() => {
          if (pane.querySelector('.ac')) paintAccounts()
        }, 1200)
      },
    })
    signIns.set(id, panel)
    panel.open()
  }

  pane.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement
    const act = t.closest<HTMLElement>('[data-ac]')?.dataset.ac
    if (!act) return
    if (act === 'back') return setWs(backTo && order.includes(backTo) ? backTo : (order[0] ?? null))
    const id = t.closest<HTMLElement>('[data-ac-id]')?.dataset.acId
    if (!id) return
    const a = accounts.find((x) => x.id === id)
    if (act === 'default') {
      setAccount(id)
      for (const ws of workspaces.values())
        for (const d of ws.drafts.values()) paintDraftChips(d.composer, ws)
      return paintAccounts()
    }
    if (act === 'login') return startSignIn(id)
    if (act === 'check') {
      t.textContent = 'Checking…'
      await fetch(`${API}/accounts/${id}/check`, { method: 'POST', headers: WRITE })
      return paintAccounts()
    }
    if (act === 'rename') {
      const label = await ask({ title: 'Name this account', input: a?.label ?? '', ok: 'Rename' })
      if (typeof label !== 'string' || !label.trim()) return
      await fetch(`${API}/accounts/${id}`, {
        method: 'PATCH',
        headers: WRITE,
        body: JSON.stringify({ label }),
      })
      return paintAccounts()
    }
    if (act === 'remove') {
      const yes = await ask({
        title: `Remove “${a?.label}” from this app?`,
        body: 'Chats already running keep going, and its login stays in the Keychain, so adding it back is instant.',
        ok: 'Remove',
        danger: true,
      })
      if (!yes) return
      await fetch(`${API}/accounts/${id}`, { method: 'DELETE', headers: { 'x-control': '1' } })
      if (prefs.account === id) setAccount('')
      return paintAccounts()
    }
  })

  // ------------------------------------------------------------ the ring listens
  const activity = (v: View, detail: Record<string, unknown>) =>
    dispatchEvent(
      new CustomEvent('laika:agent-activity', {
        detail: { id: v.s.id, sdkId: v.s.sdkSessionId, cwd: v.s.cwd, ...detail },
      }),
    )
  const focusRing = () => {
    const v = open ? activeView() : undefined
    const ws = v ? wsOf(v) : undefined
    dispatchEvent(
      new CustomEvent('laika:agent-focus', {
        detail: v
          ? {
              id: v.s.id,
              sdkId: v.s.sdkSessionId,
              cwd: v.s.cwd,
              repo: v.s.repo,
              state: v.s.state,
              colour: ws?.colour,
            }
          : null,
      }),
    )
  }
  const pathsOf = (input: Record<string, unknown>) =>
    [input.file_path, input.notebook_path, input.path].filter(
      (p): p is string => typeof p === 'string' && p.startsWith('/'),
    )
  const onStatus = (v: View) => {
    const row = summaries.find((x) => x.id === v.s.id)
    if (row) row.state = v.s.state
    const prev = lastState.get(v.s.id)
    lastState.set(v.s.id, v.s.state)
    if (prev && busyState(prev) && !busyState(v.s.state) && !isShown(v)) unread.add(v.s.id)
    paintTabs()
    const ws = wsOf(v)
    if (ws && visible(ws.path)) paintWsBar(ws)
    if (isShown(v)) focusRing()
  }

  // ------------------------------------------------------------ a chat
  /** the conductor's banner: its goal, and how long it keeps things going without you */
  function paintLead(v: View) {
    const head = v.root.querySelector<HTMLElement>('.cd-head')
    if (!head) return
    const until = v.s.autopilotUntil
      ? new Date(v.s.autopilotUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : null
    v.root.classList.toggle('away', !!v.s.autopilot)
    const away = (m: number, label: string) =>
      `<button type="button" data-away="${m}">${label}</button>`
    const deck = !v.root.classList.contains('deck-shut')
    head.innerHTML = `<span class="cd-crown" aria-hidden="true">♛</span>
      <div class="cd-what"><b>Conductor</b><span title="${esc(v.s.goal ?? '')}">${esc(v.s.goal || 'Tell it the goal below')}</span></div>
      <button type="button" class="cd-deck-t" data-deck aria-expanded="${deck}" title="${deck ? 'Fold the fleet away' : 'Show the fleet and its queue'}">Fleet<span>${deck ? '▾' : '▸'}</span></button>
      ${
        v.s.autopilot
          ? `<div class="cd-away on"><span class="cd-pulse"></span><span>${awayState?.on && awayState.conductorId === v.s.id ? 'Away mode' : 'Autopilot'} ${until ? `until ${esc(until)}` : 'until you stop it'}</span>${away(-1, 'I’m back')}</div>`
          : `<div class="cd-away"><span>Step away</span>${away(30, '30m')}${away(60, '1h')}${away(180, '3h')}${away(0, 'Until I’m back')}</div>`
      }`
  }

  /** a chat that has finished: what it planned next, one click from the box */
  function paintNext(v: View) {
    const box = v.root.querySelector<HTMLElement>(':scope > .ss-next')
    if (!box) return
    const next = v.brief?.next?.trim() ?? ''
    const show =
      v.s.role !== 'conductor' &&
      !!next &&
      v.s.state === 'idle' &&
      box.dataset.hidden !== next &&
      !v.composer.input.value
    box.hidden = !show
    if (show)
      box.innerHTML = `<span class="nx-k">Suggested next</span><button type="button" class="nx-t" data-next="use" title="Put this in the box">${esc(next)}</button><button type="button" class="nx-x" data-next="hide" title="Hide" aria-label="Hide suggestion">×</button>`
  }

  function suggestKey(v: View, e: Ev, i: number) {
    return `laika.suggest:${v.s.id}:${e.at}:${i}`
  }

  /** the conductor's suggested actions: each one goes to its chat when you send it */
  function suggestCard(v: View, e: Ev) {
    const items = (e.items as Suggestion[]) ?? []
    const box = el('div', 'm-suggest')
    box.innerHTML = `<div class="sg-h">♛ Suggested actions</div>${items
      .map((it, i) => {
        let done = ''
        try {
          done = localStorage.getItem(suggestKey(v, e, i)) ?? ''
        } catch {}
        const gone = !summaryOf(it.chat)
        return `<div class="sg-i${done ? ` ${done}` : ''}" data-i="${i}">
          <div class="sg-to"><b>${esc(it.repo)}</b><span>${esc(it.title)}</span></div>
          <div class="sg-t">${esc(it.text)}</div>
          ${it.why ? `<div class="sg-why">${esc(it.why)}</div>` : ''}
          <div class="sg-a">${
            done === 'sent'
              ? '<em>Sent</em>'
              : done === 'dismissed'
                ? '<em>Dismissed</em>'
                : gone
                  ? '<em>That chat has ended</em>'
                  : '<button type="button" class="sg-go" data-sg="send">Send</button><button type="button" data-sg="open">Open chat</button><button type="button" data-sg="dismiss">Dismiss</button>'
          }</div>
        </div>`
      })
      .join('')}`
    box.addEventListener('click', async (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-sg]')
      const row = b?.closest<HTMLElement>('.sg-i')
      if (!b || !row) return
      const i = Number(row.dataset.i)
      const it = items[i]
      if (!it) return
      const mark = (state: string, label: string) => {
        try {
          localStorage.setItem(suggestKey(v, e, i), state)
        } catch {}
        row.classList.add(state)
        ;(row.querySelector('.sg-a') as HTMLElement).innerHTML = `<em>${label}</em>`
      }
      if (b.dataset.sg === 'dismiss') return mark('dismissed', 'Dismissed')
      if (b.dataset.sg === 'open') {
        const target = summaryOf(it.chat)
        if (!target) return
        const ws = ensureWs(wsKey(target.cwd))
        setWs(ws.path)
        showChat(ws, target.id)
        return
      }
      b.disabled = true
      const r = await post(`/sessions/${it.chat}/message`, { text: it.text }).catch(() => null)
      if (r?.ok) mark('sent', 'Sent')
      else {
        b.disabled = false
        b.textContent = 'Could not send: retry'
      }
    })
    return box
  }

  function makeView(s: Summary): View {
    const r = el('div', 'ss-chat')
    r.innerHTML = `<div class="ss-log" aria-live="polite"></div><nav class="ss-track" aria-label="Your prompts in this chat" hidden></nav><div class="ss-tasks" hidden></div>`
    const v: View = {
      s,
      root: r,
      log: r.querySelector('.ss-log') as HTMLElement,
      tasks: r.querySelector('.ss-tasks') as HTMLElement,
      composer: null as unknown as Composer,
      es: null,
      lastSeq: 0,
      live: null,
      liveText: '',
      rows: new Map(),
      stick: true,
      queue: [],
      draining: false,
      replay: false,
      replayStart: 0,
      replayTimer: null,
      stickQueued: false,
      userAt: 0,
      selfAt: 0,
      grow: null,
      fit: null,
      track: r.querySelector('.ss-track') as HTMLElement,
      lastText: null,
      lastThink: null,
      lastAway: null,
      epoch: null,
      trackQueued: false,
      trackDirty: true,
      shown: false,
      unwatch: null,
      awayTimer: null,
      releaseTimer: null,
      trackTops: [],
      trackSize: '',
      trackHere: -1,
      lastUser: null,
      brief: null,
      trackTimer: null,
      since: Date.now(),
      commands: [],
      todos: [],
      tasksOpen: false,
      work: { start: 0, tokens: 0, phase: null, verb: '', shown: 0, seen: 0 },
    }
    if (s.work) setWork(v, s.work)
    paintWorking(v)
    if (s.role === 'conductor') {
      r.classList.add('conductor')
      const head = el('header', 'cd-head')
      r.prepend(head)
      paintLead(v)
      // the cockpit: every chat as a node, its queue under it (cockpit.ts)
      const deck = el('div', 'cd-deck')
      const grip = el('div', 'cd-grip')
      grip.title = 'Drag to resize'
      head.after(deck, grip)
      const ck = mountCockpit(deck)
      const shut = localStorage.getItem(DECK_KEY) === 'shut'
      r.classList.toggle('deck-shut', shut)
      ck.setVisible(!shut)
      paintLead(v)
      const h = Number(localStorage.getItem(`${DECK_KEY}.h`))
      if (h > 0) deck.style.setProperty('--deck-h', `${h}px`)
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        grip.setPointerCapture(e.pointerId)
        const y0 = e.clientY
        const h0 = deck.getBoundingClientRect().height
        const max = r.getBoundingClientRect().height * 0.6
        // the grip moves the deck's cap; the deck is still only as tall as its lanes (conductor.css)
        const move = (m: PointerEvent) => {
          deck.style.setProperty(
            '--deck-h',
            `${Math.round(Math.max(80, Math.min(max, h0 + m.clientY - y0)))}px`,
          )
        }
        const up = () => {
          grip.removeEventListener('pointermove', move)
          const now = parseInt(deck.style.getPropertyValue('--deck-h'), 10)
          if (now > 0) localStorage.setItem(`${DECK_KEY}.h`, String(now))
        }
        grip.addEventListener('pointermove', move)
        grip.addEventListener('pointerup', up, { once: true })
      })
      v.cockpit = ck.dispose
      head.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('[data-deck]')) {
          const now = !r.classList.toggle('deck-shut')
          localStorage.setItem(DECK_KEY, now ? 'open' : 'shut')
          ck.setVisible(now)
          paintLead(v)
          return
        }
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-away]')
        if (!b) return
        const minutes = Number(b.dataset.away)
        post(`/sessions/${v.s.id}/autopilot`, minutes < 0 ? { on: false } : { on: true, minutes })
          .then((x) => x.json())
          .then((sum: Summary) => {
            Object.assign(v.s, { autopilot: sum.autopilot, autopilotUntil: sum.autopilotUntil })
            paintLead(v)
          })
          .catch(() => {})
      })
    }
    v.composer = makeComposer({
      placeholder: s.role === 'conductor' ? 'Steer the conductor…' : 'Reply to Claude…',
      mode: s.mode,
      sent: () =>
        [...v.log.querySelectorAll<HTMLElement>(':scope > .m-user:not(.from-lead)')].map(
          (u) => u.dataset.text ?? '',
        ),
      onSend: (text, images) => {
        // "@chat do this": to that chat, or its queue, rather than the conductor (cockpit-route.ts)
        if (
          v.s.role === 'conductor' &&
          routeFromConductor(text, {
            box: v.composer.el,
            put: (t) => {
              v.composer.input.value = t
              v.composer.input.dispatchEvent(new Event('input'))
            },
            note: (t, tone) =>
              append(v, el('div', `m-note${tone === 'err' ? ' err' : ' ok'}`, esc(t))),
          })
        )
          return
        v.stick = true
        // on the page the moment you send, however busy the host is; its own copy replaces this
        const mine = el(
          'div',
          'm-user sending',
          `${images.length ? `<div class="m-imgs">${images.map((im) => `<img src="${im.thumb}" alt="${esc(im.name)}" />`).join('')}</div>` : ''}${text ? `<div class="ss-md">${renderMarkdown(text)}</div>` : ''}`,
        )
        mine.dataset.text = text
        append(v, mine)
        v.composer.setBusy(true)
        // no echo after a few seconds: the stream is the likelier casualty, so reopen it
        const slow = setTimeout(() => {
          if (!mine.isConnected) return
          mine.classList.add('slow')
          if (perChat) connectOne(v)
          else resubscribe(true)
        }, 4000)
        post(`/sessions/${v.s.id}/message`, { text, images })
          .then((r) => {
            if (!r.ok) throw new Error(String(r.status))
          })
          .catch(() => {
            clearTimeout(slow)
            mine.remove()
            v.composer.setBusy(v.s.state === 'running' || v.s.state === 'starting')
            // nothing typed is lost: the message goes back in the box to send again
            if (!v.composer.input.value) v.composer.input.value = text
            append(
              v,
              el(
                'div',
                'm-note err',
                'Could not reach Claude, so that message was not sent. It is back in the box: send it again.',
              ),
            )
          })
      },
      onStop: () => post(`/sessions/${v.s.id}/interrupt`),
      onMode: (m) => setMode(v, m),
      model: s.model,
      onMenu: (kind, anchor) => {
        if (kind === 'mode')
          modeMenu(anchor, v.s.mode, (m) => setMode(v, m), {
            value: prefs.effort,
            live: true,
            set: setPrefEffort,
            model: v.s.model,
          })
        if (kind === 'model') modelMenu(anchor, v.s.model, (id) => setModelOf(v, id))
        if (kind === 'slash') slashMenu(anchor, v.commands, v.composer.input)
        // a conductor's @ names chats (cockpit-route.ts), not files
        if (kind === 'at' && v.s.role !== 'conductor') atMenu(anchor, v.s.cwd, v.composer.input)
      },
    })
    const next = el('div', 'ss-next')
    next.hidden = true
    next.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-next]')?.dataset.next
      if (act === 'use') {
        v.composer.input.value = v.brief?.next ?? ''
        v.composer.input.dispatchEvent(new Event('input', { bubbles: true }))
        v.composer.input.focus()
      }
      if (act === 'use' || act === 'hide') {
        next.dataset.hidden = v.brief?.next ?? ''
        paintNext(v)
      }
    })
    r.appendChild(next)
    r.appendChild(v.composer.el)
    if (s.role === 'conductor') {
      const off = attachChatMentions(v.composer.input, v.composer.el)
      const was = v.cockpit
      v.cockpit = () => {
        was?.()
        off()
      }
    }
    v.composer.input.addEventListener('input', () => paintNext(v))
    paintViewChips(v)
    v.composer.el.addEventListener('click', (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-chip="acct-switch"]')
      if (chip) accountSwitchMenu(v, chip)
    })
    const latest = el('button', 'ss-latest')
    latest.type = 'button'
    latest.hidden = true
    latest.innerHTML = `${ICON.chev}<span>Latest</span>`
    latest.addEventListener('click', () => pinBottom(v))
    r.insertBefore(latest, v.tasks)
    v.track.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      if (t.closest('.tr-dock')) return setTrackDocked(!trackDocked())
      const i = t.closest<HTMLElement>('[data-go]')?.dataset.go
      const u = i ? v.log.querySelectorAll<HTMLElement>(':scope > .m-user')[Number(i)] : undefined
      if (!u) return
      v.stick = false
      v.log.scrollTo({ top: Math.max(0, u.offsetTop - 12), behavior: 'smooth' })
    })
    // the panel opens on a short hover, so passing the rail on the way to the chat leaves it shut
    v.track.addEventListener('pointerenter', () => hoverTrack(v, true))
    v.track.addEventListener('pointerleave', () => hoverTrack(v, false))
    v.root.classList.toggle('track-docked', trackDocked())
    v.log.addEventListener('click', (e) => {
      const pin = (e.target as HTMLElement).closest<HTMLElement>('.m-pin, .m-pin-note')
      if (pin) togglePin(v, pin.closest('.m-user') as HTMLElement)
    })
    v.log.addEventListener('scroll', () => scheduleTrack(v, true), { passive: true })
    // the gestures that count as you moving the log yourself
    const mine = () => {
      v.userAt = performance.now()
    }
    for (const ev of ['wheel', 'touchmove', 'pointerdown'] as const)
      v.log.addEventListener(ev, mine, { passive: true })
    v.log.addEventListener('keydown', (e) => {
      if (SCROLL_KEYS.has(e.key)) mine()
    })
    v.log.addEventListener(
      'scroll',
      () => {
        // a log taken off screen (switching tabs, moving groups) reports a scroll to the top;
        // that is not you scrolling up
        if (!v.log.isConnected || !v.log.clientHeight) return
        const now = performance.now()
        const atBottom = v.log.scrollHeight - v.log.scrollTop - v.log.clientHeight <= BOTTOM_SLACK
        if (now - v.userAt < GESTURE_MS)
          v.stick = atBottom // yours: the only thing that may stop it following
        else if (now - v.selfAt < SELF_MS)
          return // ours, and already at the bottom
        else if (atBottom) v.stick = true // you scrolled back down: follow again
        latest.hidden = v.stick
      },
      { passive: true },
    )
    // The log growing is not you scrolling. While it is following, keep it at the bottom as
    // content arrives — streamed text, a code block that lays out late, tool output that
    // expands — and when the log's own box changes size. stickSoon coalesces these to one
    // scroll per frame however many mutations land in it.
    v.grow = new MutationObserver(() => stickSoon(v))
    v.grow.observe(v.log, { childList: true, subtree: true, characterData: true })
    // and the track down its edge follows the log's box (the conductor's deck growing moves it)
    v.fit = new ResizeObserver(() => {
      stickSoon(v)
      scheduleTrack(v, true)
    })
    v.fit.observe(v.log)
    // images and code blocks that finish loading later still leave you at the bottom
    v.log.addEventListener(
      'load',
      () => {
        stickSoon(v)
      },
      true,
    )
    v.log.addEventListener('click', (e) => {
      const h = (e.target as HTMLElement).closest<HTMLElement>('.m-tool-h')
      if (h && !h.parentElement?.classList.contains('flat'))
        h.parentElement?.classList.toggle('open')
    })
    v.tasks.addEventListener('click', () => {
      v.tasksOpen = !v.tasksOpen
      paintTasks(v)
    })
    // a chat that is not on screen keeps its events and draws them when it comes back into view
    v.unwatch = presence.watch(v.root, (on) => {
      v.shown = on
      if (v.releaseTimer) clearTimeout(v.releaseTimer)
      v.releaseTimer = on ? null : setTimeout(() => release(v), RELEASE_AFTER_MS)
      if (!on) return tickWorking()
      drain(v)
      const bg = summaries.find((x) => x.id === v.s.id)?.work?.bg
      if (bg) paintBackground(v.log, bg)
      paintRunStrip(v.log, v.s.id)
      tickWorking()
    })
    connect(v)
    return v
  }

  /** which Claude account this chat runs on, in the composer under it; click to move the chat */
  function paintViewChips(v: View) {
    const a = accountOf(v.s.account)
    const label = accountLabel(v.s)
    const html = `<button type="button" class="cx-chip acct-chip" data-chip="acct-switch" style="--ac:${accountColour(v.s.account)}" title="${esc(`${a?.email ? `Claude account: ${label} · ${a.email}${a.plan ? ` · ${a.plan}` : ''}` : `Claude account: ${label}`}\nClick to carry this chat over to another account`)}"><i></i>${esc(label)}<span>▾</span></button>`
    if (v.root.dataset.chips === html) return
    v.root.dataset.chips = html
    v.composer.setChips(html)
  }

  /** the 5-hour window's use for an account, when the meter has it */
  const fiveHourOf = (id: string) =>
    usageList.find((u) => u.id === id)?.windows.find((w) => w.key === 'five_hour')
  function accountSwitchMenu(v: View, anchor: HTMLElement) {
    const real = accounts.filter((a) => !a.demo)
    showPop(
      anchor,
      real
        .map((a) => {
          const five = fiveHourOf(a.id)
          const why =
            a.id === v.s.account
              ? 'This chat’s account'
              : !a.loggedIn
                ? 'Not signed in'
                : [five && `5h ${Math.round(five.used)}% used`, a.email !== a.label && a.email]
                    .filter(Boolean)
                    .join(' · ') || 'Signed in'
          return `<button type="button" class="pop-i${a.id === v.s.account ? ' on' : ''}" data-val="${esc(a.id)}"${a.loggedIn ? '' : ' disabled'}><i style="background:${accountColour(a.id)};border-radius:50%"></i><span><b>${esc(a.label)}</b><em>${esc(why)}</em></span></button>`
        })
        .join('') +
        '<button type="button" class="pop-i manage" data-val="__manage"><span><b>Manage accounts…</b></span></button>',
      (val) => {
        if (val === '__manage') return paintAccounts()
        if (val !== v.s.account) switchAccountOf(v, val, false)
      },
    )
  }
  /** a usage limit, as Claude Code words it: offer the accounts that can carry on */
  const LIMIT_RE = /\b(session|usage|weekly|opus|sonnet)? ?limit\b.*\breset|hit your .*limit/i
  function limitOffer(v: View): HTMLElement | null {
    const others = accounts.filter((a) => !a.demo && a.loggedIn && a.id !== v.s.account)
    if (!others.length || v.s.account === 'demo') return null
    const box = el('div', 'm-note m-switch')
    box.append('Carry on with another account: ')
    for (const a of others) {
      const b = el('button', 'ss-link')
      b.type = 'button'
      const five = fiveHourOf(a.id)
      b.textContent = `Continue on ${a.label.replace(/@.*$/, '')}${five ? ` (${Math.round(five.used)}% of 5h used)` : ''}`
      b.addEventListener('click', () => {
        for (const x of box.querySelectorAll('button')) x.disabled = true
        switchAccountOf(v, a.id, true).then((ok) => {
          if (ok) box.remove()
          else for (const x of box.querySelectorAll('button')) x.disabled = false
        })
      })
      box.append(b, ' ')
    }
    return box
  }
  async function switchAccountOf(v: View, id: string, resume: boolean) {
    const r = await fetch(`${API}/sessions/${v.s.id}/account`, {
      method: 'POST',
      headers: WRITE,
      body: JSON.stringify({ account: id, resume }),
      signal: AbortSignal.timeout(60_000),
    }).catch(() => null)
    if (r?.ok) return true
    const d = await r?.json().catch(() => ({}))
    await ask({
      title: 'Could not switch account',
      body: d?.error ?? 'Claude did not answer',
      cancel: null,
    })
    return false
  }

  async function setModelOf(v: View, id: string) {
    v.s.model = id || null
    v.composer.setModel(v.s.model)
    const r = await post(`/sessions/${v.s.id}/model`, { model: id })
    if (!r.ok) {
      const d = await r.json().catch(() => ({}))
      await ask({ title: 'Could not switch model', body: d.error ?? '', cancel: null })
    }
  }

  async function setMode(v: View, m: Mode) {
    v.s.mode = m
    v.composer.setMode(m)
    await post(`/sessions/${v.s.id}/mode`, { mode: m })
  }

  // ------------------------------------------------------------ one stream for every chat
  /**
   * Every open chat's events arrive on one connection. A browser holds six connections to a
   * host, so a stream per chat froze the page once six chats had been looked at: sending,
   * ending and refreshing all queued behind the streams.
   */
  let hub: EventSource | null = null
  let hubTimer: ReturnType<typeof setTimeout> | null = null
  let hubOpened = false
  let hubFails = 0
  /** a server without the shared stream (not restarted yet): each chat keeps its own */
  let perChat = false

  /** the first burst is the conversation so far (hundreds of events for a long chat): draw it
   *  out of sight in small slices, then show it once, at the bottom */
  function startReplay(v: View) {
    v.replay = true
    v.replayStart = performance.now()
    v.root.classList.add('replaying')
    if (v.replayTimer) clearTimeout(v.replayTimer)
    v.replayTimer = setTimeout(() => endReplay(v), 400)
  }
  /** true when the host restarted: the chat's events were numbered afresh, so the window
   *  starts over from the recovered conversation instead of waiting for old numbers */
  function onSummary(v: View, d: { epoch?: string }) {
    if (!d.epoch) return false
    const restarted = !!v.epoch && d.epoch !== v.epoch
    v.epoch = d.epoch
    if (restarted) {
      resetView(v)
      startReplay(v)
    }
    return restarted
  }
  function onEvent(v: View, e: Ev) {
    if (e.seq <= v.lastSeq) return
    v.lastSeq = e.seq
    // streamed words not drawn yet join the ones before them: one update rather than hundreds
    const last = v.queue[v.queue.length - 1]
    if (e.t === 'delta' && last?.t === 'delta' && !e.sub && !last.sub) {
      last.text = String(last.text ?? '') + String(e.text ?? '')
      last.seq = e.seq
      last.at = e.at
    } else v.queue.push(e)
    drainSoon(v)
  }
  /**
   * A chat's log is the heaviest thing on the page: every message, tool row and diff stays in
   * memory for as long as the chat is open. One that has been out of view this long gives it
   * back, and is drawn again from the host (which keeps the whole conversation) the next time it
   * is shown, exactly as a chat opened for the first time is. A chat with something typed or
   * pasted in its composer keeps everything. `laika.chat.releaseMs` overrides the wait, for tests.
   */
  const RELEASE_AFTER_MS = Number(localStorage.getItem('laika.chat.releaseMs')) || 10 * 60_000
  function release(v: View) {
    v.releaseTimer = null
    if (v.shown || v.root.isConnected || views.get(v.s.id) !== v) return
    if (v.composer.input.value.trim() || v.composer.images.length) return
    v.es?.close()
    v.grow?.disconnect()
    v.fit?.disconnect()
    v.unwatch?.()
    v.cockpit?.()
    for (const t of [v.awayTimer, v.replayTimer, v.trackTimer]) if (t) clearTimeout(t)
    trackLater.delete(v)
    disposeRunStrip(v.log)
    views.delete(v.s.id)
    if (!perChat) resubscribe()
  }
  /** background draw rate: the window is visible but another app is in use */
  const AWAY_DRAW_MS = 1000
  /** draw now when the chat is on screen, once a second in the background, never when hidden */
  function drainSoon(v: View) {
    if (!v.shown) return
    if (presence.atLeast('away')) {
      v.awayTimer ??= setTimeout(() => {
        v.awayTimer = null
        drain(v)
      }, AWAY_DRAW_MS)
      return
    }
    drain(v)
  }

  function connect(v: View) {
    if (v.lastSeq === 0) startReplay(v)
    if (perChat) connectOne(v)
    else resubscribe()
  }

  /** (re)open the shared stream for the chats on the page, each from the last event it has */
  function resubscribe(now = false) {
    if (hubTimer) clearTimeout(hubTimer)
    hubTimer = null
    // chats opened together share one reconnect
    if (!now) {
      hubTimer = setTimeout(() => resubscribe(true), 30)
      return
    }
    hub?.close()
    hub = null
    const subs = [...views.values()].map((v) => `${v.s.id}:${v.lastSeq}`)
    if (!subs.length) return
    const es = new EventSource(`${API}/stream?subs=${encodeURIComponent(subs.join(','))}`)
    hub = es
    hubOpened = false
    es.onopen = () => {
      hubOpened = true
      hubFails = 0
    }
    es.addEventListener('summary', (m) => {
      const d = JSON.parse((m as MessageEvent).data) as { sid: string; epoch?: string; work?: Work }
      const v = views.get(d.sid)
      if (v && d.work) setWork(v, d.work)
      if (v && onSummary(v, d)) resubscribe(true)
    })
    es.addEventListener('progress', (m) => {
      const d = JSON.parse((m as MessageEvent).data) as Work & { sid: string }
      const v = views.get(d.sid)
      if (v) setWork(v, d)
    })
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as Ev & { sid: string }
      const v = views.get(e.sid)
      if (v) onEvent(v, e)
    }
    es.onerror = () => {
      es.close()
      if (hub !== es) return
      hub = null
      if (!hubOpened && ++hubFails >= 3) {
        perChat = true
        for (const v of views.values()) connectOne(v)
        return
      }
      // the host or server may be restarting; pick up from the last event each chat saw
      hubTimer = setTimeout(() => resubscribe(true), hubOpened ? 300 : 1500)
    }
  }

  function connectOne(v: View) {
    v.es?.close()
    const es = new EventSource(`${API}/sessions/${v.s.id}/events?since=${v.lastSeq}`)
    v.es = es
    es.addEventListener('summary', (m) => {
      const d = JSON.parse((m as MessageEvent).data)
      if (d.work) setWork(v, d.work)
      if (onSummary(v, d)) connectOne(v)
    })
    es.addEventListener('progress', (m) => setWork(v, JSON.parse((m as MessageEvent).data)))
    es.onmessage = (m) => onEvent(v, JSON.parse(m.data) as Ev)
    es.onerror = () => {
      // the host may be restarting; reconnect and resume from the last event seen
      es.close()
      if (views.get(v.s.id) === v) setTimeout(() => views.get(v.s.id) === v && connectOne(v), 1500)
    }
  }

  function resetView(v: View) {
    v.queue = []
    v.log.replaceChildren()
    v.rows.clear()
    v.lastSeq = 0
    v.live = null
    v.liveText = ''
    v.lastText = null
    v.todos = []
    v.lastUser = null
    v.brief = null
    paintTasks(v)
    paintWorking(v)
  }

  /** inline code short enough to fit stays on one line instead of breaking at a hyphen */
  function tidyCode(node: HTMLElement) {
    for (const c of node.querySelectorAll<HTMLElement>(':not(pre) > code'))
      if ((c.textContent ?? '').length <= 36) c.classList.add('nb')
  }

  // ------------------------------------------------------------ event rendering
  /** one scroll to the bottom per frame, however many events arrived in it */
  const stickSoon = (v: View) => {
    if (!v.stick || v.stickQueued || v.replay) return
    v.stickQueued = true
    requestAnimationFrame(() => {
      v.stickQueued = false
      if (v.stick) toBottom(v)
    })
  }
  /** draw queued events ~12ms at a time, so a long history never freezes the page */
  function drain(v: View) {
    if (v.draining) return
    v.draining = true
    const step = () => {
      // gone out of view mid-way: the rest waits for it to come back
      if (!v.shown) {
        v.draining = false
        return
      }
      const t0 = performance.now()
      while (v.queue.length && performance.now() - t0 < 12) render(v, v.queue.shift() as Ev)
      if (v.queue.length) {
        // one slice per frame, so what it added is laid out and painted before the next: a
        // backlog (a chat coming back into view) never lands as one long frame
        requestAnimationFrame(step)
        return
      }
      v.draining = false
      if (!v.replay) return stickSoon(v)
      // the burst is over once events stop arriving for a moment (or it has run long enough)
      if (v.replayTimer) clearTimeout(v.replayTimer)
      v.replayTimer = setTimeout(
        () => endReplay(v),
        performance.now() - v.replayStart > 1500 ? 0 : 60,
      )
    }
    step()
  }
  function endReplay(v: View) {
    if (!v.replay || v.queue.length || v.draining) return
    v.replay = false
    v.replayTimer = null
    v.root.classList.remove('replaying')
    pinBottom(v)
    scheduleTrack(v)
  }

  // ------------------------------------------------------------ the track beside a chat
  const pinsFor = (v: View): Record<string, string> => {
    try {
      return JSON.parse(localStorage.getItem(PINS_KEY) ?? '{}')[nameKey(v.s)] ?? {}
    } catch {
      return {}
    }
  }
  function savePins(v: View, pins: Record<string, string>) {
    try {
      const all = JSON.parse(localStorage.getItem(PINS_KEY) ?? '{}')
      if (Object.keys(pins).length) all[nameKey(v.s)] = pins
      else delete all[nameKey(v.s)]
      localStorage.setItem(PINS_KEY, JSON.stringify(all))
    } catch {}
  }
  /** a step Claude took for a prompt, counted on that prompt's node */
  function countStep(u: HTMLElement, name: string, input: Record<string, unknown>) {
    if (name === 'TodoWrite') return
    u.dataset.steps = String(Number(u.dataset.steps ?? 0) + 1)
    const path = input.file_path ?? input.notebook_path
    if (!EDITS.has(name) || typeof path !== 'string') return
    const files = u.dataset.files ? u.dataset.files.split('\n') : []
    const base = path.split('/').pop() as string
    if (!files.includes(base) && files.length < 60) u.dataset.files = [...files, base].join('\n')
  }
  const firstLine = (u: HTMLElement) =>
    (u.querySelector('.ss-md')?.textContent ?? '').trim().split('\n')[0]?.slice(0, 100) || 'Image'
  async function togglePin(v: View, u: HTMLElement) {
    const key = u.dataset.key as string
    const pins = pinsFor(v)
    const note = await ask({
      title: pins[key] ? 'Edit the pin' : 'Pin this to the track',
      body: pins[key]
        ? 'Change the note, or clear it to unpin.'
        : 'A few words on what this part of the chat is about. It shows on the track beside the chat.',
      input: pins[key] ?? firstLine(u).slice(0, 60),
      ok: pins[key] ? 'Save' : 'Pin',
    })
    if (typeof note !== 'string') return
    if (note.trim()) pins[key] = note.trim().slice(0, 80)
    else if (pins[key]) delete pins[key]
    else return
    savePins(v, pins)
    paintPins(v)
  }
  function paintPins(v: View) {
    const pins = pinsFor(v)
    for (const u of v.log.querySelectorAll<HTMLElement>(':scope > .m-user')) {
      const note = pins[u.dataset.key ?? '']
      u.classList.toggle('pinned', !!note)
      const tag = u.querySelector<HTMLElement>('.m-pin-note')
      if (note) {
        if (tag) tag.textContent = `★ ${note}`
        else
          u.insertAdjacentHTML(
            'afterbegin',
            `<button type="button" class="m-pin-note" title="Edit or unpin">★ ${esc(note)}</button>`,
          )
      } else tag?.remove()
    }
    scheduleTrack(v)
  }
  /** a scroll only relights the prompt you are reading; anything else redraws the track */
  /** chats whose track waits for the window to be in use again */
  const trackLater = new Set<View>()
  presence.onLevel(() => {
    if (presence.atLeast('away')) return
    for (const v of trackLater) scheduleTrack(v, true)
    trackLater.clear()
  })
  function scheduleTrack(v: View, scrolled = false) {
    if (!scrolled) v.trackDirty = true
    if (v.trackQueued || v.replay) return
    // in the background the track (prompts down the edge) is redrawn once, on return
    if (presence.atLeast('away')) return void trackLater.add(v)
    v.trackQueued = true
    requestAnimationFrame(() => {
      v.trackQueued = false
      // messages laid out late (images, rows scrolled into view) move the prompts: redraw then too
      if (v.trackDirty || v.trackSize !== `${v.log.scrollHeight}:${v.log.clientHeight}`)
        paintTrack(v)
      else lightTrack(v)
    })
  }
  function lightTrack(v: View, force = false) {
    const middle = v.log.scrollTop + v.log.clientHeight * 0.4
    let here = -1
    v.trackTops.forEach((top, i) => {
      if (top <= middle) here = i
    })
    if (here === v.trackHere && !force) return
    v.trackHere = here
    for (const b of v.track.querySelectorAll<HTMLElement>('[data-go]'))
      b.classList.toggle('here', Number(b.dataset.go) === here)
  }
  const trackDocked = () => {
    try {
      return localStorage.getItem(TRACK_DOCK_KEY) === '1'
    } catch {
      return false
    }
  }
  function setTrackDocked(on: boolean) {
    try {
      localStorage.setItem(TRACK_DOCK_KEY, on ? '1' : '0')
    } catch {}
    for (const x of views.values()) {
      x.root.classList.toggle('track-docked', on)
      x.track.classList.remove('open')
      scheduleTrack(x)
    }
  }
  function hoverTrack(v: View, over: boolean) {
    if (v.trackTimer) clearTimeout(v.trackTimer)
    // the ages on the nodes are only redrawn with the track: freshen them as it opens
    if (over) scheduleTrack(v)
    v.trackTimer = setTimeout(
      () => {
        v.trackTimer = null
        v.track.classList.toggle('open', over)
        if (over) v.track.querySelector('.tr-n.here')?.scrollIntoView({ block: 'nearest' })
      },
      over ? 160 : 260,
    )
  }
  /** where a prompt got to: from the brief if it has read that far, otherwise from how the turn ended */
  function statusOf(v: View, u: HTMLElement, last: boolean, b?: { status: string }) {
    if (last && (v.s.state === 'running' || v.s.state === 'starting')) return 'open'
    if (last && v.s.state === 'waiting') return 'wait'
    if (b?.status) return b.status
    const end = u.dataset.end ?? (u.dataset.ans ? 'done' : '')
    return end === 'done' ? 'done' : end === 'error' || end === 'interrupted' ? 'blocked' : 'open'
  }
  const STATUS_WORD: Record<string, string> = {
    done: 'Done',
    partial: 'Part done',
    blocked: 'Stopped',
    open: 'Working',
    wait: 'Waiting for you',
  }
  function turnMeta(u: HTMLElement) {
    const bits: string[] = []
    const at = Number(u.dataset.at)
    if (at) bits.push(ago(at) === 'now' ? 'just now' : `${ago(at)} ago`)
    const steps = Number(u.dataset.steps ?? 0)
    if (steps) bits.push(`${steps} step${steps === 1 ? '' : 's'}`)
    const files = u.dataset.files ? u.dataset.files.split('\n') : []
    if (files.length) bits.push(`${files.length} file${files.length === 1 ? '' : 's'}`)
    const secs = Number(u.dataset.ms ?? 0) / 1000
    if (secs >= 1) bits.push(secs >= 60 ? `${Math.round(secs / 60)}m` : `${Math.round(secs)}s`)
    const err = Number(u.dataset.err ?? 0)
    if (err) bits.push(`${err} failed`)
    return { text: bits.join(' · '), files }
  }
  /**
   * The track: a slim rail of points, one per prompt, placed where it sits in the conversation;
   * hovering it (or docking it) opens the panel: the chat's goal and where it stands, then every
   * prompt as a node with its label, status, age, steps and files.
   */
  function paintTrack(v: View) {
    v.trackDirty = false
    v.trackSize = `${v.log.scrollHeight}:${v.log.clientHeight}`
    const users = [...v.log.querySelectorAll<HTMLElement>(':scope > .m-user')]
    v.trackTops = users.map((u) => u.offsetTop)
    const pins = pinsFor(v)
    const show = users.length > 1 || Object.keys(pins).length > 0 || v.todos.length > 0 || !!v.brief
    v.root.classList.toggle('has-track', show)
    v.track.hidden = !show
    if (!show) return
    v.track.style.top = `${v.log.offsetTop}px`
    v.track.style.height = `${v.log.clientHeight}px`
    const total = Math.max(1, v.log.scrollHeight)
    const done = v.todos.filter((t) => t.status === 'completed').length
    const labels = new Map((v.brief?.turns ?? []).map((t) => [t.p, t]))
    const rows = users.map((u, i) => {
      const b = labels.get(u.dataset.pk ?? '')
      const last = i === users.length - 1
      return {
        u,
        note: pins[u.dataset.key ?? ''],
        label: b?.label || firstLine(u),
        guessed: !b?.label,
        status: statusOf(v, u, last, b),
        ring: last && v.todos.length > 0,
      }
    })
    const rail = rows
      .map((r, i) => {
        const top = Math.min(97, Math.max(1, ((v.trackTops[i] ?? 0) / total) * 100))
        return `<button type="button" class="tr-pt s-${r.status}${r.note ? ' pin' : ''}${r.ring ? ' ring' : ''}" data-go="${i}" style="top:${top.toFixed(2)}%${r.ring ? `;--p:${Math.round((done / v.todos.length) * 100)}` : ''}" aria-label="${esc(r.label)}"><i></i>${r.note ? `<span>${esc(r.note)}</span>` : ''}</button>`
      })
      .join('')
    const br = v.brief
    const head = br?.goal
      ? `<div class="tr-goal"><b>Goal</b><p>${esc(br.goal)}</p></div>${br.now ? `<div class="tr-now"><b>Now</b><p>${esc(br.now)}</p></div>` : ''}${br.next ? `<div class="tr-next"><b>Next</b><p>${esc(br.next)}</p></div>` : ''}`
      : `<div class="tr-goal guess"><b>Goal</b><p>${esc(rows[0]?.label ?? 'Not started')}</p><small>Claude reads the chat and sums it up after each reply</small></div>`
    const list = rows
      .map((r, i) => {
        const m = turnMeta(r.u)
        const tip = `${firstLine(r.u)}${m.files.length ? `\n\nFiles: ${m.files.join(', ')}` : ''}${r.ring ? `\nTasks ${done}/${v.todos.length}` : ''}`
        return `<li><button type="button" class="tr-n s-${r.status}${r.note ? ' pin' : ''}" data-go="${i}" title="${esc(tip)}"><i class="tr-st"></i><span class="tr-l${r.guessed ? ' guess' : ''}">${esc(r.label)}</span><span class="tr-m"><em>${STATUS_WORD[r.status] ?? ''}</em>${m.text ? ` · ${esc(m.text)}` : ''}${r.ring ? ` · tasks ${done}/${v.todos.length}` : ''}</span>${r.note ? `<span class="tr-pin">★ ${esc(r.note)}</span>` : ''}</button></li>`
      })
      .join('')
    const panel = `<div class="tr-brief">${head}<button type="button" class="tr-dock" title="${trackDocked() ? 'Close the panel beside every chat' : 'Keep this panel open beside every chat'}" aria-label="Dock">${trackDocked() ? '⇤' : '⇥'}</button></div><ol class="tr-list">${list}</ol>`
    let railEl = v.track.querySelector<HTMLElement>('.tr-rail')
    let panelEl = v.track.querySelector<HTMLElement>('.tr-panel')
    if (!railEl || !panelEl) {
      v.track.innerHTML = '<div class="tr-rail"></div><div class="tr-panel"></div>'
      railEl = v.track.querySelector('.tr-rail') as HTMLElement
      panelEl = v.track.querySelector('.tr-panel') as HTMLElement
    }
    if (railEl.dataset.html !== rail) {
      railEl.dataset.html = rail
      railEl.innerHTML = rail
    }
    if (panelEl.dataset.html !== panel) {
      const listEl = panelEl.querySelector('.tr-list')
      const keep = listEl?.scrollTop ?? 0
      panelEl.dataset.html = panel
      panelEl.innerHTML = panel
      const fresh = panelEl.querySelector('.tr-list')
      if (fresh) fresh.scrollTop = keep
    }
    // the prompt you are reading is lit in both, without redrawing either on every scroll
    lightTrack(v, true)
  }

  // ------------------------------------------------------------ sub-agents
  /** a sub-agent is a card of its own: what it was asked, what it is doing now, its steps, its report */
  function agentCard(v: View, e: Ev, input: Record<string, unknown>) {
    const kind = String(input.subagent_type ?? '')
    const card = el(
      'div',
      `m-agent ${e.history ? 'done' : 'running'}`,
      `<button type="button" class="m-agent-h"><i class="ag-dot"></i><b>${esc(!kind || kind === 'general-purpose' ? 'Sub-agent' : kind)}</b><span>${esc(String(input.description ?? ''))}</span><em class="ag-n"></em><i class="ag-caret">▸</i></button>
      <div class="m-agent-now">${e.history ? '' : 'Starting…'}</div>
      <div class="m-agent-b">
        ${input.prompt ? `<details class="m-agent-brief"><summary>Brief from Claude</summary><div class="ss-md">${renderMarkdown(String(input.prompt))}</div></details>` : ''}
        <div class="m-agent-steps"></div>
      </div>`,
    )
    card.dataset.tool = 'Agent'
    card.dataset.steps = '0'
    card.querySelector('.m-agent-h')?.addEventListener('click', () => card.classList.toggle('open'))
    v.rows.set(String(e.id), card)
    append(v, card)
    stickSoon(v)
  }
  function agentStep(card: HTMLElement, row: HTMLElement, label: string) {
    ;(card.querySelector('.m-agent-steps') as HTMLElement).appendChild(row)
    const n = Number(card.dataset.steps ?? 0) + 1
    card.dataset.steps = String(n)
    ;(card.querySelector('.ag-n') as HTMLElement).textContent = `${n} step${n === 1 ? '' : 's'}`
    if (card.classList.contains('running'))
      (card.querySelector('.m-agent-now') as HTMLElement).textContent = label
  }
  const append = (v: View, node: HTMLElement) => {
    // Claude's working line and the background line stay last
    const w = v.log.querySelector('.m-working, .m-bg')
    if (w) v.log.insertBefore(node, w)
    else v.log.appendChild(node)
    scheduleTrack(v)
    stickSoon(v)
  }
  const endLive = (v: View) => {
    v.live = null
    v.liveText = ''
  }
  /**
   * Consecutive tool rows fold into one "N steps" group so a long stretch of commands reads as
   * one line; the group opens on click. Anything else (text, a question) starts a new group.
   */
  // steps are one line each now, so a run can show a few before folding to its summary
  const GROUP_AFTER = 10_000
  function groupOf(v: View): HTMLElement {
    const last = v.log.querySelector('.m-working')
      ? v.log.querySelector('.m-working')?.previousElementSibling
      : v.log.lastElementChild
    if (last?.classList.contains('m-steps')) return last as HTMLElement
    const g = el(
      'div',
      'm-steps open',
      '<button type="button" class="m-steps-h"><i></i><span></span></button><div class="m-steps-b"></div>',
    )
    g.querySelector('.m-steps-h')?.addEventListener('click', () => {
      g.dataset.pinned = '1'
      g.classList.toggle('open')
    })
    append(v, g)
    return g
  }
  function placeTool(v: View, row: HTMLElement) {
    const g = groupOf(v)
    ;(g.querySelector('.m-steps-b') as HTMLElement).appendChild(row)
    const rows = [...g.querySelectorAll<HTMLElement>(':scope > .m-steps-b > .m-tool')]
    const n = rows.length
    const head = g.querySelector('.m-steps-h span') as HTMLElement
    // "7 steps · Bash 4 · Read 2 · Edit 1": what the run was, without opening it
    const kinds = new Map<string, number>()
    for (const x of rows) {
      const k = toolLabel(x.dataset.tool ?? '')
      kinds.set(k, (kinds.get(k) ?? 0) + 1)
    }
    const mix = [...kinds]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, c]) => `${k} ${c}`)
      .join(' · ')
    head.textContent = `${n} step${n === 1 ? '' : 's'}${n > 1 ? ` · ${mix}` : ''}`
    // small groups stay open; a long run folds to its header once it grows past the threshold
    if (n > GROUP_AFTER && !g.dataset.pinned) g.classList.toggle('open', !g.dataset.folded)
    if (n === GROUP_AFTER + 1 && !g.dataset.pinned) {
      g.dataset.folded = '1'
      g.classList.remove('open')
    }
    g.classList.toggle('fold', n > GROUP_AFTER)
    stickSoon(v)
  }
  function setWork(v: View, d: Work) {
    const w = v.work
    // a new turn: a new word, and the count starts again
    if (d.start && d.start !== w.start) {
      w.verb = pickVerb(w.verb)
      w.shown = 0
    }
    w.start = d.start
    w.tokens = d.tokens
    w.phase = d.phase
    tickWorking()
    if (d.bg) {
      const row = summaries.find((x) => x.id === v.s.id)
      if (row?.work) row.work.bg = d.bg
      if (v.shown) paintBackground(v.log, d.bg)
    }
    // and this chat's own run, if it has one going (see /runs); a hidden chat paints it on return
    if (v.shown) paintRunStrip(v.log, v.s.id)
  }
  /** the working line sits at the very end of the log while Claude is busy */
  const paintWorking = (v: View) => {
    const busy = v.s.state === 'running' || v.s.state === 'starting'
    let w = v.log.querySelector<HTMLElement>('.m-working')
    if (!busy) {
      w?.remove()
      return
    }
    if (!w) {
      if (!v.work.verb) v.work.verb = pickVerb('')
      v.work.seen = Date.now()
      w = el(
        'div',
        'm-working',
        '<b class="mw-glyph" aria-hidden="true">✻</b><span class="mw-verb"></span><span class="mw-meta"></span>',
      )
      v.log.appendChild(w)
    } else v.log.appendChild(w)
    tickWorking()
    stickSoon(v)
  }
  /** the spinner, the clock and the count, for every chat that is working, on one timer */
  let workTimer: ReturnType<typeof setInterval> | null = null
  let workGap = 0
  let workFrame = 0
  /** the spinner turns while you use the window; idle or in the background only the clock moves */
  presence.onLevel(() => tickWorking())
  function tickWorking() {
    let any = false
    workFrame++
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    for (const v of views.values()) {
      if (!v.shown) continue
      const line = v.log.querySelector<HTMLElement>(':scope > .m-working')
      if (!line) continue
      any = true
      const w = v.work
      if (w.shown < w.tokens) w.shown += Math.max(1, Math.ceil((w.tokens - w.shown) / 5))
      else w.shown = w.tokens
      const secs = Math.max(0, Math.floor((Date.now() - (w.start || w.seen)) / 1000))
      const took = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
      const meta = [
        took,
        w.shown ? `↓ ${w.shown.toLocaleString()} tokens` : '',
        w.phase === 'thinking' ? 'thinking' : '',
      ]
        .filter(Boolean)
        .join(' · ')
      ;(line.children[0] as HTMLElement).textContent = reduce
        ? '✻'
        : (GLYPHS[workFrame % GLYPHS.length] ?? '✻')
      const verb = line.children[1] as HTMLElement
      if (verb.dataset.v !== w.verb) {
        verb.dataset.v = w.verb
        verb.textContent = `${w.verb}…`
      }
      ;(line.children[2] as HTMLElement).textContent = `(${meta})`
    }
    const lvl = presence.current()
    const gap = !any || lvl === 'hidden' ? 0 : lvl === 'live' ? 120 : 1000
    if (gap === workGap) return
    if (workTimer) clearInterval(workTimer)
    workTimer = gap ? setInterval(tickWorking, gap) : null
    workGap = gap
  }
  let changesTimer: ReturnType<typeof setTimeout> | null = null

  function render(v: View, e: Ev) {
    if (v.lastThink && e.t !== 'thinking' && e.t !== 'status' && e.at) {
      const secs = Math.max(1, Math.round((e.at - v.lastThink.at) / 1000))
      const sum = v.lastThink.el.querySelector('summary')
      if (sum)
        sum.textContent = `Thought for ${secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`}`
      v.lastThink = null
    }
    switch (e.t) {
      case 'init':
        if (e.model) {
          v.s.model = String(e.model)
          v.composer.setModel(v.s.model)
        }
        v.commands = ((e.commands as string[]) ?? []).map((c) => c.replace(/^\//, ''))
        return
      case 'user': {
        endLive(v)
        v.lastText = null
        // Claude Code writes an interruption into the transcript as if you had said it
        if (/^\[Request interrupted/.test(String(e.text ?? ''))) {
          if (v.lastUser) v.lastUser.dataset.end = 'interrupted'
          append(v, el('div', 'm-note hist', 'Interrupted'))
          return
        }
        // the copy drawn when you pressed send gives way to the host's
        const mine = v.log.querySelector<HTMLElement>(':scope > .m-user.sending')
        if (mine && mine.dataset.text === String(e.text ?? '')) mine.remove()
        const imgs = (e.images as { thumb: string | null; name: string | null }[]) ?? []
        const pics = imgs
          .map((im) =>
            im.thumb
              ? `<img src="${im.thumb}" alt="${esc(im.name ?? 'image')}" />`
              : '<span class="m-img-ph">image</span>',
          )
          .join('')
        const said = String(e.text ?? '')
        if (e.auto) {
          append(
            v,
            el(
              'div',
              'm-note cd-tick',
              `♛ ${esc(said.replace(/^\[autopilot\]\s*/, '').split('\n')[0])}`,
            ),
          )
          return
        }
        const u = el(
          'div',
          said.startsWith(FROM_CONDUCTOR) ? 'm-user from-lead' : 'm-user',
          `${imgs.length ? `<div class="m-imgs">${pics}</div>` : ''}${e.text ? `<div class="ss-md">${renderMarkdown(String(e.text))}</div>` : ''}<button type="button" class="m-pin" title="Pin to the track beside this chat" aria-label="Pin">☆</button>`,
        )
        u.dataset.text = String(e.text ?? '')
        u.dataset.key = textKey(`${e.text ?? ''}|${imgs.length}`)
        u.dataset.pk = promptKey(String(e.text ?? ''))
        u.dataset.at = String(e.at)
        v.lastUser = u
        const note = pinsFor(v)[u.dataset.key]
        if (note) {
          u.classList.add('pinned')
          u.insertAdjacentHTML(
            'afterbegin',
            `<button type="button" class="m-pin-note" title="Edit or unpin">★ ${esc(note)}</button>`,
          )
        }
        append(v, u)
        return
      }
      case 'delta':
        if (!v.live) {
          v.live = el('div', 'm-claude live')
          append(v, v.live)
        }
        v.liveText += String(e.text)
        // add to the words already there rather than setting the whole message again
        if (v.live.childNodes.length === 1 && v.live.firstChild instanceof Text)
          v.live.firstChild.appendData(String(e.text))
        else v.live.textContent = v.liveText
        stickSoon(v)
        return
      case 'text': {
        if (e.sub) {
          const card = v.rows.get(String(e.sub))
          const now = card?.querySelector<HTMLElement>('.m-agent-now')
          if (now && card?.classList.contains('running'))
            now.textContent = String(e.text).trim().split('\n')[0]?.slice(0, 160) ?? ''
          return
        }
        if (v.lastUser) v.lastUser.dataset.ans = '1'
        const html = `<div class="ss-md">${renderMarkdown(String(e.text))}</div>`
        let node: HTMLElement
        if (v.live) {
          v.live.classList.remove('live')
          v.live.innerHTML = html
          node = v.live
        } else {
          node = el('div', 'm-claude', html)
          append(v, node)
        }
        tidyCode(node)
        v.lastText = node
        endLive(v)
        stickSoon(v)
        return
      }
      case 'thinking': {
        endLive(v)
        const think = el(
          'details',
          'm-think',
          `<summary>Thinking…</summary><div class="ss-md">${renderMarkdown(String(e.text))}</div>`,
        )
        v.lastThink = { el: think, at: e.at }
        // thinking between steps belongs to the run: it must not split one run into many
        const w = v.log.querySelector('.m-working')
        const last = (w ? w.previousElementSibling : v.log.lastElementChild) as HTMLElement | null
        if (last?.classList.contains('m-steps'))
          (last.querySelector('.m-steps-b') as HTMLElement).appendChild(think)
        else append(v, think)
        return
      }
      case 'tool': {
        endLive(v)
        // text straight before a step was Claude narrating its work, not its answer
        if (!e.sub && v.lastText) {
          v.lastText.classList.add('between')
          v.lastText = null
        }
        const name = String(e.name)
        const input = (e.input as Record<string, unknown>) ?? {}
        if (name === 'TodoWrite') {
          // a sub-agent's own to-do list is not the chat's
          if (e.sub) return
          v.todos = (input.todos as Todo[]) ?? []
          paintTasks(v)
          scheduleTrack(v)
          return
        }
        if (name === 'AskUserQuestion') return
        if (!e.sub && v.lastUser) countStep(v.lastUser, name, input)
        if (AGENT_TOOLS.has(name) && !e.sub) return agentCard(v, e, input)
        const body =
          name === 'Bash'
            ? `<div class="m-io" title="Click to see all of it"><div class="m-io-r in"><span>IN</span><pre>${highlight(String(input.command ?? ''), 'sh')}</pre></div></div>`
            : toolBody(name, input)
        const cls = [
          'm-tool',
          e.history ? 'done' : 'running',
          e.sub ? 'sub' : '',
          body && OPEN_BY_DEFAULT.has(name) ? 'open' : '',
          body ? '' : 'flat',
        ]
        const row = el(
          'div',
          cls.filter(Boolean).join(' '),
          `<button type="button" class="m-tool-h"><i class="bul"></i><b>${esc(toolLabel(name))}</b><span>${esc(toolTitle(name, input, v.s.cwd))}</span><em class="m-stat"></em></button><div class="m-tool-b">${body}</div>`,
        )
        row.dataset.tool = name
        row.querySelector('.m-io')?.addEventListener('click', (ev) => {
          if ((ev.target as HTMLElement).closest('a') || getSelection()?.toString()) return
          ;(ev.currentTarget as HTMLElement).classList.toggle('full')
        })
        if (name === 'Bash' && input.command)
          (row.querySelector('.m-tool-h') as HTMLElement).title = String(input.command).slice(
            0,
            600,
          )
        const d = row.querySelector('.ss-diff') as HTMLElement | null
        if (d) {
          ;(row.querySelector('.m-stat') as HTMLElement).innerHTML =
            `<ins>+${d.dataset.add}</ins> <del>−${d.dataset.del}</del>`
        }
        v.rows.set(String(e.id), row)
        const parent = e.sub ? v.rows.get(String(e.sub)) : undefined
        if (parent?.classList.contains('m-agent'))
          agentStep(parent, row, `${toolLabel(name)} ${toolTitle(name, input, v.s.cwd)}`.trim())
        else placeTool(v, row)
        if (e.at >= v.since - 1500) {
          activity(v, {
            tool: name,
            toolId: e.id,
            kind: EDITS.has(name) ? 'edit' : 'read',
            paths: pathsOf(input),
            phase: 'start',
          })
        }
        return
      }
      case 'tool_result': {
        const row = v.rows.get(String(e.id))
        if (!row) return
        if (e.error && v.lastUser && !row.classList.contains('sub'))
          v.lastUser.dataset.err = String(Number(v.lastUser.dataset.err ?? 0) + 1)
        if (e.at >= v.since - 1500)
          activity(v, { toolId: e.id, phase: e.error ? 'failed' : 'done' })
        row.classList.remove('running')
        row.classList.add(e.error ? 'failed' : 'done')
        if (row.classList.contains('m-agent')) {
          // the sub-agent's report: under its steps, the card says it finished
          const n = Number(row.dataset.steps ?? 0)
          ;(row.querySelector('.m-agent-now') as HTMLElement).textContent = e.error
            ? 'Stopped with an error'
            : `Finished${n ? ` after ${n} step${n === 1 ? '' : 's'}` : ''}`
          const report = String(e.text ?? '').trim()
          if (report)
            row
              .querySelector('.m-agent-b')
              ?.insertAdjacentHTML(
                'beforeend',
                `<div class="m-agent-out${e.error ? ' err' : ''}"><div class="m-agent-lbl">Report</div><div class="ss-md">${renderMarkdown(report.length > 12000 ? `${report.slice(0, 12000)}\n\n… (truncated)` : report)}</div></div>`,
              )
          stickSoon(v)
          return
        }
        // a failed step is worth seeing: open its group
        if (e.error) row.closest('.m-steps')?.classList.add('open')
        const text = String(e.text ?? '').trim()
        const name = row.dataset.tool ?? ''
        if (EDITS.has(name) && !e.error) {
          // files on disk moved: refresh the header's change count shortly after
          if (changesTimer) clearTimeout(changesTimer)
          changesTimer = setTimeout(
            () => wsOf(v)?.changes.refresh(),
            presence.atLeast('away') ? 5000 : 600,
          )
          return
        }
        if (!text) return
        const lines = text.split('\n')
        const io = row.querySelector<HTMLElement>('.m-io')
        if (io) {
          // a command's output goes in its box, under the command
          const r = el('div', `m-io-r out${e.error ? ' err' : ''}`, '<span>OUT</span><pre></pre>')
          ;(r.querySelector('pre') as HTMLElement).textContent =
            lines.length > 400
              ? `${lines.slice(0, 400).join('\n')}\n… ${lines.length - 400} more lines`
              : text
          io.appendChild(r)
          if (lines.length > 3)
            (row.querySelector('.m-stat') as HTMLElement).textContent = `${lines.length} lines`
          stickSoon(v)
          return
        }
        const out = el('pre', `m-out${e.error ? ' err' : ''}`)
        out.textContent =
          lines.length > 60
            ? `${lines.slice(0, 60).join('\n')}\n… ${lines.length - 60} more lines`
            : text
        ;(row.querySelector('.m-tool-b') as HTMLElement).appendChild(out)
        row.classList.remove('flat')
        if (e.error) row.classList.add('open')
        if (!EDITS.has(name) && name !== 'Bash' && !e.error && lines.length > 3) {
          ;(row.querySelector('.m-stat') as HTMLElement).textContent = `${lines.length} lines`
        }
        stickSoon(v)
        return
      }
      case 'away':
        if (e.kind === 'asked') v.lastAway = e
        return
      case 'permission':
        endLive(v)
        append(v, permissionCard(v, e))
        v.rows.get(String(e.toolUseId))?.classList.add('asking')
        focusAsk(v)
        return
      case 'question':
        endLive(v)
        append(v, questionCard(v, e))
        focusAsk(v)
        return
      case 'secret':
        endLive(v)
        append(v, secretCard(v, e))
        focusAsk(v)
        return
      case 'resolved': {
        const card = v.log.querySelector<HTMLElement>(
          `[data-req="${CSS.escape(String(e.requestId))}"]`,
        )
        const reply = e.reply as {
          behavior?: string
          answers?: Record<string, string>
          message?: string
          always?: boolean
        }
        let summary: string
        if (e.kind === 'question') {
          const a = Object.entries(reply.answers ?? {})
          summary = a.length
            ? a
                .map(([q, ans]) => `<span class="m-q">${esc(q)}</span> <b>${esc(ans)}</b>`)
                .join('<br>')
            : '<span class="m-q">Question skipped</span>'
        } else if (e.kind === 'secret') {
          summary =
            reply.behavior === 'allow'
              ? '<b class="ok">Saved to the Keychain</b> <span class="m-q">Claude can use it in commands but never sees it</span>'
              : '<b class="no">Not given</b>'
        } else {
          for (const row of v.rows.values()) row.classList.remove('asking')
          summary =
            reply.behavior === 'allow'
              ? `<b class="ok">${reply.always ? 'Allowed, and won’t ask again' : 'Allowed'}</b>`
              : `<b class="no">Denied</b>${reply.message ? ` <span class="m-q">“${esc(reply.message)}”</span>` : ''}`
        }
        const done = el('div', `m-answer ${String(e.kind)}`, summary)
        if (card) card.replaceWith(done)
        else append(v, done)
        return
      }
      case 'status': {
        v.s.state = e.state as Summary['state']
        v.composer.setBusy(v.s.state === 'running' || v.s.state === 'starting')
        paintWorking(v)
        onStatus(v)
        scheduleTrack(v)
        paintNext(v)
        return
      }
      case 'mode':
        v.s.mode = e.mode as Mode
        v.composer.setMode(v.s.mode)
        return
      case 'model':
        v.s.model = (e.model as string | null) ?? null
        v.composer.setModel(v.s.model)
        return
      case 'account': {
        v.s.account = String(e.account)
        v.s.accountLabel = String(e.accountLabel ?? e.account)
        const sum = summaries.find((x) => x.id === v.s.id)
        if (sum && sum !== v.s)
          Object.assign(sum, { account: v.s.account, accountLabel: v.s.accountLabel })
        // the offer under an old limit is spent once the chat has moved
        for (const n of v.log.querySelectorAll('.m-switch')) n.remove()
        paintViewChips(v)
        paintTabs()
        return
      }
      case 'result': {
        endLive(v)
        if (v.lastUser) {
          v.lastUser.dataset.end = e.error ? 'error' : 'done'
          v.lastUser.dataset.ms = String(Number(v.lastUser.dataset.ms ?? 0) + Number(e.ms ?? 0))
        }
        scheduleTrack(v)
        const secs = Number(e.ms ?? 0) / 1000
        if (e.error) {
          append(v, el('div', 'm-note err', esc(e.error)))
          const offer = !e.history && LIMIT_RE.test(String(e.error)) ? limitOffer(v) : null
          if (offer) append(v, offer)
        } else {
          const took = secs >= 60 ? `${Math.round(secs / 60)}m` : `${secs.toFixed(0)}s`
          append(v, el('div', 'm-note', secs >= 1 ? `Done · worked for ${took}` : 'Done'))
        }
        return
      }
      case 'brief':
        v.brief = e as unknown as Brief
        scheduleTrack(v)
        paintNext(v)
        return
      case 'suggestions':
        append(v, suggestCard(v, e))
        return
      case 'autopilot': {
        v.s.autopilot = !!e.on
        v.s.autopilotUntil = (e.until as number | null) ?? null
        const sum = summaryOf(v.s.id)
        if (sum && sum !== v.s)
          Object.assign(sum, { autopilot: v.s.autopilot, autopilotUntil: v.s.autopilotUntil })
        paintLead(v)
        const ws = wsOf(v)
        if (ws) paintWsBar(ws)
        return
      }
      case 'note':
        if (e.text === 'Interrupted' && v.lastUser) v.lastUser.dataset.end = 'interrupted'
        append(v, el('div', e.history ? 'm-note hist' : 'm-note', esc(e.text)))
        return
      case 'error':
        append(v, el('div', 'm-note err', esc(e.message)))
        return
      default:
    }
  }

  function paintTasks(v: View) {
    const t = v.todos
    v.tasks.hidden = !t.length
    if (!t.length) return
    const done = t.filter((x) => x.status === 'completed').length
    const now = t.find((x) => x.status === 'in_progress')
    v.tasks.classList.toggle('open', v.tasksOpen)
    const list = t
      .map(
        (x) =>
          `<li class="${x.status}"><i></i><span>${esc(x.status === 'in_progress' ? (x.activeForm ?? x.content) : x.content)}</span></li>`,
      )
      .join('')
    v.tasks.innerHTML = `<button type="button" class="tk-h"><span class="tk-c">${v.tasksOpen ? '▾' : '▸'}</span>Tasks <b>${done}/${t.length}</b>${now && !v.tasksOpen ? `<em>${esc(now.activeForm ?? now.content)}</em>` : ''}</button>${v.tasksOpen ? `<ol>${list}</ol>` : ''}`
  }

  const focusAsk = (v: View) => {
    if (!isShown(v)) return
    const cards = v.log.querySelectorAll<HTMLElement>('.m-ask:not(.sent)')
    cards[cards.length - 1]?.querySelector<HTMLElement>('.opt')?.focus({ preventScroll: true })
    stickSoon(v)
  }

  /** an approval, the way Claude Code asks: numbered choices, the last lets you redirect Claude */
  function permissionCard(v: View, e: Ev): HTMLElement {
    const tool = String(e.tool)
    const input = (e.input as Record<string, unknown>) ?? {}
    const target = toolTitle(tool, input, v.s.cwd)
    const ask: Record<string, string> = {
      Edit: `make this edit to <b>${esc(target)}</b>`,
      MultiEdit: `make these edits to <b>${esc(target)}</b>`,
      Write: `create <b>${esc(target)}</b>`,
      Bash: 'run this command',
      WebFetch: `fetch <b>${esc(target)}</b>`,
      WebSearch: 'search the web',
    }
    let always = ''
    if (e.canAlways) {
      always = EDITS.has(tool)
        ? 'Yes, allow all edits during this session'
        : `Yes, and don’t ask again for ${tool === 'Bash' ? 'this command' : esc(tool)}`
    }
    const opts = [
      { key: 'yes', label: 'Yes' },
      ...(always ? [{ key: 'always', label: always }] : []),
      { key: 'no', label: 'No, and tell Claude what to do differently' },
    ]
    // away mode refused this just before asking: say why, and offer the allowlist entry it suggests
    const aw = v.lastAway
    v.lastAway = null
    const away = aw && aw.tool === tool && e.seq - aw.seq <= 2 && aw.plain ? aw : null
    const pattern = away?.allowPattern ? String(away.allowPattern) : ''
    const card = el('div', 'm-ask perm')
    card.dataset.req = String(e.requestId)
    card.innerHTML = `
      <div class="ask-h">Do you want to ${ask[tool] ?? `use <b>${esc(tool)}</b>`}?</div>
      ${e.description ? `<p class="ask-d">${esc(e.description)}</p>` : ''}
      ${away ? `<p class="ask-d ask-away"><span class="q-tag">Away</span>${esc(String(away.plain))}${pattern ? ` <button type="button" class="ask-allow" data-away-allow>Always allow <code>${esc(pattern)}</code> while away</button>` : ''}</p>` : ''}
      <div class="ask-body">${toolBody(tool, input) || `<pre class="m-json">${esc(JSON.stringify(input, null, 2))}</pre>`}</div>
      <div class="ask-opts" role="listbox">${opts
        .map(
          (o, i) =>
            `<button type="button" class="opt" role="option" data-opt="${o.key}"><kbd>${i + 1}</kbd><span>${o.label}</span></button>`,
        )
        .join('')}
        <div class="ask-redirect" hidden><input placeholder="Tell Claude what to do instead, then ↵" aria-label="What Claude should do instead" /></div>
      </div>`
    const reply = (r: Record<string, unknown>) => {
      card.classList.add('sent')
      post(`/sessions/${v.s.id}/respond`, { requestId: e.requestId, reply: r })
    }
    const redirect = card.querySelector('.ask-redirect') as HTMLElement
    const note = redirect.querySelector('input') as HTMLInputElement
    const choose = (key: string) => {
      if (card.classList.contains('sent')) return
      if (key === 'yes') reply({ behavior: 'allow' })
      if (key === 'always') reply({ behavior: 'allow', always: true })
      if (key === 'no') {
        redirect.hidden = false
        note.focus()
      }
    }
    card.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-opt]')
      if (b) choose(b.dataset.opt ?? '')
    })
    const allowBtn = card.querySelector<HTMLButtonElement>('[data-away-allow]')
    allowBtn?.addEventListener('click', async () => {
      if (card.classList.contains('sent')) return
      allowBtn.disabled = true
      // the host works the pattern out again from the waiting request; the page only names it
      const r = await post(`/sessions/${v.s.id}/away-allow`, { requestId: e.requestId }).catch(
        () => null,
      )
      if (r?.ok) {
        card.classList.add('sent')
        allowBtn.textContent = 'Allowed while away'
        return
      }
      const err = (await r?.json().catch(() => null)) as { error?: string } | null
      allowBtn.disabled = false
      allowBtn.textContent = err?.error ?? 'Couldn’t save that; try again'
    })
    note.addEventListener('keydown', (k) => {
      if (k.key === 'Enter') reply({ behavior: 'deny', message: note.value.trim() })
      if (k.key === 'Escape') {
        k.stopPropagation()
        redirect.hidden = true
      }
    })
    card.addEventListener('keydown', (k) => {
      if ((k.target as HTMLElement).tagName === 'INPUT') return
      const n = Number(k.key)
      if (n >= 1 && n <= opts.length) {
        k.preventDefault()
        choose(opts[n - 1]?.key ?? '')
      }
      if (k.key === 'ArrowDown' || k.key === 'ArrowUp') {
        k.preventDefault()
        const all = [...card.querySelectorAll<HTMLElement>('.opt')]
        const i = all.indexOf(document.activeElement as HTMLElement)
        all[(i + (k.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus()
      }
    })
    return card
  }

  /**
   * a secret Claude needs: typed here, sent once to the chat host, which puts it straight into the
   * macOS Keychain. It is never shown, echoed into the chat or kept in the page.
   */
  function secretCard(v: View, e: Ev): HTMLElement {
    const card = el('div', 'm-ask secret')
    card.dataset.req = String(e.requestId)
    card.innerHTML = `
      <div class="ask-h"><span class="q-tag">Secret</span>Claude needs <b>${esc(String(e.name))}</b></div>
      ${e.why ? `<p class="ask-d">${esc(String(e.why))}</p>` : ''}
      <p class="ask-d">It goes into your macOS Keychain, not the chat. Don’t paste secrets into messages.</p>
      <form class="ask-opts" autocomplete="off">
        <label class="opt other"><input type="password" data-secret autocomplete="new-password" spellcheck="false" aria-label="Value for ${esc(String(e.name))}" placeholder="Type or paste it, then ↵" /></label>
        <div class="ask-foot"><button type="submit" class="ask-go" data-submit disabled>Save to Keychain</button><button type="button" class="ask-skip" data-skip>Don’t give it</button></div>
      </form>`
    const form = card.querySelector('form') as HTMLFormElement
    const input = card.querySelector('[data-secret]') as HTMLInputElement
    const submit = card.querySelector('[data-submit]') as HTMLButtonElement
    const reply = (r: Record<string, unknown>) => {
      if (card.classList.contains('sent')) return
      card.classList.add('sent')
      input.value = ''
      input.disabled = true
      post(`/sessions/${v.s.id}/respond`, { requestId: e.requestId, reply: r })
    }
    input.addEventListener('input', () => {
      submit.disabled = !input.value
    })
    form.addEventListener('submit', (ev) => {
      ev.preventDefault()
      if (input.value) reply({ value: input.value })
    })
    ;(card.querySelector('[data-skip]') as HTMLElement).addEventListener('click', () =>
      reply({ behavior: 'deny', message: 'The user chose not to give it' }),
    )
    return card
  }

  /** a question from Claude: numbered options with previews, several if multi-select, or your own */
  function questionCard(v: View, e: Ev): HTMLElement {
    const qs = (e.questions as Question[]) ?? []
    const picked = qs.map(() => new Set<string>())
    const other = qs.map(() => '')
    const card = el('div', 'm-ask question')
    card.dataset.req = String(e.requestId)
    card.innerHTML = `${qs
      .map(
        (q, qi) => `
        <div class="q" data-q="${qi}">
          <div class="ask-h"><span class="q-tag">${esc(q.header || 'Question')}</span>${esc(q.question)}${q.multiSelect ? ' <small>choose any</small>' : ''}</div>
          <div class="ask-opts" role="${q.multiSelect ? 'group' : 'radiogroup'}">
            ${q.options
              .map(
                (o, oi) =>
                  `<button type="button" class="opt" role="${q.multiSelect ? 'checkbox' : 'radio'}" aria-checked="false" data-o="${oi}"><kbd>${oi + 1}</kbd><span><b>${esc(o.label)}</b>${o.description ? `<em>${esc(o.description)}</em>` : ''}</span></button>`,
              )
              .join('')}
            <label class="opt other"><kbd>${q.options.length + 1}</kbd><input data-other placeholder="Type something else…" /></label>
          </div>
          ${q.options.some((o) => o.preview) ? '<pre class="q-preview" data-preview hidden></pre>' : ''}
        </div>`,
      )
      .join('')}
      <div class="ask-foot"><button type="button" class="ask-go" data-submit disabled>Submit</button><button type="button" class="ask-skip" data-skip>Skip</button></div>`
    const submit = card.querySelector('[data-submit]') as HTMLButtonElement
    const single = qs.length === 1 && !qs[0]?.multiSelect
    const ready = () => qs.every((_, i) => (picked[i]?.size ?? 0) > 0 || !!other[i]?.trim())
    const send = () => {
      if (!ready() || card.classList.contains('sent')) return
      card.classList.add('sent')
      const answers = Object.fromEntries(
        qs.map((q, i) => {
          const typed = other[i]?.trim()
          return [q.question, [...(picked[i] ?? []), ...(typed ? [typed] : [])].join(', ')]
        }),
      )
      post(`/sessions/${v.s.id}/respond`, {
        requestId: e.requestId,
        reply: { behavior: 'allow', answers },
      })
    }
    const paint = (qi: number) => {
      const box = card.querySelector(`[data-q="${qi}"]`) as HTMLElement
      for (const b of box.querySelectorAll<HTMLElement>('.opt[data-o]')) {
        const on = picked[qi]?.has(qs[qi]?.options[Number(b.dataset.o)]?.label ?? '') ?? false
        b.classList.toggle('on', on)
        b.setAttribute('aria-checked', String(on))
      }
      submit.disabled = !ready()
    }
    const preview = (qi: number, oi: number) => {
      const pre = card.querySelector<HTMLElement>(`[data-q="${qi}"] [data-preview]`)
      if (!pre) return
      const text = qs[qi]?.options[oi]?.preview ?? ''
      pre.hidden = !text
      pre.textContent = text
    }
    const pick = (qi: number, oi: number) => {
      const q = qs[qi]
      const label = q?.options[oi]?.label
      const set = picked[qi]
      if (!q || !label || !set) return
      if (q.multiSelect) {
        if (set.has(label)) set.delete(label)
        else set.add(label)
      } else {
        set.clear()
        set.add(label)
        other[qi] = ''
        const inp = card.querySelector<HTMLInputElement>(`[data-q="${qi}"] [data-other]`)
        if (inp) inp.value = ''
      }
      preview(qi, oi)
      paint(qi)
      // one question with one answer: choosing is answering, as in the terminal
      if (single) send()
    }
    for (const box of card.querySelectorAll<HTMLElement>('.q')) {
      const qi = Number(box.dataset.q)
      box.addEventListener('click', (ev) => {
        const b = (ev.target as HTMLElement).closest<HTMLElement>('.opt[data-o]')
        if (b) pick(qi, Number(b.dataset.o))
      })
      for (const name of ['mouseover', 'focusin']) {
        box.addEventListener(name, (ev) => {
          const b = (ev.target as HTMLElement).closest<HTMLElement>('.opt[data-o]')
          if (b) preview(qi, Number(b.dataset.o))
        })
      }
      const inp = box.querySelector('[data-other]') as HTMLInputElement
      inp.addEventListener('input', () => {
        other[qi] = inp.value
        if (!qs[qi]?.multiSelect && inp.value.trim()) picked[qi]?.clear()
        paint(qi)
      })
      inp.addEventListener('keydown', (k) => {
        if (k.key === 'Enter') send()
      })
    }
    card.addEventListener('keydown', (k) => {
      if ((k.target as HTMLElement).tagName === 'INPUT') return
      const n = Number(k.key)
      const first = qs[0]
      if (first && n >= 1 && n <= first.options.length) {
        k.preventDefault()
        pick(0, n - 1)
      } else if (first && n === first.options.length + 1) {
        k.preventDefault()
        card.querySelector<HTMLInputElement>('[data-q="0"] [data-other]')?.focus()
      } else if (k.key === 'Enter' && ready()) {
        k.preventDefault()
        send()
      } else if (k.key === 'ArrowDown' || k.key === 'ArrowUp') {
        k.preventDefault()
        const all = [...card.querySelectorAll<HTMLElement>('.opt[data-o], .opt.other input')]
        const i = all.indexOf(document.activeElement as HTMLElement)
        all[(i + (k.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus()
      }
    })
    submit.addEventListener('click', send)
    card.querySelector('[data-skip]')?.addEventListener('click', () => {
      card.classList.add('sent')
      post(`/sessions/${v.s.id}/respond`, {
        requestId: e.requestId,
        reply: { behavior: 'deny', message: 'The user skipped the question' },
      })
    })
    if (single) submit.hidden = true
    return card
  }

  // ------------------------------------------------------------ navigation
  async function resume(o: {
    id: string
    cwd: string
    repo: string
    title: string
    state?: string
    account?: string | null
  }) {
    setOpen(true)
    await loadStatic()
    const existing = summaries.find((s) => s.sdkSessionId === o.id)
    if (existing) {
      const ws = ensureWs(wsKey(existing.cwd))
      addChat(ws, existing.id)
      setWs(ws.path)
      return showChat(ws, existing.id)
    }
    // a session resumes on the account it ran on: its transcript lives in that account's folder
    const real = o.account
      ? accounts.find((a) => a.id === o.account && !a.demo)
      : (accounts.find((a) => a.id === prefs.account && !a.demo && a.loggedIn) ??
        accounts.find((a) => !a.demo && a.loggedIn))
    if (!real?.loggedIn) {
      const go = await ask({
        title: real ? `${real.label} isn't signed in` : 'Connect a Claude account first',
        body: real
          ? `“${o.title || o.repo}” ran on ${real.label}. Sign that account in, then open the chat again.`
          : 'Resuming a chat needs the Claude account it ran on. Until one is connected, chats use the offline demo agent.',
        ok: 'Open Claude accounts',
      })
      if (go) paintAccounts()
      return
    }
    const live = o.state === 'needs-you' || o.state === 'working' || o.state === 'blocked'
    if (live) {
      const yes = await ask({
        title: `“${o.title || o.repo}” is still running somewhere else`,
        body: 'A Claude Code process for this conversation is still open (a terminal, an editor window, or the chat you are talking to). Opening it here as well means two copies write to the same conversation. Close it there first, then open it here.',
        ok: 'Open here anyway',
        cancel: 'Not now',
        danger: true,
      })
      if (!yes) return
    }
    pane.innerHTML = `<div class="ws-start"><p class="hi-empty">Opening “${esc(o.title || o.repo)}” with its recent history…</p></div>`
    const r = await post('/sessions', {
      cwd: o.cwd,
      repo: o.repo,
      account: real.id,
      resume: o.id,
      title: o.title,
    })
    const s = await r.json()
    if (!r.ok) {
      setWs(activeWs ?? order[0] ?? null)
      await ask({
        title: 'Could not open that chat',
        body: s.error ?? 'The session host did not accept it.',
        cancel: null,
      })
      return
    }
    summaries.push(s)
    const ws = ensureWs(wsKey(s.cwd))
    addChat(ws, s.id)
    setWs(ws.path)
    showChat(ws, s.id)
    refresh()
  }

  // the dock's left edge drags; one, two and three columns each remember their own width
  const dockVar = () => '--ss-dock-w'
  const dockWidths = (): Record<string, number> => {
    try {
      return JSON.parse(localStorage.getItem(DOCK_KEY) ?? '{}')
    } catch {
      return {}
    }
  }
  // wide enough for two chats side by side unless you have dragged it
  const DEFAULT_DOCK = () => Math.round(Math.min(1180, innerWidth * 0.52))
  const applyDockWidths = () => {
    const px = dockWidths()['--ss-dock-w'] ?? DEFAULT_DOCK()
    document.documentElement.style.setProperty(
      '--ss-dock-w',
      `${Math.max(420, Math.min(px, innerWidth - 320))}px`,
    )
  }
  applyDockWidths()
  addEventListener('resize', applyDockWidths)
  const grip = $('grip')
  grip.addEventListener('pointerdown', (e) => {
    if (!docked || e.button !== 0) return
    e.preventDefault()
    grip.setPointerCapture(e.pointerId)
    const k = dockVar()
    grip.classList.add('drag')
    root.classList.add('sizing')
    const move = (m: PointerEvent) => {
      const w = Math.round(Math.max(420, Math.min(innerWidth - 320, innerWidth - m.clientX)))
      document.documentElement.style.setProperty(k, `${w}px`)
    }
    const up = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.classList.remove('drag')
      root.classList.remove('sizing')
      const all = dockWidths()
      all[k] = Math.round(root.getBoundingClientRect().width)
      try {
        localStorage.setItem(DOCK_KEY, JSON.stringify(all))
      } catch {}
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
  })
  grip.addEventListener('dblclick', () => {
    const all = dockWidths()
    delete all[dockVar()]
    try {
      localStorage.setItem(DOCK_KEY, JSON.stringify(all))
    } catch {}
    applyDockWidths()
  })

  function setDocked(on: boolean) {
    docked = on
    try {
      if (!popped) localStorage.setItem(FULL_KEY, on ? '' : '1')
    } catch {}
    root.classList.toggle('dock', docked)
    document.body.classList.toggle('ss-docked', open && docked)
    paintTabs()
    syncWidth()
  }

  async function setOpen(on: boolean) {
    if (on && poppedOut) return popOut('claude')
    if (!on && popped) return
    if (on === open) return
    open = on
    dispatchEvent(new CustomEvent('laika:claude-open', { detail: on }))
    root.classList.toggle('on', on)
    root.classList.toggle('dock', docked)
    document.body.classList.toggle('ss-docked', on && docked)
    launch.hidden = on
    if (!on) {
      syncWidth()
      timer?.()
      timer = null
      closePop()
      $('history').hidden = true
      focusRing()
      return
    }
    timer?.()
    timer = presence.every(4000, refresh, { now: false })
    if (!restored) {
      pane.innerHTML = '<div class="ws-start"><p class="hi-empty">Loading…</p></div>'
      await loadStatic()
      restored = true
      syncLibrary()
      // reopen the tabs you had, then add a workspace for every chat already running
      const saved = savedLayout()
      for (const p of saved?.order ?? [])
        if (repos.some((r) => r.path === p) || projects.some((x) => x.path === p)) {
          const key = wsKey(p)
          if (!workspaces.has(key)) ensureWs(key)
        }
      await refresh()
      setWs(saved?.active && workspaces.has(saved.active) ? saved.active : (order[0] ?? null))
      const was = (saved?.spread ?? saved?.duo ?? []).filter((p) => workspaces.has(p))
      if (was.length > 1 && activeWs && was.includes(activeWs)) {
        spread = was
        const d = Math.max(0.2, Math.min(0.8, Number(saved?.duoSize) || 0.5))
        const sizes = saved?.spreadSizes ?? (saved?.duo ? [d, 1 - d] : [])
        spreadSizes =
          sizes.length === was.length
            ? sizes.map((x) => Math.max(0.05, Number(x) || 1))
            : was.map(() => 1)
        mountPane()
        saveLayout()
        paintTabs()
        syncWidth()
      }
    } else {
      refresh()
      setWs(activeWs)
    }
  }

  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act
    if (act === 'close') return setOpen(false)
    if (act === 'broadcast') return broadcast()
    if (act === 'popout') {
      if (popped) return popOut('claude', false)
      setOpen(false)
      return popOut('claude')
    }
    const view = t.closest<HTMLElement>('[data-view]')?.dataset.view
    const vws = activeWs ? workspaces.get(activeWs) : undefined
    if (view && vws) {
      if (view === 'term') {
        vws.term.toggle()
        return paintViews()
      }
      return setPane(vws, view as Workspace['pane'])
    }
    if (act === 'size') return setDocked(!docked)
    if (act === 'history') return toggleHistory()
    if (act === 'fleet') return toggleFleet()
    if (act === 'accounts') return paintAccounts()
    if (act === 'away') return toggleAway()
    if (act === 'add') {
      const anchor = t.closest<HTMLElement>('[data-act]') as HTMLElement
      return showPop(
        anchor,
        projects
          .map(
            (p) =>
              `<button type="button" class="pop-i" data-val="${esc(p.path)}"><i style="background:${repoColour(p.path, p.name)};border-radius:50%"></i><span><b>${esc(p.name)}</b><em>project folder · ${p.repos.length} repos</em></span></button>`,
          )
          .join('') +
          repos
            .map(
              (r) =>
                `<button type="button" class="pop-i" data-val="${esc(r.path)}"><i style="background:${repoColour(r.path, short(r.name))}"></i><span><b>${esc(short(r.name))}</b><em>${esc([r.name.split('/').slice(0, -1).join('/'), r.branch].filter(Boolean).join(' · '))}</em></span><small>${r.lastCommit ? ago(r.lastCommit) : ''}</small></button>`,
            )
            .join(''),
        (p) => openRepo(p),
        true,
      )
    }
    const close = t.closest<HTMLElement>('[data-ws-close]')?.dataset.wsClose
    if (close) {
      e.stopPropagation()
      return closeWs(close)
    }
    const wsOpen = t.closest<HTMLElement>('[data-ws-open]')?.dataset.wsOpen
    // the click that ends a slide is not a click on the tab
    if (wsOpen && slid) return
    if (wsOpen) return setWs(wsOpen)
    const repo = t.closest<HTMLElement>('[data-open-repo]')?.dataset.openRepo
    if (repo) return openRepo(repo, true)
    const go = t.closest<HTMLElement>('[data-goto]')?.dataset.goto
    if (go) {
      $('history').hidden = true
      const s = summaries.find((x) => x.id === go)
      if (!s) return
      const ws = ensureWs(wsKey(s.cwd))
      addChat(ws, s.id)
      setWs(ws.path)
      return showChat(ws, s.id)
    }
    const r = t.closest<HTMLElement>('[data-resume]')?.dataset.resume
    if (r) {
      $('history').hidden = true
      const x = elsewhere.find((y) => y.id === r)
      if (x)
        resume({
          id: x.id,
          cwd: x.cwd ?? x.repoPath ?? '',
          repo: short(x.repo),
          title: x.title,
          state: x.state,
          account: x.account,
        })
    }
  })

  /** one message, or a fleet command, to many chats at once */
  function broadcast() {
    openBroadcast({
      host: root,
      chats: () =>
        summaries.map((s) => ({
          id: s.id,
          title: titleOf(s),
          repo: s.repo,
          state: s.state,
          role: s.role ?? null,
          waiting: s.waiting,
          spawnedBy: s.spawnedBy ?? null,
          bg: s.work?.bg ?? [],
        })),
      send: async (id, text) => (await post(`/sessions/${id}/message`, { text })).ok,
      done: () => refresh(),
    })
  }

  // full Claude and the spread answer wherever the cursor is, not only inside the panel
  addEventListener('keydown', (e) => {
    if (!open || !e.metaKey || !e.altKey || e.ctrlKey || root.contains(e.target as Node)) return
    if (e.code === 'KeyE') {
      e.preventDefault()
      broadcast()
    } else if (e.code === 'KeyA') {
      e.preventDefault()
      toggleAway()
    } else if (e.code === 'KeyF') {
      e.preventDefault()
      setDocked(!docked)
    } else if (e.code === 'KeyS' && activeWs) {
      e.preventDefault()
      if (spread.length) showAlone()
      else spreadTabs()
    } else if (e.shiftKey && activeWs && spread.length && /^Arrow(Left|Right)$/.test(e.key)) {
      e.preventDefault()
      shiftSide(activeWs, e.key === 'ArrowLeft' ? -1 : 1)
    }
  })
  root.addEventListener('keydown', (e) => {
    const ws = activeWs ? workspaces.get(activeWs) : undefined
    // ⌥⌘A: I'm away (or back)
    if (e.metaKey && e.altKey && !e.ctrlKey && e.code === 'KeyA') {
      e.preventDefault()
      return toggleAway()
    }
    // ⌥⌘E: broadcast to every chat you pick (⌥⌘B is the fleet board)
    if (e.metaKey && e.altKey && !e.ctrlKey && e.code === 'KeyE') {
      e.preventDefault()
      return broadcast()
    }
    if (e.ctrlKey && (e.key === '`' || e.code === 'Backquote')) {
      e.preventDefault()
      if (ws) {
        ws.term.toggle()
        paintWsBar(ws)
      }
      return
    }
    // the chats pane's own keys: ⌥⌘[ ] tabs in a group, ⌥⌘1-9 a group, ⌥⌘\ split right,
    // ⌃⌘← → move the chat into the group beside. ⌥⌘ arrows, ⌥⌘⇧ arrows, ⌥⌘-/=, ⌥⌘↩ and ⌥⌘W
    // are the window keys (panels.ts), which act on the chat groups as windows.
    if (ws && e.metaKey && (e.altKey || e.ctrlKey) && !(e.altKey && e.ctrlKey)) {
      const arrow = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
      if (e.altKey && !e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault()
        return stepChat(ws, e.code === 'BracketLeft' ? -1 : 1)
      }
      if (e.ctrlKey && arrow) {
        e.preventDefault()
        const id = ws.groups[ws.focus]?.active
        if (id && id !== 'new') moveSideways(ws, id, arrow)
        return
      }
      if (e.altKey && e.code === 'Backslash') {
        e.preventDefault()
        return splitRight(ws)
      }
      if (e.altKey && e.code === 'KeyG') {
        e.preventDefault()
        return quad(ws)
      }
      // ⌥⌘F full Claude, ⌥⌘S spread the tabs across the screen (again: back to one)
      if (e.altKey && e.code === 'KeyF') {
        e.preventDefault()
        return setDocked(!docked)
      }
      if (e.altKey && e.code === 'KeyS') {
        e.preventDefault()
        return spread.length ? showAlone() : spreadTabs()
      }
      const d = e.altKey ? /^Digit([1-9])$/.exec(e.code) : null
      if (d) {
        e.preventDefault()
        return focusGroup(ws, Number(d[1]) - 1)
      }
    }
    // inside the terminal every key belongs to the shell, Escape included (vim, less, fzf)
    if ((e.target as HTMLElement).closest('.ss-term')) return
    const typing = (e.target as HTMLElement).matches('textarea, input, select')
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (!pop.hidden) return closePop()
      if (!$('history').hidden) return toggleHistory(false)
      if (ws && ws.pane !== 'chats') return setPane(ws, 'chats')
      if (typing && (e.target as HTMLInputElement).value) return
      return setOpen(false)
    }
    if (
      !typing &&
      ws &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      (e.key === 'n' || e.key === 'N')
    ) {
      e.preventDefault()
      showChat(ws, 'new')
    }
  })

  // ------------------------------------------------------------ ring context menu
  const menu = el('div', 'ss-menu')
  menu.setAttribute('role', 'menu')
  menu.hidden = true
  document.body.appendChild(menu)
  const hideMenu = () => {
    menu.hidden = true
  }
  addEventListener('pointerdown', (e) => {
    if (!menu.contains(e.target as Node)) hideMenu()
  })
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideMenu()
  })
  let sources: { dir: string; prefix: string }[] | null = null
  async function ringMenu(indexPath: string, x: number, y: number) {
    sources ??= await fetch('/api/control/sources')
      .then((r) => r.json())
      .catch(() => [])
    if (!repos.length) await loadStatic()
    const src = (sources ?? []).find((s) =>
      s.prefix ? indexPath.startsWith(s.prefix) : !indexPath.startsWith('@'),
    )
    const abs = src ? `${src.dir}/${indexPath.slice(src.prefix.length)}` : ''
    const repo = repos
      .filter((r) => abs === r.path || abs.startsWith(`${r.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0]
    menu.innerHTML = repo
      ? `<button type="button" role="menuitem" data-new="${esc(repo.path)}"><b>✦</b> Ask Claude in <em>${esc(short(repo.name))}</em></button>
         <button type="button" role="menuitem" data-open="${esc(repo.path)}"><b>▢</b> Open <em>${esc(short(repo.name))}</em> workspace</button>`
      : '<button type="button" role="menuitem" disabled>Not inside a git repo</button>'
    menu.hidden = false
    menu.style.left = `${Math.min(x, innerWidth - menu.offsetWidth - 8)}px`
    menu.style.top = `${Math.min(y, innerHeight - menu.offsetHeight - 8)}px`
    ;(menu.querySelector('button:not([disabled])') as HTMLElement | null)?.focus()
  }
  menu.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement
    const fresh = t.closest<HTMLElement>('[data-new]')?.dataset.new
    const plain = t.closest<HTMLElement>('[data-open]')?.dataset.open
    hideMenu()
    const p = fresh ?? plain
    if (!p) return
    await setOpen(true)
    openRepo(p, !!fresh)
  })

  // ------------------------------------------------------------ the Claude widget in the rails
  /**
   * The rails render widgets from server JSON; this one's body is drawn here, from the same
   * live state as the panel: accounts, open repo workspaces, and the chats that need you.
   * Rails repaint often, so the body is re-drawn whenever its widget reappears.
   */
  // the widget's quick prompt: the repo it targets is remembered, and what you typed survives
  // the widget's own repaints (the rails redraw every minute)
  let quickCwd = ''
  try {
    quickCwd = localStorage.getItem('laika.quickRepo') ?? ''
  } catch {}
  const quickRepo = () =>
    repos.find((r) => r.path === quickCwd) ??
    repos.find((r) => r.path === activeWs) ??
    repos.find((r) => r.path === order[order.length - 1]) ??
    repos[0]

  function widgetHtml() {
    const real = accounts.filter((a) => !a.demo)
    const inApp = new Set(summaries.map((s) => s.sdkSessionId))
    const waitingHere = summaries.filter(needs)
    const running = summaries.filter((s) => s.state === 'running' || s.state === 'starting')
    const waitingElsewhere = elsewhere
      .filter((e) => !inApp.has(e.id) && (e.state === 'needs-you' || e.state === 'blocked'))
      .slice(0, 4)
    const row = (
      key: string,
      val: string,
      state: string,
      title: string,
      repo: string,
      when: string,
    ) =>
      `<button type="button" class="cw-row ${esc(state)}" data-${key}="${esc(val)}"><i class="st ${esc(state)}"></i><span class="cw-t">${esc(title || 'Untitled')}</span><em>${esc(repo)}</em><small>${esc(when)}</small></button>`
    return `
      <div class="cw" data-cw>
        <div class="cw-acc">${
          real.length
            ? real
                .map(
                  (
                    a,
                  ) => `<button type="button" class="cw-a ${a.loggedIn ? 'ok' : 'off'}${a.id === prefs.account ? ' def' : ''}" data-cw="accounts" title="${esc(a.loggedIn ? `${a.email} · ${a.plan ?? ''} plan${a.id === prefs.account ? ' · used for new chats' : ''}` : `${a.label}: not signed in`)}">
                    <i class="acct ${a.loggedIn ? 'ok' : 'off'}"></i><span>${esc((a.email ?? a.label).replace(/@.*/, ''))}</span>
                  </button>`,
                )
                .join('')
            : '<button type="button" class="cw-a off" data-cw="accounts"><i class="acct off"></i><span>Connect a Claude account</span></button>'
        }</div>
        ${
          order.length
            ? `<div class="cw-ws">${order
                .map((p) => {
                  const ws = workspaces.get(p)
                  if (!ws) return ''
                  const mine = summaries.filter((s) => ws.chats.includes(s.id))
                  return `<button type="button" class="cw-w${mine.some(needs) ? ' need' : ''}" data-cw-ws="${esc(p)}" style="--ws:${ws.colour}"><i></i>${esc(ws.name)}${mine.length ? `<small>${mine.length}</small>` : ''}</button>`
                })
                .join('')}</div>`
            : ''
        }
        <form class="cw-quick" data-cw-quick>
          <textarea rows="1" placeholder="Ask Claude…" aria-label="Ask Claude"></textarea>
          <div class="cw-quick-bar">
            <button type="button" class="cw-quick-repo" data-cw-pick style="--ws:${quickRepo() ? repoColour(quickRepo()?.path ?? '', short(quickRepo()?.name ?? '')) : '#8a93ab'}"><i></i><span>${esc(quickRepo() ? short(quickRepo()?.name ?? '') : 'Choose repo')}</span>▾</button>
            <button type="submit" class="cw-quick-go" title="Start chat (↵)" aria-label="Start chat"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M8 2.5 13 7.4l-1 1-3.3-3.2V13.5H7.3V5.2L4 8.4l-1-1z"/></svg></button>
          </div>
        </form>
        <div class="cw-list">${
          [
            ...waitingHere.map((s) =>
              row('cw-goto', s.id, 'waiting', s.title, s.repo, 'your turn'),
            ),
            ...running.map((s) =>
              row(
                'cw-goto',
                s.id,
                s.state,
                s.title,
                s.repo,
                bgShort(s.work?.bg) ? `working · ${bgShort(s.work?.bg)}` : 'working',
              ),
            ),
            ...waitingElsewhere.map((e) =>
              row(
                'cw-resume',
                e.id,
                e.state === 'blocked' ? 'blocked' : 'waiting',
                e.title,
                short(e.repo),
                'in another window',
              ),
            ),
          ].join('') || '<p class="cw-empty">No chats need you. Start one with <b>new chat</b>.</p>'
        }</div>
      </div>`
  }
  function paintWidget() {
    for (const w of document.querySelectorAll<HTMLElement>('.widget[data-id="claude"]')) {
      const body = w.querySelector<HTMLElement>('.w-body') ?? w
      const head = w.querySelector<HTMLElement>('.w-src')
      const need = summaries.filter(needs).length
      if (head) head.textContent = need ? `${need} need you` : `${summaries.length} running`
      const html = widgetHtml()
      if (body.dataset.cwHtml === html) continue
      const prev = body.querySelector<HTMLTextAreaElement>('.cw-quick textarea')
      const typed = prev?.value ?? ''
      const had = prev && document.activeElement === prev
      body.dataset.cwHtml = html
      body.innerHTML = html
      const next = body.querySelector<HTMLTextAreaElement>('.cw-quick textarea')
      if (next && typed) next.value = typed
      if (next && had) next.focus()
    }
  }
  for (const rail of document.querySelectorAll<HTMLElement>('#rail-l, #rail-r')) {
    new MutationObserver(() => {
      const body = rail.querySelector<HTMLElement>('.widget[data-id="claude"] .w-body')
      if (body && !body.querySelector('[data-cw]')) {
        delete body.dataset.cwHtml
        paintWidget()
      }
    }).observe(rail, { childList: true, subtree: true })
    rail.addEventListener('submit', async (e) => {
      const form = (e.target as HTMLElement).closest<HTMLFormElement>('[data-cw-quick]')
      if (!form) return
      e.preventDefault()
      const ta = form.querySelector('textarea') as HTMLTextAreaElement
      const text = ta.value.trim()
      const repo = quickRepo()
      if (!repo) return
      if (!text) return ta.focus()
      ta.disabled = true
      const r = await post('/sessions', {
        cwd: repo.path,
        repo: short(repo.name),
        account: prefs.account,
        mode: prefs.mode,
        model: prefs.model || undefined,
        effort: prefs.effort,
        text,
      })
      const s = await r.json()
      ta.disabled = false
      if (!r.ok) {
        ta.value = text
        ta.setCustomValidity(s.error ?? 'Could not start the chat')
        ta.reportValidity()
        return
      }
      ta.value = ''
      summaries.push(s)
      await setOpen(true)
      const ws = ensureWs(wsKey(s.cwd))
      addChat(ws, s.id)
      setWs(ws.path)
      showChat(ws, s.id)
      refresh()
    })
    rail.addEventListener('keydown', (e) => {
      const ta = (e.target as HTMLElement).closest<HTMLTextAreaElement>('.cw-quick textarea')
      if (!ta) return
      // the widget's box: Enter sends, ⇧Enter is a new line; the map's shortcuts stay out
      e.stopPropagation()
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        ta.form?.requestSubmit()
      }
    })
    rail.addEventListener('input', (e) => {
      const ta = (e.target as HTMLElement).closest<HTMLTextAreaElement>('.cw-quick textarea')
      if (!ta) return
      ta.setCustomValidity('')
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(120, ta.scrollHeight)}px`
    })
    rail.addEventListener('click', async (e) => {
      const t = e.target as HTMLElement
      if (!t.closest('.widget[data-id="claude"]')) return
      const pick = t.closest<HTMLElement>('[data-cw-pick]')
      if (pick) {
        if (!repos.length) await loadStatic()
        // the pop lives in the panel; for the widget it floats next to the chip instead
        const menu = el('div', 'ss-menu cw-menu')
        menu.innerHTML = `<input class="hi-q" placeholder="Search repos" aria-label="Search repos" /><div class="cw-menu-list">${repos
          .map(
            (r) =>
              `<button type="button" role="menuitem" data-val="${esc(r.path)}" style="--ws:${repoColour(r.path, short(r.name))}"><i></i>${esc(short(r.name))}<small>${esc(r.name.split('/').slice(0, -1).join('/'))}</small></button>`,
          )
          .join('')}</div>`
        document.body.appendChild(menu)
        const rect = pick.getBoundingClientRect()
        menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 300))}px`
        menu.style.top = `${rect.bottom + 6}px`
        const q = menu.querySelector('input') as HTMLInputElement
        const close = () => {
          menu.remove()
          removeEventListener('pointerdown', off)
        }
        const off = (ev: Event) => {
          if (!menu.contains(ev.target as Node)) close()
        }
        setTimeout(() => addEventListener('pointerdown', off), 0)
        q.addEventListener('input', () => {
          const n = q.value.toLowerCase()
          for (const b of menu.querySelectorAll<HTMLElement>('[data-val]'))
            b.hidden = !!n && !(b.textContent ?? '').toLowerCase().includes(n)
        })
        q.addEventListener('keydown', (k) => {
          k.stopPropagation()
          if (k.key === 'Escape') close()
          if (k.key === 'Enter')
            (menu.querySelector('[data-val]:not([hidden])') as HTMLElement | null)?.click()
        })
        menu.addEventListener('click', (ev) => {
          const v = (ev.target as HTMLElement).closest<HTMLElement>('[data-val]')?.dataset.val
          if (!v) return
          quickCwd = v
          try {
            localStorage.setItem('laika.quickRepo', v)
          } catch {}
          close()
          delete (rail.querySelector('.widget[data-id="claude"] .w-body') as HTMLElement | null)
            ?.dataset.cwHtml
          paintWidget()
          rail.querySelector<HTMLTextAreaElement>('.cw-quick textarea')?.focus()
        })
        q.focus()
        return
      }
      const go = t.closest<HTMLElement>('[data-cw-goto]')?.dataset.cwGoto
      const res = t.closest<HTMLElement>('[data-cw-resume]')?.dataset.cwResume
      const wsPath = t.closest<HTMLElement>('[data-cw-ws]')?.dataset.cwWs
      const acc = t.closest<HTMLElement>('[data-cw="accounts"]')
      if (go) {
        await setOpen(true)
        const s = summaries.find((x) => x.id === go)
        if (!s) return
        const ws = ensureWs(wsKey(s.cwd))
        addChat(ws, s.id)
        setWs(ws.path)
        showChat(ws, s.id)
      } else if (res) {
        const x = elsewhere.find((y) => y.id === res)
        if (x)
          resume({
            id: x.id,
            cwd: x.cwd ?? x.repoPath ?? '',
            repo: short(x.repo),
            title: x.title,
            state: x.state,
            account: x.account,
          })
      } else if (wsPath) {
        await setOpen(true)
        setWs(wsPath)
      } else if (acc) {
        await setOpen(true)
        paintAccounts()
      }
    })
  }

  // the cockpit's nodes (cockpit.ts): open a chat this page already has, by its own id
  addEventListener('laika:open-chat', async (ev) => {
    const id = (ev as CustomEvent<{ id: string }>).detail.id
    // the cockpit's stream can know a chat a moment before this page's list does
    if (!summaryOf(id)) await refresh()
    const s = summaryOf(id)
    if (!s) return
    await setOpen(true)
    const ws = ensureWs(wsKey(s.cwd))
    addChat(ws, s.id)
    setWs(ws.path)
    showChat(ws, s.id)
  })
  // anything in the app can ask for a session to be opened here
  addEventListener('laika:open-session', (ev) => {
    resume(
      (ev as CustomEvent).detail as {
        id: string
        cwd: string
        repo: string
        title: string
        state?: string
      },
    )
  })
  // keep the launcher's "needs you" badge current while the panel is closed
  presence.every(15_000, () => !open && refresh(), { now: false })
  // the widget needs accounts and repos even before the panel is first opened
  loadStatic().then(() => {
    refresh()
    paintWidget()
  })
  refresh()

  // ------------------------------------------------------------ plan usage in the top bar
  type UsageWindow = {
    key: string
    label: string
    used: number
    resetsAt: string | null
    locked?: string | null
  }
  type Usage = {
    id: string
    label: string
    plan: string | null
    at?: number
    available: boolean
    windows: UsageWindow[]
    extra?: {
      used: number | null
      limit: number | null
      pct: number | null
      currency: string | null
      decimals: number | null
      capped: boolean
    } | null
    error?: string
  }
  const meter = el('div', 'cu')
  meter.id = 'cu'
  meter.setAttribute('aria-label', 'Claude plan usage')
  meter.hidden = true
  document.querySelector('header #hdr')?.before(meter)
  // resets come back a hair before the hour (19:59:59.9), so times round to the minute
  const clock = (t: number) =>
    new Date(Math.round(t / 6e4) * 6e4).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    })
  /** a moment ahead, as short as it can be said: "6:30 pm", "tomorrow 9:00 am", "Thu 3:40 pm" */
  const when = (t: number) => {
    const day = (d: number) => new Date(d).toDateString()
    if (day(t) === day(Date.now())) return clock(t)
    if (day(t) === day(Date.now() + 864e5)) return `tomorrow ${clock(t)}`
    return `${new Date(t).toLocaleDateString(undefined, { weekday: 'short' })} ${clock(t)}`
  }
  const span = (ms: number) => {
    const h = Math.floor(ms / 36e5)
    const m = Math.round((ms % 36e5) / 6e4)
    return h >= 48 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h ? `${h}h ` : ''}${m}m`
  }
  const level = (n: number) => (n >= 90 ? 'hot' : n >= 75 ? 'warm' : '')
  const shortName = (u: Usage) => u.label.replace(/@.*$/, '')
  /** the 5-hour window is a session; every other window Claude reports runs a week */
  const windowMs = (w: UsageWindow) => (w.key === 'five_hour' ? 5 * 36e5 : 7 * 864e5)
  const windowName = (w: UsageWindow) =>
    w.key === 'five_hour'
      ? 'Session · 5 hours'
      : w.key === 'seven_day'
        ? 'Week · all models'
        : w.label

  /**
   * Where a window stands: how far through it we are, and whether the rate so far would run it
   * out before it resets. A pace is only worth saying once a tenth of the window has gone by.
   */
  function pace(w: UsageWindow) {
    const reset = w.resetsAt ? Date.parse(w.resetsAt) : Number.NaN
    if (!Number.isFinite(reset)) return { through: null as number | null, note: '', cls: '' }
    const len = windowMs(w)
    const start = reset - len
    const now = Date.now()
    const through = Math.max(0, Math.min(1, (now - start) / len))
    if (w.used >= 100) return { through, note: 'Limit reached', cls: 'hot' }
    if (w.used < 0.5) return { through, note: 'Unused so far', cls: '' }
    if (through < 0.1) return { through, note: '', cls: '' }
    const projected = w.used / through
    const outAt = start + (100 / w.used) * (now - start)
    if (projected >= 100 && outAt < reset)
      return {
        through,
        note: `Runs out ~${when(outAt)} at this pace`,
        cls: projected >= 115 ? 'hot' : 'warm',
      }
    return { through, note: `On pace for ~${Math.round(projected)}% by reset`, cls: '' }
  }
  function money(e: NonNullable<Usage['extra']>, n: number | null) {
    if (n == null) return '?'
    const v = e.decimals != null ? n / 10 ** e.decimals : n
    try {
      if (e.currency)
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: e.currency }).format(
          v,
        )
    } catch {}
    return v.toLocaleString()
  }
  /** everything known about one account, for the card under its meter */
  function usageCard(u: Usage) {
    const rows = u.windows
      .map((w) => {
        const p = pace(w)
        const reset = w.resetsAt ? Date.parse(w.resetsAt) : Number.NaN
        const resets = Number.isFinite(reset)
          ? reset - Date.now() > 0
            ? `Resets in ${span(reset - Date.now())} · ${when(reset)}`
            : 'Resets now'
          : ''
        return `<div class="cu-w ${level(w.used)}">
          <div class="cu-wh"><span>${esc(windowName(w))}</span><b>${Math.round(w.used)}%</b></div>
          <div class="cu-wbar"><i style="width:${Math.max(1, Math.min(100, w.used))}%"></i>${p.through != null && w.used < 100 ? `<u style="left:${(p.through * 100).toFixed(1)}%" title="An even pace would be here"></u>` : ''}</div>
          <div class="cu-wf"><span>${esc(resets)}</span>${p.note ? `<em class="${p.cls}">${esc(p.note)}</em>` : ''}</div>
          ${w.locked ? `<div class="cu-lock">${esc(w.locked)}</div>` : ''}
        </div>`
      })
      .join('')
    const e = u.extra
    const extra = e
      ? `<div class="cu-x ${e.capped ? 'hot' : ''}"><span>Extra usage</span><b>${money(e, e.used)}${e.limit != null ? ` of ${money(e, e.limit)}` : ''}</b><small>${e.capped ? 'Monthly spend limit reached' : 'this month, once the plan runs out'}</small></div>`
      : ''
    const age = u.at ? Date.now() - u.at : 0
    const updated = !u.at ? '' : age < 6e4 ? 'Updated just now' : `Updated ${span(age)} ago`
    return `<div class="cu-ch"><i></i><b>${esc(u.label)}</b>${u.plan ? `<span>${esc(u.plan)}</span>` : ''}</div>
      ${rows}${extra}
      <div class="cu-cf"><span>${updated}</span><span>Click for accounts</span></div>`
  }

  let usageList: Usage[] = []
  const card = el('div', 'cu-card')
  card.id = 'cu-card'
  card.setAttribute('role', 'tooltip')
  card.hidden = true
  document.body.append(card)
  let cardFor = ''
  let cardHide = 0
  function showCard(btn: HTMLElement) {
    clearTimeout(cardHide)
    const u = usageList.find((x) => x.id === btn.dataset.usage)
    if (!u) return hideCard(true)
    cardFor = u.id
    card.style.setProperty('--ac', accountColour(u.id))
    card.innerHTML = usageCard(u)
    card.hidden = false
    const r = btn.getBoundingClientRect()
    const w = card.offsetWidth
    card.style.top = `${Math.round(r.bottom + 6)}px`
    card.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)))}px`
  }
  function hideCard(now = false) {
    clearTimeout(cardHide)
    const go = () => {
      card.hidden = true
      cardFor = ''
    }
    if (now) go()
    else cardHide = window.setTimeout(go, 120)
  }
  meter.addEventListener('mouseover', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('.cu-a')
    if (btn && btn.dataset.usage !== cardFor) showCard(btn)
    else if (btn) clearTimeout(cardHide)
  })
  meter.addEventListener('mouseleave', () => hideCard())
  // the card stays while the pointer crosses onto it
  card.addEventListener('mouseenter', () => clearTimeout(cardHide))
  card.addEventListener('mouseleave', () => hideCard())
  meter.addEventListener('focusin', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('.cu-a')
    if (btn) showCard(btn)
  })
  meter.addEventListener('focusout', () => hideCard(true))
  meter.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') hideCard(true)
  })

  function paintUsage(list: Usage[]) {
    usageList = list
    const shown = list.filter((u) => u.available && u.windows.length)
    meter.hidden = !shown.length
    meter.innerHTML = shown
      .map((u) => {
        const five = u.windows.find((w) => w.key === 'five_hour')
        const week = u.windows.find((w) => w.key === 'seven_day')
        const bar = (w: UsageWindow | undefined, name: string) =>
          w
            ? `<span class="cu-row ${level(w.used)}"><em>${name}</em><span class="cu-bar"><i style="width:${Math.max(2, Math.min(100, w.used))}%"></i></span><small>${Math.round(w.used)}%</small></span>`
            : ''
        const worst = Math.max(...u.windows.map((w) => w.used))
        return `<button type="button" class="cu-a ${level(worst)}" data-usage="${esc(u.id)}" style="--ac:${accountColour(u.id)}" aria-describedby="cu-card" aria-label="${esc(`${shortName(u)} plan usage`)}">
          <b>${esc(shortName(u))}</b><span class="cu-rows">${bar(five, '5h')}${bar(week, 'wk')}</span>
        </button>`
      })
      .join('')
    // a card left open over a meter that just repainted shows the new numbers
    const open =
      cardFor && meter.querySelector<HTMLElement>(`.cu-a[data-usage="${CSS.escape(cardFor)}"]`)
    if (open) showCard(open)
    else hideCard(true)
  }
  let usageBusy = false
  async function loadUsage() {
    if (usageBusy || document.hidden) return
    usageBusy = true
    try {
      const r = await fetch('/api/control/usage')
      if (r.ok) {
        const list = (await r.json()) as Usage[]
        if (!accounts.length) await loadStatic()
        paintUsage(list)
      }
    } catch {
    } finally {
      usageBusy = false
    }
  }
  meter.addEventListener('click', async () => {
    hideCard(true)
    await setOpen(true)
    paintAccounts()
  })
  setInterval(loadUsage, 5 * 60_000)
  addEventListener('visibilitychange', () => {
    if (!document.hidden) loadUsage()
  })

  // warm the panel's data while the page is idle, so the first open has nothing to wait for
  const idle = (fn: () => void) =>
    'requestIdleCallback' in window
      ? requestIdleCallback(fn, { timeout: 3000 })
      : setTimeout(fn, 800)
  idle(() => {
    loadStatic()
    loadUsage()
  })
  // out: this copy steps aside; back in (the window closed): it opens where it was docked
  watchPop('claude', (out, was) => {
    poppedOut = out
    if (out) setOpen(false)
    else if (was) setOpen(true)
  })

  return {
    /** the widget's "new chat": the workspace on screen, else the start screen */
    newChat: async () => {
      await setOpen(true)
      const ws = activeWs ? workspaces.get(activeWs) : undefined
      if (ws) showChat(ws, 'new')
    },
    open: () => setOpen(true),
    close: () => setOpen(false),
    /** the palette's way to the header's broadcast and accounts buttons */
    broadcast: async () => {
      await setOpen(true)
      broadcast()
    },
    accounts: async () => {
      await setOpen(true)
      await paintAccounts()
    },
    /** the column you are in, one place left or right across the spread; false with none spread */
    moveColumn: (by: -1 | 1) => {
      if (!spread.length || !activeWs) return false
      shiftSide(activeWs, by)
      return true
    },
    toggle: () => setOpen(!open),
    isOpen: () => open,
    /** open a chat this app is running, by its Claude session id; false if it isn't one */
    openBySdkId: (sdkId: string) => {
      const s = summaries.find((x) => x.sdkSessionId === sdkId)
      if (!s) return false
      setOpen(true).then(() => {
        const ws = ensureWs(wsKey(s.cwd))
        addChat(ws, s.id)
        setWs(ws.path)
        showChat(ws, s.id)
      })
      return true
    },
    /** right-click on the ring: offer Claude or the workspace for the repo holding this path */
    menuFor: (indexPath: string, x: number, y: number) => ringMenu(indexPath, x, y),
    /** put the fleet board in the dock as a panel; main.ts calls it where it wants the button */
    registerFleetPanel,
    newIn: async (cwd: string) => {
      await setOpen(true)
      openRepo(wsKey(cwd), true)
    },
  }
}
