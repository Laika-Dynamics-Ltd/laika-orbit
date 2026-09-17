import assert from 'node:assert/strict'
import { request } from 'node:http'
import { describe, it } from 'node:test'
import { BASE, serverUp, widgets } from './harness.mjs'

const up = await serverUp()

describe('feeds and server guards', { skip: !up && 'server not running on E2E_URL' }, () => {
  it('reports Gmail status without leaking secrets', async () => {
    const s = await (await fetch(`${BASE}/api/gmail/status`)).json()
    assert.ok(['off', 'unconfigured', 'starting', 'needs-connect', 'live'].includes(s.status))
    const raw = JSON.stringify(s)
    assert.doesNotMatch(raw, /GOCSPX|refresh_token|client_secret/i)
  })

  it('a live Gmail feed writes the email widget', async (t) => {
    const s = await (await fetch(`${BASE}/api/gmail/status`)).json()
    if (s.status !== 'live') return t.skip(`gmail is ${s.status}`)
    const email = (await widgets()).find((w) => w.id === 'email')
    assert.equal(email.source, 'gmail · api')
    assert.match(email.config.value, /^\d+$/)
    assert.ok(Date.now() - Date.parse(email.refreshedAt) < 5 * 60_000, 'synced in the last 5 minutes')
  })

  it('refuses a forged Gmail sign-in callback', async () => {
    const html = await (await fetch(`${BASE}/api/gmail/callback?state=forged&code=x`)).text()
    assert.match(html, /expired/i)
  })

  it('refuses requests addressed to a non-loopback host', async () => {
    // fetch() will not send a forged Host header, so speak HTTP directly
    const u = new URL(BASE)
    const status = await new Promise((ok, fail) => {
      const req = request({ host: u.hostname, port: u.port, path: '/api/settings', headers: { host: 'evil.example' } }, (res) => {
        res.resume()
        ok(res.statusCode)
      })
      req.on('error', fail)
      req.end()
    })
    assert.equal(status, 403)
  })

  it('rejects an invalid profile', async () => {
    const r = await fetch(`${BASE}/api/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emails: ['nope'] }),
    })
    assert.equal(r.status, 400)
  })

  it('serves file content only for indexed paths', async () => {
    const r = await fetch(`${BASE}/api/file?path=${encodeURIComponent('../../../../etc/hosts')}`)
    assert.notEqual(r.status, 200)
  })
})
