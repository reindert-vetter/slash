package main

import (
	"errors"
	"strconv"
	"strings"
	"testing"

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
