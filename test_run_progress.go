// test_run_progress.go — "which test is Claude running right now, and which
// ones already passed/failed" for one running test_run run: a purely
// in-memory snapshot per PR, updated from the streamed CLI events plus the
// run's own `[slash:...]` marker lines (test_run.go) and pushed to the
// browser over SSE (eventbus.go).
//
// Modelled directly on comment_batch_progress.go — same carve-out from
// .claude/rules/workflows-write-boundary.md (no module, no read-model, no
// workflow-history write, empty again after a restart), same "kept after the
// run finished, not deleted" choice (a test run leaves no durable per-test
// trace of its own — the reviewer should still be able to read what just
// ran). One structural difference: comment_batch pre-seeds every item from a
// known id list; a test run has no such list (Claude decides the set of
// tests at runtime — see test_run.go's own header) — so Items starts EMPTY
// and grows as `[slash:test-start]` markers arrive.
package main

import "sync"

// The per-test states a test run walks through. The word carries the meaning
// in the UI (never colour alone — .claude/rules/conventions.md).
const (
	testRunStateBusy = "busy" // Claude announced it started this test
	testRunStatePass = "pass"
	testRunStateFail = "fail"
	// testRunStateInterrupted marks an item that was still "busy" when the run
	// ended without a matching pass/fail marker (a cancel, or a CLI crash
	// mid-test) — an honest third outcome, never silently reported as pass.
	testRunStateInterrupted = "interrupted"
)

// testRunItem is one test's state within the run.
type testRunItem struct {
	Name  string `json:"name"`
	State string `json:"state"`
	Note  string `json:"note,omitempty"`
}

// testRunProgress is the whole volatile state of one PR's test run. The
// Phase/Tool/Detail trio is named exactly like chatProgress's/
// commentBatchProgress's, so the frontend can reuse the same status-line
// formatter (claudeStatusText, src/ClaudeChat.mjs).
type testRunProgress struct {
	Running   bool   `json:"running"`
	Plan      string `json:"plan,omitempty"`
	Passed    int    `json:"passed"`
	Failed    int    `json:"failed"`
	Current   string `json:"current,omitempty"` // test name Claude is working on
	Phase     string `json:"phase"`
	Tool      string `json:"tool,omitempty"`
	Detail    string `json:"detail,omitempty"`
	Cancelled bool   `json:"cancelled,omitempty"`

	Items     []testRunItem `json:"items"`
	StartedAt int64         `json:"startedAt"` // unix ms
	UpdatedAt int64         `json:"updatedAt"` // unix ms
	Error     string        `json:"error,omitempty"`
}

var (
	testRunMu   sync.Mutex
	testRunByPR = map[prKey]testRunProgress{}
)

// startTestRunProgress installs a fresh snapshot for this PR (replacing
// whatever a previous run left behind) and publishes it.
func startTestRunProgress(repo string, pr int) {
	now := nowMillis()
	p := testRunProgress{Running: true, Phase: chatPhasePreparing, StartedAt: now, UpdatedAt: now}
	testRunMu.Lock()
	testRunByPR[prKey{repo, pr}] = p
	testRunMu.Unlock()
	publishTestRunProgress(repo, pr, p)
}

// mutateTestRunProgress applies fn to the stored snapshot and returns the
// result. The second return is false when this PR has no snapshot at all.
func mutateTestRunProgress(repo string, pr int, fn func(*testRunProgress)) (testRunProgress, bool) {
	testRunMu.Lock()
	defer testRunMu.Unlock()
	p, ok := testRunByPR[prKey{repo, pr}]
	if !ok {
		return testRunProgress{}, false
	}
	fn(&p)
	p.UpdatedAt = nowMillis()
	testRunByPR[prKey{repo, pr}] = p
	return p, true
}

// advanceTestRunProgress sets the phase (the one transition outside the
// streamed events: local prep/wait done, CLI about to be invoked).
func advanceTestRunProgress(repo string, pr int, phase string) {
	if snap, ok := mutateTestRunProgress(repo, pr, func(p *testRunProgress) {
		p.Phase = phase
	}); ok {
		publishTestRunProgress(repo, pr, snap)
	}
}

// markTestRunPlan records the run's own `[slash:plan]` line — said once,
// before anything runs, so the reviewer sees WHAT is about to happen and WHY
// before any individual test result comes in.
func markTestRunPlan(repo string, pr int, plan string) {
	if snap, ok := mutateTestRunProgress(repo, pr, func(p *testRunProgress) {
		p.Plan = plan
	}); ok {
		publishTestRunProgress(repo, pr, snap)
	}
}

