import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { type BuildOpts, W } from './index-build.ts'

/**
 * What gets indexed, and how. One file — `brain/index.config.json` — read by the app,
 * the CLI and the MCP server alike, so the index you tune in the UI is the index an
 * agent recalls against. A missing file means the built-in defaults, which reproduce
 * the behaviour from before the file existed.
 */
export const CONFIG_PATH = 'brain/index.config.json'

export interface IndexSource {
  /** short slug; files from any source but the first are addressed as `@<id>/…` */
  id: string
  label?: string
  /** folder to walk: relative to the brain root, absolute, or `~/…` */
  path: string
  enabled: boolean
  /** when non-empty, a file must match one of these to be indexed */
  include: string[]
  /** files matching any of these are skipped (on top of the global list) */
  exclude: string[]
  /** index file content from this source, not just its paths */
  content: boolean
  /** directory levels below the source folder to descend; 0 = unlimited */
  maxDepth: number
}

export interface IndexConfig {
  version: 1
  sources: IndexSource[]
  /** applied to every source */
  exclude: string[]
  /** directory NAMES skipped anywhere, on top of the built-in list */
  ignoreDirs: string[]
  /** pull text out of pdf/docx/rtf/odt/html via system tools */
  extract: boolean
  content: {
    enabled: boolean
    /** distinct tokens kept per document, so one huge file cannot dominate */
    maxTokensPerDoc: number
    /** files larger than this are indexed by path only */
    maxBytes: number
  }
  weights: { topic: number; catalogue: number; filename: number; content: number }
  /** keyword → path that always answers it */
  topics: Record<string, string>
  /** safety cap on files taken from any one source */
  maxFilesPerSource: number
  /** how long an index may be reused before the app re-scans, in seconds; 0 = only on demand */
  refreshSecs: number
}

export const DEFAULT_CONFIG: IndexConfig = {
  version: 1,
  sources: [
    {
      id: 'workspace',
      label: 'This workspace',
      path: '.',
      enabled: true,
      include: [],
      exclude: [],
      content: true,
      maxDepth: 0,
    },
  ],
  // scratch working copies and captures — the prose beside them stays indexed
  exclude: [
    '.gauntlet/work/',
    '.gauntlet/work2/',
    '.gauntlet/champion',
    '.gauntlet/void-run-1/',
    '.gauntlet/bar/',
    '.gauntlet/bar2/',
  ],
  ignoreDirs: [],
  extract: true,
  content: { enabled: true, maxTokensPerDoc: 400, maxBytes: 2 * 1024 * 1024 },
  weights: { ...W },
  topics: { voice: 'brain/routers/CONTENT.md' },
  maxFilesPerSource: 50_000,
  refreshSecs: 10,
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,31}$/

const num = (v: unknown, d: number, min: number, max: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d
}
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []

/**
 * Fill gaps from the defaults and reject what cannot work. Throws with a message a
 * person can act on; the UI shows it verbatim.
 */
