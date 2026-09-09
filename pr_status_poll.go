// pr_status_poll.go — a background safety net for the pr_status tracker's own
// merge/close detection.
//
// Root cause this fixes (task 56/58, PR 13606 on plug-and-pay-4): the ONLY
// place that ever told a pr_status tracker "this PR merged/closed" was a side
// effect of task_code_comment's own reply poller (workflows.go's poll,
// "Slow cadence only: check whether the PR merged/closed"). That poller only
// runs for a comment thread that was actually POSTED to GitHub
// (arg.RootID != 0, see the pollers spawned around workflows.go:1443) and it
// stops for good once its thread is resolved. A PR whose only remaining
// "open" comments are local/never-posted findings (github_id == 0 — e.g. an
// unconverted code_warning suggestion) therefore has NO live poller at all
// once every posted thread is resolved: nothing is left to ever notice the
// PR merged, so its pr_status tracker sits `waiting` forever — and by
// extension (see 65cdcdd's activeCheckoutClaims/prIsDone in plan_execute.go)
// any checkout claim tied to that PR can never be recognized as stale,
// because that check only ever trusts what pr_status itself recorded.
//
// StartPRMergeSweep is a second, INDEPENDENT way to learn a PR is done — it
// never depends on any comment thread being alive. Deliberately built outside
// workflows.go (same shape as StartCleanupScheduler right next to it in
// tasks_api.go): a plain periodic re-scan of every pr_status tracker still
// `waiting`, needing no hook at tracker-creation time and no per-PR
// goroutine bookkeeping of its own.
package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/reindert-vetter/tembed"
)

// StartPRMergeSweep starts the background loop: an immediate pass, then one
// more every idlePollInterval, for as long as ctx lives. Modelled on
// StartCleanupScheduler (tasks_api.go) — no reviewer-heartbeat concept
// applies here (this isn't "is someone actively viewing this PR", it's
// unconditional background maintenance), so a plain fixed-interval ticker is
// the simplest fit. idlePollInterval (10 minutes) is the same "slow cadence"
// poll()'s own merge-check already used — reused rather than inventing a
// second interval constant for the same class of check.
//
// Deliberately stateless across ticks: every pass re-reads m.engine.Runs()
// fresh, so a tracker that turns `completed` (via this sweep, or via the
// pre-existing comment-poller path, or a race between both) simply stops
// showing up on the next pass — no separate bookkeeping needed.
func (m *TaskManager) StartPRMergeSweep(ctx context.Context) {
	go func() {
		m.waitReady()
		m.runPRMergeSweepOnce(ctx)
		ticker := time.NewTicker(idlePollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.runPRMergeSweepOnce(ctx)
			}
		}
	}()
}

// runPRMergeSweepOnce checks every pr_status tracker still `waiting` for its
// PR's live state, straight from GitHub, and signals the tracker (the same
// SignalPRState/PRStateSignal poll() itself uses) the moment it sees
// anything other than "open" — completing that tracker, which is exactly
// what makes activeCheckoutClaims/prIsDone (plan_execute.go) recognize a
// checkout claim tied to it as stale from then on.
//
// A live PRState call for a PR that ALSO still has its own comment/ingest-
// refresh poller running is deliberately redundant (the same "an idempotent
// extra pass costs nothing" reasoning StartCleanupScheduler's own doc
// comment already accepts) — the whole point of this second path is to never
// depend on whether such a poller happens to still be alive.
//
// Best-effort throughout: a PRState error for one PR is logged and the sweep
// moves on to the next; a SignalWorkflow error (e.g. the tracker completed
// via a concurrent path a moment earlier) is logged, never treated as fatal.
func (m *TaskManager) runPRMergeSweepOnce(ctx context.Context) {
	runs, err := m.engine.Runs()
	if err != nil {
		m.logf("pr_status: merge sweep: list runs: %v", err)
		return
	}
	for _, r := range runs {
		if r.Workflow != WorkflowPRStatus || r.Status != tembed.StatusWaiting {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var input PRStatusInput
		if json.Unmarshal(in, &input) != nil || input.PR == 0 {
			continue
		}
		repo := canonRepo(input.Repo)
		state, err := m.ghFor(repo).PRState(ctx, input.PR)
		if err != nil {
			m.logf("pr_status: merge sweep pr=%d: %v", input.PR, err)
			continue
		}
		if state == "open" {
			continue
		}
		if err := m.engine.SignalWorkflow(r.ID, SignalPRState, PRStateSignal{State: state}); err != nil {
			m.logf("pr_status: merge sweep signal pr=%d: %v", input.PR, err)
		}
	}
}
