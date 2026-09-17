/**
 * Per-widget settings, opened from the gear in each widget header.
 *
 * Choices are saved to brain/widgets/_settings.json through PATCH /api/widget-settings,
 * never into the widget file itself: producers rewrite those wholesale on every refresh.
 * Layout moves (order, column, collapse, hide) apply at once; field edits wait for Save.
 */
import type { Widget } from './widgets.ts'

type Patch = Record<string, unknown>
type Zone = { label: string; tz: string }

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[<>&"]/g,
    (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[m] as string,
  )

/** Kinds whose items are hand-kept; staleness means nothing for them. */
const STATIC = new Set(['applist', 'deck', 'links'])

let pop: HTMLElement | null = null
let cleanup: (() => void) | null = null

export async function patch(body: Record<string, Patch | null>) {
  const r = await fetch('/api/widget-settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const e = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(e.error ?? `${r.status} ${r.statusText}`)
  }
}

export function closeWidgetSettings() {
  cleanup?.()
  cleanup = null
  pop?.remove()
  pop = null
}

let zoneNames: string[] | null = null
function timeZones(): string[] {
  if (!zoneNames) {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
    zoneNames = intl.supportedValuesOf?.('timeZone') ?? ['UTC']
  }
  return zoneNames
}
const tzOptions = (sel: string) =>
  timeZones()
    .map(
      (z) =>
        `<option value="${esc(z)}"${z === sel ? ' selected' : ''}>${esc(z.replace(/_/g, ' '))}</option>`,
    )
    .join('')

function railOrder(all: Widget[], rail: 'left' | 'right') {
  return all
    .filter((w) => (w.rail ?? 'left') === rail)
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
}

/** Rewrite a rail's order as 10, 20, 30… so a move is always a clean swap. */
function orderPatch(list: Widget[]): Record<string, Patch> {
  const out: Record<string, Patch> = {}
  list.forEach((w, i) => {
    out[w.id] = { order: (i + 1) * 10 }
  })
  return out
}

function calendarFields(w: Widget): string {
  const c = (w.config ?? {}) as {
    home?: string
    homeLabel?: string
    zones?: Zone[]
    workday?: { from?: number; to?: number }
  }
  const zones = c.zones ?? []
  return `
    <div class="ws-sec">clock & calendar</div>
    <label class="ws-f"><span>home time zone</span>
      <select data-f="home">${tzOptions(c.home ?? Intl.DateTimeFormat().resolvedOptions().timeZone)}</select></label>
    <label class="ws-f"><span>home label</span>
      <input data-f="homeLabel" value="${esc(c.homeLabel ?? '')}" placeholder="e.g. NZST · AUCKLAND"></label>
    <div class="ws-f"><span>workday</span>
      <span class="ws-inline">
        <input type="number" min="0" max="23" data-f="workFrom" value="${c.workday?.from ?? 9}"> to
        <input type="number" min="1" max="24" data-f="workTo" value="${c.workday?.to ?? 17}"> h
      </span></div>
    <div class="ws-f"><span>world clocks</span>
      <div class="ws-zones">${zones
        .map(
          (z, i) => `<div class="ws-zone" data-zone="${i}">
          <input data-zl value="${esc(z.label)}" placeholder="label">
          <select data-zt>${tzOptions(z.tz)}</select>
          <button type="button" data-act="zone-rm" data-i="${i}" title="remove">×</button></div>`,
        )
        .join('')}
        ${zones.length < 4 ? '<button type="button" class="ws-link" data-act="zone-add">+ add a clock</button>' : ''}
      </div></div>`
}

function panel(w: Widget, all: Widget[]): string {
  const rail = w.rail ?? 'left'
  const list = railOrder(all, rail)
  const at = list.findIndex((x) => x.id === w.id)
  const overridden = Object.keys(w.settings ?? {})
  const opensIndex = (w.actions ?? []).some((a) => a.action === 'brain-window')
  return `
    <header class="ws-h"><b>${esc(w.title)}</b><span>${esc(w.kind)} · ${esc(w.source)}</span>
      <button type="button" class="ws-x" data-act="close" title="Close (esc)">×</button></header>
    <div class="ws-body">
      <div class="ws-sec">layout · applies now</div>
      <div class="ws-row">
        <span class="ws-seg">
          <button type="button" data-act="rail" data-rail="left" class="${rail === 'left' ? 'on' : ''}">left</button>
          <button type="button" data-act="rail" data-rail="right" class="${rail === 'right' ? 'on' : ''}">right</button>
        </span>
        <button type="button" data-act="move" data-d="-1"${at <= 0 ? ' disabled' : ''} title="move up">↑</button>
        <button type="button" data-act="move" data-d="1"${at >= list.length - 1 ? ' disabled' : ''} title="move down">↓</button>
        <button type="button" data-act="collapse">${w.collapsed ? 'expand' : 'collapse'}</button>
        <button type="button" data-act="hide" class="danger">hide</button>
      </div>

      <div class="ws-sec">general</div>
      <label class="ws-f"><span>title</span><input data-f="title" value="${esc(w.title)}"></label>
      <label class="ws-f"><span>title link</span><input data-f="href" value="${esc(w.href ?? '')}" placeholder="https://…"></label>
      ${
        w.items
          ? `<label class="ws-f"><span>items shown</span>
        <span class="ws-inline"><input type="number" min="0" data-f="maxItems" value="${w.maxItems ?? 0}"> <em>0 = all ${w.items.length}</em></span></label>`
          : ''
      }
      <label class="ws-f"><span>height</span>
        <span class="ws-inline"><input type="number" min="0" step="8" data-f="height" value="${w.height ?? 0}"> <em>px · 0 = fit content</em></span></label>
      ${
        STATIC.has(w.kind)
          ? ''
          : `<label class="ws-f"><span>stale after</span>
        <span class="ws-inline"><input type="number" min="1" data-f="stale" value="${Number(w.config?.staleAfterMins ?? 60)}"> <em>minutes, then the age turns amber</em></span></label>`
      }
      ${w.kind === 'calendar' ? calendarFields(w) : ''}
      ${opensIndex ? '<button type="button" class="ws-wide" data-act="brain-window">Open index settings…</button>' : ''}
      <p class="ws-note">Saved to <code>brain/widgets/_settings.json</code>, so a producer refreshing
        <code>${esc(w.id)}.json</code> keeps these.${overridden.length ? ` Overridden: ${overridden.map(esc).join(', ')}.` : ''}</p>
    </div>
    <footer class="ws-foot">
      <span class="ws-err"></span>
      <button type="button" data-act="reset"${overridden.length ? '' : ' disabled'}>Reset</button>
      <button type="button" class="primary" data-act="save">Save</button>
    </footer>`
}

function place(anchor: HTMLElement) {
  if (!pop) return
  const r = anchor.getBoundingClientRect()
  const w = pop.offsetWidth
  const h = pop.offsetHeight
  const left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w))
  const below = r.bottom + 6
  const top = below + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : below
  pop.style.left = `${left}px`
  pop.style.top = `${top}px`
}