export function normaliseConfig(raw: unknown): IndexConfig {
  const r = (raw ?? {}) as Partial<IndexConfig>
  const d = DEFAULT_CONFIG
  const sources = (Array.isArray(r.sources) && r.sources.length ? r.sources : d.sources).map(
    (s, i): IndexSource => {
      const id = String(s?.id ?? '').trim()
      if (!SLUG.test(id)) {
        throw new Error(`source ${i + 1}: id "${id}" must be lowercase letters, digits, - or _`)
      }
      const path = String(s?.path ?? '').trim()
      if (!path) throw new Error(`source "${id}": path is required`)
      return {
        id,
        ...(s.label ? { label: String(s.label) } : {}),
        path,
        enabled: s.enabled !== false,
        include: strs(s.include),
        exclude: strs(s.exclude),
        content: s.content !== false,
        maxDepth: num(s.maxDepth, 0, 0, 64),
      }
    },
  )
  const ids = new Set<string>()
  for (const s of sources) {
    if (ids.has(s.id)) throw new Error(`source id "${s.id}" is used twice`)
    ids.add(s.id)
  }
  const w = (r.weights ?? {}) as Partial<IndexConfig['weights']>
  const c = (r.content ?? {}) as Partial<IndexConfig['content']>
  const topics: Record<string, string> = {}
  for (const [k, v] of Object.entries(r.topics ?? d.topics)) {
    if (k.trim() && String(v).trim()) topics[k.trim().toLowerCase()] = String(v).trim()
  }
  return {
    version: 1,
    sources,
    exclude: Array.isArray(r.exclude) ? strs(r.exclude) : [...d.exclude],
    ignoreDirs: strs(r.ignoreDirs),
    extract: r.extract !== false,
    content: {
      enabled: c.enabled !== false,
      maxTokensPerDoc: num(c.maxTokensPerDoc, d.content.maxTokensPerDoc, 10, 20_000),
      maxBytes: num(c.maxBytes, d.content.maxBytes, 1_000, 200_000_000),
    },
    weights: {
      topic: num(w.topic, d.weights.topic, 0, 100),
      catalogue: num(w.catalogue, d.weights.catalogue, 0, 100),
      filename: num(w.filename, d.weights.filename, 0, 100),
      content: num(w.content, d.weights.content, 0, 100),
    },
    topics,
    maxFilesPerSource: num(r.maxFilesPerSource, d.maxFilesPerSource, 1, 2_000_000),
    refreshSecs: num(r.refreshSecs, d.refreshSecs, 0, 86_400),
  }
}

export async function loadIndexConfig(root: string): Promise<IndexConfig> {
  const text = await readFile(join(root, CONFIG_PATH), 'utf8').catch(() => null)
  return text === null ? normaliseConfig(DEFAULT_CONFIG) : normaliseConfig(JSON.parse(text))
}

export async function saveIndexConfig(root: string, raw: unknown): Promise<IndexConfig> {
  const cfg = normaliseConfig(raw)
  await writeFile(join(root, CONFIG_PATH), `${JSON.stringify(cfg, null, 2)}\n`)
  return cfg
}

/** A source's folder on disk. */
export function sourceDir(root: string, s: Pick<IndexSource, 'path'>): string {
  if (s.path === '~' || s.path.startsWith('~/')) return join(homedir(), s.path.slice(1))
  return isAbsolute(s.path) ? s.path : resolve(root, s.path)
}

/**
 * Pattern matching, as the UI documents it:
 *   - no wildcard       → path prefix           `docs/old/`, `notes.md`
 *   - wildcard, no `/`  → file name, any depth   `*.log`, `draft-*`
 *   - wildcard with `/` → whole relative path    `src/**\/*.test.ts`
 * `**` spans folders, `*` stays within one, `?` is one character.
 */
export function compilePattern(p: string): (rel: string) => boolean {
  if (!/[*?]/.test(p)) return (rel) => rel.startsWith(p)
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const ch = p[i] as string
    if (ch === '*' && p[i + 1] === '*') {
      i++
      if (p[i + 1] === '/') {
        i++
        re += '(?:.*/)?'
      } else re += '.*'
    } else if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const rx = new RegExp(`^${re}$`, 'i')
  return p.includes('/')
    ? (rel) => rx.test(rel)
    : (rel) => rx.test(rel.slice(rel.lastIndexOf('/') + 1))
}

export const anyOf = (ps: string[]) => {
  const fs = ps.map(compilePattern)
  return (rel: string) => fs.some((f) => f(rel))
}

/**
 * Build options for a config, shared by every entry point. `BRAIN_CONTENT=0` still
 * forces a path-only index, as it did before the config file existed.
 */
export function buildOptions(
  cfg: IndexConfig,
  store: { contentFor(path: string): boolean },
): BuildOpts {
  return {
    topics: new Map(Object.entries(cfg.topics)),
    indexContent: cfg.content.enabled && process.env.BRAIN_CONTENT !== '0',
    maxTokensPerDoc: cfg.content.maxTokensPerDoc,
    maxBytes: cfg.content.maxBytes,
    weights: cfg.weights,
    contentFor: (p) => store.contentFor(p),
  }
}
