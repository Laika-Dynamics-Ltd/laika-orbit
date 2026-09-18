#!/usr/bin/env node
import { resolve } from 'node:path'
import {
  buildIndex,
  buildOptions,
  loadIndexConfig,
  parseRouter,
  ROUTER_PATH,
  recall,
  SourcedStore,
} from '@laika/core'

// `--root <dir>` beats BRAIN_ROOT beats the working directory, and is lifted out of argv here
// so a command never sees it among its own arguments.
const argv = process.argv.slice(2)
const rootFlag = (() => {
  const i = argv.indexOf('--root')
  if (i >= 0 && argv[i + 1]) return argv.splice(i, 2)[1]
  const eq = argv.findIndex((a) => a.startsWith('--root='))
  if (eq >= 0) return argv.splice(eq, 1)[0]?.slice('--root='.length)
  return undefined
})()
const [cmd = 'help', ...rest] = argv
const ROOT = resolve(rootFlag ?? process.env.BRAIN_ROOT ?? '.')
// sources, rules and weights come from brain/index.config.json — the same file the app edits
const CONFIG = await loadIndexConfig(ROOT)
const store = new SourcedStore(ROOT, CONFIG)
const BUILD = buildOptions(CONFIG, store)

const fmt = (n: number) => n.toLocaleString()
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const orange = (s: string) => `\x1b[38;5;208m${s}\x1b[0m`

async function main() {
  switch (cmd) {
    case 'index': {
      const t = performance.now()
      const idx = await buildIndex(store, BUILD)
      console.log(
        `${bold('indexed')} ${fmt(idx.docs.length)} docs · ${fmt(idx.postings.size)} tokens · ` +
          `${idx.routerCount} routers · ${fmt(idx.pointerCount)} pointers · ${(performance.now() - t).toFixed(0)}ms`,
      )
      break
    }
    case 'status': {
      const idx = await buildIndex(store, BUILD)
      console.log(`root      ${ROOT}`)
      console.log(`docs      ${fmt(idx.docs.length)}`)
      console.log(`tokens    ${fmt(idx.postings.size)}`)
      console.log(`routers   ${idx.routerCount} (${fmt(idx.pointerCount)} pointers)`)
      console.log(`topics    ${idx.topics.size}`)
      break
    }
    case 'lint': {
      const idx = await buildIndex(store, BUILD)
      let issues = 0
      for (const d of idx.docs) {
        if (!ROUTER_PATH.test(d.path)) continue // same rule as the index
        const { pointers, issues: iss } = parseRouter(await store.readDoc(d.path), d.path)
        for (const i of iss) {
          issues++
          console.log(`${d.path}:${i.line}  ${i.reason}\n  ${dim(i.text)}`)
        }
        // a pointer to a path that looks like a file but does not exist is worth knowing
        for (const p of pointers) {
          if (!/\.(md|ts|json|txt|mjs|sh|py|html)$/.test(p.path)) continue
          if (idx.byPath.has(p.path) || idx.byPath.has(p.path.replace(/^brain\//, ''))) continue
          console.log(`${d.path}:${p.line}  ${dim('dangling pointer')} → ${p.path}`)
          issues++
        }
      }
      console.log(issues ? `\n${issues} issue(s)` : 'no issues')
      process.exitCode = issues ? 1 : 0
      break
    }
    case 'recall':
    case 'ask': {
      const q = rest.join(' ')
      if (!q) {
        console.error('usage: laikaorbit recall "<question>"')
        process.exitCode = 2
        return
      }
      const idx = await buildIndex(store, BUILD)
      const r = await recall(idx, store, q)
      if (cmd === 'ask') {
        console.log(r.prompt)
        return
      }
      console.log(bold(q))
      console.log(dim(`tokens: ${r.tokens.join(', ') || '(none)'}`))
      if (r.noMatch) {
        console.log(orange('no match'))
        return
      }
      console.log(
        dim(`margin ${(r.margin * 100).toFixed(0)}%${r.lowConfidence ? ' — LOW CONFIDENCE' : ''}`),
      )
      for (const c of r.candidates) {
        console.log(
          `  ${String(c.score).padStart(4)}  ${(c.relative * 100).toFixed(0).padStart(3)}%  ${c.path}`,
        )
      }
      for (const e of r.evidence) {
        console.log(
          `\n${orange(`${e.path}${e.heading ? ` › ${e.heading}` : ''}`)} ${dim(`(lines ${e.lines})${e.viaHop ? ' [hop]' : ''}`)}`,
        )
        console.log(
          e.text
            .split('\n')
            .slice(0, 14)
            .map((l) => `  ${l}`)
            .join('\n'),
        )
      }
      console.log(
        dim(
          `\n${r.stats.scoredDocs} scored · ${fmt(r.stats.bytesRead)}B read · ` +
            `${r.stats.hops} hop · score ${r.stats.msScore.toFixed(2)}ms · total ${r.stats.msTotal.toFixed(1)}ms · 0 tokens`,
        ),
      )
      break
    }
    case 'mcp': {
      // the MCP server reads its corpus from BRAIN_ROOT, so --root carries over
      process.env.BRAIN_ROOT = ROOT
      await import('@laika/mcp')
      break
    }
    default:
      console.log(`laikaorbit — deterministic, zero-token recall over a markdown knowledge base

  laikaorbit index              build the index and report size
  laikaorbit status             index health
  laikaorbit lint               router-file diagnostics + dangling pointers
  laikaorbit recall "<q>"       inspect retrieval (candidates, margin, evidence, cost)
  laikaorbit ask "<q>"          emit the packed prompt only
  laikaorbit mcp                serve recall, get and status to Claude Code over stdio

  --root <dir>              the corpus to work on, for any command above

The corpus is --root, else BRAIN_ROOT, else the working directory.`)
  }
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
