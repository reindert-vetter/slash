package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// whisper.go is the local speech-to-text half of dictation (see
// .claude/docs/dictation.md): holding F5 records audio in the browser, and the
// raw PCM lands here to be turned into text by whisper.cpp, entirely on this
// machine. No audio ever leaves the laptop — that was the reviewer's hard
// requirement, and it is why Chrome's own webkitSpeechRecognition (which ships
// the audio to Google) was ruled out, and why Claude is not in this path at all
// (neither the CLI nor the Anthropic API accepts audio as input).
//
// Two external pieces are needed, and they are deliberately acquired in two
// DIFFERENT ways:
//
//   - the `whisper-cli` binary — `brew install whisper.cpp`, which the reviewer
//     runs in their own terminal. Running a package manager on someone's behalf
//     is a different order of magnitude than writing one file, so the settings
//     page only SHOWS that command (as FixCommand, exactly like `gh auth login`).
//   - the model file — downloaded by the app itself, from the settings page's
//     own button. That is a real, durable write, so it goes through the
//     whisper_model Workflow's Activity and never through an HTTP handler; see
//     .claude/rules/workflows-write-boundary.md and downloadWhisperModel below.
//
// WRITE BOUNDARY: POST /api/transcribe (handleTranscribe below) writes nothing
// durable. It streams the request body into a temp file, shells out to
// whisper-cli, deletes the temp file and returns the text. No module, no
// read-model, no workflow history, nothing that survives the request — the same
// operational carve-out as /api/me and ingest_progress.go. GET
// /api/whisper/progress is the same kind of in-memory, cosmetic read as
// /api/ingest/progress.

const (
	// whisperModelName is the one model slash uses: large-v3-turbo, chosen by
	// the reviewer — near-large accuracy at a fraction of the runtime on Apple
	// Silicon, which matters because the transcription only starts when the key
	// is released and the reviewer is waiting for it.
	whisperModelName = "ggml-large-v3-turbo.bin"

	// whisperModelURL is where that file comes from. Hard-coded on purpose: the
	// download is started from the browser, and the UI must not be able to name
	// an arbitrary URL for the server to fetch.
	whisperModelURL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/" + whisperModelName

	// whisperLang is fixed to Dutch, the reviewer's explicit choice over
	// auto-detection: a short dictated sentence gives a language detector very
	// little to go on, and guessing wrong garbles the whole transcript.
	whisperLang = "nl"

	// whisperSampleRate is what whisper.cpp expects, and therefore what
	// src/dictation.mjs downsamples to before uploading.
	whisperSampleRate = 16000

	// whisperMaxAudioBytes bounds one upload: 16-bit mono at 16 kHz is 32 000
	// bytes per second, so this is a little over four minutes — comfortably
	// above the two-minute cap src/dictation.mjs enforces on its own side.
	whisperMaxAudioBytes = 8 << 20

	// whisperTimeout bounds one whisper-cli run. Generous compared to the
	// couple of seconds a normal dictation takes: the very first run after a
	// boot also pays for reading 1.6 GB of model off a cold disk.
	whisperTimeout = 3 * time.Minute

	// wavHeaderSize is the fixed size of the canonical 44-byte RIFF/WAVE header
	// writeWAVHeader emits.
	wavHeaderSize = 44
)

// whisperBinPath resolves the whisper-cli binary: SLASH_WHISPER_BIN wins (tests
// point it at a stub), otherwise it is looked up on PATH. An empty string means
// "not installed", which is a state the settings page reports rather than an
// error anything crashes on.
func whisperBinPath() string {
	// The override is verified rather than trusted: exec.LookPath on a path
	// containing a slash checks that the file exists AND is executable. A stale
	// or mistyped SLASH_WHISPER_BIN must read as "not installed" on the
	// settings page, not as "installed" followed by a mystifying failure on the
	// reviewer's first F5.
	if p := strings.TrimSpace(os.Getenv("SLASH_WHISPER_BIN")); p != "" {
		if resolved, err := exec.LookPath(p); err == nil {
			return resolved
		}
		return ""
	}
	p, err := exec.LookPath("whisper-cli")
	if err != nil {
		return ""
	}
	return p
}

// whisperModelSourceURL is where the model is fetched from.
// SLASH_WHISPER_MODEL_URL overrides it — for a local mirror, or to drive the
// download end to end in a test without pulling 1.6 GB off the network. An
// ENV var specifically, never a request field: the browser starts this
// download, and it must not be able to name what the server fetches.
func whisperModelSourceURL() string {
	if u := strings.TrimSpace(os.Getenv("SLASH_WHISPER_MODEL_URL")); u != "" {
		return u
	}
	return whisperModelURL
}

// whisperModelPath resolves the model file. SLASH_WHISPER_MODEL overrides it
// wholesale; otherwise it sits in <appDataDir>/models/, next to the other files
// the settings page owns (settings.json, praise-words.json) rather than in the
// workflow-store dir — those two only coincide by default, see TaskManager's
// own appDataDir comment in workflows.go.
func whisperModelPath(appDataDir string) string {
	if p := strings.TrimSpace(os.Getenv("SLASH_WHISPER_MODEL")); p != "" {
		return p
	}
	return filepath.Join(appDataDir, "models", whisperModelName)
}

