// Package tembed is a small, embeddable durable-workflow engine — "Temporal,
// but a Go package you link into your program". You define workflows and
// activities as plain Go functions; tembed persists an append-only event
// history per run and replays it deterministically, so a workflow survives a
// process restart and never re-runs an activity whose result is already
// recorded. It supports activities, external signals, and durable timers, and
// can persist to SQLite, JSONL, or both (see MultiStore).
//
// A workflow is deterministic: all non-determinism (side effects, time,
// external input) must flow through the *Workflow handle — ExecuteActivity,
// WaitSignal, Sleep, SideEffect, Now — so replay reproduces the same decisions.
package tembed

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"
)

// WorkflowFunc is a workflow definition. It orchestrates activities and reacts
// to signals through w; input/output are JSON-encoded. It must be
// deterministic across replays.
type WorkflowFunc func(w *Workflow, input []byte) ([]byte, error)

// ActivityFunc is a unit of (possibly side-effecting) work. Its result is
// recorded in history so a replay does not re-run it.
type ActivityFunc func(ctx context.Context, input []byte) ([]byte, error)

// Engine registers workflows/activities and drives run execution.
type Engine struct {
	store Store
	clock func() time.Time
	logf  func(string, ...any)

	mu         sync.Mutex
	workflows  map[string]WorkflowFunc
	activities map[string]ActivityFunc
	locks      map[string]*sync.Mutex
	timers     map[string]*time.Timer

	wg sync.WaitGroup // tracks in-flight timer callbacks (for Wait)
}

// Option configures an Engine.
type Option func(*Engine)

// WithClock overrides the wall clock (handy in tests).
func WithClock(fn func() time.Time) Option { return func(e *Engine) { e.clock = fn } }

// WithLogger overrides the log function (default: log.Printf).
func WithLogger(fn func(string, ...any)) Option { return func(e *Engine) { e.logf = fn } }

// New returns an Engine backed by store.
func New(store Store, opts ...Option) *Engine {
	e := &Engine{
		store:      store,
		clock:      time.Now,
		logf:       log.Printf,
		workflows:  map[string]WorkflowFunc{},
		activities: map[string]ActivityFunc{},
		locks:      map[string]*sync.Mutex{},
		timers:     map[string]*time.Timer{},
	}
	for _, o := range opts {
		o(e)
	}
	return e
}

// RegisterWorkflow registers a workflow definition under name.
func (e *Engine) RegisterWorkflow(name string, fn WorkflowFunc) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.workflows[name] = fn
}

// RegisterActivity registers an activity under name.
func (e *Engine) RegisterActivity(name string, fn ActivityFunc) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.activities[name] = fn
}

func (e *Engine) now() time.Time { return e.clock() }

func (e *Engine) runLock(runID string) *sync.Mutex {
	e.mu.Lock()
	defer e.mu.Unlock()
	l := e.locks[runID]
	if l == nil {
		l = &sync.Mutex{}
		e.locks[runID] = l
	}
	return l
}

func newRunID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// StartWorkflow creates a new run of the named workflow with input (JSON-
// encoded) and drives it until it blocks or completes. It returns the run ID.
func (e *Engine) StartWorkflow(name string, input any) (string, error) {
	e.mu.Lock()
	_, ok := e.workflows[name]
	e.mu.Unlock()
	if !ok {
		return "", fmt.Errorf("tembed: unknown workflow %q", name)
	}
	in, err := json.Marshal(input)
	if err != nil {
		return "", fmt.Errorf("tembed: marshal input: %w", err)
	}
	id := newRunID()
	now := e.now()
	rec := RunRecord{ID: id, Workflow: name, Status: StatusRunning, CreatedAt: now, UpdatedAt: now}
	if err := e.store.CreateRun(rec); err != nil {
		return "", err
	}
	if err := e.store.AppendEvent(id, Event{Seq: 0, Type: EventWorkflowStarted, Payload: in, Time: now}); err != nil {
		return "", err
	}

	l := e.runLock(id)
	l.Lock()
	defer l.Unlock()
	e.advance(id)
	return id, nil
}

