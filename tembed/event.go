package tembed

import (
	"encoding/json"
	"time"
)

// EventType enumerates the durable history events of a workflow run. The
// history is an append-only event log; replaying it deterministically
// reconstructs the workflow's state (event sourcing, à la Temporal).
type EventType string

const (
	// EventWorkflowStarted is the first event; its Payload holds the input.
	EventWorkflowStarted EventType = "WorkflowStarted"
	// EventActivityCompleted records an activity's return value so a replay
	// returns the recorded result instead of re-running the side effect.
	EventActivityCompleted EventType = "ActivityCompleted"
	// EventActivityFailed records that an activity returned an error.
	EventActivityFailed EventType = "ActivityFailed"
	// EventSideEffect records the value of a non-deterministic computation
	// (time, random, uuid) so replays reuse it instead of recomputing.
	EventSideEffect EventType = "SideEffect"
	// EventSignalReceived records an external signal delivered to the run.
	EventSignalReceived EventType = "SignalReceived"
	// EventTimerStarted records a durable timer (with its fire time in Payload)
	// so a pending sleep survives a process restart.
	EventTimerStarted EventType = "TimerStarted"
	// EventTimerFired records that a started timer elapsed.
	EventTimerFired EventType = "TimerFired"
	// EventWorkflowCompleted is the terminal success event; Payload is the result.
	EventWorkflowCompleted EventType = "WorkflowCompleted"
	// EventWorkflowFailed is the terminal failure event; Error holds the reason.
	EventWorkflowFailed EventType = "WorkflowFailed"
)

// Event is one entry in a run's durable history.
type Event struct {
	Seq     int             `json:"seq"`               // position in the history, 0-based
	Type    EventType       `json:"type"`              //
	Name    string          `json:"name,omitempty"`    // activity/signal name
	Payload json.RawMessage `json:"payload,omitempty"` // result or signal data (JSON)
	Error   string          `json:"error,omitempty"`   // failure reason
	Time    time.Time       `json:"time"`              // when the event was recorded
}
