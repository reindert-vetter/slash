package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/reindert-vetter/tembed"
	"slash/modules/approvals"
	"slash/modules/callresolve"
	"slash/modules/claude"
	"slash/modules/comments"
	"slash/modules/github"
	"slash/modules/inbox"
	"slash/modules/prmeta"
	"slash/modules/relations"
)

// tasks holds the workflow engine + the module read sides. It is built once at
// server start.
type tasks struct {
	engine      *tembed.Engine
	manager     *TaskManager
	comments    *comments.Module
	inbox       *inbox.Module
	relations   *relations.Module
	prmeta      *prmeta.Module
	callresolve *callresolve.Module
	approvals   *approvals.Module
}

// newTasks builds the tembed engine (SQLite + JSONL, so comments live in the
// workflow event history AND in jsonl files), the comments module, and the
// github module, then recovers in-flight executions and resumes their pollers.
func newTasks(ctx context.Context, db *sql.DB, dataDir, repo string) (*tasks, func() error, error) {
	sq, err := tembed.NewSQLiteStore(dataDir + "/workflows.db")
	if err != nil {
		return nil, nil, err
	}
	jl, err := tembed.NewJSONLStore(dataDir + "/workflows")
	if err != nil {
		sq.Close()
		return nil, nil, err
	}
	engine := tembed.New(tembed.NewMultiStore(sq, jl))

	cs, err := comments.Open(dataDir + "/comments.db")
	if err != nil {
		sq.Close()
		return nil, nil, err
	}
	ib, err := inbox.Open(dataDir + "/inbox.db")
	if err != nil {
		sq.Close()
		cs.Close()
		return nil, nil, err
	}
	rel, err := relations.Open(dataDir + "/relations.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		return nil, nil, err
	}
	pm, err := prmeta.Open(dataDir + "/prmeta.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		rel.Close()
		return nil, nil, err
	}
	cr, err := callresolve.Open(dataDir + "/callresolve.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		rel.Close()
		pm.Close()
		return nil, nil, err
	}
	ap, err := approvals.Open(dataDir + "/approvals.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		rel.Close()
		pm.Close()
		cr.Close()
		return nil, nil, err
	}

	// Under test (SLASH_GITHUB=off) use a no-network Fake so runs never touch a
	// real repo; otherwise talk to GitHub via gh.
	var gh github.Client = github.New(repo)
	if os.Getenv("SLASH_GITHUB") == "off" {
		gh = &github.Fake{}
	}
	// Under SLASH_CLAUDE=off the LLM resolver never shells out — an empty Fake
	// resolves nothing (offline/tests). Otherwise use the real claude CLI.
	var cl claude.Client = claude.New()
	if os.Getenv("SLASH_CLAUDE") == "off" {
		cl = claude.NewFake()
	}
	mgr := NewTaskManager(engine, gh, cs, ib, rel, pm, cr, ap, cl, db, dataDir, repo)

	if err := engine.Recover(); err != nil {
		return nil, nil, err
	}
	mgr.ResumePolling(ctx)
	// Own the PR inbox via the workflow: fetch an initial snapshot into the
	// read-model and start the refresh poller (the UI reads only the read-model).
	mgr.EnsureInbox(ctx)

	closeFn := func() error {
		_ = sq.Close()
		_ = ib.Close()
		_ = rel.Close()
		_ = pm.Close()
		_ = cr.Close()
		_ = ap.Close()
		return cs.Close()
	}
	return &tasks{engine: engine, manager: mgr, comments: cs, inbox: ib, relations: rel, prmeta: pm, callresolve: cr, approvals: ap}, closeFn, nil
}

