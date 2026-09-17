/**
 * The names and colours of the profiles in the user's Google Chrome, read from Chrome's
 * `Local State` file. Only the names are used, as one-click suggestions when adding a
 * profile here. Nothing else is read: cookies and passwords stay Chrome's, so every
 * profile is signed in afresh in the shell, once.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LOCAL_STATE = {
  darwin: join(homedir(), 'Library/Application Support/Google/Chrome/Local State'),
  linux: join(homedir(), '.config/google-chrome/Local State'),
  win32: join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/User Data/Local State'),
}

/** Chrome stores its highlight colour as a signed 32-bit ARGB int. */
const hex = (n) =>
  typeof n === 'number' ? `#${((n >>> 0) & 0xffffff).toString(16).padStart(6, '0')}` : null

export async function chromeProfiles() {
  const file = LOCAL_STATE[process.platform]
  if (!file) return []
  let raw
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return []
  }
  const cache = raw?.profile?.info_cache ?? {}
  return Object.entries(cache)
    .map(([dir, p]) => ({
      dir,
      // the account email when signed in, else whatever Chrome calls the profile
      name: p.user_name || p.name || dir,
      person: p.gaia_name || null,
      colour: hex(p.profile_highlight_color),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
