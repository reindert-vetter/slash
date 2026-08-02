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
	"sort"
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

	mu            sync.Mutex
	workflows     map[string]WorkflowFunc
	activities    map[string]ActivityFunc
	priorities    map[string]Priority // recovery priority per workflow type
	actPriorities map[string]Priority // recovery priority per activity
	locks         map[string]*sync.Mutex
	timers        map[string]*time.Timer

	wg sync.WaitGroup // tracks in-flight timer callbacks + background recovery (for Wait)
}

// Priority controls the order — and the blocking behaviour — in which Recover
// re-drives mid-flight runs at startup. It affects only recovery; live
// StartWorkflow/SignalWorkflow are unaffected. See SetWorkflowPriority.
type Priority int

const (
	// PriorityLow runs are recovered in the background (after every
	// higher-priority run has been recovered synchronously), so a slow activity
	// in such a workflow — e.g. a long LLM/subprocess call — never blocks
	// startup or the fast, important workflows. Use it for workflows whose
	// activities are slow and deferrable.
	PriorityLow Priority = -1
	// PriorityNormal is the default: recovered synchronously at startup.
	PriorityNormal Priority = 0
	// PriorityHigh runs are recovered synchronously, ahead of Normal ones.
	PriorityHigh Priority = 1
)

// Option configures an Engine.
type Option func(*Engine)

// WithClock overrides the wall clock (handy in tests).
func WithClock(fn func() time.Time) Option { return func(e *Engine) { e.clock = fn } }

// WithLogger overrides the log function (default: log.Printf).
func WithLogger(fn func(string, ...any)) Option { return func(e *Engine) { e.logf = fn } }

// New returns an Engine backed by store.
func New(store Store, opts ...Option) *Engine {
	e := &Engine{
		store:         store,
		clock:         time.Now,
		logf:          log.Printf,
		workflows:     map[string]WorkflowFunc{},
		activities:    map[string]ActivityFunc{},
		priorities:    map[string]Priority{},
		actPriorities: map[string]Priority{},
		locks:         map[string]*sync.Mutex{},
		timers:        map[string]*time.Timer{},
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

// SetWorkflowPriority sets the recovery priority for a workflow type (default
// PriorityNormal). It affects only Recover(): PriorityLow runs are re-driven in
// the background — after every higher-priority run has been recovered
// synchronously — so a slow activity in such a workflow (an LLM/subprocess call)
// never blocks startup or the fast, important workflows. See Priority.
func (e *Engine) SetWorkflowPriority(name string, p Priority) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.priorities[name] = p
}

func (e *Engine) priorityOf(workflow string) Priority {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.priorities[workflow] // zero value == PriorityNormal
}

// SetActivityPriority marks an activity's recovery priority (default
// PriorityNormal). It matters only during Recover(): if a Normal/High-priority
// workflow is being recovered synchronously and its replay reaches a
// PriorityLow activity whose result was NOT yet recorded — so it would
// re-execute live — the whole run is deferred to the background instead of
// running that slow activity on the startup path. Any already-recorded
// activities replay from history as usual; only a live (unrecorded) low
// activity triggers the deferral. This lets one slow LLM/subprocess activity
// inside an otherwise important, fast workflow (e.g. a summary step) not block
// startup, without demoting the whole workflow to PriorityLow.
func (e *Engine) SetActivityPriority(name string, p Priority) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.actPriorities[name] = p
}

func (e *Engine) activityPriorityOf(name string) Priority {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.actPriorities[name] // zero value == PriorityNormal
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
	return e.startWorkflowID(newRunID(), name, input, false, "")
}

// StartWorkflowDeferLow is StartWorkflow but yields to the background at the
// first live PriorityLow activity (exactly like Recover's synchronous phase)
// instead of running it on the caller's goroutine. Use it for a fire-and-forget
// start whose early steps are fast but which then reaches a slow (LLM/
// subprocess) activity: the caller returns promptly and the slow work drains in
// the background, filling the run's read models progressively as it records
// each step. If the workflow has no live low-priority activity, it behaves like
// StartWorkflow (runs synchronously until it blocks/completes).
func (e *Engine) StartWorkflowDeferLow(name string, input any) (string, error) {
	return e.startWorkflowID(newRunID(), name, input, true, "")
}

