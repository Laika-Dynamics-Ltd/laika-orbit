/**
 * Keys Orbit owns, taken from a web page and played to the app instead: the window system's
 * ⌥⌘ keys and ⌃1–9 workspaces (panels.ts), the panel chords (⌥⌘A/B/L/P/Q, ⇧⌥⌘C/D/P/Y) and the
 * chats' ⌥⌘E/F/O/S (sessions.ts). A copy of the lists those files keep; ⌥⌘I stays DevTools.
 */
const ORBIT_ALT_CMD = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Equal', 'Minus', 'Enter', 'Slash', ...'ABEFLOPQSVW'.split('').map((c) => `Key${c}`)])
const ORBIT_SHIFT_ALT_CMD = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Equal', 'Minus', ...'CDPY'.split('').map((c) => `Key${c}`)])
export function orbitKey(input) {
  if (input.meta && input.alt && !input.control) return (input.shift ? ORBIT_SHIFT_ALT_CMD : ORBIT_ALT_CMD).has(input.code)
  return input.control && !input.meta && !input.alt && /^Digit[0-9]$/.test(input.code)
}