// fileExistsNonEmpty reports whether path is a regular, non-empty file. A
// zero-byte file is treated as absent: that is what an interrupted download
// used to leave behind before downloadWhisperModel started writing to a temp
// name first, and reporting it as "installed" would send whisper-cli off to
// fail on it.
func fileExistsNonEmpty(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.Mode().IsRegular() && st.Size() > 0
}

// ---------------------------------------------------------------- transcribe

// transcribePCM writes raw 16-bit little-endian mono PCM (already at
// whisperSampleRate) from r into a temp WAV and runs whisper-cli over it,
// returning the plain transcript.
//
// The WAV HEADER is written here rather than in the browser on purpose: the
// upload is streamed WHILE the reviewer is still speaking (see
// .claude/docs/dictation.md), so at the moment the first byte is sent nobody
// knows yet how long the recording will be — and a RIFF header's two length
// fields have to hold exactly that. So the client sends bare samples, and this
// function patches the two fields once the stream ends.
func transcribePCM(ctx context.Context, bin, model string, r io.Reader) (string, error) {
	if bin == "" {
		return "", fmt.Errorf("whisper-cli is niet geïnstalleerd")
	}
	if !fileExistsNonEmpty(model) {
		return "", fmt.Errorf("het spraakmodel ontbreekt (%s)", model)
	}
	tmp, err := os.CreateTemp("", "slash-dictation-*.wav")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	defer tmp.Close()

	if _, err := tmp.Write(make([]byte, wavHeaderSize)); err != nil {
		return "", err
	}
	n, err := io.Copy(tmp, r)
	if err != nil {
		return "", err
	}
	if n == 0 {
		return "", fmt.Errorf("lege opname")
	}
	if err := writeWAVHeader(tmp, n); err != nil {
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}

	ctx, cancel := context.WithTimeout(ctx, whisperTimeout)
	defer cancel()
	// Every argument is either a constant or a path this process itself
	// generated — nothing from the request body reaches the command line. See
	// "always validate input before handing it to a subprocess" in
	// .claude/rules/conventions.md.
	cmd := exec.CommandContext(ctx, bin, "-m", model, "-l", whisperLang, "-nt", "-f", tmpPath)
	var out strings.Builder
	var errOut strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("whisper-cli: %s", firstMeaningfulLine(errOut.String(), err.Error()))
	}
	return cleanTranscript(out.String()), nil
}

// writeWAVHeader patches a canonical 44-byte PCM WAV header over the placeholder
// at the start of f, now that the sample-data length is known.
func writeWAVHeader(f *os.File, dataLen int64) error {
	const (
		channels      = 1
		bitsPerSample = 16
	)
	byteRate := whisperSampleRate * channels * bitsPerSample / 8
	h := make([]byte, 0, wavHeaderSize)
	h = append(h, "RIFF"...)
	h = binary.LittleEndian.AppendUint32(h, uint32(36+dataLen))
	h = append(h, "WAVEfmt "...)
	h = binary.LittleEndian.AppendUint32(h, 16) // PCM fmt chunk size
	h = binary.LittleEndian.AppendUint16(h, 1)  // PCM
	h = binary.LittleEndian.AppendUint16(h, channels)
	h = binary.LittleEndian.AppendUint32(h, whisperSampleRate)
	h = binary.LittleEndian.AppendUint32(h, uint32(byteRate))
	h = binary.LittleEndian.AppendUint16(h, channels*bitsPerSample/8)
	h = binary.LittleEndian.AppendUint16(h, bitsPerSample)
	h = append(h, "data"...)
	h = binary.LittleEndian.AppendUint32(h, uint32(dataLen))
	_, err := f.WriteAt(h, 0)
	return err
}

// cleanTranscript turns whisper-cli's stdout into the one line of text that
// goes into the composer. `-nt` already drops the timestamps; what remains can
// still be several segment lines, plus whisper's own "[BLANK_AUDIO]" marker for
// a stretch with nothing in it — which must never be pasted as if the reviewer
// had said it.
func cleanTranscript(s string) string {
	var parts []string
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || (strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]")) {
			continue
		}
		parts = append(parts, line)
	}
	return strings.TrimSpace(strings.Join(parts, " "))
}

