// plan_api.go — the two endpoints of the /plan/<JIRA-KEY> planning page.
//
// GET  /api/plan?key=KEY        read-only: the stored plan document + the
//
//	workflow runs belonging to this ticket.
//
// POST /api/workflows/plan      start (idempotently reuse) the per-ticket
//
//	`plan` tracker → {runId}.
//
// The reviewer's answers are not written here: the page signals them to the
// tracker's Run ID via the ordinary POST /api/workflows/{runID}/signals/
// plan_answer, which is the sanctioned UI write path
// (.claude/rules/workflows-write-boundary.md).
package main

import (
	"encoding/json"
	"net/http"
	"strings"
)

// handlePlan serves GET /api/plan?key=KEY — read-only. A ticket whose tracker
// has not produced anything yet answers ok with an empty document plus
// `generating:true`, so the page can show the ticket and a "bezig" note rather
// than an error.
func (s *server) handlePlan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	key := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("key")))
	if !planKeyPattern.MatchString(key) {
		http.Error(w, "invalid issue key", http.StatusBadRequest)
		return
	}
	mgr := s.tasks.manager
	doc, ok := mgr.PlanDoc(r.Context(), key)
	runs := mgr.RunsForPlan(key)
	if runs == nil {
		runs = []WorkflowRunView{}
	}
	generating := !ok
	for _, run := range runs {
		if run.Workflow == WorkflowPlan && run.Status == "running" {
			generating = true
		}
	}
	if !ok {
		doc = planDoc{Key: key, Questions: []planQuestion{}, Tasks: []planTask{}, Answers: []planAnswer{}}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "key": key, "doc": doc, "runs": runs, "generating": generating,
	})
}

// handlePlanStart serves POST /api/workflows/plan {key} — start or reuse the
// per-ticket tracker (its Run ID is deterministic, so a repeated start is an
// idempotent no-op) and hand the UI the Run ID to signal answers to.
func (s *server) handlePlanStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.StartPlan(body.Key)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}
