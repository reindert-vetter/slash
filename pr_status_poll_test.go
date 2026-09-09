package main

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/reindert-vetter/tembed"

	"slash/modules/comments"
	"slash/modules/github"
)

// newPRMergeSweepTestManager builds the minimal manager the sweep needs
// (an engine + a github.Fake), mirroring TestRunsForPR's own construction.
func newPRMergeSweepTestManager(t *testing.T) (*TaskManager, *github.Fake) {
	t.Helper()
	t.Setenv("SLASH_GITHUB", "off")
	pm := testPRMeta(t)
	cs, err := comments.Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	gh := &github.Fake{}
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, cs, testInbox(t), testRelations(t), pm, nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
	return m, gh
}

// TestPRMergeSweepCompletesAMergedTracker reproduces the exact real gap
// (task 56/58, PR 13606): a pr_status tracker sitting `waiting` with no
// comment-thread poller alive to ever notice a merge. runPRMergeSweepOnce
// must complete it on its own, straight from PRState — no poller involved.
func TestPRMergeSweepCompletesAMergedTracker(t *testing.T) {
	m, gh := newPRMergeSweepTestManager(t)
	runID, err := m.EnsurePRStatus("", 13606)
	if err != nil {
		t.Fatal(err)
	}
	// ensurePRStatus starts the tracker via StartWorkflowDeferLow (fire-and-
	// forget: generatePRSummary drains in the background) — wait for it to
	// actually reach `waiting` before sweeping, exactly like a real one would
	// have by the time anything signals it.
	waitFor(t, func() bool { st, _ := m.engine.Status(runID); return st == tembed.StatusWaiting })

	gh.SetPRState("merged")
	m.runPRMergeSweepOnce(context.Background())

	if st, err := m.engine.Status(runID); err != nil || st != tembed.StatusCompleted {
		t.Fatalf("run status after sweep = %q (err %v), want completed", st, err)
	}
}

// TestPRMergeSweepLeavesAnOpenPRAlone is the flip side: a tracker whose PR is
// still genuinely open must stay `waiting` — the sweep is a merge/close
// detector, not something that ever completes a tracker on its own say-so.
func TestPRMergeSweepLeavesAnOpenPRAlone(t *testing.T) {
	m, _ := newPRMergeSweepTestManager(t)
	runID, err := m.EnsurePRStatus("", 202)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { st, _ := m.engine.Status(runID); return st == tembed.StatusWaiting })

	m.runPRMergeSweepOnce(context.Background()) // gh.prState is "" -> reads as "open"

	if st, err := m.engine.Status(runID); err != nil || st != tembed.StatusWaiting {
		t.Fatalf("run status after sweep = %q (err %v), want still waiting", st, err)
	}
}

// TestPRMergeSweepSurvivesAPRStateError proves a live-lookup failure for one
// PR is logged and skipped rather than aborting the whole pass (or panicking)
// — best-effort throughout, exactly like every other background poller in
// this file.
func TestPRMergeSweepSurvivesAPRStateError(t *testing.T) {
	m, gh := newPRMergeSweepTestManager(t)
	runID, err := m.EnsurePRStatus("", 303)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { st, _ := m.engine.Status(runID); return st == tembed.StatusWaiting })

	gh.SetPRStateErr(errors.New("boom"))
	m.runPRMergeSweepOnce(context.Background()) // must not panic

	if st, err := m.engine.Status(runID); err != nil || st != tembed.StatusWaiting {
		t.Fatalf("run status after a PRState error = %q (err %v), want still waiting (untouched)", st, err)
	}
}

// TestPRMergeSweepIgnoresAnAlreadyCompletedRun covers a tracker that
// completed via some OTHER path (a concurrent comment-poller detection, in
// real life) before this sweep ever reaches it: the `Status == StatusWaiting`
// filter skips it outright, so it is never touched (or re-signalled) a
// second time — no crash, no redundant call.
func TestPRMergeSweepIgnoresAnAlreadyCompletedRun(t *testing.T) {
	m, gh := newPRMergeSweepTestManager(t)
	runID, err := m.EnsurePRStatus("", 404)
	if err != nil {
		t.Fatal(err)
	}
	// Complete it through the ordinary path first, exactly like a real
	// concurrent poller would.
	if err := m.engine.SignalWorkflow(runID, SignalPRState, PRStateSignal{State: "closed"}); err != nil {
		t.Fatal(err)
	}
	if st, _ := m.engine.Status(runID); st != tembed.StatusCompleted {
		t.Fatalf("precondition: run status = %q, want completed", st)
	}

	gh.SetPRState("merged")
	m.runPRMergeSweepOnce(context.Background()) // must not panic; the run is already completed

	if st, err := m.engine.Status(runID); err != nil || st != tembed.StatusCompleted {
		t.Fatalf("run status = %q (err %v), want still completed", st, err)
	}
}
