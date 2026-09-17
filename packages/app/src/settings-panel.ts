/**
 * Settings: who you are, what is connected, how the app behaves, and where your data lives.
 *
 * Opened from the header gear or ⌘,. A sidebar of four sections, like macOS System Settings.
 * Profile edits are a draft until Save (⌘S); they feed the clocks, the calendar and the Gmail
 * feed's idea of "you". Connection actions and app switches apply at once. Destructive
 * actions confirm inline (click again) rather than with a browser dialog, and closing with
 * unsaved changes asks in the footer.
 */
import { glyph } from './glyphs.ts'
import { THEMES } from './themes.ts'

type Section = 'profile' | 'connections' | 'themes' | 'app' | 'privacy'
type Profile = {
  name: string
  preferredName: string
  emails: string[]
  location: string
  timeZone: string
  workday: { from: number; to: number }
  clock: '24h' | '12h'
  weekStart: 'mon' | 'sun'
}
type Gmail = {
  status: 'off' | 'unconfigured' | 'starting' | 'needs-connect' | 'live'
  error: string | null
  count: number
  at: number
  account?: string
  needs?: number
  unread?: number
  enabled: boolean
  configured: boolean
  pollSecs: number
}
type Settings = {
  profile: Profile
  macTimeZone: string
  connections: {
    gmail: Gmail
    calendar: { feeds: number; everyMins: number; at: number; count: number; error: string | null }
    index: { files: number; sources: number; builtAt: number; ms: number | null } | null
    agents: { meta?: string; waiting?: number } | null
    connectors: { id: string; name: string; via: string; live: boolean }[]
  }
  storage: Record<string, { path: string; ignored: boolean }>
}

export type AppApi = {
  layout: () => string
  setLayout: (m: 'arms' | 'rings' | 'force') => void
  groupBy: () => string
  setGrouping: (g: 'smart' | 'source' | 'project' | 'docType' | 'folder') => void
  theme: () => string
  setTheme: (id: string) => void
  railHidden: (i: number) => boolean
  setRail: (i: number, hidden: boolean) => void
  refreshWidgets: () => Promise<void> | void
  openIndex: (tab?: string) => void
  openControl: () => void
}

// ------------------------------------------------------------------- icons ----
const ICON: Record<string, string> = {
  profile:
    '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5"/>',
  connections:
    '<path d="M9 7V3.5M15 7V3.5"/><path d="M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0z"/><path d="M12 16v4.5"/>',
  app: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  themes:
    '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.5-1.4-1.8-1.4-3 0-.8.7-1.4 1.6-1.4h1.6a4.9 4.9 0 0 0 4.9-4.9c0-3.4-3.8-6-8.5-6z"/><circle cx="7.4" cy="10.4" r="1.2"/><circle cx="11.6" cy="7.7" r="1.2"/><circle cx="16" cy="9.6" r="1.2"/>',
  privacy:
    '<path d="M12 3 5 6v5.5c0 4.3 3 7.8 7 9.5 4-1.7 7-5.2 7-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
}
const icon = (k: string, cls = 'set-gl') =>
  ICON[k]
    ? `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`
    : glyph(k, cls)

const SECTIONS: [Section, string, string][] = [
  ['profile', 'Profile', 'You, your time zone and your working day'],
  ['connections', 'Connections', 'Services this brain syncs, live'],
  ['themes', 'Themes', 'How the whole brain is lit'],
  ['app', 'App', 'Layout, grouping and resets'],
  ['privacy', 'Privacy & data', 'Where everything is kept'],
]

// ----------------------------------------------------------------- helpers ----
const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[<>&"]/g,
    (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[m] as string,
  )
const ago = (t: number) => {
  if (!t) return 'never'
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
const dur = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Wall-clock parts in a zone. */
function wall(tz: string, now = new Date()) {
  const o = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      weekday: 'long',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  )
  return { h: Number(o.hour), mi: Number(o.minute), weekday: String(o.weekday ?? '') }
}
const clockText = (h: number, mi: number, h12: boolean) =>
  h12
    ? `${h % 12 || 12}:${String(mi).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`
    : `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`

/** Time zones grouped by region, labelled with their UTC offset. Built once. */
let zoneGroups: [string, { id: string; label: string }[]][] | null = null
function zones() {
  if (zoneGroups) return zoneGroups
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
  const ids = intl.supportedValuesOf?.('timeZone') ?? ['UTC']
  const now = new Date()
  const groups = new Map<string, { id: string; label: string; off: number }[]>()
  for (const id of ids) {
    let offText = ''
    try {
      offText =
        new Intl.DateTimeFormat('en', { timeZone: id, timeZoneName: 'shortOffset' })
          .formatToParts(now)
          .find((p) => p.type === 'timeZoneName')?.value ?? ''
    } catch {}
    const m = offText.match(/GMT([+-])(\d+)(?::(\d+))?/)
    const off = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0
    const region = id.includes('/') ? (id.split('/')[0] as string) : 'Other'
    const place = id.split('/').slice(1).join(' / ').replace(/_/g, ' ') || id
    const utc =
      off === 0
        ? 'UTC'
        : `UTC${off > 0 ? '+' : '−'}${Math.floor(Math.abs(off) / 60)}${Math.abs(off) % 60 ? `:${String(Math.abs(off) % 60).padStart(2, '0')}` : ''}`
    const list = groups.get(region) ?? []
    list.push({ id, label: `${place} · ${utc}`, off })
    groups.set(region, list)
  }
  zoneGroups = [...groups]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([r, list]) => [r, list.sort((a, b) => a.off - b.off || a.label.localeCompare(b.label))])
  return zoneGroups
}

