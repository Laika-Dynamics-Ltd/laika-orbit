#!/usr/bin/env node
/**
 * ffmpeg, run on the least busy Laika Orbit machine instead of this Mac. Put packages/app/bin/path
 * first on PATH and every `ffmpeg` a tool starts comes through here:
 *
 *   PATH="…/<repo>/packages/app/bin/path:$PATH" node showreel.mjs render
 *
 * The inputs are copied to the machine (and kept there by path, size and date, so a file used by
 * ten commands is copied once), along with the files a concat list names and an image sequence's
 * folder. ffmpeg runs there, its output files come back to the paths the command named, and the
 * exit code is passed through. ffmpeg's messages come back on stderr, where ffmpeg writes them.
 *
 * It runs this Mac's own ffmpeg instead, unchanged, whenever offloading could change the result
 * or is not worth it: output or input on a pipe, a device or a URL; filters that read files
 * (fonts, subtitles, LUTs); cheap work (a single still, a stream copy) on inputs under 8 MB, or
 * any work on inputs under 256 KB; no machine answering; or the machine's
 * ffmpeg failing (so an option only this Mac's build knows still works). OFFLOAD=0 always runs
 * here, and OFFLOAD_ON=<machine> picks the machine.
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { macBusy } from './feeds/loadwatch.mjs'
import { chooseMachine, followJob, pullTree, pushTree, readMachines } from './machines.mjs'

const SHIM_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'bin', 'path')
/** inputs smaller than this are not worth the trip unless the command re-encodes video */
const CHEAP_BYTES = 8 * 1024 ** 2
/** below this even an encode stays here: the copy would cost more than the work */
const TINY_BYTES = 256 * 1024
/** where offloaded ffmpeg work lives in a machine's work folder */
const AREA = '.ffmpeg'

/** ffmpeg options that take no value; every other option is followed by one */
const FLAGS = new Set(
  '-y -n -nostdin -stdin -hide_banner -shortest -re -an -vn -sn -dn -stats -nostats -copyts -start_at_zero -accurate_seek -noaccurate_seek -benchmark -benchmark_all -ignore_unknown -xerror -debug_ts -dump -hex -bitexact -report -autorotate -noautorotate -autoscale -noautoscale -copy_unknown -reinit_filter -version -h -help -formats -codecs -encoders -decoders -filters -pix_fmts -muxers -demuxers -protocols -buildconf -L'.split(
    ' ',
  ),
)
/** filters and options whose value names a file ffmpeg would open */
const READS_FILES = /(^|[:,;=])(fontfile|textfile|subtitles|ass|movie|amovie|lut3d|lut1d|haldclut|sofa|file|filename|model)=|_script$/

const say = (s) => process.stderr.write(`\x1b[2moffload ffmpeg:\x1b[0m ${s}\n`)

/**
 * What a command line needs to run elsewhere, or why it must not: its file inputs (with the
 * format forced on each), its outputs, and the positions of both in the argument list.
 */
export function planFfmpeg(args, cwd) {
  const inputs = []
  const outputs = []
  let format = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-i') {
      inputs.push({ at: i + 1, path: args[i + 1], format })
      format = null
      i++
    } else if (a.startsWith('-') && a.length > 1) {
      if (READS_FILES.test(a)) return { local: `${a} reads a file` }
      if (FLAGS.has(a)) continue
      if (a === '-f') format = args[i + 1]
      const v = args[i + 1] ?? ''
      if (READS_FILES.test(v)) return { local: `${a} ${v.slice(0, 40)} reads a file` }
      i++
    } else outputs.push({ at: i, path: a })
  }
  if (!outputs.length) return { local: 'no output file' }
  for (const o of outputs) {
    if (o.path === '-' || /^[a-z][\w+.-]*:/i.test(o.path)) return { local: `output ${o.path} is not a file` }
    o.abs = resolve(cwd, o.path)
  }
  for (const x of inputs) {
    if (x.format === 'lavfi') continue
    if (x.path === '-' || /^[a-z][\w+.-]*:/i.test(x.path) || /^(avfoundation|x11grab|dshow|gdigrab|v4l2|alsa|pulse)$/.test(x.format ?? '')) {
      return { local: `input ${x.path} is not a file` }
    }
    x.abs = resolve(cwd, x.path)
    x.sequence = /%\d*d|[*?]/.test(basename(x.path))
    if (!existsSync(x.sequence ? dirname(x.abs) : x.abs)) return { local: `${x.path} does not exist` }
  }
  return { inputs: inputs.filter((x) => x.abs), outputs, cheap: isCheap(args) }
}

/**
 * Work that costs little CPU whatever the input: one frame out, or streams copied rather than
 * encoded. Everything else encodes, and an encode is worth sending even from a small clip.
 */
export function isCheap(args) {
  const val = (flags) => {
    for (let i = 0; i < args.length - 1; i++) if (flags.includes(args[i])) return args[i + 1]
    return null
  }
  if (val(['-frames:v', '-vframes']) === '1') return true
  const v = val(['-c:v', '-vcodec', '-codec:v'])
  const all = val(['-c', '-codec'])
  return (v ?? all) === 'copy' && (args.includes('-an') || (val(['-c:a', '-acodec', '-codec:a']) ?? all) === 'copy')
}

const key = (p) => {
  const st = statSync(p)
  return createHash('sha1').update(`${p}\0${st.size}\0${st.mtimeMs}`).digest('hex').slice(0, 16)
}