// markTestRunCurrent records that Claude announced it is starting one test
// ([slash:test-start]) — adds a new item the first time this name is seen,
// otherwise just re-marks it busy (a name can legitimately repeat, e.g. a
// retried assertion inside the same test file).
func markTestRunCurrent(repo string, pr int, name string) {
	if name == "" {
		return
	}
	snap, ok := mutateTestRunProgress(repo, pr, func(p *testRunProgress) {
		p.Current = name
		for i := range p.Items {
			if p.Items[i].Name == name {
				p.Items[i].State = testRunStateBusy
				p.Items[i].Note = ""
				return
			}
		}
		p.Items = append(p.Items, testRunItem{Name: name, State: testRunStateBusy})
	})
	if ok {
		publishTestRunProgress(repo, pr, snap)
	}
}

// markTestRunOutcome records one test's final state ([slash:test-pass] /
// [slash:test-fail]). Adds the item if [slash:test-start] was somehow never
// seen for it (tolerant of a model that skips straight to the outcome).
func markTestRunOutcome(repo string, pr int, name, state, note string) {
	if name == "" {
		return
	}
	snap, ok := mutateTestRunProgress(repo, pr, func(p *testRunProgress) {
		found := false
		for i := range p.Items {
			if p.Items[i].Name != name {
				continue
			}
			p.Items[i].State = state
			p.Items[i].Note = note
			found = true
		}
		if !found {
			p.Items = append(p.Items, testRunItem{Name: name, State: state, Note: note})
		}
		if p.Current == name {
			p.Current = ""
		}
		p.Passed, p.Failed = 0, 0
		for _, it := range p.Items {
			switch it.State {
			case testRunStatePass:
				p.Passed++
			case testRunStateFail:
				p.Failed++
			}
		}
	})
	if ok {
		publishTestRunProgress(repo, pr, snap)
	}
}

// markTestRunCancelled marks the run as cancelled (the reviewer's own "Stop")
// — the honest outcome, distinct from failTestRunProgress's "something went
// wrong", exactly like chat.KindCancelled vs chat.KindError for a chat turn.
func markTestRunCancelled(repo string, pr int) {
	if snap, ok := mutateTestRunProgress(repo, pr, func(p *testRunProgress) {
		p.Cancelled = true
	}); ok {
		publishTestRunProgress(repo, pr, snap)
	}
}

// failTestRunProgress records a run that couldn't even start (no work copy,
// CLI failure) so the reviewer reads a reason instead of a run that silently
// never happens.
func failTestRunProgress(repo string, pr int, reason string) {
	if snap, ok := mutateTestRunProgress(repo, pr, func(p *testRunProgress) {
		p.Error = reason
	}); ok {
		publishTestRunProgress(repo, pr, snap)
	}
}

// finishTestRunProgress publishes one last snapshot with Running false and
// KEEPS it (see the file header): any item still "busy" (started but never
// confirmed pass/fail — a cancel, or a CLI crash mid-test) becomes
// "interrupted" rather than silently vanishing or reading as passed.
func finishTestRunProgress(repo string, pr int) {
	if snap, ok := mutateTestRunProgress(repo, pr, func(p *testRunProgress) {
		p.Running = false
		p.Current = ""
		p.Phase, p.Tool, p.Detail = "", "", ""
		for i := range p.Items {
			if p.Items[i].State == testRunStateBusy {
				p.Items[i].State = testRunStateInterrupted
			}
		}
	}); ok {
		publishTestRunProgress(repo, pr, snap)
	}
}

// testRunProgressFor is the resync read behind GET /api/test-run.
func testRunProgressFor(repo string, pr int) (testRunProgress, bool) {
	testRunMu.Lock()
	defer testRunMu.Unlock()
	p, ok := testRunByPR[prKey{repo, pr}]
	return p, ok
}

// testRunRunning says whether this PR already has a test run in flight — the
// guard behind POST /api/workflows/test_run, refusing a second concurrent run
// for the same PR (see test_run.go's file header, point 7).
func testRunRunning(repo string, pr int) bool {
	p, ok := testRunProgressFor(repo, pr)
	return ok && p.Running
}

// publishTestRunProgress pushes the snapshot to every tab watching this PR
// (no Key: the payload is PR-wide and carries its own per-test items).
func publishTestRunProgress(repo string, pr int, p testRunProgress) {
	events.publish(eventTestRunProgress, repo, pr, "", p)
}
