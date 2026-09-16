// dictation.mjs — hold F5 to dictate into the Claude composer.
//
// One module, two pages: the review tree's general chat (/pr/<id>, home.mjs's
// openGeneralChat) and the planning page's ticket chat (/plan/<KEY>,
// plan.mjs's openPlanChat). Both render the same composer
// (data-testid=claude-chat-compose, ClaudeChat.mjs), which is why the text can
// be inserted straight into the focused field instead of being plumbed back
// through two different callback chains.
//
// The contract, decided by the reviewer:
//   - PUSH-TO-TALK. Pressing F5 opens the chat and starts recording; holding it
//     keeps recording; releasing it stops and transcribes. Not a toggle.
//   - The text lands in the composer and stops there. Nothing is ever sent on
//     the reviewer's behalf — they press Enter themselves.
//   - STRICTLY LOCAL. The audio goes to POST /api/transcribe, which runs
//     whisper.cpp on this machine (whisper.go). Chrome's own
//     webkitSpeechRecognition would have been far less code and is ruled out
//     precisely because it uploads the audio to Google.
//
// Why F5 and why it can fail to arrive at all: on macOS F5 is the system
// Dictation key unless "Use F1, F2, etc. keys as standard function keys" is on.
// With that setting off, the OS eats the key and this module never sees a
// thing — the same wall the Fn/globe key hits permanently. That setting is a
// prerequisite the reviewer sets once; there is no code that can work around
// it. See .claude/docs/dictation.md.

import { reactive, html } from './vendor/arrow.js'
import { t } from './i18n.mjs'

// MIN_MS — anything shorter than this is a key brushed by accident, not a
// sentence. Transcribing it would paste a stray word (or whisper's own
// hallucination on near-silence) into the composer, so it is dropped with a
// word instead.
const MIN_MS = 300

// MAX_MS — the hard stop, matched to whisperMaxAudioBytes on the server side.
// Also the backstop for the case every listener below somehow misses the key
// going up.
const MAX_MS = 120000

// SAMPLE_RATE must match whisperSampleRate (whisper.go). Asking the
// AudioContext for it directly means the browser resamples the microphone for
// us, in native code, instead of this module hand-rolling a downsampler.
const SAMPLE_RATE = 16000

