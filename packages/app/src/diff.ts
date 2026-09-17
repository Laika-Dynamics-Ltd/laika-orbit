/** Line diffs drawn as unified diff rows, shared by session tool cards and the Changes panel. */
import { highlight } from './quicklook.ts'

const extOf = (p: string) => (/\.([a-z0-9]+)$/i.exec(p)?.[1] ?? '').toLowerCase()

// --------------------------------------------------------------------- diffs ----
/** Line diff by longest common subsequence; big inputs fall back to old-then-new. */
export function diffLines(a: string, b: string): { op: ' ' | '-' | '+'; line: string }[] {
  const x = a.split('\n')
  const y = b.split('\n')
  if (x.length * y.length > 250_000) {
    return [
      ...x.map((line) => ({ op: '-' as const, line })),
      ...y.map((line) => ({ op: '+' as const, line })),
    ]
  }
  const n = x.length
  const m = y.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const out: { op: ' ' | '-' | '+'; line: string }[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: ' ', line: x[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: '-', line: x[i++]! })
    else out.push({ op: '+', line: y[j++]! })
  }
  while (i < n) out.push({ op: '-', line: x[i++]! })
  while (j < m) out.push({ op: '+', line: y[j++]! })
  return out
}

export function diffHtml(oldText: string, newText: string, path: string, max = 400): string {
  const ext = extOf(path)
  const rows = diffLines(oldText, newText)
  const add = rows.filter((r) => r.op === '+').length
  const del = rows.filter((r) => r.op === '-').length
  const shown = rows.slice(0, max)
  return `<div class="ss-diff" data-add="${add}" data-del="${del}">${shown
    .map(
      (r) =>
        `<div class="dl ${r.op === '+' ? 'add' : r.op === '-' ? 'del' : 'ctx'}"><i>${r.op === ' ' ? '' : r.op}</i><code>${highlight(r.line, ext) || ' '}</code></div>`,
    )
    .join(
      '',
    )}${rows.length > max ? `<div class="dl more">… ${rows.length - max} more lines</div>` : ''}</div>`
}
