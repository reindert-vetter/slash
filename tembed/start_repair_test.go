package tembed

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func echoEngine(store Store) *Engine {
	e := New(store)
	e.RegisterWorkflow("echo", func(w *Workflow, in []byte) ([]byte, error) {
		var s string
		if err := json.Unmarshal(in, &s); err != nil {
			return nil, err
		}
		return json.Marshal(s)
	})
	return e
}

func TestStartWorkflowIDRepairsOrphanRun(t *testing.T) {
	store := NewMemoryStore()
	now := time.Now()
	_ = store.CreateRun(RunRecord{ID: "r1", Workflow: "echo", Status: StatusFailed, CreatedAt: now, UpdatedAt: now})
	_ = store.AppendEvent("r1", Event{Seq: 0, Type: EventWorkflowFailed, Error: "x", Time: now})
	e := echoEngine(store)
	if _, err := e.StartWorkflowID("r1", "echo", "hi"); err != nil {
		t.Fatal(err)
	}
	_, hist, _ := store.LoadRun("r1")
	if len(hist) == 0 || hist[0].Type != EventWorkflowStarted {
		t.Fatalf("history not repaired: %+v", hist)
	}
	var out string
	if err := e.Result("r1", &out); err != nil || out != "hi" {
		t.Fatalf("result = %q, %v", out, err)
	}
}

func TestStartWorkflowIDKeepsValidRun(t *testing.T) {
	e := echoEngine(NewMemoryStore())
	if _, err := e.StartWorkflowID("r2", "echo", "first"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.StartWorkflowID("r2", "echo", "second"); err != nil {
		t.Fatal(err)
	}
	var out string
	if err := e.Result("r2", &out); err != nil || out != "first" {
		t.Fatalf("result = %q, %v", out, err)
	}
}

func TestRecoverFailsRunWithoutStartInputClearly(t *testing.T) {
	store := NewMemoryStore()
	now := time.Now()
	_ = store.CreateRun(RunRecord{ID: "r3", Workflow: "echo", Status: StatusRunning, CreatedAt: now, UpdatedAt: now})
	e := echoEngine(store)
	if err := e.Recover(); err != nil {
		t.Fatal(err)
	}
	e.Wait()
	rec, hist, _ := store.LoadRun("r3")
	if rec.Status != StatusFailed || len(hist) != 1 || !strings.Contains(hist[0].Error, "no start input") {
		t.Fatalf("status=%s hist=%+v", rec.Status, hist)
	}
}
