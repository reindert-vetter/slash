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
	"regexp"
	"strings"

	"github.com/reindert-vetter/tembed"
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
	// The tracker's own history, read once: a gate answer or chat message it
	// has recorded but not handled yet (it is busy) is shown from here.
	hist := mgr.planHistory(key)
	gateAnswered := ok && applyRecordedGateAnswer(hist, &doc)
	if doc.NeedsScope || doc.NeedsHotfix {
		generating = false
	}
	if gateAnswered {
		generating = true
	}
	// The other way round: once a gate answer is stored (SavesGateAnswer),
	// the first generation runs INLINE in that answer's Signal, and the tembed
	// run keeps reading as `waiting` meanwhile — so a refresh in that window
	// must still say "bezig" instead of showing an empty plan.
	if planAwaitsFirstGeneration(doc) {
		generating = true
		for _, run := range runs {
			if run.Workflow == WorkflowPlan && run.Status == "failed" {
				generating = false
			}
		}
	}
	if !ok {
		doc = planDoc{Key: key, Questions: []planQuestion{}, Tasks: []planTask{}, Answers: []planAnswer{}}
	}
	// The stored document's own Assignee can be permanently stale (an older
	// Execution's planLoadIssue Activity result, frozen in tembed's replay
	// history — see plan_assignee_live.go's own doc comment); a live,
	// cached-for-a-few-minutes Jira read fills that gap without ever writing
	// it back into the document.
	if doc.Assignee == "" {
		if assignee, avatarURL := liveAssigneeFallback(r.Context(), mgr, key); assignee != "" {
			doc.Assignee, doc.AssigneeAvatarURL = assignee, avatarURL
		}
	}
	payload := map[string]any{
		"ok": true, "key": key, "doc": doc, "runs": runs, "generating": generating,
		// Chat messages tembed already recorded but the tracker has not handled
		// yet (it is busy with a generation) — see pendingPlanChat.
		"pendingChat": pendingPlanChat(hist, doc),
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
	// intent is the CURRENT intent.md text (auto-generated, or the reviewer's
	// own override — see renderPlanIntent) — computed here, at read time, same
	// as artifacts above, rather than stored twice: it is what column 0's
	// editable "Intentie" field seeds itself with (.claude/docs/plan-page.md).
	payload["intent"] = renderPlanIntent(doc)
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

// handlePlanRestartBranch serves POST /api/workflows/plan_restart_branch
// {key} — discards this ticket's WHOLE plan Execution and starts a fresh one,
// so the branch/hotfix question is asked again (the ONE thing "Plan opnieuw
// opstellen"/planAnswerRegenerate cannot do — see
// TaskManager.RestartPlanBranch's own doc comment for why). An administrative
// action, not (yet) wired to a button in the UI; used for the one-off reset
// this shape was built for (BUG-5463: "alsof er nog niks is gekozen"). Starts
// an Execution, so it stays inside the workflow write-boundary.
func (s *server) handlePlanRestartBranch(w http.ResponseWriter, r *http.Request) {
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
	runID, err := s.tasks.manager.RestartPlanBranch(body.Key)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// planAwaitsFirstGeneration is true between a stored gate answer and the
// first generation landing: no gate open, nothing generated, no error. Only
// for a document that saves its gate answer (SavesGateAnswer) — an older one
// never stored that in-between state.
func planAwaitsFirstGeneration(doc planDoc) bool {
	return doc.SavesGateAnswer && !doc.NeedsScope && !doc.NeedsHotfix &&
		len(doc.Questions) == 0 && len(doc.Tasks) == 0 && doc.Error == ""
}

// planChatClientIDPattern is the shape of a page-minted chat message id
// (crypto.randomUUID, or anything as tame). Anything else is dropped — the id
// is only ever compared, never handed to a subprocess.
var planChatClientIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// planChatClientID returns id when it is a valid client id, "" otherwise.
func planChatClientID(id string) string {
	if planChatClientIDPattern.MatchString(id) {
		return id
	}
	return ""
}

// planPendingChatMessage is one chat message recorded in tembed but not yet
// handled by the plan tracker.
type planPendingChatMessage struct {
	ClientID    string              `json:"clientId"`
	Body        string              `json:"body"`
	Attachments []ChatAttachmentRef `json:"attachments,omitempty"`
}

// planHistory is the plan tracker's own tembed history (read-only), nil when
// there is none. The tracker records a signal immediately even while it runs a
// minutes-long generation (Engine.SetRecordSignalsWhileBusy) but only folds it
// into the document once that generation is done — without reading the
// history, a refresh in between showed nothing of what was just chosen/sent.
func (m *TaskManager) planHistory(key string) []tembed.Event {
	if m == nil || m.engine == nil {
		return nil
	}
	hist, err := m.engine.History(planRunID(key))
	if err != nil {
		return nil
	}
	return hist
}

// applyRecordedGateAnswer folds a scope/branch answer the tracker has recorded
// but not saved yet into doc, reporting whether it did. Exact because the gate
// loop treats the FIRST signal of its name without a side Kind as the answer
// (handlePlanSideSignal), and an Execution's history only ever belongs to that
// Execution (RestartPlanBranch deletes the run).
func applyRecordedGateAnswer(hist []tembed.Event, doc *planDoc) bool {
	name := ""
	switch {
	case doc.NeedsScope:
		name = SignalPlanScope
	case doc.NeedsHotfix:
		name = SignalPlanHotfix
	default:
		return false
	}
	for _, ev := range hist {
		if ev.Type != tembed.EventSignalReceived || ev.Name != name {
			continue
		}
		var sig PlanHotfixSignal
		if json.Unmarshal(ev.Payload, &sig) != nil || sig.Kind != "" {
			continue
		}
		if name == SignalPlanScope {
			doc.NeedsScope = false
		} else {
			doc.NeedsHotfix = false
			doc.Hotfix, doc.BaseBranch = resolvePlanBase(*doc, sig)
		}
		return true
	}
	return false
}

// pendingPlanChat is the pure core of PendingPlanChat. Per signal name, the
// tracker consumes signals strictly in arrival order and counts every chat
// signal WITH a client id it handled (doc.ChatSeen), so the chat signals of
// that name past that count are exactly the unhandled ones. Signals without a
// (valid) client id — every one recorded before this existed — are ignored on
// both sides, and so is an empty message (the tracker drops it too).
func pendingPlanChat(hist []tembed.Event, doc planDoc) []planPendingChatMessage {
	out := []planPendingChatMessage{}
	seen := map[string]int{}
	for _, ev := range hist {
		if ev.Type != tembed.EventSignalReceived {
			continue
		}
		if ev.Name != SignalPlanAnswer && ev.Name != SignalPlanHotfix && ev.Name != SignalPlanScope {
			continue
		}
		var sig struct {
			Kind        string              `json:"kind"`
			Text        string              `json:"text"`
			Attachments []ChatAttachmentRef `json:"attachments"`
			ClientID    string              `json:"clientId"`
		}
		if json.Unmarshal(ev.Payload, &sig) != nil || sig.Kind != planAnswerChat || planChatClientID(sig.ClientID) == "" {
			continue
		}
		seen[ev.Name]++
		if seen[ev.Name] <= doc.ChatSeen[ev.Name] {
			continue
		}
		body := strings.TrimSpace(sig.Text)
		if body == "" && len(sig.Attachments) == 0 {
			continue
		}
		if body == "" {
			body = chatAttachmentOnlyBody(len(sig.Attachments))
		}
		out = append(out, planPendingChatMessage{ClientID: sig.ClientID, Body: body, Attachments: sig.Attachments})
	}
	return out
}
