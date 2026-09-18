#!/usr/bin/env node
/**
 * `pnpm shell:app` — Laika Orbit as a macOS app: an icon in the Dock, a one-click launch.
 *
 * Builds dist/Laika Orbit.app from the Electron binary pnpm already installed (no packager,
 * no signing service): the shell's files go into Contents/Resources/app, the bundle is
 * renamed, given the icon rendered from icon.html, ad-hoc signed, copied to /Applications
 * (or ~/Applications) and pinned to the Dock.
 *
 * The app keeps running from this checkout: its main.mjs only loads packages/shell/main.mjs
 * from the repo, so shell changes need a relaunch, not a rebuild. repo.json records where the
 * repo is, which node to use and the PATH of the shell that built it, because an app
 * launched from the Dock gets none of the terminal's environment.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
// the stable build (make-stable.mjs) sets these; plain `pnpm shell:app` builds the usual app
const NAME = process.env.LAIKA_APP_NAME ?? 'Laika Orbit'
const PORT = Number(process.env.LAIKA_APP_PORT ?? 5200)
const USER_DATA = process.env.LAIKA_USER_DATA ?? 'Laika Orbit'
const BUNDLE_ID = process.env.LAIKA_BUNDLE_ID ?? 'com.laikadynamics.laikaorbit'
const BRAIN_ROOT = process.env.LAIKA_BRAIN_ROOT ?? null
const STABLE = process.env.LAIKA_STABLE === '1'
const DIST = join(ROOT, 'dist')
const APP = join(DIST, `${NAME}.app`)
const require = createRequire(import.meta.url)
const electronBin = require('electron') // …/dist/Electron.app/Contents/MacOS/Electron
const ELECTRON_APP = resolve(electronBin, '../../..')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', env, ...opts })
const step = (s) => console.log(`\n▸ ${s}`)

if (process.platform !== 'darwin') {
  console.error('make-app builds a macOS bundle; on this platform run `pnpm shell` instead')
  process.exit(1)
}

// ---------------------------------------------------------------------- icon ----
step('rendering the icon')
await mkdir(DIST, { recursive: true })
const png = join(DIST, 'icon.png')
sh(electronBin, [join(HERE, 'render-icon.mjs'), png])
const iconset = join(DIST, 'icon.iconset')
await rm(iconset, { recursive: true, force: true })
await mkdir(iconset)
for (const s of [16, 32, 128, 256, 512]) {
  sh('sips', ['-z', String(s), String(s), png, '--out', join(iconset, `icon_${s}x${s}.png`)], { stdio: 'ignore' })
  sh('sips', ['-z', String(s * 2), String(s * 2), png, '--out', join(iconset, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' })
}
const icns = join(DIST, 'icon.icns')
sh('iconutil', ['-c', 'icns', iconset, '-o', icns])

// -------------------------------------------------------------------- bundle ----
step('building the bundle')
await rm(APP, { recursive: true, force: true })
sh('ditto', [ELECTRON_APP, APP]) // ditto keeps the frameworks' symlinks intact
const res = join(APP, 'Contents/Resources')
const appDir = join(res, 'app')
await mkdir(appDir)
await cp(join(HERE, 'package.json'), join(appDir, 'package.json'))
// not a copy of the shell: a launcher that runs it from the checkout, so a pull or an edit to
// packages/shell is live the next time the app starts (a copy went stale silently)
await writeFile(
  join(appDir, 'main.mjs'),
  `import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
globalThis.__laikaRepo = JSON.parse(readFileSync(join(here, 'repo.json'), 'utf8'))
await import(pathToFileURL(join(globalThis.__laikaRepo.root, 'packages/shell/main.mjs')).href)
`,
)
await writeFile(
  join(appDir, 'repo.json'),
  JSON.stringify(
    { root: ROOT, node: process.execPath, path: process.env.PATH, name: NAME, port: PORT, userData: USER_DATA, brainRoot: BRAIN_ROOT, stable: STABLE, builtAt: new Date().toISOString() },
    null,
    2,
  ),
)
await rm(join(res, 'default_app.asar'), { force: true })
await rm(join(res, 'electron.icns'), { force: true })
await cp(icns, join(res, 'icon.icns'))
// the binary carries the name macOS shows in the menu bar and the Dock
sh('mv', [join(APP, 'Contents/MacOS/Electron'), join(APP, 'Contents/MacOS', NAME)])
const plist = join(APP, 'Contents/Info.plist')
const set = (k, t, v) => sh('plutil', ['-replace', k, `-${t}`, v, plist])
set('CFBundleExecutable', 'string', NAME)
set('CFBundleName', 'string', NAME)
set('CFBundleDisplayName', 'string', NAME)
set('CFBundleIdentifier', 'string', BUNDLE_ID)
set('CFBundleIconFile', 'string', 'icon.icns')
set('CFBundleShortVersionString', 'string', require('./package.json').version)
set('NSHumanReadableCopyright', 'string', 'Laika Dynamics')
// the integrity record named the default app we just removed
spawnSync('plutil', ['-remove', 'ElectronAsarIntegrity', plist], { stdio: 'ignore' })
// a fresh ad-hoc signature, since the bundle changed; Gatekeeper is fine with local builds
spawnSync('codesign', ['--force', '--deep', '--sign', '-', APP], { stdio: 'ignore' })

// ------------------------------------------------------------------- install ----
step('installing')
// The app was called something else before. A copy under an old name with this
// bundle id is the same app: it goes, and its Dock tile is pointed at the new one in place.
const renamed = []
for (const dir of ['/Applications', join(homedir(), 'Applications')]) {
  let names = []
  try {
    names = await readdir(dir)
  } catch {}
  for (const n of names) {
    if (!n.endsWith('.app') || n === `${NAME}.app`) continue
    const id = spawnSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(dir, n, 'Contents/Info.plist')], { encoding: 'utf8' })
    if (id.status === 0 && id.stdout.trim() === BUNDLE_ID) {
      await rm(join(dir, n), { recursive: true, force: true })
      renamed.push(join(dir, n))
      console.log(`  removed the old ${n}`)
    }
  }
}
let dest = join('/Applications', `${NAME}.app`)
try {
  await rm(dest, { recursive: true, force: true })
  sh('ditto', [APP, dest])
} catch {
  dest = join(homedir(), 'Applications', `${NAME}.app`)
  await mkdir(dirname(dest), { recursive: true })
  await rm(dest, { recursive: true, force: true })
  sh('ditto', [APP, dest])
}
console.log(`  ${dest}`)

// ---------------------------------------------------------------------- dock ----
if (process.env.LAIKA_NO_DOCK === '1') {
  console.log(`\nDone. Open it with:  open -a "${NAME}"\n`)
  process.exit(0)
}
step('pinning to the Dock')
const dock = spawnSync('defaults', ['read', 'com.apple.dock', 'persistent-apps'], { encoding: 'utf8' }).stdout ?? ''
if (dock.includes(`${NAME}.app`)) {
  console.log('  already in the Dock')
} else if (renamed.some((old) => dock.includes(`${old}/`))) {
  // Edited through an export rather than the plist on disk, which cfprefsd would overwrite.
  const tmp = join(tmpdir(), `laika-dock-${process.pid}.plist`)
  sh('defaults', ['export', 'com.apple.dock', tmp])
  const buddy = (cmd) => spawnSync('/usr/libexec/PlistBuddy', ['-c', cmd, tmp], { encoding: 'utf8' })
  for (let i = 0; ; i++) {
    const url = buddy(`Print :persistent-apps:${i}:tile-data:file-data:_CFURLString`)
    if (url.status !== 0) {
      if (buddy(`Print :persistent-apps:${i}`).status !== 0) break
      continue
    }
    if (!renamed.some((old) => url.stdout.includes(`${old}/`))) continue
    buddy(`Set :persistent-apps:${i}:tile-data:file-data:_CFURLString file://${dest}/`)
    buddy(`Set :persistent-apps:${i}:tile-data:file-label ${NAME}`)
    // the bookmark still resolves to the old path
    buddy(`Delete :persistent-apps:${i}:tile-data:book`)
  }
  sh('defaults', ['import', 'com.apple.dock', tmp])
  await rm(tmp, { force: true })
  sh('killall', ['Dock'])
  console.log('  the old Dock tile now opens this app, in the same place')
} else {
  const entry = `<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file://${dest}/</string><key>_CFURLStringType</key><integer>15</integer></dict><key>file-label</key><string>${NAME}</string></dict><key>tile-type</key><string>file-tile</string></dict>`
  sh('defaults', ['write', 'com.apple.dock', 'persistent-apps', '-array-add', entry])
  sh('killall', ['Dock'])
  console.log('  added')
}
console.log(`\nDone. Open it from the Dock or:  open -a "${NAME}"\n`)
if (!existsSync(join(ROOT, 'node_modules'))) console.log('note: run pnpm install in the repo first, the app runs the server from there')
