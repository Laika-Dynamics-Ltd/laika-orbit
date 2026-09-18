#!/usr/bin/env node
/**
 * `node tools/standalone/build.mjs` — a Laika Orbit.app that carries everything it runs.
 *
 * The Dock app from make-app.mjs is a launcher for this checkout: it needs the repo, Homebrew Node
 * and the builder's PATH. This one does not. Inside the bundle:
 *
 *   Contents/Resources/node/bin/node      official Node for this Mac's platform, checksum-verified
 *   Contents/Resources/app/main.mjs       launcher: every path worked out at runtime from the bundle
 *   Contents/Resources/app/version.json   the version, written now, so the app never runs git
 *   Contents/Resources/app/packages/app   the server, agent host and UI, with production dependencies
 *   Contents/Resources/app/packages/shell the Electron shell, with its two dependencies
 *
 * User data lives in ~/Library/Application Support/Laika Orbit/ (Electron's profile, brain/,
 * .env.local); nothing is written inside the bundle, because signing seals it. Nothing here signs,
 * notarises or installs: the result is dist/standalone/Laika Orbit.app, and it goes nowhere else.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const OUT = join(ROOT, 'dist', 'standalone')
const NAME = 'Laika Orbit'
const APP = join(OUT, `${NAME}.app`)
// the customer app's own identity, so it never shares preferences or Keychain items with a dev build
const BUNDLE_ID = 'com.laikadynamics.laikaorbit'
const NODE = process.version // the Node this repo runs on, so the bundle runs the code the same way
const TARGET = `darwin-${process.arch}`
const CACHE = join(homedir(), '.laika', 'node', 'cache') // shared with tools/node-bundle

const require = createRequire(import.meta.url)
const electronBin = require(join(ROOT, 'packages/shell/node_modules/electron'))
const ELECTRON_APP = resolve(electronBin, '../../..')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', env, ...opts })
const out = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', env }).trim()
const step = (s) => console.log(`\n▸ ${s}`)

if (process.platform !== 'darwin')
  throw new Error('the standalone app is a macOS bundle; build it on a Mac')

// ---------------------------------------------------------------------- node ----
/** the official Node build for this platform, checked against nodejs.org's published sums */
async function nodeTarball() {
  mkdirSync(CACHE, { recursive: true })
  const name = `node-${NODE}-${TARGET}`
  const file = join(CACHE, `${name}.tar.gz`)
  const sums = await (await fetch(`https://nodejs.org/dist/${NODE}/SHASUMS256.txt`)).text()
  const want = sums
    .split('\n')
    .find((l) => l.endsWith(`  ${name}.tar.gz`))
    ?.split(/\s+/)[0]
  if (!want) throw new Error(`nodejs.org lists no ${name}.tar.gz`)
  if (!existsSync(file) || createHash('sha256').update(readFileSync(file)).digest('hex') !== want) {
    console.log(`  downloading ${name}.tar.gz`)
    const r = await fetch(`https://nodejs.org/dist/${NODE}/${name}.tar.gz`)
    if (!r.ok) throw new Error(`nodejs.org answered ${r.status}`)
    writeFileSync(file, Buffer.from(await r.arrayBuffer()))
  }
  const got = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (got !== want) throw new Error(`${name}.tar.gz does not match nodejs.org's checksum`)
  return { file, name }
}

// ---------------------------------------------------------------------- icon ----
step('rendering the icon')
mkdirSync(OUT, { recursive: true })
const png = join(OUT, 'icon.png')
sh(electronBin, [join(ROOT, 'packages/shell/render-icon.mjs'), png])
const iconset = join(OUT, 'icon.iconset')
await rm(iconset, { recursive: true, force: true })
mkdirSync(iconset)
for (const s of [16, 32, 128, 256, 512]) {
  sh('sips', ['-z', String(s), String(s), png, '--out', join(iconset, `icon_${s}x${s}.png`)], {
    stdio: 'ignore',
  })
  sh(
    'sips',
    ['-z', String(s * 2), String(s * 2), png, '--out', join(iconset, `icon_${s}x${s}@2x.png`)],
    { stdio: 'ignore' },
  )
}
const icns = join(OUT, 'icon.icns')
sh('iconutil', ['-c', 'icns', iconset, '-o', icns])

