/**
 * Camera control on the graph: mouse pan, orbit, zoom to the pointer, WASD flight and reset.
 * The view's state comes from the `__camDbg` hook in main.ts. Every test starts from the
 * home view, snapped, so nothing depends on where the one before left the camera.
 *
 * Screen directions at the ARMS home view (theta 0, straight down): screen-up is world −x,
 * screen-right is world −z (the camera's up vector is the ring's far side, see loop()).
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { openApp, serverUp } from './harness.mjs'

const up = await serverUp()

describe('camera', { skip: !up && 'server not running on E2E_URL' }, () => {
  let app
  before(async () => {
    app = await openApp()
    await app.page.waitForFunction(() => globalThis.__camDbg?.state?.().frameRadius > 0)
  })
  after(async () => {
    await app?.close()
  })
  beforeEach(async () => {
    await app.page.mouse.move(5, 5)
    // the Claude dock opens on its own, and while it is open the keys are its; Escape closes it
    await app.page.evaluate(() => document.activeElement?.blur?.())
    if (await app.page.evaluate(() => document.querySelector('#ss')?.classList.contains('on'))) await app.page.keyboard.press('Escape')
    await app.page.evaluate(() => {
      globalThis.__camDbg.reset()
      globalThis.__camDbg.snap()
    })
    await app.page.waitForTimeout(120)
  })

  const state = () => app.page.evaluate(() => globalThis.__camDbg.state())
  const ringPt = () => app.page.evaluate(() => globalThis.__camDbg.ring().pts[0])
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  const settle = (ms = 900) => app.page.waitForTimeout(ms)
  /** wait for the ease to land on the home view (a stalled headless frame is not a failure) */
  const untilHome = () =>
    app.page.waitForFunction(
      () => {
        const s = globalThis.__camDbg.state()
        const d = Math.hypot(...s.cam.target.map((v, i) => v - s.centre[i]))
        return d < 1 && Math.abs(s.cam.radius - s.want.radius) < 1 && Math.abs(s.cam.theta - s.want.theta) < 0.003
      },
      null,
      { timeout: 8000 },
    )
  const stageBox = async () => {
    const b = await app.page.locator('#stage').boundingBox()
    return { ...b, cx: b.x + b.width / 2, cy: b.y + b.height / 2 }
  }
  const hold = async (key, ms, { shift = false } = {}) => {
    if (shift) await app.page.keyboard.down('Shift')
    await app.page.keyboard.down(key)
    await app.page.waitForTimeout(ms)
    await app.page.keyboard.up(key)
    if (shift) await app.page.keyboard.up('Shift')
  }

  it('opens on the home view: straight down, on the centre', async () => {
    const s = await state()
    assert.ok(Math.abs(s.cam.phi) < 0.01, `phi ${s.cam.phi}`)
    assert.ok(dist(s.cam.target, s.centre) < 1)
    assert.ok(Math.abs(s.cam.radius - s.frameRadius * 2.24) < 2)
  })

  it('a left drag pans: the map follows the pointer 1:1 and the angle does not change', async () => {
    const { page } = app
    const b = await stageBox()
    const before = await state()
    const ptBefore = await ringPt()
    await page.mouse.move(b.cx, b.cy)
    await page.mouse.down()
    await page.mouse.move(b.cx + 60, b.cy, { steps: 6 })
    await page.mouse.move(b.cx + 120, b.cy + 80, { steps: 6 })
    await page.waitForTimeout(150) // stop first, so the release carries no glide
    await page.mouse.up()
    await settle(300)
    const after = await state()
    const ptAfter = await ringPt()
    assert.ok(Math.abs(after.cam.theta - before.cam.theta) < 1e-6, 'theta unchanged')
    assert.ok(Math.abs(after.cam.phi - before.cam.phi) < 1e-6, 'phi unchanged')
    assert.ok(dist(after.cam.target, before.cam.target) > 50, 'target moved')
    // a point on the ring moved by exactly the drag vector, in stage px
    assert.ok(Math.abs(ptAfter[0] - ptBefore[0] - 120) < 3, `dx ${ptAfter[0] - ptBefore[0]}`)
    assert.ok(Math.abs(ptAfter[1] - ptBefore[1] - 80) < 3, `dy ${ptAfter[1] - ptBefore[1]}`)
  })

  it('a flick glides on after release', async () => {
    const { page } = app
    const b = await stageBox()
    // dispatched inside the page: Playwright's own per-event latency in headless (~90ms) is
    // slower than any human release, so the flick window would never be met from outside
    const atRelease = await page.evaluate(
      async ([cx, cy]) => {
        const stage = document.querySelector('#stage')
        const ev = (type, x, y, extra = {}) =>
          stage.dispatchEvent(
            new PointerEvent(type, { clientX: x, clientY: y, pointerId: 7, button: 0, buttons: 1, bubbles: true, ...extra }),
          )
        const tick = (ms) => new Promise((r) => setTimeout(r, ms))
        ev('pointerdown', cx, cy)
        for (let i = 1; i <= 8; i++) {
          await tick(12)
          ev('pointermove', cx - i * 30, cy)
        }
        await tick(12)
        ev('pointerup', cx - 240, cy, { buttons: 0 })
        return globalThis.__camDbg.state()
      },
      [b.cx, b.cy],
    )
    assert.equal(atRelease.dragging, false)
    await settle(600)
    const later = await state()
    assert.ok(dist(later.cam.target, atRelease.cam.target) > 10, 'kept moving after release')
    assert.ok(later.cam.target[2] < atRelease.cam.target[2], 'in the direction of the flick')
  })

  it('alt-drag and the right button orbit; ARMS never tilts past the disc', async () => {
    const { page } = app
    const b = await stageBox()
    const before = await state()
    await page.keyboard.down('Alt')
    await page.mouse.move(b.cx, b.cy)
    await page.mouse.down()
    await page.mouse.move(b.cx + 100, b.cy - 400, { steps: 8 })
    await page.waitForTimeout(150)
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await settle(300)
    const mid = await state()
    assert.ok(Math.abs(mid.cam.theta - before.cam.theta) > 0.3, 'theta changed')
    assert.ok(mid.cam.phi > 0.5, `tilted: phi ${mid.cam.phi}`)
    assert.ok(mid.cam.phi <= 1.25 + 1e-6, `capped for the flat disc: phi ${mid.cam.phi}`)
    assert.ok(dist(mid.cam.target, before.cam.target) < 2, 'target unchanged')

    // from empty space (a node under the right button opens the ring menu instead)
    await page.mouse.move(b.x + b.width - 80, b.y + 80)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(b.x + b.width - 180, b.y + 80, { steps: 8 })
    await page.waitForTimeout(150)
    await page.mouse.up({ button: 'right' })
    await settle(300)
    const after = await state()
    assert.ok(Math.abs(after.cam.theta - mid.cam.theta) > 0.3, 'right button orbited')
  })

  it('the wheel zooms toward the pointer, and zooming out drifts home', async () => {
    const { page } = app
    const b = await stageBox()
    const before = await state()
    const px = b.cx + 200
    const py = b.cy + 120
    await page.mouse.move(px, py)
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, -100)
      await page.waitForTimeout(40)
    }
    await settle()
    const zoomed = await state()
    assert.ok(zoomed.cam.radius < before.cam.radius * 0.7, `zoomed in: ${zoomed.cam.radius}`)
    // the target moved toward the pointer: right on screen is −z, down on screen is +x
    assert.ok(zoomed.cam.target[2] < before.cam.target[2] - 30, 'toward the pointer, right')
    assert.ok(zoomed.cam.target[0] > before.cam.target[0] + 20, 'toward the pointer, down')
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 100)
      await page.waitForTimeout(40)
    }
    await untilHome()
    const out = await state()
    assert.ok(out.cam.radius > zoomed.cam.radius * 2, 'zoomed out')
    assert.ok(dist(out.cam.target, out.centre) < 1, `back home: ${dist(out.cam.target, out.centre)}`)
  })

  it('WASD flies, shift is faster, Q/E orbit, and 0 resets', async () => {
    const { page } = app
    const home = await state()
    await hold('d', 400)
    await settle(400)
    const d = await state()
    const right = home.cam.target[2] - d.cam.target[2]
    assert.ok(right > 100, `D moved right (−z): ${right}`)
    assert.ok(Math.abs(d.cam.target[0] - home.cam.target[0]) < 2, 'no drift along the other axis')

    await hold('w', 400)
    await settle(400)
    const w = await state()
    assert.ok(d.cam.target[0] - w.cam.target[0] > 100, 'W moved up the screen (−x)')

    await hold('a', 400, { shift: true })
    await settle(400)
    const a = await state()
    const fast = a.cam.target[2] - w.cam.target[2]
    assert.ok(fast > right * 1.6, `shift is faster: ${fast} vs ${right}`)

    await hold('e', 300)
    await settle(400)
    const e = await state()
    assert.ok(Math.abs(e.cam.theta - home.cam.theta) > 0.2, 'E orbited')
    assert.equal(e.held.length, 0, 'nothing left held')

    await page.keyboard.press('0')
    await untilHome()
    const back = await state()
    assert.ok(dist(back.cam.target, home.cam.target) < 2, 'target home')
    assert.ok(Math.abs(back.cam.theta - home.cam.theta) < 0.005, 'angle home')
    assert.ok(Math.abs(back.cam.radius - home.cam.radius) < 2, 'radius home')
  })

  it('holding S flies backward; tapping S still opens the sessions view', async () => {
    const { page } = app
    const before = await state()
    const sessionsOpen = () => page.evaluate(() => document.querySelector('#ss')?.classList.contains('on') ?? false)
    await hold('s', 500)
    await settle(400)
    const after = await state()
    assert.ok(after.cam.target[0] - before.cam.target[0] > 60, 'S moved down the screen (+x)')
    assert.equal(await sessionsOpen(), false, 'a hold did not open sessions')
    await page.keyboard.press('s')
    await page.waitForTimeout(400)
    assert.equal(await sessionsOpen(), true, 'a tap opened sessions')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    assert.equal(await sessionsOpen(), false)
  })

  it('double-clicking empty space resets, and the ⌂ button does too', async () => {
    const { page } = app
    const b = await stageBox()
    await hold('d', 300)
    await settle(300)
    let s = await state()
    assert.ok(dist(s.cam.target, s.centre) > 50)
    // the top-right corner of the stage is empty in every layout
    await page.mouse.dblclick(b.x + b.width - 30, b.y + 30)
    await untilHome()
    s = await state()
    assert.ok(dist(s.cam.target, s.centre) < 2, `double-click went home: ${dist(s.cam.target, s.centre)}`)
    await hold('a', 300)
    await settle(300)
    await page.click('#tool-home')
    await untilHome()
    s = await state()
    assert.ok(dist(s.cam.target, s.centre) < 2, `⌂ went home: ${dist(s.cam.target, s.centre)}`)
    // a NO_HMR instance still logs the Vite client's failed live-reload socket; not ours
    assert.deepEqual(
      app.errors.filter((m) => !/vite|WebSocket/i.test(m)),
      [],
    )
  })
})