// The AudioWorklet processor, inlined as a Blob URL rather than shipped as its
// own file: it is nine lines, and a separate .js would be the only file in src/
// that is neither a module nor vendored. It forwards raw frames; every decision
// about them is made on the main thread.
const WORKLET_SRC = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length) this.port.postMessage(new Float32Array(ch))
    return true
  }
}
registerProcessor('pcm-tap', PcmTap)
`

// state — 'idle' | 'recording' | 'transcribing'. `note` carries the one-line
// reason for a refusal/failure; `level` is the live microphone level (0..1)
// behind the meter bars.
const d = reactive({ state: 'idle', seconds: 0, level: 0, note: '' })

// Non-reactive capture bookkeeping. Deliberately plain module variables: none
// of it is rendered, and making it reactive would churn the effect queue on
// every audio frame.
let chunks = []
let stream = null
let ctx = null
let node = null
let source = null
let startedAt = 0
let tickTimer = null
let maxTimer = null
let workletURL = null
let openChatFn = null
let armed = false
let noteTimer = null

// setNote shows a one-line reason and clears it again after a few seconds — a
// refusal ("te kort") is worth saying once, but the pill must not sit there
// forever afterwards, since it is otherwise invisible to a reviewer who never
// dictates.
function setNote(text) {
  d.note = text
  clearTimeout(noteTimer)
  noteTimer = setTimeout(() => {
    if (d.state === 'idle') d.note = ''
  }, 6000)
}

export function isDictating() {
  return d.state !== 'idle'
}

// initDictation wires the page-independent half: which function opens that
// page's chat, plus every listener that ENDS a recording.
//
// The keyup/blur pair mirrors an existing precedent in this codebase — the held
// c/v column resize in home.mjs, whose own comment says it best: a window blur
// is "a safety net for the case the keyup itself never arrives (e.g. Alt+Tab
// away while still holding the key)". A microphone left open because a keyup
// went missing is the same bug with a worse consequence, so it gets the same
// treatment plus a visibility listener and a hard timer.
export function initDictation({ openChat }) {
  if (armed) return
  armed = true
  openChatFn = openChat
  window.addEventListener('keyup', (e) => {
    if (e.key === 'F5') stopDictation()
  })
  window.addEventListener('blur', () => stopDictation())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopDictation()
  })
}

// handleDictationKeydown is called from each page's own global onKeydown.
// Returns true when it consumed the key, so the caller can return early.
//
// It is placed AFTER the two blocking dialogs (auth problem, failed tasks) and
// BEFORE every overlay guard: a real modal still owns the keyboard, but an
// already-open chat must not block dictating a second paragraph into it.
export function handleDictationKeydown(e) {
  if (e.key !== 'F5' || e.metaKey || e.ctrlKey || e.altKey) return false
  e.preventDefault()
  // Auto-repeat: macOS keeps firing keydown for as long as the key is held,
  // which is the whole point of push-to-talk. Without this guard the recording
  // would restart dozens of times per second.
  if (e.repeat) return true
  // A non-repeat keydown while already recording means the keyup was lost
  // (a system dialog stole it, say). Treat this press as the release it must
  // have been, so one more tap always gets the reviewer unstuck.
  if (d.state === 'recording') {
    stopDictation()
    return true
  }
  if (d.state === 'transcribing') return true
  startDictation()
  return true
}

async function startDictation() {
  d.note = ''
  if (openChatFn) openChatFn()
  d.state = 'recording'
  d.seconds = 0
  d.level = 0
  chunks = []
  startedAt = Date.now()
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    d.state = 'idle'
    setNote(t('Geen toegang tot de microfoon'))
    return
  }
  // The reviewer may have let go while the permission prompt was up.
  if (d.state !== 'recording') {
    releaseStream()
    return
  }
  try {
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
    workletURL = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }))
    await ctx.audioWorklet.addModule(workletURL)
    if (d.state !== 'recording') {
      await teardownAudio()
      return
    }
    source = ctx.createMediaStreamSource(stream)
    node = new AudioWorkletNode(ctx, 'pcm-tap')
    node.port.onmessage = (ev) => onFrame(ev.data)
    source.connect(node)
    // Not connected to ctx.destination on purpose: routing the microphone to
    // the speakers would give the reviewer a live echo of their own voice.
  } catch (err) {
    await teardownAudio()
    d.state = 'idle'
    setNote(t('Opnemen lukt niet: ') + (err && err.message ? err.message : String(err)))
    return
  }
  tickTimer = setInterval(() => {
    d.seconds = Math.floor((Date.now() - startedAt) / 1000)
  }, 250)
  maxTimer = setTimeout(() => {
    setNote(t('Maximale opnameduur bereikt'))
    stopDictation()
  }, MAX_MS)
}

// onFrame turns one Float32 frame into the 16-bit samples the server expects
// and keeps the meter moving. Clamping before the 0x7fff scale matters: a
// sample slightly outside [-1, 1] would otherwise wrap around into loud noise.
function onFrame(frame) {
  if (d.state !== 'recording') return
  const out = new Int16Array(frame.length)
  let peak = 0
  for (let i = 0; i < frame.length; i++) {
    const s = Math.max(-1, Math.min(1, frame[i]))
    if (s > peak) peak = s
    else if (-s > peak) peak = -s
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  chunks.push(out)
  // Smoothed, so the bars fall back gently between syllables instead of
  // strobing on every frame.
  d.level = Math.max(peak, d.level * 0.8)
}

// stopDictation ends a recording from whichever of the four paths noticed it
// first (keyup, blur, hidden tab, the MAX_MS timer, or a recovery keydown). It
// is deliberately safe to call at any moment, including when nothing is
// running.
async function stopDictation() {
  if (d.state !== 'recording') return
  const heldMs = Date.now() - startedAt
  clearInterval(tickTimer)
  clearTimeout(maxTimer)
  tickTimer = null
  maxTimer = null
  await teardownAudio()
  d.level = 0
  const pcm = joinChunks(chunks)
  chunks = []
  if (heldMs < MIN_MS || pcm.byteLength === 0) {
    d.state = 'idle'
    if (!d.note) setNote(t('Te kort — houd F5 ingedrukt terwijl je praat'))
    return
  }
  d.state = 'transcribing'
  try {
    // One request at the end rather than a stream during the recording: Chrome
    // only allows a streaming request body over HTTP/2, and this server is
    // plain HTTP/1.1 on localhost, so a ReadableStream body fails outright.
    // Two minutes of 16-bit 16 kHz mono is under 4 MB, so buffering it costs
    // nothing worth engineering around. See .claude/docs/dictation.md.
    const res = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: pcm,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) {
      d.state = 'idle'
      setNote(
        data.setup
          ? t('Spraak naar tekst is nog niet ingesteld — zie Instellingen')
          : t('Uitschrijven mislukt: ') + (data.error || res.status),
      )
      return
    }
    d.state = 'idle'
    if (data.text) insertIntoComposer(data.text)
    else setNote(t('Niets verstaan'))
  } catch (err) {
    d.state = 'idle'
    setNote(t('Uitschrijven mislukt: ') + (err && err.message ? err.message : String(err)))
  }
}

function joinChunks(list) {
  let total = 0
  for (const c of list) total += c.length
  const out = new Int16Array(total)
  let at = 0
  for (const c of list) {
    out.set(c, at)
    at += c.length
  }
  return out.buffer
}

async function teardownAudio() {
  if (node) {
    node.port.onmessage = null
    try {
      node.disconnect()
    } catch {}
  }
  if (source) {
    try {
      source.disconnect()
    } catch {}
  }
  releaseStream()
  if (ctx) {
    try {
      await ctx.close()
    } catch {}
  }
  if (workletURL) URL.revokeObjectURL(workletURL)
  node = null
  source = null
  ctx = null
  workletURL = null
}

// releaseStream stops the microphone tracks, which is what actually turns off
// the browser's recording indicator. Separate from teardownAudio so the
// "reviewer released the key while the permission prompt was still up" path can
// call it without an AudioContext ever having existed.
function releaseStream() {
  if (!stream) return
  for (const track of stream.getTracks()) track.stop()
  stream = null
}

// insertIntoComposer writes the transcript into the chat's textarea at the
// caret and fires an `input` event, so ClaudeChat.mjs's own @input handler
// (draft storage) and the auto-grow both run exactly as if it had been typed.
function insertIntoComposer(text) {
  const el = document.querySelector('[data-testid=claude-chat-compose]')
  if (!el) {
    setNote(t('Geen invoerveld gevonden voor de tekst'))
    return
  }
  const before = el.value.slice(0, el.selectionStart)
  const after = el.value.slice(el.selectionEnd)
  // A space between two dictated fragments, but never a leading one in an
  // empty field.
  const sep = before && !/\s$/.test(before) ? ' ' : ''
  el.value = before + sep + text + after
  const caret = (before + sep + text).length
  el.setSelectionRange(caret, caret)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.focus()
}

// ---------------------------------------------------------------------- view

// LEVEL_BARS — the meter is five discrete bars rather than a continuous width,
// so "is it hearing me" reads at a glance without depending on colour at all
// (see the colourblind rule in .claude/rules/conventions.md). The WORD next to
// it carries the state; the bars only confirm the microphone is live.
const LEVEL_BARS = 5

function meterBars() {
  const lit = Math.min(LEVEL_BARS, Math.round(d.level * LEVEL_BARS * 1.6))
  const bars = []
  for (let i = 0; i < LEVEL_BARS; i++) {
    bars.push(
      html`<span
        class="${'inline-block w-[3px] rounded-sm ' +
        (i < lit ? 'h-3 bg-slate-700 dark:bg-zinc-200' : 'h-1.5 bg-slate-300 dark:bg-zinc-700')}"
      ></span>`.key('bar' + i),
    )
  }
  return bars
}

// dictationStatusPill — the one visible sign that the microphone is on, shown
// in the composer row (ClaudeChat.mjs). Empty while idle and silent, so a
// reviewer who never dictates never sees it.
export function dictationStatusPill() {
  return html`<div class="contents">
    ${() =>
      d.state === 'idle' && !d.note
        ? ''
        : html`<div
            data-testid="dictation-status"
            aria-live="polite"
            class="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300"
          >
            ${() =>
              d.state === 'recording'
                ? html`<span class="flex items-center gap-2">
                    <span
                      data-testid="dictation-recording-dot"
                      aria-hidden="true"
                      class="relative flex h-2.5 w-2.5 shrink-0"
                    >
                      <span
                        class="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75"
                      ></span>
                      <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500"></span>
                    </span>
                    <span class="font-semibold">${t('Opnemen')}</span>
                    <span class="flex items-end gap-[2px]">${() => meterBars()}</span>
                    <span>${() => d.seconds + 's'}</span>
                    <span class="text-slate-400 dark:text-zinc-500">${t('laat F5 los om te stoppen')}</span>
                  </span>`.key('rec')
                : d.state === 'transcribing'
                  ? html`<span class="flex items-center gap-2">
                      <span
                        data-testid="dictation-transcribing-spinner"
                        aria-hidden="true"
                        class="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600 dark:border-zinc-700 dark:border-t-zinc-200"
                      ></span>
                      <span class="font-semibold">${t('Uitschrijven…')}</span>
                    </span>`.key('busy')
                  : html`<span data-testid="dictation-note">${() => d.note}</span>`.key('note')}
          </div>`.key('pill')}
  </div>`
}
