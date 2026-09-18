/**
 * Commands you can run from Orbit: the palette and a run's "Run again" (2026-09-19, for a game project's playtest lane: the
 * user's "trigger playtests on the fly": 'Playtest: run squad', 'Playtest: human run', 'Playtest: judge').
 *
 * A project registers what may be run by dropping a JSON file in ~/.laika/commands/ — an array of
 *   { "id": "game-playtest-squad", "title": "Playtest: run squad", "argv": ["bash", "/abs/playtest.sh", "squad"], "cwd": "/abs" }
 * Orbit never runs anything that is not in that registry, and it never runs a shell: argv is spawned as given, and the
 * extra arguments a caller adds (a run's "Run again" carries them, e.g. ["--seed", "7"]) must each be a plain token.
 *
 *   GET  /api/commands                  { commands: [{ id, title }] }
 *   POST /api/commands/<id>/run         { args?: string[] }  → { ok, pid, log }
 *
 * The POST must carry the header `x-orbit-command: 1`. A page on another site cannot set it without a CORS preflight,
 * and this server answers no preflight, so a web page cannot make the machine run a command (the other POSTs here only
 * write reports; this one starts processes, so it asks for more).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const COMMANDS_DIR = process.env.LAIKA_COMMANDS_DIR || join(homedir(), '.laika', 'commands')
const TOKEN = /^[A-Za-z0-9._:=/@-]{1,120}$/

/** Every registered command, from every file in the registry; a broken file is skipped, never fatal. */
export function listCommands(dir = COMMANDS_DIR) {
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    try {
      const v = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      for (const c of Array.isArray(v) ? v : [v])
        if (c && typeof c.id === 'string' && TOKEN.test(c.id) && Array.isArray(c.argv) && c.argv.length && c.argv.every((a) => typeof a === 'string'))
          out.push({ id: c.id, title: String(c.title || c.id), argv: c.argv, cwd: typeof c.cwd === 'string' ? c.cwd : undefined })
    } catch {
      /* a file being written, or not ours: skip it */
    }
  }
  return out
}

/** Start a registered command, detached, its output in ~/.laika/commands/logs. */
export function runCommand(id, args = [], dir = COMMANDS_DIR) {
  const c = listCommands(dir).find((x) => x.id === id)
  if (!c) throw new Error(`no command called ${id}`)
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string' && TOKEN.test(a))) throw new Error('arguments must be plain tokens')
  const logs = join(dir, 'logs')
  mkdirSync(logs, { recursive: true })
  const log = join(logs, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
  const fd = openSync(log, 'a')
  const child = spawn(c.argv[0], [...c.argv.slice(1), ...args], { cwd: c.cwd, detached: true, stdio: ['ignore', fd, fd] })
  child.unref()
  return { pid: child.pid, log }
}

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** The route: true when it answered. */
export async function handleCommands(url, req, res) {
  if (url.pathname === '/api/commands' && req.method === 'GET') {
    send(res, 200, { commands: listCommands().map(({ id, title }) => ({ id, title })) })
    return true
  }
  const m = /^\/api\/commands\/([^/]+)\/run$/.exec(url.pathname)
  if (!m || req.method !== 'POST') return false
  if (req.headers['x-orbit-command'] !== '1') {
    send(res, 403, { error: 'this request must come from Orbit (x-orbit-command)' })
    return true
  }
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 8_000) return send(res, 413, { error: 'too large' }), true
  }
  try {
    const body = raw.trim() ? JSON.parse(raw) : {}
    const r = runCommand(decodeURIComponent(m[1]), body.args ?? [])
    send(res, 200, { ok: true, ...r })
  } catch (e) {
    send(res, 400, { error: String(e.message || e) })
  }
  return true
}
