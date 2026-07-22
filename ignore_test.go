package main

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/github"
	"slash/modules/ignore"
)

// The ignore workflow end-to-end: EnsureIgnore starts the per-repo tracker, an
// "ignore" Signal drives the saveIgnore Activity, and the state lands in the
// read-model. A Clear signal un-ignores it. EnsureIgnore is idempotent.
func TestIgnoreWorkflow(t *testing.T) {
	ig, err := ignore.Open(filepath.Join(t.TempDir(), "ignore.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer ig.Close()

	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, ig, nil, nil, nil, "", "test/repo")

	ctx := context.Background()
	runID, err := m.EnsureIgnore()
	if err != nil {
		t.Fatal(err)
	}
	if runID == "" {
		t.Fatal("EnsureIgnore returned empty run ID")
	}

	// Ignore PR 42 forever (until 0).
	if err := engine.SignalWorkflow(runID, SignalIgnore, IgnoreSignal{PR: 42, Until: 0}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := ig.List(ctx, "test/repo")
		return len(got) == 1 && got[0].PR == 42 && got[0].Until == 0
	})

	// Ignore PR 7 until a fixed timestamp.
	if err := engine.SignalWorkflow(runID, SignalIgnore, IgnoreSignal{PR: 7, Until: 1_700_000_000_000}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := ig.List(ctx, "test/repo")
		return len(got) == 2
	})

	// Clear PR 42 (un-ignore).
	if err := engine.SignalWorkflow(runID, SignalIgnore, IgnoreSignal{PR: 42, Clear: true}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := ig.List(ctx, "test/repo")
		return len(got) == 1 && got[0].PR == 7
	})

	// EnsureIgnore is idempotent: a second call reuses the same Execution.
	again, err := m.EnsureIgnore()
	if err != nil {
		t.Fatal(err)
	}
	if again != runID {
		t.Fatalf("EnsureIgnore returned a new run ID %q, want reuse of %q", again, runID)
	}
}

// The preset filter allow-list rejects an unknown key and maps known keys to
// their fixed gh-search expression (never raw UI text). filterPresets is the
// source of truth handleFilter reads.
func TestFilterPresetsAllowList(t *testing.T) {
	if _, ok := filterPresets["definitely-not-a-preset"]; ok {
		t.Fatal("unknown preset key unexpectedly present")
	}
	for _, key := range []string{"updated-oud", "alle-open", "alle-draft", "ouder-3-dagen"} {
		if _, ok := filterPresets[key]; !ok {
			t.Fatalf("preset %q missing from allow-list", key)
		}
	}
	// The date-bounded preset carries a %s placeholder handleFilter fills in.
	if got := filterPresets["ouder-3-dagen"]; !contains(got, "%s") {
		t.Fatalf("ouder-3-dagen preset %q missing date placeholder", got)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
