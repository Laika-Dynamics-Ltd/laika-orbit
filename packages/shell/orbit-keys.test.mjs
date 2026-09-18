import { expect, test } from 'vitest'
import { orbitKey } from './orbit-keys.mjs'

const k = (code, mods = '') => ({ code, meta: mods.includes('⌘'), alt: mods.includes('⌥'), control: mods.includes('⌃'), shift: mods.includes('⇧') })

// regression: a web page with focus swallowed every one of these, so the window system, the
// panel chords and the workspaces did nothing until you clicked back into Orbit
test("Orbit's own keys are taken from a web page", () => {
  for (const [code, mods] of [
    ['ArrowLeft', '⌥⌘'],
    ['ArrowRight', '⇧⌥⌘'],
    ['KeyW', '⌥⌘'],
    ['KeyQ', '⌥⌘'],
    ['KeyL', '⌥⌘'],
    ['KeyC', '⇧⌥⌘'],
    ['Digit3', '⌃'],
    ['Digit0', '⌃⇧'],
  ])
    expect(orbitKey(k(code, mods)), `${mods}${code}`).toBe(true)
})

test("the page keeps everything else, DevTools included", () => {
  for (const [code, mods] of [
    ['KeyA', ''],
    ['KeyM', '⌥⌘'],
    ['Digit1', '⌥⌘'],
    ['KeyI', '⌥⌘'],
    ['KeyW', '⌘'],
    ['KeyC', '⌥⌘'],
    ['Digit1', '⌘'],
  ])
    expect(orbitKey(k(code, mods)), `${mods}${code}`).toBe(false)
})
