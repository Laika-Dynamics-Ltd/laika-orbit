/**
 * The Files view of a repo workspace: the repo's files as a tree you can filter, and the
 * selected file on the right: Markdown rendered, code highlighted with line numbers.
 * Data comes from /api/control/git/files and /api/control/git/file.
 */
import { highlight, renderMarkdown } from './quicklook.ts'

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[<>&"']/g,
    (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[m] as string,
  )
const extOf = (p: string) => (/\.([a-z0-9]+)$/i.exec(p)?.[1] ?? '').toLowerCase()

type Node = { name: string; path: string; dirs: Map<string, Node>; files: string[] }

export type FilesView = { el: HTMLElement; refresh(): Promise<void>; open(path: string): void }

export function createFilesView(cwd: string): FilesView {
  const el = document.createElement('div')
  el.className = 'sf'
  el.innerHTML = `
    <aside class="sf-tree">
      <input class="sf-q" placeholder="Filter files" aria-label="Filter files" />
      <div class="sf-list"></div>
    </aside>
    <section class="sf-view"><div class="sf-empty">Choose a file to read it here.</div></section>`
  const list = el.querySelector('.sf-list') as HTMLElement
  const view = el.querySelector('.sf-view') as HTMLElement
  const q = el.querySelector('.sf-q') as HTMLInputElement
  let files: string[] = []
  const openDirs = new Set<string>([''])
  let current = ''

  const build = (paths: string[]): Node => {
    const root: Node = { name: '', path: '', dirs: new Map(), files: [] }
    for (const p of paths) {
      const parts = p.split('/')
      let n = root
      for (let i = 0; i < parts.length - 1; i++) {
        const name = parts[i] as string
        let next = n.dirs.get(name)
        if (!next) {
          next = { name, path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [] }
          n.dirs.set(name, next)
        }
        n = next
      }
      n.files.push(p)
    }
    return root
  }

  function paintTree() {
    const needle = q.value.trim().toLowerCase()
    if (needle) {
      // filtering flattens the tree: every match, with its folder shown quietly
      const hits = files.filter((f) => f.toLowerCase().includes(needle)).slice(0, 400)
      list.innerHTML = hits.length
        ? hits
            .map((f) => {
              const cut = f.lastIndexOf('/')
              return `<button type="button" class="sf-f${f === current ? ' on' : ''}" data-file="${esc(f)}" style="--d:0"><b>${esc(f.slice(cut + 1))}</b><em>${esc(f.slice(0, cut + 1))}</em></button>`
            })
            .join('')
        : '<p class="sf-none">No files match.</p>'
      return
    }
    const out: string[] = []
    const walk = (n: Node, depth: number) => {
      for (const d of [...n.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const isOpen = openDirs.has(d.path)
        out.push(
          `<button type="button" class="sf-d${isOpen ? ' open' : ''}" data-dir="${esc(d.path)}" style="--d:${depth}"><i>${isOpen ? '▾' : '▸'}</i>${esc(d.name)}</button>`,
        )
        if (isOpen) walk(d, depth + 1)
      }
      for (const f of [...n.files].sort((a, b) => a.localeCompare(b))) {
        out.push(
          `<button type="button" class="sf-f${f === current ? ' on' : ''}" data-file="${esc(f)}" style="--d:${depth}"><b>${esc(f.slice(f.lastIndexOf('/') + 1))}</b></button>`,
        )
      }
    }
    walk(build(files), 0)
    list.innerHTML = out.join('') || '<p class="sf-none">No files.</p>'
  }

  async function open(path: string) {
    current = path
    // reveal it in the tree
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) openDirs.add(parts.slice(0, i).join('/'))
    paintTree()
    view.innerHTML = `<div class="sf-head"><b>${esc(path)}</b></div><div class="sf-empty">Loading…</div>`
    const d = await fetch(
      `/api/control/git/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`,
    )
      .then((r) => r.json())
      .catch(() => ({ error: 'Could not read the file' }))
    if (current !== path) return
    const head = `<div class="sf-head"><b>${esc(path)}</b>${d.size !== undefined ? `<span>${(d.size / 1024).toFixed(1)} KB</span>` : ''}</div>`
    if (d.error) view.innerHTML = `${head}<div class="sf-empty">${esc(d.error)}</div>`
    else if (d.binary) view.innerHTML = `${head}<div class="sf-empty">Binary file</div>`
    else if (d.tooBig) view.innerHTML = `${head}<div class="sf-empty">Too large to show here</div>`
    else if (/^(md|mdx|markdown)$/.test(extOf(path))) {
      view.innerHTML = `${head}<div class="sf-body ss-md">${renderMarkdown(String(d.text))}</div>`
    } else {
      const text = String(d.text).replace(/\n$/, '')
      const lines = text.split('\n').length
      const gutter = Array.from({ length: lines }, (_, i) => i + 1).join('\n')
      view.innerHTML = `${head}<div class="sf-code"><pre class="sf-gut" aria-hidden="true">${gutter}</pre><pre class="sf-src">${highlight(text, extOf(path))}</pre></div>`
    }
    view.scrollTop = 0
  }

  async function refresh() {
    files = await fetch(`/api/control/git/files?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => [])
    paintTree()
  }

  list.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    const dir = t.closest<HTMLElement>('[data-dir]')?.dataset.dir
    if (dir !== undefined) {
      if (openDirs.has(dir)) openDirs.delete(dir)
      else openDirs.add(dir)
      return paintTree()
    }
    const file = t.closest<HTMLElement>('[data-file]')?.dataset.file
    if (file) open(file)
  })
  q.addEventListener('input', paintTree)

  return { el, refresh, open }
}
