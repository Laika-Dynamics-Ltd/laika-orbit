#!/usr/bin/env node
/**
 * Build the Laika Orbit node bundle: everything another machine needs to run Claude sessions and
 * terminals for this Mac's Laika Orbit, one archive per platform. Copy it over (USB stick, scp),
 * unpack it, run ./install.sh, and the machine is ready for Laika Orbit to connect to.
 *
 *   node tools/node-bundle/build.mjs                          # linux-x64 and linux-arm64
 *   node tools/node-bundle/build.mjs darwin-arm64 linux-x64   # any of the targets below
 *
 * Each archive carries Node itself and the agent host with its modules for that platform (the
 * Claude Code binary, a prebuilt terminal module), so the machine needs nothing installed first.
 *
 * It also carries this Mac's way in. ~/.laika/node/ keeps an SSH key made for Laika Orbit alone and
 * the token the agent host asks for; both are made by the first build and reused, so every
 * machine installed from any build answers to this Mac. The installer lets that key open a
 * tunnel to the agent host and do nothing else, and the agent host listens on loopback only, so
 * the token on a lost stick opens nothing without the key, which never leaves this Mac.
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const APP = join(REPO, 'packages/app')
const OUT = join(HERE, 'dist')
const KEYS = join(homedir(), '.laika', 'node')
const CACHE = join(KEYS, 'cache')

/** the agent host's port on the machine, loopback only; the SSH key may forward to this and nothing else */
const PORT = 7420
/** the Node this repo runs on, so the bundle runs the code the same way */
const NODE = process.version
/** node-pty with prebuilt binaries for every target, so nothing compiles on the machine */
const PTY = '@lydell/node-pty@1.2.0-beta.15'
const SDK = `@anthropic-ai/claude-agent-sdk@${JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')).dependencies['@anthropic-ai/claude-agent-sdk']}`
/** the agent host, which the bundle carries with every local file it imports */
const ENTRY = 'agent-host.mjs'

const TARGETS = {
  'linux-x64': { os: 'linux', cpu: 'x64', libc: 'glibc' },
  'linux-arm64': { os: 'linux', cpu: 'arm64', libc: 'glibc' },
  'darwin-arm64': { os: 'darwin', cpu: 'arm64' },
  'darwin-x64': { os: 'darwin', cpu: 'x64' },
}

/** agent-host.mjs and the app files it imports, followed through every relative import */
function appFiles(entry = ENTRY, seen = new Set()) {
  if (seen.has(entry)) return seen
  seen.add(entry)
  const text = readFileSync(join(APP, entry), 'utf8')
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    appFiles(relative(APP, resolve(APP, dirname(entry), m[1])), seen)
  }
  return seen
}

const say = (s) => console.log(s)
const run = (cmd, args, o = {}) =>
  execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...o })

