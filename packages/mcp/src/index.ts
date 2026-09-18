#!/usr/bin/env node
/**
 * MCP server over the Laika Orbit recall engine.
 *
 * This is where the token saving actually lands: Claude stops burning model turns
 * on grep/glob and whole-file reads, and calls `recall` instead.
 */
import { resolve } from 'node:path'
import {
  type BrainIndex,
  buildIndex,
  buildOptions,
  loadIndexConfig,
  recall,
  SourcedStore,
} from '@laika/core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const ROOT = resolve(process.env.BRAIN_ROOT ?? '.')
// the index an agent recalls against is the one tuned in the app: same config file
const CONFIG = await loadIndexConfig(ROOT)
const store = new SourcedStore(ROOT, CONFIG)
const BUILD = buildOptions(CONFIG, store)

let cached: BrainIndex | null = null
let builtAt = 0
async function index(): Promise<BrainIndex> {
  // Re-scan at most once per refreshSecs (0 = never after the first build). The old
  // per-call mtime walk cost a full directory walk on every recall once ~/dev was a
  // source; an incremental rebuild walks once, re-reads only what changed, and also
  // notices deletions, which the mtime check could not.
  const age = Date.now() - builtAt
  if (cached && (CONFIG.refreshSecs === 0 || age < CONFIG.refreshSecs * 1000)) return cached
  cached = await buildIndex(store, { ...BUILD, prior: cached ?? undefined })
  builtAt = Date.now()
  return cached
}

const server = new McpServer({ name: 'laikaorbit', version: '0.1.0' })

server.registerTool(
  'recall',
  {
    title: 'Recall from the Laika Orbit knowledge base',
    description:
      'Deterministic, zero-token retrieval over the local markdown knowledge base. ' +
      'Returns the exact section that answers the question plus its source path. ' +
      'Prefer this over grep/glob/Read when answering questions about this workspace.',
    inputSchema: { question: z.string().describe('a plain-English question') },
  },
  async ({ question }) => {
    const r = await recall(await index(), store, question)
    if (r.noMatch) {
      return {
        content: [{ type: 'text', text: `No match in the knowledge base for: ${question}` }],
      }
    }
    const head =
      `${r.evidence.length} source(s), margin ${(r.margin * 100).toFixed(0)}%` +
      `${r.lowConfidence ? ' — LOW CONFIDENCE, sources may disagree' : ''} ` +
      `(${r.stats.bytesRead}B read, ${r.stats.msTotal.toFixed(1)}ms, 0 model tokens)`
    const body = r.evidence
      .map(
        (e) =>
          `--- ${e.path}${e.heading ? ` › ${e.heading}` : ''} (lines ${e.lines})${e.viaHop ? ' [followed pointer]' : ''}\n${e.text}`,
      )
      .join('\n\n')
    return { content: [{ type: 'text', text: `${head}\n\n${body}` }] }
  },
)

server.registerTool(
  'get',
  {
    title: 'Read a file from the knowledge base',
    description: 'Read one file by its path relative to the brain root.',
    inputSchema: { path: z.string() },
  },
  async ({ path }) => {
    const text = await store.readDoc(path).catch(() => null)
    return text === null
      ? { content: [{ type: 'text', text: `not found: ${path}` }], isError: true }
      : { content: [{ type: 'text', text }] }
  },
)

server.registerTool(
  'status',
  {
    title: 'Laika Orbit recall index status',
    description: 'Index size and health.',
    inputSchema: {},
  },
  async () => {
    const i = await index()
    return {
      content: [
        {
          type: 'text',
          text:
            `root ${ROOT}\ndocs ${i.docs.length}\ntokens ${i.postings.size}\n` +
            `routers ${i.routerCount}\npointers ${i.pointerCount}`,
        },
      ],
    }
  },
)

await server.connect(new StdioServerTransport())
