package tembed

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// greetInput/greetResult are a tiny typed activity contract for the tests.
type greetInput struct {
	Name string `json:"name"`
}
type greetResult struct {
	Message string `json:"message"`
}

func TestStartWorkflowIDIsIdempotent(t *testing.T) {
	e := New(NewMemoryStore())

	var runs int32
	e.RegisterActivity("count", func(context.Context, []byte) ([]byte, error) {
		atomic.AddInt32(&runs, 1)
		return nil, nil
	})
	e.RegisterWorkflow("job", func(w *Workflow, _ []byte) ([]byte, error) {
		return nil, w.ExecuteActivity("count", nil, nil)
	})

	id1, err := e.StartWorkflowID("gh-42", "job", greetInput{Name: "a"})
	if err != nil {
		t.Fatal(err)
	}
	// A second start with the same ID is a no-op reuse: same ID back, the
	// workflow body (and its activity) does not run again, and the original
	// input is left untouched.
	id2, err := e.StartWorkflowID("gh-42", "job", greetInput{Name: "b"})
	if err != nil {
		t.Fatal(err)
	}
	if id1 != "gh-42" || id2 != "gh-42" {
		t.Fatalf("ids = %q,%q, want gh-42,gh-42", id1, id2)
	}
	if n := atomic.LoadInt32(&runs); n != 1 {
		t.Fatalf("activity ran %d times, want 1 (second start must be a no-op)", n)
	}
	in, err := e.Input(id1)
	if err != nil {
		t.Fatal(err)
	}
	var gi greetInput
	_ = json.Unmarshal(in, &gi)
	if gi.Name != "a" {
		t.Fatalf("input = %q, want the first start's input %q", gi.Name, "a")
	}
	// Only one run exists.
	rr, err := e.Runs()
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, r := range rr {
		if r.ID == "gh-42" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("found %d runs with id gh-42, want 1", n)
	}
}

func TestActivityRunsOnceAndReplays(t *testing.T) {
	store := NewMemoryStore()
	e := New(store)

	var calls int32
	e.RegisterActivity("greet", func(_ context.Context, in []byte) ([]byte, error) {
		atomic.AddInt32(&calls, 1)
		var gi greetInput
		_ = json.Unmarshal(in, &gi)
		return json.Marshal(greetResult{Message: "hi " + gi.Name})
	})
	e.RegisterWorkflow("hello", func(w *Workflow, _ []byte) ([]byte, error) {
		var r greetResult
		if err := w.ExecuteActivity("greet", greetInput{Name: "Reindert"}, &r); err != nil {
			return nil, err
		}
		return json.Marshal(r)
	})

	id, err := e.StartWorkflow("hello", nil)
	if err != nil {
		t.Fatal(err)
	}
	if s, _ := e.Status(id); s != StatusCompleted {
		t.Fatalf("status = %s, want completed", s)
	}
	var r greetResult
	if err := e.Result(id, &r); err != nil {
		t.Fatal(err)
	}
	if r.Message != "hi Reindert" {
		t.Fatalf("result = %q", r.Message)
	}

	// A fresh engine over the same (persisted) store must NOT re-run the
	// activity — the recorded result is replayed.
	e2 := New(store)
	e2.RegisterActivity("greet", func(context.Context, []byte) ([]byte, error) {
		t.Fatal("activity re-executed on replay")
		return nil, nil
	})
	e2.RegisterWorkflow("hello", func(w *Workflow, _ []byte) ([]byte, error) {
		var r greetResult
		if err := w.ExecuteActivity("greet", greetInput{Name: "Reindert"}, &r); err != nil {
			return nil, err
		}
		return json.Marshal(r)
	})
	if err := e2.Recover(); err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("activity ran %d times, want 1", calls)
	}
}

