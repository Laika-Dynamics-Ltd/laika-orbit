import { POINTER_TYPES, type Pointer, type PointerType } from './types.ts'

export interface ParseIssue {
  line: number
  text: string
  reason: string
}
export interface ParsedRouter {
  pointers: Pointer[]
  issues: ParseIssue[]
}

const STAGE_RE = /^#{1,6}\s+(.*\S)\s*$|^(\d+\s+[—-]\s+.*\S)\s*$/
const PTR_RE = new RegExp(`^\\s*[-*]\\s*(${POINTER_TYPES.join('|')})\\s*:\\s*(.+)$`, 'i')

/**
 * A router file is a task-ordered playbook of typed pointers, not a folder listing.
 * Every pointer line becomes one scoreable catalogue entry.
 */
export function parseRouter(text: string, source: string): ParsedRouter {
  const pointers: Pointer[] = []
  const issues: ParseIssue[] = []
  let stage: string | null = null

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1
    const trimmed = raw.trim()
    if (!trimmed) return

    const st = STAGE_RE.exec(trimmed)
    if (st) {
      stage = (st[1] ?? st[2] ?? '').trim()
      return
    }

    const m = PTR_RE.exec(raw)
    if (m) {
      const type = (POINTER_TYPES.find((t) => t.toLowerCase() === m[1]!.toLowerCase()) ??
        'Reference') as PointerType
      const rest = m[2]!.trim()
      const dash = rest.search(/\s+[—–-]\s+/)
      const path = (dash === -1 ? rest : rest.slice(0, dash)).trim()
      const description =
        dash === -1
          ? ''
          : rest
              .slice(dash)
              .replace(/^\s*[—–-]\s*/, '')
              .trim()
      if (!path) {
        issues.push({ line, text: trimmed, reason: 'pointer has no path' })
        return
      }
      pointers.push({ type, path, description, stage, line, source })
      return
    }

    // A bullet that looks like a pointer but is not one is a diagnostic, never a silent skip.
    if (/^\s*[-*]\s*\w+\s*:/.test(raw)) {
      issues.push({
        line,
        text: trimmed,
        reason: `unknown pointer type (expected ${POINTER_TYPES.join('|')})`,
      })
    }
  })

  return { pointers, issues }
}

/** Round-trip target: serialise(parse(x)) must be byte-identical for canonical input. */
export function serialiseRouter(p: ParsedRouter): string {
  const out: string[] = []
  let stage: string | null = null
  for (const ptr of p.pointers) {
    if (ptr.stage !== stage) {
      if (out.length) out.push('')
      out.push(`## ${ptr.stage ?? ''}`.trimEnd(), '')
      stage = ptr.stage
    }
    out.push(`- ${ptr.type}: ${ptr.path}${ptr.description ? ` — ${ptr.description}` : ''}`)
  }
  return `${out.join('\n')}\n`
}
