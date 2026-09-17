import './quicklook.css'

/**
 * Quick Look — an instant preview of a file, after macOS.
 *
 * Space toggles it on the selected node, esc closes it, and ←/→ step through the other
 * files in the same folder. The panel opens at once and fills as the file arrives.
 *
 * Renderers, by extension: markdown (a small safe renderer — everything is escaped first,
 * and only http(s), mailto and relative links survive), source code with highlighting and
 * line numbers, JSON pretty-printed, CSV/TSV as a table, PDF and HTML in frames (HTML
 * sandboxed, and served with a sandbox CSP as well), images, video and audio, and Word /
 * RTF / ODT / PowerPoint as the text the indexer already extracts. Anything else shows as
 * plain text if it decodes, or as a card with an "Open" button if it doesn't.
 *
 * Bytes come from /raw/<path>, which is path-style on purpose: a relative image in a
 * README, or a stylesheet next to an HTML page, resolves to its neighbour.
 */

export type QLItem = { path: string; name: string; bytes: number; group?: string | undefined }

export type QuickLookHost = {
  /** is this path in the index? — relative links to indexed files open in place */
  known: (path: string) => boolean
  /** the other files in an item's folder, in display order */
  siblings: (path: string) => QLItem[]
  /** a file became the one being looked at (by ←/→ or an in-preview link) */
  onShow?: (item: QLItem) => void
  /** reveal in Finder */
  reveal: (path: string) => void
}

const MAX_TEXT = 400_000 // characters rendered; beyond this the view says it is truncated
const MAX_ROWS = 1000

const esc = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[m] as string,
  )

const rawUrl = (p: string) => `/raw/${p.split('/').map(encodeURIComponent).join('/')}`

const extOf = (p: string) => (p.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()

const KIND: Record<string, string> = {}
for (const e of ['md', 'markdown', 'mdx', 'mdc']) KIND[e] = 'markdown'
for (const e of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico'])
  KIND[e] = 'image'
for (const e of ['mp4', 'webm', 'mov', 'm4v']) KIND[e] = 'video'
for (const e of ['mp3', 'wav', 'm4a', 'ogg', 'aif', 'aiff', 'flac']) KIND[e] = 'audio'
for (const e of ['html', 'htm']) KIND[e] = 'html'
for (const e of ['csv', 'tsv']) KIND[e] = 'table'
for (const e of ['docx', 'doc', 'rtf', 'odt', 'pptx', 'ppt']) KIND[e] = 'document'
KIND.pdf = 'pdf'
KIND.json = 'json'
const CODE = new Set(
  'ts tsx js jsx mjs cjs py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh fish ps1 sql css scss less vue svelte astro yaml yml toml ini conf env dockerfile makefile graphql gql proto lua r dart scala ex exs erl clj hs elm tf hcl xml plist gradle'.split(
    ' ',
  ),
)
const kindOf = (p: string) => {
  const e = extOf(p)
  const base = (p.split('/').pop() ?? '').toLowerCase()
  if (KIND[e]) return KIND[e] as string
  if (CODE.has(e) || base === 'dockerfile' || base === 'makefile') return 'code'
  return 'text'
}

// ------------------------------------------------------------------ highlight ----
const KEYWORDS = new Set(
  'abstract as async await break case catch class const continue def default del delete do elif else enum export extends false final finally fn for from func function get go if impl implements import in interface is let match mod module mut new nil none null of package pass private protected pub public raise readonly return self set static struct super switch this throw true try type typeof undefined use var void while with yield lambda not and or elseif then end local require def begin rescue ensure unless until'.split(
    ' ',
  ),
)
const TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|#(?![{!])[^\n]*|--[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b|\b0x[\da-f]+\b)|([A-Za-z_$][\w$]*)|(\s+|\d+[\w$]*|[^\sA-Za-z_$\d"'`#/-]+|[/-])/gi

/** Tokenise first, escape each token — escaping before tokenising would break on &lt;. */
export function highlight(code: string, ext: string): string {
  // "#" is a comment only in languages that use it
  const hashComments =
    /^(py|rb|sh|bash|zsh|fish|yaml|yml|toml|ini|conf|env|r|ex|exs|pl|dockerfile|makefile|tf|hcl|ps1)$/.test(
      ext,
    )
  const dashComments = /^(sql|lua|hs|elm)$/.test(ext)
  let out = ''
  for (const m of code.matchAll(TOKEN)) {
    const [t, com, str, num, word] = m
    if (com) {
      const isHash = com.startsWith('#')
      const isDash = com.startsWith('--')
      if ((isHash && !hashComments) || (isDash && !dashComments)) {
        out += esc(t)
        continue
      }
      out += `<i class="c">${esc(t)}</i>`
    } else if (str) out += `<i class="s">${esc(t)}</i>`
    else if (num) out += `<i class="n">${esc(t)}</i>`
    else if (word) {
      if (KEYWORDS.has(word)) out += `<i class="k">${esc(t)}</i>`
      else if (/^[A-Z][A-Za-z0-9]+$/.test(word)) out += `<i class="t">${esc(t)}</i>`
      else out += esc(t)
    } else out += esc(t)
  }
  return out
}

function codeBlock(code: string, ext: string): string {
  const body = highlight(code.replace(/\n$/, ''), ext)
  const n = code.replace(/\n$/, '').split('\n').length
  const gutter = Array.from({ length: n }, (_, k) => k + 1).join('\n')
  return `<div class="ql-code"><pre class="ql-gut" aria-hidden="true">${gutter}</pre><pre class="ql-src">${body}</pre></div>`
}

// ------------------------------------------------------------------- markdown ----
/** Resolve a link relative to the file it appears in; null if it escapes the root. */
function resolveRel(from: string, href: string): string | null {
  const dir = from.split('/').slice(0, -1)
  for (const part of href.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!dir.length) return null
      dir.pop()
    } else dir.push(part)
  }
  return dir.join('/')
}

