package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/reindert-vetter/tembed"

	"slash/modules/github"
)

// nameManager builds a TaskManager over a fresh temp data dir (so names.json is
// this test's own) and resets the process-lifetime login cache, which is
// deliberately package-level (see usernames.go).
func nameManager(t *testing.T, gh github.Client, namesJSON string) (*TaskManager, string) {
	t.Helper()
	dir := t.TempDir()
	if namesJSON != "" {
		if err := os.WriteFile(filepath.Join(dir, "names.json"), []byte(namesJSON), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	userNameMu.Lock()
	userNameCache = map[string]displayUser{}
	userNameMu.Unlock()
	namesMu.Lock()
	namesByDir = map[string]map[string]string{}
	namesMu.Unlock()

	m := NewTaskManager(tembed.New(tembed.NewMemoryStore()), gh, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, nil, dir, "test/repo")
	return m, dir
}

// TestResolveDisplayName pins the precedence rule on its own: the local
// names.json override beats GitHub's profile name, and with neither the name is
// left empty so the frontend can fall back to the bare login.
func TestResolveDisplayName(t *testing.T) {
	override := map[string]string{"dennissloove": "Dennis Sloove", "blank": "   "}
	cases := []struct{ login, ghName, want string }{
		{"dennissloove", "D. Sloove (GH)", "Dennis Sloove"}, // override wins
		{"alice", "Alice Anderson", "Alice Anderson"},       // GitHub name
		{"nobody", "", ""},                // neither → frontend shows the login
		{"blank", "Bob Boss", "Bob Boss"}, // whitespace override is no override
		{"trimmed", "  Carol  ", "Carol"},
	}
	for _, tc := range cases {
		if got := resolveDisplayName(tc.login, tc.ghName, override); got != tc.want {
			t.Errorf("resolveDisplayName(%q, %q) = %q, want %q", tc.login, tc.ghName, got, tc.want)
		}
	}
}

// TestLoadNamesFile covers the three states of the hand-maintained file: a real
// map, a missing file (the normal case), and an unparsable one — the latter two
// must yield an empty map rather than an error the caller has to handle.
func TestLoadNamesFile(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "names.json")
	if err := os.WriteFile(good, []byte(`{"dennissloove":"Dennis Sloove"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	m, err := loadNamesFile(good)
	if err != nil || m["dennissloove"] != "Dennis Sloove" {
		t.Fatalf("loadNamesFile(good) = %v, %v", m, err)
	}

	if m, _ := loadNamesFile(filepath.Join(dir, "absent.json")); len(m) != 0 {
		t.Fatalf("missing file yielded %v, want an empty map", m)
	}

	bad := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(bad, []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if m, _ := loadNamesFile(bad); len(m) != 0 {
		t.Fatalf("unparsable file yielded %v, want an empty map", m)
	}
}

// TestDisplayNamesBatchesAndCaches proves the three properties the polling UI
// depends on: every unknown login goes out in ONE lookup, a second call for the
// same logins costs nothing, and a login that resolved to nothing is cached too
// (negative caching) so it is never re-queried.
func TestDisplayNamesBatchesAndCaches(t *testing.T) {
	gh := &github.Fake{}
	gh.SetUser(github.User{Login: "dennissloove", Name: "Dennis Sloove", AvatarURL: "https://avatars.githubusercontent.com/u/2?v=4"})
	m, _ := nameManager(t, gh, "")

	got := m.DisplayNames(context.Background(), []string{"dennissloove", "ghost", "dennissloove"})
	if got["dennissloove"].Name != "Dennis Sloove" || got["dennissloove"].AvatarURL == "" {
		t.Fatalf("dennissloove = %+v, want the seeded name + avatar", got["dennissloove"])
	}
	if u, ok := got["ghost"]; !ok || u.Name != "" {
		t.Fatalf("ghost = %+v (present %v), want an entry with an empty name", u, ok)
	}
	if calls := gh.UserLookups(); calls != 1 {
		t.Fatalf("UserLookups = %d, want 1 (one batched call)", calls)
	}
	if seen := gh.UserLoginsSeen(); len(seen) != 2 {
		t.Fatalf("looked up %v, want the two distinct logins (deduped)", seen)
	}

	m.DisplayNames(context.Background(), []string{"dennissloove", "ghost"})
	if calls := gh.UserLookups(); calls != 1 {
		t.Fatalf("UserLookups = %d after a repeat call, want still 1 (cached, misses included)", calls)
	}
}

// TestDisplayNamesSkipsNonUsers proves the skip-list never reaches GitHub: the
// "reviewer" sentinel the UI stores as its own comments' author, a bot login,
// and the empty string are all guaranteed misses.
func TestDisplayNamesSkipsNonUsers(t *testing.T) {
	gh := &github.Fake{}
	m, _ := nameManager(t, gh, "")

	got := m.DisplayNames(context.Background(), []string{"reviewer", "kilo-code-bot[bot]", ""})
	if len(got) != 0 {
		t.Fatalf("DisplayNames = %v, want no entries for skipped logins", got)
	}
	if calls := gh.UserLookups(); calls != 0 {
		t.Fatalf("UserLookups = %d, want 0 (skipped before any GitHub call)", calls)
	}
}

// TestDisplayNamesOverrideWinsOffline proves names.json alone is enough: with no
// GitHub client at all the local map still resolves a name (and an unlisted
// login still gets an entry, with an empty name, so the frontend falls back to
// the login).
func TestDisplayNamesOverrideWinsOffline(t *testing.T) {
	gh := &github.Fake{}
	gh.SetUser(github.User{Login: "dennissloove", Name: "Ignored Profile Name"})
	m, _ := nameManager(t, gh, `{"dennissloove":"Dennis Sloove"}`)

	got := m.DisplayNames(context.Background(), []string{"dennissloove", "alice"})
	if got["dennissloove"].Name != "Dennis Sloove" {
		t.Fatalf("dennissloove = %+v, want the names.json override to win", got["dennissloove"])
	}
	if u, ok := got["alice"]; !ok || u.Name != "" {
		t.Fatalf("alice = %+v (present %v), want an empty name", u, ok)
	}
}

// TestHandleNames covers the read-only endpoint: it always answers 200 with a
// names map, and an empty/absent logins param is not an error.
func TestHandleNames(t *testing.T) {
	gh := &github.Fake{}
	gh.SetUser(github.User{Login: "dennissloove", Name: "Dennis Sloove"})
	m, _ := nameManager(t, gh, "")
	s := &server{tasks: &tasks{manager: m}}

	rec := httptest.NewRecorder()
	s.handleNames(rec, httptest.NewRequest(http.MethodGet, "/api/names?logins=dennissloove,%20,ghost", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body struct {
		OK    bool                   `json:"ok"`
		Names map[string]displayUser `json:"names"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || body.Names["dennissloove"].Name != "Dennis Sloove" {
		t.Fatalf("body = %+v, want ok + the resolved name", body)
	}

	rec2 := httptest.NewRecorder()
	s.handleNames(rec2, httptest.NewRequest(http.MethodGet, "/api/names", nil))
	if rec2.Code != http.StatusOK {
		t.Fatalf("status without logins = %d, want 200", rec2.Code)
	}
}
