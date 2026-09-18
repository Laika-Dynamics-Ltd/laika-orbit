import { expect, test } from 'vitest'
import { publicTab } from './tab-state.mjs'

// regression: a sleeping-timer on the tab record made the whole state snapshot uncloneable,
// so the page stopped hearing about tabs and the strip froze
test('a tab with a live timer and view still crosses IPC as plain data', () => {
  const timer = setTimeout(() => {}, 60_000)
  const t = { id: '1', profile: 'p', url: 'https://example.com/', title: 'x', favicon: null, loading: false, audible: false, muted: false, failed: null, opener: null, zoom: 1, heard: false, nav: { entries: [], index: 0 }, view: { webContents: { focus() {} } }, sleepTimer: timer }
  const out = publicTab(t, { sleeping: false })
  clearTimeout(timer)
  expect(() => structuredClone(out)).not.toThrow()
  expect(out).not.toHaveProperty('view')
  expect(out).not.toHaveProperty('sleepTimer')
  expect(out.sleeping).toBe(false)
})
