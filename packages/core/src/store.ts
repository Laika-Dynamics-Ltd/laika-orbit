import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { anyOf, type IndexConfig, sourceDir } from './config.ts'
import { EXTRACTABLE, extractText } from './extract.ts'
import type { DocMeta, Store } from './types.ts'

// Skip by directory only where it is genuinely not knowledge; skip binaries by
// extension rather than by folder name, so a README inside an image folder still indexes.
// Directories that are never knowledge: VCS internals, caches, build output.
export const DEFAULT_IGNORE = [
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.vite',
  '.turbo',
  '.cache',
  'coverage',
  '.DS_Store',
  '__pycache__',
  '.venv',
  'venv',
  'Pods',
  'DerivedData',
  '.gradle',
  'target',
  'vendor',
  '.terraform',
  '.pnpm-store',
  '.1brain',
]
// Path PREFIXES to skip. Directory-name matching is too blunt here: `.gauntlet`
// holds scratch working copies AND the bar definition and results, which are
// genuine documentation. Prefixes let us drop the scratch and keep the prose.
// Trailing slash matters: '.gauntlet/bar' would also swallow '.gauntlet/bar.md',
// which is the bar definition and very much knowledge.
export const IGNORE_PREFIX = [
  '.gauntlet/work/',
  '.gauntlet/work2/',
  '.gauntlet/champion',
  '.gauntlet/void-run-1/',
  '.gauntlet/bar/',
  '.gauntlet/bar2/',
]
// Build artefacts and machine data that pollute a filename index with noise.
export const NOISE =
  /\.(pcm|dat|o|d|map|scan|dia|lock|log|tsbuildinfo|pyc|class|so|dylib|bin|obj|pdb|sqlite3?)$/i
// Opaque binaries with no recoverable text. PDF/DOCX are NOT here — they get extracted.
export const BINARY =
  /\.(png|jpe?g|gif|webp|svg|avif|heic|bmp|tiff?|mp4|webm|mov|mp3|wav|aiff?|zip|gz|tar|dmg|ico|woff2?|ttf|otf|eot|jsonl|psd|ai|sketch|fig)$/i
/**
 * Images are binary, so they are skipped by default — but a source whose `include` list
 * names them ("*.png") gets them as path-only documents: findable by name, previewable in
 * the app, never read for content.
 */
export const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|heic|bmp|tiff?)$/i

/** Why files were left out of the last scan — the index panel shows these. */
export interface ScanStats {
  seen: number
  kept: number
  bytes: number
  skipped: {
    ignoredDir: number
    binary: number
    noise: number
    excluded: number
    notIncluded: number
    tooDeep: number
    overCap: number
  }
  /** first few of each skip reason, so a rule can be checked against real files */
  examples: Record<string, string[]>
  ms: number
  /** the walk stopped at maxFiles; there may be many more files than `overCap` shows */
  capped: boolean
  /** still walking — stats are live */
  running: boolean
}

export interface FsStoreOpts {
  extract?: boolean
  /** path prefixes / globs to skip; defaults to IGNORE_PREFIX */
  exclude?: string[]
  /** when non-empty, only matching files are kept */
  include?: string[]
  /** folder levels to descend; 0 = unlimited */
  maxDepth?: number
  maxFiles?: number
}

const blankStats = (): ScanStats => ({
  seen: 0,
  kept: 0,
  bytes: 0,
  skipped: {
    ignoredDir: 0,
    binary: 0,
    noise: 0,
    excluded: 0,
    notIncluded: 0,
    tooDeep: 0,
    overCap: 0,
  },
  examples: {},
  ms: 0,
  capped: false,
  running: true,
})

export class LocalFsStore implements Store {
  #root: string
  #ignore: Set<string>
  #extract: boolean
  #excluded: (rel: string) => boolean
  #included: ((rel: string) => boolean) | null
  #maxDepth: number
  #maxFiles: number
  /** stats from the most recent listDocs(), updated live while it runs */
  lastScan: ScanStats = blankStats()

