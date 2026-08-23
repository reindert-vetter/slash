package main

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/commentignore"
	"slash/modules/github"
)

// newIgnoreCommentManager builds a TaskManager with only the commentignore
// store wired (post-construction, like newTasks does), which is all the
// ignore_comment workflow touches.
func newIgnoreCommentManager(t *testing.T) (*TaskManager, *tembed.Engine, *commentignore.Module) {
	t.Helper()
	ci, err := commentignore.Open(filepath.Join(t.TempDir(), "commentignore.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ci.Close() })

	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
	m.commentignore = ci
	return m, engine, ci
}

// The ignore_comment workflow end-to-end: EnsureIgnoreComment starts the per-PR
// tracker, an "ignore" Signal drives the saveCommentIgnore Activity, and the
// state lands in the read-model. Signalling ignored=false un-ignores it again.
// EnsureIgnoreComment is idempotent per PR, and separate PRs get separate
// trackers (the per-PR keying the cleanup purge relies on).
func TestIgnoreCommentWorkflow(t *testing.T) {
	m, engine, ci := newIgnoreCommentManager(t)
	ctx := context.Background()
	const pr = 12903

	runID, err := m.EnsureIgnoreComment("", pr)
	if err != nil {
		t.Fatal(err)
	}
	if runID == "" {
		t.Fatal("EnsureIgnoreComment returned empty run ID")
	}

	if err := engine.SignalWorkflow(runID, SignalIgnore, IgnoreCommentSignal{CommentID: "c-1", Ignored: true}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := ci.List(ctx, "", pr)
		return len(got) == 1 && got[0] == "c-1"
	})

	if err := engine.SignalWorkflow(runID, SignalIgnore, IgnoreCommentSignal{CommentID: "c-2", Ignored: true}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := ci.List(ctx, "", pr)
		return len(got) == 2
	})

	// Un-ignore c-1 again.
	if err := engine.SignalWorkflow(runID, SignalIgnore, IgnoreCommentSignal{CommentID: "c-1", Ignored: false}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := ci.List(ctx, "", pr)
		return len(got) == 1 && got[0] == "c-2"
	})

	// Idempotent per PR: a second call reuses the same Execution.
	again, err := m.EnsureIgnoreComment("", pr)
	if err != nil {
		t.Fatal(err)
	}
	if again != runID {
		t.Fatalf("EnsureIgnoreComment returned a new run ID %q, want reuse of %q", again, runID)
	}

	// A different PR gets its own tracker, and its state stays separate.
	otherRun, err := m.EnsureIgnoreComment("", pr+1)
	if err != nil {
		t.Fatal(err)
	}
	if otherRun == runID {
		t.Fatal("EnsureIgnoreComment reused one tracker across two PRs")
	}
	if got, _ := ci.List(ctx, "", pr+1); len(got) != 0 {
		t.Fatalf("other PR should start empty, got %v", got)
	}
}

// A tracker started before a restart is found again instead of being
// duplicated: the manager's in-memory map is bypassed, so this exercises
// findIgnoreCommentLocked's scan over the engine's runs.
func TestEnsureIgnoreCommentReusesRunAfterRestart(t *testing.T) {
	m, _, _ := newIgnoreCommentManager(t)
	const pr = 7

	runID, err := m.EnsureIgnoreComment("", pr)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate a fresh process: same engine/store, no cached Run ID.
	m.ignRuns = map[prKey]string{}
	again, err := m.EnsureIgnoreComment("", pr)
	if err != nil {
		t.Fatal(err)
	}
	if again != runID {
		t.Fatalf("after restart got run ID %q, want the existing %q", again, runID)
	}
}
