/**
 * Developer features: the tools that build Orbit rather than use it (Mission Control, Showreel
 * Studio). Off by default. Off, they are not on the rail, not in the palette and not on a key;
 * Settings → App → Developer turns them on. What is gated carries `data-dev` (the rail's CSS
 * hides it) or asks devFeatures() (the palette, the keys).
 */
const KEY = 'laika.devFeatures.v1'

export const devFeatures = () => {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function setDevFeatures(on: boolean) {
  try {
    if (on) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {}
  document.body.classList.toggle('dev-features', on)
  dispatchEvent(new CustomEvent('laika:dev-features', { detail: on }))
}

if (typeof document !== 'undefined') document.body?.classList.toggle('dev-features', devFeatures())
