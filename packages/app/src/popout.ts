/**
 * Pop-outs: a part of the app (the Claude panel, agent control) in a desktop window of its own,
 * so it can live on another screen. The shell owns the windows and remembers where each one
 * was; the main page only asks for one and steps its own copy aside while it is out.
 * Outside the desktop shell there are no windows to make, and nothing here does anything.
 */
import './popout.css'

export type PopPart = 'claude' | 'control'

/** true on pop.html, the page a pop-out window loads */
export const inPopWindow = location.pathname.endsWith('/pop.html')

export const canPop = () => !inPopWindow && typeof window.laikaShell?.popout === 'function'

/** open (or bring forward) a part's window; `false` closes it, which docks the part again */
export function popOut(part: PopPart, on = true) {
  window.laikaShell?.popout?.(part, on)
}

/** the icon on every pop-out button: a window with an arrow leaving it */
export const POP_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3"/><path d="M9.5 2.5h4v4M13.5 2.5 8 8"/></svg>`
/** the icon to put a part back: the arrow coming home */
export const POP_IN_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3"/><path d="M8 4v4h4M13.5 2.5 8 8"/></svg>`

/**
 * Calls `fn(out, was)` whenever the part goes out to its window or comes back. `was` is the
 * previous value, so a caller can tell "came back" (true → false) from "was never out".
 */
export function watchPop(part: PopPart, fn: (out: boolean, was: boolean) => void) {
  const shell = window.laikaShell
  if (!shell || !canPop()) return
  let out = false
  const take = (s: { popouts?: string[] }) => {
    const now = !!s.popouts?.includes(part)
    if (now === out) return
    const was = out
    out = now
    fn(now, was)
  }
  shell.state().then(take)
  shell.onState(take)
}
