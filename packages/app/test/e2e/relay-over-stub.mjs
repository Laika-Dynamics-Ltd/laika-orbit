#!/usr/bin/env node
/**
 * The real agent host, driven from a "phone" that never touches the network.
 *
 * The unit tests exercise the relay against a handler written for them. This runs it against the
 * host itself: the actual process, its actual routes, its actual event stream — reached only by
 * sealing a request into an in-process stand-in for a database and reading the sealed answer out.
 *
 * Nothing here opens a socket to anything but 127.0.0.1, and no database exists: which one Orbit
 * relays through is the user's choice and has not been made. What this proves is that when it is
 * made, the code on this side is already right — and that the table that database would have
 * been left holding contains nothing a person wrote.
 */
import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRelayTransport } from '../../relay-transport.mjs'
import { sealedChannel } from '../../sealed-envelope.mjs'
import { createRelayStub, createStubPhone } from '../relay-stub.mjs'

const APP_PORT = '5986'
const STATE = join(tmpdir(), `laika-agent-host-${APP_PORT}.json`)
const HOST = resolve(import.meta.dirname, '../../agent-host.mjs')
rmSync(STATE, { force: true })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const checks = []
const check = (what, ok, extra = '') => {
  checks.push(Boolean(ok))
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${ok || !extra ? '' : `\n        ${extra}`}`)
}

const host = spawn(process.execPath, [HOST], { env: { ...process.env, APP_PORT, AGENT_PORT: '0', AGENT_LAN: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
const log = []
host.stdout.on('data', (d) => log.push(String(d)))
host.stderr.on('data', (d) => log.push(String(d)))

let relay
try {
  for (let i = 0; i < 100 && !(() => { try { JSON.parse(readFileSync(STATE, 'utf8')); return true } catch { return false } })(); i++) await wait(100)
  const { port, token } = JSON.parse(readFileSync(STATE, 'utf8'))
  console.log(`the agent host is up on 127.0.0.1:${port}\n`)

  /**
   * The relay's handler, standing where agent-host.mjs puts its own front door. It forwards to
   * the running host over loopback and pours the answer back into the response the relay handed
   * it — including a text/event-stream, chunk by chunk, which is the part a request/response
   * pipe has no natural way to do.
   */
  const handler = async (req, res) => {
    const body = []
    for await (const c of req) body.push(c)
    const r = await fetch(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers, body: body.length ? Buffer.concat(body) : undefined })
    const headers = Object.fromEntries(r.headers)
    res.writeHead(r.status, headers)
    if (!/text\/event-stream/.test(headers['content-type'] ?? '')) return res.end(Buffer.from(await r.arrayBuffer()).toString('utf8'))
    const reader = r.body.getReader()
    req.on('close', () => reader.cancel().catch(() => {}))
    const pump = async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || res.writableEnded) break
        res.write(Buffer.from(value).toString('utf8'))
      }
    }
    pump().catch(() => {})
  }

  // the pairing secret is the secret the QR already carries: this launch's host token
  const stub = createRelayStub({ latency: 2 })
  relay = createRelayTransport({ handler, secret: token, db: stub.db })
  await relay.open()
  check('the relay carries nothing until it is asked to', relay.status().carrying === false)
  await relay.carry(true)
  check('asked, it holds the room and waits', relay.status().carrying === true)
  console.log(`room ${relay.status().room} — derived from the pairing, not from the machine\n`)

  const phone = createStubPhone({ stub, secret: token, token, channel: sealedChannel({ secret: token, side: 'phone' }) })

  const health = await phone.ask('/health')
  check('GET /health over the relay answers 200', health.status === 200, JSON.stringify(health))
  check('  and it is the real host that answered', JSON.parse(health.body).pid === host.pid, health.body)

  const fleet = await phone.ask('/fleet')
  check('GET /fleet over the relay answers 200', fleet.status === 200)

  const accounts = await phone.ask('/accounts', { timeout: 15_000 })
  check('GET /accounts over the relay answers 200', accounts.status === 200)

  check('a request without the token is refused, exactly as on the link', (await phone.ask('/health', { headers: { 'x-agent-token': 'wrong' } })).status === 401)
  check('an unknown route still 404s', (await phone.ask('/nope')).status === 404)

  const stream = await phone.ask('/fleet/events', { stream: true, timeout: 10_000 })
  await wait(400)
  check('an event stream is open through the relay', relay.status().inflight === 1)
  await stream.cancel()
  const got = await stream.answer
  check('  it arrived as sealed chunks', got.chunks.length > 0, JSON.stringify(got).slice(0, 200))
  check('  starting with the host\'s own snapshot frame', /event: snapshot/.test(got.chunks.join('')))
  check('  and hanging up closed it on the host side', relay.status().inflight === 0)

  // --- what a provider with full read access to that table would have ---
  const table = stub.dump()
  console.log(`\n${stub.rows.length} rows went through the stand-in database`)
  const shapes = new Set(stub.rows.map((r) => Object.keys(r.envelope).sort().join(',')))
  check('every row is the same five fields: version, direction, counter, nonce, ciphertext', shapes.size === 1 && [...shapes][0] === 'ct,dir,n,seq,v', [...shapes].join(' | '))
  const leaks = ['snapshot', 'fleet', 'health', 'accounts', 'event:', 'pid', 'configDir', 'claude', 'Claude', token, 'x-agent-token', 'application/json', 'demo']
  const found = leaks.filter((l) => table.includes(l))
  check('nothing anybody wrote appears anywhere in it', found.length === 0, `found: ${found.join(', ')}`)
  check('nor the pairing secret, nor anything of it', !table.includes(token.slice(0, 16)))
  check('nor the room id in any row body', !stub.rows.some((r) => JSON.stringify(r.envelope).includes(relay.status().room)))

  // --- and what it could do with write access ---
  const before = stub.rows.filter((r) => r.dir === 'm2p').length
  const stranger = sealedChannel({ secret: 'q'.repeat(48), side: 'phone' })
  await stub.db.send(relay.status().room, 'p2m', stranger.seal({ id: 'evil', method: 'POST', path: '/autopilot/halt' }))
  const req = stub.rows.findIndex((r) => r.dir === 'p2m')
  stub.replay(req)
  stub.tamper(req, { seq: 4242 })
  stub.tamper(req, { dir: 'm2p' })
  await wait(200)
  const turned = relay.status().unreadable
  check('four hostile rows arrived and not one answer went back', stub.rows.filter((r) => r.dir === 'm2p').length === before)
  check('  the stranger\'s seal would not open', turned.sealed >= 1, JSON.stringify(turned))
  check('  the replayed row was recognised as one it had already run', turned.replay >= 1, JSON.stringify(turned))
  check('  the renumbered row did not survive its own header', turned.malformed >= 1, JSON.stringify(turned))
  check('  the redirected row was refused for coming the wrong way', turned.direction >= 1, JSON.stringify(turned))
  console.log(`  what the host could not read: ${JSON.stringify(turned)}`)

  check('the host is still carrying after all that', relay.status().carrying === true)
  check('and still answering', (await phone.ask('/health')).status === 200)
} finally {
  await relay?.close().catch(() => {})
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
