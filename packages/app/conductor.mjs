/**
 * The conductor: one chat that leads the others.
 *
 * You give it an overall goal. It sees every other chat open in this host (what each is for,
 * where it stands, what it last said), can send any of them a message, and puts suggested
 * actions in front of you as cards you can send with one click. On autopilot it does not wait
 * for you: whenever another chat finishes a turn, stops on a question or fails, the host wakes
 * the conductor to check in and keep the work moving toward the goal.
 *
 * Its tools are an in-process MCP server (`fleet`), so they only exist in conductor chats.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DONE_FLAGS as DONE_KEYS, holdReason } from './queue.mjs'
import { closeRefusal, etaText, gitHead, groupLabel, handoffBrief, spawnSlots, STALE_MS, staleHint, worktreeDirty } from './fleet-work.mjs'

export const ROLE = 'conductor'
/** after another chat changes, wait this long: several often finish together */
const SETTLE_MS = 45_000
/** at most one check-in this often, however busy the others are */
const MIN_GAP_MS = 2 * 60_000
/** with nothing changing, still look in this often while others are working */
const HEARTBEAT_MS = 10 * 60_000
/** a wait the conductor asked for (fleet_wait) was met: check in after this short settle instead. A few seconds
 * still catches a chat that finishes alongside, and MIN_GAP_MS still holds */
const WAIT_SETTLE_MS = 5_000
/** fleet_wait: how long a wait lasts unless it says, and at most */
const WAIT_DEFAULT_MIN = 60
const WAIT_MAX_MIN = 24 * 60
/** a backstop however long you are away: at most this many check-ins before autopilot stops itself */
const MAX_CHECKINS = 200
/** look for chats that are probably done at most this often */
const STALE_CHECK_MS = 60 * 60_000

export const CONDUCTOR_PROMPT = `
# You are the conductor

The user has several Claude chats open in their Laika app, each working on its own task. You lead them.
The user gives you an overall goal; you keep every chat moving toward it so the user can step away.

Your fleet tools (mcp__fleet__*):
- fleet_list: every other open chat, with its goal, where it stands, what it plans next, and whether it waits on the user.
- fleet_read: a chat's recent messages, when the brief is not enough.
- fleet_send: send a chat a message, as if the user typed it. It is marked as coming from you.
- fleet_suggest: put suggested actions in front of the user as cards they can send with one click.
- fleet_answer: answer a question card another chat is waiting on (autopilot only).
- fleet_spawn: open a new chat in a repo with a first prompt (at most 8 you opened may be open at once; new ones are held while
  this Mac or box1 is loaded or the away budget is low, and fleet_list's spawnSlots.heldBecause says why).
- fleet_close: close a chat you opened once it has finished its brief. It must be idle, with no background work, nothing
  waiting on the user and no uncommitted changes (force skips all but the last). Closing frees a spawn slot. You cannot
  close a chat the user opened: suggest it with fleet_suggest.
- fleet_park: like fleet_close (same checks, frees a spawn slot), but the conversation is kept: the user, or you with
  fleet_unpark, can resume it later. Prefer it to fleet_close when the chat may be wanted again (a follow-up is likely,
  or it holds context worth keeping). fleet_list's "parked" lists parked chats.
- fleet_unpark: resume a parked chat, optionally with a message. It counts against the spawn cap like fleet_spawn.
- fleet_checkpoint_close: for a chat you opened whose brief is done but has uncommitted work: it runs /checkpoint (stop,
  commit locally, one line) and closes the chat when that turn ends cleanly. You hear how it went at your next check-in.
- fleet_wait: be woken as soon as a chat's turn ends (idle), its background work is done, it needs the user, or anything
  about it changes, instead of waiting for the next heartbeat. Waits time out (60 minutes unless you say); fleet_list shows yours.
- fleet_handoff: pass a finished chat's result (its checkpoint, branch and commit, where it stands, its last reply) to another
  chat, or to a new chat in a folder, with what to do with it. Autopilot only.
- fleet_rename: set a chat's title and its group (the project it belongs to, e.g. "Orbit"), so the user's list stays tidy.

- fleet_you: everything the user typed across all chats, in order.
- fleet_note: remember what you have understood about a chat or about the user; notes come back in fleet_list.
- fleet_ready: mark a chat's slice ready for the merge train, once you have seen it committed, typechecked and tested.
  The train merges ready slices into local main itself: never merge by hand, and never push.
- fleet_queue_add, fleet_queue_list, fleet_queue_update, fleet_queue_assign, fleet_queue_cancel: the work queue. Work you
  have decided on but not sent goes on it, not in your head: it survives the host restarting and a chat closing (a closed
  or parked chat's items go back to the unassigned pile). Give each item a one-line title and the full brief to send.
  blockedBy (or after) holds it until those items are done; cycles are refused. On autopilot, when a chat goes idle with
  no item running, its next ready item is sent to it for you, through the same gate as fleet_send; off autopilot it
  waits, marked ready. An item stays running until you (or the chat, or the user) mark it done with fleet_queue_update,
  so mark it as soon as its chat reports it finished: the chat gets nothing new until then. A failed item goes back to
  queued; after 2 failures it waits for the user (needsUser): tell them, and retry only with clearError when the cause
  is gone. Ready items in the unassigned pile are spare work: assign them to an idle chat in that repo.

Read the user, not just the chats:
- Their intent in a chat is in their own words (youSaid, fleet_read), the chat's arc, and your notes, more than in its title.
  Brief replies like "go", "yes", "merge it" mean they trust that chat's plan: carry it on.
- Standing instructions count until the user changes them ("report here every 5 mins", "don't push", "ask me before X").
- If the user said they will do something themselves ("I'll turn the machine on and copy the file"), that chat waits on
  them: don't push it, and list it under what needs them.
- A chat that asked the user to choose, and got no answer, is not abandoned: answer from the goal and the user's recent
  direction if it is clear, otherwise ask the user.
- When you understand something that isn't obvious (a chat's real aim, a preference, how two chats relate), save it with
  fleet_note, and replace notes that have gone stale. Keep them short.
- If a Laika Orbit recall tool is available, use it for background on a project before steering it blind.

How to work:
- Start by calling fleet_list and fleet_you, then say in a few lines what each chat is doing, what you think the user wants
  from it, and how it serves the goal. Ask the user to correct you if anything is off.
- The user is often away for hours while autopilot is on: your job is that no chat sits waiting for them.
- A chat waiting on a question: on autopilot, answer it with fleet_answer when one option is marked (Recommended) or is
  clearly right for the goal and reversible. Otherwise leave it and say which chat and why.
- A chat waiting on a permission needs the user: never try to get around it. Say which chat and why.
- A chat that ended its turn with a plain-text question ("Which do you want?") is waiting too: on autopilot, reply with
  fleet_send when the answer is clear from the goal; otherwise suggest.
- A chat that failed or stopped: read it, and send it what it needs to carry on (often just "continue").
- When a next step is clear, safe and inside the goal, and autopilot is on, send it with fleet_send.
  Anything irreversible or outward-facing (pushing, merging to main, deploying, deleting, spending money, messaging people)
  goes to the user as a suggestion instead, whatever the mode.
- With autopilot off, do not send anything yourself: offer every next step with fleet_suggest.
- Messages starting with "[autopilot]" come from the host, not the user: check the chats that changed, act or suggest, and
  reply in a few lines. If nothing needs doing, say so in one line.
- Do not do the chats' work yourself, and do not edit files: you steer, they build.
- Keep replies short: what changed, what you sent, what needs the user.
- fleet_spawn is for work no open chat should take on. Prefer sending it to an existing chat in that repo. With autopilot
  off, only spawn when the user asked for it. A spawned chat asks for permissions and follows away mode like any other.
- A chat you opened whose brief is done shows "closable" in fleet_list: close it with fleet_close or park it with fleet_park
  (after it has committed), or say why it has to stay open.
- A chat idle for over a day with a clean worktree shows "stale" in fleet_list ("idle 26h, clean: probably done"), and a
  check-in line says so once a day. One you opened: close or park it. One the user opened: never close or send to it; suggest it
  once with fleet_suggest: a "/checkpoint" card whose why says it looks done and can be closed.
- A chat's "background" in fleet_list is its running background work with a rough ETA: use it to answer "check" without
  interrupting the chat.
- "[autopilot] Time is up" means the user is due back: write them a summary of the time away, chat by chat: what got done,
  what you sent or answered on their behalf, which chats you opened, closed and parked (away "spawned", "closed" and "parked": say parked chats can be resumed), whether the away budget was reached, what was auto-approved and what the host
  recovered, and what now needs them,
  most urgent first.

Away mode (the user pressed "I'm away"):
- The host runs a conservative away policy. It auto-approves only plainly safe permissions: reading and editing files inside
  a chat's own folder (not .git, not secrets) and local checks (tests, typecheck, lint, build, read-only git). Everything else
  still waits for the user, and so do irreversible or outward-facing actions: never try to get them approved another way.
- The host also recovers stuck chats: a crashed chat is brought back after a wait, a failed turn is told to continue, a
  usage limit moves the chat to another of the user's accounts or waits for the reset, a silent chat is nudged.
  Do not send "continue" to a chat the host is already recovering: check fleet_list first.
- The user may set an away budget (dollars spent across chats, and chats opened). fleet_list's away.budget shows it and
  the spend so far. Once it is reached, fleet_send, fleet_spawn and fleet_unpark are refused: stop steering, keep answering
  what is safe, and write down what is left for the user. A check-in line "Away mode: Budget reached" says when.
How to lead while the user is away:
- Send, don't suggest, for local and reversible work: writing code inside a chat's own folder, tests, typecheck, lint, local
  builds, read-only git, a local commit. Suggestion cards are for what you cannot take back or what reaches outside this Mac:
  pushing, deploying, merging to main, spending money, messaging or emailing anyone, deleting work. Whatever the mode, those
  stay the user's.
- Never leave a chat sitting idle on one blocker. A chat that stopped has one of a few problems, and each has a move: a
  question card, answer it with fleet_answer when the goal decides it; a plain-text question, answer with fleet_send; a failed
  or stalled turn, send it what it needs to carry on; a permission you cannot approve, give that chat other work in the
  meantime, or park it and say so in the summary. Only a chat where every remaining step needs the user is allowed to wait,
  and it goes at the top of the summary.
- Brief chats so the away policy can approve their commands: one command per Bash call, no && or ; chains, no pipes or
  redirection, no cd other than into their own folder. "Run the tests, then commit" is two calls, and both get approved;
  "pnpm test && git commit" is refused and the chat waits for the user for nothing.
- Do not poll. Set fleet_wait on the chat you are waiting for and end your turn; the host wakes you when it is idle, its
  background work ends, or it needs the user. Reading fleet_list over and over spends the away budget and tells you nothing new.
- fleet_list's "away" field lists what was auto-approved, what is left for the user, and every recovery. Check-in lines
  starting "Away mode:" say what just happened. Put these in the summary: they are what the user most needs to check.
How to steer, away or not:
- Each chat's "work" in fleet_list is read from git: its worktree, commits ahead of main, uncommitted files and the train's
  state (merged / ready / checking / failed / conflict / not-ready). It is the truth; a chat's "now" line can be stale.
- Verify at the source before saying a chat is stalled, done or ready: its branch commits and their times, the imports and
  entry points of what it built, its screenshots. A chat's "now" line is written after its last reply and goes stale.
- Read a chat's youSaid before overriding it. A decision the user made in that chat stands over any general rule of yours.
- Park a chat that is only waiting on the user (a download, a device, a sign-off), so its slot goes to work that can run.
- Brief for slices: the smallest useful fix first, each committed on its own with its own ETA, handed over as it lands.
  Mark each slice ready (fleet_ready) once you have seen it work, rather than waiting for the whole list: the merge train
  merges it into local main.
- For parallel work on one surface, write the shared contract (exact API, who lands it first) into every brief before any
  chat starts, and give each surface one owner. Otherwise every chat builds its own temporary version.
- Every UI or game brief carries the screen rules: verify invisibly (headless or offscreen, no windows or focus stealing),
  one hidden test copy reloaded in place, the lightest check first, visible runs only when the user says so or is away,
  CPU-only work on box1.
`.trim()

