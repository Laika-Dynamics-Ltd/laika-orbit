import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { BASE, openApp, serverUp } from './harness.mjs'

const up = await serverUp()

describe('mission control', { skip: !up && 'server not running on E2E_URL' }, () => {
  it('reports whether the panel is up, and what waits on a verdict when it is', async () => {
    const s = await (await fetch(`${BASE}/api/mission`)).json()
    assert.equal(typeof s.url, 'string')
    assert.equal(typeof s.up, 'boolean')
    if (s.up) assert.ok(Number.isInteger(s.waiting) && s.waiting >= 0, 'a count, not a guess')
    else assert.equal(typeof s.error, 'string', 'down says why')
  })

  let app
  before(async () => {
    app = await openApp()
  })
  after(async () => {
    await app?.close()
  })

  it('opens from its rail button beside the rail, frames the panel or says it is down, and closes', async () => {
    const { page } = app
    const lit = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('#wbn [data-nav].on')].map((b) => b.getAttribute('data-nav')),
      )
    const mission = '#wbn [data-nav="mission"]'
    const s = await (await fetch(`${BASE}/api/mission`)).json()

    await page.click(mission)
    await page.waitForSelector('#mc.on')
    assert.ok((await lit()).includes('mission'))
    const win = await page.locator('#mc').boundingBox()
    const rail = await page.locator('#wbn').boundingBox()
    assert.ok(win.x >= rail.x + rail.width - 1, 'the window starts beside the rail')

    if (s.up) {
      await page.waitForSelector('#mc iframe.mc-frame')
      assert.equal(await page.getAttribute('#mc iframe.mc-frame', 'src'), `${s.url}/`)
    } else {
      await page.waitForSelector('#mc .mc-down')
      assert.ok((await page.textContent('#mc .mc-down')).includes(s.url))
    }

    // a view like the others: History clears it, and it clears agent control
    await page.click('#wbn [data-nav="history"]')
    await page.waitForSelector('#hist.on')
    assert.equal(await page.evaluate(() => document.querySelector('#mc').classList.contains('on')), false)
    await page.click('#wbn [data-nav="control"]')
    await page.waitForSelector('#ctl-drawer.on')
    await page.click(mission)
    await page.waitForSelector('#mc.on')
    assert.equal(await page.evaluate(() => document.querySelector('#ctl-drawer').classList.contains('on')), false)
    assert.deepEqual((await lit()).filter((k) => ['history', 'control', 'showreel', 'mission'].includes(k)), ['mission'])

    // reopening keeps the same frame, so the panel's own place survives
    await page.click(mission)
    await page.waitForFunction(() => !document.querySelector('#mc').classList.contains('on'))
    await page.click(mission)
    await page.waitForSelector('#mc.on')
    assert.ok((await page.locator('#mc iframe').count()) <= 1)

    // esc from 1brain's side closes it
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('#mc').classList.contains('on'))

    // the badge carries the panel's waiting count, and nothing while it is down
    let agreed = false
    let last = ''
    for (const until = Date.now() + 40_000; !agreed && Date.now() < until; ) {
      const now = await (await fetch(`${BASE}/api/mission`)).json()
      const want = now.up && now.waiting ? (now.waiting > 9 ? '9+' : String(now.waiting)) : ''
      const shown = await page.evaluate(() => {
        const b = document.querySelector('#wbn [data-nav="mission"] .wbn-badge')
        return b.hidden ? '' : b.textContent
      })
      last = `server ${JSON.stringify({ up: now.up, waiting: now.waiting })}, badge "${shown}"`
      agreed = shown === want
      if (!agreed) await page.waitForTimeout(1000)
    }
    assert.ok(agreed, last)
    assert.deepEqual(app.errors, [])
  })
})

/**
 * The Build view: a Claude workspace whose folder holds repos with their own mission.config.mjs.
 * Uses whatever such workspace this machine has, and never presses Start: starting a panel
 * writes .panel/ into a real repo and runs its checks.
 */
describe('the Build view', { skip: !up && 'server not running on E2E_URL' }, () => {
  it('only lets known repos in, and only a repo with its own config counts', async () => {
    const r = await fetch(`${BASE}/api/mission/panel?root=${encodeURIComponent('/tmp')}`)
    assert.equal(r.status, 403)
    const start = await fetch(`${BASE}/api/mission/panel/start`, {
      method: 'POST',
      body: JSON.stringify({ root: '/tmp' }),
    })
    assert.equal(start.status, 403, 'a write without the control header is refused')
    const repos = await (await fetch(`${BASE}/api/control/repos`)).json()
    const own = repos.find((x) => x.path.endsWith('/laika-1brain') || x.path.includes('/laika-1brain-'))
    if (own) {
      const p = await (await fetch(`${BASE}/api/mission/panel?root=${encodeURIComponent(own.path)}`)).json()
      assert.equal(p.configured, false, '1brain has no panel of its own')
    }
  })

  let app
  after(async () => {
    await app?.close()
  })

  it('appears for a workspace with a panel, and frames it or offers to start it', async (t) => {
    const [repos, projects] = await Promise.all(
      ['repos', 'projects'].map(async (k) => (await fetch(`${BASE}/api/control/${k}`)).json()),
    )
    let ws = null
    let roots = []
    for (const path of [...projects.map((p) => p.path), ...repos.map((r) => r.path)]) {
      const j = await (await fetch(`${BASE}/api/mission/roots?root=${encodeURIComponent(path)}`)).json()
      if (j.roots?.length) {
        ws = path
        roots = j.roots
        break
      }
    }
    if (!ws) return t.skip('no repo on this machine has a mission.config.mjs')

    app = await openApp()
    const { page } = app
    await page.evaluate((ws) => {
      localStorage.setItem('laika.workspaces', JSON.stringify({ order: [ws], active: ws }))
    }, ws)
    await page.reload()
    await page.waitForSelector('#wbn [data-nav="claude"]')
    if (!(await page.evaluate(() => document.querySelector('#ss')?.classList.contains('on'))))
      await page.click('#wbn [data-nav="claude"]')
    await page.waitForSelector('#ss [data-view="build"]:not([hidden])')
    await page.click('#ss [data-view="build"]')
    await page.waitForSelector('[data-w="build"]:not([hidden]) .mcp')
    assert.equal(
      await page.locator('.mcp-repos button').count(),
      roots.length,
      'one choice per repo with a panel',
    )

    const chosen = await page.evaluate(() => document.querySelector('.mcp-repos button.on')?.getAttribute('data-root'))
    const root = chosen ?? roots[0]
    const p = await (await fetch(`${BASE}/api/mission/panel?root=${encodeURIComponent(root)}`)).json()
    if (p.running) {
      await page.waitForSelector('.mcp-frame:not([hidden])')
      assert.equal(await page.getAttribute('.mcp-frame:not([hidden])', 'src'), `${p.url}/`)
    } else {
      await page.waitForSelector('.mcp-off .mcp-start')
    }

    // the other views still switch back
    await page.click('#ss [data-view="chats"]')
    assert.equal(await page.evaluate(() => document.querySelector('[data-w="build"]').hidden), true)
    assert.deepEqual(app.errors, [])
  })
})
