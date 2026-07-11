package tembed

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Workflow is the handle a WorkflowFunc uses to interact with the engine. Every
// method that introduces non-determinism records to (or replays from) the run's
// history so re-execution reproduces the same decisions.
//
// The cursors below count how many results of each kind the current replay has
// already consumed; they are matched positionally against the history, which is
// deterministic because activities and timers resolve in program order.
type Workflow struct {
	engine  *Engine
	runID   string
	history []Event

	actIdx   int            // activity results consumed
	timerIdx int            // timers consumed
	sideIdx  int            // side effects consumed
	sigIdx   map[string]int // per-name signals consumed
}

// RunID returns the run's unique ID.
func (w *Workflow) RunID() string { return w.runID }

// Now returns a deterministic timestamp: the recording time of the current
// step, captured once via SideEffect so replays see the same value.
func (w *Workflow) Now() time.Time {
	var ns int64
	w.SideEffect(&ns, func() any { return w.engine.now().UnixNano() })
	return time.Unix(0, ns)
}

// ExecuteActivity runs the registered activity name with input, decoding its
// result into result (which may be nil). On replay the recorded result is
// returned without re-running the activity. A failed activity returns an error.
func (w *Workflow) ExecuteActivity(name string, input, result any) error {
	in, err := json.Marshal(input)
	if err != nil {
		return fmt.Errorf("tembed: marshal activity input: %w", err)
	}
	if ev, ok := w.nthOf(w.actIdx, EventActivityCompleted, EventActivityFailed); ok {
		w.actIdx++
		if ev.Type == EventActivityFailed {
			return errors.New(ev.Error)
		}
		return decode(ev.Payload, result)
	}
	// Live: not yet in history — execute the side effect now and record it.
	w.actIdx++
	w.engine.mu.Lock()
	fn := w.engine.activities[name]
	w.engine.mu.Unlock()
	if fn == nil {
		return fmt.Errorf("tembed: unknown activity %q", name)
	}
	out, aerr := fn(context.Background(), in)
	if aerr != nil {
		w.record(Event{Type: EventActivityFailed, Name: name, Error: aerr.Error()})
		return aerr
	}
	w.record(Event{Type: EventActivityCompleted, Name: name, Payload: out})
	return decode(out, result)
}

// WaitSignal blocks the workflow until a signal named signal has been
// delivered, decoding its payload into out (which may be nil). Multiple signals
// of the same name are consumed in arrival order. Under the hood a missing
// signal yields the run (it is persisted as waiting and re-driven when the
// signal arrives).
func (w *Workflow) WaitSignal(signal string, out any) {
	k := w.sigIdx[signal]
	if ev, ok := w.nthSignal(signal, k); ok {
		w.sigIdx[signal] = k + 1
		if out != nil {
			if err := decode(ev.Payload, out); err != nil {
				panic(fmt.Sprintf("tembed: decode signal %q: %v", signal, err))
			}
		}
		return
	}
	panic(blocked{kind: "signal"})
}

// Sleep durably pauses the workflow for d. The timer survives a restart: it is
// recorded as an event with an absolute fire time and rescheduled on recovery.
func (w *Workflow) Sleep(d time.Duration) {
	started, fired := w.nthTimer(w.timerIdx)
	if fired {
		w.timerIdx++
		return
	}
	if started != nil {
		// Timer already started but not yet fired (e.g. after a restart) — block
		// and let the engine reschedule from the recorded fire time.
		var fireAt time.Time
		_ = decode(started.Payload, &fireAt)
		panic(blocked{kind: "timer", fireAt: fireAt})
	}
	fireAt := w.engine.now().Add(d)
	pl, _ := json.Marshal(fireAt)
	w.record(Event{Type: EventTimerStarted, Payload: pl})
	panic(blocked{kind: "timer", fireAt: fireAt})
}

// SideEffect records the result of a non-deterministic computation (a random
// number, the current time, a UUID) so replays reuse the recorded value instead
// of recomputing it. fn is only called the first time; out receives the value.
func (w *Workflow) SideEffect(out any, fn func() any) {
	if ev, ok := w.nthOf(w.sideIdx, EventSideEffect); ok {
		w.sideIdx++
		_ = decode(ev.Payload, out)
		return
	}
	w.sideIdx++
	v := fn()
	pl, _ := json.Marshal(v)
	w.record(Event{Type: EventSideEffect, Payload: pl})
	_ = decode(pl, out)
}

// record appends an event to the in-memory history and persists it.
func (w *Workflow) record(e Event) {
	e.Seq = len(w.history)
	if e.Time.IsZero() {
		e.Time = w.engine.now()
	}
	w.history = append(w.history, e)
	if err := w.engine.store.AppendEvent(w.runID, e); err != nil {
		panic(fmt.Sprintf("tembed: persist event: %v", err))
	}
}

// nthOf returns the k-th history event whose type is one of types.
func (w *Workflow) nthOf(k int, types ...EventType) (Event, bool) {
	count := 0
	for _, ev := range w.history {
		match := false
		for _, t := range types {
			if ev.Type == t {
				match = true
				break
			}
		}
		if !match {
			continue
		}
		if count == k {
			return ev, true
		}
		count++
	}
	return Event{}, false
}

// nthSignal returns the k-th SignalReceived event named name.
func (w *Workflow) nthSignal(name string, k int) (Event, bool) {
	count := 0
	for _, ev := range w.history {
		if ev.Type != EventSignalReceived || ev.Name != name {
			continue
		}
		if count == k {
			return ev, true
		}
		count++
	}
	return Event{}, false
}

// nthTimer returns the k-th TimerStarted event (or nil) and whether its
// matching (k-th) TimerFired event exists.
func (w *Workflow) nthTimer(k int) (started *Event, fired bool) {
	starts, fires := 0, 0
	for i := range w.history {
		switch w.history[i].Type {
		case EventTimerStarted:
			if starts == k {
				started = &w.history[i]
			}
			starts++
		case EventTimerFired:
			if fires == k {
				fired = true
			}
			fires++
		}
	}
	return started, fired
}

func decode(payload json.RawMessage, out any) error {
	if out == nil || len(payload) == 0 {
		return nil
	}
	return json.Unmarshal(payload, out)
}