// ------------------------------------------------------------------- state ----
const st = {
  root: null as HTMLElement | null,
  api: null as AppApi | null,
  section: 'profile' as Section,
  data: null as Settings | null,
  draft: null as Profile | null,
  emailInput: '',
  busy: '',
  error: '',
  notice: '',
  noticeTimer: 0,
  armed: '' as string, // an action waiting for its confirming second click
  armTimer: 0,
  closing: false, // footer is asking about unsaved changes
  returnFocus: null as HTMLElement | null,
  poll: 0,
}
const dirty = () =>
  !!st.data && !!st.draft && JSON.stringify(st.data.profile) !== JSON.stringify(st.draft)

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init)
  const body = (await r.json().catch(() => ({}))) as T & { error?: string }
  if (!r.ok) throw new Error(body.error ?? `${r.status} ${r.statusText}`)
  return body
}

async function load() {
  const d = await api<Settings>('/api/settings')
  const keep = dirty()
  st.data = d
  if (!keep) st.draft = clone(d.profile)
}

function notify(text: string) {
  st.notice = text
  clearTimeout(st.noticeTimer)
  st.noticeTimer = window.setTimeout(() => {
    st.notice = ''
    renderFoot()
  }, 3200)
}

async function run(label: string, fn: () => Promise<void>) {
  st.busy = label
  st.error = ''
  render()
  try {
    await fn()
  } catch (e) {
    st.error = e instanceof Error ? e.message : String(e)
  } finally {
    st.busy = ''
    render()
  }
}

/** First click arms a destructive action; a second click within 4s performs it. */
function armed(act: string): boolean {
  if (st.armed === act) {
    st.armed = ''
    clearTimeout(st.armTimer)
    return true
  }
  st.armed = act
  clearTimeout(st.armTimer)
  st.armTimer = window.setTimeout(() => {
    st.armed = ''
    render()
  }, 4000)
  render()
  return false
}
const confirmBtn = (act: string, label: string, armedLabel: string, extra = '') =>
  `<button class="danger${st.armed === act ? ' armed' : ''}" data-act="${act}"${extra}>${esc(st.armed === act ? armedLabel : label)}</button>`

