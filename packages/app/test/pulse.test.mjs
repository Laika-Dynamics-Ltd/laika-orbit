import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

// the store and the client both read LAIKA_PULSE_DIR at import time, so it is set before them
const DIR = mkdtempSync(join(tmpdir(), 'pulse-'))
process.env.LAIKA_PULSE_DIR = DIR
const { buildGraph, featureRoll, putSignals, readSignals, slug } = await import('../pulse.mjs')
const { consent, setConsent, count, batch, flush } = await import('../pulse-client.mjs')
const { parseTraffic, parseCounts, parseReleases } = await import('../feeds/github.mjs')
const { telemetrySignals } = await import('../pulse-api.mjs')
const { validate, continentOf } = await import('../../../tools/pulse-ingest/worker.js')

const NOW = Date.parse('2026-09-18T00:00:00Z')
const day = (n) => NOW - n * 86_400_000

afterAll(() => rmSync(DIR, { recursive: true, force: true }))

describe('pulse store', () => {
  beforeEach(() => rmSync(join(DIR, 'signals'), { recursive: true, force: true }))

  it('folds signals into their days and keeps them', () => {
    putSignals([
      { at: day(1), kind: 'view', id: 'view-a', count: 40, uniques: 12 },
      { at: day(0), kind: 'clone', id: 'clone-a', count: 9, uniques: 6 },
    ])
    const got = readSignals({ now: NOW, days: 30 })
    expect(got.map((s) => s.kind)).toEqual(['view', 'clone'])
    expect(got[0].source).toBe('github')
  })

  it('replaces a signal with the same id rather than doubling it', () => {
    // GitHub returns the same 14 days on every call, so re-fetching must settle, not accumulate
    putSignals([{ at: day(1), kind: 'view', id: 'view-a', count: 10, uniques: 4 }])
    putSignals([{ at: day(1), kind: 'view', id: 'view-a', count: 40, uniques: 12 }])
    const got = readSignals({ now: NOW })
    expect(got).toHaveLength(1)
    expect(got[0].uniques).toBe(12)
  })

  it('drops a kind it does not know', () => {
    putSignals([{ at: day(1), kind: 'keystrokes', id: 'x', count: 1 }])
    expect(readSignals({ now: NOW })).toHaveLength(0)
  })

  it('refuses an unusable id', () => expect(() => slug('  ')).toThrow())
})

describe('graph', () => {
  const signals = [
    { at: day(1), kind: 'view', id: 'v1', count: 40, uniques: 12, meta: {} },
    { at: day(1), kind: 'clone', id: 'c1', count: 9, uniques: 6, meta: {} },
    { at: day(0), kind: 'install', id: 'i1', count: 1, uniques: 1, meta: { features: ['map_open', 'recall_run', 'chat_open'] } },
    { at: day(0), kind: 'install', id: 'i2', count: 1, uniques: 1, meta: { features: ['map_open', 'recall_run'] } },
    { at: day(0), kind: 'install', id: 'i3', count: 1, uniques: 1, meta: { features: ['browser_open'] } },
    { at: day(0), kind: 'feature', id: 'f1', count: 12, uniques: 2, meta: { feature: 'recall_run', install: 'i1' } },
  ]

  it('weighs a cohort by its uniques and an install as one', () => {
    const g = buildGraph(signals, { now: NOW })
    expect(g.nodes.find((n) => n.id === 'v1').weight).toBe(12)
    expect(g.nodes.find((n) => n.id === 'i1').weight).toBe(1)
  })

  it('marks cohorts, so the page never draws a count as people', () => {
    const g = buildGraph(signals, { now: NOW })
    expect(g.nodes.find((n) => n.id === 'v1')).toMatchObject({ cohort: true, label: '12 visitors' })
    expect(g.nodes.find((n) => n.id === 'i1')).toMatchObject({ cohort: false, label: 'install' })
  })

  it('keeps feature rows out of the node set but in the totals', () => {
    const g = buildGraph(signals, { now: NOW })
    expect(g.nodes.some((n) => n.kind === 'feature')).toBe(false)
    expect(g.totals.install).toBe(3)
  })

  it('links installs that share two or more features, and marks them observed', () => {
    const g = buildGraph(signals, { now: NOW })
    const shared = g.links.filter((l) => l.kind === 'shared')
    expect(shared).toHaveLength(1)
    expect(shared[0]).toMatchObject({ a: 'i1', b: 'i2', inferred: false, w: 2 })
  })

  it('marks every funnel link inferred, because nobody is followed between stages', () => {
    const g = buildGraph(signals, { now: NOW })
    expect(g.links.filter((l) => l.kind === 'flow').every((l) => l.inferred)).toBe(true)
  })

  it('drops anything outside the window', () => {
    const g = buildGraph([{ at: day(90), kind: 'view', id: 'old', count: 5, uniques: 5, meta: {} }], { now: NOW, days: 30 })
    expect(g.nodes).toHaveLength(0)
  })

  it('counts features by use and by how many installs touched them', () => {
    expect(featureRoll(signals, { now: NOW })).toEqual([{ feature: 'recall_run', uses: 12, installs: 1 }])
  })
})

