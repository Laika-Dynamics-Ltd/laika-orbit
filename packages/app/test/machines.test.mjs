import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inProject, parseAddress, planUnity, remoteDir } from '../machines.mjs'
import { parseArgs } from '../offload.mjs'

const project = join(mkdtempSync(join(tmpdir(), 'offload-')), 'My Game')
mkdirSync(join(project, 'ProjectSettings'), { recursive: true })
writeFileSync(join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.4.5f1\nm_EditorVersionWithRevision: 6000.4.5f1 (cc83ebd631f8)\n')

describe('machines', () => {
  it('reads user@host addresses', () => {
    expect(parseAddress('devuser@192.168.1.20')).toEqual({ user: 'devuser', host: '192.168.1.20', port: 22 })
    expect(parseAddress('joe@box.local:2222')).toEqual({ user: 'joe', host: 'box.local', port: 2222 })
    expect(parseAddress('box.local')).toBeNull()
    expect(parseAddress('a@b; rm -rf /')).toBeNull()
  })

  it('gives every project its own folder on a machine', () => {
    expect(remoteDir('/home/j/dev/Game WR-a')).toMatch(/^game-wr-a-[0-9a-f]{8}$/)
    expect(remoteDir('/a/game')).not.toBe(remoteDir('/b/game'))
    expect(remoteDir('/a/game/')).toBe(remoteDir('/a/game'))
  })

  it('keeps paths inside the project', () => {
    expect(inProject('/p', '/p', 'out/x.xml')).toBe('out/x.xml')
    expect(inProject('/p', '/p/sub', '../out/x.xml')).toBe('out/x.xml')
    expect(inProject('/p', '/p', '/p/a')).toBe('a')
    expect(inProject('/p', '/p', '/tmp/x')).toBeNull()
    expect(inProject('/p', '/p', '../p2/x')).toBeNull()
  })

  it('turns a Unity test run into one for the project copy, bringing its results back', () => {
    const plan = planUnity(
      ['-nographics', '-projectPath', '.', '-runTests', '-testPlatform', 'EditMode', '-testResults', '.gauntlet/out/tests.xml', '-logFile', '-'],
      project,
    )
    expect(plan.project).toBe(project)
    expect(plan.version).toBe('6000.4.5f1')
    expect(plan.args).toEqual(['-batchmode', '-nographics', '-projectPath', '.', '-runTests', '-testPlatform', 'EditMode', '-testResults', '.gauntlet/out/tests.xml', '-logFile', '-'])
    expect(plan.bring).toEqual(['.gauntlet/out'])
    expect(plan.mkdirs).toEqual(['.gauntlet/out'])
  })

  it('rewrites absolute project and output paths, and refuses outputs outside the project', () => {
    const plan = planUnity(['-batchmode', '-projectPath', project, '-logFile', join(project, 'Logs', 'run.log'), '-buildLinux64Player', join(project, 'Builds', 'game')], '/elsewhere')
    expect(plan.args).toEqual(['-batchmode', '-projectPath', '.', '-logFile', 'Logs/run.log', '-buildLinux64Player', 'Builds/game'])
    expect(plan.bring).toEqual(['Logs', 'Builds/game'])
    expect(plan.mkdirs).toEqual(['Logs'])
    expect(() => planUnity(['-projectPath', project, '-testResults', '/tmp/out.xml'], '/')).toThrow(/outside the project/)
  })

  it('reads offload options up to --', () => {
    expect(parseArgs(['--on', 'box1', '--bring', 'a', '--', 'npm', '--on', 'x'])).toMatchObject({ on: 'box1', bring: ['a'], rest: ['npm', '--on', 'x'] })
  })
})