// ---------------------------------------------------------------- profile ----
function profileSection(): string {
  const p = st.draft
  const d = st.data
  if (!p || !d) return ''
  const w = wall(p.timeZone)
  const mins = w.h * 60 + w.mi
  const left = p.workday.to * 60 - mins
  const dayState =
    mins < p.workday.from * 60
      ? `your workday starts at ${clockText(p.workday.from, 0, p.clock === '12h')}`
      : left > 0
        ? `${Math.floor(left / 60)}h ${left % 60}m left in your workday`
        : 'your workday is done'
  const who = p.preferredName || p.name
  const initial = who.trim().slice(0, 1).toUpperCase()
  const hours = (sel: number, from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => i + from)
      .map(
        (h) =>
          `<option value="${h}"${h === sel ? ' selected' : ''}>${clockText(h % 24, 0, p.clock === '12h')}${h === 24 ? ' (midnight)' : ''}</option>`,
      )
      .join('')
  const account = d.connections.gmail.account?.toLowerCase()
  const suggest = account && !p.emails.includes(account) ? account : ''
  const pct = (h: number) => `${((h / 24) * 100).toFixed(2)}%`
  const nowPct = `${((mins / 1440) * 100).toFixed(2)}%`

  return `
    <div class="set-hero">
      <div class="set-avatar${initial ? '' : ' empty'}">${initial ? esc(initial) : icon('profile', 'set-gl lg')}</div>
      <div class="set-hero-t">
        <b data-live="who">${who ? esc(who) : '<span class="set-dim">Your name</span>'}</b>
        <span>${clockText(w.h, w.mi, p.clock === '12h')} on ${esc(w.weekday)}<span data-live="loc">${p.location ? ` in ${esc(p.location)}` : ''}</span> · ${dayState}</span>
      </div>
    </div>

    <div class="set-group">
      <div class="set-gh">About you</div>
      <label class="set-f"><span>Full name</span><input data-p="name" value="${esc(p.name)}" placeholder="e.g. Jordan Smith" autocomplete="name" spellcheck="false"></label>
      <label class="set-f"><span>Call me<em>how the app greets you</em></span><input data-p="preferredName" value="${esc(p.preferredName)}" placeholder="e.g. Jordan" autocomplete="nickname" spellcheck="false"></label>
      <label class="set-f"><span>Location<em>shown beside the clock</em></span><input data-p="location" value="${esc(p.location)}" placeholder="e.g. Auckland" autocomplete="address-level2"></label>
      <div class="set-f top"><span>Email addresses<em>every address that is you — mail from these never lands in “needs you”</em></span>
        <div class="set-chips" data-chips>
          ${p.emails
            .map(
              (e, i) =>
                `<span class="set-chip${EMAIL.test(e) ? '' : ' bad'}" title="${EMAIL.test(e) ? '' : 'not a valid address'}">${esc(e)}<button data-act="email-rm" data-i="${i}" aria-label="Remove ${esc(e)}">×</button></span>`,
            )
            .join('')}
          <input data-email-in value="${esc(st.emailInput)}" placeholder="${p.emails.length ? 'add another' : 'name@company.com'}" autocomplete="email" spellcheck="false">
          ${suggest ? `<button class="set-suggest" data-act="email-add" data-v="${esc(suggest)}">+ ${esc(suggest)} <em>connected Gmail</em></button>` : ''}
        </div>
      </div>
    </div>

    <div class="set-group">
      <div class="set-gh">Time</div>
      <div class="set-f"><span>Home time zone<em>the calendar, clocks and world-clock offsets use this</em></span>
        <div class="set-stack">
          <select data-p="timeZone" aria-label="Home time zone">${zones()
            .map(
              ([region, list]) =>
                `<optgroup label="${esc(region)}">${list.map((z) => `<option value="${esc(z.id)}"${z.id === p.timeZone ? ' selected' : ''}>${esc(z.label)}</option>`).join('')}</optgroup>`,
            )
            .join('')}</select>
          ${p.timeZone !== d.macTimeZone ? `<button class="set-link" data-act="use-mac-tz">Use this Mac's time zone (${esc(d.macTimeZone.replace(/_/g, ' '))})</button>` : ''}
        </div>
      </div>
      <div class="set-f"><span>Workday</span>
        <div class="set-stack">
          <div class="set-row"><select data-p="workday.from" aria-label="Workday starts">${hours(p.workday.from, 0, 23)}</select><span class="set-dim">to</span><select data-p="workday.to" aria-label="Workday ends">${hours(p.workday.to, 1, 24)}</select>
            <span class="set-dim">${p.workday.to - p.workday.from}h</span></div>
          <div class="set-daybar" aria-hidden="true"><i style="left:${pct(p.workday.from)};width:${pct(p.workday.to - p.workday.from)}"></i><b style="left:${nowPct}"></b></div>
        </div>
      </div>
      <div class="set-f"><span>Clock</span>${seg('clock', [
        ['24h', clockText(14, 5, false)],
        ['12h', clockText(14, 5, true)],
      ])}</div>
      <div class="set-f"><span>Week starts on</span>${seg('weekStart', [
        ['mon', 'Monday'],
        ['sun', 'Sunday'],
      ])}</div>
    </div>`
}

function seg(key: 'clock' | 'weekStart', opts: [string, string][]) {
  const cur = st.draft?.[key]
  return `<span class="set-seg" role="radiogroup">${opts
    .map(
      ([v, l]) =>
        `<button role="radio" aria-checked="${cur === v}" data-seg="${key}" data-v="${v}" class="${cur === v ? 'on' : ''}">${esc(l)}</button>`,
    )
    .join('')}</span>`
}

// ------------------------------------------------------------ connections ----
function pill(kind: 'live' | 'warn' | 'off' | 'err', text: string) {
  return `<span class="set-pill ${kind}"><i></i>${esc(text)}</span>`
}

function card(o: {
  icon: string
  title: string
  sub: string
  pill: string
  body: string
  acts?: string
  danger?: string
}) {
  return `<article class="set-card">
    <header class="set-card-h"><span class="set-ico">${icon(o.icon)}</span>
      <div class="set-card-t"><b>${o.title}</b><span>${o.sub}</span></div></header>
    <div class="set-card-s">${o.pill}</div>
    <div class="set-card-b">${o.body}</div>
    ${o.acts || o.danger ? `<footer class="set-card-a">${o.acts ?? ''}<span class="set-grow"></span>${o.danger ?? ''}</footer>` : ''}
  </article>`
}

function connectionsSection(): string {
  const c = st.data?.connections
  if (!c) return ''
  const g = c.gmail
  const fig = (n: number | undefined, label: string) =>
    `<b class="set-fig">${(n ?? 0).toLocaleString()}</b> ${label}`

  const gmail = (() => {
    const base = { icon: 'mail', title: 'Gmail', sub: 'Gmail API · feeds the Email widget' }
    if (!g.enabled)
      return card({
        ...base,
        pill: pill('off', 'Off'),
        body: 'Turned off for this server (<code>GMAIL_FEED=0</code>).',
      })
    if (!g.configured) {
      return card({
        ...base,
        pill: pill('off', 'Not set up'),
        body: `<ol class="set-steps"><li>Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to <code>.env.local</code></li>
          <li>Add <code>http://localhost:5200/api/gmail/callback</code> as a redirect URI on that OAuth client</li><li>Restart the server</li></ol>`,
      })
    }
    if (g.status === 'needs-connect') {
      return card({
        ...base,
        pill: pill('warn', 'Not connected'),
        body: 'Sign in once with Google to let the brain read your inbox. Access is read-only.',
        acts: '<a class="set-btn primary" href="/api/gmail/connect" target="_blank" rel="noopener" data-act="connecting">Connect Gmail</a>',
      })
    }
    return card({
      ...base,
      pill: g.error ? pill('err', 'Sync failing') : pill('live', 'Live'),
      body: `<div class="set-acct">${esc(g.account ?? '')}</div>
        <div class="set-figs">${fig(g.count, 'in 7 days')}<span>·</span>${fig(g.unread, 'unread')}<span>·</span>${fig(g.needs, 'need you')}</div>
        <div class="set-meta">Synced ${ago(g.at)} · every ${g.pollSecs}s · read-only</div>
        ${g.error ? `<div class="set-err">${esc(g.error)}</div>` : ''}`,
      acts: `<button data-act="gmail-sync">Sync now</button><a class="set-btn" href="/api/gmail/connect" target="_blank" rel="noopener" data-act="connecting">Reconnect</a>`,
      danger: confirmBtn('gmail-disconnect', 'Disconnect', 'Click to revoke access'),
    })
  })()

  const cal = c.calendar
  const calendar = card({
    icon: 'calendar',
    title: 'Google Calendar',
    sub: 'iCal feed · feeds the Calendar widget',
    ...(cal.feeds
      ? {
          pill: cal.error ? pill('err', 'Sync failing') : pill('live', 'Live'),
          body: `<div class="set-figs">${fig(cal.feeds, cal.feeds === 1 ? 'calendar' : 'calendars')}<span>·</span>${fig(cal.count, 'upcoming events')}</div>
            <div class="set-meta">Synced ${ago(cal.at)} · every ${cal.everyMins}m</div>
            ${cal.error ? `<div class="set-err">${esc(cal.error)}</div>` : ''}`,
          acts: '<button data-act="cal-sync">Sync now</button>',
        }
      : {
          pill: pill('off', 'Not set up'),
          body: 'In Google Calendar, open <i>Settings → Integrate calendar</i> and copy the secret iCal address into <code>CALENDAR_ICS_URLS</code> in <code>.env.local</code>, then restart.',
        }),
  })

  const i = c.index
  const index = card({
    icon: 'brain',
    title: 'Brain index',
    sub: 'Local files · recall and the graph',
    pill: i ? pill('live', 'Indexed') : pill('warn', 'Building'),
    body: i
      ? `<div class="set-figs">${fig(i.files, 'files')}<span>·</span>${fig(i.sources, i.sources === 1 ? 'source' : 'sources')}</div>
         <div class="set-meta">Built ${ago(i.builtAt)}${i.ms ? ` in ${dur(i.ms)}` : ''}</div>`
      : '<div class="set-meta">Scanning…</div>',
    acts: '<button data-act="index-sources">Manage sources</button><button data-act="index">Index settings</button>',
  })

  const ag = c.agents
  const agents = card({
    icon: 'bolt',
    title: 'Claude Code',
    sub: 'Local sessions · the Agents widget',
    pill: ag
      ? pill((ag.waiting ?? 0) > 0 ? 'warn' : 'live', ag.meta ?? 'Watching')
      : pill('off', 'Unavailable'),
    body: '<div class="set-meta">Reads session transcripts on this Mac to show who is waiting on you and what is running.</div>',
    acts: '<button data-act="control">Open mission control</button>',
  })

  const live = c.connectors.filter((x) => x.live).length
  return `
    <div class="set-cards">${gmail}${calendar}${index}${agents}</div>
    <div class="set-group">
      <div class="set-gh">Claude connectors <span class="set-dim">${live} of ${c.connectors.length} connected</span></div>
      <p class="set-note">Agents use these through Claude — this app doesn't. Manage them in claude.ai → Settings → Connectors.</p>
      <div class="set-connectors">${c.connectors
        .map(
          (x) =>
            `<span class="${x.live ? 'on' : ''}" title="${esc(x.via)}"><i></i>${esc(x.name)}</span>`,
        )
        .join('')}</div>
    </div>`
}

