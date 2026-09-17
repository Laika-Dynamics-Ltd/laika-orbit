import './spotlight.css'

/**
 * Spotlight — one palette for everything: files, departments, actions and apps, plus an
 * "Ask the brain" row that runs recall.
 *
 * Opens with ⌘K or `/`. ↑↓ move, ↵ runs, ⌘↵ always asks the brain, esc closes. Moving
 * through files previews each on the ring, so you see where a file lives before opening
 * it; closing without choosing puts the view back.
 *
 * Matching is a small fuzzy scorer rather than a library: a subsequence match with
 * bonuses for a prefix, a word boundary and consecutive characters, penalised by length.
 * Over ~2,000 nodes it runs in a few milliseconds per keystroke.
 */

export type SpotFile = { i: number; name: string; path: string; group: string; colour: string }
export type SpotGroup = {
  name: string
  label: string
  count: number
  colour: string
  source: string
}
export type SpotCommand = {
  id: string
  title: string
  hint?: string
  keys?: string
  /** extra words to match on */
  terms?: string
  run: () => void
}
export type SpotApp = { name: string; via: string; live: boolean }

export type SpotlightHost = {
  files: () => SpotFile[]
  groups: () => SpotGroup[]
  commands: () => SpotCommand[]
  apps: () => SpotApp[]
  openFile: (i: number) => void
  /** preview a file on the ring; null clears the preview */
  preview: (i: number | null) => void
  isolate: (group: string) => void
  ask: (q: string) => void
}

type Row =
  | { kind: 'ask'; q: string }
  | { kind: 'file'; f: SpotFile; hits: number[]; inPath: boolean }
  | { kind: 'group'; g: SpotGroup; hits: number[] }
  | { kind: 'cmd'; c: SpotCommand; hits: number[] }
  | { kind: 'app'; a: SpotApp; hits: number[] }

