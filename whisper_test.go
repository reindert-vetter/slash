package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeStubWhisper writes a tiny shell script that behaves like whisper-cli for
// the purpose of these tests: it echoes a fixed transcript on stdout and, when
// asked, checks that the WAV it was handed really is a WAV. Keeps the suite
// free of a 1.6 GB model and a real binary.
func writeStubWhisper(t *testing.T, script string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "whisper-stub.sh")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+script+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func writeFakeModel(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), whisperModelName)
	if err := os.WriteFile(p, []byte("not really a model"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// TestTranscribePCMWrapsRawSamplesInAWAV is the core of the upload contract:
// the browser sends BARE 16-bit samples (it cannot write a correct RIFF header
// while the reviewer is still speaking — the length fields are not known yet),
// so this side has to produce the header. A stub standing in for whisper-cli
// verifies the file it receives really opens as a 16 kHz mono PCM WAV whose
// declared data length matches the bytes that arrived.
func TestTranscribePCMWrapsRawSamplesInAWAV(t *testing.T) {
	// 400 samples of silence — the content does not matter, the framing does.
	pcm := make([]byte, 800)
	bin := writeStubWhisper(t, `
f=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-f" ]; then f="$2"; fi
  shift
done
head -c 4 "$f"
printf ' '
# byte 22 is the channel count, byte 24 the sample rate, byte 40 the data size
od -An -tu2 -j22 -N2 "$f" | tr -d ' \n'
printf ' '
od -An -tu4 -j24 -N4 "$f" | tr -d ' \n'
printf ' '
od -An -tu4 -j40 -N4 "$f" | tr -d ' \n'
printf '\n'
`)
	got, err := transcribePCM(context.Background(), bin, writeFakeModel(t), strings.NewReader(string(pcm)))
	if err != nil {
		t.Fatalf("transcribePCM: %v", err)
	}
	want := fmt.Sprintf("RIFF 1 %d %d", whisperSampleRate, len(pcm))
	if got != want {
		t.Fatalf("header as seen by whisper-cli = %q, want %q", got, want)
	}
}

// TestWriteWAVHeaderSizes pins the two length fields directly, since a wrong
// one is the kind of bug that still "plays" in some decoders and silently
// truncates in others.
func TestWriteWAVHeaderSizes(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "wav")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.Write(make([]byte, wavHeaderSize)); err != nil {
		t.Fatal(err)
	}
	const dataLen = 1234
	if _, err := f.Write(make([]byte, dataLen)); err != nil {
		t.Fatal(err)
	}
	if err := writeWAVHeader(f, dataLen); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatal(err)
	}
	if got := binary.LittleEndian.Uint32(raw[4:8]); got != 36+dataLen {
		t.Errorf("RIFF chunk size = %d, want %d", got, 36+dataLen)
	}
	if got := binary.LittleEndian.Uint32(raw[40:44]); got != dataLen {
		t.Errorf("data chunk size = %d, want %d", got, dataLen)
	}
}

