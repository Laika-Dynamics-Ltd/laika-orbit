#!/usr/bin/env node
/** Serve the demo world on :5290 — the real app, pointed at fictional data. */
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const world = process.env.DEMO_WORLD ?? '/tmp/orbit-studio' // where make-world.mjs built it
spawn('node', ['server.mjs'], {
  cwd: resolve(HERE, '../../packages/app'),
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: process.env.PORT ?? '5290',
    BRAIN_ROOT: world,
    HOME: join(world, 'Users', 'demo'), // Claude sessions, memory, ~/dev and ~/Documents all resolve here
    DEV_ROOTS: join(world, 'Users', 'demo', 'dev'),
    CONTROL_ASSUME_LIVE: '1',
    CALENDAR_ICS_URLS: ' ', // set, so the real feed in .env.local is never loaded into the demo
    GMAIL_FEED: '0', // no Keychain read, no inbox polling
  },
})
