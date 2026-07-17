package tembed

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

// TestSQLiteAppendEventDuplicateSeq reproduces the raw storage-layer conflict:
// two writers racing to append the same run's next event both compute the
// same seq. The SQLite PRIMARY KEY(run_id, seq) correctly rejects the loser —
// but the Store must translate that into the portable ErrDuplicateEvent
// sentinel, not leak the raw driver error, so higher layers (Workflow.record)
// can tell "benign duplicate" apart from "the DB is broken".
func TestSQLiteAppendEventDuplicateSeq(t *testing.T) {
	dir := t.TempDir()
	store, err := NewSQLiteStore(filepath.Join(dir, "wf.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	rec := RunRecord{ID: "run-1", Workflow: "noop"}
	if err := store.CreateRun(rec); err != nil {
		t.Fatal(err)
	}

	ev := Event{Seq: 0, Type: EventWorkflowStarted}
	if err := store.AppendEvent(rec.ID, ev); err != nil {
		t.Fatalf("first append: %v", err)
	}
	// Same (run_id, seq) again — simulates a second writer that lost the race.
	if err := store.AppendEvent(rec.ID, ev); err != ErrDuplicateEvent {
		t.Fatalf("second append err = %v, want ErrDuplicateEvent", err)
	}
}

// concurrentOnceStore wraps MemoryStore and returns ErrDuplicateEvent exactly
// once, for the seq given, simulating a second writer that already recorded
// this run's next event by the time we tried to. It is a lightweight stand-in
// for racing two real Engines against the same store, without needing actual
// goroutines/processes to reproduce the race deterministically.
type concurrentOnceStore struct {
	*MemoryStore
	triggerRunID string
	triggerSeq   int
	fired        bool
}

func (s *concurrentOnceStore) AppendEvent(runID string, e Event) error {
	if !s.fired && runID == s.triggerRunID && e.Seq == s.triggerSeq {
		s.fired = true
		return ErrDuplicateEvent
	}
	return s.MemoryStore.AppendEvent(runID, e)
}

// TestRecoverToleratesConcurrentAppend reproduces the exact panic scenario
// from a real crash: a run is mid-flight (waiting on a signal), a signal
// arrives and drives advance() to try to record the workflow's terminal
// event — but that (run_id, seq) has, per the fake store, already been
// written by "another writer" that raced it. This must not panic the engine;
// the run is abandoned untouched for this attempt, and a later advance (as
// Recover would perform at the next startup) must complete it correctly.
func TestRecoverToleratesConcurrentAppend(t *testing.T) {
	base := NewMemoryStore()
	store := &concurrentOnceStore{MemoryStore: base}
	e := New(store)
	e.RegisterWorkflow("greet", func(w *Workflow, _ []byte) ([]byte, error) {
		var msg string
		w.WaitSignal("go", &msg)
		return json.Marshal("hi " + msg)
	})

	id, err := e.StartWorkflow("greet", nil)
	if err != nil {
		t.Fatal(err)
	}
	if s, _ := e.Status(id); s != StatusWaiting {
		t.Fatalf("status = %s, want waiting", s)
	}

	// Arm the fake store to reject the *next* event this run will try to
	// persist once the signal arrives: seq 2 is the WorkflowCompleted event
	// (seq 0 = WorkflowStarted, seq 1 = the SignalReceived event the signal
	// itself is about to append) — simulating that another writer already
	// recorded it concurrently.
	store.triggerRunID = id
	store.triggerSeq = 2

	if err := e.SignalWorkflow(id, "go", "Reindert"); err != nil {
		t.Fatalf("SignalWorkflow must not surface the concurrent conflict as an error: %v", err)
	}
	// The signal itself (seq 1) was accepted; only the resulting completion
	// (seq 2) hit the simulated race, so the run must be left exactly as it
	// was — waiting, not crashed, not marked failed or completed.
	if s, _ := e.Status(id); s != StatusWaiting {
		t.Fatalf("status after concurrent conflict = %s, want waiting (untouched, ready to retry)", s)
	}

	// A later advance (Recover(), no more injected conflict) must replay the
	// same history and complete the run correctly.
	if err := e.Recover(); err != nil {
		t.Fatal(err)
	}
	if s, _ := e.Status(id); s != StatusCompleted {
		t.Fatalf("status after retry = %s, want completed", s)
	}
	var r string
	if err := e.Result(id, &r); err != nil {
		t.Fatal(err)
	}
	if r != "hi Reindert" {
		t.Fatalf("result = %q, want %q", r, "hi Reindert")
	}
}
