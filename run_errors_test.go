package main

import (
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

	m := NewTaskManager(tembed.New(tembed.NewMemoryStore()), &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
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
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

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
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

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
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
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

// TestRetryRunStartsAFreshAttempt covers the "Probeer opnieuw" path behind
// POST /api/workflows/retry: a failed run's own Workflow Type is started again
// with its stored input, which supersedes the failure (so it drops out of
// FailedRuns), while a per-item deterministic-Run-ID type is refused outright —
// starting that one over would be an idempotent no-op, so the row menu says so
// instead (see retryableWorkflow).
func TestRetryRunStartsAFreshAttempt(t *testing.T) {
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

	attempts := 0
	engine.RegisterWorkflow("test_flaky", func(w *tembed.Workflow, input []byte) ([]byte, error) {
		attempts++
		if attempts == 1 {
			return nil, errors.New("first attempt boom")
		}
		return nil, nil
	})

	failedID, _ := engine.StartWorkflow("test_flaky", struct {
		PR int `json:"pr"`
	}{PR: 12903})
	if got := m.FailedRuns(failedRunCap); len(got) != 1 || !got[0].Retryable {
		t.Fatalf("FailedRuns = %+v, want exactly one retryable failure", got)
	}

	newID, err := m.RetryRun(failedID)
	if err != nil {
		t.Fatalf("RetryRun: %v", err)
	}
	if newID == failedID {
		t.Fatal("RetryRun reused the failed run's ID; it must start a fresh Execution")
	}
	if attempts != 2 {
		t.Fatalf("workflow ran %d times, want 2 (the retry must actually run it)", attempts)
	}
	// The fresh attempt succeeded, so the failure is superseded and no longer
	// something the reviewer has to act on.
	if got := m.FailedRuns(failedRunCap); len(got) != 0 {
		t.Fatalf("FailedRuns after a successful retry = %+v, want none", got)
	}
	// The input travelled along verbatim — the retry is the same task, not a
	// blank one.
	in, err := engine.Input(newID)
	if err != nil || !strings.Contains(string(in), "12903") {
		t.Fatalf("retry input = %q (err %v), want the original input", in, err)
	}

	// A per-item Run ID cannot be retried at all.
	engine.RegisterWorkflow(WorkflowTaskCodeComment, func(w *tembed.Workflow, input []byte) ([]byte, error) {
		return nil, errors.New("comment boom")
	})
	perItemID, _ := engine.StartWorkflowID("comment-1", WorkflowTaskCodeComment, struct {
		PR int `json:"pr"`
	}{PR: 12903})
	if retryableWorkflow(WorkflowTaskCodeComment) {
		t.Fatal("retryableWorkflow says a per-item Run ID can be retried")
	}
	if _, err := m.RetryRun(perItemID); err == nil {
		t.Fatal("RetryRun accepted a per-item Run ID; want an error")
	}
	// And neither can a run that isn't failed at all.
	if _, err := m.RetryRun("nope"); err == nil {
		t.Fatal("RetryRun accepted an unknown run ID; want an error")
	}
}
