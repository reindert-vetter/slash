package github

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeSlowBinary writes an executable shell script named name into a fresh
// temp dir that just sleeps, and prepends that dir to PATH for the duration
// of the test — so exec.CommandContext("gh", ...) resolves to this fake,
// hanging "gh" instead of (or in the absence of) the real CLI.
func writeSlowBinary(t *testing.T, name string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\nsleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// TestModuleEnforcesOwnTimeout proves that Module's gh calls bound a hung gh
// themselves, even with a bare context.Background() carrying no deadline of
// its own — covering both the shared api() choke point (CurrentUser) and one
// of the standalone `gh api graphql` call sites (prNodeID, via
// MarkReadyForReview). cliTimeout is temporarily shrunk so the test doesn't
// have to wait out the real-world value.
func TestModuleEnforcesOwnTimeout(t *testing.T) {
	writeSlowBinary(t, "gh")

	orig := cliTimeout
	cliTimeout = 50 * time.Millisecond
	t.Cleanup(func() { cliTimeout = orig })

	m := New("owner/repo")

	start := time.Now()
	if _, err := m.CurrentUser(context.Background()); err == nil {
		t.Fatal("want error from a timed-out CurrentUser call")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("CurrentUser took %s, want it bounded by the module's own timeout, not the fake binary's 30s sleep", elapsed)
	}

	start = time.Now()
	if err := m.MarkReadyForReview(context.Background(), 1); err == nil {
		t.Fatal("want error from a timed-out MarkReadyForReview call")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("MarkReadyForReview took %s, want it bounded by the module's own timeout, not the fake binary's 30s sleep", elapsed)
	}
}