// ----------------------------------------------------------------- themes ----
/**
 * Each card is painted by the theme it offers: `data-theme` scopes that theme's tokens onto
 * the card itself, so the swatch is the real palette rather than a copy that can drift.
 */
function themesSection(): string {
  const a = st.api
  if (!a) return ''
  const cur = a.theme()
  const cards = THEMES.map(
    (t) => `<button class="theme-card${t.id === cur ? ' on' : ''}" data-theme="${t.id}"
      data-act="theme" data-id="${t.id}" role="radio" aria-checked="${t.id === cur}" aria-label="${esc(t.name)}">
      <span class="theme-shot" aria-hidden="true">
        <span class="theme-bar"><i></i><i></i></span>
        <span class="theme-body"><span class="theme-rail"><b></b><b></b><b></b></span><span class="theme-main"></span></span>
      </span>
      <span class="theme-meta"><b>${esc(t.name)}${t.light ? '<em>Light</em>' : ''}</b><span>${esc(t.blurb)}</span></span>
      <span class="theme-tick" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg></span>
    </button>`,
  ).join('')
  return `
    <div class="set-group">
      <div class="set-gh">Appearance<span class="set-dim">Applies at once, kept in this browser</span></div>
      <div class="theme-grid" role="radiogroup" aria-label="Theme">${cards}</div>
    </div>
    <div class="set-group">
      <div class="set-gh">Note</div>
      <div class="set-f top"><span>The graph stays dark<em>Its nodes are drawn for a dark room, so the map and
        what floats on it keep Midnight's palette whatever the rest of the app is wearing.</em></span></div>
    </div>`
}

