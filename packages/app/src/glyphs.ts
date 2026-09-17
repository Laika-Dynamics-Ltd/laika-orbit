/**
 * Line glyphs for widget titles and list tiles.
 *
 * Inline SVG rather than an icon font or a package: a dozen paths is a few KB, it
 * inherits `currentColor`, and it adds no dependency. Every glyph shares one 24px grid
 * and one stroke weight so a rail of them reads as a set.
 *
 * Keys are generic on purpose (`mail`, not `gmail`). Brand marks for the applications
 * ring are a separate, larger piece of work — see UI-CHANGES.md §3.
 */
const PATHS: Record<string, string> = {
  // Claude's four-point spark, filled so it reads as a mark rather than a line icon
  claude:
    '<path fill="currentColor" stroke="none" d="M12 2.5c.6 4.5 2.9 6.9 9.5 9.5-6.6 2.6-8.9 5-9.5 9.5-.6-4.5-2.9-6.9-9.5-9.5 6.6-2.6 8.9-5 9.5-9.5z"/>',
  apps: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  calendar:
    '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m3.8 7 8.2 6 8.2-6"/>',
  bolt: '<path d="M13 3 5 13.5h6L10.5 21 19 10.5h-6z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  brain:
    '<circle cx="12" cy="12" r="2.2"/><circle cx="5" cy="6" r="1.8"/><circle cx="19" cy="6.5" r="1.8"/><circle cx="6" cy="18.5" r="1.8"/><circle cx="18.5" cy="18" r="1.8"/><path d="m6.4 7.2 4 3.4M17.5 7.6l-3.7 3.1M7.4 17.4l3.1-3.8M17 16.8l-3.3-3.3"/>',
  chart: '<path d="M4 20h16"/><path d="M7 16v-4M12 16V7M17 16v-6"/>',
  gauge:
    '<path d="M4.5 16.5a8 8 0 1 1 15 0"/><path d="m12 13 3.5-4"/><circle cx="12" cy="13" r="1.2"/>',
  doc: '<path d="M7 3h7l4.5 4.5V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4.5h4.5M9 12.5h6M9 16h6"/>',
  deploy: '<path d="M12 4 21 19H3z"/>',
  chat: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  list: '<path d="M9 7h11M9 12h11M9 17h11"/><circle cx="4.8" cy="7" r="1"/><circle cx="4.8" cy="12" r="1"/><circle cx="4.8" cy="17" r="1"/>',
  play: '<circle cx="12" cy="12" r="8.5"/><path d="m10 8.5 5.5 3.5-5.5 3.5z"/>',
}

/** Default title glyph per widget kind, used when a widget names none. */
export const KIND_GLYPH: Record<string, string> = {
  applist: 'apps',
  calendar: 'calendar',
  metric: 'chart',
  table: 'clock',
  deck: 'bolt',
  feed: 'chat',
  links: 'link',
  list: 'list',
}

export const hasGlyph = (key: string | undefined): key is string => !!key && key in PATHS

export function glyph(key: string, cls = 'gl'): string {
  const d = PATHS[key]
  if (!d) return ''
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
}
