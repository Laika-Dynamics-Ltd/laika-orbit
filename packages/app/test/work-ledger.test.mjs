import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLedger } from '../work-ledger.mjs'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })

describe('the close and park guard', () => {
  let dir, root, wt
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-')))
    root = join(dir, 'repo')
    wt = join(dir, 'repo-wt')
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    writeFileSync(join(root, 'settings.json'), '{}\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'init')
    git(root, 'worktree', 'add', '-q', '-b', 'feature', wt)
    // a runtime file the running app rewrote in the shared main checkout
    writeFileSync(join(root, 'settings.json'), '{"moved":1}\n')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const chat = (id, events) => ({ id, cwd: root, seq: events.length, events })

  it("checks the chat's own worktree and its own changes, not a stray file in the main checkout", async () => {
    const x = chat('a', [{ t: 'tool', name: 'Edit', input: { file_path: join(wt, 'a.txt') } }])
    const ledger = createLedger({ sessions: new Map([['a', x]]) })
    expect((await ledger.worktreeOf(x)).path).toBe(wt)
    expect(await ledger.dirty(x)).toBe(false)
    writeFileSync(join(wt, 'a.txt'), 'work\n')
    const again = createLedger({ sessions: new Map([['a', x]]) })
    expect(await again.dirty(x)).toBe(true)
    // a chat working in the main checkout itself: only the files it changed count
    const y = chat('b', [{ t: 'tool', name: 'Edit', input: { file_path: join(root, 'other.txt') } }])
    expect(await createLedger({ sessions: new Map([['b', y]]) }).dirty(y)).toBe(false)
  })
})
