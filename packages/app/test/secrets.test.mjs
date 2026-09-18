import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { hasSecret, listSecrets, readSnippet, saveSecret, secretTools, validName } from '../secrets.mjs'

/** the SDK's tool() shape, enough to call a handler */
const tool = (name, _d, _schema, handler) => ({ name, handler })
const byName = (tools) => Object.fromEntries(tools.map((t) => [t.name, t.handler]))
const textOf = (r) => r.content.map((c) => c.text).join('')

describe('secrets', () => {
  it('takes names, not values', () => {
    expect(validName('box1-ssh')).toBe(true)
    expect(validName('shop.admin_1')).toBe(true)
    expect(validName('')).toBe(false)
    expect(validName("x'; rm -rf ~")).toBe(false)
    expect(validName('a b')).toBe(false)
    expect(validName('-flag')).toBe(false)
    expect(readSnippet('box1-ssh')).toBe(`"$(security find-generic-password -s 'laika-orbit secret' -a 'box1-ssh' -w)"`)
  })

  it('asks for a missing secret, saves what is typed, and never returns the value', async () => {
    const saved = new Map()
    const asked = []
    const store = {
      hasSecret: async (n) => saved.has(n),
      saveSecret: async (n, v) => void saved.set(n, v),
      listSecrets: async () => [...saved.keys()],
    }
    const t = byName(secretTools({ tool, store, ask: async (p) => (asked.push(p), { value: 'hunter2-very-secret' }) }))
    const first = await t.secret_request({ name: 'box1-ssh', why: 'log in to box1' })
    expect(asked).toEqual([{ name: 'box1-ssh', why: 'log in to box1' }])
    expect(saved.get('box1-ssh')).toBe('hunter2-very-secret')
    expect(textOf(first)).not.toContain('hunter2')
    expect(textOf(first)).toContain(readSnippet('box1-ssh'))
    // stored now: no second prompt
    await t.secret_request({ name: 'box1-ssh', why: 'again' })
    expect(asked).toHaveLength(1)
    expect(textOf(await t.secret_list({}))).toBe('box1-ssh')
  })

  it('reports a declined prompt and a bad name as errors', async () => {
    const store = { hasSecret: async () => false, saveSecret: async () => {}, listSecrets: async () => [] }
    const t = byName(secretTools({ tool, store, ask: async () => ({ behavior: 'deny', message: 'not now' }) }))
    expect(await t.secret_request({ name: 'x', why: '' })).toMatchObject({ isError: true })
    expect(await t.secret_request({ name: 'no spaces', why: '' })).toMatchObject({ isError: true })
  })

  describe.runIf(process.platform === 'darwin')('in a real keychain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-test-'))
    const keychain = join(dir, 'test.keychain')
    execFileSync('security', ['create-keychain', '-p', 'test', keychain])
    afterAll(() => {
      try {
        execFileSync('security', ['delete-keychain', keychain])
      } catch {}
      rmSync(dir, { recursive: true, force: true })
    })

    it('round-trips quotes, backslashes and shell characters, and lists names only', async () => {
      const value = `p"a\\ss $HOME \`id\` 'q' ;&|`
      await saveSecret('odd-one', value, { keychain })
      expect(await hasSecret('odd-one', { keychain })).toBe(true)
      const out = execFileSync('security', ['find-generic-password', '-s', 'laika-orbit secret', '-a', 'odd-one', '-w', keychain], { encoding: 'utf8' })
      expect(out.replace(/\n$/, '')).toBe(value)
      expect(await listSecrets({ keychain })).toEqual(['odd-one'])
      await expect(saveSecret('two-lines', 'a\nb', { keychain })).rejects.toThrow()
    })
  })
})
