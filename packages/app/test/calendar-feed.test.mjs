import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { eventsFromIcs, refreshCalendar, startOfDay } from '../feeds/calendar.mjs'

// Shaped like Google's secret iCal export: CRLF, a VTIMEZONE, the owner as X-WR-CALNAME
const ev = (lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']
const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'X-WR-CALNAME:joe@example.com', 'X-WR-TIMEZONE:Pacific/Auckland',
  'BEGIN:VTIMEZONE', 'TZID:Pacific/Auckland',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+1200', 'TZOFFSETTO:+1300', 'TZNAME:NZDT',
  'DTSTART:19700927T020000', 'RRULE:FREQ=YEARLY;BYMONTH=9;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+1300', 'TZOFFSETTO:+1200', 'TZNAME:NZST',
  'DTSTART:19700405T030000', 'RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU', 'END:STANDARD',
  'END:VTIMEZONE',
  // weekly Friday catchup, one week skipped, one week moved
  ...ev(['UID:catchup', 'SUMMARY:Sam/Alex Catchup',
    'DTSTART;TZID=Pacific/Auckland:20260904T120000', 'DTEND;TZID=Pacific/Auckland:20260904T123000',
    'RRULE:FREQ=WEEKLY', 'EXDATE;TZID=Pacific/Auckland:20260925T120000']),
  ...ev(['UID:catchup', 'SUMMARY:Sam/Alex Catchup (moved)',
    'RECURRENCE-ID;TZID=Pacific/Auckland:20260918T120000',
    'DTSTART;TZID=Pacific/Auckland:20260918T140000', 'DTEND;TZID=Pacific/Auckland:20260918T143000']),
  ...ev(['UID:earlier', 'SUMMARY:Standup', 'DTSTART:20260916T210000Z', 'DTEND:20260916T211500Z']),
  ...ev(['UID:yesterday', 'SUMMARY:Yesterday', 'DTSTART:20260915T220000Z', 'DTEND:20260915T230000Z']),
  ...ev(['UID:admin', 'SUMMARY:Admin Batch · Office',
    'DTSTART;TZID=Pacific/Auckland:20260917T153000', 'DTEND;TZID=Pacific/Auckland:20260917T163000']),
  ...ev(['UID:cancelled', 'SUMMARY:Cancelled', 'STATUS:CANCELLED',
    'DTSTART:20260918T220000Z', 'DTEND:20260918T230000Z']),
  ...ev(['UID:declined', 'SUMMARY:Declined',
    'DTSTART:20260919T010000Z', 'DTEND:20260919T020000Z',
    'ATTENDEE;CN=Joe;PARTSTAT=DECLINED:mailto:joe@example.com']),
  ...ev(['UID:allday', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20260918', 'DTEND;VALUE=DATE:20260919']),
  'END:VCALENDAR',
].join('\r\n')

const NOW = new Date('2026-09-17T00:00:00Z') // Thu 12:00 NZST

describe('calendar feed', () => {
  it('finds local midnight in the home zone', () => {
    expect(new Date(startOfDay('Pacific/Auckland', NOW)).toISOString()).toBe('2026-09-16T12:00:00.000Z')
  })

  it('expands recurrences across DST and drops cancelled, declined and all-day events', () => {
    const from = startOfDay('Pacific/Auckland', NOW)
    const to = NOW.getTime() + 15 * 86_400_000
    const got = eventsFromIcs(ICS, { from, to })
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .map((e) => [e.at, e.title])
    expect(got).toEqual([
      ['2026-09-16T21:00:00.000Z', 'Standup'], // earlier today still shows, as done
      ['2026-09-17T03:30:00.000Z', 'Admin Batch · Office'],
      ['2026-09-18T02:00:00.000Z', 'Sam/Alex Catchup (moved)'],
      ['2026-10-01T23:00:00.000Z', 'Sam/Alex Catchup'], // 12:00 NZDT, an hour earlier in UTC
    ])
  })

  it('rewrites only items, keeping the widget config', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'cal-')), 'calendar.json')
    const config = { home: 'Pacific/Auckland', zones: [{ label: 'LONDON', tz: 'Europe/London' }] }
    await writeFile(file, JSON.stringify({ id: 'calendar', kind: 'calendar', config, items: [{ title: 'old' }] }))
    const fetchImpl = async () => new Response(ICS)
    const n = await refreshCalendar({ urls: ['a', 'a'], file, now: NOW, fetchImpl })
    const w = JSON.parse(await readFile(file, 'utf8'))
    expect(n).toBe(3) // two copies of one calendar dedupe; 7 days stops before Oct 2
    expect(w.config).toEqual(config)
    expect(w.refreshedAt).toBe(NOW.toISOString())
    expect(w.items.map((i) => i.title)).toEqual(['Standup', 'Admin Batch · Office', 'Sam/Alex Catchup (moved)'])
  })

  it('leaves the file alone when a feed fails', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'cal-')), 'calendar.json')
    const before = JSON.stringify({ id: 'calendar', config: {}, items: [{ title: 'old' }] })
    await writeFile(file, before)
    const fetchImpl = async () => new Response('nope', { status: 404 })
    await expect(refreshCalendar({ urls: ['a'], file, now: NOW, fetchImpl })).rejects.toThrow('HTTP 404')
    expect(await readFile(file, 'utf8')).toBe(before)
  })
})
