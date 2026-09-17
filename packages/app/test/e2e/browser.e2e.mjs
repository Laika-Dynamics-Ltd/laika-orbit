import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { openApp, serverUp, text } from './harness.mjs'

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
