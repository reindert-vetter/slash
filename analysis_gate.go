package main

import "context"

// analysisRunSlots caps how many resolve_call / resolve_test_covers Activities
// execute their heavy body (symbol index, worktree reads, claude CLI) AT ONCE,
// process-wide. After a restart tembed recovery resumes every unfinished run
// together (one per call site — 500+ for a big PR); without a cap they all hit
// SQLite and memory at the same moment. Runs beyond the cap just wait in
// acquireAnalysisSlot, so nothing is dropped or fails, and because the wait is
// inside the Activity (in-memory, never recorded in history) it does not affect
// replay or restart recovery.
//
// 8: comfortably above resolveCallSemaphore (4 concurrent claude processes) so
// the CLI pool stays saturated, yet small enough to bound index/DB work.
// Same pattern as resolveCallSemaphore: a package-level buffered channel (a test
// needing another cap replaces the channel).
var analysisRunSlots = make(chan struct{}, 8)

// acquireAnalysisSlot blocks until a slot is free or ctx ends; the returned func
// releases the slot (call it exactly once).
func acquireAnalysisSlot(ctx context.Context) (func(), error) {
	slots := analysisRunSlots
	select {
	case slots <- struct{}{}:
		return func() { <-slots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
