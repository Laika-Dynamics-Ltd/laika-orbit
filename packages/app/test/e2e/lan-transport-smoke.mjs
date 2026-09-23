#!/usr/bin/env node
/**
 * The agent host really booting on the transport, on a port of its own.
 *
 * The unit tests prove the wire; this proves the host still starts on it — it writes its state
 * file, answers /health on loopback, moves onto the network and back on POST /lan without
 * losing the port, and says so in the state file both times. That is the whole of what the
 * pairing panel reads, so it is the whole of what a refactor here could break.
 */
import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const APP_PORT = '5987'
const STATE = join(tmpdir(), `laika-agent-host-${APP_PORT}.json`)
const HOST = resolve(import.meta.dirname, '../../agent-host.mjs')
rmSync(STATE, { force: true })

const host = spawn(process.execPath, [HOST], { env: { ...process.env, APP_PORT, AGENT_PORT: '0', AGENT_LAN: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
const log = []
host.stdout.on('data', (d) => log.push(String(d)))
host.stderr.on('data', (d) => log.push(String(d)))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const state = () => JSON.parse(readFileSync(STATE, 'utf8'))
const checks = []
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  checks.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${ok ? '' : `\n        wanted ${JSON.stringify(want)}\n        got    ${JSON.stringify(got)}`}`)
}

try {
  for (let i = 0; i < 100; i++) {
    try {
      state()
      break
    } catch {
      await wait(100)
    }
  }
  const { port, token } = state()
  const call = (path, init) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-agent-token': token, ...init?.headers } })

  check('the host launched on loopback', state().lan, false)
  check('/health answers', (await call('/health')).status, 200)
  check('a request with no token is refused', (await fetch(`http://127.0.0.1:${port}/health`)).status, 401)

  const on = await (await call('/lan', { method: 'POST', body: '{"on":true}' })).json()
  check('POST /lan {on:true} reports it is carrying', on.lan, true)
  check('  on the same port', on.port, port)
  await wait(300)
  check('  and the state file agrees', state().lan, true)
  check('  and it still answers there', (await call('/health')).status, 200)

  const off = await (await call('/lan', { method: 'POST', body: '{"on":false}' })).json()
  check('POST /lan {on:false} gives the network back', off.lan, false)
  check('  keeping the port', off.port, port)
  await wait(300)
  check('  and the state file agrees', state().lan, false)
  check('  and loopback still answers', (await call('/health')).status, 200)
} finally {
  host.kill('SIGTERM')
  await wait(400)
  host.kill('SIGKILL')
  rmSync(STATE, { force: true })
}

const bad = checks.filter((c) => !c).length
if (bad) {
  console.log(`\n${bad} check(s) failed. Host said:\n${log.join('')}`)
  process.exit(1)
}
console.log(`\nall ${checks.length} checks passed`)
