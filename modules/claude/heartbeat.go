package claude

import (
	"context"
	"sync/atomic"
	"time"
)

// HeartbeatContext returns a context whose deadline behaves like
// context.WithTimeout's, EXCEPT the deadline keeps sliding forward by idle
// every time the returned ping is called, instead of being fixed once at
// creation. A caller that never pings gets identical behavior to
// context.WithTimeout(parent, idle).
//
// This exists so a long but genuinely PROGRESSING run is never killed just
// for taking a while overall, while a truly stuck one (no sign of life at
// all for idle) still cannot hang a workflow run forever — the same safety
// goal contextTimeout/agenticTimeout already served, just measured since the
// last sign of life instead of since the call started. Reviewer report
// (task 56/57): a real plan_execute agentic run doing genuine work — editing
// files, running tests — got SIGKILLed by the fixed 10-minute agenticTimeout
// mid-implementation, with no way to distinguish "still working" from
// "wedged".
//
// Exported (not just used internally by RunChat) so any other long-running
// subprocess/workflow call elsewhere in this codebase can reuse the exact
// same primitive instead of duplicating it — reviewer request: "dit mag ook
// op andere plekken komen".
//
// stop releases the underlying timer and cancels ctx; call it via defer,
// exactly like context.CancelFunc. A ping after stop is a silent no-op —
// stop is a one-way valve, not a pause, so a stray ping from a goroutine
// that outlives the call (see RunChat's steer writer) can never resurrect
// an already-finished context.
func HeartbeatContext(parent context.Context, idle time.Duration) (ctx context.Context, ping func(), stop func()) {
	ctx, cancel := context.WithCancel(parent)
	timer := time.AfterFunc(idle, cancel)
	var stopped atomic.Bool
	ping = func() {
		if !stopped.Load() {
			timer.Reset(idle)
		}
	}
	stop = func() {
		stopped.Store(true)
		timer.Stop()
		cancel()
	}
	return ctx, ping, stop
}