// handleTranscribe serves POST /api/transcribe — raw PCM in, text out. See the
// WRITE BOUNDARY note at the top of this file for why this may be a POST that
// does not go through a workflow.
func (s *server) handleTranscribe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	appDir := s.dataDir
	if s.tasks != nil && s.tasks.manager != nil {
		appDir = s.tasks.manager.appDataDirOrDefault()
	}
	bin := whisperBinPath()
	model := whisperModelPath(appDir)
	// Answered before reading the body: there is no point streaming four
	// minutes of audio into a temp file we already know nothing can transcribe.
	// 503 rather than 400 — nothing is wrong with the request, the machine just
	// is not set up yet, and src/dictation.mjs turns this into the "nog niet
	// ingesteld — zie Instellingen" line.
	if bin == "" || !fileExistsNonEmpty(model) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"ok":    false,
			"error": "spraak-naar-tekst is nog niet ingesteld",
			"setup": true,
		})
		return
	}
	body := http.MaxBytesReader(w, r.Body, whisperMaxAudioBytes)
	defer body.Close()
	text, err := transcribePCM(r.Context(), bin, model, body)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "text": text})
}

// ------------------------------------------------------------ model download

// whisperDownloadState is the in-memory, cosmetic progress of the running model
// download — bytes so far, total when the server told us one, and the reason
// the last attempt failed. Exactly the shape and the reasoning of
// ingest_progress.go: it touches no module, no read-model and no workflow
// history, it is empty again after a restart, and it is never the source of
// truth. Whether the model is installed is answered by looking at the file
// (fileExistsNonEmpty), not by this struct.
type whisperDownloadState struct {
	Active bool   `json:"active"`
	Done   int64  `json:"done"`
	Total  int64  `json:"total"`
	Error  string `json:"error,omitempty"`
}

var (
	whisperDownloadMu sync.Mutex
	whisperDownload   whisperDownloadState
)

// claimWhisperDownload marks a download as running and reports whether the
// caller got the claim. The check and the set have to happen under one lock:
// the flag is otherwise only raised inside the Activity, which starts a
// goroutine later, so two quick presses of the button would both sail past a
// plain "is it active?" read and start two 1.6 GB fetches.
func claimWhisperDownload() bool {
	whisperDownloadMu.Lock()
	defer whisperDownloadMu.Unlock()
	if whisperDownload.Active {
		return false
	}
	whisperDownload = whisperDownloadState{Active: true}
	return true
}

func setWhisperDownload(fn func(*whisperDownloadState)) {
	whisperDownloadMu.Lock()
	defer whisperDownloadMu.Unlock()
	fn(&whisperDownload)
}

func whisperDownloadStatus() whisperDownloadState {
	whisperDownloadMu.Lock()
	defer whisperDownloadMu.Unlock()
	return whisperDownload
}

// downloadWhisperModel fetches the model into <appDataDir>/models/. Called ONLY
// from the whisper_model Workflow's Activity (workflows.go) — it writes a
// durable file, so it may not be called from an HTTP handler.
//
// It downloads to a TEMP name in the same directory and renames only after the
// body has been read to completion. An interrupted download therefore never
// leaves something that looks like a working 1.6 GB model behind; the leftover
// temp file is cleaned up on the next attempt.
func downloadWhisperModel(ctx context.Context, appDataDir string) error {
	dest := whisperModelPath(appDataDir)
	if fileExistsNonEmpty(dest) {
		return nil // already there — the Activity is idempotent on replay
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	setWhisperDownload(func(st *whisperDownloadState) { st.Active = true })
	err := downloadWhisperModelTo(ctx, whisperModelSourceURL(), dest)
	setWhisperDownload(func(st *whisperDownloadState) {
		st.Active = false
		if err != nil {
			st.Error = err.Error()
		} else {
			st.Error = ""
		}
	})
	return err
}

// downloadWhisperModelTo is the part a test can drive against its own HTTP
// server: stream url into dest, atomically, reporting progress as it goes.
func downloadWhisperModelTo(ctx context.Context, url, dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download gaf status %d", resp.StatusCode)
	}
	setWhisperDownload(func(st *whisperDownloadState) { st.Total = resp.ContentLength })

	tmp, err := os.CreateTemp(filepath.Dir(dest), ".whisper-model-*.part")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op once the rename below succeeded

	_, err = io.Copy(&progressWriter{w: tmp}, resp.Body)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	// A truncated body that still ended cleanly (a proxy cutting the
	// connection) would otherwise be renamed into place as a working model.
	if resp.ContentLength > 0 {
		if st, serr := os.Stat(tmpPath); serr != nil || st.Size() != resp.ContentLength {
			return fmt.Errorf("download is onvolledig (%d van %d bytes)", fileSizeOrZero(tmpPath), resp.ContentLength)
		}
	}
	return os.Rename(tmpPath, dest)
}

func fileSizeOrZero(path string) int64 {
	st, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return st.Size()
}

// progressWriter counts bytes into the cosmetic progress state as they are
// written.
type progressWriter struct {
	w io.Writer
}

func (p *progressWriter) Write(b []byte) (int, error) {
	n, err := p.w.Write(b)
	if n > 0 {
		setWhisperDownload(func(st *whisperDownloadState) { st.Done += int64(n) })
	}
	return n, err
}

// handleWhisperProgress serves GET /api/whisper/progress — the cosmetic
// download progress described above. Read-only.
func (s *server) handleWhisperProgress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, whisperDownloadStatus())
}
