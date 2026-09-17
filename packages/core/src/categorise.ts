/**
 * Automatic categories for indexed files, so a source like ~/dev arrives as its
 * projects rather than one undifferentiated folder.
 *
 * Three facets per file:
 *   - project: the unit a person thinks in — a repo in ~/dev (found by its marker
 *     files, so `Org/app` nests correctly), a company in Documents, a Claude project
 *   - kind:    what the document IS — memory, plan, readme, spec, legal, brand, …
 *   - group:   the band it is drawn in — project, with a source's long tail merged
 *
 * Pure apart from `isProjectRoot`, which the caller supplies (it touches the disk).
 */

export const KINDS = [
  'memory',
  'skill',
  'agent',
  'plan',
  'readme',
  'changelog',
  'decision',
  'spec',
  'guide',
  'research',
  'notes',
  'legal',
  'finance',
  'brand',
  'docs',
  'data',
  'image',
  'code',
  'other',
] as const
export type DocKind = (typeof KINDS)[number]

// Ordered: the first match wins, so specific shapes come before broad words.
// `dir` is tested against the folders, `name` against the file name alone — a repo
// called financial-model must not make every README inside it a finance document.
type Rule = { kind: DocKind; dir?: RegExp; name?: RegExp }
const KIND_RULES: Rule[] = [
  // an image is an image whatever it is called — a logo is not a brand document
  { kind: 'image', name: /\.(png|jpe?g|gif|webp|svg|avif|heic|bmp|tiff?)$/i },
  { kind: 'memory', dir: /(^|\/)memory$/, name: /\.md$/i },
  { kind: 'memory', name: /^MEMORY\.md$/i },
  { kind: 'skill', dir: /(^|\/)skills(\/|$)/, name: /\.md$/i },
  { kind: 'skill', name: /^SKILL\.md$/i },
  { kind: 'agent', name: /^(CLAUDE|AGENTS|GEMINI|COPILOT)\.md$/i },
  { kind: 'agent', dir: /(^|\/)\.(claude|cursor|agents|github)(\/|$)/, name: /\.md$/i },
  {
    kind: 'agent',
    name: /(^|[-_ ])(CONTEXT|PROMPT|PROMPTFILE|SYSTEM[-_ ]PROMPT)([-_ .]|$)|PROMPTFILE/i,
  },
  { kind: 'changelog', name: /^(CHANGELOG|CHANGES|HISTORY|RELEASES?|RELEASE[-_ ]NOTES)\b/i },
  { kind: 'readme', name: /^README/i },
  { kind: 'decision', dir: /(^|\/)(adrs?|decisions?)(\/|$)/i },
  { kind: 'decision', name: /^(ADR[-_ ]?\d|DECISIONS?\b)/i },
  { kind: 'plan', dir: /(^|\/)(plans?|roadmaps?)(\/|$)/i },
  { kind: 'plan', name: /(PLAN|ROADMAP|BACKLOG|TODO|MILESTONE|NEXT[-_ ]STEPS|RISKS|BRIEF)/i },
  { kind: 'spec', dir: /(^|\/)(specs?|rfcs?|prds?|requirements)(\/|$)/i },
  { kind: 'spec', name: /(SPEC|PRD|RFC|REQUIREMENTS|DESIGN|ARCHITECTURE|SCHEMA|SCOPE)/i },
  {
    kind: 'legal',
    name: /(agreement|contract|consent|(^|[^a-z])nda([^a-z]|$)|terms[-_ ]of|engagement[-_ ]letter|privacy|^licen[cs]e|constitution|shareholder)/i,
  },
  {
    kind: 'finance',
    name: /(invoice|bank[-_ ]?statement|estatement|receipt|budget|credit[-_ ]?note|(^|[^a-z])(tax|gst)([^a-z]|$)|payroll|financ)/i,
  },
  { kind: 'finance', dir: /(^|\/)(finance|accounts|invoices)(\/|$)/i },
  {
    kind: 'brand',
    name: /(brand|guideline|logo|style[-_ ]?guide|pitch|deck|banner|marketing|campaign)/i,
  },
  { kind: 'guide', dir: /(^|\/)(guides?|runbooks?|how-?to|tutorials?)(\/|$)/i },
  {
    kind: 'guide',
    name: /(GUIDE|HOW[-_ ]?TO|SETUP|INSTALL|RUNBOOK|DEPLOY|CONTRIBUTING|ONBOARDING|QUICK[-_ ]?START|GETTING[-_ ]STARTED|TESTING|\bRUN\b)/i,
  },
  { kind: 'research', dir: /(^|\/)research(\/|$)/i },
  { kind: 'research', name: /(research|analysis|findings|study|benchmark|report|audit|results)/i },
  { kind: 'notes', dir: /(^|\/)(notes?|meetings?|journal|minutes|transcripts?)(\/|$)/i },
  { kind: 'notes', name: /(notes?|meeting|minutes|transcript|retro|update|email|summary)/i },
  { kind: 'docs', dir: /(^|\/)(docs?|documentation|wiki|reference|knowledge)(\/|$)/i },
  { kind: 'docs', name: /^(INDEX|OVERVIEW|KNOWLEDGE)/i },
  { kind: 'data', name: /\.(json|ya?ml|toml|csv|tsv|xml|ini|env)$/i },
  {
    kind: 'code',
    name: /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|swift|kt|java|rb|php|cs|cpp|c|h|sh|zsh|sql|css|scss|svelte|vue)$/i,
  },
]

