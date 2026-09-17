/**
 * The Brain window: what is indexed, why, and every knob that changes it.
 *
 * It edits a DRAFT of brain/index.config.json. Nothing touches the index until
 * "Save & rebuild"; "Preview" dry-runs the draft against the disk first, so a rule
 * can be checked against real files before it is committed. The same file drives
 * the CLI and the MCP server, so what is set here is what an agent recalls against.
 */
import type { IndexConfig, IndexSource, ScanStats } from '@laika/core'

type SourceStatus = {
  id: string
  dir: string
  prefix: string | null
  enabled: boolean
  docs: number
  bytes: number
  content: number
  scan: ScanStats | null
}
type Build = { at: number; ms: number; reason: string; full: boolean; docs: number; reread: number }
type Status = {
  root: string
  configPath: string
  building: boolean
  lastBuild: Build | null
  history: Build[]
  docs: number
  bytes: number
  tokens: number
  routers: number
  pointers: number
  contentDocs: number
  tooLarge: number
  sources: SourceStatus[]
  byExt: [string, number][]
  largest: { path: string; bytes: number; content: boolean }[]
  tools: { pdftotext: boolean; textutil: boolean }
}
type Builtin = { ignoreDirs: string[]; binary: string[]; noise: string[] }
type Preview = {
  partial: boolean
  ms: number
  total: number
  added: number
  removed: number
  addedSample: string[]
  removedSample: string[]
  sources: { id: string; dir: string; scan: ScanStats }[]
}
type FileRow = { path: string; bytes: number; mtimeMs: number; source: string; tokens: number }
type Tab = 'overview' | 'sources' | 'rules' | 'ranking' | 'files'

const TABS: [Tab, string][] = [
  ['overview', 'Overview'],
  ['sources', 'Sources'],
  ['rules', 'Rules'],
  ['ranking', 'Content & ranking'],
  ['files', 'Files'],
]

const SKIP_LABEL: Record<keyof ScanStats['skipped'], string> = {
  ignoredDir: 'ignored folder',
  binary: 'binary',
  noise: 'build/noise',
  excluded: 'excluded by rule',
  notIncluded: 'not in include list',
  tooDeep: 'too deep',
  overCap: 'over file cap',
}

const PRESETS: Record<string, string[]> = {
  docs: ['*.md', '*.mdx', '*.txt', '*.pdf', '*.docx', '*.rtf', '*.odt', '*.html'],
  markdown: ['*.md', '*.mdx'],
  code: ['*.ts', '*.tsx', '*.js', '*.mjs', '*.py', '*.go', '*.rs', '*.swift', '*.json', '*.md'],
}

const WEIGHT_HELP: Record<keyof IndexConfig['weights'], string> = {
  topic: 'keyword pinned to a file in Topics',
  catalogue: 'router pointer descriptions',
  filename: 'words in the file path',
  content: 'words inside the file',
}

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[<>&"]/g,
    (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[m] as string,
  )
const size = (b: number) =>
  b < 1024
    ? `${b} B`
    : b < 1048576
      ? `${(b / 1024).toFixed(1)} KB`
      : b < 1073741824
        ? `${(b / 1048576).toFixed(1)} MB`
        : `${(b / 1073741824).toFixed(2)} GB`
const n = (x: number) => x.toLocaleString()
const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'source'

const st = {
  root: null as HTMLElement | null,
  tab: 'overview' as Tab,
  saved: null as IndexConfig | null,
  draft: null as IndexConfig | null,
  defaults: null as IndexConfig | null,
  builtin: { ignoreDirs: [], binary: [], noise: [] } as Builtin,
  status: null as Status | null,
  canEdit: false,
  busy: '' as string,
  error: '',
  notice: '',
  preview: null as Preview | null,
  files: { q: '', source: '', sort: 'path', pattern: '', total: 0, rows: [] as FileRow[] },
  detail: null as (FileRow & { tokenList: string[] }) | null,
  browse: null as { path: string; parent: string | null; dirs: string[] } | null,
  poll: 0,
}

const dirty = () => JSON.stringify(st.saved) !== JSON.stringify(st.draft)

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init)
  const body = (await r.json().catch(() => ({}))) as T & { error?: string }
  if (!r.ok) throw new Error(body.error ?? `${r.status} ${r.statusText}`)
  return body
}

async function load() {
  const d = await api<{
    config: IndexConfig
    defaults: IndexConfig
    builtin: Builtin
    status: Status
    canEdit: boolean
  }>('/api/index')
  st.saved = d.config
  if (!st.draft || !dirty()) st.draft = clone(d.config)
  st.defaults = d.defaults
  st.builtin = d.builtin
  st.status = d.status
  st.canEdit = d.canEdit
}

async function loadFiles() {
  const f = st.files
  const q = new URLSearchParams({ q: f.q, source: f.source, sort: f.sort, limit: '300' })
  if (f.pattern) q.set('pattern', f.pattern)
  const d = await api<{ total: number; rows: FileRow[] }>(`/api/index/files?${q}`)
  f.total = d.total
  f.rows = d.rows
}

