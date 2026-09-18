import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createQueue } from '../queue.mjs'
import { createQueueHost } from '../queue-host.mjs'

const fileFor = () => join(mkdtempSync(join(tmpdir(), 'queue-')), 'queue.json')

/** a chat as the host's Session looks to the queue: it records what it was sent */
const chat = (id) => ({ id, repo: 'r', state: 'idle', events: [], pending: new Map(), sent: [], emit() {} })

describe('the work queue', () => {
  // the two things that break silently: a dependent item going out early, and a restart losing work
  it('sends a chat its items in dependency order, never one whose dependencies are not done', () => {
    const queue = createQueue({ file: fileFor() })
    const x = chat('chat-a')
    const sessions = new Map([[x.id, x]])
    let gate = 'autopilot is off: it waits for you'
    const host = createQueueHost({
      queue,
      sessions,
      deps: { gate: () => gate, send: (c, text) => c.sent.push(text), report: () => {}, busy: () => false, isConductor: () => false },
    })

    // added in the wrong order on purpose: the later-added item is the one the other waits on
    const second = queue.add({ title: 'second', brief: 'do the second thing', chatId: x.id, order: 0 })
    const first = queue.add({ title: 'first', brief: 'do the first thing', chatId: x.id, order: 1 })
    queue.update(second.id, { blockedBy: [first.id] })
    expect(() => queue.update(first.id, { blockedBy: [second.id] })).toThrow(/cycle/)
    expect(() => queue.start(second.id)).toThrow(/waits on/)

    // off autopilot nothing goes out: the item is ready and left
    expect(host.dispatch(x)).toBeNull()
    expect(x.sent).toEqual([])
    expect(queue.get(first.id).ready).toBe(true)

    gate = null
    expect(host.dispatch(x)?.id).toBe(first.id)
    expect(x.sent).toEqual(['do the first thing'])
    // the first is still running: the chat gets nothing new until it is marked done
    expect(host.dispatch(x)).toBeNull()

    queue.update(first.id, { state: 'done' })
    expect(host.dispatch(x)?.id).toBe(second.id)
    expect(x.sent).toEqual(['do the first thing', 'do the second thing'])
  })

  it('keeps every item across a restart and a closed chat, running ones queued again without spending a retry', () => {
    const file = fileFor()
    const before = createQueue({ file })
    const a = before.add({ title: 'build it', brief: 'build', chatId: 'chat-a', estimate: 30, machine: 'box1' })
    const b = before.add({ title: 'check it', brief: 'check', chatId: 'chat-a', after: a.id })
    before.start(a.id)
    before.fail(b.id, 'usage limit')

    // the host dies and a new one reads the same file
    const after = createQueue({ file })
    expect(after.all().map((r) => r.id).sort()).toEqual([a.id, b.id].sort())
    const back = after.restore()
    expect(back.map((r) => r.id)).toEqual([a.id])
    const got = after.get(a.id)
    expect(got).toMatchObject({ state: 'queued', chatId: 'chat-a', estimate: 30, machine: 'box1', retries: 0, ready: true })
    expect(got.lastError).toMatch(/restarted/)
    expect(after.get(b.id)).toMatchObject({ retries: 1, lastError: 'usage limit', waitingOn: [a.id] })

    // its chat closes: both go back to the pile, nothing binned, dependencies and errors kept
    expect(after.release('chat-a')).toHaveLength(2)
    const again = createQueue({ file })
    expect(again.all().map((r) => [r.id, r.chatId, r.state])).toEqual([
      [a.id, null, 'queued'],
      [b.id, null, 'queued'],
    ])
    expect(again.get(b.id).blockedBy).toEqual([a.id])
  })
})
