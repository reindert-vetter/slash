// qa_run_progress.go — "what is the QA run doing right now" for one PR's
// running qa_run: a purely in-memory snapshot, updated from the streamed CLI
// events plus the run's own `[slash:qa-plan]`/`[slash:qa-step]` lines
// (qa_run.go), pushed to the browser over SSE (eventQAProgress) and readable
// via GET /api/qa (its resync read).
//
// Same carve-out from .claude/rules/workflows-write-boundary.md as
// test_run_progress.go: no module, no read-model, no workflow-history write,
// empty again after a restart. Never the source of truth — the finished QA
// report is the qa_run run's own recorded result.
package main

import "sync"

// qaRunProgress is the volatile state of one PR's QA run. Phase/Tool/Detail
// are named exactly like chatProgress's, so the frontend reuses
// claudeStatusText (src/ClaudeChat.mjs) for the status line.
type qaRunProgress struct {
	RunID   string   `json:"runId,omitempty"`
	Running bool     `json:"running"`
	Plan    string   `json:"plan,omitempty"`
	Steps   []string `json:"steps"` // every [slash:qa-step] title, in order
	Phase   string   `json:"phase"`
	Tool    string   `json:"tool,omitempty"`
	Detail  string   `json:"detail,omitempty"`
	// WaitingChoice: the run is blocked on the PR's open werkmap choice (the
	// same chatCheckoutDecision a chat turn raises); the page shows the werkmap
	// overlay meanwhile and the run continues by itself once it is answered.
	WaitingChoice bool   `json:"waitingChoice,omitempty"`
	Cancelled     bool   `json:"cancelled,omitempty"`
	Error         string `json:"error,omitempty"`
	StartedAt     int64  `json:"startedAt"`
	UpdatedAt     int64  `json:"updatedAt"`
}

var (
	qaRunMu   sync.Mutex
	qaRunByPR = map[prKey]qaRunProgress{}
)

func startQARunProgress(repo string, pr int, runID string) {
	now := nowMillis()
	p := qaRunProgress{RunID: runID, Running: true, Phase: chatPhasePreparing, Steps: []string{}, StartedAt: now, UpdatedAt: now}
	qaRunMu.Lock()
	qaRunByPR[prKey{repo, pr}] = p
	qaRunMu.Unlock()
	publishQARunProgress(repo, pr, p)
}

// mutateQARunProgress applies fn and publishes the result; a PR without a
// snapshot is left alone.
func mutateQARunProgress(repo string, pr int, fn func(*qaRunProgress)) {
	qaRunMu.Lock()
	p, ok := qaRunByPR[prKey{repo, pr}]
	if ok {
		fn(&p)
		p.UpdatedAt = nowMillis()
		qaRunByPR[prKey{repo, pr}] = p
	}
	qaRunMu.Unlock()
	if ok {
		publishQARunProgress(repo, pr, p)
	}
}

func finishQARunProgress(repo string, pr int) {
	mutateQARunProgress(repo, pr, func(p *qaRunProgress) {
		p.Running = false
		p.WaitingChoice = false
		p.Phase, p.Tool, p.Detail = "", "", ""
	})
}

func qaRunProgressFor(repo string, pr int) (qaRunProgress, bool) {
	qaRunMu.Lock()
	defer qaRunMu.Unlock()
	p, ok := qaRunByPR[prKey{repo, pr}]
	return p, ok
}

// qaRunRunning guards POST /api/workflows/qa_run: one QA run per PR at a time
// (it drives the one local stack and the PR's one checkout).
func qaRunRunning(repo string, pr int) bool {
	p, ok := qaRunProgressFor(repo, pr)
	return ok && p.Running
}

func publishQARunProgress(repo string, pr int, p qaRunProgress) {
	events.publish(eventQAProgress, repo, pr, "", p)
}
