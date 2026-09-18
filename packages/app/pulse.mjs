/**
 * Adoption pulse — the signals behind the /pulse node network, and the graph they make.
 *
 * WHY A STORE AND NOT A LIVE FETCH: the two sources tell you about different spans and neither
 * is repeatable. GitHub's traffic API only ever returns the last 14 days and forgets what came
 * before, so a day not fetched is a day lost for good; opt-in telemetry arrives whenever a user's
 * app happens to flush. Both are folded into one append-only file per day here, so the page reads
 * one shape, history outlives GitHub's window, and a rate limit or a down endpoint costs nothing.
 *
 *   ~/.laika/pulse/signals/<yyyy-mm-dd>.json   the day's signals, newest appended
 *   ~/.laika/pulse/cache/<source>.json         last raw fetch, for backoff and diffing
 *
 * A signal is one observed thing, from either source, in one shape:
 *
 *   { at, kind, source, id, count, uniques, meta }
 *
 * `id` is stable per (kind, source, bucket) so re-fetching an overlapping window updates a day
 * rather than doubling it — GitHub returns the same 14 days every call.
 *
 * WHAT A NODE MEANS, EXACTLY: public signals are daily *counts*, not people. A clone node stands
 * for a cohort ("9 unique cloners on the 16th"), never an individual, and carries `cohort: true`
 * so the page can label it honestly. Only opt-in telemetry produces a node that is one install,
 * and even then it is an anonymous id that the user chose to send. Nothing here ever holds a
 * name, an address, a path or a query.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DIR = process.env.LAIKA_PULSE_DIR || join(homedir(), '.laika', 'pulse')
const SIGNALS = () => join(DIR, 'signals')
const CACHE = () => join(DIR, 'cache')

/** every signal kind, and whether one node of it stands for one person */
export const KINDS = {
  view: { source: 'github', cohort: true, label: 'visitor' },
  clone: { source: 'github', cohort: true, label: 'cloner' },
  star: { source: 'github', cohort: true, label: 'star' },
  fork: { source: 'github', cohort: true, label: 'fork' },
  download: { source: 'github', cohort: true, label: 'download' },
  install: { source: 'telemetry', cohort: false, label: 'install' },
  session: { source: 'telemetry', cohort: false, label: 'session' },
  feature: { source: 'telemetry', cohort: false, label: 'feature' },
}

export const day = (at) => new Date(at).toISOString().slice(0, 10)

/** a file-name-safe id, same rules as the progress store */
export function slug(s) {
  const v = String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, 80)
  if (!v) throw new Error(`not a usable id: ${JSON.stringify(s)}`)
  return v
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** atomic: write beside the target, then rename, so a reader never sees half a file */
function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value))
  renameSync(tmp, path)
}

/**
 * Fold signals into their days, replacing any with the same id.
 *
 * Returns the days touched. Callers hand us a whole fetch and we sort out which file each
 * signal belongs in, because one GitHub response spans 14 of them.
 */
export function putSignals(list, { dir = DIR } = {}) {
  const byDay = new Map()
  for (const s of list) {
    if (!s || !KINDS[s.kind]) continue
    const d = day(s.at)
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d).push({
      at: Number(s.at),
      kind: s.kind,
      source: KINDS[s.kind].source,
      id: slug(s.id ?? `${s.kind}-${d}`),
      count: Math.max(0, Number(s.count ?? 1)),
      uniques: Math.max(0, Number(s.uniques ?? s.count ?? 1)),
      meta: s.meta && typeof s.meta === 'object' ? s.meta : {},
    })
  }
  const dir_ = join(dir, 'signals')
  for (const [d, fresh] of byDay) {
    const path = join(dir_, `${d}.json`)
    const prior = readJson(path, [])
    const merged = new Map(prior.map((s) => [s.id, s]))
    for (const s of fresh) merged.set(s.id, s)
    writeJson(path, [...merged.values()].sort((a, b) => a.at - b.at))
  }
  return [...byDay.keys()]
}

/** Every signal in the last `days`, oldest first. */
export function readSignals({ dir = DIR, days = 30, now = Date.now() } = {}) {
  const from = now - days * 86_400_000
  const dir_ = join(dir, 'signals')
  if (!existsSync(dir_)) return []
  const out = []
  for (const f of readdirSync(dir_)) {
    if (!f.endsWith('.json')) continue
    if (Date.parse(`${f.slice(0, 10)}T23:59:59Z`) < from) continue
    for (const s of readJson(join(dir_, f), [])) if (s.at >= from) out.push(s)
  }
  return out.sort((a, b) => a.at - b.at)
}

export const readCache = (name, fallback = null) => readJson(join(CACHE(), `${slug(name)}.json`), fallback)
export const writeCache = (name, value) => writeJson(join(CACHE(), `${slug(name)}.json`), value)

