import { copyFileSync, renameSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

/**
 * browser.json holds every profile (and so which cookie jar is whose), the tabs and the
 * bookmarks. A file that did not parse used to mean a fresh start that then overwrote it: all of
 * that gone. Now it is written whole or not at all (a temp file renamed into place, one write
 * at a time), each launch keeps the last good one as .bak, and a broken file falls back to that
 * .bak and is kept aside for a look, never overwritten.
 */
export async function readState(file) {
  const backup = `${file}.bak`
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'))
    try {
      copyFileSync(file, backup)
    } catch {}
    return raw
  } catch (e) {
    if (e?.code === 'ENOENT') return null
    console.error('browser.json did not parse; using the backup', e?.message)
    try {
      renameSync(file, `${file}.broken-${Date.now()}`)
    } catch {}
    try {
      return JSON.parse(await readFile(backup, 'utf8'))
    } catch {
      return null
    }
  }
}
