import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createJobs, insideRoot, needOf, unityEditor, unityVersions } from '../jobs.mjs'

const root = mkdtempSync(join(tmpdir(), 'jobs-test-'))
mkdirSync(join(root, 'proj'))

/** resolves with every event once the job exits */
const events = (jobs, id, since = 0) =>
  new Promise((done) => {
    const seen = []
    jobs.watch(id, since, (e) => {
      seen.push(e)
      if (e.t === 'exit') done(seen)
    })
  })
const output = (seen) => seen.filter((e) => e.t === 'out').map((e) => e.data).join('')

describe('jobs', () => {
  it('keeps jobs inside the work root', () => {
    expect(insideRoot('/w', 'a/b')).toBe('/w/a/b')
    expect(insideRoot('/w', '../x')).toBeNull()
    expect(insideRoot('/w', 'a/../../x')).toBeNull()
    expect(insideRoot('/w', '/etc')).toBeNull()
    expect(insideRoot('/w', '')).toBeNull()
  })

  it('runs a command in its folder, streams output and reports the exit code', async () => {
    const jobs = createJobs({ root })
    const j = jobs.start({ dir: 'proj', cmd: 'sh', args: ['-c', 'pwd; echo err >&2; exit 3'] })
    const seen = await events(jobs, j.id)
    expect(output(seen)).toContain(join(root, 'proj'))
    expect(output(seen)).toContain('err')
    expect(seen.at(-1)).toMatchObject({ t: 'exit', code: 3, state: 'failed' })
    expect(jobs.get(j.id)).toMatchObject({ state: 'failed', code: 3 })
  })

  it('replays a finished job from where a reader left off', async () => {
    const jobs = createJobs({ root })
    const j = jobs.start({ dir: 'proj', cmd: 'sh', args: ['-c', 'printf hello-world'] })
    await events(jobs, j.id)
    const rest = await events(jobs, j.id, 6)
    expect(output(rest)).toBe('world')
    expect(rest.at(-1)).toMatchObject({ state: 'done', code: 0 })
  })

  it('refuses folders that are missing or outside the root, and editors it does not have', () => {
    const jobs = createJobs({ root, unityDirs: [join(root, 'editors')] })
    expect(() => jobs.start({ dir: '../', cmd: 'ls' })).toThrow(/under the work root/)
    expect(() => jobs.start({ dir: 'nope', cmd: 'ls' })).toThrow(/sync it first/)
    expect(() => jobs.start({ dir: 'proj', unity: '6000.4.5f1' })).toThrow(/not installed/)
  })

  it('finds the Unity Editor where Unity Hub keeps it', () => {
    const dir = join(root, 'editors')
    mkdirSync(join(dir, '6000.4.5f1', 'Editor'), { recursive: true })
    writeFileSync(join(dir, '6000.4.5f1', 'Editor', 'Unity'), '')
    expect(unityEditor('6000.4.5f1', [dir], 'linux')).toBe(join(dir, '6000.4.5f1', 'Editor', 'Unity'))
    expect(unityEditor('6000.3.9f1', [dir], 'linux')).toBeNull()
    expect(unityEditor('../../bin/sh', [dir], 'linux')).toBeNull()
    expect(unityVersions([dir, join(root, 'missing')], 'linux')).toEqual(['6000.4.5f1'])
  })

  it('runs one job per folder, and makes the folders a command writes into', async () => {
    const jobs = createJobs({ root })
    const j = jobs.start({ dir: 'proj', cmd: 'sh', args: ['-c', 'sleep 0.3; test -d out/results && echo made'], mkdirs: ['out/results', '../../escape'] })
    expect(() => jobs.start({ dir: './proj', cmd: 'true' })).toThrow(/busy/)
    const seen = await events(jobs, j.id)
    expect(output(seen)).toContain('made')
    expect(jobs.start({ dir: 'proj', cmd: 'true' }).state).toBe('running')
  })

  it('keeps a capped machine to its number of jobs, at the priority it was given', async () => {
    const jobs = createJobs({ root, maxRunning: 1, nice: 15 })
    mkdirSync(join(root, 'other'), { recursive: true })
    const j = jobs.start({ dir: 'proj', cmd: 'sh', args: ['-c', 'sleep 0.3; ps -o nice= -p $$'] })
    expect(() => jobs.start({ dir: 'other', cmd: 'true' })).toThrow(/1 job at a time/)
    expect(jobs.cap).toEqual({ jobs: 1, nice: 15 })
    const seen = await events(jobs, j.id)
    expect(output(seen).trim()).toBe('15')
  })

  it('refuses a job that would leave the machine short of memory, sized by what it runs', () => {
    const low = createJobs({ root, available: () => 3.5e9, reserve: 1.2e9 })
    expect(() => low.start({ dir: 'proj', unity: '6000.4.5f1' })).toThrow(/not enough memory|not installed/)
    expect(() => low.start({ dir: 'proj', cmd: '/opt/blender/blender', args: [] })).toThrow(/not enough memory \(3.5 GB free, this job needs about 3.0 GB\)/)
    expect(() => low.start({ dir: 'proj', cmd: 'sh', args: ['-c', 'true'], memory: 2.5e9 })).toThrow(/not enough memory/)
    expect(low.start({ dir: 'proj', cmd: 'sh', args: ['-c', 'true'] }).state).toBe('running')
    expect([needOf({ unity: '6000.4.5f1' }), needOf({ cmd: 'ffmpeg' }), needOf({ cmd: 'node' })]).toEqual([3e9, 1e9, 1.5e9])
  })

  it('ends a job and everything it started', async () => {
    const jobs = createJobs({ root })
    const j = jobs.start({ dir: 'proj', cmd: 'sh', args: ['-c', 'sleep 30 & sleep 30; echo never'] })
    const done = events(jobs, j.id)
    await new Promise((r) => setTimeout(r, 200))
    expect(jobs.kill(j.id)).toBe(true)
    const seen = await done
    expect(seen.at(-1)).toMatchObject({ t: 'exit', state: 'killed' })
    expect(output(seen)).not.toContain('never')
  })
})