describe('github parsers', () => {
  it('reads a traffic window and skips days nobody came', () => {
    const got = parseTraffic({ views: [{ timestamp: '2026-09-16T00:00:00Z', count: 40, uniques: 12 }, { timestamp: '2026-09-17T00:00:00Z', count: 0, uniques: 0 }] }, 'view')
    expect(got).toEqual([{ at: Date.parse('2026-09-16T00:00:00Z'), kind: 'view', id: 'view-2026-09-16', count: 40, uniques: 12 }])
  })

  it('turns a running star total into the day it moved by', () => {
    expect(parseCounts({ stargazers_count: 15, forks_count: 3 }, { stargazers_count: 12, forks_count: 3 }, NOW)).toEqual([
      { at: NOW, kind: 'star', id: 'star-2026-09-18', count: 3, uniques: 3, meta: { total: 15 } },
    ])
  })

  it('says nothing when a total has not moved', () => {
    expect(parseCounts({ stargazers_count: 12, forks_count: 3 }, { stargazers_count: 12, forks_count: 3 }, NOW)).toEqual([])
    expect(parseReleases([{ assets: [{ download_count: 12 }] }], 12, NOW)).toEqual([])
  })

  it('sums downloads across every asset of every release', () => {
    const got = parseReleases([{ assets: [{ download_count: 5 }, { download_count: 7 }] }, { assets: [{ download_count: 2 }] }], null, NOW)
    expect(got[0]).toMatchObject({ kind: 'download', count: 14 })
  })

  it('survives a shape it did not expect', () => {
    expect(parseTraffic(null, 'view')).toEqual([])
    expect(parseReleases(undefined, null, NOW)).toEqual([])
  })
})