// ResumePolling restarts the GitHub poller for every waiting code-comment
// execution after a restart (so the "check GitHub every minute" keeps running).
func (m *TaskManager) ResumePolling(ctx context.Context) {
	runs, err := m.engine.Runs()
	if err != nil {
		m.logf("task_code_comment: resume polling: %v", err)
		return
	}
	for _, r := range runs {
		if r.Workflow != WorkflowTaskCodeComment || r.Status != tembed.StatusWaiting {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var input CodeCommentInput
		if json.Unmarshal(in, &input) != nil {
			continue
		}
		rootID, _ := m.rootID(r.ID)
		if rootID != 0 {
			prRunID, err := m.ensurePRStatus(input.PR)
			if err != nil {
				m.logf("task_code_comment: resume ensure pr_status pr=%d: %v", input.PR, err)
				prRunID = ""
			}
			go m.poll(ctx, r.ID, input.PR, rootID, prRunID)
		}
	}
}

// routesTasks registers the workflow + comments routes on mux. Writes go only
// through workflow endpoints (start / signal); everything else is read-only.
func (s *server) routesTasks(mux *http.ServeMux) {
	// POST /api/workflows/task_code_comment            → start an execution
	// GET  /api/workflows/task_code_comment            → list executions
	// POST /api/workflows/{runID}/signals/{signalName} → signal (UI reaction)
	// GET  /api/workflows/{runID}                       → execution status
	mux.HandleFunc("/api/workflows/", s.handleWorkflows)
	mux.HandleFunc("/api/workflows/task_code_comment", s.handleTaskCodeComment)
	// POST /api/workflows/resolve_call → start an LLM call-resolution execution
	mux.HandleFunc("/api/workflows/resolve_call", s.handleResolveCall)
	// POST /api/workflows/pr_status {pr} → ensure the per-PR lifecycle tracker
	// (its start fetches the PR's metadata into the prmeta read-model).
	mux.HandleFunc("/api/workflows/pr_status", s.handlePRStatusStart)
	// POST /api/workflows/approve {pr} → ensure the per-PR approval tracker; the
	// UI then signals approvals to its Run ID via .../signals/set.
	mux.HandleFunc("/api/workflows/approve", s.handleApproveStart)
	// GET /api/approvals?pr=N → read-only approval read-model (per block: the
	// approved changed rows + call segments) for refresh-restore.
	mux.HandleFunc("/api/approvals", s.handleApprovals)
	// GET /api/pr?pr=N → read-only PR metadata (title + URL) from the prmeta
	// read-model — for the `/` command menu's Jira/GitHub deep-links.
	mux.HandleFunc("/api/pr", s.handlePR)
	// GET /api/comments?pr=N → read-only comments + reactions for the UI
	mux.HandleFunc("/api/comments", s.handleComments)
	// GET /api/relations?pr=N → read-only block relations (edges) for the UI
	mux.HandleFunc("/api/relations", s.handleRelations)
	// GET /api/callresolve?pr=N → read-only call-resolution read-model (Go +
	// LLM-resolved definitions, and the unresolved calls behind the "Zoek" button)
	mux.HandleFunc("/api/callresolve", s.handleCallResolve)
	// The inbox is owned by the pr_inbox workflow; these endpoints read its
	// read-model (never GitHub directly).
	mux.HandleFunc("/api/inbox", s.handleInbox)
	mux.HandleFunc("/api/inbox/status", s.handleInboxStatus)
}

// handleTaskCodeComment starts a code-comment Workflow Execution (POST) or lists
// executions (GET).
func (s *server) handleTaskCodeComment(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		var in CodeCommentInput
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.File == "" || in.Body == "" {
			http.Error(w, "invalid comment", http.StatusBadRequest)
			return
		}
		if strings.Contains(in.File, "..") {
			http.Error(w, "invalid file", http.StatusBadRequest)
			return
		}
		runID, err := s.tasks.manager.StartCodeComment(r.Context(), in)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
	case http.MethodGet:
		runs, err := s.tasks.engine.Runs()
		if err != nil {
			http.Error(w, "query failed", http.StatusInternalServerError)
			return
		}
		out := make([]tembed.RunRecord, 0, len(runs))
		for _, rec := range runs {
			if rec.Workflow == WorkflowTaskCodeComment {
				out = append(out, rec)
			}
		}
		writeJSON(w, http.StatusOK, out)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleWorkflows routes /api/workflows/{runID} (GET status) and
// /api/workflows/{runID}/signals/{signalName} (POST signal).
func (s *server) handleWorkflows(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/workflows/")
	if rest == "" || rest == "task_code_comment" || rest == "pr_status" || rest == "resolve_call" || rest == "approve" {
		http.NotFound(w, r)
		return
	}
	parts := strings.Split(rest, "/")
	runID := parts[0]

	// POST /api/workflows/{runID}/heartbeat — the UI marks a thread as actively
	// viewed so the server keeps fast-polling GitHub. Writes no state (only
	// in-memory poll timing), so it sits outside the workflow write-boundary.
	if len(parts) == 2 && parts[1] == "heartbeat" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		s.tasks.manager.Heartbeat(runID)
		writeJSON(w, http.StatusOK, map[string]string{"status": "beat"})
		return
	}

	// POST /api/workflows/{runID}/signals/{signalName}
	if len(parts) == 3 && parts[1] == "signals" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		// The inbox "refresh" signal carries no payload — it just asks the
		// pr_inbox workflow to re-fetch now (the UI's on-load re-check).
		if parts[2] == SignalRefresh {
			if err := s.tasks.manager.RefreshInbox(runID); err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "refreshing"})
			return
		}
		// The build_relations "rebuild" signal carries no payload — it asks the
		// workflow to recompute the PR's relations now.
		if parts[2] == SignalRebuild {
			if err := s.tasks.engine.SignalWorkflow(runID, SignalRebuild, json.RawMessage("{}")); err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "rebuilding"})
			return
		}
		// The "set" signal carries a block's full approved state (rows + call
		// segments) to the per-PR approve tracker — the UI write path for approval.
		if parts[2] == SignalSet {
			var body ApprovalSignal
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, "invalid approval", http.StatusBadRequest)
				return
			}
			if body.Viewed != nil {
				if body.File == "" {
					http.Error(w, "invalid viewed request", http.StatusBadRequest)
					return
				}
			} else if body.BlockID == "" {
				http.Error(w, "invalid approval", http.StatusBadRequest)
				return
			}
			if body.Rows == nil {
				body.Rows = []int{}
			}
			if body.Calls == nil {
				body.Calls = []string{}
			}
			if err := s.tasks.engine.SignalWorkflow(runID, SignalSet, body); err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "set"})
			return
		}
		// The delete signal carries no comment body — it just asks the workflow
		// to mark the comment "deleting" and remove it (see ReactionSignal).
		if parts[2] == SignalDelete {
			var body struct {
				Author string `json:"author"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body) // author is optional
			sig := ReactionSignal{
				ID: "ui-" + newUIReactionID(), Source: "ui",
				Author: body.Author, Action: "delete",
			}
			if err := s.tasks.manager.Signal(runID, sig); err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "deleting"})
			return
		}
		if parts[2] != SignalReply {
			http.Error(w, "unknown signal", http.StatusBadRequest)
			return
		}
		var body struct {
			Author string `json:"author"`
			Body   string `json:"body"`
			Done   bool   `json:"done"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Body == "" {
			http.Error(w, "invalid reaction", http.StatusBadRequest)
			return
		}
		sig := ReactionSignal{
			ID: "ui-" + newUIReactionID(), Source: "ui",
			Author: body.Author, Body: body.Body, Done: body.Done,
		}
		if err := s.tasks.manager.Signal(runID, sig); err != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "signalled"})
		return
	}

	// GET /api/workflows/{runID}
	if len(parts) == 1 && r.Method == http.MethodGet {
		status, err := s.tasks.engine.Status(runID)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"runId": runID, "status": status})
		return
	}
	http.NotFound(w, r)
}