/**
 * The node network the page draws.
 *
 * Nodes are laid out by the renderer, not here — this only decides what exists, how heavy it is
 * and what it connects to. Two kinds of edge, because they mean different things:
 *
 *   flow    a day's cohort to the next day's, following the funnel view → clone → install.
 *           These are the arcs people "flow" along; they are inferred from ordering, not from
 *           following anyone, and are marked `inferred` so the page never overclaims.
 *   shared  two telemetry installs that used the same feature. Real, and only ever between
 *           anonymous ids.
 */
export function buildGraph(signals, { now = Date.now(), days = 30 } = {}) {
  const from = now - days * 86_400_000
  const nodes = []
  const links = []
  const totals = { view: 0, clone: 0, star: 0, fork: 0, download: 0, install: 0, session: 0 }
  const byDayKind = new Map()

  for (const s of signals) {
    if (s.at < from) continue
    const k = KINDS[s.kind]
    if (!k) continue
    totals[s.kind] = (totals[s.kind] ?? 0) + (k.cohort ? s.uniques : 1)
    if (s.kind === 'feature') continue // features hang off their install, not on their own
    const d = day(s.at)
    const node = {
      id: s.id,
      kind: s.kind,
      day: d,
      at: s.at,
      cohort: k.cohort,
      // a cohort node is as heavy as the people it stands for; an install is always one
      weight: k.cohort ? s.uniques : 1,
      count: s.count,
      label: k.cohort ? `${s.uniques} ${k.label}${s.uniques === 1 ? '' : 's'}` : k.label,
      features: Array.isArray(s.meta?.features) ? s.meta.features.slice(0, 12) : [],
      region: s.meta?.region ?? null,
    }
    nodes.push(node)
    const key = `${d}:${s.kind}`
    if (!byDayKind.has(key)) byDayKind.set(key, [])
    byDayKind.get(key).push(node)
  }

  // the funnel: each day's stage joins the same day's next stage, and the same stage tomorrow
  const FUNNEL = ['view', 'clone', 'install', 'session']
  const dayList = [...new Set(nodes.map((n) => n.day))].sort()
  for (const d of dayList) {
    for (let i = 0; i < FUNNEL.length - 1; i++) {
      const a = byDayKind.get(`${d}:${FUNNEL[i]}`)
      const b = byDayKind.get(`${d}:${FUNNEL[i + 1]}`)
      if (a?.length && b?.length) {
        for (const x of a) for (const y of b) links.push({ a: x.id, b: y.id, kind: 'flow', inferred: true, w: Math.min(x.weight, y.weight) })
      }
    }
    const next = dayList[dayList.indexOf(d) + 1]
    if (!next) continue
    for (const stage of FUNNEL) {
      const a = byDayKind.get(`${d}:${stage}`)
      const b = byDayKind.get(`${next}:${stage}`)
      if (a?.length && b?.length) links.push({ a: a[0].id, b: b[0].id, kind: 'flow', inferred: true, w: Math.min(a[0].weight, b[0].weight) })
    }
  }

  // shared features between installs — the only edge that is observed rather than inferred
  const installs = nodes.filter((n) => n.kind === 'install' && n.features.length)
  for (let i = 0; i < installs.length; i++) {
    for (let j = i + 1; j < installs.length; j++) {
      const shared = installs[i].features.filter((f) => installs[j].features.includes(f))
      if (shared.length >= 2) links.push({ a: installs[i].id, b: installs[j].id, kind: 'shared', inferred: false, w: shared.length })
    }
  }

  // one point per day per stage, for the sparkline rail
  const series = dayList.map((d) => {
    const at = Date.parse(`${d}T00:00:00Z`)
    const sum = (stage) => (byDayKind.get(`${d}:${stage}`) ?? []).reduce((t, n) => t + n.weight, 0)
    return { day: d, at, view: sum('view'), clone: sum('clone'), install: sum('install'), session: sum('session') }
  })

  return { nodes, links, totals, series, days, now }
}

/** Features counted across installs, most used first — the behaviour readout. */
export function featureRoll(signals, { now = Date.now(), days = 30 } = {}) {
  const from = now - days * 86_400_000
  const count = new Map()
  for (const s of signals) {
    if (s.at < from || s.kind !== 'feature') continue
    const name = s.meta?.feature
    if (typeof name !== 'string') continue
    const c = count.get(name) ?? { feature: name, uses: 0, installs: new Set() }
    c.uses += s.count
    if (s.meta?.install) c.installs.add(s.meta.install)
    count.set(name, c)
  }
  return [...count.values()]
    .map((c) => ({ feature: c.feature, uses: c.uses, installs: c.installs.size }))
    .sort((a, b) => b.uses - a.uses || a.feature.localeCompare(b.feature))
}
