import './pair.css'
import { type PanelHandle, registerPanel } from './panels.ts'

/**
 * Pair a phone: the QR that puts this Mac's agent host in the Orbit Anywhere app, and the switch
 * that decides whether there is anything to pair with.
 *
 * The panel is deliberately blunt about what a scan hands over, because it hands over the fleet:
 * the code carries this launch's token, and anyone who scans it can drive the chats on this Mac
 * until the host restarts. The code is only drawn on a press, never on the poll, and it is put
 * away again on the next press or when the panel closes.
 */
type Pair = {
  name: string
  host: string | null
  running: boolean
  lan: boolean
  port: number | null
}

const ICON =
  '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.8" y="2.8" width="5.4" height="5.4" rx="1.2"/><rect x="11.8" y="2.8" width="5.4" height="5.4" rx="1.2"/><rect x="2.8" y="11.8" width="5.4" height="5.4" rx="1.2"/><path d="M11.8 11.8h2.2v2.2h-2.2zM15.4 15.4h1.8v1.8h-1.8z"/></svg>'

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`)
let panel: PanelHandle | null = null

async function ask(path: string, init?: RequestInit) {
  const r = await fetch(path, init)
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error ?? `pairing answered ${r.status}`)
  return body
}

function mountPair(host: HTMLElement) {
  host.classList.add('pr')
  host.innerHTML =
    '<div class="pr-state"></div><div class="pr-code"></div><div class="pr-act"></div>'
  const stateEl = host.querySelector('.pr-state') as HTMLDivElement
  const codeEl = host.querySelector('.pr-code') as HTMLDivElement
  const actEl = host.querySelector('.pr-act') as HTMLDivElement

  let at: Pair | null = null
  let showing = false
  let busy = false
  let trouble = ''

  async function refresh() {
    try {
      at = await ask('/api/pair')
      trouble = ''
    } catch (e) {
      at = null
      trouble = (e as Error).message
    }
    render()
  }

  function render() {
    if (!at) {
      stateEl.innerHTML = `<p class="pr-off">${esc(trouble || 'Orbit cannot see its agent host.')}</p>`
      codeEl.innerHTML = ''
      actEl.innerHTML = ''
      return
    }
    const where = at.lan
      ? `${at.host ?? 'this network'}${at.port ? `:${at.port}` : ''}`
      : 'this Mac only'
    stateEl.innerHTML = `
      <p class="pr-line ${at.lan ? 'on' : ''}"><i></i>${at.lan ? `Answering the local network on <b>${esc(where)}</b>` : 'Answering this Mac only'}</p>
      <p class="pr-sub">${
        at.lan
          ? 'A phone on this network can drive the fleet here — list chats, and turn away mode, autopilot and halt on and off — if it holds this launch&#39;s token.'
          : 'The agent host is on loopback, so nothing on the network can reach it and there is nothing to pair with yet.'
      }</p>
      ${trouble ? `<p class="pr-bad">${esc(trouble)}</p>` : ''}`

    codeEl.innerHTML = showing
      ? `<div class="pr-qr"></div>
         <p class="pr-warn"><b>This code is a key to this Mac.</b> It carries this launch&#39;s token: anyone who scans it can drive the fleet until the agent host restarts, and restarting it is what takes the key back. Show it to the phone you mean to pair, and to nothing else — a photograph of it works as well as the original.</p>
         <p class="pr-sub">Scan it in Orbit Anywhere, then confirm the machine name on the phone: it will ask before it saves the pairing.</p>`
      : ''

    const btn = (act: string, label: string, kind = '') =>
      `<button class="pr-btn ${kind}" type="button" data-act="${act}"${busy ? ' disabled' : ''}>${label}</button>`
    actEl.innerHTML = !at.running
      ? ''
      : at.lan
        ? `${btn('code', showing ? 'Hide the code' : 'Show the pairing code', 'go')}${btn('off', 'Stop answering the network')}`
        : btn('on', 'Answer the local network', 'go')
  }

  async function draw() {
    const { svg } = await ask('/api/pair/code', { method: 'POST' })
    const box = host.querySelector('.pr-qr')
    if (box) box.innerHTML = svg
  }

  host.addEventListener('click', async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
    if (!act || busy) return
    busy = true
    render()
    try {
      if (act === 'code') {
        showing = !showing
        render()
        if (showing) await draw()
      } else {
        await ask('/api/pair/lan', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ on: act === 'on' }),
        })
        showing = false
        // the host answers before it moves the socket, so give it that moment
        await new Promise((ok) => setTimeout(ok, 350))
      }
      trouble = ''
    } catch (err) {
      trouble = (err as Error).message
      showing = false
    }
    busy = false
    await refresh()
  })

  refresh()
  return {
    setVisible(on: boolean) {
      if (on) return void refresh()
      // a code left on screen behind a closed panel is a key left on a desk
      showing = false
      render()
    },
  }
}

let live: ReturnType<typeof mountPair> | null = null

panel = registerPanel({
  id: 'pair',
  title: 'Pair a phone',
  group: 'fleet',
  icon: ICON,
  width: { min: 320, default: 400, snaps: [360, 400, 520] },
  terms: 'pair phone ios iphone qr code scan orbit anywhere remote lan token agent host',
  hint: 'put this Mac in the Orbit Anywhere app',
  mount: (host) => {
    live = mountPair(host)
    return () => {
      live = null
    }
  },
  onVisible: (on) => live?.setVisible(on),
})

export const openPair = () => panel?.open()