/** Run an async step with a busy label, surfacing errors in the window. */
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

// ------------------------------------------------------------------ draft ----
/** Read/write a dotted path like `sources.1.maxDepth` on the draft. */
function getAt(path: string): unknown {
  let cur: unknown = st.draft
  for (const k of path.split('.')) cur = (cur as Record<string, unknown> | undefined)?.[k]
  return cur
}
function setAt(path: string, v: unknown) {
  const keys = path.split('.')
  const last = keys.pop() as string
  let cur = st.draft as unknown as Record<string, unknown>
  for (const k of keys) cur = cur[k] as Record<string, unknown>
  cur[last] = v
}
function listAt(path: string): string[] {
  const v = getAt(path)
  return Array.isArray(v) ? (v as string[]) : []
}
function addTo(path: string, values: string[]) {
  const cur = listAt(path)
  setAt(path, [...cur, ...values.filter((x) => x && !cur.includes(x))])
}

// ---------------------------------------------------------------- widgets ----
const dis = () => (st.canEdit ? '' : ' disabled')

function toggle(bind: string, label: string, hint = '') {
  const on = getAt(bind) === true
  return `<label class="bw-tg${on ? ' on' : ''}"><input type="checkbox" data-bind="${bind}" data-type="bool"${on ? ' checked' : ''}${dis()}>
    <i></i><span>${esc(label)}${hint ? `<em>${esc(hint)}</em>` : ''}</span></label>`
}

function numField(
  bind: string,
  label: string,
  hint: string,
  o: { min?: number; step?: number; scale?: number; unit?: string } = {},
) {
  const scale = o.scale ?? 1
  const v = Number(getAt(bind)) / scale
  return `<label class="bw-f"><span>${esc(label)}<em>${esc(hint)}</em></span>
    <span class="bw-num"><input type="number" value="${Number.isInteger(v) ? v : v.toFixed(2)}" min="${o.min ?? 0}" step="${o.step ?? 1}"
      data-bind="${bind}" data-type="num" data-scale="${scale}"${dis()}>${o.unit ? `<small>${esc(o.unit)}</small>` : ''}</span></label>`
}

function chips(bind: string, placeholder: string, presets?: [string, string][]) {
  const list = listAt(bind)
  return `<div class="bw-chips">
    ${list.map((c, i) => `<span class="bw-chip"><code>${esc(c)}</code>${st.canEdit ? `<button data-act="chip-rm" data-bind="${bind}" data-i="${i}" title="remove">×</button>` : ''}</span>`).join('')}
    ${st.canEdit ? `<input class="bw-chip-in" data-chip="${bind}" placeholder="${esc(placeholder)}">` : ''}
    ${
      presets && st.canEdit
        ? `<span class="bw-presets">${presets.map(([k, l]) => `<button data-act="preset" data-bind="${bind}" data-preset="${k}">+ ${esc(l)}</button>`).join('')}</span>`
        : ''
    }
  </div>`
}

function skipChips(scan: ScanStats | null) {
  if (!scan) return '<span class="bw-dim">not scanned</span>'
  const parts = (Object.keys(SKIP_LABEL) as (keyof ScanStats['skipped'])[])
    .filter((k) => scan.skipped[k] > 0)
    .map((k) => {
      const ex = scan.examples[k] ?? []
      return `<span class="bw-skip ${k}" title="${esc(ex.join('\n'))}${ex.length >= 8 ? '\n…' : ''}">${n(scan.skipped[k])} ${SKIP_LABEL[k]}</span>`
    })
  return parts.length ? parts.join('') : '<span class="bw-dim">nothing skipped</span>'
}

