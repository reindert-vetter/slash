package main

import (
	"context"
	"encoding/json"

	"slash/modules/prmeta"
)

// prSummaryRefreshNeeded decides, OUTSIDE the pr_status workflow, whether the
// page-load "state" signal should carry RefreshSummary: true (re-run
// fetchPRBasics + generatePRSummary). Read-only — a prmeta read plus one live
// `gh` PR read — so it is safe in an HTTP handler; the verdict is recorded in
// the signal payload, which keeps the workflow body deterministic.
//
// True when:
//   - the stored summary is empty (the one-shot stage-2 Haiku call at tracker
//     start failed or timed out — before this, nothing ever retried it), or
//   - the PR's live title/description differ from the ones the summary was
//     generated from (SummarySource). A summary stored before that column
//     existed has no source; its stored basics are what it was generated from
//     (stages 1+2 always ran back to back), so those stand in for it.
//
// Any lookup failure answers false: the summary simply stays as it is.
func (m *TaskManager) prSummaryRefreshNeeded(ctx context.Context, runID string) bool {
	if m.prmeta == nil || m.engine == nil {
		return false
	}
	raw, err := m.engine.Input(runID)
	if err != nil {
		return false
	}
	var in PRStatusInput
	if json.Unmarshal(raw, &in) != nil || in.PR <= 0 {
		return false
	}
	meta, ok, err := m.prmeta.Get(ctx, in.Repo, in.PR)
	if err != nil || !ok {
		return false
	}
	if meta.Summary == "" {
		return true
	}
	live, err := m.ghFor(in.Repo).PRMeta(ctx, in.PR)
	if err != nil {
		return false
	}
	source := meta.SummarySource
	if source == "" {
		source = prmeta.SummarySource(meta.Title, meta.Body)
	}
	return prmeta.SummarySource(live.Title, live.Body) != source
}
