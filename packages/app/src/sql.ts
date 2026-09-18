/**
 * Reading SQL well enough to know what it will do, without a parser.
 *
 * Two callers, one answer: the server refuses a write the console is not unlocked for
 * (supabase.mjs), and the panel warns before a destructive one. Node runs this file directly and
 * Vite bundles it, so both sides classify a statement the same way rather than each keeping its
 * own regex that drifts.
 *
 * This is lexical, not Postgres. Comments and string literals are blanked first, so a `--` inside
 * a quoted value or a `delete` inside a comment cannot mislead it, and then the leading keyword of
 * each statement decides. That is enough to catch a mistyped `DELETE` and a `DROP TABLE` pasted
 * into the wrong project; it is not a sandbox, and nothing here should be trusted against SQL
 * written to get past it.
 */

/**
 * The same SQL with comments and string literals replaced by spaces. Lengths are preserved, so
 * offsets into the result still line up with the original text.
 */
export function strip(sql: string): string {
  let out = ''
  let i = 0
  const blank = (n: number) => ' '.repeat(n)
  while (i < sql.length) {
    const rest = sql.slice(i)
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      out += blank(stop - i)
      i = stop
      continue
    }
    if (rest.startsWith('/*')) {
      // Postgres block comments nest, so this counts rather than searching for the first `*/`
      let depth = 0
      let j = i
      while (j < sql.length) {
        if (sql.startsWith('/*', j)) {
          depth++
          j += 2
        } else if (sql.startsWith('*/', j)) {
          depth--
          j += 2
          if (!depth) break
        } else j++
      }
      out += blank(j - i)
      i = j
      continue
    }
    const q = rest[0]
    if (q === "'" || q === '"') {
      let j = i + 1
      while (j < sql.length) {
        // '' inside a quoted string is an escaped quote, not the end of it
        if (sql[j] === q && sql[j + 1] === q) j += 2
        else if (sql[j] === q) {
          j++
          break
        } else j++
      }
      out += blank(j - i)
      i = j
      continue
    }
    // dollar quoting: $$ … $$ or $tag$ … $tag$, which is how function bodies arrive
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest)
    if (dollar) {
      const tag = dollar[0]
      const end = sql.indexOf(tag, i + tag.length)
      const stop = end === -1 ? sql.length : end + tag.length
      out += blank(stop - i)
      i = stop
      continue
    }
    out += sql[i]
    i++
  }
  return out
}

/** the statements in a script: split on the semicolons that are not inside quotes or comments */
export function statements(sql: string): string[] {
  const masked = strip(sql)
  const out: string[] = []
  let start = 0
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== ';') continue
    const text = sql.slice(start, i).trim()
    if (text) out.push(text)
    start = i + 1
  }
  const last = sql.slice(start).trim()
  if (last) out.push(last)
  return out
}

/** the leading keyword of a statement, lowercased; leading brackets of `(select …) union …` skipped */
export function head(statement: string): string {
  return /^\s*\(*\s*([a-z]+)/i.exec(strip(statement))?.[1]?.toLowerCase() ?? ''
}

/** statements that only ever read; anything not on this list counts as a write */
const READS = new Set(['select', 'with', 'explain', 'show', 'table', 'values', 'fetch'])
/** a CTE can hide a write: `with x as (delete from t returning *) select * from x` */
const WRITE_IN_CTE =
  /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|call|do|vacuum|reindex|refresh|comment|copy|set|lock)\b/i
/** `explain analyze <write>` actually runs the write */
const EXPLAIN_RUNS = /^explain\b[\s(]*[^;]*\banaly[sz]e/i

/**
 * Is every statement here plainly a read? A false means "refuse unless writes are on", and never
 * "this SQL is safe" — see the note at the top of the file.
 */
export function readOnly(sql: string): boolean {
  const parts = statements(sql)
  if (!parts.length) return false
  return parts.every((text) => {
    const masked = strip(text)
    const k = head(text)
    if (!READS.has(k)) return false
    if (k === 'explain' && EXPLAIN_RUNS.test(masked)) return false
    if (k === 'with' && WRITE_IN_CTE.test(masked)) return false
    return true
  })
}

/** the keyword of the first statement that is not a read, for the message shown when one is refused */
export function firstWrite(sql: string): string | null {
  for (const text of statements(sql)) {
    if (readOnly(text)) continue
    return head(text).toUpperCase() || 'that statement'
  }
  return null
}

/**
 * Writes worth a second look even with writes unlocked: whole tables going away, and the
 * unqualified `delete`/`update` that was meant to have a `where` on it.
 */
export function destructive(sql: string): string | null {
  for (const text of statements(sql)) {
    const masked = strip(text)
    const k = head(text)
    if (k === 'drop')
      return `DROP ${/^\s*drop\s+(\w+)/i.exec(masked)?.[1]?.toUpperCase() ?? ''}`.trim()
    if (k === 'truncate') return 'TRUNCATE'
    if ((k === 'delete' || k === 'update') && !/\bwhere\b/i.test(masked))
      return `${k.toUpperCase()} with no WHERE`
    if (k === 'alter' && /\bdrop\b/i.test(masked)) return 'ALTER … DROP'
  }
  return null
}
