package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/reindert-vetter/tembed"
)

// shrinkDBLockRetryDelays swaps dbLockRetryDelays for a few-millisecond ladder
// for the duration of one test, restoring the real one afterwards — same
// pattern as shrinkChatRetryDelays (chat_workflow_test.go).
func shrinkDBLockRetryDelays(t *testing.T) {
	t.Helper()
	orig := dbLockRetryDelays
	dbLockRetryDelays = []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond, time.Millisecond}
	t.Cleanup(func() { dbLockRetryDelays = orig })
}

// TestExecuteActivityWithLockRetryRetriesTransientBusyError proves that a
// SQLITE_BUSY-shaped Activity failure is retried through dbLockRetryDelays'
// durable backoff ladder instead of failing the run on the spot, and that the
// run ends up Completed once the underlying contention clears.
func TestExecuteActivityWithLockRetryRetriesTransientBusyError(t *testing.T) {
	shrinkDBLockRetryDelays(t)
	engine := tembed.New(tembed.NewMemoryStore())

	calls := 0
	engine.RegisterActivity("saveReaction", func(ctx context.Context, in []byte) ([]byte, error) {
		calls++
		if calls <= 2 {
			return nil, errors.New("database is locked (5) (SQLITE_BUSY)")
		}
		return nil, nil
	})
	engine.RegisterWorkflow("test_lock_retry", func(w *tembed.Workflow, input []byte) ([]byte, error) {
		if err := executeActivityWithLockRetry(w, "saveReaction", nil, nil); err != nil {
			return nil, err
		}
		return nil, nil
	})

	runID, err := engine.StartWorkflow("test_lock_retry", struct{}{})
	if err != nil {
		t.Fatal(err)
	}

	waitFor(t, func() bool {
		runs, _ := engine.Runs()
		for _, r := range runs {
			if r.ID == runID {
				return r.Status == tembed.StatusCompleted
			}
		}
		return false
	})

	if calls != 3 {
		t.Fatalf("expected 3 saveReaction calls (2 transient failures + 1 success), got %d", calls)
	}
}

// TestExecuteActivityWithLockRetryFailsImmediatelyOnRealError proves a
// non-transient error (a genuine bug, not lock contention) is NOT retried —
// it must fail the run on the spot rather than hide it for up to ~17h.
func TestExecuteActivityWithLockRetryFailsImmediatelyOnRealError(t *testing.T) {
	shrinkDBLockRetryDelays(t)
	engine := tembed.New(tembed.NewMemoryStore())

	calls := 0
	engine.RegisterActivity("saveReaction", func(ctx context.Context, in []byte) ([]byte, error) {
		calls++
		return nil, errors.New("comment not found")
	})
	engine.RegisterWorkflow("test_lock_retry_real_error", func(w *tembed.Workflow, input []byte) ([]byte, error) {
		if err := executeActivityWithLockRetry(w, "saveReaction", nil, nil); err != nil {
			return nil, err
		}
		return nil, nil
	})

	runID, err := engine.StartWorkflow("test_lock_retry_real_error", struct{}{})
	if err != nil {
		t.Fatal(err)
	}

	waitFor(t, func() bool {
		runs, _ := engine.Runs()
		for _, r := range runs {
			if r.ID == runID {
				return r.Status == tembed.StatusFailed
			}
		}
		return false
	})

	if calls != 1 {
		t.Fatalf("expected exactly 1 saveReaction call (no retry on a non-transient error), got %d", calls)
	}
}

// TestExecuteActivityWithLockRetryExhaustsLadder proves that once every rung
// of dbLockRetryDelays is spent on a STILL-transient error, the run ends up
// StatusFailed (not stuck retrying forever) — the "Mislukte taken" / manual
// "Opnieuw proberen" path stays the backstop.
func TestExecuteActivityWithLockRetryExhaustsLadder(t *testing.T) {
	shrinkDBLockRetryDelays(t)
	engine := tembed.New(tembed.NewMemoryStore())

	calls := 0
	engine.RegisterActivity("saveReaction", func(ctx context.Context, in []byte) ([]byte, error) {
		calls++
		return nil, errors.New("database is locked (5) (SQLITE_BUSY)")
	})
	engine.RegisterWorkflow("test_lock_retry_exhausted", func(w *tembed.Workflow, input []byte) ([]byte, error) {
		if err := executeActivityWithLockRetry(w, "saveReaction", nil, nil); err != nil {
			return nil, err
		}
		return nil, nil
	})

	runID, err := engine.StartWorkflow("test_lock_retry_exhausted", struct{}{})
	if err != nil {
		t.Fatal(err)
	}

	waitFor(t, func() bool {
		runs, _ := engine.Runs()
		for _, r := range runs {
			if r.ID == runID {
				return r.Status == tembed.StatusFailed
			}
		}
		return false
	})

	if want := len(dbLockRetryDelays) + 1; calls != want {
		t.Fatalf("expected %d saveReaction calls (every rung of the ladder), got %d", want, calls)
	}
}
