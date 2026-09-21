/**
 * A capture run for the drop zone panel — `node packages/app/test/e2e/drop-shot.mjs`.
 *
 * Deliberately not a `*.e2e.mjs` suite: it asserts nothing, it is how the panel gets photographed.
 * It brings up a hidden copy of the app on a port of its own (never the live app on 5200), a
 * second real drop zone standing in for the Orbit across the room, drops a file on the panel and
 * has the stand-in offer one back. Writes /tmp/drop-panel.png and /tmp/drop-panel-2.png.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startDrop } from '../../drop.mjs'

const freePort = () =>
  new Promise((ok) => {
    const p = createServer()
    p.listen(0, '127.0.0.1', () => {
      const { port } = p.address()
      p.close(() => ok(port))
    })
  })

const dir = mkdtempSync(join(tmpdir(), 'drop-shot-'))
const theirs = join(dir, 'theirs')
const port = await freePort()
const dropPort = await freePort()
const gifts = ['brand-guide.pdf', 'logo-marks.zip']
mkdirSync(join(dir, 'handover'), { recursive: true })
for (const [i, g] of gifts.entries()) writeFileSync(join(dir, 'handover', g), Buffer.alloc(2_400_000 - i * 900_000, 7))

// the Orbit across the room: a real drop zone, advertising itself on the real network
const them = await startDrop({ port: 0, inbox: theirs, me: { id: 'studio-mac-id', name: 'studio-mac' } })

const HERE = dirname(fileURLToPath(import.meta.url))
const server = spawn('node', [join(HERE, '../../server.mjs')], {
  env: { ...process.env, PORT: String(port), NO_HMR: '1', ORBIT_DROP_PORT: String(dropPort), ORBIT_DROP_DIR: join(dir, 'Orbit Drops'), GMAIL_FEED: '0' },
  stdio: ['ignore', 'pipe', 'inherit'],
})
server.stdout.on('data', (d) => process.stdout.write(`  [app] ${d}`))
const base = `http://127.0.0.1:${port}`
for (let i = 0; i < 90; i++) {
  try {
    if ((await fetch(`${base}/api/drop`)).ok) break
  } catch {}
  await new Promise((r) => setTimeout(r, 1000))
}

// let the two find each other over mDNS
const peers = await (async () => {
  for (let i = 0; i < 40; i++) {
    const { peers } = await (await fetch(`${base}/api/drop/peers`)).json()
    if (peers.some((p) => p.id === 'studio-mac-id')) return peers
    await new Promise((r) => setTimeout(r, 500))
  }
  return []
})()
console.log('peers the app can see:', JSON.stringify(peers.map((p) => p.name)))

const browser = await chromium.launch()
const page = await browser.newContext({ viewport: { width: 1500, height: 940 } }).then((c) => c.newPage())
page.setDefaultTimeout(60_000)
await page.goto(base, { waitUntil: 'load' })
await page.waitForFunction(() => {
  const b = document.querySelector('.boot')
  return !b || b.classList.contains('gone') || getComputedStyle(b).display === 'none'
})
await page.waitForTimeout(1200)

// the other Orbit offers this machine a folder — two files, one question; nothing is written
// until the panel says yes
const batch = { id: 'handover-1', name: 'handover', count: 2, size: 2_400_000 + 1_500_000 }
const incoming = Promise.all(
  gifts.map((g) => them.sendFile({ id: 'mine', name: 'this-mac', host: '127.0.0.1', port: dropPort }, join(dir, 'handover', g), { poll: 300, rel: `handover/${g}`, batch })),
).catch((e) => console.log('  (offer ended:', e.message, ')'))

await page.keyboard.press('Alt+Meta+KeyD')
await page.waitForSelector('#pnl-drop .dz-zone', { timeout: 15_000 })
await page.waitForTimeout(1500)

// drag three files onto the panel, the way the pointer would
await page.evaluate(() => {
  const dt = new DataTransfer()
  for (const [name, size] of [
    ['kickoff-deck.key', 840_000],
    ['budget-v4.numbers', 210_000],
    ['shot-list.md', 4_200],
  ])
    dt.items.add(new File([new Uint8Array(size)], name, { type: 'application/octet-stream' }))
  const host = document.querySelector('#pnl-drop .dz-zone')
  for (const type of ['dragenter', 'dragover', 'drop']) host.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
})
await page.waitForTimeout(900)
await page.locator('#pnl-drop').screenshot({ path: '/tmp/drop-panel.png' })
console.log('shot 1 → /tmp/drop-panel.png (a file held, a peer to send it to, an offer waiting)')

// accept what came in, and send what is held, so the second shot has both halves moving
await page.click('#pnl-drop .dz-yes')
await page.waitForTimeout(400)
await page.click('#pnl-drop .dz-peer')
await page.waitForTimeout(2200)
await page.locator('#pnl-drop').screenshot({ path: '/tmp/drop-panel-2.png' })
console.log('shot 2 → /tmp/drop-panel-2.png')
await incoming
await page.waitForTimeout(500)
console.log('state:', JSON.stringify(await (await fetch(`${base}/api/drop/state`)).json(), null, 1).slice(0, 900))

await browser.close()
server.kill()
await them.close()