// ------------------------------------------------------------------- tabs ----
function overview(): string {
  const s = st.status
  if (!s) return ''
  const lb = s.lastBuild
  const tiles: [string, string, string][] = [
    ['files', n(s.docs), size(s.bytes)],
    ['vocabulary', n(s.tokens), 'distinct tokens'],
    [
      'content',
      `${n(s.contentDocs)}<small>/${n(s.docs)}</small>`,
      s.tooLarge ? `${s.tooLarge} over size cap` : 'files read',
    ],
    ['routers', n(s.routers), `${n(s.pointers)} pointers`],
    [
      'last build',
      lb ? `${Math.round(lb.ms)}<small>ms</small>` : '—',
      lb ? `${lb.reread} re-read · ${ago(lb.at)}` : '',
    ],
  ]
  const maxExt = Math.max(1, ...s.byExt.map((e) => e[1]))
  return `
    <div class="bw-tiles">${tiles.map(([k, v, sub]) => `<div class="bw-tile"><em>${k}</em><b>${v}</b><span>${esc(sub)}</span></div>`).join('')}</div>
    <div class="bw-row">
      <div class="bw-card grow">
        <div class="bw-h"><b>Sources</b><span>${s.building ? '<i class="bw-spin"></i> building' : ''}</span></div>
        <table class="bw-t">
          <tr><th>source</th><th class="r">files</th><th class="r">content</th><th class="r">size</th><th>skipped while scanning</th><th class="r">scan</th></tr>
          ${s.sources
            .map(
              (x) => `<tr class="${x.enabled ? '' : 'off'}">
            <td><b>${esc(x.id)}</b><small title="${esc(x.dir)}">${esc(x.dir)}</small></td>
            <td class="r">${x.enabled ? n(x.docs) : 'off'}</td>
            <td class="r">${x.enabled ? n(x.content) : ''}</td>
            <td class="r">${x.enabled ? size(x.bytes) : ''}</td>
            <td>${x.enabled ? skipChips(x.scan) : ''}${x.scan?.capped ? '<span class="bw-skip warn">stopped at file cap</span>' : ''}</td>
            <td class="r">${x.scan && !x.scan.running ? `${Math.round(x.scan.ms)}ms` : ''}</td></tr>`,
            )
            .join('')}
        </table>
      </div>
    </div>
    <div class="bw-row">
      <div class="bw-card">
        <div class="bw-h"><b>By type</b></div>
        <div class="bw-bars">${s.byExt
          .map(
            ([e, c]) =>
              `<div><span>.${esc(e)}</span><i style="width:${(c / maxExt) * 100}%"></i><b>${n(c)}</b></div>`,
          )
          .join('')}</div>
      </div>
      <div class="bw-card grow">
        <div class="bw-h"><b>Largest files</b><span>content cap ${size(st.draft?.content.maxBytes ?? 0)}</span></div>
        <div class="bw-list">${s.largest
          .map(
            (f) => `<div data-act="open-file" data-path="${esc(f.path)}"><span>${esc(f.path)}</span>
            ${f.content ? '' : '<em class="bw-tag warn">path only</em>'}<b>${size(f.bytes)}</b></div>`,
          )
          .join('')}</div>
      </div>
    </div>
    <div class="bw-row">
      <div class="bw-card grow">
        <div class="bw-h"><b>Build history</b>
          <span class="bw-btns">
            <button data-act="rebuild"${dis()} title="Re-scan; unchanged files reuse their tokens">Rebuild</button>
            <button data-act="rebuild-full"${dis()} title="Re-read every file">Full rebuild</button>
          </span></div>
        <table class="bw-t">
          <tr><th>when</th><th>trigger</th><th class="r">files</th><th class="r">re-read</th><th class="r">time</th></tr>
          ${s.history
            .map(
              (
                b,
              ) => `<tr><td>${new Date(b.at).toLocaleTimeString()}</td><td>${esc(b.reason)}${b.full ? ' · full' : ''}</td>
              <td class="r">${n(b.docs)}</td><td class="r">${n(b.reread)}</td><td class="r">${Math.round(b.ms)}ms</td></tr>`,
            )
            .join('')}
        </table>
      </div>
      <div class="bw-card">
        <div class="bw-h"><b>Engine</b></div>
        <dl class="bw-dl">
          <dt>root</dt><dd title="${esc(s.root)}">${esc(s.root)}</dd>
          <dt>config</dt><dd>${esc(s.configPath)}</dd>
          <dt>pdf text</dt><dd>${s.tools.pdftotext ? '<b class="ok">pdftotext ✓</b>' : '<b class="warn">pdftotext missing</b> · brew install poppler'}</dd>
          <dt>doc text</dt><dd>${s.tools.textutil ? '<b class="ok">textutil ✓</b>' : '<b class="warn">textutil missing</b>'}</dd>
          <dt>refresh</dt><dd>${st.saved?.refreshSecs ? `every ${st.saved.refreshSecs}s on request` : 'manual only'}</dd>
        </dl>
      </div>
    </div>`
}

function sourceCard(s: IndexSource, i: number): string {
  const live = st.status?.sources.find((x) => x.id === s.id)
  const b = `sources.${i}`
  const first = i === 0
  return `<div class="bw-card src${s.enabled ? '' : ' off'}">
    <div class="bw-h">
      ${toggle(`${b}.enabled`, '')}
      <input class="bw-title-in" value="${esc(s.label ?? '')}" placeholder="${esc(s.id)}" data-bind="${b}.label" data-type="str"${dis()}>
      <span class="bw-dim">${first ? 'paths as-is' : `files appear as <code>@${esc(s.id)}/…</code>`}</span>
      <span class="bw-btns">
        ${i > 0 && st.canEdit ? `<button data-act="src-up" data-i="${i}" title="move up">↑</button>` : ''}
        ${!first && st.canEdit ? `<button data-act="src-rm" data-i="${i}" class="danger">Remove</button>` : ''}
      </span>
    </div>
    <div class="bw-grid">
      <label class="bw-f"><span>id<em>slug; changing it renames @paths</em></span>
        <input value="${esc(s.id)}" data-bind="${b}.id" data-type="slug"${dis()}></label>
      <label class="bw-f wide"><span>folder<em>relative to the brain root, absolute, or ~/…</em></span>
        <span class="bw-path"><input value="${esc(s.path)}" data-bind="${b}.path" data-type="str"${dis()}>
        ${st.canEdit ? `<button data-act="browse" data-i="${i}">Browse…</button>` : ''}</span></label>
      ${numField(`${b}.maxDepth`, 'max depth', '0 = all levels', { min: 0 })}
      <div class="bw-f">${toggle(`${b}.content`, 'index content', 'off = paths only')}</div>
    </div>
    <div class="bw-sub">include <em>empty = every file; otherwise a file must match one</em></div>
    ${chips(`${b}.include`, 'add a pattern, e.g. *.md', [
      ['docs', 'docs'],
      ['markdown', 'markdown'],
      ['code', 'code'],
    ])}
    <div class="bw-sub">exclude <em>on top of the global rules</em></div>
    ${chips(`${b}.exclude`, 'e.g. archive/ or *.draft.md')}
    <div class="bw-foot">${
      live?.enabled
        ? `<b>${n(live.docs)}</b> files · ${size(live.bytes)} · ${skipChips(live.scan)}`
        : '<span class="bw-dim">not in the current index</span>'
    }</div>
  </div>`
}

