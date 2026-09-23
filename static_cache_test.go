package main

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// TestStaticAssetsAreNoCache guards the Cache-Control header on the HTML shells
// and /src/* modules: without it the browser's heuristic freshness can mix a
// stale module with a fresh importer and leave the page blank (see serveFile).
func TestStaticAssetsAreNoCache(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"index.html", "src/x.mjs"} {
		if err := os.WriteFile(filepath.Join(dir, f), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mux := (&server{}).routes(dir)
	for _, path := range []string{"/pr/1", "/src/x.mjs"} {
		rr := httptest.NewRecorder()
		mux.ServeHTTP(rr, httptest.NewRequest("GET", path, nil))
		if rr.Code != 200 {
			t.Fatalf("%s: status %d", path, rr.Code)
		}
		if got := rr.Header().Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("%s: Cache-Control = %q, want no-cache", path, got)
		}
	}
}