// -------------------------------------------------------------------- app ----
function appSection(): string {
  const a = st.api
  if (!a) return ''
  const segBtns = (act: string, cur: string, opts: [string, string][]) =>
    `<span class="set-seg" role="radiogroup">${opts
      .map(
        ([v, l]) =>
          `<button role="radio" aria-checked="${cur === v}" data-act="${act}" data-v="${v}" class="${cur === v ? 'on' : ''}">${l}</button>`,
      )
      .join('')}</span>`
  const toggle = (i: number, label: string) => {
    const on = !a.railHidden(i)
    return `<label class="set-toggle${on ? ' on' : ''}"><input type="checkbox" data-act="rail" data-i="${i}"${on ? ' checked' : ''}><i></i>${label}</label>`
  }
  return `
    <div class="set-group">
      <div class="set-gh">Graph</div>
      <div class="set-f"><span>Layout<em>also <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></em></span>${segBtns(
        'layout',
        a.layout(),
        [
          ['arms', 'ARMS'],
          ['rings', 'Rings'],
          ['force', 'Packed'],
        ],
      )}</div>
      <div class="set-f"><span>Group files by</span>${segBtns('group', a.groupBy(), [
        ['smart', 'Smart'],
        ['source', 'Source'],
        ['project', 'Project'],
        ['docType', 'Type'],
        ['folder', 'Folder'],
      ])}</div>
    </div>
    <div class="set-group">
      <div class="set-gh">Workspace</div>
      <div class="set-f"><span>Side columns<em>also <kbd>[</kbd> <kbd>]</kbd> · <kbd>\\</kbd> for graph only</em></span>
        <div class="set-row">${toggle(0, 'Left')}${toggle(1, 'Right')}</div></div>
      <div class="set-f"><span>Column widths<em>saved in this browser</em></span><div class="set-row"><button data-act="reset-widths">Reset to default</button></div></div>
      <div class="set-f"><span>Widgets<em>order, columns, heights, collapsed and hidden widgets</em></span>
        <div class="set-row">${confirmBtn('reset-layout', 'Reset all widgets', 'Click again to reset')}</div></div>
    </div>`
}

// ---------------------------------------------------------------- privacy ----
function privacySection(): string {
  const d = st.data
  if (!d) return ''
  const s = d.storage
  const where = (ignored: boolean | undefined) =>
    ignored === undefined
      ? ''
      : ignored
        ? pill('live', 'Not committed')
        : pill('warn', 'Committed to git')
  const row = (ico: string, what: string, path: string, note: string, ignored?: boolean) => `
    <div class="set-store">
      <span class="set-ico sm">${icon(ico)}</span>
      <div><b>${what}</b><code>${esc(path)}</code><span>${note}</span></div>
      <div class="set-store-s">${where(ignored)}</div>
    </div>`
  return `
    <div class="set-callout">${icon('privacy', 'set-gl lg')}
      <div><b>Runs on this Mac only</b><span>The server listens on 127.0.0.1 and refuses requests addressed to any other host.
        The only outside service it talks to is Google, to sync Gmail and Calendar.</span></div></div>
    <div class="set-group flush">
      ${row('link', 'Google app keys & calendar addresses', s.envLocal?.path ?? '.env.local', 'Secrets', s.envLocal?.ignored)}
      ${row('mail', 'Gmail sign-in', 'macOS Keychain · laika-1brain gmail', 'Read-only access. Disconnect revokes it at Google.')}
      ${row('profile', 'Your profile', s.profile?.path ?? '', 'Name, addresses, time zone', s.profile?.ignored)}
      ${row('chart', 'Synced email & calendar', s.synced?.path ?? '', 'Account, counts, unread senders and subjects, event titles', s.synced?.ignored)}
      ${row('apps', 'Widget layout', s.widgetLayout?.path ?? '', 'Order, sizes, collapsed', s.widgetLayout?.ignored)}
      ${row('doc', 'What gets indexed', s.indexConfig?.path ?? '', 'Sources and rules', s.indexConfig?.ignored)}
      ${row('app', 'Column widths & views', 'This browser', 'Per-device conveniences')}
    </div>`
}