function browser(): string {
  const b = st.browse
  if (!b) return ''
  return `<div class="bw-browse">
    <div class="bw-h"><b>Choose a folder</b><span class="bw-btns"><button data-act="browse-close">Cancel</button></span></div>
    <div class="bw-crumb">
      ${b.parent ? `<button data-act="browse-go" data-path="${esc(b.parent)}">↑ up</button>` : ''}
      <code>${esc(b.path)}</code>
      <button class="primary" data-act="browse-pick" data-path="${esc(b.path)}">Use this folder</button>
    </div>
    <div class="bw-dirs">${
      b.dirs.length
        ? b.dirs
            .map(
              (d) =>
                `<button data-act="browse-go" data-path="${esc(`${b.path.replace(/\/$/, '')}/${d}`)}">📁 ${esc(d)}</button>`,
            )
            .join('')
        : '<span class="bw-dim">no sub-folders</span>'
    }</div>
  </div>`
}

function sources(): string {
  const d = st.draft
  if (!d) return ''
  return `
    <p class="bw-lede">Folders the brain reads. The first source keeps plain paths, so routers and links
      keep working; the others are namespaced by id. Hover a skip count to see example files.</p>
    ${browser()}
    ${d.sources.map(sourceCard).join('')}
    ${st.canEdit ? '<button class="bw-add" data-act="src-add">+ Add a folder</button>' : ''}`
}

function rules(): string {
  const d = st.draft
  if (!d) return ''
  const f = st.files
  return `
    <div class="bw-card">
      <div class="bw-h"><b>Global exclude</b><span class="bw-dim">applies to every source</span></div>
      <div class="bw-help">
        <div><code>docs/old/</code><span>no wildcard: path prefix</span></div>
        <div><code>*.log</code><span>no slash: file name, any depth</span></div>
        <div><code>src/**/*.test.ts</code><span>with slash: whole path · <code>**</code> spans folders</span></div>
      </div>
      ${chips('exclude', 'add a pattern and press Enter')}
    </div>
    <div class="bw-card">
      <div class="bw-h"><b>Test a pattern</b><span class="bw-dim">against the files indexed now</span></div>
      <div class="bw-path"><input data-files="pattern" value="${esc(f.pattern)}" placeholder="e.g. research/**/*.md">
        ${f.pattern && st.canEdit ? `<button data-act="pattern-exclude">Add to global exclude</button>` : ''}</div>
      ${
        f.pattern
          ? `<div class="bw-dim bw-pad">${n(f.total)} indexed file${f.total === 1 ? '' : 's'} match</div>
        <div class="bw-list short">${f.rows
          .slice(0, 30)
          .map(
            (r) =>
              `<div data-act="open-file" data-path="${esc(r.path)}"><span>${esc(r.path)}</span><b>${size(r.bytes)}</b></div>`,
          )
          .join('')}</div>`
          : ''
      }
    </div>
    <div class="bw-row">
      <div class="bw-card grow">
        <div class="bw-h"><b>Skipped folder names</b><span class="bw-dim">matched by name at any depth</span></div>
        ${chips('ignoreDirs', 'e.g. archive')}
        <div class="bw-sub">built in</div>
        <div class="bw-fixed">${st.builtin.ignoreDirs.map((x) => `<code>${esc(x)}</code>`).join('')}</div>
      </div>
      <div class="bw-card grow">
        <div class="bw-h"><b>Always skipped</b><span class="bw-dim">no recoverable text</span></div>
        <div class="bw-sub">binary</div>
        <div class="bw-fixed">${st.builtin.binary.map((x) => `<code>.${esc(x)}</code>`).join('')}</div>
        <div class="bw-sub">build output & machine data</div>
        <div class="bw-fixed">${st.builtin.noise.map((x) => `<code>.${esc(x)}</code>`).join('')}</div>
      </div>
    </div>
    <div class="bw-card">
      <div class="bw-h"><b>Document extraction</b></div>
      ${toggle('extract', 'extract text from pdf, docx, rtf, odt and html', st.status ? `pdftotext ${st.status.tools.pdftotext ? '✓' : '✗'} · textutil ${st.status.tools.textutil ? '✓' : '✗'}` : '')}
    </div>`
}

