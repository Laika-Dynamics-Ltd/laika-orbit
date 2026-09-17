import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BASE, openApp, serverUp } from './harness.mjs'

const up = await serverUp()

describe('app version', { skip: !up && 'server not running on E2E_URL' }, () => {
  it('is read from git and goes up with the commit count', async () => {
    const v = await (await fetch(`${BASE}/api/version`)).json()
    assert.match(v.label, /^v0\.\d+\+? · [0-9a-f]{7,}$/)
    assert.ok(v.build > 0)
    assert.equal(v.version, `0.${v.build}`)
  })

  it('shows in the shell, bottom-left of the stage', async () => {
    const { page, errors, close } = await openApp()
    try {
      const ver = page.locator('#ver')
      await ver.waitFor({ state: 'visible', timeout: 30_000 })
      assert.match(await ver.textContent(), /^v0\.\d+/)
      const box = await ver.boundingBox()
      const stage = await page.locator('#stage').boundingBox()
      const vp = page.viewportSize()
      assert.ok(box.x - stage.x < 40, 'sits at the left edge of the stage')
      assert.ok(vp.height - (box.y + box.height) < 40, 'sits at the bottom of the shell')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
