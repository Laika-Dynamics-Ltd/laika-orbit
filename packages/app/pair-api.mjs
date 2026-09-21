/**
 * Pairing a phone with this Mac's agent host: the QR, and the switch that opens and shuts the
 * door it points at.
 *
 * The code carries this launch's token, so it is a grant and not a printed key — it dies when the
 * host restarts, and the panel says so where someone about to show it can read it. It is only ever
 * minted on a press (POST), never on the poll that draws the panel, so a token does not sit in a
 * response that something might log.
 *
 * The QR is rendered here rather than in the page: what crosses into the browser is an image of
 * the token, not the token as text.
 *
 *   GET  /api/pair        where things stand: is the host up, is it on the network, what address
 *   POST /api/pair/code   mint the QR — only when the host is answering the network
 *   POST /api/pair/lan    { on } — start or stop answering it, without restarting the host
 *
 * The payload is the contract with the iOS app (orbit-anywhere), agreed with it before this was
 * written:
 *
 *   orbit://pair?v=1&host=<private IPv4>&port=<port>&token=<hex>&name=<machine>
 *
 * orbit:// rather than https:// on purpose: a universal link would need the phone to fetch an
 * apple-app-site-association file over the internet to validate it, and a phone on a LAN with no
 * route out would fall through to Safari — a broken pairing that also drops the token into browser
 * history. v is always present and always "1"; the app refuses anything else, missing included.
 * `name` is not decoration: the app shows it in the confirmation a person answers before a scan is
 * saved, because iOS hands any orbit:// link to the app from anywhere, a hostile one included.
 */
import { readFileSync } from 'node:fs'
import encodeQR from '@paulmillr/qr'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { lanAddress } from './local-net.mjs'

const APP_PORT = process.env.APP_PORT ?? process.env.PORT ?? '5200'
const STATE = () => join(tmpdir(), `laika-agent-host-${APP_PORT}.json`)

/** this machine, as a person reads it on the phone before they agree to the pairing */
export const machineName = () => hostname().replace(/\.local$/i, '')

/** the agent host as its state file last described it, or null when nothing is running */
export function hostState(file = STATE()) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'))
    return s?.port && s?.token ? s : null
  } catch {
    return null
  }
}

/**
 * The one string the QR carries. Every part is encoded, so a machine called "Sam's Mac" survives
 * the trip, and the order is fixed so the same pairing always prints the same code.
 */
export function pairURI({ host, port, token, name }) {
  if (!host || !port || !token) throw new Error('a pairing needs a host, a port and a token')
  const q = [
    ['v', '1'],
    ['host', host],
    ['port', String(port)],
    ['token', token],
    ['name', name || 'Orbit'],
  ]
  // encodeURIComponent leaves an apostrophe alone; it is escaped here too, so the string is safe
  // to put in an attribute or a quoted literal on the way to being drawn
  const enc = (v) => encodeURIComponent(v).replace(/'/g, '%27')
  return `orbit://pair?${q.map(([k, v]) => `${k}=${enc(v)}`).join('&')}`
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
  return true
}

async function readJson(req) {
  const parts = []
  for await (const chunk of req) parts.push(chunk)
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')
  } catch {
    return {}
  }
}

/** ask the host itself to start or stop answering the network; it holds the socket, not this */
async function setLan(state, on) {
  const r = await fetch(`http://127.0.0.1:${state.port}/lan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': state.token },
    body: JSON.stringify({ on }),
    signal: AbortSignal.timeout(5000),
  })
  if (!r.ok) throw new Error(`the agent host answered ${r.status}`)
  return r.json()
}

export async function handlePair(url, req, res) {
  const path = url.pathname
  if (path !== '/api/pair' && !path.startsWith('/api/pair/')) return false
  const state = hostState()

  if (req.method === 'GET' && path === '/api/pair')
    return json(res, 200, {
      name: machineName(),
      host: lanAddress(),
      running: Boolean(state),
      lan: Boolean(state?.lan),
      port: state?.port ?? null,
    })

  if (req.method === 'POST' && path === '/api/pair/lan') {
    if (!state) return json(res, 503, { error: 'the agent host is not running' })
    const { on } = await readJson(req)
    try {
      const now = await setLan(state, on === true)
      return json(res, 200, { ...now, name: machineName(), running: true })
    } catch (e) {
      return json(res, 502, { error: String(e?.message ?? e) })
    }
  }

  if (req.method === 'POST' && path === '/api/pair/code') {
    if (!state) return json(res, 503, { error: 'the agent host is not running' })
    // a code for a door that is shut would pair a phone with nothing it can reach
    if (!state.lan) return json(res, 409, { error: 'the agent host is not answering the network yet' })
    const host = state.host || lanAddress()
    if (!host) return json(res, 409, { error: 'this Mac has no address on a local network' })
    const uri = pairURI({ host, port: state.port, token: state.token, name: machineName() })
    return json(res, 200, { svg: encodeQR(uri, 'svg', { ecc: 'medium', scale: 1 }), host, port: state.port, name: machineName() })
  }

  return json(res, 404, { error: 'not a pairing route' })
}