function ranking(): string {
  const d = st.draft
  if (!d) return ''
  const w = d.weights
  const paths = st.files.rows.length ? st.files.rows : []
  return `
    <div class="bw-card">
      <div class="bw-h"><b>Content</b></div>
      ${toggle('content.enabled', 'index what is inside files', 'off = paths and routers only')}
      <div class="bw-grid">
        ${numField('content.maxTokensPerDoc', 'tokens per file', 'distinct words kept; stops one big file dominating', { min: 10, step: 50 })}
        ${numField('content.maxBytes', 'max file size', 'larger files are indexed by path only', { min: 0.01, step: 0.5, scale: 1048576, unit: 'MB' })}
        ${numField('maxFilesPerSource', 'files per source', 'the scan stops here', { min: 1, step: 1000 })}
        ${numField('refreshSecs', 'auto refresh', 'seconds an index is reused; 0 = manual only', { min: 0, step: 5, unit: 's' })}
      </div>
    </div>
    <div class="bw-card">
      <div class="bw-h"><b>Ranking weights</b><span class="bw-btns">${st.canEdit ? '<button data-act="weights-reset">Reset</button>' : ''}</span></div>
      <p class="bw-lede">How much a match in each place counts. Router descriptions are written for retrieval,
        so by default they outrank a filename that happens to share a word.</p>
      ${(Object.keys(w) as (keyof typeof w)[])
        .map(
          (k) => `<label class="bw-w"><span>${k}<em>${WEIGHT_HELP[k]}</em></span>
        <input type="range" min="0" max="20" step="0.5" value="${w[k]}" data-bind="weights.${k}" data-type="num"${dis()}>
        <b>${w[k]}</b></label>`,
        )
        .join('')}
    </div>
    <div class="bw-card">
      <div class="bw-h"><b>Topics</b><span class="bw-dim">a keyword that always answers with one file</span></div>
      <table class="bw-t topics">
        <tr><th>keyword</th><th>file</th><th></th></tr>
        ${Object.entries(d.topics)
          .map(
            ([k, p]) => `<tr><td><code>${esc(k)}</code></td><td><code>${esc(p)}</code></td>
          <td class="r">${st.canEdit ? `<button data-act="topic-rm" data-k="${esc(k)}">×</button>` : ''}</td></tr>`,
          )
          .join('')}
        ${
          st.canEdit
            ? `<tr class="add"><td><input id="bw-tk" placeholder="keyword"></td>
          <td><input id="bw-tp" placeholder="path of an indexed file" list="bw-paths"></td>
          <td class="r"><button data-act="topic-add">Add</button></td></tr>`
            : ''
        }
      </table>
      <datalist id="bw-paths">${paths.map((r) => `<option value="${esc(r.path)}">`).join('')}</datalist>
    </div>`
}

function files(): string {
  const f = st.files
  const s = st.status
  const det = st.detail
  return `
    <div class="bw-filebar">
      <input data-files="q" value="${esc(f.q)}" placeholder="filter by path">
      <select data-files="source"><option value="">all sources</option>${(s?.sources ?? [])
        .filter((x) => x.enabled)
        .map(
          (x) =>
            `<option value="${esc(x.id)}"${f.source === x.id ? ' selected' : ''}>${esc(x.id)}</option>`,
        )
        .join('')}</select>
      <select data-files="sort">${[
        ['path', 'by path'],
        ['bytes', 'largest'],
        ['tokens', 'most tokens'],
        ['mtime', 'recently changed'],
      ]
        .map(([v, l]) => `<option value="${v}"${f.sort === v ? ' selected' : ''}>${l}</option>`)
        .join('')}</select>
      <span class="bw-dim">${n(f.total)} file${f.total === 1 ? '' : 's'}${f.total > f.rows.length ? ` · first ${f.rows.length}` : ''}</span>
    </div>
    <div class="bw-split">
      <div class="bw-ftable">
        <table class="bw-t hover">
          <tr><th>path</th><th>source</th><th class="r">size</th><th class="r">tokens</th><th class="r">changed</th></tr>
          ${f.rows
            .map(
              (
                r,
              ) => `<tr data-act="open-file" data-path="${esc(r.path)}" class="${det?.path === r.path ? 'sel' : ''}">
            <td class="p">${esc(r.path)}</td><td>${esc(r.source)}</td><td class="r">${size(r.bytes)}</td>
            <td class="r">${r.tokens ? n(r.tokens) : '<span class="bw-dim">—</span>'}</td>
            <td class="r">${new Date(r.mtimeMs).toLocaleDateString()}</td></tr>`,
            )
            .join('')}
        </table>
      </div>
      ${
        det
          ? `<div class="bw-card bw-detail">
        <div class="bw-h"><b title="${esc(det.path)}">${esc(det.path.split('/').pop())}</b><span class="bw-btns"><button data-act="detail-close">×</button></span></div>
        <div class="bw-dim">${esc(det.path)}</div>
        <dl class="bw-dl"><dt>source</dt><dd>${esc(det.source)}</dd><dt>size</dt><dd>${size(det.bytes)}</dd>
          <dt>changed</dt><dd>${new Date(det.mtimeMs).toLocaleString()}</dd>
          <dt>content</dt><dd>${det.tokenList.length ? `${n(det.tokenList.length)} tokens` : 'path only'}</dd></dl>
        ${
          st.canEdit
            ? `<div class="bw-btns col">
          <button data-act="ex-file">Exclude this file</button>
          <button data-act="ex-dir">Exclude its folder</button>
          <button data-act="reveal">Reveal in Finder</button></div>`
            : ''
        }
        <div class="bw-sub">tokens this file contributes</div>
        <div class="bw-tokens">${det.tokenList.map((t) => `<code>${esc(t)}</code>`).join('') || '<span class="bw-dim">none — matched by path only</span>'}</div>
      </div>`
          : ''
      }
    </div>`
}