/** Only what changed since the panel opened, so an untouched field never becomes an override. */
function diff(before: Patch, after: Patch): Patch {
  const out: Patch = {}
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  for (const [k, v] of Object.entries(after)) {
    if (k === 'config') continue
    if (!same(before[k], v)) out[k] = v
  }
  const bc = (before.config ?? {}) as Patch
  const ac = (after.config ?? {}) as Patch
  const config: Patch = {}
  for (const [k, v] of Object.entries(ac)) if (!same(bc[k], v)) config[k] = v
  if (Object.keys(config).length) out.config = config
  return out
}

/** Read the form into a settings patch. Empty fields reset to the producer's value. */
function collect(w: Widget): Patch {
  const v = (f: string) => pop?.querySelector<HTMLInputElement>(`[data-f="${f}"]`)?.value.trim()
  const out: Patch = {}
  const config: Patch = {}
  const title = v('title')
  out.title = title || null
  out.href = v('href') || null
  const hv = v('height')
  if (hv !== undefined) out.height = Number(hv) >= 40 ? Math.round(Number(hv)) : null
  const mi = v('maxItems')
  if (mi !== undefined) out.maxItems = Number(mi) > 0 ? Math.floor(Number(mi)) : null
  const stale = v('stale')
  if (stale !== undefined) config.staleAfterMins = Number(stale) > 0 ? Number(stale) : null
  if (w.kind === 'calendar') {
    config.home = v('home') || null
    config.homeLabel = v('homeLabel') || null
    const from = Number(v('workFrom'))
    const to = Number(v('workTo'))
    if (!(from >= 0 && to <= 24 && from < to))
      throw new Error('workday must start before it ends, within 0-24')
    config.workday = { from, to }
    const zones: Zone[] = []
    for (const row of pop?.querySelectorAll<HTMLElement>('.ws-zone') ?? []) {
      const tz = row.querySelector<HTMLSelectElement>('[data-zt]')?.value ?? ''
      const label =
        row.querySelector<HTMLInputElement>('[data-zl]')?.value.trim() || tz.split('/').pop() || tz
      if (tz) zones.push({ label: label.toUpperCase(), tz })
    }
    config.zones = zones
  }
  if (Object.keys(config).length) out.config = config
  return out
}

