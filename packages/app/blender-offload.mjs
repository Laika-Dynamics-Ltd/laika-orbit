#!/usr/bin/env node
/**
 * Blender, run on the least busy Laika Orbit machine instead of this Mac, for background renders.
 * Put packages/app/bin/path first on PATH and `blender` comes through here:
 *
 *   PATH="…/<repo>/packages/app/bin/path:$PATH" blender -b scene.blend -o //render/frame_#### -a
 *
 * The .blend file's project (the nearest folder above it with .git, otherwise its own folder) is
 * copied to the machine, Blender renders there on the CPU, and the folder the output path names
 * comes back. Runs this Mac's Blender instead, unchanged, when the command is not a background
 * render, names no output (-o), reads or writes outside the project, when no machine has memory
 * free, or when the machine fails or runs out of memory. OFFLOAD=0 always runs here.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bringBack, chooseMachine, followJob, readMachines, remoteDir, syncUp } from './machines.mjs'

const SHIM_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'bin', 'path')
const say = (s) => process.stderr.write(`\x1b[2moffload blender:\x1b[0m ${s}\n`)

function realBlender() {
  for (const d of (process.env.PATH ?? '').split(delimiter)) {
    if (!d || resolve(d) === SHIM_DIR) continue
    if (existsSync(join(d, 'blender'))) return join(d, 'blender')
  }
  return '/Applications/Blender.app/Contents/MacOS/Blender'
}
function runHere(args, why) {
  if (why && process.env.OFFLOAD_VERBOSE) say(`here: ${why}`)
  const p = spawn(realBlender(), args, { stdio: 'inherit' })
  p.on('exit', (code, sig) => process.exit(sig ? 1 : (code ?? 1)))
}

const inside = (root, p) => {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) ? rel || '.' : null
}
function projectOf(file) {
  for (let d = dirname(file); d !== dirname(d); d = dirname(d)) if (existsSync(join(d, '.git'))) return d
  return dirname(file)
}

/**
 * What a Blender command line needs to render elsewhere, or why it must stay here: the project,
 * the arguments rewritten for its copy, and the folder the render writes into.
 */
export function planBlender(args, cwd) {
  if (!args.some((a) => a === '-b' || a === '--background')) return { local: 'not a background render' }
  const blendAt = args.findIndex((a) => /\.blend\d*$/i.test(a) && !a.startsWith('-'))
  if (blendAt < 0) return { local: 'no .blend file' }
  const blend = resolve(cwd, args[blendAt])
  if (!existsSync(blend)) return { local: `${args[blendAt]} does not exist` }
  const root = projectOf(blend)
  const out = [...args]
  out[blendAt] = inside(root, blend)
  let bring = null
  for (let i = 0; i < args.length - 1; i++) {
    const a = args[i]
    const v = args[i + 1]
    if (a === '-o' || a === '--render-output') {
      // // is relative to the .blend, which keeps its place in the copy
      const abs = v.startsWith('//') ? resolve(dirname(blend), v.slice(2)) : resolve(cwd, v)
      const rel = inside(root, abs)
      if (!rel) return { local: `output ${v} is outside the project` }
      if (!v.startsWith('//')) out[i + 1] = rel
      bring = dirname(rel)
      i++
    } else if (a === '-P' || a === '--python') {
      const rel = inside(root, resolve(cwd, v))
      if (!rel) return { local: `script ${v} is outside the project` }
      out[i + 1] = rel
      i++
    }
  }
  if (!bring) return { local: 'no -o output named, so the render would land where only this Mac looks' }
  return { root, args: out, bring }
}

async function main() {
  const args = process.argv.slice(2)
  if (process.env.OFFLOAD === '0' || !readMachines().length) return runHere(args, 'offloading is off')
  const plan = planBlender(args, process.cwd())
  if (plan.local) return runHere(args, plan.local)
  const { pick } = await chooseMachine({ on: process.env.OFFLOAD_ON || null, memory: 3e9, gpu: true })
  if (!pick) return runHere(args, 'no machine has room')
  try {
    const dir = remoteDir(plan.root)
    say(`rendering on ${pick.m.name}`)
    await syncUp(pick.m, plan.root, dir)
    const r = await pick.t.call('/jobs', { method: 'POST', body: JSON.stringify({ dir, cmd: 'blender', args: plan.args, mkdirs: [plan.bring], memory: 3e9, gpu: true }) })
    const body = await r.json()
    if (!r.ok) {
      pick.t.close()
      return runHere(args, `${pick.m.name}: ${body.error}`)
    }
    const end = await followJob(pick, body.id, { write: (d) => process.stdout.write(d), say })
    if (end.state === 'killed') process.exit(130)
    if (end.code !== 0) {
      say(end.oom ? `${pick.m.name} ran out of the memory it keeps for jobs; rendering here` : `${pick.m.name} failed (${end.code}); rendering here`)
      pick.t.close()
      return runHere(args)
    }
    const missing = await bringBack(pick.m, plan.root, dir, [plan.bring])
    if (missing.length) say(`\x1b[33m${plan.bring} did not come back\x1b[0m`)
    pick.t.close()
    process.exit(0)
  } catch (e) {
    say(`${e?.message ?? e}; rendering here`)
    pick.t.close()
    runHere(args)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
