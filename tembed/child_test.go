package tembed

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestChildWorkflowsRunConcurrently proves that starting several children back
// to back and only then waiting on them lets those children progress
// independently rather than one at a time: two children each sleep 20ms: if
// the engine ran them one after another (only starting the second once the
// first had fully finished), the parent would need ~40ms; started
// concurrently it needs ~20ms.
func TestChildWorkflowsRunConcurrently(t *testing.T) {
	e := New(NewMemoryStore())

	e.RegisterWorkflow("napChild", func(w *Workflow, _ []byte) ([]byte, error) {
		w.Sleep(20 * time.Millisecond)
		return json.Marshal("awake")
	})
	e.RegisterWorkflow("parent", func(w *Workflow, _ []byte) ([]byte, error) {
		id1, err := w.ExecuteChildWorkflow("napChild", nil)
		if err != nil {
			return nil, err
		}
		id2, err := w.ExecuteChildWorkflow("napChild", nil)
		if err != nil {
			return nil, err
		}
		var r1, r2 string
		if err := w.WaitChildWorkflow(id1, &r1); err != nil {
			return nil, err
		}
		if err := w.WaitChildWorkflow(id2, &r2); err != nil {
			return nil, err
		}
		return json.Marshal(r1 + "+" + r2)
	})

	start := time.Now()
	id, err := e.StartWorkflow("parent", nil)
	if err != nil {
		t.Fatal(err)
	}
	e.Wait()
	elapsed := time.Since(start)

	if s, _ := e.Status(id); s != StatusCompleted {
		t.Fatalf("status = %s, want completed", s)
	}
	var got string
	if err := e.Result(id, &got); err != nil {
		t.Fatal(err)
	}
	if got != "awake+awake" {
		t.Fatalf("result = %q, want %q", got, "awake+awake")
	}
	// Sequential children would take ~40ms; concurrent ones ~20ms. A generous
	// margin keeps this robust against scheduling jitter while still failing
	// clearly if the children were serialized.
	if elapsed >= 35*time.Millisecond {
		t.Fatalf("elapsed = %v, want < 35ms (children must run concurrently, not sequentially)", elapsed)
	}
}

// TestExecuteChildWorkflowIDUsesTheGivenID proves the explicit-ID variant: the
// child run really carries that ID (not the positional <parent>-child-0), it
// records the parent, and calling it a second time with the same ID reuses that
// child instead of starting a second one.
func TestExecuteChildWorkflowIDUsesTheGivenID(t *testing.T) {
	e := New(NewMemoryStore())

	runs := 0
	e.RegisterWorkflow("namedChild", func(w *Workflow, _ []byte) ([]byte, error) {
		runs++
		return json.Marshal("done")
	})
	e.RegisterWorkflow("parent", func(w *Workflow, _ []byte) ([]byte, error) {
		id, err := w.ExecuteChildWorkflowID("my-own-child", "namedChild", nil)
		if err != nil {
			return nil, err
		}
		// A second call with the same ID is a no-op reuse, not a second child.
		again, err := w.ExecuteChildWorkflowID("my-own-child", "namedChild", nil)
		if err != nil {
			return nil, err
		}
		if again != id {
			return nil, fmt.Errorf("second call returned %q, want %q", again, id)
		}
		var res string
		if err := w.WaitChildWorkflow(id, &res); err != nil {
			return nil, err
		}
		return json.Marshal(id + ":" + res)
	})

	id, err := e.StartWorkflow("parent", nil)
	if err != nil {
		t.Fatal(err)
	}
	e.Wait()

	if s, _ := e.Status(id); s != StatusCompleted {
		t.Fatalf("parent status = %s, want completed", s)
	}
	var got string
	if err := e.Result(id, &got); err != nil {
		t.Fatal(err)
	}
	if got != "my-own-child:done" {
		t.Fatalf("result = %q, want %q", got, "my-own-child:done")
	}
	if runs != 1 {
		t.Fatalf("child ran %d times, want exactly 1", runs)
	}
	if s, _ := e.Status("my-own-child"); s != StatusCompleted {
		t.Fatalf("child status = %s, want completed", s)
	}
}

// TestChildWorkflowFailurePropagates checks that a failing child's error comes
// back through WaitChildWorkflow and fails the parent with that message. The
// child fails synchronously during its own start (no Sleep/signal), which
// exercises the nested-lock path in Engine.propagateToParent.
func TestChildWorkflowFailurePropagates(t *testing.T) {
	e := New(NewMemoryStore())

	e.RegisterActivity("boom", func(context.Context, []byte) ([]byte, error) {
		return nil, errors.New("child kaboom")
	})
	e.RegisterWorkflow("failChild", func(w *Workflow, _ []byte) ([]byte, error) {
		return nil, w.ExecuteActivity("boom", nil, nil)
	})
	e.RegisterWorkflow("parent", func(w *Workflow, _ []byte) ([]byte, error) {
		id, err := w.ExecuteChildWorkflow("failChild", nil)
		if err != nil {
			return nil, err
		}
		return nil, w.WaitChildWorkflow(id, nil)
	})

	id, err := e.StartWorkflow("parent", nil)
	if err != nil {
		t.Fatal(err)
	}
	e.Wait()

	if s, _ := e.Status(id); s != StatusFailed {
		t.Fatalf("status = %s, want failed", s)
	}
	if err := e.Result(id, nil); err == nil || err.Error() != "tembed: workflow failed: child kaboom" {
		t.Fatalf("result err = %v, want it to mention %q", err, "child kaboom")
	}
}

