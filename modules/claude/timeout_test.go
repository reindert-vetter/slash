package claude

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeSlowBinary writes an executable shell script named name into a fresh
// temp dir that just sleeps, and prepends that dir to PATH for the duration
// of the test — so exec.CommandContext("claude", ...) resolves to this fake,
// hanging "claude" instead of (or in the absence of) the real CLI.
func writeSlowBinary(t *testing.T, name string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\nsleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// TestModuleEnforcesOwnTimeout proves that Module.Run bounds a hung `claude`
// itself, even with a bare context.Background() carrying no deadline of its
// own — for both the context-only (no Tools) and the agentic (Tools set)
// branch, since they use different timeout vars. Both vars are temporarily
// shrunk so the test doesn't have to wait out the real-world values.
func TestModuleEnforcesOwnTimeout(t *testing.T) {
	writeSlowBinary(t, "claude")

	origCtx, origAgentic := contextTimeout, agenticTimeout
	contextTimeout = 50 * time.Millisecond
	agenticTimeout = 50 * time.Millisecond
	t.Cleanup(func() {
		contextTimeout, agenticTimeout = origCtx, origAgentic
	})

	m := New("")

	start := time.Now()
	if _, err := m.Run(context.Background(), RunRequest{Model: ModelHaiku, Prompt: "hi"}); err == nil {
		t.Fatal("want error from a timed-out context-only Run call")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("context-only Run took %s, want it bounded by contextTimeout, not the fake binary's 30s sleep", elapsed)
	}

	start = time.Now()
	if _, err := m.Run(context.Background(), RunRequest{Model: ModelSonnet, Prompt: "hi", Tools: []string{"Read"}}); err == nil {
		t.Fatal("want error from a timed-out agentic Run call")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("agentic Run took %s, want it bounded by agenticTimeout, not the fake binary's 30s sleep", elapsed)
	}
}