// ------------------------------------------------------------------ render ----
function footHtml(): string {
  const changed = st.section === 'profile' && dirty()
  if (st.closing) {
    return `<span class="set-state warn-t">You have unsaved profile changes.</span>
      <button data-act="close-keep">Keep editing</button><button class="danger" data-act="close-discard">Discard & close</button>
      <button class="primary" data-act="close-save">Save & close</button>`
  }
  const state = st.busy
    ? `<i class="set-spin"></i>${esc(st.busy)}…`
    : st.error
      ? `<b class="set-err-t">${esc(st.error)}</b>`
      : st.notice
        ? `<b class="set-ok-t">✓ ${esc(st.notice)}</b>`
        : changed
          ? '<span class="set-dim">Unsaved changes · <kbd>⌘</kbd><kbd>S</kbd> to save</span>'
          : ''
  const buttons =
    st.section === 'profile'
      ? `<button data-act="discard"${changed ? '' : ' disabled'}>Discard</button><button class="primary" data-act="save"${changed && !st.busy ? '' : ' disabled'}>Save</button>`
      : ''
  return `<span class="set-state">${state}</span>${buttons}`
}

function renderFoot() {
  const f = st.root?.querySelector('.set-foot')
  if (f) f.innerHTML = footHtml()
}

function render() {
  const root = st.root
  if (!root) return
  // keep focus (and the caret) where the person is typing across a re-render
  const active = document.activeElement as HTMLInputElement | null
  const focusSel =
    active && root.contains(active)
      ? active.dataset.p
        ? `[data-p="${active.dataset.p}"]`
        : active.hasAttribute('data-email-in')
          ? '[data-email-in]'
          : active.dataset.sec
            ? `[data-sec="${active.dataset.sec}"]`
            : active.dataset.act
              ? `[data-act="${active.dataset.act}"]${active.dataset.v ? `[data-v="${active.dataset.v}"]` : ''}`
              : null
      : null
  const caret = active && 'selectionStart' in active ? active.selectionStart : null
  const scroll = root.querySelector('.set-body')?.scrollTop ?? 0

  const body = !st.data
    ? '<div class="set-skel"><i></i><i></i><i></i></div>'
    : st.section === 'profile'
      ? profileSection()
      : st.section === 'connections'
        ? connectionsSection()
        : st.section === 'themes'
          ? themesSection()
          : st.section === 'app'
            ? appSection()
            : privacySection()
  const title = SECTIONS.find(([k]) => k === st.section)
  const c = st.data?.connections
  const attention =
    !!c && (c.gmail.status === 'needs-connect' || !!c.gmail.error || !!c.calendar.error)

  root.innerHTML = `<div class="set-win" role="dialog" aria-modal="true" aria-labelledby="set-title">
    <nav class="set-nav" aria-label="Settings sections">
      <div class="set-nav-h">Settings</div>
      ${SECTIONS.map(
        ([
          k,
          l,
        ]) => `<button data-sec="${k}" class="${st.section === k ? 'on' : ''}" aria-current="${st.section === k ? 'page' : 'false'}">
          ${icon(k)}<span>${l}</span>${k === 'connections' && attention ? '<i class="set-dot" title="Needs attention"></i>' : ''}
          ${k === 'profile' && dirty() ? '<i class="set-dot blue" title="Unsaved"></i>' : ''}</button>`,
      ).join('')}
      <div class="set-nav-f">laika·orbit<br><span>local · 127.0.0.1</span></div>
    </nav>
    <section class="set-main">
      <header class="set-head"><div><h2 id="set-title">${title?.[1] ?? ''}</h2><span>${title?.[2] ?? ''}</span></div>
        <button class="set-x" data-act="close" aria-label="Close settings" title="Close (esc)">×</button></header>
      <div class="set-body" data-section="${st.section}">${body}</div>
      <footer class="set-foot">${footHtml()}</footer>
    </section>
  </div>`

  const b = root.querySelector('.set-body')
  if (b) b.scrollTop = scroll
  if (focusSel) {
    const el = root.querySelector<HTMLInputElement>(focusSel)
    if (el) {
      el.focus({ preventScroll: true })
      if (caret != null && 'setSelectionRange' in el) {
        try {
          el.setSelectionRange(caret, caret)
        } catch {}
      }
    }
  }
}

// ------------------------------------------------------------------ events ----
function setDraft(key: string, raw: string) {
  const p = st.draft
  if (!p) return
  if (key === 'workday.from') p.workday = { ...p.workday, from: Number(raw) }
  else if (key === 'workday.to') p.workday = { ...p.workday, to: Number(raw) }
  else if (key === 'name' || key === 'preferredName' || key === 'location' || key === 'timeZone')
    p[key] = raw
}

function addEmails(raw: string) {
  const p = st.draft
  if (!p) return
  for (const e of raw
    .split(/[\s,;]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)) {
    if (!p.emails.includes(e)) p.emails.push(e)
  }
  st.emailInput = ''
}

