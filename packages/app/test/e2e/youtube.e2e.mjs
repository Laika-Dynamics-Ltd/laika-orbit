import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { openApp, serverUp } from './harness.mjs'

/**
 * The floating player. YouTube itself is stubbed: the suite must pass on a machine with no
 * network, and what matters here is ours — the window goes where it is put and remembers it,
 * the mini bar keeps the embed alive, and closing takes the embed away so the audio stops.
 */
const up = await serverUp()

/** the window's box, as the page has it */
const box = (page) =>
  page.evaluate(() => {
    const r = document.querySelector('#ytp').getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  })

describe('floating player', { skip: !up && 'server not running on E2E_URL' }, () => {
  let app
  before(async () => {
    app = await openApp()
    // never reach Google from a test: the embed and the search page are both stubs
    await app.page.route(/youtube-nocookie\.com|youtube\.com/, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>stub</title>' }),
    )
  })
  after(async () => {
    await app?.close()
  })

  // The rail button, not the `m` key: like every other single-key shortcut in this app, `m`
  // is off while the Claude dock has the keyboard — and the first run opens that dock.
  it('opens and closes from the workbench rail', async () => {
    const { page } = app
    await page.click('[data-nav="music"]')
    await page.waitForSelector('#ytp:not([hidden])')
    assert.equal(await page.isVisible('[data-nav="music"].on'), true, 'the rail button lights up')
    await page.click('[data-nav="music"]')
    await page.waitForSelector('#ytp[hidden]', { state: 'attached' })
    await page.click('[data-nav="music"]')
    await page.waitForSelector('#ytp:not([hidden])')
  })

  it('drags anywhere by its title bar, and remembers where', async () => {
    const { page } = app
    const from = await box(page)
    await page.mouse.move(from.x + 60, from.y + 15)
    await page.mouse.down()
    await page.mouse.move(600, 420, { steps: 12 })
    await page.mouse.up()
    const to = await box(page)
    assert.equal(to.x, 600 - 60, 'the window follows the grab point')
    assert.equal(to.y, 420 - 15)
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('orbit:yt')))
    assert.equal(saved.x, to.x, 'the position is saved')
    assert.equal(saved.y, to.y)
  })

  it('snaps to the edge of the screen', async () => {
    const { page } = app
    const from = await box(page)
    await page.mouse.move(from.x + 60, from.y + 15)
    await page.mouse.down()
    await page.mouse.move(64, 400, { steps: 8 })
    await page.mouse.up()
    assert.equal((await box(page)).x, 12, 'it lands on the 12px margin rather than near it')
  })

  it('plays a pasted link', async () => {
    const { page } = app
    await page.fill('#ytp .yt-in', 'https://youtu.be/dQw4w9WgXcQ?t=30')
    await page.press('#ytp .yt-in', 'Enter')
    await page.waitForSelector('#ytp .yt-frame')
    const src = await page.getAttribute('#ytp .yt-frame', 'src')
    assert.ok(src.startsWith('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?'), src)
    assert.ok(src.includes('start=30'), 'the link\'s start time is kept')
    assert.ok(src.includes('enablejsapi=1'), 'the player can be driven from the app')
  })

  it('shrinks to a mini bar without dropping the embed', async () => {
    const { page } = app
    const full = await box(page)
    await page.click('#ytp .yt-mini')
    const mini = await box(page)
    assert.ok(mini.h < full.h / 3, `mini is a bar: ${mini.h} vs ${full.h}`)
    assert.equal(await page.isVisible('#ytp .yt-play'), true, 'play/pause is still reachable')
    assert.equal(
      await page.evaluate(() => !!document.querySelector('#ytp .yt-frame')?.isConnected),
      true,
      'the embed is only clipped, so the audio keeps going',
    )
    await page.click('#ytp .yt-mini')
    assert.equal((await box(page)).h, full.h, 'and back')
  })

  it('keeps its typing to itself', async () => {
    const { page } = app
    await page.click('#ytp .yt-in')
    await page.keyboard.type('bch')
    assert.equal(await page.inputValue('#ytp .yt-in'), 'bch')
    assert.equal(await page.isVisible('#pnl-history'), false, 'h did not open History')
    assert.equal(await page.isVisible('#pnl-control'), false, 'c did not open agent control')
    await page.fill('#ytp .yt-in', '')
  })

  it('sends a search to the web view, not the embed', async () => {
    const { page } = app
    const popup = page.context().waitForEvent('page', { timeout: 15_000 })
    await page.fill('#ytp .yt-in', 'lofi beats')
    await page.press('#ytp .yt-in', 'Enter')
    const opened = await popup
    assert.ok(
      opened.url().includes('results?search_query=lofi'),
      `searched on youtube.com: ${opened.url()}`,
    )
    await opened.close()
    await page.fill('#ytp .yt-in', '')
  })

  it('closing takes the embed away, so nothing plays on', async () => {
    const { page } = app
    await page.click('#ytp .yt-x')
    await page.waitForSelector('#ytp[hidden]', { state: 'attached' })
    assert.equal(await page.evaluate(() => !document.querySelector('#ytp .yt-frame')), true)
  })

  it('raised no page errors and was not hot-reloaded mid-run', () => {
    assert.deepEqual(app.errors, [])
    assert.equal(app.reloaded(), false)
  })
})