// TestRecoverResumesParentWaitingOnChild reproduces a crash while the parent
// is durably waiting on a child that hasn't completed yet: a fresh Engine
// recovering both runs from a store must still let the parent complete once
// the child's (also recovered) timer fires.
func TestRecoverResumesParentWaitingOnChild(t *testing.T) {
	store := NewMemoryStore()
	now := time.Now()
	const parentID = "parent-1"
	childID := parentID + "-child-0"

	if err := store.CreateRun(RunRecord{ID: parentID, Workflow: "parent", Status: StatusWaiting, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendEvent(parentID, Event{Seq: 0, Type: EventWorkflowStarted, Time: now}); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendEvent(parentID, Event{Seq: 1, Type: EventChildWorkflowStarted, Name: childID, Time: now}); err != nil {
		t.Fatal(err)
	}

	if err := store.CreateRun(RunRecord{ID: childID, Workflow: "napChild", Status: StatusWaiting, CreatedAt: now, UpdatedAt: now, ParentRunID: parentID}); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendEvent(childID, Event{Seq: 0, Type: EventWorkflowStarted, Time: now}); err != nil {
		t.Fatal(err)
	}
	fireAt := now.Add(10 * time.Millisecond)
	pl, _ := json.Marshal(fireAt)
	if err := store.AppendEvent(childID, Event{Seq: 1, Type: EventTimerStarted, Payload: pl, Time: now}); err != nil {
		t.Fatal(err)
	}

	e := New(store)
	e.RegisterWorkflow("napChild", func(w *Workflow, _ []byte) ([]byte, error) {
		w.Sleep(10 * time.Millisecond)
		return json.Marshal("awake")
	})
	e.RegisterWorkflow("parent", func(w *Workflow, _ []byte) ([]byte, error) {
		id, err := w.ExecuteChildWorkflow("napChild", nil)
		if err != nil {
			return nil, err
		}
		var res string
		if err := w.WaitChildWorkflow(id, &res); err != nil {
			return nil, err
		}
		return json.Marshal(res)
	})

	if err := e.Recover(); err != nil {
		t.Fatal(err)
	}
	e.Wait()

	if s, _ := e.Status(childID); s != StatusCompleted {
		t.Fatalf("child status = %s, want completed", s)
	}
	if s, _ := e.Status(parentID); s != StatusCompleted {
		t.Fatalf("parent status = %s, want completed", s)
	}
	var got string
	if err := e.Result(parentID, &got); err != nil {
		t.Fatal(err)
	}
	if got != "awake" {
		t.Fatalf("parent result = %q, want %q", got, "awake")
	}
}

// TestExecuteChildWorkflowIDHasNoSlash guards against a regression of the
// "checkout_wait_fallback" bug: ExecuteChildWorkflow used to derive
// "<parent>/child-<n>" (a literal "/"), which JSONLStore's flat
// "<id>.events.jsonl"/"<id>.meta.jsonl" naming cannot address without a
// subdirectory that is never created — CreateRun/AppendEvent then partially
// succeeded across a MultiStore (a SQLite row with no matching JSONL file),
// leaving an orphaned run with metadata but no EventWorkflowStarted event.
// Run against the real production store combination (SQLite + JSONL through a
// MultiStore, like TestSQLiteAndJSONLStores) so a reintroduced "/" would
// reproduce the exact failure instead of only being caught by MemoryStore,
// which has no filesystem to trip over.
func TestExecuteChildWorkflowIDHasNoSlash(t *testing.T) {
	dir := t.TempDir()
	sq, err := NewSQLiteStore(filepath.Join(dir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer sq.Close()
	jsonlDir := filepath.Join(dir, "jsonl")
	jl, err := NewJSONLStore(jsonlDir)
	if err != nil {
		t.Fatal(err)
	}
	store := NewMultiStore(sq, jl)
	e := New(store)

	var childID string
	e.RegisterWorkflow("napChild", func(w *Workflow, _ []byte) ([]byte, error) {
		return json.Marshal("awake")
	})
	e.RegisterWorkflow("parent", func(w *Workflow, _ []byte) ([]byte, error) {
		id, err := w.ExecuteChildWorkflow("napChild", nil)
		if err != nil {
			return nil, err
		}
		childID = id
		var res string
		if err := w.WaitChildWorkflow(id, &res); err != nil {
			return nil, err
		}
		return json.Marshal(res)
	})

	id, err := e.StartWorkflow("parent", nil)
	if err != nil {
		t.Fatal(err)
	}
	e.Wait()

	if strings.Contains(childID, "/") {
		t.Fatalf("child run id %q contains a %q", childID, "/")
	}
	if s, _ := e.Status(childID); s != StatusCompleted {
		t.Fatalf("child status = %s, want completed", s)
	}
	if s, _ := e.Status(id); s != StatusCompleted {
		t.Fatalf("parent status = %s, want completed", s)
	}

	// Both stores must independently hold the completed child run, and the
	// JSONL side must carry its EventWorkflowStarted — the event a "/" in the
	// id used to make CreateRun/AppendEvent lose partway through the
	// MultiStore fan-out.
	if _, hist, err := jl.LoadRun(childID); err != nil {
		t.Fatalf("jsonl LoadRun(%s): %v", childID, err)
	} else if len(hist) == 0 || hist[0].Type != EventWorkflowStarted {
		t.Fatalf("jsonl history for child = %+v, want it to start with EventWorkflowStarted", hist)
	}
}
