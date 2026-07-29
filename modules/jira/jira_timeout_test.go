package jira

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeSlowBinary writes an executable shell script named name into a fresh
// temp dir that just sleeps, and prepends that dir to PATH for the duration
// of the test — so exec.CommandContext("acli", ...) resolves to this fake,
// hanging "acli" instead of (or in the absence of) the real CLI.
func writeSlowBinary(t *testing.T, name string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\nsleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// TestModuleEnforcesOwnTimeout proves that Module.Issue/AssignedToMe bound a
// hung acli themselves — even when called with a bare context.Background()
// that carries no deadline of its own. Without the module's own cliTimeout,
// this would hang for the full 30s the fake binary sleeps (or forever, for a
// real acli stuck on an interactive prompt); with it, the call must return an
// error quickly. cliTimeout is temporarily shrunk so the test doesn't have to
// wait out a real-world value.
func TestModuleEnforcesOwnTimeout(t *testing.T) {
	writeSlowBinary(t, "acli")

	orig := cliTimeout
	cliTimeout = 50 * time.Millisecond
	t.Cleanup(func() { cliTimeout = orig })

	m := New()

	start := time.Now()
	if _, err := m.Issue(context.Background(), "ABC-1"); err == nil {
		t.Fatal("want error from a timed-out Issue call")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("Issue took %s, want it bounded by the module's own timeout, not the fake binary's 30s sleep", elapsed)
	}

	start = time.Now()
	if _, err := m.AssignedToMe(context.Background()); err == nil {
		t.Fatal("want error from a timed-out AssignedToMe call")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("AssignedToMe took %s, want it bounded by the module's own timeout, not the fake binary's 30s sleep", elapsed)
	}
}
