import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { guardFiles, openApp, serverUp, steady, widgets } from './harness.mjs'

const up = await serverUp()

describe('widgets', { skip: !up && 'server not running on E2E_URL' }, () => {
  let app
  let restore
  before(async () => {
    restore = await guardFiles()
    app = await openApp()
  })
  after(async () => {
    await app?.close()
    await restore?.()
  })

  const byId = async (id) => (await widgets()).find((w) => w.id === id)
  const height = (id) => app.page.evaluate((i) => Math.round(document.querySelector(`[data-id=${i}]`).getBoundingClientRect().height), id)
  const order = (rail) => app.page.evaluate((r) => [...document.querySelectorAll(`#rail-${r} > .widget`)].map((w) => w.dataset.id), rail)

  it('every widget has a fold button, a gear and a resize handle', async () => {
    const counts = await app.page.evaluate(() => {
      const ws = [...document.querySelectorAll('.widget')]
      return [ws.length, ws.filter((w) => w.querySelector('.w-fold') && w.querySelector('.w-gear') && w.querySelector('.w-rsz')).length]
    })
    assert.ok(counts[0] > 0)
    assert.equal(counts[1], counts[0])
  })

  it('collapses to a compact card, persists, and expands back', async () => {
    const { page } = app
    await page.click('[data-id=calendar] .w-fold')
    await page.waitForTimeout(500)
    assert.equal(await page.evaluate(() => document.querySelector('[data-id=calendar]').classList.contains('collapsed')), true)
    assert.ok((await page.evaluate(() => document.querySelector('[data-id=calendar] .w-compact').offsetHeight)) > 20, 'compact card shows')
    assert.equal((await byId('calendar')).collapsed, true)
    await page.click('[data-id=calendar] .w-fold')
    await page.waitForTimeout(500)
    assert.equal((await byId('calendar')).collapsed, undefined)
  })

  it('resizes with the keyboard in 16px steps and saves the height', async () => {
    const { page } = app
    await steady(() => page.locator('[data-id=email] .w-rsz').scrollIntoViewIfNeeded())
    const h0 = await height('email')
    await page.focus('[data-id=email] .w-rsz')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await page.waitForTimeout(400)
    assert.equal(await height('email'), h0 - 32)
    assert.equal((await byId('email')).height, h0 - 32)
    await page.keyboard.press('Home') // back to fit content
    await page.waitForTimeout(400)
    assert.equal((await byId('email')).height, undefined)
  })

  it('drags a widget into the other column and the server agrees', async () => {
    const { page } = app
    const target = (await order('r'))[0]
    assert.ok(target, 'right rail has a widget')
    const [t, d] = await steady(async () => {
      await page.locator('[data-id=calendar]').scrollIntoViewIfNeeded()
      return [await page.locator('[data-id=calendar] .w-title').boundingBox(), await page.locator(`[data-id=${target}]`).boundingBox()]
    })
    const from = { x: t.x + t.width + 24, y: t.y + t.height / 2 }
    const to = { x: d.x + d.width / 2, y: d.y + d.height - 8 }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    for (let i = 1; i <= 24; i++) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / 24, from.y + ((to.y - from.y) * i) / 24)
      await page.waitForTimeout(12)
    }
    assert.ok(await page.$('.w-ghost'), 'ghost lifted')
    assert.equal(await page.evaluate(() => document.querySelector('.w-socket')?.parentElement?.id), 'rail-r')
    await page.mouse.up()
    await page.waitForFunction(() => !document.querySelector('.w-ghost, .w-socket'), null, { timeout: 5000 })
    await page.waitForTimeout(300) // the save is fired on landing
    assert.ok((await order('r')).includes('calendar'))
    assert.equal((await byId('calendar')).rail, 'right')
  })

  it('the gear opens that widget’s settings and Escape closes it', async () => {
    const { page } = app
    await page.click('[data-id=email] .w-gear')
    await page.waitForTimeout(250)
    assert.equal(await page.evaluate(() => document.querySelector('#ws')?.dataset.id), 'email')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    assert.equal(await page.$('#ws'), null)
  })

  it('raised no page errors and was not hot-reloaded mid-run', () => {
    assert.deepEqual(app.errors, [])
    assert.equal(app.reloaded(), false, 'a dev-server reload during the run makes these results unreliable; re-run')
  })
})
