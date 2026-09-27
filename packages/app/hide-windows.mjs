/**
 * On Windows, spawning a console program (claude.exe, git.exe, ...) pops a visible cmd/conhost
 * window unless the call sets `windowsHide: true`. Not every spawn site in this codebase, and
 * none inside the vendored Agent SDK, reliably does.
 *
 * This patches node:child_process globally (so anything already calling `spawn`/`execFile` etc.
 * gets windowsHide for free) AND exports the same wrapped functions by name, because the global
 * patch alone was not enough: named ESM imports of a builtin (`import { execFile } from
 * 'node:child_process'`) are meant to pick up a mutation once `module.syncBuiltinESMExports()`
 * runs, but that did not reliably show up for every call site in the real running app (agent-host
 * spawned with no console of its own, unlike an interactive dev shell, so its children flash a
 * brand-new window - see the identical bug fixed by hand in C:\laika\screen\server.mjs). Call
 * sites that still flash a window should switch their import to `from './hide-windows.mjs'`
 * instead of `'node:child_process'` - that reference can't miss the patch, no binding-propagation
 * mechanism required.
 *
 * Delegates to the original functions' own `promisify.custom` (rather than reimplementing the
 * {stdout, stderr} shape) so `promisify(execFile)` keeps working - a from-scratch version of this
 * dropped that symbol before and silently broke every caller of promisify(execFile)/(exec).
 */
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'

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

const identity = (fn) => fn

const make = process.platform === 'win32' ? wrap : identity

export const exec = make(cp.exec.bind(cp))
export const execFile = make(cp.execFile.bind(cp))
export const spawn = make(cp.spawn.bind(cp))
export const execSync = make(cp.execSync.bind(cp))
export const execFileSync = make(cp.execFileSync.bind(cp))

if (process.platform === 'win32') {
  cp.exec = exec
  cp.execFile = execFile
  cp.spawn = spawn
  cp.execSync = execSync
  cp.execFileSync = execFileSync

  // Named imports elsewhere (`import { spawn } from 'node:child_process'`) are meant to pick up
  // the mutation above once this runs - kept as a best-effort net for call sites not yet switched
  // to importing from here directly.
  syncBuiltinESMExports()
}
