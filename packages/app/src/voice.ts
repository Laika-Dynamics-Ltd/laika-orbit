/**
 * Voice prompting for the Claude composer. The mic button (or ⌥Space) starts hands-free
 * listening on whatever input macOS has selected, AirPods included: each thing you say is cut
 * at the pause after it, transcribed on this Mac (/api/voice, whisper.cpp) and added to the
 * prompt. Say "send it" to send, "scratch that" to clear, "stop listening" to stop; the button
 * or ⌥Space again also stops. Listening ends by itself after a few quiet minutes.
 */
import './voice.css'

type Hooks = {
  box: HTMLElement
  input: HTMLTextAreaElement
  /** sends what is in the box */
  submit: () => void
  /** re-measures the box after its text changed */
  sync: () => void
}

const MIC_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5.5" y="1.8" width="5" height="8.2" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3.3 7.6a4.7 4.7 0 0 0 9.4 0M8 12.3v2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`
/** a pause this long after speech ends the utterance */
const PAUSE_MS = 1300
/** speech shorter than this is a cough or a click, not words */
const MIN_SPEECH_MS = 350
/** nothing said for this long turns listening off */
const IDLE_MS = 3 * 60_000
/** one utterance never runs longer than this */
const MAX_UTTER_MS = 90_000

// whisper's usual inventions on breath and room noise
const HALLUCINATIONS = /^(thank you\.?|thanks for watching!?|you|bye\.?|\.+|okay\.?)$/i
const SEND = /[\s,.]*\b(send it|send that|send now)[.!]?$/i
const SCRATCH = /^(scratch that|clear that|delete that)[.!]?$/i
const STOP = /[\s,.]*\b(stop listening|stop recording)[.!]?$/i

const byButton = new WeakMap<HTMLElement, Voice>()
let lastUsed: Voice | null = null

type Voice = { hooks: Hooks; btn: HTMLButtonElement; toggle: () => void; stop: () => void }

/** One sentence into the box, with a space between it and what is already there. */
function append(input: HTMLTextAreaElement, text: string) {
  const v = input.value
  input.value = v && !/\s$/.test(v) ? `${v} ${text}` : `${v}${text}`
  input.selectionStart = input.selectionEnd = input.value.length
}

