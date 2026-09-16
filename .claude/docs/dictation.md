# Dictation: press F5 to speak into the Claude composer

Press `F5`, talk, press `F5` again — the transcript is inserted into the
Claude chat's composer AND sent straight away, exactly as if the reviewer had
typed it and pressed Enter themselves. Everything runs on this machine: the
audio never leaves it.

Frontend: `src/dictation.mjs`. Backend: `whisper.go` plus the `whisper_model`
Workflow in `workflows.go`. The settings row lives in `auth_status.go`'s
`checkWhisper` and `src/settings.mjs`'s `whisperBlock`.

## Which chat F5 opens

`initDictation({ openChat })`'s `openChat` decides which chat the first F5
press (of a fresh recording) opens — `src/dictation.mjs` itself has no opinion
here, it only calls whatever the page handed it.

- **`home.mjs` (review tree, `/pr/<id>`) — three tiers, in order:**
  1. If the currently selected group/line/call's own scoped Claude
     conversation is already reachable (`claudeColumnVisible()`,
     `RelatedPanel.mjs` — the same "does the Claude half of the merged
     comment/chat card render" question `enterCommentsOrRelated`'s own →
     chain asks), F5 opens THAT conversation via the existing
     `enterClaudeChat` entry point.
  2. Otherwise, if a real navigation unit is selected at all
     (`commentTarget()` — works in list mode, diff mode, and inside a
     drilled column, see its own doc comment), F5 opens (creates) THAT
     unit's own scoped chat via `startClaudeChat` — the exact same call the
     "Chat over deze regel" palette command already makes. **First reported
     gap, since fixed:** with no conversation yet on the selected unit,
     tier 1 is (correctly) `false`, but F5 used to then fall all the way
     through to the general chat instead of opening/creating the scoped one
     — reviewer follow-up: "als ik in de diff zit van code blok, en ik druk
     op f5, dan wil ik chatblokje rechts ervan openen (wat al bestaat), niet
     de algemene model/chat". `claudeColumnVisible()` alone was too strict a
     gate for what F5 should be ALLOWED to open, only for what already
     happens to be open.
  3. Only when NEITHER applies — nothing sensible selected at all (no
     blocks loaded, or a synthetic comment-index row, whose `commentTarget()`
     deliberately returns `null`, see "A synthetic comment-index item…" in
     that function's own doc comment) — does F5 fall back to the PR-wide
     general chat (`openGeneralChat`).

  Reviewer request behind tier 1: "als ik op f5 druk, en ik heb groep, line
  of call geselecteerd dan wil ik daarvan de chat openen, niet de algemene
  chat". Never a second, parallel way to reach any of these three — all of
  `claudeColumnVisible`/`enterClaudeChat`/`commentTarget`/`startClaudeChat`
  are reused unchanged from their existing call sites.
- **`plan.mjs` (planning page, `/plan/<KEY>`):** always opens the one ticket
  chat (`openPlanChat`) — there is no per-unit scoped conversation on this
  page to prefer instead.

Only the recording's **START** consults this — the second F5 press that stops
and transcribes never opens or switches a chat, it only ends the recording
that is already running (whichever chat is on screen at that point keeps the
focus it already had).

## The transcript is sent, not just inserted

Reviewer request: "na 2e keer f5 wil ik het gelijk versturen" — the second F5
press no longer just drops the transcript in the composer for the reviewer to
send themselves; it sends it right away, the same as if they had typed it and
pressed Enter.

**No second send path.** `sendComposer(el)` (`dictation.mjs`) dispatches a
synthetic, plain (non-Shift) `keydown` Enter on the composer field itself —
the exact event `ClaudeChat.mjs`'s own `@keydown` handler already reacts to
for a genuinely typed Enter, which calls whichever `onSend` callback that
particular chat (scoped or general) is currently wired up with. This module
never needs to know or care which chat is open, or import a send function
directly — same "reuse the real listener via a dispatched event" pattern
`tests/dictation.spec.mjs`'s own auto-repeat test already uses for F5 itself.

**Three edge cases, confirmed with the reviewer rather than assumed:**

- **The composer already held reviewer-typed text:** `insertIntoComposer`
  already appended the transcript to it (with a separating space), as before
  this change — sending then sends the WHOLE field, exactly as if the
  reviewer had typed the rest themselves and pressed Enter. No special-casing
  needed: the synthetic Enter reads `e.target.value` at the moment it fires,
  same as a real one would.
- **An empty transcript** ("Niets verstaan", or a recording under `MIN_MS`) —
  `insertIntoComposer` (and therefore `sendComposer`) is never called for it
  in the first place (`stopDictation`'s `if (data.text) { … }` guard), so
  nothing is ever sent either. Sending only ever happens as a consequence of
  a successful insert, never on its own.
- **Escape mid-recording** (`abortDictation`) never reaches `insertIntoComposer`
  or `sendComposer` at all — it is a wholly separate path that only tears down
  the audio capture. Aborting a recording never inserts and never sends.

`insertIntoComposer` now returns the composer element (or `null` if it wasn't
found) instead of nothing, purely so `stopDictation` has something to call
`sendComposer` on.

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

## A toggle, not push-to-talk — and why that changed

Press F5 to start recording, press it again to stop and transcribe. Releasing
the key does nothing at all.

This **replaced an earlier push-to-talk design** (hold F5, let go to finish).
The reviewer triggers F5 via BetterTouchTool, mapped from a physical mic
button — and BTT forwards a *complete* keystroke (down and up, back to back)
whenever that button is pressed, rather than holding the key down for as long
as the button is held. Push-to-talk is therefore not reachable from that
trigger at all: BTT cannot "hold" a key, so every recording would have
finished (or been discarded as too short) within milliseconds of starting.
A toggle is the shape BTT can actually drive.

**Escape aborts a running recording without transcribing anything.**
Push-to-talk never needed this — releasing the key always finished and
transcribed whatever was captured, so there was no separate "cancel" gesture.
A toggle does need one: the reviewer can now start a recording by accident (or
change their mind) with no key still held to just let go of, so Escape is the
explicit way out. Only consumed while a recording is actually running; an
ordinary Escape elsewhere is untouched.

**One wrinkle: the general chat overlay's own Escape handler runs on the
CAPTURE phase** (`generalChatOverlay.mjs`, "esc moet alles weer hidden" — an
absolute reviewer rule, see that file's own header) and calls
`e.stopPropagation()`, so `dictation.mjs`'s bubble-phase Escape branch never
gets a turn at all while that overlay is the thing on screen. This matters
here specifically because F5 opens that very overlay whenever it had to fall
back to the general chat (see "Which chat F5 opens" above) — without a fix,
pressing Escape to leave it would close the overlay but leave the microphone
recording silently behind it. `abortDictationIfRecording` (exported from
`dictation.mjs`) is called from that same capture-phase handler, right before
`closeGeneralChatOverlay()`, so both happen together. The scoped, in-tree chat
has no such capture-phase Escape owner, so there Escape reaches
`handleDictationKeydown` the ordinary way and only the recording is
cancelled — the chat card itself stays exactly as it was.

The remaining risk is a recording **left running indefinitely** — there is no
keyup to fall back on anymore, so if the reviewer forgets they toggled it on
and walks away, or a second F5 press never arrives, nothing else would stop
it. `src/dictation.mjs` still ends a recording on any of:

1. A second, non-repeat `keydown` on F5 — the ordinary path (the toggle
   itself).
2. `window` `blur` — ⌘-Tab, Spotlight, a system dialog. The audio recorded so
   far is kept and transcribed; it was genuinely spoken. Deliberately left in,
   even though a toggle lets the reviewer knowingly click away while still
   meaning to keep talking: an open microphone that keeps recording while the
   window isn't even focused is the more surprising (and more
   privacy-sensitive) outcome of the two choices, and `MAX_MS` alone would
   leave it running for up to two full minutes unattended. One more F5 press
   starts a fresh recording immediately if the reviewer really did just glance
   elsewhere mid-sentence.
3. `visibilitychange` to `hidden` — tab switch, minimise.
4. A hard `MAX_MS` (two minutes) timer, matched to the server's own body cap —
   now the backstop of last resort, since nothing else is guaranteed to fire.

This is the same shape as the existing held-key precedent in this codebase —
the `c`/`v` column resize in `home.mjs`, whose own comment already says a
window blur is a safety net for "the case the keyup itself never arrives
(e.g. Alt+Tab away while still holding the key)" — reused here even though
this module no longer has a keyup of its own to lose.

**`e.repeat` must be ignored.** macOS (and a held BTT trigger) keeps firing
`keydown` for as long as the key is considered held; without that guard a
single press would flip the toggle back and forth dozens of times per second.
`tests/dictation.spec.mjs` pins this by dispatching twenty synthetic
`repeat: true` keydowns and asserting `getUserMedia` was called exactly once.

**A recording shorter than `MIN_MS` (300 ms) is discarded** with the word "Te
kort" rather than transcribed. Under push-to-talk this guarded against a key
brushed by accident; under the toggle it guards against two F5 presses in
quick succession (an accidental double-trigger, e.g. a flaky hardware
button) — whisper happily hallucinates a word out of near-silence, and
pasting that into the composer is worse than pasting nothing.

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

## The status pill's icons: a blinking red dot, then a spinner

Reviewer follow-up: the existing `dictationStatusPill` (word + level bars) was
felt to need a clearer at-a-glance cue right next to the composer for "is it
actually recording right now" — not a second, competing indicator, just two
small icons added to the pill's two active states:

- **`recording`**: a red dot that blinks (`animate-ping` ring behind a solid
  dot, `data-testid=dictation-recording-dot`), the conventional "recording"
  cue.
- **`transcribing`**: a small CSS ring spinner
  (`data-testid=dictation-transcribing-spinner`, `animate-spin` on a
  bordered circle) in place of the earlier static `⋯` glyph.

Both are `aria-hidden="true"` decoration next to the existing word
(`Opnemen`/`Uitschrijven…`) — the reviewer is colorblind, so the word and the
**motion** (ping/spin), not the red color, carry the state; see the
colorblind rule in `.claude/rules/conventions.md`. The pill already goes back
to nothing (`d.state === 'idle' && !d.note`) the moment a transcript lands in
the composer, which is exactly the "weg zodra de tekst in de input staat"
behaviour asked for — no separate state was needed for that.

## Tests

- `whisper_test.go` — the WAV framing as whisper-cli actually receives it (via a
  shell stub), the two header length fields, `cleanTranscript` (including
  whisper's `[BLANK_AUDIO]` marker, which must never be pasted as if spoken),
  the 503 "not set up" answer given *before* any audio is read, the body cap,
  the three `checkWhisper` states plus "never error", atomic download including
  a truncated response, and the download claim.
- `tests/dictation.spec.mjs` — the real toggle gesture on both pages (start on
  one press, stop-and-transcribe on the next), which chat F5 opens (the
  scoped one when a group/line/call already has a reachable conversation,
  opening/creating a fresh scoped one for a plain comment-less block in the
  diff, and the general one only with genuinely nothing selected), the
  auto-repeat guard, Escape aborting a recording both on a scoped chat (chat
  stays open) and via the general overlay's own capture-phase handler
  (overlay closes, recording still cancelled), the blur safety net, the
  too-short discard, the "not set up" message, dictating into
  an already-open chat, and the settings button appearing only when the model
  (not the binary) is what is missing. `getUserMedia` is replaced
  by a **real** oscillator-backed MediaStream rather than a stub object, so the
  AudioContext/AudioWorklet path is genuinely exercised; only `/api/transcribe`
  is faked, so no 1.6 GB model is needed to run the suite.