function previewBox(): string {
  const p = st.preview
  if (!p) return ''
  const list = (xs: string[], cls: string) =>
    xs.map((x) => `<div class="${cls}">${esc(x)}</div>`).join('')
  return `<div class="bw-preview">
    <div class="bw-h"><b>Preview</b>
      <span>${n(p.total)} files would be indexed · <b class="ok">+${n(p.added)}</b> · <b class="warn">−${n(p.removed)}</b> · scanned in ${Math.round(p.ms)}ms${p.partial ? ' · <b class="warn">stopped after 8s, partial</b>' : ''}</span>
      <span class="bw-btns"><button data-act="preview-close">×</button></span></div>
    ${p.sources.map((s) => `<div class="bw-pv-src"><b>${esc(s.id)}</b> ${n(s.scan.kept)} kept · ${skipChips(s.scan)}${s.scan.capped ? '<span class="bw-skip warn">stopped at file cap</span>' : ''}</div>`).join('')}
    <div class="bw-pv">
      <div>${p.added ? `<div class="bw-sub">added${p.added > p.addedSample.length ? ` · first ${p.addedSample.length}` : ''}</div>${list(p.addedSample, 'add')}` : ''}</div>
      <div>${p.removed ? `<div class="bw-sub">removed${p.removed > p.removedSample.length ? ` · first ${p.removedSample.length}` : ''}</div>${list(p.removedSample, 'rm')}` : ''}</div>
    </div>
  </div>`
}

function render() {
  const root = st.root
  if (!root) return
  // keep focus and caret in whichever field the user is typing in
  const active = document.activeElement as HTMLInputElement | null
  const focusKey =
    active && root.contains(active)
      ? (active.dataset.bind ?? active.dataset.files ?? active.dataset.chip ?? active.id)
      : null
  const caret = focusKey ? active?.selectionStart : null
  const scroller = root.querySelector('.bw-body')
  const scroll = scroller?.scrollTop ?? 0

  const body =
    st.tab === 'overview'
      ? overview()
      : st.tab === 'sources'
        ? sources()
        : st.tab === 'rules'
          ? rules()
          : st.tab === 'ranking'
            ? ranking()
            : files()
  const changed = st.draft && dirty()
  root.innerHTML = `<div class="bw-win" role="dialog" aria-label="Brain index">
    <header class="bw-top">
      <div><b>Brain index</b><span>${st.status ? `${n(st.status.docs)} files · ${n(st.status.tokens)} tokens · ${st.status.sources.filter((s) => s.enabled).length} source${st.status.sources.filter((s) => s.enabled).length === 1 ? '' : 's'}` : 'loading…'}</span></div>
      <nav>${TABS.map(([k, l]) => `<button data-tab="${k}" class="${st.tab === k ? 'on' : ''}">${l}</button>`).join('')}</nav>
      <button class="bw-x" data-act="close" title="Close (esc)">×</button>
    </header>
    ${st.canEdit ? '' : '<div class="bw-banner">Read-only: index settings can only be changed from this machine.</div>'}
    <div class="bw-body">${body}</div>
    ${previewBox()}
    <footer class="bw-foot-bar${changed ? ' dirty' : ''}">
      <span class="bw-state">${
        st.busy
          ? `<i class="bw-spin"></i>${esc(st.busy)}`
          : st.error
            ? `<b class="warn">${esc(st.error)}</b>`
            : st.notice
              ? `<b class="ok">${esc(st.notice)}</b>`
              : changed
                ? 'Unsaved changes'
                : 'Settings match the running index'
      }</span>
      ${st.notice && !changed ? '<button data-act="reload-view">Reload graph</button>' : ''}
      <button data-act="preview"${st.busy ? ' disabled' : ''}${dis()}>Preview</button>
      <button data-act="discard"${changed && !st.busy ? '' : ' disabled'}>Discard</button>
      <button class="primary" data-act="save"${changed && !st.busy && st.canEdit ? '' : ' disabled'}>Save &amp; rebuild</button>
    </footer>
  </div>`

  const next = root.querySelector('.bw-body')
  if (next) next.scrollTop = scroll
  if (focusKey) {
    const el = root.querySelector<HTMLInputElement>(
      `[data-bind="${focusKey}"],[data-files="${focusKey}"],[data-chip="${focusKey}"],#${CSS.escape(focusKey)}`,
    )
    if (el) {
      el.focus()
      if (
        caret != null &&
        'setSelectionRange' in el &&
        el.type !== 'number' &&
        el.type !== 'range'
      ) {
        try {
          el.setSelectionRange(caret, caret)
        } catch {}
      }
    }
  }
}

