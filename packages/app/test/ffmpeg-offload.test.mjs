import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { concatEntries, isCheap, planFfmpeg } from '../ffmpeg-offload.mjs'

const dir = mkdtempSync(join(tmpdir(), 'ffoff-'))
writeFileSync(join(dir, 'film.mp4'), 'x')
writeFileSync(join(dir, 'list.txt'), "file '/abs/a.png'\nduration 0.5\nfile 'b c.png'\nfile 'it'\\''s.png'\n")

describe('ffmpeg offload', () => {
  it('finds inputs and outputs, skipping option values', () => {
    const p = planFfmpeg(['-y', '-loglevel', 'error', '-ss', '12', '-i', 'film.mp4', '-frames:v', '1', '-q:v', '3', 'still.jpg'], dir)
    expect(p.local).toBeUndefined()
    expect(p.inputs.map((x) => [x.at, x.abs])).toEqual([[6, join(dir, 'film.mp4')]])
    expect(p.outputs.map((x) => [x.at, x.abs])).toEqual([[11, join(dir, 'still.jpg')]])
  })

  it('knows each input’s forced format, and sequences by their pattern', () => {
    const p = planFfmpeg(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-framerate', '1', '-i', '%02d.jpg', 'out.mp4'], dir)
    expect(p.inputs.map((x) => [x.format, x.sequence])).toEqual([
      ['concat', false],
      [null, true],
    ])
  })

  it('stays on this Mac for pipes, devices, URLs, file-reading filters and missing files', () => {
    expect(planFfmpeg(['-i', 'film.mp4', '-f', 'mp4', '-'], dir).local).toMatch(/not a file/)
    expect(planFfmpeg(['-f', 'avfoundation', '-i', '1', 'cap.mov'], dir).local).toMatch(/not a file/)
    expect(planFfmpeg(['-i', 'https://x/y.mp4', 'o.mp4'], dir).local).toMatch(/not a file/)
    expect(planFfmpeg(['-i', 'film.mp4', '-vf', "drawtext=fontfile=/f.ttf:text='a'", 'o.mp4'], dir).local).toMatch(/reads a file/)
    expect(planFfmpeg(['-i', 'nope.mp4', 'o.mp4'], dir).local).toMatch(/does not exist/)
    expect(planFfmpeg(['-version'], dir).local).toMatch(/no output/)
  })

  it('lets lavfi sources through without looking for files', () => {
    expect(planFfmpeg(['-f', 'lavfi', '-i', 'testsrc=size=640x360', '-t', '1', 'o.mp4'], dir).local).toBeUndefined()
  })

  it('reads the files a concat list names, relative to the list', () => {
    expect(concatEntries(join(dir, 'list.txt'))).toEqual(['/abs/a.png', join(dir, 'b c.png'), join(dir, "it's.png")])
  })

  it('tells cheap work (a still, a stream copy) from encodes', () => {
    expect(isCheap(['-ss', '3', '-i', 'a.mp4', '-frames:v', '1', 'a.jpg'])).toBe(true)
    expect(isCheap(['-i', 'a.mp4', '-c', 'copy', 'b.mp4'])).toBe(true)
    expect(isCheap(['-i', 'a.mp4', '-c:v', 'copy', '-an', 'b.mp4'])).toBe(true)
    expect(isCheap(['-i', 'a.mp4', '-c:v', 'copy', '-c:a', 'aac', 'b.mp4'])).toBe(false)
    expect(isCheap(['-ss', '0', '-i', 'clip.mp4', '-an', '-c:v', 'libx264', '-crf', '16', 'o.mp4'])).toBe(false)
    expect(isCheap(['-i', 'a.mov', 'b.mp4'])).toBe(false)
  })
})
