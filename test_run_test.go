package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/reindert-vetter/tembed"

	"slash/modules/claude"
)

// TestParseTestRunMarkers covers the marker contract test_run.md fixes: the
// four kinds, a trailing note that may be empty, and prose that must NOT be
// mistaken for a marker.
func TestParseTestRunMarkers(t *testing.T) {
	text := strings.Join([]string{
		"Ik kijk eerst naar composer.json.",
		"[slash:plan] draai OrderTest.php, want die raakt de gewijzigde code",
		"[slash:test-start] tests/OrderTest.php",
		"[slash:test-pass] tests/OrderTest.php",
		"[slash:test-start] tests/PaymentTest::testRefund",
		"[slash:test-fail] tests/PaymentTest::testRefund assertion mismatch op refund-bedrag",
		"slash:test-pass tests/Other.php — geen marker, gewone tekst",
	}, "\n")
	got := parseTestRunMarkers(text)
	if len(got) != 5 {
		t.Fatalf("want 5 markers, got %d (%+v)", len(got), got)
	}
	if got[0].Kind != testRunMarkerPlan || got[0].Note != "draai OrderTest.php, want die raakt de gewijzigde code" {
		t.Errorf("plan marker: %+v", got[0])
	}
	if got[1].Kind != testRunMarkerStart || got[1].Name != "tests/OrderTest.php" {
		t.Errorf("start marker: %+v", got[1])
	}
	if got[2].Kind != testRunMarkerPass || got[2].Name != "tests/OrderTest.php" {
		t.Errorf("pass marker: %+v", got[2])
	}
	if got[3].Kind != testRunMarkerStart || got[3].Name != "tests/PaymentTest::testRefund" {
		t.Errorf("second start marker: %+v", got[3])
	}
	if got[4].Kind != testRunMarkerFail || got[4].Name != "tests/PaymentTest::testRefund" || got[4].Note != "assertion mismatch op refund-bedrag" {
		t.Errorf("fail marker: %+v", got[4])
	}
}

// TestTestRunProgressLifecycle covers the parts of test_run_progress.go that
// differ from comment_batch_progress.go's own precedent: items are NOT
// pre-seeded (a test's name is only known once Claude announces it), and a
// still-"busy" item at the end of the run becomes "interrupted" rather than
// silently vanishing or reading as passed.
func TestTestRunProgressLifecycle(t *testing.T) {
	const repo, pr = "", 999001
	t.Cleanup(func() {
		testRunMu.Lock()
		delete(testRunByPR, prKey{repo, pr})
		testRunMu.Unlock()
	})

	startTestRunProgress(repo, pr)
	markTestRunPlan(repo, pr, "draai OrderTest.php")
	markTestRunCurrent(repo, pr, "OrderTest")
	markTestRunOutcome(repo, pr, "OrderTest", testRunStatePass, "")
	markTestRunCurrent(repo, pr, "PaymentTest") // never gets an outcome before finish

	snap, ok := testRunProgressFor(repo, pr)
	if !ok {
		t.Fatal("expected a progress snapshot")
	}
	if snap.Plan != "draai OrderTest.php" || snap.Passed != 1 || snap.Failed != 0 {
		t.Fatalf("snapshot before finish: %+v", snap)
	}

	finishTestRunProgress(repo, pr)
	snap, _ = testRunProgressFor(repo, pr)
	if snap.Running {
		t.Fatal("expected running=false after finish")
	}
	var orderState, paymentState string
	for _, it := range snap.Items {
		switch it.Name {
		case "OrderTest":
			orderState = it.State
		case "PaymentTest":
			paymentState = it.State
		}
	}
	if orderState != testRunStatePass {
		t.Errorf("OrderTest state = %q, want pass", orderState)
	}
	if paymentState != testRunStateInterrupted {
		t.Errorf("PaymentTest state = %q, want interrupted (never got a pass/fail marker)", paymentState)
	}
}

