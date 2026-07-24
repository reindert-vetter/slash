package main

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/github"
	"slash/modules/tasksnooze"
)

// The task_snooze workflow end-to-end: EnsureTaskSnooze starts the per-repo
// tracker, a "snooze" Signal drives the saveTaskSnooze Activity, and the state
// lands in the read-model. A Clear signal un-snoozes it. EnsureTaskSnooze is
// idempotent.
func TestTaskSnoozeWorkflow(t *testing.T) {
	ts, err := tasksnooze.Open(filepath.Join(t.TempDir(), "tasksnooze.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer ts.Close()

	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, ts, nil, nil, nil, "", "test/repo")

	ctx := context.Background()
	runID, err := m.EnsureTaskSnooze()
	if err != nil {
		t.Fatal(err)
	}
	if runID == "" {
		t.Fatal("EnsureTaskSnooze returned empty run ID")
	}

	// Snooze task-42 forever (until 0).
	if err := engine.SignalWorkflow(runID, SignalSnooze, SnoozeSignal{TaskID: "task-42", Until: 0}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := ts.List(ctx)
		return len(got) == 1 && got[0].TaskID == "task-42" && got[0].Until == 0
	})

	// Snooze task-7 until a fixed timestamp.
	if err := engine.SignalWorkflow(runID, SignalSnooze, SnoozeSignal{TaskID: "task-7", Until: 1_700_000_000_000}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := ts.List(ctx)
		return len(got) == 2
	})

	// Clear task-42 (un-snooze).
	if err := engine.SignalWorkflow(runID, SignalSnooze, SnoozeSignal{TaskID: "task-42", Clear: true}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := ts.List(ctx)
		return len(got) == 1 && got[0].TaskID == "task-7"
	})

	// EnsureTaskSnooze is idempotent: a second call reuses the same Execution.
	again, err := m.EnsureTaskSnooze()
	if err != nil {
		t.Fatal(err)
	}
	if again != runID {
		t.Fatalf("EnsureTaskSnooze returned a new run ID %q, want reuse of %q", again, runID)
	}
}
