/**
 * Calendar + world clock widget.
 *
 * Everything is computed in the widget's HOME time zone, not the browser's: the
 * panel describes Auckland even when the laptop is somewhere else. The events come
 * from the producer as `{ title, meta: "Thu 3:30pm", tag: "today" }` (or an ISO `at`),
 * and are turned into real instants so the list can count down and retire them.
 */
import type { Widget, WidgetItem } from './widgets.ts'

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[<>&"]/g,
    (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[m] as string,
  )

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
type Work = { from: number; to: number }
/** default working hours, used for the day bar and each zone's status */
const WORK: Work = { from: 9, to: 17 }
const workOf = (v: unknown): Work => {
  const o = (v ?? {}) as Partial<Work>
  const from = Number(o.from ?? WORK.from)
  const to = Number(o.to ?? WORK.to)
  return from >= 0 && to <= 24 && from < to ? { from, to } : WORK
}
const workAttr = (w: Work) => `${w.from}-${w.to}`
const parseWork = (s: string | undefined): Work => {
  const [a, b] = (s ?? '').split('-').map(Number)
  return workOf({ from: a, to: b })
}

type Parts = { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: number }

const partFmt = new Map<string, Intl.DateTimeFormat>()
/** Wall-clock parts of `date` in `tz`. */
function partsIn(tz: string, date = new Date()): Parts {
  let f = partFmt.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    })
    partFmt.set(tz, f)
  }
  const o: Record<string, string> = {}
  for (const p of f.formatToParts(date)) o[p.type] = p.value
  return {
    y: +(o.year ?? 0),
    mo: +(o.month ?? 1),
    d: +(o.day ?? 1),
    h: +(o.hour ?? 0),
    mi: +(o.minute ?? 0),
    s: +(o.second ?? 0),
    wd: WD.indexOf(o.weekday ?? 'Sun'),
  }
}

/** Minutes ahead of UTC for `tz` right now. */
function offsetMin(tz: string, date = new Date()): number {
  const p = partsIn(tz, date)
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s)
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Clock text in the profile's format: 24h "14:05", 12h "2:05pm". */
function hm(h: number, mi: number, h12: boolean, sec?: number): string {
  const s = sec === undefined ? '' : `:${pad(sec)}`
  if (!h12) return `${pad(h)}:${pad(mi)}${s}`
  return `${h % 12 || 12}:${pad(mi)}${s}${h < 12 ? 'am' : 'pm'}`
}
/** set per render from the widget config; the attribute carries it to tickClocks */
let H12 = false
const h12Attr = () => (H12 ? ' data-h12' : '')

/** ISO week number of a calendar date. */
function isoWeek(y: number, mo: number, d: number): number {
  const t = new Date(Date.UTC(y, mo - 1, d))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return Math.ceil(((t.getTime() - start.getTime()) / 86400000 + 1) / 7)
}

/**
 * When an event happens, as epoch ms. Prefers `at`; otherwise reads the producer's
 * "Thu 3:30pm" / "12:00pm" in the home zone. A bare time is today (or tomorrow when
 * tagged so); a weekday is its next occurrence, today included.
 */
