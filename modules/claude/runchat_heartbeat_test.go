package claude

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeStreamingBinary writes a fake `claude` whose stdout is exactly lines,
// each preceded by a `sleep gapSeconds` — simulating a real agentic run that
// keeps producing stream-json frames some distance apart, rather than all at
// once. Used to prove RunChat's heartbeat keeps a slow-but-progressing run
// alive past a shrunk agenticTimeout.
func writeStreamingBinary(t *testing.T, gapSeconds float64, lines ...string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "claude")
	script := "#!/bin/sh\n"
	for _, l := range lines {
		script += fmt.Sprintf("sleep %g\n", gapSeconds)
		script += "echo '" + l + "'\n"
	}
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// TestRunChatHeartbeatSurvivesASlowButProgressingRun shrinks agenticTimeout
// far below the fake run's TOTAL duration, but keeps every individual gap
// between streamed lines under it — proving the deadline really slides
// forward on each line instead of firing once at the call's start. Without
// HeartbeatContext this run would be SIGKILLed partway through (exactly the
// real bug report: a genuine plan_execute run doing real work for minutes
// got killed by the fixed 10-minute agenticTimeout).
func TestRunChatHeartbeatSurvivesASlowButProgressingRun(t *testing.T) {
	origAgentic := agenticTimeout
	// Generous, sandbox-safe numbers: a bare `sleep 0.06` was observed to cost
	// several hundred ms of pure process-spawn overhead in this environment
	// (~250-600ms for a "0.06s" sleep) — far more than the requested duration
	// itself. A 500ms requested gap keeps that overhead a small, tolerable
	// fraction instead of dominating (and invalidating) the measurement.
	agenticTimeout = 900 * time.Millisecond
	t.Cleanup(func() { agenticTimeout = origAgentic })

	writeStreamingBinary(t, 0.5,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{}}]},"session_id":"s-1"}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{}}]},"session_id":"s-1"}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{}}]},"session_id":"s-1"}`,
		`{"type":"result","subtype":"success","is_error":false,"result":"klaar","session_id":"s-1"}`,
	)

	m := New("")
	start := time.Now()
	res, err := m.RunChat(context.Background(), RunRequest{Model: ModelSonnet, Prompt: "hi", Tools: []string{"Read"}})
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("RunChat failed after %s (want it to survive on steady progress): %v", elapsed, err)
	}
	if res.Text != "klaar" {
		t.Fatalf("result = %+v", res)
	}
	// 4 gaps of ~500ms ≈ 2s total, well past the 900ms agenticTimeout — the
	// only way this could have finished is the deadline sliding forward.
	if elapsed < 1500*time.Millisecond {
		t.Fatalf("run finished in %s, fixture too fast to prove the heartbeat did anything", elapsed)
	}
}

// TestRunChatHeartbeatStillTimesOutWhenTrulyStuck is the flip side: a run
// that produces exactly one line and then goes silent must still be killed,
// within roughly one idle window — the heartbeat shifts the deadline, it
// does not remove it.
func TestRunChatHeartbeatStillTimesOutWhenTrulyStuck(t *testing.T) {
	origAgentic := agenticTimeout
	agenticTimeout = 300 * time.Millisecond
	t.Cleanup(func() { agenticTimeout = origAgentic })

	dir := t.TempDir()
	path := filepath.Join(dir, "claude")
	script := "#!/bin/sh\n" +
		`echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{}}]},"session_id":"s-1"}'` + "\n" +
		"sleep 30\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	m := New("")
	start := time.Now()
	if _, err := m.RunChat(context.Background(), RunRequest{Model: ModelSonnet, Prompt: "hi", Tools: []string{"Read"}}); err == nil {
		t.Fatal("want an error from a run that goes silent after one line")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("stuck run took %s, want it bounded by agenticTimeout (~80ms), not the fake binary's 30s sleep", elapsed)
	}
}
