package claude

import (
	"context"
	"testing"
	"time"
)

// TestHeartbeatContextNeverPingedBehavesLikeAFixedTimeout pins the "no
// behaviour change for an existing caller" contract: a context that is never
// pinged must cancel at (approximately) idle after creation, exactly like
// context.WithTimeout would.
func TestHeartbeatContextNeverPingedBehavesLikeAFixedTimeout(t *testing.T) {
	start := time.Now()
	ctx, _, stop := HeartbeatContext(context.Background(), 60*time.Millisecond)
	defer stop()
	<-ctx.Done()
	if elapsed := time.Since(start); elapsed < 40*time.Millisecond || elapsed > 500*time.Millisecond {
		t.Fatalf("unpinged context cancelled after %s, want ~60ms", elapsed)
	}
	if ctx.Err() != context.Canceled {
		t.Fatalf("ctx.Err() = %v, want context.Canceled", ctx.Err())
	}
}

// TestHeartbeatContextPingKeepsItAliveBeyondIdle proves the actual point of
// this primitive: repeated pings, each one within the idle window, let the
// context survive far longer than idle in total.
func TestHeartbeatContextPingKeepsItAliveBeyondIdle(t *testing.T) {
	ctx, ping, stop := HeartbeatContext(context.Background(), 60*time.Millisecond)
	defer stop()
	start := time.Now()
	for i := 0; i < 8; i++ {
		time.Sleep(20 * time.Millisecond) // < idle, so each one arrives in time
		ping()
	}
	if ctx.Err() != nil {
		t.Fatalf("ctx cancelled early after %s of steady pings: %v", time.Since(start), ctx.Err())
	}
	// Total elapsed by now is ~160ms, well past the 60ms idle window — proof
	// the deadline really did keep sliding forward instead of firing once.
	if elapsed := time.Since(start); elapsed < 100*time.Millisecond {
		t.Fatalf("test took only %s, fixture too fast to prove anything", elapsed)
	}
	// Stop pinging: it must still cancel, within roughly one more idle window.
	select {
	case <-ctx.Done():
	case <-time.After(500 * time.Millisecond):
		t.Fatal("context never cancelled once pings stopped")
	}
}

// TestHeartbeatContextStopMakesALatePingANoOp guards the exact race
// HeartbeatContext's own doc comment calls out: a goroutine still holding
// ping after stop() must never resurrect the context.
func TestHeartbeatContextStopMakesALatePingANoOp(t *testing.T) {
	ctx, ping, stop := HeartbeatContext(context.Background(), 30*time.Millisecond)
	stop()
	if ctx.Err() != context.Canceled {
		t.Fatalf("ctx.Err() after stop = %v, want context.Canceled", ctx.Err())
	}
	ping() // must not panic, must not un-cancel anything
	time.Sleep(50 * time.Millisecond)
	if ctx.Err() != context.Canceled {
		t.Fatalf("ctx.Err() after a late ping = %v, want still context.Canceled", ctx.Err())
	}
}
