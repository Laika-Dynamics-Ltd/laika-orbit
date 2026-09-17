import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { BASE, guardFiles, openApp, serverUp, text, widgets } from './harness.mjs'

const up = await serverUp()

describe('settings panel', { skip: !up && 'server not running on E2E_URL' }, () => {
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

  const isOpen = () => app.page.evaluate(() => document.querySelector('#settings')?.classList.contains('on') ?? false)

  it('opens from the header gear and from ⌘,', async () => {
    const { page } = app
    await page.click('#settings-btn')
    await page.waitForTimeout(600)
    assert.equal(await isOpen(), true)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    assert.equal(await isOpen(), false)
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'settings-btn', 'focus returns to the gear')
    await page.keyboard.press('Meta+Comma')
    await page.waitForTimeout(600)
    assert.equal(await isOpen(), true)
  })

  it('edits the profile, guards an unsaved close, and saves with ⌘S', async () => {
    const { page } = app
    await page.click('[data-sec=profile]')
    await page.waitForSelector('[data-p=name]')
    await page.fill('[data-p=location]', 'Testville')
    await page.click('[data-seg=clock][data-v="12h"]')
    await page.click('[data-email-in]')
    await page.keyboard.type('not-an-address')
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => document.querySelectorAll('.set-chip.bad').length), 1, 'invalid address flagged')
    await page.click('.set-chip.bad button')

    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    assert.match(await text(page, '.set-foot'), /unsaved profile changes/i)
    await page.click('[data-act=close-keep]')

    await page.keyboard.press('Meta+s')
    await page.waitForFunction(() => /Saved/.test(document.querySelector('.set-state')?.textContent ?? ''), null, { timeout: 8000 })
    const profile = (await (await fetch(`${BASE}/api/settings`)).json()).profile
    assert.equal(profile.location, 'Testville')
    assert.equal(profile.clock, '12h')
    const cal = (await widgets()).find((w) => w.id === 'calendar')
    assert.equal(cal.config.clock, '12h', 'the calendar picks up the profile')
  })

  it('shows every connection card with a status', async () => {
    const { page } = app
    await page.click('[data-sec=connections]')
    await page.waitForSelector('.set-card')
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll('.set-card')].map((c) => [c.querySelector('.set-card-t b')?.textContent, c.querySelector('.set-pill')?.textContent?.trim()]),
    )
    assert.deepEqual(cards.map((c) => c[0]), ['Gmail', 'Google Calendar', 'Brain index', 'Claude Code'])
    for (const [, status] of cards) assert.ok(status, 'has a status pill')
  })

  it('arms Disconnect on the first click and Escape disarms it (never confirmed)', async (t) => {
    const { page } = app
    if (!(await page.$('[data-act=gmail-disconnect]'))) return t.skip('Gmail not connected')
    await page.click('[data-act=gmail-disconnect]')
    await page.waitForTimeout(120)
    assert.match(await text(page, '[data-act=gmail-disconnect]'), /revoke/i)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(120)
    assert.equal(await text(page, '[data-act=gmail-disconnect]'), 'Disconnect')
    assert.equal(await isOpen(), true, 'first Escape only disarms')
    assert.equal((await (await fetch(`${BASE}/api/gmail/status`)).json()).status, 'live')
  })

  it('lists where data lives, with git status', async () => {
    const { page } = app
    await page.click('[data-sec=privacy]')
    await page.waitForSelector('.set-store')
    const rows = await page.evaluate(() => document.querySelectorAll('.set-store').length)
    assert.ok(rows >= 6)
    assert.match(await text(page, '.set-store:nth-of-type(3)'), /profile\.local\.json.*Not committed/)
  })

  it('raised no page errors and was not hot-reloaded mid-run', () => {
    assert.deepEqual(app.errors, [])
    assert.equal(app.reloaded(), false, 'a dev-server reload during the run makes these results unreliable; re-run')
  })
})