func TestSignalDrivesWorkflow(t *testing.T) {
	e := New(NewMemoryStore())

	var posted []string
	e.RegisterActivity("post", func(_ context.Context, in []byte) ([]byte, error) {
		var s string
		_ = json.Unmarshal(in, &s)
		posted = append(posted, s)
		return json.Marshal(len(posted))
	})
	// Workflow: post a comment, then wait for two "reaction" signals, posting
	// a reply after each. This mirrors the slash review task.
	e.RegisterWorkflow("review", func(w *Workflow, _ []byte) ([]byte, error) {
		_ = w.ExecuteActivity("post", "initial comment", nil)
		for i := 0; i < 2; i++ {
			var reaction string
			w.WaitSignal("reaction", &reaction)
			_ = w.ExecuteActivity("post", "reply to: "+reaction, nil)
		}
		return json.Marshal("done")
	})

	id, err := e.StartWorkflow("review", nil)
	if err != nil {
		t.Fatal(err)
	}
	if s, _ := e.Status(id); s != StatusWaiting {
		t.Fatalf("status = %s, want waiting", s)
	}

	if err := e.SignalWorkflow(id, "reaction", "looks good"); err != nil {
		t.Fatal(err)
	}
	if s, _ := e.Status(id); s != StatusWaiting {
		t.Fatalf("after 1 signal status = %s, want waiting", s)
	}
	if err := e.SignalWorkflow(id, "reaction", "ship it"); err != nil {
		t.Fatal(err)
	}
	if s, _ := e.Status(id); s != StatusCompleted {
		t.Fatalf("after 2 signals status = %s, want completed", s)
	}

	want := []string{"initial comment", "reply to: looks good", "reply to: ship it"}
	if len(posted) != len(want) {
		t.Fatalf("posted = %v", posted)
	}
	for i := range want {
		if posted[i] != want[i] {
			t.Fatalf("posted[%d] = %q, want %q", i, posted[i], want[i])
		}
	}
}

func TestBufferedSignalArrivesEarly(t *testing.T) {
	// A signal delivered before the workflow waits for it must be buffered.
	e := New(NewMemoryStore())
	e.RegisterWorkflow("wait", func(w *Workflow, _ []byte) ([]byte, error) {
		var msg string
		w.WaitSignal("go", &msg)
		return json.Marshal(msg)
	})
	// Start a run that immediately blocks.
	id, _ := e.StartWorkflow("wait", nil)
	// Deliver, then it should complete.
	if err := e.SignalWorkflow(id, "go", "early"); err != nil {
		t.Fatal(err)
	}
	var got string
	if err := e.Result(id, &got); err != nil {
		t.Fatal(err)
	}
	if got != "early" {
		t.Fatalf("got %q", got)
	}
}

func TestDurableTimer(t *testing.T) {
	e := New(NewMemoryStore())
	e.RegisterWorkflow("nap", func(w *Workflow, _ []byte) ([]byte, error) {
		w.Sleep(20 * time.Millisecond)
		return json.Marshal("awake")
	})
	id, _ := e.StartWorkflow("nap", nil)
	if s, _ := e.Status(id); s != StatusWaiting {
		t.Fatalf("status = %s, want waiting", s)
	}
	e.Wait() // let the timer fire
	var got string
	if err := e.Result(id, &got); err != nil {
		t.Fatal(err)
	}
	if got != "awake" {
		t.Fatalf("got %q", got)
	}
}

func TestActivityFailurePropagates(t *testing.T) {
	e := New(NewMemoryStore())
	e.RegisterActivity("boom", func(context.Context, []byte) ([]byte, error) {
		return nil, errBoom
	})
	e.RegisterWorkflow("fail", func(w *Workflow, _ []byte) ([]byte, error) {
		return nil, w.ExecuteActivity("boom", nil, nil)
	})
	id, _ := e.StartWorkflow("fail", nil)
	if s, _ := e.Status(id); s != StatusFailed {
		t.Fatalf("status = %s, want failed", s)
	}
	if err := e.Result(id, nil); err == nil {
		t.Fatal("expected error from failed run")
	}
}