describe('opt-in consent', () => {
  beforeEach(() => setConsent(false))

  it('starts unset, and counts nothing until asked', () => {
    rmSync(join(DIR, 'consent.json'), { force: true })
    expect(consent().state).toBe('unset')
    expect(count('app_open')).toBe(false)
    expect(batch()).toBe(null)
  })

  it('mints an install id only on consent', () => {
    expect(consent().install).toBe(null)
    setConsent(true)
    expect(consent().install).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('keeps the same id across a restart, so one install is one node', () => {
    setConsent(true)
    const first = consent().install
    setConsent(true)
    expect(consent().install).toBe(first)
  })

  it('destroys the id and the queue when consent is withdrawn', () => {
    setConsent(true)
    count('app_open', 4)
    setConsent(false)
    expect(consent().install).toBe(null)
    expect(batch()).toBe(null)
    setConsent(true)
    // a new id, not the old one: withdrawing means leaving nothing behind
    expect(batch()).toBe(null)
  })

  it('refuses an event name that is not on the allowlist', () => {
    setConsent(true)
    expect(count('file_opened_at_path')).toBe(false)
    expect(batch()).toBe(null)
  })

  it('sends only the allowed shape, and never a path or a query', async () => {
    setConsent(true)
    count('app_open', 3)
    count('recall_run')
    let sent = null
    const res = await flush({ app: '0.42', endpoint: 'https://x.test', fetchImpl: async (u, o) => ((sent = { u, body: JSON.parse(o.body) }), { ok: true }) })
    expect(res.ok).toBe(true)
    expect(sent.u).toBe('https://x.test/v1/events')
    expect(Object.keys(sent.body).sort()).toEqual(['app', 'events', 'install', 'platform', 'v'])
    // counts are per UTC day, so today's, whenever the test runs
    expect(sent.body.events).toContainEqual({ name: 'app_open', day: new Date().toISOString().slice(0, 10), count: 3 })
    for (const e of sent.body.events) expect(Object.keys(e).sort()).toEqual(['count', 'day', 'name'])
  })

  it('makes no request at all when there is no endpoint', async () => {
    setConsent(true)
    count('app_open')
    expect(await flush({ app: '0.42' })).toMatchObject({ ok: false, reason: 'no-endpoint' })
  })

  it('does not throw when the endpoint is down', async () => {
    setConsent(true)
    count('app_open')
    const res = await flush({ endpoint: 'https://x.test', fetchImpl: async () => { throw new Error('offline') } })
    expect(res).toMatchObject({ ok: false })
  })
})

describe('ingest worker validation', () => {
  const id = '11111111-2222-3333-4444-555555555555'

  it('takes a well-formed batch', () => {
    expect(validate({ v: 1, install: id, app: '0.42', platform: 'darwin', events: [{ name: 'app_open', day: '2026-09-18', count: 3 }] }, { now: NOW }))
      .toMatchObject({ install: id, app: '0.42', platform: 'darwin', dropped: 0 })
  })

  it('drops an event name it does not know, rather than storing it', () => {
    // the client is open source and runs on other people's machines, so this is the real gate
    const v = validate({ v: 1, install: id, events: [{ name: 'app_open', day: '2026-09-18', count: 1 }, { name: "'; DROP TABLE events;--", day: '2026-09-18', count: 1 }] }, { now: NOW })
    expect(v.events).toHaveLength(1)
    expect(v.dropped).toBe(1)
  })

  it('refuses an install id that is not a uuid', () => {
    expect(validate({ v: 1, install: '../../etc/passwd', events: [] }, { now: NOW }).error).toMatch(/uuid/)
  })

  it('drops days outside the window, so a wrong clock cannot distort the series', () => {
    expect(validate({ v: 1, install: id, events: [{ name: 'app_open', day: '2019-01-01', count: 1 }] }, { now: NOW }).error).toBeTruthy()
    expect(validate({ v: 1, install: id, events: [{ name: 'app_open', day: '2027-01-01', count: 1 }] }, { now: NOW }).error).toBeTruthy()
  })

  it('nulls a platform it does not recognise instead of storing free text', () => {
    const v = validate({ v: 1, install: id, platform: 'rm -rf /', app: 'x'.repeat(99), events: [{ name: 'app_open', day: '2026-09-18', count: 1 }] }, { now: NOW })
    expect(v.platform).toBe(null)
    expect(v.app).toBe(null)
  })

  it('caps the batch size and the count', () => {
    const many = Array.from({ length: 61 }, () => ({ name: 'app_open', day: '2026-09-18', count: 1 }))
    expect(validate({ v: 1, install: id, events: many }, { now: NOW }).error).toMatch(/at most/)
    const big = validate({ v: 1, install: id, events: [{ name: 'app_open', day: '2026-09-18', count: 1e9 }] }, { now: NOW })
    expect(big.events[0].count).toBe(100_000)
  })

  it('narrows a country to a continent, and never keeps the country', () => {
    expect(continentOf('NZ')).toBe('OC')
    expect(continentOf('gb')).toBe('EU')
    expect(continentOf('ZZ')).toBe(null)
  })
})

describe('telemetry → signals', () => {
  it('maps installs, days and features into the one store shape', () => {
    const got = telemetrySignals(
      { installs: [{ install: 'abc', first_day: '2026-09-17', last_day: '2026-09-18', app: '0.42', platform: 'darwin', region: 'OC', features: ['map_open'] }], daily: [{ day: '2026-09-18', installs: 2, events: 31 }], features: [{ name: 'recall_run', uses: 12, installs: 2 }] },
      { now: NOW },
    )
    expect(got.map((s) => s.kind)).toEqual(['install', 'session', 'feature'])
    // prefixed ids, so a telemetry node can never collide with a GitHub cohort for the same day
    expect(got[0].id).toBe('install-abc')
  })

  it('survives an empty or missing response', () => {
    expect(telemetrySignals(null, { now: NOW })).toEqual([])
    expect(telemetrySignals({}, { now: NOW })).toEqual([])
  })
})
