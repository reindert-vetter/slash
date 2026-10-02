package main

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/github"
	"slash/modules/prignore"
)

// pr_ignore end-to-end against a real (temp) prignore store: an ignore Signal
// lands a row, ignore=false removes it, EnsurePrIgnore reuses its run.
func TestPrIgnoreWorkflow(t *testing.T) {
	pi, err := prignore.Open(filepath.Join(t.TempDir(), "prignore.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pi.Close() })
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
	m.prignore = pi
	ctx := context.Background()

	runID, err := m.EnsurePrIgnore()
	if err != nil || runID == "" {
		t.Fatalf("EnsurePrIgnore = %q, %v", runID, err)
	}
	if again, _ := m.EnsurePrIgnore(); again != runID {
		t.Fatalf("second run started: %q vs %q", again, runID)
	}
	if err := engine.SignalWorkflow(runID, SignalPrIgnore, PrIgnoreSignal{PR: 42, Ignore: true}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := m.PrIgnores(ctx)
		return len(got) == 1 && got[0].PR == 42
	})
	if err := engine.SignalWorkflow(runID, SignalPrIgnore, PrIgnoreSignal{PR: 42, Ignore: false}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := m.PrIgnores(ctx)
		return len(got) == 0
	})
}