function safeHref(from: string, href: string, host: QuickLookHost): { attr: string } {
  const h = href.trim()
  if (/^(https?:|mailto:)/i.test(h))
    return { attr: `href="${esc(h)}" target="_blank" rel="noopener noreferrer"` }
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return { attr: '' } // javascript:, data:, file: …
  if (h.startsWith('#')) return { attr: '' }
  const clean = h.split(/[?#]/)[0] ?? ''
  const p = resolveRel(from, decodeURIComponentSafe(clean))
  if (p && host.known(p)) return { attr: `href="#" data-ql="${esc(p)}"` }
  return { attr: '' }
}

function decodeURIComponentSafe(s: string) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function inline(text: string, from: string, host: QuickLookHost): string {
  // pull code spans out first so their contents are never formatted
  const codes: string[] = []
  let s = text.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${esc(c)}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  s = esc(s)
  // images, then links; the URL was escaped along with the text, so unescape it for use
  const unesc = (u: string) =>
    u
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
  s = s.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_, alt: string, src: string) => {
      const u = unesc(src)
      if (/^https?:/i.test(u)) return `<img alt="${alt}" src="${esc(u)}" loading="lazy">`
      if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return alt
      const p = resolveRel(from, decodeURIComponentSafe(u.split(/[?#]/)[0] ?? ''))
      return p ? `<img alt="${alt}" src="${rawUrl(p)}" loading="lazy">` : alt
    },
  )
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) => {
    const { attr } = safeHref(from, unesc(href), host)
    return attr ? `<a ${attr}>${label}</a>` : `<span class="ql-deadlink">${label}</span>`
  })
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre: string, url: string) => {
    return `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  })
  s = s
    .replace(
      /\*\*([^*]+)\*\*|__([^_]+)__/g,
      (_, a?: string, b?: string) => `<strong>${a ?? b}</strong>`,
    )
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
  // biome-ignore lint/suspicious/noControlCharactersInRegex: placeholder markers for code spans
  return s.replace(/\u0000(\d+)\u0000/g, (_, k: string) => codes[Number(k)] ?? '')
}

function markdown(src: string, from: string, host: QuickLookHost): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let k = 0
  // leading YAML front matter is shown as a quiet block, not as a heading or rule
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end > 0) {
      out.push(`<pre class="ql-front">${esc(lines.slice(1, end).join('\n'))}</pre>`)
      k = end + 1
    }
  }
  const para: string[] = []
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '), from, host)}</p>`)
    para.length = 0
  }
  while (k < lines.length) {
    const line = lines[k] as string
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line)
    if (fence) {
      flush()
      const close = fence[1] as string
      const body: string[] = []
      k++
      while (k < lines.length && !(lines[k] as string).trim().startsWith(close))
        body.push(lines[k++] as string)
      k++
      out.push(codeBlock(body.join('\n'), (fence[2] || '').toLowerCase()))
      continue
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      flush()
      const lvl = (h[1] as string).length
      out.push(`<h${lvl}>${inline(h[2] as string, from, host)}</h${lvl}>`)
      k++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      out.push('<hr>')
      k++
      continue
    }
    // tables: a header row, then a |---| separator
    if (line.includes('|') && /^\s*\|?\s*:?-{2,}/.test(lines[k + 1] ?? '')) {
      flush()
      const cells = (r: string) =>
        r
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim())
      const head = cells(line)
      k += 2
      const rows: string[][] = []
      while (
        k < lines.length &&
        (lines[k] as string).includes('|') &&
        (lines[k] as string).trim()
      ) {
        rows.push(cells(lines[k] as string))
        k++
      }
      out.push(
        `<div class="ql-tablewrap"><table><thead><tr>${head.map((c) => `<th>${inline(c, from, host)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c, from, host)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      )
      continue
    }
    if (/^\s*>/.test(line)) {
      flush()
      const body: string[] = []
      while (k < lines.length && /^\s*>/.test(lines[k] as string))
        body.push((lines[k++] as string).replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${markdown(body.join('\n'), from, host)}</blockquote>`)
      continue
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) {
      flush()
      const ordered = /\d/.test(li[2] as string)
      const items: string[] = []
      while (k < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[k] as string)
        if (!m) {
          // a continuation line belongs to the previous item
          const cont = lines[k] as string
          if (cont.trim() && /^\s{2,}/.test(cont) && items.length) {
            items[items.length - 1] += ` ${cont.trim()}`
            k++
            continue
          }
          break
        }
        const depth = Math.floor((m[1] as string).replace(/\t/g, '  ').length / 2)
        let body = m[3] as string
        let box = ''
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(body)
        if (task) {
          box = `<span class="ql-box${task[1] === ' ' ? '' : ' on'}"></span>`
          body = task[2] as string
        }
        items.push(`<li style="margin-left:${depth * 18}px">${box}${inline(body, from, host)}</li>`)
        k++
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`)
      continue
    }
    if (!line.trim()) {
      flush()
      k++
      continue
    }
    para.push(line.trim())
    k++
  }
  flush()
  return out.join('\n')
}

