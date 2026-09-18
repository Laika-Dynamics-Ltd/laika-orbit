#!/usr/bin/env node
/**
 * offload: run a command on another machine instead of this Mac, as if it ran here.
 *
 * The project is copied to the machine (rsync, changed files only), the command runs there in
 * that copy, its output streams back here as it happens, the files it wrote come back into the
 * project, and offload exits with the command's exit code. Made for Unity test runs and builds,
 * which pin this Mac's CPU for minutes; works for any command.
 *
 *   offload unity [--on <machine>] [--bring <path>]… -- <Unity options…>
 *       Runs the project's Unity version (ProjectSettings/ProjectVersion.txt). The folders that
 *       -testResults and -logFile write into, and player builds, come back by themselves.
 *   bin/unity-offload                  the same, shaped like the Unity binary, for scripts that
 *       take a Unity path:  UNITY=…/packages/app/bin/unity-offload ./game-check.sh
 *   offload run [--on <machine>] [--needs gpu|cpu] [--bring <path>]… -- <command> [args…]
 *       Any command, in the current folder's copy. Paths inside the folder are rewritten.
 *   offload sync [--on <machine>]      copy the current folder, run nothing
 *   offload machines                   the machines, online or not, and how busy
 *   offload health [--json]            each machine: reachable or why not, and what it can run
 *   offload where [--needs gpu|cpu] [-- <command>]   the machine a job would go to now, and why
 *   offload add <user@host[:port]> [--name <name>] [--os windows]
 *   offload remove <name>
 *   offload clean --on <machine>       remove the current folder's copy there (Windows)
 *   offload discover                   machines announcing themselves on the network
 *   offload windows-kit [--out <dir>]  the folder to copy to a new Windows machine (setup.ps1)
 *
 * With no --on, the least busy machine that can run the command is picked, by what it needs:
 * GPU work (Unity, renders, captures, browsers) goes to a machine that renders properly when one
 * is free, and shell scripts only to machines that are not Windows. `--needs gpu` or `--needs cpu`
 * says it outright. A Unity binary path given to `run` is recognised, so
 * `offload run -- /Applications/Unity/…/Unity -batchmode …` works.
 */
import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import { UNITY_DIRS, unityEditor } from './jobs.mjs'
import {
  LIST,
  bringBack,
  canRun,
  capsOf,
  chooseMachine,
  discover,
  followJob,
  inProject,
  openTunnel,
  parseAddress,
  planUnity,
  readMachines,
  remoteDir,
  surveyMachines,
  syncUp,
  needsOf,
  routesOf,
  saveMachineState,
  writeMachines,
} from './machines.mjs'
import { isWindows, makeKit, winClean, winHealth } from './windows.mjs'

