/**
 * The opt-in ask: a quiet card, shown once, that lets someone turn anonymous usage reporting on.
 *
 * WHY IT IS ITS OWN MODULE AND MOUNTS ITSELF: this is the only thing that makes the /pulse page's
 * telemetry half legitimate, and it has to ship in the same build as the client that reports.
 * Keeping it self-contained means it can be read, audited or deleted in one piece, and adding it
 * to the app is one import rather than a spread of edits.
 *
 * It appears only when reporting is actually possible (the build has an endpoint) and the user
 * has never answered. Declining is as cheap as accepting: no identifier is created either way
 * until the answer is yes, and the card never comes back.
 */
import './pulse-consent.css'

const KEY = 'orbit:pulse-asked'

export async function askConsent() {
  // asked and answered on this machine already? the server is the source of truth, but the flag
  // keeps a dismissed card from flashing up on every reload before the fetch lands
  if (localStorage.getItem(KEY) === '1') return
  let state: { state: string; reporting: boolean }
  try {
    const res = await fetch('/api/pulse/consent')
    if (!res.ok) return
    state = await res.json()
  } catch {
    return
  }
  // nothing to ask if this build cannot report at all, or the answer is already in
  if (!state.reporting || state.state !== 'unset') {
    if (state.state !== 'unset') localStorage.setItem(KEY, '1')
    return
  }

  const el = document.createElement('div')
  el.className = 'pc-card'
  el.innerHTML = `
    <h3>Help shape Laika Orbit?</h3>
    <p>
      Send <b>anonymous</b> counts of coarse actions — that recall ran, that a chat opened — once
      a day. Never a file name, path, query, prompt, URL or IP address.
    </p>
    <p class="pc-fine">Off unless you say yes. Turning it off later destroys the id and the queue.</p>
    <div class="pc-row">
      <button class="pc-no" type="button">No thanks</button>
      <button class="pc-yes" type="button">Turn it on</button>
    </div>
    <a class="pc-more" href="https://github.com/Laika-Dynamics-Ltd/laika-orbit/blob/main/PRIVACY.md" target="_blank" rel="noreferrer">What exactly is sent?</a>`
  document.body.appendChild(el)
  requestAnimationFrame(() => el.classList.add('in'))

  const answer = async (on: boolean) => {
    el.classList.remove('in')
    localStorage.setItem(KEY, '1')
    setTimeout(() => el.remove(), 250)
    try {
      await fetch('/api/pulse/consent', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ on }),
      })
    } catch {
      // a failed answer is a 'no': the client reports nothing until consent.json says 'on'
    }
  }
  el.querySelector('.pc-yes')?.addEventListener('click', () => answer(true))
  el.querySelector('.pc-no')?.addEventListener('click', () => answer(false))
}

// asked a beat after load, so it never competes with the first paint or the index build
if (typeof document !== 'undefined') setTimeout(() => askConsent().catch(() => {}), 4000)
