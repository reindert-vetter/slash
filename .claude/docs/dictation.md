# Dictation: hold F5 to speak into the Claude composer

Hold `F5`, talk, let go — the transcript lands in the Claude chat's composer and
stops there. The reviewer presses Enter themselves. Everything runs on this
machine: the audio never leaves it.

Frontend: `src/dictation.mjs`. Backend: `whisper.go` plus the `whisper_model`
Workflow in `workflows.go`. The settings row lives in `auth_status.go`'s
`checkWhisper` and `src/settings.mjs`'s `whisperBlock`.

## Why F5, and the one thing the reviewer must set themselves

The original request was the **Fn/globe key**. That is impossible, not merely
awkward: on macOS Fn is a hardware-level modifier that never reaches the browser
as a `keydown` at all — unlike Shift/Ctrl/Alt/Cmd it produces no key event, only
an OS-level flag, and `getModifierState('Fn')` is always false in Blink. The OS
also claims the key for itself (emoji picker / dictation / input source). No
amount of JavaScript can see it. Karabiner and friends cannot expose it as a
plain hotkey either; they can only remap it to something else.

`F5` was the reviewer's choice instead. It carries its own prerequisite:
**System Settings → Keyboard → "Use F1, F2, etc. keys as standard function
keys" must be ON.** With it off, macOS treats F5 as the system Dictation key and
eats it, so the app never sees a thing — the same wall, just avoidable. There is
no code-side workaround; this is a one-time setting.

A quick way to check what the browser actually receives: a page with a
`keydown`/`keyup` logger. If pressing F5 logs nothing, that setting is off.

## Push-to-talk, and the four ways a recording ends

Press = record, release = done. Not a toggle — the reviewer asked for this
explicitly after first considering a toggle.

The whole risk of push-to-talk is a **keyup that never arrives**, which would
leave the microphone open indefinitely. `src/dictation.mjs` therefore ends a
recording on any of:

1. `keyup` on F5 — the ordinary path.
2. `window` `blur` — ⌘-Tab, Spotlight, a system dialog. The audio recorded so
   far is kept and transcribed; it was genuinely spoken.
3. `visibilitychange` to `hidden` — tab switch, minimise.
4. A hard `MAX_MS` (two minutes) timer, matched to the server's own body cap.

Plus a fifth, recovery path: a **non-repeat `keydown` while already recording**
means a keyup went missing, so that press is treated as the release. One more
tap always gets the reviewer unstuck.

This is the same shape as the existing held-key precedent in this codebase — the
`c`/`v` column resize in `home.mjs`, whose own comment already says a window
blur is the safety net for "the case the keyup itself never arrives (e.g.
Alt+Tab away while still holding the key)".

**`e.repeat` must be ignored.** macOS keeps firing `keydown` for as long as the
key is held; without that guard the recording restarts dozens of times per
second and every earlier fragment is thrown away. `tests/dictation.spec.mjs`
pins this by dispatching twenty synthetic `repeat: true` keydowns and asserting
`getUserMedia` was called exactly once.

**A tap shorter than `MIN_MS` (300 ms) is discarded** with the word "Te kort"
rather than transcribed: whisper happily hallucinates a word out of 40 ms of
near-silence, and pasting that into the composer is worse than pasting nothing.

## Where the keydown branch sits, and why that position is load-bearing

In **both** pages' global `onKeydown`, the F5 branch sits **after** the two
blocking dialogs (`isAuthProblemOpen`, `isFailedTasksOpen`) and **before** every
overlay guard.

That is not cosmetic. Those overlay guards `return` early — `home.mjs`'s
`isGeneralChatOverlayOpen()` at roughly line 14160, `plan.mjs`'s
`state.chatOpen` as its very first branch. A branch placed further down (next to
the `/` menu branch, say) would never run once the chat it opens is actually
open, making it impossible to dictate a **second** paragraph into the same
chat. The two blocking dialogs deliberately still win: while one of those owns
the keyboard, F5 does nothing. Verified live — with the failed-tasks dialog up,
F5 is correctly swallowed; after Escape it works.

## The audio path

`getUserMedia` → `AudioContext({ sampleRate: 16000 })` → an `AudioWorklet` that
forwards raw frames → Int16 samples buffered in memory → one `POST
/api/transcribe` on release.

- **16 kHz is asked of the AudioContext directly**, so the browser resamples the
  microphone in native code instead of this module hand-rolling a downsampler.
- **The worklet is a Blob URL**, not its own file: it is nine lines, and a
  separate `.js` would be the only file in `src/` that is neither a module nor
  vendored.
- **The microphone is never connected to `ctx.destination`** — that would give
  the reviewer a live echo of their own voice.
- **The WAV header is written server-side** (`writeWAVHeader`, `whisper.go`).
  The browser sends bare samples because a RIFF header's two length fields must
  hold the final length, which is unknown while the reviewer is still speaking.

### The upload is NOT streamed while recording, and that was a real attempt

The plan was to stream the PCM up during the recording so only the transcription
time remained after release. It does not work here: **Chrome only allows a
streaming request body over HTTP/2**, and this server is plain HTTP/1.1 on
localhost, so a `ReadableStream` body fails outright. Two minutes of 16-bit
16 kHz mono is under 4 MB, so buffering it costs nothing worth engineering
around. Don't reintroduce a streaming body without first changing the transport.

### There is NO live/incremental transcription, deliberately

Transcribing while the key is held was explored and rejected on three grounds:

1. The Homebrew formula installs only **`whisper-cli`**, a one-shot process that
   reloads the model on every invocation — per-chunk calls pay that cost over
   and over.