const say = (s) => process.stderr.write(`\x1b[2moffload:\x1b[0m ${s}\n`)
const fail = (s, code = 2) => {
  say(`\x1b[31m${s}\x1b[0m`)
  process.exit(code)
}
const since = (t) => {
  const s = Math.round((Date.now() - t) / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

/** "--on x --bring a -- cmd args" → { on, bring, rest } */
export function parseArgs(argv) {
  const o = { on: null, bring: [], name: null, os: null, needs: null, out: null, json: false, rest: [], words: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      o.rest = argv.slice(i + 1)
      break
    }
    if (a === '--on') o.on = argv[++i]
    else if (a === '--bring') o.bring.push(argv[++i])
    else if (a === '--name') o.name = argv[++i]
    else if (a === '--os') o.os = argv[++i]
    else if (a === '--needs') o.needs = argv[++i]
    else if (a === '--out') o.out = argv[++i]
    else if (a === '--json') o.json = true
    else o.words.push(a)
  }
  return o
}

/** the named machine, or the least busy one that can run the job; stops offload when there is none */
async function choose(on, needs = {}) {
  if (!readMachines().length) fail(`no machines yet: offload add <user@host>  (list: ${LIST})`)
  const { pick, notes } = await chooseMachine({ on, ...needs })
  for (const n of notes) say(n)
  if (!pick) fail(on ? `${on} cannot run this` : 'no machine can run this right now')
  return pick
}

/**
 * sync, run, stream, bring back, exit with the command's code. A machine short of memory, or a
 * job its memory cap stopped, hands the work to `here` (this Mac runs the same command) when
 * given, rather than the job dying; without it the job waits for memory. OFFLOAD_FALLBACK=0 turns
 * running here off.
 */
async function offload({ pick: chosen, on, bring, project, job, needs, label, here = null }) {
  const fallback = process.env.OFFLOAD_FALLBACK === '0' ? null : here
  const pick = chosen ?? (await choose(on, needs))
  const { m } = pick
  const dir = remoteDir(project)
  const started = Date.now()
  for (;;) {
    say(`copying ${basename(project)} to ${m.name}…`)
    await syncUp(m, project, dir)
    const r = await pick.t.call('/jobs', { method: 'POST', body: JSON.stringify({ ...job, dir }) })
    const body = await r.json()
    if (r.status === 409 && /memory/.test(body.error) && fallback) {
      pick.t.close()
      say(`${m.name}: ${body.error.replace(/^busy: /, '')}; running here`)
      return fallback()
    }
    if (r.status === 409) {
      say(`${m.name}: ${body.error.replace(/^busy: /, '')}; waiting…`)
      await new Promise((ok) => setTimeout(ok, 5000))
      continue
    }
    if (!r.ok) fail(`${m.name}: ${body.error}`)
    say(`running ${label} on ${m.name} (${m.user}@${m.host})`)
    const end = await followJob(pick, body.id, { write: (d) => process.stdout.write(d), say })
    if (end.oom && fallback) {
      pick.t.close()
      say(`${m.name} ran out of the memory it keeps for jobs; running here instead`)
      return fallback()
    }
    const outputs = [...new Set(bring)]
    if (outputs.length) {
      const missing = await bringBack(m, project, dir, outputs)
      for (const p of missing) say(`\x1b[33m${p} was not made on ${m.name}\x1b[0m`)
    }
    pick.t.close()
    const code = end.state === 'killed' ? 130 : (end.code ?? (end.state === 'done' ? 0 : 1))
    say(`${end.state} on ${m.name} in ${since(started)}${end.signal ? ` (${end.signal})` : ''}, exit ${code}`)
    process.exit(code)
  }
}

/** what `run` / `where` asks of a machine: --needs says it outright, otherwise the command does */
function needsFor(o) {
  const guess = o.rest.length ? needsOf(o.rest[0], o.rest.slice(1)) : { gpu: false, posix: false }
  if (o.needs === 'gpu') return { ...guess, gpu: true }
  if (o.needs === 'cpu') return { ...guess, gpu: false }
  if (o.needs) fail('--needs is gpu or cpu')
  return guess
}

/**
 * Every machine: reachable or why not, what it is and what it can run, then where GPU and CPU
 * work would go right now. `--json` prints the same as data.
 */
async function health(o) {
  const list = readMachines()
  if (!list.length) return say(`no machines yet: offload add <user@host>  (list: ${LIST})`)
  const seen = await surveyMachines(list)
  const gb = (b) => `${Math.round((b ?? 0) / 1e9)} GB`
  const rows = seen.map((x) => {
    x.t?.close()
    const how = isWindows(x.m) ? 'ssh + PowerShell gate' : 'ssh tunnel + agent host'
    if (x.error) return { name: x.m.name, os: x.m.os ?? 'linux', address: `${x.m.user}@${x.m.host}`, via: how, online: false, error: x.error }
    const h = x.machine
    const caps = capsOf(x.m, h)
    return {
      name: x.m.name,
      os: caps.os,
      address: `${x.m.user}@${x.m.host}`,
      via: how,
      online: true,
      cores: h.cores,
      memTotal: h.memTotal,
      load: h.load,
      jobs: h.jobs,
      cap: h.cap?.jobs ?? x.m.limits?.jobs ?? null,
      gpus: (h.gpus ?? []).map((g) => g.name),
      desktop: h.desktop ?? null,
      tools: h.tools ?? null,
      caps,
      canRun: canRun(caps),
    }
  })
  saveMachineState(rows)
  const r0 = routesOf(rows)
  const routes = { gpu: r0.gpu ?? 'this Mac', cpu: r0.cpuAll.join(' or ') || 'this Mac' }
  if (o.json) return console.log(JSON.stringify({ machines: rows, routes }, null, 2))
  for (const r of rows) {
    if (!r.online) {
      console.log(`\x1b[31m●\x1b[0m ${r.name.padEnd(10)} offline   ${r.os}, ${r.address} (${r.via})\n    ${r.error}`)
      continue
    }
    console.log(`\x1b[32m●\x1b[0m ${r.name.padEnd(10)} online    ${r.os}, ${r.address} (${r.via})`)
    console.log(`    ${r.cores} cores, ${gb(r.memTotal)}, load ${r.load}, ${r.jobs} job(s)${r.cap ? ` of ${r.cap}` : ''}`)
    console.log(`    GPU: ${r.caps.gpu ?? 'none'}${r.desktop === false ? ' (nobody signed in at the screen)' : ''}`)
    if (r.tools) console.log(`    tools: ${Object.entries(r.tools).map(([k, v]) => `${k} ${v ?? '–'}`).join(', ')}`)
    console.log(`    runs: ${r.canRun.join('; ')}`)
  }
  console.log(`\nGPU work → ${routes.gpu}    CPU work → ${routes.cpu}`)
}

const UNITY_BIN = /\/Unity\.app\/Contents\/MacOS\/Unity$|(^|\/)Unity$/

async function main() {
  const [cmd, ...argv] = process.argv.slice(2)
  const o = parseArgs(argv)
  const cwd = process.cwd()

  if (cmd === 'unity' || (cmd === 'run' && UNITY_BIN.test(o.rest[0] ?? ''))) {
    const args = cmd === 'run' ? o.rest.slice(1) : o.rest
    let plan
    try {
      plan = planUnity(args, cwd)
    } catch (e) {
      fail(e.message)
    }
    if (!plan.version) fail(`${plan.project} is not a Unity project (no ProjectSettings/ProjectVersion.txt)`)
    // OFFLOAD_BRING (colon separated) names more outputs, for callers that cannot pass --bring
    const asked = [...o.bring, ...(process.env.OFFLOAD_BRING ?? '').split(':').filter(Boolean)]
    const extra = asked.map((p) => inProject(plan.project, cwd, p) ?? fail(`--bring ${p} is outside the project`))
    // no machine free (or none set up): this Mac's Unity runs the command exactly as given, so a
    // script that defaults to offloading still works when the machines are busy or away
    const { pick, notes } = readMachines().length ? await chooseMachine({ on: o.on, unity: plan.version, memory: 3e9, gpu: true }) : { pick: null, notes: [] }
    if (!pick) {
      const here = unityEditor(plan.version, UNITY_DIRS, process.platform)
      for (const n of notes) say(n)
      if (!here) fail(`no machine can run Unity ${plan.version}, and this Mac does not have it either`)
      say(`no machine free; running Unity ${plan.version} here`)
      const p = spawn(here, args, { stdio: 'inherit' })
      return p.on('exit', (code, sig) => process.exit(sig ? 1 : (code ?? 1)))
    }
    return offload({
      pick,
      on: o.on,
      bring: [...plan.bring, ...extra],
      project: plan.project,
      job: { unity: plan.version, args: plan.args, mkdirs: plan.mkdirs, gpu: true },
      needs: { unity: plan.version, memory: 3e9, gpu: true },
      label: `Unity ${plan.version}`,
      here: () => {
        const bin = unityEditor(plan.version, UNITY_DIRS, process.platform)
        if (!bin) fail(`this Mac has no Unity ${plan.version} to fall back to`)
        const p = spawn(bin, args, { stdio: 'inherit' })
        p.on('exit', (code, sig) => process.exit(sig ? 1 : (code ?? 1)))
      },
    })
  }
  if (cmd === 'run') {
    if (!o.rest.length) fail('offload run -- <command> [args…]')
    const rel = (a) => (a.startsWith('/') ? inProject(cwd, cwd, a) ?? a : a)
    const bring = o.bring.map((p) => inProject(cwd, cwd, p) ?? fail(`--bring ${p} is outside ${cwd}`))
    const needs = needsFor(o)
    return offload({
      on: o.on,
      bring,
      project: cwd,
      job: { cmd: o.rest[0], args: o.rest.slice(1).map(rel), gpu: needs.gpu },
      needs,
      label: o.rest[0],
      here: () => {
        const p = spawn(o.rest[0], o.rest.slice(1), { stdio: 'inherit' })
        p.on('exit', (code, sig) => process.exit(sig ? 1 : (code ?? 1)))
      },
    })
  }
  if (cmd === 'sync') {
    const pick = await choose(o.on)
    await syncUp(pick.m, cwd, remoteDir(cwd))
    pick.t.close()
    return say(`copied to ${pick.m.name}:${pick.machine.work ?? '~/orbit-work'}/${remoteDir(cwd)}`)
  }
  if (cmd === 'machines') {
    const list = readMachines()
    if (!list.length) return say(`no machines yet: offload add <user@host>`)
    for (const x of await surveyMachines(list)) {
      x.t?.close()
      const h = x.machine
      console.log(
        x.error
          ? `${x.m.name.padEnd(16)} offline   ${x.error}`
          : `${x.m.name.padEnd(16)} online    ${h.cores} cores, load ${h.load}, mem ${h.mem}%, ${h.jobs} job(s), Unity ${h.unity?.join(' ') || '–'}${h.gpus?.length ? `, ${h.gpus.map((g) => g.name).join(', ')}` : ''}`,
      )
    }
    return
  }
  if (cmd === 'add') {
    const addr = parseAddress(o.words[0] ?? '')
    if (!addr) fail('offload add <user@host[:port]> [--name <name>] [--os windows]')
    if (o.os && !['linux', 'windows', 'mac'].includes(o.os)) fail('--os is linux, windows or mac')
    let h
    if (o.os === 'windows') {
      h = { machine: await winHealth({ ...addr, os: 'windows', name: addr.host }).catch((e) => fail(`${e.message}\n  Has setup.ps1 run on it? (offload windows-kit makes the folder to copy there)`)) }
    } else {
      const t = await openTunnel({ ...addr, name: addr.host }).catch((e) => fail(e.message))
      h = await (await t.call('/health?machine=1')).json()
      t.close()
    }
    const name = o.name ?? String(h.machine?.hostname ?? addr.host).split('.')[0].toLowerCase()
    const list = readMachines().filter((m) => m.name !== name)
    const gpu = capsOf({ os: o.os }, h.machine).gpu
    writeMachines([...list, { name, ...addr, ...(o.os ? { os: o.os } : {}) }])
    return say(`added ${name}: ${h.machine?.cores} cores, ${gpu ? `GPU ${gpu}` : 'no GPU'}, Unity ${h.machine?.unity?.join(' ') || 'not installed'}`)
  }
  if (cmd === 'remove') {
    const list = readMachines()
    if (!list.some((m) => m.name === o.words[0])) fail(`no machine named ${o.words[0]}`)
    writeMachines(list.filter((m) => m.name !== o.words[0]))
    return say(`removed ${o.words[0]}`)
  }
  if (cmd === 'health') return health(o)
  if (cmd === 'where') {
    const needs = needsFor(o)
    const { pick, notes } = await chooseMachine({ on: o.on, ...needs })
    for (const n of notes) say(n)
    pick?.t.close()
    const what = needs.gpu ? 'GPU work' : 'CPU work'
    return console.log(pick ? `${what}${needs.posix ? ' (Unix only)' : ''} → ${pick.m.name}` : `${what} → this Mac (no machine can take it now)`)
  }
  if (cmd === 'clean') {
    const m = readMachines().find((x) => x.name === o.on)
    if (!m) fail('offload clean --on <machine>')
    if (!isWindows(m)) fail(`${m.name} keeps copies in ~/orbit-work; clean is for Windows machines`)
    await winClean(m, remoteDir(cwd)).catch((e) => fail(e.message))
    return say(`removed ${remoteDir(cwd)} from ${m.name}`)
  }
  if (cmd === 'windows-kit') {
    let out
    try {
      out = makeKit(o.out ?? undefined)
    } catch (e) {
      fail(e.message)
    }
    say(`made ${out}`)
    return say('copy that folder to the Windows machine and follow CHECKLIST.md in it (setup.ps1 does the rest)')
  }
  if (cmd === 'discover') {
    const found = await discover()
    if (!found.length) return say('no machines announcing Laika Orbit on this network')
    const known = new Set(readMachines().map((m) => `${m.user}@${m.host}`))
    for (const f of found) console.log(`${f.name.padEnd(32)} ${f.address}${known.has(f.address) ? '  (added)' : ''}`)
    return
  }
  process.stderr.write(`${(await import('node:fs')).readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, '')}\n`)
  process.exit(cmd ? 2 : 0)
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/offload.mjs')) {
  main().catch((e) => fail(String(e?.stack ?? e), 1))
}
