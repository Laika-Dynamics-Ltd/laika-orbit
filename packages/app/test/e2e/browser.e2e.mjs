import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { openApp, serverUp, text } from './harness.mjs'
import { shellStub } from './shell-stub.mjs'

const up = await serverUp()

/**
 * The browser dock in a plain browser (no desktop shell): it opens, explains itself, and its
 * keys stay out of the map. The shell itself is exercised by its own self-test
 * (LAIKA_SHELL_SMOKE, see packages/shell/main.mjs), which needs a display.
 */
describe('browser dock', { skip: !up && 'server not running on E2E_URL' }, () => {
  it('opens with b, explains the shell, closes with its button', async () => {
    const { page, errors, reloaded, close } = await openApp()
    try {
      await page.keyboard.press('b')
      await page.waitForSelector('#wb.on')
      assert.match(await text(page, '#wb .wb-noshell'), /pnpm shell/)
      assert.match(await text(page, '#wb .wb-noshell'), /one profile per account/i)
      // the header button reflects the state, and closes it
      assert.ok(await page.$('#wb-btn.on'))
      await page.click('#wb [data-act="close"]')
      await page.waitForSelector('#wb:not(.on)', { state: 'attached' })
      assert.equal(await page.$('#wb-btn.on'), null)
      // single-key shortcuts do not fire from inside the dock
      await page.click('#wb-btn')
      await page.waitForSelector('#wb.on')
      await page.focus('#wb [data-el="url"]')
      await page.keyboard.press('b')
      assert.ok(await page.$('#wb.on'), 'typing b in the omnibox must not close the dock')
      assert.ok(!reloaded(), 'a hot reload interrupted this test')
      // a NO_HMR instance still logs the Vite client's failed live-reload socket; not ours
      assert.deepEqual(
        errors.filter((m) => !/vite|WebSocket/i.test(m)),
        [],
      )
    } finally {
      await close()
    }
  })

  // regression: the strip was rebuilt on every state push, so a click whose press and release
  // straddled one (a page loading, a download running) was lost
  it('takes tab clicks while state keeps arriving', async () => {
    const { page, close } = await openApp({ init: shellStub })
    try {
      await page.click('#wbn [data-nav="browser"]')
      await page.waitForSelector('#wb.on')
      await page.evaluate(async () => {
        for (const u of ['https://a.example/', 'https://b.example/', 'https://c.example/']) await window.laikaShell.tab('open', { url: u })
      })
      await page.waitForFunction(() => document.querySelectorAll('#wb .wb-tab').length === 3)
      await page.evaluate(() => {
        window.__busy = setInterval(() => window.__stub.push(), 33)
      })
      for (const i of [0, 1, 0, 1, 0, 1]) {
        const r = await page.evaluate((i) => {
          const b = document.querySelectorAll('#wb .wb-tab')[i].getBoundingClientRect()
          return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
        }, i)
        await page.mouse.move(r.x, r.y)
        await page.mouse.down()
        await page.waitForTimeout(90)
        await page.mouse.up()
        await page.waitForTimeout(120)
        const [active, want] = await page.evaluate((i) => [window.__stub.st.active, window.__stub.st.tabs[i].id], i)
        assert.equal(active, want, `the click on tab ${i} was lost`)
      }
      await page.evaluate(() => clearInterval(window.__busy))
    } finally {
      await close()
    }
  })

  // regression: a crashed page left a dead, blank view over the dock with no way back but the
  // toolbar; now its own tab shows what happened and a reload
  it('shows a crashed page as a card with a reload in its tab', async () => {
    const { page, close } = await openApp({ init: shellStub })
    try {
      await page.click('#wbn [data-nav="browser"]')
      await page.waitForSelector('#wb.on')
      await page.evaluate(async () => {
        await window.laikaShell.tab('open', { url: 'https://a.example/' })
        await window.laikaShell.tab('open', { url: 'https://b.example/' })
        window.__stub.st.tabs[1].gone = 'crashed'
        window.__stub.push()
      })
      await page.waitForSelector('#wb .wb-down')
      assert.match(await text(page, '#wb .wb-down'), /b\.example crashed/)
      assert.ok(await page.$('#wb .wb-tab.on.down'), 'the strip marks the crashed tab')
      assert.equal(await page.$('#wb .wb-tab:not(.on).down'), null, 'and only that one')
      await page.click('#wb .wb-down [data-act="revive"]')
      assert.deepEqual(await page.evaluate(() => window.__stub.calls.at(-1)), ['reload', '2'])
    } finally {
      await close()
    }
  })

  it('is listed in spotlight', async () => {
    const { page, close } = await openApp()
    try {
      await page.keyboard.press('Meta+k')
      await page.waitForSelector('#sp.on')
      await page.keyboard.type('browser')
      // the command row, not the "Ask the brain: browser" row
      const row = page.locator('#sp .sp-row', { hasText: /Browser/ }).first()
      await row.waitFor()
      await row.click()
      await page.waitForSelector('#wb.on')
    } finally {
      await close()
    }
  })
})