  constructor(root: string, ignore: string[] = [], opts: FsStoreOpts = {}) {
    this.#root = root
    this.#ignore = new Set([...DEFAULT_IGNORE, ...ignore])
    this.#extract = opts.extract ?? true
    this.#excluded = anyOf(opts.exclude ?? IGNORE_PREFIX)
    this.#included = opts.include?.length ? anyOf(opts.include) : null
    this.#maxDepth = opts.maxDepth ?? 0
    this.#maxFiles = opts.maxFiles ?? Number.POSITIVE_INFINITY
  }
  root() {
    return this.#root
  }
  abs(path: string) {
    return join(this.#root, path)
  }
  /** Plain text directly; document formats (docx/pdf/rtf) are extracted and cached first. */
  async readDoc(path: string) {
    const abs = join(this.#root, path)
    if (IMAGE.test(path)) return '' // pixels are not text; the file name is all that indexes
    if (this.#extract && EXTRACTABLE.test(path)) {
      const t = await extractText(abs, { cacheDir: join(this.#root, '.1brain', 'cache') })
      if (t !== null) return t
    }
    return readFile(abs, 'utf8')
  }

  async *listDocs(): AsyncIterable<DocMeta> {
    const t0 = performance.now()
    const st = blankStats()
    this.lastScan = st
    const note = (why: keyof ScanStats['skipped'], rel: string) => {
      st.skipped[why]++
      st.examples[why] ??= []
      const ex = st.examples[why]
      if (ex.length < 8) ex.push(rel)
    }
    let id = 0
    const walk = async function* (
      this: LocalFsStore,
      dir: string,
      depth: number,
    ): AsyncIterable<DocMeta> {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (st.capped) return
        const abs = join(dir, e.name)
        const rel = relative(this.#root, abs).split(sep).join('/')
        if (this.#ignore.has(e.name)) {
          note('ignoredDir', rel)
          continue
        }
        if (e.isDirectory()) {
          // an excluded folder is pruned whole instead of being walked file by file
          if (this.#excluded(`${rel}/`)) {
            note('excluded', `${rel}/`)
            continue
          }
          if (this.#maxDepth && depth >= this.#maxDepth) {
            note('tooDeep', `${rel}/`)
            continue
          }
          yield* walk.call(this, abs, depth + 1)
          continue
        }
        if (!e.isFile() && !e.isSymbolicLink()) continue
        st.seen++
        if (BINARY.test(e.name) && !(IMAGE.test(e.name) && this.#included?.(rel))) {
          note('binary', rel)
          continue
        }
        if (NOISE.test(e.name)) {
          note('noise', rel)
          continue
        }
        if (this.#excluded(rel)) {
          note('excluded', rel)
          continue
        }
        if (this.#included && !this.#included(rel)) {
          note('notIncluded', rel)
          continue
        }
        if (st.kept >= this.#maxFiles) {
          // stop rather than walk the rest of a huge tree just to count it
          note('overCap', rel)
          st.capped = true
          return
        }
        const s = await stat(abs).catch(() => null)
        if (!s?.isFile()) continue
        st.kept++
        st.bytes += s.size
        yield { id: id++, path: rel, bytes: s.size, mtimeMs: s.mtimeMs }
      }
    }
    yield* walk.call(this, this.#root, 0)
    st.ms = performance.now() - t0
    st.running = false
  }
}

/**
 * Several folders presented as one store. The first source keeps plain relative
 * paths (so routers and existing links keep working); every other source is
 * addressed as `@<id>/<path>`.
 */
export class SourcedStore implements Store {
  readonly parts: { id: string; prefix: string; store: LocalFsStore; content: boolean }[]
  #root: string

  constructor(root: string, cfg: IndexConfig) {
    this.#root = root
    const on = cfg.sources.filter((s) => s.enabled)
    this.parts = on.map((s, i) => ({
      id: s.id,
      prefix: i === 0 && s === cfg.sources[0] ? '' : `@${s.id}/`,
      content: s.content,
      store: new LocalFsStore(sourceDir(root, s), cfg.ignoreDirs, {
        extract: cfg.extract,
        exclude: [...cfg.exclude, ...s.exclude],
        include: s.include,
        maxDepth: s.maxDepth,
        maxFiles: cfg.maxFilesPerSource,
      }),
    }))
  }
  root() {
    return this.#root
  }
  #route(path: string) {
    const part =
      this.parts.find((p) => p.prefix && path.startsWith(p.prefix)) ??
      this.parts.find((p) => !p.prefix)
    if (!part) throw new Error(`no enabled source for ${path}`)
    return { part, rel: path.slice(part.prefix.length) }
  }
  /** absolute path on disk for an index path */
  abs(path: string) {
    const { part, rel } = this.#route(path)
    return part.store.abs(rel)
  }
  sourceOf(path: string) {
    return this.#route(path).part.id
  }
  /** whether a document's content should be indexed, per its source */
  contentFor(path: string) {
    return this.#route(path).part.content
  }
  readDoc(path: string) {
    const { part, rel } = this.#route(path)
    return part.store.readDoc(rel)
  }
  async *listDocs(): AsyncIterable<DocMeta> {
    let id = 0
    for (const p of this.parts) {
      for await (const d of p.store.listDocs()) {
        yield { ...d, id: id++, path: p.prefix + d.path }
      }
    }
  }
}
