package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// TestDataInboxSnapshotMissingIsNotA404 is the regression guard for the
// console-error sweep finding: on a fresh datadir, loadInbox's
// (src/overview.mjs) fallback fetch of /data/inbox.json — hit on every page
// load until pr_inbox has fetched its first live snapshot — used to bubble a
// bare static-file 404 to the browser console for no functional reason (the
// client already treats a non-ok response as "no luck", see applyCached).
// This asserts the route now answers 200 with the same "no data" shape
// /api/inbox itself uses when there is no snapshot yet.
func TestDataInboxSnapshotMissingIsNotA404(t *testing.T) {
	staticDir := t.TempDir()

	srv := &server{}
	req := httptest.NewRequest(http.MethodGet, "/data/inbox.json", nil)
	rec := httptest.NewRecorder()
	srv.routes(staticDir).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (a missing snapshot must not 404)", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON: %v (%q)", err, rec.Body.String())
	}
	if ok, _ := body["ok"].(bool); ok {
		t.Fatalf("expected ok:false for a missing snapshot, got %v", body)
	}
}

// TestDataInboxSnapshotServesRealFile asserts a genuinely present snapshot
// file is still served as-is — this route must not shadow a real fixture.
func TestDataInboxSnapshotServesRealFile(t *testing.T) {
	staticDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(staticDir, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	want := `{"ok":true,"repo":"","prs":[]}`
	if err := os.WriteFile(filepath.Join(staticDir, "data", "inbox.json"), []byte(want), 0o644); err != nil {
		t.Fatal(err)
	}

	srv := &server{}
	req := httptest.NewRequest(http.MethodGet, "/data/inbox.json", nil)
	rec := httptest.NewRecorder()
	srv.routes(staticDir).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Body.String() != want {
		t.Fatalf("body = %q, want %q", rec.Body.String(), want)
	}
}
