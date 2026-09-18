import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { derivedEta, listBoards, parseEta, prune, putBoard, putJob, putLane, readBoard, removeBoard, slug } from '../runs.mjs'

const M = 60_000
const T = 1_800_000_000_000
const fresh = () => mkdtempSync(join(tmpdir(), 'progress-test-'))
const env = { CLAUDE_CODE_SESSION_ID: 'chat-1', CLAUDE_PID: '4242' }
const up = () => true

describe('runs store', () => {
  it('makes ids safe file names and refuses empty ones', () => {
    expect(slug('Site Rebuild / v2')).toBe('site-rebuild-v2')
    expect(slug('../../etc')).toBe('etc')
    expect(() => slug('///')).toThrow()
  })

  it('reads ETAs as durations, minutes or times', () => {
    expect(parseEta('15m', T)).toBe(T + 15 * M)
    expect(parseEta('1h30m', T)).toBe(T + 90 * M)
    expect(parseEta('90s', T)).toBe(T + 90_000)
    expect(parseEta('5', T)).toBe(T + 5 * M)
    expect(parseEta('2026-09-18T10:00:00Z', T)).toBe(Date.parse('2026-09-18T10:00:00Z'))
    expect(parseEta('', T)).toBeNull()
    expect(() => parseEta('soon', T)).toThrow()
  })

  it('moves a lane with its jobs even when they are only reported once done, and reopens it for a new one', () => {
    const dir = fresh()
    putBoard('run', { title: 'A run' }, { dir, now: T, env })
    putLane('run', 'build', {}, { dir, now: T, env })
    putJob('run', 'build', 'page-1', { status: 'done' }, { dir, now: T + 1, env })
    const lane = () => readBoard('run', { dir, now: T + 20 * M, isAlive: up }).lanes[0]
    // was: status 'queued' at 100%, and later flagged stalled
    expect(lane()).toMatchObject({ status: 'done', pct: 100, stalled: false })
    putJob('run', 'build', 'page-2', { status: 'running' }, { dir, now: T + 2, env })
    expect(lane()).toMatchObject({ status: 'running', pct: 50 })
  })

  it('records which chat reported, and a running board with lanes in order', () => {
    const dir = fresh()
    putBoard('run', { title: 'A run', stallMin: 10 }, { dir, now: T, env })
    putLane('run', 'b', { status: 'running', pct: 50 }, { dir, now: T + 1, env })
    putLane('run', 'a', { status: 'queued' }, { dir, now: T + 2, env })
    const b = readBoard('run', { dir, now: T + 3, isAlive: up })
    expect(b).toMatchObject({ title: 'A run', chat: 'chat-1', pid: 4242, state: 'running', pct: 25 })
    expect(b.lanes.map((l) => l.id)).toEqual(['b', 'a'])
  })

  it('flags a running lane with no update past its limit as stalled', () => {
    const dir = fresh()
    putLane('run', 'build', { status: 'running', pct: 10 }, { dir, now: T, env })
    putBoard('run', { stallMin: 10 }, { dir, now: T, env })
    expect(readBoard('run', { dir, now: T + 9 * M, isAlive: up }).state).toBe('running')
    const b = readBoard('run', { dir, now: T + 11 * M, isAlive: up })
    expect(b.state).toBe('stalled')
    expect(b.lanes[0].stalled).toBe(true)
    // a later report clears it
    putLane('run', 'build', { pct: 20 }, { dir, now: T + 12 * M, env })
    expect(readBoard('run', { dir, now: T + 12 * M, isAlive: up }).state).toBe('running')
  })

  it('never calls waiting on a person a stall, and never flags a finished board', () => {
    const dir = fresh()
    putLane('run', 'review', { status: 'blocked', note: 'needs sign-off' }, { dir, now: T, env })
    expect(readBoard('run', { dir, now: T + 60 * M, isAlive: up }).state).toBe('blocked')
    putLane('run', 'build', { status: 'running' }, { dir, now: T, env })
    putBoard('run', { status: 'done' }, { dir, now: T + M, env })
    const b = readBoard('run', { dir, now: T + 600 * M, isAlive: up })
    expect(b.state).toBe('done')
    expect(b.lanes.some((l) => l.stalled)).toBe(false)
  })

  it('calls a run over only once its chat process is gone AND it has stopped reporting', () => {
    const dir = fresh()
    putLane('run', 'build', { status: 'running' }, { dir, now: T, env })
    // a chat's process id changes under it (Claude Code re-execs), so a dead pid alone means nothing
    expect(readBoard('run', { dir, now: T, isAlive: () => false }).state).toBe('running')
    expect(readBoard('run', { dir, now: T + 15 * M, isAlive: () => false }).state).toBe('stalled')
    expect(readBoard('run', { dir, now: T + 25 * M, isAlive: () => false }).state).toBe('orphaned')
    // no pid to check is not evidence of anything
    expect(readBoard('run', { dir, now: T + 25 * M, isAlive: () => null }).state).toBe('stalled')
  })

  it('keeps a stated ETA, projects one from progress otherwise, and bounds the board by its last lane', () => {
    const dir = fresh()
    putLane('run', 'a', { status: 'running', pct: 20 }, { dir, now: T, env })
    putLane('run', 'a', { pct: 40 }, { dir, now: T + 10 * M, env })
    putLane('run', 'b', { status: 'running', eta: '45m' }, { dir, now: T + 10 * M, env })
    putLane('run', 'c', { status: 'queued' }, { dir, now: T + 10 * M, env })
    const b = readBoard('run', { dir, now: T + 10 * M, isAlive: up })
    const [a, bb] = b.lanes
    expect(a.etaDerived).toBe(true)
    expect(a.etaAt).toBe(T + 40 * M) // 20 points per 10 minutes, 60 to go
    expect(bb).toMatchObject({ etaAt: T + 55 * M, etaDerived: false })
    expect(b).toMatchObject({ etaAt: T + 55 * M, etaPartial: true })
  })

  it('does not project an ETA from under a minute of progress', () => {
    expect(derivedEta([[T, 0], [T + 5000, 50]], T)).toBeNull()
    expect(derivedEta([[T, 0], [T + 2 * M, 50]], T + 2 * M)).toBe(T + 4 * M)
  })

  it('moves a lane with its jobs unless the lane states its own progress', () => {
    const dir = fresh()
    putJob('run', 'shots', 'one', { status: 'done' }, { dir, now: T, env })
    putJob('run', 'shots', 'two', { status: 'running', pct: 50 }, { dir, now: T, env })
    let lane = readBoard('run', { dir, now: T, isAlive: up }).lanes[0]
    expect(lane).toMatchObject({ status: 'running', done: 1, total: 2, pct: 75 })
    putLane('run', 'shots', { pct: 10 }, { dir, now: T, env })
    putJob('run', 'shots', 'three', {}, { dir, now: T, env })
    lane = readBoard('run', { dir, now: T, isAlive: up }).lanes[0]
    expect(lane.pct).toBe(10)
    expect(lane.jobs.map((j) => j.id)).toEqual(['one', 'two', 'three'])
  })

  it('rejects unknown statuses', () => {
    expect(() => putLane('run', 'x', { status: 'nearly' }, { dir: fresh(), now: T, env })).toThrow(/status/)
  })

  it('lists newest first, removes and prunes old finished boards', () => {
    const dir = fresh()
    putBoard('old', { status: 'done' }, { dir, now: T - 10 * 1440 * M, env })
    putBoard('new', {}, { dir, now: T, env })
    expect(listBoards({ dir, now: T, isAlive: up }).map((b) => b.id)).toEqual(['new', 'old'])
    expect(prune(7, { dir, now: T })).toEqual(['old'])
    expect(removeBoard('new', { dir })).toBe(true)
    expect(listBoards({ dir, now: T })).toEqual([])
  })

  it('keeps every report when several processes write one lane at once', async () => {
    const dir = fresh()
    const cli = join(import.meta.dirname, '../runs.mjs')
    const run = promisify(execFile)
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        run(process.execPath, [cli, 'job', 'run', 'lane', `job-${i}`, '--status', 'done'], {
          env: { ...process.env, LAIKA_PROGRESS_DIR: dir },
        }),
      ),
    )
    const lane = readBoard('run', { dir, isAlive: up }).lanes[0]
    expect(lane.jobs).toHaveLength(12)
    expect(lane.pct).toBe(100)
  })
})
