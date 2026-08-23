package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// writePraiseFile drops a praise-words.json into a fresh temp data dir and
// returns that dir, so each case gets its own cache key (praiseWords caches per
// dataDir).
func writePraiseFile(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "praise-words.json"), []byte(body), 0o644); err != nil {
		t.Fatalf("write praise-words.json: %v", err)
	}
	return dir
}

// TestPraiseWordsDefaults covers every fall-back path: no file at all, invalid
// JSON, and a file that normalizes to nothing. All three must yield the built-in
// list rather than an error or an empty list — a hand-edited local file may
// never break the review flow.
func TestPraiseWordsDefaults(t *testing.T) {
	cases := map[string]string{
		"missing file":  "",
		"invalid json":  "{ not json",
		"wrong shape":   `{"nice": true}`,
		"empty array":   `[]`,
		"blanks only":   `["", "   "]`,
		"null contents": `null`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			if body != "" {
				dir = writePraiseFile(t, body)
			}
			if got := praiseWords(dir); !reflect.DeepEqual(got, defaultPraiseWords) {
				t.Fatalf("praiseWords = %v, want the defaults %v", got, defaultPraiseWords)
			}
		})
	}
}

// TestPraiseWordsOverrideWins proves the local file replaces the defaults
// entirely (it is not merged — a reviewer must be able to drop a default word
// too) and that every entry is normalized to trimmed lowercase, since the
// frontend matches case-insensitively against an already-lowercased body.
func TestPraiseWordsOverrideWins(t *testing.T) {
	dir := writePraiseFile(t, `["Nice", "  TOP  ", "", "prima"]`)
	want := []string{"nice", "top", "prima"}
	if got := praiseWords(dir); !reflect.DeepEqual(got, want) {
		t.Fatalf("praiseWords = %v, want %v", got, want)
	}
}

// TestPraiseWordsCachedPerDir pins the cache behaviour the doc promises: the
// file is read ONCE per data dir, so editing it takes a restart, while a second
// dir is still resolved independently (which is what makes the cases above
// isolated).
func TestPraiseWordsCachedPerDir(t *testing.T) {
	dir := writePraiseFile(t, `["prima"]`)
	first := praiseWords(dir)
	if err := os.WriteFile(filepath.Join(dir, "praise-words.json"), []byte(`["anders"]`), 0o644); err != nil {
		t.Fatalf("rewrite praise-words.json: %v", err)
	}
	if got := praiseWords(dir); !reflect.DeepEqual(got, first) {
		t.Fatalf("praiseWords = %v after an edit, want the cached %v", got, first)
	}
	other := writePraiseFile(t, `["anders"]`)
	if got := praiseWords(other); !reflect.DeepEqual(got, []string{"anders"}) {
		t.Fatalf("praiseWords(other dir) = %v, want [anders]", got)
	}
}

// TestPraiseWordsEndpoint covers GET /api/praisewords itself: it answers 200
// with the resolved list for the server's own data dir (the frontend's
// ensurePraiseWords only accepts a non-empty array, see src/home.mjs), and it
// stays GET-only.
func TestPraiseWordsEndpoint(t *testing.T) {
	s := &server{dataDir: writePraiseFile(t, `["prima"]`)}

	rec := httptest.NewRecorder()
	s.handlePraiseWords(rec, httptest.NewRequest(http.MethodGet, "/api/praisewords", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got struct {
		OK    bool     `json:"ok"`
		Words []string `json:"words"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	if !got.OK || !reflect.DeepEqual(got.Words, []string{"prima"}) {
		t.Fatalf("body = %+v, want ok with [prima]", got)
	}

	rec = httptest.NewRecorder()
	s.handlePraiseWords(rec, httptest.NewRequest(http.MethodPost, "/api/praisewords", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d, want 405", rec.Code)
	}
}

// TestSavePraiseWordsFileTakesEffectImmediately pins the settings-page write
// path's whole point: unlike a hand edit (TestPraiseWordsCachedPerDir), a
// write through savePraiseWordsFile must be visible on the very next read —
// no restart — because it updates the in-memory cache in the same locked
// section as the disk write.
func TestSavePraiseWordsFileTakesEffectImmediately(t *testing.T) {
	dir := writePraiseFile(t, `["prima"]`)
	if got := praiseWords(dir); !reflect.DeepEqual(got, []string{"prima"}) {
		t.Fatalf("praiseWords = %v, want [prima]", got)
	}
	got, err := savePraiseWordsFile(dir, []string{"Nice", "  TOP  ", ""})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"nice", "top"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("savePraiseWordsFile returned %v, want %v", got, want)
	}
	if got := praiseWords(dir); !reflect.DeepEqual(got, want) {
		t.Fatalf("praiseWords after save = %v, want %v (no restart needed)", got, want)
	}
	// The write also landed on disk, not just in the cache.
	onDisk := loadPraiseWordsFile(filepath.Join(dir, "praise-words.json"))
	if !reflect.DeepEqual(onDisk, want) {
		t.Fatalf("on-disk file = %v, want %v", onDisk, want)
	}
}

// TestSavePraiseWordsFileEmptyFallsBackToDefaults covers the one place the
// write path deviates from the read path's own normalization: the HTTP
// handler (tasks_api.go) rejects an empty list before ever signaling the
// workflow, but savePraiseWordsFile itself stays defensive (never persists an
// empty list that would just silently read back as the defaults anyway).
func TestSavePraiseWordsFileEmptyFallsBackToDefaults(t *testing.T) {
	dir := writePraiseFile(t, `["prima"]`)
	got, err := savePraiseWordsFile(dir, []string{"", "   "})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, defaultPraiseWords) {
		t.Fatalf("savePraiseWordsFile([empty]) = %v, want the defaults %v", got, defaultPraiseWords)
	}
}