async function save(): Promise<boolean> {
  if (st.draft?.emails.some((e) => !EMAIL.test(e))) {
    st.error = 'Fix the highlighted email address first'
    render()
    return false
  }
  let ok = false
  await run('Saving', async () => {
    const r = await api<{ profile: Profile }>('/api/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(st.draft),
    })
    if (st.data) st.data.profile = r.profile
    st.draft = clone(r.profile)
    ok = true
    notify('Saved — the calendar and clocks use it now')
    await st.api?.refreshWidgets()
  })
  return ok
}

function bind(root: HTMLElement) {
  root.addEventListener('mousedown', (e) => {
    // clicks on the dimmed backdrop close; a drag that ends there does not
    if (e.target === root) root.dataset.down = '1'
  })
  root.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement
    if (t === root && root.dataset.down) {
      delete root.dataset.down
      return close()
    }
    delete root.dataset.down
    if (t.closest('[data-chips]') && t === t.closest('[data-chips]')) {
      root.querySelector<HTMLInputElement>('[data-email-in]')?.focus()
      return
    }
    const sec = t.closest<HTMLElement>('[data-sec]')?.dataset.sec as Section | undefined
    if (sec) {
      st.section = sec
      st.error = ''
      st.armed = ''
      render()
      root.querySelector<HTMLElement>('.set-body')?.scrollTo(0, 0)
      return
    }
    const sg = t.closest<HTMLElement>('[data-seg]')
    if (sg && st.draft) {
      ;(st.draft as Record<string, unknown>)[sg.dataset.seg as string] = sg.dataset.v
      return render()
    }
    const a = t.closest<HTMLElement>('[data-act]')
    if (!a || (a as HTMLButtonElement).disabled) return
    const app = st.api
    const act = a.dataset.act as string
    if (act !== st.armed && !['gmail-disconnect', 'reset-layout'].includes(act)) st.armed = ''
    switch (act) {
      case 'close':
        return close()
      case 'close-keep':
        st.closing = false
        return renderFoot()
      case 'close-discard':
        st.closing = false
        if (st.data) st.draft = clone(st.data.profile)
        return close()
      case 'close-save':
        st.closing = false
        if (await save()) close()
        return
      case 'use-mac-tz':
        if (st.draft && st.data) st.draft.timeZone = st.data.macTimeZone
        return render()
      case 'email-rm':
        st.draft?.emails.splice(Number(a.dataset.i), 1)
        return render()
      case 'email-add':
        addEmails(a.dataset.v ?? '')
        return render()
      case 'discard':
        if (st.data) st.draft = clone(st.data.profile)
        st.error = ''
        return render()
      case 'save':
        await save()
        return
      case 'connecting':
        notify('Finish signing in with Google in the new tab — this updates when it lands')
        return renderFoot()
      case 'gmail-sync':
        return run('Syncing Gmail', async () => {
          await api<unknown>('/api/gmail/sync', { method: 'POST' })
          await load()
          await app?.refreshWidgets()
          notify('Gmail synced')
        })
      case 'gmail-disconnect':
        if (!armed(act)) return
        return run('Disconnecting', async () => {
          const r = await api<{ revoked: boolean }>('/api/gmail/disconnect', { method: 'POST' })
          await load()
          await app?.refreshWidgets()
          notify(
            r.revoked
              ? 'Disconnected and revoked at Google'
              : 'Disconnected (Google did not confirm the revoke)',
          )
        })
      case 'cal-sync':
        return run('Syncing calendar', async () => {
          await api<unknown>('/api/calendar/sync', { method: 'POST' })
          await load()
          await app?.refreshWidgets()
          notify('Calendar synced')
        })
      case 'index':
        close()
        return app?.openIndex()
      case 'index-sources':
        close()
        return app?.openIndex('sources')
      case 'control':
        close()
        return app?.openControl()
      case 'theme':
        app?.setTheme(a.dataset.id as string)
        return render()
      case 'layout':
        app?.setLayout(a.dataset.v as 'arms' | 'rings' | 'force')
        return render()
      case 'group':
        app?.setGrouping(a.dataset.v as 'smart' | 'source' | 'project' | 'docType' | 'folder')
        return render()
      case 'reset-widths':
        try {
          localStorage.removeItem('1brain:rail-l-w')
          localStorage.removeItem('1brain:rail-r-w')
        } catch {}
        document.documentElement.style.removeProperty('--rail-l')
        document.documentElement.style.removeProperty('--rail-r')
        notify('Column widths reset')
        return renderFoot()
      case 'reset-layout':
        if (!armed(act)) return
        return run('Resetting widgets', async () => {
          await api<unknown>('/api/settings/reset-layout', { method: 'POST' })
          await app?.refreshWidgets()
          notify('Widgets reset to default')
        })
    }
  })

  root.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement
    if (el.dataset.act === 'rail') {
      st.api?.setRail(Number(el.dataset.i), !el.checked)
      return render()
    }
    // Only selects re-render on change. A text field's change fires on blur — i.e. on the
    // mousedown of the Save button — and re-rendering then would swallow that click.
    if (el.dataset.p && el.tagName === 'SELECT') {
      setDraft(el.dataset.p, el.value)
      render()
    }
  })

  root.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement
    if (el.hasAttribute('data-email-in')) {
      st.emailInput = el.value
      return
    }
    if (!el.dataset.p || el.tagName === 'SELECT') return
    setDraft(el.dataset.p, el.value)
    // live bits of the hero, without re-rendering the field being typed in
    const p = st.draft
    const who = root.querySelector('[data-live="who"]')
    if (who && p)
      who.innerHTML =
        p.preferredName || p.name
          ? esc(p.preferredName || p.name)
          : '<span class="set-dim">Your name</span>'
    const loc = root.querySelector('[data-live="loc"]')
    if (loc && p) loc.textContent = p.location ? ` in ${p.location}` : ''
    const av = root.querySelector('.set-avatar')
    const init = (p?.preferredName || p?.name || '').trim().slice(0, 1).toUpperCase()
    if (av && init) {
      av.classList.remove('empty')
      av.textContent = init
    }
    renderFoot()
    const nav = root.querySelector('[data-sec="profile"]')
    if (nav && dirty() && !nav.querySelector('.set-dot'))
      nav.insertAdjacentHTML('beforeend', '<i class="set-dot blue" title="Unsaved"></i>')
  })

  root.addEventListener('keydown', (e) => {
    const el = e.target as HTMLInputElement
    if (el.hasAttribute('data-email-in')) {
      if (e.key === 'Enter' || e.key === ',' || e.key === ' ' || e.key === 'Tab') {
        if (el.value.trim()) {
          e.preventDefault()
          addEmails(el.value)
          render()
        }
      } else if (e.key === 'Backspace' && !el.value && st.draft?.emails.length) {
        st.draft.emails.pop()
        render()
      }
      return
    }
    // ↑/↓ move between sections when the sidebar has focus
    if (el.dataset.sec && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      const i = SECTIONS.findIndex(([k]) => k === st.section)
      const next =
        SECTIONS[(i + (e.key === 'ArrowDown' ? 1 : SECTIONS.length - 1)) % SECTIONS.length]
      if (next) {
        st.section = next[0]
        render()
        root.querySelector<HTMLElement>(`[data-sec="${next[0]}"]`)?.focus()
      }
    }
  })
  // paste a list of addresses straight into the chips
  root.addEventListener('paste', (e) => {
    const el = e.target as HTMLElement
    if (!el.hasAttribute('data-email-in')) return
    const text = e.clipboardData?.getData('text') ?? ''
    if (/[\s,;]/.test(text.trim())) {
      e.preventDefault()
      addEmails(text)
      render()
    }
  })
}