// StartWorkflowID is StartWorkflow with a caller-supplied run ID, making the
// start idempotent: if a run with id already exists (any status), it is a no-op
// that returns id unchanged — the existing run is left exactly as it is. This
// lets a caller derive a deterministic ID from an external key (e.g.
// "gh-<commentID>") so a repeated start — the same poll running twice, or a
// restart re-observing the same GitHub comment — never creates a second
// Execution. The existence check + create is done under the run lock so two
// concurrent starts of the same id can't both create.
func (e *Engine) StartWorkflowID(id, name string, input any) (string, error) {
	return e.startWorkflowID(id, name, input, false, "")
}

// startChildWorkflow starts a run with the given (deterministically derived)
// childID, recording parentID as its ParentRunID so the run's terminal event
// can later be propagated back (see advanceMode). Like StartWorkflowID it is
// idempotent: replaying ExecuteChildWorkflow's already-recorded start is a
// no-op reuse of the existing child run.
func (e *Engine) startChildWorkflow(parentID, childID, name string, input json.RawMessage) error {
	_, err := e.startWorkflowID(childID, name, input, false, parentID)
	return err
}

func (e *Engine) startWorkflowID(id, name string, input any, deferLow bool, parentRunID string) (string, error) {
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

	l := e.runLock(id)
	l.Lock()

	// Idempotent reuse: a run with this ID already exists → no-op.
	if _, _, err := e.store.LoadRun(id); err == nil {
		l.Unlock()
		return id, nil
	}

	now := e.now()
	rec := RunRecord{ID: id, Workflow: name, Status: StatusRunning, CreatedAt: now, UpdatedAt: now, ParentRunID: parentRunID}
	if err := e.store.CreateRun(rec); err != nil {
		l.Unlock()
		return "", err
	}
	if err := e.store.AppendEvent(id, Event{Seq: 0, Type: EventWorkflowStarted, Payload: in, Time: now}); err != nil {
		l.Unlock()
		return "", err
	}

	deferred := e.advanceMode(id, deferLow)
	l.Unlock()
	// Reached a live PriorityLow activity under deferLow — finish driving the
	// run in the background so the caller returns promptly (the run is durable;
	// the background advance replays to the same point and runs the activity).
	if deferred {
		e.wg.Add(1)
		go func() {
			defer e.wg.Done()
			l := e.runLock(id)
			l.Lock()
			e.advance(id)
			l.Unlock()
		}()
	}
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
func (e *Engine) advance(runID string) { e.advanceMode(runID, false) }

// advanceMode is advance with a recovery-time flag. When deferLow is true, a
// live (not-yet-recorded) PriorityLow activity yields the run instead of
// running — reported as deferred == true — so the caller can re-drive it in the
// background rather than blocking on a slow activity. deferLow is set only by
// Recover's synchronous phase; every other caller (Start/Signal/timer/the
// background drain) passes false and runs activities inline as usual.
func (e *Engine) advanceMode(runID string, deferLow bool) (deferred bool) {
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

	w := &Workflow{engine: e, runID: runID, history: hist, sigIdx: map[string]int{}, deferLowActivities: deferLow}

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
	case blk != nil && blk.kind == "defer":
		// A recovering Normal/High run reached a live PriorityLow activity — no
		// event was recorded (the panic fired before the activity ran), so the
		// run stays exactly as it was (still running/waiting). Report it so the
		// caller re-drives it in the background with defer off.
		deferred = true
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
		e.propagateToParent(rec.ParentRunID, runID, fmt.Errorf("panic: %v", panicked), nil)
	case done && wErr != nil:
		if safeRecord(w, Event{Type: EventWorkflowFailed, Error: wErr.Error()}) {
			e.logf("tembed: concurrent advance for run %s, will retry", runID)
			return
		}
		e.setStatus(runID, StatusFailed)
		e.propagateToParent(rec.ParentRunID, runID, wErr, nil)
	case done:
		if safeRecord(w, Event{Type: EventWorkflowCompleted, Payload: result, Time: now}) {
			e.logf("tembed: concurrent advance for run %s, will retry", runID)
			return
		}
		e.setStatus(runID, StatusCompleted)
		e.propagateToParent(rec.ParentRunID, runID, nil, result)
	}
	return deferred
}