export function openWidgetSettings(
  id: string,
  anchor: HTMLElement,
  all: Widget[],
  refresh: () => Promise<void> | void,
  openIndex: () => void,
) {
  const w = all.find((x) => x.id === id)
  if (!w) return
  const reopen = pop?.dataset.id === id
  closeWidgetSettings()
  if (reopen) return // a second click on the same gear closes it

  pop = document.createElement('div')
  pop.id = 'ws'
  pop.dataset.id = id
  pop.setAttribute('role', 'dialog')
  pop.setAttribute('aria-label', `${w.title} settings`)
  pop.innerHTML = panel(w, all)
  document.body.appendChild(pop)
  place(anchor)
  pop.querySelector<HTMLInputElement>('[data-f="title"]')?.focus()
  const before = collect(w)

  const el = pop
  const fail = (e: unknown) => {
    const box = el.querySelector('.ws-err')
    if (box) box.textContent = e instanceof Error ? e.message : String(e)
  }
  /** apply a layout patch now, then re-open against the refreshed widgets */
  const applyNow = async (body: Record<string, Patch | null>, close = false) => {
    try {
      await patch(body)
      closeWidgetSettings()
      await refresh()
      if (!close) {
        const gear = document.querySelector<HTMLElement>(`[data-settings="${CSS.escape(id)}"]`)
        if (gear) gear.click()
      }
    } catch (e) {
      fail(e)
    }
  }

  el.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]')
    if (!b || b.disabled) return
    const rail = w.rail ?? 'left'
    switch (b.dataset.act) {
      case 'close':
        return closeWidgetSettings()
      case 'rail': {
        const to = b.dataset.rail as 'left' | 'right'
        if (to === rail) return
        const dest = railOrder(all, to).filter((x) => x.id !== id)
        return applyNow({
          ...orderPatch([...dest, w]),
          [id]: { rail: to, order: (dest.length + 1) * 10 },
        })
      }
      case 'move': {
        const list = railOrder(all, rail)
        const i = list.findIndex((x) => x.id === id)
        const j = i + Number(b.dataset.d)
        if (i < 0 || j < 0 || j >= list.length) return
        ;[list[i], list[j]] = [list[j] as Widget, list[i] as Widget]
        return applyNow(orderPatch(list))
      }
      case 'collapse':
        return applyNow({ [id]: { collapsed: w.collapsed ? null : true } })
      case 'hide':
        return applyNow({ [id]: { hidden: true } }, true)
      case 'zone-rm':
        b.closest('.ws-zone')?.remove()
        return
      case 'zone-add': {
        const row = document.createElement('div')
        row.className = 'ws-zone'
        row.innerHTML = `<input data-zl placeholder="label"><select data-zt>${tzOptions('Europe/London')}</select>
          <button type="button" data-act="zone-rm" title="remove">×</button>`
        b.before(row)
        if (el.querySelectorAll('.ws-zone').length >= 4) b.remove()
        return
      }
      case 'brain-window':
        closeWidgetSettings()
        return openIndex()
      case 'reset':
        return applyNow({ [id]: null })
      case 'save':
        try {
          const changes = diff(before, collect(w))
          if (Object.keys(changes).length) await patch({ [id]: changes })
          closeWidgetSettings()
          await refresh()
        } catch (err) {
          fail(err)
        }
        return
    }
  })

  const onDown = (e: PointerEvent) => {
    const t = e.target as HTMLElement
    if (!el.contains(t) && !t.closest(`[data-settings="${CSS.escape(id)}"]`)) closeWidgetSettings()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopImmediatePropagation()
      closeWidgetSettings()
    } else if (
      e.key === 'Enter' &&
      el.contains(e.target as Node) &&
      (e.target as HTMLElement).tagName === 'INPUT'
    ) {
      el.querySelector<HTMLButtonElement>('[data-act="save"]')?.click()
    }
  }
  const onResize = () => closeWidgetSettings()
  addEventListener('pointerdown', onDown, true)
  addEventListener('keydown', onKey, true)
  addEventListener('resize', onResize)
  cleanup = () => {
    removeEventListener('pointerdown', onDown, true)
    removeEventListener('keydown', onKey, true)
    removeEventListener('resize', onResize)
  }
}

/** Un-hide every hidden widget in a rail. */
export async function restoreHidden(
  rail: 'left' | 'right',
  all: Widget[],
  refresh: () => Promise<void> | void,
) {
  const body: Record<string, Patch> = {}
  for (const w of all) if ((w.rail ?? 'left') === rail && w.hidden) body[w.id] = { hidden: null }
  await patch(body)
  await refresh()
}