// TestRecoverDefersLowPriority proves that Recover re-drives Normal-priority
// runs synchronously but pushes PriorityLow runs (a slow LLM/subprocess call
// that re-executes live because its result wasn't recorded before the crash)
// to the background — so a slow low-priority activity never blocks Recover's
// return or the recovery of the fast, important runs.
func TestRecoverDefersLowPriority(t *testing.T) {
	store := NewMemoryStore()
	// Seed two interrupted, mid-flight runs (status running, only their
	// WorkflowStarted event) — as if the process died before either activity
	// recorded its result. On Recover both would re-execute their activity live.
	now := time.Now()
	seed := func(id, workflow string) {
		if err := store.CreateRun(RunRecord{ID: id, Workflow: workflow, Status: StatusRunning, CreatedAt: now, UpdatedAt: now}); err != nil {
			t.Fatal(err)
		}
		if err := store.AppendEvent(id, Event{Seq: 0, Type: EventWorkflowStarted, Payload: []byte("null"), Time: now}); err != nil {
			t.Fatal(err)
		}
	}
	seed("fast-run", "fast")
	seed("slow-run", "slow")

	e := New(store)
	var fastRan, slowDone int32
	release := make(chan struct{})
	e.RegisterActivity("fastAct", func(context.Context, []byte) ([]byte, error) {
		atomic.AddInt32(&fastRan, 1)
		return []byte("null"), nil
	})
	e.RegisterActivity("slowAct", func(context.Context, []byte) ([]byte, error) {
		<-release // block until released (simulates a slow LLM/subprocess call)
		atomic.AddInt32(&slowDone, 1)
		return []byte("null"), nil
	})
	e.RegisterWorkflow("fast", func(w *Workflow, _ []byte) ([]byte, error) {
		return nil, w.ExecuteActivity("fastAct", nil, nil)
	})
	e.RegisterWorkflow("slow", func(w *Workflow, _ []byte) ([]byte, error) {
		return nil, w.ExecuteActivity("slowAct", nil, nil)
	})
	e.SetWorkflowPriority("slow", PriorityLow)

	// Recover must return promptly, without waiting on the slow activity.
	done := make(chan error, 1)
	go func() { done <- e.Recover() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Recover blocked on the low-priority run's slow activity")
	}

	// The Normal run was recovered synchronously — completed before Recover returned.
	if atomic.LoadInt32(&fastRan) != 1 {
		t.Fatalf("fast activity ran %d times, want 1 (synchronous recovery)", fastRan)
	}
	if s, _ := e.Status("fast-run"); s != StatusCompleted {
		t.Fatalf("fast run status = %s, want completed", s)
	}
	// The Low run is still in-flight in the background — not completed.
	if atomic.LoadInt32(&slowDone) != 0 {
		t.Fatal("slow activity completed before release — was it recovered synchronously?")
	}
	if s, _ := e.Status("slow-run"); s != StatusRunning {
		t.Fatalf("slow run status = %s, want running (deferred to background)", s)
	}

	// Releasing it lets the background recovery finish; Wait() covers that goroutine.
	close(release)
	e.Wait()
	if s, _ := e.Status("slow-run"); s != StatusCompleted {
		t.Fatalf("slow run status = %s, want completed after release", s)
	}
}

// TestStartWorkflowDeferLow proves that StartWorkflowDeferLow runs a workflow's
// fast leading activities synchronously but yields to the background at the
// first live PriorityLow activity — so a fire-and-forget start (e.g. pr_status,
// whose only slow step is an LLM summary) returns promptly instead of blocking
// the caller on that activity.
func TestStartWorkflowDeferLow(t *testing.T) {
	e := New(NewMemoryStore())
	var fastRan, slowDone int32
	release := make(chan struct{})
	e.RegisterActivity("basics", func(context.Context, []byte) ([]byte, error) {
		atomic.AddInt32(&fastRan, 1)
		return []byte("null"), nil
	})
	e.RegisterActivity("summary", func(context.Context, []byte) ([]byte, error) {
		<-release // slow LLM-like step
		atomic.AddInt32(&slowDone, 1)
		return []byte("null"), nil
	})
	e.RegisterWorkflow("prstatus", func(w *Workflow, _ []byte) ([]byte, error) {
		if err := w.ExecuteActivity("basics", nil, nil); err != nil {
			return nil, err
		}
		if err := w.ExecuteActivity("summary", nil, nil); err != nil {
			return nil, err
		}
		return nil, nil
	})
	e.SetActivityPriority("summary", PriorityLow)

	done := make(chan string, 1)
	go func() {
		id, err := e.StartWorkflowDeferLow("prstatus", nil)
		if err != nil {
			t.Error(err)
		}
		done <- id
	}()
	var id string
	select {
	case id = <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("StartWorkflowDeferLow blocked on the low-priority activity")
	}

	// The fast leading activity ran synchronously; the low one is deferred.
	if atomic.LoadInt32(&fastRan) != 1 {
		t.Fatalf("basics ran %d times, want 1 (synchronous)", fastRan)
	}
	if atomic.LoadInt32(&slowDone) != 0 {
		t.Fatal("summary completed before release — it wasn't deferred")
	}
	if s, _ := e.Status(id); s != StatusRunning {
		t.Fatalf("status = %s, want running (deferred to background)", s)
	}

	close(release)
	e.Wait()
	if s, _ := e.Status(id); s != StatusCompleted {
		t.Fatalf("status = %s, want completed after release", s)
	}
	if atomic.LoadInt32(&fastRan) != 1 {
		t.Fatalf("basics ran %d times total, want 1 (replayed from history, not re-run)", fastRan)
	}
}