// SignalWorkflow delivers a named signal (with JSON payload) to a run and
// drives it forward. Signals are buffered in history: a signal that arrives
// before the workflow asks for it waits until it does.
func (e *Engine) SignalWorkflow(runID, signal string, payload any) error {
	pl, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("tembed: marshal signal payload: %w", err)
	}
	l := e.runLock(runID)
	l.Lock()
	defer l.Unlock()

	rec, hist, err := e.store.LoadRun(runID)
	if err != nil {
		return err
	}
	if rec.Status == StatusCompleted || rec.Status == StatusFailed {
		return fmt.Errorf("tembed: run %s already %s", runID, rec.Status)
	}
	ev := Event{Seq: len(hist), Type: EventSignalReceived, Name: signal, Payload: pl, Time: e.now()}
	if err := e.store.AppendEvent(runID, ev); err != nil {
		return err
	}
	e.advance(runID)
	return nil
}

// blocked is the sentinel panic used to yield a workflow that cannot proceed.
type blocked struct {
	kind   string // "signal" or "timer"
	fireAt time.Time
}

// advance loads the run, replays its history by re-running the workflow
// function, executes any newly reached activities, and persists the outcome.
// The caller must hold the run lock.
func (e *Engine) advance(runID string) {
	rec, hist, err := e.store.LoadRun(runID)
	if err != nil {
		e.logf("tembed: advance load %s: %v", runID, err)
		return
	}
	if rec.Status == StatusCompleted || rec.Status == StatusFailed {
		return
	}
	e.mu.Lock()
	fn := e.workflows[rec.Workflow]
	e.mu.Unlock()
	if fn == nil {
		e.logf("tembed: run %s uses unregistered workflow %q", runID, rec.Workflow)
		return
	}

	var input []byte
	if len(hist) > 0 && hist[0].Type == EventWorkflowStarted {
		input = hist[0].Payload
	}

	w := &Workflow{engine: e, runID: runID, history: hist, sigIdx: map[string]int{}}

	var (
		result   []byte
		wErr     error
		blk      *blocked
		panicked any
		done     bool
	)
	func() {
		defer func() {
			if r := recover(); r != nil {
				if b, ok := r.(blocked); ok {
					blk = &b
					return
				}
				panicked = r
			}
		}()
		result, wErr = fn(w, input)
		done = true
	}()

	now := e.now()
	switch {
	case blk != nil && blk.kind == "concurrent":
		// Another writer already recorded this run's next event (lost a
		// race, see Workflow.record). Our speculative in-memory event was
		// never persisted, so durable state is untouched — abandon this
		// attempt and let the next advance (a poll, a signal, or the next
		// Recover) replay against the now-current history.
		e.logf("tembed: concurrent advance for run %s, will retry", runID)
	case blk != nil && blk.kind == "timer":
		e.setStatus(runID, StatusWaiting)
		e.scheduleTimer(runID, blk.fireAt)
	case blk != nil: // signal
		e.setStatus(runID, StatusWaiting)
	case panicked != nil:
		if safeRecord(w, Event{Type: EventWorkflowFailed, Error: fmt.Sprintf("panic: %v", panicked)}) {
			e.logf("tembed: concurrent advance for run %s, will retry", runID)
			return
		}
		e.setStatus(runID, StatusFailed)
	case done && wErr != nil:
		if safeRecord(w, Event{Type: EventWorkflowFailed, Error: wErr.Error()}) {
			e.logf("tembed: concurrent advance for run %s, will retry", runID)
			return
		}
		e.setStatus(runID, StatusFailed)
	case done:
		if safeRecord(w, Event{Type: EventWorkflowCompleted, Payload: result, Time: now}) {
			e.logf("tembed: concurrent advance for run %s, will retry", runID)
			return
		}
		e.setStatus(runID, StatusCompleted)
	}
}

// safeRecord records e on w, tolerating the case where some other writer
// already recorded this run's next event concurrently (see Workflow.record).
// It reports whether that happened (concurrent == true), in which case the
// caller must not touch the run's status — a later advance will retry. Any
// other panic from record (a real persistence failure) is re-raised.
func safeRecord(w *Workflow, e Event) (concurrent bool) {
	defer func() {
		if r := recover(); r != nil {
			if b, ok := r.(blocked); ok && b.kind == "concurrent" {
				concurrent = true
				return
			}
			panic(r)
		}
	}()
	w.record(e)
	return false
}

