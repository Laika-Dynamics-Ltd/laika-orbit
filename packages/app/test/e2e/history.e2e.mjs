import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { BASE, openApp, serverUp } from './harness.mjs'

const up = await serverUp()

describe('history', { skip: !up && 'server not running on E2E_URL' }, () => {
  it('serves moments of all three kinds, on a window it says it covers', async () => {
    const r = await (await fetch(`${BASE}/api/control/moments?hours=12`)).json()
    assert.equal(r.hours, 12)
    assert.ok(Math.abs(r.to - r.from - 12 * 3600e3) < 60e3, 'the window is twelve hours')
    assert.equal(r.buckets.length, 96)
    for (const m of r.moments) {
      assert.ok(['work', 'commit', 'note'].includes(m.kind), `known kind: ${m.kind}`)
      assert.ok(m.t0 <= m.t1 && m.t >= r.from - 60e3, 'sits inside the window')
    }
    // an unknown window falls back rather than scanning further than sessions reach
    assert.equal((await (await fetch(`${BASE}/api/control/moments?hours=9999`)).json()).hours, 24)
  })

  it('counts a commit once, however many worktrees share it', async () => {
    const r = await (await fetch(`${BASE}/api/control/moments?hours=48`)).json()
    const hashes = r.moments.filter((m) => m.kind === 'commit').flatMap((m) => m.commits.map((c) => c.hash))
    assert.equal(new Set(hashes).size, hashes.length)
  })

  let app
  before(async () => {
    app = await openApp()
  })
  after(async () => {
    await app?.close()
  })

  it('opens from the rail, narrows to a project, and esc steps back out', async () => {
    const { page } = app
    await page.click('#wbn [data-pnl="history"]')
    await page.waitForSelector('#pnl-history .hist.on')
    await page.waitForFunction(() => document.querySelector('#pnl-history .hist')?.dataset.cards !== undefined, null, {
      timeout: 120_000,
    })
    const all = await page.evaluate(() => ({
      projects: document.querySelectorAll('.h-proj').length,
      canvas: document.querySelector('#pnl-history canvas')?.width ?? 0,
    }))
    assert.ok(all.canvas > 0, 'the stage has a size')

    if (all.projects > 1) {
      const name = await page.getAttribute('.h-proj:nth-child(2)', 'data-project')
      await page.click('.h-proj:nth-child(2)')
      await page.waitForFunction((p) => document.querySelector('.h-proj.on')?.dataset.project === p, name, {
        timeout: 60_000,
      })
      const r = await (await fetch(`${BASE}/api/control/moments?hours=24&project=${encodeURIComponent(name)}`)).json()
      assert.ok(r.moments.every((m) => m.project === name), 'only that project')
    }

    // focus is on the project chip, inside the panel: Escape closes the panel from there
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('#pnl-history .hist')?.classList.contains('on'))
  })

  it('the network names a node under the pointer, and a click opens its detail', async (t) => {
    const { page } = app
    const r = await (await fetch(`${BASE}/api/control/moments?hours=24`)).json()
    if (!r.moments.length) return t.skip('nothing happened in the last day')
    await page.click('#wbn [data-pnl="history"]')
    await page.waitForSelector('#pnl-history .hist.on')
    await page.waitForFunction(() => document.querySelector('#pnl-history .hist')?.dataset.cards !== undefined)
    await page.waitForTimeout(800)
    // sweep a spiral out from NOW until the pointer lands on a node
    const box = await page.locator('#pnl-history [data-el="stage"]').boundingBox()
    let tip = null
    for (let k = 0; k < 500 && !tip; k++) {
      const a = k * 2.399
      const rad = 50 + (k % 45) * 8
      await page.mouse.move(box.x + box.width / 2 + Math.sin(a) * rad, box.y + box.height / 2 - Math.cos(a) * rad)
      tip = await page.evaluate(() => {
        const el = document.querySelector('#pnl-history .hm-tip')
        return el && !el.hidden ? el.querySelector('b')?.textContent : null
      })
    }
    assert.ok(tip, 'some node answered to the pointer')
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForSelector('#pnl-history [data-el="detail"]:not([hidden])')
    assert.equal(await page.textContent('#pnl-history [data-el="detail"] h3'), tip, 'the detail is the node that was named')
    // the first Escape steps back out of the card and leaves History open; the second closes it
    await page.keyboard.press('Escape')
    await page.waitForSelector('#pnl-history [data-el="detail"][hidden]', { state: 'attached' })
    assert.ok(await page.evaluate(() => document.querySelector('#pnl-history .hist').classList.contains('on')))
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('#pnl-history .hist')?.classList.contains('on'))
  })

  it('the rail lights what is open, puts History and agent control side by side, and stays reachable', async () => {
    const { page } = app
    const lit = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('#wbn [data-nav].on, #wbn [data-pnl].on')].map(
          (b) => b.getAttribute('data-nav') ?? b.getAttribute('data-pnl'),
        ),
      )
    const history = '#wbn [data-pnl="history"]'
    const control = '#wbn [data-pnl="control"]'

    await page.click(history)
    await page.waitForSelector('#pnl-history .hist.on')
    assert.ok((await lit()).includes('history'))
    // History is a panel in the dock: beside the rail and the map, never over the rail
    const hist = await page.locator('#pnl-history').boundingBox()
    const rail = await page.locator('#wbn').boundingBox()
    assert.ok(hist.x >= rail.x + rail.width - 1, 'History starts beside the rail')

    // agent control opens beside History rather than replacing it, and is the top thing where it is
    await page.click(control)
    await page.waitForSelector('#pnl-control:not([hidden])')
    await page.waitForFunction(() => !document.body.classList.contains('pnl-anim'))
    assert.deepEqual((await lit()).filter((k) => k === 'history' || k === 'control').sort(), ['control', 'history'])
    const onTop = await page.evaluate(() => {
      const d = document.querySelector('#pnl-control').getBoundingClientRect()
      const at = document.elementFromPoint(d.left + d.width / 2, d.top + 60)
      return !!at?.closest('#pnl-control')
    })
    assert.ok(onTop, 'agent control is the top thing where it is drawn')
    const [c, h] = await Promise.all([page.locator('#pnl-control').boundingBox(), page.locator('#pnl-history').boundingBox()])
    assert.ok(c.x + c.width <= h.x + 1 || h.x + h.width <= c.x + 1, 'the two panels do not overlap')

    // Reel covers the page; a panel opened from the rail clears it, so nothing opens out of sight
    await page.click('#wbn [data-nav="showreel"]')
    await page.waitForSelector('#sr.on')
    await page.click(control) // closes agent control
    await page.waitForFunction(() => document.getElementById('pnl-control').hidden)
    await page.click(control) // and opening it again clears Reel
    await page.waitForSelector('#pnl-control:not([hidden])')
    assert.equal(await page.evaluate(() => !!document.querySelector('#sr')?.classList.contains('on')), false)

    // agent control toggles: once out
    await page.click(control)
    await page.waitForFunction(() => document.getElementById('pnl-control').hidden)
    assert.equal((await lit()).includes('control'), false)

    // the badge carries what the server says is waiting. Sessions change state on their own,
    // so this asks again until a reading and the badge agree, rather than racing one reading.
    let agreed = false
    let last = ''
    for (const until = Date.now() + 20_000; !agreed && Date.now() < until; ) {
      const w = await (await fetch(`${BASE}/api/control/widget`)).json()
      const n = Number(w.config?.waiting ?? 0)
      const shown = await page.evaluate(() => {
        const b = document.querySelector('#wbn [data-pnl="control"] .wbn-badge')
        return b.hidden ? '' : b.textContent
      })
      last = `server ${n}, badge "${shown}"`
      agreed = shown === (n ? (n > 9 ? '9+' : String(n)) : '')
      if (!agreed) await page.waitForTimeout(1000)
    }
    assert.ok(agreed, `the badge follows the waiting count (${last})`)
    assert.deepEqual(app.errors, [])
  })
})