// handleComments serves GET /api/comments?pr=N — the read-only comments +
// reactions read-model the UI renders.
func (s *server) handleComments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// ?path=<prefix> does a hierarchical prefix search over the comment paths
	// (e.g. /pr-123 for a whole PR, /pr-123/app/Foo.php for one file); ?pr=N is
	// the plain per-PR list. Both are read-only.
	var (
		list []comments.Comment
		err  error
	)
	if prefix := r.URL.Query().Get("path"); prefix != "" {
		list, err = s.tasks.comments.Search(r.Context(), prefix)
	} else {
		pr := 0
		if v := r.URL.Query().Get("pr"); v != "" {
			pr, _ = strconv.Atoi(v)
		}
		list, err = s.tasks.comments.List(r.Context(), pr)
	}
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []comments.Comment{}
	}
	writeJSON(w, http.StatusOK, list)
}

// handleRelations serves GET /api/relations?pr=N — the read-only block-relations
// read-model (parent→child edges) the UI uses to nest children under a block.
func (s *server) handleRelations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	list, err := s.tasks.relations.List(r.Context(), pr)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []relations.Relation{}
	}
	writeJSON(w, http.StatusOK, list)
}

// handleResolveCall starts an LLM call-resolution Workflow Execution (POST). It
// is the sanctioned UI write path for the "Zoek" action — the workflow runs
// Haiku, escalates to Sonnet if needed, and writes the callresolve read-model.
func (s *server) handleResolveCall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in ResolveCallInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.PR <= 0 || in.CallerID == "" || len(in.Calls) == 0 {
		http.Error(w, "invalid resolve request", http.StatusBadRequest)
		return
	}
	if strings.Contains(in.CallerFile, "..") {
		http.Error(w, "invalid file", http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.StartResolveCall(in)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleCallResolve serves GET /api/callresolve?pr=N — the read-only
// call-resolution read-model (resolved/found definitions + unresolved calls).
func (s *server) handleCallResolve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	list, err := s.tasks.callresolve.List(r.Context(), pr)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []callresolve.Entry{}
	}
	writeJSON(w, http.StatusOK, list)
}

// handlePRStatusStart starts (or reuses) the per-PR pr_status tracker. Starting
// an Execution is the sanctioned UI write path; its start synchronously fetches
// the PR's metadata into the prmeta read-model. The UI calls this on page load.
func (s *server) handlePRStatusStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in struct {
		PR int `json:"pr"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.PR <= 0 {
		http.Error(w, "invalid pr", http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.EnsurePRStatus(in.PR)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleApproveStart starts (or reuses) the per-PR approve tracker and returns
// its Run ID. Starting an Execution is the sanctioned UI write path; the UI then
// signals approvals to this Run ID via .../signals/set.
func (s *server) handleApproveStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in struct {
		PR int `json:"pr"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.PR <= 0 {
		http.Error(w, "invalid pr", http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.EnsureApprovals(in.PR)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleApprovals serves GET /api/approvals?pr=N — the read-only approval
// read-model (per block: approved changed rows + call segments) the UI restores
// on load.
func (s *server) handleApprovals(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	list, err := s.tasks.approvals.List(r.Context(), pr)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []approvals.Approval{}
	}
	writeJSON(w, http.StatusOK, list)
}

// handlePR serves GET /api/pr?pr=N — the read-only PR metadata (title + URL)
// from the prmeta read-model. {ok:false} while the pr_status tracker hasn't
// fetched it yet.
func (s *server) handlePR(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	meta, ok, err := s.tasks.prmeta.Get(r.Context(), pr)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "pr": pr})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "pr": meta.PR, "title": meta.Title, "url": meta.URL, "updatedAt": meta.UpdatedAt,
	})
}
