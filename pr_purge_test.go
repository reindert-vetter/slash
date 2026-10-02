package main

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/reindert-vetter/tembed"

	"slash/modules/prignore"
)

// The merge sweep purges everything of a PR seen merged/closed.
func TestMergeSweepPurgesDonePR(t *testing.T) {
	ctm := newCleanupTestManager(t)
	const pr = 61
	ctm.seedAllPRData(t, pr)
	statusRun, err := ctm.mgr.EnsurePRStatus("", pr)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { st, _ := ctm.mgr.engine.Status(statusRun); return st == tembed.StatusWaiting })

	ctm.gh.SetPRState("closed")
	ctm.mgr.runPRMergeSweepOnce(context.Background())

	if worktreesExist(ctm.dataDir, pr) {
		t.Fatal("worktrees survived")
	}
	if blocks, _ := blocksByPR(ctm.graphDB, "", pr); len(blocks) != 0 {
		t.Fatal("blocks survived")
	}
	if list, _ := ctm.comments.List(context.Background(), "", pr); len(list) != 0 {
		t.Fatal("comments survived")
	}
}

// Negeren purges the PR's data, but the pr_ignore tracker (and the ignore row)
// survive, and so does a snooze-free other PR.
func TestIgnorePurgesPRButNotItsOwnTracker(t *testing.T) {
	ctm := newCleanupTestManager(t)
	const pr, other = 62, 63
	ctm.seedAllPRData(t, pr)
	ctm.seedAllPRData(t, other)
	pi, err := prignore.Open(filepath.Join(t.TempDir(), "prignore.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pi.Close() })
	ctm.mgr.prignore = pi

	runID, err := ctm.mgr.EnsurePrIgnore()
	if err != nil {
		t.Fatal(err)
	}
	if err := ctm.mgr.engine.SignalWorkflow(runID, SignalPrIgnore, PrIgnoreSignal{PR: pr, Ignore: true}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return !worktreesExist(ctm.dataDir, pr) })

	if blocks, _ := blocksByPR(ctm.graphDB, "", pr); len(blocks) != 0 {
		t.Fatal("ignored PR's blocks survived")
	}
	if blocks, _ := blocksByPR(ctm.graphDB, "", other); len(blocks) == 0 {
		t.Fatal("another PR's blocks were removed")
	}
	if st, err := ctm.mgr.engine.Status(runID); err != nil || st == tembed.StatusCompleted {
		t.Fatalf("pr_ignore tracker status = %q (err %v), want still running/waiting", st, err)
	}
	if got, _ := ctm.mgr.PrIgnores(context.Background()); len(got) != 1 {
		t.Fatalf("ignores = %+v, want 1", got)
	}
}
