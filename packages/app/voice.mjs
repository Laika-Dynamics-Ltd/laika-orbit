/**
 * Voice prompting: the composer records a clip and posts it here; it is turned into 16 kHz wav
 * with ffmpeg and transcribed on this machine by whisper.cpp (`whisper-cli`), so no audio leaves
 * the Mac. The model lives in ~/.cache/laika-whisper (or LAIKA_WHISPER_MODEL).
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const MODEL_DIR = join(homedir(), '.cache/laika-whisper')
const MAX_BYTES = 25 * 1024 * 1024
// names whisper tends to mangle, given as a lead-in so it spells them this way
const HINT = 'Laika, Laika Orbit, Claude, Opus, Sonnet, repo, commit, TypeScript, Electron, Vite, offload, gauntlet, showreel.'

function bin(name) {
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) if (existsSync(join(dir, name))) return join(dir, name)
  return null
}

function model() {
  if (process.env.LAIKA_WHISPER_MODEL) return existsSync(process.env.LAIKA_WHISPER_MODEL) ? process.env.LAIKA_WHISPER_MODEL : null
  if (!existsSync(MODEL_DIR)) return null
  // best first
  const order = ['large-v3-turbo', 'small.en', 'small', 'base.en', 'base']
  const files = readdirSync(MODEL_DIR).filter((f) => f.startsWith('ggml-') && f.endsWith('.bin'))
  files.sort((a, b) => order.findIndex((o) => a.includes(o)) - order.findIndex((o) => b.includes(o)))
  return files.length ? join(MODEL_DIR, files[0]) : null
}

export function voiceStatus() {
  const whisper = bin('whisper-cli')
  const ffmpeg = bin('ffmpeg')
  const m = model()
  const missing = [!whisper && 'whisper-cli (brew install whisper-cpp)', !ffmpeg && 'ffmpeg (brew install ffmpeg)', !m && `a model in ${MODEL_DIR}`].filter(Boolean)
  return { ready: !missing.length, missing, model: m }
}

/** Plain text of a whisper transcript: no timestamps, no [BLANK_AUDIO]-style tags. */
export function cleanTranscript(s) {
  return s
    .replace(/\[[^\]]*\]|\([^)]*(music|silence|blank|inaudible)[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > MAX_BYTES) throw Object.assign(new Error('clip too long'), { status: 413 })
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

let warmed = false

/** Text of a recorded clip; with no clip, a second of silence (to load the model). */
async function transcribe(audio) {
  const st = voiceStatus()
  if (!st.ready) throw Object.assign(new Error(`Voice needs ${st.missing.join(', ')}`), { status: 503 })
  const dir = await mkdtemp(join(tmpdir(), 'laika-voice-'))
  try {
    const src = join(dir, 'clip.webm')
    const wav = join(dir, 'clip.wav')
    if (audio) await writeFile(src, audio)
    const input = audio ? ['-i', src] : ['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1']
    await run(bin('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', ...input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav])
    await run(bin('whisper-cli'), ['-m', st.model, '-f', wav, '-l', 'en', '-nt', '-np', '--prompt', HINT, '-otxt', '-of', join(dir, 'out')], { timeout: 120_000 })
    return cleanTranscript(await readFile(join(dir, 'out.txt'), 'utf8'))
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** /api/voice/status and /api/voice/transcribe; returns true when it answered. */
export async function handleVoice(url, req, res) {
  if (!url.pathname.startsWith('/api/voice/')) return false
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/api/voice/status') {
    const st = voiceStatus()
    // the first transcription loads the model and compiles its GPU kernels (~25 s); do that
    // now, while nobody is waiting on it
    if (st.ready && !warmed) {
      warmed = true
      transcribe(null).catch(() => {})
    }
    json(200, st)
    return true
  }
  if (url.pathname === '/api/voice/transcribe' && req.method === 'POST') {
    try {
      const t0 = Date.now()
      const text = await transcribe(await readBody(req))
      json(200, { text, ms: Date.now() - t0 })
    } catch (e) {
      json(e.status ?? 500, { error: e.message })
    }
    return true
  }
  json(404, { error: 'not found' })
  return true
}
