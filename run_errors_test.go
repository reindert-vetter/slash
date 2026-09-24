package main

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/reindert-vetter/tembed"

	"slash/modules/github"
)

// TestRecordProblemParsesScopeAndPR covers the log mirror's only real logic:
// newest-first order, the "pr=<n>" parse, and the subsystem prefix — with the
// two shapes that motivated this feature (a poller glue error naming a PR, and
// a tembed engine line naming only a run).
func TestRecordProblemParsesScopeAndPR(t *testing.T) {
	resetProblemLog()
	t.Cleanup(resetProblemLog)

	recordProblem("import comments: fetch review comments pr=970099: gh api ...: exit status 1")
	recordProblem("tembed: run gh-3629116956 uses unregistered workflow \"ignore\"")
	recordProblem("   ") // blank lines are never recorded

	got := loggedProblems()
	if len(got) != 2 {
		t.Fatalf("loggedProblems() = %d entries, want 2 (blank line dropped)", len(got))
	}
	// Newest first.
	if !strings.HasPrefix(got[0].Message, "tembed:") {
		t.Fatalf("first entry = %q, want the most recently recorded line", got[0].Message)
	}
	if got[0].Scope != "tembed" || got[0].PR != 0 {
		t.Fatalf("engine line = scope %q pr %d, want \"tembed\" and 0", got[0].Scope, got[0].PR)
	}
	if got[1].Scope != "import comments" || got[1].PR != 970099 {
		t.Fatalf("glue line = scope %q pr %d, want \"import comments\" and 970099", got[1].Scope, got[1].PR)
	}
	if got[1].At.IsZero() {
		t.Fatal("entry has no timestamp")
	}
}

// TestProblemLogRingBufferCaps proves the buffer is bounded: the oldest lines
// fall out, the newest survive. It is in-memory only, so unbounded growth
// would be a slow leak in a long-running server.
func TestProblemLogRingBufferCaps(t *testing.T) {
	resetProblemLog()
	t.Cleanup(resetProblemLog)

	for i := 0; i < problemLogCap+25; i++ {
		recordProblem("pr_status: skipped no=" + strconv.Itoa(i))
	}
	got := loggedProblems()
	if len(got) != problemLogCap {
		t.Fatalf("buffer holds %d entries, want the cap %d", len(got), problemLogCap)
	}
	if !strings.HasSuffix(got[0].Message, "no="+strconv.Itoa(problemLogCap+24)) {
		t.Fatalf("newest entry = %q, want the last recorded line", got[0].Message)
	}
	if strings.HasSuffix(got[len(got)-1].Message, "no=0") {
		t.Fatal("oldest line survived the cap, want it dropped")
	}
}