const esc = (s: string) => s.replace(/[<>&"]/g, (m) => `&#${m.charCodeAt(0)};`)

/** Fuzzy match: returns a score (higher is better) and the matched indices, or null. */
export function fuzzy(q: string, text: string): { score: number; hits: number[] } | null {
  if (!q) return { score: 0, hits: [] }
  const t = text.toLowerCase()
  const needle = q.toLowerCase().replace(/\s+/g, ' ').trim()
  // a whole substring beats any scattered match
  const at = t.indexOf(needle)
  if (at >= 0) {
    const boundary = at === 0 || /[\s/._\-·]/.test(t[at - 1] ?? '')
    const hits = [...needle].map((_, k) => at + k)
    return { score: 100 + (at === 0 ? 40 : boundary ? 25 : 0) - text.length * 0.2, hits }
  }
  // Scattered matches follow the editor rule: each letter either continues the previous
  // match or starts a word. Letters buried mid-word don't count, so "jarvis" no longer
  // finds pro-J-ect_A-lle-R-gy…, while "kmi" still finds KHANBAN_MCP_INTEGRATION.
  const isStart = (k: number) =>
    k === 0 || /[\s/._\-·]/.test(t[k - 1] ?? '') || (text[k] !== t[k] && text[k - 1] === t[k - 1]) // camelCase hump
  const hits: number[] = []
  let score = 0
  let last = -1
  let run = 0
  for (const ch of needle) {
    if (ch === ' ') continue
    let k = -1
    if (last >= 0 && t[last + 1] === ch) k = last + 1
    else {
      for (let j = last + 1; j < t.length; j++) {
        if (t[j] === ch && isStart(j)) {
          k = j
          break
        }
      }
    }
    if (k < 0) return null
    run = k === last + 1 ? run + 1 : 0
    score += 2 + (run ? run * 3 : 6)
    hits.push(k)
    last = k
  }
  return { score: score - text.length * 0.15 - (hits[0] ?? 0) * 0.3, hits }
}

function mark(text: string, hits: number[], offset = 0): string {
  if (!hits.length) return esc(text)
  const set = new Set(hits.map((h) => h - offset))
  let out = ''
  for (let k = 0; k < text.length; k++) {
    const c = esc(text[k] as string)
    out += set.has(k) ? `<mark>${c}</mark>` : c
  }
  return out
}

export function createSpotlight(host: SpotlightHost) {
  const root = document.createElement('div')
  root.id = 'sp'
  root.innerHTML = `
    <div class="sp-panel" role="dialog" aria-label="Spotlight">
      <div class="sp-bar">
        <span class="sp-ico">⌕</span>
        <input id="sp-q" placeholder="Search files, departments, actions — or ask the brain" autocomplete="off" spellcheck="false"/>
        <kbd>esc</kbd>
      </div>
      <div class="sp-list" role="listbox"></div>
      <div class="sp-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>⌘</kbd><kbd>↵</kbd> ask the brain</span><span class="sp-count"></span></div>
    </div>`
  document.body.appendChild(root)
  const input = root.querySelector('#sp-q') as HTMLInputElement
  const list = root.querySelector('.sp-list') as HTMLElement
  const count = root.querySelector('.sp-count') as HTMLElement
  let rows: Row[] = []
  let sel = 0
  let open = false
  let previewing = false

  function search(q: string): Row[] {
    const query = q.trim()
    const out: Row[] = []
    const files = host
      .files()
      .flatMap((f) => {
        // match the name first; fall back to the full path
        const n = fuzzy(query, f.name)
        const p = n ? null : fuzzy(query, f.path)
        const m = n
          ? { score: n.score + 15, hits: n.hits, inPath: false }
          : p
            ? { ...p, inPath: true }
            : null
        return m ? [{ f, m }] : []
      })
      .sort((a, b) => b.m.score - a.m.score)
      .slice(0, query ? 8 : 0)
    const groups = host
      .groups()
      .flatMap((g) => {
        const m = fuzzy(query, g.label)
        return m ? [{ g, m }] : []
      })
      .sort((a, b) => b.m.score - a.m.score || b.g.count - a.g.count)
      .slice(0, query ? 4 : 5)
    const cmds = host
      .commands()
      .flatMap((c) => {
        const m =
          fuzzy(query, c.title) ??
          (c.terms && fuzzy(query, c.terms) ? { score: 1, hits: [] } : null)
        return m ? [{ c, m }] : []
      })
      .sort((a, b) => b.m.score - a.m.score)
      .slice(0, query ? 5 : 8)
    const apps = query
      ? host
          .apps()
          .flatMap((a) => {
            const m = fuzzy(query, a.name)
            return m ? [{ a, m }] : []
          })
          .sort((x, y) => y.m.score - x.m.score)
          .slice(0, 3)
      : []

    // Sections are ordered by their best match, so "rings" leads with the Rings layout
    // rather than with files that merely contain the letters. A question (several words
    // or a question mark) puts "ask" on top.
    const blocks: { best: number; rows: Row[] }[] = [
      {
        best: files[0]?.m.score ?? -1e9,
        rows: files.map(({ f, m }) => ({ kind: 'file', f, hits: m.hits, inPath: m.inPath })),
      },
      {
        best: groups[0]?.m.score ?? -1e9,
        rows: groups.map(({ g, m }) => ({ kind: 'group', g, hits: m.hits })),
      },
      {
        best: cmds[0]?.m.score ?? -1e9,
        rows: cmds.map(({ c, m }) => ({ kind: 'cmd', c, hits: m.hits })),
      },
      {
        best: apps[0]?.m.score ?? -1e9,
        rows: apps.map(({ a, m }) => ({ kind: 'app', a, hits: m.hits })),
      },
    ]
    if (query) blocks.sort((x, y) => y.best - x.best)
    const askFirst = /\s|\?$/.test(query)
    if (query && askFirst) out.push({ kind: 'ask', q: query })
    blocks.forEach((bl, k) => {
      out.push(...bl.rows)
      // a single token: offer "ask" after the strongest section
      if (query && !askFirst && k === 0) out.push({ kind: 'ask', q: query })
    })
    return out
  }

  const section = (r: Row) =>
    r.kind === 'ask'
      ? 'Ask'
      : r.kind === 'file'
        ? 'Files'
        : r.kind === 'group'
          ? 'Departments'
          : r.kind === 'cmd'
            ? 'Actions'
            : 'Applications'

  function render() {
    let last = ''
    list.innerHTML = rows
      .map((r, k) => {
        const head = section(r) !== last ? `<div class="sp-sec">${section(r)}</div>` : ''
        last = section(r)
        const on = k === sel ? ' on' : ''
        const body =
          r.kind === 'ask'
            ? `<span class="sp-dot ask">✦</span><span class="sp-t">Ask the brain: <b>${esc(r.q)}</b></span><span class="sp-r"><bdi>recall · 0 model calls</bdi></span>`
            : r.kind === 'file'
              ? `<span class="sp-dot" style="background:${r.f.colour}"></span><span class="sp-t">${mark(r.f.name, r.inPath ? [] : r.hits)}</span><span class="sp-r"><bdi>${r.inPath ? mark(r.f.path, r.hits) : esc(r.f.path)}</bdi></span>`
              : r.kind === 'group'
                ? `<span class="sp-dot" style="background:${r.g.colour}"></span><span class="sp-t">${mark(r.g.label, r.hits)}</span><span class="sp-r"><bdi>${esc(r.g.source)} · ${r.g.count.toLocaleString()} files · isolate</bdi></span>`
                : r.kind === 'cmd'
                  ? `<span class="sp-dot cmd">›</span><span class="sp-t">${mark(r.c.title, r.hits)}</span><span class="sp-r"><bdi>${r.c.hint ? esc(r.c.hint) : ''}${r.c.keys ? ` <kbd>${esc(r.c.keys)}</kbd>` : ''}</bdi></span>`
                  : `<span class="sp-dot app${r.a.live ? '' : ' off'}">⬡</span><span class="sp-t">${mark(r.a.name, r.hits)}</span><span class="sp-r"><bdi>${esc(r.a.via)}</bdi></span>`
        return `${head}<div class="sp-row${on}" role="option" data-k="${k}">${body}</div>`
      })
      .join('')
    if (!rows.length) list.innerHTML = '<div class="sp-empty">No matches</div>'
    const nFiles = rows.filter((r) => r.kind === 'file').length
    count.textContent = input.value.trim() ? `${nFiles} file${nFiles === 1 ? '' : 's'} shown` : ''
    list.querySelector('.sp-row.on')?.scrollIntoView({ block: 'nearest' })
    syncPreview()
  }

  function syncPreview() {
    const r = rows[sel]
    if (r?.kind === 'file') {
      host.preview(r.f.i)
      previewing = true
    } else if (previewing) {
      host.preview(null)
      previewing = false
    }
  }

  function refresh() {
    rows = search(input.value)
    sel = 0
    render()
  }

  function run(r: Row | undefined, forceAsk = false) {
    const q = input.value.trim()
    if (forceAsk && q) {
      close(false)
      host.ask(q)
      return
    }
    if (!r) return
    close(r.kind !== 'file')
    if (r.kind === 'ask') host.ask(r.q)
    else if (r.kind === 'file') host.openFile(r.f.i)
    else if (r.kind === 'group') host.isolate(r.g.name)
    else if (r.kind === 'cmd') r.c.run()
  }

  function close(clearPreview = true) {
    if (!open) return
    open = false
    root.classList.remove('on')
    if (previewing && clearPreview) host.preview(null)
    previewing = false
    input.blur()
  }

  input.addEventListener('input', refresh)
  input.addEventListener('keydown', (e) => {
    // the palette owns its keys; nothing leaks to the page's shortcuts
    e.stopPropagation()
    if (e.key === 'Escape') return close()
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!rows.length) return
      sel = (sel + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length
      render()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      run(rows[sel], e.metaKey || e.ctrlKey)
    }
  })
  list.addEventListener('mousemove', (e) => {
    const k = Number((e.target as HTMLElement).closest<HTMLElement>('.sp-row')?.dataset.k)
    if (Number.isFinite(k) && k !== sel) {
      sel = k
      for (const el of list.querySelectorAll('.sp-row')) {
        el.classList.toggle('on', Number((el as HTMLElement).dataset.k) === sel)
      }
      syncPreview()
    }
  })
  list.addEventListener('click', (e) => {
    const k = Number((e.target as HTMLElement).closest<HTMLElement>('.sp-row')?.dataset.k)
    if (Number.isFinite(k)) run(rows[k])
  })
  // clicking the dimmed backdrop closes; clicks inside the panel don't
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) close()
  })

  return {
    open(prefill = '') {
      open = true
      root.classList.add('on')
      input.value = prefill
      refresh()
      input.focus()
      input.select()
    },
    close,
    isOpen: () => open,
  }
}
