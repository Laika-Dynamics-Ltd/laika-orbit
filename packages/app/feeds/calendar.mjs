/**
 * Calendar feed: Google Calendar's secret iCal address → brain/widgets/calendar.json.
 *
 * The server polls this itself, so the widget is minutes old rather than whenever an agent
 * last ran, and no OAuth is involved: the secret address is the credential, kept in
 * .env.local. Only `items`, `refreshedAt` and `source` are replaced — the zones, home time
 * zone and staleness settings already in the file are kept.
 */
import ICAL from 'ical.js'
import { readFile, writeFile, rename } from 'node:fs/promises'

const MAX_ITERATIONS = 100_000 // a daily series since 2000 is ~10k; this only stops a runaway rule

/** Epoch ms of local midnight today in `tz`. */
export function startOfDay(tz, now = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  })
  const o = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]))
  const wall = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second)
  const offset = wall - Math.floor(now.getTime() / 1000) * 1000
  return Date.UTC(+o.year, +o.month - 1, +o.day) - offset
}

/**
 * Timed events from one .ics text that overlap [from, to), recurrences expanded.
 * All-day events are left out: the widget lists events by clock time.
 */
export function eventsFromIcs(text, { from, to }) {
  const cal = new ICAL.Component(ICAL.parse(text))
  for (const tz of cal.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(tz)

  // Google names the primary calendar after its owner, which is how a declined invite is found
  const calName = String(cal.getFirstPropertyValue('x-wr-calname') ?? '')
  const owner = calName.includes('@') ? `mailto:${calName.toLowerCase()}` : null
  const declined = (comp) =>
    !!owner &&
    comp.getAllProperties('attendee').some(
      (a) => String(a.getFirstValue()).toLowerCase() === owner &&
        String(a.getParameter('partstat') ?? '').toUpperCase() === 'DECLINED',
    )
  const skip = (comp) =>
    String(comp.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED' || declined(comp)

  // a moved or edited occurrence arrives as its own VEVENT with a RECURRENCE-ID
  const masters = new Map()
  const exceptions = []
  for (const comp of cal.getAllSubcomponents('vevent')) {
    const ev = new ICAL.Event(comp)
    if (ev.isRecurrenceException()) exceptions.push(ev)
    else masters.set(ev.uid, ev)
  }
  const orphans = []
  for (const ex of exceptions) {
    const m = masters.get(ex.uid)
    if (m) m.relateException(ex)
    else orphans.push(ex)
  }

  const out = []
  const push = (start, end, comp, title) => {
    if (start.isDate || skip(comp)) return
    const s = start.toJSDate().getTime()
    const e = end ? end.toJSDate().getTime() : s
    if (e <= from || s >= to) return
    out.push({ title: title || '(no title)', at: new Date(s).toISOString(), end: new Date(e).toISOString(), uid: comp.getFirstPropertyValue('uid') })
  }

  for (const ev of [...masters.values(), ...orphans]) {
    if (!ev.isRecurring()) {
      push(ev.startDate, ev.endDate, ev.component, ev.summary)
      continue
    }
    const it = ev.iterator()
    for (let t = it.next(), n = 0; t && n < MAX_ITERATIONS; t = it.next(), n++) {
      if (t.toJSDate().getTime() >= to) break
      const d = ev.getOccurrenceDetails(t)
      push(d.startDate, d.endDate, d.item.component, d.item.summary)
    }
  }
  return out
}

/**
 * Fetch every address, merge, and rewrite the widget file. Throws if any address fails, so a
 * half-read calendar never looks complete; the old file stays and turns stale instead.
 */
export async function refreshCalendar({ urls, file, days = 7, limit = 20, now = new Date(), fetchImpl = fetch }) {
  const widget = JSON.parse(await readFile(file, 'utf8'))
  const tz = widget.config?.home ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const from = startOfDay(tz, now)
  const to = now.getTime() + days * 86_400_000

  const texts = await Promise.all(
    urls.map(async (url) => {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) })
      // never log the address itself: it is the credential
      if (!res.ok) throw new Error(`calendar feed returned HTTP ${res.status}`)
      return res.text()
    }),
  )

  const seen = new Set()
  const events = texts
    .flatMap((t) => eventsFromIcs(t, { from, to }))
    .filter((e) => {
      const k = `${e.uid}|${e.at}` // the same meeting on two shared calendars
      return seen.has(k) ? false : (seen.add(k), true)
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(0, limit)

  const next = {
    ...widget,
    source: 'google-calendar · ics',
    refreshedAt: now.toISOString(),
    items: events.map(({ title, at, end }) => ({ title, at, end })),
  }
  // write-then-rename, so the 60s UI poll never reads a half-written file
  await writeFile(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`)
  await rename(`${file}.tmp`, file)
  return events.length
}