export function docKind(path: string): DocKind {
  // match on the path inside its source, so an `@dev/` prefix never reads as a word
  const rel = path.replace(/^@[^/]+\//, '')
  const cut = rel.lastIndexOf('/')
  const dir = cut < 0 ? '' : rel.slice(0, cut)
  const name = rel.slice(cut + 1)
  for (const r of KIND_RULES) {
    if (r.dir && !r.dir.test(dir)) continue
    if (r.name && !r.name.test(name)) continue
    return r.kind
  }
  return 'other'
}

/** Files that make a folder a project root. */
export const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'Gemfile',
  'pubspec.yaml',
  'composer.json',
  'deno.json',
  'Package.swift',
  'ProjectSettings', // Unity
  'project.godot',
  'CLAUDE.md',
]

/** `-Users-sam-dev-Acme-NZ-LTD` (Claude's project folder name) → `Acme-NZ-LTD`. */
export function claudeProjectName(encoded: string): string {
  return encoded.replace(/^-Users-[^-]+-/, '').replace(/^(dev|Documents|Desktop)-/, '') || encoded
}

export interface Category {
  source: string
  project: string
  kind: DocKind
}

/**
 * The project a file belongs to.
 * - `claude` sources: memory is per Claude project; plans and skills are their own.
 * - folder-of-repos sources (any source whose files are mostly inside projects): the
 *   OUTERMOST ancestor that is a project root, so a monorepo stays one project and
 *   `Org/app` (no marker on Org) resolves to `Org/app`.
 * - everything else: the first folder, e.g. the company in Documents.
 */
export function projectOf(
  rel: string,
  source: string,
  isProjectRoot: (dirRel: string) => boolean,
): string {
  const parts = rel.split('/')
  if (parts.length === 1) return '(top)'
  if (source === 'claude') {
    if (parts[0] === 'projects' && parts[1]) return claudeProjectName(parts[1])
    return parts[0] as string
  }
  const dirs = parts.slice(0, -1)
  for (let i = 1; i <= Math.min(dirs.length, 4); i++) {
    const d = dirs.slice(0, i).join('/')
    if (isProjectRoot(d)) return d
  }
  return parts[0] as string
}

export function categorise(
  path: string,
  sourceOf: (p: string) => string,
  isProjectRoot: (source: string, dirRel: string) => boolean,
): Category {
  const source = sourceOf(path)
  const rel = path.replace(/^@[^/]+\//, '')
  return {
    source,
    project: projectOf(rel, source, (d) => isProjectRoot(source, d)),
    kind: docKind(path),
  }
}

/**
 * Band names for a set of categorised files. The primary source keeps its own folder
 * taxonomy (passed in as `folder`); every other source is split by project, with
 * projects below `minSize` merged into `<source> · other` so the graph stays legible.
 */
/** joins source and project into one map key; neither can contain a tab */
const SEP = String.fromCharCode(9)

export function smartGroups(
  items: { source: string; project: string; folder: string; primary: boolean }[],
  opts: { minSize?: number | ((source: string) => number); maxPerSource?: number } = {},
): string[] {
  const minFor =
    typeof opts.minSize === 'function'
      ? opts.minSize
      : () => (opts.minSize as number | undefined) ?? 12
  const maxPer = opts.maxPerSource ?? 10
  const counts = new Map<string, number>()
  for (const it of items) {
    if (it.primary) continue
    const k = `${it.source}${SEP}${it.project}`
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  // per source: the biggest projects keep a band, up to maxPer
  const keep = new Set<string>()
  const bySource = new Map<string, [string, number][]>()
  for (const [k, n] of counts) {
    const s = k.split(SEP)[0] as string
    const a = bySource.get(s) ?? []
    a.push([k, n])
    bySource.set(s, a)
  }
  for (const [s, a] of bySource) {
    a.sort((x, y) => y[1] - x[1])
    const min = minFor(s)
    for (const [k, n] of a.slice(0, maxPer)) if (n >= min) keep.add(k)
  }
  return items.map((it) => {
    if (it.primary) return it.folder
    const k = `${it.source}${SEP}${it.project}`
    if (!keep.has(k)) return `${it.source} · other`
    return `${it.source}/${it.project === '(top)' ? 'top' : it.project}`
  })
}