// -------------------------------------------------------------------- bundle ----
step('building the bundle from Electron')
await rm(APP, { recursive: true, force: true })
sh('ditto', [ELECTRON_APP, APP]) // ditto keeps the frameworks' symlinks intact
const res = join(APP, 'Contents/Resources')
await rm(join(res, 'default_app.asar'), { force: true })
await rm(join(res, 'electron.icns'), { force: true })
await cp(icns, join(res, 'icon.icns'))
sh('mv', [join(APP, 'Contents/MacOS/Electron'), join(APP, 'Contents/MacOS', NAME)])
const plist = join(APP, 'Contents/Info.plist')
const set = (k, t, v) => sh('plutil', ['-replace', k, `-${t}`, v, plist])
const version = JSON.parse(readFileSync(join(ROOT, 'packages/shell/package.json'), 'utf8')).version
set('CFBundleExecutable', 'string', NAME)
set('CFBundleName', 'string', NAME)
set('CFBundleDisplayName', 'string', NAME)
set('CFBundleIdentifier', 'string', BUNDLE_ID)
set('CFBundleIconFile', 'string', 'icon.icns')
set('CFBundleShortVersionString', 'string', version)
set('NSHumanReadableCopyright', 'string', 'Laika Dynamics')
execFileSync('plutil', ['-remove', 'ElectronAsarIntegrity', plist], { stdio: 'ignore' })

// ---------------------------------------------------------------------- node ----
step(`packing Node ${NODE} for ${TARGET}`)
const { file: tarball, name: nodeDir } = await nodeTarball()
const nodeTmp = await mkdtemp(join(tmpdir(), 'laika-node-'))
sh('tar', ['-xzf', tarball, '-C', nodeTmp, `${nodeDir}/bin/node`, `${nodeDir}/LICENSE`])
mkdirSync(join(res, 'node/bin'), { recursive: true })
await cp(join(nodeTmp, nodeDir, 'bin/node'), join(res, 'node/bin/node'))
await cp(join(nodeTmp, nodeDir, 'LICENSE'), join(res, 'node/LICENSE'))
await rm(nodeTmp, { recursive: true, force: true })

// ---------------------------------------------------------------------- code ----
// pnpm deploy writes each package with its own node_modules, workspace packages copied in,
// production dependencies only. Vite is one of them: the UI is served by Vite's middleware with
// live reload off, as the stable build does.
const appDir = join(res, 'app')
const deployTmp = await mkdtemp(join(tmpdir(), 'laika-deploy-'))
step('deploying the app package and its dependencies')
sh('pnpm', ['--filter', '@laika/app', 'deploy', '--legacy', '--prod', join(deployTmp, 'app')], {
  cwd: ROOT,
})
step('deploying the shell package and its dependencies')
sh('pnpm', ['--filter', '@laika/shell', 'deploy', '--legacy', '--prod', join(deployTmp, 'shell')], {
  cwd: ROOT,
})
mkdirSync(join(appDir, 'packages'), { recursive: true })
sh('ditto', [join(deployTmp, 'app'), join(appDir, 'packages/app')])
sh('ditto', [join(deployTmp, 'shell'), join(appDir, 'packages/shell')])
await rm(deployTmp, { recursive: true, force: true })
// Workspace packages are TypeScript source, and Node strips types only outside node_modules. In a
// checkout they are symlinked in from packages/, so Node sees the real path; pnpm deploy copied them
// into node_modules instead. Put them back beside the app and link to them, relative and inside
// the bundle, so the running code sees exactly the layout it has in the repo.
{
  const pnpmDir = join(appDir, 'packages/app/node_modules/.pnpm')
  const injected = execFileSync(
    'find',
    [pnpmDir, '-maxdepth', '4', '-path', '*/node_modules/@laika/*', '-type', 'd', '-prune'],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean)
  for (const dir of injected) {
    const pkg = dir.split('/').pop()
    const home = join(appDir, 'packages', pkg)
    if (!existsSync(home)) sh('ditto', [dir, home])
    await rm(dir, { recursive: true, force: true })
    sh('ln', ['-s', relative(dirname(dir), home), dir])
    console.log(`  @laika/${pkg} → packages/${pkg}`)
  }
  // and the top-level link the app resolves first
  const top = join(appDir, 'packages/app/node_modules/@laika')
  if (existsSync(top))
    for (const pkg of execFileSync('ls', [top], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)) {
      const link = join(top, pkg)
      await rm(link, { recursive: true, force: true })
      sh('ln', ['-s', relative(top, join(appDir, 'packages', pkg)), link])
    }
}
// the terminal module ships prebuilt binaries for four platforms and its C++ source; keep this one
{
  const pty = execFileSync(
    'find',
    [
      join(appDir, 'packages/app/node_modules/.pnpm'),
      '-maxdepth',
      '3',
      '-type',
      'd',
      '-name',
      'node-pty',
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean)
  for (const dir of pty) {
    for (const p of ['deps', 'src', 'third_party', 'scripts', 'binding.gyp'])
      await rm(join(dir, p), { recursive: true, force: true })
    const pre = join(dir, 'prebuilds')
    if (existsSync(pre))
      for (const plat of execFileSync('ls', [pre], { encoding: 'utf8' }).trim().split('\n'))
        if (plat && plat !== TARGET) await rm(join(pre, plat), { recursive: true, force: true })
  }
}
// nothing of a checkout travels: tests, capture scratch and build output stay behind
for (const junk of [
  'packages/app/test',
  'packages/app/.gauntlet',
  'packages/shell/dist',
  'packages/shell/make-app.mjs',
  'packages/shell/make-stable.mjs',
]) {
  await rm(join(appDir, junk), { recursive: true, force: true })
}

// packages/app and packages/core extend ../../tsconfig.base.json; Vite reads it to compile the UI,
// and without it parts of the interface fail to load
await cp(join(ROOT, 'tsconfig.base.json'), join(appDir, 'tsconfig.base.json'))

// ------------------------------------------------------------------- version ----
step('writing the version')
const count = out('git', ['-C', ROOT, 'rev-list', '--count', 'HEAD'])
const hash = out('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'])
const dirty =
  out('git', [
    '-C',
    ROOT,
    'status',
    '--porcelain',
    '--untracked-files=no',
    '--',
    'packages',
    'package.json',
    'pnpm-lock.yaml',
  ]).length > 0
