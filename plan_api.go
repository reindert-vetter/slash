// plan_api.go — the two endpoints of the /plan/<JIRA-KEY> planning page.
//
// GET  /api/plan?key=KEY        read-only: the stored plan document + the
//
//	workflow runs belonging to this ticket.
//
// POST /api/workflows/plan_execute  run the plan: implement it on a fresh
//
//	branch and open a draft PR → {runId}.
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
	// A tracker parked on the scope question IS running, but it is waiting for
	// the reviewer, not working — saying "plan wordt opgesteld…" there would be
	// a lie the page cannot recover from (it never resolves on its own).
	// Same for the hotfix question a bug ticket is parked on.
	if doc.NeedsScope || doc.NeedsHotfix {
		generating = false
	}
	if !ok {
		doc = planDoc{Key: key, Questions: []planQuestion{}, Tasks: []planTask{}, Answers: []planAnswer{}}
	}
	payload := map[string]any{
		"ok": true, "key": key, "doc": doc, "runs": runs, "generating": generating,
	}
	// The index's LAST action (plan_execute, see plan_execute.go): the newest
	// attempt for this ticket, absent when it was never run. Read from the
	// workflow's own history rather than from the plan document — the `plan`
	// tracker holds that document in memory and rewrites it on every answer, so
	// a shared row would clobber one or the other.
	if exec, ok := mgr.PlanExecution(key); ok {
		payload["exec"] = exec
	}
	// The three planning phases (intent → specs → plan) and the files behind
	// them — read-only, derived from the document plus what is really on disk,
	// so a file cleanup already removed stops being claimed the moment it is
	// gone (see plan_artifacts.go).
	if artifacts, ok := planArtifactsView(mgr.dataDir, doc); ok {
		payload["artifacts"] = artifacts
	}
	writeJSON(w, http.StatusOK, payload)
}

// handlePlanExecuteStart serves POST /api/workflows/plan_execute {key} — the
// index's last action: implement the stored plan on a fresh branch and open a
// DRAFT pull request (see plan_execute.go). A run already going for this ticket
// is refused with 409 rather than started a second time — the same precedent
// handleTestRunStart sets, for the same reason: both would work in the same
// worktree at once.
func (s *server) handlePlanExecuteStart(w http.ResponseWriter, r *http.Request) {
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
	key := strings.ToUpper(strings.TrimSpace(body.Key))
	if !planKeyPattern.MatchString(key) {
		http.Error(w, "invalid issue key", http.StatusBadRequest)
		return
	}
	if s.tasks.manager.PlanExecuteRunning(key) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "plan execution already running"})
		return
	}
	runID, err := s.tasks.manager.StartPlanExecute(key)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
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
