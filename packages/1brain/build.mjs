/**
 * The published `1brain` package: the CLI and the MCP server bundled to plain JavaScript.
 *
 * In this repo the packages run their TypeScript directly, but Node refuses to strip types from
 * anything under node_modules, so what npm installs has to be built. The workspace code (core,
 * cli, mcp) goes into the bundle; the MCP SDK and zod stay real dependencies.
 */
import { copyFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, 'dist')
rmSync(DIST, { recursive: true, force: true })

await build({
  entryPoints: { cli: join(HERE, '../cli/src/index.ts') },
  outdir: DIST,
  bundle: true,
  splitting: true, // the MCP server is its own chunk, loaded only by `1brain mcp`
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*', 'zod'],
  legalComments: 'none',
  logLevel: 'info',
})

copyFileSync(join(HERE, '../../LICENSE'), join(HERE, 'LICENSE'))
