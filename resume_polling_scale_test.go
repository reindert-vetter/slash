package main

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"

	"github.com/reindert-vetter/tembed"

	"slash/modules/github"
)

// countingStore wraps a tembed.MemoryStore and counts how many times ListRuns
// is called, so a test can assert a caller doesn't rescan the whole run table
// once per item it processes.
type countingStore struct {
	*tembed.MemoryStore
	listRunsCalls atomic.Int64
}

func (s *countingStore) ListRuns() ([]tembed.RunRecord, error) {
	s.listRunsCalls.Add(1)
	return s.MemoryStore.ListRuns()
}

// TestResumePollingDoesNotRescanRunsPerPR guards against the quadratic
// pattern found in production: ResumePolling looping over many waiting
// task_code_comment runs across many distinct PRs, each triggering
// ensurePRStatus -> findPRStatusLocked's own full store.ListRuns() scan
// because m.prRuns starts cold on a restart (ResumePRStatusPolling, which
// populates that cache in one pass, runs AFTER ResumePolling — see
// newTasks in tasks_api.go). Left unfixed this is O(waiting runs * total
// runs). ResumePolling must instead prime m.prRuns from the one runs slice
// it already has, so the whole pass costs a single ListRuns call.
func TestResumePollingDoesNotRescanRunsPerPR(t *testing.T) {
	store := &countingStore{MemoryStore: tembed.NewMemoryStore()}
	engine := tembed.New(store)
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

	// Replace the real pr_status/task_code_comment workflows with a stub that
	// just waits forever on a signal nobody sends — cheap way to land the run
	// in StatusWaiting without exercising the real business logic (mirrors
	// TestFailedRunsHidesSupersededRun's pattern in run_errors_test.go).
	waitForever := func(w *tembed.Workflow, input []byte) ([]byte, error) {
		var sig struct{}
		w.WaitSignal("never", &sig)
		return nil, nil
	}
	engine.RegisterWorkflow(WorkflowPRStatus, waitForever)
	engine.RegisterWorkflow(WorkflowTaskCodeComment, waitForever)

	const numPRs = 40
	for pr := 1; pr <= numPRs; pr++ {
		if _, err := engine.StartWorkflow(WorkflowPRStatus, PRStatusInput{PR: pr}); err != nil {
			t.Fatalf("start pr_status pr=%d: %v", pr, err)
		}
		in := CodeCommentInput{
			PR: pr, File: "src/Order.php", Line: 1, Author: "colleague", Body: "root",
			Side: "RIGHT", RowStart: 1, RowEnd: 1, Source: "github",
			ImportedRootID: int64(1000 + pr),
		}
		if _, err := engine.StartWorkflowID(fmt.Sprintf("comment-%d", pr), WorkflowTaskCodeComment, in); err != nil {
			t.Fatalf("start task_code_comment pr=%d: %v", pr, err)
		}
	}

	// Reset the counter: only ResumePolling's own scans are under test, not
	// the setup above's writes.
	store.listRunsCalls.Store(0)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m.ResumePolling(ctx)

	if got := store.listRunsCalls.Load(); got != 1 {
		t.Fatalf("ResumePolling called store.ListRuns %d times for %d PRs, want 1 (it must prime m.prRuns from its own single runs fetch instead of rescanning per PR)", got, numPRs)
	}
}