function onKey(e: KeyboardEvent) {
  const root = st.root
  if (!root?.classList.contains('on')) return
  if (e.key === 'Escape') {
    e.stopImmediatePropagation()
    e.preventDefault()
    if (st.armed) {
      st.armed = ''
      return render()
    }
    if (st.closing) {
      st.closing = false
      return renderFoot()
    }
    return close()
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'Enter')) {
    e.preventDefault()
    e.stopImmediatePropagation()
    if (st.section === 'profile' && dirty() && !st.busy) save()
    return
  }
  if (e.key === 'Tab') {
    // keep focus inside the dialog
    const f = [
      ...root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input, select, textarea',
      ),
    ].filter((x) => x.offsetParent !== null)
    if (!f.length) return
    const first = f[0] as HTMLElement
    const last = f[f.length - 1] as HTMLElement
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }
}

function close() {
  if (dirty()) {
    st.closing = true
    return renderFoot()
  }
  st.closing = false
  st.armed = ''
  st.root?.classList.remove('on')
  clearInterval(st.poll)
  removeEventListener('keydown', onKey, true)
  st.returnFocus?.focus?.()
}

export function initSettings(api: AppApi) {
  st.api = api
}

export async function openSettings(section?: Section) {
  if (!st.root) {
    st.root = document.createElement('div')
    st.root.id = 'settings'
    document.body.appendChild(st.root)
    bind(st.root)
  }
  if (st.root.classList.contains('on')) {
    if (section) {
      st.section = section
      render()
    }
    return
  }
  st.returnFocus = document.activeElement as HTMLElement | null
  if (section) st.section = section
  st.notice = ''
  st.error = ''
  st.closing = false
  st.root.classList.add('on')
  addEventListener('keydown', onKey, true)
  render()
  st.root.querySelector<HTMLElement>(`[data-sec="${st.section}"]`)?.focus({ preventScroll: true })
  await run('Loading', load)
  // live status: a Google sign-in finishing in another tab, a sync landing
  clearInterval(st.poll)
  st.poll = window.setInterval(async () => {
    if (st.busy || document.hidden || st.section === 'profile' || st.armed) return
    try {
      const before = JSON.stringify(st.data?.connections)
      await load()
      if (JSON.stringify(st.data?.connections) !== before) render()
    } catch {}
  }, 4000)
}
