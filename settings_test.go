package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// writeSettingsFile puts a settings.json in a fresh temp data dir and returns
// that dir, mirroring writePraiseFile in praisewords_test.go. A fresh dir per
// call matters: settings() caches per dataDir for the process lifetime.
func writeSettingsFile(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	if body != "" {
		if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(body), 0o644); err != nil {
			t.Fatalf("write settings.json: %v", err)
		}
	}
	return dir
}

// TestLoadSettingsFile covers the parse + normalization rules: a missing file
// and unparsable JSON both yield empty settings (never an error — the frontend
// then falls back to /api/me), and aliases are trimmed, emptied-dropped and
// deduped case-insensitively because mention matching is case-insensitive.
func TestLoadSettingsFile(t *testing.T) {
	if got := loadSettingsFile(filepath.Join(t.TempDir(), "nope.json")); got.Me.Login != "" || len(got.Me.Aliases) != 0 {
		t.Fatalf("missing file = %+v, want empty settings", got)
	}

	bad := writeSettingsFile(t, `{"me": {`)
	if got := loadSettingsFile(filepath.Join(bad, "settings.json")); got.Me.Login != "" || len(got.Me.Aliases) != 0 {
		t.Fatalf("bad JSON = %+v, want empty settings", got)
	}

	dir := writeSettingsFile(t, `{"me": {"login": "  reindert-vetter  ", "aliases": [" reindert ", "", "Reindert", "rv"]}}`)
	got := loadSettingsFile(filepath.Join(dir, "settings.json"))
	if got.Me.Login != "reindert-vetter" {
		t.Fatalf("login = %q, want reindert-vetter", got.Me.Login)
	}
	if !reflect.DeepEqual(got.Me.Aliases, []string{"reindert", "rv"}) {
		t.Fatalf("aliases = %v, want [reindert rv]", got.Me.Aliases)
	}
}

// TestSettingsCachedPerDataDir pins the read-once-per-dataDir behaviour
// (editing the file takes a restart, like names.json/praise-words.json) and that
// a different dir gets its own answer — the property a test relies on.
func TestSettingsCachedPerDataDir(t *testing.T) {
	dir := writeSettingsFile(t, `{"me": {"login": "first"}}`)
	if got := settings(dir).Me.Login; got != "first" {
		t.Fatalf("login = %q, want first", got)
	}
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"me":{"login":"second"}}`), 0o644); err != nil {
		t.Fatalf("rewrite settings.json: %v", err)
	}
	if got := settings(dir).Me.Login; got != "first" {
		t.Fatalf("login = %q after an edit, want the cached first", got)
	}
	other := writeSettingsFile(t, `{"me": {"login": "other"}}`)
	if got := settings(other).Me.Login; got != "other" {
		t.Fatalf("login(other dir) = %q, want other", got)
	}
}

// TestSettingsEndpoint covers GET /api/settings itself: 200 with the resolved
// me-block for the server's own data dir, an always-present (never null) alias
// array so the frontend can iterate it unguarded, and GET-only.
func TestSettingsEndpoint(t *testing.T) {
	s := &server{dataDir: writeSettingsFile(t, `{"me": {"login": "reindert-vetter", "aliases": ["reindert"]}}`)}

	rec := httptest.NewRecorder()
	s.handleSettings(rec, httptest.NewRequest(http.MethodGet, "/api/settings", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got struct {
		OK bool `json:"ok"`
		Me struct {
			Login   string   `json:"login"`
			Aliases []string `json:"aliases"`
		} `json:"me"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	if !got.OK || got.Me.Login != "reindert-vetter" || !reflect.DeepEqual(got.Me.Aliases, []string{"reindert"}) {
		t.Fatalf("body = %+v, want ok with reindert-vetter/[reindert]", got)
	}

	// No file at all still answers 200 with an empty (non-null) alias list.
	empty := &server{dataDir: writeSettingsFile(t, "")}
	rec = httptest.NewRecorder()
	empty.handleSettings(rec, httptest.NewRequest(http.MethodGet, "/api/settings", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("no-file status = %d, want 200", rec.Code)
	}
	if body := rec.Body.String(); !strings.Contains(body, `"aliases":[]`) {
		t.Fatalf("no-file body = %s, want an empty aliases array", body)
	}

	rec = httptest.NewRecorder()
	s.handleSettings(rec, httptest.NewRequest(http.MethodPost, "/api/settings", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d, want 405", rec.Code)
	}
}

// TestSaveMentionAliasesTakesEffectImmediately mirrors
// TestSavePraiseWordsFileTakesEffectImmediately: a write through
// saveMentionAliases must be visible on the very next settings() read, unlike
// a hand edit (TestSettingsCachedPerDataDir).
func TestSaveMentionAliasesTakesEffectImmediately(t *testing.T) {
	dir := writeSettingsFile(t, `{"me": {"login": "reindert-vetter", "aliases": ["reindert"]}}`)
	got, err := saveMentionAliases(dir, []string{"Reindert", "  rv  ", ""})
	if err != nil {
		t.Fatal(err)
	}
	wantAliases := []string{"Reindert", "rv"}
	if !reflect.DeepEqual(got.Me.Aliases, wantAliases) {
		t.Fatalf("saveMentionAliases returned aliases %v, want %v", got.Me.Aliases, wantAliases)
	}
	if got := settings(dir).Me.Aliases; !reflect.DeepEqual(got, wantAliases) {
		t.Fatalf("settings() after save = %v, want %v (no restart needed)", got, wantAliases)
	}
}

// TestSaveMentionAliasesPreservesLoginAndRepos pins the write path's central
// safety property: it must touch ONLY aliases, never clobber Login (still
// display-only, sourced from GitHub — settings.go) or Repos (repos.go's own
// registry) even when those were changed by a hand edit AFTER this process
// already cached an older copy.
func TestSaveMentionAliasesPreservesLoginAndRepos(t *testing.T) {
	dir := writeSettingsFile(t, `{"me": {"login": "old-login"}, "repos": [{"key": "extra", "slug": "o/n"}]}`)
	// Warm the cache with the original content, then hand-edit the login on
	// disk — simulating an edit made after this process started.
	_ = settings(dir)
	if err := os.WriteFile(filepath.Join(dir, "settings.json"),
		[]byte(`{"me": {"login": "new-login"}, "repos": [{"key": "extra", "slug": "o/n"}]}`), 0o644); err != nil {
		t.Fatalf("rewrite settings.json: %v", err)
	}
	got, err := saveMentionAliases(dir, []string{"alias1"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Me.Login != "new-login" {
		t.Fatalf("Me.Login = %q, want the on-disk new-login (not clobbered by the stale cache)", got.Me.Login)
	}
	if len(got.Repos) != 1 || got.Repos[0].Key != "extra" {
		t.Fatalf("Repos = %+v, want the on-disk repos entry preserved", got.Repos)
	}
	if !reflect.DeepEqual(got.Me.Aliases, []string{"alias1"}) {
		t.Fatalf("Me.Aliases = %v, want [alias1]", got.Me.Aliases)
	}
}
