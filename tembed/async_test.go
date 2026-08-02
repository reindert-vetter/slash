package tembed

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

// TestExecuteActivityAsyncRunsInParallel proves two ExecuteActivityAsync calls
// actually overlap. Each activity hands off to the other over a rendezvous
// channel; if the engine ran them sequentially (the second only starting once
// the first has returned), the first would block forever waiting for a
// handoff the second — not yet started — can never send, and the activity
// itself times out and fails the run.
func TestExecuteActivityAsyncRunsInParallel(t *testing.T) {
	e := New(NewMemoryStore())

	chA := make(chan struct{}, 1)
	chB := make(chan struct{}, 1)

	e.RegisterActivity("actA", func(context.Context, []byte) ([]byte, error) {
		chA <- struct{}{}
		select {
		case <-chB:
			return nil, nil
		case <-time.After(2 * time.Second):
			return nil, errors.New("timeout waiting for actB (activities did not run in parallel)")
		}
	})
	e.RegisterActivity("actB", func(context.Context, []byte) ([]byte, error) {
		chB <- struct{}{}
		select {
		case <-chA:
			return nil, nil
		case <-time.After(2 * time.Second):
			return nil, errors.New("timeout waiting for actA (activities did not run in parallel)")
		}
	})
	e.RegisterWorkflow("job", func(w *Workflow, _ []byte) ([]byte, error) {
		fA := w.ExecuteActivityAsync("actA", nil)
		fB := w.ExecuteActivityAsync("actB", nil)
		if err := fA.Get(nil); err != nil {
			return nil, err
		}
		if err := fB.Get(nil); err != nil {
			return nil, err
		}
		return nil, nil
	})

	id, err := e.StartWorkflow("job", nil)
	if err != nil {
		t.Fatal(err)
	}
	e.Wait()
	if s, _ := e.Status(id); s != StatusCompleted {
		t.Fatalf("status = %s, want completed (activities should have run in parallel)", s)
	}
}

// TestAsyncActivityFailurePropagates checks that an async activity's error
// comes back through Future.Get and fails the run with that message.
func TestAsyncActivityFailurePropagates(t *testing.T) {
	e := New(NewMemoryStore())

	e.RegisterActivity("boom", func(context.Context, []byte) ([]byte, error) {
		return nil, errors.New("kaboom")
	})
	e.RegisterWorkflow("job", func(w *Workflow, _ []byte) ([]byte, error) {
		f := w.ExecuteActivityAsync("boom", nil)
		if err := f.Get(nil); err != nil {
			return nil, err
		}
		return nil, nil
	})

	id, err := e.StartWorkflow("job", nil)
	if err != nil {
		t.Fatal(err)
	}
	e.Wait()
	if s, _ := e.Status(id); s != StatusFailed {
		t.Fatalf("status = %s, want failed", s)
	}
	if err := e.Result(id, nil); err == nil || err.Error() != "tembed: workflow failed: kaboom" {
		t.Fatalf("result err = %v, want it to mention %q", err, "kaboom")
	}
}

// TestAsyncActivityReplaySkipsRerun checks that a replay triggered by an
// unrelated signal does not relaunch an already-scheduled async activity: the
// side-effect counter must stay at 1.
func TestAsyncActivityReplaySkipsRerun(t *testing.T) {
	e := New(NewMemoryStore())

	var calls int32
	e.RegisterActivity("count", func(context.Context, []byte) ([]byte, error) {
		atomic.AddInt32(&calls, 1)
		return json.Marshal("ok")
	})
	e.RegisterWorkflow("job", func(w *Workflow, _ []byte) ([]byte, error) {
		f := w.ExecuteActivityAsync("count", nil)
		var sig string
		w.WaitSignal("go", &sig)
		var res string
		if err := f.Get(&res); err != nil {
			return nil, err
		}
		return json.Marshal(res)
	})

	id, err := e.StartWorkflow("job", nil)
	if err != nil {
		t.Fatal(err)
	}
	// Let the async activity actually complete before the signal drives a
	// replay, so the replay's Future.Get finds a recorded completion.
	e.Wait()
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("calls after first run = %d, want 1", n)
	}

	if err := e.SignalWorkflow(id, "go", "ignored"); err != nil {
		t.Fatal(err)
	}
	e.Wait()

	if s, _ := e.Status(id); s != StatusCompleted {
		t.Fatalf("status = %s, want completed", s)
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("calls after replay = %d, want 1 (replay must not relaunch)", n)
	}
}

// TestRecoverResumesPendingAsyncActivity reproduces a crash between an async
// activity's Scheduled event and its completion: a fresh Engine over a store
// holding only the Scheduled event must relaunch the activity on Recover and
// the run must still complete.
func TestRecoverResumesPendingAsyncActivity(t *testing.T) {
	store := NewMemoryStore()
	now := time.Now()
	const runID = "run-1"
	if err := store.CreateRun(RunRecord{ID: runID, Workflow: "job", Status: StatusWaiting, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendEvent(runID, Event{Seq: 0, Type: EventWorkflowStarted, Time: now}); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendEvent(runID, Event{Seq: 1, Type: EventActivityScheduled, Name: "count#0", Time: now}); err != nil {
		t.Fatal(err)
	}

	e := New(store)
	var calls int32
	e.RegisterActivity("count", func(context.Context, []byte) ([]byte, error) {
		atomic.AddInt32(&calls, 1)
		return json.Marshal("ok")
	})
	e.RegisterWorkflow("job", func(w *Workflow, _ []byte) ([]byte, error) {
		f := w.ExecuteActivityAsync("count", nil)
		var res string
		if err := f.Get(&res); err != nil {
			return nil, err
		}
		return json.Marshal(res)
	})

	if err := e.Recover(); err != nil {
		t.Fatal(err)
	}
	e.Wait()

	if s, _ := e.Status(runID); s != StatusCompleted {
		t.Fatalf("status = %s, want completed", s)
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("calls = %d, want 1 (activity must run exactly once)", n)
	}
	var res string
	if err := e.Result(runID, &res); err != nil {
		t.Fatal(err)
	}
	if res != "ok" {
		t.Fatalf("result = %q, want %q", res, "ok")
	}
}