func (e *Engine) setStatus(runID, status string) {
	if err := e.store.SetStatus(runID, status, e.now()); err != nil {
		e.logf("tembed: set status %s=%s: %v", runID, status, err)
	}
}

// scheduleTimer arranges for a TimerFired event at fireAt (or immediately if it
// is already past), unless a timer for this run is already pending.
func (e *Engine) scheduleTimer(runID string, fireAt time.Time) {
	e.mu.Lock()
	if _, exists := e.timers[runID]; exists {
		e.mu.Unlock()
		return
	}
	d := fireAt.Sub(e.now())
	if d < 0 {
		d = 0
	}
	e.wg.Add(1)
	t := time.AfterFunc(d, func() {
		defer e.wg.Done()
		e.fireTimer(runID)
	})
	e.timers[runID] = t
	e.mu.Unlock()
}

func (e *Engine) fireTimer(runID string) {
	l := e.runLock(runID)
	l.Lock()
	defer l.Unlock()

	e.mu.Lock()
	delete(e.timers, runID)
	e.mu.Unlock()

	rec, hist, err := e.store.LoadRun(runID)
	if err != nil {
		e.logf("tembed: fireTimer load %s: %v", runID, err)
		return
	}
	if rec.Status != StatusWaiting {
		return
	}
	ev := Event{Seq: len(hist), Type: EventTimerFired, Time: e.now()}
	if err := e.store.AppendEvent(runID, ev); err != nil {
		e.logf("tembed: fireTimer append %s: %v", runID, err)
		return
	}
	e.advance(runID)
}

// Recover re-drives every run that was mid-flight (running or waiting) when the
// process last stopped: it replays their histories, reschedules pending timers,
// and re-blocks on unfulfilled signals. Call it once at startup.
func (e *Engine) Recover() error {
	runs, err := e.store.ListRuns()
	if err != nil {
		return err
	}
	for _, r := range runs {
		if r.Status != StatusRunning && r.Status != StatusWaiting {
			continue
		}
		l := e.runLock(r.ID)
		l.Lock()
		e.advance(r.ID)
		l.Unlock()
	}
	return nil
}

// Wait blocks until all in-flight timer callbacks have completed. Mainly for
// tests and graceful shutdown.
func (e *Engine) Wait() { e.wg.Wait() }

// Status returns a run's current status.
func (e *Engine) Status(runID string) (string, error) {
	rec, _, err := e.store.LoadRun(runID)
	if err != nil {
		return "", err
	}
	return rec.Status, nil
}

// Result returns a completed run's result payload. It errors if the run is not
// yet completed (use Status to check) or if it failed.
func (e *Engine) Result(runID string, out any) error {
	rec, hist, err := e.store.LoadRun(runID)
	if err != nil {
		return err
	}
	switch rec.Status {
	case StatusCompleted:
		for _, ev := range hist {
			if ev.Type == EventWorkflowCompleted {
				if out == nil || len(ev.Payload) == 0 {
					return nil
				}
				return json.Unmarshal(ev.Payload, out)
			}
		}
		return nil
	case StatusFailed:
		for _, ev := range hist {
			if ev.Type == EventWorkflowFailed {
				return fmt.Errorf("tembed: workflow failed: %s", ev.Error)
			}
		}
		return errors.New("tembed: workflow failed")
	default:
		return fmt.Errorf("tembed: run %s not finished (status %s)", runID, rec.Status)
	}
}

// History returns a copy of a run's event history (for inspection/debugging).
func (e *Engine) History(runID string) ([]Event, error) {
	_, hist, err := e.store.LoadRun(runID)
	return hist, err
}

// Runs returns every run's metadata (for building read-models or resuming
// per-run side work such as pollers after a restart).
func (e *Engine) Runs() ([]RunRecord, error) { return e.store.ListRuns() }

// Input returns the JSON-encoded input a run was started with.
func (e *Engine) Input(runID string) ([]byte, error) {
	_, hist, err := e.store.LoadRun(runID)
	if err != nil {
		return nil, err
	}
	if len(hist) > 0 && hist[0].Type == EventWorkflowStarted {
		return hist[0].Payload, nil
	}
	return nil, nil
}