// TestMirrorManagerLogsFeedsBuffer proves the single-funnel wrapper works: any
// TaskManager.logf call lands in the buffer *and* still reaches the original
// log function, so nothing disappears from the terminal.
func TestMirrorManagerLogsFeedsBuffer(t *testing.T) {
	resetProblemLog()
	t.Cleanup(resetProblemLog)

	m := NewTaskManager(tembed.New(tembed.NewMemoryStore()), &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
	var seen []string
	m.logf = func(format string, args ...any) { seen = append(seen, format) }
	mirrorManagerLogs(m)

	m.logf("import comments: fetch review comments pr=%d: %v", 4321, errors.New("boom"))

	if len(seen) != 1 {
		t.Fatalf("original log function called %d times, want 1 (the wrapper must not swallow it)", len(seen))
	}
	got := loggedProblems()
	if len(got) != 1 || got[0].PR != 4321 || !strings.Contains(got[0].Message, "boom") {
		t.Fatalf("buffer = %+v, want one entry for pr 4321 carrying the error text", got)
	}
}

// TestFailedRunsReportsOnlyFailures proves the durable half: a run that ended
// in `failed` comes back with its PR + recorded error message, a completed run
// never does, and a repo-wide run (no "pr" in its input) is included with PR 0
// — the case RunsForPR structurally cannot report.
func TestFailedRunsReportsOnlyFailures(t *testing.T) {
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

	engine.RegisterWorkflow("test_boom", func(w *tembed.Workflow, input []byte) ([]byte, error) {
		return nil, errors.New("kaboom in the activity")
	})
	engine.RegisterWorkflow("test_fine", func(w *tembed.Workflow, input []byte) ([]byte, error) {
		return nil, nil
	})

	// StartWorkflow reports the run ID, not the workflow's own failure — the
	// run is simply recorded as `failed`, which is exactly the state
	// FailedRuns reads.
	failedID, _ := engine.StartWorkflow("test_boom", struct {
		PR int `json:"pr"`
	}{PR: 12903})
	if failedID == "" {
		t.Fatal("no run ID for the failed run")
	}
	if status, _ := engine.Status(failedID); status != tembed.StatusFailed {
		t.Fatalf("run status = %q, want failed", status)
	}
	repoWideID, _ := engine.StartWorkflow("test_boom", struct {
		Repo string `json:"repo"`
	}{Repo: "test/repo"})
	if repoWideID == "" {
		t.Fatal("no run ID for the repo-wide failed run")
	}
	if _, err := engine.StartWorkflow("test_fine", struct {
		PR int `json:"pr"`
	}{PR: 999}); err != nil {
		t.Fatal(err)
	}

	got := m.FailedRuns(failedRunCap)
	if len(got) != 2 {
		t.Fatalf("FailedRuns = %d runs, want 2 (the completed run must not appear)", len(got))
	}
	byID := map[string]FailedRun{}
	for _, f := range got {
		byID[f.RunID] = f
	}
	prScoped, ok := byID[failedID]
	if !ok {
		t.Fatalf("failed run %s missing from %+v", failedID, got)
	}
	if prScoped.PR != 12903 {
		t.Fatalf("PR = %d, want 12903 (parsed from the run input)", prScoped.PR)
	}
	if !strings.Contains(prScoped.Error, "kaboom in the activity") {
		t.Fatalf("Error = %q, want the recorded failure message", prScoped.Error)
	}
	if prScoped.Workflow != "test_boom" {
		t.Fatalf("Workflow = %q, want test_boom", prScoped.Workflow)
	}
	repoWide, ok := byID[repoWideID]
	if !ok {
		t.Fatalf("repo-wide failed run %s missing from %+v", repoWideID, got)
	}
	if repoWide.PR != 0 {
		t.Fatalf("repo-wide run PR = %d, want 0", repoWide.PR)
	}

	// The limit is honoured (newest-updated first).
	if one := m.FailedRuns(1); len(one) != 1 {
		t.Fatalf("FailedRuns(1) = %d runs, want 1", len(one))
	}
}

// TestFailedRunsHidesSupersededRun covers the "later attempt took over" filter:
// a failed run disappears once the same task ran again (workflow+pr identity,
// including the repo-wide pr=0 shape), while a per-item deterministic-Run-ID
// workflow — where a retry is structurally impossible — always keeps showing,
// even when a sibling item on the same PR succeeded.
func TestFailedRunsHidesSupersededRun(t *testing.T) {
	clock := time.Now()
	engine := tembed.New(tembed.NewMemoryStore(), tembed.WithClock(func() time.Time { return clock }))
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

	boom := func(w *tembed.Workflow, input []byte) ([]byte, error) { return nil, errors.New("boom") }
	fine := func(w *tembed.Workflow, input []byte) ([]byte, error) { return nil, nil }
	engine.RegisterWorkflow(WorkflowPRStatus, boom)
	engine.RegisterWorkflow(WorkflowCleanup, boom)
	engine.RegisterWorkflow(WorkflowTaskCodeComment, boom)
	engine.RegisterWorkflow("test_fine", fine)

	type prInput struct {
		PR int `json:"pr"`
	}
	// tick advances the shared clock so the next run is unambiguously newer.
	tick := func() { clock = clock.Add(time.Minute) }

	// (1) a failed pr_status for PR 1 — later replaced by a live one.
	stale, _ := engine.StartWorkflow(WorkflowPRStatus, prInput{PR: 1})
	// (2) a failed pr_status for PR 2 — never replaced, so it must stay.
	tick()
	lonely, _ := engine.StartWorkflow(WorkflowPRStatus, prInput{PR: 2})
	// (3) two failed comment threads on PR 1 (deterministic Run IDs).
	tick()
	comment, _ := engine.StartWorkflowID("comment-a", WorkflowTaskCodeComment, prInput{PR: 1})
	engine.StartWorkflowID("comment-b", WorkflowTaskCodeComment, prInput{PR: 1})
	// (4) a failed repo-wide cleanup pass — later replaced by a good one.
	tick()
	staleCleanup, _ := engine.StartWorkflow(WorkflowCleanup, struct{}{})

	// The successors, all created after their failed predecessor.
	tick()
	engine.RegisterWorkflow(WorkflowPRStatus, fine)
	engine.RegisterWorkflow(WorkflowCleanup, fine)
	if _, err := engine.StartWorkflow(WorkflowPRStatus, prInput{PR: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.StartWorkflow(WorkflowCleanup, struct{}{}); err != nil {
		t.Fatal(err)
	}
	// A succeeded comment thread on PR 1 must NOT hide the failed ones.
	engine.RegisterWorkflow(WorkflowTaskCodeComment, fine)
	if _, err := engine.StartWorkflowID("comment-ok", WorkflowTaskCodeComment, prInput{PR: 1}); err != nil {
		t.Fatal(err)
	}

	got := map[string]bool{}
	for _, f := range m.FailedRuns(failedRunCap) {
		got[f.RunID] = true
	}
	if got[stale] {
		t.Errorf("superseded pr_status run %s still listed: %v", stale, got)
	}
	if got[staleCleanup] {
		t.Errorf("superseded repo-wide cleanup run %s still listed: %v", staleCleanup, got)
	}
	if !got[lonely] {
		t.Errorf("pr_status failure without a successor is missing: %v", got)
	}
	if !got[comment] || !got["comment-b"] {
		t.Errorf("a per-item comment failure must never be superseded: %v", got)
	}
}

// TestFailedRunsCarriesCommentRef proves a failed comment thread says WHICH
// comment it was: file/line plus a body snippet, parsed from the run input.
func TestFailedRunsCarriesCommentRef(t *testing.T) {
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
	engine.RegisterWorkflow(WorkflowTaskCodeComment, func(w *tembed.Workflow, input []byte) ([]byte, error) {
		return nil, errors.New("save reaction: database is locked")
	})

	if _, err := engine.StartWorkflowID("c-1", WorkflowTaskCodeComment, CodeCommentInput{
		PR: 13098, File: "src/Billing/Invoice.php", Line: 42, Body: "Kun je hier een guard clause van maken?",
	}); err != nil {
		t.Fatal(err)
	}

	got := m.FailedRuns(failedRunCap)
	if len(got) != 1 || got[0].Comment == nil {
		t.Fatalf("FailedRuns = %+v, want one run carrying a comment ref", got)
	}
	c := got[0].Comment
	if c.File != "src/Billing/Invoice.php" || c.Line != 42 {
		t.Fatalf("comment ref = %+v, want the file/line from the run input", c)
	}
	if !strings.Contains(c.Snippet, "guard clause") {
		t.Fatalf("snippet = %q, want a preview of the comment body", c.Snippet)
	}
}

// TestRetryRunResumesFromLastGoodStep covers the "Opnieuw proberen" path
// behind POST /api/workflows/retry after it changed from "start a fresh
// Execution" to "resume the failed run from its last successful step"
// (Engine.ResumeFailed): the run keeps its own ID, the activities that already
// succeeded are NOT re-executed, and a per-item deterministic Run ID — which
// could not be retried at all before — now works too.
func TestRetryRunResumesFromLastGoodStep(t *testing.T) {
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

	firstRuns, secondRuns := 0, 0
	engine.RegisterActivity("stepOne", func(ctx context.Context, in []byte) ([]byte, error) {
		firstRuns++
		return nil, nil
	})
	engine.RegisterActivity("stepTwo", func(ctx context.Context, in []byte) ([]byte, error) {
		secondRuns++
		if secondRuns == 1 {
			return nil, errors.New("save reaction: database is locked")
		}
		return nil, nil
	})
	flaky := func(w *tembed.Workflow, input []byte) ([]byte, error) {
		if err := w.ExecuteActivity("stepOne", nil, nil); err != nil {
			return nil, err
		}
		if err := w.ExecuteActivity("stepTwo", nil, nil); err != nil {
			return nil, err
		}
		return nil, nil
	}
	engine.RegisterWorkflow("test_flaky", flaky)

	failedID, _ := engine.StartWorkflow("test_flaky", struct {
		PR int `json:"pr"`
	}{PR: 12903})
	if got := m.FailedRuns(failedRunCap); len(got) != 1 || !got[0].Retryable {
		t.Fatalf("FailedRuns = %+v, want exactly one retryable failure", got)
	}
	if firstRuns != 1 || secondRuns != 1 {
		t.Fatalf("activity runs = %d/%d, want 1/1 before the retry", firstRuns, secondRuns)
	}

	sameID, err := m.RetryRun(failedID)
	if err != nil {
		t.Fatalf("RetryRun: %v", err)
	}
	if sameID != failedID {
		t.Fatalf("RetryRun returned %q, want the same run %q — it resumes, it does not start a new run", sameID, failedID)
	}
	if status, _ := engine.Status(failedID); status != tembed.StatusCompleted {
		t.Fatalf("run status after the retry = %q, want completed", status)
	}
	// The whole point: the step that already succeeded was replayed from the
	// history, not executed again; only the failed one ran a second time.
	if firstRuns != 1 {
		t.Fatalf("stepOne ran %d times, want 1 — a resumed run must not redo work that succeeded", firstRuns)
	}
	if secondRuns != 2 {
		t.Fatalf("stepTwo ran %d times, want 2 (the failed step must run again)", secondRuns)
	}
	if got := m.FailedRuns(failedRunCap); len(got) != 0 {
		t.Fatalf("FailedRuns after a successful retry = %+v, want none", got)
	}

	// A per-item deterministic Run ID is retryable now — resuming needs no
	// start, so the idempotence of StartWorkflowID is no longer in the way.
	commentRuns := 0
	engine.RegisterWorkflow(WorkflowTaskCodeComment, func(w *tembed.Workflow, input []byte) ([]byte, error) {
		commentRuns++
		if commentRuns == 1 {
			return nil, errors.New("comment boom")
		}
		return nil, nil
	})
	perItemID, _ := engine.StartWorkflowID("comment-1", WorkflowTaskCodeComment, struct {
		PR int `json:"pr"`
	}{PR: 12903})
	if !retryableWorkflow(WorkflowTaskCodeComment) {
		t.Fatal("retryableWorkflow says a per-item Run ID cannot be retried; resuming needs no fresh start")
	}
	if _, err := m.RetryRun(perItemID); err != nil {
		t.Fatalf("RetryRun on a per-item Run ID: %v", err)
	}
	if status, _ := engine.Status(perItemID); status != tembed.StatusCompleted {
		t.Fatalf("per-item run status after the retry = %q, want completed", status)
	}

	// A run that isn't failed at all, and an unknown one, are still refused.
	if _, err := m.RetryRun(failedID); err == nil {
		t.Fatal("RetryRun accepted an already completed run; want an error")
	}
	if _, err := m.RetryRun("nope"); err == nil {
		t.Fatal("RetryRun accepted an unknown run ID; want an error")
	}
}

// TestRetryAllFailedResumesEveryRow covers the "Alles opnieuw proberen" button
// of the global failed-tasks popup (POST /api/workflows/retry-all): every row
// currently on the list is resumed, and the count reported back is what the
// popup shows.
func TestRetryAllFailedResumesEveryRow(t *testing.T) {
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

	attempts := map[string]int{}
	engine.RegisterWorkflow(WorkflowTaskCodeComment, func(w *tembed.Workflow, input []byte) ([]byte, error) {
		var in struct {
			File string `json:"file"`
		}
		_ = json.Unmarshal(input, &in)
		attempts[in.File]++
		if attempts[in.File] == 1 {
			return nil, errors.New("save reaction: database is locked")
		}
		return nil, nil
	})
	for _, f := range []string{"a.php", "b.php", "c.php"} {
		if _, err := engine.StartWorkflowID("comment-"+f, WorkflowTaskCodeComment, CodeCommentInput{PR: 13098, File: f, Line: 1}); err != nil {
			t.Fatal(err)
		}
	}
	if got := m.FailedRuns(0); len(got) != 3 {
		t.Fatalf("FailedRuns = %d, want 3", len(got))
	}

	retried, skipped := m.RetryAllFailed()
	if retried != 3 || skipped != 0 {
		t.Fatalf("RetryAllFailed = %d retried / %d skipped, want 3/0", retried, skipped)
	}
	if got := m.FailedRuns(0); len(got) != 0 {
		t.Fatalf("FailedRuns after retrying everything = %+v, want none", got)
	}
}

// TestIgnoreFailedRunsDeletesOnlyFailures covers the "Negeer" half of the
// global failed-tasks popup (POST /api/workflows/ignore-runs): a failure the
// reviewer decides needs no action is deleted for good, so it leaves every
// list built on GET /api/problems, while a run that is NOT failed (or an id
// nobody knows) is reported as skipped instead of being torn out.
func TestIgnoreFailedRunsDeletesOnlyFailures(t *testing.T) {
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

	engine.RegisterWorkflow("test_boom", func(w *tembed.Workflow, input []byte) ([]byte, error) {
		return nil, errors.New("save reaction: database is locked")
	})
	engine.RegisterWorkflow("test_fine", func(w *tembed.Workflow, input []byte) ([]byte, error) {
		return nil, nil
	})
	var failed []string
	for i := 0; i < 2; i++ {
		// StartWorkflow drives a signal-less workflow inline and records the
		// failure in its history rather than returning it, exactly as
		// TestRetryAllFailedResumesEveryRow relies on.
		id, _ := engine.StartWorkflow("test_boom", struct {
			PR int `json:"pr"`
		}{PR: 13535})
		failed = append(failed, id)
	}
	okID, err := engine.StartWorkflow("test_fine", struct {
		PR int `json:"pr"`
	}{PR: 13535})
	if err != nil {
		t.Fatal(err)
	}
	if got := m.FailedRuns(0); len(got) != 2 {
		t.Fatalf("FailedRuns = %d, want 2", len(got))
	}

	res, err := m.IgnoreFailedRuns([]string{failed[0], failed[1], okID, "nope"})
	if err != nil {
		t.Fatalf("IgnoreFailedRuns: %v", err)
	}
	if res.Ignored != 2 || res.Skipped != 2 {
		t.Fatalf("IgnoreFailedRuns = %d ignored / %d skipped, want 2/2", res.Ignored, res.Skipped)
	}
	if got := m.FailedRuns(0); len(got) != 0 {
		t.Fatalf("FailedRuns after ignoring everything = %+v, want none", got)
	}
	// The completed run is untouched, and the ignore_runs Execution itself is
	// no new failure on the list.
	if status, err := engine.Status(okID); err != nil || status != tembed.StatusCompleted {
		t.Fatalf("completed run status = %q (%v), want it left alone", status, err)
	}
	for _, id := range failed {
		if _, err := engine.Status(id); err == nil {
			t.Fatalf("ignored run %s still exists; want it deleted", id)
		}
	}
}

// TestFailedRunsDropsRunsOlderThanTheWindow covers problemWindow: a failure
// from beyond the last four days no longer reaches the UI at all (reviewer:
// "ik wil bovenaan van 4 dagen zien"), so it is also not part of "alles
// opnieuw proberen".
func TestFailedRunsDropsRunsOlderThanTheWindow(t *testing.T) {
	clock := time.Now()
	engine := tembed.New(tembed.NewMemoryStore(), tembed.WithClock(func() time.Time { return clock }))
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
	engine.RegisterWorkflow("test_boom", func(w *tembed.Workflow, input []byte) ([]byte, error) {
		return nil, errors.New("boom")
	})

	clock = time.Now().Add(-problemWindow - time.Hour)
	old, _ := engine.StartWorkflow("test_boom", struct {
		PR int `json:"pr"`
	}{PR: 1})
	clock = time.Now().Add(-time.Hour)
	recent, _ := engine.StartWorkflow("test_boom", struct {
		PR int `json:"pr"`
	}{PR: 2})

	got := map[string]bool{}
	for _, f := range m.FailedRuns(0) {
		got[f.RunID] = true
	}
	if got[old] {
		t.Errorf("a failure older than problemWindow is still listed: %v", got)
	}
	if !got[recent] {
		t.Errorf("a failure within problemWindow is missing: %v", got)
	}
}

// TestRunningCountsTalliesPerPR covers the busy-count behind /pr-overview's
// header badge and per-row chip: every unit counts in the total, only a PR-bound
// one in byPR, keyed like the overview's prUid (bare number for the primary
// repo), and an active chat turn counts through the progress map.
func TestRunningCountsTalliesPerPR(t *testing.T) {
	total, byPR := countActive([]activeUnit{{pr: 12}, {pr: 12}, {pr: 0}, {repo: "", pr: 7}})
	if total != 4 {
		t.Fatalf("total = %d, want 4 (a repo-wide unit still counts in the total)", total)
	}
	if byPR["12"] != 2 || byPR["7"] != 1 || len(byPR) != 2 {
		t.Fatalf("byPR = %v, want {12:2, 7:1}", byPR)
	}

	chatProgressMu.Lock()
	saved := chatProgressByConv
	chatProgressByConv = map[string]chatProgress{
		"conv-a": {Running: true, pr: 12},
		"conv-b": {Running: true, pr: 0}, // plan-page turn: no PR, skipped
	}
	chatProgressMu.Unlock()
	t.Cleanup(func() {
		chatProgressMu.Lock()
		chatProgressByConv = saved
		chatProgressMu.Unlock()
	})

	m := NewTaskManager(tembed.New(tembed.NewMemoryStore()), &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
	total, byPR = m.RunningCounts()
	if total != 1 || byPR["12"] != 1 {
		t.Fatalf("RunningCounts() = %d, %v, want 1 and {12:1} from the active chat turn", total, byPR)
	}
}
