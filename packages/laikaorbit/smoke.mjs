/**
 * Installs the packed `laikaorbit` tarball into an empty project, the way npm users get it, and runs it
 * against a small corpus: index, recall, lint, and an MCP session over stdio (initialize, list the
 * tools, call recall). Fails loudly on the first thing that doesn't work.
 *
 *   pnpm --filter laikaorbit smoke
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = mkdtempSync(join(tmpdir(), 'laikaorbit-smoke-'))
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, BRAIN_ROOT: '' } })
const ok = (cond, what) => {
  if (!cond) throw new Error(`smoke: ${what}`)
  console.log(`  ✓ ${what}`)
}

try {
  // pack (prepack builds), then install the tarball into an empty project
  sh('pnpm', ['pack', '--pack-destination', WORK], HERE)
  const tgz = readdirSync(WORK).find((f) => f.endsWith('.tgz'))
  ok(tgz, `packed ${tgz}`)
  const listing = sh('tar', ['-tzf', join(WORK, tgz)], WORK)
  ok(!/\.ts$/m.test(listing) && !/node_modules/.test(listing), 'tarball holds built JavaScript only')
  const app = join(WORK, 'app')
  mkdirSync(app)
  writeFileSync(join(app, 'package.json'), '{"name":"smoke","private":true}')
  sh('npm', ['install', '--no-audit', '--no-fund', '--silent', join(WORK, tgz)], app)
  const bin = join(app, 'node_modules/.bin/laikaorbit')

  // a corpus with a router file pointing at a note
  const corpus = join(WORK, 'corpus')
  mkdirSync(join(corpus, 'brain/routers'), { recursive: true })
  mkdirSync(join(corpus, 'notes'))
  writeFileSync(join(corpus, 'brain/routers/OPS.md'), '## 1 — deploys\n\n- Files: notes/deploy.md — how production deploys are rolled back\n')
  writeFileSync(join(corpus, 'notes/deploy.md'), '# Deploys\n\n## Rolling back\n\nRun `make rollback TAG=<previous>` and watch the canary for ten minutes.\n')

  const indexed = sh(bin, ['index', '--root', corpus], app)
  ok(/indexed.*2 docs/.test(indexed), 'index builds (2 docs)')
  const recalled = sh(bin, ['recall', 'how do I roll back a deploy', '--root', corpus], app)
  ok(recalled.includes('notes/deploy.md') && recalled.includes('make rollback'), 'recall returns the answering section')
  ok(/no issues/.test(sh(bin, ['lint', '--root', corpus], app)), 'lint finds no issues')

  // MCP over stdio: newline-delimited JSON-RPC
  const mcp = spawn(bin, ['mcp', '--root', corpus], { cwd: app, stdio: ['pipe', 'pipe', 'inherit'] })
  const replies = new Map()
  let buf = ''
  mcp.stdout.on('data', (d) => {
    buf += d
    for (let i; (i = buf.indexOf('\n')) >= 0; ) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim()) {
        const m = JSON.parse(line)
        if (m.id !== undefined) replies.set(m.id, m)
      }
    }
  })
  const send = (m) => mcp.stdin.write(`${JSON.stringify(m)}\n`)
  const reply = async (id) => {
    for (let t = 0; t < 200 && !replies.has(id); t++) await new Promise((r) => setTimeout(r, 50))
    if (!replies.has(id)) throw new Error(`smoke: no MCP reply to request ${id}`)
    return replies.get(id)
  }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } })
  ok((await reply(1)).result?.serverInfo?.name === 'laikaorbit', 'MCP initialize answers as laikaorbit')
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const tools = (await reply(2)).result.tools.map((t) => t.name).sort()
  ok(tools.join() === 'get,recall,status', `MCP lists ${tools.join(', ')}`)
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'recall', arguments: { question: 'how do I roll back a deploy' } } })
  const text = (await reply(3)).result.content[0].text
  ok(text.includes('make rollback') && text.includes('0 model tokens'), 'MCP recall returns the section, 0 model tokens')
  mcp.kill()
  console.log('\nsmoke passed')
} finally {
  rmSync(WORK, { recursive: true, force: true })
}