export function eventTime(it: WidgetItem, tz: string, now = new Date()): number | null {
  if (it.at) {
    const t = Date.parse(it.at)
    if (Number.isFinite(t)) return t
  }
  const m = (it.meta ?? '').match(
    /^\s*(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i,
  )
  if (!m) return null
  let h = Number(m[2])
  const mi = Number(m[3] ?? 0)
  const ap = m[4]?.toLowerCase()
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  if (h > 23 || mi > 59) return null
  const p = partsIn(tz, now)
  let days = /tomorrow/i.test(it.tag ?? '') ? 1 : 0
  if (m[1]) {
    const want = WD.findIndex((w) => w.toLowerCase() === m[1]?.slice(0, 3).toLowerCase())
    days = (want - p.wd + 7) % 7
  }
  const deltaMin = days * 1440 + h * 60 + mi - (p.h * 60 + p.mi + p.s / 60)
  return now.getTime() + deltaMin * 60000
}

function until(ms: number): string {
  const m = Math.round(ms / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `in ${h}h${m % 60 ? ` ${m % 60}m` : ''}`
  return `in ${Math.round(h / 24)}d`
}

/** Status of an event row. An event counts as live for 30 minutes after it starts. */
function rowState(at: number, now: number): { cls: string; text: string } {
  const d = at - now
  if (d > 0) return { cls: 'up', text: until(d) }
  if (d > -30 * 60000) return { cls: 'live', text: 'now' }
  return { cls: 'done', text: 'done' }
}

function zoneState(h: number, work: Work): { cls: string; text: string } {
  if (h >= work.from && h < work.to) return { cls: 'work', text: 'working' }
  if (h >= 7 && h < 22) return { cls: 'awake', text: 'off hours' }
  return { cls: 'night', text: 'asleep' }
}

function relOffset(min: number): string {
  if (min === 0) return 'same'
  const sign = min > 0 ? '+' : '−'
  const a = Math.abs(min)
  return `${sign}${Math.floor(a / 60)}${a % 60 ? `:${pad(a % 60)}` : ''}h`
}

function dayLabel(p: Parts, work: Work): string {
  const nowMin = p.h * 60 + p.mi
  if (nowMin < work.from * 60) {
    const m = work.from * 60 - nowMin
    return `workday starts in ${Math.floor(m / 60)}h ${m % 60}m`
  }
  if (nowMin < work.to * 60) {
    const m = work.to * 60 - nowMin
    return `${Math.floor(m / 60)}h ${m % 60}m left in the workday`
  }
  return 'workday done'
}

function clockFace(): string {
  const ticks = Array.from({ length: 12 }, (_, i) => {
    const major = i % 3 === 0
    return `<line x1="30" y1="${major ? 3.5 : 4.5}" x2="30" y2="${major ? 8 : 6.5}" stroke="${major ? '#8892ad' : '#39415a'}"
      stroke-width="${major ? 1.4 : 1}" stroke-linecap="round" transform="rotate(${i * 30} 30 30)"/>`
  }).join('')
  return `<circle cx="30" cy="30" r="28" fill="#0a0d15" stroke="#232b3d" stroke-width="1"/>
    ${ticks}
    <line x1="30" y1="30" x2="30" y2="16" stroke="#e8ecf8" stroke-width="2.2" stroke-linecap="round" data-hand="h"/>
    <line x1="30" y1="30" x2="30" y2="9" stroke="#c8d1e6" stroke-width="1.4" stroke-linecap="round" data-hand="m"/>
    <line x1="30" y1="34" x2="30" y2="7" stroke="#ff7a45" stroke-width="0.9" stroke-linecap="round" data-hand="s"/>
    <circle cx="30" cy="30" r="1.8" fill="#ff7a45"/>`
}

/** Mon-first month grid for the home zone's current month; days with events are marked. */
function monthGrid(p: Parts, eventDays: Set<number>, sundayFirst = false): string {
  const first = new Date(Date.UTC(p.y, p.mo - 1, 1)).getUTCDay() // 0 Sun
  const lead = sundayFirst ? first : (first + 6) % 7
  const days = new Date(Date.UTC(p.y, p.mo, 0)).getUTCDate()
  const cells: string[] = []
  for (let i = 0; i < lead; i++) cells.push('<i class="pad"></i>')
  for (let d = 1; d <= days; d++) {
    const cls = [d === p.d ? 'today' : d < p.d ? 'past' : '', eventDays.has(d) ? 'has-ev' : '']
      .filter(Boolean)
      .join(' ')
    cells.push(`<i class="${cls}">${d}</i>`)
  }
  const month = new Date(Date.UTC(p.y, p.mo - 1, 1)).toLocaleString('en-GB', {
    month: 'long',
    timeZone: 'UTC',
  })
  return `<div class="mg">
    <div class="mg-h">${esc(month)} ${p.y}</div>
    <div class="mg-g">${(sundayFirst ? ['S', 'M', 'T', 'W', 'T', 'F', 'S'] : ['M', 'T', 'W', 'T', 'F', 'S', 'S']).map((x) => `<b>${x}</b>`).join('')}${cells.join('')}</div>
  </div>`
}

/** 52 week-cells in four quarter rows, current week lit. */
function yearGrid(week: number): string {
  let out = ''
  for (let q = 0; q < 4; q++) {
    const cells = Array.from({ length: 13 }, (_, i) => {
      const w = q * 13 + i + 1
      const cls = w === week ? 'now' : w < week ? 'past' : ''
      return `<i class="${cls}"></i>`
    }).join('')
    out += `<div class="yg-row"><em>Q${q + 1}</em>${cells}</div>`
  }
  return `<div class="yg">${out}</div>`
}

const VIEW_KEY = 'orbit:cal-view'
function calView(): 'month' | 'year' {
  try {
    return localStorage.getItem(VIEW_KEY) === 'year' ? 'year' : 'month'
  } catch {
    return 'month'
  }
}

export function calendarBody(w: Widget): string {
  const c = (w.config ?? {}) as {
    home?: string
    homeLabel?: string
    zones?: { label: string; tz: string }[]
    workday?: Partial<Work>
    clock?: string
    weekStart?: string
  }
  const home = c.home ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const work = workOf(c.workday)
  H12 = c.clock === '12h'
  const nowD = new Date()
  const now = nowD.getTime()
  const p = partsIn(home, nowD)
  const week = isoWeek(p.y, p.mo, p.d)
  const homeOff = offsetMin(home, nowD)
  const dateLine = new Intl.DateTimeFormat('en-GB', {
    timeZone: home,
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  }).format(nowD)

  const zones = (c.zones ?? [])
    .map((z) => {
      const zp = partsIn(z.tz, nowD)
      const st = zoneState(zp.h, work)
      const dayDiff = Date.UTC(zp.y, zp.mo - 1, zp.d) - Date.UTC(p.y, p.mo - 1, p.d)
      const dayTag = dayDiff < 0 ? 'yday' : dayDiff > 0 ? 'tmrw' : WD[zp.wd]
      return `<div class="z" data-zone="${esc(z.tz)}" data-work="${workAttr(work)}">
        <span class="z-l"><i class="z-dot ${st.cls}" title="${st.text}"></i>${esc(z.label)}</span>
        <b data-tz="${esc(z.tz)}"${h12Attr()}>${hm(zp.h, zp.mi, H12)}</b>
        <em>${esc(dayTag)} · ${relOffset(offsetMin(z.tz, nowD) - homeOff)}</em></div>`
    })
    .join('')

  // events: resolve instants, keep producer order within a day, sort across days
  const events = (w.items ?? [])
    .map((it, i) => ({ it, i, at: eventTime(it, home, nowD) }))
    .sort(
      (a, b) =>
        (a.at ?? Number.POSITIVE_INFINITY) - (b.at ?? Number.POSITIVE_INFINITY) || a.i - b.i,
    )
  const eventDays = new Set<number>()
  let nextMarked = false
  const rows = events
    .map(({ it, at }) => {
      if (at === null) {
        return `<div class="ev-row"><span class="ev-t">—</span>
          <span class="ev-n" title="${esc(it.title)}">${esc(it.title)}</span><em>${esc(it.meta ?? '')}</em></div>`
      }
      const ep = partsIn(home, new Date(at))
      if (ep.y === p.y && ep.mo === p.mo) eventDays.add(ep.d)
      const st = rowState(at, now)
      const isNext = !nextMarked && st.cls !== 'done'
      if (isNext) nextMarked = true
      const sameDay = ep.y === p.y && ep.mo === p.mo && ep.d === p.d
      const day = sameDay ? '' : `<small>${WD[ep.wd]}</small>`
      const dot = it.accent ? `<i style="background:${esc(it.accent)}"></i>` : '<i></i>'
      return `<div class="ev-row ${st.cls}${isNext ? ' next' : ''}" data-at="${at}">
        <span class="ev-t">${day}${hm(ep.h, ep.mi, H12)}</span>
        <span class="ev-n" title="${esc(it.title)}">${dot}<span>${esc(it.title)}</span></span>
        <em class="ev-s">${st.text}</em></div>`
    })
    .join('')

  const pct = ((p.h * 60 + p.mi) / 1440) * 100
  const view = calView()

  return `
    <div class="cal-top">
      <svg class="cal-face" viewBox="0 0 60 60" data-clockface data-home="${esc(home)}">${clockFace()}</svg>
      <div class="cal-main">
        <div class="cal-wk"><b>Wk${week}</b> · ${esc(dateLine)}</div>
        <div class="cal-time" data-tz="${esc(home)}" data-sec${h12Attr()}>${hm(p.h, p.mi, H12, p.s)}</div>
        <div class="cal-zone">${esc(c.homeLabel ?? home)}</div>
      </div>
    </div>
    <div class="dayb" data-dayprog="${esc(home)}" data-work="${workAttr(work)}">
      <div class="dayb-bar">
        <span class="dayb-work" style="left:${(work.from / 24) * 100}%;width:${((work.to - work.from) / 24) * 100}%"></span>
        <span class="dayb-fill" style="width:${pct.toFixed(2)}%"></span>
        <span class="dayb-now" style="left:${pct.toFixed(2)}%"></span>
      </div>
      <div class="dayb-ax"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
      <div class="dayb-l">${dayLabel(p, work)}</div>
    </div>
    ${zones ? `<div class="cal-zones">${zones}</div>` : ''}
    <div class="w-sec cal-sec">what's next</div>
    <div class="ev-list">${rows || '<div class="w-empty">Nothing scheduled.</div>'}</div>
    <div class="w-sec cal-sec">
      <span>${view === 'year' ? `year · week ${week} of 52` : 'this month'}</span>
      <span class="cal-seg"><button data-calview="month" class="${view === 'month' ? 'on' : ''}">month</button><button data-calview="year" class="${view === 'year' ? 'on' : ''}">year</button></span>
    </div>
    ${view === 'year' ? yearGrid(week) : monthGrid(p, eventDays, c.weekStart === 'sun')}`
}

/** Tick every live element: zone times, the analog hands, the day bar and countdowns. */
export function tickClocks(root: ParentNode) {
  const now = new Date()
  for (const el of root.querySelectorAll<HTMLElement>('[data-tz]')) {
    const tz = el.dataset.tz
    if (!tz) continue
    const p = partsIn(tz, now)
    el.textContent = hm(
      p.h,
      p.mi,
      el.hasAttribute('data-h12'),
      el.hasAttribute('data-sec') ? p.s : undefined,
    )
  }
  for (const z of root.querySelectorAll<HTMLElement>('[data-zone]')) {
    const st = zoneState(partsIn(z.dataset.zone ?? 'UTC', now).h, parseWork(z.dataset.work))
    const dot = z.querySelector('.z-dot')
    if (dot) {
      dot.className = `z-dot ${st.cls}`
      dot.setAttribute('title', st.text)
    }
  }
  for (const face of root.querySelectorAll<SVGElement>('[data-clockface]')) {
    const p = partsIn(face.dataset.home ?? Intl.DateTimeFormat().resolvedOptions().timeZone, now)
    const set = (sel: string, deg: number) =>
      face.querySelector(`[data-hand="${sel}"]`)?.setAttribute('transform', `rotate(${deg} 30 30)`)
    set('h', (p.h % 12) * 30 + p.mi * 0.5)
    set('m', p.mi * 6 + p.s * 0.1)
    set('s', p.s * 6)
  }
  for (const d of root.querySelectorAll<HTMLElement>('[data-dayprog]')) {
    const p = partsIn(d.dataset.dayprog ?? 'UTC', now)
    const pct = `${(((p.h * 60 + p.mi) / 1440) * 100).toFixed(2)}%`
    const fill = d.querySelector<HTMLElement>('.dayb-fill')
    const mark = d.querySelector<HTMLElement>('.dayb-now')
    const label = d.querySelector('.dayb-l')
    if (fill) fill.style.width = pct
    if (mark) mark.style.left = pct
    if (label) label.textContent = dayLabel(p, parseWork(d.dataset.work))
  }
  const t = now.getTime()
  for (const list of root.querySelectorAll('.ev-list')) {
    let nextMarked = false
    for (const row of list.querySelectorAll<HTMLElement>('.ev-row[data-at]')) {
      const st = rowState(Number(row.dataset.at), t)
      const isNext = !nextMarked && st.cls !== 'done'
      if (isNext) nextMarked = true
      row.className = `ev-row ${st.cls}${isNext ? ' next' : ''}`
      const s = row.querySelector('.ev-s')
      if (s) s.textContent = st.text
    }
  }
}

/** Month/year switch. Delegated once, because the rails re-render wholesale. */
export function bindCalendar(root: HTMLElement, rerender: () => void) {
  root.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-calview]')
    if (!b) return
    try {
      localStorage.setItem(VIEW_KEY, b.dataset.calview === 'year' ? 'year' : 'month')
    } catch {}
    rerender()
  })
}

