import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { authorizeUrl, parseFrom, refreshEmail, resetEmailCache, segmentOf, summarise } from '../feeds/gmail.mjs'

const NOW = Date.parse('2026-09-17T10:00:00Z')
const msg = (id, from, subject, { labels = ['INBOX'], unsub = false, ago = 60 } = {}) => ({
  id,
  threadId: `t${id}`,
  labelIds: labels,
  internalDate: String(NOW - ago * 60_000),
  payload: {
    headers: [
      { name: 'From', value: from },
      { name: 'Subject', value: subject },
      ...(unsub ? [{ name: 'List-Unsubscribe', value: '<mailto:u@x>' }] : []),
    ],
  },
})

const MAIL = [
  msg('1', '"Jane Client" <jane@acme.co.nz>', 'Invoice question', { labels: ['INBOX', 'UNREAD'], ago: 30 }),
  msg('2', 'Sentry <noreply@md.getsentry.com>', 'TypeError in dashboard', { labels: ['INBOX', 'UNREAD'] }),
  msg('3', 'Xero <messaging@post.xero.com>', 'Your bill', { labels: ['INBOX'] }),
  msg('4', 'Weekly <news@substack.com>', 'The week in AI', { labels: ['INBOX', 'CATEGORY_UPDATES', 'UNREAD'], unsub: true }),
  msg('5', 'Shop <deals@shop.com>', '50% off', { labels: ['CATEGORY_PROMOTIONS', 'UNREAD'], unsub: true }),
  msg('6', 'Sam Mate <sam@gmail.com>', 'beers friday?', { labels: ['INBOX'], ago: 300 }),
  msg('7', 'Sam Rivera <sam@example.com>', 'Catchup notes', { labels: ['INBOX', 'UNREAD'], ago: 5 }),
  msg('8', 'Joe <joe@example.com>', 'note to self', { labels: ['INBOX', 'UNREAD'], ago: 2 }),
]
const unreadIds = MAIL.filter((m) => m.labelIds.includes('UNREAD')).map((m) => m.id)

function fakeFetch(calls) {
  return async (url, init) => {
    calls.push(String(url))
    const ok = (body) => ({ ok: true, status: 200, json: async () => body })
    if (String(url).includes('oauth2.googleapis.com/token')) {
      expect(String(init.body)).toContain('grant_type=refresh_token')
      return ok({ access_token: 'at', expires_in: 3600 })
    }
    const u = new URL(url)
    expect(init.headers.authorization).toBe('Bearer at')
    if (u.pathname.endsWith('/profile')) return ok({ emailAddress: 'joe@example.com' })
    if (u.pathname.endsWith('/messages')) {
      const q = u.searchParams.get('q')
      const ids = q.includes('is:unread') ? unreadIds : MAIL.map((m) => m.id)
      return ok({ messages: ids.map((id) => ({ id })) })
    }
    const id = u.pathname.split('/').pop()
    return ok(MAIL.find((m) => m.id === id))
  }
}

describe('gmail feed', () => {
  beforeEach(() => resetEmailCache())

  it('classifies senders', () => {
    expect(parseFrom('"Jane Client" <Jane@Acme.co.nz>')).toEqual({ name: 'Jane Client', email: 'jane@acme.co.nz' })
    const s = MAIL.map(summarise)
    expect(s.map((m) => m.person)).toEqual([true, false, false, false, false, true, true, true])
    expect(s.map((m) => segmentOf(m))).toEqual(['PEOPLE', 'ALERTS', 'BILLING', 'NEWS', 'NOISE', 'PEOPLE', 'PEOPLE', 'PEOPLE'])
  })

  it('writes figures and unread-from-people, keeps settings, and only fetches new headers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gmail-'))
    const file = join(dir, 'email.json')
    await writeFile(file, JSON.stringify({ id: 'email', kind: 'metric', title: 'Email', config: { staleAfterMins: 20 } }))
    const calls = []
    const creds = { clientId: 'c', clientSecret: 's', refreshToken: 'r' }
    const r = await refreshEmail({ creds, file, now: NOW, fetchImpl: fakeFetch(calls) })
    expect(r).toEqual({ count: 8, account: 'joe@example.com', needs: 2, unread: 6 })
    const w = JSON.parse(await readFile(file, 'utf8'))
    expect(w.config.staleAfterMins).toBe(20)
    expect(w.config.value).toBe('8')
    expect(w.config.unread).toBe(6)
    expect(w.items.map((i) => i.title)).toEqual(['Sam Rivera — Catchup notes', 'Jane Client — Invoice question'])
    expect(w.items[0].meta).toBe('5m')
    expect(w.items[0].href).toBe('https://mail.google.com/mail/u/0/#inbox/t7')
    expect(w.config.segments.map((s) => `${s.label}:${s.n}`)).toEqual(['ALERTS:1', 'BILLING:1', 'PEOPLE:4', 'NEWS:1', 'NOISE:1'])
    expect(w.config.footer).toContain('joe@example.com')
    const headerCalls = calls.filter((c) => /\/messages\/\d/.test(c)).length
    expect(headerCalls).toBe(8)

    // second poll: nothing new, so no header fetches and no second token call
    const again = []
    await refreshEmail({ creds, file, now: NOW, fetchImpl: fakeFetch(again) })
    expect(again.filter((c) => /\/messages\/\d/.test(c))).toHaveLength(0)
    expect(again.filter((c) => c.includes('oauth2'))).toHaveLength(0)
  })

  it('asks for read-only offline access', () => {
    const u = new URL(authorizeUrl({ clientId: 'cid', redirectUri: 'http://localhost:5200/api/gmail/callback', state: 'st' }))
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly')
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('state')).toBe('st')
  })
})