// ---------------------------------------------------------------------- table ----
function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let k = 0; k < text.length; k++) {
    const ch = text[k] as string
    if (quoted) {
      if (ch === '"' && text[k + 1] === '"') {
        cell += '"'
        k++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === delim) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[k + 1] === '\n') k++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      if (rows.length > MAX_ROWS) break
    } else cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

function table(text: string, ext: string): string {
  const rows = parseDelimited(
    text,
    ext === 'tsv'
      ? '\t'
      : text.split('\n')[0]?.includes(';') && !text.split('\n')[0]?.includes(',')
        ? ';'
        : ',',
  )
  const [head, ...body] = rows
  if (!head) return '<div class="ql-empty">Empty file</div>'
  const more =
    rows.length > MAX_ROWS
      ? `<div class="ql-note">Showing the first ${MAX_ROWS.toLocaleString()} rows</div>`
      : ''
  return `${more}<div class="ql-tablewrap sheet"><table><thead><tr><th class="rn"></th>${head.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${body
    .slice(0, MAX_ROWS)
    .map(
      (r, k) =>
        `<tr><td class="rn">${k + 1}</td>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`,
    )
    .join('')}</tbody></table></div>`
}

/**
 * Extracted document text (Word, RTF, ODT, PowerPoint) usually breaks paragraphs with a
 * single newline, so splitting only on blank lines ran a whole contract into three
 * paragraphs. Use blank lines when the text has them, single lines otherwise.
 */
