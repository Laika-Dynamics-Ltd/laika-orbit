import { parseRouter } from './router.ts'
import { tokenise } from './tokenise.ts'
import type { DocMeta, Store } from './types.ts'

/**
 * Weights. Router descriptions are hand-written FOR retrieval, so they outrank a
 * filename match, which is often incidental — "where do claims live" should not
 * be won by a file that happens to be called live-builds.sh.
 */
/**
 * Which files are routers. They live in the primary source only: an `@source/…/CLAUDE.md`
 * is another repo's agent notes, not a catalogue of this brain.
 */
export const ROUTER_PATH = /^(?!@)(.*\/)?(routers\/.+\.md|CLAUDE\.md)$/i

export const W = { topic: 8, catalogue: 4, filename: 2, content: 1 } as const

export interface BrainIndex {
  docs: DocMeta[]
  /** path -> distinct content tokens, kept so an incremental rebuild can skip re-reading */
  contentTokens: Map<string, string[]>
  /** how many documents were re-read on the last build, vs reused */
  reread: number
  byPath: Map<string, number>
  /** token -> flat [docId, weight, docId, weight, ...] */
  postings: Map<string, number[]>
  topics: Map<string, string>
  builtAt: number
  routerCount: number
  pointerCount: number
  /** documents whose content was indexed (fresh or reused) */
  contentDocs: number
  /** documents skipped for content because they exceeded maxBytes */
  tooLarge: number
}

const add = (postings: Map<string, number[]>, tok: string, id: number, w: number) => {
  let a = postings.get(tok)
  if (!a) {
    a = []
    postings.set(tok, a)
  }
  a.push(id, w)
}

/**
 * A previously built index, reused to skip unchanged files.
 * Content is only re-read when size or mtime moved, which is what makes
 * re-indexing a large corpus cheap.
 */
export interface PriorIndex {
  docs: DocMeta[]
  contentTokens?: Map<string, string[]>
}

export interface BuildOpts {
  topics?: Map<string, string>
  routerGlob?: RegExp
  /**
   * Index document CONTENT at the lowest weight. Essential when a workspace has no
   * router files yet — otherwise scoring is filename-only. Curated pointers still
   * outrank content, so this never drowns a well-routed brain.
   */
  indexContent?: boolean
  /** cap distinct tokens taken from any one document, so a huge file can't dominate */
  maxTokensPerDoc?: number
  onProgress?: (done: number, total: number) => void
  /** previous index; unchanged files reuse their cached tokens */
  prior?: BrainIndex | undefined
  /** per-field weights; defaults to W */
  weights?: Partial<Record<keyof typeof W, number>>
  /** files above this size are indexed by path only (default 2 MiB) */
  maxBytes?: number
  /** per-document content switch, e.g. a source with content indexing off */
  contentFor?: (path: string) => boolean
}

/**
 * Inverted index built once at index time. Recall is then O(query tokens),
 * not O(corpus) — which is how this beats brain.js's per-query list scan.
 */
export async function buildIndex(store: Store, opts: BuildOpts = {}): Promise<BrainIndex> {
  const routerGlob = opts.routerGlob ?? ROUTER_PATH
  const docs: DocMeta[] = []
  const byPath = new Map<string, number>()
  const postings = new Map<string, number[]>()
  let routerCount = 0
  let pointerCount = 0
  let reread = 0
  const contentTokens = new Map<string, string[]>()
  const w = { ...W, ...opts.weights }
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024
  let contentDocs = 0
  let tooLarge = 0

  for await (const d of store.listDocs()) {
    const id = docs.length
    docs.push({ ...d, id })
    byPath.set(d.path, id)
    for (const t of tokenise(d.path.replace(/[/_.-]/g, ' '))) add(postings, t, id, w.filename)
  }

  for (const d of docs) {
    if (!routerGlob.test(d.path)) continue
    routerCount++
    const text = await store.readDoc(d.path).catch(() => '')
    if (!text) continue
    const { pointers } = parseRouter(text, d.path)
    for (const p of pointers) {
      pointerCount++
      // A catalogue line scores toward the document it POINTS AT when that
      // document exists; otherwise toward the router that declares it.
      const target = byPath.get(p.path.replace(/^\.\//, '')) ?? d.id
      for (const t of tokenise(`${p.path} ${p.description} ${p.stage ?? ''}`)) {
        add(postings, t, target, w.catalogue)
      }
    }
  }

  if (opts.indexContent) {
    const cap = opts.maxTokensPerDoc ?? 400
    // A file is unchanged if its size AND mtime both match the prior build. That
    // is the whole trick: hashing every file would cost the read we are avoiding.
    const priorMeta = new Map(opts.prior?.docs.map((d) => [d.path, d]) ?? [])
    const priorTokens = opts.prior?.contentTokens
    let done = 0
    for (const d of docs) {
      done++
      if (opts.contentFor && !opts.contentFor(d.path)) continue
      if (d.bytes > maxBytes) {
        tooLarge++ // pathological or deliberately capped: path-only
        continue
      }

      const was = priorMeta.get(d.path)
      const cached =
        was && was.bytes === d.bytes && was.mtimeMs === d.mtimeMs
          ? priorTokens?.get(d.path)
          : undefined

      let toks: string[]
      if (cached) {
        toks = cached
      } else {
        const text = await store.readDoc(d.path).catch(() => '')
        reread++
        const seen = new Set<string>()
        for (const t of tokenise(text)) {
          if (seen.size >= cap) break
          seen.add(t)
        }
        toks = [...seen]
      }
      contentTokens.set(d.path, toks)
      contentDocs++
      for (const t of toks) add(postings, t, d.id, w.content)
      if (done % 200 === 0) opts.onProgress?.(done, docs.length)
    }
    opts.onProgress?.(docs.length, docs.length)
  }

  const topics = opts.topics ?? new Map()
  for (const [topic, path] of topics) {
    const id = byPath.get(path)
    if (id === undefined) continue
    for (const t of tokenise(topic)) add(postings, t, id, w.topic)
  }

  return {
    docs,
    byPath,
    postings,
    topics,
    contentTokens,
    reread,
    builtAt: Date.now(),
    routerCount,
    pointerCount,
    contentDocs,
    tooLarge,
  }
}
