import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Text extraction for binary document formats. Uses tools already present on the
 * machine (textutil ships with macOS, pdftotext with poppler) via node:child_process,
 * so core keeps ZERO npm dependencies. A missing tool degrades gracefully to
 * filename-only indexing — it never throws.
 */
export const EXTRACTABLE = /\.(docx?|rtf|pdf|odt|html?|pptx?)$/i

type Extractor = { cmd: string; args: (abs: string) => string[] }

const TEXTUTIL: Extractor = { cmd: 'textutil', args: (a) => ['-convert', 'txt', '-stdout', a] }
const BY_EXT: Record<string, Extractor> = {
  pdf: { cmd: 'pdftotext', args: (a) => [a, '-'] },
  docx: TEXTUTIL,
  doc: TEXTUTIL,
  rtf: TEXTUTIL,
  odt: TEXTUTIL,
  html: TEXTUTIL,
  htm: TEXTUTIL,
}

const available = new Map<string, boolean>()
async function has(cmd: string): Promise<boolean> {
  const cached = available.get(cmd)
  if (cached !== undefined) return cached
  const ok = await run('which', [cmd]).then(
    () => true,
    () => false,
  )
  available.set(cmd, ok)
  return ok
}

export interface ExtractOpts {
  cacheDir: string
  maxBytes?: number
}

/** Extracted text, or null when the format or its tool is unavailable. */
export async function extractText(abs: string, opts: ExtractOpts): Promise<string | null> {
  const ext = (abs.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()
  const ex = BY_EXT[ext]
  if (!ex) return null
  if (!(await has(ex.cmd))) return null

  // keyed on size + mtime too: keyed on the path alone, an edited document kept
  // serving the text of its first version forever
  const s = await stat(abs).catch(() => null)
  if (!s) return null
  const key = createHash('sha1')
    .update(`${abs}\0${s.size}\0${s.mtimeMs}`)
    .digest('hex')
    .slice(0, 20)
  const cached = join(opts.cacheDir, `${key}.txt`)
  const hit = await readFile(cached, 'utf8').catch(() => null)
  if (hit !== null) return hit

  try {
    const { stdout } = await run(ex.cmd, ex.args(abs), {
      maxBuffer: opts.maxBytes ?? 4 * 1024 * 1024,
      timeout: 20_000,
    })
    // strip NULs that some converters emit; they break downstream string handling
    const text = stdout.split('\0').join('').trim()
    await mkdir(opts.cacheDir, { recursive: true }).catch(() => {})
    await writeFile(cached, text).catch(() => {})
    return text
  } catch {
    return null // corrupt, timed out, or encrypted — fall back to filename indexing
  }
}
