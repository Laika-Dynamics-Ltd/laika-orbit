/**
 * A capture run for the pairing panel — `node packages/app/test/e2e/pair-shot.mjs`.
 *
 * Asserts nothing; it is how the panel gets photographed. A hidden copy of the app on its own port
 * (never the live app on 5200/5300), and a stand-in agent host rather than the real one: the real
 * one restores live Claude sessions and can stop processes belonging to the fleet on this Mac, so
 * it is not something a screenshot may start. The stand-in speaks the two things pairing needs —
 * POST /lan and a state file — with a token minted here and thrown away when this exits, so the
 * code in the picture opens nothing.
 *
 * Writes /tmp/pair-off.png and /tmp/pair-on.png.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as net } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { lanAddress, rebind } from '../../local-net.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const freePort = () =>
  new Promise((ok) => {
    const p = net()
    p.listen(0, '127.0.0.1', () => {
      const { port } = p.address()
      p.close(() => ok(port))
    })
  })

const APP_PORT = await freePort()
const TOKEN = randomBytes(24).toString('hex')
const STATE = join(tmpdir(), `laika-agent-host-${APP_PORT}.json`)

// the stand-in agent host: loopback to begin with, and able to move on and off the network the
// same way the real one does
let bind = '127.0.0.1'
const host = createServer(async (req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.headers['x-agent-token'] !== TOKEN) return json(401, { error: 'unauthorised' })
  if (req.url === '/lan' && req.method === 'POST') {
    const body = await new Promise((ok) => {
      let s = ''
      req.on('data', (d) => {
        s += d
      })
      req.on('end', () => ok(JSON.parse(s || '{}')))
    })
    const want = body.on === true ? '0.0.0.0' : '127.0.0.1'
    const port = host.address().port
    json(200, { lan: want !== '127.0.0.1', port, host: want !== '127.0.0.1' ? lanAddress() : null })
    setImmediate(async () => {
      bind = want
      await rebind(host, { port, bind }).catch(() => {})
      writeState()
      console.log(`  [stand-in host] now on ${bind}:${port}`)
    })
    return
  }
  json(200, { ok: true })
})
const writeState = () => writeFileSync(STATE, JSON.stringify({ port: host.address().port, token: TOKEN, pid: process.pid, lan: bind !== '127.0.0.1', host: bind !== '127.0.0.1' ? lanAddress() : null }), { mode: 0o600 })
await new Promise((ok) => host.listen(0, bind, ok))
writeState()

const server = spawn('node', [join(HERE, '../../server.mjs')], {
  env: { ...process.env, PORT: String(APP_PORT), APP_PORT: String(APP_PORT), NO_HMR: '1', GMAIL_FEED: '0', ORBIT_DROP: '0' },
  // 'ignore', not 'pipe': a piped stdout nobody reads fills and stops the server dead
  stdio: ['ignore', 'ignore', 'inherit'],
})
const base = `http://127.0.0.1:${APP_PORT}`
for (let i = 0; i < 90; i++) {
  try {
    if ((await fetch(`${base}/api/pair`)).ok) break
  } catch {}
  await new Promise((r) => setTimeout(r, 1000))
}
console.log('pairing sees:', JSON.stringify(await (await fetch(`${base}/api/pair`)).json()))

const browser = await chromium.launch()
const page = await browser.newContext({ viewport: { width: 1500, height: 940 } }).then((c) => c.newPage())
page.setDefaultTimeout(60_000)
await page.goto(base, { waitUntil: 'load' })
await page.waitForFunction(() => {
  const b = document.querySelector('.boot')
  return !b || b.classList.contains('gone') || getComputedStyle(b).display === 'none'
})
await page.waitForTimeout(1200)

await page.click('[aria-label="Pair a phone"]')
await page.waitForSelector('#pnl-pair .pr-state')
await page.waitForTimeout(700)
await page.locator('#pnl-pair').screenshot({ path: '/tmp/pair-off.png' })
console.log('shot 1 → /tmp/pair-off.png (loopback only: the offer to turn it on, no code)')

await page.click('#pnl-pair [data-act=on]')
await page.waitForSelector('#pnl-pair [data-act=code]')
await page.click('#pnl-pair [data-act=code]')
await page.waitForSelector('#pnl-pair .pr-qr svg')
await page.waitForTimeout(500)
await page.locator('#pnl-pair').screenshot({ path: '/tmp/pair-on.png' })
console.log('shot 2 → /tmp/pair-on.png (on the network: the code, what it hands over, and how to stop)')

await browser.close()
server.kill()
await new Promise((ok) => host.close(ok))
try {
  unlinkSync(STATE)
} catch {}