/** the files a concat list names, as absolute paths (relative ones are relative to the list) */
export function concatEntries(listPath) {
  const out = []
  for (const line of readFileSync(listPath, 'utf8').split('\n')) {
    const m = /^\s*file\s+(?:'((?:[^']|'\\'')*)'|(\S+))\s*$/.exec(line)
    if (!m) continue
    const p = (m[1] ?? m[2]).replace(/'\\''/g, "'")
    out.push(isAbsolute(p) ? p : resolve(dirname(listPath), p))
  }
  return out
}

/** this Mac's ffmpeg: the first on PATH that is not this stand-in */
function realFfmpeg() {
  for (const d of (process.env.PATH ?? '').split(delimiter)) {
    if (!d || resolve(d) === SHIM_DIR) continue
    const f = join(d, 'ffmpeg')
    if (existsSync(f)) return f
  }
  return '/opt/homebrew/bin/ffmpeg'
}

function runHere(args, why) {
  if (why && process.env.OFFLOAD_VERBOSE) say(`here: ${why}`)
  const p = spawn(realFfmpeg(), args, { stdio: 'inherit' })
  p.on('exit', (code, sig) => process.exit(sig ? 1 : (code ?? 1)))
}

async function main() {
  const args = process.argv.slice(2)
  if (process.env.OFFLOAD === '0' || !readMachines().length) return runHere(args, 'offloading is off')
  const plan = planFfmpeg(args, process.cwd())
  if (plan.local) return runHere(args, plan.local)

  // stage: every input, concat list entry and sequence folder as a link under in/<key>/
  const stage = mkdtempSync(join(tmpdir(), 'ffmpeg-offload-'))
  const id = randomUUID()
  const job = `${AREA}/jobs/${id}`
  const remoteArgs = [...args]
  let bytes = 0
  try {
    const link = (abs) => {
      const k = key(abs)
      const dir = join(stage, 'in', k)
      mkdirSync(dir, { recursive: true })
      if (!existsSync(join(dir, basename(abs)))) symlinkSync(abs, join(dir, basename(abs)))
      bytes += statSync(abs).isFile() ? statSync(abs).size : 0
      return `in/${k}/${basename(abs)}`
    }
    for (const x of plan.inputs) {
      if (x.sequence) {
        const folder = dirname(x.abs)
        const k = key(folder)
        mkdirSync(join(stage, 'in'), { recursive: true })
        if (!existsSync(join(stage, 'in', k))) symlinkSync(folder, join(stage, 'in', k))
        bytes += CHEAP_BYTES // a sequence is always worth sending
        remoteArgs[x.at] = `../../in/${k}/${basename(x.abs)}`
      } else if (x.format === 'concat') {
        const entries = concatEntries(x.abs).map((e) => `file '../${link(e).slice(3).replace(/'/g, "'\\''")}'`)
        const k = key(x.abs)
        mkdirSync(join(stage, 'in', k), { recursive: true })
        writeFileSync(join(stage, 'in', k, 'list.txt'), `${entries.join('\n')}\n`)
        remoteArgs[x.at] = `../../in/${k}/list.txt`
      } else {
        remoteArgs[x.at] = `../../${link(x.abs)}`
      }
    }
    // a busy Mac sends even cheap work; otherwise small cheap jobs are not worth the trip
    if (!macBusy() && (bytes < TINY_BYTES || (plan.cheap && bytes < CHEAP_BYTES))) return runHere(args, 'not worth sending')
    plan.outputs.forEach((o, n) => {
      mkdirSync(join(stage, 'jobs', id, 'out', String(n)), { recursive: true })
      remoteArgs[o.at] = `out/${n}/${basename(o.abs)}`
    })

    // Linux machines only: the staging below (links, ../../ paths, rm) and the machine's own ffmpeg build are Unix
    const { pick } = await chooseMachine({ on: process.env.OFFLOAD_ON || null, memory: 1e9, posix: true })
    if (!pick) return runHere(args, 'no machine answered')
    const started = Date.now()
    await pushTree(pick.m, stage, AREA)
    const bin = pick.machine.work ? `${pick.machine.work}/.tools/ffmpeg/bin/ffmpeg` : 'ffmpeg'
    const r = await pick.t.call('/jobs', { method: 'POST', body: JSON.stringify({ dir: job, cmd: bin, args: remoteArgs }) })
    const body = await r.json()
    if (!r.ok) {
      pick.t.close()
      return runHere(args, `${pick.m.name}: ${body.error}`)
    }
    let log = ''
    const end = await followJob(pick, body.id, { write: (d) => (log += d), say })
    if (end.state === 'killed') process.exit(130)
    if (end.code !== 0) {
      // the machine's ffmpeg may not know something this Mac's does: the Mac decides
      say(`${pick.m.name} failed (${end.code}): ${log.trim().split('\n').slice(-2).join(' / ').slice(0, 200)}; running here`)
      pick.t.close()
      return runHere(args)
    }
    process.stderr.write(log)
    for (const [n, o] of plan.outputs.entries()) await pullTree(pick.m, `${job}/out/${n}`, dirname(o.abs))
    pick.t
      .call('/jobs', { method: 'POST', body: JSON.stringify({ dir: '.', cmd: 'rm', args: ['-rf', job] }) })
      .catch(() => {})
      .finally(() => pick.t.close())
    if (process.env.OFFLOAD_VERBOSE) say(`ran on ${pick.m.name} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
    setTimeout(() => process.exit(0), 300)
  } catch (e) {
    say(`${e?.message ?? e}; running here`)
    runHere(args)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
