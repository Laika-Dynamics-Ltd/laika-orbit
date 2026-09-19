/**
 * "New version ready · Restart": a quiet pill in the header once the stable app's next version is
 * built (stable-rebuild.mjs). Nothing restarts until you click it.
 *
 * It asks the host once when the page loads, when you come back to the window, and every few
 * minutes while you are using it; hidden or away, it asks nothing (activity.ts).
 */
import { every, onLevel } from './activity.ts'

type Rebuild = {
  state: 'off' | 'idle' | 'waiting' | 'building' | 'ready' | 'failed' | 'restarting'
  sha: string | null
  subject: string | null
  error?: string | null
}

const API = '/api/control/agent/stable'

export function initStableUpdate() {
  // beside the brand: the right end of the header runs off narrow windows
  const brand = document.querySelector('body > header .brand')
  if (!brand) return
  const pill = document.createElement('button')
  pill.type = 'button'
  pill.id = 'upd'
  pill.className = 'upd'
  pill.hidden = true
  brand.after(pill)
  let last = ''

  const paint = (r: Rebuild) => {
    const key = `${r.state}:${r.sha}`
    if (key === last) return
    last = key
    pill.hidden = r.state !== 'ready' && r.state !== 'restarting'
    pill.disabled = r.state === 'restarting'
    pill.innerHTML =
      r.state === 'restarting' ? '<i></i>Restarting…' : `<i></i>New version ready<b>Restart</b>`
    pill.title = r.sha
      ? `${r.sha.slice(0, 7)} ${r.subject ?? ''}\nRestarts Laika Orbit into it. Your chats carry on.`
      : ''
  }
  const look = () =>
    fetch(API)
      .then((r) => (r.ok ? r.json() : null))
      .then((r: Rebuild | null) => r && paint(r))
      .catch(() => {})

  pill.addEventListener('click', () => {
    pill.disabled = true
    fetch(`${API}/restart`, {
      method: 'POST',
      headers: { 'x-control': '1', 'content-type': 'application/json' },
      body: '{}',
    })
      .then((r) => r.json())
      .then((r: Rebuild & { error?: string }) => {
        if (r.error) {
          pill.disabled = false
          pill.title = r.error
        } else paint(r)
      })
      .catch(() => {
        pill.disabled = false
      })
  })

  look()
  every(5 * 60_000, look, { away: 'stop' })
  onLevel((l, was) => {
    if (l === 'live' && (was === 'away' || was === 'hidden')) look()
  })
}
