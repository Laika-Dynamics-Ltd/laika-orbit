import { describe, expect, it } from 'vitest'
import { parseMeminfo, parseNvidiaSmi, parsePs, parseSwapUsage, parseVmStat, sysres } from '../feeds/sysres.mjs'

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     4000.
Pages wired down:                             263735.
Pages purgeable:                                4253.
Anonymous pages:                              247451.
Pages occupied by compressor:                 355241.
`

describe('sysres', () => {
  it('counts app, wired and compressed memory like Activity Monitor', () => {
    const page = 16384
    expect(parseVmStat(VM_STAT)).toEqual({
      used: (247451 - 4253 + 263735 + 355241) * page,
      app: (247451 - 4253) * page,
      wired: 263735 * page,
      compressed: 355241 * page,
    })
  })
  it('gives up on output it cannot read', () => {
    expect(parseVmStat('nothing here')).toBeNull()
    expect(parseSwapUsage('nothing here')).toBeNull()
  })
  it('counts Linux memory as everything but MemAvailable', () => {
    const info = 'MemTotal:       32000000 kB\nMemFree:         1000000 kB\nMemAvailable:   24000000 kB\n'
    expect(parseMeminfo(info)).toEqual({ used: 8000000 * 1024 })
    expect(parseMeminfo('nothing here')).toBeNull()
  })
  it('reads NVIDIA GPUs and skips rows it cannot read', () => {
    const out = 'NVIDIA GeForce RTX 4090, 37, 2048, 24564\nNVIDIA A100-SXM4-80GB, [N/A], 0, 81920\n\n'
    expect(parseNvidiaSmi(out)).toEqual([{ name: 'NVIDIA GeForce RTX 4090', util: 37, memUsed: 2048 * 1024 ** 2, memTotal: 24564 * 1024 ** 2 }])
  })
  it('reads swap from sysctl', () => {
    expect(parseSwapUsage('total = 13312.00M  used = 11956.50M  free = 1355.50M  (encrypted)')).toEqual({
      total: 13312 * 1024 ** 2,
      used: 11956.5 * 1024 ** 2,
    })
  })
  it('picks the busiest and the largest processes, names with spaces intact', () => {
    const top = parsePs(
      ['32552  97.3 468048 Electron Helper (Renderer)', '  101   0.0 900000 WindowServer', '7 12.5 1024 node', 'junk'].join('\n'),
      2,
    )
    expect(top.cpu.map((p) => p.name)).toEqual(['Electron Helper (Renderer)', 'node'])
    expect(top.mem[0]).toEqual({ pid: 101, cpu: 0, mem: 900000 * 1024, name: 'WindowServer' })
    expect(top.mem).toHaveLength(2)
  })
  it('reports whole percents, and shares a reading between close requests', async () => {
    const a = sysres()
    expect(sysres()).toBe(a)
    const s = await a
    expect(s.cpu).toBeGreaterThanOrEqual(0)
    expect(s.cpu).toBeLessThanOrEqual(100)
    expect(s.mem).toBeGreaterThan(0)
    expect(s.mem).toBeLessThanOrEqual(100)
    expect(s.memUsed).toBeLessThanOrEqual(s.memTotal)
    expect(s.loads).toHaveLength(3)
  })
  it('adds swap and processes only when asked for detail', async () => {
    const d = await sysres({ detail: true })
    expect(d.top?.cpu.length).toBeGreaterThan(0)
    expect(d).toHaveProperty('swap')
  })
})