// TestCleanTranscript covers what actually reaches the composer. whisper-cli
// emits one line per segment, and "[BLANK_AUDIO]" for a stretch with nothing
// in it — pasting that literal marker as if the reviewer had said it would be
// worse than pasting nothing.
func TestCleanTranscript(t *testing.T) {
	cases := []struct{ in, want string }{
		{"  hallo wereld \n", "hallo wereld"},
		{"eerste zin\ntweede zin\n", "eerste zin tweede zin"},
		{"[BLANK_AUDIO]\n", ""},
		{"echt iets\n[BLANK_AUDIO]\nen nog iets\n", "echt iets en nog iets"},
		{"", ""},
	}
	for _, c := range cases {
		if got := cleanTranscript(c.in); got != c.want {
			t.Errorf("cleanTranscript(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestHandleTranscribeReportsSetupBeforeReadingAudio pins the "nothing is
// installed yet" path: the endpoint must answer 503 with setup:true — which
// src/dictation.mjs turns into "nog niet ingesteld — zie Instellingen" —
// rather than accept four minutes of audio it has no way to transcribe.
func TestHandleTranscribeReportsSetupBeforeReadingAudio(t *testing.T) {
	t.Setenv("SLASH_WHISPER_BIN", filepath.Join(t.TempDir(), "definitely-not-here"))
	t.Setenv("SLASH_WHISPER_MODEL", filepath.Join(t.TempDir(), "no-model.bin"))
	s := &server{}
	rec := httptest.NewRecorder()
	s.handleTranscribe(rec, httptest.NewRequest(http.MethodPost, "/api/transcribe", strings.NewReader("audio")))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
	var body struct {
		OK    bool `json:"ok"`
		Setup bool `json:"setup"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.OK || !body.Setup {
		t.Fatalf("body = %+v, want ok=false setup=true", body)
	}
}

// TestHandleTranscribeRejectsOversizedAudio: the body cap has to bite, since
// this endpoint streams straight into a temp file.
func TestHandleTranscribeRejectsOversizedAudio(t *testing.T) {
	model := writeFakeModel(t)
	t.Setenv("SLASH_WHISPER_BIN", writeStubWhisper(t, "echo hallo"))
	t.Setenv("SLASH_WHISPER_MODEL", model)
	s := &server{}
	big := strings.NewReader(strings.Repeat("x", whisperMaxAudioBytes+1024))
	rec := httptest.NewRecorder()
	s.handleTranscribe(rec, httptest.NewRequest(http.MethodPost, "/api/transcribe", big))
	if rec.Code == http.StatusOK {
		t.Fatalf("oversized upload was accepted (status %d)", rec.Code)
	}
}

// TestHandleTranscribeReturnsText is the happy path end to end through the
// handler, with the stub standing in for whisper-cli.
func TestHandleTranscribeReturnsText(t *testing.T) {
	t.Setenv("SLASH_WHISPER_BIN", writeStubWhisper(t, "echo 'hallo dit is een test'"))
	t.Setenv("SLASH_WHISPER_MODEL", writeFakeModel(t))
	s := &server{}
	rec := httptest.NewRecorder()
	s.handleTranscribe(rec, httptest.NewRequest(http.MethodPost, "/api/transcribe", strings.NewReader("some pcm")))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		OK   bool   `json:"ok"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || body.Text != "hallo dit is een test" {
		t.Fatalf("body = %+v", body)
	}
}

// TestCheckWhisperStates walks the three states the settings page renders, and
// pins the one rule that matters most: this check must NEVER be authStateError.
// brokenChecks() (src/authStatus.mjs) filters on exactly "error" to decide
// whether to open the global, keyboard-owning dialog, and a reviewer who never
// dictates must not be nagged by a modal about an optional feature.
func TestCheckWhisperStates(t *testing.T) {
	m := &TaskManager{}

	t.Run("binary missing", func(t *testing.T) {
		t.Setenv("SLASH_WHISPER_BIN", filepath.Join(t.TempDir(), "nope"))
		t.Setenv("SLASH_WHISPER_MODEL", writeFakeModel(t))
		c := m.checkWhisper()
		if c.State != authStateMissing {
			t.Fatalf("state = %q, want %q", c.State, authStateMissing)
		}
		if c.FixCommand != "brew install whisper.cpp" {
			t.Errorf("FixCommand = %q", c.FixCommand)
		}
		if c.Action != "" {
			t.Errorf("Action = %q, want none: slash cannot brew install on the reviewer's behalf", c.Action)
		}
	})

	t.Run("model missing offers the download", func(t *testing.T) {
		t.Setenv("SLASH_WHISPER_BIN", writeStubWhisper(t, "true"))
		t.Setenv("SLASH_WHISPER_MODEL", filepath.Join(t.TempDir(), "absent.bin"))
		c := m.checkWhisper()
		if c.State != authStateMissing {
			t.Fatalf("state = %q, want %q", c.State, authStateMissing)
		}
		if c.Action != "whisperModel" {
			t.Fatalf("Action = %q, want %q", c.Action, "whisperModel")
		}
	})

	t.Run("ready", func(t *testing.T) {
		t.Setenv("SLASH_WHISPER_BIN", writeStubWhisper(t, "true"))
		t.Setenv("SLASH_WHISPER_MODEL", writeFakeModel(t))
		c := m.checkWhisper()
		if c.State != authStateOK {
			t.Fatalf("state = %q, want %q", c.State, authStateOK)
		}
	})

	t.Run("never error", func(t *testing.T) {
		for _, bin := range []string{"", filepath.Join(t.TempDir(), "nope")} {
			t.Setenv("SLASH_WHISPER_BIN", bin)
			t.Setenv("SLASH_WHISPER_MODEL", filepath.Join(t.TempDir(), "absent.bin"))
			if c := m.checkWhisper(); c.State == authStateError {
				t.Fatalf("checkWhisper reported authStateError for bin=%q", bin)
			}
		}
	})
}

// TestDownloadWhisperModelToIsAtomic covers the thing that would hurt most: a
// download that ends early must not leave something that looks like a working
// 1.6 GB model behind, because checkWhisper would then report "klaar voor
// gebruik" and every dictation would fail on a corrupt file instead.
func TestDownloadWhisperModelToIsAtomic(t *testing.T) {
	dir := t.TempDir()

	t.Run("complete download lands", func(t *testing.T) {
		payload := strings.Repeat("model-bytes", 100)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(payload))
		}))
		defer srv.Close()
		dest := filepath.Join(dir, "ok.bin")
		if err := downloadWhisperModelTo(context.Background(), srv.URL, dest); err != nil {
			t.Fatalf("download: %v", err)
		}
		got, err := os.ReadFile(dest)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != payload {
			t.Fatalf("stored %d bytes, want %d", len(got), len(payload))
		}
	})

	t.Run("truncated download leaves nothing behind", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Promise more than we deliver, then hang up cleanly — a proxy
			// cutting the connection looks exactly like this.
			w.Header().Set("Content-Length", "1000")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("only a few bytes"))
		}))
		defer srv.Close()
		dest := filepath.Join(dir, "truncated.bin")
		err := downloadWhisperModelTo(context.Background(), srv.URL, dest)
		if err == nil {
			t.Fatal("truncated download reported success")
		}
		if fileExistsNonEmpty(dest) {
			t.Fatal("a truncated download was renamed into place")
		}
		// The leftover part-file must not be mistaken for the model either.
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if e.Name() == filepath.Base(dest) {
				t.Fatalf("destination %s exists after a failed download", e.Name())
			}
		}
	})

	t.Run("existing model is not re-downloaded", func(t *testing.T) {
		appDir := t.TempDir()
		dest := filepath.Join(appDir, "models", whisperModelName)
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dest, []byte("already here"), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Setenv("SLASH_WHISPER_MODEL", "")
		// No HTTP server at all: if the Activity tried to fetch, this fails.
		if err := downloadWhisperModel(context.Background(), appDir); err != nil {
			t.Fatalf("download: %v", err)
		}
		got, _ := os.ReadFile(dest)
		if string(got) != "already here" {
			t.Fatalf("existing model was overwritten: %q", got)
		}
	})
}

// TestClaimWhisperDownloadIsExclusive: the button's own guard. Two quick
// presses must not start two 1.6 GB fetches into the same directory.
func TestClaimWhisperDownloadIsExclusive(t *testing.T) {
	setWhisperDownload(func(st *whisperDownloadState) { *st = whisperDownloadState{} })
	defer setWhisperDownload(func(st *whisperDownloadState) { *st = whisperDownloadState{} })
	if !claimWhisperDownload() {
		t.Fatal("first claim was refused")
	}
	if claimWhisperDownload() {
		t.Fatal("second claim was granted while a download is active")
	}
	setWhisperDownload(func(st *whisperDownloadState) { st.Active = false })
	if !claimWhisperDownload() {
		t.Fatal("claim refused after the previous download finished")
	}
}
