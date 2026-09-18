import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classify, heaviest, judge, macBusy, noticeOf, parsePs, parseTherm } from '../feeds/loadwatch.mjs'
import { planBlender } from '../blender-offload.mjs'

const PS = [
  '    1     0   0.0   1000 /sbin/launchd',
  '  500     1   2.0  90000 /home/j/.local/bin/claude --resume 11111111-2222-3333-4444-555555555555',
  '  600   500   1.0   9000 bash ./game-check.sh --fast',
  '  610   600 310.0 3000000 /Applications/Unity/Hub/Editor/6000.4.5f1/Unity.app/Contents/MacOS/Unity -batchmode -nographics -projectPath . -runTests',
  '  611   610  40.0 200000 /Applications/Unity/Hub/Editor/6000.4.5f1/Unity.app/Contents/MacOS/Unity -batchmode -worker',
  '  700     1   1.0  90000 /home/j/.local/bin/claude',
  '  710   700 250.0 400000 /opt/homebrew/bin/ffmpeg -y -i film.mp4 -c:v libx264 web.mp4',
  '  800     1 120.0 900000 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -scheme Flip',
  '  900     1  20.0 800000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].join('\n')

describe('load watch', () => {
  it('reads ps and pmset', () => {
    expect(parsePs(PS)[3]).toMatchObject({ pid: 610, ppid: 600, cpu: 310, mem: 3000000 * 1024 })
    expect(parseTherm('CPU_Speed_Limit \t= 72\nCPU_Available_CPUs = 10')).toBe(72)
    expect(parseTherm('Note: No thermal warning level has been recorded')).toBe(100)
  })

  it('knows which heavy work could run on another machine', () => {
    expect(classify('/Applications/Unity/Hub/Editor/x/Unity.app/Contents/MacOS/Unity -batchmode')).toMatchObject({ kind: 'unity', offloadable: true })
    expect(classify('/Applications/Unity/Hub/Editor/x/Unity.app/Contents/MacOS/Unity -projectPath .')).toMatchObject({ kind: 'unity', offloadable: false })
    expect(classify('ffmpeg -f image2pipe -i - out.mp4')).toMatchObject({ kind: 'ffmpeg', offloadable: false })
    expect(classify('/Applications/Blender.app/Contents/MacOS/Blender -b a.blend -a')).toMatchObject({ kind: 'blender', offloadable: true })
    expect(classify('xcodebuild -scheme Flip')).toMatchObject({ kind: 'build', offloadable: false })
    expect(classify('node /x/node_modules/.bin/vite build')).toMatchObject({ kind: 'build', offloadable: true })
    expect(classify('/x/chrome-headless-shell --headless=new')).toMatchObject({ kind: 'browser', offloadable: true })
  })

  it('names the heaviest work and the chat it runs under, children counted with it', () => {
    const heavy = heaviest(parsePs(PS), {
      chats: new Map([['11111111-2222-3333-4444-555555555555', 'Game lane a']]),
      cwdOf: (pid) => (pid === 700 ? '/home/j/dev/shop-dev' : null),
    })
    expect(heavy.map((h) => [h.label, h.owner, h.cpu])).toEqual([
      ['Unity (batch)', 'chat “Game lane a”', 350],
      ['ffmpeg', 'Claude Code in shop-dev', 250],
      ['Xcode / Swift build', 'Xcode', 120],
    ])
  })

  it('puts one line in front of Joe while busy', () => {
    expect(noticeOf([{ label: 'Unity (batch)', offloadable: true }], ['CPU 97%'])).toBe('Mac busy: Unity (batch) is heavy (new ones go to the other machines)')
    expect(noticeOf([{ label: 'Xcode / Swift build', offloadable: false }], ['CPU 97%'])).toBe('Mac busy: Xcode / Swift build is heavy')
    expect(noticeOf([], ['memory 93%'])).toBe('Mac busy: memory 93%')
  })

  it('calls the Mac busy only after a sustained minute, and clear after 30 calm seconds', () => {
    const hot = { cpu: 95, mem: 60, speedLimit: 100 }
    const calm = { cpu: 30, mem: 60, speedLimit: 100 }
    expect(judge(false, [hot, hot, hot, hot, hot])).toBe(false)
    expect(judge(false, [hot, hot, hot, hot, hot, hot])).toBe(true)
    expect(judge(false, [hot, hot, calm, hot, hot, hot])).toBe(false)
    expect(judge(true, [hot, calm, calm])).toBe(true)
    expect(judge(true, [calm, calm, calm])).toBe(false)
    expect(judge(false, Array(6).fill({ cpu: 20, mem: 20, speedLimit: 60 }))).toBe(true)
  })

  it('tells the offload tools, and forgets a state no watcher is keeping fresh', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'lw-')), 'load.json')
    writeFileSync(f, JSON.stringify({ busy: true, at: Date.now() }))
    expect(macBusy(f)).toBe(true)
    writeFileSync(f, JSON.stringify({ busy: true, at: Date.now() - 120_000 }))
    expect(macBusy(f)).toBe(false)
  })

  it('offloads only background renders that write inside their project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bl-'))
    writeFileSync(join(dir, 'scene.blend'), '')
    expect(planBlender(['scene.blend'], dir).local).toMatch(/background/)
    expect(planBlender(['-b', 'scene.blend', '-a'], dir).local).toMatch(/no -o/)
    expect(planBlender(['-b', 'scene.blend', '-o', '/tmp/x_####', '-a'], dir).local).toMatch(/outside/)
    const p = planBlender(['-b', 'scene.blend', '-o', '//render/f_####', '-a'], dir)
    expect(p).toMatchObject({ root: dir, args: ['-b', 'scene.blend', '-o', '//render/f_####', '-a'], bring: 'render' })
  })
})