/**
 * The compact card shown when the widget is collapsed: the home clock, the next event
 * with its countdown, and the day bar. Every live element reuses the attributes
 * tickClocks already drives, so the card keeps time without its own timer. All of
 * today's upcoming rows are rendered; CSS shows only the one tickClocks marks `.next`.
 */
export function calendarCompact(w: Widget): string {
  const c = (w.config ?? {}) as { home?: string; workday?: Partial<Work>; clock?: string }
  const home = c.home ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const work = workOf(c.workday)
  H12 = c.clock === '12h'
  const nowD = new Date()
  const now = nowD.getTime()
  const p = partsIn(home, nowD)
  const events = (w.items ?? [])
    .map((it) => ({ it, at: eventTime(it, home, nowD) }))
    .filter((e): e is { it: WidgetItem; at: number } => e.at !== null)
    .sort((a, b) => a.at - b.at)
  let marked = false
  const rows = events
    .map(({ it, at }) => {
      const st = rowState(at, now)
      const isNext = !marked && st.cls !== 'done'
      if (isNext) marked = true
      const ep = partsIn(home, new Date(at))
      const day = ep.d === p.d && ep.mo === p.mo ? '' : `${WD[ep.wd]} `
      return `<div class="ev-row ${st.cls}${isNext ? ' next' : ''}" data-at="${at}">
        <span class="ev-t">${day}${hm(ep.h, ep.mi, H12)}</span>
        <span class="ev-n" title="${esc(it.title)}"><span>${esc(it.title)}</span></span>
        <em class="ev-s">${st.text}</em></div>`
    })
    .join('')
  const pct = ((p.h * 60 + p.mi) / 1440) * 100
  return `<div class="wc wc-cal">
    <div class="wc-hero"><b data-tz="${esc(home)}"${h12Attr()}>${hm(p.h, p.mi, H12)}</b><em>${WD[p.wd]} ${p.d}</em></div>
    <div class="wc-side"><span class="wc-k">next</span>
      <div class="ev-list">${rows}<div class="wc-none">nothing ahead</div></div></div>
  </div>
  <div class="dayb wc-day" data-dayprog="${esc(home)}" data-work="${workAttr(work)}">
    <div class="dayb-bar">
      <span class="dayb-work" style="left:${(work.from / 24) * 100}%;width:${((work.to - work.from) / 24) * 100}%"></span>
      <span class="dayb-fill" style="width:${pct.toFixed(2)}%"></span>
      <span class="dayb-now" style="left:${pct.toFixed(2)}%"></span>
    </div><div class="dayb-l" hidden></div>
  </div>`
}
