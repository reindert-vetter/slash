package tembed

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"
)

// busyFixture registers a workflow that waits for "start", runs one SLOW
// activity (blocked until release is closed), then waits for "gate" and
// finally for two "msg" signals, noting each. entered is closed once the slow
// activity is running, i.e. while the advance holds the run lock.
type busyFixture struct {
	e       *Engine
	store   Store
	entered chan struct{}
	release chan struct{}
	mu      sync.Mutex
	slow    int
	notes   []string
}

func newBusyFixture(t *testing.T, store Store, optIn bool) *busyFixture {
	t.Helper()
	f := &busyFixture{store: store, entered: make(chan struct{}), release: make(chan struct{})}
	f.e = New(store)
	f.register(optIn)
	return f
}

func (f *busyFixture) register(optIn bool) {
	f.e.RegisterActivity("slow", func(context.Context, []byte) ([]byte, error) {
		f.mu.Lock()
		f.slow++
		f.mu.Unlock()
		close(f.entered)
		<-f.release
		return nil, nil
	})
	f.e.RegisterActivity("note", func(_ context.Context, in []byte) ([]byte, error) {
		var s string
		_ = json.Unmarshal(in, &s)
		f.mu.Lock()
		f.notes = append(f.notes, s)
		f.mu.Unlock()
		return nil, nil
	})
	f.e.RegisterWorkflow("tracker", func(w *Workflow, _ []byte) ([]byte, error) {
		w.WaitSignal("start", nil)
		if err := w.ExecuteActivity("slow", nil, nil); err != nil {
			return nil, err
		}
		w.WaitSignal("gate", nil)
		var got []string
		for i := 0; i < 2; i++ {
			var m string
			w.WaitSignal("msg", &m)
			if err := w.ExecuteActivity("note", m, nil); err != nil {
				return nil, err
			}
			got = append(got, m)
		}
		return json.Marshal(got)
	})
	if optIn {
		f.e.SetRecordSignalsWhileBusy("tracker", func(signal string, _ []byte) bool { return signal != "never-fast" })
	}
}

// startBusy starts the run and drives it into the slow activity on a
// background goroutine; done is closed once that advance returns.
func (f *busyFixture) startBusy(t *testing.T) (id string, done chan struct{}) {
	t.Helper()
	id, err := f.e.StartWorkflowID("run-1", "tracker", nil)
	if err != nil {
		t.Fatal(err)
	}
	done = make(chan struct{})
	go func() {
		defer close(done)
		if err := f.e.SignalWorkflow(id, "start", nil); err != nil {
			t.Error(err)
		}
	}()
	select {
	case <-f.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("slow activity never started")
	}
	return id, done
}

// signalWithin sends a signal and fails when it does not return within d.
func signalWithin(t *testing.T, e *Engine, id, name string, payload any, d time.Duration) {
	t.Helper()
	ret := make(chan error, 1)
	go func() { ret <- e.SignalWorkflow(id, name, payload) }()
	select {
	case err := <-ret:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(d):
		t.Fatalf("SignalWorkflow(%s) did not return within %s while the run was busy", name, d)
	}
}

// A signal to an opted-in workflow whose run is busy is recorded at once (so a
// read model sees it immediately), lands BETWEEN that advance's own events
// without disturbing positional replay, and is consumed later in arrival order.
func TestSignalRecordedWhileRunBusy(t *testing.T) {
	store := NewMemoryStore()
	f := newBusyFixture(t, store, true)
	id, done := f.startBusy(t)

	// While "slow" holds the lock: "msg" (not waited on yet) and "gate".
	signalWithin(t, f.e, id, "msg", "first", time.Second)
	hist, err := f.e.History(id)
	if err != nil {
		t.Fatal(err)
	}
	last := hist[len(hist)-1]
	if last.Type != EventSignalReceived || last.Name != "msg" {
		t.Fatalf("last event = %s/%s, want the msg signal recorded while busy", last.Type, last.Name)
	}
	signalWithin(t, f.e, id, "gate", nil, time.Second)

	close(f.release)
	<-done
	f.e.Wait()
	if s, _ := f.e.Status(id); s != StatusWaiting {
		t.Fatalf("status = %s, want waiting for the second msg", s)
	}
	if err := f.e.SignalWorkflow(id, "msg", "second"); err != nil {
		t.Fatal(err)
	}
	f.e.Wait()
	var got []string
	if err := f.e.Result(id, &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "first" || got[1] != "second" {
		t.Fatalf("result = %v, want [first second]", got)
	}

	// The SignalReceived for "first" sits between "slow"'s own events — and
	// seqs stay a gap-free 0..n-1 (no collision between the two writers).
	hist, _ = f.e.History(id)
	for i, ev := range hist {
		if ev.Seq != i {
			t.Fatalf("event %d has seq %d", i, ev.Seq)
		}
	}

	// Replay on a fresh engine over the same store: same result, nothing re-run.
	g := &busyFixture{store: store, entered: make(chan struct{}), release: make(chan struct{})}
	g.e = New(store)
	g.register(true)
	g.e.advance(id)
	var again []string
	if err := g.e.Result(id, &again); err != nil {
		t.Fatal(err)
	}
	if len(again) != 2 || again[0] != "first" || again[1] != "second" || g.slow != 0 || len(g.notes) != 0 {
		t.Fatalf("replay = %v (slow %d, notes %v), want same result and no re-run", again, g.slow, g.notes)
	}
}

// Without the opt-in a busy run keeps the old contract: SignalWorkflow waits
// for the lock (and therefore for the in-flight activity).
func TestSignalWaitsForBusyRunWithoutOptIn(t *testing.T) {
	f := newBusyFixture(t, NewMemoryStore(), false)
	id, done := f.startBusy(t)

	ret := make(chan error, 1)
	go func() { ret <- f.e.SignalWorkflow(id, "gate", nil) }()
	select {
	case <-ret:
		t.Fatal("SignalWorkflow returned while the run was busy, want it to wait for the lock")
	case <-time.After(150 * time.Millisecond):
	}
	close(f.release)
	<-done
	if err := <-ret; err != nil {
		t.Fatal(err)
	}
	f.e.Wait()
	hist, _ := f.e.History(id)
	if last := hist[len(hist)-1]; last.Type != EventSignalReceived || last.Name != "gate" {
		t.Fatalf("last event = %s/%s, want the gate signal after slow", last.Type, last.Name)
	}
}

// accept narrows the opt-in: a rejected signal keeps the blocking contract.
func TestSignalRejectedByAcceptWaitsForBusyRun(t *testing.T) {
	f := newBusyFixture(t, NewMemoryStore(), true)
	id, done := f.startBusy(t)

	ret := make(chan error, 1)
	go func() { ret <- f.e.SignalWorkflow(id, "never-fast", nil) }()
	select {
	case <-ret:
		t.Fatal("a signal accept rejects returned while the run was busy, want it to wait for the lock")
	case <-time.After(150 * time.Millisecond):
	}
	close(f.release)
	<-done
	if err := <-ret; err != nil {
		t.Fatal(err)
	}
	f.e.Wait()
}
