import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { readState } from './state-file.mjs'

// regression: a torn browser.json meant a fresh start with one profile, saved over the old file,
// so every profile, sign-in, tab and bookmark was gone
test('a torn state file falls back to the last good one and is kept aside', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-state-'))
  const file = join(dir, 'browser.json')
  writeFileSync(file, JSON.stringify({ profiles: [{ id: 'a', name: 'Work' }] }))
  expect((await readState(file)).profiles[0].name).toBe('Work') // a good launch keeps a .bak
  writeFileSync(file, '{"profiles": [{"id": "a", "na')
  expect((await readState(file)).profiles[0].name).toBe('Work')
  expect(existsSync(file)).toBe(false)
  expect(readdirSync(dir).some((f) => f.startsWith('browser.json.broken-'))).toBe(true)
})

test('no file at all is a first launch, not an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-state-'))
  expect(await readState(join(dir, 'browser.json'))).toBe(null)
})