// TestRunTestRunCancelWhileWaitingForWriteSlot guards a bug where a reviewer's
// "Stop" click during the very first phase — before the CLI is even
// invoked, still holding the write-turn slot's onWaiting callback
// (chatPhaseWaiting, shown as "Werkmap klaarzetten…") — cancelled the run but
// never marked the volatile snapshot as Cancelled. finishTestRunProgress's
// defer still ran (Running -> false), so the status line fell through to
// "Klaar — 0 geslaagd, 0 mislukt" instead of "Afgebroken op jouw verzoek" —
// indistinguishable from a run that quietly did nothing.
func TestRunTestRunCancelWhileWaitingForWriteSlot(t *testing.T) {
	const repo, pr = "", 999002
	t.Cleanup(func() {
		testRunMu.Lock()
		delete(testRunByPR, prKey{repo, pr})
		testRunMu.Unlock()
	})

	// Hold this PR's own write-turn slot so runTestRun's own
	// acquireWriteTurnSlot call has to wait for it, exactly like a concurrent
	// code-editing chat turn on the SAME PR would.
	dataDir := t.TempDir()
	release := acquireWriteTurnSlot(context.Background(), checkoutWriteSlotKey(dataDir, repo, pr), nil)
	defer release()

	done := make(chan testRunResult, 1)
	go func() {
		done <- runTestRun(context.Background(), &TaskManager{}, claude.NewFake(), dataDir, testRunArg{Repo: repo, PR: pr})
	}()

	// Wait until the run actually registered itself as waiting for the slot.
	waitFor(t, func() bool {
		snap, ok := testRunProgressFor(repo, pr)
		return ok && snap.Phase == chatPhaseWaiting
	})

	if !cancelChatTurn(testRunCancelID(pr)) {
		t.Fatal("expected a registered cancel func while the run is waiting for the write slot")
	}

	select {
	case res := <-done:
		if !res.Cancelled {
			t.Fatalf("expected the Activity result to report Cancelled, got %+v", res)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("runTestRun never returned after cancel")
	}

	snap, ok := testRunProgressFor(repo, pr)
	if !ok {
		t.Fatal("expected a progress snapshot")
	}
	if snap.Running {
		t.Fatal("expected running=false after the run returned")
	}
	if !snap.Cancelled {
		t.Fatal("expected the volatile snapshot's Cancelled flag to be set — this is what the status line reads")
	}
}

// initGitRepoWithUntracked creates a throwaway git repo with one tracked file
// (committed) and one untracked file — good enough for `git clean -ndx` to
// have something real to report, without needing an actual test framework.
func initGitRepoWithUntracked(t *testing.T, untrackedRelPath string) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-q")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "test")
	if err := os.WriteFile(filepath.Join(dir, "tracked.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "tracked.txt")
	run("commit", "-q", "-m", "init")
	full := filepath.Join(dir, untrackedRelPath)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte("residue"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// registerFakeTestRunWorkflow overrides the WorkflowTestRun definition on
// this test's own engine (RegisterWorkflow simply replaces the map entry, see
// tembed/engine.go) with a one-shot, no-Activity workflow that returns res
// immediately — letting the test drive test_run's OWN result shape onto a
// real, StatusCompleted run without invoking the real claude.Client at all.
func registerFakeTestRunWorkflow(engine *tembed.Engine, res testRunResult) {
	engine.RegisterWorkflow(WorkflowTestRun, func(w *tembed.Workflow, input []byte) ([]byte, error) {
		return json.Marshal(res)
	})
}

// TestSweepTestRunResidueAgeGate proves the core reviewer decision: residue
// older than testRunResidueAge is removed (together with its run record),
// residue younger than that is left completely alone — both the files on
// disk and the run record, so the "resten" warning stays visible until it's
// actually stale.
func TestSweepTestRunResidueAgeGate(t *testing.T) {
	ctm := newCleanupTestManager(t)
	ctx := context.Background()

	oldDir := initGitRepoWithUntracked(t, "cache/phpunit.result.cache")
	// Use the real collectTestRunResidue rather than a hand-typed path: git
	// reports a wholly-untracked directory as one unit ("cache/"), not its
	// individual files — the same value production code would actually record.
	oldResidueDir, oldResiduePaths := collectTestRunResidue(ctx, oldDir)
	if oldResidueDir == "" || len(oldResiduePaths) == 0 {
		t.Fatalf("expected residue in %s, got dir=%q paths=%v", oldDir, oldResidueDir, oldResiduePaths)
	}
	registerFakeTestRunWorkflow(ctm.mgr.engine, testRunResult{
		Passed: 1, ResidueDir: oldResidueDir, ResiduePaths: oldResiduePaths,
	})
	oldRunID, err := ctm.mgr.engine.StartWorkflow(WorkflowTestRun, TestRunInput{PR: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := ctm.store.SetStatus(oldRunID, tembed.StatusCompleted, time.Now().Add(-testRunResidueAge-time.Hour)); err != nil {
		t.Fatal(err)
	}

	freshDir := initGitRepoWithUntracked(t, "cache/phpunit.result.cache")
	freshResidueDir, freshResiduePaths := collectTestRunResidue(ctx, freshDir)
	registerFakeTestRunWorkflow(ctm.mgr.engine, testRunResult{
		Passed: 1, ResidueDir: freshResidueDir, ResiduePaths: freshResiduePaths,
	})
	freshRunID, err := ctm.mgr.engine.StartWorkflow(WorkflowTestRun, TestRunInput{PR: 2})
	if err != nil {
		t.Fatal(err)
	}
	// Left at whatever UpdatedAt StartWorkflow's own completion set — that's
	// "just now", well inside testRunResidueAge.

	res, err := ctm.mgr.StartCleanup(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if res.TestRunResidueSwept != 1 {
		t.Fatalf("TestRunResidueSwept = %d, want 1", res.TestRunResidueSwept)
	}

	if _, err := os.Stat(filepath.Join(oldDir, "cache")); !os.IsNotExist(err) {
		t.Errorf("old residue dir still present (err=%v)", err)
	}
	if _, err := ctm.mgr.engine.Status(oldRunID); err == nil {
		t.Error("old test_run run record still present after sweep")
	}

	if _, err := os.Stat(filepath.Join(freshDir, "cache", "phpunit.result.cache")); err != nil {
		t.Errorf("fresh residue file was removed too early: %v", err)
	}
	if _, err := ctm.mgr.engine.Status(freshRunID); err != nil {
		t.Errorf("fresh test_run run record was deleted too early: %v", err)
	}
}
