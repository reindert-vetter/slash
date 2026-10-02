package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/reindert-vetter/tembed"
)

// pr_purge — drops everything stored for one PR right after it was seen merged
// or closed (the merge sweep in pr_status_poll.go starts it). The daily
// cleanup workflow is the safety net with the same gate. One-shot, signal-less.
//
// The input field is deliberately named "target", NOT "pr": purgePR deletes
// every run whose input carries a "pr" field, which would delete this very run
// while its Activity is still executing.

const WorkflowPrPurge = "pr_purge"

// PrPurgeInput starts a pr_purge Execution (primary repo only).
type PrPurgeInput struct {
	Target int `json:"target"`
}

func prPurgeWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in PrPurgeInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	var res CleanupPurgeResult
	if err := w.ExecuteActivity("purgePRNow", in, &res); err != nil {
		return nil, fmt.Errorf("purge pr %d: %w", in.Target, err)
	}
	return json.Marshal(res)
}

func (m *TaskManager) registerPrPurgeActivities(engine *tembed.Engine) {
	engine.RegisterActivity("purgePRNow", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg PrPurgeInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if arg.Target <= 0 {
			return nil, fmt.Errorf("invalid target")
		}
		res, err := m.purgePRAndForget(ctx, arg.Target)
		if err != nil {
			return nil, err
		}
		return json.Marshal(res)
	})
}