function docParas(text: string): string {
  const blank = (text.match(/\n\s*\n/g) ?? []).length
  const lines = text.split('\n').filter((l) => l.trim()).length
  const parts = blank >= lines / 4 ? text.split(/\n\s*\n/) : text.split('\n')
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('')
}

// ------------------------------------------------------------------- the panel ----
/** Markdown for text that isn't a file (agent replies): links out only, no in-index links. */
export function renderMarkdown(src: string): string {
  const host: QuickLookHost = { known: () => false, siblings: () => [], reveal: () => {} }
  return markdown(src, '', host)
}

export function createQuickLook(host: QuickLookHost) {
  const root = document.createElement('div')
  root.id = 'ql'
  root.innerHTML = `
    <div class="ql-win" role="dialog" aria-label="Quick Look">
      <div class="ql-bar">
        <button class="ql-x" type="button" title="Close (space / esc)" aria-label="Close"></button>
        <div class="ql-title"><b></b><span></span></div>
        <div class="ql-acts">
          <button type="button" data-a="prev" title="Previous in folder (←)">‹</button>
          <button type="button" data-a="next" title="Next in folder (→)">›</button>
          <button type="button" data-a="reveal" title="Reveal in Finder">Reveal</button>
          <button type="button" data-a="open" class="primary" title="Open with default app">Open</button>
        </div>
      </div>
      <div class="ql-body"></div>
    </div>`
  document.body.appendChild(root)
  const title = root.querySelector('.ql-title b') as HTMLElement
  const sub = root.querySelector('.ql-title span') as HTMLElement
  const body = root.querySelector('.ql-body') as HTMLElement
  let current: QLItem | null = null
  let isOpen = false
  let token = 0
  const cache = new Map<string, string>() // path → rendered html, small LRU

  async function render(item: QLItem): Promise<string> {
    const hit = cache.get(item.path)
    if (hit) return hit
    const kind = kindOf(item.path)
    const ext = extOf(item.path)
    const url = rawUrl(item.path)
    let html: string
    if (kind === 'image') html = `<div class="ql-media"><img src="${url}" alt=""></div>`
    else if (kind === 'video')
      html = `<div class="ql-media"><video src="${url}" controls autoplay muted playsinline></video></div>`
    else if (kind === 'audio')
      html = `<div class="ql-media audio"><div class="ql-wave"></div><audio src="${url}" controls autoplay></audio></div>`
    else if (kind === 'pdf')
      html = `<iframe class="ql-frame" src="${url}#view=FitH" title="PDF"></iframe>`
    else if (kind === 'html')
      html = `<iframe class="ql-frame light" sandbox src="${url}" title="HTML preview"></iframe>`
    else {
      // text-based kinds come through /api/file, which also extracts Word, RTF and friends
      const res = await fetch(`/api/file?path=${encodeURIComponent(item.path)}`)
      if (!res.ok) return `<div class="ql-empty">Can't read this file.</div>`
      let text = await res.text()
      const cut = text.length > MAX_TEXT
      if (cut) text = text.slice(0, MAX_TEXT)
      // a file that decodes to control characters is binary; offer to open it instead
      // biome-ignore lint/suspicious/noControlCharactersInRegex: binary sniffing
      const binary = (text.slice(0, 4000).match(/[\u0000-\u0008\u000e-\u001f]/g)?.length ?? 0) > 8
      const note = cut
        ? `<div class="ql-note">Showing the first ${(MAX_TEXT / 1000).toFixed(0)}k characters</div>`
        : ''
      if (binary) html = cardFor(item)
      else if (kind === 'markdown')
        html = `${note}<article class="ql-md">${markdown(text, item.path, host)}</article>`
      else if (kind === 'json') {
        let pretty = text
        try {
          pretty = JSON.stringify(JSON.parse(text), null, 2)
        } catch {
          // not valid JSON — show it as written
        }
        html = note + codeBlock(pretty, 'json')
      } else if (kind === 'table') html = table(text, ext)
      else if (kind === 'code')
        html =
          note +
          codeBlock(text, ext || (item.name.toLowerCase() === 'dockerfile' ? 'dockerfile' : ''))
      else if (kind === 'document')
        html = `${note}<article class="ql-md doc">${docParas(text)}</article>`
      else html = `${note}<pre class="ql-plain">${esc(text)}</pre>`
    }
    cache.set(item.path, html)
    if (cache.size > 24) cache.delete(cache.keys().next().value as string)
    return html
  }

  function cardFor(item: QLItem) {
    return `<div class="ql-card"><div class="ql-glyph">${esc(extOf(item.path).toUpperCase() || 'FILE')}</div><b>${esc(item.name)}</b><span>${(item.bytes / 1024).toFixed(1)} KB · no preview for this format</span><button type="button" data-a="open" class="primary">Open with default app</button></div>`
  }

  async function show(item: QLItem) {
    current = item
    const my = ++token
    const dir = item.path.split('/').slice(0, -1).join('/')
    title.textContent = item.name
    const kb =
      item.bytes >= 1048576
        ? `${(item.bytes / 1048576).toFixed(1)} MB`
        : `${(item.bytes / 1024).toFixed(1)} KB`
    sub.textContent = `${dir || '(root)'} · ${kb}`
    root.dataset.kind = kindOf(item.path)
    body.innerHTML = '<div class="ql-loading"><i></i></div>'
    body.scrollTop = 0
    const sib = host.siblings(item.path)
    const at = sib.findIndex((s) => s.path === item.path)
    ;(root.querySelector('[data-a="prev"]') as HTMLButtonElement).disabled = at <= 0
    ;(root.querySelector('[data-a="next"]') as HTMLButtonElement).disabled =
      at < 0 || at >= sib.length - 1
    const html = await render(item).catch(() => `<div class="ql-empty">Preview failed.</div>`)
    if (my !== token) return // a newer file was requested while this one loaded
    body.innerHTML = html
  }

  function step(d: number) {
    if (!current) return
    const sib = host.siblings(current.path)
    const at = sib.findIndex((s) => s.path === current?.path)
    const next = sib[at + d]
    if (at < 0 || !next) return
    host.onShow?.(next)
    show(next)
  }

  function open(item: QLItem) {
    isOpen = true
    root.classList.add('on')
    show(item)
  }
  function close() {
    if (!isOpen) return
    isOpen = false
    root.classList.remove('on')
    // stop media the moment the window closes
    body.innerHTML = ''
    token++
  }

  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t === root || t.closest('.ql-x')) return close()
    const a = t.closest<HTMLElement>('[data-a]')?.dataset.a
    if (a && current) {
      if (a === 'prev') step(-1)
      else if (a === 'next') step(1)
      else if (a === 'reveal') host.reveal(current.path)
      else if (a === 'open')
        fetch(`/api/open?path=${encodeURIComponent(current.path)}`).catch(() => {})
      return
    }
    // a link to another indexed file opens in place
    const link = t.closest<HTMLElement>('[data-ql]')
    if (link) {
      e.preventDefault()
      const p = link.dataset.ql as string
      const item = host.siblings(p).find((s) => s.path === p) ?? {
        path: p,
        name: p.split('/').pop() ?? p,
        bytes: 0,
      }
      host.onShow?.(item)
      show(item)
    }
  })
  addEventListener(
    'keydown',
    (e) => {
      if (!isOpen) return
      if (
        e.key === 'Escape' ||
        (e.key === ' ' && !(e.target as HTMLElement).closest('input, textarea'))
      ) {
        e.preventDefault()
        e.stopPropagation()
        close()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        e.stopPropagation()
        step(e.key === 'ArrowLeft' ? -1 : 1)
      }
    },
    true, // capture: Quick Look owns the keyboard while it is open
  )

  return {
    open,
    close,
    toggle: (item: QLItem) => (isOpen ? close() : open(item)),
    isOpen: () => isOpen,
  }
}
