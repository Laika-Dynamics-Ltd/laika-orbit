/**
 * Shared set-up for the browser suite: `pnpm test:e2e`.
 *
 * run.mjs starts a quiet server on a free port and passes it down as E2E_URL, so nothing
 * has to be running first and another session's file saves cannot reload the page mid-test.
 * Point the suite at a server you already have with E2E_URL=http://localhost:5200.
 *
 * These drive the real app on the real server, which writes real files. So every suite
 * snapshots the files it can change — the widget layout and the profile — and puts them back
 * afterwards, whatever happened. Nothing destructive is ever confirmed: Gmail disconnect and
 * widget reset are only armed, then cancelled.
 */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

export const BASE = process.env.E2E_URL ?? 'http://localhost:5200'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const GUARDED = ['brain/widgets/_settings.json', 'brain/profile.local.json'].map((p) => resolve(ROOT, p))

/**
 * Vite still injects its client when HMR is off, and that client then fails to reach a socket
 * nobody is listening on. It is the dev server's own transport complaining, never the app, and
 * the suite runs with HMR off by design — so it cannot be allowed to read as a page error.
 * Nothing in the app opens a websocket, so this cannot hide one of ours.
 */
const VITE_NOISE = /@vite\/client|^\[vite\]|WebSocket (connection to|closed without opened)/

/**
 * Waits up to a minute for the server (a fresh instance builds its index first), then primes
 * the index. An unreachable server fails the run rather than skipping it: a skipped suite
 * looks like a pass. Set E2E_OPTIONAL=1 to skip instead.
 */
export async function serverUp() {
  const until = Date.now() + 60_000
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/api/gmail/status`, { signal: AbortSignal.timeout(3000) })
      if (r.ok) {
        await fetch(`${BASE}/api/settings`, { signal: AbortSignal.timeout(120_000) }).catch(() => {})
        return true
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (process.env.E2E_OPTIONAL) return false
  throw new Error(`no server at ${BASE} — start one (see the note at the top of harness.mjs)`)
}

/** Snapshot the files the UI can write; returns a function that restores them exactly. */
export async function guardFiles() {
  const saved = await Promise.all(GUARDED.map((f) => readFile(f, 'utf8').catch(() => null)))
  return async () => {
    await Promise.all(
      GUARDED.map((f, i) => (saved[i] === null ? rm(f, { force: true }) : writeFile(f, saved[i]))),
    )
  }
}

/**
 * A message from another server on this machine: a page Laika Orbit frames (Mission Control on its
 * own port) is its own app with its own suite, and its console is not this app's failure.
 */
function otherLocalApp(url) {
  try {
    const u = new URL(url)
    const base = new URL(BASE)
    return ['127.0.0.1', 'localhost'].includes(u.hostname) && u.port !== base.port
  } catch {
    return false
  }
}

/** A fresh browser context (empty localStorage) on the app, past the boot overlay. */
export async function openApp({ width = 1600, height = 950, init = null } = {}) {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width, height } })
  // a script to run in the page before the app's own (e.g. a stand-in for the desktop shell)
  if (init) await context.addInitScript(init)
  const page = await context.newPage()
  // generous: the suite runs beside indexing, other sessions and dev servers
  page.setDefaultTimeout(60_000)
  const errors = []
  const ignored = (t) => /status of 4\d\d/.test(t) || VITE_NOISE.test(t)
  page.on('pageerror', (e) => {
    if (!ignored(e.message)) errors.push(e.message)
  })
  page.on('console', (m) => {
    // 4xx from deliberate validation checks are expected; everything else is a failure
    if (m.type() === 'error' && !ignored(m.text()) && !otherLocalApp(m.location()?.url)) errors.push(m.text())
  })
  let reloads = -1
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) reloads++
  })
  await page.goto(BASE, { waitUntil: 'load' })
  await page.waitForFunction(
    () => {
      const b = document.querySelector('.boot')
      return (!b || b.classList.contains('gone') || getComputedStyle(b).display === 'none') && document.querySelector('.widget')
    },
    null,
    { timeout: 45_000 },
  )
  await page.waitForTimeout(500)
  return {
    browser,
    page,
    errors,
    /** a dev-server hot reload mid-test invalidates what the test saw */
    reloaded: () => reloads > 0,
    close: () => browser.close(),
  }
}

export const text = (page, sel) =>
  page.evaluate((s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? null, sel)

export const widgets = async () => (await fetch(`${BASE}/api/widgets`)).json()

/**
 * Retry a step whose element was swapped out by a background re-render (the agents widget
 * redraws its rail every 5s). Only "detached" errors are retried; anything else fails.
 */
export async function steady(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= tries || !/not attached|detached/i.test(String(e?.message))) throw e
      await new Promise((r) => setTimeout(r, 300))
    }
  }
}