2. Whisper needs context. On two-second fragments accuracy and word boundaries
   collapse, and concatenating chunk transcripts produces duplicated and
   truncated words. Doing it properly needs a sliding window that re-transcribes
   earlier audio and rewrites its own output, which would make the text in the
   composer flicker and correct itself while the reviewer speaks.
3. `whisper-stream`, which does stream, reads the **system microphone directly
   from the server** — microphone contention with the browser, plus a separate
   macOS permission for the Go process.

If the wait after release ever becomes annoying, the known next step is
**`whisper-server`**: a long-running process that loads the model once. That is
a contained change to `transcribePCM`; chunked transcription is not.

## Claude cannot do this

Neither the `claude` CLI nor the Anthropic API accepts audio as input — text,
images and PDFs only. There is no route that turns speech into text *via*
Claude, so a local transcriber is not a preference here, it is the only option.
Chrome's own `webkitSpeechRecognition` would have been far less code and is
ruled out for exactly one reason: it ships the audio to Google, and the
requirement is strictly local.

## Setup: two pieces, acquired two different ways

| Piece | How it arrives | Why |
| --- | --- | --- |
| `whisper-cli` | the reviewer runs `brew install whisper.cpp` | running a package manager on someone's behalf is a different order of thing than writing one file; shown as the check's `FixCommand`, exactly like `gh auth login` |
| `ggml-large-v3-turbo.bin` (~1.6 GB) | the app downloads it, from a button in Settings | one file, one known URL — worth automating |

The model is `large-v3-turbo` and the language is fixed to **Dutch** (`-l nl`),
both the reviewer's choice: auto-detection has very little to go on in a short
dictated sentence, and guessing wrong garbles the whole transcript.

`data/models/` is gitignored. `data/` is ignored file by file in this repo, so
without that entry a 1.6 GB blob would show up as untracked.

## The settings row, and why it is never `error`

`checkWhisper` (`auth_status.go`) is an ordinary `AuthCheck`, so it renders
itself in the credentials list next to gh, acli and the Jira token with no
frontend work at all. It reports three states — binary missing, model missing,
ready — each with its own `Detail`, because "niet ingesteld" without saying
which half is missing would be useless.

**It never reports `authStateError`.** `brokenChecks()` (`src/authStatus.mjs`)
filters on exactly `"error"` to decide whether to throw up the global,
keyboard-owning dialog. Dictation is optional: a reviewer who never installed
whisper must not be met by a modal on every page load. `authStateMissing`
("Niet ingesteld") is the right volume. `TestCheckWhisperStates` pins this.

Unlike its three neighbours this check shells out to nothing — a PATH lookup and
two `stat` calls — so it takes no context and no timeout. A bogus
`SLASH_WHISPER_BIN` reads as "not installed" rather than being trusted, so a
stale override surfaces on the settings page instead of failing mysteriously on
the reviewer's first F5.

### The download button and the write boundary

Putting 1.6 GB on disk is a **durable write**, so it goes through a workflow and
never through an HTTP handler: `POST /api/workflows/whisper_model` starts a
one-shot `whisper_model` Execution whose single Activity does the writing. The
URL and destination are constants in `whisper.go` — a browser-triggered download
must not be able to name what the server fetches or where it lands.
(`SLASH_WHISPER_MODEL_URL` exists for a local mirror or an end-to-end test; it
is an env var, never a request field.)

The Activity is idempotent on replay (an existing model returns immediately) and
downloads to a **temp name in the same directory**, renaming only after the body
has been read in full and its length checked against `Content-Length`. An
interrupted download therefore never leaves something that looks like a working
model — which matters, because `checkWhisper` would then cheerfully report
"klaar voor gebruik" and every dictation would fail on a corrupt file.

`StartWhisperModel` launches the Execution in a **goroutine**, and that is
load-bearing: a signal-less workflow is driven inline by `StartWorkflow` (see
`startCleanup`/`IgnoreFailedRuns`), so a caller that waited would hold the HTTP
request open for the whole download. A `claimWhisperDownload` compare-and-set
keeps two quick button presses from starting two fetches.

## Write boundary

Two carve-outs, both of the established kind (see
`.claude/rules/workflows-write-boundary.md`):

- **`POST /api/transcribe`** writes nothing durable — request body into a temp
  file, shell out, delete, return text. Same shape as `/api/me`.
- **`GET /api/whisper/progress`** reads an in-memory byte counter, empty again
  after a restart, exactly like `/api/ingest/progress`. It is never the source
  of truth: whether the model is installed is answered by looking at the file.

## Tests

- `whisper_test.go` — the WAV framing as whisper-cli actually receives it (via a
  shell stub), the two header length fields, `cleanTranscript` (including
  whisper's `[BLANK_AUDIO]` marker, which must never be pasted as if spoken),
  the 503 "not set up" answer given *before* any audio is read, the body cap,
  the three `checkWhisper` states plus "never error", atomic download including
  a truncated response, and the download claim.
- `tests/dictation.spec.mjs` — the real gesture on both pages, the auto-repeat
  guard, the blur safety net, the too-short discard, the "not set up" message,
  dictating into an already-open chat, and the settings button appearing only
  when the model (not the binary) is what is missing. `getUserMedia` is replaced
  by a **real** oscillator-backed MediaStream rather than a stub object, so the
  AudioContext/AudioWorklet path is genuinely exercised; only `/api/transcribe`
  is faked, so no 1.6 GB model is needed to run the suite.