/** Adds the mic button to a composer's bar, just before its chips. */
export function attachVoice(hooks: Hooks): void {
  const bar = hooks.box.querySelector('.cx-bar') as HTMLElement
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'cx-ic cx-mic'
  btn.title = 'Speak your prompt (⌥Space). Say “send it” to send.'
  btn.setAttribute('aria-label', 'Voice prompt')
  btn.innerHTML = `${MIC_ICON}<i class="cx-mic-lvl"></i>`
  bar.insertBefore(btn, bar.querySelector('.cx-chips'))

  let stream: MediaStream | null = null
  let ctx: AudioContext | null = null
  let rec: MediaRecorder | null = null
  let pending = 0
  let on = false

  const paint = (state: 'idle' | 'listen' | 'hear' | 'work' | 'err', note?: string) => {
    btn.dataset.state = state
    if (note) btn.title = note
    else
      btn.title = on
        ? 'Listening. Say “send it” to send, “stop listening” to stop (⌥Space)'
        : 'Speak your prompt (⌥Space). Say “send it” to send.'
  }

  const transcribe = async (blob: Blob) => {
    pending++
    paint('work')
    try {
      const r = await fetch('/api/voice/transcribe', { method: 'POST', body: blob })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      let text = String(j.text ?? '').trim()
      if (!text || HALLUCINATIONS.test(text)) return
      if (SCRATCH.test(text)) {
        hooks.input.value = ''
        return hooks.sync()
      }
      const stopAfter = STOP.test(text)
      if (stopAfter) text = text.replace(STOP, '')
      const send = SEND.test(text)
      if (send) text = text.replace(SEND, '')
      if (text) append(hooks.input, text)
      hooks.sync()
      if (send) hooks.submit()
      if (stopAfter) stop()
    } catch (e) {
      paint('err', `Voice failed: ${(e as Error).message}`)
      stop()
    } finally {
      pending--
      if (btn.dataset.state === 'work' && !pending) paint(on ? 'listen' : 'idle')
    }
  }

  const stop = () => {
    on = false
    if (rec && rec.state !== 'inactive') rec.stop()
    rec = null
    for (const t of stream?.getTracks() ?? []) t.stop()
    stream = null
    ctx?.close().catch(() => {})
    ctx = null
    btn.classList.remove('on')
    btn.style.removeProperty('--lvl')
    if (!pending && btn.dataset.state !== 'err') paint('idle')
  }

  const start = async () => {
    lastUsed = voice
    for (const b of document.querySelectorAll<HTMLElement>('.cx-mic.on'))
      if (b !== btn) byButton.get(b)?.stop()
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (e) {
      paint('err', `No microphone: ${(e as Error).message}`)
      return
    }
    on = true
    btn.classList.add('on')
    paint('listen')
    hooks.input.focus()
    ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(stream)
    // an audio-thread callback, not requestAnimationFrame: it keeps running while the window
    // is behind others, which is the point of talking through AirPods away from the desk
    const tap = ctx.createScriptProcessor(2048, 1, 1)
    const mute = ctx.createGain()
    mute.gain.value = 0
    source.connect(tap)
    tap.connect(mute)
    mute.connect(ctx.destination)

    // one recorder per utterance, so each clip is a whole webm file of its own
    let clip = { rec: null as MediaRecorder | null, speechMs: 0, lastVoice: 0, began: 0 }
    let lastAny = performance.now()
    let floor = 0.004
    const fresh = () => {
      if (!stream) return
      const chunks: Blob[] = []
      const r = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
      const c = { rec: r, speechMs: 0, lastVoice: 0, began: performance.now() }
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      r.onstop = () => {
        if (c.speechMs >= MIN_SPEECH_MS) transcribe(new Blob(chunks, { type: 'audio/webm' }))
      }
      r.start()
      rec = r
      clip = c
    }
    const cut = (keep: boolean) => {
      if (!keep) clip.speechMs = 0
      clip.rec?.stop()
      fresh()
    }
    fresh()

    let prev = performance.now()
    tap.onaudioprocess = (e) => {
      if (!on || !rec) return
      if (!hooks.box.isConnected) return stop()
      const now = performance.now()
      const dt = now - prev
      prev = now
      const buf = e.inputBuffer.getChannelData(0)
      let sum = 0
      for (const x of buf) sum += x * x
      const rms = Math.sqrt(sum / buf.length)
      // the room's hum sets the bar: follow it down at once, up slowly
      floor = rms < floor ? rms : floor + (rms - floor) * 0.01
      const loud = rms > Math.max(0.012, floor * 3)
      btn.style.setProperty('--lvl', String(Math.min(1, rms * 12)))
      if (loud) {
        clip.speechMs += dt
        clip.lastVoice = now
        lastAny = now
        if (btn.dataset.state === 'listen') paint('hear')
      } else if (btn.dataset.state === 'hear') paint('listen')

      const paused = clip.lastVoice && now - clip.lastVoice > PAUSE_MS
      if ((paused && clip.speechMs >= MIN_SPEECH_MS) || now - clip.began > MAX_UTTER_MS) cut(true)
      // a blip and then quiet, or a long quiet: start the clip again rather than let it grow
      else if (paused || (!clip.lastVoice && now - clip.began > 20_000)) cut(false)
      if (now - lastAny > IDLE_MS) stop()
    }
  }

  const voice: Voice = {
    hooks,
    btn,
    stop,
    toggle: () => (on ? stop() : start()),
  }
  byButton.set(btn, voice)
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    voice.toggle()
  })
  hooks.input.addEventListener('focus', () => {
    lastUsed = voice
  })
  fetch('/api/voice/status')
    .then((r) => r.json())
    .then((s) => {
      if (!s.ready) paint('err', `Voice needs ${s.missing.join(', ')}`)
    })
    .catch(() => {})
}

// ⌥Space toggles the composer you last used, or the one on screen
addEventListener(
  'keydown',
  (e) => {
    if (!(e.altKey && e.code === 'Space') || e.metaKey || e.ctrlKey) return
    const shown = (v: Voice) => v.hooks.box.isConnected && v.hooks.box.offsetParent !== null
    const onScreen = [...document.querySelectorAll<HTMLElement>('.cx-mic')].map((b) =>
      byButton.get(b),
    )
    const v =
      lastUsed && shown(lastUsed) ? lastUsed : onScreen.find((x): x is Voice => !!x && shown(x))
    if (!v) return
    e.preventDefault()
    e.stopPropagation()
    v.toggle()
  },
  true,
)