/** what the conductor has learned about each chat and about you, kept across restarts (a test points it elsewhere) */
const notesFile = () => process.env.LAIKA_CONDUCTOR_NOTES ?? join(homedir(), '.laika', 'conductor-notes.json')
const readNotes = () => {
  try {
    const n = JSON.parse(readFileSync(notesFile(), 'utf8'))
    return { chats: n.chats ?? {}, you: n.you ?? [] }
  } catch {
    return { chats: {}, you: [] }
  }
}
const writeNotes = (n) => {
  mkdirSync(dirname(notesFile()), { recursive: true, mode: 0o700 })
  writeFileSync(`${notesFile()}.tmp`, JSON.stringify(n, null, 1), { mode: 0o600 })
  renameSync(`${notesFile()}.tmp`, notesFile())
}
/** a chat's notes outlive its tab: they follow the conversation */
const noteKey = (x) => x.sdkSessionId ?? x.id
export const FROM_CONDUCTOR = '[from the conductor] '
/** what away mode (away.mjs) has done, for fleet_list; the host sets it */
let awayDigest = () => null
export const setAwayDigest = (fn) => {
  awayDigest = fn
}
/**
 * Whether anything stops a 'send' or a 'spawn': why, or null; the host sets it. The host puts the
 * autopilot kill switch (autopilot.mjs) ahead of the away budget (away.mjs budgetRefusal) here, so
 * one gate covers both — and is where a future "pause all chats" goes.
 */
let awayBudget = () => null
export const setAwayBudget = (fn) => {
  awayBudget = fn
}

/**
 * Every action a fleet tool takes, told to the host so the autopilot timeline can show it with its
 * reason (autopilot.mjs). Spawning, closing, parking, unparking and renaming already go through the
 * host's own functions, which report there; this is for the ones that act from in here.
 */
let fleetReport = () => {}
export const setFleetReport = (fn) => {
  fleetReport = fn
}
/** what you typed, not what the conductor or the host sent */
const yours = (e) => e.t === 'user' && !e.auto && !String(e.text ?? '').startsWith(FROM_CONDUCTOR) && !/^\[Request interrupted/.test(String(e.text ?? ''))

const clip = (t, n) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}
const ok = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] })
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true })

/** the chats a conductor leads: open, and not conductors themselves */
const fleetOf = (sessions, self) =>
  [...sessions.values()].filter((x) => x !== self && x.state !== 'closed' && x.role !== ROLE)

/** a chat by its id or the first characters of it */
const find = (sessions, self, id) => {
  const key = String(id ?? '').trim()
  if (!key) return null
  const hits = fleetOf(sessions, self).filter((x) => x.id === key || x.id.startsWith(key))
  return hits.length === 1 ? hits[0] : null
}

const card = (x, notes = readNotes()) => {
  const said = x.events.filter(yours)
  const last = said.at(-1)
  return {
    id: x.id.slice(0, 8),
    repo: x.repo,
    title: clip(x.brief?.goal || x.title, 100),
    group: x.group ?? null,
    state: x.state,
    needsUser: [...x.pending.values()].map((p) => p.kind),
    now: clip(x.brief?.now, 200) || null,
    next: clip(x.brief?.next, 200) || null,
    // the arc of the chat, from the host's brief: what each of your prompts was about and how it went
    arc: (x.brief?.turns ?? []).slice(-6).map((t) => `${t.label} (${t.status})`),
    // your own words, most recent last: the best guide to what you want from it
    youSaid: said.slice(-3).map((e) => clip(e.text, 240)),
    youLastSpoke: last ? `${Math.round((Date.now() - last.at) / 60000)}m ago` : null,
    idleFor: x.state === 'idle' ? `${Math.round((Date.now() - x.updatedAt) / 60000)}m` : null,
    cost: Math.round(x.cost * 100) / 100,
    ...(x.spawnedBy ? { spawnedByConductor: x.spawnedBy.slice(0, 8) } : {}),
    // background shells and agents still running, each with a rough ETA
    background: (x.background?.() ?? []).map((t) => `${t.label}: ${etaText(t)}${t.basis ? ` (${t.basis})` : ''}`),
    notes: notes.chats[noteKey(x)] ?? [],
  }
}

