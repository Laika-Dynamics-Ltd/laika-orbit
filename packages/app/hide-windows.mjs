/**
 * On Windows, spawning a console program (claude.exe, git.exe, ...) pops a visible cmd/conhost
 * window unless the call sets `windowsHide: true`. Not every spawn site in this codebase, and
 * none inside the vendored Agent SDK, reliably does — so patch node:child_process once, here,
 * imported before anything else touches it, and every spawn downstream inherits the option.
 *
 * Delegates to the original functions' own `promisify.custom` (rather than reimplementing the
 * {stdout, stderr} shape) so `promisify(execFile)` keeps working - a from-scratch version of this
 * dropped that symbol before and silently broke every caller of promisify(execFile)/(exec).
 */
import cp from 'node:child_process'
import { promisify } from 'node:util'

if (process.platform === 'win32') {
  const hide = (options) => ({ ...options, windowsHide: options?.windowsHide ?? true })

  // Finds the plain-object options argument (skipping arrays like execFile's `args`, and any
  // trailing callback) and hides it - or inserts a fresh hidden options object if none is passed.
  const injectHide = (args) => {
    const out = [...args]
    const hasCb = typeof out[out.length - 1] === 'function'
    const upTo = hasCb ? out.length - 1 : out.length
    for (let i = 0; i < upTo; i++) {
      if (out[i] && typeof out[i] === 'object' && !Array.isArray(out[i])) {
        out[i] = hide(out[i])
        return out
      }
    }
    out.splice(upTo, 0, hide({}))
    return out
  }

  const wrap = (orig) => {
    const wrapped = (...args) => orig(...injectHide(args))
    const origCustom = orig[promisify.custom]
    if (origCustom) wrapped[promisify.custom] = (...args) => origCustom(...injectHide(args))
    return wrapped
  }

  cp.exec = wrap(cp.exec.bind(cp))
  cp.execFile = wrap(cp.execFile.bind(cp))
  cp.spawn = wrap(cp.spawn.bind(cp))
  cp.execSync = wrap(cp.execSync.bind(cp))
  cp.execFileSync = wrap(cp.execFileSync.bind(cp))
}