// propagateToParent records a child workflow's outcome (childID, the child's
// own runID) on its parent run and re-drives the parent — mirroring how
// fireTimer re-drives a run after recording a TimerFired event. A no-op if
// parentRunID is empty (a top-level run has no parent).
//
// Runs in its own goroutine (tracked by e.wg, like a timer callback or an
// async activity): the caller (advanceMode) may still hold the CHILD's own
// run lock, and — when a child finishes fully synchronously during its own
// start, nested inside ExecuteChildWorkflow — that call is itself nested
// inside the PARENT's advanceMode, which already holds the parent's run lock
// on this very goroutine. Taking the parent's lock synchronously here would
// then self-deadlock; a fresh goroutine simply waits for that lock to free up
// once the parent's current run finishes, exactly as any other concurrent
// caller of the parent's lock would.
func (e *Engine) propagateToParent(parentRunID, childID string, childErr error, childResult []byte) {
	if parentRunID == "" {
		return
	}
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		l := e.runLock(parentRunID)
		l.Lock()
		defer l.Unlock()

		rec, hist, err := e.store.LoadRun(parentRunID)
		if err != nil {
			e.logf("tembed: propagateToParent load %s: %v", parentRunID, err)
			return
		}
		if rec.Status == StatusCompleted || rec.Status == StatusFailed {
			return
		}
		ev := Event{Seq: len(hist), Name: childID, Time: e.now()}
		if childErr != nil {
			ev.Type = EventChildWorkflowFailed
			ev.Error = childErr.Error()
		} else {
			ev.Type = EventChildWorkflowCompleted
			ev.Payload = childResult
		}
		if err := e.store.AppendEvent(parentRunID, ev); err != nil {
			if errors.Is(err, ErrDuplicateEvent) {
				return
			}
			e.logf("tembed: propagateToParent append %s: %v", parentRunID, err)
			return
		}
		e.advance(parentRunID)
	}()
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

// launchAsyncActivity runs the named activity for an ExecuteActivityAsync call
// in its own goroutine (tracked by e.wg, like a timer callback) and records its
// result under key once it finishes. An unknown activity name is completed as
// an immediate failure without spawning a goroutine.
func (e *Engine) launchAsyncActivity(runID, key, name string, input []byte) {
	e.mu.Lock()
	fn := e.activities[name]
	e.mu.Unlock()
	if fn == nil {
		e.completeAsyncActivity(runID, key, nil, fmt.Errorf("tembed: unknown activity %q", name))
		return
	}
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		out, aerr := fn(context.Background(), input)
		e.completeAsyncActivity(runID, key, out, aerr)
	}()
}

// completeAsyncActivity records the outcome of an async activity started by
// launchAsyncActivity and re-drives the run. It takes the run's lock, so it
// is safe to call from the activity's own goroutine, independent of whatever
// else is currently advancing that run. A run that has already finished (or a
// duplicate completion — e.g. a repeated Recover) is silently ignored.
func (e *Engine) completeAsyncActivity(runID, key string, out []byte, aerr error) {
	l := e.runLock(runID)
	l.Lock()
	defer l.Unlock()

	rec, hist, err := e.store.LoadRun(runID)
	if err != nil {
		e.logf("tembed: completeAsyncActivity load %s: %v", runID, err)
		return
	}
	if rec.Status == StatusCompleted || rec.Status == StatusFailed {
		return
	}
	// Already recorded (e.g. this completion raced a duplicate launch) — nothing to do.
	for _, ev := range hist {
		if ev.Name == key && (ev.Type == EventAsyncActivityCompleted || ev.Type == EventAsyncActivityFailed) {
			return
		}
	}
	ev := Event{Seq: len(hist), Name: key, Time: e.now()}
	if aerr != nil {
		ev.Type = EventAsyncActivityFailed
		ev.Error = aerr.Error()
	} else {
		ev.Type = EventAsyncActivityCompleted
		ev.Payload = out
	}
	if err := e.store.AppendEvent(runID, ev); err != nil {
		if errors.Is(err, ErrDuplicateEvent) {
			// Some other writer already recorded this run's next event —
			// benign race, same tolerance as Workflow.record.
			return
		}
		e.logf("tembed: completeAsyncActivity append %s: %v", runID, err)
		return
	}
	e.advance(runID)
}

// resumePendingAsync re-launches every async activity that was scheduled
// (EventActivityScheduled) but has no matching completion event yet — i.e. it
// was still in flight when the process last stopped. Called once per run
// during Recover, under that run's lock, before the run is (re)driven.
func (e *Engine) resumePendingAsync(runID string, hist []Event) {
	done := map[string]bool{}
	for _, ev := range hist {
		if ev.Type == EventAsyncActivityCompleted || ev.Type == EventAsyncActivityFailed {
			done[ev.Name] = true
		}
	}
	for _, ev := range hist {
		if ev.Type != EventActivityScheduled || done[ev.Name] {
			continue
		}
		name := ev.Name
		if i := lastIndexByte(name, '#'); i >= 0 {
			name = name[:i]
		}
		e.launchAsyncActivity(runID, ev.Name, name, ev.Payload)
	}
}