/**
 * A chat's ledger as fleet_list shows it: taken from git, so it is the truth about the work where
 * the chat's "now" line may be stale. null when the chat is not in a git repo.
 */
export function ledgerCard(l, now = Date.now()) {
  if (!l) return null
  const ago = (t) => (t ? `${Math.max(0, Math.round((now - t) / 60_000))}m ago` : null)
  return {
    state: l.state,
    worktree: l.worktree,
    branch: l.branch,
    behindMain: l.behind,
    aheadOfMain: l.ahead,
    commits: l.commits.slice(0, 8).map((c) => `${c.sha.slice(0, 7)} ${clip(c.title, 90)} (${ago(c.at)})`),
    uncommitted: l.dirty.count ? { files: l.dirty.count, oldestChange: ago(l.dirty.oldestAt) } : null,
    lastCommit: ago(l.lastCommitAt),
    ...(l.ready ? { ready: `${l.ready.sha.slice(0, 7)} via ${l.ready.via}, ${ago(l.ready.at)}` } : {}),
    ...(l.overlaps?.length ? { overlaps: l.overlaps.map((o) => `${o.file} (also ${o.chat.slice(0, 8)})`) } : {}),
    ...(l.train ? { train: { status: l.train.status, at: ago(l.train.at), ...(l.train.output ? { output: clip(l.train.output, 1200) } : {}) } } : {}),
  }
}

// -------------------------------------------------------------------- waits ----
/** what a conductor can wait for (fleet_wait) */
export const WAIT_UNTIL = ['idle', 'background-done', 'needs-user', 'any-change']
const waitLook = (x) => ({ state: x.state, bg: (x.background?.() ?? []).length, asks: x.pending?.size ?? 0 })

/** whether a chat now meets what a wait is for, in words ("is now idle"); null while it does not */
export function waitMet(x, w) {
  if (!x || x.state === 'closed') return 'was closed'
  const asks = [...(x.pending?.values() ?? [])].map((p) => p.kind)
  switch (w.until) {
    // a turn that ended in an error has ended too
    case 'idle':
      return ['idle', 'error'].includes(x.state) && !asks.length ? `is now ${x.state}` : null
    case 'background-done':
      return (x.background?.() ?? []).length ? null : 'has no background work left'
    case 'needs-user':
      return x.state === 'waiting' || asks.length ? `needs the user (${asks.join(', ') || 'waiting'})` : null
    case 'any-change': {
      const now = waitLook(x)
      if (now.state === w.from?.state && now.bg === w.from?.bg && now.asks === w.from?.asks) return null
      return `changed: now ${now.state}${now.bg ? `, ${now.bg} background task(s)` : ''}${asks.length ? `, needs the user (${asks.join(', ')})` : ''}`
    }
    default:
      return null
  }
}

/**
 * A conductor's waits that are over (met, timed out, or their chat gone): taken off `c.waits` and
 * returned as { chat, line } for its check-in. `only` checks just the waits on that chat.
 */
export function dueWaits(c, sessions, { now = Date.now(), only = null } = {}) {
  const due = []
  const keep = []
  for (const w of c.waits ?? []) {
    if (only && w.chat !== only) {
      keep.push(w)
      continue
    }
    const x = sessions.get(w.chat)
    const name = `${w.chat.slice(0, 8)} (${w.repo})`
    const why = w.note ? `you were waiting: ${w.note}` : `you were waiting for ${w.until}`
    const met = waitMet(x, w)
    if (met) due.push({ chat: w.chat, line: `${name} ${met} (${why})` })
    else if (now >= w.timeoutAt)
      due.push({ chat: w.chat, line: `Wait timed out after ${Math.round((w.timeoutAt - w.at) / 60_000)}m: ${name} is ${x.state}, not yet ${w.until} (${why})` })
    else keep.push(w)
  }
  if (due.length) c.waits = keep
  return due
}