// ----------------------------------------------------------------- events ----
function bind(root: HTMLElement) {
  root.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement
    if (t === root) return close()
    const tab = t.closest<HTMLElement>('[data-tab]')?.dataset.tab as Tab | undefined
    if (tab) {
      st.tab = tab
      if ((tab === 'files' || tab === 'ranking') && !st.files.rows.length) {
        await run('loading files', loadFiles)
      } else render()
      return
    }
    const a = t.closest<HTMLElement>('[data-act]')
    if (!a || (a as HTMLButtonElement).disabled) return
    const act = a.dataset.act
    const d = st.draft
    const i = Number(a.dataset.i)
    switch (act) {
      case 'close':
        return close()
      case 'chip-rm': {
        const b = a.dataset.bind ?? ''
        setAt(
          b,
          listAt(b).filter((_, j) => j !== i),
        )
        return render()
      }
      case 'preset':
        addTo(a.dataset.bind ?? '', PRESETS[a.dataset.preset ?? ''] ?? [])
        return render()
      case 'src-add':
        return openBrowser(-1)
      case 'browse':
        return openBrowser(i)
      case 'browse-go':
        return run('listing folder', () => browseTo(a.dataset.path ?? ''))
      case 'browse-close':
        st.browse = null
        browseFor = -1
        return render()
      case 'browse-pick':
        return pickFolder(a.dataset.path ?? '')
      case 'src-rm':
        if (d && i > 0) d.sources.splice(i, 1)
        return render()
      case 'src-up':
        if (d && i > 1) {
          const [s] = d.sources.splice(i, 1)
          if (s) d.sources.splice(i - 1, 0, s)
        } else if (d && i === 1) {
          // promoting to first changes which source keeps plain paths — say so
          if (
            !confirm(
              'The first source keeps plain paths; the others become @id/… Make this the first source?',
            )
          )
            return
          const [s] = d.sources.splice(1, 1)
          if (s) d.sources.unshift(s)
        }
        return render()
      case 'weights-reset':
        if (d && st.defaults) d.weights = clone(st.defaults.weights)
        return render()
      case 'topic-add': {
        const k = (root.querySelector<HTMLInputElement>('#bw-tk')?.value ?? '').trim().toLowerCase()
        const p = (root.querySelector<HTMLInputElement>('#bw-tp')?.value ?? '').trim()
        if (d && k && p) d.topics = { ...d.topics, [k]: p }
        return render()
      }
      case 'topic-rm':
        if (d) {
          const { [a.dataset.k ?? '']: _, ...rest } = d.topics
          d.topics = rest
        }
        return render()
      case 'pattern-exclude':
        addTo('exclude', [st.files.pattern])
        st.tab = 'rules'
        return render()
      case 'open-file':
        return run('reading file', () => openFile(a.dataset.path ?? ''))
      case 'detail-close':
        st.detail = null
        return render()
      case 'ex-file':
      case 'ex-dir':
        return excludeDetail(act === 'ex-dir')
      case 'reveal':
        if (st.detail) fetch(`/api/reveal?path=${encodeURIComponent(st.detail.path)}`)
        return
      case 'rebuild':
      case 'rebuild-full':
        return run(act === 'rebuild' ? 'rebuilding' : 'full rebuild', async () => {
          const r = await api<{ status: Status }>('/api/index/rebuild', {
            method: 'POST',
            body: JSON.stringify({ full: act === 'rebuild-full' }),
          })
          st.status = r.status
          st.notice = `Rebuilt · ${n(r.status.docs)} files`
        })
      case 'preview':
        return run('scanning', async () => {
          st.preview = await api<Preview>('/api/index/preview', {
            method: 'POST',
            body: JSON.stringify(st.draft),
          })
        })
      case 'preview-close':
        st.preview = null
        return render()
      case 'discard':
        st.draft = clone(st.saved)
        st.preview = null
        return render()
      case 'save':
        return run('saving and rebuilding', async () => {
          const r = await api<{ config: IndexConfig; status: Status }>('/api/index/config', {
            method: 'PUT',
            body: JSON.stringify(st.draft),
          })
          st.saved = r.config
          st.draft = clone(r.config)
          st.status = r.status
          st.preview = null
          st.notice = `Saved · ${n(r.status.docs)} files indexed`
          st.files.rows = []
          if (st.tab === 'files' || st.tab === 'ranking') await loadFiles()
        })
      case 'reload-view':
        location.reload()
        return
    }
  })

  const onInput = (e: Event, commit: boolean) => {
    const el = e.target as HTMLInputElement
    const b = el.dataset.bind
    if (b && st.draft) {
      const type = el.dataset.type
      let v: unknown = el.value
      if (type === 'bool') v = el.checked
      else if (type === 'num') {
        if (el.value === '') return
        v = Number(el.value) * Number(el.dataset.scale ?? 1)
      } else if (type === 'slug') v = slug(el.value)
      else if (type === 'str' && b.endsWith('.label') && !el.value) {
        const owner = getAt(b.slice(0, -'.label'.length)) as Record<string, unknown>
        delete owner.label
        st.notice = ''
        return render()
      }
      setAt(b, v)
      st.notice = ''
      // text fields re-render on commit only, so typing is never interrupted
      if (commit || type === 'bool' || el.type === 'range') render()
      return
    }
    const f = el.dataset.files as 'q' | 'source' | 'sort' | 'pattern' | undefined
    if (f) {
      st.files[f] = el.value
      clearTimeout(filesTimer)
      filesTimer = window.setTimeout(() => run('', loadFiles), 180)
    }
  }
  let filesTimer = 0
  root.addEventListener('input', (e) => onInput(e, false))
  root.addEventListener('change', (e) => onInput(e, true))
  root.addEventListener('keydown', (e) => {
    // Escape is handled by onKey, which runs first in the capture phase
    const el = e.target as HTMLInputElement
    if (e.key === 'Enter' && el.dataset.chip) {
      e.preventDefault()
      addTo(
        el.dataset.chip,
        el.value.split(',').map((x) => x.trim()),
      )
      el.value = ''
      render()
    }
  })
}

