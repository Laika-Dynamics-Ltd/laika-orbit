/**
 * Widget layer for the OS view.
 *
 * Structure follows the reference: two widget rails flanking the graph, which is
 * the centrepiece rather than one panel among many. Widgets are data, not code —
 * the server returns whatever JSON lives in brain/widgets/, and this renders by
 * `kind`, so adding a widget is adding a file.
 */
import { calendarBody, calendarCompact } from './calendar.ts'
import { glyph, hasGlyph, KIND_GLYPH } from './glyphs.ts'
import { type Summary, summaryBody, summaryCompact } from './summary-card.ts'

export { tickClocks } from './calendar.ts'

export type WidgetItem = {
  title: string
  meta?: string
  tag?: string
  badge?: string
  at?: string
  href?: string
  /** handled in the app instead of opening href, like WidgetAction.action */
  action?: string
  accent?: string
  /** glyph key from glyphs.ts; tiles fall back to the item's initial, never to a blank */
  icon?: string
}

export type Segment = { label: string; n: number; accent?: string }

/**
 * A header button. `action` is handled in the app (e.g. `brain-window`); `href` opens
 * a link. Kinds do not get actions of their own — the widget file declares them.
 */
export type WidgetAction = { label: string; action?: string; href?: string }

export type Widget = {
  id: string
  kind: 'calendar' | 'metric' | 'table' | 'deck' | 'applist' | 'list' | 'feed' | 'links' | 'summary'
  title: string
  source: string
  refreshedAt?: string
  href?: string
  rail?: 'left' | 'right'
  order?: number
  /** title glyph; defaults by kind (KIND_GLYPH) */
  icon?: string
  config?: Record<string, unknown>
  items?: WidgetItem[]
  actions?: WidgetAction[]
  /** from the gear (brain/widgets/_settings.json), merged in by the server */
  collapsed?: boolean
  hidden?: boolean
  /** show at most this many items */
  maxItems?: number
  /** fixed height in px from the resize handle; absent = fit content */
  height?: number
  /** the raw overrides, so the settings panel can show and reset them */
  settings?: Record<string, unknown>
}

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[<>&"]/g,
    (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[m] as string,
  )

const ago = (iso?: string) => {
  if (!iso) return ''
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (!Number.isFinite(s)) return ''
  if (s < 90) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

/** Kinds whose content is hand-kept rather than synced; age alone says nothing about them. */
const STATIC_KINDS = new Set<Widget['kind']>(['applist', 'deck', 'links'])

function isStale(w: Widget): boolean {
  if (!w.refreshedAt) return false
  if (w.config?.staleAfterMins === undefined && STATIC_KINDS.has(w.kind)) return false
  const limit = Number(w.config?.staleAfterMins ?? 60)
  return (Date.now() - Date.parse(w.refreshedAt)) / 60000 > limit
}

function metricBody(w: Widget): string {
  const c = (w.config ?? {}) as {
    value?: string
    valueLabel?: string
    flaggedLabel?: string
    segments?: Segment[]
    footer?: string
    /** shown in place of the list when there are no items */
    empty?: string
  }
  const segs = c.segments ?? []
  const total = segs.reduce((a, s) => a + s.n, 0) || 1
  return `
    ${
      c.value
        ? `<div class="m-top"><b>${esc(c.value)}</b>
           <span>${esc(c.valueLabel ?? '')
             .split('\\n')
             .map(esc)
             .join('<br>')}</span></div>`
        : ''
    }
    ${c.flaggedLabel ? `<div class="w-sec">${esc(c.flaggedLabel)}</div>` : ''}
    <div class="w-items">${
      (w.items ?? []).length
        ? (w.items ?? [])
            .map((it) => {
              // a row with an href (e.g. a Gmail thread) opens it
              const tag = it.href ? 'a' : 'div'
              const link = it.href ? ` href="${esc(it.href)}" target="_blank" rel="noopener"` : ''
              return `<${tag} class="w-item nx"${link}>
        <span class="w-t" title="${esc(it.title)}">${it.accent ? `<i style="background:${esc(it.accent)}"></i>` : '<i></i>'}<span class="w-tx">${esc(it.title)}</span></span>
        <em>${esc(it.meta ?? '')}</em></${tag}>`
            })
            .join('')
        : c.empty
          ? `<div class="w-empty">${esc(c.empty)}</div>`
          : ''
    }</div>
    ${
      segs.length
        ? `<div class="w-sec">breakdown</div>
      <div class="segbar">${segs
        .map(
          (s) =>
            `<i style="width:${((s.n / total) * 100).toFixed(1)}%;background:${esc(s.accent ?? '#5b9dff')}" title="${esc(s.label)} ${s.n}"></i>`,
        )
        .join('')}</div>
      <div class="seglegend">${segs
        .map((s) => `<span><b>${s.n}</b> ${esc(s.label)}</span>`)
        .join('')}</div>`
        : ''
    }
    ${c.footer ? `<div class="m-foot">● ${esc(c.footer)}</div>` : ''}`
}

function tableBody(w: Widget): string {
  const cols = ((w.config?.columns as string[]) ?? ['TIME', 'NAME', 'STATUS']).map(esc)
  return `<div class="tbl">
    <div class="tr th"><span>${cols[0]}</span><span>${cols[1]}</span><span>${cols[2]}</span></div>
    ${(w.items ?? [])
      .map(
        (it) => `<div class="tr${it.accent ? ' hot' : ''}">
        <span class="tm">${esc(it.meta ?? '')}</span>
        <span class="tn">${esc(it.title)}${it.badge ? `<em>${esc(it.badge)}</em>` : ''}</span>
        <span class="ts ${esc((it.tag ?? '').toLowerCase())}">${esc(it.tag ?? '')}</span></div>`,
      )
      .join('')}</div>`
}

function deckBody(w: Widget): string {
  return `<div class="deck">${(w.items ?? [])
    .map(
      (it) => `<div class="card">
      <div class="c-t">${esc(it.title)}</div>
      <div class="c-m">${esc(it.meta ?? '')}</div>
      <div class="c-b"><button class="c-run" title="run">▸</button>
        ${it.tag ? `<span class="c-tag">${esc(it.tag)}</span>` : ''}</div></div>`,
    )
    .join('')}</div>`
}

/** First letter or digit of a name — the tile fallback when an item carries no glyph. */
const initial = (t: string) => (t.match(/[\p{L}\p{N}]/u)?.[0] ?? '·').toUpperCase()

const appTarget = (it: WidgetItem) =>
  it.action
    ? `data-action="${esc(it.action)}" role="button" tabindex="0"`
    : it.href
      ? `href="${esc(it.href)}" target="_blank" rel="noopener"`
      : ''

function appListBody(w: Widget): string {
  return `<div class="applist">${(w.items ?? [])
    .map(
      (it) => `<a class="app" ${appTarget(it)}>
      <span class="a-i">${hasGlyph(it.icon) ? glyph(it.icon) : `<b class="a-l">${esc(initial(it.title))}</b>`}</span>
      <span><b>${esc(it.title)}</b><em>${esc(it.meta ?? '')}</em></span>
      <span class="a-x">→</span></a>`,
    )
    .join('')}</div>`
}

function listBody(w: Widget): string {
  const items = w.items ?? []
  if (!items.length) {
    return `<div class="w-empty">${esc(w.config?.empty ?? 'Nothing here yet.')}</div>`
  }
  return `<div class="w-items">${items
    .map(
      (
        it,
      ) => `${it.href ? `<a class="w-item nx" href="${esc(it.href)}" target="_blank" rel="noopener">` : '<div class="w-item nx">'}
      <span class="w-t" title="${esc(it.title)}">${it.accent ? `<i style="background:${esc(it.accent)}"></i>` : '<i></i>'}<span class="w-tx">${esc(it.title)}</span></span>
      <em>${esc(it.meta ?? '')}</em>${it.href ? '</a>' : '</div>'}`,
    )
    .join('')}</div>`
}

// Every panel led with the same grip dots, so a rail read as one repeated element.
// The reference leads each title with its own mark (grip, then ✉ / ⚡ / ⏱).
function titleGlyph(w: Widget): string {
  const key = hasGlyph(w.icon) ? w.icon : KIND_GLYPH[w.kind]
  return key ? glyph(key, 'gl w-gl') : ''
}

const GEAR = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M9.4 1.1l.3 1.6c.4.1.8.3 1.1.5l1.4-.9 1.5 1.5-.9 1.4c.2.3.4.7.5 1.1l1.6.3v2.2l-1.6.3c-.1.4-.3.8-.5 1.1l.9 1.4-1.5 1.5-1.4-.9c-.3.2-.7.4-1.1.5l-.3 1.6H7.2l-.3-1.6c-.4-.1-.8-.3-1.1-.5l-1.4.9-1.5-1.5.9-1.4c-.2-.3-.4-.7-.5-1.1l-1.6-.3V6.9l1.6-.3c.1-.4.3-.8.5-1.1l-.9-1.4 1.5-1.5 1.4.9c.3-.2.7-.4 1.1-.5l.3-1.6h2.2zM8.3 5.6a2.4 2.4 0 100 4.8 2.4 2.4 0 000-4.8z"/></svg>`

const CHEVRON = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`

/**
 * The collapsed card, like a small iPhone widget: one hero figure and the single most
 * useful line beside it. Built from the same data as the full body, per kind.
 */
function compactBody(w: Widget): string {
  const items = w.items ?? []
  const c = (w.config ?? {}) as Record<string, unknown>
  const dot = (it: WidgetItem | undefined) =>
    it?.accent ? `<i style="background:${esc(it.accent)}"></i>` : '<i></i>'
  const line = (it: WidgetItem | undefined, k: string) =>
    it
      ? `<span class="wc-k">${esc(k)}</span><span class="wc-line" title="${esc(it.title)}">${dot(it)}<span>${esc(it.title)}</span><em>${esc(it.meta ?? '')}</em></span>`
      : `<span class="wc-k">${esc(k)}</span><span class="wc-line"><span class="wc-dim">${esc(c.empty ?? 'nothing yet')}</span></span>`
  const hero = (value: unknown, label: unknown) =>
    `<div class="wc-hero"><b>${esc(value)}</b><em>${esc(String(label ?? '').replace(/\\n|\n/g, ' '))}</em></div>`
  /** "2/6 fired today" → hero "2/6", label "fired today" */
  const split = (s: unknown): [string, string] => {
    const m = String(s ?? '').match(/^(\S+)\s+(.*)$/)
    return m ? [m[1] as string, m[2] as string] : [String(s ?? ''), '']
  }

  switch (w.kind) {
    case 'calendar':
      return calendarCompact(w)
    case 'summary':
      return summaryCompact((c.summary as Summary | undefined) ?? null)
    case 'metric': {
      const segs = (c.segments as Segment[] | undefined) ?? []
      const total = segs.reduce((a, s) => a + s.n, 0) || 1
      const bar = segs.length
        ? `<div class="segbar wc-bar">${segs
            .map(
              (s) =>
                `<i style="width:${((s.n / total) * 100).toFixed(1)}%;background:${esc(s.accent ?? '#5b9dff')}"></i>`,
            )
            .join('')}</div>`
        : ''
      return `<div class="wc">${hero(c.value ?? items.length, c.valueLabel ?? 'items')}
        <div class="wc-side">${line(
          items[0],
          String(c.flaggedLabel ?? 'top')
            .split('·')[0]
            ?.trim() ?? 'top',
        )}</div></div>${bar}`
    }
    case 'table': {
      const next =
        items.find((it) => /next|running|live/i.test(it.tag ?? '')) ??
        items.find((it) => !/fired|done|ok/i.test(it.tag ?? '')) ??
        items[0]
      const [v, label] = c.meta ? split(c.meta) : [String(items.length), 'rows']
      const row = next
        ? `<span class="wc-k">next</span><span class="wc-line" title="${esc(next.title)}"><b class="wc-time">${esc(next.meta ?? '')}</b><span>${esc(next.title)}</span><em class="wc-tag">${esc(next.tag ?? '')}</em></span>`
        : line(undefined, 'next')
      return `<div class="wc">${hero(v, label)}<div class="wc-side">${row}</div></div>`
    }
    case 'deck':
      return `<div class="wc">${hero(items.length, items.length === 1 ? 'item' : 'items')}
        <div class="wc-side wc-chips">${items
          .slice(0, 6)
          .map((it) => `<span title="${esc(it.meta ?? '')}">${esc(it.title)}</span>`)
          .join('')}</div></div>`
    case 'applist':
      return `<div class="wc-apps">${items
        .slice(0, 6)
        .map(
          (it) =>
            `<a class="wc-app" title="${esc(it.title)}" ${appTarget(it)}>
          <span class="a-i">${hasGlyph(it.icon) ? glyph(it.icon) : `<b class="a-l">${esc(initial(it.title))}</b>`}</span>
          <em>${esc(it.title)}</em></a>`,
        )
        .join('')}</div>`
    default: {
      // lists: a numeric "waiting" style count is the hero when the producer gives one
      const [v, label] =
        typeof c.waiting === 'number'
          ? [String(c.waiting), 'waiting']
          : c.meta
            ? split(c.meta)
            : [String(items.length), items.length === 1 ? 'item' : 'items']
      return `<div class="wc">${hero(v, label)}<div class="wc-side">${line(items[0], 'latest')}</div></div>`
    }
  }
}

export function renderWidget(src: Widget): string {
  const w = src.maxItems && src.items ? { ...src, items: src.items.slice(0, src.maxItems) } : src
  const body =
    w.kind === 'calendar'
      ? calendarBody(w)
      : w.kind === 'summary'
        ? summaryBody((w.config?.summary as Summary | undefined) ?? null, {
            nextAt: w.config?.nextAt as number | null,
            recap: w.config?.recap as Summary | null,
          })
        : w.kind === 'metric'
          ? metricBody(w)
          : w.kind === 'table'
            ? tableBody(w)
            : w.kind === 'deck'
              ? deckBody(w)
              : w.kind === 'applist'
                ? appListBody(w)
                : listBody(w)

  const title = w.href
    ? `<a href="${esc(w.href)}" target="_blank" rel="noopener">${esc(w.title)}</a>`
    : esc(w.title)
  // age is always shown quietly; it only takes the warning colour past the widget's limit
  const stale = isStale(w)
  const meta = `<span class="w-src${stale ? ' stale' : ''}"${
    w.refreshedAt
      ? ` title="${stale ? 'stale · ' : ''}refreshed ${esc(new Date(w.refreshedAt).toLocaleString())}"`
      : ''
  }>${esc(w.config?.meta ?? ago(w.refreshedAt))}</span>`

  const actions = (w.actions ?? [])
    .map((a) =>
      a.href
        ? `<a class="w-action" href="${esc(a.href)}" target="_blank" rel="noopener">${esc(a.label)}</a>`
        : `<button class="w-action" type="button" data-action="${esc(a.action ?? '')}">${esc(a.label)}</button>`,
    )
    .join('')

  // a collapsed widget keeps its header (and glyph) so the rail still reads at a glance
  const sized = !w.collapsed && w.height ? ` style="height:${Math.round(w.height)}px"` : ''
  return `<section class="widget${w.collapsed ? ' collapsed' : ''}${sized ? ' sized' : ''}" data-id="${esc(w.id)}"${sized}>
      <header class="w-h"><span class="grip"></span>${titleGlyph(w)}
        <span class="w-title">${title}</span>${actions ? `<span class="w-actions">${actions}</span>` : ''}${meta}
        <button class="w-fold" type="button" aria-expanded="${!w.collapsed}" aria-label="Collapse or expand ${esc(w.title)}"
          title="Collapse / expand · double-click the header · ⌥-click for the whole column">${CHEVRON}</button>
        <button class="w-gear" type="button" data-settings="${esc(w.id)}" title="${esc(w.title)} settings" aria-label="${esc(w.title)} settings">${GEAR}</button></header>
      <div class="w-compact">${compactBody(w)}</div>
      <div class="w-body">${body}</div>
      <div class="w-rsz" role="separator" aria-orientation="horizontal" tabindex="0"
        aria-label="${esc(w.title)} height" title="Drag to resize · double-click to fit content"></div>
    </section>`
}

export function renderRail(ws: Widget[], rail: 'left' | 'right'): string {
  const all = ws
    .filter((w) => (w.rail ?? 'left') === rail)
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
  const mine = all.filter((w) => !w.hidden)
  const hidden = all.length - mine.length
  const restore = hidden
    ? `<button class="w-restore" type="button" data-restore="${rail}">${hidden} hidden widget${hidden === 1 ? '' : 's'} · show</button>`
    : ''
  if (!mine.length && hidden) return restore
  if (!mine.length) {
    return `<div class="w-empty" style="padding:26px">No ${rail} widgets. Drop a JSON file in
      <code>brain/widgets/</code> with <code>"rail":"${rail}"</code>.</div>`
  }
  return mine.map(renderWidget).join('') + restore
}
