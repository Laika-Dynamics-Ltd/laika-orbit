/**
 * A tab as the page sees it (ShellTab in packages/app/src/shell-api.ts): plain data, picked
 * field by field. The shell's own tab record also holds the live WebContentsView and timers,
 * which cannot cross IPC; when one leaked into the snapshot, every state push after the first
 * tab went out of view failed, and the tab strip froze on whatever it last showed.
 */
export function publicTab(t, live = {}) {
  return {
    id: t.id,
    profile: t.profile,
    url: t.url,
    title: t.title,
    favicon: t.favicon,
    loading: t.loading,
    audible: t.audible,
    muted: t.muted,
    failed: t.failed,
    gone: t.gone ?? null,
    hung: !!t.hung,
    // the page's first waiting permission question, for the bar above it
    ask: t.asks?.length ? { origin: t.asks[0].origin, what: t.asks[0].what, text: t.asks[0].text, yes: t.asks[0].yes, no: t.asks[0].no } : null,
    opener: t.opener,
    zoom: t.zoom,
    ...live,
  }
}
