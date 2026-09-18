#!/usr/bin/env node
/**
 * `pnpm shell` — opens Laika Orbit in its own Chromium window.
 *
 * A plain launcher rather than `electron .`, because a terminal that is itself inside an
 * Electron app (VS Code, Cursor, the Claude desktop app) exports ELECTRON_RUN_AS_NODE=1,
 * which turns the Electron binary into a bare Node and the app never opens.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const bin = createRequire(import.meta.url)('electron')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(bin, [HERE, ...process.argv.slice(2)], { stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code ?? 0))