writeFileSync(
  join(appDir, 'version.json'),
  `${JSON.stringify(
    {
      version: `0.${count}`,
      build: Number(count),
      hash,
      dirty,
      subject: out('git', ['-C', ROOT, 'log', '-1', '--format=%s']),
      date: out('git', ['-C', ROOT, 'log', '-1', '--format=%cI']),
      label: `v0.${count}${dirty ? '+' : ''} · ${hash}`,
      standalone: true,
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
)

// ------------------------------------------------------------------ launcher ----
step('writing the launcher')
await writeFile(
  join(appDir, 'package.json'),
  `${JSON.stringify({ name: 'laika-orbit', private: true, type: 'module', main: 'main.mjs', version }, null, 2)}\n`,
)
await writeFile(
  join(appDir, 'main.mjs'),
  `// Laika Orbit, standalone: everything below is worked out from where this bundle sits, so the app
// runs from /Applications, ~/Downloads or anywhere else, on a Mac that has never seen the repo.
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app } from 'electron'

const here = dirname(fileURLToPath(import.meta.url))
const nodeBin = join(dirname(here), 'node', 'bin')
// Application Support/Laika Orbit: Electron's profile, the brain and .env.local live here
const support = process.env.LAIKA_SUPPORT_DIR ?? join(app.getPath('appData'), '${NAME}')
const brain = join(support, 'brain')
mkdirSync(brain, { recursive: true })

// Claude's tools need the person's own PATH (git, their package managers), and an app opened from
// the Dock gets almost none, so ask their login shell once. LAIKA_LOGIN_PATH=0 skips it.
const base = '/usr/bin:/bin:/usr/sbin:/sbin'
let path = base
if (process.env.LAIKA_LOGIN_PATH !== '0') {
  const r = spawnSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 4000 })
  if (r.status === 0 && r.stdout.includes('/')) path = r.stdout.trim().split('\\n').pop()
}

process.env.LAIKA_ENV_FILE ??= join(support, '.env.local')
process.env.LAIKA_VERSION_FILE ??= join(here, 'version.json')
globalThis.__laikaRepo = {
  root: here,
  node: join(nodeBin, 'node'),
  path,
  name: '${NAME}',
  port: Number(process.env.LAIKA_APP_PORT ?? 5300),
  userData: '${NAME}',
  brainRoot: brain,
  stable: true,
  standalone: true,
}
await import(pathToFileURL(join(here, 'packages/shell/main.mjs')).href)
`,
)

// ---------------------------------------------------------------------- size ----
step('done')
const du = (p) => out('du', ['-sh', p]).split('\t')[0]
console.log(`  ${APP}`)
console.log(
  `  total ${du(APP)} · Electron ${du(join(APP, 'Contents/Frameworks'))} · Node ${du(join(res, 'node'))} · app ${du(join(appDir, 'packages/app'))} · shell ${du(join(appDir, 'packages/shell'))}`,
)