func TestSQLiteAndJSONLStores(t *testing.T) {
	dir := t.TempDir()
	sq, err := NewSQLiteStore(filepath.Join(dir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer sq.Close()
	jl, err := NewJSONLStore(filepath.Join(dir, "jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	// Combination store: SQLite + JSONL together.
	store := NewMultiStore(sq, jl)
	e := New(store)
	e.RegisterActivity("double", func(_ context.Context, in []byte) ([]byte, error) {
		var n int
		_ = json.Unmarshal(in, &n)
		return json.Marshal(n * 2)
	})
	e.RegisterWorkflow("math", func(w *Workflow, in []byte) ([]byte, error) {
		var n int
		_ = json.Unmarshal(in, &n)
		var out int
		if err := w.ExecuteActivity("double", n, &out); err != nil {
			return nil, err
		}
		return json.Marshal(out)
	})
	id, err := e.StartWorkflow("math", 21)
	if err != nil {
		t.Fatal(err)
	}
	var got int
	if err := e.Result(id, &got); err != nil {
		t.Fatal(err)
	}
	if got != 42 {
		t.Fatalf("got %d, want 42", got)
	}

	// Both stores must independently hold the same run.
	for _, s := range []Store{sq, jl} {
		runs, err := s.ListRuns()
		if err != nil {
			t.Fatal(err)
		}
		if len(runs) != 1 || runs[0].Status != StatusCompleted {
			t.Fatalf("store %T runs = %+v", s, runs)
		}
	}
}

// TestEngineDeleteRun proves Engine.DeleteRun removes a run's metadata + full
// history from every wrapped store (both SQLite rows and the JSONL files on
// disk), and that deleting an already-gone (or never-existing) run ID is a
// no-op, not an error — the idempotency a repeated daily cleanup pass relies
// on.
func TestEngineDeleteRun(t *testing.T) {
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
	e.RegisterActivity("double", func(_ context.Context, in []byte) ([]byte, error) {
		var n int
		_ = json.Unmarshal(in, &n)
		return json.Marshal(n * 2)
	})
	e.RegisterWorkflow("math", func(w *Workflow, in []byte) ([]byte, error) {
		var n int
		_ = json.Unmarshal(in, &n)
		var out int
		if err := w.ExecuteActivity("double", n, &out); err != nil {
			return nil, err
		}
		return json.Marshal(out)
	})
	id, err := e.StartWorkflow("math", 21)
	if err != nil {
		t.Fatal(err)
	}

	metaPath := filepath.Join(jsonlDir, id+".meta.jsonl")
	eventsPath := filepath.Join(jsonlDir, id+".events.jsonl")
	if _, err := readLines(metaPath); err != nil {
		t.Fatalf("expected jsonl meta file to exist before delete: %v", err)
	}

	if err := e.DeleteRun(id); err != nil {
		t.Fatalf("DeleteRun: %v", err)
	}

	if runs, err := e.Runs(); err != nil || len(runs) != 0 {
		t.Fatalf("Runs() after delete = %+v, %v, want empty", runs, err)
	}
	if _, err := e.Status(id); err == nil {
		t.Fatal("expected Status to error for a deleted run")
	}
	var out int
	if err := e.Result(id, &out); err == nil {
		t.Fatal("expected Result to error for a deleted run")
	}
	if lines, err := readLines(metaPath); err != nil || len(lines) != 0 {
		t.Fatalf("jsonl meta file after delete: lines=%v err=%v, want gone/empty", lines, err)
	}
	if lines, err := readLines(eventsPath); err != nil || len(lines) != 0 {
		t.Fatalf("jsonl events file after delete: lines=%v err=%v, want gone/empty", lines, err)
	}

	// Idempotent: deleting again (and deleting a run that never existed) must
	// not error.
	if err := e.DeleteRun(id); err != nil {
		t.Fatalf("second DeleteRun of the same id: %v", err)
	}
	if err := e.DeleteRun("never-existed"); err != nil {
		t.Fatalf("DeleteRun of an unknown id: %v", err)
	}
}

// TestResumeFailedContinuesFromLastGoodStep covers Engine.ResumeFailed against
// the real production store combination (SQLite + JSONL through a MultiStore),
// so the new TruncateEvents implementations are exercised, not just the
// in-memory one: the failure tail is cut, the activity that already succeeded
// is replayed from the history instead of re-run, and only the step that
// failed executes a second time.
func TestResumeFailedContinuesFromLastGoodStep(t *testing.T) {
	dir := t.TempDir()
	sq, err := NewSQLiteStore(filepath.Join(dir, "wf.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer sq.Close()
	jl, err := NewJSONLStore(filepath.Join(dir, "jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	e := New(NewMultiStore(sq, jl))

	var good, flaky int32
	e.RegisterActivity("good", func(_ context.Context, in []byte) ([]byte, error) {
		atomic.AddInt32(&good, 1)
		return []byte(`"ok"`), nil
	})
	e.RegisterActivity("flaky", func(_ context.Context, in []byte) ([]byte, error) {
		if atomic.AddInt32(&flaky, 1) == 1 {
			return nil, errUnavailable
		}
		return nil, nil
	})
	e.RegisterWorkflow("two_steps", func(w *Workflow, input []byte) ([]byte, error) {
		var out string
		if err := w.ExecuteActivity("good", nil, &out); err != nil {
			return nil, err
		}
		if err := w.ExecuteActivity("flaky", nil, nil); err != nil {
			return nil, err
		}
		return []byte(`"done"`), nil
	})

	runID, err := e.StartWorkflow("two_steps", nil)
	if err != nil {
		t.Fatal(err)
	}
	if st, _ := e.Status(runID); st != StatusFailed {
		t.Fatalf("status = %q, want failed", st)
	}
	beforeHist, _ := e.History(runID)
	if beforeHist[len(beforeHist)-1].Type != EventWorkflowFailed {
		t.Fatalf("history does not end in WorkflowFailed: %+v", beforeHist)
	}

	if err := e.ResumeFailed(runID); err != nil {
		t.Fatalf("ResumeFailed: %v", err)
	}
	if st, _ := e.Status(runID); st != StatusCompleted {
		t.Fatalf("status after resume = %q, want completed", st)
	}
	if got := atomic.LoadInt32(&good); got != 1 {
		t.Fatalf("the successful activity ran %d times, want 1 (replayed from history)", got)
	}
	if got := atomic.LoadInt32(&flaky); got != 2 {
		t.Fatalf("the failed activity ran %d times, want 2", got)
	}
	// The truncation really landed in BOTH stores: the JSONL events file is
	// rewritten, so reading it back must not resurrect the old failure tail.
	_, jlHist, err := jl.LoadRun(runID)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range jlHist {
		if ev.Type == EventWorkflowFailed || ev.Type == EventActivityFailed {
			t.Fatalf("JSONL history still holds a failure event: %+v", jlHist)
		}
	}
	if jlHist[len(jlHist)-1].Type != EventWorkflowCompleted {
		t.Fatalf("JSONL history does not end in WorkflowCompleted: %+v", jlHist)
	}
	// Seqs stay a gapless prefix + the new tail.
	for i, ev := range jlHist {
		if ev.Seq != i {
			t.Fatalf("event %d has seq %d; the history must stay gapless: %+v", i, ev.Seq, jlHist)
		}
	}

	// Resuming a run that is not failed is refused.
	if err := e.ResumeFailed(runID); err == nil {
		t.Fatal("ResumeFailed accepted a completed run; want an error")
	}
}

var errUnavailable = errors.New("temporarily unavailable")

// TestResumeFailedInBackgroundReturnsBeforeTheStep covers the retry button's
// path: the resumed step blocks (an LLM call queued behind a busy slot pool),
// yet the call returns straight away with the run already back to `running`,
// and the step still completes the run once it unblocks. A run that is not
// failed is reported per ID, not silently dropped.
func TestResumeFailedInBackgroundReturnsBeforeTheStep(t *testing.T) {
	e := New(NewMemoryStore())
	release := make(chan struct{})
	var calls int32
	e.RegisterActivity("slow", func(_ context.Context, in []byte) ([]byte, error) {
		if atomic.AddInt32(&calls, 1) == 1 {
			return nil, errUnavailable
		}
		<-release
		return nil, nil
	})
	e.RegisterWorkflow("one_step", func(w *Workflow, input []byte) ([]byte, error) {
		return nil, w.ExecuteActivity("slow", nil, nil)
	})
	runID, err := e.StartWorkflow("one_step", nil)
	if err != nil {
		t.Fatal(err)
	}
	if st, _ := e.Status(runID); st != StatusFailed {
		t.Fatalf("status = %q, want failed", st)
	}

	resumed, errs := e.ResumeFailedInBackground([]string{runID, "nope"})
	if len(resumed) != 1 || resumed[0] != runID {
		t.Fatalf("resumed = %v, want [%s]", resumed, runID)
	}
	if errs["nope"] == nil || errs[runID] != nil {
		t.Fatalf("errs = %v, want only the unknown run refused", errs)
	}
	if st, _ := e.Status(runID); st != StatusRunning {
		t.Fatalf("status while the step blocks = %q, want running", st)
	}
	close(release)
	e.Wait()
	if st, _ := e.Status(runID); st != StatusCompleted {
		t.Fatalf("status after the step = %q, want completed", st)
	}
}