// lastIndexByte returns the index of the last occurrence of b in s, or -1.
func lastIndexByte(s string, b byte) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == b {
			return i
		}
	}
	return -1
}

// Recover re-drives every run that was mid-flight (running or waiting) when the
// process last stopped: it replays their histories, reschedules pending timers,
// and re-blocks on unfulfilled signals. Call it once at startup.
//
// Recovery is prioritised (see SetWorkflowPriority): runs of Normal/High
// priority are re-driven synchronously here (High first), so Recover blocks
// until they're back on their feet. Runs of PriorityLow are re-driven in a
// background goroutine that drains them serially, so a slow activity in such a
// workflow — a long LLM/subprocess call whose result wasn't yet recorded when
// the process died, and which therefore re-executes live on replay — never
// blocks Recover's return (and thus the caller's ListenAndServe) or the
// recovery of the fast, important workflows above it. The background goroutine
// is tracked by e.wg, so Wait() still covers it (tests, graceful shutdown).
func (e *Engine) Recover() error {
	runs, err := e.store.ListRuns()
	if err != nil {
		return err
	}
	var immediate, deferred []RunRecord
	for _, r := range runs {
		if r.Status != StatusRunning && r.Status != StatusWaiting {
			continue
		}
		if e.priorityOf(r.Workflow) <= PriorityLow {
			deferred = append(deferred, r)
		} else {
			immediate = append(immediate, r)
		}
	}
	// Re-launch any async activity (ExecuteActivityAsync) that was still in
	// flight when the process last stopped, for every mid-flight run — a pass
	// of its own, independent of the immediate/deferred priority split above,
	// because this does not drive the workflow function itself: it only makes
	// sure the eventual completion event gets recorded (which, via
	// completeAsyncActivity, re-drives the run on its own).
	for _, r := range append(append([]RunRecord{}, immediate...), deferred...) {
		l := e.runLock(r.ID)
		l.Lock()
		if _, hist, err := e.store.LoadRun(r.ID); err == nil {
			e.resumePendingAsync(r.ID, hist)
		}
		l.Unlock()
	}
	// Higher priority first; stable so equal-priority runs keep ListRuns order.
	sort.SliceStable(immediate, func(i, j int) bool {
		return e.priorityOf(immediate[i].Workflow) > e.priorityOf(immediate[j].Workflow)
	})
	for _, r := range immediate {
		l := e.runLock(r.ID)
		l.Lock()
		// Recover synchronously, but with activity-level deferral on: if this
		// run's replay reaches a live PriorityLow activity, it yields (nothing
		// recorded) and joins the background drain instead of blocking here.
		if e.advanceMode(r.ID, true) {
			deferred = append(deferred, r)
		}
		l.Unlock()
	}
	// Drain low-priority runs serially in the background — one at a time, to
	// avoid a thundering herd of side-effecting activities (dozens of
	// subprocess/LLM calls launching at once). Each advance still takes the
	// run's own lock, so a live server request touching the same run is safe.
	if len(deferred) > 0 {
		e.wg.Add(1)
		go func() {
			defer e.wg.Done()
			for _, r := range deferred {
				l := e.runLock(r.ID)
				l.Lock()
				e.advance(r.ID)
				l.Unlock()
			}
		}()
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

// DeleteRun permanently removes a run's metadata and full event history from
// the store (and, e.g. a JSONL store, its files on disk) — a durable-cleanup
// primitive, not a workflow concept itself: a caller (an Activity of some
// other, PR-scoped cleanup workflow, say) decides which runs qualify and
// calls this for each. Deleting an unknown run ID is a no-op, not an error,
// so a repeated/idempotent cleanup pass never fails on a run it already
// removed. Also cancels any pending durable timer for runID and releases its
// run lock, so a deleted run can never be woken up again.
func (e *Engine) DeleteRun(runID string) error {
	l := e.runLock(runID)
	l.Lock()
	defer l.Unlock()

	e.mu.Lock()
	if t, ok := e.timers[runID]; ok {
		t.Stop()
		delete(e.timers, runID)
	}
	e.mu.Unlock()

	err := e.store.DeleteRun(runID)

	e.mu.Lock()
	delete(e.locks, runID)
	e.mu.Unlock()

	return err
}

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
