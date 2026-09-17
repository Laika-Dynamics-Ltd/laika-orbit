/**
 * The terminal panel under a Claude session: a real login shell in the session's repo,
 * hosted by agent-host.mjs (node-pty) and drawn with xterm.js.
 *
 * One shell per session, created the first time the panel opens and kept after that: closing
 * the panel, reloading the page or restarting the web server reattaches to the same shell and
 * repaints its recent output.
 */
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { onTheme } from './themes.ts'

const API = '/api/control/agent/terms'
const WRITE = { 'x-control': '1', 'content-type': 'application/json' }

export type TerminalPanel = {
  toggle(): void
  open(): void
  close(): void
  isOpen(): boolean
  setAccent(hex: string): void
  dispose(kill?: boolean): void
}

export function createTerminalPanel(
  host: HTMLElement,
  o: {
    cwd: string
    owner: string
    accent?: string
    /** start something other than a shell in the repo (the account sign-in terminal) */
    start?: (cols: number, rows: number) => Promise<Response>
    onExit?: (code: number) => void
    title?: string
  },
): TerminalPanel {
  host.classList.add('ss-term')
  host.hidden = true
  host.innerHTML = `
    <div class="ss-term-grip" title="Drag to resize"></div>
    <div class="ss-term-bar">
      <b>${o.title ?? 'Terminal'}</b><span class="ss-term-cwd">${o.title ? '' : o.cwd.replace(/^\/Users\/[^/]+/, '~')}</span>
      <button type="button" class="ss-x" data-term="restart" title="Start a new shell" hidden>Restart</button>
      <button type="button" class="ss-x" data-term="close" title="Hide terminal (⌃\`)" aria-label="Hide terminal">×</button>
    </div>
    <div class="ss-term-screen"></div>`
  const screen = host.querySelector('.ss-term-screen') as HTMLElement
  const restartBtn = host.querySelector('[data-term="restart"]') as HTMLElement

  let term: Terminal | null = null
  let fit: FitAddon | null = null
  let id: string | null = null
  let es: EventSource | null = null
  let at = 0
  let open = false
  let pending = ''
  let flushing = false
  let resizeTimer: ReturnType<typeof setTimeout> | null = null
  let accent = o.accent ?? '#ff8a4c'
  onTheme(() => {
    if (term) term.options.theme = theme()
  })

  // xterm paints to its own canvas, so it cannot inherit the cascade: the surface colours are
  // read back off the themed element instead. The ANSI palette below stays fixed — those
  // sixteen colours are what programs mean by "red" and are not ours to restyle.
  const token = (name: string, fallback: string) =>
    getComputedStyle(host).getPropertyValue(name).trim() || fallback

  const theme = () => ({
    background: token('--n1', '#07080d'),
    foreground: token('--n33', '#d7dcea'),
    cursor: accent,
    cursorAccent: token('--n1', '#07080d'),
    selectionBackground: token('--n19', '#2a3350'),
    black: '#1c2030',
    red: '#ff6b7a',
    green: '#3ddc97',
    yellow: '#ffc94f',
    blue: '#5b9dff',
    magenta: '#c792ea',
    cyan: '#56d8ff',
    white: '#d7dcea',
    brightBlack: '#5c6680',
    brightRed: '#ff8f9a',
    brightGreen: '#7fe3b5',
    brightYellow: '#ffd98a',
    brightBlue: '#8bb8ff',
    brightMagenta: '#dcb3f5',
    brightCyan: '#8fe6ff',
    brightWhite: '#ffffff',
  })

  // keystrokes are batched so a paste or a held key is one request, not hundreds
  const send = (data: string) => {
    pending += data
    if (flushing) return
    flushing = true
    queueMicrotask(async () => {
      while (pending && id) {
        const chunk = pending
        pending = ''
        await fetch(`${API}/${id}/input`, {
          method: 'POST',
          headers: WRITE,
          body: JSON.stringify({ data: chunk }),
        }).catch(() => {})
      }
      flushing = false
    })
  }

  const resize = () => {
    if (!term || !fit || !open) return
    fit.fit()
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      if (id && term) {
        fetch(`${API}/${id}/resize`, {
          method: 'POST',
          headers: WRITE,
          body: JSON.stringify({ cols: term.cols, rows: term.rows }),
        }).catch(() => {})
      }
    }, 80)
  }

  function listen() {
    es?.close()
    if (!id) return
    const src = new EventSource(`${API}/${id}/events?since=${at}`)
    es = src
    src.onmessage = (m) => {
      const e = JSON.parse(m.data) as { t: string; data?: string; at?: number; code?: number }
      if (e.t === 'data' && e.data) {
        term?.write(e.data)
        at = e.at ?? at
      } else if (e.t === 'exit') {
        term?.write(`\r\n\x1b[90m[shell exited${e.code ? ` with ${e.code}` : ''}]\x1b[0m\r\n`)
        restartBtn.hidden = !!o.start
        o.onExit?.(e.code ?? 0)
      }
    }
    src.onerror = () => {
      // the host may be restarting: reconnect and resume from the last byte seen
      src.close()
      if (es === src) setTimeout(() => es === src && listen(), 1500)
    }
  }

  async function start() {
    term ??= new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: false,
      scrollback: 5000,
      theme: theme(),
    })
    if (!fit) {
      fit = new FitAddon()
      term.loadAddon(fit)
      // links in output open in the browser (the sign-in URL, dev server addresses)
      term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener')))
      term.open(screen)
      term.onData(send)
      new ResizeObserver(resize).observe(screen)
    }
    fit.fit()
    const r = o.start
      ? await o.start(term.cols, term.rows)
      : await fetch(API, {
          method: 'POST',
          headers: WRITE,
          body: JSON.stringify({ cwd: o.cwd, owner: o.owner, cols: term.cols, rows: term.rows }),
        })
    if (!r.ok) {
      term.write(
        `\x1b[31mCould not start a shell: ${(await r.json().catch(() => ({}))).error ?? r.status}\x1b[0m\r\n`,
      )
      return
    }
    const t = (await r.json()) as { id: string }
    if (t.id !== id) {
      id = t.id
      at = 0
      term.reset()
    }
    restartBtn.hidden = true
    listen()
    resize()
  }

  function setOpen(on: boolean) {
    open = on
    host.hidden = !on
    if (on) {
      if (!id) start()
      else resize()
      requestAnimationFrame(() => term?.focus())
    }
  }

  host.addEventListener('click', async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-term]')?.dataset.term
    if (act === 'close') setOpen(false)
    if (act === 'restart' && id) {
      await fetch(`${API}/${id}`, { method: 'DELETE', headers: { 'x-control': '1' } }).catch(
        () => {},
      )
      id = null
      es?.close()
      start()
    }
  })

  // drag the top edge to resize; the height is remembered per browser
  const grip = host.querySelector('.ss-term-grip') as HTMLElement
  try {
    const h = Number(localStorage.getItem('laika.termHeight'))
    if (h > 80) host.style.height = `${h}px`
  } catch {}
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    grip.setPointerCapture(e.pointerId)
    const startY = e.clientY
    const startH = host.getBoundingClientRect().height
    const move = (m: PointerEvent) => {
      const h = Math.max(120, Math.min(innerHeight * 0.75, startH + (startY - m.clientY)))
      host.style.height = `${h}px`
    }
    const up = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      try {
        localStorage.setItem(
          'laika.termHeight',
          String(Math.round(host.getBoundingClientRect().height)),
        )
      } catch {}
      resize()
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
  })

  return {
    toggle: () => setOpen(!open),
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => open,
    setAccent(hex: string) {
      accent = hex
      if (term) term.options.theme = theme()
      host.style.setProperty('--term-accent', hex)
    },
    /** stop listening; with kill, also end the shell (the session itself is ending) */
    dispose(kill = false) {
      es?.close()
      es = null
      if (kill && id)
        fetch(`${API}/${id}`, { method: 'DELETE', headers: { 'x-control': '1' } }).catch(() => {})
      term?.dispose()
    },
  }
}
