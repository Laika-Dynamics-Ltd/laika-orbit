import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { BASE, openApp, serverUp } from './harness.mjs'

/**
 * Live previews: the thumbnail route, image nodes, the hover preview and the in-scene
 * cards that appear when the camera is close to a cluster.
 */
const up = await serverUp()

const files = async (q) =>
  (await (await fetch(`${BASE}/api/index/files?q=${encodeURIComponent(q)}&limit=5`)).json()).rows

describe('thumbnail route', { skip: !up && 'server not running on E2E_URL' }, () => {
  it('renders a PDF page as a PNG and caches it', async (t) => {
    const [pdf] = await files('.pdf')
    if (!pdf) return t.skip('no PDF in the index')
    const r = await fetch(`${BASE}/api/thumb?path=${encodeURIComponent(pdf.path)}&s=320`)
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-type'), 'image/png')
    const bytes = new Uint8Array(await r.arrayBuffer())
    assert.deepEqual([...bytes.slice(1, 4)], [0x50, 0x4e, 0x47], 'PNG signature')
    const t0 = Date.now()
    const again = await fetch(`${BASE}/api/thumb?path=${encodeURIComponent(pdf.path)}&s=320`)
    assert.equal(again.status, 200)
    assert.ok(Date.now() - t0 < 1500, 'second request comes from the cache')
  })

  it('renders a Word document', async (t) => {
    const [doc] = (await files('.docx')).filter((f) => f.path.endsWith('.docx'))
    if (!doc) return t.skip('no .docx in the index')
    const r = await fetch(`${BASE}/api/thumb?path=${encodeURIComponent(doc.path)}&s=160`)
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-type'), 'image/png')
  })

  it('refuses paths outside the index and formats it cannot draw', async () => {
    const out = await fetch(`${BASE}/api/thumb?path=${encodeURIComponent('../../../etc/hosts')}`)
    assert.equal(out.status, 403)
    const [ts] = (await files('.ts')).filter((f) => /\.ts$/.test(f.path))
    if (ts) {
      const r = await fetch(`${BASE}/api/thumb?path=${encodeURIComponent(ts.path)}`)
      assert.equal(r.status, 415)
    }
  })

  it('indexes images a source includes, as image nodes with no content', async (t) => {
    const g = await (await fetch(`${BASE}/api/graph`)).json()
    const img = g.nodes.find((n) => n.kind === 'image')
    if (!img) return t.skip('no image source configured')
    assert.match(img.path, /\.(png|jpe?g|gif|webp|svg)$/i)
    assert.equal(img.docType, 'image')
    const d = await (await fetch(`${BASE}/api/index/doc?path=${encodeURIComponent(img.path)}`)).json()
    assert.equal(d.tokens.length, 0, 'pixels are not tokenised')
    const r = await fetch(`${BASE}/api/thumb?path=${encodeURIComponent(img.path)}&s=160`)
    assert.equal(r.status, 200)
  })
})

describe('previews in the app', { skip: !up && 'server not running on E2E_URL' }, () => {
  let app
  before(async () => {
    app = await openApp()
  })
  after(async () => {
    await app?.close()
  })

  /** Scan the stage for a point that picks a node; returns stage-relative coordinates. */
  async function findNode(page) {
    return page.evaluate(async () => {
      const st = document.querySelector('#stage').getBoundingClientRect()
      for (let y = 60; y < st.height - 60; y += 12) {
        for (let x = 100; x < st.width - 100; x += 12) {
          const i = globalThis.__pick(st.left + x, st.top + y)
          if (i >= 0) return { x: st.left + x, y: st.top + y, i }
        }
      }
      return null
    })
  }

  /** Move the pointer onto a node and wait for its tooltip; the camera may still be settling. */
  async function hoverNode(page) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const hit = await findNode(page)
      if (hit) {
        await page.mouse.move(hit.x, hit.y)
        const on = await page
          .waitForSelector('#tip.on', { timeout: 4000 })
          .then(() => true)
          .catch(() => false)
        if (on) return hit
      }
      // nothing pickable yet: the camera may be settling, or the view is far out — zoom a notch
      const st = await page.evaluate(() => {
        const r = document.querySelector('#stage').getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })
      await page.mouse.move(st.x, st.y)
      await page.mouse.wheel(0, -200)
      await page.waitForTimeout(1500)
    }
    return null
  }

  it('hovering a node grows the tooltip into a preview', async () => {
    const { page } = app
    await page.waitForFunction(() => document.querySelector('#np-layer'))
    await page.waitForTimeout(1500) // let the boot fly-in settle
    const hit = await hoverNode(page)
    assert.ok(hit, 'a node under the pointer somewhere on the stage')
    await page.waitForSelector('#tip .np-tip[data-np]', { timeout: 20_000 })
    const kind = await page.getAttribute('#tip .np-tip', 'data-np')
    assert.ok(['thumb', 'markdown', 'code'].includes(kind))
  })

  it('clicking a node shows a preview in the inspector and cards on the nearby nodes', async () => {
    const { page } = app
    const hit = await hoverNode(page)
    assert.ok(hit)
    await page.mouse.click(hit.x, hit.y)
    await page.waitForSelector('#inspector.on')
    await page.waitForSelector('#ins-prev.np-ready', { timeout: 20_000 })
    // the fly-to brings the camera close enough for in-scene cards
    await page.waitForSelector('#np-layer .np-card.np-ready', { timeout: 20_000 })
    const n = await page.locator('#np-layer .np-card.np-ready').count()
    assert.ok(n >= 1, `cards on screen: ${n}`)
  })

  it('p toggles the in-scene cards off and on', async () => {
    const { page } = app
    await page.mouse.move(10, 10) // off the graph, so the key is not typed into a field
    await page.keyboard.press('p')
    await page.waitForFunction(() => document.querySelector('#np-layer').classList.contains('off'))
    assert.equal(await page.locator('#np-layer .np-card').count(), 0)
    await page.keyboard.press('p')
    await page.waitForFunction(() => !document.querySelector('#np-layer').classList.contains('off'))
    await page.waitForSelector('#np-layer .np-card.np-ready', { timeout: 20_000 })
  })
})