/** this Mac's key and token for its machines, made once */
function credentials() {
  mkdirSync(KEYS, { recursive: true, mode: 0o700 })
  const key = join(KEYS, 'id_ed25519')
  if (!existsSync(key)) {
    say('making an SSH key for Laika Orbit machines in ~/.laika/node')
    run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'orbit-node', '-f', key])
  }
  const tokenFile = join(KEYS, 'token')
  if (!existsSync(tokenFile))
    writeFileSync(tokenFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
  const pub = readFileSync(`${key}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ')
  return { pub: `${pub} orbit-node`, token: readFileSync(tokenFile, 'utf8').trim() }
}

async function download(url, file) {
  if (existsSync(file)) return file
  say(`downloading ${url}`)
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url}: ${r.status}`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.part`, Buffer.from(await r.arrayBuffer()))
  renameSync(`${file}.part`, file)
  return file
}

/** the official Node build for a target, checked against nodejs.org's published sums */
async function nodeBinary(t, into) {
  const name = `node-${NODE}-${t.os}-${t.cpu}`
  const sums = await (await fetch(`https://nodejs.org/dist/${NODE}/SHASUMS256.txt`)).text()
  const want = new RegExp(`^([0-9a-f]{64})\\s+${name}\\.tar\\.gz$`, 'm').exec(sums)?.[1]
  if (!want) throw new Error(`nodejs.org lists no ${name}.tar.gz`)
  const archive = await download(
    `https://nodejs.org/dist/${NODE}/${name}.tar.gz`,
    join(CACHE, `${name}.tar.gz`),
  )
  const got = createHash('sha256').update(readFileSync(archive)).digest('hex')
  if (got !== want) {
    rmSync(archive)
    throw new Error(`${name}.tar.gz does not match nodejs.org's checksum`)
  }
  mkdirSync(join(into, 'bin'), { recursive: true })
  run('tar', ['-xzf', archive, '-C', join(into, 'bin'), '--strip-components=2', `${name}/bin/node`])
  run('tar', ['-xzf', archive, '-C', into, '--strip-components=1', `${name}/LICENSE`])
  run('mv', [join(into, 'LICENSE'), join(into, 'NODE-LICENSE')])
}

async function build(target, creds) {
  const t = TARGETS[target]
  if (!t) throw new Error(`unknown target ${target}; one of ${Object.keys(TARGETS).join(', ')}`)
  const name = `orbit-node-${target}`
  const dir = join(OUT, name)
  say(`\n${name}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'app'), { recursive: true })

  await nodeBinary(t, dir)

  for (const f of appFiles()) cpSync(join(APP, f), join(dir, 'app', f))
  writeFileSync(
    join(dir, 'app', 'package.json'),
    `${JSON.stringify({ name: 'orbit-node', private: true, type: 'module' }, null, 2)}\n`,
  )
  say(`installing ${SDK} and ${PTY} for ${target}`)
  run(
    'npm',
    [
      'install',
      '--prefix',
      join(dir, 'app'),
      `--os=${t.os}`,
      `--cpu=${t.cpu}`,
      ...(t.libc ? [`--libc=${t.libc}`] : []),
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--loglevel=error',
      SDK,
      PTY,
    ],
    { stdio: 'inherit' },
  )
  const claude = join(
    dir,
    'app/node_modules/@anthropic-ai',
    `claude-agent-sdk-${t.os}-${t.cpu}`,
    'claude',
  )
  if (!existsSync(claude)) throw new Error(`the Claude Code binary for ${target} did not install`)
  chmodSync(claude, 0o755)

  for (const f of ['install.sh', 'uninstall.sh']) {
    cpSync(join(HERE, f), join(dir, f))
    chmodSync(join(dir, f), 0o755)
  }
  cpSync(join(HERE, 'README.txt'), join(dir, 'README.txt'))
  writeFileSync(join(dir, 'authorized_key'), `${creds.pub}\n`)
  writeFileSync(join(dir, 'token'), `${creds.token}\n`, { mode: 0o600 })
  const commit = run('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD']).trim()
  writeFileSync(
    join(dir, 'bundle.env'),
    [
      `TARGET=${target}`,
      `PORT=${PORT}`,
      `NODE_VERSION=${NODE}`,
      `COMMIT=${commit}`,
      `BUILT=${new Date().toISOString()}`,
      '',
    ].join('\n'),
  )

  const archive = join(OUT, `${name}.tar.gz`)
  // no macOS resource forks or extended attributes: Linux tar warns about every one
  run('tar', ['--no-mac-metadata', '--no-xattrs', '-czf', archive, '-C', OUT, name], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  say(`→ ${archive.replace(`${REPO}/`, '')}  ${(statSync(archive).size / 1024 ** 2).toFixed(0)} MB`)
}

const targets = process.argv.slice(2)
const creds = credentials()
for (const target of targets.length ? targets : ['linux-x64', 'linux-arm64'])
  await build(target, creds)
say(
  '\nCopy an archive to the machine, then there:  tar -xzf orbit-node-<platform>.tar.gz && ./orbit-node-<platform>/install.sh',
)
