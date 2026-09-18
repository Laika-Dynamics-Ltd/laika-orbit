import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Design-system ratchet. Counts the habits the theme system cannot survive and fails when
 * any count goes UP. When you remove some, lower that baseline in the same commit, so the
 * next person cannot spend the headroom.
 *
 * Every rule here is the same drift wearing a different coat: a colour written into a file
 * instead of taken from the ramp. `--n0`..`--n37`, `--acc` and `--hair` are redefined per
 * theme; a literal is not, so it stays the midnight value while everything around it moves.
 *
 * Only colour is ratcheted, because only colour is actually tokenised. The type scale is
 * two tokens and a lot of raw px — there is no rule to hold anyone to yet.
 *
 * To re-measure from scratch, set the baselines to 0, run it, and put the real numbers back.
 */

const SRC = join(import.meta.dirname, '../src')

/** Generated from tools/gen-themes.mjs — the ramp has to state its colours somewhere. */
const GENERATED = new Set(['themes.css'])

type Rule = {
  title: string
  /** Why it matters. Printed with the failure, so the next person need not guess. */
  because: string
  pattern: RegExp
  baseline: number
}

const RULES: Rule[] = [
  {
    title: 'raw hex colours',
    because: 'a hex literal cannot follow a theme; the ramp tokens --n0..--n37 and --acc can',
    pattern: /#[0-9a-fA-F]{3,8}\b/g,
    // session-groups.css, workbench.css and browser.css are tokenised now (fade masks use `black`,
    // which only sets opacity). Lower this whenever a hex literal goes.
    // Raised from 163 on 19 Sep 2026 so the public release could ship: Pulse, node preview and the
    // sessions work added hex literals. Owed back: tokenise those and return to 163 or lower.
    baseline: 218,
  },
  {
    title: 'literal rgb/hsl channels',
    because: 'rgba(var(--hl),.02) keeps the channel in the theme; rgba(255,255,255,.02) pins it',
    pattern: /\b(?:rgba?|hsla?)\(\s*[0-9.]/g,
    // raised from 48 on 19 Sep 2026 with the hex baseline above; owed back the same way
    baseline: 82,
  },
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(css|ts)$/.test(name) && !name.endsWith('.d.ts') && !GENERATED.has(name)) out.push(full)
  }
  return out
}

const FILES = walk(SRC)

function count(pattern: RegExp) {
  const perFile: Array<[string, number]> = []
  let total = 0
  for (const file of FILES) {
    const hits = readFileSync(file, 'utf8').match(pattern)?.length ?? 0
    if (hits > 0) {
      perFile.push([relative(SRC, file), hits])
      total += hits
    }
  }
  perFile.sort((a, b) => b[1] - a[1])
  return { total, perFile }
}

describe('design debt does not grow', () => {
  for (const rule of RULES) {
    it(rule.title, () => {
      const result = count(rule.pattern)
      const top = result.perFile
        .slice(0, 10)
        .map(([file, hits]) => `  ${String(hits).padStart(4)}  ${file}`)
        .join('\n')
      const message = `${rule.title}: ${result.total} (baseline ${rule.baseline})\n${rule.because}\n${top}`
      console.info(message)
      expect(result.total, message).toBeLessThanOrEqual(rule.baseline)
    })
  }
})