let browseFor = -1
async function browseTo(path: string) {
  const q = path ? `?path=${encodeURIComponent(path)}` : ''
  st.browse = await api<{ path: string; parent: string | null; dirs: string[] }>(
    `/api/index/dirs${q}`,
  )
}
function openBrowser(i: number) {
  browseFor = i
  const start =
    i >= 0 ? (st.status?.sources.find((s) => s.id === st.draft?.sources[i]?.id)?.dir ?? '') : ''
  return run('listing folder', () => browseTo(start))
}
function pickFolder(path: string) {
  const d = st.draft
  if (!d) return
  if (browseFor >= 0) {
    const s = d.sources[browseFor]
    if (s) s.path = path
  } else {
    const base = slug(path.split('/').filter(Boolean).pop() ?? 'source')
    let id = base
    for (let k = 2; d.sources.some((s) => s.id === id); k++) id = `${base}-${k}`
    d.sources.push({
      id,
      label: path.split('/').filter(Boolean).pop() ?? id,
      path,
      enabled: true,
      include: [...(PRESETS.docs ?? [])],
      exclude: [],
      content: true,
      maxDepth: 0,
    })
  }
  st.browse = null
  browseFor = -1
  st.tab = 'sources'
  render()
}

async function openFile(path: string) {
  const d = await api<Omit<FileRow, 'tokens'> & { tokens: string[] }>(
    `/api/index/doc?path=${encodeURIComponent(path)}`,
  )
  st.detail = { ...d, tokens: d.tokens.length, tokenList: d.tokens }
  if (st.tab !== 'files') {
    st.tab = 'files'
    if (!st.files.rows.length) await loadFiles()
  }
}

/** Add the open file (or its folder) to its own source's exclude list. */
function excludeDetail(folder: boolean) {
  const det = st.detail
  const d = st.draft
  if (!det || !d) return
  const i = d.sources.findIndex((s) => s.id === det.source)
  if (i < 0) return
  const rel = det.path.replace(/^@[^/]+\//, '')
  const pattern = folder ? `${rel.split('/').slice(0, -1).join('/')}/` : rel
  if (pattern === '/') {
    st.error = 'That file is at the top of its source; exclude it by name instead.'
    return render()
  }
  addTo(`sources.${i}.exclude`, [pattern])
  st.notice = ''
  st.error = ''
  render()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && st.root?.classList.contains('on')) {
    e.stopImmediatePropagation()
    if (st.browse) {
      st.browse = null
      render()
    } else close()
  }
}

function close() {
  if (dirty() && !confirm('Discard unsaved index changes?')) return
  st.draft = clone(st.saved)
  st.preview = null
  st.root?.classList.remove('on')
  clearInterval(st.poll)
  removeEventListener('keydown', onKey, true)
}

export async function openBrainWindow(tab?: Tab) {
  if (!st.root) {
    st.root = document.createElement('div')
    st.root.id = 'bw'
    document.body.appendChild(st.root)
    bind(st.root)
  }
  if (tab) st.tab = tab
  st.notice = ''
  st.root.classList.add('on')
  addEventListener('keydown', onKey, true)
  render()
  await run('loading', load)
  // keep the live numbers moving while a build runs elsewhere (auto refresh, CLI)
  clearInterval(st.poll)
  st.poll = window.setInterval(async () => {
    if (st.busy || document.hidden) return
    try {
      const was = JSON.stringify(st.status)
      await load()
      if (JSON.stringify(st.status) !== was && st.tab === 'overview') render()
    } catch {}
  }, 5000)
}