/** the fleet MCP server for one conductor chat */
export async function fleetServer(s, sessions, deps = {}) {
  const { tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk')
  return createSdkMcpServer({ name: 'fleet', version: '1.0.0', tools: fleetTools(s, sessions, tool, deps) })
}

/** the conductor's tools; `tool` is the SDK's, or a stand-in in tests; `deps.spawn` opens a chat (the host's) */
export function fleetTools(s, sessions, tool, deps = {}) {
  // zod comes with the SDK; this package does not depend on it directly
  const { z } = createRequire(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'))('zod')
  const dirtyOf = deps.dirty ?? ((x) => worktreeDirty(x.cwd))
  /** a queue tool: refused plainly when this host has no queue, and a queue refusal comes back as one */
  const queued = (fn) => async (args) => {
    if (!deps.queue) return fail('This host has no work queue.')
    try {
      return await fn(args)
    } catch (e) {
      if (e?.name === 'QueueError') return fail(e.message)
      throw e
    }
  }
  const headOf = deps.head ?? gitHead
  return [
      tool('fleet_list', "List every other open chat: goal, state, where it stands, its planned next step, whether it is waiting on the user, and its work as git sees it (work: worktree, branch, commits ahead of main, uncommitted files, ready/merged/failed/conflict). Trust work over the chat's own 'now' line.", {}, async () => {
        const all = fleetOf(sessions, s)
        const notes = readNotes()
        return ok({
          autopilot: s.autopilot,
          awayUntil: s.autopilotUntil ? new Date(s.autopilotUntil).toISOString() : null,
          goal: s.goal || null,
          away: awayDigest(),
          // the spawn cap: how many chats you may still open, and which open ones count against it
          // chats closed with fleet_park, resumable with fleet_unpark
          parked: (deps.parked?.() ?? []).map((r) => ({
            id: r.id.slice(0, 8),
            repo: r.repo,
            title: clip(r.title, 100),
            group: r.group ?? null,
            parkedAt: new Date(r.parkedAt).toISOString().slice(0, 16),
            reason: r.reason || null,
          })),
          spawnSlots: (({ open, used, max, free, held }) => ({
            used,
            max,
            free,
            // under the cap but held: the Mac or box1 is loaded, or the away budget is low
            ...(held ? { heldBecause: held } : {}),
            open: open.map((x) => `${x.id.slice(0, 8)} (${x.repo})${x.closeAfter ? ' closing after its checkpoint' : ''}`),
          }))(spawnSlots(sessions, { hold: deps.hold ?? (() => null) })),
          // what you asked to be woken for (fleet_wait), with the time each has left
          waits: (s.waits ?? []).map(
            (w) => `${w.chat.slice(0, 8)} (${w.repo}) until ${w.until}, ${Math.max(0, Math.round((w.timeoutAt - Date.now()) / 60_000))}m left${w.note ? `: ${w.note}` : ''}`,
          ),
          aboutTheUser: notes.you,
          chats: await Promise.all(
            all.map(async (x) => {
              // the chat's work as git sees it, never its own status line (work-ledger.mjs)
              const work = deps.ledger ? ledgerCard(await deps.ledger(x).catch(() => null)) : undefined
              const c = { ...card(x, notes), ...(work === undefined ? {} : { work }) }
              // idle for a day and clean: probably done (git only for the chats that look it)
              const looksStale = !!staleHint(x)
              if (!x.spawnedBy) {
                const stale = looksStale ? staleHint(x, { dirty: await dirtyOf(x) }) : null
                return stale ? { ...c, stale } : c
              }
              // a chat you opened: can it be tidied away now, and if not, why not
              const dirty = await dirtyOf(x)
              const why = closeRefusal(x, { dirty })
              const stale = looksStale ? staleHint(x, { dirty }) : null
              return { ...c, closable: !why, ...(why ? { notClosableBecause: why } : {}), ...(stale ? { stale } : {}) }
            }),
          ),
        })
      }),
      tool(
        'fleet_ready',
        "Mark a chat's slice ready for the merge train at its current commit, as a \"Ready: yes\" trailer would. Only once you have seen that it is committed, typechecked and its affected tests pass (read the chat, check its work in fleet_list). The train re-checks it on main and fast-forwards local main when green; it never pushes.",
        { chat: z.string() },
        async ({ chat }) => {
          if (!deps.ready) return fail('This host has no merge train.')
          const x = find(sessions, s, chat)
          if (!x) return fail(`No single open chat matches "${chat}". Call fleet_list for the ids.`)
          try {
            const l = await deps.ready(x)
            fleetReport({ action: 'ready', conductor: s, chat: x, text: `marked ready at ${l?.ready?.sha?.slice(0, 7) ?? 'its tip'}` })
            return ok(`Marked ${x.id.slice(0, 8)} (${x.repo}) ready: ${l?.branch ?? ''} ${l?.ahead ?? 0} commit(s) ahead of ${l?.base ?? 'main'}. The train takes it from here.`)
          } catch (e) {
            return fail(`Not marked ready: ${String(e?.message ?? e)}`)
          }
        },
      ),
      tool(
        'fleet_read',
        "Read a chat's recent messages: the user's prompts, Claude's replies, how turns ended and what it is waiting on.",
        { chat: z.string().describe('chat id (the first 8 characters are enough)'), limit: z.number().int().min(1).max(40).optional() },
        async ({ chat, limit = 12 }) => {
          const x = find(sessions, s, chat)
          if (!x) return fail(`No single open chat matches "${chat}". Call fleet_list for the ids.`)
          const rows = []
          for (const e of x.events) {
            if (e.t === 'user') rows.push({ who: 'user', text: clip(e.text, 600) })
            else if (e.t === 'text' && !e.sub) rows.push({ who: 'claude', text: clip(e.text, 1200) })
            else if (e.t === 'result') rows.push({ who: 'host', text: e.error ? `turn failed: ${clip(e.error, 200)}` : 'turn finished' })
            else if (e.t === 'error') rows.push({ who: 'host', text: `error: ${clip(e.message, 200)}` })
            else if (e.t === 'question') rows.push({ who: 'waiting', text: `asks the user: ${clip((e.questions ?? []).map((q) => q.question).join(' / '), 400)}` })
            else if (e.t === 'permission') rows.push({ who: 'waiting', text: `asks permission for ${e.tool}: ${clip(JSON.stringify(e.input), 200)}` })
          }
          return ok({ chat: card(x), messages: rows.slice(-limit) })
        },
      ),
      tool(
        'fleet_you',
        "Everything the user typed across every chat, oldest first, with when and where: read it to understand their priorities, habits and standing instructions.",
        { limit: z.number().int().min(5).max(120).optional() },
        async ({ limit = 50 }) => {
          const rows = []
          for (const x of fleetOf(sessions, s))
            for (const e of x.events) if (yours(e)) rows.push({ at: e.at, chat: x.id.slice(0, 8), repo: x.repo, text: clip(e.text, 300) })
          rows.sort((a, b) => a.at - b.at)
          return ok(rows.slice(-limit).map((r) => ({ ...r, at: new Date(r.at).toISOString().slice(0, 16) })))
        },
      ),
      tool(
        'fleet_note',
        'Remember something you have understood, so you still know it after a restart: about one chat (its real intent, what it waits on, what the user asked of it) or, with no chat, about the user.',
        {
          chat: z.string().optional().describe('chat id; leave out for a note about the user'),
          note: z.string().min(1).max(400),
          replace: z.boolean().optional().describe('drop the earlier notes for this chat (or about the user) first'),
        },
        async ({ chat, note, replace }) => {
          const n = readNotes()
          let list
          if (chat) {
            const x = find(sessions, s, chat)
            if (!x) return fail(`No single open chat matches "${chat}".`)
            list = replace ? [] : (n.chats[noteKey(x)] ?? [])
            n.chats[noteKey(x)] = [...list, note].slice(-12)
          } else {
            list = replace ? [] : n.you
            n.you = [...list, note].slice(-30)
          }
          writeNotes(n)
          return ok('Noted.')
        },
      ),
      tool(
        'fleet_send',
        'Send a chat a message, as if the user typed it. Only for clear, safe next steps inside the goal, and only while autopilot is on.',
        {
          chat: z.string(),
          text: z.string().min(1).max(4000),
          why: z.string().max(300).optional().describe('one line on why you are sending this; the user reads it in the autopilot timeline'),
        },
        async ({ chat, text, why }) => {
          if (!s.autopilot) return fail('Autopilot is off: offer this with fleet_suggest instead, and the user will send it.')
          const x = find(sessions, s, chat)
          if (!x) return fail(`No single open chat matches "${chat}".`)
          if (x.pending.size) return fail(`That chat is waiting on the user (${[...x.pending.values()].map((p) => p.kind).join(', ')}). Tell the user instead.`)
          if (x.account?.demo) return fail('That is an offline demo chat.')
          const broke = awayBudget('send')
          if (broke) return fail(broke)
          x.send(`${FROM_CONDUCTOR}${text}`)
          fleetReport({ action: 'send', conductor: s, chat: x, text, reason: why ?? '', undo: { kind: 'stop' } })
          return ok(`Sent to ${x.id.slice(0, 8)} (${x.repo}). It was ${x.state === 'running' ? 'already working; the message is queued' : 'idle and has started'}.`)
        },
      ),
      tool(
        'fleet_answer',
        "Answer the question card a chat is waiting on, as the user would. Autopilot only; never for permissions.",
        {
          chat: z.string(),
          answers: z
            .array(z.object({ question: z.string().describe('the question text, as fleet_read shows it'), answer: z.string().describe('the label of the option chosen, or a short free answer') }))
            .min(1),
        },
        async ({ chat, answers }) => {
          if (!s.autopilot) return fail('Autopilot is off: tell the user instead.')
          const x = find(sessions, s, chat)
          if (!x) return fail(`No single open chat matches "${chat}".`)
          // answering for the user is the conductor acting on their behalf: the same gate as sending
          const stopped = awayBudget('send')
          if (stopped) return fail(stopped)
          const q = [...x.pending.entries()].find(([, p]) => p.kind === 'question')
          if (!q) return fail('That chat is not waiting on a question.')
          const [requestId, p] = q
          const asked = p.event.questions ?? []
          const out = {}
          for (const a of answers) {
            const match = asked.find((k) => k.question === a.question) ?? (asked.length === 1 ? asked[0] : null)
            if (!match) return fail(`No question "${clip(a.question, 80)}". It asks: ${asked.map((k) => k.question).join(' / ')}`)
            out[match.question] = a.answer
          }
          x.answer(requestId, { answers: out, annotations: {} })
          x.emit({ t: 'note', text: 'The conductor answered this for you' })
          fleetReport({ action: 'answer', conductor: s, chat: x, text: answers.map((a) => `${clip(a.question, 80)} → ${clip(a.answer, 80)}`).join('; ') })
          return ok(`Answered for ${x.id.slice(0, 8)} (${x.repo}).`)
        },
      ),
      tool(
        'fleet_spawn',
        'Open a new chat in a repo with a first prompt, as the user would from the app. At most 8 chats you opened may be open at once, and new ones are held while this Mac or box1 is loaded or the away budget is low (the refusal says why). It is marked as yours, asks for permissions and follows away mode like any other chat, and is logged in the away summary.',
        {
          cwd: z.string().describe("the repo's folder: an absolute path, or the repo name of an open chat to use its folder"),
          prompt: z.string().min(1).max(8000).describe('the first message, written as the user would say it'),
          account: z.string().optional().describe("account id, label or email; defaults to the conductor's own"),
          title: z.string().max(80).optional(),
        },
        async ({ cwd, prompt, account, title }) => {
          if (!deps.spawn) return fail('This host cannot open chats.')
          const broke = awayBudget('spawn')
          if (broke) return fail(broke)
          const byRepo = fleetOf(sessions, s).find((x) => x.repo === cwd || x.cwd.split('/').pop() === cwd)
          try {
            const x = await deps.spawn(s, { cwd: cwd.startsWith('/') || cwd.startsWith('~') ? cwd : (byRepo?.cwd ?? cwd), prompt, account, title })
            return ok(`Opened ${x.id.slice(0, 8)} in ${x.repo} on ${x.account.label}. It has started on the prompt.`)
          } catch (e) {
            return fail(String(e?.message ?? e))
          }
        },
      ),
      tool(
        'fleet_close',
        "Close a chat you opened (fleet_spawn) once its brief is done: it must be idle, with no background work, nothing waiting on the user and a clean worktree. force skips the idle, background and waiting checks, never the uncommitted-work one. Chats the user opened cannot be closed: suggest it with fleet_suggest. Closing frees a spawn slot and is logged in the away summary.",
        {
          chat: z.string(),
          reason: z.string().max(300).optional().describe('one line on why: it goes in the away summary'),
          force: z.boolean().optional(),
        },
        async ({ chat, reason, force = false }) => {
          if (!deps.close) return fail('This host cannot close chats.')
          const x = find(sessions, s, chat)
          if (!x) return fail(`No single open chat matches "${chat}". Call fleet_list for the ids.`)
          // the cheap refusals first: no git call for a chat you may not close anyway
          if (!x.spawnedBy) return fail(closeRefusal(x, { dirty: false }))
          const why = closeRefusal(x, { dirty: await dirtyOf(x), force })
          if (why) return fail(`Not closed: ${why}`)
          try {
            await deps.close(s, x, { reason: reason ?? '', force })
          } catch (e) {
            return fail(String(e?.message ?? e))
          }
          return ok(`Closed ${x.id.slice(0, 8)} (${x.repo})${force ? ' (forced)' : ''}. A spawn slot is free.`)
        },
      ),
      tool(
        'fleet_park',
        "Park a chat you opened (fleet_spawn): close it like fleet_close, with the same checks, freeing a spawn slot, but keep its conversation so it can be resumed later (by the user, or by you with fleet_unpark). force skips the idle, background and waiting checks, never the uncommitted-work one. Logged in the away summary.",
        {
          chat: z.string(),
          reason: z.string().max(300).optional().describe('one line on why, and what resuming it would be for: it goes in the away summary'),
          force: z.boolean().optional(),
        },
        async ({ chat, reason, force = false }) => {
          if (!deps.park) return fail('This host cannot park chats.')
          const x = find(sessions, s, chat)
          if (!x) return fail(`No single open chat matches "${chat}". Call fleet_list for the ids.`)
          if (!x.spawnedBy) return fail(closeRefusal(x, { dirty: false }))
          if (!x.sdkSessionId) return fail(`${x.id.slice(0, 8)} has no conversation to keep yet: close it with fleet_close instead.`)
          const why = closeRefusal(x, { dirty: await dirtyOf(x), force })
          if (why) return fail(`Not parked: ${why}`)
          try {
            await deps.park(s, x, { reason: reason ?? '', force })
          } catch (e) {
            return fail(String(e?.message ?? e))
          }
          return ok(`Parked ${x.id.slice(0, 8)} (${x.repo})${force ? ' (forced)' : ''}: resumable with fleet_unpark. A spawn slot is free.`)
        },
      ),
      tool(
        'fleet_unpark',
        'Resume a parked chat (fleet_list "parked") where it left off, optionally sending it a message. It counts against the spawn cap, like fleet_spawn, and is logged in the away summary.',
        {
          chat: z.string().describe('the parked chat id (the first 8 characters are enough)'),
          text: z.string().min(1).max(4000).optional().describe('a message to send it once resumed, written as the user would say it'),
        },
        async ({ chat, text }) => {
          if (!deps.unpark) return fail('This host cannot resume parked chats.')
          const broke = awayBudget('spawn')
          if (broke) return fail(broke)
          try {
            const x = await deps.unpark(s, chat, { text })
            return ok(`Resumed ${x.id.slice(0, 8)} (${x.repo})${text ? ' and sent it your message' : ''}.`)
          } catch (e) {
            return fail(String(e?.message ?? e))
          }
        },
      ),
      tool(
        'fleet_checkpoint_close',
        "For a chat you opened whose brief is done: run /checkpoint in it (stop, stop its background work, commit locally, reply in one line), then close it once that turn ends idle with a clean worktree. If it stops on a question or permission, fails, still has uncommitted changes, or the user writes to it meanwhile, it stays open. The outcome comes to your next check-in. Autopilot only.",
        { chat: z.string(), reason: z.string().max(300).optional().describe('one line on why: it goes in the away summary') },
        async ({ chat, reason }) => {
          if (!deps.close) return fail('This host cannot close chats.')
          if (!s.autopilot) return fail('Autopilot is off: suggest "/checkpoint" to the user with fleet_suggest, then close it with fleet_close.')
          const x = find(sessions, s, chat)
          if (!x) return fail(`No single open chat matches "${chat}". Call fleet_list for the ids.`)
          if (!x.spawnedBy) return fail(closeRefusal(x, { dirty: false }))
          if (x.closeAfter) return fail(`${x.id.slice(0, 8)} is already checkpointing to close.`)
          if (x.pending.size) return fail(`That chat is waiting on the user (${[...x.pending.values()].map((p) => p.kind).join(', ')}). Tell the user instead.`)
          if (x.account?.demo) return fail('That is an offline demo chat.')
          x.closeAfter = { conductor: s.id, reason: reason ?? '', mark: x.events.at(-1)?.seq ?? 0, since: Date.now() }
          x.send('/checkpoint The conductor closes this chat when you are done: do not start anything else.', [], { auto: true })
          fleetReport({ action: 'send', conductor: s, chat: x, text: '/checkpoint, then close when the worktree is clean', reason: reason ?? '' })
          return ok(`Sent /checkpoint to ${x.id.slice(0, 8)} (${x.repo}). It closes when that turn ends cleanly; you hear how it went at your next check-in.`)
        },
      ),
      tool(
        'fleet_wait',
        "Be woken as soon as a chat reaches a point, instead of at the next heartbeat: idle (its turn ended, or failed), background-done (no background work left), needs-user (it stops on a question or permission), or any-change. On autopilot you get a check-in within seconds; otherwise a note in this chat. A wait on a chat that closes ends with \"was closed\"; one that runs out of time ends with \"timed out\".",
        {
          chat: z.string(),
          until: z.enum(WAIT_UNTIL),
          note: z.string().max(300).optional().describe('why you are waiting: it comes back with the wake-up'),
          timeoutMinutes: z.number().int().min(1).max(WAIT_MAX_MIN).optional().describe(`default ${WAIT_DEFAULT_MIN}`),
        },
        async ({ chat, until, note, timeoutMinutes }) => {
          const x = find(sessions, s, chat)
          if (!x) return fail(`No single open chat matches "${chat}". Call fleet_list for the ids.`)
          if (!WAIT_UNTIL.includes(until)) return fail(`until is one of ${WAIT_UNTIL.join(', ')}.`)
          const minutes = Math.min(WAIT_MAX_MIN, Math.max(1, Math.round(Number(timeoutMinutes) || WAIT_DEFAULT_MIN)))
          const at = Date.now()
          const w = { chat: x.id, repo: x.repo, until, note: clip(note, 300), at, timeoutAt: at + minutes * 60_000, from: waitLook(x) }
          const name = `${x.id.slice(0, 8)} (${x.repo})`
          const already = until === 'any-change' ? null : waitMet(x, w)
          if (already) return ok(`${name} ${already} already: nothing to wait for.`)
          // one wait per chat and condition: asking again restarts it
          s.waits = [...(s.waits ?? []).filter((o) => !(o.chat === x.id && o.until === until)), w].slice(-20)
          return ok(`Waiting for ${name} until ${until}, for at most ${minutes}m. ${s.autopilot ? 'You get a check-in' : 'Autopilot is off: you get a note in this chat'} as soon as it is.`)
        },
      ),
      tool(
        'fleet_handoff',
        "Pass one chat's finished result to another chat as a brief: its latest Checkpoint line, its git branch and commit, its goal and where it stands, and its last reply, with your note on what to do with it. Send it to an open chat (to), or open a new chat with it (toCwd, like fleet_spawn). Autopilot only.",
        {
          from: z.string().describe('the chat whose result is handed on'),
          to: z.string().optional().describe('the chat that picks it up'),
          toCwd: z.string().optional().describe('or: open a new chat here with the brief as its first prompt (an absolute path, or the repo name of an open chat)'),
          note: z.string().min(1).max(1500).describe('what the next chat should do with it'),
          title: z.string().max(80).optional().describe('title for a new chat'),
        },
        async ({ from, to, toCwd, note, title }) => {
          if (!s.autopilot) return fail('Autopilot is off: offer this with fleet_suggest instead, and the user will send it.')
          if (!to === !toCwd) return fail('Give either to (an open chat) or toCwd (a folder for a new chat).')
          // a new chat counts as a spawn against the away budget; a brief to an open one as a send
          const broke = awayBudget(toCwd ? 'spawn' : 'send')
          if (broke) return fail(broke)
          const x = find(sessions, s, from)
          if (!x) return fail(`No single open chat matches "${from}". Call fleet_list for the ids.`)
          if (['running', 'starting'].includes(x.state)) return fail(`${x.id.slice(0, 8)} is still working: wait for it (fleet_wait until idle), then hand off.`)
          const y = to ? find(sessions, s, to) : null
          if (to) {
            if (!y) return fail(`No single open chat matches "${to}".`)
            if (y === x) return fail('from and to are the same chat.')
            if (y.pending.size) return fail(`That chat is waiting on the user (${[...y.pending.values()].map((p) => p.kind).join(', ')}). Tell the user instead.`)
            if (y.account?.demo) return fail('That is an offline demo chat.')
          } else if (!deps.spawn) return fail('This host cannot open chats.')
          const brief = handoffBrief(x, { head: await headOf(x.cwd), note })
          if (y) {
            y.send(`${FROM_CONDUCTOR}${brief}`)
            fleetReport({ action: 'handoff', conductor: s, chat: y, text: `took over ${x.id.slice(0, 8)} (${x.repo})`, reason: note, undo: { kind: 'stop' } })
            return ok(`Handed ${x.id.slice(0, 8)}'s result to ${y.id.slice(0, 8)} (${y.repo}). It was ${y.state === 'running' ? 'already working; the brief is queued' : 'idle and has started'}.`)
          }
          const byRepo = fleetOf(sessions, s).find((o) => o.repo === toCwd || o.cwd.split('/').pop() === toCwd)
          try {
            const n = await deps.spawn(s, { cwd: toCwd.startsWith('/') || toCwd.startsWith('~') ? toCwd : (byRepo?.cwd ?? toCwd), prompt: `${FROM_CONDUCTOR}${brief}`, title })
            return ok(`Opened ${n.id.slice(0, 8)} in ${n.repo} with ${x.id.slice(0, 8)}'s result. It has started on it.`)
          } catch (e) {
            return fail(String(e?.message ?? e))
          }
        },
      ),
      tool(
        'fleet_rename',
        'Set a chat\'s title and/or its group, the project it belongs to (e.g. "Orbit", "Website", "Mobile app"). The app lists chats by group. An empty group clears it.',
        {
          chat: z.string(),
          title: z.string().min(1).max(80).optional(),
          group: z.string().max(40).optional().describe('project label; "" clears it'),
        },
        async ({ chat, title, group }) => {
          if (title === undefined && group === undefined) return fail('Give a title, a group, or both.')
          const x = find(sessions, s, chat)
          if (!x) return fail(`No single open chat matches "${chat}". Call fleet_list for the ids.`)
          const was = { title: x.title, group: x.group ?? '' }
          if (title !== undefined) x.title = title.replace(/\s+/g, ' ').trim().slice(0, 80) || x.title
          if (group !== undefined) x.group = groupLabel(group)
          deps.renamed?.(x)
          fleetReport({ action: 'rename', conductor: s, chat: x, text: `“${was.title}” → “${x.title}”${x.group === was.group ? '' : `, ${x.group ? `in ${x.group}` : 'no group'}`}`, undo: { kind: 'rename', ...was } })
          return ok(`${x.id.slice(0, 8)} is now "${x.title}"${x.group ? ` in ${x.group}` : ', with no group'}.`)
        },
      ),
      tool(
        'fleet_suggest',
        'Show the user suggested actions as cards; each one sends its text to that chat when clicked. Use for anything that needs their say.',
        {
          items: z
            .array(
              z.object({
                chat: z.string().describe('chat id'),
                text: z.string().min(1).max(2000).describe('the message the chat would receive, written as the user would say it'),
                why: z.string().max(300).optional().describe('one line on why'),
              }),
            )
            .min(1)
            .max(8),
        },
        async ({ items }) => {
          const shown = []
          const missing = []
          for (const it of items) {
            const x = find(sessions, s, it.chat)
            if (!x) missing.push(it.chat)
            else shown.push({ chat: x.id, repo: x.repo, title: clip(x.brief?.goal || x.title, 80), text: it.text, why: it.why ?? '' })
          }
          if (shown.length) s.emit({ t: 'suggestions', items: shown })
          for (const it of shown) fleetReport({ action: 'suggest', conductor: s, chat: it.chat, repo: it.repo, text: it.text, reason: it.why })
          return ok(`Showed ${shown.length} suggestion(s)${missing.length ? `; no chat matched ${missing.join(', ')}` : ''}.`)
        },
      ),
      tool(
        'fleet_queue_add',
        "Put work on the queue: a one-line title and the full brief to send. Give it to a chat, or leave chat out for the unassigned pile. blockedBy (or after) holds it until those items are done. On autopilot it is sent when its chat is next idle with nothing running; off autopilot it waits, marked ready.",
        {
          title: z.string().min(1).max(120).describe('one line: what the work is'),
          brief: z.string().min(1).max(8000).describe('the full text to send the chat, written as the user would say it'),
          chat: z.string().optional().describe('the chat to give it to; leave out for the unassigned pile'),
          repo: z.string().optional().describe("defaults to the chat's repo"),
          blockedBy: z.array(z.string()).optional().describe('item ids this waits on'),
          after: z.string().optional().describe('one item id: the same as blockedBy [id]'),
          estimate: z.number().min(0).max(24 * 60).optional().describe('minutes'),
          machine: z.enum(['mac', 'box1', 'any']).optional(),
          order: z.number().optional().describe('its place in its list; default the end'),
        },
        queued(async ({ chat, ...f }) => {
          const x = chat ? find(sessions, s, chat) : null
          if (chat && !x) return fail(`No single open chat matches "${chat}". Call fleet_list for the ids, or leave chat out for the unassigned pile.`)
          const item = deps.queue.add({ ...f, chatId: x?.id ?? null, repo: f.repo || x?.repo || '', createdBy: 'conductor' })
          fleetReport({ action: 'queue', conductor: s, chat: x, repo: item.repo, text: `queued: ${item.title}`, reason: item.waitingOn.length ? `after ${item.waitingOn.join(', ')}` : '' })
          return ok(`Queued ${item.id}${x ? ` for ${x.id.slice(0, 8)} (${x.repo})` : ' in the unassigned pile'}: ${item.ready ? (s.autopilot ? 'ready, it goes out when that chat is next idle' : 'ready, waiting for autopilot or the user') : holdReason(item)}.`)
        }),
      ),
      tool(
        'fleet_queue_list',
        'The queue: what is running, what is ready to go out next, what waits on what, and what waits for the user. Done and cancelled items are left out unless includeDone.',
        {
          chat: z.string().optional().describe('one chat, or "none" for the unassigned pile'),
          state: z.array(z.enum(['queued', 'running', 'blocked', 'done', 'cancelled'])).optional(),
          repo: z.string().optional(),
          includeDone: z.boolean().optional(),
        },
        queued(async ({ chat, state, repo, includeDone }) => {
          let chatId = chat
          if (chat && chat !== 'none') {
            const x = find(sessions, s, chat)
            chatId = x?.id ?? chat
          }
          const items = deps.queue.list({ chat: chatId, state, repo, includeDone })
          const now = Date.now()
          const row = (r) => ({
            id: r.id,
            title: r.title,
            chat: r.chatId ? r.chatId.slice(0, 8) : null,
            repo: r.repo,
            state: r.state,
            ...(r.ready ? { ready: true } : {}),
            ...(r.waitingOn.length ? { waitingOn: r.waitingOn } : {}),
            ...(r.needsUser ? { needsUser: true } : {}),
            ...(r.lastError ? { lastError: clip(r.lastError, 160) } : {}),
            ...(r.retries ? { retries: r.retries } : {}),
            ...(r.state === 'running' && r.startedAt ? { running: `${Math.round((now - r.startedAt) / 60_000)}m` } : {}),
            ...(r.estimate ? { estimate: `${r.estimate}m` } : {}),
            ...(r.machine !== 'any' ? { machine: r.machine } : {}),
            done: DONE_KEYS.filter((k) => r.done[k]),
          })
          const { counts } = deps.queue.view()
          return ok({ autopilot: s.autopilot, counts, items: items.map(row) })
        }),
      ),
      tool(
        'fleet_queue_update',
        "Change a queue item: mark it done (state 'done', and the done flags you have checked), reorder it, change what it waits on, or hold it (state 'blocked'). clearError gives a failed item its retries back.",
        {
          id: z.string(),
          state: z.enum(['queued', 'running', 'blocked', 'done', 'cancelled']).optional(),
          order: z.number().optional(),
          blockedBy: z.array(z.string()).optional().describe('replaces the list'),
          done: z.object({ committed: z.boolean().optional(), reachable: z.boolean().optional(), verified: z.boolean().optional() }).optional(),
          title: z.string().min(1).max(120).optional(),
          brief: z.string().min(1).max(8000).optional(),
          estimate: z.number().min(0).max(24 * 60).optional(),
          machine: z.enum(['mac', 'box1', 'any']).optional(),
          artefacts: z.array(z.string()).max(60).optional().describe('replaces the list'),
          clearError: z.boolean().optional().describe('clear lastError and give it its 2 retries back'),
        },
        queued(async ({ id, ...patch }) => {
          const item = deps.queue.update(id, patch)
          const flags = DONE_KEYS.filter((k) => item.done[k])
          return ok(`${item.id} is ${item.state}${item.state === 'done' ? ` (${flags.length ? flags.join(', ') : 'no done flags set'})` : ''}${item.ready ? ', ready' : item.state === 'queued' ? `: ${holdReason(item)}` : ''}.`)
        }),
      ),
      tool(
        'fleet_queue_assign',
        'Give a queue item to a chat, or back to the unassigned pile (chat null). Assigning is not sending: it goes out when that chat is next idle, on autopilot.',
        {
          id: z.string(),
          chat: z.string().nullable().describe('the chat, or null for the unassigned pile'),
          why: z.string().max(300).optional().describe('one line on why; the user reads it in the autopilot timeline'),
        },
        queued(async ({ id, chat, why }) => {
          const x = chat ? find(sessions, s, chat) : null
          if (chat && !x) return fail(`No single open chat matches "${chat}". Call fleet_list for the ids.`)
          const item = deps.queue.assign(id, x?.id ?? null, { why: why ?? '' })
          fleetReport({ action: 'queue', conductor: s, chat: x, repo: item.repo, text: `${item.title} → ${x ? `${x.id.slice(0, 8)} (${x.repo})` : 'the unassigned pile'}`, reason: why ?? '' })
          return ok(`${item.id} is now ${x ? `${x.id.slice(0, 8)}'s (${x.repo})` : 'in the unassigned pile'}${item.ready ? ', ready' : `: ${holdReason(item)}`}.`)
        }),
      ),
      tool(
        'fleet_queue_cancel',
        'Drop a queue item. It stays in the list as cancelled; items that wait on it are then stuck, and are named so you can re-point or cancel them.',
        {
          id: z.string(),
          reason: z.string().max(300).optional(),
        },
        queued(async ({ id, reason }) => {
          const { item, stuck } = deps.queue.cancel(id, { reason: reason ?? '' })
          fleetReport({ action: 'queue', conductor: s, repo: item.repo, text: `cancelled: ${item.title}`, reason: reason ?? '' })
          return ok(`Cancelled ${item.id}.${stuck.length ? ` Now stuck waiting on it: ${stuck.join(', ')}. Re-point their blockedBy or cancel them.` : ''}`)
        }),
      ),
  ]
}

/**
 * A chat asked to checkpoint and close (fleet_checkpoint_close) changed state: once the checkpoint
 * turn is over, close it if it may be closed, otherwise leave it open and say why. The host calls
 * this on every state change; `deps` has `dirty`, `close` (the host's) and `tell` (watchFleet's).
 */
export async function settleCheckpointClose(x, sessions, { dirty = (x) => worktreeDirty(x.cwd), close, tell }) {
  const p = x.closeAfter
  if (!p || p.settling || ['running', 'starting'].includes(x.state)) return null
  const c = sessions.get(p.conductor)
  const name = `${x.id.slice(0, 8)} (${x.repo})`
  const done = (outcome, line) => {
    x.closeAfter = null
    if (c && c.state !== 'closed') tell?.(c, line)
    return outcome
  }
  if (x.state === 'closed') return done('gone', `${name} was closed before its checkpoint finished.`)
  if (!c || c.state === 'closed') return done('orphaned', null)
  if (x.state === 'waiting' || x.pending?.size)
    return done('left', `${name} stopped on ${[...x.pending.values()].map((q) => q.kind).join(', ') || 'the user'} during its checkpoint: left open.`)
  if (x.state !== 'idle') return done('left', `${name}'s checkpoint turn ended in ${x.state}: left open.`)
  // the host restarted mid-checkpoint: the turn was cut off, so it is not known to be done
  if (p.restored === 'busy')
    return done('left', `The host restarted during ${name}'s checkpoint: left open. Ask again with fleet_checkpoint_close once it is idle.`)
  // event seqs start again after a restart: a restored close goes by time (the replayed history keeps its times)
  const after = p.mark == null ? x.events.filter((e) => (e.at ?? 0) >= (p.since ?? 0)) : x.events.filter((e) => e.seq > p.mark)
  // the replayed checkpoint prompt has lost its automatic mark: it is not the user writing
  if (after.some((e) => yours(e) && !/^\s*\[?\/checkpoint\b/.test(String(e.text ?? '')))) return done('left', `The user wrote to ${name} during its checkpoint: left open.`)
  // idle between turns, before the checkpoint turn itself has run and ended (a restored idle chat has run it)
  if (!p.restored && !after.some((e) => e.t === 'result')) return null
  const line = clip(after.filter((e) => e.t === 'text' && !e.sub && /Checkpoint:/.test(e.text ?? '')).at(-1)?.text.match(/Checkpoint:.*/)?.[0], 200)
  p.settling = true
  const why = closeRefusal(x, { dirty: await dirty(x) })
  p.settling = false
  if (why) return done('left', `${name} not closed after its checkpoint${line ? ` (${line})` : ''}: ${why}`)
  x.closeAfter = null
  await close(c, x, { reason: [p.reason, line].filter(Boolean).join(' · '), force: false })
  return done('closed', `Closed ${name} after its checkpoint${line ? ` (${line})` : ''}. A spawn slot is free.`)
}

/** a pending checkpoint-close as the registry keeps it: the event mark means nothing after a restart */
export const savedCloseAfter = (p) => (p?.conductor ? { conductor: p.conductor, reason: p.reason ?? '', since: p.since ?? 0 } : null)

/**
 * A pending checkpoint-close brought back with its chat after a restart. `busy`: the chat was mid-turn
 * when the host went down, so the checkpoint was cut off; otherwise it had already run.
 */
export const restoredCloseAfter = (saved, { busy = false } = {}) =>
  saved?.conductor ? { conductor: saved.conductor, reason: saved.reason ?? '', since: saved.since ?? 0, mark: null, restored: busy ? 'busy' : 'idle' } : null

/**
 * Autopilot: wake idle conductors when the chats they lead change. `send` is the conductor's own
 * Session.send, so a check-in looks like any other turn in its chat.
 */
export function watchFleet(sessions, { dirty = (x) => worktreeDirty(x.cwd) } = {}) {
  const changed = new Map() // conductor → Map(chat id → state)
  const awayLines = new Map() // conductor → what away mode did since its last check-in
  const waitLines = new Map() // conductor → [{ chat, line }]: the waits it asked for that are over
  const WAIT_WHY = 'A chat you were waiting on has news:'
  const timers = new Map()

  const checkIn = (c, why) => {
    if (c.state === 'closed' || !c.autopilot) return
    // busy or waiting on you: try again once it is free
    if (c.state !== 'idle') return schedule(c, SETTLE_MS)
    const seen = changed.get(c) ?? new Map()
    changed.delete(c)
    const away = (awayLines.get(c) ?? []).slice(-12)
    awayLines.delete(c)
    const waited = waitLines.get(c) ?? []
    waitLines.delete(c)
    // a wait's own line says it better than "is now idle"
    for (const w of waited) seen.delete(w.chat)
    c.checkins = (c.checkins ?? 0) + 1
    c.lastCheckIn = Date.now()
    if (c.checkins > MAX_CHECKINS) {
      setAutopilot(c, false, { note: `Autopilot switched off after ${MAX_CHECKINS} check-ins. Switch it back on to carry on.` })
      return
    }
    const byId = new Map([...sessions.values()].map((x) => [x.id, x]))
    const lines = [...seen].map(([id, state]) => `- ${id.slice(0, 8)} (${byId.get(id)?.repo ?? '?'}) is now ${state}`)
    lines.push(...waited.map((w) => `- ${w.line}`))
    lines.push(...away.map((a) => `- ${a}`))
    c.send(
      `[autopilot] ${why}${lines.length ? `\n${lines.join('\n')}` : ''}\nCheck in on the fleet and keep it moving toward the goal${c.goal ? `: ${c.goal}` : ''}.`,
      [],
      { auto: true },
    )
  }

  const schedule = (c, ms, why) => {
    // a wait that is over is worth a prompt look, whatever else changed meanwhile
    if (waitLines.get(c)?.length) ms = Math.min(ms, WAIT_SETTLE_MS)
    clearTimeout(timers.get(c))
    const wait = Math.max(ms, (c.lastCheckIn ?? 0) + MIN_GAP_MS - Date.now())
    const t = setTimeout(() => {
      timers.delete(c)
      checkIn(c, why ?? (waitLines.get(c)?.length ? WAIT_WHY : changed.get(c)?.size ? 'Chats changed:' : 'Heartbeat: nothing has changed for a while.'))
    }, wait)
    t.unref?.()
    timers.set(c, t)
  }

  const conductors = () => [...sessions.values()].filter((x) => x.role === ROLE && x.autopilot && x.state !== 'closed')

  /** the waits conductors asked for (fleet_wait) that are over now, on `x` or (null) on any chat: wake them */
  const checkWaits = (x) => {
    for (const c of sessions.values()) {
      if (c.role !== ROLE || !c.waits?.length) continue
      if (c.state === 'closed') {
        c.waits = []
        continue
      }
      const due = dueWaits(c, sessions, { only: x?.id ?? null })
      if (!due.length) continue
      if (!c.autopilot) {
        for (const w of due) c.emit({ t: 'note', text: w.line.slice(0, 300) })
        continue
      }
      waitLines.set(c, [...(waitLines.get(c) ?? []), ...due].slice(-40))
      schedule(c, WAIT_SETTLE_MS, WAIT_WHY)
    }
  }

  // a lead chat's turn ended, or it stopped on you: that is worth a look
  const onState = (x) => {
    checkWaits(x)
    if (x.role === ROLE || x.account?.demo) return
    if (!['idle', 'waiting', 'error'].includes(x.state)) return
    for (const c of conductors()) {
      const m = changed.get(c) ?? new Map()
      m.set(x.id, x.state)
      changed.set(c, m)
      schedule(c, SETTLE_MS)
    }
  }

  const beat = setInterval(() => {
    // time-outs, and background work that ends without the host hearing (a live-progress board)
    checkWaits(null)
    for (const c of conductors()) {
      if (c.autopilotUntil && Date.now() >= c.autopilotUntil) {
        timeUp(c)
        continue
      }
      const working = fleetOf(sessions, c).some((x) => x.state === 'running')
      if (working && !timers.has(c) && Date.now() - (c.lastCheckIn ?? c.updatedAt) > HEARTBEAT_MS) schedule(c, 0)
    }
    if (Date.now() - lastStaleCheck >= STALE_CHECK_MS) staleCheck().catch(() => {})
  }, 60_000)
  beat.unref?.()

  // chats idle for a day with a clean worktree: each conductor on autopilot hears once a day per chat
  let lastStaleCheck = Date.now()
  const hinted = new Map() // chat id → when its stale line was last sent
  const staleCheck = async () => {
    lastStaleCheck = Date.now()
    const leads = conductors()
    if (!leads.length) return []
    const lines = []
    const seen = new Set()
    for (const c of leads)
      for (const x of fleetOf(sessions, c)) {
        if (seen.has(x.id) || x.account?.demo || !staleHint(x)) continue
        seen.add(x.id)
        if (Date.now() - (hinted.get(x.id) ?? -Infinity) < STALE_MS) continue
        const hint = staleHint(x, { dirty: await dirty(x) })
        if (!hint) continue
        hinted.set(x.id, Date.now())
        const what = x.spawnedBy ? 'you opened it: close or park it' : 'the user opened it: suggest closing it with fleet_suggest'
        lines.push(`${x.id.slice(0, 8)} (${x.repo}) is stale: ${hint}; ${what}`)
      }
    for (const [id] of hinted) if (!sessions.has(id)) hinted.delete(id)
    if (!lines.length) return lines
    for (const c of conductors()) {
      awayLines.set(c, [...(awayLines.get(c) ?? []), ...lines].slice(-40))
      if (!timers.has(c)) schedule(c, SETTLE_MS, 'Chats that look done:')
    }
    return lines
  }

  // time is up: one last turn to tell you what happened, then it only suggests again
  const timeUp = (c) => {
    if (c.state !== 'idle') return // the next beat tries again
    setAutopilot(c, false, { note: 'Away time is up: autopilot is off' })
    c.send('[autopilot] Time is up: the user is due back. Write them the summary of the time away.', [], { auto: true })
  }

  /** `minutes`: how long you are away; 0 or missing means until you switch it off */
  const setAutopilot = (c, on, { minutes = 0, note } = {}) => {
    c.autopilot = on
    c.autopilotUntil = on && minutes > 0 ? Date.now() + minutes * 60_000 : null
    if (on) {
      c.checkins = 0
      c.awaySince = Date.now()
    } else {
      clearTimeout(timers.get(c))
      timers.delete(c)
      changed.delete(c)
      awayLines.delete(c)
      // waits already over: still shown, as notes
      for (const w of waitLines.get(c) ?? []) c.emit({ t: 'note', text: w.line.slice(0, 300) })
      waitLines.delete(c)
    }
    c.emit({ t: 'autopilot', on, until: c.autopilotUntil })
    const until = c.autopilotUntil ? ` until ${new Date(c.autopilotUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''
    c.emit({ t: 'note', text: note ?? (on ? `Autopilot on${until}: the conductor keeps the chats going and answers what it safely can` : 'Autopilot off: the conductor only suggests') })
    awake()
    // straight away, rather than at the first change
    if (on) schedule(c, 0, 'Autopilot is on: the user is stepping away. Take stock of every chat and get the waiting ones moving.')
  }

  // the Mac must not sleep while you are away and the chats are meant to keep going
  let caffeinate = null
  const awake = () => {
    const want = conductors().length > 0
    if (want && !caffeinate && process.platform === 'darwin') {
      caffeinate = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
      caffeinate.on('exit', () => (caffeinate = null))
      caffeinate.on('error', () => (caffeinate = null))
    } else if (!want && caffeinate) {
      caffeinate.kill()
      caffeinate = null
    }
  }

  /** away mode acted (an approval left for the user, a recovery): conductors on autopilot hear at their next check-in */
  const awayNote = (line) => {
    for (const c of conductors()) {
      awayLines.set(c, [...(awayLines.get(c) ?? []), `Away mode: ${String(line).slice(0, 300)}`].slice(-40))
      if (!timers.has(c)) schedule(c, SETTLE_MS, 'Away mode acted:')
    }
  }

  /** something for one conductor alone (a checkpoint-close it asked for): shown in its chat, and at its next check-in */
  const tell = (c, line) => {
    const text = String(line).slice(0, 300)
    c.emit({ t: 'note', text })
    if (!c.autopilot || c.state === 'closed') return
    awayLines.set(c, [...(awayLines.get(c) ?? []), text].slice(-40))
    if (!timers.has(c)) schedule(c, SETTLE_MS, 'A chat you asked about has news:')
  }

  return {
    onState,
    /** a chat's background work started or ended (Session.tasksChanged) */
    tasksChanged: (x) => checkWaits(x),
    setAutopilot,
    awayNote,
    tell,
    /** look for stale chats now (the minute beat does it hourly); the lines told to conductors */
    staleCheck,
    /** a conductor restored after a restart keeps its autopilot */
    restored: () => awake(),
    humanSpoke: (c) => (c.checkins = 0),
  }
}
